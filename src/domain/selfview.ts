import { many, maybe, ts } from '../db/index.js';
import { DAY } from '../lib/calendar.js';
import { hashSecret, hmac, newRecoveryCode, normalizeCode, safeEqual, verifySecret } from '../lib/crypto.js';
import { type Actor, type Ctx, audit, decBytes, encBytes, fail, has, requireRole } from './core.js';
import { getOrg } from './orgs.js';
import { type ParticipantRow, accessBasis, hasGrant, checkVerification, currentPlan, findByCode, getParticipantRow, latestConsent, lockParticipant, summarize } from './participants.js';
import { openCaseFor } from './cases.js';

// ---------------------------------------------------------------------------
// Participant self-view (HB-P2-4): no smartphone or account needed. Staff give the participant a
// one-time access code on paper; with their participant code and verification answer they can
// read (not change) what is held about them and who has looked at it.
// ---------------------------------------------------------------------------

export async function issueSelfViewCode(ctx: Ctx, actor: Actor, participantId: string): Promise<string> {
  requireRole(actor, 'enroller', 'coordinator', 'program_lead', 'responder');
  const code = newRecoveryCode(3);
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    if (!(await latestConsent(q, p.id)).selfView) fail('The participant has not chosen self-view.');
    await q.query('UPDATE participants SET self_view_code_hash = $2, self_view_code_expires = $3 WHERE id = $1', [p.id, await hashSecret(normalizeCode(code)), ts(ctx.clock.now() + 7 * DAY)]);
    await audit(q, ctx, actor, { action: 'selfview.code_issued', targetType: 'participant', targetId: p.id, participantId: p.id });
  });
  return code;
}

export function selfViewToken(ctx: Ctx, participantId: string, expires: number): string {
  return `${participantId}.${expires}.${hmac(ctx.config.secret, 'selfview', participantId, String(expires))}`;
}

export function readSelfViewToken(ctx: Ctx, token: string | undefined): string | null {
  if (!token) return null;
  const [id, exp, mac] = token.split('.');
  if (!id || !exp || !mac || Number(exp) < ctx.clock.now()) return null;
  return safeEqual(hmac(ctx.config.secret, 'selfview', id, exp), mac) ? id : null;
}

/** Returns a 10-minute token, or null. The one-time code is used up on success. */
export async function selfViewLogin(ctx: Ctx, input: { code: string; answer: string; oneTime: string }): Promise<string | null> {
  return ctx.db.tx(async (q) => {
    const found = await findByCode(q, input.code);
    if (!found) return null;
    const p = await maybe<ParticipantRow>(q, 'SELECT * FROM participants WHERE id = $1 FOR UPDATE', [found.id]);
    if (!p || !['active', 'paused', 'withdrawal_pending', 'transfer_pending'].includes(p.state)) return null;
    const now = ctx.clock.now();
    if (!p.self_view_code_hash || !p.self_view_code_expires || p.self_view_code_expires.getTime() < now) return null;
    const v = await checkVerification(q, ctx, p, input.answer, { kind: 'participant', orgId: p.org_id });
    if (v !== 'ok') return null;
    if (!(await verifySecret(normalizeCode(input.oneTime), p.self_view_code_hash))) return null;
    await q.query('UPDATE participants SET self_view_code_hash = NULL, self_view_code_expires = NULL WHERE id = $1', [p.id]);
    await audit(q, ctx, { kind: 'participant', orgId: p.org_id }, { action: 'selfview.signin', targetType: 'participant', targetId: p.id, participantId: p.id });
    return selfViewToken(ctx, p.id, now + 10 * 60_000);
  });
}

export async function selfViewData(ctx: Ctx, participantId: string) {
  const p = await getParticipantRow(ctx.db, participantId);
  const org = await getOrg(ctx.db, p.org_id);
  const summary = await summarize(ctx, p);
  const plan = await currentPlan(ctx.db, ctx, p.id);
  const open = await openCaseFor(ctx.db, p.id);
  const access = await accessSummary(ctx, p.id);
  await ctx.db.tx((q) => audit(q, ctx, { kind: 'participant', orgId: p.org_id }, { action: 'selfview.view', targetType: 'participant', targetId: p.id, participantId: p.id }));
  return { org, summary, plan, followUpOpen: !!open, access };
}

/** Which roles and organizations viewed or changed the record, and when (names on request via the program lead). */
export async function accessSummary(ctx: Ctx, participantId: string) {
  return many<{ day: string; role_org: string; action: string; n: string }>(ctx.db,
    `SELECT to_char(a.at, 'YYYY-MM-DD') AS day, COALESCE(o.name, CASE a.actor_type WHEN 'system' THEN 'Heartbeat (automatic)' WHEN 'participant' THEN 'You' ELSE 'Text/phone service' END) AS role_org,
            split_part(a.action, '.', 1) || '.' || split_part(a.action, '.', 2) AS action, count(*) AS n
       FROM audit_events a LEFT JOIN organizations o ON o.id = a.actor_org
      WHERE a.participant_id = $1 GROUP BY 1, 2, 3 ORDER BY 1 DESC LIMIT 500`, [participantId]);
}

// ---------------------------------------------------------------------------
// Optional photo (HB-P2-3): off unless the host enables photos and the participant agrees.
// Metadata (including any GPS location) is stripped before encryption.
// ---------------------------------------------------------------------------

export function stripImageMetadata(buf: Buffer): { data: Buffer; mime: 'image/jpeg' | 'image/png' } {
  if (buf.length > 2 * 1024 * 1024) fail('Photos must be 2 MB or smaller.');
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const out: Buffer[] = [buf.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) fail('That JPEG file is damaged.');
      const marker = buf[i + 1]!;
      if (marker === 0xda) {
        out.push(buf.subarray(i));
        break;
      }
      const len = buf.readUInt16BE(i + 2);
      const seg = buf.subarray(i, i + 2 + len);
      const isApp = marker >= 0xe1 && marker <= 0xef; // APP1–APP15 (Exif, XMP, …); keep APP0 (JFIF)
      if (!isApp && marker !== 0xfe) out.push(seg);
      i += 2 + len;
    }
    return { data: Buffer.concat(out), mime: 'image/jpeg' };
  }
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const out: Buffer[] = [buf.subarray(0, 8)];
    let i = 8;
    const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs']);
    while (i + 12 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const type = buf.subarray(i + 4, i + 8).toString('latin1');
      const chunk = buf.subarray(i, i + 12 + len);
      if (keep.has(type)) out.push(chunk);
      i += 12 + len;
      if (type === 'IEND') break;
    }
    return { data: Buffer.concat(out), mime: 'image/png' };
  }
  return fail('Use a JPEG or PNG photo.');
}

export async function setPhoto(ctx: Ctx, actor: Actor, participantId: string, image: Buffer): Promise<void> {
  requireRole(actor, 'enroller', 'coordinator', 'program_lead');
  const { data, mime } = stripImageMetadata(image);
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    const org = await getOrg(q, p.org_id);
    if (!org.photos_enabled) fail('Photos are turned off for this organization.');
    if (!(await latestConsent(q, p.id)).photo) fail('The participant has not agreed to a photo.');
    const payload = Buffer.concat([Buffer.from(mime === 'image/png' ? 'P' : 'J'), data]);
    await q.query('UPDATE participants SET photo_enc = $2 WHERE id = $1', [p.id, await encBytes(ctx, p.id, 'photo', payload)]);
    await audit(q, ctx, actor, { action: 'participant.photo_set', targetType: 'participant', targetId: p.id, participantId: p.id });
  });
}

export async function getPhoto(ctx: Ctx, actor: Actor, participantId: string): Promise<{ data: Buffer; mime: string } | null> {
  const p = await getParticipantRow(ctx.db, participantId);
  const basis = await accessBasis(ctx.db, ctx, actor, p, 'plan');
  if (basis !== 'assignment' && !(has(actor, 'coordinator', 'program_lead') && (await hasGrant(ctx.db, ctx, actor, p.id)))) {
    fail('Photos are visible only to the assigned responder, and to coordinators who give a reason.', 403);
  }
  const raw = await decBytes(ctx, p.id, 'photo', p.photo_enc);
  if (!raw) return null;
  await ctx.db.tx((q) => audit(q, ctx, actor, { action: 'participant.photo_view', targetType: 'participant', targetId: p.id, participantId: p.id, basis: basis ?? 'coordinator' }));
  return { data: raw.subarray(1), mime: raw[0] === 0x50 ? 'image/png' : 'image/jpeg' };
}

export async function deletePhoto(ctx: Ctx, actor: Actor, participantId: string): Promise<void> {
  requireRole(actor, 'enroller', 'coordinator', 'program_lead');
  await ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    await q.query('UPDATE participants SET photo_enc = NULL WHERE id = $1', [p.id]);
    await audit(q, ctx, actor, { action: 'participant.photo_deleted', targetType: 'participant', targetId: p.id, participantId: p.id });
  });
}
