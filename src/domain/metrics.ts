import { POLICY } from '../config.js';
import { many, maybe, one, ts } from '../db/index.js';
import { DAY, businessMinutesBetween, isOpen, localDate } from '../lib/calendar.js';
import { type Actor, type Ctx, audit, clampText, fail, requireRole } from './core.js';
import { notify } from './notifications.js';
import { getOrg, hoursFor } from './orgs.js';

const suppress = (n: number): number | string => (n > 0 && n < POLICY.suppressBelow ? `<${POLICY.suppressBelow}` : n);

function weekStart(ms: number): string {
  const d = new Date(ms);
  const wd = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - wd)).toISOString().slice(0, 10);
}

/**
 * De-identified pilot measures (docs/09, HB-EVAL-1): week granularity, no names, codes, notes or
 * exact dates, and any count under 5 suppressed.
 */
export async function deidentifiedMetrics(ctx: Ctx, actor: Actor, weeks = 12) {
  requireRole(actor, 'coordinator', 'program_lead', 'evaluator');
  const org = await getOrg(ctx.db, actor.orgId);
  const h = await hoursFor(ctx.db, org);
  const since = ctx.clock.now() - weeks * 7 * DAY;
  const cases = await many<{ id: string; opened_at: Date; overdue_at: Date | null; state: string; closure_reason: string | null; closed_at: Date | null; trigger: string }>(ctx.db,
    'SELECT id, opened_at, overdue_at, state, closure_reason, closed_at, trigger FROM cases WHERE org_id = $1 AND opened_at >= $2', [org.id, ts(since)]);
  const firstAccept = new Map((await many<{ case_id: string; at: Date }>(ctx.db,
    'SELECT case_id, min(accepted_at) AS at FROM case_assignments WHERE accepted_at IS NOT NULL AND case_id = ANY($1) GROUP BY case_id', [cases.map((c) => c.id)])).map((r) => [r.case_id, r.at]));
  const firstAction = new Map((await many<{ case_id: string; at: Date }>(ctx.db,
    "SELECT case_id, min(at) AS at FROM case_actions WHERE action <> 'review' AND case_id = ANY($1) GROUP BY case_id", [cases.map((c) => c.id)])).map((r) => [r.case_id, r.at]));
  const day = h.endMin - h.startMin;
  const byWeek = new Map<string, Record<string, number>>();
  for (const c of cases) {
    const w = weekStart(c.opened_at.getTime());
    const m = byWeek.get(w) ?? {};
    const inc = (k: string) => (m[k] = (m[k] ?? 0) + 1);
    inc('cases_opened');
    const acc = firstAccept.get(c.id);
    const start = (c.overdue_at ?? c.opened_at).getTime();
    if (acc) {
      inc('accepted');
      if (businessMinutesBetween(Math.max(start, c.opened_at.getTime()), acc.getTime(), h) <= day) inc('accepted_within_1bd');
      const act = firstAction.get(c.id);
      if (act && businessMinutesBetween(acc.getTime(), act.getTime(), h) <= day) inc('first_action_within_1bd');
    }
    if (c.closure_reason) inc(`closed_${c.closure_reason}`);
    if (c.state !== 'closed') inc('still_open');
    byWeek.set(w, m);
  }
  const agg = await many<{ week: string; metric: string; value: string }>(ctx.db, "SELECT to_char(week, 'YYYY-MM-DD') AS week, metric, value FROM monthly_aggregates WHERE org_id = $1 AND week >= $2", [org.id, new Date(since)]);
  for (const a of agg) {
    const m = byWeek.get(a.week) ?? {};
    m[a.metric] = (m[a.metric] ?? 0) + Number(a.value);
    byWeek.set(a.week, m);
  }
  const live = await many<{ week: string; kind: string; n: string }>(ctx.db,
    `SELECT to_char(date_trunc('week', c.occurred_at), 'YYYY-MM-DD') AS week, c.kind, count(*) AS n FROM contacts c JOIN participants p ON p.id = c.participant_id
      WHERE p.org_id = $1 AND c.occurred_at >= $2 AND c.voided_at IS NULL GROUP BY 1, 2`, [org.id, ts(since)]);
  for (const l of live) {
    const m = byWeek.get(l.week) ?? {};
    m[`contacts_${l.kind}`] = (m[`contacts_${l.kind}`] ?? 0) + Number(l.n);
    byWeek.set(l.week, m);
  }
  const rows = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, m]) => ({ week, ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, suppress(v)])) }));
  await ctx.db.tx((q) => audit(q, ctx, actor, { action: 'metrics.export', targetType: 'organization', targetId: org.id, details: { weeks } }));
  return rows;
}

// ---------------------------------------------------------------------------
// Capacity and enrollment-pause indicators (docs/08 §8.2, §8.5)
// ---------------------------------------------------------------------------

export async function capacity(ctx: Ctx, orgId: string) {
  const org = await getOrg(ctx.db, orgId);
  const now = ctx.clock.now();
  const active = Number((await one<{ n: string }>(ctx.db, "SELECT count(*) AS n FROM participants WHERE org_id = $1 AND state IN ('active','paused','withdrawal_pending','transfer_pending')", [orgId])).n);
  const perResponder = await many<{ id: string; display_name: string; n: string }>(ctx.db,
    `SELECT s.id, s.display_name, count(c.id) AS n FROM staff s LEFT JOIN cases c ON c.owner_id = s.id AND c.state IN ('accepted','stalled','extended_watch','contact_reported')
      WHERE s.org_id = $1 AND s.active AND ('responder' = ANY(s.roles) OR 'coordinator' = ANY(s.roles)) GROUP BY s.id, s.display_name ORDER BY s.display_name`, [orgId]);
  const opened4w = Number((await one<{ n: string }>(ctx.db, "SELECT count(*) AS n FROM cases WHERE org_id = $1 AND trigger = 'overdue' AND opened_at >= $2", [orgId, ts(now - 28 * DAY)])).n);
  const hours4w = Number((await one<{ h: string | null }>(ctx.db, 'SELECT sum(t.hours) AS h FROM time_logs t JOIN staff s ON s.id = t.staff_id WHERE s.org_id = $1 AND t.week >= $2', [orgId, new Date(now - 28 * DAY)])).h ?? 0);
  const cases4w = Math.max(1, opened4w);
  const haveData = opened4w > 0 && hours4w > 0 && active > 0;
  const r = haveData ? opened4w / (active * 4) : 0.2;
  const hPerCase = haveData ? hours4w / cases4w : 3;
  const committed = Number(org.committed_hours);
  const projected = active * r * hPerCase;
  const cap = r * hPerCase > 0 ? Math.floor((0.6 * committed) / (r * hPerCase)) : 0;
  return { active, perResponder: perResponder.map((p) => ({ ...p, n: Number(p.n) })), r, hPerCase, committed, projected, cap, measured: haveData, responderCap: POLICY.responderCap };
}

export async function pauseIndicators(ctx: Ctx, orgId: string): Promise<string[]> {
  const org = await getOrg(ctx.db, orgId);
  const h = await hoursFor(ctx.db, org);
  const now = ctx.clock.now();
  const out: string[] = [];
  const day = h.endMin - h.startMin;
  const uncoveredLong = await many<{ id: string }>(ctx.db,
    `SELECT DISTINCT a.target_id AS id FROM audit_events a JOIN cases c ON c.id::text = a.target_id WHERE c.org_id = $1 AND a.action = 'case.uncovered' AND a.at >= $2`, [orgId, ts(now - 28 * DAY)]);
  let longOnes = 0;
  for (const u of uncoveredLong) {
    const c = await maybe<{ uncovered_since: Date | null; state: string; accepted_at: Date | null }>(ctx.db, 'SELECT uncovered_since, state, accepted_at FROM cases WHERE id = $1', [u.id]);
    if (c?.uncovered_since && businessMinutesBetween(c.uncovered_since.getTime(), now, h) > day) longOnes++;
  }
  if (longOnes >= 2) out.push('Two or more cases uncovered for more than one business day in four weeks.');
  const lowWeeks: boolean[] = [];
  for (const w of [0, 1]) {
    const rows = await many<{ opened_at: Date; at: Date | null }>(ctx.db,
      `SELECT c.opened_at, (SELECT min(accepted_at) FROM case_assignments a WHERE a.case_id = c.id) AS at FROM cases c WHERE c.org_id = $1 AND c.opened_at >= $2 AND c.opened_at < $3`,
      [orgId, ts(now - (w + 1) * 7 * DAY), ts(now - w * 7 * DAY)]);
    const ok = rows.filter((r) => r.at && businessMinutesBetween(r.opened_at.getTime(), r.at.getTime(), h) <= day).length;
    lowWeeks.push(rows.length > 0 && ok / rows.length < 0.9);
  }
  if (lowWeeks.every(Boolean)) out.push('Fewer than 90% of cases accepted within one business day for two consecutive weeks.');
  const open = Number((await one<{ n: string }>(ctx.db, "SELECT count(*) AS n FROM cases WHERE org_id = $1 AND state <> 'closed'", [orgId])).n);
  const stalled = Number((await one<{ n: string }>(ctx.db, "SELECT count(*) AS n FROM cases WHERE org_id = $1 AND state = 'stalled'", [orgId])).n);
  if (open >= 5 && stalled / open > 0.2) out.push('More than 20% of open cases are stalled.');
  const cap = await capacity(ctx, orgId);
  if (cap.active > cap.cap) out.push(`Enrollment (${cap.active}) exceeds the cap rule (${cap.cap}) for committed responder hours.`);
  const responders = cap.perResponder.length;
  if (responders < 3) out.push('Fewer than three responders.');
  const month = await one<{ total: string; gaps: string }>(ctx.db,
    "SELECT count(*) AS total, count(*) FILTER (WHERE closure_reason = 'recording_gap') AS gaps FROM cases WHERE org_id = $1 AND closed_at >= $2", [orgId, ts(now - 30 * DAY)]);
  if (Number(month.total) >= 5 && Number(month.gaps) / Number(month.total) > 0.3) out.push('More than 30% of cases in the last month were recording gaps.');
  const detector = await maybe<{ finished_at: Date }>(ctx.db, "SELECT finished_at FROM job_runs WHERE job = 'detector' AND org_id = $1 AND ok ORDER BY started_at DESC LIMIT 1", [orgId]);
  if (org.status === 'live' && (!detector || businessMinutesBetween(detector.finished_at.getTime(), now, h) > day)) out.push('The overdue detector has not completed for more than one business day.');
  if (out.length && isOpen(now, h)) {
    await ctx.db.tx((q) => notify(q, ctx, { staffId: org.program_lead_id, orgId, kind: 'enrollment_indicator', dedupeKey: `ind:${orgId}:${weekStart(now)}` }));
  }
  return out;
}

export async function logHours(ctx: Ctx, actor: Actor, week: string, hours: number): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) fail('Choose the week.');
  if (!(hours >= 0 && hours <= 80)) fail('Enter hours between 0 and 80.');
  await ctx.db.tx(async (q) => {
    await q.query('INSERT INTO time_logs (staff_id, week, hours) VALUES ($1,$2,$3) ON CONFLICT (staff_id, week) DO UPDATE SET hours = EXCLUDED.hours', [actor.staffId, weekStart(Date.parse(`${week}T12:00:00Z`)), hours]);
    await audit(q, ctx, actor, { action: 'staff.hours', targetType: 'staff', targetId: actor.staffId });
  });
}

// ---------------------------------------------------------------------------
// Monthly access review (HB-AUD-2)
// ---------------------------------------------------------------------------

export async function accessReviewReport(ctx: Ctx, actor: Actor, month: string) {
  requireRole(actor, 'program_lead');
  if (!/^\d{4}-\d{2}$/.test(month)) fail('Choose a month.');
  const org = await getOrg(ctx.db, actor.orgId);
  const h = await hoursFor(ctx.db, org);
  const from = new Date(`${month}-01T00:00:00Z`);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const events = await many<{ id: string; at: Date; actor_id: string | null; action: string; basis: string | null; reason: string | null; outcome: string; search_terms: string | null; details: Record<string, unknown>; name: string | null }>(ctx.db,
    `SELECT a.id, a.at, a.actor_id, a.action, a.basis, a.reason, a.outcome, a.search_terms, a.details, s.display_name AS name
       FROM audit_events a LEFT JOIN staff s ON s.id = a.actor_id WHERE a.actor_org = $1 AND a.at >= $2 AND a.at < $3 ORDER BY a.at`, [org.id, from, to]);
  const reasonViews = events.filter((e) => e.basis === 'reason');
  const afterHours = events.filter((e) => (e.action === 'participant.view' || e.action === 'participant.search') && !isOpen(e.at.getTime(), h));
  const prints = events.filter((e) => e.action.startsWith('print.') || e.action === 'metrics.export');
  const breakglass = await many<{ at: Date; action: string }>(ctx.db, "SELECT at, action FROM audit_events WHERE action LIKE 'breakglass.%' AND target_id = $1 AND at >= $2 AND at < $3", [org.id, from, to]);
  const failedRelays = events.filter((e) => e.action === 'relay.attempt' && e.outcome === 'denied');
  const lockouts = await many<{ at: Date }>(ctx.db, "SELECT at FROM audit_events WHERE action = 'participant.verification' AND details->>'locked' = 'true' AND at >= $1 AND at < $2", [from, to]);
  const emptySearches = events.filter((e) => e.action === 'participant.search' && Number(e.details?.results ?? 0) === 0);
  const perStaff = new Map<string, { name: string; views: number; searches: number }>();
  for (const e of events) {
    if (!e.actor_id) continue;
    const s = perStaff.get(e.actor_id) ?? { name: e.name ?? '', views: 0, searches: 0 };
    if (e.action === 'participant.view') s.views++;
    if (e.action === 'participant.search') s.searches++;
    perStaff.set(e.actor_id, s);
  }
  const volumes = [...perStaff.values()].map((s) => s.views + s.searches);
  const mean = volumes.reduce((a, b) => a + b, 0) / Math.max(1, volumes.length);
  const sd = Math.sqrt(volumes.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, volumes.length));
  const heavy = [...perStaff.values()].filter((s) => s.views + s.searches > Math.max(50, mean + 2 * sd));
  const signed = await maybe<{ signed_by: string; signed_at: Date; note: string | null }>(ctx.db, 'SELECT signed_by, signed_at, note FROM access_reviews WHERE org_id = $1 AND month = $2', [org.id, month]);
  await ctx.db.tx((q) => audit(q, ctx, actor, { action: 'audit.review_view', targetType: 'organization', targetId: org.id, details: { month } }));
  return { month, reasonViews, afterHours, prints, breakglass, failedRelays, lockouts, emptySearches, heavy, signed, localDate: (t: number) => localDate(t, org.timezone) };
}

export async function signAccessReview(ctx: Ctx, actor: Actor, month: string, note: string | null): Promise<void> {
  requireRole(actor, 'program_lead');
  await ctx.db.tx(async (q) => {
    await q.query(`INSERT INTO access_reviews (org_id, month, signed_by, signed_at, note) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (org_id, month) DO UPDATE SET signed_by = EXCLUDED.signed_by, signed_at = EXCLUDED.signed_at, note = EXCLUDED.note`,
    [actor.orgId, month, actor.staffId, ts(ctx.clock.now()), clampText(note, 500)]);
    await audit(q, ctx, actor, { action: 'audit.review_signed', targetType: 'organization', targetId: actor.orgId, details: { month } });
  });
}
