import { randomBytes } from 'node:crypto';
import { createContext } from './context.js';
import { createOrg, listOrgs } from './domain/orgs.js';
import { exportAuditDay, runRetention, verifyAuditChain } from './domain/retention.js';
import { createStaff } from './domain/staff.js';

const [cmd, ...args] = process.argv.slice(2);
const usage = `Usage:
  heartbeat genkey                                  print a new HEARTBEAT_MASTER_KEY
  heartbeat bootstrap-operator <email> <name>       create the OMH operator organization and first operator (prints a temporary password)
  heartbeat orgs                                    list organizations
  heartbeat retention                               run retention now
  heartbeat audit-export [YYYY-MM-DD]               export an audit checkpoint
  heartbeat audit-verify                            verify the audit hash chain
  heartbeat seed-demo                               (demo deployments only) create a training host, accounts and made-up participants`;

if (cmd === 'genkey') {
  console.log(randomBytes(32).toString('base64'));
  process.exit(0);
}
const ctx = await createContext({ workers: false });
try {
  switch (cmd) {
    case 'bootstrap-operator': {
      const [email, ...name] = args;
      if (!email || !name.length) throw new Error(usage);
      const existing = (await listOrgs(ctx.db)).find((o) => o.kind === 'operator');
      const org = existing ?? (await createOrg(ctx, null, { name: 'Open Mission of Hope', kind: 'operator' }));
      const password = randomBytes(12).toString('base64url');
      await createStaff(ctx, null, { orgId: org.id, email, displayName: name.join(' '), password, roles: ['operator'] });
      console.log(`Operator created. Temporary password: ${password}\nSign in, set up the authenticator, then change the password.`);
      break;
    }
    case 'seed-demo': {
      if (!ctx.config.demo) throw new Error('seed-demo runs only with HEARTBEAT_DEMO=1.');
      const { seedDemo } = await import('./demo.js');
      console.log(await seedDemo(ctx));
      break;
    }
    case 'orgs':
      for (const o of await listOrgs(ctx.db)) console.log(`${o.id}  ${o.kind.padEnd(8)} ${o.status.padEnd(6)} ${o.name}`);
      break;
    case 'retention':
      console.log(await runRetention(ctx));
      break;
    case 'audit-export':
      console.log(await exportAuditDay(ctx, args[0]));
      break;
    case 'audit-verify':
      console.log(await verifyAuditChain(ctx));
      break;
    default:
      console.log(usage);
  }
} finally {
  await ctx.db.close();
}
