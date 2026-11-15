import type { FastifyInstance, FastifyRequest } from 'fastify';
import { POLICY } from '../../config.js';
import { many } from '../../db/index.js';
import { setLegalHold } from '../../domain/admin.js';
import { voidContact, contactHistory } from '../../domain/contacts.js';
import { concernsFor, markParticipantTold, recordConcern } from '../../domain/concerns.js';
import { fail, has } from '../../domain/core.js';
import { cancelPendingWithdrawal, confirmWithdrawalInPerson, endLongPendingWithdrawal, endPause, pause, reactivate, reinstate, reviewPendingWithdrawal, withdraw } from '../../domain/lifecycle.js';
import { listOrgs } from '../../domain/orgs.js';
import {
  type ConsentChoices, type Confidence, type NamedPerson, type ParticipantRow, type PlanInput, type Section,
  accessBasis, addConflict, changePlan, confirmRemoteChanges, currentPlan, enroll, getParticipantRow, grantAccess, latestConsent, listConflicts,
  logView, remoteFlags, removeConflict, resetVerification, searchParticipants, setLookup, setPrimaryBackup, summarize, updateIdentity,
} from '../../domain/participants.js';
import { deletePhoto, getPhoto, issueSelfViewCode, setPhoto } from '../../domain/selfview.js';
import { sendPhoneCode, verifyPhoneCode } from '../../domain/sms.js';
import { listStaff } from '../../domain/staff.js';
import { requestTransfer } from '../../domain/transfers.js';
import { CONSENT_POINTS, TEACH_BACK } from '../../content/consent.js';
import { formatParticipantCode } from '../../lib/codes.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { type RouteDeps, actorOf, body, bodyAll, query } from '../app.js';
import { CLOSURE_LABEL, CONFIDENCE_LABEL, CSTATE_LABEL, KIND_LABEL, PSTATE_LABEL, checked, csrfField, flash, fmtDate, lastContactText, options, postButton, render } from '../ui.js';
import { zonedInput } from './home.js';

const DAY = 86_400_000;

export function consentFields(c: ConsentChoices | null): SafeHtml {
  return html`<fieldset><legend>The participant agrees to (each is a separate choice)</legend>
<label class="check"><input type="checkbox" name="c_relays" value="1"${checked(c?.relays)}> Relays: contact at another participating organization can count</label>
<label class="check"><input type="checkbox" name="c_sms" value="1"${checked(c?.sms)}> Automated text messages (check-ins, reminders, follow-up texts). Reply STOP any time.</label>
<label class="check"><input type="checkbox" name="c_keypad" value="1"${checked(c?.keypad)}> Phone keypad check-ins with a PIN</label>
<label class="check"><input type="checkbox" name="c_continuity" value="1"${checked(c?.continuitySharing)}> If we cannot operate, our continuity partner may use the minimal continuity sheet</label>
<label class="check"><input type="checkbox" name="c_photo" value="1"${checked(c?.photo)}> A photo, so staff who don't know them can tell them apart (only if this organization uses photos)</label>
<label class="check"><input type="checkbox" name="c_selfview" value="1"${checked(c?.selfView)}> Seeing their own record online with a one-time code</label></fieldset>
<fieldset><legend>Teach-back</legend><p>Ask, and listen for the answer in their own words:</p><ul>${TEACH_BACK.map((t) => html`<li>${t}</li>`)}</ul>
<label class="check"><input type="checkbox" name="teachBack" value="1" required> They explained all three back in their own words</label></fieldset>`;
}

export function readConsent(req: FastifyRequest): { consent: ConsentChoices; teachBack: boolean } {
  const b = body(req);
  return {
    consent: { relays: b.c_relays === '1', sms: b.c_sms === '1', keypad: b.c_keypad === '1', continuitySharing: b.c_continuity === '1', photo: b.c_photo === '1', selfView: b.c_selfview === '1' },
    teachBack: b.teachBack === '1',
  };
}

function planFields(p: Partial<ReturnType<typeof planDefaults>>): SafeHtml {
  const kinds = p.qualifyingKinds ?? ['in_person', 'phone_with_staff'];
  const fu = p.followup ?? ['records'];
  const people = [...(p.namedPeople ?? []), { name: '', phone: '', message: '' }, { name: '', phone: '', message: '' }].slice(0, 3);
  return html`<fieldset><legend>How often</legend><label>Expected contact at least every <select name="intervalDays">${options([['7', '7 days'], ['14', '14 days'], ['30', '30 days']], String(p.intervalDays ?? 14))}</select></label>
<p class="muted">Grace after the interval: ${Object.entries(POLICY.graceDays).map(([i, g]) => `${i}-day plan ${g} days`).join('; ')}. Choose based on how often they are actually around.</p></fieldset>
<fieldset><legend>What counts as contact</legend>
${(['in_person', 'phone_with_staff', 'relay', 'self_check_in'] as const).map((k) => html`<label class="check"><input type="checkbox" name="qk" value="${k}"${checked(kinds.includes(k))}> ${KIND_LABEL[k]}${k === 'self_check_in' ? ' (texts or keypad, with their check-in word or PIN)' : ''}</label>`)}</fieldset>
<fieldset><legend>Follow-up they agree to if they go quiet</legend>
<label class="check"><input type="checkbox" checked disabled> Check Heartbeat and our records, and ask our staff (always)</label>
<label class="check"><input type="checkbox" name="fu" value="phone"${checked(fu.includes('phone'))}> Call or text their phone</label>
<label class="check"><input type="checkbox" name="fu" value="places"${checked(fu.includes('places'))}> Look for them at the places they list</label>
<label class="check"><input type="checkbox" name="fu" value="people"${checked(fu.includes('people'))}> Ask the people they name</label>
<label class="check"><input type="checkbox" name="fu" value="partners"${checked(fu.includes('partners'))}> Give participating partner organizations their message</label></fieldset>
<fieldset><legend>Phone</legend><label>Phone number <input name="phone" value="${p.phone ?? ''}" inputmode="tel"></label>
<label class="check"><input type="checkbox" name="phoneCall" value="1"${checked(p.phoneCall)}> They agree to calls on this phone</label>
<label class="check"><input type="checkbox" name="phoneText" value="1"${checked(p.phoneText)}> They agree to texts on this phone</label>
<label class="check"><input type="checkbox" name="phoneVoicemail" value="1"${checked(p.phoneVoicemail)}> They agree to voicemail on this phone</label>
<label>Exactly what may be said if someone else answers (their words) <input name="phoneMessage" maxlength="200" value="${p.phoneMessage ?? ''}" placeholder="This is Sam from the day center; please ask them to call us."></label>
<label>Times to avoid <input name="avoidTimes" maxlength="120" value="${p.avoidTimes ?? ''}"></label>
<label class="check"><input type="checkbox" name="smsCheckins" value="1"${checked(p.smsCheckins)}> Text check-ins from this phone</label>
<label class="check"><input type="checkbox" name="smsReminders" value="1"${checked(p.smsReminders)}> A reminder text the day before contact is due</label>
<label class="check"><input type="checkbox" name="keypadCheckins" value="1"${checked(p.keypadCheckins)}> Phone keypad check-ins</label></fieldset>
<fieldset><legend>Where they are usually found (their words, 200 characters; never a location history)</legend><input name="usuallyFound" maxlength="200" value="${p.usuallyFound ?? ''}"></fieldset>
<fieldset><legend>People who may be asked about them</legend>${people.map((n, i) => html`<div class="row"><label>Name <input name="np${i}_name" value="${n.name}"></label><label>Phone <input name="np${i}_phone" value="${n.phone}"></label><label>Exactly what may be said <input name="np${i}_message" value="${n.message}" placeholder="We're trying to reach Laura — have you seen her?"></label></div>`)}</fieldset>
<fieldset><legend>Message partners may be given</legend><input name="partnerMessage" maxlength="200" value="${p.partnerMessage ?? ''}" placeholder="We're trying to reach Laura; if she comes in, please ask her to call us."></fieldset>
<fieldset><legend>Other choices</legend>
<label class="check"><input type="checkbox" name="tellMeIfAsked" value="1"${checked(p.tellMeIfAsked ?? true)}> Tell them if someone asks about them</label>
<label class="check"><input type="checkbox" name="disasterPriority" value="1"${checked(p.disasterPriority)}> Try to reach them sooner after a disaster (a place near the top of the list — not rescue)</label>
<label>Reason (optional) <select name="disasterCategory"><option value="">—</option>${options([['mobility', 'Mobility'], ['medical', 'Medical equipment or medication'], ['other', 'Other']], p.disasterCategory ?? '')}</select></label>
<label class="check"><input type="checkbox" name="continuitySharing" value="1"${checked(p.continuitySharing)}> Continuity partner may use the continuity sheet</label></fieldset>`;
}

function planDefaults() {
  return { intervalDays: 14, qualifyingKinds: ['in_person', 'phone_with_staff'] as string[], followup: ['records'] as string[], phone: '', phoneCall: false, phoneText: false, phoneVoicemail: false,
    phoneMessage: '', avoidTimes: '', usuallyFound: '', namedPeople: [] as NamedPerson[], partnerMessage: '', tellMeIfAsked: true, disasterPriority: false,
    disasterCategory: null as string | null, continuitySharing: false, smsCheckins: false, smsReminders: false, keypadCheckins: false };
}

function readPlan(req: FastifyRequest): PlanInput & { intervalDays: number } {
  const b = body(req);
  const named: NamedPerson[] = [0, 1, 2].map((i) => ({ name: (b[`np${i}_name`] ?? '').trim(), phone: (b[`np${i}_phone`] ?? '').trim(), message: (b[`np${i}_message`] ?? '').trim() })).filter((n) => n.name || n.phone || n.message);
  return {
    intervalDays: Number(b.intervalDays ?? 14),
    qualifyingKinds: bodyAll(req, 'qk') as never,
    followup: ['records', ...bodyAll(req, 'fu')] as never,
    phone: b.phone || null,
    phoneCall: b.phoneCall === '1', phoneText: b.phoneText === '1', phoneVoicemail: b.phoneVoicemail === '1',
    phoneMessage: b.phoneMessage || null, avoidTimes: b.avoidTimes || null, usuallyFound: b.usuallyFound || null, namedPeople: named, partnerMessage: b.partnerMessage || null,
    tellMeIfAsked: b.tellMeIfAsked === '1', disasterPriority: b.disasterPriority === '1', disasterCategory: (b.disasterCategory || null) as never,
    continuitySharing: b.continuitySharing === '1', smsCheckins: b.smsCheckins === '1', smsReminders: b.smsReminders === '1', keypadCheckins: b.keypadCheckins === '1',
  };
}

const IDENTITY_OPTIONS: [string, string][] = [['known', 'I know them (voice or sight)'], ['verified', 'They gave the verification answer'], ['stated', 'They only said who they were']];

function remoteFields(): SafeHtml {
  return html`<label>How is the participant asking? <select name="channel">${options([['in_person', 'In person, in private'], ['remote', 'Remotely (phone, message, relay)']])}</select></label>
<label>If remote, how do you know it is them? <select name="identity">${options(IDENTITY_OPTIONS)}</select></label>`;
}

export async function participantRoutes(app: FastifyInstance, { ctx }: RouteDeps) {
  const back = (id: string) => `/participants/${id}`;
  const pid = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get('/participants', async (req, reply) => {
    const a = actorOf(req);
    const q = (query(req).q ?? '').trim();
    const hits = q ? await searchParticipants(ctx, a, q) : [];
    return render(req, reply, {
      title: 'Participants',
      body: html`<h1>Participants</h1><form method="get" class="row"><label>Name or code <input name="q" value="${q}" required></label><button class="btn" type="submit">Find</button></form>
<p class="muted">There is no list of everyone: search by name or code. Searches are logged.</p>
${hits.length ? html`<table><tbody>${hits.map((h) => html`<tr><td><a href="/participants/${h.id}">${h.name}</a></td><td><code>${h.code}</code></td><td>${PSTATE_LABEL[h.state]}</td><td>${h.training ? 'training' : ''}</td></tr>`)}</tbody></table>` : q ? html`<p>No match.</p>` : ''}`,
    });
  });

  app.get('/participants/new', async (req, reply) => {
    const a = actorOf(req);
    const responders = (await listStaff(ctx.db, a.orgId)).filter((s) => s.active && s.roles.includes('responder'));
    return render(req, reply, {
      title: 'Enroll',
      body: html`<h1>Enroll a participant</h1>
${req.org!.enrollment_paused ? html`<div class="card alert"><p><strong>New enrollment is paused:</strong> ${req.org!.enrollment_pause_reason}. Please invite the person to ask again later; nothing is recorded.</p></div>` : ''}
<form method="post" action="/participants/new" class="stack">${csrfField(req)}
<section class="card"><h2>1. The consent conversation</h2><p>In private, in their language, without rushing, and not while they are waiting for a service they might think depends on this. Cover each point:</p>
<ol>${CONSENT_POINTS.map((c) => html`<li>${c.en}</li>`)}</ol>
<label class="check"><input type="checkbox" name="adult" value="1" required> They say they are 18 or older</label>
<label class="check"><input type="checkbox" name="private" value="1" required> We spoke in private (no companion unless they asked for one)</label>
${consentFields(null)}</section>
<section class="card"><h2>2. Who they are</h2>
<label>Name they want us to use <input name="preferredName" required maxlength="80"></label>
<div class="row"><label>Other name <input name="on0"></label><label class="check"><input type="checkbox" name="on0v" value="1"> front desk may see it</label></div>
<div class="row"><label>Other name <input name="on1"></label><label class="check"><input type="checkbox" name="on1v" value="1"> front desk may see it</label></div>
<label class="check"><input type="checkbox" name="codeOnly" value="1"> Find me by code only (I don't want to appear in name searches at the front desk)</label>
<label>Birth year (optional) <input name="birthYear" inputmode="numeric" maxlength="4"></label>
<label>Languages <input name="languages" maxlength="80"></label>
<label>Accessibility needs (optional, 200 characters) <input name="accessibility" maxlength="200"></label>
<label>Verification answer — a word or number they will remember; not a birthday <input name="verificationAnswer" required autocomplete="off"></label>
<label>Keypad PIN, 4–6 digits (only for keypad check-ins) <input name="keypadPin" inputmode="numeric" maxlength="6" autocomplete="off"></label></section>
<section class="card"><h2>3. Their contact plan</h2>${planFields(planDefaults())}</section>
<section class="card"><h2>4. Responders</h2>
<label>Primary responder (someone they trust, if possible) <select name="primary"><option value="">—</option>${options(responders.map((s) => [s.id, s.display_name]))}</select></label>
<label>Backup responder <select name="backup"><option value="">—</option>${options(responders.map((s) => [s.id, s.display_name]))}</select></label>
<label class="check"><input type="checkbox" name="confirmDifferent" value="1"> I checked: this is not someone already enrolled (only needed if a possible match is shown)</label></section>
<button class="btn primary" type="submit">Enroll</button></form>`,
    });
  });

  app.post('/participants/new', async (req, reply) => {
    const a = actorOf(req);
    const b = body(req);
    const { consent, teachBack } = readConsent(req);
    const p = await enroll(ctx, a, {
      preferredName: b.preferredName ?? '',
      otherNames: [0, 1].map((i) => ({ name: b[`on${i}`] ?? '', recorderVisible: b[`on${i}v`] === '1' })).filter((o) => o.name.trim()),
      lookup: b.codeOnly === '1' ? 'code_only' : 'name',
      birthYear: b.birthYear ? Number(b.birthYear) : null,
      languages: b.languages || null, accessibility: b.accessibility || null,
      verificationAnswer: b.verificationAnswer ?? '', keypadPin: b.keypadPin || null,
      adultConfirmed: b.adult === '1', privateConversation: b.private === '1', teachBack, consent,
      plan: readPlan(req), primaryResponderId: b.primary || null, backupResponderId: b.backup || null, confirmDifferentPerson: b.confirmDifferent === '1',
    });
    flash(reply, 'ok', `Enrolled. Code ${formatParticipantCode(p.code)}. Offer them a card and a printed summary.`);
    return reply.redirect(back(p.id), 303);
  });

  app.get('/participants/:id', async (req, reply) => {
    const a = actorOf(req);
    const p = await getParticipantRow(ctx.db, pid(req));
    if (p.org_id !== a.orgId) fail('Participant not found.', 404);
    const tz = req.org!.timezone;
    const now = ctx.clock.now();
    const s = await summarize(ctx, p);
    const bases: Partial<Record<Section, string | null>> = {};
    for (const sec of ['plan', 'history', 'cases'] as Section[]) {
      try {
        bases[sec] = await accessBasis(ctx.db, ctx, a, p, sec);
      } catch {
        bases[sec] = undefined as never;
      }
    }
    const needsReason = Object.values(bases).some((v) => v === null);
    const parts: SafeHtml[] = [];
    const flags = await remoteFlags(ctx.db, p.id, now);
    const remoteOnly = s.lastQualifyingAt && (!s.lastInPersonAt || now - s.lastInPersonAt.getTime() > POLICY.inPersonPromptDays * DAY);
    parts.push(html`<h1>${s.name} <code>${formatParticipantCode(s.code)}</code>${s.training ? html` <span class="tag">training</span>` : ''}</h1>
<p>${PSTATE_LABEL[s.state]}. ${lastContactText(s.lastQualifyingAt, s.lastQualifyingKind, s.lastQualifyingConfidence, tz)}. Last in-person contact: ${fmtDate(s.lastInPersonAt, tz)}.</p>
${flags.length ? html`<p class="warn">Plan changed remotely (${flags.map((f) => `${f.fields.join(', ')} on ${fmtDate(f.at, tz, false)}`).join('; ')}) — not yet confirmed in person. ${has(a, 'coordinator', 'program_lead', 'enroller') ? postButton(req, `/participants/${p.id}/confirm-remote`, 'Confirmed privately in person') : ''}</p>` : ''}
${remoteOnly ? html`<p class="warn">No private, in-person contact for over ${POLICY.inPersonPromptDays} days. Seek one when you can (this is a prompt, not a case).</p>` : ''}
${s.tellPending ? html`<p class="warn">Someone asked about this person, and they want to know. Tell them privately. ${postButton(req, `/participants/${p.id}/told`, 'I told them')}</p>` : ''}
${s.state === 'withdrawal_pending' ? html`<p class="warn">Asked remotely to withdraw on ${fmtDate(p.withdrawal_requested_at, tz)}. No outreach. Confirm in person before it takes effect. Next review due ${fmtDate(p.withdrawal_review_due, tz, false)}.</p>` : ''}
${s.legalHold ? html`<p class="warn">Legal hold: ${s.legalHold}</p>` : ''}`);
    if (needsReason) {
      parts.push(html`<form method="post" action="/participants/${p.id}/reason" class="card row">${csrfField(req)}<label>To see more, type why you need to (logged and reviewed monthly) <input name="reason" minlength="10" maxlength="200" required></label><button class="btn" type="submit">Continue</button></form>`);
    }
    if (bases.plan) {
      await logView(ctx, a, p.id, 'plan', bases.plan as never);
      const plan = await currentPlan(ctx.db, ctx, p.id);
      const consent = await latestConsent(ctx.db, p.id);
      parts.push(html`<section class="card"><h2>Contact plan <a class="small" href="/participants/${p.id}/plan">change</a></h2>
<dl><dt>Interval</dt><dd>${plan.intervalDays} days + ${plan.graceDays} days grace</dd>
<dt>Counts as contact</dt><dd>${plan.qualifyingKinds.map((k) => KIND_LABEL[k]).join(', ')}</dd>
<dt>Follow-up agreed</dt><dd>${plan.followup.join(', ')}</dd>
<dt>Phone</dt><dd>${plan.phone ?? '—'} ${plan.phone ? `(${[plan.phoneCall && 'call', plan.phoneText && 'text', plan.phoneVoicemail && 'voicemail'].filter(Boolean).join(', ') || 'no contact by phone'}; ${plan.phoneVerifiedAt ? 'confirmed' : 'not confirmed'})` : ''}</dd>
<dt>May be said</dt><dd>${plan.phoneMessage ?? '—'}</dd><dt>Avoid</dt><dd>${plan.avoidTimes ?? '—'}</dd>
<dt>Usually found</dt><dd>${plan.usuallyFound ?? '—'}</dd>
<dt>People who may be asked</dt><dd>${plan.namedPeople.length ? plan.namedPeople.map((n) => html`${n.name} (${n.phone}): “${n.message}”<br>`) : '—'}</dd>
<dt>Partner message</dt><dd>${plan.partnerMessage ?? '—'}</dd>
<dt>Texts</dt><dd>${consent.sms ? `check-ins ${plan.smsCheckins ? 'on' : 'off'}, reminders ${plan.smsReminders ? 'on' : 'off'}` : 'not agreed'}</dd>
<dt>Keypad</dt><dd>${consent.keypad ? `${plan.keypadCheckins ? 'on' : 'off'}; check-in number ${s.phoneCheckinId ?? '—'}` : 'not agreed'}</dd>
<dt>Disaster priority</dt><dd>${plan.disasterPriority ? `yes${plan.disasterCategory ? ` (${plan.disasterCategory})` : ''}` : 'no'}</dd>
<dt>Lookup</dt><dd>${s.lookup === 'code_only' ? 'by code only' : 'by name'}</dd></dl>
${s.hasPhoto ? html`<p><img class="photo" src="/participants/${p.id}/photo" alt="Photo of the participant"></p>` : ''}</section>`);
    }
    if (bases.history) {
      await logView(ctx, a, p.id, 'history', bases.history as never);
      const contacts = await contactHistory(ctx, p.id, p.hosted_since.getTime());
      const concerns = await concernsFor(ctx, a, p.id);
      parts.push(html`<section class="card"><h2>Recorded contacts (last ${POLICY.retention.contactDays} days)</h2>
<table><thead><tr><th>When</th><th>Kind</th><th>Identity</th><th>By</th><th>Note</th><th></th></tr></thead><tbody>${contacts.map((c) => html`<tr class="${c.voided_at ? 'voided' : ''}">
<td>${fmtDate(c.occurred_at, tz)}</td><td>${KIND_LABEL[c.kind]}${c.qualifying ? ' ✓' : ''}${c.needs_approval ? ' (awaiting approval)' : ''}</td><td>${CONFIDENCE_LABEL[c.confidence]}</td>
<td>${c.recorder ?? c.source}${c.org_name && c.recorded_org !== p.org_id ? ` at ${c.org_name}` : ''}</td><td>${c.note ?? c.relayMessage ?? ''}${c.voided_at ? ` — void: ${c.void_reason}` : ''}</td>
<td>${!c.voided_at ? html`<form method="post" action="/contacts/${c.id}/void" class="inline">${csrfField(req)}<input type="hidden" name="back" value="/participants/${p.id}"><input name="reason" placeholder="Why wrong?" required><button class="btn small" type="submit">Void</button></form>` : ''}</td></tr>`)}</tbody></table>
<p class="muted">✓ = counted toward the contact plan. A recorded contact is not proof of safety.</p>
${concerns.length ? html`<h3>Concerns raised by others</h3><ul>${concerns.map((c) => html`<li>${fmtDate(c.received_at, tz)} — ${c.source_category}${c.callback ? ` — callback ${c.callback}` : ''}${c.participant_told_at ? ' — participant told' : ''}</li>`)}</ul>` : ''}</section>`);
    }
    if (bases.cases) {
      await logView(ctx, a, p.id, 'cases', bases.cases as never);
      const cases = await many<{ id: string; state: string; opened_at: Date; closure_reason: string | null; trigger: string }>(ctx.db,
        'SELECT id, state, opened_at, closure_reason, trigger FROM cases WHERE participant_id = $1 AND org_id = $2 ORDER BY opened_at DESC', [p.id, a.orgId]);
      parts.push(html`<section class="card"><h2>Follow-up cases</h2>${cases.length ? html`<ul>${cases.map((c) => html`<li><a href="/cases/${c.id}">${fmtDate(c.opened_at, tz, false)}</a> — ${c.trigger.replace('_', ' ')} — ${CSTATE_LABEL[c.state]}${c.closure_reason ? `: ${CLOSURE_LABEL[c.closure_reason]}` : ''}</li>`)}</ul>` : html`<p class="muted">None.</p>`}</section>`);
    }
    if (has(a, 'enroller', 'responder', 'coordinator', 'program_lead')) parts.push(await actionsPanel(req, p));
    return render(req, reply, { title: s.name, body: html`${parts}` });
  });

  async function actionsPanel(req: FastifyRequest, p: ParticipantRow): Promise<SafeHtml> {
    const a = actorOf(req);
    const coord = has(a, 'coordinator', 'program_lead');
    const lead = has(a, 'program_lead');
    const staff = (await listStaff(ctx.db, a.orgId)).filter((s) => s.active);
    const responders = staff.filter((s) => s.roles.includes('responder'));
    const conflicts = await listConflicts(ctx.db, p.id);
    const hosts = (await listOrgs(ctx.db)).filter((o) => o.kind === 'host' && o.status === 'live' && o.id !== a.orgId);
    const st = p.state;
    const items: SafeHtml[] = [];
    items.push(html`<p>Print: <a href="/participants/${p.id}/print/card">card</a> (<a href="/participants/${p.id}/print/card?lang=es">es</a>) · <a href="/participants/${p.id}/print/summary">record summary</a> (<a href="/participants/${p.id}/print/summary?lang=es">es</a>) · <a href="/participants/${p.id}/print/access">who has looked</a> · <a href="/safeguarding">required report</a></p>`);
    if (st === 'active') {
      items.push(html`<details><summary>Pause</summary><form method="post" action="/participants/${p.id}/pause" class="stack">${csrfField(req)}<label>Until <input type="date" name="until" required></label>${remoteFields()}<button class="btn" type="submit">Pause</button></form></details>`);
    }
    if (st === 'paused') items.push(postButton(req, `/participants/${p.id}/resume`, 'End pause now'));
    if (['active', 'paused', 'transfer_pending'].includes(st)) {
      items.push(html`<details><summary>Withdraw</summary><p>Withdrawal is never refused or questioned. In person, it takes effect now. Remotely, outreach stops now and it takes effect when they confirm in person.</p>
<form method="post" action="/participants/${p.id}/withdraw" class="stack">${csrfField(req)}${remoteFields()}<label class="check"><input type="checkbox" name="keep" value="1"> Keep the record 90 days so they can rejoin (default: delete within 30 days)</label><button class="btn danger" type="submit">Record withdrawal</button></form></details>`);
    }
    if (st === 'withdrawal_pending') {
      items.push(html`${postButton(req, `/participants/${p.id}/withdraw/confirm`, 'They confirmed in person: withdraw')} ${postButton(req, `/participants/${p.id}/withdraw/cancel`, 'They said in person they did not mean it')}
${coord ? html`<form method="post" action="/participants/${p.id}/withdraw/review" class="row">${csrfField(req)}<input name="note" placeholder="Review note"><button class="btn" type="submit">Record review</button></form>` : ''}
${lead ? html`<form method="post" action="/participants/${p.id}/withdraw/end" class="row">${csrfField(req)}<input name="note" required placeholder="Reason (after ${POLICY.withdrawalPendingMaxDays} days only)"><button class="btn" type="submit">End enrollment as inactive</button></form>` : ''}`);
    }
    if (st === 'withdrawn' && coord) items.push(postButton(req, `/participants/${p.id}/reinstate`, 'They said in person they did not withdraw: reinstate'));
    if (['inactive', 'ended'].includes(st) && coord) {
      items.push(html`<details><summary>Restore enrollment</summary><form method="post" action="/participants/${p.id}/reactivate" class="stack">${csrfField(req)}<label>Why <input name="reason" required></label>${consentFields(null)}<button class="btn" type="submit">Restore</button></form></details>`);
    }
    if (coord && ['active', 'paused'].includes(st)) {
      items.push(html`<form method="post" action="/participants/${p.id}/responders" class="row">${csrfField(req)}<label>Primary <select name="primary"><option value="">—</option>${options(responders.map((s) => [s.id, s.display_name]), p.primary_responder_id)}</select></label>
<label>Backup <select name="backup"><option value="">—</option>${options(responders.map((s) => [s.id, s.display_name]), p.backup_responder_id)}</select></label><button class="btn" type="submit">Set responders</button></form>`);
    }
    if (has(a, 'enroller', 'coordinator', 'program_lead')) {
      items.push(html`<details><summary>Name, other names, verification</summary>
<form method="post" action="/participants/${p.id}/identity" class="stack">${csrfField(req)}<label>Name they want us to use <input name="preferredName"></label><label>Languages <input name="languages"></label><button class="btn" type="submit">Save</button></form>
<form method="post" action="/participants/${p.id}/lookup" class="row">${csrfField(req)}<select name="lookup">${options([['name', 'Find by name'], ['code_only', 'Find by code only']], p.lookup)}</select><button class="btn" type="submit">Save</button></form>
<form method="post" action="/participants/${p.id}/verification" class="row">${csrfField(req)}<label>New verification answer (in person only) <input name="answer" required autocomplete="off"></label><label>New keypad PIN <input name="pin" inputmode="numeric" maxlength="6" autocomplete="off"></label><button class="btn" type="submit">Reset</button></form>
<form method="post" action="/participants/${p.id}/phone-code" class="inline">${csrfField(req)}<button class="btn" type="submit">Text a code to confirm their phone</button></form>
<form method="post" action="/participants/${p.id}/phone-verify" class="row">${csrfField(req)}<input name="code" inputmode="numeric" placeholder="Code they read back"><button class="btn" type="submit">Confirm phone</button></form>
${postButton(req, `/participants/${p.id}/selfview-code`, 'Print a one-time self-view code')}
${req.org!.photos_enabled ? html`<form method="post" action="/participants/${p.id}/photo" enctype="multipart/form-data" class="row">${csrfField(req)}<input type="file" name="photo" accept="image/jpeg,image/png" required><button class="btn" type="submit">Upload photo</button></form>${postButton(req, `/participants/${p.id}/photo/delete`, 'Delete photo')}` : ''}</details>`);
      items.push(html`<details><summary>Staff they don't want to see their record</summary><ul>${conflicts.map((c) => html`<li>${c.display_name} (${c.source.replace('_', ' ')}) ${lead ? postButton(req, `/participants/${p.id}/conflicts/remove`, 'Remove', { staffId: c.staff_id }) : ''}</li>`)}</ul>
<form method="post" action="/participants/${p.id}/conflicts" class="row">${csrfField(req)}<select name="staffId">${options(staff.map((s) => [s.id, s.display_name]))}</select><button class="btn" type="submit">Exclude</button></form></details>`);
    }
    items.push(postButton(req, `/participants/${p.id}/conflicts/self`, 'I know this person outside work (declare a conflict)', {}, 'btn small'));
    if (coord) {
      items.push(html`<details><summary>Someone raised a concern</summary><p>Never confirm or deny that this person is enrolled to the person who raised it.</p><form method="post" action="/participants/${p.id}/concern" class="stack">${csrfField(req)}
<label>Who raised it <select name="source">${options([['family', 'Family'], ['friend', 'Friend'], ['other_org', 'Another organization'], ['other', 'Other']])}</select></label>
<label>Callback number, if they want a reply (deleted after 30 days) <input name="callback"></label>
<label class="check"><input type="checkbox" name="openCase" value="1"> Open a follow-up case now (only within the follow-up they agreed to)</label><button class="btn" type="submit">Record concern</button></form></details>`);
    }
    if (st === 'active' && hosts.length && has(a, 'enroller', 'coordinator', 'program_lead')) {
      items.push(html`<details><summary>Transfer to another organization</summary><form method="post" action="/participants/${p.id}/transfer" class="stack">${csrfField(req)}
<label>To <select name="toOrg">${options(hosts.map((h) => [h.id, h.name]))}</select></label><label class="check"><input type="checkbox" name="present" value="1" required> They asked in person, now</label>
<label class="check"><input type="checkbox" name="otherNames" value="1"> Include their other names</label><label class="check"><input type="checkbox" name="namedPeople" value="1"> Include the people they named (they re-confirmed each)</label><button class="btn" type="submit">Request transfer</button></form></details>`);
    }
    if (lead) items.push(html`<form method="post" action="/participants/${p.id}/legal-hold" class="row">${csrfField(req)}<label>Legal hold (counsel's reference; blank to clear) <input name="reference" value="${p.legal_hold ?? ''}"></label><button class="btn" type="submit">Save</button></form>`);
    return html`<section class="card"><h2>Actions</h2>${items}</section>`;
  }

  app.post('/participants/:id/reason', async (req, reply) => {
    await grantAccess(ctx, actorOf(req), pid(req), body(req).reason ?? '');
    return reply.redirect(back(pid(req)), 303);
  });

  app.get('/participants/:id/plan', async (req, reply) => {
    const a = actorOf(req);
    const p = await getParticipantRow(ctx.db, pid(req));
    const basis = await accessBasis(ctx.db, ctx, a, p, 'plan');
    if (!basis) return reply.redirect(back(p.id), 303);
    await logView(ctx, a, p.id, 'plan_edit', basis);
    const plan = await currentPlan(ctx.db, ctx, p.id);
    return render(req, reply, {
      title: 'Change plan',
      body: html`<h1>Change the contact plan</h1><form method="post" action="/participants/${p.id}/plan" class="stack">${csrfField(req)}${remoteFields()}
<p class="muted">Remote changes that reduce follow-up (longer interval, fewer follow-up steps, removing a person, a new phone number, more kinds that count) need a caller you know or the right verification answer, and are flagged until confirmed in person.</p>
${planFields({ ...plan, phone: plan.phone ?? '', phoneMessage: plan.phoneMessage ?? '', avoidTimes: plan.avoidTimes ?? '', usuallyFound: plan.usuallyFound ?? '', partnerMessage: plan.partnerMessage ?? '' })}
<button class="btn primary" type="submit">Save new version</button></form>`,
    });
  });

  app.post('/participants/:id/plan', async (req, reply) => {
    const b = body(req);
    const r = await changePlan(ctx, actorOf(req), pid(req), readPlan(req), { channel: b.channel === 'remote' ? 'remote' : 'in_person', identity: (b.identity ?? 'stated') as Confidence });
    flash(reply, 'ok', r.remoteFlag ? 'Saved and flagged as a remote change to confirm in person.' : 'Saved.');
    return reply.redirect(back(pid(req)), 303);
  });

  const simple = (path: string, fn: (req: FastifyRequest) => Promise<unknown>, msg: string) => {
    app.post(`/participants/:id/${path}`, async (req, reply) => {
      await fn(req);
      flash(reply, 'ok', msg);
      return reply.redirect(back(pid(req)), 303);
    });
  };
  simple('pause', (req) => {
    const b = body(req);
    if (!b.until) fail('Choose the end date.');
    return pause(ctx, actorOf(req), pid(req), { endsAt: zonedInput(`${b.until}T17:00`, req.org!.timezone), channel: b.channel === 'remote' ? 'remote' : 'in_person', identity: (b.identity ?? 'stated') as Confidence });
  }, 'Paused.');
  simple('resume', (req) => endPause(ctx, actorOf(req), pid(req)), 'Pause ended.');
  app.post('/participants/:id/withdraw', async (req, reply) => {
    const b = body(req);
    const r = await withdraw(ctx, actorOf(req), pid(req), { channel: b.channel === 'remote' ? 'remote' : 'in_person', identity: (b.identity ?? 'stated') as Confidence, keep: b.keep === '1' });
    flash(reply, 'ok', r === 'withdrawn' ? 'Withdrawn. Thank them; nothing else changes about the help they get here.' : 'All outreach has stopped. The withdrawal takes effect when they confirm it in person.');
    return reply.redirect(back(pid(req)), 303);
  });
  simple('withdraw/confirm', (req) => confirmWithdrawalInPerson(ctx, actorOf(req), pid(req)), 'Withdrawn.');
  simple('withdraw/cancel', (req) => cancelPendingWithdrawal(ctx, actorOf(req), pid(req)), 'Withdrawal cancelled. Record today’s contact too.');
  simple('withdraw/review', (req) => reviewPendingWithdrawal(ctx, actorOf(req), pid(req), body(req).note || null), 'Review recorded.');
  simple('withdraw/end', (req) => endLongPendingWithdrawal(ctx, actorOf(req), pid(req), body(req).note ?? ''), 'Enrollment ended as inactive.');
  simple('reinstate', (req) => reinstate(ctx, actorOf(req), pid(req)), 'Reinstated.');
  simple('reactivate', (req) => {
    const { consent, teachBack } = readConsent(req);
    return reactivate(ctx, actorOf(req), pid(req), { reason: body(req).reason ?? '', consent, teachBack });
  }, 'Enrollment restored.');
  simple('responders', (req) => setPrimaryBackup(ctx, actorOf(req), pid(req), body(req).primary || null, body(req).backup || null), 'Responders saved.');
  simple('identity', (req) => {
    const b = body(req);
    return updateIdentity(ctx, actorOf(req), pid(req), { ...(b.preferredName ? { preferredName: b.preferredName } : {}), ...(b.languages ? { languages: b.languages } : {}) });
  }, 'Saved.');
  simple('lookup', (req) => setLookup(ctx, actorOf(req), pid(req), body(req).lookup === 'code_only' ? 'code_only' : 'name'), 'Saved.');
  simple('verification', (req) => resetVerification(ctx, actorOf(req), pid(req), body(req).answer ?? '', body(req).pin || null), 'Verification reset.');
  simple('confirm-remote', (req) => confirmRemoteChanges(ctx, actorOf(req), pid(req)), 'Remote changes confirmed.');
  simple('told', (req) => markParticipantTold(ctx, actorOf(req), pid(req)), 'Recorded.');
  simple('conflicts', (req) => addConflict(ctx, actorOf(req), pid(req), body(req).staffId ?? '', 'participant_requested'), 'Excluded.');
  simple('conflicts/self', (req) => addConflict(ctx, actorOf(req), pid(req), actorOf(req).staffId, 'staff_declared'), 'Conflict declared. You can still record contacts.');
  simple('conflicts/remove', (req) => removeConflict(ctx, actorOf(req), pid(req), body(req).staffId ?? ''), 'Removed.');
  simple('concern', (req) => recordConcern(ctx, actorOf(req), pid(req), { source: (body(req).source ?? 'other') as never, callback: body(req).callback || null, openCaseNow: body(req).openCase === '1' }), 'Concern recorded.');
  simple('transfer', (req) => requestTransfer(ctx, actorOf(req), pid(req), body(req).toOrg ?? '', { includeOtherNames: body(req).otherNames === '1', includeNamedPeople: body(req).namedPeople === '1', participantPresent: body(req).present === '1' }), 'Transfer requested. You remain responsible until they accept.');
  simple('legal-hold', (req) => setLegalHold(ctx, actorOf(req), pid(req), body(req).reference || null), 'Saved.');
  simple('photo/delete', (req) => deletePhoto(ctx, actorOf(req), pid(req)), 'Photo deleted.');
  app.post('/participants/:id/phone-code', async (req, reply) => {
    const r = await sendPhoneCode(ctx, actorOf(req), pid(req));
    flash(reply, r === 'sent' ? 'ok' : 'error', r === 'sent' ? 'Code sent. Ask them to read it back.' : 'The code could not be sent (texting not set up, opted out, or failed).');
    return reply.redirect(back(pid(req)), 303);
  });
  app.post('/participants/:id/phone-verify', async (req, reply) => {
    const ok = await verifyPhoneCode(ctx, actorOf(req), pid(req), body(req).code ?? '');
    flash(reply, ok ? 'ok' : 'error', ok ? 'Phone confirmed.' : 'That code did not match.');
    return reply.redirect(back(pid(req)), 303);
  });
  app.post('/participants/:id/selfview-code', async (req, reply) => {
    const code = await issueSelfViewCode(ctx, actorOf(req), pid(req));
    return render(req, reply, { title: 'Self-view code', print: true, body: html`<h1>Your one-time code</h1><p class="big"><code>${code}</code></p><p>Go to ${ctx.config.publicUrl}/me within 7 days. You will need your participant code, your verification answer and this code. It works once.</p><p><a href="${back(pid(req))}">Back</a></p>` });
  });
  app.post('/participants/:id/photo', async (req, reply) => {
    const file = await req.file();
    if (!file) fail('Choose a photo.');
    await setPhoto(ctx, actorOf(req), pid(req), await file!.toBuffer());
    flash(reply, 'ok', 'Photo saved (metadata removed).');
    return reply.redirect(back(pid(req)), 303);
  });
  app.get('/participants/:id/photo', async (req, reply) => {
    const ph = await getPhoto(ctx, actorOf(req), pid(req));
    if (!ph) fail('No photo.', 404);
    return reply.type(ph!.mime).header('Cache-Control', 'no-store').send(ph!.data);
  });
  app.post('/contacts/:id/void', async (req, reply) => {
    await voidContact(ctx, actorOf(req), (req.params as { id: string }).id, body(req).reason ?? '');
    flash(reply, 'ok', 'Contact voided.');
    const backTo = body(req).back ?? '';
    return reply.redirect(/^\/(participants|cases)\/[0-9a-f-]{36}$/.test(backTo) ? backTo : '/', 303);
  });
}
