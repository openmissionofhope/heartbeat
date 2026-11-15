import type { Config } from '../config.js';
import type { Db, Q } from '../db/index.js';
import { maybe } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { aesDecrypt, aesEncrypt, newToken, sha256 } from '../lib/crypto.js';
import type { Mailer } from './mail.js';
import type { SmsProvider } from './sms-provider.js';

export class DomainError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const fail = (message: string, status = 400): never => {
  throw new DomainError(message, status);
};

export interface Ctx {
  db: Db;
  /** Separate connection for participant data keys (may be the same database). */
  keysDb: Db;
  config: Config;
  clock: Clock;
  mailer: Mailer;
  sms: SmsProvider;
  keys: KeyStore;
}

export type Role = 'recorder' | 'enroller' | 'responder' | 'coordinator' | 'program_lead' | 'relay' | 'steward' | 'operator' | 'evaluator';

export interface Actor {
  kind: 'staff';
  staffId: string;
  orgId: string;
  orgKind: 'host' | 'partner' | 'operator';
  name: string;
  roles: Set<Role>;
  sessionHash: string | null;
}

export const SYSTEM = { kind: 'system' as const };
export type AnyActor = Actor | typeof SYSTEM;

export function has(actor: Actor, ...roles: Role[]): boolean {
  return roles.some((r) => actor.roles.has(r));
}

export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!has(actor, ...roles)) fail('You do not have permission to do that.', 403);
}

// ---------------------------------------------------------------------------
// Participant data keys (envelope encryption, docs/04 §4.5).
// ---------------------------------------------------------------------------

export class KeyStore {
  private cache = new Map<string, Buffer>();
  constructor(private db: Db, private masterKey: Buffer, private clock: Clock) {}

  async create(participantId: string): Promise<void> {
    const dek = Buffer.from(newToken(32), 'base64url');
    const wrapped = aesEncrypt(this.masterKey, dek, `dek:${participantId}`);
    await this.db.query('INSERT INTO participant_keys (participant_id, wrapped_key, created_at) VALUES ($1, $2, $3)', [participantId, wrapped, new Date(this.clock.now())]);
    this.cache.set(participantId, dek);
  }

  async get(participantId: string): Promise<Buffer | null> {
    const hit = this.cache.get(participantId);
    if (hit) return hit;
    const row = await maybe<{ wrapped_key: Buffer }>(this.db, 'SELECT wrapped_key FROM participant_keys WHERE participant_id = $1', [participantId]);
    if (!row) return null;
    const dek = aesDecrypt(this.masterKey, row.wrapped_key, `dek:${participantId}`);
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(participantId, dek);
    return dek;
  }

  /** Destroys the key: every encrypted field of this participant becomes unreadable, everywhere. */
  async destroy(participantId: string): Promise<void> {
    this.cache.delete(participantId);
    await this.db.query('DELETE FROM participant_keys WHERE participant_id = $1', [participantId]);
  }
}

export async function enc(ctx: Ctx, participantId: string, field: string, value: string | null | undefined): Promise<Buffer | null> {
  if (value === null || value === undefined || value === '') return null;
  const key = await ctx.keys.get(participantId);
  if (!key) fail('This record is no longer available.', 410);
  return aesEncrypt(key!, Buffer.from(value, 'utf8'), `${participantId}:${field}`);
}

export async function dec(ctx: Ctx, participantId: string, field: string, blob: Buffer | null | undefined): Promise<string | null> {
  if (!blob) return null;
  const key = await ctx.keys.get(participantId);
  if (!key) return null;
  return aesDecrypt(key, blob, `${participantId}:${field}`).toString('utf8');
}

export async function encBytes(ctx: Ctx, participantId: string, field: string, value: Buffer): Promise<Buffer> {
  const key = await ctx.keys.get(participantId);
  if (!key) fail('This record is no longer available.', 410);
  return aesEncrypt(key!, value, `${participantId}:${field}`);
}

export async function decBytes(ctx: Ctx, participantId: string, field: string, blob: Buffer | null): Promise<Buffer | null> {
  if (!blob) return null;
  const key = await ctx.keys.get(participantId);
  if (!key) return null;
  return aesDecrypt(key, blob, `${participantId}:${field}`);
}

export async function encJson(ctx: Ctx, participantId: string, field: string, value: unknown): Promise<Buffer | null> {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return null;
  return enc(ctx, participantId, field, JSON.stringify(value));
}

export async function decJson<T>(ctx: Ctx, participantId: string, field: string, blob: Buffer | null | undefined, fallback: T): Promise<T> {
  const s = await dec(ctx, participantId, field, blob);
  return s ? (JSON.parse(s) as T) : fallback;
}

// ---------------------------------------------------------------------------
// Audit trail (docs/04 §4.6): append-only, hash-chained, no personal data.
// Must be called inside a transaction.
// ---------------------------------------------------------------------------

export interface AuditEvent {
  action: string;
  targetType?: string;
  targetId?: string | null;
  participantId?: string | null;
  basis?: string;
  reason?: string | null;
  outcome?: 'ok' | 'denied' | 'failed';
  details?: Record<string, unknown>;
  searchTerms?: string;
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function auditHash(row: {
  prev_hash: string; id: string | number; at: Date; actor_type: string; actor_id: string | null; actor_org: string | null; action: string;
  target_type: string | null; target_id: string | null; basis: string | null; reason: string | null; outcome: string; details: unknown; commit: string;
}): string {
  return sha256([
    row.prev_hash, String(row.id), row.at.toISOString(), row.actor_type, row.actor_id ?? '', row.actor_org ?? '', row.action,
    row.target_type ?? '', row.target_id ?? '', row.basis ?? '', row.reason ?? '', row.outcome, canonicalJson(row.details), row.commit,
  ].join('|'));
}

export const GENESIS = 'GENESIS';

export async function audit(q: Q, ctx: Ctx, actor: AnyActor | { kind: 'participant' | 'provider'; orgId?: string }, ev: AuditEvent): Promise<void> {
  await q.query('SELECT pg_advisory_xact_lock(727274)');
  const prev = await maybe<{ hash: string }>(q, 'SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1');
  const id = (await q.query<{ id: string }>("SELECT nextval('audit_seq') AS id")).rows[0]!.id;
  const salt = newToken(16);
  const commit = sha256(`${salt}|${ev.participantId ?? ''}|${ev.searchTerms ?? ''}`);
  const at = new Date(ctx.clock.now());
  const actorType = actor.kind;
  const actorId = actor.kind === 'staff' ? actor.staffId : null;
  const actorOrg = actor.kind === 'staff' ? actor.orgId : 'orgId' in actor ? actor.orgId ?? null : null;
  const row = {
    prev_hash: prev?.hash ?? GENESIS, id, at, actor_type: actorType, actor_id: actorId, actor_org: actorOrg, action: ev.action,
    target_type: ev.targetType ?? null, target_id: ev.targetId ?? null, basis: ev.basis ?? null, reason: ev.reason ?? null,
    outcome: ev.outcome ?? 'ok', details: ev.details ?? {}, commit,
  };
  const hash = auditHash(row);
  await q.query(
    `INSERT INTO audit_events (id, at, actor_type, actor_id, actor_org, action, target_type, target_id, basis, reason, outcome, details,
       participant_id, search_terms, salt, commit, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id, at, actorType, actorId, actorOrg, ev.action, row.target_type, row.target_id, row.basis, row.reason, row.outcome, JSON.stringify(row.details),
      ev.participantId ?? null, ev.searchTerms ?? null, salt, commit, row.prev_hash, hash],
  );
}

/** Convenience: record an audit event in its own transaction. */
export function auditNow(ctx: Ctx, actor: AnyActor, ev: AuditEvent): Promise<void> {
  return ctx.db.tx((q) => audit(q, ctx, actor, ev));
}

export function clampText(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  const t = s.trim();
  if (!t) return null;
  if (t.length > max) fail(`Please keep this to ${max} characters or fewer.`);
  return t;
}
