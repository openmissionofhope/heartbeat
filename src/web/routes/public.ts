import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recordContactInTx } from '../../domain/contacts.js';
import { fail, has } from '../../domain/core.js';
import { detectorHealth } from '../../domain/detector.js';
import { findByCode } from '../../domain/participants.js';
import { readSelfViewToken, selfViewData, selfViewLogin } from '../../domain/selfview.js';
import { formatParticipantCode } from '../../lib/codes.js';
import { html } from '../../lib/html.js';
import { type RouteDeps, actorOf, body } from '../app.js';
import { KIND_LABEL, csrfField, flash, fmtDate, render } from '../ui.js';

export async function publicRoutes(app: FastifyInstance, { ctx }: RouteDeps) {
  // For an external uptime monitor: fails if any live host's overdue detector is stale (HB-CLK-2).
  app.get('/healthz', async (_req, reply) => {
    try {
      await ctx.db.query('SELECT 1');
      const h = await detectorHealth(ctx);
      return reply.code(h.ok ? 200 : 503).send(h.ok ? 'ok' : 'detector stale');
    } catch {
      return reply.code(503).send('database unavailable');
    }
  });

  // -------------------------------------------------------------------------
  // Participant self-view (HB-P2-4)
  // -------------------------------------------------------------------------
  app.get('/me', async (req, reply) => {
    const id = readSelfViewToken(ctx, req.cookies.hb_me);
    if (!id) {
      return render(req, reply, {
        title: 'Your record',
        body: html`<h1>See your Heartbeat record</h1><p>You need your participant code, your verification answer, and the one-time code staff gave you. This page shows what is kept about you and who has looked at it. To change anything, talk to staff.</p>
<form method="post" action="/me" class="stack narrow">${csrfField(req)}<label>Participant code <input name="code" required autocomplete="off"></label><label>Verification answer <input name="answer" type="password" required autocomplete="off"></label>
<label>One-time code <input name="oneTime" required autocomplete="off"></label><button class="btn primary" type="submit">Show my record</button></form>
<p><strong>This is not emergency help. In an emergency, call 911.</strong></p>`,
      });
    }
    const d = await selfViewData(ctx, id);
    const tz = d.org.timezone;
    return render(req, reply, {
      title: 'Your record',
      body: html`<h1>Your Heartbeat record</h1><p>${d.org.name}. Call ${d.org.public_phone ?? 'the front desk'} to change anything, pause or stop.</p>
<dl><dt>Name we use</dt><dd>${d.summary.name}</dd><dt>Other names</dt><dd>${d.summary.otherNames.map((o) => o.name).join(', ') || '—'}</dd>
<dt>Code</dt><dd>${formatParticipantCode(d.summary.code)}</dd><dt>We expect to be in touch at least every</dt><dd>${d.plan.intervalDays} days</dd>
<dt>What counts</dt><dd>${d.plan.qualifyingKinds.map((k) => KIND_LABEL[k]).join(', ')}</dd><dt>Follow-up you agreed to</dt><dd>${d.plan.followup.join(', ')}</dd>
<dt>People we may ask</dt><dd>${d.plan.namedPeople.map((n) => n.name).join(', ') || 'Nobody'}</dd><dt>Last recorded contact</dt><dd>${fmtDate(d.summary.lastQualifyingAt, tz)}</dd>
<dt>Is someone following up right now?</dt><dd>${d.followUpOpen ? 'Yes — staff are trying to reach you in the ways you chose.' : 'No.'}</dd></dl>
<h2>Who has looked at or changed your record</h2><table><thead><tr><th>Day</th><th>Who</th><th>What</th><th>Times</th></tr></thead><tbody>${d.access.map((r) => html`<tr><td>${r.day}</td><td>${r.role_org}</td><td>${r.action}</td><td>${r.n}</td></tr>`)}</tbody></table>
<p>Names of individual staff are available if you ask the program lead.</p><form method="post" action="/me/out">${csrfField(req)}<button class="btn" type="submit">Done</button></form>`,
    });
  });
  app.post('/me', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = body(req);
    const token = await selfViewLogin(ctx, { code: b.code ?? '', answer: b.answer ?? '', oneTime: b.oneTime ?? '' });
    if (!token) {
      flash(reply, 'error', 'That did not match. Ask staff for a new one-time code. After several wrong answers, it locks for 24 hours.');
      return reply.redirect('/me', 303);
    }
    reply.setCookie('hb_me', token, { path: '/me', httpOnly: true, sameSite: 'strict', secure: ctx.config.secureCookies, maxAge: 600 });
    return reply.redirect('/me', 303);
  });
  app.post('/me/out', async (_req, reply) => {
    reply.clearCookie('hb_me', { path: '/me' });
    return reply.redirect('/me', 303);
  });

  // -------------------------------------------------------------------------
  // Offline recording (HB-P2-7). The page and its script are cached by a service worker; entries
  // hold only a participant code, kind, identity and time — no participant data is ever cached.
  // -------------------------------------------------------------------------
  const pub = (f: string) => fileURLToPath(new URL(`../../../public/${f}`, import.meta.url));
  app.get('/sw.js', async (_req, reply) => reply.type('text/javascript').header('Service-Worker-Allowed', '/').send(readFileSync(pub('js/sw.js'))));
  app.get('/offline', async (req, reply) => render(req, reply, {
    title: 'Offline recording',
    scripts: ['/static/js/offline.js'],
    body: html`<h1>Record contacts without a connection</h1>
<p>For outreach where there is no signal. Saved on this device, encrypted, until you are back online and signed in; then send them. Only the participant code is stored — no names. Entries older than 72 hours need a coordinator's approval.</p>
<form id="offline-form" class="stack narrow"><label>Participant code <input name="code" required autocomplete="off"></label>
<label>Kind <select name="kind"><option value="in_person">In person</option><option value="secondhand">Someone else saw them</option></select></label>
<label>How you know it was them <select name="confidence"><option value="known">I know them</option><option value="code_only">Code only</option><option value="reported">Secondhand</option></select></label>
<button class="btn primary" type="submit">Save on this device</button></form>
<p id="offline-status" role="status"></p><button class="btn" id="offline-sync" type="button">Send saved entries</button>
<input type="hidden" id="csrf" value="${req.csrf}">`,
  }));
  app.post('/offline/sync', async (req, reply) => {
    const a = actorOf(req);
    if (!has(a, 'recorder', 'enroller', 'responder', 'coordinator', 'program_lead')) fail('Not allowed.', 403);
    const entries = ((req.body ?? {}) as { entries?: { code: string; kind: string; confidence: string; occurredAt: number }[] }).entries ?? [];
    if (!Array.isArray(entries) || entries.length > 200) fail('Too many entries.');
    const results: { code: string; ok: boolean; error?: string }[] = [];
    for (const e of entries) {
      try {
        await ctx.db.tx(async (q) => {
          const p = await findByCode(q, String(e.code));
          if (!p || p.org_id !== a.orgId) fail('No participant here has that code.');
          await recordContactInTx(q, ctx, a, { participantId: p!.id, kind: e.kind as never, confidence: e.confidence as never, source: 'offline', occurredAt: Number(e.occurredAt) });
        });
        results.push({ code: e.code, ok: true });
      } catch (err) {
        results.push({ code: e.code, ok: false, error: (err as Error).message });
      }
    }
    return reply.send({ results });
  });
}
