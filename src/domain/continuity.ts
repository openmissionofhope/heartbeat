import { POLICY } from '../config.js';
import type { Q } from '../db/index.js';
import { many, maybe, one, ts } from '../db/index.js';
import { DAY, HOUR } from '../lib/calendar.js';
import { type Actor, type Ctx, audit, clampText, fail, requireRole } from './core.js';
import { recordContactInTx } from './contacts.js';
import { notify } from './notifications.js';
import { getOrg } from './orgs.js';
import { type Confidence, type Kind, currentPlan, getParticipantRow, summarize } from './participants.js';

/**
 * Continuity partner (docs/07 §7.4): a pre-agreed organization that can step in when the host
 * cannot. Activated by the host's program lead, or — if no host staff have signed in for 72 hours —
 * jointly by the partner's steward and an OMH operator. Time-limited, scoped to participants who
 * agreed to continuity sharing, every action audited and reported to the host.
 */
export interface EventRow { id: string; host_org: string; partner_org: string; reason: string; requested_by: string; approved_by: string | null; starts_at: Date | null; ends_at: Date | null; ended_at: Date | null; created_at: Date }

export async function activeEvent(q: Q, hostOrg: string, partnerOrg: string, now: number): Promise<EventRow | null> {
  return maybe<EventRow>(q, 'SELECT * FROM continuity_events WHERE host_org = $1 AND partner_org = $2 AND starts_at <= $3 AND ends_at > $3 AND ended_at IS NULL', [hostOrg, partnerOrg, ts(now)]);
}

export async function activateByHost(ctx: Ctx, actor: Actor, reason: string): Promise<string> {
  requireRole(actor, 'program_lead');
  const r = clampText(reason, 300) ?? fail('Give a reason.');
  const now = ctx.clock.now();
  return ctx.db.tx(async (q) => {
    const host = await getOrg(q, actor.orgId);
    if (!host.continuity_partner_id) fail('Name a continuity partner in settings first.');
    const row = await one<{ id: string }>(q, `INSERT INTO continuity_events (host_org, partner_org, reason, requested_by, approved_by, starts_at, ends_at, created_at)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$5) RETURNING id`, [host.id, host.continuity_partner_id, r, actor.staffId, ts(now), ts(now + POLICY.continuityEventDays * DAY)]);
    await audit(q, ctx, actor, { action: 'continuity.activate', targetType: 'continuity_event', targetId: row.id, reason: r, details: { by: 'host' } });
    return row.id;
  });
}

export async function requestByPartner(ctx: Ctx, actor: Actor, hostOrgId: string, reason: string): Promise<string> {
  requireRole(actor, 'steward', 'program_lead');
  const r = clampText(reason, 300) ?? fail('Give a reason.');
  const now = ctx.clock.now();
  return ctx.db.tx(async (q) => {
    const host = await getOrg(q, hostOrgId);
    if (host.continuity_partner_id !== actor.orgId) fail('Your organization is not this host’s continuity partner.', 403);
    const row = await one<{ id: string }>(q, 'INSERT INTO continuity_events (host_org, partner_org, reason, requested_by, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [host.id, actor.orgId, r, actor.staffId, ts(now)]);
    await audit(q, ctx, actor, { action: 'continuity.request', targetType: 'continuity_event', targetId: row.id, reason: r });
    await notify(q, ctx, { staffId: host.program_lead_id, orgId: host.id, kind: 'continuity_request', dedupeKey: `cr:${row.id}` });
    const operators = await many<{ email: string }>(q, "SELECT s.email FROM staff s JOIN organizations o ON o.id = s.org_id WHERE o.kind = 'operator' AND s.active");
    for (const op of operators) await notify(q, ctx, { operatorEmail: op.email, orgId: host.id, kind: 'continuity_request', dedupeKey: `cro:${row.id}:${op.email}` });
    return row.id;
  });
}

export async function approveByOperator(ctx: Ctx, actor: Actor, eventId: string): Promise<void> {
  requireRole(actor, 'operator');
  const now = ctx.clock.now();
  await ctx.db.tx(async (q) => {
    const e = await maybe<EventRow>(q, 'SELECT * FROM continuity_events WHERE id = $1 FOR UPDATE', [eventId]);
    if (!e || e.approved_by) fail('Request not found.', 404);
    const last = await maybe<{ at: Date | null }>(q, 'SELECT max(last_signin_at) AS at FROM staff WHERE org_id = $1', [e!.host_org]);
    if (last?.at && now - last.at.getTime() < POLICY.continuityHostSilentHours * HOUR) {
      fail('Host staff signed in within the last 72 hours; only the host’s program lead can activate continuity now.');
    }
    await q.query('UPDATE continuity_events SET approved_by = $2, starts_at = $3, ends_at = $4 WHERE id = $1', [e!.id, actor.staffId, ts(now), ts(now + POLICY.continuityEventDays * DAY)]);
    await audit(q, ctx, actor, { action: 'continuity.activate', targetType: 'continuity_event', targetId: e!.id, details: { by: 'partner+operator' } });
    const host = await getOrg(q, e!.host_org);
    await notify(q, ctx, { staffId: host.program_lead_id, orgId: host.id, kind: 'continuity_active', dedupeKey: `ca:${e!.id}` });
  });
}

export async function endEvent(ctx: Ctx, actor: Actor, eventId: string): Promise<void> {
  await ctx.db.tx(async (q) => {
    const e = await maybe<EventRow>(q, 'SELECT * FROM continuity_events WHERE id = $1 FOR UPDATE', [eventId]);
    if (!e) fail('Not found.', 404);
    const allowed = actor.roles.has('operator') || ((actor.orgId === e!.host_org || actor.orgId === e!.partner_org) && (actor.roles.has('program_lead') || actor.roles.has('steward')));
    if (!allowed) fail('You cannot end this.', 403);
    await q.query('UPDATE continuity_events SET ended_at = $2 WHERE id = $1', [e!.id, ts(ctx.clock.now())]);
    await audit(q, ctx, actor, { action: 'continuity.end', targetType: 'continuity_event', targetId: e!.id });
  });
}

export async function eventsFor(ctx: Ctx, actor: Actor): Promise<(EventRow & { host_name: string; partner_name: string })[]> {
  return many(ctx.db, `SELECT e.*, h.name AS host_name, p.name AS partner_name FROM continuity_events e JOIN organizations h ON h.id = e.host_org JOIN organizations p ON p.id = e.partner_org
    WHERE ($1 OR e.host_org = $2 OR e.partner_org = $2) ORDER BY e.created_at DESC LIMIT 50`, [actor.roles.has('operator'), actor.orgId]);
}

export interface RosterRow { id: string; code: string; name: string; lastContact: Date | null; disasterPriority: boolean; usuallyFound: string | null; namedPeople: { name: string; phone: string; message: string }[] }

/** The continuity-sheet fields, for participants who agreed to continuity sharing. */
export async function stewardRoster(ctx: Ctx, actor: Actor, hostOrgId: string): Promise<RosterRow[]> {
  requireRole(actor, 'steward');
  const e = await activeEvent(ctx.db, hostOrgId, actor.orgId, ctx.clock.now());
  if (!e) fail('There is no active continuity event for this host.', 403);
  const rows = await many<{ id: string }>(ctx.db,
    `SELECT p.id FROM participants p JOIN plan_versions pv ON pv.participant_id = p.id AND pv.superseded_at IS NULL
      WHERE p.org_id = $1 AND p.state IN ('active','paused') AND pv.continuity_sharing ORDER BY pv.disaster_priority DESC, p.last_qualifying_at ASC NULLS FIRST`, [hostOrgId]);
  const out: RosterRow[] = [];
  for (const r of rows) {
    const p = await getParticipantRow(ctx.db, r.id);
    const s = await summarize(ctx, p);
    const plan = await currentPlan(ctx.db, ctx, p.id);
    out.push({
      id: p.id, code: p.code, name: s.name, lastContact: p.last_qualifying_at, disasterPriority: plan.disasterPriority,
      usuallyFound: plan.followup.includes('places') ? plan.usuallyFound : null, namedPeople: plan.followup.includes('people') ? plan.namedPeople : [],
    });
  }
  await ctx.db.tx((q) => audit(q, ctx, actor, { action: 'continuity.roster_view', targetType: 'continuity_event', targetId: e!.id, details: { count: out.length } }));
  return out;
}

export async function stewardRecordContact(ctx: Ctx, actor: Actor, hostOrgId: string, participantId: string, kind: Kind, confidence: Confidence, note?: string | null): Promise<void> {
  requireRole(actor, 'steward');
  await ctx.db.tx(async (q) => {
    const e = await activeEvent(q, hostOrgId, actor.orgId, ctx.clock.now());
    if (!e) fail('There is no active continuity event for this host.', 403);
    const p = await getParticipantRow(q, participantId);
    const plan = await currentPlan(q, ctx, p.id);
    if (p.org_id !== hostOrgId || !plan.continuitySharing) fail('Participant not found.', 404);
    await recordContactInTx(q, ctx, actor, { participantId: p.id, kind, confidence, source: 'continuity', recordedOrg: actor.orgId, note: kind === 'secondhand' ? note : null });
  });
}
