import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCaseFor } from '../src/domain/cases.js';
import { runDetector } from '../src/domain/detector.js';
import { getParticipantRow } from '../src/domain/participants.js';
import { twilioSignature } from '../src/domain/sms-provider.js';
import { totpAt } from '../src/lib/crypto.js';
import { buildApp } from '../src/web/app.js';
import { CLOSURE_LABEL, CONFIDENCE_LABEL, CSTATE_LABEL, FORBIDDEN_STATUS_WORDS, KIND_LABEL, PSTATE_LABEL, lastContactText } from '../src/web/ui.js';
import { DAY, HOUR, type Host, PASSWORD, type TestCtx, enrollWith, makeCtx, makeHost } from './helpers.js';

let ctx: TestCtx;
let host: Host;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await makeCtx();
  host = await makeHost(ctx);
  app = await buildApp(ctx);
});
afterEach(async () => {
  await app.close();
  await ctx.close();
});

class Browser {
  cookies = new Map<string, string>();
  csrf = '';
  constructor(private app: FastifyInstance) {}
  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private take(res: { cookies: { name: string; value: string }[]; body: string }) {
    for (const c of res.cookies) {
      if (c.value === '') this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const m = /name="_csrf" value="([^"]+)"/.exec(res.body);
    if (m) this.csrf = m[1]!;
  }
  async get(url: string) {
    const res = await this.app.inject({ method: 'GET', url, headers: { cookie: this.cookieHeader() } });
    this.take(res);
    return res;
  }
  async post(url: string, form: Record<string, string | string[]>, withCsrf = true) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) params.append(k, x);
    if (withCsrf) params.append('_csrf', this.csrf);
    const res = await this.app.inject({ method: 'POST', url, payload: params.toString(), headers: { cookie: this.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' } });
    this.take(res);
    return res;
  }
}

async function signIn(email: string): Promise<Browser> {
  const b = new Browser(app);
  await b.get('/login');
  const r = await b.post('/login', { email, password: PASSWORD });
  expect(r.headers.location).toBe('/mfa/setup');
  const setup = await b.get('/mfa/setup');
  const secret = /Key: <code>([A-Z2-7 ]+)<\/code>/.exec(setup.body)![1]!.replace(/ /g, '');
  const done = await b.post('/mfa/setup', { code: totpAt(secret, ctx.clock.now()) });
  expect(done.body).toContain('recovery codes');
  return b;
}

async function emailOf(id: string) {
  return (await ctx.db.query('SELECT email FROM staff WHERE id = $1', [id])).rows[0]!.email as string;
}

describe('web', () => {
  it('requires sign-in and MFA for everything except public paths', async () => {
    const b = new Browser(app);
    expect((await b.get('/')).headers.location).toBe('/login');
    expect((await b.get('/participants/new')).headers.location).toBe('/login');
    expect((await b.get('/healthz')).statusCode).toBe(503); // live host whose detector has not run yet
    await runDetector(ctx, host.org.id);
    expect((await b.get('/healthz')).statusCode).toBe(200);
    await b.get('/login');
    await b.post('/login', { email: await emailOf(host.recorder.staffId), password: PASSWORD });
    expect((await b.get('/')).headers.location).toBe('/mfa');
  });

  it('rejects state-changing requests without the CSRF token', async () => {
    const b = await signIn(await emailOf(host.coordinator.staffId));
    const r = await b.post('/hold/declare', { reason: 'test' }, false);
    expect(r.statusCode).toBe(403);
  });

  it('enrolls through the form, then a recorder records a contact in four steps', async () => {
    const e = await signIn(await emailOf(host.enroller.staffId));
    const page = await e.get('/participants/new');
    expect(page.body).toContain('not emergency help');
    const r = await e.post('/participants/new', {
      adult: '1', private: '1', teachBack: '1', preferredName: 'Rosa Web', verificationAnswer: 'river stone', intervalDays: '7',
      qk: ['in_person', 'phone_with_staff'], primary: host.responderA.staffId, backup: host.responderB.staffId,
    });
    expect(r.statusCode).toBe(303);
    const pid = r.headers.location!.split('/').pop()!;
    const p = await getParticipantRow(ctx.db, pid);
    const rec = await signIn(await emailOf(host.recorder.staffId));
    const found = await rec.get('/record?q=rosa');
    expect(found.body).toContain('Rosa Web');
    expect(found.body).not.toContain('Last recorded contact');
    await rec.post('/record', { participantId: pid, kind: 'in_person', confidence: 'known' });
    expect((await getParticipantRow(ctx.db, pid)).last_qualifying_at).not.toBeNull();
    expect(p.code).toHaveLength(9);
  });

  it('a responder accepts an overdue case through the page and closes it by recording contact', async () => {
    const p = await enrollWith(ctx, host);
    ctx.clock.advance(9 * DAY + HOUR);
    await runDetector(ctx, host.org.id);
    const c = (await openCaseFor(ctx.db, p.id))!;
    const b = await signIn(await emailOf(host.responderA.staffId));
    const home = await b.get('/');
    expect(home.body).toContain(`/cases/${c.id}`);
    const view = await b.get(`/cases/${c.id}`);
    expect(view.body).toContain('I am responsible for this follow-up.');
    await b.post(`/cases/${c.id}/accept`, { statement: 'I am responsible for this follow-up.' });
    await b.get(`/cases/${c.id}`);
    await b.post(`/cases/${c.id}/action`, { action: 'checked_records', source: 'host_staff', result: 'contact_restored', certainty: 'high', ckind: 'in_person', cconf: 'known' });
    expect((await openCaseFor(ctx.db, p.id))).toBeNull();
  });

  it('accepts signed Twilio webhooks and rejects unsigned ones when verification is on', async () => {
    ctx.config.verifyWebhooks = true;
    const token = 'tok';
    (ctx.sms as { verifyWebhook: (u: string, p: Record<string, string>, s?: string) => boolean }).verifyWebhook = (url, params, sig) => sig === twilioSignature(token, url, params);
    const params = { From: '+18285550000', To: host.org.sms_number!, Body: 'HELP', MessageSid: 'SM9' };
    const payload = new URLSearchParams(params).toString();
    const bad = await app.inject({ method: 'POST', url: '/hooks/sms', payload, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(bad.statusCode).toBe(403);
    const sig = twilioSignature(token, `${ctx.config.publicUrl}/hooks/sms`, params);
    const ok = await app.inject({ method: 'POST', url: '/hooks/sms', payload, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('not emergency help');
  });

  it('pages never put participant names in URLs', async () => {
    const p = await enrollWith(ctx, host, { preferredName: 'Zelda Unique' });
    const b = await signIn(await emailOf(host.coordinator.staffId));
    const page = await b.get(`/participants/${p.id}`);
    const hrefs = [...page.body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.some((h) => h.includes('Zelda'))).toBe(false);
  });
});

describe('language guardrails (HB-UI-1)', () => {
  it('status and contact labels never say safe, OK, fine, alive, accounted for or all clear', () => {
    const labels = [...Object.values(KIND_LABEL), ...Object.values(CONFIDENCE_LABEL), ...Object.values(PSTATE_LABEL), ...Object.values(CSTATE_LABEL), ...Object.values(CLOSURE_LABEL)];
    for (const k of Object.keys(KIND_LABEL)) for (const c of Object.keys(CONFIDENCE_LABEL)) labels.push(lastContactText(new Date(), k, c, 'UTC'));
    for (const l of labels) for (const w of FORBIDDEN_STATUS_WORDS) expect(l).not.toMatch(w);
  });

  it('no template describes a participant as safe or gives an all-clear', () => {
    const files = [...readdirSync('src/web/routes').map((f) => join('src/web/routes', f)), 'src/domain/sms.ts', 'src/domain/notifications.ts'];
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/all clear|accounted for|verified safe|is safe\b|are safe\b|status: ?ok|\bis OK\b|\bare OK\b/i);
    }
  });
});

describe('every page renders for the roles that use it', () => {
  it('has no server errors across the main pages', async () => {
    const { createOrg } = await import('../src/domain/orgs.js');
    const { createStaff } = await import('../src/domain/staff.js');
    const { declareHold } = await import('../src/domain/detector.js');
    const p = await enrollWith(ctx, host, { consent: { relays: true, sms: true, keypad: true, continuitySharing: true, photo: true, selfView: true }, keypadPin: '1234',
      plan: { intervalDays: 7, phone: '8285550111', phoneCall: true, phoneText: true, followup: ['records', 'phone'], smsCheckins: true, continuitySharing: true } });
    ctx.clock.advance(9 * DAY + HOUR);
    await runDetector(ctx, host.org.id);
    const c = (await openCaseFor(ctx.db, p.id))!;
    const opOrg = await createOrg(ctx, null, { name: 'Open Mission of Hope', kind: 'operator' });
    await createStaff(ctx, null, { orgId: opOrg.id, email: 'op@omh.example', displayName: 'Op', password: PASSWORD, roles: ['operator'] });
    const partner = await createOrg(ctx, null, { name: 'Partner', kind: 'partner' });
    await createStaff(ctx, null, { orgId: partner.id, email: 'relay@p.example', displayName: 'Relay', password: PASSWORD, roles: ['relay', 'steward'] });
    const pages: [string, string[]][] = [
      [await emailOf(host.lead.staffId), ['/', '/record?q=laura', '/participants?q=laura', '/participants/new', `/participants/${p.id}`, `/participants/${p.id}/plan`, `/cases/${c.id}`,
        `/participants/${p.id}/print/card`, `/participants/${p.id}/print/card?lang=es`, `/participants/${p.id}/print/summary?lang=es`, `/participants/${p.id}/print/access`,
        '/print/continuity', '/print/forms', '/safeguarding', '/hold', '/transfers', '/admin', '/admin/access-review', '/admin/metrics', '/admin/metrics?format=csv', '/account', '/continuity']],
      [await emailOf(host.recorder.staffId), ['/', '/record?q=laura', '/safeguarding', '/offline']],
      [await emailOf(host.responderA.staffId), ['/', `/cases/${c.id}`]],
      ['op@omh.example', ['/operator']],
      ['relay@p.example', ['/relay', '/continuity']],
    ];
    for (const [email, urls] of pages) {
      const b = await signIn(email);
      for (const u of urls) {
        const r = await b.get(u);
        expect(r.statusCode, `${email} ${u}: ${r.body.slice(0, 300)}`).toBeLessThan(500);
        expect(r.statusCode, `${email} ${u}`).not.toBe(404);
        if (r.headers['content-type']?.toString().includes('html')) expect(r.body, `${email} ${u}`).not.toMatch(/\bundefined\b|\[object Object\]|\bNaN\b/);
      }
    }
    await declareHold(ctx, host.coordinator, 'storm');
    const b = await signIn(await emailOf(host.coordinator.staffId));
    expect((await b.get('/hold')).statusCode).toBe(200);
    expect((await new Browser(app).get('/me')).statusCode).toBe(200);
  });
});
