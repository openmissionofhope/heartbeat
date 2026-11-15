import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgeTrainingParticipants, setLegalHold } from '../src/domain/admin.js';
import { recordContact } from '../src/domain/contacts.js';
import { auditNow } from '../src/domain/core.js';
import { withdraw } from '../src/domain/lifecycle.js';
import { deidentifiedMetrics } from '../src/domain/metrics.js';
import { goLive, readiness, recordReadiness } from '../src/domain/orgs.js';
import { enroll, summarize, getParticipantRow } from '../src/domain/participants.js';
import { exportAuditDay, runRetention, verifyAuditChain } from '../src/domain/retention.js';
import { NEVER_REPORT, identifyRequiredReport, recordReportMade, REQUIRED_RECIPIENTS } from '../src/domain/safeguarding.js';
import { stripImageMetadata } from '../src/domain/selfview.js';
import { createOrg } from '../src/domain/orgs.js';
import { createStaff, loadActor } from '../src/domain/staff.js';
import { DAY, type Host, PASSWORD, type TestCtx, enrollInput, enrollWith, makeCtx, makeHost } from './helpers.js';

let ctx: TestCtx;
let host: Host;

beforeEach(async () => {
  ctx = await makeCtx();
  host = await makeHost(ctx);
});
afterEach(async () => ctx.close());

describe('audit trail', () => {
  it('is append-only and hash-chained; tampering is detected', async () => {
    await enrollWith(ctx, host);
    await expect(ctx.db.query("UPDATE audit_events SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
    expect((await verifyAuditChain(ctx)).ok).toBe(true);
    await ctx.db.query('ALTER TABLE audit_events DISABLE TRIGGER audit_append_only');
    await ctx.db.query("UPDATE audit_events SET reason = 'edited' WHERE id = (SELECT min(id) FROM audit_events)");
    await ctx.db.query('ALTER TABLE audit_events ENABLE TRIGGER audit_append_only');
    expect((await verifyAuditChain(ctx)).ok).toBe(false);
  });

  it('exports a daily checkpoint without participant links', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-audit-'));
    ctx.config.auditExportDir = dir;
    const p = await enrollWith(ctx, host);
    const day = new Date(ctx.clock.now()).toISOString().slice(0, 10);
    ctx.clock.advance(DAY);
    await exportAuditDay(ctx, day);
    const file = readFileSync(join(dir, `${day}.json`), 'utf8');
    expect(file).not.toContain(p.id);
    expect(JSON.parse(file).count).toBeGreaterThan(0);
  });
});

describe('retention and deletion', () => {
  it('deletes a withdrawn participant after 30 days and destroys their key; the audit trail no longer links to them', async () => {
    const p = await enrollWith(ctx, host);
    await recordContact(ctx, host.recorder, { participantId: p.id, kind: 'in_person', confidence: 'known', source: 'staff' });
    await withdraw(ctx, host.enroller, p.id, { channel: 'in_person', identity: 'known' });
    const blob = (await ctx.db.query('SELECT name_enc FROM participants WHERE id = $1', [p.id])).rows[0]!.name_enc;
    ctx.clock.advance(31 * DAY);
    await runRetention(ctx);
    expect((await ctx.db.query('SELECT 1 FROM participants WHERE id = $1', [p.id])).rowCount).toBe(0);
    expect((await ctx.db.query('SELECT 1 FROM participant_keys WHERE participant_id = $1', [p.id])).rowCount).toBe(0);
    expect((await ctx.db.query('SELECT end_reason FROM tombstones WHERE participant_id = $1', [p.id])).rows[0]!.end_reason).toBe('withdrawn');
    expect(blob).toBeInstanceOf(Buffer); // a backup copy of this ciphertext is now unreadable: its key is gone
    ctx.clock.advance(90 * DAY);
    await runRetention(ctx);
    const linked = await ctx.db.query("SELECT count(*)::int AS n FROM audit_events WHERE participant_id = $1 AND action = 'contact.record'", [p.id]);
    expect(linked.rows[0]!.n).toBe(0);
    expect((await verifyAuditChain(ctx)).ok).toBe(true);
  });

  it('deletes contacts after 90 days but keeps the latest dates; legal hold suspends deletion', async () => {
    const p = await enrollWith(ctx, host);
    const held = await enrollWith(ctx, host);
    for (const id of [p.id, held.id]) await recordContact(ctx, host.recorder, { participantId: id, kind: 'in_person', confidence: 'known', source: 'staff' });
    await setLegalHold(ctx, host.lead, held.id, 'Counsel letter 2026-11-20');
    ctx.clock.advance(91 * DAY);
    await runRetention(ctx);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM contacts WHERE participant_id = $1', [p.id])).rows[0]!.n).toBe(0);
    expect((await getParticipantRow(ctx.db, p.id)).last_qualifying_at).not.toBeNull();
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM contacts WHERE participant_id = $1', [held.id])).rows[0]!.n).toBe(1);
  });
});

describe('readiness gate (legal review etc.)', () => {
  it('a host in setup enrolls only training participants and cannot go live without every item', async () => {
    const setupHost = await makeHost(ctx, 'Setup Center', { live: false });
    const p = await enrollWith(ctx, setupHost);
    expect(p.training).toBe(true);
    const opOrg = await createOrg(ctx, null, { name: 'Open Mission of Hope', kind: 'operator' });
    const s = await createStaff(ctx, null, { orgId: opOrg.id, email: 'ops@omh.example', displayName: 'Operator', password: PASSWORD, roles: ['operator'] });
    const op = (await loadActor(ctx.db, s.id, null))!;
    await expect(goLive(ctx, op, setupHost.org.id)).rejects.toThrow(/counsel/);
    for (const item of await readiness(ctx.db, setupHost.org.id)) await recordReadiness(ctx, setupHost.lead, setupHost.org.id, item.key, 'ref');
    await expect(goLive(ctx, op, setupHost.org.id)).rejects.toThrow(/training participants/);
    await purgeTrainingParticipants(ctx, setupHost.lead, setupHost.org.id);
    await goLive(ctx, op, setupHost.org.id);
  });
});

describe('required abuse reports (OMH policy 2026-11-15)', () => {
  it('maps each category to who must be called, and has no immigration category', async () => {
    expect(REQUIRED_RECIPIENTS.child_abuse).toEqual(['police', 'dss_child']);
    expect(REQUIRED_RECIPIENTS.intimate_partner_abuse).toEqual(['police']);
    expect(REQUIRED_RECIPIENTS.disabled_adult).toEqual(['dss_adult']);
    expect(Object.keys(REQUIRED_RECIPIENTS).join()).not.toMatch(/immigra/);
    const p = await enrollWith(ctx, host);
    const r = await identifyRequiredReport(ctx, host.responderA, { category: 'disabled_adult', participantId: p.id });
    await expect(recordReportMade(ctx, host.responderA, r.ids[0]!, { reference: 'mentioned immigration' })).rejects.toThrow(NEVER_REPORT);
    await recordReportMade(ctx, host.responderA, r.ids[0]!, { reference: 'APS intake #123' });
  });

  it('the schema itself rejects an immigration category', async () => {
    await expect(ctx.db.query("INSERT INTO safeguarding_reports (org_id, category, recipient, identified_by, identified_at) VALUES ($1, 'immigration', 'police', $2, now())", [host.org.id, host.lead.staffId])).rejects.toThrow();
  });
});

describe('privacy details', () => {
  it('encrypts names at rest', async () => {
    const p = await enroll(ctx, host.enroller, enrollInput({ preferredName: 'Unmistakable Name' }));
    const raw = await ctx.db.query('SELECT name_enc::text AS t FROM participants WHERE id = $1', [p.id]);
    expect(raw.rows[0]!.t).not.toContain('Unmistakable');
    expect((await summarize(ctx, await getParticipantRow(ctx.db, p.id))).name).toBe('Unmistakable Name');
  });

  it('strips JPEG metadata (where GPS lives) from photos', () => {
    const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x08]), Buffer.from('Exif\0\0')]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9])]);
    const out = stripImageMetadata(jpeg).data;
    expect(out.includes(Buffer.from('Exif'))).toBe(false);
    expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('suppresses small counts in de-identified metrics', async () => {
    await enrollWith(ctx, host);
    ctx.clock.advance(10 * DAY);
    const { runDetector } = await import('../src/domain/detector.js');
    await runDetector(ctx, host.org.id);
    const rows = await deidentifiedMetrics(ctx, host.lead);
    expect(rows.some((r) => (r as Record<string, unknown>).cases_opened === '<5')).toBe(true);
    await auditNow(ctx, host.lead, { action: 'noop' });
  });
});

describe('demo deployment', () => {
  it('seeds a training host with made-up participants and refuses to let anyone go live', async () => {
    ctx.config.demo = true;
    const { seedDemo } = await import('../src/demo.js');
    const out = await seedDemo(ctx);
    expect(out).toContain('lead@demo.heartbeat.test');
    const org = (await ctx.db.query("SELECT * FROM organizations WHERE name = 'Demo Day Center'")).rows[0]!;
    expect(org.status).toBe('setup');
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM participants WHERE org_id = $1 AND training', [org.id])).rows[0]!.n).toBe(3);
    const op = (await ctx.db.query("SELECT id FROM staff WHERE email = 'operator@demo.heartbeat.test'")).rows[0]!;
    const actor = (await loadActor(ctx.db, op.id, null))!;
    await expect(goLive(ctx, actor, org.id)).rejects.toThrow(/demo deployment/);
    expect(await seedDemo(ctx)).toBe('Demo already seeded.');
  });
});
