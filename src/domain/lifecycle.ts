import { POLICY } from '../config.js';
import type { Q } from '../db/index.js';
import { many, maybe, ts } from '../db/index.js';
import { DAY } from '../lib/calendar.js';
import { type Actor, type AnyActor, type Ctx, audit, clampText, fail, has, requireRole } from './core.js';
import { notify } from './notifications.js';
import { dutyChain, getOrg, hoursFor } from './orgs.js';
import { type Confidence, type ConsentChoices, CONSENT_SCRIPT_VERSION, type PState, getParticipantRow, lockParticipant, recordUnverifiedRemoteRequest } from './participants.js';

async function setState(q: Q, ctx: Ctx, participantId: string, state: PState, extra: Record<string, unknown> = {}): Promise<void> {
  const cols = Object.keys(extra);
  const sets = cols.map((c, i) => `, ${c} = $${i + 4}`).join('');
  await q.query(`UPDATE participants SET state = $2, state_changed_at = $3${sets} WHERE id = $1`, [participantId, state, ts(ctx.clock.now()), ...cols.map((c) => extra[c])]);
}

function assertHost(actor: Actor, orgId: string): void {
  if (actor.orgId !== orgId) fail('Participant not found.', 404);
}

function verifiedIdentity(identity: Confidence): boolean {
  return identity === 'known' || identity === 'verified';
}

// ---------------------------------------------------------------------------
// Pauses (docs/03 §3.10)
// ---------------------------------------------------------------------------

export async function pause(ctx: Ctx, actor: Actor, participantId: string, input: { endsAt: number; channel: 'in_person' | 'remote'; identity: Confidence }): Promise<void> {
  requireRole(actor, 'enroller', 'responder', 'coordinator', 'program_lead');
  const now = ctx.clock.now();
  if (input.channel === 'remote' && !verifiedIdentity(input.identity)) {
    const p0 = await getParticipantRow(ctx.db, participantId);
    assertHost(actor, p0.org_id);
    await recordUnverifiedRemoteRequest(ctx, actor, p0, 'pause');
  }
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    assertHost(actor, p.org_id);
    if (p.state !== 'active') fail('Only an active participant can be paused.');
    const { openCaseFor } = await import('./cases.js');
    if (await openCaseFor(q, p.id)) fail('Restore contact and close the follow-up case first; the pause can then be recorded during that contact.');
    const remote = input.channel === 'remote';
    const maxDays = remote ? POLICY.pauseMaxDaysRemote : POLICY.pauseMaxDaysInPerson;
    if (input.endsAt <= now) fail('The pause must end in the future.');
    if (input.endsAt - now > maxDays * DAY) fail(`A ${remote ? 'remote' : 'pause agreed in person'} pause can last at most ${maxDays} days.`);
    if (remote) {
      const last = await maybe<{ ends_at: Date; channel: string }>(q, 'SELECT ends_at, channel FROM pauses WHERE participant_id = $1 ORDER BY ends_at DESC LIMIT 1', [p.id]);
      if (last && last.channel === 'remote' && (!p.last_qualifying_at || p.last_qualifying_at < last.ends_at)) {
        fail('A new remote pause needs a qualifying contact since the last pause ended.');
      }
    }
    await q.query('INSERT INTO pauses (participant_id, starts_at, ends_at, channel, created_by) VALUES ($1,$2,$3,$4,$5)', [p.id, ts(now), ts(input.endsAt), input.channel, actor.staffId]);
    await setState(q, ctx, p.id, 'paused');
    await audit(q, ctx, actor, { action: 'participant.pause', targetType: 'participant', targetId: p.id, participantId: p.id, details: { channel: input.channel, days: Math.ceil((input.endsAt - now) / DAY) } });
  });
}

export async function endPause(ctx: Ctx, actor: AnyActor, participantId: string, q0?: Q): Promise<void> {
  const run = async (q: Q) => {
    const p = await lockParticipant(q, participantId);
    if (actor.kind === 'staff') assertHost(actor, p.org_id);
    if (p.state !== 'paused') return;
    const now = ctx.clock.now();
    await q.query('UPDATE pauses SET ended_at = $2 WHERE participant_id = $1 AND ended_at IS NULL', [p.id, ts(now)]);
    await setState(q, ctx, p.id, 'active', { clock_base_at: ts(now), clock_return: true });
    await audit(q, ctx, actor, { action: 'participant.pause_end', targetType: 'participant', targetId: p.id, participantId: p.id });
  };
  if (q0) await run(q0);
  else await ctx.db.tx(run);
}

/** Called by the scheduler: pauses that reached their end date. */
export async function expirePauses(ctx: Ctx, orgId: string): Promise<number> {
  const rows = await many<{ participant_id: string; ends_at: Date }>(ctx.db,
    `SELECT pa.participant_id, pa.ends_at FROM pauses pa JOIN participants p ON p.id = pa.participant_id
      WHERE p.org_id = $1 AND p.state = 'paused' AND pa.ended_at IS NULL AND pa.ends_at <= $2`, [orgId, ts(ctx.clock.now())]);
  for (const r of rows) {
    await ctx.db.tx(async (q) => {
      const p = await lockParticipant(q, r.participant_id);
      if (p.state !== 'paused') return;
      await q.query('UPDATE pauses SET ended_at = $2 WHERE participant_id = $1 AND ended_at IS NULL', [p.id, r.ends_at]);
      await setState(q, ctx, p.id, 'active', { clock_base_at: r.ends_at, clock_return: true });
      await audit(q, ctx, { kind: 'system' }, { action: 'participant.pause_end', targetType: 'participant', targetId: p.id, participantId: p.id, details: { scheduled: true } });
    });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Withdrawal. OMH decision D6 (2026-11-14): a remote withdrawal needs the participant's personal,
// in-person confirmation before it takes effect. Outreach stops at once either way.
// ---------------------------------------------------------------------------

export async function withdraw(ctx: Ctx, actor: Actor, participantId: string, input: { channel: 'in_person' | 'remote'; identity: Confidence; keep?: boolean }): Promise<'withdrawn' | 'withdrawal_pending'> {
  requireRole(actor, 'enroller', 'responder', 'coordinator', 'program_lead');
  const now = ctx.clock.now();
  const cases = await import('./cases.js');
  if (input.channel === 'remote' && !verifiedIdentity(input.identity)) {
    const p0 = await getParticipantRow(ctx.db, participantId);
    assertHost(actor, p0.org_id);
    await recordUnverifiedRemoteRequest(ctx, actor, p0, 'withdrawal');
  }
  return ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    assertHost(actor, p.org_id);
    if (!['active', 'paused', 'transfer_pending'].includes(p.state)) fail('This participant cannot withdraw from their current state.');
    if (input.channel === 'in_person') {
      await completeWithdrawal(q, ctx, actor, p.id, !!input.keep);
      return 'withdrawn';
    }
    await q.query("UPDATE pauses SET ended_at = $2 WHERE participant_id = $1 AND ended_at IS NULL", [p.id, ts(now)]);
    await q.query("UPDATE transfers SET status = 'declined', decided_at = $2 WHERE participant_id = $1 AND status = 'pending'", [p.id, ts(now)]);
    await setState(q, ctx, p.id, 'withdrawal_pending', { withdrawal_requested_at: ts(now), withdrawal_review_due: ts(now + POLICY.withdrawalReviewDays * DAY), keep_after_withdrawal: !!input.keep });
    await cases.handOverForPendingWithdrawal(q, ctx, actor, p.id);
    await audit(q, ctx, actor, { action: 'participant.withdrawal_requested', targetType: 'participant', targetId: p.id, participantId: p.id, details: { channel: 'remote', identity: input.identity } });
    return 'withdrawal_pending';
  });
}

async function completeWithdrawal(q: Q, ctx: Ctx, actor: AnyActor, participantId: string, keep: boolean): Promise<void> {
  const now = ctx.clock.now();
  const { closeForLifecycle } = await import('./cases.js');
  await closeForLifecycle(q, ctx, actor, participantId, 'withdrawn');
  await q.query('UPDATE pauses SET ended_at = $2 WHERE participant_id = $1 AND ended_at IS NULL', [participantId, ts(now)]);
  await q.query("UPDATE transfers SET status = 'declined', decided_at = $2 WHERE participant_id = $1 AND status = 'pending'", [participantId, ts(now)]);
  const days = keep ? POLICY.retention.withdrawnKeepDays : POLICY.retention.withdrawnDays;
  await setState(q, ctx, participantId, 'withdrawn', { delete_after: ts(now + days * DAY), keep_after_withdrawal: keep, withdrawal_review_due: null });
  await audit(q, ctx, actor, { action: 'participant.withdrawn', targetType: 'participant', targetId: participantId, participantId, details: { keep } });
}

/** The participant, in person, confirms the withdrawal they asked for remotely. */
export async function confirmWithdrawalInPerson(ctx: Ctx, actor: Actor, participantId: string, keep?: boolean): Promise<void> {
  requireRole(actor, 'enroller', 'responder', 'coordinator', 'program_lead');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    assertHost(actor, p.org_id);
    if (p.state !== 'withdrawal_pending') fail('There is no pending withdrawal.');
    await completeWithdrawal(q, ctx, actor, p.id, keep ?? p.keep_after_withdrawal);
  });
}

/** The participant, in person, says they did not mean to withdraw. */
export async function cancelPendingWithdrawal(ctx: Ctx, actor: Actor, participantId: string): Promise<void> {
  requireRole(actor, 'enroller', 'responder', 'coordinator', 'program_lead');
  const { clearWithdrawalPending } = await import('./cases.js');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    assertHost(actor, p.org_id);
    if (p.state !== 'withdrawal_pending') fail('There is no pending withdrawal.');
    await setState(q, ctx, p.id, 'active', { withdrawal_requested_at: null, withdrawal_review_due: null, withdrawal_extended: false, clock_base_at: ts(ctx.clock.now()), clock_return: false });
    await clearWithdrawalPending(q, p.id);
    await audit(q, ctx, actor, { action: 'participant.withdrawal_cancelled', targetType: 'participant', targetId: p.id, participantId: p.id, details: { channel: 'in_person' } });
  });
}

/** The coordinator's periodic review of a pending withdrawal; it stays pending until personal confirmation. */
export async function reviewPendingWithdrawal(ctx: Ctx, actor: Actor, participantId: string, note: string | null): Promise<void> {
  requireRole(actor, 'coordinator', 'program_lead');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    assertHost(actor, p.org_id);
    if (p.state !== 'withdrawal_pending') fail('There is no pending withdrawal.');
    const now = ctx.clock.now();
    await q.query('UPDATE participants SET withdrawal_review_due = $2 WHERE id = $1', [p.id, ts(now + POLICY.withdrawalReviewDays * DAY)]);
    await audit(q, ctx, actor, { action: 'participant.withdrawal_reviewed', targetType: 'participant', targetId: p.id, participantId: p.id, reason: clampText(note, 300) });
  });
}

/**
 * After the maximum pending period without personal confirmation, the program lead may end the
 * enrollment as inactive (a documented decision, not a withdrawal and not a judgment about the person).
 */
export async function endLongPendingWithdrawal(ctx: Ctx, actor: Actor, participantId: string, note: string): Promise<void> {
  requireRole(actor, 'program_lead');
  const n = clampText(note, POLICY.noteMax.reason) ?? fail('Record the reason for this decision.');
  const { closeForLifecycleOther } = await import('./lifecycle-helpers.js');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    assertHost(actor, p.org_id);
    if (p.state !== 'withdrawal_pending' || !p.withdrawal_requested_at) fail('There is no pending withdrawal.');
    if (ctx.clock.now() - p.withdrawal_requested_at!.getTime() < POLICY.withdrawalPendingMaxDays * DAY) fail(`This decision is possible only after ${POLICY.withdrawalPendingMaxDays} days pending.`);
    await closeForLifecycleOther(q, ctx, actor, p.id, n);
    await endEnrollment(q, ctx, actor, p.id, 'inactive', 'withdrawal_never_confirmed');
  });
}

/** Reinstates a withdrawn participant who says in person, before deletion, that they did not withdraw. */
export async function reinstate(ctx: Ctx, actor: Actor, participantId: string): Promise<void> {
  requireRole(actor, 'coordinator', 'program_lead');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    assertHost(actor, p.org_id);
    if (p.state !== 'withdrawn') fail('Only a withdrawn participant can be reinstated.');
    await setState(q, ctx, p.id, 'active', { delete_after: null, clock_base_at: ts(ctx.clock.now()), clock_return: false });
    await audit(q, ctx, actor, { action: 'participant.reinstated', targetType: 'participant', targetId: p.id, participantId: p.id, details: { channel: 'in_person' } });
  });
}

/** Ends an enrollment after an approved closure (docs/03 §3.10). */
export async function endEnrollment(q: Q, ctx: Ctx, actor: AnyActor, participantId: string, to: 'inactive' | 'ended', reason: string): Promise<void> {
  const now = ctx.clock.now();
  const days = to === 'inactive' ? POLICY.retention.inactiveDays : POLICY.retention.endedDays;
  await q.query('UPDATE pauses SET ended_at = $2 WHERE participant_id = $1 AND ended_at IS NULL', [participantId, ts(now)]);
  await setState(q, ctx, participantId, to, { delete_after: ts(now + days * DAY), withdrawal_review_due: null });
  await audit(q, ctx, actor, { action: `participant.${to}`, targetType: 'participant', targetId: participantId, participantId, details: { reason } });
}

/** Coordinator + program lead: a death report proved wrong, or an ended/inactive participant returns. */
export async function reactivate(ctx: Ctx, actor: Actor, participantId: string, input: { reason: string; consent: ConsentChoices; teachBack: boolean }): Promise<void> {
  requireRole(actor, 'coordinator', 'program_lead');
  const reason = clampText(input.reason, POLICY.noteMax.reason) ?? fail('Record why the enrollment is being restored.');
  if (!input.teachBack) fail('Re-enrollment needs a fresh consent conversation with teach-back.');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    assertHost(actor, p.org_id);
    if (!['inactive', 'ended'].includes(p.state)) fail('Only an inactive or ended enrollment can be restored.');
    if (p.state === 'ended' && !has(actor, 'program_lead')) fail('Restoring an ended enrollment needs the program lead.', 403);
    const now = ctx.clock.now();
    await q.query(`INSERT INTO consents (participant_id, org_id, script_version, choices, teach_back, method, witnessed_by, created_at) VALUES ($1,$2,$3,$4,true,'in_person',$5,$6)`,
      [p.id, p.org_id, CONSENT_SCRIPT_VERSION, JSON.stringify(input.consent), actor.staffId, ts(now)]);
    await setState(q, ctx, p.id, 'active', { delete_after: null, clock_base_at: ts(now), clock_return: false });
    await audit(q, ctx, actor, { action: 'participant.reactivated', targetType: 'participant', targetId: p.id, participantId: p.id, reason });
  });
}

/** Scheduler: pending-withdrawal reviews that are due or late. */
export async function remindPendingWithdrawals(ctx: Ctx, orgId: string): Promise<void> {
  const org = await getOrg(ctx.db, orgId);
  const h = await hoursFor(ctx.db, org);
  const { addBusinessDays } = await import('./cases.js');
  const now = ctx.clock.now();
  const rows = await many<{ id: string; withdrawal_review_due: Date }>(ctx.db, "SELECT id, withdrawal_review_due FROM participants WHERE org_id = $1 AND state = 'withdrawal_pending' AND withdrawal_review_due <= $2", [orgId, ts(now)]);
  for (const r of rows) {
    await ctx.db.tx(async (q) => {
      const duty = await dutyChain(q, org, now);
      const due = r.withdrawal_review_due.getTime();
      await notify(q, ctx, { staffId: duty.onDuty?.id, orgId, kind: 'withdrawal_review', dedupeKey: `wdr:${r.id}:${due}` });
      if (now >= addBusinessDays(due, 1, h)) await notify(q, ctx, { staffId: org.program_lead_id, orgId, kind: 'withdrawal_review_late', dedupeKey: `wdrl:${r.id}:${new Date(now).toISOString().slice(0, 10)}` });
    });
  }
}
