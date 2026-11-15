import type { FastifyInstance } from 'fastify';
import { eventsFor, requestByPartner, stewardRecordContact, stewardRoster } from '../../domain/continuity.js';
import { has } from '../../domain/core.js';
import { listOrgs } from '../../domain/orgs.js';
import { recordRelay } from '../../domain/relay.js';
import { formatParticipantCode } from '../../lib/codes.js';
import { html } from '../../lib/html.js';
import { type RouteDeps, actorOf, body, query } from '../app.js';
import { csrfField, flash, fmtDate, options, render } from '../ui.js';

export async function partnerRoutes(app: FastifyInstance, { ctx }: RouteDeps) {
  // Relays (docs/07 §7.2): code + verification answer; the screen never reveals anything.
  app.get('/relay', async (req, reply) => render(req, reply, {
    title: 'Relay',
    body: html`<h1>Relay a contact to someone's host</h1>
<p>Use this only when the person asks you to, and with them here. They tell you their code and their verification answer. You will not see anything about them.</p>
<form method="post" action="/relay" class="stack narrow">${csrfField(req)}<label>Their code <input name="code" required autocomplete="off"></label>
<label>Their verification answer <input name="answer" required autocomplete="off"></label>
<label>A message from them for their host (optional, 140 characters; it will be shared — don't include where they are staying) <input name="message" maxlength="140"></label>
<button class="btn primary" type="submit">Send relay</button></form>`,
  }));
  app.post('/relay', async (req, reply) => {
    const b = body(req);
    const receipt = await recordRelay(ctx, actorOf(req), { code: b.code ?? '', answer: b.answer ?? '', message: b.message || null });
    flash(reply, 'ok', receipt);
    return reply.redirect('/relay', 303);
  });

  // Continuity stewards (docs/07 §7.4).
  app.get('/continuity', async (req, reply) => {
    const a = actorOf(req);
    const events = await eventsFor(ctx, a);
    const hosts = (await listOrgs(ctx.db)).filter((o) => o.continuity_partner_id === a.orgId);
    const hostId = query(req).host;
    const roster = hostId && has(a, 'steward') ? await stewardRoster(ctx, a, hostId) : null;
    return render(req, reply, {
      title: 'Continuity',
      body: html`<h1>Continuity</h1>
${hosts.length ? html`<p>You are the continuity partner for: ${hosts.map((h) => html`<a href="/continuity?host=${h.id}">${h.name}</a> `)}</p>
<form method="post" action="/continuity/request" class="row">${csrfField(req)}<select name="host">${options(hosts.map((h) => [h.id, h.name]))}</select><input name="reason" required placeholder="Why (host unreachable, disaster)"><button class="btn" type="submit">Ask to activate</button></form>
<p class="muted">If the host's program lead cannot be reached and no host staff have signed in for 72 hours, an OMH operator can approve.</p>` : html`<p class="muted">No host has named your organization as its continuity partner.</p>`}
<h2>Events</h2><ul>${events.map((e) => html`<li>${e.host_name} → ${e.partner_name}: ${e.reason}. ${e.starts_at ? `${fmtDate(e.starts_at, 'America/New_York')} – ${fmtDate(e.ends_at, 'America/New_York')}` : 'requested, not active'}${e.ended_at ? ' (ended)' : ''}</li>`)}</ul>
${roster ? html`<h2>Continuity sheet (${roster.length}) — only people who agreed to continuity sharing</h2><table><thead><tr><th>Code</th><th>Name</th><th>Last contact</th><th>Priority</th><th>Usually found</th><th>People who may be asked</th><th>Record</th></tr></thead><tbody>
${roster.map((r) => html`<tr><td>${formatParticipantCode(r.code)}</td><td>${r.name}</td><td>${fmtDate(r.lastContact, 'America/New_York', false)}</td><td>${r.disasterPriority ? 'yes' : ''}</td><td>${r.usuallyFound ?? ''}</td>
<td>${r.namedPeople.map((n) => `${n.name} ${n.phone}: “${n.message}”`).join('; ')}</td>
<td><form method="post" action="/continuity/record" class="stack">${csrfField(req)}<input type="hidden" name="host" value="${hostId}"><input type="hidden" name="participantId" value="${r.id}">
<select name="kind">${options([['in_person', 'Seen in person'], ['phone_with_staff', 'Phone call'], ['secondhand', 'Someone else saw them']])}</select>
<select name="confidence">${options([['known', 'I know them'], ['verified', 'Verification answer'], ['stated', 'Said who they were'], ['reported', 'Secondhand']])}</select>
<input name="note" maxlength="200" placeholder="Secondhand note (never where)"><button class="btn small" type="submit">Save</button></form></td></tr>`)}</tbody></table>` : ''}`,
    });
  });
  app.post('/continuity/request', async (req, reply) => {
    await requestByPartner(ctx, actorOf(req), body(req).host ?? '', body(req).reason ?? '');
    flash(reply, 'ok', 'Requested. The host and OMH have been told.');
    return reply.redirect('/continuity', 303);
  });
  app.post('/continuity/record', async (req, reply) => {
    const b = body(req);
    const conf = b.kind === 'secondhand' ? 'reported' : (b.confidence === 'reported' ? 'stated' : b.confidence);
    await stewardRecordContact(ctx, actorOf(req), b.host ?? '', b.participantId ?? '', b.kind as never, conf as never, b.note || null);
    flash(reply, 'ok', 'Saved. The host will see it.');
    return reply.redirect(`/continuity?host=${encodeURIComponent(b.host ?? '')}`, 303);
  });
}
