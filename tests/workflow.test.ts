import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCEPT_STATEMENT, acceptCase, confirmReportedContact, declineCase, getCase, openCaseFor, proposeClosure, decideClosure, secondReview, recordAction, reopenCase, startExtendedWatch, tickCases } from '../src/domain/cases.js';
import { recordContact, voidContact } from '../src/domain/contacts.js';
import { overdueAt, runDetector } from '../src/domain/detector.js';
import { getParticipantRow } from '../src/domain/participants.js';
import { DAY, HOUR, type Host, type TestCtx, enrollWith, makeCtx, makeHost, runJobs } from './helpers.js';

let ctx: TestCtx;
let host: Host;

beforeEach(async () => {
  ctx = await makeCtx();
  host = await makeHost(ctx);
});
afterEach(async () => ctx.close());

async function makeOverdue(intervalDays = 7) {
  const p = await enrollWith(ctx, host, { plan: { intervalDays } });
  // 7-day plan + 2 days grace → overdue 9 days later (Wednesday 09:00 the following week).
  ctx.clock.advance((intervalDays + (intervalDays === 7 ? 2 : 3)) * DAY + HOUR);
  await runJobs(ctx, host.org.id);
  const c = await openCaseFor(ctx.db, p.id);
  return { p, c: c! };
}

describe('overdue detection', () => {
  it('computes overdue from the last qualifying contact, interval and grace', () => {
    const base = Date.parse('2026-11-16T14:00:00Z');
    expect(overdueAt({ last_qualifying_at: new Date(base), clock_base_at: new Date(base - DAY), clock_return: false, activated_at: new Date(base - DAY) }, { intervalDays: 7, graceDays: 2 }))
      .toBe(base + 9 * DAY);
    // After a pause, the return window is min(interval, 7) + grace.
    expect(overdueAt({ last_qualifying_at: null, clock_base_at: new Date(base), clock_return: true, activated_at: new Date(base - 60 * DAY) }, { intervalDays: 30, graceDays: 5 }))
      .toBe(base + 12 * DAY);
  });

  it('opens exactly one case when contact becomes overdue, and none before', async () => {
    const p = await enrollWith(ctx, host);
    ctx.clock.advance(8 * DAY);
    await runDetector(ctx, host.org.id);
    expect(await openCaseFor(ctx.db, p.id)).toBeNull();
    ctx.clock.advance(1 * DAY + HOUR);
    await Promise.all([runDetector(ctx, host.org.id), runDetector(ctx, host.org.id)]);
    await runDetector(ctx, host.org.id);
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM cases WHERE participant_id = $1', [p.id]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('a qualifying contact resets the clock; a secondhand report does not', async () => {
    const p = await enrollWith(ctx, host);
    ctx.clock.advance(6 * DAY);
    await recordContact(ctx, host.recorder, { participantId: p.id, kind: 'secondhand', confidence: 'reported', source: 'staff', note: 'a friend says she was fine' });
    ctx.clock.advance(3 * DAY + HOUR);
    await runDetector(ctx, host.org.id);
    expect(await openCaseFor(ctx.db, p.id)).not.toBeNull();
    const q = await enrollWith(ctx, host);
    ctx.clock.advance(6 * DAY);
    await recordContact(ctx, host.recorder, { participantId: q.id, kind: 'in_person', confidence: 'known', source: 'staff' });
    ctx.clock.advance(3 * DAY + HOUR);
    await runDetector(ctx, host.org.id);
    expect(await openCaseFor(ctx.db, q.id)).toBeNull();
  });

  it('does not open cases outside staffed hours; opens at the start of the next business day', async () => {
    const p = await enrollWith(ctx, host);
    ctx.clock.set(Date.parse('2026-11-25T23:30:00Z')); // overdue (Wed evening) but closed; Thanksgiving next
    await runDetector(ctx, host.org.id);
    expect(await openCaseFor(ctx.db, p.id)).toBeNull();
    ctx.clock.set(Date.parse('2026-11-26T15:00:00Z')); // Thanksgiving is a weekday but not a holiday here
    await runDetector(ctx, host.org.id);
    expect(await openCaseFor(ctx.db, p.id)).not.toBeNull();
  });
});

describe('offer chain and acceptance', () => {
  it('offers to primary, then backup, then coordinator, then marks uncovered and alerts the program lead', async () => {
    const { c } = await makeOverdue();
    expect(c.state).toBe('offered');
    expect(c.offeree_id).toBe(host.responderA.staffId);
    ctx.clock.advance(3 * HOUR + 60_000);
    await tickCases(ctx, host.org.id);
    expect((await getCase(ctx.db, c.id)).offeree_id).toBe(host.responderB.staffId);
    ctx.clock.advance(3 * HOUR + 60_000);
    await tickCases(ctx, host.org.id);
    const c3 = await getCase(ctx.db, c.id);
    expect(c3.offeree_id).toBe(host.coordinator.staffId);
    ctx.clock.advance(5 * HOUR); // past end of day: business minutes continue next morning
    await tickCases(ctx, host.org.id);
    ctx.clock.advance(16 * HOUR);
    await tickCases(ctx, host.org.id);
    const c4 = await getCase(ctx.db, c.id);
    expect(c4.state).toBe('uncovered');
    const lead = await ctx.db.query("SELECT count(*)::int AS n FROM notifications WHERE staff_id = $1 AND kind = 'uncovered'", [host.lead.staffId]);
    expect(lead.rows[0]!.n).toBeGreaterThan(0);
  });

  it('requires the explicit responsibility statement; viewing is not accepting', async () => {
    const { c } = await makeOverdue();
    await expect(acceptCase(ctx, host.responderA, c.id, 'ok')).rejects.toThrow(/responsible/);
    await acceptCase(ctx, host.responderA, c.id, ACCEPT_STATEMENT);
    const after = await getCase(ctx.db, c.id);
    expect(after.state).toBe('accepted');
    expect(after.owner_id).toBe(host.responderA.staffId);
  });

  it('declining moves the offer on immediately; the person who declined is not offered again', async () => {
    const { c } = await makeOverdue();
    await declineCase(ctx, host.responderA, c.id, 'on leave tomorrow');
    const after = await getCase(ctx.db, c.id);
    expect(after.offeree_id).toBe(host.responderB.staffId);
    await expect(acceptCase(ctx, host.responderA, c.id, ACCEPT_STATEMENT)).rejects.toThrow();
  });

  it('a stalled case goes to the coordinator, then is reassigned to the backup', async () => {
    const { c } = await makeOverdue();
    await acceptCase(ctx, host.responderA, c.id, ACCEPT_STATEMENT);
    ctx.clock.advance(DAY + HOUR);
    await tickCases(ctx, host.org.id);
    expect((await getCase(ctx.db, c.id)).state).toBe('stalled');
    ctx.clock.advance(DAY + HOUR);
    await tickCases(ctx, host.org.id);
    const after = await getCase(ctx.db, c.id);
    expect(after.state).toBe('offered');
    expect(after.offeree_id).toBe(host.responderB.staffId);
  });
});

describe('closure', () => {
  it('a contact recorded by someone else must be confirmed by the owner; wrong person reopens follow-up', async () => {
    const { p, c } = await makeOverdue();
    await acceptCase(ctx, host.responderA, c.id, ACCEPT_STATEMENT);
    await recordContact(ctx, host.recorder, { participantId: p.id, kind: 'in_person', confidence: 'known', source: 'staff' });
    expect((await getCase(ctx.db, c.id)).state).toBe('contact_reported');
    await confirmReportedContact(ctx, host.responderA, c.id, false, 'a different Laura');
    expect((await getCase(ctx.db, c.id)).state).toBe('accepted');
    await recordContact(ctx, host.recorder, { participantId: p.id, kind: 'in_person', confidence: 'verified', source: 'staff' });
    await confirmReportedContact(ctx, host.responderA, c.id, true);
    const closed = await getCase(ctx.db, c.id);
    expect(closed.state).toBe('closed');
    expect(closed.closure_reason).toBe('contact_restored');
  });

  it('a contact on an uncovered case gives it an owner (the coordinator on duty)', async () => {
    const { p, c } = await makeOverdue();
    await recordContact(ctx, host.recorder, { participantId: p.id, kind: 'in_person', confidence: 'known', source: 'staff' });
    const after = await getCase(ctx.db, c.id);
    expect(after.state).toBe('contact_reported');
    expect(after.owner_id).toBe(host.coordinator.staffId);
  });

  it('voiding the contact that closed a case reopens it', async () => {
    const { p, c } = await makeOverdue();
    await acceptCase(ctx, host.responderA, c.id, ACCEPT_STATEMENT);
    const r = await recordAction(ctx, host.responderA, c.id, { action: 'checked_records', source: 'host_staff', result: 'contact_restored', certainty: 'high', contact: { kind: 'in_person', confidence: 'known' } });
    expect(r.closed).toBe(true);
    const contact = await ctx.db.query('SELECT id FROM contacts WHERE participant_id = $1 ORDER BY recorded_at DESC LIMIT 1', [p.id]);
    await voidContact(ctx, host.coordinator, contact.rows[0]!.id, 'recorded against the wrong person');
    const after = await getCase(ctx.db, c.id);
    expect(after.state).toBe('accepted');
    expect(after.reopen_count).toBe(1);
  });

  it('never closes a case because time passed (a simulated year with no contact)', async () => {
    const { c } = await makeOverdue();
    for (let d = 0; d < 365; d += 2) {
      ctx.clock.advance(2 * DAY);
      await runJobs(ctx, host.org.id);
      if (d === 30) await acceptCase(ctx, host.coordinator, c.id, ACCEPT_STATEMENT);
      expect((await getCase(ctx.db, c.id)).state).not.toBe('closed');
    }
  });

  it('a reported death needs a listed source, a second reviewer who did not propose it, and program-lead approval', async () => {
    const { p, c } = await makeOverdue();
    await acceptCase(ctx, host.responderA, c.id, ACCEPT_STATEMENT);
    await expect(proposeClosure(ctx, host.responderA, c.id, { reason: 'reported_deceased', deceasedSource: null })).rejects.toThrow(/relative/);
    const id = await proposeClosure(ctx, host.responderA, c.id, { reason: 'reported_deceased', deceasedSource: 'official_notification' });
    await expect(decideClosure(ctx, host.lead, id, true)).rejects.toThrow(/second reviewer/);
    await expect(secondReview(ctx, host.responderA, id)).rejects.toThrow();
    await secondReview(ctx, host.coordinator, id);
    await decideClosure(ctx, host.lead, id, true);
    expect((await getCase(ctx.db, c.id)).closure_reason).toBe('reported_deceased');
    expect((await getParticipantRow(ctx.db, p.id)).state).toBe('ended');
  });

  it('extended watch requires every consented method to have been tried', async () => {
    const { c } = await makeOverdue();
    await acceptCase(ctx, host.responderA, c.id, ACCEPT_STATEMENT);
    ctx.clock.advance(15 * DAY);
    await expect(startExtendedWatch(ctx, host.coordinator, c.id)).rejects.toThrow(/records/);
    await recordAction(ctx, host.responderA, c.id, { action: 'checked_records', source: 'none', result: 'no_information', certainty: 'medium' });
    await startExtendedWatch(ctx, host.coordinator, c.id);
    expect((await getCase(ctx.db, c.id)).state).toBe('extended_watch');
    await expect(reopenCase(ctx, host.coordinator, c.id, 'x')).rejects.toThrow();
  });

  it('follow-up actions are limited to what the participant agreed to', async () => {
    const { c } = await makeOverdue();
    await acceptCase(ctx, host.responderA, c.id, ACCEPT_STATEMENT);
    await expect(recordAction(ctx, host.responderA, c.id, { action: 'visited_usual_place', source: 'none', result: 'no_information', certainty: 'low' })).rejects.toThrow(/did not agree/);
  });
});
