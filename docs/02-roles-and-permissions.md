# 2. Roles and permissions

Status: **proposal**. Role names are design terms; a host organization may use its own job titles.

## 2.1 Design rules

1. **Individual accounts only.** No shared logins, including at front desks. Every action is
   attributable to one person.
2. **Least privilege by default, more by assignment.** Most staff see almost nothing about a
   participant until a follow-up case is assigned to them, and lose that view when the case closes or
   is reassigned.
3. **Every view of participant detail is logged** with the reason the system granted it
   ([04 §4.6](04-data-retention-audit.md#46-access-audit)). Views outside an assignment require a
   typed reason.
4. **Exactly one accountable owner per open case at any moment** (a responder, the coordinator, or —
   visibly — nobody, which is itself an alarm).
5. **No role sees immigration status, location history or government identifiers**, because the
   system never holds them.
6. **No role exists for law enforcement, immigration enforcement, landlords, creditors, employers,
   or the public.** There is no "family portal" in the pilot.
7. **Conflicts of interest are declared.** A staff member who knows a participant outside work, or
   whom a participant asks to exclude, is blocked from that record except for recording a contact.

## 2.2 Roles

| Role | Who | Purpose |
|---|---|---|
| **Participant** | The enrolled person. No account or device needed in the MVP. | Owns the contact plan; acts through staff of their choosing. |
| **Contact recorder** | Host front-desk staff, meal-line or shelter-desk staff and trained volunteers. | Record that a contact happened. Sees name and code only. |
| **Enrollment worker** | Trained host staff. | Hold the consent conversation, enroll, set up and change the plan with the participant. |
| **Responder** | Trained host staff (or supervised outreach volunteers if the host already uses them). | Accept and carry out follow-up cases. |
| **Coordinator** (and a deputy) | A senior host staff member on duty. | Own the queue; final backstop for unaccepted cases; review closures; manage capacity. |
| **Program lead** | The host's accountable manager. | Staff accounts and roles; approve sensitive closures; pause enrollment; review access logs; declare continuity events. |
| **Relay user** *(Stage B)* | Staff at a second participating organization. | Record a contact for a participant who presents their code, without seeing their record. |
| **Continuity steward** *(later phase)* | Designated lead at a pre-agreed continuity partner. | Dormant; activated only in a declared continuity event ([07](07-disaster-continuity.md)). |
| **Platform operator** | OMH technical staff. | Run, secure and back up the system. No routine access to participant data; break-glass only. |
| **Evaluator** | OMH or partner staff doing pilot evaluation. | De-identified metrics only. |
| **Concerned person** | A relative, friend or anyone else who cares about someone. | **No system access.** May raise a concern with the host by phone or in person; receives only what the participant has authorized (default: nothing, not even whether they are enrolled). |

One person may hold several roles (in a small team the coordinator is usually also a responder).
Combining roles never removes logging or separation-of-duty checks.

## 2.3 Permission matrix

Key: ✓ allowed · **A** only for participants on a case assigned to them · **R** allowed with a typed
reason, logged and included in the monthly access review · — not allowed.

| Capability | Recorder | Enroller | Responder | Coordinator | Program lead | Relay user | Operator | Evaluator |
|---|---|---|---|---|---|---|---|---|
| Find a participant of own host by name, alias or code | ✓¹ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Record a contact | ✓ | ✓ | ✓ | ✓ | ✓ | code + verification only² | — | — |
| See contact plan (methods, follow-up permissions, trusted people, "usually found" note) | — | ✓ during enrollment/plan change | **A** | R | R | — | — | — |
| See contact history | — | R | **A** | ✓ | R | — | — | — |
| See follow-up cases and actions | — | — | **A** | ✓ | ✓ | — | — | — |
| Accept a case, record follow-up actions | — | — | **A** | ✓ | ✓ | — | — | — |
| Assign or reassign cases | — | — | — | ✓ | ✓ | — | — | — |
| Enroll; record consent; change plan with participant | — | ✓ | ✓³ | ✓ | ✓ | — | — | — |
| Record participant's pause or withdrawal request (an effective withdrawal closes any open case, [03 §3.9](03-workflow-and-states.md#39-step-7--closure)) | — | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Close case: contact restored, recording gap, self-report | — | — | **A** | ✓ | ✓ | — | — | — |
| Decide a pending remote withdrawal at T-WD | — | — | — | ✓ | ✓ | — | — | — |
| Accept an incoming transfer (closes the sending host's case; later phase) | — | — | — | ✓ | ✓ | — | — | — |
| Close case: ended after extended follow-up, other documented outcome | — | — | propose | propose | **approve** | — | — | — |
| Close case: reported deceased | — | — | propose | propose | **approve** + a second reviewer who did not propose it | — | — | — |
| Org-wide escalation hold / roll call ([07](07-disaster-continuity.md)) | — | — | — | ✓ | ✓ | — | — | — |
| Pause or resume new enrollment | — | — | — | — | ✓ | — | — | — |
| Manage staff accounts, roles, conflicts | — | — | — | — | ✓ | — | admin only⁴ | — |
| Print participant summary for that participant | — | ✓ | — | ✓ | ✓ | — | — | — |
| Print continuity sheet | — | — | — | ✓ | ✓ | — | — | — |
| View access/audit log | — | — | — | own actions | ✓ | — | integrity only⁵ | — |
| De-identified metrics | — | — | — | ✓ | ✓ | — | — | ✓ |
| Break-glass access to participant data | — | — | — | — | — | — | two-person, logged, reported to host⁶ | — |

1. The recorder search returns only preferred name, participant code, and (if the participant
   allowed it) other names they go by. No dates, status, or plan. Participants who chose code-only
   lookup do not appear in name searches below enrollment worker. A recorder can still learn that a
   person is enrolled — a residual risk ([06 §6.1 D](06-failure-modes-and-abuse.md#d-an-abusive-household-member-seeking-access)).
2. The relay user enters a code and the participant's verification answer; the screen confirms
   only that a relay was sent ([07 §7.2](07-disaster-continuity.md#72-cross-organization-continuity)).
3. A responder may update the plan with the participant during contact restored on their case.
4. The operator can create the first program-lead account for a host and disable compromised
   accounts; it cannot assign itself host roles.
5. The operator can verify audit-log integrity and export it to the host on request, without
   reading participant fields.
6. For example, to repair corrupted data at the host's written request. Requires a second OMH
   approver, a ticket reference and a reason; the host program lead is notified automatically.

## 2.4 Participant control

The participant decides, and can change at any time through any enrollment worker, responder or
coordinator:

| Choice | Options | Default |
|---|---|---|
| Contact interval | 7, 14 or 30 days *(provisional)* | None — chosen together, based on how often the participant actually expects to be around |
| What counts as contact | In person at the host; phone call with staff; relay from a participating organization (Stage B); messages I leave (self-check-in) | In person and phone |
| How staff find my record | By name, or by code only (staff who record contacts must then use my code) | By name |
| Follow-up I agree to if I go quiet | (a) check Heartbeat and host records and ask host staff; (b) call or text my phone; (c) look for me at the places I list; (d) ask the people I name; (e) give participating partner organizations my permitted message ("we're trying to reach [first name]; if they come in, please ask them to call us") | (a) only, until the participant chooses more |
| People who may be asked about me | Named people, each with a phone number and exactly what may be said ("we're trying to reach X — have you seen them?") | Nobody |
| If someone asks about me | Tell me / don't tell me | Tell me |
| Staff I don't want to see my record | Named staff | None |
| Other names staff may see | Listed aliases | None shown to recorders |
| Remote withdrawal | "If I withdraw by phone or message, confirm with me in person if you see me within 30 days" / "Stop and delete right away" | Confirm |
| Disaster priority | "Try to reach me sooner after a disaster" — explained as a place near the top of the staff's list, not rescue — with an optional reason category (mobility, medical equipment or medication, other) | Not set |
| Continuity sharing *(later phase)* | Allow my minimal record to be used by a named continuity partner if my host cannot operate | Not allowed |

The participant may also, through staff: see a printed summary of everything held about them; see
which roles and organizations viewed or changed their record and when; correct anything wrong; pause;
withdraw and have their information deleted.

## 2.5 Organizational accountability

| Party | Accountable for |
|---|---|
| **Host organization** | Follow-up for its participants within its stated hours; staffing and training; the consent conversation; its legal obligations; complying with the boundaries; deciding to pause enrollment. Named program lead. Expected to be the data controller *(subject to legal review)*. |
| **Open Mission of Hope** | The software, hosting, security, backups, audit integrity, uptime monitoring and incident notification; never using participant data for any other purpose; refusing feature requests that cross the boundaries. Expected to act only on the host's instructions as a processor *(subject to legal review)*. |
| **Coordinator on duty** | Every open case has an owner; uncovered and stalled cases are worked or escalated; closures meet the rules. |
| **Responder** | Accept or decline explicitly; act within the timers; record what was done and with what certainty; hand back explicitly rather than go quiet. |
| **Relay partner organization** *(Stage B)* | Only recording relays at a participant's request; never using the relay to learn about a person. |

A written agreement between OMH and the host should record these responsibilities, the data roles,
the retention schedule, incident response, the pilot pause criteria, and what happens to the data if
either party withdraws ([11 decision D1](11-roadmap-and-decisions.md#d1-who-operates-the-system-and-holds-the-data)).

## 2.6 Account security baseline

* Multi-factor authentication for every staff account (passkey or authenticator app; SMS codes only
  as a fallback).
* 15-minute idle timeout on devices marked shared; 12-hour maximum session elsewhere.
* Accounts of departed staff disabled the same day; quarterly role review by the program lead.
* Failed sign-ins and privilege changes appear in the audit log.
