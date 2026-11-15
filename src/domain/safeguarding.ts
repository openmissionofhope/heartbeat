import { many, maybe, one, ts } from '../db/index.js';
import { type Actor, type Ctx, audit, clampText, fail, has, requireRole } from './core.js';
import { notify } from './notifications.js';
import { dutyChain, getOrg, hoursFor } from './orgs.js';
import { getParticipantRow } from './participants.js';

/**
 * Required abuse reports — OMH policy decided 2026-11-15 (docs/safeguarding-reports.md):
 *   - abuse of a child: report to police and to county social services (child protective services);
 *   - intimate-partner abuse: report to police;
 *   - a disabled adult who needs protective services: report to county social services (adult
 *     protective services).
 * Never report anyone for possible immigration violations: there is no such category, and reports
 * must not mention immigration status.
 *
 * Staff make each report themselves, by phone. Heartbeat sends nothing to anyone; it shows who to
 * call and records only that the report was made, so a required report cannot be forgotten.
 */
export type ReportCategory = 'child_abuse' | 'intimate_partner_abuse' | 'disabled_adult';
export type Recipient = 'police' | 'dss_child' | 'dss_adult';

export const REQUIRED_RECIPIENTS: Record<ReportCategory, Recipient[]> = {
  child_abuse: ['police', 'dss_child'],
  intimate_partner_abuse: ['police'],
  disabled_adult: ['dss_adult'],
};

export const CATEGORY_LABEL: Record<ReportCategory, string> = {
  child_abuse: 'Abuse or neglect of a child',
  intimate_partner_abuse: 'Abuse by an intimate partner',
  disabled_adult: 'A disabled adult who needs protective services',
};

export const RECIPIENT_LABEL: Record<Recipient, string> = {
  police: 'Police (local law enforcement)',
  dss_child: 'County social services — child protective services intake',
  dss_adult: 'County social services — adult protective services intake',
};

export const NEVER_REPORT = 'Never report anyone for possible immigration violations, and never mention immigration status in a report.';

/** Records that a required report is needed; returns the recipients to call. */
export async function identifyRequiredReport(ctx: Ctx, actor: Actor, input: { category: ReportCategory; participantId?: string | null; caseId?: string | null }): Promise<{ ids: string[]; recipients: { recipient: Recipient; phone: string | null }[] }> {
  if (!has(actor, 'recorder', 'enroller', 'responder', 'coordinator', 'program_lead', 'steward')) fail('You do not have permission to do that.', 403);
  const recipients = REQUIRED_RECIPIENTS[input.category];
  if (!recipients) fail('Choose what kind of report is required.');
  const now = ctx.clock.now();
  return ctx.db.tx(async (q) => {
    const org = await getOrg(q, actor.orgId);
    if (input.participantId) {
      const p = await getParticipantRow(q, input.participantId);
      if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    }
    const ids: string[] = [];
    for (const r of recipients) {
      const row = await one<{ id: string }>(q,
        `INSERT INTO safeguarding_reports (org_id, participant_id, case_id, category, recipient, identified_by, identified_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [org.id, input.participantId ?? null, input.caseId ?? null, input.category, r, actor.staffId, ts(now)]);
      ids.push(row.id);
    }
    await audit(q, ctx, actor, { action: 'safeguarding.identified', targetType: 'organization', targetId: org.id, participantId: input.participantId ?? null, details: { category: input.category } });
    const phone = (r: Recipient) => (r === 'police' ? org.police_nonemergency_phone : r === 'dss_child' ? org.dss_child_phone : org.dss_adult_phone);
    return { ids, recipients: recipients.map((r) => ({ recipient: r, phone: phone(r) })) };
  });
}

export async function recordReportMade(ctx: Ctx, actor: Actor, reportId: string, input: { madeAt?: number; reference?: string | null }): Promise<void> {
  const ref = clampText(input.reference, 80);
  if (ref && /immigra|ice\b|citizen|undocumented|visa/i.test(ref)) fail(NEVER_REPORT);
  await ctx.db.tx(async (q) => {
    const r = await maybe<{ id: string; org_id: string; made_at: Date | null; participant_id: string | null }>(q, 'SELECT id, org_id, made_at, participant_id FROM safeguarding_reports WHERE id = $1 FOR UPDATE', [reportId]);
    if (!r || r.org_id !== actor.orgId) fail('Report not found.', 404);
    if (r!.made_at) fail('This report is already recorded as made.');
    const at = input.madeAt ?? ctx.clock.now();
    if (at > ctx.clock.now() + 60_000) fail('The time cannot be in the future.');
    await q.query('UPDATE safeguarding_reports SET made_by = $2, made_at = $3, reference = $4, delete_after = $5 WHERE id = $1',
      [r!.id, actor.staffId, ts(at), ref, ts(ctx.clock.now() + 730 * 86_400_000)]);
    await audit(q, ctx, actor, { action: 'safeguarding.made', targetType: 'safeguarding_report', targetId: r!.id, participantId: r!.participant_id });
  });
}

export async function outstandingReports(ctx: Ctx, actor: Actor) {
  requireRole(actor, 'coordinator', 'program_lead', 'responder', 'enroller', 'recorder');
  return many<{ id: string; category: ReportCategory; recipient: Recipient; identified_at: Date; identified_by: string; display_name: string; participant_id: string | null }>(ctx.db,
    `SELECT r.id, r.category, r.recipient, r.identified_at, r.identified_by, s.display_name, r.participant_id FROM safeguarding_reports r JOIN staff s ON s.id = r.identified_by
      WHERE r.org_id = $1 AND r.made_at IS NULL AND (r.identified_by = $2 OR $3) ORDER BY r.identified_at`,
    [actor.orgId, actor.staffId, has(actor, 'coordinator', 'program_lead')]);
}

/** Scheduler: a required report not recorded as made within 2 staffed hours reaches the coordinator, then the program lead. */
export async function remindOutstandingReports(ctx: Ctx, orgId: string): Promise<void> {
  const org = await getOrg(ctx.db, orgId);
  const h = await hoursFor(ctx.db, org);
  const { addBusinessDays } = await import('./cases.js');
  const { addBusinessMinutes } = await import('../lib/calendar.js');
  const now = ctx.clock.now();
  const rows = await many<{ id: string; identified_at: Date; identified_by: string }>(ctx.db, 'SELECT id, identified_at, identified_by FROM safeguarding_reports WHERE org_id = $1 AND made_at IS NULL', [orgId]);
  for (const r of rows) {
    await ctx.db.tx(async (q) => {
      const t = r.identified_at.getTime();
      if (now >= addBusinessMinutes(t, 120, h)) {
        const duty = await dutyChain(q, org, now);
        await notify(q, ctx, { staffId: duty.onDuty?.id, orgId, kind: 'safeguarding_outstanding', dedupeKey: `sg:${r.id}` });
      }
      if (now >= addBusinessDays(t, 1, h)) await notify(q, ctx, { staffId: org.program_lead_id, orgId, kind: 'safeguarding_outstanding', dedupeKey: `sgpl:${r.id}` });
    });
  }
}
