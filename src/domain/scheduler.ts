import { localDate } from '../lib/calendar.js';
import { tickCases } from './cases.js';
import type { Ctx } from './core.js';
import { holdReminders, hostSilenceCheck, runDetector, sendDailyDigest } from './detector.js';
import { remindPendingWithdrawals } from './lifecycle.js';
import { pauseIndicators } from './metrics.js';
import { deliverNotifications } from './notifications.js';
import { listOrgs } from './orgs.js';
import { exportAuditDay, runRetention } from './retention.js';
import { remindOutstandingReports } from './safeguarding.js';
import { sendReminders } from './sms.js';
import { expireTransfers } from './transfers.js';

/** One pass of every scheduled job. The worker calls this every minute; tests call it directly. */
export async function runScheduledJobs(ctx: Ctx, opts: { log?: (msg: string, err?: unknown) => void } = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  const safe = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      log(`${name} failed`, err);
    }
  };
  for (const org of await listOrgs(ctx.db)) {
    if (org.kind !== 'host' || org.status === 'closed') continue;
    await safe('detector', () => runDetector(ctx, org.id));
    await safe('cases', () => tickCases(ctx, org.id));
    await safe('withdrawals', () => remindPendingWithdrawals(ctx, org.id));
    await safe('safeguarding', () => remindOutstandingReports(ctx, org.id));
    await safe('reminders', () => sendReminders(ctx, org.id));
    await safe('digest', () => sendDailyDigest(ctx, org));
    await safe('hold', () => holdReminders(ctx, org));
    await safe('silence', () => hostSilenceCheck(ctx, org));
    await safe('indicators', () => pauseIndicators(ctx, org.id));
  }
  await safe('transfers', () => expireTransfers(ctx));
  await safe('notifications', () => deliverNotifications(ctx));
}

let lastNightly = '';

/** Retention and audit export once a day, after 02:00 UTC. */
export async function runNightlyIfDue(ctx: Ctx, retentionDb?: Parameters<typeof runRetention>[1], log?: (msg: string, err?: unknown) => void): Promise<boolean> {
  const now = ctx.clock.now();
  const today = localDate(now, 'UTC');
  if (today === lastNightly || new Date(now).getUTCHours() < 2) return false;
  lastNightly = today;
  try {
    await exportAuditDay(ctx);
  } catch (err) {
    log?.('audit export failed', err);
  }
  try {
    await runRetention(ctx, retentionDb);
  } catch (err) {
    log?.('retention failed', err);
  }
  return true;
}
