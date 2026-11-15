import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate, openDb } from '../src/db/index.js';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplate: string;
  }
}

function findPgBin(): string {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const base = '/usr/lib/postgresql';
  if (existsSync(base)) {
    const versions = readdirSync(base).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
    for (const v of versions) if (existsSync(join(base, v, 'bin', 'initdb'))) return join(base, v, 'bin');
  }
  return '';
}

let stop: (() => void) | null = null;

export default async function setup(project: TestProject) {
  let adminUrl = process.env.HEARTBEAT_TEST_DATABASE_URL;
  if (!adminUrl) {
    const bin = findPgBin();
    const initdb = bin ? join(bin, 'initdb') : 'initdb';
    const pgCtl = bin ? join(bin, 'pg_ctl') : 'pg_ctl';
    const dir = mkdtempSync(join(tmpdir(), 'heartbeat-pg-'));
    const data = join(dir, 'data');
    execFileSync(initdb, ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync'], { stdio: 'ignore' });
    const port = 20000 + Math.floor(Math.random() * 20000);
    execFileSync(pgCtl, ['-D', data, '-o', `-F -k ${dir} -c listen_addresses='' -p ${port} -c fsync=off -c synchronous_commit=off -c full_page_writes=off`, '-w', 'start', '-l', join(dir, 'log')], { stdio: 'ignore' });
    adminUrl = `postgres://postgres@/postgres?host=${encodeURIComponent(dir)}&port=${port}`;
    stop = () => {
      try {
        execFileSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
      } catch { /* already stopped */ }
      rmSync(dir, { recursive: true, force: true });
    };
    void spawn;
  }
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const template = `heartbeat_template_${process.pid}`;
  await admin.query(`DROP DATABASE IF EXISTS ${template}`);
  await admin.query(`CREATE DATABASE ${template}`);
  await admin.end();
  const db = openDb(adminUrl.replace(/\/postgres(\?|$)/, `/${template}$1`), 2);
  await migrate(db);
  await db.close();
  project.provide('pgAdminUrl', adminUrl);
  project.provide('pgTemplate', template);
  return async () => {
    if (stop) stop();
    else {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${template}`).catch(() => {});
      await c.end();
    }
  };
}
