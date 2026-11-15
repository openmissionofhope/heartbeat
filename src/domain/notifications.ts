import type { Q } from '../db/index.js';
import { many, maybe, ts } from '../db/index.js';
import type { Ctx } from './core.js';

/**
 * Staff notifications carry no participant details (docs/03 §3.7 step 6): every message says
 * only that something needs attention and links to sign in. The task queue, not these messages,
 * is the source of truth.
 */
export const NOTICE_TEXT: Record<string, string> = {
  offer: 'You have a Heartbeat follow-up task waiting for you to accept.',
  escalated: 'A Heartbeat follow-up task has been passed to you because it was not accepted in time.',
  uncovered: 'A Heartbeat follow-up task has nobody responsible for it. Please sign in and make sure someone accepts it.',
  stalled: 'A Heartbeat follow-up task has had no recorded action within the expected time.',
  stall_reassigned: 'A stalled Heartbeat follow-up task was passed to a backup.',
  contact_reported: 'A contact was recorded on a Heartbeat follow-up task you own. Please confirm it was the right person.',
  confirm_late: 'A recorded contact on a Heartbeat follow-up task has not been confirmed.',
  review_due: 'A Heartbeat case in extended watch is due for review.',
  review_late: 'A Heartbeat extended-watch review is overdue.',
  withdrawal_review: 'A pending Heartbeat withdrawal is due for review.',
  withdrawal_review_late: 'A pending Heartbeat withdrawal review is overdue.',
  withdrawal_seen: 'A participant with a pending withdrawal was seen in person. Please confirm the withdrawal with them privately.',
  remote_change_seen: 'A participant with a plan change made remotely was seen in person. Please confirm the change with them privately.',
  inactive_returned: 'Someone whose Heartbeat enrollment ended without contact has been seen again. Please speak with them about re-enrolling.',
  ended_returned: 'A contact was recorded for someone whose Heartbeat enrollment had ended. Please review the record.',
  verification_locked: 'A Heartbeat participant’s verification answer was entered wrongly too many times and is locked for 24 hours.',
  remote_request_unverified: 'A remote request to reduce a participant’s Heartbeat follow-up could not be verified and was not applied.',
  concern: 'A concern was recorded about a Heartbeat participant.',
  transfer_request: 'A Heartbeat transfer request is waiting for your organization to accept or decline.',
  transfer_expired: 'A Heartbeat transfer request expired without being accepted.',
  closure_approval: 'A Heartbeat case closure is waiting for your approval.',
  closure_second_review: 'A Heartbeat case closure needs a second reviewer.',
  backdate_approval: 'A Heartbeat contact entered more than 72 hours late needs your approval.',
  breakglass: 'An OMH operator used break-glass access to your organization’s Heartbeat data.',
  hold_confirm: 'Heartbeat escalation hold is on. Please confirm it should continue.',
  hold_unconfirmed: 'Heartbeat escalation hold has not been reconfirmed. Please sign in.',
  host_silence: 'A Heartbeat host organization may be unable to operate: cases are uncovered or no staff have signed in. Please phone the program lead.',
  continuity_request: 'A continuity partner has asked to activate Heartbeat continuity access for your organization.',
  continuity_active: 'Heartbeat continuity access is active for your organization.',
  enrollment_indicator: 'A Heartbeat enrollment-pause indicator has been reached. Please review the dashboard.',
  sms_failed: 'Heartbeat could not send a text message. Please check the dashboard.',
  safeguarding_outstanding: 'A required abuse report has not yet been recorded as made. Please make sure it is made now.',
  pause_expiring: 'A Heartbeat pause ends soon.',
};

export interface NotifyInput {
  staffId?: string | null;
  operatorEmail?: string;
  orgId?: string | null;
  caseId?: string | null;
  kind: keyof typeof NOTICE_TEXT | 'digest';
  dedupeKey?: string;
  /** Pre-rendered body for digests (counts only). */
  digestText?: string;
}

export async function notify(q: Q, ctx: Ctx, n: NotifyInput): Promise<void> {
  if (!n.staffId && !n.operatorEmail) return;
  const now = ts(ctx.clock.now());
  const sms = n.staffId ? await maybe<{ notify_sms: boolean; work_phone: string | null }>(q, 'SELECT notify_sms, work_phone FROM staff WHERE id = $1 AND active', [n.staffId]) : null;
  if (n.staffId && !sms) return;
  const kind = n.kind === 'digest' ? `digest:${n.digestText ?? ''}` : n.kind;
  await q.query(
    `INSERT INTO notifications (staff_id, operator_email, org_id, case_id, kind, channel, dedupe_key, created_at) VALUES ($1,$2,$3,$4,$5,'email',$6,$7)
     ON CONFLICT DO NOTHING`,
    [n.staffId ?? null, n.operatorEmail ?? null, n.orgId ?? null, n.caseId ?? null, kind, n.dedupeKey ?? null, now]);
  if (sms?.notify_sms && sms.work_phone && n.kind !== 'digest') {
    await q.query(
      `INSERT INTO notifications (staff_id, org_id, case_id, kind, channel, dedupe_key, created_at) VALUES ($1,$2,$3,$4,'sms',$5,$6) ON CONFLICT DO NOTHING`,
      [n.staffId, n.orgId ?? null, n.caseId ?? null, kind, n.dedupeKey ? `${n.dedupeKey}:sms` : null, now]);
  }
}

/** Sends pending notifications. Failures are recorded and retried up to five times. */
export async function deliverNotifications(ctx: Ctx, limit = 50): Promise<{ sent: number; failed: number }> {
  const rows = await many<{ id: string; staff_id: string | null; operator_email: string | null; org_id: string | null; kind: string; channel: string; attempts: number; email: string | null; work_phone: string | null; sms_number: string | null }>(ctx.db,
    `SELECT n.id, n.staff_id, n.operator_email, n.org_id, n.kind, n.channel, n.attempts, s.email, s.work_phone, o.sms_number
       FROM notifications n LEFT JOIN staff s ON s.id = n.staff_id LEFT JOIN organizations o ON o.id = n.org_id
      WHERE n.status = 'pending' AND n.attempts < 5 ORDER BY n.created_at LIMIT $1`, [limit]);
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const isDigest = r.kind.startsWith('digest:');
    const text = isDigest ? r.kind.slice(7) : NOTICE_TEXT[r.kind] ?? 'Something in Heartbeat needs your attention.';
    const body = `${text}\n\nSign in to see the details: ${ctx.config.publicUrl}/\n\nThis message intentionally contains no participant information.`;
    try {
      if (r.channel === 'email') {
        const to = r.email ?? r.operator_email;
        if (!to) throw new Error('no address');
        await ctx.mailer.send({ to, subject: isDigest ? 'Heartbeat daily check' : 'Heartbeat: action needed', text: body });
      } else {
        if (!r.work_phone || !r.sms_number) {
          await ctx.db.query("UPDATE notifications SET status = 'skipped', error = 'no phone or sending number' WHERE id = $1", [r.id]);
          continue;
        }
        await ctx.sms.send({ from: r.sms_number, to: r.work_phone, body: `${text} ${ctx.config.publicUrl}/` });
      }
      await ctx.db.query("UPDATE notifications SET status = 'sent', sent_at = $2, attempts = attempts + 1 WHERE id = $1", [r.id, ts(ctx.clock.now())]);
      sent++;
    } catch (err) {
      const attempts = r.attempts + 1;
      await ctx.db.query('UPDATE notifications SET attempts = $2, status = $3, error = $4 WHERE id = $1',
        [r.id, attempts, attempts >= 5 ? 'failed' : 'pending', String((err as Error).message).slice(0, 200)]);
      failed++;
    }
  }
  return { sent, failed };
}

/** Recent delivery failures per staff member, for the coordinator dashboard (HB-OPS-2). */
export async function deliveryFailures(q: Q, orgId: string, sinceMs: number) {
  return many<{ staff_id: string; display_name: string; failures: string }>(q,
    `SELECT n.staff_id, s.display_name, count(*) AS failures FROM notifications n JOIN staff s ON s.id = n.staff_id
      WHERE s.org_id = $1 AND n.status = 'failed' AND n.created_at >= $2 GROUP BY n.staff_id, s.display_name`, [orgId, ts(sinceMs)]);
}
