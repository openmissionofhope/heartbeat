import { POLICY } from '../config.js';
import { many, ts } from '../db/index.js';
import { DAY } from '../lib/calendar.js';
import { normalizePhone } from '../lib/codes.js';
import { type Actor, type Ctx, audit, dec, enc, fail, requireRole } from './core.js';
import { openCase, openCaseFor } from './cases.js';
import { currentPlan, lockParticipant } from './participants.js';

/**
 * Concerns raised by other people (docs/03 §3.12). Staff neither confirm nor deny enrollment;
 * the coordinator records the concern against the participant if there is one. Nothing is ever
 * disclosed to the person who raised it.
 */
export async function recordConcern(ctx: Ctx, actor: Actor, participantId: string, input: { source: 'family' | 'friend' | 'other_org' | 'other'; callback?: string | null; openCaseNow?: boolean }): Promise<{ caseOpened: boolean }> {
  requireRole(actor, 'coordinator', 'program_lead');
  if (!['family', 'friend', 'other_org', 'other'].includes(input.source)) fail('Choose who raised the concern.');
  const callback = input.callback ? (normalizePhone(input.callback) ?? fail('Enter a valid callback number or leave it blank.')) : null;
  const now = ctx.clock.now();
  return ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    const open = await openCaseFor(q, p.id);
    const plan = await currentPlan(q, ctx, p.id);
    await q.query(
      `INSERT INTO concerns (participant_id, received_at, source_category, callback_enc, callback_delete_at, linked_case_id, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.id, ts(now), input.source, await enc(ctx, p.id, 'concern_callback', callback), callback ? ts(now + POLICY.retention.concernCallbackDays * DAY) : null, open?.id ?? null, actor.staffId]);
    if (plan.tellMeIfAsked) await q.query('UPDATE participants SET tell_pending = true WHERE id = $1', [p.id]);
    await audit(q, ctx, actor, { action: 'concern.record', targetType: 'participant', targetId: p.id, participantId: p.id, details: { source: input.source, callback: !!callback } });
    if (!open && input.openCaseNow) {
      if (p.state !== 'active') fail('A follow-up case can be opened only for an active participant.');
      await openCase(q, ctx, p, 'concern', null, actor);
      return { caseOpened: true };
    }
    return { caseOpened: false };
  });
}

export async function markParticipantTold(ctx: Ctx, actor: Actor, participantId: string): Promise<void> {
  requireRole(actor, 'enroller', 'responder', 'coordinator', 'program_lead');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    await q.query('UPDATE participants SET tell_pending = false WHERE id = $1', [p.id]);
    await q.query('UPDATE concerns SET participant_told_at = $2 WHERE participant_id = $1 AND participant_told_at IS NULL', [p.id, ts(ctx.clock.now())]);
    await audit(q, ctx, actor, { action: 'concern.participant_told', targetType: 'participant', targetId: p.id, participantId: p.id });
  });
}

export async function concernsFor(ctx: Ctx, actor: Actor, participantId: string) {
  const coordinator = actor.roles.has('coordinator') || actor.roles.has('program_lead');
  const rows = await many<{ id: string; received_at: Date; source_category: string; callback_enc: Buffer | null; participant_told_at: Date | null }>(ctx.db,
    'SELECT id, received_at, source_category, callback_enc, participant_told_at FROM concerns WHERE participant_id = $1 ORDER BY received_at DESC', [participantId]);
  return Promise.all(rows.map(async (r) => ({ ...r, callback: coordinator ? await dec(ctx, participantId, 'concern_callback', r.callback_enc) : null })));
}
