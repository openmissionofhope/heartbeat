# 8. Pilot operating plan

Status: **proposal**. Every number here is *(provisional)* and must be checked against the host's
real staffing, using the questions in [10](10-partner-questions.md). No organization has agreed to
host a pilot.

## 8.1 Staffing assumptions

| Role | People | Time (Stage A → Stage B) | Notes |
|---|---|---|---|
| Program lead (host) | 1 | ~2 h/week | Access review, approvals, pause decisions, partner meetings |
| Coordinator + deputy (host) | 2 | Coordinator ~6 h → ~10 h/week; deputy covers absences | 5-minute check at the start of every staffed day; weekly huddle |
| Responders (host) | 4 (at least 3) | ~3 h/week each — at least 12 committed hours in total — inside existing outreach or case-management work | Must already do outreach or have regular contact with participants |
| Enrollment workers (host) | 2 (may overlap with responders) | ~45 min per enrollment | Trained in the consent conversation |
| Contact recorders (host) | All front-line staff and volunteers at service points | Seconds per contact | The pilot fails without consistent recording |
| Relay users (partner, Stage B) | 2–4 | Seconds per relay | Partner signs a participation agreement |
| OMH operator | 1 + backup | ~4 h/week; reachable during host staffed hours | System, security, incidents; no participant data access |
| OMH evaluator | 1 | ~3 h/week | Interviews, metrics, stage reports |

## 8.2 Capacity

Weekly follow-up load can be estimated as

```
L (responder hours/week) = N × r × h
  N = active participants
  r = chance a participant becomes overdue in a given week
  h = responder hours per case, including documentation
```

`r` and `h` are unknown until the pilot measures them. Until there are four weeks of data, plan with
the pessimistic column.

| | Optimistic | Middle | Pessimistic |
|---|---|---|---|
| r | 0.10 | 0.15 | 0.20 |
| h | 1.5 h | 2 h | 3 h |
| Hours per participant per week (r × h) | 0.15 | 0.30 | 0.60 |
| L at N = 15 | 2.3 h | 4.5 h | 9 h |
| L at N = 40 | 6 h | 12 h | 24 h |

**Enrollment cap rule.** Enroll only while projected `L` is at most **60% of committed responder
hours**, leaving headroom for cold snaps, encampment clearances and staff absences. With four
responders at 3 h/week (12 h), 60% is 7.2 h: about **12 participants** on pessimistic assumptions, or
24 on middle ones. So Stage A is "up to 15, fewer if committed hours are lower" (12 with the
minimum 12 committed hours until four weeks of data exist). Stage B's 40 needs about 20 committed
hours at the middle assumptions (for example five responders at 4 h), or a measured `r × h` of at
most 0.18 with 12 hours. In general: `N ≤ 0.6 × committed hours ÷ (r × h)`. Each responder also
has at most CAP-R = 6 open cases.

During a declared escalation hold ([07](07-disaster-continuity.md)) the cap rule is suspended; the
roll call is worked in batches the team can actually handle.

## 8.3 Training

No one receives a role until the modules for it are recorded as completed (enforced by HB-SEC-1).
Refresher every 6 months, and after any incident.

| Module | Who | Length |
|---|---|---|
| 1. What Heartbeat is and is not; contact is not safety | Everyone with any role | 30 min |
| 2. Neither confirm nor deny: callers, visitors, police, family | Anyone who answers phones or the door | 20 min + role-play |
| 3. Recording contact: kinds, identity confidence, codes, no location | Contact recorders and above | 20 min |
| 4. The consent conversation: plain language, teach-back, privacy, no pressure, separate from services and from religious activity | Enrollment workers | 2 h + 2 supervised enrollments |
| 5. Follow-up practice: consented methods only, permitted messages, making private moments, noticing control, recording certainty, outreach safety | Responders | 2 h |
| 6. Emergencies and legal duties **outside** Heartbeat: the host's emergency procedures; reporting duties as advised by counsel; what Heartbeat does and does not record | Responders, coordinators, program lead | 1 h |
| 7. Coordinating: queue, triage, capacity, closure review, uncovered cases, escalation hold, continuity sheet, paper procedures | Coordinators | 2 h |
| 8. Program lead: access review, approvals, pause criteria, incidents, legal-process requests | Program lead | 1.5 h |
| 9. Tabletop exercises of every scenario in [06](06-failure-modes-and-abuse.md) | All role holders | 2 h before Stage A; again before Stage B |
| 10. Disaster drill on paper: hold, roll call, phone forwarding, late entry | Coordinators, responders | Half day before Stage A |

## 8.4 Backup coverage

* Every participant has a primary and a different backup responder.
* A named coordinator is on duty every staffed day, with a deputy; the program lead is the last
  resort.
* Absences of more than two staffed days: the coordinator reassigns primary roles in advance.
* Multi-day host closures (holidays): the coordinator either keeps a skeleton daily check or offers
  participants a pause covering the closure, explained honestly.
* Staff leaving: account disabled the same day; their cases and participants reassigned the same day.
* Start of every staffed day: the coordinator reads the digest, checks uncovered and stalled cases and
  the detector's last run (about 5 minutes). Missing digest → call the OMH operator.

## 8.5 Criteria for pausing enrollment

The program lead pauses new enrollment (HB-ENR-5) when any of these is true. The dashboard shows
the indicators.

1. A case has been **uncovered for more than one business day**, twice within four weeks.
2. Fewer than 90% of cases were **accepted within one business day** for two consecutive weeks.
3. More than 20% of open cases were **stalled** for two consecutive weeks.
4. Projected load exceeds the **cap rule** (§8.2) — including because committed responder hours
   have fallen below what current enrollment needs — fewer than three responders remain, or
   coordinator coverage lapses.
5. More than 30% of a month's cases closed as **recording gaps** (recording is failing, and alarms
   will stop meaning anything).
6. Any **privacy incident**: disclosure to someone not authorized, or misuse of access.
7. Any credible report that enrollment was **pressured, made a condition of help, or tied to
   religious participation**.
8. The system or detector was **unavailable for more than one business day**, or a restore drill
   failed.
9. Counsel says an open [legal-review](legal-review.md) item must be resolved first.

Enrollment resumes when the program lead and OMH agree the cause is fixed, with the reason recorded.

**Suspend the whole pilot** (tell participants, stop new cases, keep following up open ones as
far as possible) if harm is linked to Heartbeat — for example, a disclosure that helped someone find a
participant who was avoiding them — if the host cannot staff follow-up for two weeks, or on legal
advice.

## 8.6 Stage gates

**Stage A → Stage B** after at least 8 weeks, only if all of these hold:

* At least 10 participants enrolled and at least 5 overdue cases handled (if fewer cases occurred,
  extend Stage A; the follow-up loop has not been tested yet).
* ≥ 90% of cases accepted within one business day; ≥ 90% with a first action within one business
  day of acceptance; no case uncovered for more than one business day.
* Every closed case has a valid reason and evidence; closure reviews done weekly.
* No privacy incident; monthly access reviews signed off.
* At least 8 participant interviews: ≥ 80% pass the 30-day teach-back recheck; no reports of
  pressure, conditioned services or religious pressure.
* Responder hours within commitment; staff survey shows the work is sustainable.
* Tabletop exercises, disaster drill and a restore test completed.
* P1 items built and tested, and the relay partner's agreement signed and its staff trained.
* The host wants to continue.

**Stage B → continuation** is decided from the evaluation report ([09](09-evaluation.md)).

## 8.7 Routine cadence

| When | What |
|---|---|
| Every staffed day | Coordinator's 5-minute check |
| Weekly | 30-minute huddle: open and uncovered cases, closure review, capacity, recording gaps |
| Monthly | Access review sign-off; host–OMH meeting on metrics, incidents and pause indicators; case sampling |
| End of each stage | Evaluation report and go/no-go decision |

## 8.8 Participants: communication, complaints and pay

* Cards, scripts and summaries say plainly: not emergency help; the host's hours; how to pause,
  stop, see your record or complain.
* Complaints go to the program lead, or to OMH directly through a contact that bypasses the host
  (to be set up in Phase 0).
* Participants are **not paid to enroll**, because payment could pressure people to join. If decision
  D8 approves it, they are paid for evaluation interviews, which have their own consent
  ([D8](11-roadmap-and-decisions.md#112-decisions-that-need-you)).
* If the pilot ends, participants are told at least 30 days ahead where possible and offered
  continuation under the host's own process or withdrawal; data is then deleted on schedule.
