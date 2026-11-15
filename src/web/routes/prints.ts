import type { FastifyInstance, FastifyRequest } from 'fastify';
import { many } from '../../db/index.js';
import { type Ctx, audit, fail, has, requireRole } from '../../domain/core.js';
import { currentPlan, getParticipantRow, latestConsent, summarize } from '../../domain/participants.js';
import { accessSummary } from '../../domain/selfview.js';
import { formatParticipantCode } from '../../lib/codes.js';
import { html } from '../../lib/html.js';
import { type RouteDeps, actorOf, query } from '../app.js';
import { fmtDate, render } from '../ui.js';

type Lang = 'en' | 'es';
const T = {
  en: {
    card: 'Heartbeat card', code: 'Your code', keypad: 'Phone check-in number', call: 'Call', hours: 'Hours',
    notEmergency: 'This is not emergency help. In an emergency, call 911.', stop: 'To stop at any time, tell any staff member or call us.',
    summary: 'What we keep about you', name: 'Name we use', other: 'Other names', interval: 'We expect to be in touch at least every', days: 'days',
    counts: 'What counts as contact', followup: 'If we don’t hear from you, we may', people: 'People we may ask', none: 'Nobody', lastContact: 'Last time we recorded contact',
    notKept: 'We do not keep where you go, immigration information, ID numbers or health records.', see: 'You can ask to see who has looked at your record.',
    access: 'Who has looked at or changed your record', when: 'Day', who: 'Who', what: 'What', times: 'Times',
    fu: { records: 'check our records and ask our staff', phone: 'call or text your phone', places: 'look for you where you said you are usually found', people: 'ask the people you named', partners: 'give partner organizations your message' } as Record<string, string>,
    kinds: { in_person: 'seeing you here', phone_with_staff: 'a phone call with staff', relay: 'a visit to a partner organization with your code', self_check_in: 'your text or keypad check-in' } as Record<string, string>,
  },
  es: {
    card: 'Tarjeta Heartbeat', code: 'Su código', keypad: 'Número para registrarse por teléfono', call: 'Llame al', hours: 'Horario',
    notEmergency: 'Esto no es ayuda de emergencia. En una emergencia, llame al 911.', stop: 'Para dejar de participar en cualquier momento, dígaselo a cualquier miembro del personal o llámenos.',
    summary: 'Lo que guardamos sobre usted', name: 'Nombre que usamos', other: 'Otros nombres', interval: 'Esperamos saber de usted al menos cada', days: 'días',
    counts: 'Lo que cuenta como contacto', followup: 'Si no sabemos de usted, podemos', people: 'Personas a quienes podemos preguntar', none: 'Nadie', lastContact: 'Última vez que registramos contacto',
    notKept: 'No guardamos a dónde va, información de inmigración, números de identificación ni expedientes médicos.', see: 'Puede pedir ver quién ha consultado su expediente.',
    access: 'Quién ha consultado o cambiado su expediente', when: 'Día', who: 'Quién', what: 'Qué', times: 'Veces',
    fu: { records: 'revisar nuestros registros y preguntar a nuestro personal', phone: 'llamar o enviar mensajes a su teléfono', places: 'buscarle donde dijo que suele estar', people: 'preguntar a las personas que nombró', partners: 'dar su mensaje a organizaciones asociadas' } as Record<string, string>,
    kinds: { in_person: 'verle aquí', phone_with_staff: 'una llamada con el personal', relay: 'una visita a una organización asociada con su código', self_check_in: 'su mensaje o registro por teléfono' } as Record<string, string>,
  },
};

async function printable(ctx: Ctx, req: FastifyRequest, id: string, what: string) {
  const a = actorOf(req);
  requireRole(a, 'enroller', 'coordinator', 'program_lead', 'responder');
  const p = await getParticipantRow(ctx.db, id);
  if (p.org_id !== a.orgId) fail('Participant not found.', 404);
  await ctx.db.tx((q) => audit(q, ctx, a, { action: `print.${what}`, targetType: 'participant', targetId: p.id, participantId: p.id }));
  return p;
}

export async function printRoutes(app: FastifyInstance, { ctx }: RouteDeps) {
  const lang = (req: FastifyRequest): Lang => (query(req).lang === 'es' ? 'es' : 'en');

  app.get('/participants/:id/print/card', async (req, reply) => {
    const p = await printable(ctx, req, (req.params as { id: string }).id, 'card');
    const org = req.org!;
    const t = T[lang(req)];
    const plan = await currentPlan(ctx.db, ctx, p.id);
    return render(req, reply, { title: t.card, print: true, lang: lang(req), body: html`<div class="pcard"><h1>${org.name}</h1>
<p>${t.code}: <strong><code>${formatParticipantCode(p.code)}</code></strong></p>
${plan.keypadCheckins && p.phone_checkin_id ? html`<p>${t.keypad}: <strong>${p.phone_checkin_id}</strong> → ${org.sms_number ?? ''}</p>` : ''}
<p>${t.call} ${org.public_phone ?? ''}. ${t.hours}: ${hoursLine(org)}</p><p><strong>${t.notEmergency}</strong></p><p>${t.stop}</p></div>` });
  });

  app.get('/participants/:id/print/summary', async (req, reply) => {
    const p = await printable(ctx, req, (req.params as { id: string }).id, 'summary');
    const org = req.org!;
    const t = T[lang(req)];
    const s = await summarize(ctx, p);
    const plan = await currentPlan(ctx.db, ctx, p.id);
    const consent = await latestConsent(ctx.db, p.id);
    return render(req, reply, { title: t.summary, print: true, lang: lang(req), body: html`<h1>${t.summary}</h1><p>${org.name} · ${fmtDate(ctx.clock.now(), org.timezone, false)}</p>
<dl><dt>${t.name}</dt><dd>${s.name}</dd><dt>${t.other}</dt><dd>${s.otherNames.map((o) => o.name).join(', ') || '—'}</dd>
<dt>${t.code}</dt><dd>${formatParticipantCode(s.code)}</dd>
<dt>${t.interval}</dt><dd>${plan.intervalDays} ${t.days}</dd>
<dt>${t.counts}</dt><dd>${plan.qualifyingKinds.map((k) => t.kinds[k]).join('; ')}</dd>
<dt>${t.followup}</dt><dd>${plan.followup.map((f) => t.fu[f]).join('; ')}</dd>
<dt>${t.people}</dt><dd>${plan.namedPeople.map((n) => `${n.name} (${n.phone}): “${n.message}”`).join('; ') || t.none}</dd>
<dt>Phone</dt><dd>${plan.phone ?? '—'}</dd><dt>${t.lastContact}</dt><dd>${fmtDate(s.lastQualifyingAt, org.timezone)}</dd>
<dt>Choices</dt><dd>${Object.entries(consent).filter(([, v]) => v).map(([k]) => k).join(', ') || '—'}</dd></dl>
<p>${t.notKept}</p><p>${t.see}</p><p><strong>${t.notEmergency}</strong></p><p>${t.stop}</p>` });
  });

  app.get('/participants/:id/print/access', async (req, reply) => {
    const p = await printable(ctx, req, (req.params as { id: string }).id, 'access');
    const t = T[lang(req)];
    const rows = await accessSummary(ctx, p.id);
    return render(req, reply, { title: t.access, print: true, lang: lang(req), body: html`<h1>${t.access}</h1>
<table><thead><tr><th>${t.when}</th><th>${t.who}</th><th>${t.what}</th><th>${t.times}</th></tr></thead><tbody>${rows.map((r) => html`<tr><td>${r.day}</td><td>${r.role_org}</td><td>${r.action}</td><td>${r.n}</td></tr>`)}</tbody></table>
<p class="muted">Names of individual staff are available on request through the program lead.</p>` });
  });

  // Continuity sheet (HB-DR-2): logged with a count; only fields each participant allowed.
  app.get('/print/continuity', async (req, reply) => {
    const a = actorOf(req);
    if (!has(a, 'coordinator', 'program_lead')) fail('Only coordinators print the continuity sheet.', 403);
    const org = req.org!;
    const ids = await many<{ id: string }>(ctx.db, "SELECT id FROM participants WHERE org_id = $1 AND state IN ('active','paused','withdrawal_pending','transfer_pending')", [org.id]);
    const rows = [];
    for (const { id } of ids) {
      const p = await getParticipantRow(ctx.db, id);
      const s = await summarize(ctx, p);
      const plan = await currentPlan(ctx.db, ctx, id);
      rows.push({ s, plan, withdrawal: p.state === 'withdrawal_pending' });
    }
    rows.sort((x, y) => Number(y.plan.disasterPriority) - Number(x.plan.disasterPriority) || (x.s.lastQualifyingAt?.getTime() ?? 0) - (y.s.lastQualifyingAt?.getTime() ?? 0));
    await ctx.db.tx((q) => audit(q, ctx, a, { action: 'print.continuity_sheet', targetType: 'organization', targetId: org.id, details: { count: rows.length } }));
    return render(req, reply, { title: 'Continuity sheet', print: true, body: html`<h1>Continuity sheet — ${org.name}</h1>
<p>Printed ${fmtDate(ctx.clock.now(), org.timezone)}. Keep locked. Shred the previous copy. Recorded contacts are not proof of safety.</p>
<table class="dense"><thead><tr><th>Code</th><th>Name</th><th>Last contact</th><th>Priority</th><th>Usually found (if allowed)</th><th>People who may be asked (if allowed)</th></tr></thead><tbody>
${rows.map(({ s, plan, withdrawal }) => html`<tr><td>${formatParticipantCode(s.code)}</td><td>${s.name}${withdrawal ? ' (withdrawal pending: no outreach)' : ''}</td><td>${fmtDate(s.lastQualifyingAt, org.timezone, false)}</td>
<td>${plan.disasterPriority ? 'yes' : ''}</td><td>${!withdrawal && plan.followup.includes('places') ? plan.usuallyFound ?? '' : ''}</td><td>${!withdrawal && plan.followup.includes('people') ? plan.namedPeople.map((n) => `${n.name} ${n.phone}: “${n.message}”`).join('; ') : ''}</td></tr>`)}</tbody></table>` });
  });

  // Paper fallback forms (HB-DR-4).
  app.get('/print/forms', async (req, reply) => {
    const org = req.org!;
    const lines = (n: number) => html`${Array.from({ length: n }, () => html`<tr>${Array.from({ length: 6 }, () => html`<td>&nbsp;</td>`)}</tr>`)}`;
    return render(req, reply, { title: 'Paper forms', print: true, body: html`<h1>Heartbeat paper contact log — ${org.name}</h1>
<p>Use when Heartbeat cannot be reached. Enter every line into Heartbeat within 3 business days with the real date and time, then shred this sheet. Never write where the person was.</p>
<table class="paper"><thead><tr><th>Date and time it happened</th><th>Participant code</th><th>Name</th><th>Kind (in person / phone / message / secondhand)</th><th>How you knew it was them (know them / answer / code / said so / reported)</th><th>Your name</th></tr></thead><tbody>${lines(18)}</tbody></table>
<h1 class="pagebreak">Heartbeat paper follow-up log</h1>
<table class="paper"><thead><tr><th>Date and time</th><th>Participant code</th><th>What you did</th><th>Result (nothing / lead / in contact / impossible)</th><th>How sure (low / medium / high)</th><th>Your name</th></tr></thead><tbody>${lines(18)}</tbody></table>
<h2>Running Heartbeat on paper</h2><ol><li>The coordinator declares escalation hold as soon as Heartbeat or the building is unavailable (by phone with the program lead if needed).</li>
<li>Forward the card phone number to the on-duty phone.</li><li>Work the continuity sheet top to bottom: disaster priority first, then longest since contact.</li>
<li>Record every contact here. If anyone is in immediate danger, call 911. Abuse that must be reported is reported by phone as usual.</li><li>When Heartbeat is back, enter these lines and shred the sheets.</li></ol>` });
  });
}

function hoursLine(org: { work_days: number[]; day_start_min: number; day_end_min: number }): string {
  const f = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}${m < 720 ? 'am' : 'pm'}`;
  const days = org.work_days.join(',') === '1,2,3,4,5' ? 'Mon–Fri' : org.work_days.map((d) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join(', ');
  return `${days} ${f(org.day_start_min)}–${f(org.day_end_min)}`;
}
