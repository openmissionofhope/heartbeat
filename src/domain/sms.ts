import { POLICY } from '../config.js';
import type { Q } from '../db/index.js';
import { many, maybe, one, ts } from '../db/index.js';
import { DAY, localDate, localParts } from '../lib/calendar.js';
import { isValidPhoneCheckinId, normalizePhone } from '../lib/codes.js';
import { hashSecret, hmac, normalizeAnswer, randomDigits, safeEqual, verifySecret } from '../lib/crypto.js';
import { type Actor, type Ctx, audit, fail } from './core.js';
import { recordContactInTx } from './contacts.js';
import { type OrgRow, getOrg } from './orgs.js';
import { type ParticipantRow, checkVerification, currentPlan, getParticipantRow, latestConsent, lockParticipant, markPhoneVerified, phoneIndex } from './participants.js';

/**
 * Text-message and phone-keypad check-ins (decision D2, 2026-11-14). Messages never say "safe" or
 * "OK", never name the participant, and always say Heartbeat is not emergency help.
 */
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
const HELP_WORDS = new Set(['help', 'info']);

function hoursText(org: OrgRow): string {
  const fmt = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${m < 720 ? 'am' : 'pm'}`;
  const weekdays = org.work_days.join(',') === '1,2,3,4,5' ? 'Mon–Fri' : 'staffed days';
  return `${weekdays} ${fmt(org.day_start_min)}–${fmt(org.day_end_min)}`;
}

export function helpText(org: OrgRow): string {
  return `${org.name} Heartbeat check-ins. Call ${org.public_phone ?? 'the front desk'} (${hoursText(org)}). This is not emergency help: in an emergency call 911. Reply STOP to stop texts.`;
}

async function optedOut(q: Q, orgId: string, index: string): Promise<boolean> {
  return !!(await maybe(q, 'SELECT 1 FROM sms_optouts WHERE org_id = $1 AND phone_index = $2', [orgId, index]));
}

export async function handleInboundSms(ctx: Ctx, input: { from: string; to: string; body: string; providerId?: string }): Promise<string | null> {
  const org = await maybe<OrgRow>(ctx.db, 'SELECT * FROM organizations WHERE sms_number = $1', [normalizePhone(input.to)]);
  if (!org) return null;
  const from = normalizePhone(input.from);
  if (!from) return null;
  const index = phoneIndex(ctx, org.id, from);
  const word = input.body.trim().toLowerCase().replace(/[^a-z]/g, '');
  const now = ctx.clock.now();
  if (STOP_WORDS.has(word)) {
    await ctx.db.tx(async (q) => {
      await q.query('INSERT INTO sms_optouts (org_id, phone_index, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [org.id, index, ts(now)]);
      await audit(q, ctx, { kind: 'provider', orgId: org.id }, { action: 'sms.optout', targetType: 'organization', targetId: org.id });
    });
    return `You will get no more texts from ${org.name} Heartbeat. Reply START to resume.`;
  }
  if (START_WORDS.has(word)) {
    await ctx.db.tx(async (q) => {
      await q.query('DELETE FROM sms_optouts WHERE org_id = $1 AND phone_index = $2', [org.id, index]);
      await audit(q, ctx, { kind: 'provider', orgId: org.id }, { action: 'sms.optin', targetType: 'organization', targetId: org.id });
    });
    return `Texts from ${org.name} Heartbeat are back on. ${helpText(org)}`;
  }
  if (HELP_WORDS.has(word)) return helpText(org);

  const recent = await one<{ n: string }>(ctx.db, "SELECT count(*) AS n FROM sms_messages WHERE org_id = $1 AND direction = 'in' AND dedupe_key LIKE $2 AND created_at >= $3",
    [org.id, `in:${index}:%`, ts(now - 3_600_000)]);
  if (Number(recent.n) >= 10) return null;

  return ctx.db.tx(async (q) => {
    const match = await maybe<{ participant_id: string }>(q,
      `SELECT pv.participant_id FROM plan_versions pv JOIN participants p ON p.id = pv.participant_id
        WHERE pv.phone_index = $1 AND pv.superseded_at IS NULL AND pv.sms_checkins AND p.org_id = $2
          AND p.state IN ('active','paused','withdrawal_pending','transfer_pending','inactive') LIMIT 1`, [index, org.id]);
    await q.query("INSERT INTO sms_messages (org_id, participant_id, direction, purpose, provider_id, status, dedupe_key, created_at) VALUES ($1,$2,'in','checkin',$3,'received',$4,$5)",
      [org.id, match?.participant_id ?? null, input.providerId ?? null, `in:${index}:${input.providerId ?? now}`, ts(now)]);
    if (!match) {
      await audit(q, ctx, { kind: 'provider', orgId: org.id }, { action: 'sms.inbound_unmatched', targetType: 'organization', targetId: org.id });
      return `This number is for check-ins with ${org.name}. Please call ${org.public_phone ?? 'the front desk'}. In an emergency call 911.`;
    }
    const p = await lockParticipant(q, match.participant_id);
    const consent = await latestConsent(q, p.id);
    if (!consent.sms) return helpText(org);
    const stripped = input.body.trim().replace(/^(here|check\s*in|checkin)\b[\s:,-]*/i, '');
    const looksLikeAnswer = normalizeAnswer(stripped).length >= 3 && normalizeAnswer(stripped).length <= 40;
    const verified = looksLikeAnswer && p.verification_hash && !(p.verification_locked_until && p.verification_locked_until.getTime() > now)
      ? await verifySecret(normalizeAnswer(stripped), p.verification_hash) : false;
    const note = verified ? null : input.body.trim().slice(0, POLICY.noteMax.contact);
    await recordContactInTx(q, ctx, { kind: 'provider', orgId: org.id }, { participantId: p.id, kind: 'self_check_in', confidence: verified ? 'verified' : 'stated', source: 'sms', note });
    const date = new Date(now).toLocaleDateString('en-US', { timeZone: org.timezone, month: 'short', day: 'numeric' });
    return verified
      ? `Thanks — ${org.name} got your check-in on ${date}. This is not emergency help: if you are in danger, call 911.`
      : `Thanks — ${org.name} got your message on ${date}. To check in, text just your check-in word. This is not emergency help: in an emergency call 911.`;
  });
}

// ---------------------------------------------------------------------------
// Outbound texts
// ---------------------------------------------------------------------------

function withinTextingHours(now: number, tz: string): boolean {
  const { hh } = localParts(now, tz);
  return hh >= POLICY.smsQuietHours.startHour && hh < POLICY.smsQuietHours.endHour;
}

async function sendToParticipant(ctx: Ctx, org: OrgRow, p: ParticipantRow, to: string, body: string, purpose: string, dedupeKey: string | null, ignoreQuietHours = false): Promise<'sent' | 'skipped' | 'failed'> {
  const now = ctx.clock.now();
  if (!org.sms_number) return 'skipped';
  if (await optedOut(ctx.db, org.id, phoneIndex(ctx, org.id, to))) return 'skipped';
  if (!ignoreQuietHours && !withinTextingHours(now, org.timezone)) return 'skipped';
  if (dedupeKey && (await maybe(ctx.db, 'SELECT 1 FROM sms_messages WHERE dedupe_key = $1', [dedupeKey]))) return 'skipped';
  let status: 'sent' | 'failed' = 'sent';
  let providerId: string | null = null;
  try {
    providerId = (await ctx.sms.send({ from: org.sms_number, to, body })).providerId;
  } catch {
    status = 'failed';
  }
  await ctx.db.query("INSERT INTO sms_messages (org_id, participant_id, direction, purpose, provider_id, status, dedupe_key, created_at) VALUES ($1,$2,'out',$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
    [org.id, p.id, purpose, providerId, status, dedupeKey, ts(now)]);
  return status;
}

/** Scheduler: one reminder per contact period, the day before it is due, for participants who asked. */
export async function sendReminders(ctx: Ctx, orgId: string): Promise<number> {
  const org = await getOrg(ctx.db, orgId);
  if (!org.sms_number || org.status === 'closed') return 0;
  const now = ctx.clock.now();
  if (!withinTextingHours(now, org.timezone)) return 0;
  const rows = await many<ParticipantRow>(ctx.db,
    `SELECT p.* FROM participants p JOIN plan_versions pv ON pv.participant_id = p.id AND pv.superseded_at IS NULL
      WHERE p.org_id = $1 AND p.state = 'active' AND pv.sms_reminders AND pv.phone_enc IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.participant_id = p.id AND c.state <> 'closed')`, [orgId]);
  let sent = 0;
  for (const p of rows) {
    const plan = await currentPlan(ctx.db, ctx, p.id);
    const consent = await latestConsent(ctx.db, p.id);
    if (!consent.sms || !plan.phone) continue;
    const base = Math.max(p.last_qualifying_at?.getTime() ?? 0, p.clock_base_at?.getTime() ?? 0);
    const due = base + plan.intervalDays * DAY;
    if (now < due - DAY || now > due + plan.graceDays * DAY) continue;
    const body = `${org.name}: it's time to check in. Text your check-in word to this number, or call ${org.public_phone ?? 'us'}. Not emergency help: in an emergency call 911. Reply STOP to stop texts.`;
    if ((await sendToParticipant(ctx, org, p, plan.phone, body, 'reminder', `reminder:${p.id}:${due}`)) === 'sent') sent++;
  }
  return sent;
}

/** A responder sends the participant's own permitted message as a follow-up text, recorded as an action. */
export async function sendFollowupText(ctx: Ctx, actor: Actor, caseId: string): Promise<'sent' | 'skipped' | 'failed'> {
  const { getCase, recordAction } = await import('./cases.js');
  const c = await getCase(ctx.db, caseId);
  if (c.org_id !== actor.orgId) fail('Case not found.', 404);
  if (c.owner_id !== actor.staffId) fail('Only the case owner can send this.', 403);
  if (c.withdrawal_pending) fail('This participant asked to withdraw; no outreach until they confirm in person.');
  const p = await getParticipantRow(ctx.db, c.participant_id);
  const plan = await currentPlan(ctx.db, ctx, p.id);
  const consent = await latestConsent(ctx.db, p.id);
  if (!plan.followup.includes('phone') || !plan.phoneText || !plan.phone) fail('The participant did not agree to follow-up texts.');
  if (!consent.sms) fail('The participant did not agree to automated texts; text from a work phone if texting is allowed, and record it as an action.');
  const org = await getOrg(ctx.db, c.org_id);
  const body = `${plan.phoneMessage ?? `This is ${org.name}. Please call us at ${org.public_phone ?? 'the front desk'}.`} Reply STOP to stop texts.`;
  const status = await sendToParticipant(ctx, org, p, plan.phone!, body, 'followup', null);
  if (status === 'sent') await recordAction(ctx, actor, caseId, { action: 'texted', source: 'none', result: 'no_information', certainty: 'low', note: 'Permitted message sent by Heartbeat text.' });
  return status;
}

/** Sends a 6-digit code to the plan's phone so staff can confirm the number with the participant present. */
export async function sendPhoneCode(ctx: Ctx, actor: Actor, participantId: string): Promise<'sent' | 'skipped' | 'failed'> {
  const p = await getParticipantRow(ctx.db, participantId);
  if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
  const plan = await currentPlan(ctx.db, ctx, p.id);
  const consent = await latestConsent(ctx.db, p.id);
  if (!plan.phone || !consent.sms) fail('Add a phone number and the participant’s agreement to texts first.');
  const code = randomDigits(6);
  await ctx.db.query(`INSERT INTO phone_codes (participant_id, code_hash, expires_at) VALUES ($1,$2,$3)
    ON CONFLICT (participant_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`, [p.id, await hashSecret(code), ts(ctx.clock.now() + 15 * 60_000)]);
  const org = await getOrg(ctx.db, p.org_id);
  return sendToParticipant(ctx, org, p, plan.phone!, `${org.name} Heartbeat code: ${code}. Tell it to the staff member with you. Reply STOP to stop texts.`, 'verify', null, true);
}

export async function verifyPhoneCode(ctx: Ctx, actor: Actor, participantId: string, code: string): Promise<boolean> {
  return ctx.db.tx(async (q) => {
    const p = await getParticipantRow(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    const row = await maybe<{ code_hash: string; expires_at: Date; attempts: number }>(q, 'SELECT * FROM phone_codes WHERE participant_id = $1 FOR UPDATE', [p.id]);
    if (!row || row.expires_at.getTime() < ctx.clock.now() || row.attempts >= 5) fail('Send a new code.');
    const ok = await verifySecret(code.replace(/\D/g, ''), row!.code_hash);
    if (!ok) {
      await q.query('UPDATE phone_codes SET attempts = attempts + 1 WHERE participant_id = $1', [p.id]);
      return false;
    }
    await q.query('DELETE FROM phone_codes WHERE participant_id = $1', [p.id]);
    await markPhoneVerified(q, ctx, p.id);
    await audit(q, ctx, actor, { action: 'plan.phone_verified', targetType: 'participant', targetId: p.id, participantId: p.id });
    return true;
  });
}

// ---------------------------------------------------------------------------
// Phone keypad check-ins (TwiML). Every caller hears the same words whether or not a number exists.
// ---------------------------------------------------------------------------

function xml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function twiml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

export function signKeypadState(ctx: Ctx, id: string, expires: number): string {
  return `${id}.${expires}.${hmac(ctx.config.secret, 'keypad', id, String(expires))}`;
}

function readKeypadState(ctx: Ctx, s: string): string | null {
  const [id, exp, mac] = s.split('.');
  if (!id || !exp || !mac || Number(exp) < ctx.clock.now()) return null;
  return safeEqual(hmac(ctx.config.secret, 'keypad', id, exp), mac) ? id : null;
}

export async function voiceGreeting(ctx: Ctx, to: string): Promise<string> {
  const org = await maybe<OrgRow>(ctx.db, 'SELECT * FROM organizations WHERE sms_number = $1', [normalizePhone(to)]);
  const name = org?.name ?? 'Heartbeat';
  return twiml(`<Say>This is the ${xml(name)} Heartbeat check-in line. This is not emergency help. If you are in danger, hang up and call 9 1 1.</Say>`
    + `<Gather input="dtmf" numDigits="8" timeout="10" action="/hooks/voice/id" method="POST"><Say>Please enter your 8 digit check-in number.</Say></Gather>`
    + `<Say>We did not get a number. Please call ${xml(org?.public_phone ?? 'the front desk')}. Goodbye.</Say>`);
}

export function voiceAfterId(ctx: Ctx, digits: string): string {
  const id = digits.replace(/\D/g, '');
  const state = signKeypadState(ctx, isValidPhoneCheckinId(id) ? id : '00000000', ctx.clock.now() + 5 * 60_000);
  return twiml(`<Gather input="dtmf" finishOnKey="#" timeout="10" action="/hooks/voice/pin?s=${encodeURIComponent(state)}" method="POST"><Say>Now enter your PIN, then press the pound key.</Say></Gather><Say>Goodbye.</Say>`);
}

export async function voiceAfterPin(ctx: Ctx, state: string, pin: string): Promise<string> {
  const id = readKeypadState(ctx, state);
  const generic = (orgPhone: string | null) => twiml(`<Say>That did not match. Please call ${xml(orgPhone ?? 'the front desk')}. This is not emergency help. Goodbye.</Say>`);
  if (!id) return generic(null);
  return ctx.db.tx(async (q) => {
    const p = await maybe<ParticipantRow>(q, 'SELECT * FROM participants WHERE phone_checkin_id = $1 FOR UPDATE', [id]);
    if (!p || !['active', 'paused', 'withdrawal_pending', 'transfer_pending', 'inactive'].includes(p.state) || !p.keypad_pin_hash) return generic(null);
    const org = await getOrg(q, p.org_id);
    const plan = await currentPlan(q, ctx, p.id);
    const consent = await latestConsent(q, p.id);
    if (!plan.keypadCheckins || !consent.keypad) return generic(org.public_phone);
    const now = ctx.clock.now();
    if (p.verification_locked_until && p.verification_locked_until.getTime() > now) return generic(org.public_phone);
    const ok = await verifySecret(pin.replace(/\D/g, ''), p.keypad_pin_hash);
    if (!ok) {
      // Shares the verification lockout with the check-in word.
      await checkVerification(q, ctx, p, `__keypad_wrong__${pin}`, { kind: 'provider', orgId: org.id });
      return generic(org.public_phone);
    }
    await recordContactInTx(q, ctx, { kind: 'provider', orgId: org.id }, { participantId: p.id, kind: 'self_check_in', confidence: 'verified', source: 'keypad' });
    const date = new Date(now).toLocaleDateString('en-US', { timeZone: org.timezone, month: 'long', day: 'numeric' });
    return twiml(`<Say>Thank you. Your check-in with ${xml(org.name)} was recorded on ${xml(date)}. This is not emergency help. Goodbye.</Say>`);
  });
}

export { localDate };
