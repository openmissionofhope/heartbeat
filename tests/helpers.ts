import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { POLICY, loadConfig } from '../src/config.js';
import { type Db, openDb } from '../src/db/index.js';
import { type Actor, type Ctx, KeyStore, type Role } from '../src/domain/core.js';
import { MemoryMailer } from '../src/domain/mail.js';
import { type EnrollInput, enroll } from '../src/domain/participants.js';
import { MemorySms } from '../src/domain/sms-provider.js';
import { createOrg, type OrgRow } from '../src/domain/orgs.js';
import { createStaff, loadActor } from '../src/domain/staff.js';
import { ManualClock } from '../src/lib/clock.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface TestCtx extends Ctx {
  clock: ManualClock;
  mailer: MemoryMailer;
  sms: MemorySms;
  close(): Promise<void>;
}

let counter = 0;

export async function makeCtx(): Promise<TestCtx> {
  const adminUrl = inject('pgAdminUrl');
  const template = inject('pgTemplate');
  const name = `hb_test_${process.pid}_${Date.now()}_${counter++}_${randomBytes(3).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  await admin.end();
  const url = adminUrl.replace(/\/postgres(\?|$)/, `/${name}$1`);
  const db: Db = openDb(url, 5);
  const clock = new ManualClock();
  const config = loadConfig({ env: 'test', databaseUrl: url, publicUrl: 'https://heartbeat.test', masterKey: randomBytes(32), secret: 'test-secret', workers: false, verifyWebhooks: false });
  const mailer = new MemoryMailer();
  const sms = new MemorySms();
  const keys = new KeyStore(db, config.masterKey, clock);
  return {
    db, keysDb: db, config, clock, mailer, sms, keys,
    async close() {
      await db.close();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
      await a.end();
    },
  };
}

export const PASSWORD = 'correct horse battery staple';

export interface Host {
  org: OrgRow;
  lead: Actor;
  coordinator: Actor;
  deputy: Actor;
  responderA: Actor;
  responderB: Actor;
  responderC: Actor;
  recorder: Actor;
  enroller: Actor;
}

async function staff(ctx: Ctx, orgId: string, name: string, roles: Role[]): Promise<Actor> {
  const s = await createStaff(ctx, null, { orgId, email: `${name.toLowerCase().replace(/\W+/g, '.')}.${orgId.slice(0, 6)}@example.org`, displayName: name, password: PASSWORD, roles });
  await ctx.db.query('INSERT INTO staff_training (staff_id, module, completed_at, recorded_by) SELECT $1, m, $2, $1 FROM generate_series(1,10) m', [s.id, new Date(ctx.clock.now())]);
  return (await loadActor(ctx.db, s.id, null))!;
}

/** A live host with a full team, all trained. Hours: Mon–Fri 08:00–17:00 America/New_York. */
export async function makeHost(ctx: Ctx, name = 'Test Day Center', opts: { live?: boolean } = {}): Promise<Host> {
  const org = await createOrg(ctx, null, { name, kind: 'host', publicPhone: '+18285550100' });
  const lead = await staff(ctx, org.id, `${name} Lead`, ['program_lead', 'coordinator']);
  const coordinator = await staff(ctx, org.id, `${name} Coordinator`, ['coordinator', 'responder', 'enroller']);
  const deputy = await staff(ctx, org.id, `${name} Deputy`, ['coordinator', 'responder']);
  const responderA = await staff(ctx, org.id, `${name} Responder A`, ['responder', 'enroller']);
  const responderB = await staff(ctx, org.id, `${name} Responder B`, ['responder']);
  const responderC = await staff(ctx, org.id, `${name} Responder C`, ['responder']);
  const recorder = await staff(ctx, org.id, `${name} Front Desk`, ['recorder']);
  const enroller = await staff(ctx, org.id, `${name} Enroller`, ['enroller']);
  await ctx.db.query(`UPDATE organizations SET coordinator_id = $2, deputy_id = $3, program_lead_id = $4, status = $5, sms_number = $6 WHERE id = $1`,
    [org.id, coordinator.staffId, deputy.staffId, lead.staffId, opts.live === false ? 'setup' : 'live', `+1828555${String(1000 + Math.floor(Math.random() * 9000))}`]);
  const fresh = (await ctx.db.query<OrgRow>('SELECT * FROM organizations WHERE id = $1', [org.id])).rows[0]!;
  const reload = async (a: Actor) => (await loadActor(ctx.db, a.staffId, null))!;
  return {
    org: fresh, lead: await reload(lead), coordinator: await reload(coordinator), deputy: await reload(deputy), responderA: await reload(responderA),
    responderB: await reload(responderB), responderC: await reload(responderC), recorder: await reload(recorder), enroller: await reload(enroller),
  };
}

export function enrollInput(over: Partial<EnrollInput> = {}): EnrollInput {
  return {
    preferredName: `Laura ${randomBytes(2).toString('hex')}`,
    verificationAnswer: 'blue river',
    adultConfirmed: true,
    privateConversation: true,
    teachBack: true,
    consent: { relays: true, sms: false, keypad: false, continuitySharing: false, photo: false, selfView: false },
    plan: { intervalDays: 7 },
    confirmDifferentPerson: true,
    ...over,
  };
}

export async function enrollWith(ctx: Ctx, host: Host, over: Partial<EnrollInput> = {}) {
  return enroll(ctx, host.enroller, {
    primaryResponderId: host.responderA.staffId,
    backupResponderId: host.responderB.staffId,
    ...enrollInput(over),
  });
}

/** Moves the clock forward and runs every scheduled job, as the worker would. */
export async function runJobs(ctx: Ctx, orgId: string): Promise<void> {
  const { runDetector } = await import('../src/domain/detector.js');
  const { tickCases } = await import('../src/domain/cases.js');
  await runDetector(ctx, orgId);
  await tickCases(ctx, orgId);
}

export function at(iso: string): number {
  return Date.parse(iso);
}

export { POLICY };
