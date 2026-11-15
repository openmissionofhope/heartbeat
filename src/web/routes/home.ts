import type { FastifyInstance } from 'fastify';
import { many } from '../../db/index.js';
import { pendingProposals, type CaseRow } from '../../domain/cases.js';
import { approveBackdated, pendingBackdated, recordContact } from '../../domain/contacts.js';
import { fail, has } from '../../domain/core.js';
import { confirmHold, declareHold, endHold, lastDetectorRun, openRollCallCases, rollCall, unreachedDuringHold } from '../../domain/detector.js';
import { capacity, pauseIndicators } from '../../domain/metrics.js';
import { deliveryFailures } from '../../domain/notifications.js';
import { getParticipantRow, searchParticipants, summarize } from '../../domain/participants.js';
import { CATEGORY_LABEL, NEVER_REPORT, RECIPIENT_LABEL, type ReportCategory, identifyRequiredReport, outstandingReports, recordReportMade } from '../../domain/safeguarding.js';
import { listStaff } from '../../domain/staff.js';
import { acceptTransfer, declineTransfer, incomingTransfers } from '../../domain/transfers.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { type RouteDeps, actorOf, body, bodyAll, query } from '../app.js';
import { CONFIDENCE_LABEL, CSTATE_LABEL, KIND_LABEL, ago, csrfField, flash, fmtDate, options, postButton, render } from '../ui.js';
import { consentFields, readConsent } from './participants.js';

export async function homeRoutes(app: FastifyInstance, { ctx }: RouteDeps) {
  app.get('/', async (req, reply) => {
    const a = actorOf(req);
    const org = req.org!;
    const now = ctx.clock.now();
    const sections: SafeHtml[] = [];
    if (org.kind === 'operator') return reply.redirect('/operator', 303);
    if (org.kind === 'partner') return reply.redirect(a.roles.has('relay') ? '/relay' : '/continuity', 303);
    if (has(a, 'recorder', 'enroller', 'responder', 'coordinator', 'program_lead')) {
      sections.push(html`<section class="card"><h2>Record a contact</h2><form method="get" action="/record" class="row"><label>Name or code <input name="q" autocomplete="off" required></label><button class="btn primary" type="submit">Find</button></form></section>`);
    }
    if (has(a, 'responder', 'coordinator', 'program_lead')) {
      const mine = await many<CaseRow & { code: string }>(ctx.db,
        `SELECT c.*, p.code FROM cases c JOIN participants p ON p.id = c.participant_id WHERE c.org_id = $1 AND c.state <> 'closed' AND (c.owner_id = $2 OR c.offeree_id = $2) ORDER BY c.opened_at`, [a.orgId, a.staffId]);
      sections.push(html`<section class="card"><h2>Your follow-up tasks</h2>${mine.length ? caseTable(mine, now, org.timezone) : html`<p class="muted">None right now.</p>`}</section>`);
    }
    if (has(a, 'coordinator', 'program_lead')) {
      const all = await many<CaseRow & { code: string; owner: string | null; offeree: string | null }>(ctx.db,
        `SELECT c.*, p.code, so.display_name AS owner, sf.display_name AS offeree FROM cases c JOIN participants p ON p.id = c.participant_id
           LEFT JOIN staff so ON so.id = c.owner_id LEFT JOIN staff sf ON sf.id = c.offeree_id
          WHERE c.org_id = $1 AND c.state <> 'closed'
          ORDER BY (c.state = 'uncovered') DESC, c.priority DESC, c.overdue_at ASC NULLS LAST, c.opened_at`, [a.orgId]);
      const last = await lastDetectorRun(ctx, org.id);
      const cap = await capacity(ctx, org.id);
      const indicators = await pauseIndicators(ctx, org.id);
      const backdated = await pendingBackdated(ctx.db, org.id);
      const proposals = await pendingProposals(ctx.db, org.id);
      const failures = await deliveryFailures(ctx.db, org.id, now - 7 * 86_400_000);
      sections.push(html`<section class="card"><h2>Queue</h2>
<p>Overdue detector: ${last ? html`${last.ok ? 'last completed' : html`<strong class="warn">FAILED</strong>`} ${fmtDate(last.at, org.timezone)}` : html`<strong class="warn">has not run</strong>`}.
 Open cases: ${all.length}. Uncovered: <strong>${all.filter((c) => c.state === 'uncovered').length}</strong>. Stalled: ${all.filter((c) => c.state === 'stalled').length}.</p>
${all.length ? caseTable(all, now, org.timezone, true) : html`<p class="muted">No open cases.</p>`}</section>
<section class="card"><h2>Capacity</h2><p>Active participants: ${cap.active}. Cap rule: ${cap.cap} (${cap.measured ? 'measured' : 'pessimistic assumptions until there are four weeks of data'}: r×h = ${(cap.r * cap.hPerCase).toFixed(2)} h per participant-week; committed ${cap.committed} h/week).</p>
<table><thead><tr><th>Responder</th><th>Open cases</th></tr></thead><tbody>${cap.perResponder.map((p) => html`<tr><td>${p.display_name}</td><td>${p.n}${p.n >= cap.responderCap ? ' (at cap)' : ''}</td></tr>`)}</tbody></table>
${indicators.length ? html`<h3 class="warn">Enrollment-pause indicators</h3><ul>${indicators.map((i) => html`<li>${i}</li>`)}</ul><p>The program lead decides whether to pause enrollment (docs/08 §8.5).</p>` : html`<p>No enrollment-pause indicators.</p>`}
${failures.length ? html`<p class="warn">Notification failures this week: ${failures.map((f) => html`${f.display_name} (${f.failures}) `)}</p>` : ''}</section>
${backdated.length ? html`<section class="card"><h2>Late entries to approve</h2><table><tbody>${backdated.map((b) => html`<tr><td>${KIND_LABEL[b.kind]}</td><td>happened ${fmtDate(b.occurred_at, org.timezone)}, entered ${fmtDate(b.recorded_at, org.timezone)}</td><td>
<form method="post" action="/contacts/${b.id}/approve" class="row">${csrfField(req)}<input name="reason" placeholder="Reason (e.g. paper form, outage)" required><button class="btn" type="submit">Approve</button></form></td></tr>`)}</tbody></table></section>` : ''}
${proposals.length ? html`<section class="card"><h2>Closures waiting for review or approval</h2><ul>${proposals.map((p) => html`<li><a href="/cases/${p.case_id}">${p.reason.replace(/_/g, ' ')}</a> proposed by ${p.proposer} ${ago(p.proposed_at, now)} ago${p.reviewed_by ? ' (second review done)' : ''}</li>`)}</ul></section>` : ''}`);
    }
    const reports = await outstandingReports(ctx, a).catch(() => []);
    if (reports.length) sections.unshift(html`<section class="card alert"><h2>Required reports not yet recorded as made</h2><p><a href="/safeguarding">Open required reports</a> (${reports.length}).</p></section>`);
    return render(req, reply, { title: 'Home', body: html`<h1>${org.name}</h1>${sections}` });
  });

  // -------------------------------------------------------------------------
  // Recording contact (HB-CON-1): four interactions, minimal view.
  // -------------------------------------------------------------------------
  app.get('/record', async (req, reply) => {
    const a = actorOf(req);
    const q = (query(req).q ?? '').trim();
    const hits = q ? await searchParticipants(ctx, a, q) : [];
    return render(req, reply, {
      title: 'Record contact',
      body: html`<h1>Record a contact</h1>
<form method="get" action="/record" class="row"><label>Name or code <input name="q" value="${q}" autocomplete="off" required></label><button class="btn" type="submit">Find</button></form>
${q && !hits.length ? html`<p>No match. Check the code on the person's card, or ask them which name they use with us.</p>` : ''}
${hits.map((h) => html`<form method="post" action="/record" class="card record">${csrfField(req)}<input type="hidden" name="participantId" value="${h.id}">
<p class="who"><strong>${h.name}</strong> <code>${h.code}</code>${h.otherNames.length ? html` <span class="muted">also: ${h.otherNames.join(', ')}</span>` : ''}${h.training ? html` <span class="tag">training</span>` : ''}</p>
<fieldset><legend>Kind of contact</legend>
<label class="check"><input type="radio" name="kind" value="in_person" required> In person</label>
<label class="check"><input type="radio" name="kind" value="phone_with_staff"> Phone call with me</label>
<label class="check"><input type="radio" name="kind" value="self_check_in"> Message they left</label>
<label class="check"><input type="radio" name="kind" value="secondhand"> Someone else saw or heard from them</label></fieldset>
<fieldset><legend>How do you know it was them?</legend>
<label class="check"><input type="radio" name="confidence" value="known" required> I know them</label>
<label class="check"><input type="radio" name="confidence" value="verified"> They gave their verification answer</label>
<label class="check"><input type="radio" name="confidence" value="code_only"> They showed their code only</label>
<label class="check"><input type="radio" name="confidence" value="stated"> They told me who they were</label>
<label class="check"><input type="radio" name="confidence" value="reported"> Secondhand report</label></fieldset>
<label>Verification answer (only if they give it to you) <input name="answer" autocomplete="off"></label>
<details><summary>Entering this late, or adding a note?</summary>
<label>When it happened <input type="datetime-local" name="occurredAt"></label>
<label>Note — secondhand reports and messages only, 200 characters, never where the person is <input name="note" maxlength="200"></label></details>
<button class="btn primary" type="submit">Save contact</button></form>`)}`,
    });
  });

  app.post('/record', async (req, reply) => {
    const a = actorOf(req);
    const b = body(req);
    let confidence = b.confidence as 'known' | 'verified' | 'code_only' | 'stated' | 'reported';
    if (b.answer) {
      const { checkVerification } = await import('../../domain/participants.js');
      const result = await ctx.db.tx(async (q) => {
        const p = await getParticipantRow(q, b.participantId ?? '');
        if (p.org_id !== a.orgId) fail('Participant not found.', 404);
        return checkVerification(q, ctx, p, b.answer ?? '', a);
      });
      if (result === 'ok') confidence = 'verified';
      else if (confidence === 'verified') confidence = 'stated';
      if (result === 'locked') flash(reply, 'error', 'Verification is locked for 24 hours after repeated wrong answers. The contact was saved without it.');
    } else if (confidence === 'verified') confidence = 'stated';
    const occurredAt = b.occurredAt ? zonedInput(b.occurredAt, req.org!.timezone) : undefined;
    const r = await recordContact(ctx, a, { participantId: b.participantId ?? '', kind: b.kind as never, confidence, source: 'staff', occurredAt, note: b.note || null });
    if (!req.cookies.hb_flash) flash(reply, 'ok', r.needsApproval ? 'Saved. Because it happened more than 72 hours ago, a coordinator will approve it.' : `Saved (${KIND_LABEL[b.kind ?? '']}, ${CONFIDENCE_LABEL[confidence]}).`);
    return reply.redirect('/record', 303);
  });

  app.post('/contacts/:id/approve', async (req, reply) => {
    await approveBackdated(ctx, actorOf(req), (req.params as { id: string }).id, body(req).reason ?? '');
    flash(reply, 'ok', 'Approved.');
    return reply.redirect('/', 303);
  });

  // -------------------------------------------------------------------------
  // Required abuse reports (OMH policy 2026-11-15)
  // -------------------------------------------------------------------------
  app.get('/safeguarding', async (req, reply) => {
    const a = actorOf(req);
    const org = req.org!;
    const open = await outstandingReports(ctx, a);
    return render(req, reply, {
      title: 'Required reports',
      body: html`<h1>Required reports</h1>
<div class="card alert"><p><strong>If anyone is in immediate danger, call 911 now.</strong></p>
<p>OMH policy: abuse or neglect of a child is reported to police and to county child protective services; abuse by an intimate partner is reported to police; a disabled adult who needs protective services is reported to county adult protective services. You make the call yourself. Heartbeat sends nothing to anyone; it only records that the report was made.</p>
<p><strong>${NEVER_REPORT}</strong></p></div>
<form method="post" action="/safeguarding" class="card stack">${csrfField(req)}<h2>I learned something that must be reported</h2>
<label>What <select name="category" required>${options(Object.entries(CATEGORY_LABEL) as [string, string][])}</select></label>
<label>Participant code, if it concerns a participant <input name="code" autocomplete="off"></label>
<button class="btn primary" type="submit">Show who to call</button></form>
<section><h2>Not yet recorded as made</h2>${open.length ? html`<table><thead><tr><th>Report</th><th>Call</th><th>Identified</th><th></th></tr></thead><tbody>${open.map((r) => html`<tr>
<td>${CATEGORY_LABEL[r.category]}</td><td>${RECIPIENT_LABEL[r.recipient]}<br><strong>${phoneFor(org, r.recipient) ?? 'number not set — ask the program lead'}</strong></td><td>${fmtDate(r.identified_at, org.timezone)} by ${r.display_name}</td>
<td><form method="post" action="/safeguarding/${r.id}/made" class="stack">${csrfField(req)}<label>Reference number (optional) <input name="reference" maxlength="80"></label><button class="btn" type="submit">I made this report</button></form></td></tr>`)}</tbody></table>` : html`<p class="muted">None.</p>`}</section>`,
    });
  });

  app.post('/safeguarding', async (req, reply) => {
    const a = actorOf(req);
    const b = body(req);
    let participantId: string | null = null;
    if (b.code) {
      const { findByCode } = await import('../../domain/participants.js');
      const p = await findByCode(ctx.db, b.code);
      if (!p || p.org_id !== a.orgId) fail('No participant here has that code. Leave it blank if unsure; the report still has to be made.');
      participantId = p!.id;
    }
    await identifyRequiredReport(ctx, a, { category: b.category as ReportCategory, participantId });
    flash(reply, 'ok', 'Make the call(s) listed below now, then record each one as made.');
    return reply.redirect('/safeguarding', 303);
  });

  app.post('/safeguarding/:id/made', async (req, reply) => {
    await recordReportMade(ctx, actorOf(req), (req.params as { id: string }).id, { reference: body(req).reference || null });
    flash(reply, 'ok', 'Recorded as made.');
    return reply.redirect('/safeguarding', 303);
  });

  // -------------------------------------------------------------------------
  // Escalation hold and roll call (HB-DR-3)
  // -------------------------------------------------------------------------
  app.get('/hold', async (req, reply) => {
    const a = actorOf(req);
    const org = req.org!;
    const list = org.hold_active ? await rollCall(ctx, a) : [];
    const unreached = org.hold_active ? new Set(await unreachedDuringHold(ctx, org.id)) : new Set<string>();
    const responders = (await listStaff(ctx.db, org.id)).filter((s) => s.active && (s.roles.includes('responder') || s.roles.includes('coordinator')));
    return render(req, reply, {
      title: 'Escalation hold and roll call',
      body: html`<h1>Escalation hold and roll call</h1>
<p>For disasters and outages, not for workload. While the hold is on, no individual overdue cases open; work the roll call instead, then end the hold.</p>
${org.hold_active ? html`<p><strong>Hold is on</strong> since ${fmtDate(org.hold_started_at, org.timezone)}: ${org.hold_reason}. Last confirmed ${fmtDate(org.hold_confirmed_at, org.timezone)}.</p>
${postButton(req, '/hold/confirm', 'Confirm the hold continues today')} ${postButton(req, '/hold/end', 'End the hold')}
<p><a href="/print/continuity">Print the continuity sheet</a> · <a href="/print/forms">Print paper forms</a></p>
<form method="post" action="/hold/rollcall">${csrfField(req)}<h2>Roll call (${list.length})</h2>
<table><thead><tr><th></th><th>Code</th><th>Disaster priority</th><th>Last recorded contact</th><th>Status</th></tr></thead><tbody>${list.map((r) => html`<tr>
<td>${unreached.has(r.id) ? html`<input type="checkbox" name="ids" value="${r.id}" aria-label="Select ${r.code}">` : ''}</td><td><a href="/participants/${r.id}">${r.code}</a></td><td>${r.disasterPriority ? 'yes' : ''}</td>
<td>${fmtDate(r.lastContact, org.timezone)}</td><td>${r.hasOpenCase ? 'case open' : r.contactedSinceHold ? 'contact since hold' : html`<strong>not reached</strong>`}</td></tr>`)}</tbody></table>
<label>Assign selected to <select name="assignTo"><option value="">Normal offer chain</option>${options(responders.map((s) => [s.id, s.display_name]))}</select></label>
<button class="btn" type="submit">Open roll-call cases for selected</button></form>`
        : html`<form method="post" action="/hold/declare" class="stack narrow">${csrfField(req)}<label>Reason <input name="reason" required maxlength="300" placeholder="e.g. flooding; day center closed"></label><button class="btn danger" type="submit">Declare escalation hold</button></form>
<p><a href="/print/continuity">Print the continuity sheet</a> · <a href="/print/forms">Print paper forms</a></p>`}`,
    });
  });
  app.post('/hold/declare', async (req, reply) => {
    await declareHold(ctx, actorOf(req), body(req).reason ?? '');
    return reply.redirect('/hold', 303);
  });
  app.post('/hold/confirm', async (req, reply) => {
    await confirmHold(ctx, actorOf(req));
    flash(reply, 'ok', 'Hold confirmed for today.');
    return reply.redirect('/hold', 303);
  });
  app.post('/hold/end', async (req, reply) => {
    await endHold(ctx, actorOf(req));
    flash(reply, 'ok', 'Hold ended. Everyone reached during the hold has the return window before an overdue case opens.');
    return reply.redirect('/hold', 303);
  });
  app.post('/hold/rollcall', async (req, reply) => {
    const n = await openRollCallCases(ctx, actorOf(req), bodyAll(req, 'ids'), body(req).assignTo || null);
    flash(reply, 'ok', `${n} roll-call case(s) opened.`);
    return reply.redirect('/hold', 303);
  });

  // -------------------------------------------------------------------------
  // Incoming transfers (docs/07 §7.3)
  // -------------------------------------------------------------------------
  app.get('/transfers', async (req, reply) => {
    const a = actorOf(req);
    const list = await incomingTransfers(ctx, a);
    const responders = (await listStaff(ctx.db, a.orgId)).filter((s) => s.active && s.roles.includes('responder'));
    return render(req, reply, {
      title: 'Transfers',
      body: html`<h1>Incoming transfers</h1><p>Accept only with the participant present: hold your own consent conversation and have them choose a new verification answer.</p>
${list.length ? list.map((t) => html`<form method="post" action="/transfers/${t.transferId}/accept" class="card stack">${csrfField(req)}
<h2>${t.preferredName} <code>${t.code}</code></h2><p>From ${t.fromOrg}. Other names: ${t.otherNames.map((o) => o.name).join(', ') || '—'}. Birth year: ${t.birthYear ?? '—'}. Languages: ${t.languages ?? '—'}. Accessibility: ${t.accessibility ?? '—'}.
Interval: ${t.intervalDays} days. Last qualifying contact: ${fmtDate(t.lastQualifyingAt, req.org!.timezone)}. Named people: ${t.namedPeople.map((n) => n.name).join(', ') || '—'}.</p>
${consentFields(null)}
<label>New verification answer (the participant chooses) <input name="verificationAnswer" required autocomplete="off"></label>
<label>Primary responder <select name="primary"><option value="">—</option>${options(responders.map((s) => [s.id, s.display_name]))}</select></label>
<label>Backup responder <select name="backup"><option value="">—</option>${options(responders.map((s) => [s.id, s.display_name]))}</select></label>
<button class="btn primary" type="submit">Accept responsibility</button></form>${postButton(req, `/transfers/${t.transferId}/decline`, 'Decline')}`) : html`<p class="muted">None.</p>`}`,
    });
  });
  app.post('/transfers/:id/accept', async (req, reply) => {
    const b = body(req);
    const { consent, teachBack } = readConsent(req);
    await acceptTransfer(ctx, actorOf(req), (req.params as { id: string }).id, { verificationAnswer: b.verificationAnswer ?? '', consent, teachBack, primaryResponderId: b.primary || null, backupResponderId: b.backup || null });
    flash(reply, 'ok', 'Transfer accepted. Your organization is now responsible.');
    return reply.redirect('/transfers', 303);
  });
  app.post('/transfers/:id/decline', async (req, reply) => {
    await declineTransfer(ctx, actorOf(req), (req.params as { id: string }).id);
    return reply.redirect('/transfers', 303);
  });
  void summarize;
}

function phoneFor(org: { police_nonemergency_phone: string | null; dss_adult_phone: string | null; dss_child_phone: string | null }, r: string): string | null {
  return r === 'police' ? org.police_nonemergency_phone : r === 'dss_child' ? org.dss_child_phone : org.dss_adult_phone;
}

function caseTable(rows: (CaseRow & { code: string; owner?: string | null; offeree?: string | null })[], now: number, tz: string, withOwner = false): SafeHtml {
  return html`<table><thead><tr><th>Participant</th><th>Status</th><th>Since overdue</th>${withOwner ? html`<th>Responsible</th>` : ''}<th>Trigger</th></tr></thead><tbody>${rows.map((c) => html`<tr class="${c.state}">
<td><a href="/cases/${c.id}">${c.code}</a>${c.priority ? ' ★' : ''}</td><td>${CSTATE_LABEL[c.state]}${c.withdrawal_pending ? ' (withdrawal pending)' : ''}</td><td>${ago(c.overdue_at ?? c.opened_at, now)}</td>
${withOwner ? html`<td>${c.owner ?? (c.offeree ? `offered to ${c.offeree}` : '—')}</td>` : ''}<td>${c.trigger.replace('_', ' ')}</td></tr>`)}</tbody></table>`;
  void tz;
}

/** Interprets a datetime-local value in the organization's time zone. */
export function zonedInput(v: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) fail('Enter a valid date and time.');
  const { zonedToUtc } = calendar;
  return zonedToUtc(Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4]) * 60 + Number(m![5]), tz);
}
import * as calendar from '../../lib/calendar.js';
