import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '../domain/core.js';
import type { OrgRow } from '../domain/orgs.js';
import { type SafeHtml, html, raw } from '../lib/html.js';

export const SITE = { name: 'OMH Heartbeat', repo: 'https://github.com/openmissionofhope/heartbeat' };

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    org: OrgRow | null;
    sessionHash: string | null;
    mfaOk: boolean;
    csrf: string;
  }
}

export interface PageOptions {
  title: string;
  body: SafeHtml;
  /** Printable pages: no navigation. */
  print?: boolean;
  lang?: 'en' | 'es';
  scripts?: string[];
}

let demoMode = false;
/** Set once at startup: demo deployments show a warning on every page. */
export function setDemoMode(on: boolean): void {
  demoMode = on;
}

export function render(req: FastifyRequest, reply: FastifyReply, o: PageOptions, status = 200): FastifyReply {
  const flashRaw = req.cookies.hb_flash;
  if (flashRaw) reply.clearCookie('hb_flash', { path: '/' });
  let flash: { k: string; t: string } | null = null;
  try {
    flash = flashRaw ? (JSON.parse(Buffer.from(flashRaw, 'base64url').toString('utf8')) as { k: string; t: string }) : null;
  } catch {
    flash = null;
  }
  reply.header('X-Robots-Tag', 'noindex, nofollow');
  return reply.code(status).type('text/html; charset=utf-8').send(layout(req, o, flash).value);
}

export function flash(reply: FastifyReply, kind: 'ok' | 'error', text: string): void {
  reply.setCookie('hb_flash', Buffer.from(JSON.stringify({ k: kind, t: text.slice(0, 400) })).toString('base64url'), { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 });
}

function nav(req: FastifyRequest): SafeHtml {
  const a = req.actor;
  if (!a || !req.mfaOk) return html``;
  const r = a.roles;
  const links: [string, string, boolean][] = [
    ['/', 'Home', true],
    ['/record', 'Record contact', r.has('recorder') || r.has('enroller') || r.has('responder') || r.has('coordinator') || r.has('program_lead')],
    ['/participants', 'Participants', r.has('enroller') || r.has('coordinator') || r.has('program_lead')],
    ['/participants/new', 'Enroll', r.has('enroller') || r.has('coordinator') || r.has('program_lead')],
    ['/safeguarding', 'Required reports', a.orgKind === 'host'],
    ['/hold', 'Roll call', r.has('coordinator') || r.has('program_lead')],
    ['/transfers', 'Transfers', r.has('coordinator') || r.has('program_lead')],
    ['/relay', 'Relay', r.has('relay')],
    ['/continuity', 'Continuity', r.has('steward') || r.has('program_lead')],
    ['/admin', 'Admin', r.has('program_lead')],
    ['/operator', 'Operator', r.has('operator')],
    ['/account', 'Account', true],
  ];
  return html`<nav aria-label="Main">${links.filter((l) => l[2]).map(([href, label]) => html`<a href="${href}">${label}</a>`)}
<form method="post" action="/logout" class="inline">${csrfField(req)}<button class="linklike" type="submit">Sign out</button></form></nav>`;
}

function banner(req: FastifyRequest): SafeHtml {
  const o = req.org;
  if (!o || !req.mfaOk) return html``;
  const items: SafeHtml[] = [];
  if (o.kind === 'host' && o.status === 'setup') items.push(html`<p><strong>Training mode.</strong> This organization has not completed its readiness checks (including legal review). Use made-up participants only.</p>`);
  if (o.hold_active) items.push(html`<p><strong>Escalation hold is on</strong> (${o.hold_reason}). Individual overdue cases are paused; use the <a href="/hold">roll call</a>.</p>`);
  if (o.enrollment_paused) items.push(html`<p><strong>New enrollment is paused:</strong> ${o.enrollment_pause_reason}</p>`);
  return items.length ? html`<div class="banner" role="status">${items}</div>` : html``;
}

function layout(req: FastifyRequest, o: PageOptions, f: { k: string; t: string } | null): SafeHtml {
  return html`<!doctype html>
<html lang="${o.lang ?? 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${o.title} · ${SITE.name}</title>
<link rel="stylesheet" href="/static/css/styles.css">
<link rel="manifest" href="/static/manifest.webmanifest">
${(o.scripts ?? []).map((s) => html`<script src="${s}" defer></script>`)}
</head>
<body class="${o.print ? 'print' : ''}">
${demoMode ? html`<div class="demo" role="note"><strong>Demo.</strong> Made-up information only — do not enter anything about real people. This demo does not send texts or emails.</div>` : ''}
${o.print ? '' : html`<a class="skip" href="#main">Skip to content</a>
<header class="site"><a class="brand" href="/"><b>Heartbeat</b> <small>${req.org?.name ?? 'Open Mission of Hope'}</small></a>${nav(req)}</header>
${banner(req)}`}
<main id="main" tabindex="-1">
${f ? html`<div class="flash flash-${f.k === 'error' ? 'error' : 'ok'}" role="${f.k === 'error' ? 'alert' : 'status'}">${f.t}</div>` : ''}
${o.body}
</main>
${o.print ? '' : html`<footer class="site"><p>Heartbeat is not emergency help. In an emergency, call 911. A recorded contact is not proof that anyone is safe.</p>
<p>A service of <a href="https://openmissionofhope.org">Open Mission of Hope</a> · <a href="${SITE.repo}">Source code</a></p></footer>`}
</body>
</html>`;
}

export function csrfField(req: FastifyRequest): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${req.csrf}">`;
}

export function postButton(req: FastifyRequest, action: string, label: string, fields: Record<string, string> = {}, cls = 'btn'): SafeHtml {
  return html`<form method="post" action="${action}" class="inline">${csrfField(req)}${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button type="submit" class="${cls}">${label}</button></form>`;
}

export function options(values: [string, string][], selected?: string | null): SafeHtml {
  return html`${values.map(([v, l]) => html`<option value="${v}"${v === selected ? raw(' selected') : ''}>${l}</option>`)}`;
}

export function checked(b: boolean | undefined | null): SafeHtml {
  return b ? raw(' checked') : raw('');
}

// ---------------------------------------------------------------------------
// Words. Language guardrails (HB-UI-1): status and contact are never described as "safe",
// "OK", "fine", "alive", "accounted for", or an all-clear.
// ---------------------------------------------------------------------------

export const KIND_LABEL: Record<string, string> = {
  in_person: 'in person',
  phone_with_staff: 'phone call with staff',
  relay: 'relay from a partner',
  self_check_in: 'self-check-in',
  secondhand: 'secondhand report',
};

export const CONFIDENCE_LABEL: Record<string, string> = {
  known: 'known to staff',
  verified: 'verification answer given',
  code_only: 'code only',
  stated: 'said who they were',
  reported: 'reported by someone else',
};

export const PSTATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  withdrawal_pending: 'Withdrawal pending in-person confirmation',
  withdrawn: 'Withdrawn',
  transfer_pending: 'Transfer pending',
  transferred: 'Transferred',
  inactive: 'Enrollment ended after extended follow-up',
  ended: 'Enrollment ended',
};

export const CSTATE_LABEL: Record<string, string> = {
  offered: 'Offered — waiting for acceptance',
  uncovered: 'UNCOVERED — nobody responsible',
  accepted: 'Accepted — follow-up in progress',
  stalled: 'Stalled — no recent action',
  extended_watch: 'Extended watch',
  contact_reported: 'Contact reported — owner to confirm',
  closed: 'Closed',
};

export const CLOSURE_LABEL: Record<string, string> = {
  contact_restored: 'Contact restored',
  contact_restored_self_report: 'Contact restored (self-check-in reviewed)',
  recording_gap: 'Recording gap (contact had happened but was entered late)',
  withdrawn: 'Participant withdrew',
  transferred: 'Transferred to another organization',
  reported_deceased: 'Reported deceased (listed source, two-person approval)',
  ended_after_extended_follow_up: 'Ended after extended follow-up — not a determination that the person has died or is well',
  other_documented: 'Other documented outcome',
};

export const FORBIDDEN_STATUS_WORDS = [/\bsafe\b/i, /\bOK\b/, /\bfine\b/i, /\balive\b/i, /accounted for/i, /all clear/i];

export function lastContactText(at: Date | null, kind: string | null, confidence: string | null, tz: string): string {
  if (!at) return 'No recorded contact yet';
  return `Last recorded contact: ${fmtDate(at, tz)} (${KIND_LABEL[kind ?? ''] ?? kind}, ${CONFIDENCE_LABEL[confidence ?? ''] ?? confidence})`;
}

export function fmtDate(d: Date | number | null | undefined, tz: string, withTime = true): string {
  if (d === null || d === undefined) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(new Date(d));
}

export function ago(d: Date | number | null | undefined, now: number): string {
  if (d === null || d === undefined) return '—';
  const ms = now - new Date(d).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return 'under an hour';
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

export function errorPage(message: string): SafeHtml {
  return html`<h1>Something needs attention</h1><p class="lead">${message}</p><p><a href="/">Home</a></p>`;
}
