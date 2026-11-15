import pg from 'pg';
import { MIGRATIONS } from './schema.js';

/** A query target: the pool, or a client inside a transaction. */
export interface Q {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

export interface Db extends Q {
  pool: pg.Pool;
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function openDb(url: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString: url, max });
  return {
    pool,
    query: (sql, params) => pool.query(sql, params as unknown[]),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function migrate(db: Db): Promise<void> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await db.tx(async (q) => {
      await q.query(m.sql);
      await q.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
    });
  }
}

export async function one<T extends pg.QueryResultRow>(q: Q, sql: string, params: unknown[] = []): Promise<T> {
  const r = await q.query<T>(sql, params);
  if (!r.rows[0]) throw new Error('expected one row');
  return r.rows[0];
}

export async function maybe<T extends pg.QueryResultRow>(q: Q, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await q.query<T>(sql, params);
  return r.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow>(q: Q, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await q.query<T>(sql, params)).rows;
}

/** Converts an instant (ms) to a parameter, or null. */
export const ts = (ms: number | null | undefined): Date | null => (ms === null || ms === undefined ? null : new Date(ms));

/** Converts a timestamptz column value to ms, or null. */
export const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);
