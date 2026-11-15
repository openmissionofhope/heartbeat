import { POLICY } from '../config.js';
import { many, maybe, one, ts } from '../db/index.js';
import { DAY, businessDayStartOf, isOpen, localDate, staffedDayStartsBetween } from '../lib/calendar.js';
import { type Actor, type Ctx, SYSTEM, audit, clampText, fail, requireRole } from './core.js';
import { notify } from './notifications.js';
import { type OrgRow, dutyChain, getOrg, hoursFor, listOrgs } from './orgs.js';
import { type ParticipantRow, type Plan, currentPlan, lockParticipant } from './participants.js';
import { addBusinessDays, openCase, openCaseFor } from './cases.js';

/**
 * When does this participant become overdue? (docs/03 §3.6)
 *   base = latest of: last qualifying contact, enrollment, pause end, hold end
 *   overdue = base + interval + grace, or after a pause/hold: base + min(interval, 7 days) + grace
 */
export function overdueAt(p: Pick<ParticipantRow, 'last_qualifying_at' | 'clock_base_at' | 'clock_return' | 'activated_at'>, plan: Pick<Plan, 'intervalDays' | 'graceDays'>): number | null {
  const lastQ = p.last_qualifying_at?.getTime() ?? null;
  const base = p.clock_base_at?.getTime() ?? p.activated_at?.getTime() ?? null;
  if (lastQ === null && base === null) return null;
  if (base !== null && (lastQ === null || base > lastQ) && p.clock_return) {
    return base + Math.min(plan.intervalDays, POLICY.returnWindowMaxDays) * DAY + plan.graceDays * DAY;
  }
  const from = Math.max(lastQ ?? 0, base ?? 0);
  return from + plan.intervalDays * DAY + plan.graceDays * DAY;
}

export async function runDetector(ctx: Ctx, orgId: string): Promise<{ opened: number; skipped: string | null }> {
  const now = ctx.clock.now();
  const run = await one<{ id: string }>(ctx.db, "INSERT INTO job_runs (job, org_id, started_at) VALUES ('detector', $1, $2) RETURNING id", [orgId, ts(now)]);
  let opened = 0;
  let skipped: string | null = null;
  try {
    const org = await getOrg(ctx.db, orgId);
    const h = await hoursFor(ctx.db, org);
    const { expirePauses } = await import('./lifecycle.js');
    await expirePauses(ctx, orgId);
    if (org.kind !== 'host' || org.status === 'closed') skipped = 'not a host';
    else if (org.hold_active) skipped = 'escalation hold';
    else if (!isOpen(now, h)) skipped = 'outside staffed hours';
    if (!skipped) {
      const rows = await many<ParticipantRow>(ctx.db,
        `SELECT p.* FROM participants p WHERE p.org_id = $1 AND p.state = 'active'
           AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.participant_id = p.id AND c.state <> 'closed')`, [orgId]);
      for (const r of rows) {
        const plan = await currentPlan(ctx.db, ctx, r.id);
        const due = overdueAt(r, plan);
        if (due === null || now < due) continue;
        const didOpen = await ctx.db.tx(async (q) => {
          const p = await lockParticipant(q, r.id);
          if (p.state !== 'active' || (await openCaseFor(q, p.id))) return false;
          const plan2 = await currentPlan(q, ctx, p.id);
          const due2 = overdueAt(p, plan2);
          if (due2 === null || now < due2) return false;
          await openCase(q, ctx, p, 'overdue', due2);
          return true;
        });
        if (didOpen) opened++;
      }
    }
    await ctx.db.query('UPDATE job_runs SET finished_at = $2, ok = true, summary = $3 WHERE id = $1', [run.id, ts(ctx.clock.now()), JSON.stringify({ opened, skipped })]);
  } catch (err) {
    await ctx.db.query('UPDATE job_runs SET finished_at = $2, ok = false, summary = $3 WHERE id = $1', [run.id, ts(ctx.clock.now()), JSON.stringify({ error: String((err as Error).message).slice(0, 300) })]);
    throw err;
  }
  return { opened, skipped };
}

export async function lastDetectorRun(ctx: Ctx, orgId: string): Promise<{ at: Date; ok: boolean } | null> {
  const r = await maybe<{ finished_at: Date; ok: boolean }>(ctx.db, "SELECT finished_at, ok FROM job_runs WHERE job = 'detector' AND org_id = $1 AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1", [orgId]);
  return r ? { at: r.finished_at, ok: r.ok } : null;
}

export async function lastSuccessfulDetectorRun(ctx: Ctx, orgId: string): Promise<Date | null> {
  const r = await maybe<{ finished_at: Date }>(ctx.db, "SELECT finished_at FROM job_runs WHERE job = 'detector' AND org_id = $1 AND ok ORDER BY started_at DESC LIMIT 1", [orgId]);
  return r?.finished_at ?? null;
}

/**
 * Health for an external uptime monitor (HB-CLK-2): unhealthy if any live host's detector has not
 * completed successfully within 2 staffed hours.
 */
export async function detectorHealth(ctx: Ctx): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const now = ctx.clock.now();
  for (const org of await listOrgs(ctx.db)) {
    if (org.kind !== 'host' || org.status !== 'live') continue;
    const h = await hoursFor(ctx.db, org);
    const last = await lastSuccessfulDetectorRun(ctx, org.id);
    const { businessMinutesBetween } = await import('../lib/calendar.js');
    if (!last || businessMinutesBetween(last.getTime(), now, h) > 120) problems.push(`detector stale for ${org.id}`);
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Daily digest (HB-CLK-2) and host-silence alert to OMH (HB-OPS-6)
// ---------------------------------------------------------------------------

export async function orgCounts(ctx: Ctx, orgId: string, sinceMs: number) {
  const r = await one<{ new_cases: string; uncovered: string; stalled: string; reported: string; open: string }>(ctx.db,
    `SELECT count(*) FILTER (WHERE opened_at >= $2) AS new_cases, count(*) FILTER (WHERE state = 'uncovered') AS uncovered,
            count(*) FILTER (WHERE state = 'stalled') AS stalled, count(*) FILTER (WHERE state = 'contact_reported') AS reported,
            count(*) FILTER (WHERE state <> 'closed') AS open
       FROM cases WHERE org_id = $1`, [orgId, ts(sinceMs)]);
  return { newCases: Number(r.new_cases), uncovered: Number(r.uncovered), stalled: Number(r.stalled), reported: Number(r.reported), open: Number(r.open) };
}

export async function sendDailyDigest(ctx: Ctx, org: OrgRow): Promise<boolean> {
  const h = await hoursFor(ctx.db, org);
  const now = ctx.clock.now();
  const dayStart = businessDayStartOf(now, h);
  if (dayStart === null || now < dayStart) return false;
  const today = localDate(now, org.timezone);
  const counts = await orgCounts(ctx, org.id, now - DAY);
  const last = await lastDetectorRun(ctx, org.id);
  const lastText = last ? `${last.ok ? 'completed' : 'FAILED'} at ${new Date(last.at).toLocaleString('en-US', { timeZone: org.timezone })}` : 'has not run';
  const text = `Heartbeat daily check for ${org.name}: ${counts.newCases} new case(s) in the last day; ${counts.uncovered} uncovered; ${counts.stalled} stalled; ${counts.reported} awaiting contact confirmation; ${counts.open} open in total. The overdue detector last ${lastText}.${org.hold_active ? ' Escalation hold is ON.' : ''}`;
  await ctx.db.tx(async (q) => {
    for (const id of [org.coordinator_id, org.deputy_id]) {
      if (id) await notify(q, ctx, { staffId: id, orgId: org.id, kind: 'digest', digestText: text, dedupeKey: `digest:${org.id}:${id}:${today}` });
    }
  });
  return true;
}

export async function hostSilenceCheck(ctx: Ctx, org: OrgRow): Promise<boolean> {
  if (org.kind !== 'host' || org.status !== 'live') return false;
  const h = await hoursFor(ctx.db, org);
  const now = ctx.clock.now();
  const oldestUncovered = await maybe<{ since: Date }>(ctx.db, "SELECT min(uncovered_since) AS since FROM cases WHERE org_id = $1 AND state = 'uncovered'", [org.id]);
  const lastSignin = await maybe<{ at: Date | null }>(ctx.db, 'SELECT max(last_signin_at) AS at FROM staff WHERE org_id = $1', [org.id]);
  const uncoveredLong = !!oldestUncovered?.since && now >= addBusinessDays(oldestUncovered.since.getTime(), POLICY.hostSilenceBusinessDays, h);
  const silent = !!lastSignin?.at && staffedDayStartsBetween(lastSignin.at.getTime(), now, h) >= POLICY.hostSilenceBusinessDays;
  if (!uncoveredLong && !silent) return false;
  const today = localDate(now, org.timezone);
  const operators = await many<{ email: string }>(ctx.db, "SELECT s.email FROM staff s JOIN organizations o ON o.id = s.org_id WHERE o.kind = 'operator' AND s.active");
  await ctx.db.tx(async (q) => {
    for (const op of operators) await notify(q, ctx, { operatorEmail: op.email, orgId: org.id, kind: 'host_silence', dedupeKey: `silence:${org.id}:${op.email}:${today}` });
    await audit(q, ctx, SYSTEM, { action: 'org.host_silence_alert', targetType: 'organization', targetId: org.id, details: { uncoveredLong, silent } });
  });
  return true;
}

// ---------------------------------------------------------------------------
// Escalation hold and roll call (docs/07 §7.1, HB-DR-3)
// ---------------------------------------------------------------------------

export async function declareHold(ctx: Ctx, actor: Actor, reason: string): Promise<void> {
  requireRole(actor, 'coordinator', 'program_lead');
  const r = clampText(reason, 300) ?? fail('Give the reason for the escalation hold.');
  await ctx.db.tx(async (q) => {
    const org = await getOrg(q, actor.orgId);
    if (org.hold_active) fail('Escalation hold is already on.');
    const now = ts(ctx.clock.now());
    await q.query('UPDATE organizations SET hold_active = true, hold_reason = $2, hold_started_at = $3, hold_confirmed_at = $3 WHERE id = $1', [org.id, r, now]);
    await audit(q, ctx, actor, { action: 'hold.declare', targetType: 'organization', targetId: org.id, reason: r });
  });
}

export async function confirmHold(ctx: Ctx, actor: Actor): Promise<void> {
  requireRole(actor, 'program_lead', 'coordinator');
  await ctx.db.tx(async (q) => {
    const org = await getOrg(q, actor.orgId);
    if (!org.hold_active) fail('Escalation hold is not on.');
    await q.query('UPDATE organizations SET hold_confirmed_at = $2 WHERE id = $1', [org.id, ts(ctx.clock.now())]);
    await audit(q, ctx, actor, { action: 'hold.confirm', targetType: 'organization', targetId: org.id });
  });
}

/** Participants not reached since the hold began and without an open case block the end of hold. */
export async function unreachedDuringHold(ctx: Ctx, orgId: string): Promise<string[]> {
  const org = await getOrg(ctx.db, orgId);
  if (!org.hold_active || !org.hold_started_at) return [];
  const rows = await many<{ id: string }>(ctx.db,
    `SELECT p.id FROM participants p WHERE p.org_id = $1 AND p.state = 'active'
       AND (p.last_qualifying_at IS NULL OR p.last_qualifying_at < $2)
       AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.participant_id = p.id AND c.state <> 'closed')`, [orgId, org.hold_started_at]);
  return rows.map((r) => r.id);
}

export async function endHold(ctx: Ctx, actor: Actor): Promise<void> {
  requireRole(actor, 'coordinator', 'program_lead');
  const unreached = await unreachedDuringHold(ctx, actor.orgId);
  if (unreached.length) fail(`${unreached.length} participant(s) have had no contact since the hold began and no open case. Record a contact or open a roll-call case for each before ending the hold.`);
  await ctx.db.tx(async (q) => {
    const org = await getOrg(q, actor.orgId);
    if (!org.hold_active) fail('Escalation hold is not on.');
    const now = ts(ctx.clock.now());
    await q.query(`UPDATE participants SET clock_base_at = $2, clock_return = true WHERE org_id = $1 AND state = 'active' AND last_qualifying_at >= $3`, [org.id, now, org.hold_started_at]);
    await q.query('UPDATE organizations SET hold_active = false, hold_reason = NULL, hold_started_at = NULL, hold_confirmed_at = NULL WHERE id = $1', [org.id]);
    await audit(q, ctx, actor, { action: 'hold.end', targetType: 'organization', targetId: org.id });
  });
}

export interface RollCallRow { id: string; code: string; disasterPriority: boolean; lastContact: Date | null; hasOpenCase: boolean; contactedSinceHold: boolean }

export async function rollCall(ctx: Ctx, actor: Actor): Promise<RollCallRow[]> {
  requireRole(actor, 'coordinator', 'program_lead');
  const org = await getOrg(ctx.db, actor.orgId);
  const rows = await many<{ id: string; code: string; disaster_priority: boolean; last_qualifying_at: Date | null; open_case: boolean }>(ctx.db,
    `SELECT p.id, p.code, COALESCE(pv.disaster_priority, false) AS disaster_priority, p.last_qualifying_at,
            EXISTS (SELECT 1 FROM cases c WHERE c.participant_id = p.id AND c.state <> 'closed') AS open_case
       FROM participants p LEFT JOIN plan_versions pv ON pv.participant_id = p.id AND pv.superseded_at IS NULL
      WHERE p.org_id = $1 AND p.state IN ('active','paused')
      ORDER BY COALESCE(pv.disaster_priority, false) DESC, p.last_qualifying_at ASC NULLS FIRST`, [actor.orgId]);
  return rows.map((r) => ({
    id: r.id, code: r.code, disasterPriority: r.disaster_priority, lastContact: r.last_qualifying_at, hasOpenCase: r.open_case,
    contactedSinceHold: !!(org.hold_started_at && r.last_qualifying_at && r.last_qualifying_at >= org.hold_started_at),
  }));
}

export async function openRollCallCases(ctx: Ctx, actor: Actor, participantIds: string[], assignTo: string | null): Promise<number> {
  requireRole(actor, 'coordinator', 'program_lead');
  let n = 0;
  for (const id of participantIds) {
    await ctx.db.tx(async (q) => {
      const p = await lockParticipant(q, id);
      if (p.org_id !== actor.orgId || !['active', 'paused'].includes(p.state)) return;
      if (await openCaseFor(q, p.id)) return;
      await openCase(q, ctx, p, 'roll_call', null, actor, assignTo ?? undefined);
      n++;
    });
  }
  return n;
}

/** Daily: ask the program lead to reconfirm the hold; escalate to the deputy, then OMH, if nobody does. */
export async function holdReminders(ctx: Ctx, org: OrgRow): Promise<void> {
  if (!org.hold_active || !org.hold_confirmed_at) return;
  const h = await hoursFor(ctx.db, org);
  const now = ctx.clock.now();
  if (!isOpen(now, h)) return;
  const today = localDate(now, org.timezone);
  const confirmedToday = localDate(org.hold_confirmed_at.getTime(), org.timezone) === today;
  if (confirmedToday) return;
  const missedDays = staffedDayStartsBetween(org.hold_confirmed_at.getTime(), now, h);
  await ctx.db.tx(async (q) => {
    await notify(q, ctx, { staffId: org.program_lead_id, orgId: org.id, kind: 'hold_confirm', dedupeKey: `holdc:${org.id}:${today}` });
    if (missedDays >= 2) await notify(q, ctx, { staffId: org.deputy_id, orgId: org.id, kind: 'hold_unconfirmed', dedupeKey: `holdd:${org.id}:${today}` });
    if (missedDays > POLICY.holdOperatorAlertBusinessDays) {
      const operators = await many<{ email: string }>(q, "SELECT s.email FROM staff s JOIN organizations o ON o.id = s.org_id WHERE o.kind = 'operator' AND s.active");
      for (const op of operators) await notify(q, ctx, { operatorEmail: op.email, orgId: org.id, kind: 'hold_unconfirmed', dedupeKey: `holdo:${org.id}:${op.email}:${today}` });
    }
  });
  void dutyChain;
}
