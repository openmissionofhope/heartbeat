import { randomBytes } from 'node:crypto';

/**
 * Workflow parameters from docs/03-workflow-and-states.md §3.2. Business durations are in
 * staffed minutes; a "business day" is the host's staffed-day length.
 */
export const POLICY = {
  intervals: [7, 14, 30] as const,
  graceDays: { 7: 2, 14: 3, 30: 5 } as Record<number, number>,
  returnWindowMaxDays: 7,
  offerMinutes: { primary: 180, backup: 180, coordinator: 120 },
  firstActionBusinessDays: 1,
  updateBusinessDays: 3,
  stallBusinessDays: 1,
  confirmBusinessDays: 1,
  extendedWatchMinBusinessDays: 10,
  extendedWatchReviewBusinessDays: 10,
  extendedWatchMaxDays: 90,
  inPersonPromptDays: 60,
  pauseMaxDaysInPerson: 90,
  pauseMaxDaysRemote: 14,
  withdrawalReviewDays: 30,
  withdrawalPendingMaxDays: 180,
  backdateHours: 72,
  responderCap: 6,
  reopenDays: 30,
  transferExpiryBusinessDays: 10,
  remoteFlagDays: 30,
  verificationLockout: { failures: 5, hours: 24 },
  relayRate: { perStaffPerHour: 30 },
  hostSilenceBusinessDays: 2,
  holdOperatorAlertBusinessDays: 3,
  continuityEventDays: 14,
  continuityHostSilentHours: 72,
  retention: {
    draftDays: 7,
    supersededPlanDays: 90,
    contactDays: 90,
    voidedContactDays: 30,
    actionNoteDays: 180,
    concernCallbackDays: 30,
    withdrawnDays: 30,
    withdrawnKeepDays: 90,
    inactiveDays: 365,
    endedDays: 180,
    transferredHistoryDays: 30,
    auditDays: 730,
    auditRedactDays: 90,
    notificationDays: 90,
    smsDays: 90,
  },
  noteMax: { contact: 200, relay: 140, action: 500, reason: 500, accessReason: 200 },
  smsQuietHours: { startHour: 8, endHour: 21 },
  sessionIdleMinutesShared: 15,
  sessionMaxHours: 12,
  suppressBelow: 5,
} as const;

export type SmsProviderKind = 'console' | 'twilio';

export interface Config {
  env: 'development' | 'test' | 'production';
  production: boolean;
  port: number;
  host: string;
  publicUrl: string;
  databaseUrl: string;
  /** Optional separate connection for the retention job (which alone may purge audit rows). */
  retentionDatabaseUrl: string;
  /** Optional separate store for participant data keys, so deletion reaches backups too. */
  keystoreDatabaseUrl: string;
  /** 32-byte master key that wraps participant data keys. */
  masterKey: Buffer;
  /** Secret for CSRF tokens and keyed hashes (phone-number index, etc.). */
  secret: string;
  secureCookies: boolean;
  trustProxy: boolean;
  allowedOrigins: Set<string>;
  logLevel: string;
  workers: boolean;
  auditExportDir: string;
  smtp: { url: string; from: string } | null;
  sms: { provider: SmsProviderKind; twilioAccountSid?: string; twilioAuthToken?: string };
  /** Verify webhook signatures from the SMS/voice provider (always on in production). */
  verifyWebhooks: boolean;
}

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (process.env.NODE_ENV === 'production' ? 'production' : process.env.NODE_ENV === 'test' ? 'test' : 'development') as Config['env'];
  const production = env === 'production';
  const publicUrl = (process.env.HEARTBEAT_PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const masterKeyB64 = production ? required('HEARTBEAT_MASTER_KEY') : process.env.HEARTBEAT_MASTER_KEY;
  const masterKey = masterKeyB64 ? Buffer.from(masterKeyB64, 'base64') : randomBytes(32);
  if (masterKey.length !== 32) throw new Error('HEARTBEAT_MASTER_KEY must be 32 bytes, base64-encoded');
  const databaseUrl = required('DATABASE_URL', production ? undefined : 'postgres:///heartbeat');
  const smtpUrl = process.env.HEARTBEAT_SMTP_URL;
  const provider = (process.env.HEARTBEAT_SMS_PROVIDER ?? 'console') as SmsProviderKind;
  const config: Config = {
    env,
    production,
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    publicUrl,
    databaseUrl,
    retentionDatabaseUrl: process.env.RETENTION_DATABASE_URL ?? databaseUrl,
    keystoreDatabaseUrl: process.env.KEYSTORE_DATABASE_URL ?? databaseUrl,
    masterKey,
    secret: production ? required('HEARTBEAT_SECRET') : (process.env.HEARTBEAT_SECRET ?? 'development-secret-not-for-production'),
    secureCookies: publicUrl.startsWith('https://'),
    trustProxy: process.env.HEARTBEAT_TRUST_PROXY === '1',
    allowedOrigins: new Set([publicUrl, ...(process.env.HEARTBEAT_EXTRA_ORIGINS ?? '').split(',').filter(Boolean)]),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    workers: process.env.HEARTBEAT_WORKERS !== '0',
    auditExportDir: process.env.HEARTBEAT_AUDIT_EXPORT_DIR ?? 'var/audit-export',
    smtp: smtpUrl ? { url: smtpUrl, from: required('HEARTBEAT_MAIL_FROM', 'Heartbeat <heartbeat@localhost>') } : null,
    sms: {
      provider,
      twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
      twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    },
    verifyWebhooks: production || process.env.HEARTBEAT_VERIFY_WEBHOOKS === '1',
    ...overrides,
  };
  if (config.sms.provider === 'twilio' && (!config.sms.twilioAccountSid || !config.sms.twilioAuthToken)) {
    throw new Error('Twilio SMS requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
  }
  return config;
}
