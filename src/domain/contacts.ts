import { POLICY } from '../config.js';
import type { Q } from '../db/index.js';
import { many, maybe, one, ts } from '../db/index.js';
import { localDate } from '../lib/calendar.js';
import { type Actor, type AnyActor, type Ctx, SYSTEM, audit, clampText, dec, enc, fail, has } from './core.js';
import { notify } from './notifications.js';
import { dutyChain, getOrg } from './orgs.js';
import { type Confidence, type Kind, type ParticipantRow, currentPlan, lockParticipant } from './participants.js';

export interface ContactInput {
  participantId: string;
  kind: Kind;
  confidence: Confidence;
  source: 'staff' | 'relay' | 'sms' | 'keypad' | 'offline' | 'continuity';
  occurredAt?: number;
  note?: string | null;
  relayMessage?: string | null;
  recordedOrg?: string;
}

export interface ContactRow {
  id: string;
  participant_id: string;
  kind: Kind;
  confidence: Confidence;
  source: string;
  occurred_at: Date;
  recorded_at: Date;
  recorded_by: string | null;
  recorded_org: string | null;
  qualifying: boolean;
  needs_approval: boolean;
  note_enc: Buffer | null;
  relay_message_enc: Buffer | null;
  voided_at: Date | null;
  void_reason: string | null;
}

/** Recording states: people who have left (withdrawn, transferred) cannot be recorded against. */
const RECORDABLE = ['active', 'paused', 'withdrawal_pending', 'transfer_pending', 'inactive', 'ended'];

/** Does this contact reset the participant's clock under their plan? (docs/03 §3.5) */
export function qualifies(kind: Kind, confidence: Confidence, planKinds: Kind[]): boolean {
  if (kind === 'secondhand') return false;
  if (!planKinds.includes(kind)) return false;
  if (kind === 'relay') return confidence === 'verified';
  return confidence === 'known' || confidence === 'verified';
}

function validate(input: ContactInput): void {
  const kinds: Kind[] = ['in_person', 'phone_with_staff', 'relay', 'self_check_in', 'secondhand'];
  const confs: Confidence[] = ['known', 'verified', 'code_only', 'stated', 'reported'];
  if (!kinds.includes(input.kind) || !confs.includes(input.confidence)) fail('Choose the kind of contact and how you confirmed who it was.');
  if ((input.kind === 'secondhand') !== (input.confidence === 'reported')) fail('Secondhand reports are always "reported"; firsthand contacts need an identity confidence.');
  if (input.note && !['self_check_in', 'secondhand'].includes(input.kind)) fail('Notes are only for self-check-ins and secondhand reports.');
  if (input.relayMessage && input.kind !== 'relay') fail('Only relays carry a participant message.');
}

export async function recordContact(ctx: Ctx, actor: Actor, input: ContactInput): Promise<{ contactId: string; qualifying: boolean; needsApproval: boolean }> {
  if (!has(actor, 'recorder', 'enroller', 'responder', 'coordinator', 'program_lead')) fail('You do not have permission to record contacts.', 403);
  return ctx.db.tx(async (q) => {
    const r = await recordContactInTx(q, ctx, actor, input);
    return { contactId: r.contactId, qualifying: r.qualifying, needsApproval: r.needsApproval };
  });
}

export async function recordContactInTx(q: Q, ctx: Ctx, actor: AnyActor | { kind: 'participant' | 'provider'; orgId?: string }, input: ContactInput): Promise<{ contactId: string; qualifying: boolean; needsApproval: boolean; closedCase: boolean }> {
  validate(input);
  const now = ctx.clock.now();
  const p = await lockParticipant(q, input.participantId);
  if (actor.kind === 'staff' && input.source === 'staff' && p.org_id !== actor.orgId) fail('Participant not found.', 404);
  if (!RECORDABLE.includes(p.state)) fail('Participant not found.', 404);
  const occurred = input.occurredAt ?? now;
  if (occurred > now + 5 * 60_000) fail('A contact cannot be in the future.');
  const needsApproval = now - occurred > POLICY.backdateHours * 3_600_000;
  const note = clampText(input.note, POLICY.noteMax.contact);
  const relayMessage = clampText(input.relayMessage, POLICY.noteMax.relay);
  const plan = await currentPlan(q, ctx, p.id).catch(() => null);
  const isQualifying = !needsApproval && p.state !== 'ended' && !!plan && qualifies(input.kind, input.confidence, plan.qualifyingKinds);
  const recordedBy = actor.kind === 'staff' ? actor.staffId : null;
  const recordedOrg = input.recordedOrg ?? (actor.kind === 'staff' ? actor.orgId : p.org_id);
  const row = await one<{ id: string }>(q,
    `INSERT INTO contacts (participant_id, kind, confidence, source, occurred_at, recorded_at, recorded_by, recorded_org, qualifying, needs_approval, note_enc, relay_message_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [p.id, input.kind, input.confidence, input.source, ts(occurred), ts(now), recordedBy, recordedOrg, isQualifying, needsApproval,
      await enc(ctx, p.id, 'contact_note', note), await enc(ctx, p.id, 'relay_message', relayMessage)]);
  await audit(q, ctx, actor as AnyActor, { action: 'contact.record', targetType: 'contact', targetId: row.id, participantId: p.id,
    details: { kind: input.kind, confidence: input.confidence, source: input.source, qualifying: isQualifying, backdated: needsApproval } });
  const org = await getOrg(q, p.org_id);
  if (needsApproval) {
    const duty = await dutyChain(q, org, now);
    await notify(q, ctx, { staffId: duty.onDuty?.id, orgId: org.id, kind: 'backdate_approval', dedupeKey: `backdate:${row.id}` });
    return { contactId: row.id, qualifying: false, needsApproval, closedCase: false };
  }
  const closedCase = await applyContactEffects(q, ctx, actor as AnyActor, p, { id: row.id, kind: input.kind, confidence: input.confidence, occurred_at: new Date(occurred), qualifying: isQualifying });
  return { contactId: row.id, qualifying: isQualifying, needsApproval: false, closedCase };
}

async function applyContactEffects(q: Q, ctx: Ctx, actor: AnyActor, p: ParticipantRow, c: { id: string; kind: Kind; confidence: Confidence; occurred_at: Date; qualifying: boolean }): Promise<boolean> {
  const now = ctx.clock.now();
  const org = await getOrg(q, p.org_id);
  const firsthandInPerson = c.kind === 'in_person' && (c.confidence === 'known' || c.confidence === 'verified');
  if (c.qualifying && (!p.last_qualifying_at || c.occurred_at > p.last_qualifying_at)) {
    await q.query('UPDATE participants SET last_qualifying_at = $2, last_qualifying_kind = $3, last_qualifying_confidence = $4 WHERE id = $1', [p.id, c.occurred_at, c.kind, c.confidence]);
  }
  if (firsthandInPerson && (!p.last_in_person_at || c.occurred_at > p.last_in_person_at)) {
    await q.query('UPDATE participants SET last_in_person_at = $2 WHERE id = $1', [p.id, c.occurred_at]);
  }
  const today = localDate(now, org.timezone);
  const duty = firsthandInPerson || ['inactive', 'ended'].includes(p.state) ? await dutyChain(q, org, now) : null;
  if (firsthandInPerson) {
    const flagged = await maybe(q, 'SELECT 1 FROM plan_versions WHERE participant_id = $1 AND remote_unconfirmed', [p.id]);
    if (flagged) await notify(q, ctx, { staffId: duty?.onDuty?.id, orgId: org.id, kind: 'remote_change_seen', dedupeKey: `rcs:${p.id}:${today}` });
    if (p.state === 'withdrawal_pending') await notify(q, ctx, { staffId: duty?.onDuty?.id, orgId: org.id, kind: 'withdrawal_seen', dedupeKey: `wds:${p.id}:${today}` });
    if (p.tell_pending) await notify(q, ctx, { staffId: duty?.onDuty?.id, orgId: org.id, kind: 'concern', dedupeKey: `tell:${p.id}:${today}` });
  }
  if (p.state === 'inactive') await notify(q, ctx, { staffId: duty?.onDuty?.id, orgId: org.id, kind: 'inactive_returned', dedupeKey: `inret:${p.id}:${today}` });
  if (p.state === 'ended') await notify(q, ctx, { staffId: org.program_lead_id, orgId: org.id, kind: 'ended_returned', dedupeKey: `endret:${p.id}:${today}` });
  if (c.qualifying) {
    const { openCaseFor, onQualifyingContact } = await import('./cases.js');
    const open = await openCaseFor(q, p.id);
    if (open && !open.withdrawal_pending) return onQualifyingContact(q, ctx, actor, open, c);
  }
  return false;
}

export async function approveBackdated(ctx: Ctx, actor: Actor, contactId: string, reason: string): Promise<void> {
  if (!has(actor, 'coordinator', 'program_lead')) fail('Only a coordinator can approve late entries.', 403);
  const r = clampText(reason, 200) ?? fail('Give the reason (e.g. "paper form, outage of 3 Oct").');
  await ctx.db.tx(async (q) => {
    const c = await maybe<ContactRow>(q, 'SELECT * FROM contacts WHERE id = $1 FOR UPDATE', [contactId]);
    if (!c || !c.needs_approval || c.voided_at) fail('Nothing to approve.', 404);
    const p = await lockParticipant(q, c!.participant_id);
    if (p.org_id !== actor.orgId) fail('Contact not found.', 404);
    const plan = await currentPlan(q, ctx, p.id);
    const isQ = p.state !== 'ended' && qualifies(c!.kind, c!.confidence, plan.qualifyingKinds);
    await q.query('UPDATE contacts SET needs_approval = false, approved_by = $2, approval_reason = $3, qualifying = $4 WHERE id = $1', [c!.id, actor.staffId, r, isQ]);
    await audit(q, ctx, actor, { action: 'contact.backdate_approved', targetType: 'contact', targetId: c!.id, participantId: p.id, reason: r });
    await applyContactEffects(q, ctx, actor, p, { id: c!.id, kind: c!.kind, confidence: c!.confidence, occurred_at: c!.occurred_at, qualifying: isQ });
  });
}

export async function voidContact(ctx: Ctx, actor: Actor, contactId: string, reason: string): Promise<void> {
  const r = clampText(reason, 200) ?? fail('Say why this contact is wrong.');
  await ctx.db.tx(async (q) => {
    const c = await maybe<ContactRow>(q, 'SELECT * FROM contacts WHERE id = $1', [contactId]);
    if (!c) fail('Contact not found.', 404);
    const own = c!.recorded_by === actor.staffId && ctx.clock.now() - c!.recorded_at.getTime() <= 24 * 3_600_000;
    if (!own && !has(actor, 'coordinator', 'program_lead')) fail('Only the person who recorded it (within 24 hours) or a coordinator can void a contact.', 403);
    const p = await lockParticipant(q, c!.participant_id);
    if (p.org_id !== actor.orgId && c!.recorded_org !== actor.orgId) fail('Contact not found.', 404);
    await voidContactInTx(q, ctx, actor, contactId, r, {});
  });
}

/** Voids a contact; recomputes the clock; a contact awaiting confirmation goes back; a closing contact reopens its case. */
export async function voidContactInTx(q: Q, ctx: Ctx, actor: Actor, contactId: string, reason: string, opts: { skipCaseEffects?: boolean }): Promise<void> {
  const c = await maybe<ContactRow>(q, 'SELECT * FROM contacts WHERE id = $1 FOR UPDATE', [contactId]);
  if (!c || c.voided_at) fail('That contact is already void.');
  const now = ctx.clock.now();
  await q.query('UPDATE contacts SET voided_at = $2, voided_by = $3, void_reason = $4, qualifying = false WHERE id = $1', [c!.id, ts(now), actor.staffId, reason]);
  await audit(q, ctx, actor, { action: 'contact.void', targetType: 'contact', targetId: c!.id, participantId: c!.participant_id, reason });
  await recomputeLastContacts(q, c!.participant_id, c!);
  if (opts.skipCaseEffects) return;
  const { reopenCase } = await import('./cases.js');
  const reported = await maybe<{ id: string; owner_id: string }>(q, "SELECT id, owner_id FROM cases WHERE reported_contact_id = $1 AND state = 'contact_reported'", [c!.id]);
  if (reported) {
    await q.query("UPDATE cases SET state = 'accepted', reported_contact_id = NULL, contact_reported_at = NULL, prior_state = NULL, accepted_at = COALESCE(accepted_at, $2) WHERE id = $1", [reported.id, ts(now)]);
    return;
  }
  const closed = await maybe<{ id: string }>(q, "SELECT id FROM cases WHERE reported_contact_id = $1 AND state = 'closed' AND closed_at >= $2", [c!.id, ts(now - POLICY.reopenDays * 86_400_000)]);
  if (closed) await reopenCase(ctx, SYSTEM, closed.id, 'closing contact voided', q);
}

/** After voiding a contact, recomputes the participant's latest dates if that contact supplied them. */
export async function recomputeLastContacts(q: Q, participantId: string, voided: ContactRow): Promise<void> {
  const p = await maybe<{ last_qualifying_at: Date | null; last_in_person_at: Date | null }>(q, 'SELECT last_qualifying_at, last_in_person_at FROM participants WHERE id = $1', [participantId]);
  if (!p) return;
  if (voided.qualifying && p.last_qualifying_at && p.last_qualifying_at.getTime() === voided.occurred_at.getTime()) {
    const lastQ = await maybe<{ occurred_at: Date; kind: string; confidence: string }>(q,
      'SELECT occurred_at, kind, confidence FROM contacts WHERE participant_id = $1 AND qualifying AND voided_at IS NULL ORDER BY occurred_at DESC LIMIT 1', [participantId]);
    await q.query('UPDATE participants SET last_qualifying_at = $2, last_qualifying_kind = $3, last_qualifying_confidence = $4 WHERE id = $1',
      [participantId, lastQ?.occurred_at ?? null, lastQ?.kind ?? null, lastQ?.confidence ?? null]);
  }
  if (voided.kind === 'in_person' && p.last_in_person_at && p.last_in_person_at.getTime() === voided.occurred_at.getTime()) {
    const lastIp = await maybe<{ occurred_at: Date }>(q,
      "SELECT occurred_at FROM contacts WHERE participant_id = $1 AND kind = 'in_person' AND confidence IN ('known','verified') AND voided_at IS NULL AND NOT needs_approval ORDER BY occurred_at DESC LIMIT 1", [participantId]);
    await q.query('UPDATE participants SET last_in_person_at = $2 WHERE id = $1', [participantId, lastIp?.occurred_at ?? null]);
  }
}

export async function contactHistory(ctx: Ctx, participantId: string, sinceMs?: number) {
  const rows = await many<ContactRow & { recorder: string | null; org_name: string | null }>(ctx.db,
    `SELECT c.*, s.display_name AS recorder, o.name AS org_name FROM contacts c LEFT JOIN staff s ON s.id = c.recorded_by LEFT JOIN organizations o ON o.id = c.recorded_org
      WHERE c.participant_id = $1 AND ($2::timestamptz IS NULL OR c.recorded_at >= $2) ORDER BY c.occurred_at DESC LIMIT 200`, [participantId, ts(sinceMs ?? null)]);
  return Promise.all(rows.map(async (r) => ({
    ...r,
    note: await dec(ctx, participantId, 'contact_note', r.note_enc),
    relayMessage: await dec(ctx, participantId, 'relay_message', r.relay_message_enc),
  })));
}

export async function pendingBackdated(q: Q, orgId: string) {
  return many<{ id: string; participant_id: string; kind: string; occurred_at: Date; recorded_at: Date }>(q,
    `SELECT c.id, c.participant_id, c.kind, c.occurred_at, c.recorded_at FROM contacts c JOIN participants p ON p.id = c.participant_id
      WHERE p.org_id = $1 AND c.needs_approval AND c.voided_at IS NULL ORDER BY c.recorded_at`, [orgId]);
}
