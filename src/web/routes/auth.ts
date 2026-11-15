import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { flash, render, csrfField, checked } from '../ui.js';
import { type RouteDeps, SESSION_COOKIE, actorOf, body } from '../app.js';
import { html, raw } from '../../lib/html.js';
import { beginMfaSetup, changePassword, finishMfaSetup, getStaff, signIn, signOut, verifyMfa, loadSession, setAvailability, setNotifySms } from '../../domain/staff.js';
import { logHours } from '../../domain/metrics.js';
import { fail } from '../../domain/core.js';

export async function authRoutes(app: FastifyInstance, { ctx }: RouteDeps) {
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: ctx.config.secureCookies };

  app.get('/login', async (req, reply) => render(req, reply, {
    title: 'Sign in',
    body: html`<h1>Sign in to Heartbeat</h1>
<form method="post" action="/login" class="stack narrow">${csrfField(req)}
<label>Work email <input name="email" type="email" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<label class="check"><input type="checkbox" name="shared" value="1"> This is a shared device (sign me out after 15 minutes idle)</label>
<button class="btn primary" type="submit">Continue</button></form>
<p class="muted">Participants: to see your own record, use <a href="/me">this page</a> with the code staff gave you.</p>`,
  }));

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = body(req);
    const r = await signIn(ctx, b.email ?? '', b.password ?? '', b.shared === '1');
    if (!r) {
      flash(reply, 'error', 'That email and password did not match, or the account is locked for 15 minutes after repeated attempts.');
      return reply.redirect('/login', 303);
    }
    reply.setCookie(SESSION_COOKIE, r.token, cookieOpts);
    return reply.redirect(r.needsMfaSetup ? '/mfa/setup' : '/mfa', 303);
  });

  app.post('/logout', async (req, reply) => {
    if (req.sessionHash) await signOut(ctx, req.sessionHash);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/login', 303);
  });

  app.get('/mfa', async (req, reply) => {
    if (!req.actor) return reply.redirect('/login', 303);
    if (req.mfaOk) return reply.redirect('/', 303);
    const s = await getStaff(ctx.db, req.actor.staffId);
    if (!s?.totp_enabled) return reply.redirect('/mfa/setup', 303);
    return render(req, reply, {
      title: 'Verification code',
      body: html`<h1>Enter your verification code</h1><form method="post" action="/mfa" class="stack narrow">${csrfField(req)}
<label>6-digit code from your authenticator app, or a recovery code <input name="code" autocomplete="one-time-code" required></label>
<button class="btn primary" type="submit">Sign in</button></form>`,
    });
  });

  app.post('/mfa', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const session = await loadSession(ctx, req.cookies[SESSION_COOKIE]);
    if (!session) return reply.redirect('/login', 303);
    if (!(await verifyMfa(ctx, session, body(req).code ?? ''))) {
      flash(reply, 'error', 'That code did not match.');
      return reply.redirect('/mfa', 303);
    }
    return reply.redirect('/', 303);
  });

  app.get('/mfa/setup', async (req, reply) => {
    if (!req.actor) return reply.redirect('/login', 303);
    const s = await getStaff(ctx.db, req.actor.staffId);
    if (s?.totp_enabled) return reply.redirect(req.mfaOk ? '/' : '/mfa', 303);
    const { secret } = await beginMfaSetup(ctx, req.actor.staffId);
    const uri = `otpauth://totp/${encodeURIComponent(`Heartbeat:${s!.email}`)}?secret=${secret}&issuer=Heartbeat`;
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 220 });
    return render(req, reply, {
      title: 'Set up sign-in verification',
      body: html`<h1>Set up your authenticator</h1>
<p>Every Heartbeat account needs a second step at sign-in. Scan this with an authenticator app (or type the key), then enter the 6-digit code it shows.</p>
<div class="qr">${raw(svg)}</div><p>Key: <code>${secret.match(/.{4}/g)!.join(' ')}</code></p>
<form method="post" action="/mfa/setup" class="stack narrow">${csrfField(req)}<label>6-digit code <input name="code" autocomplete="one-time-code" required></label>
<button class="btn primary" type="submit">Turn on</button></form>`,
    });
  });

  app.post('/mfa/setup', async (req, reply) => {
    const session = await loadSession(ctx, req.cookies[SESSION_COOKIE]);
    if (!session) return reply.redirect('/login', 303);
    const codes = await finishMfaSetup(ctx, session, body(req).code ?? '');
    return render(req, reply, {
      title: 'Recovery codes',
      body: html`<h1>Save your recovery codes</h1><p>Each code works once if you lose your phone. Keep them on paper with the continuity kit or somewhere only you can reach. They will not be shown again.</p>
<ul class="codes">${codes.map((c) => html`<li><code>${c}</code></li>`)}</ul><p><a class="btn primary" href="/">Continue</a></p>`,
    });
  });

  app.get('/account', async (req, reply) => {
    const a = actorOf(req);
    const s = (await getStaff(ctx.db, a.staffId))!;
    return render(req, reply, {
      title: 'Account',
      body: html`<h1>Your account</h1><p>${s.display_name} · ${s.email} · roles in effect: ${[...a.roles].join(', ') || 'none (training not yet recorded)'}</p>
<section><h2>Away from work</h2><p class="muted">Offers skip you while you are away.</p>
<form method="post" action="/account/away" class="row">${csrfField(req)}<label>First day <input type="date" name="from" value="${s.out_from ?? ''}"></label><label>Last day <input type="date" name="to" value="${s.out_to ?? ''}"></label><button class="btn" type="submit">Save</button></form></section>
<section><h2>Notifications</h2><p class="muted">Email always. Texts to your work phone are optional; they contain no participant details.</p>
<form method="post" action="/account/notify" class="row">${csrfField(req)}<label class="check"><input type="checkbox" name="sms" value="1"${checked(s.notify_sms)}> Also text me</label><label>Work phone <input name="phone" value="${s.work_phone ?? ''}"></label><button class="btn" type="submit">Save</button></form></section>
<section><h2>Heartbeat hours this week</h2><form method="post" action="/account/hours" class="row">${csrfField(req)}<label>Week of <input type="date" name="week" required></label><label>Hours <input type="number" name="hours" step="0.5" min="0" max="80" required></label><button class="btn" type="submit">Log</button></form></section>
<section><h2>Password</h2><form method="post" action="/account/password" class="stack narrow">${csrfField(req)}<label>Current <input type="password" name="current" required></label><label>New (12+ characters) <input type="password" name="next" required minlength="12"></label><button class="btn" type="submit">Change password</button></form></section>`,
    });
  });

  app.post('/account/away', async (req, reply) => {
    const b = body(req);
    await setAvailability(ctx, actorOf(req), actorOf(req).staffId, b.from || null, b.to || null);
    flash(reply, 'ok', 'Saved.');
    return reply.redirect('/account', 303);
  });
  app.post('/account/notify', async (req, reply) => {
    const b = body(req);
    await setNotifySms(ctx, actorOf(req), b.sms === '1', b.phone || null);
    flash(reply, 'ok', 'Saved.');
    return reply.redirect('/account', 303);
  });
  app.post('/account/hours', async (req, reply) => {
    const b = body(req);
    await logHours(ctx, actorOf(req), b.week ?? '', Number(b.hours));
    flash(reply, 'ok', 'Hours logged.');
    return reply.redirect('/account', 303);
  });
  app.post('/account/password', async (req, reply) => {
    const b = body(req);
    if (!b.next) fail('Enter a new password.');
    await changePassword(ctx, actorOf(req), b.current ?? '', b.next ?? '');
    flash(reply, 'ok', 'Password changed. Other sessions were signed out.');
    return reply.redirect('/account', 303);
  });
}
