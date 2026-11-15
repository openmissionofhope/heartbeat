import { type Config, loadConfig } from './config.js';
import { migrate, openDb } from './db/index.js';
import { type Ctx, KeyStore } from './domain/core.js';
import { createMailer } from './domain/mail.js';
import { createSmsProvider } from './domain/sms-provider.js';
import { systemClock } from './lib/clock.js';

export async function createContext(overrides: Partial<Config> = {}): Promise<Ctx> {
  const config = loadConfig(overrides);
  const db = openDb(config.databaseUrl);
  await migrate(db);
  const keysDb = config.keystoreDatabaseUrl === config.databaseUrl ? db : openDb(config.keystoreDatabaseUrl, 4);
  if (keysDb !== db) {
    await keysDb.query('CREATE TABLE IF NOT EXISTS participant_keys (participant_id uuid PRIMARY KEY, wrapped_key bytea NOT NULL, created_at timestamptz NOT NULL)');
  }
  return { db, keysDb, config, clock: systemClock, mailer: createMailer(config), sms: createSmsProvider(config), keys: new KeyStore(keysDb, config.masterKey, systemClock) };
}
