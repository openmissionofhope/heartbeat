import type { Q } from '../db/index.js';
import { ts } from '../db/index.js';
import { type Actor, type Ctx, audit, enc } from './core.js';
import { openCaseFor } from './cases.js';

/** Closes an open case as a program-lead-approved documented outcome (used for long-pending withdrawals). */
export async function closeForLifecycleOther(q: Q, ctx: Ctx, actor: Actor, participantId: string, note: string): Promise<void> {
  const c = await openCaseFor(q, participantId);
  if (!c) return;
  await q.query(
    `UPDATE cases SET state = 'closed', closure_reason = 'other_documented', closed_at = $2, closed_by = $3, approved_by = $3, closure_note_enc = $4,
       offeree_id = NULL, offered_at = NULL, offer_expires_at = NULL, uncovered_since = NULL WHERE id = $1`,
    [c.id, ts(ctx.clock.now()), actor.staffId, await enc(ctx, participantId, 'closure_note', note)]);
  await audit(q, ctx, actor, { action: 'case.close', targetType: 'case', targetId: c.id, participantId, details: { reason: 'other_documented' } });
}
