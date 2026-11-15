import type { FastifyInstance, FastifyRequest } from 'fastify';
import { many } from '../../db/index.js';
import { disableStaff, enableStaff, legalHolds, purgeTrainingParticipants, setReportingNumbers } from '../../domain/admin.js';
import { activateByHost, endEvent, eventsFor } from '../../domain/continuity.js';
import { type Role, fail, requireRole } from '../../domain/core.js';
import { accessReviewReport, capacity, deidentifiedMetrics, signAccessReview } from '../../domain/metrics.js';
import { READINESS_ITEMS, type ReadinessKey, listOrgs, readiness, recordReadiness, setEnrollmentPaused, setHolidays, updateOrgSettings } from '../../domain/orgs.js';
import { ALL_ROLES, MODULE_TITLES, ROLE_MODULES, createStaff, listStaff, recordTraining, resetCredentials, setAvailability, setRoles, trainingOf } from '../../domain/staff.js';
import { html } from '../../lib/html.js';
import { type RouteDeps, actorOf, body, bodyAll, query } from '../app.js';
import { checked, csrfField, flash, fmtDate, options, postButton, render } from '../ui.js';

const ROLE_LABEL: Record<Role, string> = {
  recorder: 'Contact recorder', enroller: 'Enrollment worker', responder: 'Responder', coordinator: 'Coordinator', program_lead: 'Program lead',
  relay: 'Relay user', steward: 'Continuity steward', operator: 'OMH operator', evaluator: 'Evaluator',
};

export async function adminRoutes(app: FastifyInstance, { ctx }: RouteDeps) {
  const lead = (req: FastifyRequest) => {
    const a = actorOf(req);
    requireRole(a, 'program_lead');
    return a;
  };

  app.get('/admin', async (req, reply) => {
    const a = lead(req);
    const org = req.org!;
    const staff = await listStaff(ctx.db, org.id);
    const ready = await readiness(ctx.db, org.id);
    const holds = await legalHolds(ctx, a);
    const events = await eventsFor(ctx, a);
    const partners = (await listOrgs(ctx.db)).filter((o) => o.id !== org.id && o.kind !== 'operator');
    const holidays = await many<{ day: string; label: string | null }>(ctx.db, "SELECT to_char(day, 'YYYY-MM-DD') AS day, label FROM org_holidays WHERE org_id = $1 ORDER BY day", [org.id]);
    const trained = new Map(await Promise.all(staff.map(async (s) => [s.id, await trainingOf(ctx.db, s.id)] as const)));
    const cap = await capacity(ctx, org.id);
    const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return render(req, reply, {
      title: 'Admin',
      body: html`<h1>Program lead</h1>
<p><a href="/admin/access-review">Monthly access review</a> · <a href="/admin/metrics">De-identified measures</a></p>
<section class="card"><h2>Readiness ${org.status === 'live' ? '(live)' : '(setup: training data only)'}</h2>
<p>A host stays in training mode until every item is recorded and an OMH operator approves going live.</p><ul>${ready.map((r) => html`<li>${r.done ? '☑' : '☐'} ${r.label}${r.done ? html` — ${r.done.reference} (${fmtDate(r.done.completed_at, org.timezone, false)})` : ''}</li>`)}</ul>
<form method="post" action="/admin/readiness" class="row">${csrfField(req)}<select name="item">${options(READINESS_ITEMS.map((i) => [i.key, i.label]))}</select><input name="reference" required placeholder="Reference: document, date, who"><button class="btn" type="submit">Record</button></form>
${org.status === 'setup' ? postButton(req, '/admin/purge-training', 'Delete all training participants') : ''}</section>
<section class="card"><h2>Enrollment</h2>${org.enrollment_paused ? html`<p><strong>Paused:</strong> ${org.enrollment_pause_reason}</p>${postButton(req, '/admin/enrollment', 'Resume enrollment', { paused: '0' })}`
        : html`<form method="post" action="/admin/enrollment" class="row">${csrfField(req)}<input type="hidden" name="paused" value="1"><input name="reason" required placeholder="Reason for pausing"><button class="btn" type="submit">Pause new enrollment</button></form>`}
<p>Active participants ${cap.active}; cap rule ${cap.cap} at ${cap.committed} committed responder hours a week.</p></section>
<section class="card"><h2>Settings</h2><form method="post" action="/admin/settings" class="stack">${csrfField(req)}
<label>Name <input name="name" value="${org.name}"></label><label>Public phone (on cards) <input name="publicPhone" value="${org.public_phone ?? ''}"></label>
<div class="row"><label>Staffed from <input type="time" name="start" value="${fmtMin(org.day_start_min)}"></label><label>to <input type="time" name="end" value="${fmtMin(org.day_end_min)}"></label></div>
<fieldset><legend>Staffed days</legend>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => html`<label class="check"><input type="checkbox" name="days" value="${i + 1}"${checked(org.work_days.includes(i + 1))}> ${d}</label>`)}</fieldset>
<label>Coordinator <select name="coordinator"><option value="">—</option>${options(staff.filter((s) => s.roles.includes('coordinator')).map((s) => [s.id, s.display_name]), org.coordinator_id)}</select></label>
<label>Deputy coordinator <select name="deputy"><option value="">—</option>${options(staff.filter((s) => s.roles.includes('coordinator')).map((s) => [s.id, s.display_name]), org.deputy_id)}</select></label>
<label>Program lead <select name="programLead">${options(staff.filter((s) => s.roles.includes('program_lead')).map((s) => [s.id, s.display_name]), org.program_lead_id)}</select></label>
<label>Continuity partner <select name="partner"><option value="">—</option>${options(partners.map((p) => [p.id, p.name]), org.continuity_partner_id)}</select></label>
<label class="check"><input type="checkbox" name="photos" value="1"${checked(org.photos_enabled)}> Use optional participant photos (off by default; needs the participant's agreement)</label>
<button class="btn" type="submit">Save settings</button></form></section>
<section class="card"><h2>Who to call for required reports</h2><form method="post" action="/admin/reporting" class="stack">${csrfField(req)}
<label>Police non-emergency number <input name="police" value="${org.police_nonemergency_phone ?? ''}"></label>
<label>County adult protective services intake <input name="dssAdult" value="${org.dss_adult_phone ?? ''}"></label>
<label>County child protective services intake <input name="dssChild" value="${org.dss_child_phone ?? ''}"></label>
<label>Committed responder hours per week <input type="number" name="committed" value="${org.committed_hours}" min="0" max="400"></label><button class="btn" type="submit">Save</button></form></section>
<section class="card"><h2>Holidays</h2><form method="post" action="/admin/holidays" class="stack">${csrfField(req)}<label>One per line: YYYY-MM-DD label <textarea name="holidays" rows="6">${holidays.map((h) => `${h.day} ${h.label ?? ''}`.trim()).join('\n')}</textarea></label><button class="btn" type="submit">Save holidays</button></form></section>
<section class="card"><h2>Staff</h2><table><thead><tr><th>Name</th><th>Roles</th><th>Training</th><th>Away</th><th></th></tr></thead><tbody>${staff.map((s) => html`<tr class="${s.active ? '' : 'voided'}">
<td>${s.display_name}<br><small>${s.email}</small></td>
<td><form method="post" action="/admin/staff/${s.id}/roles" class="stack">${csrfField(req)}${ALL_ROLES.filter((r) => r !== 'operator').map((r) => html`<label class="check"><input type="checkbox" name="roles" value="${r}"${checked(s.roles.includes(r))}> ${ROLE_LABEL[r]}</label>`)}<button class="btn small" type="submit">Save roles</button></form></td>
<td><form method="post" action="/admin/staff/${s.id}/training" class="stack">${csrfField(req)}${Object.entries(MODULE_TITLES).map(([m, t]) => html`<label class="check"><input type="checkbox" name="modules" value="${m}"${checked(trained.get(s.id)?.has(Number(m)))}> ${m}. ${t}</label>`)}<button class="btn small" type="submit">Record completed</button></form>
<small>Needed: ${s.roles.map((r) => `${r} ${ROLE_MODULES[r].join(',')}`).join('; ')}</small></td>
<td><form method="post" action="/admin/staff/${s.id}/away" class="stack">${csrfField(req)}<input type="date" name="from" value="${s.out_from ?? ''}"><input type="date" name="to" value="${s.out_to ?? ''}"><button class="btn small" type="submit">Save</button></form></td>
<td>${s.active ? postButton(req, `/admin/staff/${s.id}/disable`, 'Disable', {}, 'btn small danger') : postButton(req, `/admin/staff/${s.id}/enable`, 'Enable', {}, 'btn small')}
<form method="post" action="/admin/staff/${s.id}/reset" class="stack">${csrfField(req)}<input name="temp" minlength="12" placeholder="Temporary password" required><button class="btn small" type="submit">Reset password and MFA</button></form></td></tr>`)}</tbody></table>
<form method="post" action="/admin/staff" class="card stack">${csrfField(req)}<h3>Add staff</h3><label>Name <input name="name" required></label><label>Work email <input name="email" type="email" required></label>
<label>Temporary password (12+ characters; they change it) <input name="password" minlength="12" required></label>
<fieldset><legend>Roles</legend>${ALL_ROLES.filter((r) => r !== 'operator').map((r) => html`<label class="check"><input type="checkbox" name="roles" value="${r}"> ${ROLE_LABEL[r]}</label>`)}</fieldset><button class="btn" type="submit">Add</button></form></section>
<section class="card"><h2>Continuity events</h2>${events.map((e) => html`<p>${e.host_name} → ${e.partner_name}: ${e.reason}. ${e.starts_at ? `${fmtDate(e.starts_at, org.timezone)} – ${fmtDate(e.ends_at, org.timezone)}` : 'requested'}${e.ended_at ? ' (ended)' : ''} ${!e.ended_at && e.starts_at ? postButton(req, `/admin/continuity/${e.id}/end`, 'End') : ''}</p>`)}
${org.continuity_partner_id ? html`<form method="post" action="/admin/continuity" class="row">${csrfField(req)}<input name="reason" required placeholder="Why the partner should step in"><button class="btn" type="submit">Activate continuity partner for 14 days</button></form>` : html`<p class="muted">Name a continuity partner in settings first.</p>`}</section>
<section class="card"><h2>Legal holds</h2>${holds.length ? html`<ul>${holds.map((h) => html`<li><a href="/participants/${h.id}">${h.code}</a>: ${h.legal_hold}</li>`)}</ul>` : html`<p class="muted">None.</p>`}</section>`,
    });
  });

  const go = (path: string, fn: (req: FastifyRequest) => Promise<unknown>, msg = 'Saved.') => {
    app.post(path, async (req, reply) => {
      await fn(req);
      flash(reply, 'ok', msg);
      return reply.redirect('/admin', 303);
    });
  };
  const toMin = (v: string | undefined) => {
    const m = /^(\d{2}):(\d{2})$/.exec(v ?? '');
    if (!m) fail('Enter times as HH:MM.');
    return Number(m![1]) * 60 + Number(m![2]);
  };
  go('/admin/readiness', (req) => recordReadiness(ctx, lead(req), req.org!.id, body(req).item as ReadinessKey, body(req).reference ?? ''));
  go('/admin/purge-training', (req) => purgeTrainingParticipants(ctx, lead(req), req.org!.id), 'Training participants deleted.');
  go('/admin/enrollment', (req) => setEnrollmentPaused(ctx, lead(req), body(req).paused === '1', body(req).reason || null));
  go('/admin/settings', (req) => {
    const b = body(req);
    return updateOrgSettings(ctx, lead(req), req.org!.id, {
      name: b.name, publicPhone: b.publicPhone || null, dayStartMin: toMin(b.start), dayEndMin: toMin(b.end), workDays: bodyAll(req, 'days').map(Number),
      coordinatorId: b.coordinator || null, deputyId: b.deputy || null, programLeadId: b.programLead || null, continuityPartnerId: b.partner || null, photosEnabled: b.photos === '1',
    });
  });
  go('/admin/reporting', (req) => setReportingNumbers(ctx, lead(req), { police: body(req).police || null, dssAdult: body(req).dssAdult || null, dssChild: body(req).dssChild || null, committedHours: Number(body(req).committed ?? 12) }));
  go('/admin/holidays', (req) => setHolidays(ctx, lead(req), req.org!.id, (body(req).holidays ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => ({ day: l.slice(0, 10), label: l.slice(11).trim() || undefined }))));
  go('/admin/staff', (req) => {
    const b = body(req);
    return createStaff(ctx, lead(req), { orgId: req.org!.id, email: b.email ?? '', displayName: b.name ?? '', password: b.password ?? '', roles: bodyAll(req, 'roles') as Role[] });
  }, 'Added. Give them the temporary password in person; they set up their authenticator at first sign-in.');
  const sid = (req: FastifyRequest) => (req.params as { id: string }).id;
  go('/admin/staff/:id/roles', (req) => setRoles(ctx, lead(req), sid(req), bodyAll(req, 'roles') as Role[]));
  go('/admin/staff/:id/training', (req) => recordTraining(ctx, lead(req), sid(req), bodyAll(req, 'modules').map(Number)));
  go('/admin/staff/:id/away', (req) => setAvailability(ctx, lead(req), sid(req), body(req).from || null, body(req).to || null));
  go('/admin/staff/:id/disable', (req) => disableStaff(ctx, lead(req), sid(req)), 'Disabled; their cases were moved.');
  go('/admin/staff/:id/enable', (req) => enableStaff(ctx, lead(req), sid(req)));
  go('/admin/staff/:id/reset', (req) => resetCredentials(ctx, lead(req), sid(req), body(req).temp ?? ''), 'Reset. They set up a new authenticator at next sign-in.');
  go('/admin/continuity', (req) => activateByHost(ctx, lead(req), body(req).reason ?? ''), 'Continuity partner activated for 14 days.');
  go('/admin/continuity/:id/end', (req) => endEvent(ctx, lead(req), sid(req)), 'Ended.');

  app.get('/admin/access-review', async (req, reply) => {
    const a = lead(req);
    const month = query(req).month ?? new Date(ctx.clock.now()).toISOString().slice(0, 7);
    const r = await accessReviewReport(ctx, a, month);
    const tz = req.org!.timezone;
    const list = (title: string, rows: { at: Date; name?: string | null; reason?: string | null; action?: string; search_terms?: string | null }[]) => html`<h2>${title} (${rows.length})</h2>${rows.length ? html`<ul>${rows.slice(0, 200).map((e) => html`<li>${fmtDate(e.at, tz)} — ${e.name ?? ''} ${e.action ?? ''} ${e.reason ? `— “${e.reason}”` : ''}${e.search_terms ? ` — searched “${e.search_terms}”` : ''}</li>`)}</ul>` : ''}`;
    return render(req, reply, {
      title: 'Access review',
      body: html`<h1>Access review ${month}</h1><form method="get" class="row"><input type="month" name="month" value="${month}"><button class="btn" type="submit">Show</button></form>
${list('Views with a typed reason', r.reasonViews)}${list('Views and searches outside staffed hours', r.afterHours)}${list('Prints and exports', r.prints)}
${list('Break-glass', r.breakglass)}${list('Failed relays', r.failedRelays)}${list('Verification lockouts', r.lockouts)}${list('Name searches with no result (possible fishing)', r.emptySearches)}
<h2>Unusually many views or searches</h2>${r.heavy.length ? html`<ul>${r.heavy.map((h) => html`<li>${h.name}: ${h.views} views, ${h.searches} searches</li>`)}</ul>` : html`<p>None.</p>`}
${r.signed ? html`<p>Signed off ${fmtDate(r.signed.signed_at, tz)}${r.signed.note ? `: ${r.signed.note}` : ''}.</p>` : ''}
<form method="post" action="/admin/access-review" class="row">${csrfField(req)}<input type="hidden" name="month" value="${month}"><input name="note" placeholder="Note (optional)"><button class="btn primary" type="submit">Sign off this month</button></form>`,
    });
  });
  app.post('/admin/access-review', async (req, reply) => {
    await signAccessReview(ctx, lead(req), body(req).month ?? '', body(req).note || null);
    flash(reply, 'ok', 'Signed off.');
    return reply.redirect(`/admin/access-review?month=${encodeURIComponent(body(req).month ?? '')}`, 303);
  });

  app.get('/admin/metrics', async (req, reply) => {
    const a = actorOf(req);
    const rows = await deidentifiedMetrics(ctx, a, 26);
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k !== 'week')))].sort();
    if (query(req).format === 'csv') {
      const csv = [['week', ...keys].join(','), ...rows.map((r) => [r.week, ...keys.map((k) => String((r as Record<string, unknown>)[k] ?? 0))].join(','))].join('\n');
      return reply.type('text/csv').header('Content-Disposition', 'attachment; filename="heartbeat-measures.csv"').send(csv);
    }
    return render(req, reply, {
      title: 'Measures',
      body: html`<h1>De-identified measures</h1><p>Week granularity; counts under 5 are shown as “&lt;5”. Check-in counts are context, not success (docs/09). <a href="/admin/metrics?format=csv">Download CSV</a></p>
<div class="scroll"><table><thead><tr><th>Week</th>${keys.map((k) => html`<th>${k.replace(/_/g, ' ')}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr><td>${r.week}</td>${keys.map((k) => html`<td>${String((r as Record<string, unknown>)[k] ?? 0)}</td>`)}</tr>`)}</tbody></table></div>`,
    });
  });
}
