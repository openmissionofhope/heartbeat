import { randomBytes } from 'node:crypto';
import type { Ctx } from './domain/core.js';
import { createOrg, listOrgs } from './domain/orgs.js';
import { enroll } from './domain/participants.js';
import { createStaff, loadActor } from './domain/staff.js';

/**
 * Demo deployment only: a host in training mode, accounts for each role, and made-up participants
 * (one already overdue) so people can see how Heartbeat works. Everyone signs in with the
 * temporary password, then sets up an authenticator app.
 */
export async function seedDemo(ctx: Ctx): Promise<string> {
  const orgs = await listOrgs(ctx.db);
  if (orgs.some((o) => o.name === 'Demo Day Center')) return 'Demo already seeded.';
  const pw = () => randomBytes(9).toString('base64url');
  const lines: string[] = [];
  const operatorOrg = orgs.find((o) => o.kind === 'operator') ?? (await createOrg(ctx, null, { name: 'Open Mission of Hope', kind: 'operator' }));
  const opPw = pw();
  await createStaff(ctx, null, { orgId: operatorOrg.id, email: 'operator@demo.heartbeat.test', displayName: 'Demo Operator', password: opPw, roles: ['operator'] });
  lines.push(`operator@demo.heartbeat.test  ${opPw}  (OMH operator)`);
  const host = await createOrg(ctx, null, { name: 'Demo Day Center', kind: 'host', publicPhone: '+18285550100' });
  const people: [string, string, string[]][] = [
    ['lead@demo.heartbeat.test', 'Demo Program Lead', ['program_lead', 'coordinator', 'enroller', 'responder', 'recorder']],
    ['deputy@demo.heartbeat.test', 'Demo Deputy Coordinator', ['coordinator', 'responder']],
    ['responder@demo.heartbeat.test', 'Demo Responder', ['responder', 'enroller']],
    ['frontdesk@demo.heartbeat.test', 'Demo Front Desk', ['recorder']],
  ];
  const ids: Record<string, string> = {};
  for (const [email, name, roles] of people) {
    const p = pw();
    const s = await createStaff(ctx, null, { orgId: host.id, email, displayName: name, password: p, roles: roles as never });
    ids[email] = s.id;
    lines.push(`${email.padEnd(30)} ${p}  (${roles.join(', ')})`);
  }
  await ctx.db.query('UPDATE organizations SET program_lead_id = $2, coordinator_id = $2, deputy_id = $3 WHERE id = $1',
    [host.id, ids['lead@demo.heartbeat.test'], ids['deputy@demo.heartbeat.test']]);
  const lead = (await loadActor(ctx.db, ids['lead@demo.heartbeat.test']!, null))!;
  const base = { adultConfirmed: true, privateConversation: true, teachBack: true, verificationAnswer: 'blue river', confirmDifferentPerson: true,
    consent: { relays: true, sms: false, keypad: false, continuitySharing: false, photo: false, selfView: true },
    primaryResponderId: ids['responder@demo.heartbeat.test'], backupResponderId: ids['deputy@demo.heartbeat.test'] };
  const made = [
    await enroll(ctx, lead, { ...base, preferredName: 'Sample Person One', plan: { intervalDays: 7, followup: ['records', 'places'], usuallyFound: 'Day center most mornings' } }),
    await enroll(ctx, lead, { ...base, preferredName: 'Sample Person Two', plan: { intervalDays: 14 } }),
    await enroll(ctx, lead, { ...base, preferredName: 'Sample Person Three', plan: { intervalDays: 30, disasterPriority: true, disasterCategory: 'mobility' } }),
  ];
  // Make the first one overdue so the follow-up workflow can be tried at once.
  await ctx.db.query("UPDATE participants SET activated_at = now() - interval '12 days', clock_base_at = now() - interval '12 days' WHERE id = $1", [made[0]!.id]);
  return `Demo seeded. Temporary passwords (each account sets up an authenticator app at first sign-in):\n${lines.join('\n')}\nMade-up participants: ${made.map((m) => m.code).join(', ')} (verification answer for all: "blue river").`;
}
