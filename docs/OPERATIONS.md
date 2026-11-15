# Operations

Status: Heartbeat is **not deployed**. This is how OMH would run it once a host and legal review
exist. Nothing here authorizes enrolling real people: the readiness gate does that, per host.

## 1. Run it locally

Requires Node.js 22 and PostgreSQL 14+.

```bash
npm ci
createdb heartbeat
export DATABASE_URL=postgres:///heartbeat
npm run cli:dev -- bootstrap-operator you@example.org "Your Name"   # prints a temporary password
npm run dev                                                      # http://localhost:8080
npm test                                                         # starts its own temporary PostgreSQL
```

Sign in as the operator, set up the authenticator, create a host organization and its program lead
on **Operator**. The host starts in **setup** (training mode): everything works, but participants are
marked as training data and must be deleted before the host can go live. In development, email and
texts are printed to the console.

## 2. Configuration

See [.env.example](../.env.example). In production `HEARTBEAT_MASTER_KEY` and `HEARTBEAT_SECRET` are
required, cookies are secure, and webhook signatures are always verified.

**Recommended database roles** (create once; adjust names):

```sql
CREATE ROLE heartbeat_app LOGIN PASSWORD '…';
CREATE ROLE heartbeat_retention LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE heartbeat TO heartbeat_app, heartbeat_retention;
-- after the first migration, run as the owner:
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO heartbeat_app, heartbeat_retention;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO heartbeat_app, heartbeat_retention;
REVOKE UPDATE, DELETE ON audit_events FROM heartbeat_app;   -- the app can only append
```

Set `DATABASE_URL` to the app role and `RETENTION_DATABASE_URL` to the retention role. Put the
participant key store (`KEYSTORE_DATABASE_URL`) in a separate small database whose backups are kept
for only 7–14 days: deleting a key then makes that participant's data in older main-database backups
unreadable.

## 3. Hosting and continuity (docs/07 §7.1)

* Host outside western North Carolina (for example, a US-East region), with managed PostgreSQL,
  daily encrypted backups kept 30 days, and point-in-time recovery.
* Rehearse a restore before a host goes live and every quarter; record it as the `restore_drill`
  readiness item (it must be within 90 days to go live).
* Point an external uptime monitor at `GET /healthz`. It returns 503 if the database is unreachable
  or any live host's overdue detector has not completed within 2 staffed hours.
* Audit export (`HEARTBEAT_AUDIT_EXPORT_DIR`) should be write-once storage the application account
  cannot overwrite (for example, an object-locked bucket mounted for writing only).
* The OMH operator is alerted by email when a host has cases uncovered for two business days or no
  staff sign-ins for two staffed days, and when an escalation hold goes unconfirmed. The operator's
  job is to phone the host's program lead; operators cannot act on participant data.

## 4. Text messages and keypad check-ins

1. Buy a US long-code number per host and set it on **Operator** (it identifies the host for inbound
   texts and calls).
2. Register the brand and campaign for A2P 10DLC (verified brand; charity use case needs 501(c)(3)
   status), with consent wording reviewed by counsel. Record it as the `sms_registration` readiness
   item.
3. Point the number's messaging webhook to `POST /hooks/sms` and voice webhook to `POST /hooks/voice`.
4. Set `HEARTBEAT_SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.

Texts go only to participants who agreed to texts; STOP, START and HELP are handled; reminders and
follow-up texts are sent only between 8 am and 9 pm local time; message wording never says "safe",
never names the participant, and always says Heartbeat is not emergency help.

## 5. Going live for a host

The program lead records every readiness item with a reference (Admin → Readiness):
legal review, host agreement, tested consent materials, complaint route, staff training, tabletop
exercises, disaster drill, restore drill, security review, texting registration. They delete the
training participants. An OMH operator then approves going live. Before that, the host's numbers for
required reports (police non-emergency, county adult and child protective services intake) should be
set on Admin.

## 6. Routine

| When | Who | What |
|---|---|---|
| Every staffed morning | Coordinator | Read the digest; check uncovered and stalled cases and the detector's last run |
| Weekly | Coordinator | Closure review (self-report closures highlighted); capacity; recording gaps |
| Monthly | Program lead | Access review and sign-off; pause indicators; time logs |
| Quarterly | OMH operator | Restore drill; `npm run cli -- audit-verify` |
| Nightly (automatic) | System | Retention, audit export |
