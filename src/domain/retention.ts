import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { POLICY } from '../config.js';
import type { Db } from '../db/index.js';
import { many, maybe, one, ts } from '../db/index.js';
import { DAY } from '../lib/calendar.js';
import { type Ctx, GENESIS, SYSTEM, audit, auditHash } from './core.js';

/**
 * Nightly retention (docs/04 §4.4). Real deletion: participant rows are deleted and their data
 * keys destroyed, so encrypted copies in backups become unreadable too. Records under legal hold
 * are skipped entirely.
 */
export async function runRetention(ctx: Ctx, retentionDb?: Db): Promise<Record<string, number>> {
  const now = ctx.clock.now();
  const R = POLICY.retention;
  const db = ctx.db;
  const out: Record<string, number> = {};
  const count = async (key: string, sql: string, params: unknown[]) => {
    const r = await db.query(sql, params);
    out[key] = (out[key] ?? 0) + (r.rowCount ?? 0);
  };
  const run = await one<{ id: string }>(db, "INSERT INTO job_runs (job, started_at) VALUES ('retention', $1) RETURNING id", [ts(now)]);
  try {
    // Weekly de-identified aggregates before contacts are deleted.
    await db.query(`INSERT INTO monthly_aggregates (org_id, week, metric, value)
      SELECT p.org_id, date_trunc('week', c.occurred_at)::date, 'contacts_' || c.kind, count(*)
        FROM contacts c JOIN participants p ON p.id = c.participant_id
       WHERE c.occurred_at < $1 AND p.legal_hold IS NULL AND c.voided_at IS NULL
       GROUP BY 1, 2, 3
      ON CONFLICT (org_id, week, metric) DO UPDATE SET value = monthly_aggregates.value + EXCLUDED.value`, [ts(now - R.contactDays * DAY)]);
    await count('contacts', 'DELETE FROM contacts c USING participants p WHERE p.id = c.participant_id AND c.occurred_at < $1 AND p.legal_hold IS NULL', [ts(now - R.contactDays * DAY)]);
    await count('voided_contacts', 'DELETE FROM contacts c USING participants p WHERE p.id = c.participant_id AND c.voided_at < $1 AND p.legal_hold IS NULL', [ts(now - R.voidedContactDays * DAY)]);
    await count('superseded_plans', `UPDATE plan_versions pv SET phone_enc = NULL, phone_message_enc = NULL, avoid_times_enc = NULL, usually_found_enc = NULL,
        named_people_enc = NULL, partner_message_enc = NULL, values_purged = true
       FROM participants p WHERE p.id = pv.participant_id AND pv.superseded_at < $1 AND NOT pv.values_purged AND p.legal_hold IS NULL`, [ts(now - R.supersededPlanDays * DAY)]);
    await count('case_notes', `UPDATE case_actions a SET note_enc = NULL FROM cases c JOIN participants p ON p.id = c.participant_id
       WHERE a.case_id = c.id AND c.state = 'closed' AND c.closed_at < $1 AND a.note_enc IS NOT NULL AND p.legal_hold IS NULL`, [ts(now - R.actionNoteDays * DAY)]);
    await count('closure_notes', `UPDATE cases c SET closure_note_enc = NULL, notes_purged = true FROM participants p
       WHERE p.id = c.participant_id AND c.state = 'closed' AND c.closed_at < $1 AND NOT c.notes_purged AND p.legal_hold IS NULL`, [ts(now - R.actionNoteDays * DAY)]);
    await count('concern_callbacks', 'UPDATE concerns SET callback_enc = NULL, callback_delete_at = NULL WHERE callback_delete_at < $1', [ts(now)]);
    // Pre-transfer history at the sending host: deleted 30 days after the transfer.
    await count('transferred_history', `DELETE FROM cases c USING participants p WHERE p.id = c.participant_id AND c.org_id <> p.org_id AND c.state = 'closed'
        AND p.hosted_since < $1 AND p.legal_hold IS NULL`, [ts(now - R.transferredHistoryDays * DAY)]);
    await count('transferred_contacts', `DELETE FROM contacts c USING participants p WHERE p.id = c.participant_id AND c.recorded_at < p.hosted_since
        AND p.hosted_since < $1 AND p.legal_hold IS NULL`, [ts(now - R.transferredHistoryDays * DAY)]);

    // Participants whose enrollment ended and whose retention period has passed; abandoned drafts.
    const due = await many<{ id: string; org_id: string; created_at: Date; state: string }>(db,
      `SELECT id, org_id, created_at, state FROM participants WHERE legal_hold IS NULL AND ((delete_after IS NOT NULL AND delete_after <= $1) OR (state = 'draft' AND created_at < $2))`,
      [ts(now), ts(now - R.draftDays * DAY)]);
    for (const p of due) {
      await db.tx(async (q) => {
        await q.query(`INSERT INTO tombstones (participant_id, org_id, enrolled_month, ended_month, end_reason, deleted_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [p.id, p.org_id, p.created_at.toISOString().slice(0, 7), new Date(now).toISOString().slice(0, 7), p.state, ts(now)]);
        await q.query('UPDATE safeguarding_reports SET participant_id = NULL WHERE participant_id = $1', [p.id]);
        await q.query('DELETE FROM participants WHERE id = $1', [p.id]);
        await audit(q, ctx, SYSTEM, { action: 'retention.participant_deleted', targetType: 'participant', targetId: p.id, details: { state: p.state } });
      });
      await ctx.keys.destroy(p.id);
    }
    out.participants = due.length;
    // Data keys whose participant no longer exists (e.g. an enrollment that failed after key creation).
    const orphanKeys = await many<{ participant_id: string }>(ctx.keysDb, 'SELECT participant_id FROM participant_keys WHERE created_at < $1', [ts(now - DAY)]);
    let orphans = 0;
    for (const k of orphanKeys) {
      if (!(await maybe(db, 'SELECT 1 FROM participants WHERE id = $1', [k.participant_id]))) {
        await ctx.keys.destroy(k.participant_id);
        orphans++;
      }
    }
    out.orphan_keys = orphans;

    await count('notifications', 'DELETE FROM notifications WHERE created_at < $1', [ts(now - R.notificationDays * DAY)]);
    await count('sms_messages', 'DELETE FROM sms_messages WHERE created_at < $1', [ts(now - R.smsDays * DAY)]);
    await count('relay_attempts', 'DELETE FROM relay_attempts WHERE at < $1', [ts(now - R.contactDays * DAY)]);
    await count('job_runs', "DELETE FROM job_runs WHERE started_at < $1 AND job <> 'retention'", [ts(now - 90 * DAY)]);
    await count('access_grants', 'DELETE FROM access_grants WHERE expires_at < $1', [ts(now)]);
    await count('sessions', 'DELETE FROM sessions WHERE created_at < $1', [ts(now - POLICY.sessionMaxHours * 3_600_000)]);
    await count('phone_codes', 'DELETE FROM phone_codes WHERE expires_at < $1', [ts(now)]);
    await count('safeguarding_reports', 'DELETE FROM safeguarding_reports WHERE (delete_after IS NOT NULL AND delete_after < $1) OR identified_at < $2', [ts(now), ts(now - R.auditDays * DAY)]);
    await count('closed_cases', "DELETE FROM cases c USING participants p WHERE p.id = c.participant_id AND c.state = 'closed' AND c.closed_at < $1 AND p.legal_hold IS NULL", [ts(now - R.auditDays * DAY)]);

    // Audit: redact participant links from contact events and search terms after 90 days; purge after 2 years.
    await count('audit_redacted', `UPDATE audit_events SET participant_id = NULL, search_terms = NULL, salt = NULL
       WHERE at < $1 AND (search_terms IS NOT NULL OR (participant_id IS NOT NULL AND action IN ('contact.record','contact.void','contact.backdate_approved','relay.attempt','case.contact_reported')))`,
    [ts(now - R.auditRedactDays * DAY)]);
    const purger = retentionDb ?? db;
    await purger.tx(async (q) => {
      await q.query("SET LOCAL heartbeat.audit_purge = 'on'");
      const r = await q.query('DELETE FROM audit_events WHERE at < $1', [ts(now - R.auditDays * DAY)]);
      out.audit_purged = r.rowCount ?? 0;
    });
    await db.tx((q) => audit(q, ctx, SYSTEM, { action: 'retention.run', details: out }));
    await db.query('UPDATE job_runs SET finished_at = $2, ok = true, summary = $3 WHERE id = $1', [run.id, ts(ctx.clock.now()), JSON.stringify(out)]);
  } catch (err) {
    await db.query('UPDATE job_runs SET finished_at = $2, ok = false, summary = $3 WHERE id = $1', [run.id, ts(ctx.clock.now()), JSON.stringify({ error: String((err as Error).message).slice(0, 300) })]);
    throw err;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audit integrity (HB-AUD-1, HB-AUD-4): nightly checkpoint export and chain verification.
// ---------------------------------------------------------------------------

interface AuditRowFull {
  id: string; at: Date; actor_type: string; actor_id: string | null; actor_org: string | null; action: string; target_type: string | null; target_id: string | null;
  basis: string | null; reason: string | null; outcome: string; details: unknown; commit: string; prev_hash: string; hash: string;
}

/** Writes the previous UTC day's event hashes and chain head to separate storage. */
export async function exportAuditDay(ctx: Ctx, dayIso?: string): Promise<{ day: string; count: number } | null> {
  const now = ctx.clock.now();
  const day = dayIso ?? new Date(now - DAY).toISOString().slice(0, 10);
  if (await maybe(ctx.db, 'SELECT 1 FROM audit_checkpoints WHERE day = $1', [day])) return null;
  const start = new Date(`${day}T00:00:00Z`);
  const end = new Date(start.getTime() + DAY);
  const rows = await many<AuditRowFull>(ctx.db,
    'SELECT id, at, actor_type, actor_id, actor_org, action, target_type, target_id, basis, reason, outcome, details, commit, prev_hash, hash FROM audit_events WHERE at >= $1 AND at < $2 ORDER BY id', [start, end]);
  const head = rows.at(-1)?.hash ?? (await maybe<{ hash: string }>(ctx.db, 'SELECT hash FROM audit_events WHERE at < $1 ORDER BY id DESC LIMIT 1', [start]))?.hash ?? GENESIS;
  const first = rows[0]?.prev_hash ?? head;
  mkdirSync(ctx.config.auditExportDir, { recursive: true });
  // Only ids and hashes leave the database: enough to prove later that no event was altered or removed,
  // without copying any participant link to the export store.
  writeFileSync(join(ctx.config.auditExportDir, `${day}.json`), JSON.stringify({ day, count: rows.length, firstPrevHash: first, headHash: head, events: rows.map((r) => [r.id, r.hash]) }), { flag: 'wx' });
  await ctx.db.query('INSERT INTO audit_checkpoints (day, last_id, head_hash, first_prev_hash, count, exported_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [day, rows.at(-1)?.id ?? 0, head, first, rows.length, ts(now)]);
  return { day, count: rows.length };
}

/** Recomputes every hash and checks the links. Returns the first broken event id, if any. */
export async function verifyAuditChain(ctx: Ctx): Promise<{ ok: boolean; checked: number; brokenAt: string | null }> {
  let prev: string | null = null;
  let checked = 0;
  let lastId = '0';
  for (;;) {
    const rows = await many<AuditRowFull>(ctx.db,
      'SELECT id, at, actor_type, actor_id, actor_org, action, target_type, target_id, basis, reason, outcome, details, commit, prev_hash, hash FROM audit_events WHERE id > $1 ORDER BY id LIMIT 1000', [lastId]);
    if (!rows.length) break;
    for (const r of rows) {
      if (prev !== null && r.prev_hash !== prev) return { ok: false, checked, brokenAt: r.id };
      if (auditHash(r) !== r.hash) return { ok: false, checked, brokenAt: r.id };
      prev = r.hash;
      lastId = r.id;
      checked++;
    }
  }
  return { ok: true, checked, brokenAt: null };
}
