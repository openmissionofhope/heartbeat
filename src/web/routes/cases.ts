import type { FastifyInstance, FastifyRequest } from 'fastify';
import { many, maybe } from '../../db/index.js';
import {
  ACCEPT_STATEMENT, FOLLOWUP_ACTIONS, acceptCase, caseActions, closeOnSelfReport, confirmReportedContact, declineCase, decideClosure, getCase,
  proposeClosure, recordAction, recordReview, releaseCase, reassignCase, reopenCase, resumeActiveFollowup, secondReview, startExtendedWatch,
} from '../../domain/cases.js';
import { contactHistory } from '../../domain/contacts.js';
import { fail, has } from '../../domain/core.js';
import { accessBasis, currentPlan, getParticipantRow, logView, remoteFlags, summarize } from '../../domain/participants.js';
import { sendFollowupText } from '../../domain/sms.js';
import { listStaff } from '../../domain/staff.js';
import { formatParticipantCode } from '../../lib/codes.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { type RouteDeps, actorOf, body } from '../app.js';
import { CLOSURE_LABEL, CONFIDENCE_LABEL, CSTATE_LABEL, KIND_LABEL, csrfField, flash, fmtDate, lastContactText, options, postButton, render } from '../ui.js';

const ACTION_LABEL: Record<string, string> = {
  checked_records: 'Checked Heartbeat and our records',
  asked_host_staff: 'Asked our staff',
  called: 'Called their phone',
  texted: 'Texted their phone',
  left_voicemail: 'Left a voicemail',
  visited_usual_place: 'Looked where they are usually found',
  asked_named_person: 'Asked a person they named',
  asked_partner_org: 'Gave a partner organization their message',
  other: 'Other (explain in the note)',
  review: 'Extended-watch review',
};

export async function caseRoutes(app: FastifyInstance, { ctx }: RouteDeps) {
  const cid = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get('/cases/:id', async (req, reply) => {
    const a = actorOf(req);
    const c = await getCase(ctx.db, cid(req));
    if (c.org_id !== a.orgId) fail('Case not found.', 404);
    const p = await getParticipantRow(ctx.db, c.participant_id);
    const tz = req.org!.timezone;
    const now = ctx.clock.now();
    const basis = await accessBasis(ctx.db, ctx, a, p, 'cases');
    if (!basis) fail('You do not have access to this case.', 403);
    await logView(ctx, a, p.id, 'case', basis!);
    const s = await summarize(ctx, p);
    const isOwner = c.owner_id === a.staffId;
    const isOfferee = c.offeree_id === a.staffId;
    const coord = has(a, 'coordinator', 'program_lead');
    const plan = await currentPlan(ctx.db, ctx, p.id);
    const flags = await remoteFlags(ctx.db, p.id, now);
    const actions = await caseActions(ctx, c);
    const leads = (await contactHistory(ctx, p.id, c.opened_at.getTime() - 14 * 86_400_000)).filter((x) => !x.voided_at);
    const proposal = await maybe<{ id: string; reason: string; proposed_by: string; reviewed_by: string | null }>(ctx.db, 'SELECT id, reason, proposed_by, reviewed_by FROM closure_proposals WHERE case_id = $1 AND decision IS NULL', [c.id]);
    const staff = (await listStaff(ctx.db, a.orgId)).filter((x) => x.active && (x.roles.includes('responder') || x.roles.includes('coordinator')));
    const names = new Map(staff.map((x) => [x.id, x.display_name]));
    const owner = c.owner_id ? names.get(c.owner_id) ?? '—' : null;
    const offeree = c.offeree_id ? names.get(c.offeree_id) ?? '—' : null;
    const showPlan = isOwner || isOfferee || coord;
    const parts: SafeHtml[] = [];
    parts.push(html`<h1>Follow-up: ${s.name} <code>${formatParticipantCode(s.code)}</code></h1>
<p><strong>${CSTATE_LABEL[c.state]}</strong>${c.withdrawal_pending ? html` — <strong>withdrawal pending: passive steps only, no outreach</strong>` : ''}. Opened ${fmtDate(c.opened_at, tz)} (${c.trigger.replace('_', ' ')}${c.overdue_at ? `; overdue since ${fmtDate(c.overdue_at, tz)}` : ''}).
${owner ? html` Responsible: <strong>${owner}</strong>.` : offeree ? html` Offered to ${offeree} until ${fmtDate(c.offer_expires_at, tz)}.` : ''}</p>
<p>${lastContactText(s.lastQualifyingAt, s.lastQualifyingKind, s.lastQualifyingConfidence, tz)}. A recorded contact is not proof of safety.</p>
${flags.length ? html`<p class="warn">Plan changed remotely ${flags.map((f) => `on ${fmtDate(f.at, tz, false)} (${f.fields.join(', ')})`).join('; ')} and not confirmed in person. Weigh this.</p>` : ''}
${c.closure_reason ? html`<p>Closed: ${CLOSURE_LABEL[c.closure_reason]} — ${fmtDate(c.closed_at, tz)}.</p>` : ''}`);

    if (c.state === 'offered' && (isOfferee || coord)) {
      parts.push(html`<section class="card"><form method="post" action="/cases/${c.id}/accept" class="stack">${csrfField(req)}<label class="check"><input type="checkbox" name="statement" value="${ACCEPT_STATEMENT}" required> ${ACCEPT_STATEMENT}</label><button class="btn primary" type="submit">Accept</button></form>
${isOfferee ? html`<form method="post" action="/cases/${c.id}/decline" class="row">${csrfField(req)}<input name="reason" required placeholder="Why (on leave, conflict, capacity…)"><button class="btn" type="submit">Decline</button></form>` : ''}</section>`);
    }
    if (c.state === 'uncovered' && has(a, 'responder', 'coordinator', 'program_lead')) {
      parts.push(html`<section class="card alert"><p>Nobody is responsible for this follow-up.</p><form method="post" action="/cases/${c.id}/accept" class="stack">${csrfField(req)}<label class="check"><input type="checkbox" name="statement" value="${ACCEPT_STATEMENT}" required> ${ACCEPT_STATEMENT}</label><button class="btn primary" type="submit">Accept</button></form></section>`);
    }
    if (showPlan && c.state !== 'closed') {
      parts.push(html`<section class="card"><h2>What the participant agreed to</h2><ul>
${plan.followup.map((f) => html`<li>${{ records: 'Check our records and ask our staff', phone: `Phone ${plan.phone ?? ''} (${[plan.phoneCall && 'call', plan.phoneText && 'text', plan.phoneVoicemail && 'voicemail'].filter(Boolean).join(', ') || 'no method agreed'}); say only: “${plan.phoneMessage ?? 'This is [your first name] from [host]; please ask them to call us.'}”${plan.avoidTimes ? `; avoid ${plan.avoidTimes}` : ''}`, places: `Look where they are usually found: ${plan.usuallyFound ?? ''}`, people: 'Ask the people they named (below), using exactly the words given', partners: `Give partner organizations this message: “${plan.partnerMessage ?? ''}”` }[f]}</li>`)}</ul>
${plan.followup.includes('people') ? html`<ul>${plan.namedPeople.map((n) => html`<li>${n.name}, ${n.phone}: “${n.message}”</li>`)}</ul>` : ''}
<p class="muted">Only these steps. If you believe another step is needed, write why and ask the coordinator. If anyone is in immediate danger, follow our emergency procedures outside Heartbeat. If you learn of abuse that must be reported, use <a href="/safeguarding">Required reports</a>.</p></section>`);
    }
    if (c.state === 'contact_reported' && (isOwner || coord)) {
      const rc = leads.find((l) => l.id === c.reported_contact_id);
      parts.push(html`<section class="card alert"><h2>A contact was recorded</h2><p>${rc ? `${KIND_LABEL[rc.kind]}, ${CONFIDENCE_LABEL[rc.confidence]}, ${fmtDate(rc.occurred_at, tz)}, by ${rc.recorder ?? rc.org_name ?? rc.source}` : 'Details unavailable.'}. Was it the right person?</p>
${postButton(req, `/cases/${c.id}/confirm`, 'Yes — close as contact restored', { right: '1' }, 'btn primary')}
<form method="post" action="/cases/${c.id}/confirm" class="row">${csrfField(req)}<input type="hidden" name="right" value="0"><input name="reason" required placeholder="Why it was the wrong person"><button class="btn" type="submit">No — wrong person</button></form></section>`);
    }
    if (['accepted', 'stalled', 'extended_watch'].includes(c.state) && (isOwner || has(a, 'coordinator'))) {
      const allowed = Object.keys(FOLLOWUP_ACTIONS).filter((k) => k !== 'review' && (!FOLLOWUP_ACTIONS[k] || plan.followup.includes(FOLLOWUP_ACTIONS[k] as never)) && (!c.withdrawal_pending || ['checked_records', 'asked_host_staff'].includes(k)));
      parts.push(html`<section class="card"><h2>Record what you did</h2><form method="post" action="/cases/${c.id}/action" class="stack">${csrfField(req)}
<label>Action <select name="action">${options(allowed.map((k) => [k, ACTION_LABEL[k]!]))}</select></label>
<label>Who gave any information <select name="source">${options([['none', 'Nobody'], ['participant', 'The participant'], ['host_staff', 'Our staff'], ['partner_staff', 'Partner staff'], ['named_person', 'A person they named'], ['other_person', 'Someone else']])}</select></label>
<label>Result <select name="result">${options([['no_information', 'No information'], ['lead', 'A lead that may help'], ['contact_restored', 'I was in contact with them'], ['impossible', 'This step was impossible']])}</select></label>
<label>How sure are you? <select name="certainty">${options([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])}</select></label>
<fieldset><legend>If you were in contact</legend><select name="ckind">${options([['', '—'], ['in_person', 'In person'], ['phone_with_staff', 'By phone']])}</select>
<select name="cconf">${options([['known', 'I know them'], ['verified', 'They gave their verification answer'], ['stated', 'They only said who they were']])}</select></fieldset>
<label>Note (500 characters; not where they are, not health, immigration or other people's details) <textarea name="note" maxlength="500"></textarea></label>
<button class="btn primary" type="submit">Save</button></form>
${plan.followup.includes('phone') && plan.phoneText && !c.withdrawal_pending ? postButton(req, `/cases/${c.id}/text`, 'Send their permitted message by text') : ''}</section>`);
      const selfReports = leads.filter((l) => l.kind === 'self_check_in' && l.recorded_at >= c.opened_at);
      if (selfReports.length && !c.withdrawal_pending) {
        parts.push(html`<section class="card"><h2>Self-check-ins since this opened</h2><ul>${selfReports.map((l) => html`<li>${fmtDate(l.occurred_at, tz)} — ${CONFIDENCE_LABEL[l.confidence]}${l.note ? ` — “${l.note}”` : ''} ${postButton(req, `/cases/${c.id}/self-report`, 'Credible: close (reviewed weekly)', { contactId: l.id }, 'btn small')}</li>`)}</ul></section>`);
      }
      const ownerOptions: SafeHtml[] = [];
      if (isOwner && c.state !== 'extended_watch' && !c.withdrawal_pending) ownerOptions.push(html`<form method="post" action="/cases/${c.id}/release" class="row">${csrfField(req)}<input name="reason" required placeholder="Why you are handing it back"><button class="btn" type="submit">Release to the next person</button></form>`);
      if (has(a, 'coordinator') && c.state !== 'extended_watch') ownerOptions.push(postButton(req, `/cases/${c.id}/extended-watch`, 'Move to extended watch'));
      if (c.state === 'extended_watch') ownerOptions.push(html`<form method="post" action="/cases/${c.id}/review" class="row">${csrfField(req)}<input name="note" placeholder="Review note"><button class="btn" type="submit">Record review</button></form>${postButton(req, `/cases/${c.id}/resume`, 'New lead: resume active follow-up')}`);
      if (!proposal) {
        ownerOptions.push(html`<details><summary>Propose a closure that needs approval</summary><form method="post" action="/cases/${c.id}/propose" class="stack">${csrfField(req)}
<label>Reason <select name="reason">${options([['other_documented', 'Other documented outcome'], ['reported_deceased', 'Reported deceased'], ['ended_after_extended_follow_up', 'End after extended follow-up (90+ days in extended watch)']])}</select></label>
<label>If reported deceased, how it was confirmed <select name="deceasedSource"><option value="">—</option>${options([['official_notification', 'Official notification (e.g. medical examiner, hospital)'], ['next_of_kin_confirmed', 'Next of kin, with official confirmation'], ['staff_confirmed', 'Our staff personally confirmed']])}</select></label>
<label>Note <textarea name="note" maxlength="500"></textarea></label><button class="btn" type="submit">Propose</button></form></details>`);
      }
      if (coord && !c.withdrawal_pending) {
        ownerOptions.push(html`<form method="post" action="/cases/${c.id}/reassign" class="row">${csrfField(req)}<select name="staffId">${options(staff.map((x) => [x.id, x.display_name]))}</select><button class="btn" type="submit">Reassign</button></form>`);
      }
      parts.push(html`<section class="card"><h2>Other options</h2>${ownerOptions}</section>`);
    }
    if (c.state === 'offered' && coord) parts.push(html`<section class="card"><form method="post" action="/cases/${c.id}/reassign" class="row">${csrfField(req)}<select name="staffId">${options(staff.map((x) => [x.id, x.display_name]))}</select><button class="btn" type="submit">Offer to someone else</button></form></section>`);
    if (proposal) {
      parts.push(html`<section class="card alert"><h2>Closure proposed: ${CLOSURE_LABEL[proposal.reason]}</h2>
${proposal.reason === 'reported_deceased' && !proposal.reviewed_by && proposal.proposed_by !== a.staffId && coord ? postButton(req, `/proposals/${proposal.id}/review`, 'I am the second reviewer: I checked the source') : ''}
${proposal.reason === 'reported_deceased' && !proposal.reviewed_by ? html`<p>Waiting for a second reviewer who did not propose it.</p>` : ''}
${has(a, 'program_lead') ? html`${postButton(req, `/proposals/${proposal.id}/decide`, 'Approve', { approve: '1' }, 'btn primary')} ${postButton(req, `/proposals/${proposal.id}/decide`, 'Reject', { approve: '0' })}` : ''}</section>`);
    }
    if (c.state === 'closed' && coord && ['contact_restored', 'contact_restored_self_report', 'recording_gap'].includes(c.closure_reason ?? '')) {
      parts.push(html`<form method="post" action="/cases/${c.id}/reopen" class="card row">${csrfField(req)}<input name="reason" required placeholder="Why the closure was wrong"><button class="btn" type="submit">Reopen</button></form>`);
    }
    const assignments = await many<{ step: string; display_name: string; offered_at: Date; accepted_at: Date | null; declined_at: Date | null; decline_reason: string | null; expired_at: Date | null; released_at: Date | null; release_reason: string | null }>(ctx.db,
      'SELECT a.*, s.display_name FROM case_assignments a JOIN staff s ON s.id = a.staff_id WHERE a.case_id = $1 ORDER BY a.offered_at', [c.id]);
    parts.push(html`<section class="card"><h2>History</h2><table><tbody>
${assignments.map((x) => html`<tr><td>${fmtDate(x.offered_at, tz)}</td><td>Offered to ${x.display_name} (${x.step})</td><td>${x.accepted_at ? `accepted ${fmtDate(x.accepted_at, tz)}` : x.declined_at ? `declined: ${x.decline_reason}` : x.expired_at ? 'not accepted in time' : ''}${x.released_at ? `; released: ${x.release_reason}` : ''}</td></tr>`)}
${actions.map((x) => html`<tr><td>${fmtDate(x.at, tz)}</td><td>${x.display_name}: ${ACTION_LABEL[x.action]}</td><td>${x.result.replace('_', ' ')}, certainty ${x.certainty}${x.note ? html` — ${x.note}` : ''}</td></tr>`)}
${leads.filter((l) => l.recorded_at >= c.opened_at).map((l) => html`<tr><td>${fmtDate(l.occurred_at, tz)}</td><td>Contact: ${KIND_LABEL[l.kind]}</td><td>${CONFIDENCE_LABEL[l.confidence]}${l.note ? ` — “${l.note}”` : ''}${l.voided_at ? ' (void)' : ''}</td></tr>`)}
</tbody></table></section>`);
    return render(req, reply, { title: 'Follow-up', body: html`${parts}` });
  });

  const go = (path: string, fn: (req: FastifyRequest) => Promise<unknown>, msg: string) => {
    app.post(`/cases/:id/${path}`, async (req, reply) => {
      await fn(req);
      flash(reply, 'ok', msg);
      return reply.redirect(`/cases/${cid(req)}`, 303);
    });
  };
  go('accept', (req) => acceptCase(ctx, actorOf(req), cid(req), body(req).statement ?? ''), 'Accepted. You are responsible for this follow-up.');
  go('decline', (req) => declineCase(ctx, actorOf(req), cid(req), body(req).reason ?? ''), 'Declined; offered to the next person.');
  go('release', (req) => releaseCase(ctx, actorOf(req), cid(req), body(req).reason ?? ''), 'Released.');
  go('reassign', (req) => reassignCase(ctx, actorOf(req), cid(req), body(req).staffId ?? ''), 'Offered.');
  go('action', (req) => {
    const b = body(req);
    return recordAction(ctx, actorOf(req), cid(req), {
      action: b.action as never, source: b.source as never, result: b.result as never, certainty: b.certainty as never, note: b.note || null,
      ...(b.ckind ? { contact: { kind: b.ckind as never, confidence: (b.cconf ?? 'stated') as never } } : {}),
    });
  }, 'Saved.');
  go('text', async (req) => {
    const r = await sendFollowupText(ctx, actorOf(req), cid(req));
    if (r !== 'sent') fail(r === 'skipped' ? 'Not sent: outside texting hours, opted out, or texting is not set up.' : 'The text failed to send.');
  }, 'Sent and recorded.');
  go('confirm', (req) => confirmReportedContact(ctx, actorOf(req), cid(req), body(req).right === '1', body(req).reason), 'Saved.');
  go('self-report', (req) => closeOnSelfReport(ctx, actorOf(req), cid(req), body(req).contactId ?? ''), 'Closed. This closure appears in the weekly review.');
  go('extended-watch', (req) => startExtendedWatch(ctx, actorOf(req), cid(req)), 'Moved to extended watch. It stays open.');
  go('review', (req) => recordReview(ctx, actorOf(req), cid(req), body(req).note || null), 'Review recorded.');
  go('resume', (req) => resumeActiveFollowup(ctx, actorOf(req), cid(req)), 'Active follow-up resumed.');
  go('propose', (req) => proposeClosure(ctx, actorOf(req), cid(req), { reason: body(req).reason as never, note: body(req).note || null, deceasedSource: body(req).deceasedSource || null }), 'Proposed. The program lead decides.');
  go('reopen', (req) => reopenCase(ctx, actorOf(req), cid(req), body(req).reason ?? ''), 'Reopened.');

  app.post('/proposals/:id/review', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await secondReview(ctx, actorOf(req), id);
    const r = await maybe<{ case_id: string }>(ctx.db, 'SELECT case_id FROM closure_proposals WHERE id = $1', [id]);
    return reply.redirect(`/cases/${r?.case_id ?? ''}`, 303);
  });
  app.post('/proposals/:id/decide', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await decideClosure(ctx, actorOf(req), id, body(req).approve === '1');
    const r = await maybe<{ case_id: string }>(ctx.db, 'SELECT case_id FROM closure_proposals WHERE id = $1', [id]);
    return reply.redirect(`/cases/${r?.case_id ?? ''}`, 303);
  });
}
