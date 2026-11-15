import { POLICY } from '../config.js';
import { maybe, one, ts } from '../db/index.js';
import { parseParticipantCode } from '../lib/codes.js';
import { hmac } from '../lib/crypto.js';
import { type Actor, type Ctx, audit, clampText, fail, requireRole } from './core.js';
import { recordContactInTx } from './contacts.js';
import { checkVerification, latestConsent } from './participants.js';

/** The only thing a relay user is ever told (docs/07 §7.2). Identical for every outcome. */
export const RELAY_RECEIPT = 'Thank you. If this code is active, the person’s host organization has been told. If the person wants to speak with their host, let them use a phone.';

/**
 * Relays: staff at another participating organization record that a participant was there,
 * with the participant's code and verification answer, and see nothing about them.
 */
export async function recordRelay(ctx: Ctx, actor: Actor, input: { code: string; answer: string; message?: string | null }): Promise<string> {
  requireRole(actor, 'relay', 'recorder', 'coordinator', 'program_lead');
  const message = clampText(input.message, POLICY.noteMax.relay);
  const now = ctx.clock.now();
  const recent = await one<{ n: string }>(ctx.db, 'SELECT count(*) AS n FROM relay_attempts WHERE staff_id = $1 AND at >= $2', [actor.staffId, ts(now - 3_600_000)]);
  if (Number(recent.n) >= POLICY.relayRate.perStaffPerHour) fail('Too many relays in the last hour. Please try again later.', 429);
  const code = parseParticipantCode(input.code);
  const codeHash = hmac(ctx.config.secret, 'relay', code ?? input.code.toUpperCase());
  await ctx.db.tx(async (q) => {
    let ok = false;
    if (code) {
      const p = await maybe<Parameters<typeof checkVerification>[2]>(q, 'SELECT * FROM participants WHERE code = $1 FOR UPDATE', [code]);
      if (p && p.org_id !== actor.orgId && ['active', 'paused', 'withdrawal_pending', 'transfer_pending', 'inactive'].includes(p.state)) {
        const consent = await latestConsent(q, p.id);
        const result = await checkVerification(q, ctx, p, input.answer, actor);
        if (result === 'ok' && consent.relays) {
          await recordContactInTx(q, ctx, actor, { participantId: p.id, kind: 'relay', confidence: 'verified', source: 'relay', relayMessage: message, recordedOrg: actor.orgId });
          ok = true;
        }
      }
    }
    await q.query('INSERT INTO relay_attempts (staff_id, code_hash, at, ok) VALUES ($1,$2,$3,$4)', [actor.staffId, codeHash, ts(now), ok]);
    if (!ok) await audit(q, ctx, actor, { action: 'relay.attempt', outcome: 'denied' });
  });
  return RELAY_RECEIPT;
}
