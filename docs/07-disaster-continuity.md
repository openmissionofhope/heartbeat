# 7. Disaster continuity and cross-organization continuity

Status: **built** (2026-11-15). §7.1 must be in place before a host goes live. §7.2 (relays) is used
from Stage B. §7.3 (transfers) needs a second participating host. §7.4's continuity partner and
offline recording are built but used only after their own agreements and drills. Sourced facts about
Hurricane Helene's disruption in Asheville are in [context-and-sources.md](context-and-sources.md#hurricane-helene).

## Why this matters for Asheville

The motivating concern is people experiencing homelessness who were not accounted for after
Hurricane Helene. A disaster breaks Heartbeat's assumptions all at once: the host may close,
staff may be displaced, phones and internet may fail for days, participants scatter, and every
participant becomes "overdue" on the same day. A design that only works on an ordinary Tuesday
fails exactly when it matters most.

## 7.1 MVP continuity requirements

| # | Requirement | Backlog |
|---|---|---|
| C1 | **Off-site hosting** outside western North Carolina, with encrypted daily backups, a rehearsed restore, recovery point ≤ 24 h and recovery time ≤ 1 business day. | HB-DR-1 |
| C2 | **Reachable from anywhere.** Staff can sign in from any working connection and a low-end phone, so a displaced coordinator can keep working. MFA recovery codes are kept on paper with the continuity kit. | HB-SEC-1, HB-UI-2 |
| C3 | **Escalation hold and roll call.** One switch stops individual overdue cases and replaces them with a single prioritized roll-call list. The hold cannot end until every participant has a contact since it began or an open case. | HB-DR-3 |
| C4 | **Participant-chosen disaster priority**, so the roll call starts with those who asked to be reached sooner — explained to them as a place on a list, not rescue. | HB-ENR-2 |
| C5 | **Printed continuity sheet**, refreshed weekly and whenever a severe-weather warning is issued, kept in two locked places (coordinator and program lead), old copies shredded, prints logged. Contains code, preferred name, latest contact date, disaster priority and — only where the participant allowed — the "usually found" note and named people. | HB-DR-2 |
| C6 | **Paper fallback kit**: contact-log and follow-up-action forms mirroring the data fields, a one-page "running Heartbeat on paper" guide, and a pen. Entries are typed in later with their real `occurred_at`. | HB-DR-4, HB-CON-4 |
| C7 | **A phone number that survives the building.** The number on participant cards must be answerable away from the office (forwarding to a staff mobile or a hosted number), with the switch-over rehearsed. | Operations |
| C8 | **Staff contact tree** and a rule for who acts as coordinator when the usual coordinator and deputy are unreachable. | Operations |
| C9 | **"Before the storm" conversations.** When a severe-weather watch is issued, staff who see participants may offer (never require) a short conversation: does the host have your current number, where you might go, whether you want to pause. | Operations |
| C10 | **Host-silence alert.** If cases stay uncovered or host staff stop signing in, OMH is alerted to phone the program lead. | HB-OPS-6 |

### Roll-call procedure (MVP)

1. The coordinator or program lead **declares escalation hold** with a reason. The system asks the
   program lead each day whether to continue; if no one answers, the hold continues and the prompt
   escalates to the deputy and, after three business days, to the OMH operator, who phones the host.
2. Staff work the **roll-call list** (or the printed sheet if the system is unreachable) in order:
   disaster priority, then longest since last contact.
3. Every contact is recorded normally — in person at emergency shelters and distribution sites,
   by phone, by relay (Stage B), and secondhand leads ("someone who knows him says they saw him on
   Thursday" — never where).
4. For participants still not reached, the coordinator opens `roll_call` cases **in batches sized to
   responders' capacity**, assigned like any other case, using only the follow-up methods each
   participant consented to.
5. When ordinary operations resume, the coordinator **ends the hold**. Before it can end, every
   active participant must have a qualifying contact since the hold began or an open case, so no one
   unreached gets another stretch of silence. Those with a contact get T-RETURN; `roll_call` cases
   continue to closure.

Silence after a disaster does not mean death. Roll-call cases close only for the reasons in
[03 §3.9](03-workflow-and-states.md#39-step-7--closure).

### Network outages without a disaster

Short outages (internet, power, or the hosting provider) use the same paper forms and late entry.
The detector's self-heartbeat makes an outage of the system itself visible (HB-CLK-2); the external
monitor alerts the operator.

## 7.2 Cross-organization continuity

People experiencing homelessness move between shelters, meal sites, clinics and day centers.
Heartbeat should let a contact at another participating organization count, **without** that
organization being able to look anyone up and without sharing records between organizations.

**Consent.** At enrollment the participant chooses whether relays may count. Each relay is then
initiated by the participant themselves, by giving their code and verification answer to staff at
the partner organization. Without that, nothing is exchanged.

**Authorization.** Each relay organization signs a participation agreement covering purpose, use
limits and training. Each relay user has an individual account with MFA. The relay role has **no
read access** to anything about participants.

**Identity matching.** Code plus verification answer only. There is no matching by name, birth
year, photo or anything else, no search, and no query that answers "is this person enrolled?". The
relay screen shows the same response ("Thank you — if this code is active, the host has been told")
whether the code is valid, unknown or failed verification, except for an instruction to retry or let
the participant phone their host. Attempts are rate-limited per relay user and per code; five
failures lock that code's relays for 24 hours and notify the host coordinator.

**Minimum information exchanged.**

| Direction | Exchanged | Never exchanged |
|---|---|---|
| Partner → host | Participant code; verification result; that a firsthand contact occurred; `occurred_at`; partner organization; relay user (for accountability); optionally a message from the participant ≤ 140 characters, with an on-screen reminder that it will be shared and should not include where they are staying | Anything the partner holds about the person |
| Host → partner | Nothing beyond the generic receipt — except, during a follow-up case and only if the participant chose follow-up option (e), their permitted message ("we're trying to reach [first name]; if they come in, please ask them to call us") | Plan, status, whether overdue, history, notes, other names |

**Effect at the host.** The relay is recorded as a `relay` contact with `verified` confidence. If
the plan allows relays it qualifies; on an open case it moves the case to `contact_reported` for the
owner to confirm.

**What the host learns.** Which organization the participant visited and when. The participant
chooses to share that by presenting their code; it is deleted with other contacts after 90 days.

## 7.3 Transfer of responsibility

When a participant wants another **participating** organization to become their host (for example,
they have moved into that organization's shelter):

1. The participant asks, in person at either organization (or by verified phone, confirmed in person
   at the receiving organization). Their consent is recorded.
2. The sending host creates a transfer request containing only: preferred name; other names the
   participant chooses to bring; birth year if given; languages; accessibility note; plan choices
   (interval, qualifying kinds, follow-up permissions); named people only if the participant
   re-confirms each one; and the date of the latest qualifying contact.
3. **Not transferred:** case history, action notes, concerns, the contact list, consent records, or
   the verification answer. The receiving organization holds its own short consent conversation and
   the participant sets a new verification answer. The participant code stays the same so their card
   still works.
4. The receiving organization explicitly **accepts** and assigns a primary and backup responder. Only
   then does responsibility move. Until acceptance, the sending host remains accountable; an
   unaccepted request expires after 10 business days and the sending host is told.
5. After acceptance the sending host loses access, and its copy is deleted after 30 days, leaving a
   tombstone.

Moving somewhere that does not participate is handled as a **withdrawal** with the reason "moving
away"; staff may help the person connect with services there, outside Heartbeat. No data goes with
them unless they take their own printed summary.

## 7.4 Later enhancements

| Enhancement | Design notes | Why not MVP |
|---|---|---|
| **Continuity partner** that can act if the host cannot | Participant consents at enrollment. Activation by the host program lead, or — if the host is unreachable for 72 hours during a declared disaster — jointly by the continuity partner's lead and an OMH operator. Time-limited (14 days, renewable), scoped to the continuity-sheet fields, recording contacts and roll-call cases; every action audited and reported to the host; participants told afterwards. | Needs multi-organization agreements, legal review and drills; the pilot has one host. |
| Asking disaster-relief organizations about a participant | A specific consent choice, e.g. allowing a responder to submit a Red Cross welfare inquiry, whose current scope is limited ([context](context-and-sources.md#disaster-reunification-tools)). | Needs its own consent wording and a check of each organization's process. |
| Text-message or phone-keypad check-in during disasters | Lets participants report contact when they can reach a phone but not the host. Must avoid words like "safe". | Same reasons as HB-P2-1; mobile networks are often down at the worst time. |
| Offline-capable recording app for outreach | Encrypted local queue that syncs later. | Paper covers the pilot; offline data on lost devices is a new risk. |
| Region-wide roll call across several hosts | Coordinated by participant code, so a person seen by any participating organization is marked once. | Requires multiple hosts and governance. |
| Warm standby in a second hosting region | Faster recovery than restore-from-backup. | Cost; the recovery targets in C1 suffice for a non-emergency service. |
