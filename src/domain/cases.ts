import { POLICY } from '../config.js';
import type { Q } from '../db/index.js';
import { many, maybe, one, ts } from '../db/index.js';
import { DAY, type Hours, addBusinessMinutes, businessDayMinutes, isOpen, localDate } from '../lib/calendar.js';
import {
  type Actor, type AnyActor, type Ctx, SYSTEM, audit, clampText, dec, enc, fail, has, requireRole,
} from './core.js';
import { notify } from './notifications.js';
import { type OrgRow, type StaffBrief, dutyChain, getOrg, hoursFor, isAvailable, staffBrief } from './orgs.js';
import { type ParticipantRow, type Plan, currentPlan, getParticipantRow, lockParticipant } from './participants.js';
import { conflictedStaff, effectiveRoles, getStaff, trainingOf } from './staff.js';

export type CaseState = 'offered' | 'uncovered' | 'accepted' | 'stalled' | 'extended_watch' | 'contact_reported' | 'closed';
export type Step = 'primary' | 'backup' | 'coordinator' | 'deputy' | 'program_lead' | 'named';
export type ClosureReason = 'contact_restored' | 'contact_restored_self_report' | 'recording_gap' | 'withdrawn' | 'transferred' | 'reported_deceased' | 'ended_after_extended_follow_up' | 'other_documented';

export interface CaseRow {
  id: string;
  participant_id: string;
  org_id: string;
  trigger: 'overdue' | 'concern' | 'roll_call';
  state: CaseState;
  opened_at: Date;
  overdue_at: Date | null;
  owner_id: string | null;
  offeree_id: string | null;
  chain_step: Step | null;
  offered_at: Date | null;
  offer_expires_at: Date | null;
  uncovered_since: Date | null;
  accepted_at: Date | null;
  last_action_at: Date | null;
  stalled_at: Date | null;
  stall_deadline: Date | null;
  ew_since: Date | null;
  ew_next_review: Date | null;
  reported_contact_id: string | null;
  contact_reported_at: Date | null;
  prior_state: CaseState | null;
  withdrawal_pending: boolean;
  priority: number;
  closure_reason: ClosureReason | null;
  closure_contact_kind: string | null;
  closure_contact_confidence: string | null;
  closed_at: Date | null;
  closed_by: string | null;
  approved_by: string | null;
  second_reviewer: string | null;
  deceased_source: string | null;
  closure_note_enc: Buffer | null;
  reopen_count: number;
  notes_purged: boolean;
}

export const ACCEPT_STATEMENT = 'I am responsible for this follow-up.';

const STEP_ORDER: Step[] = ['primary', 'backup', 'coordinator'];

const FOLLOWUP_ACTIONS: Record<string, string | null> = {
  checked_records: 'records',
  asked_host_staff: 'records',
  called: 'phone',
  texted: 'phone',
  left_voicemail: 'phone',
  visited_usual_place: 'places',
  asked_named_person: 'people',
  asked_partner_org: 'partners',
  other: null,
  review: null,
};
const PASSIVE_ACTIONS = new Set(['checked_records', 'asked_host_staff', 'review']);

export async function getCase(q: Q, id: string): Promise<CaseRow> {
  const c = await maybe<CaseRow>(q, 'SELECT * FROM cases WHERE id = $1', [id]);
  if (!c) fail('Case not found.', 404);
  return c!;
}

async function lockCase(q: Q, id: string): Promise<CaseRow> {
  const c = await maybe<CaseRow>(q, 'SELECT * FROM cases WHERE id = $1 FOR UPDATE', [id]);
  if (!c) fail('Case not found.', 404);
  return c!;
}

export async function openCaseFor(q: Q, participantId: string): Promise<CaseRow | null> {
  return maybe<CaseRow>(q, "SELECT * FROM cases WHERE participant_id = $1 AND state <> 'closed'", [participantId]);
}

export function addBusinessDays(t: number, days: number, h: Hours): number {
  return addBusinessMinutes(t, days * businessDayMinutes(h), h);
}

// ---------------------------------------------------------------------------
// Eligibility and the offer chain (docs/03 §3.7)
// ---------------------------------------------------------------------------

async function openCaseCount(q: Q, staffId: string): Promise<number> {
  const r = await one<{ n: string }>(q, "SELECT count(*) AS n FROM cases WHERE owner_id = $1 AND state IN ('accepted','stalled','extended_watch','contact_reported')", [staffId]);
  return Number(r.n);
}

async function canRespond(q: Q, s: StaffBrief, org: OrgRow, roles: string[]): Promise<boolean> {
  const staff = await getStaff(q, s.id);
  if (!staff) return false;
  const eff = effectiveRoles(staff.roles, await trainingOf(q, s.id), org);
  return roles.some((r) => eff.has(r as never));
}

async function eligibleResponder(q: Q, ctx: Ctx, id: string | null, org: OrgRow, conflicted: Set<string>, excluded: Set<string>, now: number): Promise<StaffBrief | null> {
  if (!id || conflicted.has(id) || excluded.has(id)) return null;
  const s = await staffBrief(q, id);
  if (!s || s.org_id !== org.id || !isAvailable(s, now, org.timezone)) return null;
  if (!(await canRespond(q, s, org, ['responder', 'coordinator']))) return null;
  if ((await openCaseCount(q, id)) >= POLICY.responderCap && !(await canRespond(q, s, org, ['coordinator']))) return null;
  return s;
}

/** The coordinator step never skips for capacity; it falls back from coordinator to deputy to program lead. */
async function eligibleCoordinator(q: Q, org: OrgRow, conflicted: Set<string>, excluded: Set<string>, now: number): Promise<{ s: StaffBrief; step: Step } | null> {
  const chain = await dutyChain(q, org, now);
  for (const [s, step] of [[chain.coordinator, 'coordinator'], [chain.deputy, 'deputy'], [chain.lead, 'program_lead']] as const) {
    if (s && !conflicted.has(s.id) && !excluded.has(s.id) && isAvailable(s, now, org.timezone)) return { s, step };
  }
  return null;
}

function offerMinutes(step: Step): number {
  if (step === 'primary' || step === 'named') return POLICY.offerMinutes.primary;
  if (step === 'backup') return POLICY.offerMinutes.backup;
  return POLICY.offerMinutes.coordinator;
}

async function excludedFor(q: Q, caseId: string, sinceMs: number): Promise<Set<string>> {
  const rows = await many<{ staff_id: string }>(q,
    'SELECT staff_id FROM case_assignments WHERE case_id = $1 AND offered_at >= $2 AND (declined_at IS NOT NULL OR expired_at IS NOT NULL OR released_at IS NOT NULL)',
    [caseId, ts(sinceMs)]);
  return new Set(rows.map((r) => r.staff_id));
}

/**
 * Offers the case to the next eligible person after `afterStep`, or marks it uncovered.
 * `cycleStart` bounds which earlier declines/expiries exclude people (a new cycle starts on reopen).
 */
async function offerNext(q: Q, ctx: Ctx, c: CaseRow, p: ParticipantRow, org: OrgRow, h: Hours, afterStep: Step | null, extraExcluded: string[] = []): Promise<void> {
  const now = ctx.clock.now();
  const conflicted = await conflictedStaff(q, p.id);
  const excluded = await excludedFor(q, c.id, c.opened_at.getTime());
  for (const x of extraExcluded) excluded.add(x);
  const startIdx = afterStep === null || afterStep === 'named' ? 0 : afterStep === 'primary' ? 1 : afterStep === 'backup' ? 2 : 3;
  for (let i = startIdx; i < STEP_ORDER.length; i++) {
    const step = STEP_ORDER[i]!;
    let target: StaffBrief | null = null;
    let actualStep: Step = step;
    if (step === 'primary') target = await eligibleResponder(q, ctx, p.primary_responder_id, org, conflicted, excluded, now);
    else if (step === 'backup') target = await eligibleResponder(q, ctx, p.backup_responder_id, org, conflicted, excluded, now);
    else {
      const co = await eligibleCoordinator(q, org, conflicted, excluded, now);
      if (co) {
        target = co.s;
        actualStep = co.step;
      }
    }
    if (target) {
      await makeOffer(q, ctx, c, target.id, actualStep, h, step !== 'primary');
      return;
    }
  }
  await q.query(
    `UPDATE cases SET state = 'uncovered', owner_id = NULL, offeree_id = NULL, chain_step = NULL, offered_at = NULL, offer_expires_at = NULL,
       uncovered_since = COALESCE(uncovered_since, $2) WHERE id = $1`, [c.id, ts(now)]);
  await audit(q, ctx, SYSTEM, { action: 'case.uncovered', targetType: 'case', targetId: c.id, participantId: p.id });
  await notify(q, ctx, { staffId: org.program_lead_id, orgId: org.id, caseId: c.id, kind: 'uncovered', dedupeKey: `uncovered:${c.id}:${localDate(now, org.timezone)}` });
}

async function makeOffer(q: Q, ctx: Ctx, c: CaseRow, staffId: string, step: Step, h: Hours, escalated: boolean): Promise<void> {
  const now = ctx.clock.now();
  const expires = addBusinessMinutes(now, offerMinutes(step), h);
  await q.query(
    `UPDATE cases SET state = 'offered', owner_id = NULL, offeree_id = $2, chain_step = $3, offered_at = $4, offer_expires_at = $5, uncovered_since = NULL,
       stalled_at = NULL, stall_deadline = NULL WHERE id = $1`, [c.id, staffId, step, ts(now), ts(expires)]);
  await q.query('INSERT INTO case_assignments (case_id, staff_id, step, offered_at) VALUES ($1,$2,$3,$4)', [c.id, staffId, step, ts(now)]);
  await audit(q, ctx, SYSTEM, { action: 'case.offer', targetType: 'case', targetId: c.id, participantId: c.participant_id, details: { step, to: staffId } });
  await notify(q, ctx, { staffId, orgId: c.org_id, caseId: c.id, kind: escalated ? 'escalated' : 'offer' });
}

async function closeCurrentAssignment(q: Q, caseId: string, staffId: string | null, field: 'expired_at' | 'declined_at' | 'released_at', now: number, reason?: string): Promise<void> {
  if (!staffId) return;
  const extra = field === 'declined_at' ? ', decline_reason = $4' : field === 'released_at' ? ', release_reason = $4' : '';
  await q.query(
    `UPDATE case_assignments SET ${field} = $3${extra} WHERE id = (SELECT id FROM case_assignments WHERE case_id = $1 AND staff_id = $2 ORDER BY offered_at DESC LIMIT 1)`,
    extra ? [caseId, staffId, ts(now), reason ?? null] : [caseId, staffId, ts(now)]);
}

// ---------------------------------------------------------------------------
// Opening cases
// ---------------------------------------------------------------------------

export async function openCase(q: Q, ctx: Ctx, p: ParticipantRow, trigger: CaseRow['trigger'], overdueAt: number | null, actor: AnyActor = SYSTEM, assignTo?: string): Promise<CaseRow> {
  const now = ctx.clock.now();
  const org = await getOrg(q, p.org_id);
  const h = await hoursFor(q, org);
  let priority = 0;
  try {
    const plan = await currentPlan(q, ctx, p.id);
    priority = plan.disasterPriority ? 1 : 0;
  } catch {
    priority = 0;
  }
  const c = await one<CaseRow>(q,
    `INSERT INTO cases (participant_id, org_id, trigger, state, opened_at, overdue_at, priority) VALUES ($1,$2,$3,'uncovered',$4,$5,$6) RETURNING *`,
    [p.id, p.org_id, trigger, ts(now), ts(overdueAt), priority]);
  await audit(q, ctx, actor, { action: 'case.open', targetType: 'case', targetId: c.id, participantId: p.id, details: { trigger } });
  await q.query('UPDATE concerns SET linked_case_id = $2 WHERE participant_id = $1 AND linked_case_id IS NULL', [p.id, c.id]);
  if (assignTo) {
    const conflicted = await conflictedStaff(q, p.id);
    const s = await eligibleResponder(q, ctx, assignTo, org, conflicted, new Set(), now) ?? (await eligibleCoordinatorById(q, org, assignTo, conflicted, now));
    if (!s) fail('That staff member cannot take this case (away, excluded, at capacity, or not a responder).');
    await makeOffer(q, ctx, c, assignTo, 'named', h, false);
  } else {
    await offerNext(q, ctx, c, p, org, h, null);
  }
  return getCase(q, c.id);
}

async function eligibleCoordinatorById(q: Q, org: OrgRow, id: string, conflicted: Set<string>, now: number): Promise<StaffBrief | null> {
  if (conflicted.has(id)) return null;
  const s = await staffBrief(q, id);
  if (!s || s.org_id !== org.id || !isAvailable(s, now, org.timezone)) return null;
  return (await canRespond(q, s, org, ['coordinator', 'program_lead'])) ? s : null;
}

// ---------------------------------------------------------------------------
// Staff actions on cases
// ---------------------------------------------------------------------------

async function caseContext(q: Q, c: CaseRow) {
  const p = await getParticipantRow(q, c.participant_id);
  const org = await getOrg(q, c.org_id);
  const h = await hoursFor(q, org);
  return { p, org, h };
}

function assertOrg(actor: Actor, c: CaseRow): void {
  if (c.org_id !== actor.orgId) fail('Case not found.', 404);
}

export async function acceptCase(ctx: Ctx, actor: Actor, caseId: string, statement: string): Promise<void> {
  if (statement.trim() !== ACCEPT_STATEMENT) fail(`To accept, confirm: "${ACCEPT_STATEMENT}"`);
  const now = ctx.clock.now();
  await ctx.db.tx(async (q) => {
    const c = await lockCase(q, caseId);
    assertOrg(actor, c);
    const { p, org } = await caseContext(q, c);
    const conflicted = await conflictedStaff(q, p.id);
    if (conflicted.has(actor.staffId)) fail('You are excluded from this participant’s record.', 403);
    const coordinatorish = has(actor, 'coordinator', 'program_lead');
    if (c.state === 'offered') {
      if (c.offeree_id !== actor.staffId && !coordinatorish) fail('This task was offered to someone else.', 403);
    } else if (c.state !== 'uncovered') fail('This task cannot be accepted now.');
    if (!has(actor, 'responder', 'coordinator', 'program_lead')) fail('Only responders and coordinators accept follow-up tasks.', 403);
    if (!coordinatorish && (await openCaseCount(q, actor.staffId)) >= POLICY.responderCap) fail(`You already have ${POLICY.responderCap} open cases. Ask the coordinator to reassign.`);
    if (c.offeree_id && c.offeree_id !== actor.staffId) await closeCurrentAssignment(q, c.id, c.offeree_id, 'expired_at', now);
    if (c.offeree_id === actor.staffId) await q.query('UPDATE case_assignments SET accepted_at = $3 WHERE id = (SELECT id FROM case_assignments WHERE case_id = $1 AND staff_id = $2 ORDER BY offered_at DESC LIMIT 1)', [c.id, actor.staffId, ts(now)]);
    else await q.query('INSERT INTO case_assignments (case_id, staff_id, step, offered_at, accepted_at) VALUES ($1,$2,$3,$4,$4)', [c.id, actor.staffId, c.state === 'uncovered' ? 'named' : 'coordinator', ts(now)]);
    await q.query(
      `UPDATE cases SET state = 'accepted', owner_id = $2, offeree_id = NULL, offered_at = NULL, offer_expires_at = NULL, uncovered_since = NULL,
         accepted_at = $3, last_action_at = NULL, stalled_at = NULL, stall_deadline = NULL WHERE id = $1`, [c.id, actor.staffId, ts(now)]);
    await audit(q, ctx, actor, { action: 'case.accept', targetType: 'case', targetId: c.id, participantId: p.id, details: { statement: ACCEPT_STATEMENT, from: c.state } });
    void org;
  });
}

export async function declineCase(ctx: Ctx, actor: Actor, caseId: string, reason: string): Promise<void> {
  const r = clampText(reason, 200) ?? fail('Say why you are declining (on leave, conflict, capacity…).');
  await ctx.db.tx(async (q) => {
    const c = await lockCase(q, caseId);
    assertOrg(actor, c);
    if (c.state !== 'offered' || c.offeree_id !== actor.staffId) fail('Only the person this task is offered to can decline it.', 403);
    const { p, org, h } = await caseContext(q, c);
    await closeCurrentAssignment(q, c.id, actor.staffId, 'declined_at', ctx.clock.now(), r);
    await audit(q, ctx, actor, { action: 'case.decline', targetType: 'case', targetId: c.id, participantId: p.id, reason: r });
    await offerNext(q, ctx, c, p, org, h, c.chain_step, [actor.staffId]);
  });
}

export async function releaseCase(ctx: Ctx, actor: Actor, caseId: string, reason: string): Promise<void> {
  const r = clampText(reason, 200) ?? fail('Say why you are handing this back.');
  await ctx.db.tx(async (q) => {
    const c = await lockCase(q, caseId);
    assertOrg(actor, c);
    if (!['accepted', 'stalled'].includes(c.state) || c.owner_id !== actor.staffId) fail('Only the current owner can release this case.', 403);
    if (c.withdrawal_pending) fail('A case with a pending withdrawal stays with the coordinator.');
    const { p, org, h } = await caseContext(q, c);
    await closeCurrentAssignment(q, c.id, actor.staffId, 'released_at', ctx.clock.now(), r);
    await audit(q, ctx, actor, { action: 'case.release', targetType: 'case', targetId: c.id, participantId: p.id, reason: r });
    await offerNext(q, ctx, c, p, org, h, stepOfOwner(c, p, actor.staffId), [actor.staffId]);
  });
}

function stepOfOwner(c: CaseRow, p: ParticipantRow, staffId: string): Step {
  if (p.primary_responder_id === staffId) return 'primary';
  if (p.backup_responder_id === staffId) return 'backup';
  return c.chain_step === 'named' ? 'primary' : (c.chain_step ?? 'primary');
}

export async function reassignCase(ctx: Ctx, actor: Actor, caseId: string, staffId: string): Promise<void> {
  requireRole(actor, 'coordinator', 'program_lead');
  await ctx.db.tx(async (q) => {
    const c = await lockCase(q, caseId);
    assertOrg(actor, c);
    if (c.state === 'closed' || c.state === 'contact_reported') fail('This case cannot be reassigned now.');
    if (c.withdrawal_pending) fail('A case with a pending withdrawal stays with the coordinator.');
    const { p, org, h } = await caseContext(q, c);
    const conflicted = await conflictedStaff(q, p.id);
    const now = ctx.clock.now();
    const s = (await eligibleResponder(q, ctx, staffId, org, conflicted, new Set(), now)) ?? (await eligibleCoordinatorById(q, org, staffId, conflicted, now));
    if (!s) fail('That staff member cannot take this case (away, excluded, at capacity, or not a responder).');
    if (c.owner_id) await closeCurrentAssignment(q, c.id, c.owner_id, 'released_at', now, 'reassigned by coordinator');
    if (c.offeree_id) await closeCurrentAssignment(q, c.id, c.offeree_id, 'expired_at', now);
    await audit(q, ctx, actor, { action: 'case.reassign', targetType: 'case', targetId: c.id, participantId: p.id, details: { to: staffId } });
    await makeOffer(q, ctx, c, staffId, 'named', h, true);
  });
}

export interface ActionInput {
  action: keyof typeof FOLLOWUP_ACTIONS;
  source: 'participant' | 'host_staff' | 'partner_staff' | 'named_person' | 'other_person' | 'none';
  result: 'no_information' | 'lead' | 'contact_restored' | 'impossible';
  certainty: 'low' | 'medium' | 'high';
  note?: string | null;
  /** A firsthand contact made during this action (required when result is contact_restored). */
  contact?: { kind: 'in_person' | 'phone_with_staff'; confidence: 'known' | 'verified' | 'stated' | 'code_only' };
}

export async function recordAction(ctx: Ctx, actor: Actor, caseId: string, input: ActionInput): Promise<{ closed: boolean }> {
  if (!(input.action in FOLLOWUP_ACTIONS)) fail('Unknown action.');
  const note = clampText(input.note, POLICY.noteMax.action);
  if (input.result === 'contact_restored' && !input.contact) fail('Record how you were in contact (in person or by phone) and how you confirmed who it was.');
  const now = ctx.clock.now();
  const { recordContactInTx } = await import('./contacts.js');
  return ctx.db.tx(async (q) => {
    const c = await lockCase(q, caseId);
    assertOrg(actor, c);
    if (!['accepted', 'stalled', 'extended_watch'].includes(c.state)) fail('Accept the case before recording follow-up.');
    if (c.owner_id !== actor.staffId && !has(actor, 'coordinator')) fail('Only the case owner records follow-up.', 403);
    const plan = await currentPlan(q, ctx, c.participant_id);
    const needed = FOLLOWUP_ACTIONS[input.action];
    if (c.withdrawal_pending && !PASSIVE_ACTIONS.has(input.action)) fail('This participant asked to withdraw; only passive steps (checking records, asking host staff) are allowed until they confirm in person.');
    if (needed && !plan.followup.includes(needed as Plan['followup'][number])) fail('The participant did not agree to that kind of follow-up. Record why another step is needed and ask the coordinator.');
    if ((input.action === 'texted') && !plan.phoneText) fail('The participant did not say texting is safe.');
    if ((input.action === 'called') && !plan.phoneCall) fail('The participant did not say calling is safe.');
    if ((input.action === 'left_voicemail') && !plan.phoneVoicemail) fail('The participant did not say voicemail is safe.');
    await q.query(`INSERT INTO case_actions (case_id, staff_id, at, action, source, result, certainty, note_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [c.id, actor.staffId, ts(now), input.action, input.source, input.result, input.certainty, await enc(ctx, c.participant_id, 'action_note', note)]);
    const nextState = c.state === 'stalled' ? 'accepted' : c.state;
    await q.query('UPDATE cases SET last_action_at = $2, state = $3, stalled_at = NULL, stall_deadline = NULL WHERE id = $1', [c.id, ts(now), nextState]);
    await audit(q, ctx, actor, { action: 'case.action', targetType: 'case', targetId: c.id, participantId: c.participant_id, details: { action: input.action, result: input.result, certainty: input.certainty } });
    if (input.contact) {
      const r = await recordContactInTx(q, ctx, actor, { participantId: c.participant_id, kind: input.contact.kind, confidence: input.contact.confidence, source: 'staff' });
      const after = await getCase(q, c.id);
      return { closed: after.state === 'closed' || r.closedCase };
    }
    return { closed: false };
  });
}

/**
 * A qualifying contact was recorded while the case is open (docs/03 §3.11). If the person who
 * recorded it owns the case, they are confirming it themselves; otherwise the owner (or the
 * coordinator on duty when nobody owns it) must confirm it was the right person.
 */
export async function onQualifyingContact(q: Q, ctx: Ctx, actor: AnyActor, c: CaseRow, contact: { id: string; kind: string; confidence: string; occurred_at: Date }): Promise<boolean> {
  const now = ctx.clock.now();
  const recorderOwns = actor.kind === 'staff' && c.owner_id === actor.staffId;
  if (recorderOwns) {
    await closeWith(q, ctx, actor, c, contact.occurred_at.getTime() < c.opened_at.getTime() ? 'recording_gap' : 'contact_restored', contact);
    return true;
  }
  let owner = c.owner_id;
  if (!owner) {
    const org = await getOrg(q, c.org_id);
    const duty = await dutyChain(q, org, now);
    owner = duty.onDuty?.id ?? org.program_lead_id;
    if (c.offeree_id) await closeCurrentAssignment(q, c.id, c.offeree_id, 'expired_at', now);
  }
  if (!owner) return false;
  await q.query(
    `UPDATE cases SET prior_state = CASE WHEN state = 'contact_reported' THEN prior_state ELSE state END, state = 'contact_reported', owner_id = $2, offeree_id = NULL,
       offered_at = NULL, offer_expires_at = NULL, uncovered_since = NULL, reported_contact_id = $3, contact_reported_at = $4 WHERE id = $1`,
    [c.id, owner, contact.id, ts(now)]);
  await audit(q, ctx, SYSTEM, { action: 'case.contact_reported', targetType: 'case', targetId: c.id, participantId: c.participant_id, details: { kind: contact.kind, confidence: contact.confidence } });
  await notify(q, ctx, { staffId: owner, orgId: c.org_id, caseId: c.id, kind: 'contact_reported' });
  return false;
}

async function closeWith(q: Q, ctx: Ctx, actor: AnyActor, c: CaseRow, reason: ClosureReason, contact?: { id: string; kind: string; confidence: string } | null, extra: { approvedBy?: string; secondReviewer?: string; deceasedSource?: string; note?: string | null } = {}): Promise<void> {
  const now = ctx.clock.now();
  const closedBy = actor.kind === 'staff' ? actor.staffId : null;
  await q.query(
    `UPDATE cases SET state = 'closed', closure_reason = $2, closure_contact_kind = $3, closure_contact_confidence = $4, closed_at = $5, closed_by = $6,
       approved_by = $7, second_reviewer = $8, deceased_source = $9, closure_note_enc = $10, reported_contact_id = COALESCE($11, reported_contact_id),
       offeree_id = NULL, offered_at = NULL, offer_expires_at = NULL, uncovered_since = NULL, stalled_at = NULL, stall_deadline = NULL WHERE id = $1`,
    [c.id, reason, contact?.kind ?? null, contact?.confidence ?? null, ts(now), closedBy, extra.approvedBy ?? null, extra.secondReviewer ?? null,
      extra.deceasedSource ?? null, await enc(ctx, c.participant_id, 'closure_note', extra.note ?? null), contact?.id ?? null]);
  await audit(q, ctx, actor, { action: 'case.close', targetType: 'case', targetId: c.id, participantId: c.participant_id, details: { reason } });
}

export async function confirmReportedContact(ctx: Ctx, actor: Actor, caseId: string, rightPerson: boolean, reason?: string): Promise<void> {
  const { voidContactInTx } = await import('./contacts.js');
  await ctx.db.tx(async (q) => {
    const c = await lockCase(q, caseId);
    assertOrg(actor, c);
    if (c.state !== 'contact_reported') fail('There is no reported contact to confirm.');
    if (c.owner_id !== actor.staffId && !has(actor, 'coordinator', 'program_lead')) fail('Only the case owner or a coordinator confirms reported contacts.', 403);
    const contact = await maybe<{ id: string; kind: string; confidence: string; occurred_at: Date; voided_at: Date | null }>(q, 'SELECT id, kind, confidence, occurred_at, voided_at FROM contacts WHERE id = $1', [c.reported_contact_id]);
    if (rightPerson) {
      if (!contact || contact.voided_at) fail('The reported contact is no longer valid.');
      await closeWith(q, ctx, actor, c, contact!.occurred_at.getTime() < c.opened_at.getTime() ? 'recording_gap' : 'contact_restored', contact);
    } else {
      const r = clampText(reason, 200) ?? fail('Say why this was the wrong person.');
      if (contact) await voidContactInTx(q, ctx, actor, contact.id, r, { skipCaseEffects: true });
      const back = c.owner_id ?? actor.staffId;
      await q.query(`UPDATE cases SET state = 'accepted', owner_id = $2, reported_contact_id = NULL, contact_reported_at = NULL, prior_state = NULL,
          accepted_at = COALESCE(accepted_at, $3) WHERE id = $1`, [c.id, back, ts(ctx.clock.now())]);
      await audit(q, ctx, actor, { action: 'case.contact_rejected', targetType: 'case', targetId: c.id, participantId: c.participant_id, reason: r });
    }
  });
}

/** Closes on a credible self-check-in the owner has reviewed (always in the weekly closure review). */
export async function closeOnSelfReport(ctx: Ctx, actor: Actor, caseId: string, contactId: string): Promise<void> {
  await ctx.db.tx(async (q) => {
    const c = await lockCase(q, caseId);
    assertOrg(actor, c);
    if (!['accepted', 'stalled', 'extended_watch'].includes(c.state)) fail('This case cannot be closed that way now.');
    if (c.owner_id !== actor.staffId && !has(actor, 'coordinator')) fail('Only the case owner can do that.', 403);
    const contact = await maybe<{ id: string; kind: string; confidence: string; recorded_at: Date; voided_at: Date | null; participant_id: string }>(q,
      'SELECT id, kind, confidence, recorded_at, voided_at, participant_id FROM contacts WHERE id = $1', [contactId]);
    if (!contact || contact.participant_id !== c.participant_id || contact.kind !== 'self_check_in' || contact.voided_at || contact.recorded_at.getTime() < c.opened_at.getTime()) {
      fail('Choose a self-check-in received after this case opened.');
    }
    if (c.withdrawal_pending) fail('A pending withdrawal must be confirmed or reversed in person first.');
    await closeWith(q, ctx, actor, c, 'contact_restored_self_report', contact);
  });
}

// ---------------------------------------------------------------------------
// Closures that need approval (docs/03 §3.9)
// ---------------------------------------------------------------------------

export async function proposeClosure(ctx: Ctx, actor: Actor, caseId: string, input: { reason: 'reported_deceased' | 'ended_after_extended_follow_up' | 'other_documented'; note?: string | null; deceasedSource?: string | null }): Promise<string> {
  const note = clampText(input.note, POLICY.noteMax.reason);
  if (input.reason === 'other_documented' && !note) fail('Describe the documented outcome.');
  if (input.reason === 'reported_deceased' && !['official_notification', 'next_of_kin_confirmed', 'staff_confirmed'].includes(input.deceasedSource ?? '')) {
    fail('Choose how the death was confirmed: an official notification, next of kin with official confirmation, or staff who personally confirmed. A relative’s word alone is not enough.');
  }
  return ctx.db.tx(async (q) => {
    const c = await lockCase(q, caseId);
    assertOrg(actor, c);
    if (!['accepted', 'stalled', 'extended_watch'].includes(c.state)) fail('Only an accepted case can be proposed for this closure.');
    if (c.owner_id !== actor.staffId && !has(actor, 'coordinator', 'program_lead')) fail('Only the case owner or a coordinator can propose this.', 403);
    if (input.reason === 'ended_after_extended_follow_up') {
      if (c.state !== 'extended_watch' || !c.ew_since || ctx.clock.now() - c.ew_since.getTime() < POLICY.extendedWatchMaxDays * DAY) {
        fail(`This closure is possible only after ${POLICY.extendedWatchMaxDays} days in extended watch.`);
      }
    }
    const pending = await maybe(q, "SELECT 1 FROM closure_proposals WHERE case_id = $1 AND decision IS NULL", [c.id]);
    if (pending) fail('A closure proposal is already waiting for a decision.');
    const row = await one<{ id: string }>(q,
      `INSERT INTO closure_proposals (case_id, reason, deceased_source, note_enc, proposed_by, proposed_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [c.id, input.reason, input.deceasedSource ?? null, await enc(ctx, c.participant_id, 'closure_note', note), actor.staffId, ts(ctx.clock.now())]);
    await audit(q, ctx, actor, { action: 'case.closure_proposed', targetType: 'case', targetId: c.id, participantId: c.participant_id, details: { reason: input.reason } });
    const org = await getOrg(q, c.org_id);
    if (input.reason === 'reported_deceased') {
      const chain = await dutyChain(q, org, ctx.clock.now());
      for (const s of [chain.coordinator, chain.deputy]) if (s && s.id !== actor.staffId) await notify(q, ctx, { staffId: s.id, orgId: org.id, caseId: c.id, kind: 'closure_second_review' });
    }
    await notify(q, ctx, { staffId: org.program_lead_id, orgId: org.id, caseId: c.id, kind: 'closure_approval' });
    return row.id;
  });
}

export async function secondReview(ctx: Ctx, actor: Actor, proposalId: string): Promise<void> {
  requireRole(actor, 'coordinator', 'program_lead');
  await ctx.db.tx(async (q) => {
    const pr = await maybe<{ id: string; case_id: string; reason: string; proposed_by: string; reviewed_by: string | null; decision: string | null }>(q, 'SELECT * FROM closure_proposals WHERE id = $1 FOR UPDATE', [proposalId]);
    if (!pr || pr.decision) fail('Proposal not found.', 404);
    const c = await getCase(q, pr!.case_id);
    assertOrg(actor, c);
    if (pr!.reason !== 'reported_deceased') fail('Only reported deaths need a second reviewer.');
    if (pr!.proposed_by === actor.staffId) fail('The second reviewer must be someone other than the person who proposed it.');
    await q.query('UPDATE closure_proposals SET reviewed_by = $2, reviewed_at = $3 WHERE id = $1', [proposalId, actor.staffId, ts(ctx.clock.now())]);
    await audit(q, ctx, actor, { action: 'case.closure_reviewed', targetType: 'case', targetId: c.id, participantId: c.participant_id });
  });
}

export async function decideClosure(ctx: Ctx, actor: Actor, proposalId: string, approve: boolean): Promise<void> {
  requireRole(actor, 'program_lead');
  const { endEnrollment } = await import('./lifecycle.js');
  await ctx.db.tx(async (q) => {
    const pr = await maybe<{ id: string; case_id: string; reason: ClosureReason; deceased_source: string | null; note_enc: Buffer | null; proposed_by: string; reviewed_by: string | null; decision: string | null }>(q,
      'SELECT * FROM closure_proposals WHERE id = $1 FOR UPDATE', [proposalId]);
    if (!pr || pr.decision) fail('Proposal not found.', 404);
    const c = await lockCase(q, pr!.case_id);
    assertOrg(actor, c);
    const now = ctx.clock.now();
    await q.query('UPDATE closure_proposals SET decided_by = $2, decided_at = $3, decision = $4 WHERE id = $1', [proposalId, actor.staffId, ts(now), approve ? 'approved' : 'rejected']);
    if (!approve) {
      await audit(q, ctx, actor, { action: 'case.closure_rejected', targetType: 'case', targetId: c.id, participantId: c.participant_id });
      return;
    }
    if (!['accepted', 'stalled', 'extended_watch'].includes(c.state)) fail('The case is no longer in a state that can be closed this way.');
    if (pr!.reason === 'reported_deceased') {
      if (!pr!.reviewed_by) fail('A second reviewer must confirm a reported death first.');
      if (pr!.reviewed_by === actor.staffId) fail('The approver must be different from the second reviewer.');
    }
    const note = await dec(ctx, c.participant_id, 'closure_note', pr!.note_enc);
    await closeWith(q, ctx, actor, c, pr!.reason, null, { approvedBy: actor.staffId, secondReviewer: pr!.reviewed_by ?? undefined, deceasedSource: pr!.deceased_source ?? undefined, note });
    await endEnrollment(q, ctx, actor, c.participant_id, pr!.reason === 'ended_after_extended_follow_up' ? 'inactive' : 'ended', pr!.reason);
  });
}

// ---------------------------------------------------------------------------
// Extended watch and reopening
// ---------------------------------------------------------------------------

export async function startExtendedWatch(ctx: Ctx, actor: Actor, caseId: string): Promise<void> {
  requireRole(actor, 'coordinator');
  await ctx.db.tx(async (q) => {
    const c = await lockCase(q, caseId);
    assertOrg(actor, c);
    if (!['accepted', 'stalled'].includes(c.state)) fail('Only an accepted case can move to extended watch.');
    const { h } = await caseContext(q, c);
    const now = ctx.clock.now();
    if (now < addBusinessDays(c.opened_at.getTime(), POLICY.extendedWatchMinBusinessDays, h)) fail(`Extended watch is possible after ${POLICY.extendedWatchMinBusinessDays} business days of follow-up.`);
    const plan = await currentPlan(q, ctx, c.participant_id);
    const tried = new Set((await many<{ action: string }>(q, 'SELECT DISTINCT action FROM case_actions WHERE case_id = $1', [c.id])).map((a) => FOLLOWUP_ACTIONS[a.action]).filter(Boolean));
    const missing = plan.followup.filter((f) => !tried.has(f));
    if (missing.length) fail(`Every method the participant agreed to must be tried (or recorded as impossible) first. Not yet tried: ${missing.join(', ')}.`);
    await q.query("UPDATE cases SET state = 'extended_watch', ew_since = $2, ew_next_review = $3, stalled_at = NULL, stall_deadline = NULL WHERE id = $1",
      [c.id, ts(now), ts(addBusinessDays(now, POLICY.extendedWatchReviewBusinessDays, h))]);
    await audit(q, ctx, actor, { action: 'case.extended_watch', targetType: 'case', targetId: c.id, participantId: c.participant_id });
  });
}

export async function recordReview(ctx: Ctx, actor: Actor, caseId: string, note: string | null): Promise<void> {
  await ctx.db.tx(async (q) => {
    const c = await lockCase(q, caseId);
    assertOrg(actor, c);
    if (c.state !== 'extended_watch') fail('Reviews apply to cases in extended watch.');
    if (c.owner_id !== actor.staffId && !has(actor, 'coordinator')) fail('Only the owner or a coordinator records reviews.', 403);
    const { h } = await caseContext(q, c);
    const now = ctx.clock.now();
    await q.query(`INSERT INTO case_actions (case_id, staff_id, at, action, source, result, certainty, note_enc) VALUES ($1,$2,$3,'review','none','no_information','low',$4)`,
      [c.id, actor.staffId, ts(now), await enc(ctx, c.participant_id, 'action_note', clampText(note, POLICY.noteMax.action))]);
    await q.query('UPDATE cases SET last_action_at = $2, ew_next_review = $3 WHERE id = $1', [c.id, ts(now), ts(addBusinessDays(now, POLICY.extendedWatchReviewBusinessDays, h))]);
    await audit(q, ctx, actor, { action: 'case.review', targetType: 'case', targetId: c.id, participantId: c.participant_id });
  });
}

export async function resumeActiveFollowup(ctx: Ctx, actor: Actor, caseId: string): Promise<void> {
  await ctx.db.tx(async (q) => {
    const c = await lockCase(q, caseId);
    assertOrg(actor, c);
    if (c.state !== 'extended_watch') fail('This case is not in extended watch.');
    if (c.owner_id !== actor.staffId && !has(actor, 'coordinator')) fail('Only the owner or a coordinator can do that.', 403);
    await q.query("UPDATE cases SET state = 'accepted', last_action_at = $2, ew_next_review = NULL WHERE id = $1", [c.id, ts(ctx.clock.now())]);
    await audit(q, ctx, actor, { action: 'case.resume', targetType: 'case', targetId: c.id, participantId: c.participant_id });
  });
}

const REOPENABLE: ClosureReason[] = ['contact_restored', 'contact_restored_self_report', 'recording_gap'];

export async function reopenCase(ctx: Ctx, actor: AnyActor, caseId: string, reason: string, q0?: Q): Promise<void> {
  const run = async (q: Q) => {
    const c = await lockCase(q, caseId);
    if (actor.kind === 'staff') {
      assertOrg(actor, c);
      requireRole(actor, 'coordinator', 'program_lead');
    }
    if (c.state !== 'closed' || !c.closure_reason || !REOPENABLE.includes(c.closure_reason)) fail('Only cases closed on a contact can be reopened.');
    const now = ctx.clock.now();
    if (now - c.closed_at!.getTime() > POLICY.reopenDays * DAY) fail(`Cases can be reopened within ${POLICY.reopenDays} days of closing.`);
    const p = await lockParticipant(q, c.participant_id);
    if (p.state !== 'active') fail('The participant is not active.');
    if (await openCaseFor(q, p.id)) fail('This participant already has an open case.');
    const { org, h } = await caseContext(q, c);
    const owner = c.closed_by ? await staffBrief(q, c.closed_by) : null;
    const conflicted = await conflictedStaff(q, p.id);
    await q.query(`UPDATE cases SET state = 'uncovered', closure_reason = NULL, closure_contact_kind = NULL, closure_contact_confidence = NULL, closed_at = NULL,
        closed_by = NULL, approved_by = NULL, second_reviewer = NULL, reported_contact_id = NULL, owner_id = NULL, reopen_count = reopen_count + 1 WHERE id = $1`, [c.id]);
    await audit(q, ctx, actor, { action: 'case.reopen', targetType: 'case', targetId: c.id, participantId: p.id, reason });
    if (owner && isAvailable(owner, now, org.timezone) && !conflicted.has(owner.id)) {
      await q.query("UPDATE cases SET state = 'accepted', owner_id = $2, accepted_at = $3, last_action_at = NULL WHERE id = $1", [c.id, owner.id, ts(now)]);
      await q.query('INSERT INTO case_assignments (case_id, staff_id, step, offered_at, accepted_at) VALUES ($1,$2,$3,$4,$4)', [c.id, owner.id, 'named', ts(now)]);
      await notify(q, ctx, { staffId: owner.id, orgId: org.id, caseId: c.id, kind: 'escalated' });
    } else {
      await offerNext(q, ctx, await getCase(q, c.id), p, org, h, null);
    }
  };
  if (q0) await run(q0);
  else await ctx.db.tx(run);
}

// ---------------------------------------------------------------------------
// Lifecycle hooks used by withdrawal, transfer, conflicts and account changes
// ---------------------------------------------------------------------------

export async function closeForLifecycle(q: Q, ctx: Ctx, actor: AnyActor, participantId: string, reason: 'withdrawn' | 'transferred'): Promise<void> {
  const c = await openCaseFor(q, participantId);
  if (c) await closeWith(q, ctx, actor, c, reason);
}

/** Remote withdrawal pending: the open case passes to the coordinator, passive steps only. */
export async function handOverForPendingWithdrawal(q: Q, ctx: Ctx, actor: AnyActor, participantId: string): Promise<void> {
  const c = await openCaseFor(q, participantId);
  if (!c) return;
  const org = await getOrg(q, c.org_id);
  const now = ctx.clock.now();
  const duty = await dutyChain(q, org, now);
  const coord = duty.onDuty?.id ?? org.program_lead_id;
  if (!coord) return;
  if (c.offeree_id) await closeCurrentAssignment(q, c.id, c.offeree_id, 'expired_at', now);
  if (c.owner_id && c.owner_id !== coord) await closeCurrentAssignment(q, c.id, c.owner_id, 'released_at', now, 'withdrawal pending');
  await q.query(`UPDATE cases SET state = CASE WHEN state = 'contact_reported' THEN state ELSE 'accepted' END, owner_id = $2, offeree_id = NULL, offered_at = NULL,
      offer_expires_at = NULL, uncovered_since = NULL, stalled_at = NULL, stall_deadline = NULL, withdrawal_pending = true, accepted_at = COALESCE(accepted_at, $3) WHERE id = $1`,
  [c.id, coord, ts(now)]);
  await q.query('INSERT INTO case_assignments (case_id, staff_id, step, offered_at, accepted_at) VALUES ($1,$2,$3,$4,$4)', [c.id, coord, 'coordinator', ts(now)]);
  await audit(q, ctx, actor, { action: 'case.withdrawal_pending', targetType: 'case', targetId: c.id, participantId });
}

export async function clearWithdrawalPending(q: Q, participantId: string): Promise<void> {
  await q.query("UPDATE cases SET withdrawal_pending = false WHERE participant_id = $1 AND state <> 'closed'", [participantId]);
}

/** Moves a case away from a staff member (conflict declared, account disabled). */
export async function reassignAwayFrom(q: Q, ctx: Ctx, actor: AnyActor, participantId: string, staffId: string, why: string): Promise<void> {
  const c = await openCaseFor(q, participantId);
  if (!c || (c.owner_id !== staffId && c.offeree_id !== staffId)) return;
  const { p, org, h } = await caseContext(q, c);
  const now = ctx.clock.now();
  await closeCurrentAssignment(q, c.id, staffId, c.owner_id === staffId ? 'released_at' : 'expired_at', now, why);
  await audit(q, ctx, actor, { action: 'case.moved', targetType: 'case', targetId: c.id, participantId, reason: why });
  if (c.withdrawal_pending || c.state === 'contact_reported') {
    const duty = await dutyChain(q, org, now);
    const coord = [duty.coordinator, duty.deputy, duty.lead].find((s) => s && s.id !== staffId && isAvailable(s, now, org.timezone));
    if (coord) {
      await q.query('UPDATE cases SET owner_id = $2 WHERE id = $1', [c.id, coord.id]);
      return;
    }
  }
  await offerNext(q, ctx, c, p, org, h, c.owner_id === staffId ? stepOfOwner(c, p, staffId) : c.chain_step, [staffId]);
}

export async function moveCasesOfDisabledStaff(q: Q, ctx: Ctx, actor: Actor, staffId: string): Promise<void> {
  const rows = await many<{ participant_id: string }>(q, "SELECT participant_id FROM cases WHERE state <> 'closed' AND (owner_id = $1 OR offeree_id = $1)", [staffId]);
  for (const r of rows) await reassignAwayFrom(q, ctx, actor, r.participant_id, staffId, 'account disabled');
  await q.query('UPDATE participants SET primary_responder_id = NULL WHERE primary_responder_id = $1', [staffId]);
  await q.query('UPDATE participants SET backup_responder_id = NULL WHERE backup_responder_id = $1', [staffId]);
}

// ---------------------------------------------------------------------------
// Timers (docs/03 §3.11 transition table and guards)
// ---------------------------------------------------------------------------

export async function tickCases(ctx: Ctx, orgId: string): Promise<{ escalated: number; stalled: number; reassigned: number }> {
  const org = await getOrg(ctx.db, orgId);
  const h = await hoursFor(ctx.db, org);
  const now = ctx.clock.now();
  const today = localDate(now, org.timezone);
  const open = isOpen(now, h);
  let escalated = 0;
  let stalled = 0;
  let reassigned = 0;
  const cases = await many<CaseRow>(ctx.db, "SELECT * FROM cases WHERE org_id = $1 AND state <> 'closed'", [orgId]);
  for (const c0 of cases) {
    await ctx.db.tx(async (q) => {
      const c = await lockCase(q, c0.id);
      if (c.state === 'closed') return;
      const p = await getParticipantRow(q, c.participant_id);
      if (c.state === 'offered' && c.offer_expires_at && now >= c.offer_expires_at.getTime()) {
        await closeCurrentAssignment(q, c.id, c.offeree_id, 'expired_at', now);
        await audit(q, ctx, SYSTEM, { action: 'case.offer_expired', targetType: 'case', targetId: c.id, participantId: p.id, details: { step: c.chain_step } });
        await offerNext(q, ctx, c, p, org, h, c.chain_step, c.offeree_id ? [c.offeree_id] : []);
        escalated++;
        return;
      }
      if (c.state === 'uncovered' && open) {
        await notify(q, ctx, { staffId: org.program_lead_id, orgId, caseId: c.id, kind: 'uncovered', dedupeKey: `uncovered:${c.id}:${today}` });
        return;
      }
      if (c.state === 'accepted' && !c.withdrawal_pending) {
        const base = (c.last_action_at ?? c.accepted_at)!.getTime();
        const deadline = addBusinessDays(base, c.last_action_at ? POLICY.updateBusinessDays : POLICY.firstActionBusinessDays, h);
        if (now >= deadline) {
          const stallDeadline = addBusinessDays(now, POLICY.stallBusinessDays, h);
          await q.query("UPDATE cases SET state = 'stalled', stalled_at = $2, stall_deadline = $3 WHERE id = $1", [c.id, ts(now), ts(stallDeadline)]);
          await audit(q, ctx, SYSTEM, { action: 'case.stalled', targetType: 'case', targetId: c.id, participantId: p.id });
          const duty = await dutyChain(q, org, now);
          await notify(q, ctx, { staffId: duty.onDuty?.id, orgId, caseId: c.id, kind: 'stalled', dedupeKey: `stalled:${c.id}:${now}` });
          stalled++;
        }
        return;
      }
      if (c.state === 'stalled' && c.stall_deadline && now >= c.stall_deadline.getTime()) {
        const owner = c.owner_id!;
        await closeCurrentAssignment(q, c.id, owner, 'released_at', now, 'stalled');
        await audit(q, ctx, SYSTEM, { action: 'case.stall_reassigned', targetType: 'case', targetId: c.id, participantId: p.id });
        await offerNext(q, ctx, c, p, org, h, stepOfOwner(c, p, owner), [owner]);
        await notify(q, ctx, { staffId: org.program_lead_id, orgId, caseId: c.id, kind: 'stall_reassigned', dedupeKey: `stallre:${c.id}:${now}` });
        reassigned++;
        return;
      }
      if (c.state === 'contact_reported' && c.contact_reported_at) {
        const due = addBusinessDays(c.contact_reported_at.getTime(), POLICY.confirmBusinessDays, h);
        if (now >= due) {
          const duty = await dutyChain(q, org, now);
          await notify(q, ctx, { staffId: duty.onDuty?.id, orgId, caseId: c.id, kind: 'confirm_late', dedupeKey: `conf:${c.id}` });
        }
        if (now >= addBusinessDays(due, 1, h) && open) await notify(q, ctx, { staffId: org.program_lead_id, orgId, caseId: c.id, kind: 'confirm_late', dedupeKey: `confpl:${c.id}:${today}` });
        return;
      }
      if (c.state === 'extended_watch' && c.ew_next_review) {
        const due = c.ew_next_review.getTime();
        if (now >= due) await notify(q, ctx, { staffId: c.owner_id, orgId, caseId: c.id, kind: 'review_due', dedupeKey: `ew:${c.id}:${due}` });
        if (now >= addBusinessDays(due, 1, h) && open) await notify(q, ctx, { staffId: org.program_lead_id, orgId, caseId: c.id, kind: 'review_late', dedupeKey: `ewpl:${c.id}:${today}` });
        if (c.ew_since && now - c.ew_since.getTime() >= POLICY.extendedWatchMaxDays * DAY) {
          await notify(q, ctx, { staffId: org.program_lead_id, orgId, caseId: c.id, kind: 'closure_approval', dedupeKey: `ewmax:${c.id}` });
        }
      }
    });
  }
  return { escalated, stalled, reassigned };
}

export async function caseActions(ctx: Ctx, c: CaseRow) {
  const rows = await many<{ id: string; staff_id: string; display_name: string; at: Date; action: string; source: string; result: string; certainty: string; note_enc: Buffer | null }>(ctx.db,
    'SELECT a.*, s.display_name FROM case_actions a JOIN staff s ON s.id = a.staff_id WHERE a.case_id = $1 ORDER BY a.at', [c.id]);
  return Promise.all(rows.map(async (r) => ({ ...r, note: await dec(ctx, c.participant_id, 'action_note', r.note_enc) })));
}

export async function pendingProposals(q: Q, orgId: string) {
  return many<{ id: string; case_id: string; reason: string; proposed_by: string; proposer: string; reviewed_by: string | null; proposed_at: Date; participant_id: string }>(q,
    `SELECT p.id, p.case_id, p.reason, p.proposed_by, s.display_name AS proposer, p.reviewed_by, p.proposed_at, c.participant_id
       FROM closure_proposals p JOIN cases c ON c.id = p.case_id JOIN staff s ON s.id = p.proposed_by
      WHERE c.org_id = $1 AND p.decision IS NULL ORDER BY p.proposed_at`, [orgId]);
}

export { FOLLOWUP_ACTIONS, PASSIVE_ACTIONS };
