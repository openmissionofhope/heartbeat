# OMH Heartbeat

**If someone who asked to be noticed stops being seen, an accountable person follows up.**

Heartbeat is an [Open Mission of Hope](https://openmissionofhope.org) program and the software that
supports it. A person enrolls voluntarily through an organization they trust and agrees how often
they expect to be in touch. Staff record meaningful contact; participants who choose to can also
check in by text or phone keypad. When expected contact becomes overdue, a named social-service
responder must explicitly accept a follow-up task, is backed up if they don't, and documents what
they tried until the case closes for a stated reason. Silence never closes a case and never means
death.

The name refers to a heartbeat in computing — a regular signal whose absence gets noticed.

A recorded contact is **not** proof that someone is safe. People can be impersonated, mistaken for
someone else, or coerced into checking in, and an abused person may still be in contact with
others. Heartbeat is not emergency help, not a tracker, and not a way to find anyone.

## Status (2026-11-15)

| Part | State |
|---|---|
| Software | **Built and tested** (TypeScript, Fastify, PostgreSQL; automated tests against a real database). |
| Demo | **https://heartbeat.openmissionofhope.org** (also https://omh-heartbeat.fly.dev): made-up information only; no organization can go live there ([docs/OPERATIONS.md §7](docs/OPERATIONS.md#7-the-demo-deployment)). No real deployment and no real participants. |
| Readiness gate | Every host starts in training mode (made-up participants only) and cannot go live until it records legal review, a signed agreement, tested consent materials, training, drills, a security review and texting registration, and an OMH operator approves. |
| Legal review | **Not available yet** — the blocking questions are in [docs/legal-review.md](docs/legal-review.md). |
| First pilot | Proposed: consenting adults experiencing homelessness in the Asheville, NC area, through one outreach or day-service organization. **No organization has been approached or has agreed to anything.** |
| Repository history | Created 2026-02-02 with a one-line description ("Append-only logging of human presence and absence"). The audit trail is append-only; personal information is not, because participants must be able to delete it ([docs/04 §4.5](docs/04-data-retention-audit.md#45-deletion-approach)). |

## What it does

1. **The participant sets the plan**: interval (7, 14 or 30 days), what counts as contact, which
   follow-up they consent to (from "check records only" up to "look where I'm usually found" or "ask
   the people I name"), what may be said on the phone, who may be asked, texts and keypad check-ins,
   pauses and withdrawal. No smartphone, app, address, ID or reachable relative is needed.
2. **Every contact is labelled** by kind (in person, phone with staff, relay, self-check-in,
   secondhand) and identity confidence. Only contact with a known or verified person resets the clock;
   the rest are leads.
3. **Accountability by explicit acceptance.** Primary responder → backup → coordinator, with 3, 3 and
   2 business hours to accept, so someone owns every overdue case within one business day; otherwise
   it is *uncovered* and the program lead is alerted every morning. Stalled cases pass to the backup.
   No job ever closes a case.
4. **Closure only for a reason** — contact restored, withdrawal, verified transfer, a reported death
   from a listed source with two-person approval, or a documented outcome approved by the program lead.
5. **Guarding against controlling people.** No public lookup; staff neither confirm nor deny
   enrollment; remote changes that reduce follow-up need a verified caller and are flagged; a
   remote withdrawal stops all outreach at once but takes effect only when the participant confirms
   in person; participants can exclude named staff or be found by code only.
6. **Minimum data, encrypted.** No location history, immigration status, ID numbers, diagnoses or
   religion. Personal fields are encrypted under a per-participant key that is destroyed on deletion.
   Contacts are deleted after 90 days; every view is audited and participants can see who looked.
7. **Disaster-ready.** Hosted outside western NC; a roll-call mode replaces a flood of alerts with one
   prioritized list; paper forms, a printed continuity sheet, offline recording, relays from partner
   organizations, and an optional continuity partner.
8. **Heartbeat watches itself.** The overdue detector reports every business morning, even with
   nothing to report; `/healthz` fails if it goes stale; OMH is alerted if a host goes silent.

## Decisions

Recorded in [docs/11](docs/11-roadmap-and-decisions.md#112-decisions).

* **Made:** OMH operates the service for host organizations (D1); text-message check-ins (D2); build
  the whole backlog now; TypeScript/Node with PostgreSQL (D5); remote withdrawal needs the
  participant's personal confirmation (D6); required abuse reports ([policy](docs/safeguarding-reports.md)).
* **Open:** qualified legal review (D4, blocking); finding a host organization and the people to
  staff it (D3, D7); evaluation ethics and interview pay (D8).

## Boundaries

* No law-enforcement or immigration-enforcement integrations, access, data feeds or automatic
  notifications. Social-service responders own follow-up.
* **Required reports are made by staff, by phone**: abuse of a child to police and county child
  protective services; abuse by an intimate partner to police; a disabled adult who needs protective
  services to county adult protective services. Heartbeat records only that the report was made.
  **Nobody is ever reported for possible immigration violations.** ([policy](docs/safeguarding-reports.md))
* No immigration status; no continuous location tracking, movement history, public person-search or
  public status lookup.
* Works without a smartphone, app, stable address or dependable relative.
* Voluntary. Help never depends on enrolling, religious participation or loyalty to OMH.
* Separate from emergency response and distress signaling; promises no rescue, survival or
  protection from abuse.
* Children are excluded until separate safeguarding work is done ([docs/children.md](docs/children.md)).

Changing a boundary is a public governance decision by OMH, not a feature request.

## Run it

Requires Node.js 22 and PostgreSQL 14+. Details in [docs/OPERATIONS.md](docs/OPERATIONS.md).

```bash
npm ci
createdb heartbeat && export DATABASE_URL=postgres:///heartbeat
npm run cli:dev -- bootstrap-operator you@example.org "Your Name"
npm run dev        # http://localhost:8080
npm test           # starts its own temporary PostgreSQL
```

## Documents

| # | Document | Covers |
|---|---|---|
| 1 | [Charter, non-goals and pilot](docs/01-charter.md) | Purpose, principles, non-goals, bounded pilot, terms |
| 2 | [Roles and permissions](docs/02-roles-and-permissions.md) | Roles, permission matrix, participant control, accountability |
| 3 | [Workflow and states](docs/03-workflow-and-states.md) | Enrollment, contact, overdue, escalation, follow-up, closure, state machines, parameters |
| 4 | [Data, retention and audit](docs/04-data-retention-audit.md) | Data model, never-collected list, retention, deletion, access audit |
| 5 | [Backlog](docs/05-mvp-backlog.md) | Items with acceptance criteria (all built) |
| 6 | [Failure modes and abuse](docs/06-failure-modes-and-abuse.md) | Required scenarios, misuse, system failures, residual limits |
| 7 | [Disaster and cross-organization continuity](docs/07-disaster-continuity.md) | Continuity requirements; relays; transfers; continuity partners |
| 8 | [Pilot operations](docs/08-pilot-operations.md) | Staffing, capacity, training, coverage, pause criteria, stage gates |
| 9 | [Evaluation](docs/09-evaluation.md) | Measures and targets |
| 10 | [Partner questions](docs/10-partner-questions.md) | First conversation with an Asheville outreach organization |
| 11 | [Roadmap and decisions](docs/11-roadmap-and-decisions.md) | Phases, decisions made and open |
| — | [Architecture and security](docs/ARCHITECTURE.md) | How the software is built and protected |
| — | [Operations](docs/OPERATIONS.md) | Configuration, hosting, texting setup, going live |
| — | [Required abuse reports](docs/safeguarding-reports.md) | OMH reporting policy and how it works |
| — | [Children](docs/children.md) | Safeguarding work required before inclusion |
| — | [Legal review](docs/legal-review.md) | Questions for North Carolina counsel (not legal advice) |
| — | [Context and sources](docs/context-and-sources.md) | Sourced facts, kept apart from recommendations |

[prompts/init.md](prompts/init.md) is the brief this design responds to. Security issues:
[SECURITY.md](SECURITY.md).

## Acknowledgments

Thank you to Elizabeth Johnson, a friend and former colleague, and to Harland Biggs of NC Baptists
on Mission, for supporting Heartbeat. Their support is personal; it is not an endorsement by NC
Baptists on Mission or any other organization, and no organization has agreed to host or partner in
a pilot.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
