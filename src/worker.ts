import { createContext } from './context.js';
import { openDb } from './db/index.js';
import { runNightlyIfDue, runScheduledJobs } from './domain/scheduler.js';

/** Runs the scheduled jobs without the web server (when the web process sets HEARTBEAT_WORKERS=0). */
const ctx = await createContext();
const retentionDb = ctx.config.retentionDatabaseUrl === ctx.config.databaseUrl ? undefined : openDb(ctx.config.retentionDatabaseUrl, 2);
const log = (msg: string, err?: unknown) => console.error(msg, err instanceof Error ? err.message : err);
for (;;) {
  await runScheduledJobs(ctx, { log });
  await runNightlyIfDue(ctx, retentionDb, log);
  await new Promise((r) => setTimeout(r, 60_000));
}
