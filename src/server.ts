import { createContext } from './context.js';
import { openDb } from './db/index.js';
import { runNightlyIfDue, runScheduledJobs } from './domain/scheduler.js';
import { buildApp } from './web/app.js';

const ctx = await createContext();
const app = await buildApp(ctx);
const retentionDb = ctx.config.retentionDatabaseUrl === ctx.config.databaseUrl ? undefined : openDb(ctx.config.retentionDatabaseUrl, 2);
const log = (msg: string, err?: unknown) => app.log.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : err }, msg);

const timers: NodeJS.Timeout[] = [];
if (ctx.config.workers) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runScheduledJobs(ctx, { log });
      await runNightlyIfDue(ctx, retentionDb, log);
    } finally {
      running = false;
    }
  };
  timers.push(setInterval(() => void tick(), 60_000));
  void tick();
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal}: shutting down`);
  for (const t of timers) clearInterval(t);
  await app.close();
  await ctx.db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

app.log.info({ publicUrl: ctx.config.publicUrl, sms: ctx.sms.name, workers: ctx.config.workers }, 'starting Heartbeat');
await app.listen({ port: ctx.config.port, host: ctx.config.host });
