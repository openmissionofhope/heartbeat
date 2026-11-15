# 6. Failure modes and abuse cases

Status: **proposal**. Each scenario lists what happens, the mitigations (design **D** or
operations **O**, with backlog IDs from [05](05-mvp-backlog.md)), and what remains unsolved.
Every scenario here should be run as a tabletop exercise with host staff before Stage A, and as an
automated scenario test with synthetic data.

## 6.1 Required scenarios

### A. Lost phone, ordinary travel, or wanting privacy

**What happens.** A participant's phone is lost, stolen or cut off; they go to see family for two
weeks without saying so; or they simply want to be left alone for a while.

**Mitigations.**
* **D** The MVP never depends on the participant having a phone; in-person contact at the host is
  the main channel, and phone is one method among those the participant chooses (HB-ENR-2).
* **D** The plan records what may be said on the phone. A responder who reaches whoever now holds a
  lost phone says only the permitted message (default: "This is [first name] from [host]; please ask
  them to call us") — never "Heartbeat", "overdue" or "missing".
* **D** Pauses with end dates cover planned travel (HB-LIFE-1); a remote pause needs verified
  identity, is capped at 14 days and cannot be renewed remotely without a contact in between.
* **D** Follow-up permissions bound how intrusive follow-up can be. A participant who chose
  "records and host staff only" will not be looked for at camps or asked about through relatives.
* **O** Phone numbers are rechecked at each enrollment-worker or responder conversation.
* **O** Wanting privacy is treated as a right: the participant can lengthen the interval, narrow
  follow-up, pause or withdraw, without being asked to justify it.

**Residual.** Someone who travels without pausing will be followed up, within the limits they set,
and may find that unwelcome; the pilot measures how often this happens and how participants feel
about it ([09](09-evaluation.md)).

### B. Alias, or confusion with another person

**What happens.** Two people called "Mike" use the same day center; someone is known by a street
name to one team and a legal name to another; a recorder picks the wrong record.

**Mitigations.**
* **D** The recorder's picker always shows the participant code beside the name; participants
  decide which other names recorders may see (HB-CON-1).
* **D** Identity confidence is required on every contact; only `known` or `verified` qualify
  (HB-CON-2).
* **D** Duplicate warning at enrollment within the host (HB-ENR-4).
* **D** A contact on an open case does not close it until the owner confirms it was the right
  person (`contact_reported`, HB-CASE-4); a wrong contact is voided and the case reopens (HB-CON-3).
* **D** Across organizations there is **no name matching at all** — only code plus verification
  answer (HB-DR-5) — so two different people with similar names cannot be merged.

**Residual.** A recorder who is confident but wrong (`known`) can reset the wrong person's clock;
the code display and owner confirmation reduce but cannot remove this. A person enrolled separately
with two hosts cannot be detected, by design; the result is duplicated follow-up, not a missed one.

### C. False, stale, mistaken or coerced heartbeat

**What happens.** Someone impersonates the participant by phone to keep their record "fresh"; an
old contact is entered as if recent; the wrong person is recorded; or the participant is made to
check in, or to say they are fine, by someone controlling them.

**Mitigations.**
* **D** Impersonation by phone needs the verification answer to qualify; `stated` never qualifies.
* **D** `occurred_at` drives the clock; backdating beyond 72 hours needs coordinator approval, so a
  stale contact cannot push the clock past its real date (HB-CON-4).
* **D** If remote contact is all there has been for 60 days, staff are prompted to seek private,
  in-person contact (T-INP).
* **D** Safety-reducing plan changes made remotely are applied only with `known` or `verified`
  identity and are flagged on the plan and on cases opened within 30 days (HB-ENR-2); remote
  withdrawal stops outreach at once but takes effect only when the participant confirms it in
  person (decision D6, HB-LIFE-2).
* **D** Screens never say "safe" or "OK" (HB-UI-1), so a recorded contact cannot be mistaken for
  assurance.
* **O** Training: make private moments ("let's do your paperwork in the office"); notice who is
  hovering; know local domestic-violence and adult-protective resources and the host's own
  procedures — outside Heartbeat.

**Residual.** Heartbeat cannot detect coercion. A coerced in-person check-in is, in the data,
identical to a free one. By the project's boundaries Heartbeat will not offer a duress code or
covert distress signal; that belongs to separate, specialized services. This limitation is stated in
the consent conversation, training and every public description.

### D. An abusive household member seeking access

**What happens.** A partner, parent or other controlling person calls the host to ask whether the
participant is enrolled or where they are; poses as the participant to withdraw, pause or change the
phone number; gets themselves named as a trusted person; works or volunteers at the host; takes the
participant's card or phone; or uses a court process to obtain records.

**Mitigations.**
* **D** No public lookup, no family portal, and no enrollment confirmation to anyone outside the
  host's authorized staff (HB-LIFE-3 gives identical responses for participants and non-participants
  below coordinator level). Participants at particular risk can choose code-only lookup, so they do
  not appear in recorders' name searches (HB-CON-1).
* **O** A neither-confirm-nor-deny script for every staff member who answers phones or the door.
* **D** Remote withdrawal, pause and number changes require `known` or `verified` identity, are
  flagged, and a withdrawal takes effect only when confirmed in person (HB-ENR-2, HB-LIFE-2).
* **D** Named people are chosen by the participant in private, can be removed at any time, and only
  ever hear the participant's permitted message.
* **D** Staff conflicts and participant-requested exclusions block a staff member from a record
  (HB-SEC-2).
* **D** The card carries no name; a code without the verification answer is only `code_only`.
* **D** Data minimization limits what any legal process can obtain; retention deletes contacts after
  90 days ([04](04-data-retention-audit.md)). How to respond to subpoenas and orders is a
  [legal-review](legal-review.md) item.

**Residual.** Someone who knows the verification answer can impersonate the participant remotely
and stop outreach, though not delete the record quickly under the default preference. Host staff
and volunteers who record contacts can learn that a person is enrolled. An insider with legitimate
access can misuse it; the audit log deters and detects that rather than preventing it.

### E. An unavailable or unreliable responder

**What happens.** The assigned responder is sick, on leave, overloaded, has left the job, ignores
the task, or closes cases improperly.

**Mitigations.**
* **D** Explicit acceptance, timed escalation to backup and coordinator, and an **uncovered** alarm
  to the program lead (HB-CASE-1); availability skips absent staff (HB-OPS-3); disabling an account
  returns its cases to the coordinator (HB-SEC-1).
* **D** Stalled detection when accepted cases go quiet (HB-CASE-2).
* **D** Closure requires evidence and, for sensitive outcomes, approval; weekly closure review;
  reopening (HB-CASE-4, HB-OPS-5, HB-CASE-6).
* **O** At least two people can act as coordinator; holiday coverage planned a month ahead
  ([08 §8.4](08-pilot-operations.md#84-backup-coverage)).
* **O** Monthly, the coordinator samples closed cases and, where the participant agreed to be asked,
  checks with them that follow-up actually happened.

**Residual.** Heartbeat cannot verify that a recorded phone call or visit took place. Review and
sampling deter falsification; they do not prevent it.

### F. Contact through another participating organization

**What happens.** The participant turns up at a different shelter or meal site — one that
participates in Heartbeat (Stage B), or one that does not.

**Mitigations.**
* **D** At a participating organization, staff record a **relay** with the participant's code and
  verification answer; they see nothing about the person, and the screen gives the same response
  whether or not the code exists (HB-DR-5, [07 §7.2](07-disaster-continuity.md#72-cross-organization-continuity)).
* **O** Without the card, partner staff can let the participant phone the host, which records a
  `phone_with_staff` contact.
* **O** At a non-participating organization, the participant can still call the host.
* **D** If partner staff call the host about someone, the host neither confirms nor denies; any
  information they give can be recorded as a secondhand lead.

**Residual.** The host learns which organization the participant visited, and when — a coarse
location the participant chose to share by presenting their code. Relays are deleted after 90 days
like all contacts.

### G. Disaster displacement, network outages, or an unavailable host

**What happens.** A storm or flood closes the host, scatters participants, cuts power, water and
mobile service for days or weeks, and displaces staff themselves. Every participant becomes overdue
at once.

**Mitigations.** Detailed in [07](07-disaster-continuity.md). In short:
* **D** Hosting outside the region, so the system survives a local disaster (HB-DR-1).
* **D** Escalation hold and roll call replace hundreds of individual alerts with one prioritized
  list (HB-DR-3).
* **D/O** Paper forms and late entry; a printed continuity sheet held by the coordinator and program
  lead (HB-DR-2, HB-DR-4, HB-CON-4).
* **D** Disaster priority chosen by the participant orders the roll call.
* **D** Relays from participating shelters and partners (Stage B).

**Residual.** In the MVP, if the host's own staff cannot work, no one else is authorized to follow up.
OMH is alerted when cases stay uncovered or host staff stop signing in (HB-OPS-6), but can only
phone the host. Participants are told this limit at enrollment. Continuity partners that can step in
are a later phase with their own consent ([07 §7.4](07-disaster-continuity.md#74-later-enhancements)).

### H. An overwhelmed team

**What happens.** More cases are overdue than responders can handle — after a cold snap, an
encampment clearance, a staff departure, or simply enrolling too fast.

**Mitigations.**
* **D** Per-responder cap (CAP-R) and capacity indicators (HB-OPS-4); an enrollment cap derived from
  committed responder hours ([08 §8.2](08-pilot-operations.md#82-capacity)).
* **D** Offers skip full responders but never skip the coordinator, and uncovered cases are loud;
  nothing is silently dropped.
* **O** Triage: every overdue case gets a minimal first action (records check and asking host staff)
  within T-ACT; deeper follow-up is ordered by disaster priority, attached concerns, remote-change
  flags, then days overdue.
* **O** Enrollment pause criteria, shown on the dashboard and acted on by the program lead
  ([08 §8.5](08-pilot-operations.md#85-criteria-for-pausing-enrollment)).
* **O** Escalation hold is for disasters, not to hide overload; it requires a reason and daily
  reconfirmation.
* **O** Intervals are never lengthened to reduce workload except with each participant's agreement.

**Residual.** Some follow-up will be slower than the targets. That is measured and reported, and it
triggers the pause rules rather than being hidden.

## 6.2 Abuse and misuse

| Case | Mitigation | Residual |
|---|---|---|
| Staff browse records out of curiosity or for personal reasons | Assignment-based access; typed reasons; monthly exception review; host HR consequences (HB-AUD-1, -2) | Detection after the fact |
| Staff learn of abuse that must be reported | Staff make the report by phone under the [required-reports policy](safeguarding-reports.md); Heartbeat shows who to call and records that it was made, never the details; nobody is reported for immigration | Mandatory police reporting of partner abuse may deter disclosure or raise danger ([risks](safeguarding-reports.md#risks-to-weigh)) |
| A police officer asks staff whether a person is around or what is known about them | Heartbeat has no police role, export or workflow. Staff follow the host's existing policy for law-enforcement contact. | The host's policy, not the software, governs; it needs [legal review](legal-review.md#15-informal-requests-from-police-or-immigration-officers--blocking-for-training) |
| Subpoena, court order or warrant for records | Minimal data and short retention; requests routed to host counsel and OMH; policy to require valid process, narrow scope, and tell the participant where lawful | Lawful orders may have to be obeyed; "no integrations" does not mean "no disclosure" |
| Immigration-enforcement inquiry | No immigration status or proxies are held; same process as above | As above |
| Using overdue status to sanction participants (e.g. releasing a shelter bed, exiting someone from a program) | Prohibited by the host agreement; Heartbeat data is not used for eligibility, compliance or discharge decisions | Relies on the host keeping its word; participant feedback checks |
| Pressure to enroll (staff targets, enrolling at the meal line) | No enrollment targets; private consent conversation away from service delivery; teach-back; easy withdrawal | Subtle pressure from trusted staff is hard to remove entirely |
| Religious pressure tied to Heartbeat contact | Consent states the separation; training; feedback question in [09](09-evaluation.md) | — |
| Someone falsely reports the participant has died to end follow-up | `reported_deceased` needs one of the source categories in [03 §3.9](03-workflow-and-states.md#39-step-7--closure) (a relative's word alone is not enough) and program-lead approval with a second reviewer; a wrong report can be reversed | — |
| Staff record contacts that didn't happen to avoid follow-up work | Contacts are attributed; recording patterns reviewed; participant sampling | Detection after the fact |
| Requests to add location tracking, police sharing, or a family portal | These are boundary changes, not features; they would require a public OMH governance decision, and the backlog lists them as "will not build" | — |
| Data breach | Minimal data; encryption; incident plan: host told within 24 hours, participant notification decided with counsel | Even names plus contact dates can harm someone |
| Researchers or journalists ask for data | De-identified aggregates only, cells under 5 suppressed (HB-EVAL-1) | — |

## 6.3 System and operational failures

| Failure | Mitigation |
|---|---|
| The overdue detector stops running | Heartbeat applies its own principle to itself: every run is recorded, the coordinator gets a digest **every** business morning even with zero cases, and an external monitor alerts if no run succeeds within 2 staffed hours (HB-CLK-2). |
| Notifications fail or go to spam | The queue is the source of truth, reviewed at every shift start; delivery failures shown (HB-OPS-2). |
| Wrong timezone, daylight-saving or holiday handling | Tested explicitly; the program lead confirms the holiday calendar yearly; hours shown on the dashboard (HB-CLK-1). |
| Wrong interval or plan entered | The plan summary is read back to the participant and offered in print at enrollment. |
| False alarms because contacts weren't recorded | Recording-gap closures are counted; if more than 30% of cases in a month are recording gaps, the program lead pauses enrollment until recording is fixed ([08 §8.5](08-pilot-operations.md#85-criteria-for-pausing-enrollment)). |
| Participants, families or staff come to treat enrollment as safety | Language guardrails, consent script, training, public descriptions (HB-UI-1). |
| The host ends its program or closes | Host agreement requires notice; participants are told and offered transfer or withdrawal; data deleted on schedule. |
| OMH stops operating the service | Agreement requires export to the host in a documented format, then deletion; the code is open source (Apache 2.0), so a host can run it. |
| Staff turnover | Training completion gates role assignment; accounts disabled the same day; cases reassigned automatically. |
| Responder safety when looking for someone | Responders follow the host's outreach safety policy (pairs, daylight, known locations). Heartbeat never asks a responder to go anywhere the host would not already send outreach staff. |

## 6.4 Residual limitations, stated plainly

1. A recorded contact is not proof of safety, freedom or wellbeing.
2. Heartbeat cannot detect coercion, and deliberately provides no distress signal.
3. Follow-up happens during staffed hours only and may be slower than targets when demand spikes.
4. In the MVP, if the host cannot operate, no one else can follow up on its participants.
5. Lawful legal process may compel disclosure of what Heartbeat holds.
6. Insiders can misuse access; auditing detects it after the fact.
7. Heartbeat can only notice the absence of people who enrolled, and only from contacts someone
   recorded.
