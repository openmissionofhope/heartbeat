import { POLICY } from '../config.js';
import type { Q } from '../db/index.js';
import { many, maybe, one, ts } from '../db/index.js';
import { DAY } from '../lib/calendar.js';
import { newParticipantCode, newPhoneCheckinId, normalizePhone, parseParticipantCode } from '../lib/codes.js';
import { hashSecret, hmac, normalizeAnswer, verifySecret } from '../lib/crypto.js';
import {
  type Actor, type Ctx, audit, clampText, dec, decJson, enc, encJson, fail, has, requireRole,
} from './core.js';
import { notify } from './notifications.js';
import { type OrgRow, dutyChain, getOrg } from './orgs.js';
import { conflictedStaff, isConflicted } from './staff.js';

export type Kind = 'in_person' | 'phone_with_staff' | 'relay' | 'self_check_in' | 'secondhand';
export type Confidence = 'known' | 'verified' | 'code_only' | 'stated' | 'reported';
export type Followup = 'records' | 'phone' | 'places' | 'people' | 'partners';
export type Channel = 'in_person' | 'remote';
export type PState = 'draft' | 'active' | 'paused' | 'withdrawal_pending' | 'withdrawn' | 'transfer_pending' | 'transferred' | 'inactive' | 'ended';

export const CONSENT_SCRIPT_VERSION = '2026-11-draft-1';

export interface ParticipantRow {
  id: string;
  org_id: string;
  hosted_since: Date;
  code: string;
  phone_checkin_id: string | null;
  training: boolean;
  name_enc: Buffer;
  other_names_enc: Buffer | null;
  lookup: 'name' | 'code_only';
  birth_year: number | null;
  languages: string | null;
  accessibility_enc: Buffer | null;
  verification_hash: string | null;
  keypad_pin_hash: string | null;
  verification_failures: number;
  verification_locked_until: Date | null;
  primary_responder_id: string | null;
  backup_responder_id: string | null;
  state: PState;
  state_changed_at: Date;
  activated_at: Date | null;
  clock_base_at: Date | null;
  clock_return: boolean;
  tell_pending: boolean;
  last_qualifying_at: Date | null;
  last_qualifying_kind: Kind | null;
  last_qualifying_confidence: Confidence | null;
  last_in_person_at: Date | null;
  withdrawal_requested_at: Date | null;
  withdrawal_review_due: Date | null;
  withdrawal_extended: boolean;
  keep_after_withdrawal: boolean;
  delete_after: Date | null;
  legal_hold: string | null;
  photo_enc: Buffer | null;
  self_view_code_hash: string | null;
  self_view_code_expires: Date | null;
  created_by: string;
  created_at: Date;
}

export interface OtherName { name: string; recorderVisible: boolean }
export interface NamedPerson { name: string; phone: string; message: string }

export interface Plan {
  version: number;
  intervalDays: number;
  graceDays: number;
  qualifyingKinds: Kind[];
  followup: Followup[];
  phone: string | null;
  phoneVerifiedAt: Date | null;
  phoneCall: boolean;
  phoneText: boolean;
  phoneVoicemail: boolean;
  phoneMessage: string | null;
  avoidTimes: string | null;
  usuallyFound: string | null;
  namedPeople: NamedPerson[];
  partnerMessage: string | null;
  tellMeIfAsked: boolean;
  disasterPriority: boolean;
  disasterCategory: 'mobility' | 'medical' | 'other' | null;
  continuitySharing: boolean;
  smsCheckins: boolean;
  smsReminders: boolean;
  smsConsentAt: Date | null;
  keypadCheckins: boolean;
  changeChannel: Channel;
  changedFields: string[];
  remoteUnconfirmed: boolean;
  confirmedInPersonAt: Date | null;
  effectiveFrom: Date;
  changedBy: string | null;
}

export type PlanInput = Partial<Omit<Plan, 'version' | 'changeChannel' | 'changedFields' | 'remoteUnconfirmed' | 'confirmedInPersonAt' | 'effectiveFrom' | 'changedBy' | 'phoneVerifiedAt' | 'smsConsentAt' | 'graceDays'>>;

export const DEFAULT_PLAN: Omit<Plan, 'version' | 'intervalDays' | 'graceDays' | 'changeChannel' | 'changedFields' | 'remoteUnconfirmed' | 'confirmedInPersonAt' | 'effectiveFrom' | 'changedBy'> = {
  qualifyingKinds: ['in_person', 'phone_with_staff'],
  followup: ['records'],
  phone: null,
  phoneVerifiedAt: null,
  phoneCall: false,
  phoneText: false,
  phoneVoicemail: false,
  phoneMessage: null,
  avoidTimes: null,
  usuallyFound: null,
  namedPeople: [],
  partnerMessage: null,
  tellMeIfAsked: true,
  disasterPriority: false,
  disasterCategory: null,
  continuitySharing: false,
  smsCheckins: false,
  smsReminders: false,
  smsConsentAt: null,
  keypadCheckins: false,
};

export interface ConsentChoices {
  relays: boolean;
  sms: boolean;
  keypad: boolean;
  continuitySharing: boolean;
  photo: boolean;
  selfView: boolean;
}

export const OPEN_STATES: PState[] = ['active', 'paused', 'withdrawal_pending', 'transfer_pending'];

export async function getParticipantRow(q: Q, id: string): Promise<ParticipantRow> {
  const p = await maybe<ParticipantRow>(q, 'SELECT * FROM participants WHERE id = $1', [id]);
  if (!p) fail('Participant not found.', 404);
  return p!;
}

export async function lockParticipant(q: Q, id: string): Promise<ParticipantRow> {
  const p = await maybe<ParticipantRow>(q, 'SELECT * FROM participants WHERE id = $1 FOR UPDATE', [id]);
  if (!p) fail('Participant not found.', 404);
  return p!;
}

export async function findByCode(q: Q, code: string): Promise<ParticipantRow | null> {
  const c = parseParticipantCode(code);
  if (!c) return null;
  return maybe<ParticipantRow>(q, 'SELECT * FROM participants WHERE code = $1', [c]);
}

export function phoneIndex(ctx: Ctx, orgId: string, e164: string): string {
  return hmac(ctx.config.secret, 'phone', orgId, e164);
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

interface PlanRow {
  participant_id: string; version: number; interval_days: number; grace_days: number; qualifying_kinds: Kind[]; followup: Followup[];
  phone_enc: Buffer | null; phone_index: string | null; phone_verified_at: Date | null; phone_call: boolean; phone_text: boolean; phone_voicemail: boolean;
  phone_message_enc: Buffer | null; avoid_times_enc: Buffer | null; usually_found_enc: Buffer | null; named_people_enc: Buffer | null; partner_message_enc: Buffer | null;
  tell_me_if_asked: boolean; disaster_priority: boolean; disaster_category: Plan['disasterCategory']; continuity_sharing: boolean;
  sms_checkins: boolean; sms_reminders: boolean; sms_consent_at: Date | null; keypad_checkins: boolean;
  changed_by: string | null; change_channel: Channel; changed_fields: string[]; remote_unconfirmed: boolean; confirmed_in_person_at: Date | null;
  effective_from: Date; superseded_at: Date | null; values_purged: boolean;
}

async function rowToPlan(ctx: Ctx, r: PlanRow): Promise<Plan> {
  const pid = r.participant_id;
  return {
    version: r.version,
    intervalDays: r.interval_days,
    graceDays: r.grace_days,
    qualifyingKinds: r.qualifying_kinds,
    followup: r.followup,
    phone: await dec(ctx, pid, 'phone', r.phone_enc),
    phoneVerifiedAt: r.phone_verified_at,
    phoneCall: r.phone_call,
    phoneText: r.phone_text,
    phoneVoicemail: r.phone_voicemail,
    phoneMessage: await dec(ctx, pid, 'phone_message', r.phone_message_enc),
    avoidTimes: await dec(ctx, pid, 'avoid_times', r.avoid_times_enc),
    usuallyFound: await dec(ctx, pid, 'usually_found', r.usually_found_enc),
    namedPeople: await decJson<NamedPerson[]>(ctx, pid, 'named_people', r.named_people_enc, []),
    partnerMessage: await dec(ctx, pid, 'partner_message', r.partner_message_enc),
    tellMeIfAsked: r.tell_me_if_asked,
    disasterPriority: r.disaster_priority,
    disasterCategory: r.disaster_category,
    continuitySharing: r.continuity_sharing,
    smsCheckins: r.sms_checkins,
    smsReminders: r.sms_reminders,
    smsConsentAt: r.sms_consent_at,
    keypadCheckins: r.keypad_checkins,
    changeChannel: r.change_channel,
    changedFields: r.changed_fields,
    remoteUnconfirmed: r.remote_unconfirmed,
    confirmedInPersonAt: r.confirmed_in_person_at,
    effectiveFrom: r.effective_from,
    changedBy: r.changed_by,
  };
}

export async function currentPlan(q: Q, ctx: Ctx, participantId: string): Promise<Plan> {
  const r = await maybe<PlanRow>(q, 'SELECT * FROM plan_versions WHERE participant_id = $1 AND superseded_at IS NULL ORDER BY version DESC LIMIT 1', [participantId]);
  if (!r) fail('This participant has no contact plan.', 404);
  return rowToPlan(ctx, r!);
}

/** Plan versions changed remotely within the flag window and not yet confirmed in person. */
export async function remoteFlags(q: Q, participantId: string, now: number): Promise<{ version: number; fields: string[]; at: Date }[]> {
  const rows = await many<{ version: number; changed_fields: string[]; effective_from: Date }>(q,
    `SELECT version, changed_fields, effective_from FROM plan_versions WHERE participant_id = $1 AND remote_unconfirmed AND effective_from >= $2 ORDER BY version`,
    [participantId, ts(now - POLICY.remoteFlagDays * DAY)]);
  return rows.map((r) => ({ version: r.version, fields: r.changed_fields, at: r.effective_from }));
}

const SAFETY_REDUCING = new Set(['intervalDays', 'followup', 'namedPeople', 'phone', 'qualifyingKinds']);

function graceFor(interval: number): number {
  return POLICY.graceDays[interval] ?? 3;
}

function validatePlan(p: Omit<Plan, 'version' | 'changeChannel' | 'changedFields' | 'remoteUnconfirmed' | 'confirmedInPersonAt' | 'effectiveFrom' | 'changedBy'>, consent: ConsentChoices): void {
  if (!(POLICY.intervals as readonly number[]).includes(p.intervalDays)) fail('Choose a contact interval of 7, 14 or 30 days.');
  if (!p.qualifyingKinds.length) fail('Choose at least one kind of contact that counts.');
  if (p.qualifyingKinds.includes('relay') && !consent.relays) fail('Relays can count only if the participant agreed to relays.');
  if (p.qualifyingKinds.includes('self_check_in') && !(consent.sms || consent.keypad)) fail('Self-check-ins can count only if the participant agreed to text or keypad check-ins.');
  if (!p.followup.includes('records')) fail('Checking Heartbeat and host records is always part of follow-up.');
  if (p.followup.includes('phone') && !p.phone) fail('Add a phone number before allowing phone follow-up.');
  if (p.followup.includes('places') && !p.usuallyFound) fail('Add the places the participant listed before allowing staff to look there.');
  if (p.followup.includes('people') && !p.namedPeople.length) fail('Add the people the participant named before allowing staff to ask them.');
  if (p.followup.includes('partners') && !p.partnerMessage) fail('Write the message partners may be given.');
  if (p.phone && !normalizePhone(p.phone)) fail('Enter a valid phone number.');
  if ((p.smsCheckins || p.smsReminders) && !(consent.sms && p.phone)) fail('Text messages need the participant’s agreement to texts and a phone number.');
  if (p.keypadCheckins && !consent.keypad) fail('Keypad check-ins need the participant’s agreement.');
  if (p.continuitySharing && !consent.continuitySharing) fail('Continuity sharing needs the participant’s agreement.');
  if (p.disasterCategory && !p.disasterPriority) fail('A disaster-priority reason applies only when disaster priority is chosen.');
  for (const n of p.namedPeople) {
    if (!n.name?.trim() || !normalizePhone(n.phone ?? '') || !n.message?.trim()) fail('Each named person needs a name, a phone number and exactly what may be said.');
  }
  clampText(p.usuallyFound, 200);
  clampText(p.phoneMessage, 200);
  clampText(p.partnerMessage, 200);
  clampText(p.avoidTimes, 120);
}

async function insertPlan(q: Q, ctx: Ctx, pid: string, orgId: string, version: number, p: Omit<Plan, 'version' | 'effectiveFrom'>, now: number): Promise<void> {
  const phone = p.phone ? normalizePhone(p.phone) : null;
  await q.query(
    `INSERT INTO plan_versions (participant_id, version, interval_days, grace_days, qualifying_kinds, followup, phone_enc, phone_index, phone_verified_at,
       phone_call, phone_text, phone_voicemail, phone_message_enc, avoid_times_enc, usually_found_enc, named_people_enc, partner_message_enc, tell_me_if_asked,
       disaster_priority, disaster_category, continuity_sharing, sms_checkins, sms_reminders, sms_consent_at, keypad_checkins, changed_by, change_channel,
       changed_fields, remote_unconfirmed, confirmed_in_person_at, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
    [pid, version, p.intervalDays, p.graceDays, p.qualifyingKinds, p.followup, await enc(ctx, pid, 'phone', phone), phone ? phoneIndex(ctx, orgId, phone) : null,
      p.phoneVerifiedAt ? ts(p.phoneVerifiedAt.getTime()) : null, p.phoneCall, p.phoneText, p.phoneVoicemail,
      await enc(ctx, pid, 'phone_message', p.phoneMessage), await enc(ctx, pid, 'avoid_times', p.avoidTimes), await enc(ctx, pid, 'usually_found', p.usuallyFound),
      await encJson(ctx, pid, 'named_people', p.namedPeople.map((n) => ({ ...n, phone: normalizePhone(n.phone) }))), await enc(ctx, pid, 'partner_message', p.partnerMessage),
      p.tellMeIfAsked, p.disasterPriority, p.disasterCategory, p.continuitySharing, p.smsCheckins, p.smsReminders, p.smsConsentAt ? ts(p.smsConsentAt.getTime()) : null,
      p.keypadCheckins, p.changedBy, p.changeChannel, p.changedFields, p.remoteUnconfirmed, p.confirmedInPersonAt ? ts(p.confirmedInPersonAt.getTime()) : null, ts(now)]);
}

export async function latestConsent(q: Q, participantId: string): Promise<ConsentChoices> {
  const c = await maybe<{ choices: ConsentChoices }>(q, 'SELECT choices FROM consents WHERE participant_id = $1 ORDER BY created_at DESC LIMIT 1', [participantId]);
  return c?.choices ?? { relays: false, sms: false, keypad: false, continuitySharing: false, photo: false, selfView: false };
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export interface EnrollInput {
  preferredName: string;
  otherNames?: OtherName[];
  lookup?: 'name' | 'code_only';
  birthYear?: number | null;
  languages?: string | null;
  accessibility?: string | null;
  verificationAnswer: string;
  keypadPin?: string | null;
  adultConfirmed: boolean;
  privateConversation: boolean;
  teachBack: boolean;
  consent: ConsentChoices;
  plan: PlanInput & { intervalDays: number };
  primaryResponderId?: string | null;
  backupResponderId?: string | null;
  confirmDifferentPerson?: boolean;
}

export async function possibleDuplicates(ctx: Ctx, actor: Actor, names: string[], birthYear: number | null | undefined): Promise<{ id: string; code: string; name: string }[]> {
  const wanted = names.map((n) => normalizeAnswer(n)).filter(Boolean);
  if (!wanted.length) return [];
  const rows = await many<ParticipantRow>(ctx.db, `SELECT * FROM participants WHERE org_id = $1 AND state = ANY($2)`, [actor.orgId, [...OPEN_STATES, 'inactive']]);
  const out: { id: string; code: string; name: string }[] = [];
  for (const r of rows) {
    if (birthYear && r.birth_year && Math.abs(r.birth_year - birthYear) > 1) continue;
    const name = (await dec(ctx, r.id, 'name', r.name_enc)) ?? '';
    const others = await decJson<OtherName[]>(ctx, r.id, 'other_names', r.other_names_enc, []);
    const theirs = [name, ...others.map((o) => o.name)].map(normalizeAnswer);
    if (theirs.some((t) => wanted.some((w) => similar(t, w)))) out.push({ id: r.id, code: r.code, name });
  }
  return out;
}

/** Same normalized name, one a prefix of the other (Mike / Michael is not caught), or edit distance ≤ 1. */
function similar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

async function validateResponder(q: Q, orgId: string, id: string | null | undefined, label: string): Promise<string | null> {
  if (!id) return null;
  const s = await maybe<{ org_id: string; roles: string[]; active: boolean }>(q, 'SELECT org_id, roles, active FROM staff WHERE id = $1', [id]);
  if (!s || s.org_id !== orgId || !s.active || !s.roles.includes('responder')) fail(`${label} must be an active responder at this organization.`);
  return id;
}

export async function enroll(ctx: Ctx, actor: Actor, input: EnrollInput): Promise<ParticipantRow> {
  requireRole(actor, 'enroller', 'coordinator', 'program_lead');
  if (actor.orgKind !== 'host') fail('Only host organizations enroll participants.', 403);
  if (!input.adultConfirmed) fail('Heartbeat enrolls only adults (18 or older). Follow the host’s own procedures for anyone younger.');
  if (!input.privateConversation) fail('The consent conversation must be held in private.');
  if (!input.teachBack) fail('Enrollment can go ahead only if the participant could explain it back in their own words.');
  const name = clampText(input.preferredName, 80) ?? fail('Enter the name the participant wants us to use.');
  const answer = normalizeAnswer(input.verificationAnswer ?? '');
  if (answer.length < 3) fail('The verification answer needs at least 3 letters or numbers.');
  if (input.consent.keypad && !/^\d{4,6}$/.test(input.keypadPin ?? '')) fail('Keypad check-ins need a 4–6 digit PIN chosen by the participant.');
  const otherNames = (input.otherNames ?? []).map((o) => ({ name: clampText(o.name, 80) ?? '', recorderVisible: !!o.recorderVisible })).filter((o) => o.name);
  if (input.birthYear && (input.birthYear < 1900 || input.birthYear > new Date(ctx.clock.now()).getUTCFullYear() - 18)) fail('Birth year must make the participant at least 18.');
  const now = ctx.clock.now();
  const interval = input.plan.intervalDays;
  const plan = { ...DEFAULT_PLAN, ...stripUndefined(input.plan), intervalDays: interval, graceDays: graceFor(interval) };
  if (plan.smsCheckins || plan.smsReminders) plan.smsConsentAt = new Date(now);
  validatePlan(plan, input.consent);

  const org = await getOrg(ctx.db, actor.orgId);
  if (org.enrollment_paused) fail(`New enrollment is paused: ${org.enrollment_pause_reason ?? 'see the program lead'}. Nothing is recorded; please invite the person to ask again later.`);
  if (org.status === 'closed') fail('This organization is closed.');
  if (!input.confirmDifferentPerson) {
    const dups = await possibleDuplicates(ctx, actor, [name, ...otherNames.map((o) => o.name)], input.birthYear);
    if (dups.length) fail(`Possible existing record: ${dups.map((d) => d.code).join(', ')}. Confirm this is a different person, or open the existing record.`, 409);
  }

  let code = newParticipantCode();
  while (await maybe(ctx.db, 'SELECT 1 FROM participants WHERE code = $1', [code])) code = newParticipantCode();
  let keypadId: string | null = null;
  if (input.consent.keypad) {
    keypadId = newPhoneCheckinId();
    while (await maybe(ctx.db, 'SELECT 1 FROM participants WHERE phone_checkin_id = $1', [keypadId])) keypadId = newPhoneCheckinId();
  }
  const pidRow = await one<{ id: string }>(ctx.db, 'SELECT gen_random_uuid() AS id');
  const pid = pidRow.id;
  await ctx.keys.create(pid);
  const verificationHash = await hashSecret(answer);
  const pinHash = input.keypadPin ? await hashSecret(input.keypadPin) : null;

  return ctx.db.tx(async (q) => {
    const primary = await validateResponder(q, actor.orgId, input.primaryResponderId, 'The primary responder');
    const backup = await validateResponder(q, actor.orgId, input.backupResponderId, 'The backup responder');
    if (primary && backup && primary === backup) fail('The backup responder must be a different person from the primary.');
    const row = await one<ParticipantRow>(q,
      `INSERT INTO participants (id, org_id, hosted_since, code, phone_checkin_id, training, name_enc, other_names_enc, lookup, birth_year, languages, accessibility_enc,
         verification_hash, keypad_pin_hash, primary_responder_id, backup_responder_id, state, state_changed_at, activated_at, clock_base_at, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active',$3,$3,$3,$17,$3) RETURNING *`,
      [pid, actor.orgId, ts(now), code, keypadId, org.status !== 'live', await enc(ctx, pid, 'name', name), await encJson(ctx, pid, 'other_names', otherNames),
        input.lookup ?? 'name', input.birthYear ?? null, clampText(input.languages, 80), await enc(ctx, pid, 'accessibility', clampText(input.accessibility, 200)),
        verificationHash, pinHash, primary, backup, actor.staffId]);
    await q.query(`INSERT INTO consents (participant_id, org_id, script_version, choices, teach_back, method, witnessed_by, created_at) VALUES ($1,$2,$3,$4,$5,'in_person',$6,$7)`,
      [pid, actor.orgId, CONSENT_SCRIPT_VERSION, JSON.stringify(input.consent), true, actor.staffId, ts(now)]);
    await insertPlan(q, ctx, pid, actor.orgId, 1, { ...plan, changeChannel: 'in_person', changedFields: [], remoteUnconfirmed: false, confirmedInPersonAt: new Date(now), changedBy: actor.staffId }, now);
    await audit(q, ctx, actor, { action: 'participant.enroll', targetType: 'participant', targetId: pid, participantId: pid, details: { training: row.training, consent: input.consent } });
    return row;
  });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Search and access (docs/02 §2.3)
// ---------------------------------------------------------------------------

export interface SearchHit { id: string; code: string; name: string; otherNames: string[]; state: PState; training: boolean }

export async function searchParticipants(ctx: Ctx, actor: Actor, query: string): Promise<SearchHit[]> {
  requireRole(actor, 'recorder', 'enroller', 'responder', 'coordinator', 'program_lead');
  const term = query.trim();
  if (term.length < 2) return [];
  const enrollerPlus = has(actor, 'enroller', 'coordinator', 'program_lead');
  const code = parseParticipantCode(term);
  const states = [...OPEN_STATES, 'inactive', 'ended'];
  let rows: ParticipantRow[];
  if (code) rows = await many<ParticipantRow>(ctx.db, 'SELECT * FROM participants WHERE org_id = $1 AND code = $2 AND state = ANY($3)', [actor.orgId, code, states]);
  else rows = await many<ParticipantRow>(ctx.db, 'SELECT * FROM participants WHERE org_id = $1 AND state = ANY($2)', [actor.orgId, states]);
  const tokens = normalizeTokens(term);
  const hits: SearchHit[] = [];
  for (const r of rows) {
    const name = (await dec(ctx, r.id, 'name', r.name_enc)) ?? '';
    const others = await decJson<OtherName[]>(ctx, r.id, 'other_names', r.other_names_enc, []);
    const visibleOthers = enrollerPlus ? others.map((o) => o.name) : others.filter((o) => o.recorderVisible).map((o) => o.name);
    if (!code) {
      if (r.lookup === 'code_only' && !enrollerPlus) continue;
      const hay = [name, ...visibleOthers].flatMap(normalizeTokens);
      if (!tokens.every((t) => hay.some((h) => h.startsWith(t)))) continue;
    }
    hits.push({ id: r.id, code: r.code, name, otherNames: visibleOthers, state: r.state, training: r.training });
    if (hits.length >= 20) break;
  }
  await ctx.db.tx((q) => audit(q, ctx, actor, { action: 'participant.search', basis: code ? 'code' : 'name', details: { results: hits.length }, searchTerms: term.slice(0, 80) }));
  return hits;
}

function normalizeTokens(s: string): string[] {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export type Section = 'plan' | 'history' | 'cases';
export type Basis = 'assignment' | 'enrollment' | 'coordinator' | 'reason' | 'continuity';

/**
 * Decides on what basis the actor may see a section of a participant's record. Returns null if
 * a typed reason is needed first; throws if not allowed at all.
 */
export async function accessBasis(q: Q, ctx: Ctx, actor: Actor, p: ParticipantRow, section: Section): Promise<Basis | null> {
  if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
  if (await isConflicted(q, actor.staffId, p.id)) fail('You are excluded from this record (a declared conflict or the participant’s request). You can still record a contact.', 403);
  const open = await maybe<{ owner_id: string | null; offeree_id: string | null }>(q, "SELECT owner_id, offeree_id FROM cases WHERE participant_id = $1 AND state <> 'closed'", [p.id]);
  if (open && (open.owner_id === actor.staffId || open.offeree_id === actor.staffId) && has(actor, 'responder', 'coordinator', 'program_lead')) return 'assignment';
  const grant = actor.sessionHash ? await maybe(q, 'SELECT 1 FROM access_grants WHERE session_hash = $1 AND participant_id = $2 AND expires_at > $3', [actor.sessionHash, p.id, ts(ctx.clock.now())]) : null;
  const viaReason: Basis | null = grant ? 'reason' : null;
  switch (section) {
    case 'plan':
      if (has(actor, 'enroller')) return 'enrollment';
      if (has(actor, 'coordinator', 'program_lead')) return viaReason;
      break;
    case 'history':
      if (has(actor, 'coordinator')) return 'coordinator';
      if (has(actor, 'enroller', 'program_lead')) return viaReason;
      break;
    case 'cases':
      if (has(actor, 'coordinator', 'program_lead')) return 'coordinator';
      break;
  }
  return fail('You do not have access to that part of this record.', 403);
}

export async function hasGrant(q: Q, ctx: Ctx, actor: Actor, participantId: string): Promise<boolean> {
  if (!actor.sessionHash) return false;
  return !!(await maybe(q, 'SELECT 1 FROM access_grants WHERE session_hash = $1 AND participant_id = $2 AND expires_at > $3', [actor.sessionHash, participantId, ts(ctx.clock.now())]));
}

export async function grantAccess(ctx: Ctx, actor: Actor, participantId: string, reason: string): Promise<void> {
  const r = clampText(reason, POLICY.noteMax.accessReason) ?? fail('Type why you need to see this record.');
  if (r.length < 10) fail('Please give a reason of at least 10 characters.');
  if (!actor.sessionHash) fail('Sign in again.', 401);
  await ctx.db.tx(async (q) => {
    const p = await getParticipantRow(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    if (await isConflicted(q, actor.staffId, p.id)) fail('You are excluded from this record.', 403);
    const now = ctx.clock.now();
    await q.query(`INSERT INTO access_grants (session_hash, participant_id, reason, granted_at, expires_at) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (session_hash, participant_id) DO UPDATE SET reason = EXCLUDED.reason, granted_at = EXCLUDED.granted_at, expires_at = EXCLUDED.expires_at`,
    [actor.sessionHash, p.id, r, ts(now), ts(now + 30 * 60_000)]);
    await audit(q, ctx, actor, { action: 'participant.access_reason', targetType: 'participant', targetId: p.id, participantId: p.id, basis: 'reason', reason: r });
  });
}

export interface ParticipantSummary {
  id: string;
  code: string;
  name: string;
  otherNames: OtherName[];
  lookup: 'name' | 'code_only';
  birthYear: number | null;
  languages: string | null;
  accessibility: string | null;
  state: PState;
  training: boolean;
  orgId: string;
  phoneCheckinId: string | null;
  lastQualifyingAt: Date | null;
  lastQualifyingKind: Kind | null;
  lastQualifyingConfidence: Confidence | null;
  lastInPersonAt: Date | null;
  primaryResponderId: string | null;
  backupResponderId: string | null;
  hasPhoto: boolean;
  legalHold: string | null;
  withdrawalReviewDue: Date | null;
  tellPending: boolean;
}

export async function summarize(ctx: Ctx, p: ParticipantRow): Promise<ParticipantSummary> {
  return {
    id: p.id, code: p.code,
    name: (await dec(ctx, p.id, 'name', p.name_enc)) ?? '(deleted)',
    otherNames: await decJson<OtherName[]>(ctx, p.id, 'other_names', p.other_names_enc, []),
    lookup: p.lookup, birthYear: p.birth_year, languages: p.languages,
    accessibility: await dec(ctx, p.id, 'accessibility', p.accessibility_enc),
    state: p.state, training: p.training, orgId: p.org_id, phoneCheckinId: p.phone_checkin_id,
    lastQualifyingAt: p.last_qualifying_at, lastQualifyingKind: p.last_qualifying_kind, lastQualifyingConfidence: p.last_qualifying_confidence,
    lastInPersonAt: p.last_in_person_at, primaryResponderId: p.primary_responder_id, backupResponderId: p.backup_responder_id,
    hasPhoto: !!p.photo_enc, legalHold: p.legal_hold, withdrawalReviewDue: p.withdrawal_review_due, tellPending: p.tell_pending,
  };
}

/** Logs a view of participant detail with its basis (HB-AUD-1). */
export async function logView(ctx: Ctx, actor: Actor, participantId: string, section: string, basis: Basis): Promise<void> {
  await ctx.db.tx((q) => audit(q, ctx, actor, { action: 'participant.view', targetType: 'participant', targetId: participantId, participantId, basis, details: { section } }));
}

// ---------------------------------------------------------------------------
// Verification answers (HB-CON-2)
// ---------------------------------------------------------------------------

/** Checks a verification answer, applying the lockout. Runs in the caller's transaction. */
export async function checkVerification(q: Q, ctx: Ctx, p: ParticipantRow, answer: string, actorForAudit: Actor | { kind: 'participant' | 'provider'; orgId?: string }): Promise<'ok' | 'wrong' | 'locked'> {
  const now = ctx.clock.now();
  if (p.verification_locked_until && p.verification_locked_until.getTime() > now) return 'locked';
  const ok = await verifySecret(normalizeAnswer(answer), p.verification_hash);
  if (ok) {
    if (p.verification_failures) await q.query('UPDATE participants SET verification_failures = 0 WHERE id = $1', [p.id]);
    return 'ok';
  }
  const failures = p.verification_failures + 1;
  const lock = failures >= POLICY.verificationLockout.failures;
  await q.query('UPDATE participants SET verification_failures = $2, verification_locked_until = $3 WHERE id = $1',
    [p.id, lock ? 0 : failures, lock ? ts(now + POLICY.verificationLockout.hours * 3_600_000) : p.verification_locked_until]);
  p.verification_failures = lock ? 0 : failures;
  await audit(q, ctx, actorForAudit as Actor, { action: 'participant.verification', targetType: 'participant', targetId: p.id, participantId: p.id, outcome: 'denied', details: { locked: lock } });
  if (lock) {
    const org = await getOrg(q, p.org_id);
    const duty = await dutyChain(q, org, now);
    await notify(q, ctx, { staffId: duty.onDuty?.id, orgId: org.id, kind: 'verification_locked', dedupeKey: `vlock:${p.id}:${Math.floor(now / 3_600_000)}` });
  }
  return lock ? 'locked' : 'wrong';
}

export async function resetVerification(ctx: Ctx, actor: Actor, participantId: string, answer: string, keypadPin?: string | null): Promise<void> {
  requireRole(actor, 'enroller', 'coordinator', 'program_lead');
  const a = normalizeAnswer(answer);
  if (a.length < 3) fail('The verification answer needs at least 3 letters or numbers.');
  if (keypadPin && !/^\d{4,6}$/.test(keypadPin)) fail('The keypad PIN must be 4–6 digits.');
  const h = await hashSecret(a);
  const pinH = keypadPin ? await hashSecret(keypadPin) : null;
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    await q.query('UPDATE participants SET verification_hash = $2, keypad_pin_hash = COALESCE($3, keypad_pin_hash), verification_failures = 0, verification_locked_until = NULL WHERE id = $1', [p.id, h, pinH]);
    await audit(q, ctx, actor, { action: 'participant.verification_reset', targetType: 'participant', targetId: p.id, participantId: p.id, details: { channel: 'in_person' } });
  });
}

// ---------------------------------------------------------------------------
// Plan changes and remote-change rules (docs/03 §3.10)
// ---------------------------------------------------------------------------

export interface ChangeOptions { channel: Channel; identity: Confidence }

function diffPlan(before: Plan, after: Omit<Plan, 'version' | 'changeChannel' | 'changedFields' | 'remoteUnconfirmed' | 'confirmedInPersonAt' | 'effectiveFrom' | 'changedBy'>): { fields: string[]; reducing: boolean } {
  const fields: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const k of Object.keys(after) as (keyof typeof after)[]) {
    if (k === 'graceDays' || k === 'phoneVerifiedAt' || k === 'smsConsentAt') continue;
    if (!same((before as unknown as Record<string, unknown>)[k], (after as unknown as Record<string, unknown>)[k])) fields.push(k);
  }
  let reducing = false;
  if (after.intervalDays > before.intervalDays) reducing = true;
  if (before.followup.some((f) => !after.followup.includes(f))) reducing = true;
  if (before.namedPeople.some((n) => !after.namedPeople.some((m) => m.name === n.name && normalizePhone(m.phone) === normalizePhone(n.phone)))) reducing = true;
  if ((before.phone ?? '') !== (after.phone ? normalizePhone(after.phone) ?? after.phone : '')) reducing = true;
  if (after.qualifyingKinds.some((k) => !before.qualifyingKinds.includes(k))) reducing = true;
  return { fields, reducing: reducing && fields.some((f) => SAFETY_REDUCING.has(f)) };
}

export async function recordUnverifiedRemoteRequest(ctx: Ctx, actor: Actor, p: ParticipantRow, what: string): Promise<never> {
  await ctx.db.tx(async (q) => {
    await audit(q, ctx, actor, { action: 'participant.remote_request_unverified', targetType: 'participant', targetId: p.id, participantId: p.id, outcome: 'denied', details: { what } });
    const org = await getOrg(q, p.org_id);
    const duty = await dutyChain(q, org, ctx.clock.now());
    await notify(q, ctx, { staffId: duty.onDuty?.id, orgId: org.id, kind: 'remote_request_unverified' });
  });
  return fail('Remote requests that reduce follow-up are applied only when the caller is known to you or gave the right verification answer. Nothing was changed; the request was recorded and the coordinator told.', 403);
}

async function canChangePlan(q: Q, actor: Actor, p: ParticipantRow): Promise<void> {
  if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
  if (await isConflicted(q, actor.staffId, p.id)) fail('You are excluded from this record.', 403);
  if (has(actor, 'enroller', 'coordinator', 'program_lead')) return;
  const open = await maybe<{ owner_id: string | null }>(q, "SELECT owner_id FROM cases WHERE participant_id = $1 AND state <> 'closed'", [p.id]);
  if (has(actor, 'responder') && open?.owner_id === actor.staffId) return;
  fail('Only an enrollment worker, coordinator, program lead or the assigned responder can change the plan.', 403);
}

export async function changePlan(ctx: Ctx, actor: Actor, participantId: string, changes: PlanInput, opts: ChangeOptions): Promise<{ version: number; remoteFlag: boolean }> {
  const now = ctx.clock.now();
  const p0 = await getParticipantRow(ctx.db, participantId);
  if (p0.org_id !== actor.orgId) fail('Participant not found.', 404);
  const before = await currentPlan(ctx.db, ctx, participantId);
  if (!['active', 'paused'].includes(p0.state)) fail('The plan can be changed only for active or paused participants.');
  const consent = await latestConsent(ctx.db, participantId);
  const interval = changes.intervalDays ?? before.intervalDays;
  const merged = {
    ...pickPlanValues(before), ...stripUndefined(changes), intervalDays: interval, graceDays: graceFor(interval),
  };
  if (changes.phone !== undefined && normalizePhone(changes.phone ?? '') !== before.phone) merged.phoneVerifiedAt = null;
  if ((merged.smsCheckins || merged.smsReminders) && !before.smsConsentAt) merged.smsConsentAt = new Date(now);
  validatePlan(merged, consent);
  const { fields, reducing } = diffPlan(before, merged);
  if (!fields.length) return { version: before.version, remoteFlag: false };
  const remote = opts.channel === 'remote';
  if (remote && reducing && !['known', 'verified'].includes(opts.identity)) await recordUnverifiedRemoteRequest(ctx, actor, p0, 'plan_change');
  return ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    await canChangePlan(q, actor, p);
    await q.query('UPDATE plan_versions SET superseded_at = $2 WHERE participant_id = $1 AND superseded_at IS NULL', [p.id, ts(now)]);
    const version = before.version + 1;
    await insertPlan(q, ctx, p.id, p.org_id, version, {
      ...merged, changeChannel: opts.channel, changedFields: fields, remoteUnconfirmed: remote && reducing,
      confirmedInPersonAt: remote ? null : new Date(now), changedBy: actor.staffId,
    }, now);
    await audit(q, ctx, actor, { action: 'plan.change', targetType: 'participant', targetId: p.id, participantId: p.id, details: { fields, channel: opts.channel, identity: opts.identity, reducing } });
    return { version, remoteFlag: remote && reducing };
  });
}

function pickPlanValues(p: Plan) {
  const { version: _v, changeChannel: _c, changedFields: _f, remoteUnconfirmed: _r, confirmedInPersonAt: _ci, effectiveFrom: _e, changedBy: _b, ...rest } = p;
  return rest;
}

export async function confirmRemoteChanges(ctx: Ctx, actor: Actor, participantId: string): Promise<void> {
  requireRole(actor, 'coordinator', 'program_lead', 'enroller');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    await q.query('UPDATE plan_versions SET remote_unconfirmed = false, confirmed_in_person_at = $2 WHERE participant_id = $1 AND remote_unconfirmed', [p.id, ts(ctx.clock.now())]);
    await audit(q, ctx, actor, { action: 'plan.remote_confirmed', targetType: 'participant', targetId: p.id, participantId: p.id });
  });
}

export async function markPhoneVerified(q: Q, ctx: Ctx, participantId: string): Promise<void> {
  await q.query('UPDATE plan_versions SET phone_verified_at = $2 WHERE participant_id = $1 AND superseded_at IS NULL', [participantId, ts(ctx.clock.now())]);
}

export async function setPrimaryBackup(ctx: Ctx, actor: Actor, participantId: string, primary: string | null, backup: string | null): Promise<void> {
  requireRole(actor, 'coordinator', 'program_lead');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    const conflicted = await conflictedStaff(q, p.id);
    const pr = await validateResponder(q, p.org_id, primary, 'The primary responder');
    const bk = await validateResponder(q, p.org_id, backup, 'The backup responder');
    if (pr && bk && pr === bk) fail('The backup must be a different person from the primary.');
    if ((pr && conflicted.has(pr)) || (bk && conflicted.has(bk))) fail('That responder is excluded from this participant’s record.');
    await q.query('UPDATE participants SET primary_responder_id = $2, backup_responder_id = $3 WHERE id = $1', [p.id, pr, bk]);
    await audit(q, ctx, actor, { action: 'participant.responders', targetType: 'participant', targetId: p.id, participantId: p.id });
  });
}

export async function setLookup(ctx: Ctx, actor: Actor, participantId: string, lookup: 'name' | 'code_only'): Promise<void> {
  requireRole(actor, 'enroller', 'coordinator', 'program_lead');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    await q.query('UPDATE participants SET lookup = $2 WHERE id = $1', [p.id, lookup]);
    await audit(q, ctx, actor, { action: 'participant.lookup', targetType: 'participant', targetId: p.id, participantId: p.id, details: { lookup } });
  });
}

export async function updateIdentity(ctx: Ctx, actor: Actor, participantId: string, input: { preferredName?: string; otherNames?: OtherName[]; birthYear?: number | null; languages?: string | null; accessibility?: string | null }): Promise<void> {
  requireRole(actor, 'enroller', 'coordinator', 'program_lead');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    if (input.preferredName !== undefined) {
      const n = clampText(input.preferredName, 80) ?? fail('Name is required.');
      await q.query('UPDATE participants SET name_enc = $2 WHERE id = $1', [p.id, await enc(ctx, p.id, 'name', n)]);
    }
    if (input.otherNames !== undefined) {
      const o = input.otherNames.map((x) => ({ name: clampText(x.name, 80) ?? '', recorderVisible: !!x.recorderVisible })).filter((x) => x.name);
      await q.query('UPDATE participants SET other_names_enc = $2 WHERE id = $1', [p.id, await encJson(ctx, p.id, 'other_names', o)]);
    }
    if (input.birthYear !== undefined) await q.query('UPDATE participants SET birth_year = $2 WHERE id = $1', [p.id, input.birthYear]);
    if (input.languages !== undefined) await q.query('UPDATE participants SET languages = $2 WHERE id = $1', [p.id, clampText(input.languages, 80)]);
    if (input.accessibility !== undefined) await q.query('UPDATE participants SET accessibility_enc = $2 WHERE id = $1', [p.id, await enc(ctx, p.id, 'accessibility', clampText(input.accessibility, 200))]);
    await audit(q, ctx, actor, { action: 'participant.identity', targetType: 'participant', targetId: p.id, participantId: p.id, details: { fields: Object.keys(input) } });
  });
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export async function addConflict(ctx: Ctx, actor: Actor, participantId: string, staffId: string, source: 'staff_declared' | 'participant_requested'): Promise<void> {
  if (source === 'staff_declared' && staffId !== actor.staffId) fail('Staff declare their own conflicts.');
  if (source === 'participant_requested') requireRole(actor, 'enroller', 'coordinator', 'program_lead');
  const { reassignAwayFrom } = await import('./cases.js');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    const st = await maybe<{ org_id: string }>(q, 'SELECT org_id FROM staff WHERE id = $1', [staffId]);
    if (!st || st.org_id !== p.org_id) fail('Staff member not found.', 404);
    await q.query('INSERT INTO conflicts (staff_id, participant_id, source, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [staffId, p.id, source, ts(ctx.clock.now())]);
    await q.query('UPDATE participants SET primary_responder_id = CASE WHEN primary_responder_id = $2 THEN NULL ELSE primary_responder_id END, backup_responder_id = CASE WHEN backup_responder_id = $2 THEN NULL ELSE backup_responder_id END WHERE id = $1', [p.id, staffId]);
    await q.query('DELETE FROM access_grants WHERE participant_id = $1 AND session_hash IN (SELECT id_hash FROM sessions WHERE staff_id = $2)', [p.id, staffId]);
    await reassignAwayFrom(q, ctx, actor, p.id, staffId, 'conflict');
    await audit(q, ctx, actor, { action: 'conflict.add', targetType: 'participant', targetId: p.id, participantId: p.id, details: { source, staffId } });
  });
}

export async function removeConflict(ctx: Ctx, actor: Actor, participantId: string, staffId: string): Promise<void> {
  requireRole(actor, 'program_lead');
  await ctx.db.tx(async (q) => {
    const p = await getParticipantRow(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    await q.query('DELETE FROM conflicts WHERE staff_id = $1 AND participant_id = $2', [staffId, participantId]);
    await audit(q, ctx, actor, { action: 'conflict.remove', targetType: 'participant', targetId: participantId, participantId, details: { staffId } });
  });
}

export async function listConflicts(q: Q, participantId: string) {
  return many<{ staff_id: string; display_name: string; source: string }>(q, 'SELECT c.staff_id, s.display_name, c.source FROM conflicts c JOIN staff s ON s.id = c.staff_id WHERE c.participant_id = $1', [participantId]);
}

export function isHostOrg(org: OrgRow): boolean {
  return org.kind === 'host';
}
