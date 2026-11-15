import { POLICY } from '../config.js';
import type { Q } from '../db/index.js';
import { many, maybe, one, ts } from '../db/index.js';
import { aesDecrypt, aesEncrypt, hashSecret, newRecoveryCode, newTotpSecret, newToken, normalizeCode, sha256, verifySecret, verifyTotp } from '../lib/crypto.js';
import { type Actor, type Ctx, type Role, SYSTEM, audit, clampText, fail, requireRole } from './core.js';
import { type OrgRow, getOrg } from './orgs.js';

export const ALL_ROLES: Role[] = ['recorder', 'enroller', 'responder', 'coordinator', 'program_lead', 'relay', 'steward', 'operator', 'evaluator'];

/** Training modules (docs/08 §8.3) each role needs before it takes effect in a live organization. */
export const ROLE_MODULES: Record<Role, number[]> = {
  recorder: [1, 2, 3],
  enroller: [1, 2, 3, 4],
  responder: [1, 2, 3, 5, 6],
  coordinator: [1, 2, 3, 5, 6, 7],
  program_lead: [1, 2, 6, 8],
  relay: [1, 2, 3],
  steward: [1, 2, 3, 5, 6, 7],
  operator: [],
  evaluator: [1],
};

export const MODULE_TITLES: Record<number, string> = {
  1: 'What Heartbeat is and is not',
  2: 'Neither confirm nor deny',
  3: 'Recording contact',
  4: 'The consent conversation',
  5: 'Follow-up practice',
  6: 'Emergencies and legal duties outside Heartbeat',
  7: 'Coordinating',
  8: 'Program lead duties',
  9: 'Tabletop exercises',
  10: 'Disaster drill on paper',
};

export interface StaffRow {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  work_phone: string | null;
  password_hash: string;
  totp_secret_enc: Buffer | null;
  totp_enabled: boolean;
  recovery_hashes: string[];
  roles: Role[];
  active: boolean;
  out_from: string | null;
  out_to: string | null;
  failed_signins: number;
  locked_until: Date | null;
  last_signin_at: Date | null;
  notify_sms: boolean;
  created_at: Date;
}

const STAFF_COLS = "id, org_id, email, display_name, work_phone, password_hash, totp_secret_enc, totp_enabled, recovery_hashes, roles, active, to_char(out_from,'YYYY-MM-DD') AS out_from, to_char(out_to,'YYYY-MM-DD') AS out_to, failed_signins, locked_until, last_signin_at, notify_sms, created_at";

export async function getStaff(q: Q, id: string): Promise<StaffRow | null> {
  return maybe<StaffRow>(q, `SELECT ${STAFF_COLS} FROM staff WHERE id = $1`, [id]);
}

export async function listStaff(q: Q, orgId: string): Promise<StaffRow[]> {
  return many<StaffRow>(q, `SELECT ${STAFF_COLS} FROM staff WHERE org_id = $1 ORDER BY active DESC, display_name`, [orgId]);
}

export async function trainingOf(q: Q, staffId: string): Promise<Set<number>> {
  return new Set((await many<{ module: number }>(q, 'SELECT module FROM staff_training WHERE staff_id = $1', [staffId])).map((r) => r.module));
}

export function effectiveRoles(roles: Role[], trained: Set<number>, org: OrgRow): Set<Role> {
  if (org.status !== 'live') return new Set(roles);
  return new Set(roles.filter((r) => ROLE_MODULES[r].every((m) => trained.has(m))));
}

export async function loadActor(q: Q, staffId: string, sessionHash: string | null): Promise<Actor | null> {
  const s = await getStaff(q, staffId);
  if (!s || !s.active) return null;
  const org = await getOrg(q, s.org_id);
  const roles = effectiveRoles(s.roles, await trainingOf(q, s.id), org);
  return { kind: 'staff', staffId: s.id, orgId: s.org_id, orgKind: org.kind, name: s.display_name, roles, sessionHash };
}

function validPassword(pw: string): void {
  if (pw.length < 12) fail('Passwords must be at least 12 characters.');
  if (pw.length > 200) fail('That password is too long.');
}

export async function createStaff(ctx: Ctx, actor: Actor | null, input: { orgId: string; email: string; displayName: string; password: string; roles: Role[]; workPhone?: string | null }): Promise<StaffRow> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('Enter a valid work email.');
  const name = clampText(input.displayName, 80) ?? fail('Name is required.');
  validPassword(input.password);
  const roles = [...new Set(input.roles)];
  if (roles.some((r) => !ALL_ROLES.includes(r))) fail('Unknown role.');
  return ctx.db.tx(async (q) => {
    const org = await getOrg(q, input.orgId);
    if (actor) {
      const operator = actor.roles.has('operator');
      const lead = actor.roles.has('program_lead') && actor.orgId === input.orgId;
      if (!operator && !lead) fail('Only the program lead can add staff.', 403);
      // The operator may create only the first program lead of a host; it never assigns itself host roles.
      if (operator && !lead && org.kind !== 'operator' && roles.some((r) => r !== 'program_lead')) fail('OMH operators create only a first program lead; the program lead adds everyone else.', 403);
    }
    if (org.kind === 'operator' && roles.some((r) => r !== 'operator')) fail('Operator accounts hold only the operator role.');
    if (org.kind !== 'operator' && roles.includes('operator')) fail('The operator role belongs to OMH accounts only.');
    if (org.kind === 'partner' && roles.some((r) => !['relay', 'steward', 'program_lead'].includes(r))) fail('Partner organizations hold relay, steward or program lead roles.');
    const existing = await maybe(q, 'SELECT 1 FROM staff WHERE email = $1', [email]);
    if (existing) fail('An account with that email already exists.');
    const row = await one<StaffRow>(q,
      `INSERT INTO staff (org_id, email, display_name, work_phone, password_hash, roles, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${STAFF_COLS}`,
      [input.orgId, email, name, input.workPhone ?? null, await hashSecret(input.password), roles, ts(ctx.clock.now())]);
    await audit(q, ctx, actor ?? SYSTEM, { action: 'staff.create', targetType: 'staff', targetId: row.id, details: { roles } });
    return row;
  });
}

export async function setRoles(ctx: Ctx, actor: Actor, staffId: string, roles: Role[]): Promise<void> {
  requireRole(actor, 'program_lead');
  await ctx.db.tx(async (q) => {
    const s = await getStaff(q, staffId);
    if (!s || s.org_id !== actor.orgId) fail('Staff member not found.', 404);
    const org = await getOrg(q, actor.orgId);
    if (roles.includes('operator')) fail('The operator role belongs to OMH accounts only.');
    if (org.kind === 'partner' && roles.some((r) => !['relay', 'steward', 'program_lead'].includes(r))) fail('Partner organizations hold relay, steward or program lead roles.');
    if (staffId === actor.staffId && !roles.includes('program_lead')) fail('You cannot remove your own program lead role.');
    await q.query('UPDATE staff SET roles = $2 WHERE id = $1', [staffId, [...new Set(roles)]]);
    await audit(q, ctx, actor, { action: 'staff.roles', targetType: 'staff', targetId: staffId, details: { roles } });
  });
}

export async function recordTraining(ctx: Ctx, actor: Actor, staffId: string, modules: number[]): Promise<void> {
  requireRole(actor, 'program_lead', 'coordinator');
  await ctx.db.tx(async (q) => {
    const s = await getStaff(q, staffId);
    if (!s || s.org_id !== actor.orgId) fail('Staff member not found.', 404);
    for (const m of modules) {
      if (!MODULE_TITLES[m]) fail('Unknown module.');
      await q.query('INSERT INTO staff_training (staff_id, module, completed_at, recorded_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [staffId, m, ts(ctx.clock.now()), actor.staffId]);
    }
    await audit(q, ctx, actor, { action: 'staff.training', targetType: 'staff', targetId: staffId, details: { modules } });
  });
}

export async function setAvailability(ctx: Ctx, actor: Actor, staffId: string, from: string | null, to: string | null): Promise<void> {
  if (staffId !== actor.staffId) requireRole(actor, 'coordinator', 'program_lead');
  if ((from && !to) || (!from && to)) fail('Give both the first and last day away.');
  if (from && to && to < from) fail('The last day must be on or after the first.');
  await ctx.db.tx(async (q) => {
    const s = await getStaff(q, staffId);
    if (!s || s.org_id !== actor.orgId) fail('Staff member not found.', 404);
    await q.query('UPDATE staff SET out_from = $2, out_to = $3 WHERE id = $1', [staffId, from, to]);
    await audit(q, ctx, actor, { action: 'staff.availability', targetType: 'staff', targetId: staffId });
  });
}

export async function setNotifySms(ctx: Ctx, actor: Actor, on: boolean, phone: string | null): Promise<void> {
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE staff SET notify_sms = $2, work_phone = COALESCE($3, work_phone) WHERE id = $1', [actor.staffId, on, phone]);
    await audit(q, ctx, actor, { action: 'staff.notify_settings', targetType: 'staff', targetId: actor.staffId });
  });
}

// ---------------------------------------------------------------------------
// Sign-in, sessions and MFA
// ---------------------------------------------------------------------------

export async function signIn(ctx: Ctx, email: string, password: string, sharedDevice: boolean): Promise<{ token: string; staff: StaffRow; needsMfaSetup: boolean } | null> {
  const now = ctx.clock.now();
  return ctx.db.tx(async (q) => {
    const s = await maybe<StaffRow>(q, `SELECT ${STAFF_COLS} FROM staff WHERE email = $1 FOR UPDATE`, [email.trim().toLowerCase()]);
    if (!s || !s.active) {
      await audit(q, ctx, SYSTEM, { action: 'auth.signin', outcome: 'denied', details: { why: 'unknown' } });
      return null;
    }
    if (s.locked_until && s.locked_until.getTime() > now) {
      await audit(q, ctx, SYSTEM, { action: 'auth.signin', targetType: 'staff', targetId: s.id, outcome: 'denied', details: { why: 'locked' } });
      return null;
    }
    if (!(await verifySecret(password, s.password_hash))) {
      const failures = s.failed_signins + 1;
      await q.query('UPDATE staff SET failed_signins = $2, locked_until = $3 WHERE id = $1', [s.id, failures >= 5 ? 0 : failures, failures >= 5 ? ts(now + 15 * 60_000) : null]);
      await audit(q, ctx, SYSTEM, { action: 'auth.signin', targetType: 'staff', targetId: s.id, outcome: 'denied', details: { why: 'password' } });
      return null;
    }
    await q.query('UPDATE staff SET failed_signins = 0, locked_until = NULL WHERE id = $1', [s.id]);
    const token = newToken();
    await q.query('INSERT INTO sessions (id_hash, staff_id, mfa_ok, shared_device, created_at, last_seen_at) VALUES ($1,$2,false,$3,$4,$4)', [sha256(token), s.id, sharedDevice, ts(now)]);
    await audit(q, ctx, SYSTEM, { action: 'auth.password_ok', targetType: 'staff', targetId: s.id });
    return { token, staff: s, needsMfaSetup: !s.totp_enabled };
  });
}

export interface SessionInfo {
  sessionHash: string;
  staffId: string;
  mfaOk: boolean;
  shared: boolean;
}

export async function loadSession(ctx: Ctx, token: string | undefined): Promise<SessionInfo | null> {
  if (!token || token.length > 100) return null;
  const h = sha256(token);
  const now = ctx.clock.now();
  const s = await maybe<{ id_hash: string; staff_id: string; mfa_ok: boolean; shared_device: boolean; created_at: Date; last_seen_at: Date }>(ctx.db, 'SELECT * FROM sessions WHERE id_hash = $1', [h]);
  if (!s) return null;
  const idleLimit = s.shared_device ? POLICY.sessionIdleMinutesShared * 60_000 : POLICY.sessionMaxHours * 3_600_000;
  if (now - s.created_at.getTime() > POLICY.sessionMaxHours * 3_600_000 || now - s.last_seen_at.getTime() > idleLimit) {
    await ctx.db.query('DELETE FROM sessions WHERE id_hash = $1', [h]);
    return null;
  }
  if (now - s.last_seen_at.getTime() > 30_000) await ctx.db.query('UPDATE sessions SET last_seen_at = $2 WHERE id_hash = $1', [h, ts(now)]);
  return { sessionHash: h, staffId: s.staff_id, mfaOk: s.mfa_ok, shared: s.shared_device };
}

export async function signOut(ctx: Ctx, sessionHash: string): Promise<void> {
  await ctx.db.query('DELETE FROM sessions WHERE id_hash = $1', [sessionHash]);
}

function totpKey(ctx: Ctx, staffId: string, enc: Buffer): string {
  return aesDecrypt(ctx.config.masterKey, enc, `totp:${staffId}`).toString('utf8');
}

/** Starts MFA enrollment: stores a new secret (not yet enabled) and returns it with recovery codes. */
export async function beginMfaSetup(ctx: Ctx, staffId: string): Promise<{ secret: string }> {
  const secret = newTotpSecret();
  const encd = aesEncrypt(ctx.config.masterKey, Buffer.from(secret), `totp:${staffId}`);
  await ctx.db.query('UPDATE staff SET totp_secret_enc = $2 WHERE id = $1 AND NOT totp_enabled', [staffId, encd]);
  return { secret };
}

export async function finishMfaSetup(ctx: Ctx, session: SessionInfo, code: string): Promise<string[]> {
  return ctx.db.tx(async (q) => {
    const s = await getStaff(q, session.staffId);
    if (!s?.totp_secret_enc || s.totp_enabled) fail('Start authenticator setup again.');
    if (!verifyTotp(totpKey(ctx, s!.id, s!.totp_secret_enc!), code, ctx.clock.now())) fail('That code did not match. Check the time on your phone and try again.');
    const codes = Array.from({ length: 8 }, () => newRecoveryCode());
    await q.query('UPDATE staff SET totp_enabled = true, recovery_hashes = $2 WHERE id = $1', [s!.id, codes.map((c) => sha256(normalizeCode(c)))]);
    await q.query('UPDATE sessions SET mfa_ok = true WHERE id_hash = $1', [session.sessionHash]);
    await audit(q, ctx, SYSTEM, { action: 'auth.mfa_enabled', targetType: 'staff', targetId: s!.id });
    return codes;
  });
}

export async function verifyMfa(ctx: Ctx, session: SessionInfo, code: string): Promise<boolean> {
  return ctx.db.tx(async (q) => {
    const s = await getStaff(q, session.staffId);
    if (!s?.totp_enabled || !s.totp_secret_enc) return false;
    let ok = verifyTotp(totpKey(ctx, s.id, s.totp_secret_enc), code, ctx.clock.now());
    let usedRecovery = false;
    if (!ok) {
      const h = sha256(normalizeCode(code));
      if (s.recovery_hashes.includes(h)) {
        ok = true;
        usedRecovery = true;
        await q.query('UPDATE staff SET recovery_hashes = array_remove(recovery_hashes, $2) WHERE id = $1', [s.id, h]);
      }
    }
    if (ok) {
      await q.query('UPDATE sessions SET mfa_ok = true WHERE id_hash = $1', [session.sessionHash]);
      await q.query('UPDATE staff SET last_signin_at = $2 WHERE id = $1', [s.id, ts(ctx.clock.now())]);
    }
    await audit(q, ctx, SYSTEM, { action: 'auth.mfa', targetType: 'staff', targetId: s.id, outcome: ok ? 'ok' : 'denied', details: { recovery: usedRecovery } });
    return ok;
  });
}

export async function changePassword(ctx: Ctx, actor: Actor, current: string, next: string): Promise<void> {
  validPassword(next);
  await ctx.db.tx(async (q) => {
    const s = await getStaff(q, actor.staffId);
    if (!s || !(await verifySecret(current, s.password_hash))) fail('Your current password was not right.');
    await q.query('UPDATE staff SET password_hash = $2 WHERE id = $1', [actor.staffId, await hashSecret(next)]);
    await q.query('DELETE FROM sessions WHERE staff_id = $1 AND id_hash <> $2', [actor.staffId, actor.sessionHash ?? '']);
    await audit(q, ctx, actor, { action: 'auth.password_changed', targetType: 'staff', targetId: actor.staffId });
  });
}

/** Program lead resets a staff member's password and MFA (e.g. lost phone). */
export async function resetCredentials(ctx: Ctx, actor: Actor, staffId: string, tempPassword: string): Promise<void> {
  requireRole(actor, 'program_lead');
  validPassword(tempPassword);
  await ctx.db.tx(async (q) => {
    const s = await getStaff(q, staffId);
    if (!s || s.org_id !== actor.orgId) fail('Staff member not found.', 404);
    await q.query("UPDATE staff SET password_hash = $2, totp_enabled = false, totp_secret_enc = NULL, recovery_hashes = '{}' WHERE id = $1", [staffId, await hashSecret(tempPassword)]);
    await q.query('DELETE FROM sessions WHERE staff_id = $1', [staffId]);
    await audit(q, ctx, actor, { action: 'staff.reset_credentials', targetType: 'staff', targetId: staffId });
  });
}

// ---------------------------------------------------------------------------
// Conflicts of interest and participant-requested exclusions (HB-SEC-2)
// ---------------------------------------------------------------------------

export async function isConflicted(q: Q, staffId: string, participantId: string): Promise<boolean> {
  return !!(await maybe(q, 'SELECT 1 FROM conflicts WHERE staff_id = $1 AND participant_id = $2', [staffId, participantId]));
}

export async function conflictedStaff(q: Q, participantId: string): Promise<Set<string>> {
  return new Set((await many<{ staff_id: string }>(q, 'SELECT staff_id FROM conflicts WHERE participant_id = $1', [participantId])).map((r) => r.staff_id));
}
