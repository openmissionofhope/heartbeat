import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCEPT_STATEMENT, acceptCase, getCase, openCaseFor, recordAction } from '../src/domain/cases.js';
import { recordContact } from '../src/domain/contacts.js';
import { declareHold, endHold, openRollCallCases, rollCall, runDetector } from '../src/domain/detector.js';
import { cancelPendingWithdrawal, confirmWithdrawalInPerson, pause, reinstate, withdraw } from '../src/domain/lifecycle.js';
import { accessBasis, addConflict, changePlan, currentPlan, getParticipantRow, grantAccess, remoteFlags, searchParticipants } from '../src/domain/participants.js';
import { recordConcern } from '../src/domain/concerns.js';
import { DAY, HOUR, type Host, type TestCtx, enrollWith, makeCtx, makeHost, runJobs } from './helpers.js';

let ctx: TestCtx;
let host: Host;

beforeEach(async () => {
  ctx = await makeCtx();
  host = await makeHost(ctx);
});
afterEach(async () => ctx.close());

describe('withdrawal (decision D6: remote withdrawal needs personal confirmation)', () => {
  it('in-person withdrawal takes effect at once and schedules deletion', async () => {
    const p = await enrollWith(ctx, host);
    expect(await withdraw(ctx, host.enroller, p.id, { channel: 'in_person', identity: 'known' })).toBe('withdrawn');
    const row = await getParticipantRow(ctx.db, p.id);
    expect(row.state).toBe('withdrawn');
    expect(row.delete_after!.getTime() - ctx.clock.now()).toBe(30 * DAY);
  });

  it('an unverified remote withdrawal changes nothing and tells the coordinator', async () => {
    const p = await enrollWith(ctx, host);
    await expect(withdraw(ctx, host.enroller, p.id, { channel: 'remote', identity: 'stated' })).rejects.toThrow(/verification/);
    expect((await getParticipantRow(ctx.db, p.id)).state).toBe('active');
    const n = await ctx.db.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'remote_request_unverified'");
    expect(n.rows[0]!.n).toBe(1);
  });

  it('a verified remote withdrawal stays pending — outreach stops, passive steps only — until confirmed in person', async () => {
    const p = await enrollWith(ctx, host);
    ctx.clock.advance(9 * DAY + HOUR);
    await runJobs(ctx, host.org.id);
    const c = (await openCaseFor(ctx.db, p.id))!;
    await acceptCase(ctx, host.responderA, c.id, ACCEPT_STATEMENT);
    expect(await withdraw(ctx, host.responderA, p.id, { channel: 'remote', identity: 'verified' })).toBe('withdrawal_pending');
    const after = await getCase(ctx.db, c.id);
    expect(after.withdrawal_pending).toBe(true);
    expect(after.owner_id).toBe(host.coordinator.staffId);
    await expect(recordAction(ctx, host.coordinator, c.id, { action: 'called', source: 'none', result: 'no_information', certainty: 'low' })).rejects.toThrow(/passive/);
    await recordAction(ctx, host.coordinator, c.id, { action: 'checked_records', source: 'none', result: 'no_information', certainty: 'low' });
    // A year of silence never finalizes it.
    for (let d = 0; d < 365; d += 5) {
      ctx.clock.advance(5 * DAY);
      await runJobs(ctx, host.org.id);
    }
    expect((await getParticipantRow(ctx.db, p.id)).state).toBe('withdrawal_pending');
    await confirmWithdrawalInPerson(ctx, host.enroller, p.id);
    expect((await getParticipantRow(ctx.db, p.id)).state).toBe('withdrawn');
    expect((await getCase(ctx.db, c.id)).closure_reason).toBe('withdrawn');
  });

  it('the participant can say in person they did not mean it, and can be reinstated after withdrawing', async () => {
    const p = await enrollWith(ctx, host);
    await withdraw(ctx, host.enroller, p.id, { channel: 'remote', identity: 'known' });
    await cancelPendingWithdrawal(ctx, host.enroller, p.id);
    expect((await getParticipantRow(ctx.db, p.id)).state).toBe('active');
    await withdraw(ctx, host.enroller, p.id, { channel: 'in_person', identity: 'known' });
    await reinstate(ctx, host.coordinator, p.id);
    expect((await getParticipantRow(ctx.db, p.id)).state).toBe('active');
  });
});

describe('pauses and remote changes', () => {
  it('a remote pause is capped at 14 days and cannot be chained without a contact', async () => {
    const p = await enrollWith(ctx, host);
    await expect(pause(ctx, host.enroller, p.id, { endsAt: ctx.clock.now() + 20 * DAY, channel: 'remote', identity: 'verified' })).rejects.toThrow(/14 days/);
    await pause(ctx, host.enroller, p.id, { endsAt: ctx.clock.now() + 10 * DAY, channel: 'remote', identity: 'verified' });
    ctx.clock.advance(10 * DAY + HOUR);
    await runDetector(ctx, host.org.id);
    expect((await getParticipantRow(ctx.db, p.id)).state).toBe('active');
    await expect(pause(ctx, host.enroller, p.id, { endsAt: ctx.clock.now() + 5 * DAY, channel: 'remote', identity: 'verified' })).rejects.toThrow(/qualifying contact/);
  });

  it('after a pause the participant gets the return window, not a full interval', async () => {
    const p = await enrollWith(ctx, host, { plan: { intervalDays: 30 } });
    await pause(ctx, host.enroller, p.id, { endsAt: ctx.clock.now() + 3 * DAY, channel: 'in_person', identity: 'known' });
    ctx.clock.advance(3 * DAY + HOUR);
    await runDetector(ctx, host.org.id);
    ctx.clock.advance(11 * DAY); // return window = 7 + 5 grace = 12 days
    await runDetector(ctx, host.org.id);
    expect(await openCaseFor(ctx.db, p.id)).toBeNull();
    ctx.clock.advance(2 * DAY);
    await runDetector(ctx, host.org.id);
    expect(await openCaseFor(ctx.db, p.id)).not.toBeNull();
  });

  it('safety-reducing remote changes need verified identity and are flagged until confirmed in person', async () => {
    const p = await enrollWith(ctx, host);
    await expect(changePlan(ctx, host.enroller, p.id, { intervalDays: 30 }, { channel: 'remote', identity: 'stated' })).rejects.toThrow(/verification/);
    expect((await currentPlan(ctx.db, ctx, p.id)).intervalDays).toBe(7);
    const r = await changePlan(ctx, host.enroller, p.id, { intervalDays: 30 }, { channel: 'remote', identity: 'verified' });
    expect(r.remoteFlag).toBe(true);
    expect(await remoteFlags(ctx.db, p.id, ctx.clock.now())).toHaveLength(1);
    await recordContact(ctx, host.recorder, { participantId: p.id, kind: 'in_person', confidence: 'known', source: 'staff' });
    const n = await ctx.db.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'remote_change_seen'");
    expect(n.rows[0]!.n).toBe(1);
  });
});

describe('access and lookup', () => {
  it('recorders see code and visible names only; code-only participants never appear in their name searches', async () => {
    const a = await enrollWith(ctx, host, { preferredName: 'Laura Smith', otherNames: [{ name: 'Lulu', recorderVisible: false }, { name: 'L.S.', recorderVisible: true }] });
    const b = await enrollWith(ctx, host, { preferredName: 'Laura Jones', lookup: 'code_only' });
    const hits = await searchParticipants(ctx, host.recorder, 'laura');
    expect(hits.map((h) => h.id)).toEqual([a.id]);
    expect(hits[0]!.otherNames).toEqual(['L.S.']);
    expect(await searchParticipants(ctx, host.recorder, 'lulu')).toEqual([]);
    expect((await searchParticipants(ctx, host.recorder, b.code)).map((h) => h.id)).toEqual([b.id]);
    expect((await searchParticipants(ctx, host.enroller, 'laura')).length).toBe(2);
    const audit = await ctx.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'participant.search'");
    expect(audit.rows[0]!.n).toBe(4);
  });

  it('coordinators need a typed reason to see a plan; excluded staff are blocked but can still record contact', async () => {
    const p = await enrollWith(ctx, host);
    const lead = { ...host.lead, sessionHash: null };
    const row = await getParticipantRow(ctx.db, p.id);
    expect(await accessBasis(ctx.db, ctx, lead, row, 'plan')).toBeNull();
    await addConflict(ctx, host.enroller, p.id, host.responderB.staffId, 'participant_requested');
    await expect(accessBasis(ctx.db, ctx, host.responderB, row, 'plan')).rejects.toThrow(/excluded/);
    await recordContact(ctx, host.responderB, { participantId: p.id, kind: 'in_person', confidence: 'known', source: 'staff' });
    expect((await getParticipantRow(ctx.db, p.id)).backup_responder_id).toBeNull();
    await expect(grantAccess(ctx, { ...host.coordinator, sessionHash: null }, p.id, 'too short')).rejects.toThrow();
  });

  it('a concern from someone else never confirms enrollment, and sets a tell-me prompt', async () => {
    const p = await enrollWith(ctx, host);
    await recordConcern(ctx, host.coordinator, p.id, { source: 'family', callback: '828-555-0199' });
    expect((await getParticipantRow(ctx.db, p.id)).tell_pending).toBe(true);
  });
});

describe('escalation hold and roll call', () => {
  it('hold stops individual cases; it cannot end until everyone has a contact or a case', async () => {
    const a = await enrollWith(ctx, host);
    const b = await enrollWith(ctx, host, { plan: { intervalDays: 7, disasterPriority: true } });
    await declareHold(ctx, host.coordinator, 'flooding; host closed');
    ctx.clock.advance(12 * DAY);
    await runDetector(ctx, host.org.id);
    expect(await openCaseFor(ctx.db, a.id)).toBeNull();
    const list = await rollCall(ctx, host.coordinator);
    expect(list[0]!.id).toBe(b.id); // disaster priority first
    await expect(endHold(ctx, host.coordinator)).rejects.toThrow(/no contact since the hold/);
    await recordContact(ctx, host.recorder, { participantId: a.id, kind: 'in_person', confidence: 'known', source: 'staff' });
    expect(await openRollCallCases(ctx, host.coordinator, [b.id], host.responderC.staffId)).toBe(1);
    await endHold(ctx, host.coordinator);
    const c = (await openCaseFor(ctx.db, b.id))!;
    expect(c.trigger).toBe('roll_call');
    expect(c.offeree_id).toBe(host.responderC.staffId);
    ctx.clock.advance(5 * DAY);
    await runDetector(ctx, host.org.id);
    expect(await openCaseFor(ctx.db, a.id)).toBeNull(); // T-RETURN after the hold
  });
});
