# Architecture and security model

Status: **implemented** (2026-11-15). Not deployed; no real participants. A host stays in training
mode until its readiness items — including legal review — are recorded and an OMH operator approves.

## Shape

One Node.js 22 service (TypeScript, Fastify) serves server-rendered HTML that works without
JavaScript, and runs the scheduler every minute (or a separate `npm run worker`). Data lives in
PostgreSQL. Small, optional scripts add offline recording; nothing else needs JavaScript.

```
src/
  config.ts            workflow parameters (docs/03 §3.2) and environment
  db/                  pool, transactions, schema with constraints and audit triggers
  domain/              all rules — the web layer only calls these
    participants.ts    enrollment, plans and remote-change rules, search, access basis, verification
    contacts.ts        recording, qualification, backdating approval, voiding
    cases.ts           offer chain, acceptance, stall escalation, closure rules, transition table
    detector.ts        overdue detection, daily digest, host-silence alert, escalation hold and roll call
    lifecycle.ts       pause, withdrawal (in-person confirmation for remote requests), reinstatement
    safeguarding.ts    required abuse reports (staff call; Heartbeat records)
    sms.ts             text and keypad check-ins, reminders, follow-up texts, phone confirmation
    relay.ts           partner relays (code + verification answer; identical receipts)
    transfers.ts       host-to-host transfer of responsibility with a minimal package
    continuity.ts      continuity-partner activation and roster
    selfview.ts        participant self-view; optional photos with metadata stripped
    retention.ts       nightly deletion, crypto-shredding, audit redaction, export, chain verification
    metrics.ts         de-identified measures, capacity, pause indicators, monthly access review
    admin.ts           staff accounts, legal hold, break-glass, training data purge
  web/                 routes and HTML templates (escaped by default)
public/                stylesheet, offline page script and service worker
tests/                 vitest against a real PostgreSQL (a temporary cluster is started automatically)
```

## Security model

**Accounts.** Individual staff accounts only, with scrypt password hashes, TOTP multi-factor
authentication (required before any participant data), one-time recovery codes, lockout after five
failed passwords, 15-minute idle timeout on shared devices and 12-hour sessions. Roles take effect in
a live organization only when their training modules are recorded (docs/08 §8.3).

**Who sees what.** Every read of participant detail goes through `accessBasis`, which implements the
matrix in docs/02 §2.3: assignment-based access for responders; a typed reason (a 30-minute grant,
logged) for coordinators and program leads seeing plans; conflicts and participant-requested
exclusions block a staff member entirely except for recording contact. Recorders see name and code
only, and participants who chose code-only lookup never appear in their name searches. Relay users
and continuity stewards have their own narrow paths. OMH operators see organizations and counts;
participant data only through two-person break-glass that notifies the host.

**Encryption and deletion.** Names, other names, phone numbers, notes, named people, messages and
photos are encrypted with AES-256-GCM under a per-participant data key; data keys are wrapped by the
master key (`HEARTBEAT_MASTER_KEY`) and may live in a separate key-store database. Deleting a
participant deletes the row and destroys the key, so copies in backups become unreadable once the
key store's own backups expire. Search decrypts within one organization in memory, which is fine at
pilot scale (thousands of participants, not millions).

**Never collected.** The schema has no fields for immigration status, citizenship, country of birth,
government ID numbers, location or location history, diagnoses, substance use, criminal history or
religion. Free-text notes are short and warn against these.

**Audit.** `audit_events` is append-only (a trigger rejects updates and deletes), hash-chained, and
holds no personal data: participants appear only by random id, which retention removes from contact
events after 90 days; search terms are dropped after 90 days; rows are purged after two years by a
session that sets `heartbeat.audit_purge` (in production, give that right only to the retention
role). Each night the day's event hashes and chain head are exported to separate storage, and
operators can verify the whole chain.

**Web.** CSRF tokens bound to a per-browser cookie plus same-origin checks; strict Content Security
Policy with no inline scripts; no referrers; `Cache-Control: no-store`; `noindex`; logs record
method and route pattern only (no query strings, no IP addresses, no cookies); participant data never
appears in URLs (random ids only) or in notifications (generic text only). Provider webhooks are
authenticated by Twilio-style HMAC signatures, always verified in production.

**Workflow guarantees in the database.** A partial unique index allows one open case per
participant; check constraints enforce the owner/offeree rules for each case state, closure
evidence, program-lead approval for sensitive closures, and a distinct second reviewer for reported
deaths. No scheduled job ever moves a case to `closed`; tests simulate a year of silence to prove it.

## Decisions recorded in code

| Decision | Where |
|---|---|
| D1 — OMH operates the service for host organizations | Operator role, readiness gate, break-glass (`admin.ts`, `orgs.ts`) |
| D2 — text-message check-ins | `sms.ts`, consent choice `sms`, STOP/START/HELP, quiet hours, 10DLC readiness item |
| D5 — TypeScript/Node with PostgreSQL | this repository |
| D6 — remote withdrawal needs personal confirmation | `lifecycle.ts`: remote → `withdrawal_pending` until confirmed in person; never finalized by silence |
| Required abuse reports (2026-11-15) | `safeguarding.ts`, [safeguarding-reports.md](safeguarding-reports.md) |
| D4 legal review not yet available | `org_readiness.legal_review` blocks going live |
