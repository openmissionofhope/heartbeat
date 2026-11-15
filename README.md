# OMH Heartbeat

**If someone who asked to be noticed stops being seen, an accountable person follows up.**

Heartbeat is a proposed [Open Mission of Hope](https://openmissionofhope.org) program and small
piece of software. A person enrolls voluntarily through an organization they trust and agrees how
often they expect to be in touch. Staff record meaningful contact. When expected contact becomes
overdue, a named social-service responder must explicitly accept a follow-up task, is backed up if
they don't, and documents what they tried until the case closes for a stated reason. Silence never
closes a case and never means death.

The name refers to a heartbeat in computing — a regular signal whose absence gets noticed.

A recorded contact is **not** proof that someone is safe. People can be impersonated, mistaken for
someone else, or coerced into checking in, and an abused person may still be in contact with
others. Heartbeat is not emergency help, not a tracker, and not a way to find anyone.

## Status (2026-11-14)

| Part | State |
|---|---|
| Software | **None.** No code, no deployment, no participants. |
| Product, pilot and operating design | **Proposed** in [`docs/`](docs/) for review |
| First pilot | Proposed: consenting adults experiencing homelessness in the Asheville, NC area, through one outreach or day-service organization. **No organization has been approached, has endorsed Heartbeat, or has agreed to anything.** |
| Legal review | Not started; questions in [docs/legal-review.md](docs/legal-review.md), several blocking |
| Repository history | Created 2026-02-02 with a one-line description ("Append-only logging of human presence and absence"), the Apache 2.0 license and a Rust `.gitignore`. Nothing else had been specified or built. The design keeps append-only for the audit trail but not for personal information, which participants must be able to delete ([docs/04 §4.5](docs/04-data-retention-audit.md#45-deletion-approach)). |

## Recommended design in brief

1. **Small, staff-mediated pilot.** Up to 15 participants for 8 weeks, then up to 40, only if the
   gates are met. Contact is in person or by phone with staff; no app, smartphone, address, ID or
   reachable relative needed. No automated texting until the follow-up loop is proven.
2. **The participant sets the plan**: interval (7, 14 or 30 days), what counts as contact, which
   follow-up they consent to (from "check records only" up to "look where I'm usually found" or "ask
   the people I name"), what may be said on the phone, who may be asked, pauses and withdrawal.
3. **Every contact is labelled** by kind (in person, phone with staff, relay, self-check-in,
   secondhand) and identity confidence. Only firsthand contact with a known or verified person
   resets the clock (plus the participant's own messages, if they choose); the rest are leads.
4. **Accountability by explicit acceptance.** Primary responder → backup → coordinator, with 3, 3
   and 2 business hours to accept, so someone owns every overdue case within one business day; then
   the case is *uncovered* and the program lead is alerted every morning until someone owns it.
   Stalled cases pass to the backup. The system never closes a case on its own.
5. **Closure only for a reason** — contact restored, withdrawal, verified transfer, a reported death
   from a listed source with two-person approval, or a documented outcome approved by the program
   lead. "Extended watch"
   keeps unresolved cases open at a lower cadence.
6. **Guarding against controlling people.** No public lookup and a neither-confirm-nor-deny rule;
   safety-reducing changes made remotely need a verified caller and are flagged; remote withdrawal is
   confirmed in person or by a recorded coordinator decision, never by silence; participants can
   exclude named staff or ask to be found by code only. Someone who knows a participant's
   verification answer can still impersonate them — a stated limit.
7. **Minimum data.** No location history, immigration status, ID numbers, diagnoses or religion.
   Contacts are deleted after 90 days, notes 180 days after a case closes; every view is audited and
   participants can see who looked.
8. **Disaster-ready.** Hosted outside western North Carolina; a roll-call mode replaces a flood of
   alerts with one prioritized list; paper forms and a printed continuity sheet; a phone number that
   works when the building doesn't.
9. **Heartbeat watches itself.** The overdue detector reports every business morning, even with
   nothing to report; a missing report is the alarm.
10. **Measured by follow-up**, not check-ins: time to acceptance, completed and well-documented
    follow-up, participant experience, privacy, false alarms and responder workload.

## Decisions that most need an answer

Details and recommendations in [docs/11](docs/11-roadmap-and-decisions.md#112-decisions-that-need-you).

* **D1 — Who operates the system and holds the data.** Recommended: OMH hosts as a service provider
  for the host organization. This makes OMH a target for subpoenas and possibly subject to HIPAA,
  HUD HMIS or VAWA rules, depending on the host.
* **D2 — Staff-mediated contact only in the MVP** (recommended) or text-message check-ins from the
  start.
* **D4 — Legal review.** North Carolina's universal duties to report a disabled adult needing
  protective services, and to report certain crimes against juveniles to law enforcement, bear
  directly on the consent conversation and the no-police boundary. These must be answered by
  counsel before anyone enrolls.
* **D6 — Default for remote withdrawal**: confirm once in person (recommended) or stop immediately.
* **D3 / D7 — Which organization to approach, and who pays for responder time.**

## Boundaries

* No law-enforcement or immigration-enforcement integrations, access, notifications or referral
  workflows. Social-service responders own follow-up.
* No immigration status; no continuous location tracking, movement history, public person-search or
  public status lookup.
* Works without a smartphone, app, stable address or dependable relative.
* Voluntary. Help never depends on enrolling, religious participation or loyalty to OMH.
* Separate from emergency response and distress signaling; promises no rescue, survival or
  protection from abuse.
* Children are excluded until separate safeguarding work is done ([docs/children.md](docs/children.md)).
* Legal obligations and emergency questions are identified for qualified review, never silently
  routed around ([docs/legal-review.md](docs/legal-review.md)).

Changing a boundary is a public governance decision by OMH, not a feature request.

## Documents

| # | Document | Covers |
|---|---|---|
| 1 | [Charter, non-goals and pilot](docs/01-charter.md) | Purpose, principles, non-goals, bounded pilot, terms |
| 2 | [Roles and permissions](docs/02-roles-and-permissions.md) | Roles, permission matrix, participant control, accountability |
| 3 | [Workflow and states](docs/03-workflow-and-states.md) | Enrollment, contact, overdue, escalation, follow-up, closure, state machines, parameters |
| 4 | [Data, retention and audit](docs/04-data-retention-audit.md) | Minimal data model, never-collected list, retention, deletion, access audit |
| 5 | [MVP backlog](docs/05-mvp-backlog.md) | Prioritized items with acceptance criteria |
| 6 | [Failure modes and abuse](docs/06-failure-modes-and-abuse.md) | Required scenarios, misuse, system failures, residual limits |
| 7 | [Disaster and cross-organization continuity](docs/07-disaster-continuity.md) | MVP requirements vs. later; relays; transfers |
| 8 | [Pilot operations](docs/08-pilot-operations.md) | Staffing, capacity, training, coverage, pause criteria, stage gates |
| 9 | [Evaluation](docs/09-evaluation.md) | Measures and targets |
| 10 | [Partner questions](docs/10-partner-questions.md) | First conversation with an Asheville outreach organization |
| 11 | [Roadmap and decisions](docs/11-roadmap-and-decisions.md) | Phases, decisions for OMH, defaults chosen |
| — | [Children](docs/children.md) | Safeguarding work required before inclusion |
| — | [Legal review](docs/legal-review.md) | Questions for North Carolina counsel (not legal advice) |
| — | [Context and sources](docs/context-and-sources.md) | Sourced facts, kept apart from recommendations |

[prompts/init.md](prompts/init.md) is the brief this design responds to.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
