import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCaseFor } from '../src/domain/cases.js';
import { createOrg } from '../src/domain/orgs.js';
import { getParticipantRow } from '../src/domain/participants.js';
import { RELAY_RECEIPT, recordRelay } from '../src/domain/relay.js';
import { handleInboundSms, sendReminders, voiceAfterId, voiceAfterPin } from '../src/domain/sms.js';
import { createStaff, loadActor } from '../src/domain/staff.js';
import { DAY, HOUR, type Host, PASSWORD, type TestCtx, enrollWith, makeCtx, makeHost } from './helpers.js';

let ctx: TestCtx;
let host: Host;

beforeEach(async () => {
  ctx = await makeCtx();
  host = await makeHost(ctx);
});
afterEach(async () => ctx.close());

const smsConsent = { relays: true, sms: true, keypad: true, continuitySharing: false, photo: false, selfView: false };

describe('text-message check-ins', () => {
  it('a text of the check-in word from the registered phone is a verified self-check-in that counts if the plan says so', async () => {
    const p = await enrollWith(ctx, host, { consent: smsConsent, keypadPin: '2468', plan: { intervalDays: 7, phone: '828-555-0142', smsCheckins: true, qualifyingKinds: ['in_person', 'phone_with_staff', 'self_check_in'] } });
    const reply = await handleInboundSms(ctx, { from: '+18285550142', to: host.org.sms_number!, body: 'Blue river', providerId: 'SM1' });
    expect(reply).toMatch(/got your check-in/);
    expect(reply).not.toMatch(/\bsafe\b|\bOK\b/i);
    const row = await getParticipantRow(ctx.db, p.id);
    expect(row.last_qualifying_kind).toBe('self_check_in');
    expect(row.last_qualifying_confidence).toBe('verified');
  });

  it('any other text is recorded as a lead, never as verified', async () => {
    const p = await enrollWith(ctx, host, { consent: smsConsent, keypadPin: '2468', plan: { intervalDays: 7, phone: '828-555-0142', smsCheckins: true, qualifyingKinds: ['in_person', 'self_check_in'] } });
    await handleInboundSms(ctx, { from: '+18285550142', to: host.org.sms_number!, body: 'staying at my sister', providerId: 'SM2' });
    const c = await ctx.db.query('SELECT confidence, qualifying FROM contacts WHERE participant_id = $1', [p.id]);
    expect(c.rows[0]).toMatchObject({ confidence: 'stated', qualifying: false });
  });

  it('unknown numbers get a generic reply; STOP opts out and suppresses reminders', async () => {
    expect(await handleInboundSms(ctx, { from: '+18285559999', to: host.org.sms_number!, body: 'hello' })).toMatch(/This number is for check-ins/);
    await enrollWith(ctx, host, { consent: smsConsent, keypadPin: '2468', plan: { intervalDays: 7, phone: '828-555-0142', smsReminders: true } });
    ctx.clock.advance(6 * DAY);
    expect(await sendReminders(ctx, host.org.id)).toBe(1);
    expect(ctx.sms.sent.at(-1)!.body).toMatch(/not emergency help/i);
    expect(await handleInboundSms(ctx, { from: '+18285550142', to: host.org.sms_number!, body: 'STOP' })).toMatch(/no more texts/);
    ctx.clock.advance(7 * DAY + HOUR);
    expect(await sendReminders(ctx, host.org.id)).toBe(0);
  });
});

describe('phone keypad check-ins', () => {
  it('check-in number plus PIN records a verified self-check-in; a wrong PIN says the same thing as an unknown number', async () => {
    const p = await enrollWith(ctx, host, { consent: smsConsent, keypadPin: '2468', plan: { intervalDays: 7, keypadCheckins: true } });
    const id = (await getParticipantRow(ctx.db, p.id)).phone_checkin_id!;
    const state = /s=([^"]+)"/.exec(voiceAfterId(ctx, id))![1]!;
    const wrong = await voiceAfterPin(ctx, decodeURIComponent(state), '1111');
    const unknown = await voiceAfterPin(ctx, decodeURIComponent(/s=([^"]+)"/.exec(voiceAfterId(ctx, '12345674'))![1]!), '1111');
    expect(wrong).toMatch(/did not match/);
    expect(unknown).toMatch(/did not match/);
    const ok = await voiceAfterPin(ctx, decodeURIComponent(state), '2468');
    expect(ok).toMatch(/check-in .* was recorded/);
    expect((await ctx.db.query("SELECT count(*)::int AS n FROM contacts WHERE participant_id = $1 AND source = 'keypad' AND confidence = 'verified'", [p.id])).rows[0]!.n).toBe(1);
  });
});

describe('relays from a partner organization', () => {
  it('gives the same receipt for every outcome and records a verified relay only with the right answer', async () => {
    const partner = await createOrg(ctx, null, { name: 'Partner Shelter', kind: 'partner' });
    const s = await createStaff(ctx, null, { orgId: partner.id, email: 'relay@partner.example', displayName: 'Relay Desk', password: PASSWORD, roles: ['relay'] });
    const relay = (await loadActor(ctx.db, s.id, null))!;
    const p = await enrollWith(ctx, host, { plan: { intervalDays: 7, qualifyingKinds: ['in_person', 'relay'] } });
    expect(await recordRelay(ctx, relay, { code: 'HB-2222-2222-2', answer: 'x' })).toBe(RELAY_RECEIPT);
    expect(await recordRelay(ctx, relay, { code: p.code, answer: 'wrong answer' })).toBe(RELAY_RECEIPT);
    expect((await getParticipantRow(ctx.db, p.id)).last_qualifying_at).toBeNull();
    expect(await recordRelay(ctx, relay, { code: p.code, answer: 'blue river', message: 'tell them I am fine' })).toBe(RELAY_RECEIPT);
    expect((await getParticipantRow(ctx.db, p.id)).last_qualifying_kind).toBe('relay');
  });

  it('five wrong answers lock relays for that participant for 24 hours', async () => {
    const partner = await createOrg(ctx, null, { name: 'Partner Shelter', kind: 'partner' });
    const s = await createStaff(ctx, null, { orgId: partner.id, email: 'relay2@partner.example', displayName: 'Relay Desk', password: PASSWORD, roles: ['relay'] });
    const relay = (await loadActor(ctx.db, s.id, null))!;
    const p = await enrollWith(ctx, host, { plan: { intervalDays: 7, qualifyingKinds: ['in_person', 'relay'] } });
    for (let i = 0; i < 5; i++) await recordRelay(ctx, relay, { code: p.code, answer: `guess${i}` });
    await recordRelay(ctx, relay, { code: p.code, answer: 'blue river' });
    expect((await getParticipantRow(ctx.db, p.id)).last_qualifying_at).toBeNull();
    ctx.clock.advance(DAY + HOUR);
    await recordRelay(ctx, relay, { code: p.code, answer: 'blue river' });
    expect((await getParticipantRow(ctx.db, p.id)).last_qualifying_kind).toBe('relay');
    expect(await openCaseFor(ctx.db, p.id)).toBeNull();
  });
});
