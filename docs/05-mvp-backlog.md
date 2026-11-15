# 5. Prioritized MVP backlog

Status: **all items built (2026-11-15)** with automated tests (`tests/`); not deployed. Priorities now
say when an item is needed in the rollout, not when it gets built. IDs are stable.

* **P0** — required before any real participant is enrolled (pilot Stage A).
* **P1** — required before Stage B (up to 40 participants and a relay partner).
* **P2** — later phases; each needs its own review before work starts.

Parameters such as T-P1 are defined in [03 §3.2](03-workflow-and-states.md#32-provisional-parameters).

## Definition of done (every item)

* Automated tests cover the acceptance criteria, using synthetic data only.
* Every action that reads or changes participant data writes the audit events in
  [04 §4.6](04-data-retention-audit.md#46-access-audit); tests assert them.
* Screens pass the language guardrails (HB-UI-1) and accessibility checks (HB-UI-2).
* No participant data appears in URLs, logs, notifications or error reports (tested).
* Each scenario in [06](06-failure-modes-and-abuse.md) touched by the item has a scenario test.

## Foundations

### HB-SEC-1 Staff accounts, roles and MFA — P0
* Each staff account belongs to one organization and holds one or more roles from
  [02 §2.2](02-roles-and-permissions.md#22-roles); permissions match the matrix in §2.3 exactly
  (table-driven tests per cell).
* MFA is required at first sign-in; an account without MFA cannot reach participant data.
* Idle timeout and maximum session follow [02 §2.6](02-roles-and-permissions.md#26-account-security-baseline).
* Disabling an account ends its sessions immediately and removes it from offer chains; its open
  cases go to the coordinator as `offered`.

### HB-SEC-2 Conflicts and staff exclusions — P0
* A staff member can declare a conflict with a participant; a participant can ask (through any
  enrollment worker or coordinator) that named staff be excluded.
* A conflicted or excluded staff member can still record a contact for that participant but cannot
  view plan, history or cases, and is never offered their case.
* If exclusions leave no eligible responder, the case goes straight to the coordinator; if the
  coordinator is excluded, to the deputy; if both, to the program lead.

### HB-AUD-1 Access audit — P0
* Every event class in [04 §4.6](04-data-retention-audit.md#46-access-audit) is written with actor,
  basis, target and outcome.
* Views outside an assignment require a typed reason of at least 10 characters before data shows.
* The application's database role cannot update or delete audit rows (test attempts and expects
  failure).
* A nightly export writes the day's events to separate storage; a failed export alerts the operator.

### HB-AUD-2 Monthly access review — P0
* The program lead can generate the exception report in §4.6 for any month and record sign-off.
* Break-glass events notify the program lead within 5 minutes.

### HB-AUD-3 Participant summary and access summary — P0
* An enrollment worker or coordinator can print, for one participant, everything held about them in
  plain language, and an access summary by role, organization and date.
* The print itself is logged; the summary never includes other participants or staff notes about
  other people.

## Enrollment and plan

### HB-ENR-1 Enrollment with consent — P0
* A participant cannot become `active` until each consent item has a recorded choice, the script
  version is stored, and teach-back is marked passed.
* The form has no fields for anything on the never-collected list in
  [04 §4.1](04-data-retention-audit.md#41-rules-for-every-field).
* Enrollment is blocked while the host's enrollment is paused, with a script shown instead.
* Drafts older than 7 days are deleted.

### HB-ENR-2 Contact plan — P0
* The plan captures every choice in [02 §2.4](02-roles-and-permissions.md#24-participant-control)
  with the stated defaults.
* Every change creates a new version recording who, when, which fields, and channel (`in_person`
  or `remote`).
* Remote safety-reducing changes ([03 §3.10](03-workflow-and-states.md#310-enrollment-states-pauses-plan-changes-and-withdrawal))
  are flagged on the plan and on any case opened within 30 days; the flag clears only when a
  coordinator records in-person confirmation.
* The next in-person contact for a participant with an unconfirmed remote change notifies the
  coordinator (not the recorder).

### HB-ENR-3 Participant code and card — P0
* Codes follow [04 §4.2](04-data-retention-audit.md#42-entities), are unique across organizations,
  and the check character catches every single-character typo and every adjacent swap.
* A card can be printed (optional) with code, host phone and hours, and how to stop — no name.

### HB-ENR-4 Duplicate warning — P0
* On enrollment, the system warns if the preferred name or any other name, with the same birth year
  if given, resembles an existing participant at the host, showing only codes and names to the
  enrollment worker, who must confirm "different person" or open the existing record.

### HB-ENR-5 Enrollment pause — P0
* The program lead can pause and resume new enrollment with a reason; existing participants are
  unaffected. Pausing and resuming are audited and shown on the coordinator dashboard.

## Contact recording

### HB-CON-1 Quick recording — P0
* A contact recorder can find a participant by name, allowed other names, or code, and record a
  contact in at most four interactions; median time in usability testing under 30 seconds.
* The recorder sees only preferred name, code and allowed other names — no dates, states or plan.
* Participants with code-only lookup are found only by code below enrollment-worker level.

### HB-CON-2 Kinds, confidence and qualification — P0
* Kind and identity confidence are both required; qualification follows the table in
  [03 §3.5](03-workflow-and-states.md#35-step-3--recording-contact) and the participant's plan
  (table-driven tests for every cell).
* The verification check accepts the participant's answer case- and space-insensitively; five
  failed answers lock verification for that participant for 24 hours and notify the coordinator.
* Notes are possible only on `self_check_in` and `secondhand` and limited to 200 characters.

### HB-CON-3 Void and correct — P0
* A contact can be voided with a reason by its recorder (within 24 hours) or a coordinator (any
  time); voided contacts no longer count, and voiding the contact that closed a case reopens it to
  its last owner.

### HB-CON-4 Late entry — P0
* `occurred_at` may be up to T-BACK earlier than `recorded_at` without approval; earlier needs
  coordinator approval with a reason (e.g. "paper form, outage of 3 Oct").
* A late qualifying contact whose `occurred_at` precedes an open case's opening moves that case to
  `contact_reported` for closure as `recording_gap` ([03 §3.9](03-workflow-and-states.md#39-step-7--closure)).

## Clock and follow-up cases

### HB-CLK-1 Overdue detector — P0
* Computes due and overdue times per [03 §3.6](03-workflow-and-states.md#36-step-4--overdue-detection)
  using the host's timezone, staffed hours and holidays; correct across daylight-saving changes and
  holidays (tests for both).
* Idempotent: repeated or concurrent runs never open a second case for a participant.
* Never opens cases for paused, `withdrawal_pending`, withdrawn, transferred, inactive or ended
  participants, or while the host is in escalation hold.

### HB-CLK-2 Detector self-heartbeat — P0
* Each run records completion; the coordinator dashboard shows the last successful run.
* A digest goes to the coordinator and deputy every business morning, including "0 new cases".
* An external monitor alerts the operator and program lead if no successful run is recorded within
  2 staffed hours.

### HB-CASE-1 Offer, acceptance and escalation — P0
* Offer chain primary → backup → coordinator → uncovered follows T-P1, T-P2, T-P3, skipping
  unavailable, conflicted, excluded and at-capacity staff (never the coordinator).
* Acceptance is a deliberate action with the responsibility statement; viewing a notification or
  the case does not accept it.
* Declining requires a reason and moves the offer on immediately.
* Uncovered cases appear at the top of every eligible staff dashboard and trigger a program-lead
  notification immediately and each business morning until accepted.
* Database constraints guarantee at most one current owner/offeree per case.

### HB-CASE-2 Stalled, release and reassignment — P0
* A case with no action within T-ACT of acceptance, or within T-UPD of the last action, is marked
  stalled and the coordinator notified; it stays with its owner for T-STALL, then is released and
  offered to the backup (or coordinator) with the program lead notified.
* An owner can release with a reason; the coordinator can reassign; both are audited.

### HB-CASE-3 Follow-up actions — P0
* The action form offers only methods the participant consented to; others appear greyed with "not
  agreed by participant".
* Each action records action, source, result, certainty and an optional note ≤ 500 characters.
* The case view shows the participant's follow-up permissions, safe-contact flags, named people and
  their permitted message, the "usually found" note, recent leads, and any remote-change flags — to
  the owner only.

### HB-CASE-4 Closure — P0
* Closure is possible only with a reason from [03 §3.9](03-workflow-and-states.md#39-step-7--closure)
  and its required evidence and approvals; the proposer cannot be the second reviewer.
* No timer or job can move a case to `closed` (test by running all jobs over a simulated year with
  no contacts and asserting the case remains open).
* `contact_reported` notifies the owner immediately, the coordinator after T-CONF if unconfirmed,
  and the program lead each morning once it is more than one business day past T-CONF.
* Every transition in the table in [03 §3.11](03-workflow-and-states.md#311-follow-up-case-states)
  has a test, and a test asserts no other transition is possible.

### HB-CASE-5 Extended watch — P0
* Available only after T-EW with every consented method tried or marked impossible, and coordinator
  approval.
* Prompts a review every T-EWR; a review more than one business day overdue goes to the program
  lead each morning; at T-EWMAX notifies the program lead to decide whether to continue.
* `ended_after_extended_follow_up` closure displays, and stores, the statement that it is not a
  determination of death or wellbeing.

### HB-CASE-6 Reopen — P0
* A coordinator can reopen a case closed within 30 days, with a reason; it returns to `accepted`
  with its last owner (or `offered` if that person is unavailable).

## Lifecycle

### HB-LIFE-1 Pause — P0
* Requires an end date within T-PAUSE (14 days if remote, 90 if in person); stops the clock; on
  expiry starts T-RETURN; extensions need a new request.
* A remote pause needs `known` or `verified` identity, cannot be extended remotely, and a new remote
  pause needs a qualifying contact since the previous pause ended.

### HB-LIFE-2 Withdrawal — P0
* In-person withdrawal is effective immediately; the participant's choice of deletion (within 30
  days) or keeping the record 90 days to rejoin is recorded.
* Remote withdrawal is applied only with `known` or `verified` identity (otherwise recorded as a
  lead and the coordinator told), then becomes `withdrawal_pending` per
  [03 §3.10](03-workflow-and-states.md#310-enrollment-states-pauses-plan-changes-and-withdrawal)
  — outreach and clock stop, any open case passes to the coordinator with passive steps only, the
  coordinator is prompted at any in-person contact and records a review every T-WD (program lead
  told each morning if late). It takes effect only on in-person confirmation (decision D6); a year
  of simulated silence leaves it pending (tested).
* A coordinator can reinstate a withdrawn participant who says in person, before deletion, that they
  did not withdraw.
* An effective withdrawal closes any open case with reason `withdrawn`. No screen asks the participant to justify
  withdrawing; an optional reason category may be recorded if they offer one.

### HB-LIFE-3 Concerns from others — P0
* A coordinator can record a concern per [03 §3.12](03-workflow-and-states.md#312-concerns-raised-by-other-people);
  callback numbers are visible only to coordinators and deleted at 30 days.
* Searching for a name to record a concern gives no different response for participants and
  non-participants to anyone below coordinator.

### HB-LIFE-4 Transfer — P2 (needs a second host)
* Implements [07 §7.3](07-disaster-continuity.md#73-transfer-of-responsibility): in-person consent,
  minimal package, explicit acceptance, sender remains accountable until acceptance, expiry after 10
  business days.

## Coordination

### HB-OPS-1 Coordinator dashboard — P0
* Shows uncovered, stalled, offered, accepted, contact-reported and extended-watch cases with age;
  detector status; enrollment and hold status; responders' open-case counts against CAP-R.
* Sort order: uncovered first, then by disaster priority (if in roll call), then oldest overdue.

### HB-OPS-2 Staff notifications — P0
* Email notifications for offers, escalations, uncovered, stalled and contact-reported, with
  generic content only and a link to sign in.
* Each send records delivered or failed; repeated failures to one person show on the dashboard.
* The task queue works fully if notifications fail.

### HB-OPS-3 Availability — P0
* Staff (or the coordinator for them) can mark out-of-office with dates; offers skip them.

### HB-OPS-4 Capacity indicators — P0
* Dashboard shows active participants, open cases, cases per responder, and the last four weeks'
  overdue rate and responder hours logged, against the enrollment cap from
  [08 §8.2](08-pilot-operations.md#82-capacity).

### HB-OPS-5 Weekly closure review — P0
* Lists the past week's closures with reason, evidence kind and confidence, highlighting
  `contact_restored_self_report`, closures from `code_only`/`stated` evidence (should be none), and
  reopened cases; the coordinator records review.

### HB-OPS-6 Host-silence alert to OMH — P0
* If any case is uncovered for more than two business days, or no host staff member signs in for two
  staffed days, the OMH operator is alerted to phone the program lead. OMH sees only counts, never
  participant data.

## Continuity and resilience

### HB-DR-1 Hosting, backups and restore — P0
* Hosted outside western North Carolina; encrypted backups daily, 30-day retention.
* A documented restore is rehearsed before Stage A and quarterly; recovery point ≤ 24 hours,
  recovery time ≤ 1 business day.

### HB-DR-2 Continuity sheet — P0
* Coordinator can print a sheet of active participants with code, preferred name, latest qualifying
  contact date, disaster priority, and — only where the participant allowed it — the "usually found"
  note and permitted named people. The print is logged with a count.

### HB-DR-3 Escalation hold and roll call — P0
* The coordinator or program lead can place the host in escalation hold with a reason; the detector
  stops opening individual cases and the dashboard shows a roll-call list of all active participants
  sorted by disaster priority then days since latest contact.
* Roll-call contacts are recorded normally; the coordinator opens `roll_call` cases in batches and
  assigns them.
* Hold cannot end until every active participant has a qualifying contact since the hold began or
  an open case; those with a contact then get T-RETURN.
* Hold prompts the program lead daily to confirm it should continue. If no one confirms, the hold
  continues (ending it would flood the queue) and the prompt escalates to the deputy coordinator and,
  after three business days, to the OMH operator, who phones the host.

### HB-DR-4 Paper fallback kit — P0
* Printable contact-log and follow-up-action forms mirroring the data fields, and the late-entry
  path HB-CON-4. (Mostly an operations deliverable; see [07 §7.1](07-disaster-continuity.md#71-mvp-continuity-requirements).)

### HB-DR-5 Relay from a partner organization — P1
* Implements [07 §7.2](07-disaster-continuity.md#72-cross-organization-continuity): code plus
  verification answer; partner sees no participant data; the result screen is identical for
  success, unknown code and failed verification except an instruction to retry or call the host;
  rate-limited per partner user and per code.

## Retention

### HB-RET-1 Retention job — P0
* Applies every row of [04 §4.4](04-data-retention-audit.md#44-retention) nightly, computes the
  monthly aggregates before deleting contacts, and records each run.
* Tests advance a clock through every retention boundary and assert deletion and tombstones.

### HB-RET-2 Deletion on leaving — P0
* Withdrawal, transfer, inactive and ended records are deleted on schedule, leaving only the
  tombstone; audit events remain but resolve to the tombstone.

### HB-RET-3 Legal hold — P0
* The program lead can place a hold on a specific participant record with a reference; the
  retention job skips it and lists it monthly.

## Evaluation and interface

### HB-EVAL-1 De-identified metrics — P0
* Exports the measures in [09](09-evaluation.md) that come from system data, with no names, codes,
  notes or exact dates (week granularity), and suppresses any cell under 5 people.

### HB-UI-1 Language guardrails — P0
* No screen, notification, print or export uses "safe", "OK", "fine", "alive", "accounted for",
  "verified safe" or a green "all clear" for a participant. A test scans all templates for these words
  in participant-status contexts.
* Contact is always shown as "last recorded contact: [date] ([kind], [confidence])".
* Every participant-facing print states that Heartbeat is not emergency help and gives the host's
  hours.

### HB-UI-2 Accessibility and devices — P0
* Staff screens meet WCAG 2.2 AA, work on a low-end Android phone and a shared desktop, and are
  usable without JavaScript for contact recording.
* Participant-facing prints (card, consent summary, record summary) exist in English and Spanish;
  other languages by host request.

## P2 — built; off by default or needing review before use

| ID | Item | How it is built, and what must happen before use |
|---|---|---|
| HB-P2-1 | Text-message check-ins, reminders and follow-up texts (decision D2) | `src/domain/sms.ts`: per-participant consent, check-in word = verified, any other text = lead, STOP/START/HELP, quiet hours 8 am–9 pm, generic wording. Before use: 10DLC registration and counsel's review of consent wording ([legal-review §10](legal-review.md#10-automated-texts-and-calls--blocking-before-texting-is-used)). |
| HB-P2-2 | Phone keypad check-ins | TwiML webhooks: 8-digit check-in number with a check digit + PIN; identical replies for unknown numbers and wrong PINs; shares the verification lockout. Before use: accessibility testing with participants. |
| HB-P2-3 | Optional photo to tell people apart | Off for every host until its program lead turns it on; needs the participant's agreement; JPEG/PNG metadata (including GPS) stripped; encrypted; visible to the assigned responder and to coordinators who give a reason. Before use: host and legal decision. |
| HB-P2-4 | Participant self-view | `/me`: participant code + verification answer + a one-time code printed by staff (7 days, single use); read-only; 10-minute session; shows the access summary. |
| HB-P2-5 | Continuity-partner activation | Host program lead activates, or a partner steward requests and an OMH operator approves when no host staff have signed in for 72 hours; 14 days; roster limited to participants who agreed. Before use: multi-organization agreements and a drill. |
| HB-P2-6 | Per-participant encryption keys | AES-256-GCM field encryption under per-participant keys wrapped by the master key; optional separate key store so deletion reaches backups. |
| HB-P2-7 | Offline-capable recording | `/offline`: service worker caches the page only; entries (code, kind, identity, time) encrypted in IndexedDB with a non-extractable key; synced when signed in; entries over 72 hours old need approval. |
| HB-LIFE-4 | Transfer between hosts | Built per [07 §7.3](07-disaster-continuity.md#73-transfer-of-responsibility). Needs a second participating host. |
| HB-AUD-4 | Hash-chained audit export | Built: chain verified by `npm run cli -- audit-verify`; nightly export of hashes only. |
| HB-SG-1 | Required abuse reports (OMH policy 2026-11-15) | Built: [safeguarding-reports.md](safeguarding-reports.md). Staff call; Heartbeat records; reminders if not recorded as made; no immigration category (enforced by a database constraint). |

## Will not build

Law-enforcement or immigration access, notifications or referral flows; location capture or
history; public search or status lookup; automatic notification of family; duress codes or
panic buttons; automatic closure of cases; collection of any never-collected field.
