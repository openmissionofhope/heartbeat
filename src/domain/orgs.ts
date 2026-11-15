import type { Q } from '../db/index.js';
import { many, maybe, one, ts } from '../db/index.js';
import { type Hours, localDate } from '../lib/calendar.js';
import { normalizePhone } from '../lib/codes.js';
import { type Actor, type Ctx, audit, clampText, fail, requireRole } from './core.js';

export interface OrgRow {
  id: string;
  name: string;
  kind: 'host' | 'partner' | 'operator';
  status: 'setup' | 'live' | 'closed';
  timezone: string;
  day_start_min: number;
  day_end_min: number;
  work_days: number[];
  public_phone: string | null;
  sms_number: string | null;
  coordinator_id: string | null;
  deputy_id: string | null;
  program_lead_id: string | null;
  enrollment_paused: boolean;
  enrollment_pause_reason: string | null;
  hold_active: boolean;
  hold_reason: string | null;
  hold_started_at: Date | null;
  hold_confirmed_at: Date | null;
  photos_enabled: boolean;
  continuity_partner_id: string | null;
  committed_hours: string;
  police_nonemergency_phone: string | null;
  dss_adult_phone: string | null;
  dss_child_phone: string | null;
  created_at: Date;
}

/** Items that must be recorded before a host can enroll real participants (docs/11 Phase 0–1). */
export const READINESS_ITEMS = [
  { key: 'legal_review', label: 'Written answers from North Carolina counsel to every blocking item in docs/legal-review.md' },
  { key: 'host_agreement', label: 'Signed OMH–host agreement (data roles, purpose limits, retention, legal process, exit)' },
  { key: 'consent_materials', label: 'Consent conversation, card and summaries tested with people with lived experience' },
  { key: 'complaint_route', label: 'Participant complaint route to OMH that bypasses the host' },
  { key: 'staff_training', label: 'Training modules 1–8 completed for every role holder' },
  { key: 'tabletop', label: 'Tabletop exercises of every scenario in docs/06' },
  { key: 'disaster_drill', label: 'Paper disaster drill, including phone forwarding' },
  { key: 'restore_drill', label: 'Backup restore rehearsed within the last 90 days' },
  { key: 'security_review', label: 'Independent security review; findings fixed or accepted in writing' },
  { key: 'sms_registration', label: 'Text messaging: 10DLC brand and campaign registered, consent wording approved (or texting left off)' },
] as const;
export type ReadinessKey = (typeof READINESS_ITEMS)[number]['key'];

export async function getOrg(q: Q, id: string): Promise<OrgRow> {
  const o = await maybe<OrgRow>(q, 'SELECT * FROM organizations WHERE id = $1', [id]);
  if (!o) fail('Organization not found.', 404);
  return o!;
}

export async function listOrgs(q: Q): Promise<OrgRow[]> {
  return many<OrgRow>(q, 'SELECT * FROM organizations ORDER BY kind, name');
}

export async function hoursFor(q: Q, org: OrgRow): Promise<Hours> {
  const hol = await many<{ day: string }>(q, "SELECT to_char(day, 'YYYY-MM-DD') AS day FROM org_holidays WHERE org_id = $1", [org.id]);
  return { tz: org.timezone, startMin: org.day_start_min, endMin: org.day_end_min, days: org.work_days, holidays: new Set(hol.map((h) => h.day)) };
}

export async function createOrg(ctx: Ctx, actor: Actor | null, input: { name: string; kind: OrgRow['kind']; timezone?: string; publicPhone?: string }): Promise<OrgRow> {
  if (actor) requireRole(actor, 'operator');
  const name = clampText(input.name, 120) ?? fail('Name is required.');
  const tz = input.timezone ?? 'America/New_York';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    fail('Unknown time zone.');
  }
  return ctx.db.tx(async (q) => {
    const org = await one<OrgRow>(q,
      `INSERT INTO organizations (name, kind, timezone, public_phone, status, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, input.kind, tz, input.publicPhone ?? null, input.kind === 'operator' ? 'live' : 'setup', ts(ctx.clock.now())]);
    if (actor) await audit(q, ctx, actor, { action: 'org.create', targetType: 'organization', targetId: org.id, details: { kind: input.kind } });
    return org;
  });
}

export interface OrgSettings {
  name?: string;
  timezone?: string;
  dayStartMin?: number;
  dayEndMin?: number;
  workDays?: number[];
  publicPhone?: string | null;
  photosEnabled?: boolean;
  continuityPartnerId?: string | null;
  coordinatorId?: string | null;
  deputyId?: string | null;
  programLeadId?: string | null;
}

export async function updateOrgSettings(ctx: Ctx, actor: Actor, orgId: string, s: OrgSettings): Promise<void> {
  if (!(actor.orgId === orgId && actor.roles.has('program_lead')) && !actor.roles.has('operator')) fail('Only the program lead can change these settings.', 403);
  await ctx.db.tx(async (q) => {
    const org = await getOrg(q, orgId);
    const next = {
      name: s.name !== undefined ? (clampText(s.name, 120) ?? org.name) : org.name,
      timezone: s.timezone ?? org.timezone,
      start: s.dayStartMin ?? org.day_start_min,
      end: s.dayEndMin ?? org.day_end_min,
      days: s.workDays ?? org.work_days,
      phone: s.publicPhone === undefined ? org.public_phone : s.publicPhone ? (normalizePhone(s.publicPhone) ?? fail('Enter a valid phone number.')) : null,
      photos: s.photosEnabled ?? org.photos_enabled,
      partner: s.continuityPartnerId === undefined ? org.continuity_partner_id : s.continuityPartnerId,
      coordinator: s.coordinatorId === undefined ? org.coordinator_id : s.coordinatorId,
      deputy: s.deputyId === undefined ? org.deputy_id : s.deputyId,
      lead: s.programLeadId === undefined ? org.program_lead_id : s.programLeadId,
    };
    if (next.end <= next.start) fail('Staffed hours must end after they start.');
    if (!next.days.length || next.days.some((d) => d < 1 || d > 7)) fail('Choose at least one staffed day.');
    for (const [label, id, role] of [['Coordinator', next.coordinator, 'coordinator'], ['Deputy coordinator', next.deputy, 'coordinator'], ['Program lead', next.lead, 'program_lead']] as const) {
      if (!id) continue;
      const st = await maybe<{ org_id: string; roles: string[] }>(q, 'SELECT org_id, roles FROM staff WHERE id = $1 AND active', [id]);
      if (!st || st.org_id !== orgId || !st.roles.includes(role)) fail(`${label} must be an active staff member of this organization with the ${role.replace('_', ' ')} role.`);
    }
    if (next.partner) {
      const p = await getOrg(q, next.partner);
      if (p.id === orgId || p.kind === 'operator') fail('Choose another participating organization.');
    }
    await q.query(
      `UPDATE organizations SET name=$2, timezone=$3, day_start_min=$4, day_end_min=$5, work_days=$6, public_phone=$7, photos_enabled=$8,
         continuity_partner_id=$9, coordinator_id=$10, deputy_id=$11, program_lead_id=$12 WHERE id=$1`,
      [orgId, next.name, next.timezone, next.start, next.end, next.days, next.phone, next.photos, next.partner, next.coordinator, next.deputy, next.lead]);
    await audit(q, ctx, actor, { action: 'org.settings', targetType: 'organization', targetId: orgId, details: { fields: Object.keys(s) } });
  });
}

/** SMS numbers are assigned by the operator, because they are tied to carrier registration. */
export async function setSmsNumber(ctx: Ctx, actor: Actor, orgId: string, number: string | null): Promise<void> {
  requireRole(actor, 'operator');
  const n = number ? (normalizePhone(number) ?? fail('Enter a valid phone number.')) : null;
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE organizations SET sms_number = $2 WHERE id = $1', [orgId, n]);
    await audit(q, ctx, actor, { action: 'org.sms_number', targetType: 'organization', targetId: orgId });
  });
}

export async function setHolidays(ctx: Ctx, actor: Actor, orgId: string, days: { day: string; label?: string }[]): Promise<void> {
  if (!(actor.orgId === orgId && actor.roles.has('program_lead'))) fail('Only the program lead can set holidays.', 403);
  for (const d of days) if (!/^\d{4}-\d{2}-\d{2}$/.test(d.day)) fail(`Not a date: ${d.day}`);
  await ctx.db.tx(async (q) => {
    await q.query('DELETE FROM org_holidays WHERE org_id = $1', [orgId]);
    for (const d of days) await q.query('INSERT INTO org_holidays (org_id, day, label) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [orgId, d.day, d.label ?? null]);
    await audit(q, ctx, actor, { action: 'org.holidays', targetType: 'organization', targetId: orgId, details: { count: days.length } });
  });
}

// ---------------------------------------------------------------------------
// Readiness gate: a host stays in "setup" (training data only) until every item is recorded
// and an OMH operator approves going live.
// ---------------------------------------------------------------------------

export async function readiness(q: Q, orgId: string) {
  const done = await many<{ item: string; completed_at: Date; reference: string }>(q, 'SELECT item, completed_at, reference FROM org_readiness WHERE org_id = $1', [orgId]);
  const map = new Map(done.map((d) => [d.item, d]));
  return READINESS_ITEMS.map((i) => ({ ...i, done: map.get(i.key) ?? null }));
}

export async function recordReadiness(ctx: Ctx, actor: Actor, orgId: string, item: ReadinessKey, reference: string): Promise<void> {
  if (!(actor.orgId === orgId && actor.roles.has('program_lead')) && !actor.roles.has('operator')) fail('Only the program lead or an OMH operator can record readiness.', 403);
  if (!READINESS_ITEMS.some((i) => i.key === item)) fail('Unknown readiness item.');
  const ref = clampText(reference, 300) ?? fail('Give a reference (document, date, who).');
  await ctx.db.tx(async (q) => {
    await q.query(`INSERT INTO org_readiness (org_id, item, completed_at, completed_by, reference) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (org_id, item) DO UPDATE SET completed_at = EXCLUDED.completed_at, completed_by = EXCLUDED.completed_by, reference = EXCLUDED.reference`,
    [orgId, item, ts(ctx.clock.now()), actor.staffId, ref]);
    await audit(q, ctx, actor, { action: 'org.readiness', targetType: 'organization', targetId: orgId, details: { item } });
  });
}

export async function goLive(ctx: Ctx, actor: Actor, orgId: string): Promise<void> {
  requireRole(actor, 'operator');
  await ctx.db.tx(async (q) => {
    const org = await getOrg(q, orgId);
    if (org.kind === 'operator') fail('Not applicable.');
    if (org.status !== 'setup') fail('This organization is not in setup.');
    const items = await readiness(q, orgId);
    const missing = items.filter((i) => !i.done);
    if (missing.length) fail(`Not ready: ${missing.map((m) => m.label).join('; ')}.`);
    const restore = items.find((i) => i.key === 'restore_drill')!.done!;
    if (ctx.clock.now() - restore.completed_at.getTime() > 90 * 86_400_000) fail('The restore drill must be within the last 90 days.');
    if (org.kind === 'host' && (!org.coordinator_id || !org.deputy_id || !org.program_lead_id)) fail('Name a coordinator, deputy and program lead first.');
    const training = await one<{ n: string }>(q, 'SELECT count(*) AS n FROM participants WHERE org_id = $1 AND training', [orgId]);
    if (Number(training.n) > 0) fail('Delete the training participants before going live.');
    await q.query("UPDATE organizations SET status = 'live' WHERE id = $1", [orgId]);
    await audit(q, ctx, actor, { action: 'org.go_live', targetType: 'organization', targetId: orgId });
  });
}

export async function setEnrollmentPaused(ctx: Ctx, actor: Actor, paused: boolean, reason: string | null): Promise<void> {
  requireRole(actor, 'program_lead');
  const r = paused ? (clampText(reason, 300) ?? fail('Give a reason for pausing enrollment.')) : null;
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE organizations SET enrollment_paused = $2, enrollment_pause_reason = $3 WHERE id = $1', [actor.orgId, paused, r]);
    await audit(q, ctx, actor, { action: paused ? 'org.enrollment_pause' : 'org.enrollment_resume', targetType: 'organization', targetId: actor.orgId, reason: r });
  });
}

// ---------------------------------------------------------------------------
// Who is on duty
// ---------------------------------------------------------------------------

export interface StaffBrief {
  id: string;
  org_id: string;
  display_name: string;
  email: string;
  work_phone: string | null;
  roles: string[];
  active: boolean;
  out_from: string | null;
  out_to: string | null;
}

export async function staffBrief(q: Q, id: string | null): Promise<StaffBrief | null> {
  if (!id) return null;
  return maybe<StaffBrief>(q, "SELECT id, org_id, display_name, email, work_phone, roles, active, to_char(out_from,'YYYY-MM-DD') AS out_from, to_char(out_to,'YYYY-MM-DD') AS out_to FROM staff WHERE id = $1", [id]);
}

export function isAvailable(s: StaffBrief | null, now: number, tz: string): boolean {
  if (!s || !s.active) return false;
  if (s.out_from && s.out_to) {
    const today = localDate(now, tz);
    if (today >= s.out_from && today <= s.out_to) return false;
  }
  return true;
}

/** Coordinator on duty: the coordinator, else the deputy, else the program lead. */
export async function dutyChain(q: Q, org: OrgRow, now: number): Promise<{ coordinator: StaffBrief | null; deputy: StaffBrief | null; lead: StaffBrief | null; onDuty: StaffBrief | null }> {
  const coordinator = await staffBrief(q, org.coordinator_id);
  const deputy = await staffBrief(q, org.deputy_id);
  const lead = await staffBrief(q, org.program_lead_id);
  const onDuty = [coordinator, deputy, lead].find((s) => isAvailable(s, now, org.timezone)) ?? null;
  return { coordinator, deputy, lead, onDuty };
}
