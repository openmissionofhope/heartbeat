import type { FastifyInstance, FastifyRequest } from 'fastify';
import { many } from '../../db/index.js';
import { activeBreakglass, approveBreakglass, requestBreakglass } from '../../domain/admin.js';
import { approveByOperator, eventsFor } from '../../domain/continuity.js';
import { audit, fail, requireRole } from '../../domain/core.js';
import { detectorHealth, lastDetectorRun, orgCounts } from '../../domain/detector.js';
import { createOrg, goLive, listOrgs, readiness, setSmsNumber } from '../../domain/orgs.js';
import { getParticipantRow, summarize } from '../../domain/participants.js';
import { verifyAuditChain } from '../../domain/retention.js';
import { createStaff } from '../../domain/staff.js';
import { html } from '../../lib/html.js';
import { type RouteDeps, actorOf, body } from '../app.js';
import { PSTATE_LABEL, csrfField, flash, fmtDate, options, postButton, render } from '../ui.js';

/**
 * OMH operators run the service. They see organizations and counts, never participant data,
 * except through two-person break-glass access that the host is told about.
 */
export async function operatorRoutes(app: FastifyInstance, { ctx }: RouteDeps) {
  const op = (req: FastifyRequest) => {
    const a = actorOf(req);
    requireRole(a, 'operator');
    return a;
  };

  app.get('/operator', async (req, reply) => {
    const a = op(req);
    const orgs = await listOrgs(ctx.db);
    const health = await detectorHealth(ctx);
    const rows = await Promise.all(orgs.filter((o) => o.kind !== 'operator').map(async (o) => ({ o, counts: await orgCounts(ctx, o.id, ctx.clock.now() - 86_400_000), last: await lastDetectorRun(ctx, o.id), ready: await readiness(ctx.db, o.id) })));
    const requests = await many<{ id: string; org_id: string; name: string; requested_by: string; requester: string; ticket: string; reason: string; approved_by: string | null; expires_at: Date | null }>(ctx.db,
      'SELECT b.*, o.name, s.display_name AS requester FROM breakglass_requests b JOIN organizations o ON o.id = b.org_id JOIN staff s ON s.id = b.requested_by ORDER BY b.created_at DESC LIMIT 20');
    const events = (await eventsFor(ctx, a)).filter((e) => !e.approved_by && !e.ended_at);
    return render(req, reply, {
      title: 'Operator',
      body: html`<h1>OMH operator</h1><p>Detector health: ${health.ok ? 'all live hosts current' : html`<strong class="warn">${health.problems.join('; ')}</strong>`}. ${postButton(req, '/operator/verify-audit', 'Verify audit chain')}</p>
<table><thead><tr><th>Organization</th><th>Kind</th><th>Status</th><th>Readiness</th><th>Open / uncovered</th><th>Detector</th><th>Texting number</th><th></th></tr></thead><tbody>${rows.map(({ o, counts, last, ready }) => html`<tr>
<td>${o.name}</td><td>${o.kind}</td><td>${o.status}</td><td>${ready.filter((r) => r.done).length}/${ready.length}</td><td>${counts.open} / ${counts.uncovered}</td><td>${last ? fmtDate(last.at, o.timezone) : '—'}</td>
<td><form method="post" action="/operator/orgs/${o.id}/sms" class="row">${csrfField(req)}<input name="number" value="${o.sms_number ?? ''}" placeholder="+1…"><button class="btn small" type="submit">Set</button></form></td>
<td>${o.status === 'setup' ? postButton(req, `/operator/orgs/${o.id}/live`, 'Approve going live', {}, 'btn small') : ''}</td></tr>`)}</tbody></table>
<section class="card"><h2>Add an organization and its first program lead</h2><form method="post" action="/operator/orgs" class="stack">${csrfField(req)}
<label>Name <input name="name" required></label><label>Kind <select name="kind">${options([['host', 'Host (enrolls participants)'], ['partner', 'Partner (relays, continuity)']])}</select></label>
<label>Public phone <input name="phone"></label><label>Program lead name <input name="leadName" required></label><label>Program lead email <input name="leadEmail" type="email" required></label>
<label>Temporary password <input name="leadPassword" minlength="12" required></label><button class="btn" type="submit">Create</button></form></section>
<section class="card"><h2>Break-glass</h2><p>Only at the host's written request, with a second operator's approval. The host's program lead is notified. Access lasts 4 hours and every view is logged.</p>
<form method="post" action="/operator/breakglass" class="row">${csrfField(req)}<select name="orgId">${options(orgs.filter((o) => o.kind === 'host').map((o) => [o.id, o.name]))}</select><input name="ticket" required placeholder="Ticket"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Request</button></form>
<ul>${requests.map((r) => html`<li>${r.name}: ${r.ticket} — ${r.reason} (by ${r.requester}) ${r.approved_by ? `approved, expires ${fmtDate(r.expires_at, 'UTC')}` : r.requested_by !== a.staffId ? postButton(req, `/operator/breakglass/${r.id}/approve`, 'Approve (second operator)', {}, 'btn small') : 'awaiting a second operator'}
${r.approved_by && r.requested_by === a.staffId ? html` <a href="/operator/breakglass/${r.org_id}">open</a>` : ''}</li>`)}</ul></section>
<section class="card"><h2>Continuity requests</h2>${events.length ? html`<ul>${events.map((e) => html`<li>${e.partner_name} for ${e.host_name}: ${e.reason} ${postButton(req, `/operator/continuity/${e.id}/approve`, 'Approve (host silent 72 h)', {}, 'btn small')}</li>`)}</ul>` : html`<p class="muted">None.</p>`}</section>`,
    });
  });

  const go = (path: string, fn: (req: FastifyRequest) => Promise<unknown>, msg = 'Saved.') => {
    app.post(path, async (req, reply) => {
      await fn(req);
      flash(reply, 'ok', msg);
      return reply.redirect('/operator', 303);
    });
  };
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;
  go('/operator/orgs', async (req) => {
    const a = op(req);
    const b = body(req);
    const org = await createOrg(ctx, a, { name: b.name ?? '', kind: b.kind === 'partner' ? 'partner' : 'host', publicPhone: b.phone || undefined });
    const s = await createStaff(ctx, a, { orgId: org.id, email: b.leadEmail ?? '', displayName: b.leadName ?? '', password: b.leadPassword ?? '', roles: ['program_lead'] });
    await ctx.db.query('UPDATE organizations SET program_lead_id = $2 WHERE id = $1', [org.id, s.id]);
  }, 'Created. The organization starts in setup (training mode).');
  go('/operator/orgs/:id/sms', (req) => setSmsNumber(ctx, op(req), id(req), body(req).number || null));
  go('/operator/orgs/:id/live', (req) => goLive(ctx, op(req), id(req)), 'The organization is live.');
  go('/operator/breakglass', (req) => requestBreakglass(ctx, op(req), body(req).orgId ?? '', body(req).ticket ?? '', body(req).reason ?? ''), 'Requested. A second operator must approve.');
  go('/operator/breakglass/:id/approve', (req) => approveBreakglass(ctx, op(req), id(req)), 'Approved. The host was notified.');
  go('/operator/continuity/:id/approve', (req) => approveByOperator(ctx, op(req), id(req)), 'Continuity activated.');
  app.post('/operator/verify-audit', async (req, reply) => {
    op(req);
    const r = await verifyAuditChain(ctx);
    flash(reply, r.ok ? 'ok' : 'error', r.ok ? `Audit chain intact (${r.checked} events).` : `Audit chain broken at event ${r.brokenAt}.`);
    return reply.redirect('/operator', 303);
  });

  app.get('/operator/breakglass/:id', async (req, reply) => {
    const a = op(req);
    const orgId = id(req);
    if (!(await activeBreakglass(ctx, a, orgId))) fail('No approved break-glass access for this organization.', 403);
    const ids = await many<{ id: string }>(ctx.db, 'SELECT id FROM participants WHERE org_id = $1 ORDER BY created_at LIMIT 500', [orgId]);
    const rows = [];
    for (const r of ids) rows.push(await summarize(ctx, await getParticipantRow(ctx.db, r.id)));
    await ctx.db.tx((q) => audit(q, ctx, a, { action: 'breakglass.view', targetType: 'organization', targetId: orgId, details: { count: rows.length } }));
    return render(req, reply, { title: 'Break-glass', body: html`<h1>Break-glass view (read only, logged)</h1><table><tbody>${rows.map((s) => html`<tr><td>${s.code}</td><td>${s.name}</td><td>${PSTATE_LABEL[s.state]}</td></tr>`)}</tbody></table>` });
  });
}
