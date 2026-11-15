import { many, maybe, one, ts } from '../db/index.js';
import { normalizePhone } from '../lib/codes.js';
import { type Actor, type Ctx, audit, clampText, fail, requireRole } from './core.js';
import { moveCasesOfDisabledStaff } from './cases.js';
import { notify } from './notifications.js';
import { getOrg } from './orgs.js';
import { getStaff } from './staff.js';

export async function disableStaff(ctx: Ctx, actor: Actor, staffId: string): Promise<void> {
  requireRole(actor, 'program_lead', 'operator');
  await ctx.db.tx(async (q) => {
    const s = await getStaff(q, staffId);
    if (!s) fail('Staff member not found.', 404);
    if (!actor.roles.has('operator') && s!.org_id !== actor.orgId) fail('Staff member not found.', 404);
    if (s!.id === actor.staffId) fail('You cannot disable your own account.');
    await q.query('UPDATE staff SET active = false WHERE id = $1', [staffId]);
    await q.query('DELETE FROM sessions WHERE staff_id = $1', [staffId]);
    await moveCasesOfDisabledStaff(q, ctx, actor, staffId);
    await audit(q, ctx, actor, { action: 'staff.disable', targetType: 'staff', targetId: staffId });
  });
}

export async function enableStaff(ctx: Ctx, actor: Actor, staffId: string): Promise<void> {
  requireRole(actor, 'program_lead');
  await ctx.db.tx(async (q) => {
    const s = await getStaff(q, staffId);
    if (!s || s.org_id !== actor.orgId) fail('Staff member not found.', 404);
    await q.query('UPDATE staff SET active = true WHERE id = $1', [staffId]);
    await audit(q, ctx, actor, { action: 'staff.enable', targetType: 'staff', targetId: staffId });
  });
}

/** Deletes the synthetic participants used for training while a host is in setup. */
export async function purgeTrainingParticipants(ctx: Ctx, actor: Actor, orgId: string): Promise<number> {
  if (!(actor.orgId === orgId && actor.roles.has('program_lead')) && !actor.roles.has('operator')) fail('Only the program lead or an operator can do that.', 403);
  const rows = await many<{ id: string }>(ctx.db, 'SELECT id FROM participants WHERE org_id = $1 AND training', [orgId]);
  for (const r of rows) {
    await ctx.db.tx(async (q) => {
      await q.query('DELETE FROM participants WHERE id = $1', [r.id]);
      await audit(q, ctx, actor, { action: 'participant.training_purged', targetType: 'participant', targetId: r.id });
    });
    await ctx.keys.destroy(r.id);
  }
  return rows.length;
}

export async function setLegalHold(ctx: Ctx, actor: Actor, participantId: string, reference: string | null): Promise<void> {
  requireRole(actor, 'program_lead');
  const ref = reference === null ? null : (clampText(reference, 200) ?? fail('Give the counsel instruction reference.'));
  await ctx.db.tx(async (q) => {
    const p = await maybe<{ org_id: string }>(q, 'SELECT org_id FROM participants WHERE id = $1 FOR UPDATE', [participantId]);
    if (!p || p.org_id !== actor.orgId) fail('Participant not found.', 404);
    await q.query('UPDATE participants SET legal_hold = $2 WHERE id = $1', [participantId, ref]);
    await audit(q, ctx, actor, { action: ref ? 'legal_hold.set' : 'legal_hold.clear', targetType: 'participant', targetId: participantId, participantId, reason: ref });
  });
}

export async function legalHolds(ctx: Ctx, actor: Actor) {
  requireRole(actor, 'program_lead');
  return many<{ id: string; code: string; legal_hold: string }>(ctx.db, 'SELECT id, code, legal_hold FROM participants WHERE org_id = $1 AND legal_hold IS NOT NULL', [actor.orgId]);
}

export async function setReportingNumbers(ctx: Ctx, actor: Actor, input: { police: string | null; dssAdult: string | null; dssChild: string | null; committedHours?: number }): Promise<void> {
  requireRole(actor, 'program_lead');
  const n = (v: string | null) => (v ? (normalizePhone(v) ?? fail(`Not a phone number: ${v}`)) : null);
  if (input.committedHours !== undefined && !(input.committedHours >= 0 && input.committedHours <= 400)) fail('Committed hours must be between 0 and 400.');
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE organizations SET police_nonemergency_phone = $2, dss_adult_phone = $3, dss_child_phone = $4, committed_hours = COALESCE($5, committed_hours) WHERE id = $1',
      [actor.orgId, n(input.police), n(input.dssAdult), n(input.dssChild), input.committedHours ?? null]);
    await audit(q, ctx, actor, { action: 'org.reporting_numbers', targetType: 'organization', targetId: actor.orgId });
  });
}

// ---------------------------------------------------------------------------
// Break-glass (docs/02 §2.3 note 6): an OMH operator, at the host's written request, with a
// second operator's approval, a ticket and a reason, gets 4 hours of read access. The host's
// program lead is notified immediately.
// ---------------------------------------------------------------------------

export async function requestBreakglass(ctx: Ctx, actor: Actor, orgId: string, ticket: string, reason: string): Promise<string> {
  requireRole(actor, 'operator');
  const t = clampText(ticket, 80) ?? fail('Give the ticket reference.');
  const r = clampText(reason, 300) ?? fail('Give the reason.');
  return ctx.db.tx(async (q) => {
    await getOrg(q, orgId);
    const row = await one<{ id: string }>(q, 'INSERT INTO breakglass_requests (org_id, requested_by, ticket, reason, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id', [orgId, actor.staffId, t, r, ts(ctx.clock.now())]);
    await audit(q, ctx, actor, { action: 'breakglass.request', targetType: 'organization', targetId: orgId, reason: r, details: { ticket: t } });
    return row.id;
  });
}

export async function approveBreakglass(ctx: Ctx, actor: Actor, requestId: string): Promise<void> {
  requireRole(actor, 'operator');
  await ctx.db.tx(async (q) => {
    const b = await maybe<{ id: string; org_id: string; requested_by: string; approved_by: string | null }>(q, 'SELECT * FROM breakglass_requests WHERE id = $1 FOR UPDATE', [requestId]);
    if (!b || b.approved_by) fail('Request not found.', 404);
    if (b!.requested_by === actor.staffId) fail('A second operator must approve.');
    const now = ctx.clock.now();
    await q.query('UPDATE breakglass_requests SET approved_by = $2, approved_at = $3, expires_at = $4 WHERE id = $1', [b!.id, actor.staffId, ts(now), ts(now + 4 * 3_600_000)]);
    await audit(q, ctx, actor, { action: 'breakglass.approve', targetType: 'organization', targetId: b!.org_id });
    const org = await getOrg(q, b!.org_id);
    await notify(q, ctx, { staffId: org.program_lead_id, orgId: org.id, kind: 'breakglass', dedupeKey: `bg:${b!.id}` });
  });
}

export async function activeBreakglass(ctx: Ctx, actor: Actor, orgId: string): Promise<boolean> {
  if (!actor.roles.has('operator')) return false;
  return !!(await maybe(ctx.db, 'SELECT 1 FROM breakglass_requests WHERE org_id = $1 AND requested_by = $2 AND approved_by IS NOT NULL AND expires_at > $3', [orgId, actor.staffId, ts(ctx.clock.now())]));
}
