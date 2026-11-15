import { POLICY } from '../config.js';
import { many, maybe, one, ts } from '../db/index.js';
import { hashSecret, normalizeAnswer } from '../lib/crypto.js';
import { type Actor, type Ctx, SYSTEM, audit, decJson, encJson, fail, requireRole } from './core.js';
import { addBusinessDays, closeForLifecycle } from './cases.js';
import { notify } from './notifications.js';
import { getOrg, hoursFor } from './orgs.js';
import { type ConsentChoices, CONSENT_SCRIPT_VERSION, type NamedPerson, type OtherName, currentPlan, lockParticipant, summarize } from './participants.js';

/**
 * Transfer of responsibility between participating host organizations (docs/07 §7.3). Only a
 * minimal package moves; case history, notes, concerns, contacts, consents and the verification
 * answer do not. Until the receiving organization accepts, the sending host remains accountable.
 */
export async function requestTransfer(ctx: Ctx, actor: Actor, participantId: string, toOrgId: string, opts: { includeOtherNames: boolean; includeNamedPeople: boolean; participantPresent: boolean }): Promise<string> {
  requireRole(actor, 'enroller', 'coordinator', 'program_lead');
  if (!opts.participantPresent) fail('The participant must ask for the transfer in person.');
  const now = ctx.clock.now();
  return ctx.db.tx(async (q) => {
    const p = await lockParticipant(q, participantId);
    if (p.org_id !== actor.orgId) fail('Participant not found.', 404);
    if (p.state !== 'active') fail('Only an active participant can be transferred.');
    const to = await getOrg(q, toOrgId);
    if (to.kind !== 'host' || to.status !== 'live' || to.id === actor.orgId) fail('Choose another participating host organization.');
    const h = await hoursFor(q, await getOrg(q, actor.orgId));
    const row = await one<{ id: string }>(q,
      `INSERT INTO transfers (participant_id, from_org, to_org, include_other_names, include_named_people, created_by, created_at, expires_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id`,
      [p.id, actor.orgId, to.id, opts.includeOtherNames, opts.includeNamedPeople, actor.staffId, ts(now), ts(addBusinessDays(now, POLICY.transferExpiryBusinessDays, h))]);
    await q.query("UPDATE participants SET state = 'transfer_pending', state_changed_at = $2 WHERE id = $1", [p.id, ts(now)]);
    await audit(q, ctx, actor, { action: 'transfer.request', targetType: 'transfer', targetId: row.id, participantId: p.id, details: { to: to.id } });
    for (const id of [to.coordinator_id, to.program_lead_id]) await notify(q, ctx, { staffId: id, orgId: to.id, kind: 'transfer_request', dedupeKey: `tr:${row.id}:${id}` });
    return row.id;
  });
}

export interface TransferPackage {
  transferId: string;
  fromOrg: string;
  preferredName: string;
  otherNames: OtherName[];
  birthYear: number | null;
  languages: string | null;
  accessibility: string | null;
  intervalDays: number;
  qualifyingKinds: string[];
  followup: string[];
  namedPeople: NamedPerson[];
  lastQualifyingAt: Date | null;
  code: string;
}

export async function incomingTransfers(ctx: Ctx, actor: Actor): Promise<TransferPackage[]> {
  requireRole(actor, 'coordinator', 'program_lead');
  const rows = await many<{ id: string; participant_id: string; from_name: string; include_other_names: boolean; include_named_people: boolean }>(ctx.db,
    `SELECT t.id, t.participant_id, o.name AS from_name, t.include_other_names, t.include_named_people FROM transfers t JOIN organizations o ON o.id = t.from_org
      WHERE t.to_org = $1 AND t.status = 'pending' ORDER BY t.created_at`, [actor.orgId]);
  const out: TransferPackage[] = [];
  for (const r of rows) {
    const p = await lockParticipantNoTx(ctx, r.participant_id);
    const s = await summarize(ctx, p);
    const plan = await currentPlan(ctx.db, ctx, p.id);
    out.push({
      transferId: r.id, fromOrg: r.from_name, preferredName: s.name, otherNames: r.include_other_names ? s.otherNames : [],
      birthYear: s.birthYear, languages: s.languages, accessibility: s.accessibility, intervalDays: plan.intervalDays,
      qualifyingKinds: plan.qualifyingKinds, followup: plan.followup, namedPeople: r.include_named_people ? plan.namedPeople : [],
      lastQualifyingAt: p.last_qualifying_at, code: p.code,
    });
    await ctx.db.tx((q) => audit(q, ctx, actor, { action: 'transfer.package_view', targetType: 'transfer', targetId: r.id, participantId: p.id }));
  }
  return out;
}

async function lockParticipantNoTx(ctx: Ctx, id: string) {
  const { getParticipantRow } = await import('./participants.js');
  return getParticipantRow(ctx.db, id);
}

export async function acceptTransfer(ctx: Ctx, actor: Actor, transferId: string, input: { verificationAnswer: string; consent: ConsentChoices; teachBack: boolean; primaryResponderId: string | null; backupResponderId: string | null }): Promise<void> {
  requireRole(actor, 'coordinator', 'program_lead');
  if (!input.teachBack) fail('The receiving organization holds its own consent conversation with teach-back.');
  const answer = normalizeAnswer(input.verificationAnswer);
  if (answer.length < 3) fail('The participant sets a new verification answer of at least 3 letters or numbers.');
  const vh = await hashSecret(answer);
  const now = ctx.clock.now();
  await ctx.db.tx(async (q) => {
    const t = await maybe<{ id: string; participant_id: string; from_org: string; to_org: string; status: string; include_other_names: boolean; include_named_people: boolean }>(q, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [transferId]);
    if (!t || t.to_org !== actor.orgId || t.status !== 'pending') fail('Transfer not found.', 404);
    const p = await lockParticipant(q, t!.participant_id);
    for (const [id, label] of [[input.primaryResponderId, 'primary'], [input.backupResponderId, 'backup']] as const) {
      if (!id) continue;
      const s = await maybe<{ org_id: string; roles: string[] }>(q, 'SELECT org_id, roles FROM staff WHERE id = $1 AND active', [id]);
      if (!s || s.org_id !== actor.orgId || !s.roles.includes('responder')) fail(`The ${label} responder must be a responder here.`);
    }
    await closeForLifecycle(q, ctx, actor, p.id, 'transferred');
    const plan = await currentPlan(q, ctx, p.id);
    const others = t!.include_other_names ? await decJson<OtherName[]>(ctx, p.id, 'other_names', p.other_names_enc, []) : [];
    await q.query(`UPDATE participants SET org_id = $2, hosted_since = $3, state = 'active', state_changed_at = $3, verification_hash = $4, verification_failures = 0,
        verification_locked_until = NULL, primary_responder_id = $5, backup_responder_id = $6, other_names_enc = $7, photo_enc = NULL, tell_pending = false,
        clock_base_at = $3, clock_return = false, keypad_pin_hash = NULL, self_view_code_hash = NULL WHERE id = $1`,
    [p.id, actor.orgId, ts(now), vh, input.primaryResponderId, input.backupResponderId, await encJson(ctx, p.id, 'other_names', others)]);
    await q.query('DELETE FROM conflicts WHERE participant_id = $1', [p.id]);
    await q.query(`INSERT INTO consents (participant_id, org_id, script_version, choices, teach_back, method, witnessed_by, created_at) VALUES ($1,$2,$3,$4,true,'in_person',$5,$6)`,
      [p.id, actor.orgId, CONSENT_SCRIPT_VERSION, JSON.stringify(input.consent), actor.staffId, ts(now)]);
    await q.query('UPDATE plan_versions SET superseded_at = $2 WHERE participant_id = $1 AND superseded_at IS NULL', [p.id, ts(now)]);
    await q.query(
      `INSERT INTO plan_versions (participant_id, version, interval_days, grace_days, qualifying_kinds, followup, named_people_enc, tell_me_if_asked, disaster_priority,
         disaster_category, change_channel, changed_fields, changed_by, confirmed_in_person_at, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'in_person','{transfer}',$11,$12,$12)`,
      [p.id, plan.version + 1, plan.intervalDays, plan.graceDays, plan.qualifyingKinds.filter((k) => k !== 'self_check_in'), plan.followup.filter((f) => f === 'records' || (f === 'people' && t!.include_named_people)),
        t!.include_named_people ? await encJson(ctx, p.id, 'named_people', plan.namedPeople) : null, plan.tellMeIfAsked, plan.disasterPriority, plan.disasterCategory, actor.staffId, ts(now)]);
    await q.query("UPDATE transfers SET status = 'accepted', decided_by = $2, decided_at = $3 WHERE id = $1", [t!.id, actor.staffId, ts(now)]);
    await audit(q, ctx, actor, { action: 'transfer.accept', targetType: 'transfer', targetId: t!.id, participantId: p.id, details: { from: t!.from_org } });
  });
}

export async function declineTransfer(ctx: Ctx, actor: Actor, transferId: string): Promise<void> {
  requireRole(actor, 'coordinator', 'program_lead');
  await ctx.db.tx(async (q) => {
    const t = await maybe<{ id: string; participant_id: string; from_org: string; to_org: string; status: string }>(q, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [transferId]);
    if (!t || t.to_org !== actor.orgId || t.status !== 'pending') fail('Transfer not found.', 404);
    await q.query("UPDATE transfers SET status = 'declined', decided_by = $2, decided_at = $3 WHERE id = $1", [t!.id, actor.staffId, ts(ctx.clock.now())]);
    await q.query("UPDATE participants SET state = 'active' WHERE id = $1 AND state = 'transfer_pending'", [t!.participant_id]);
    await audit(q, ctx, actor, { action: 'transfer.decline', targetType: 'transfer', targetId: t!.id, participantId: t!.participant_id });
    const from = await getOrg(q, t!.from_org);
    await notify(q, ctx, { staffId: from.coordinator_id, orgId: from.id, kind: 'transfer_expired', dedupeKey: `trd:${t!.id}` });
  });
}

export async function expireTransfers(ctx: Ctx): Promise<number> {
  const rows = await many<{ id: string; participant_id: string; from_org: string }>(ctx.db, "SELECT id, participant_id, from_org FROM transfers WHERE status = 'pending' AND expires_at <= $1", [ts(ctx.clock.now())]);
  for (const t of rows) {
    await ctx.db.tx(async (q) => {
      await q.query("UPDATE transfers SET status = 'expired', decided_at = $2 WHERE id = $1 AND status = 'pending'", [t.id, ts(ctx.clock.now())]);
      await q.query("UPDATE participants SET state = 'active' WHERE id = $1 AND state = 'transfer_pending'", [t.participant_id]);
      await audit(q, ctx, SYSTEM, { action: 'transfer.expired', targetType: 'transfer', targetId: t.id, participantId: t.participant_id });
      const from = await getOrg(q, t.from_org);
      await notify(q, ctx, { staffId: from.coordinator_id, orgId: from.id, kind: 'transfer_expired', dedupeKey: `tre:${t.id}` });
    });
  }
  return rows.length;
}
