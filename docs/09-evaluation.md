# 9. Evaluation

Status: **proposal**. Targets are *(provisional)* Stage A targets.

## 9.1 Principles

* **Measure follow-up, not check-ins.** The number of contacts recorded or people enrolled is
  context, never success. A pilot with many check-ins and slow, undocumented follow-up has failed.
* **Small numbers.** With 15–40 participants, report counts, medians and individual case reviews,
  not significance tests or rates on tiny bases. Suppress any cell under 5 in anything shared outside
  the host.
* **Participants' own view counts as much as system data.** Short, voluntary interviews with their
  own consent — paid for the participant's time if decision D8 approves.
* **De-identified** exports only (HB-EVAL-1); interviews are not linked to Heartbeat records outside
  the host.

## 9.2 Measures

### A. Timely follow-up

| Measure | Definition | Source | Target |
|---|---|---|---|
| Time to acceptance | `overdue_at` → `accepted_at`, business hours: median and 90th percentile | System | ≥ 90% within 1 business day |
| Time to first action | `accepted_at` → first action | System | ≥ 90% within 1 business day |
| Uncovered time | Number of cases and total business hours with no owner | System | No case > 1 business day |
| Who accepted | Share accepted by primary, backup, coordinator | System | Most by primary or backup |
| Stalled cases | Share of open case-days spent stalled | System | < 10% |

### B. Completed follow-up

| Measure | Definition | Source | Target |
|---|---|---|---|
| Valid closure | Closed cases with a §3.9 reason and required evidence | System + weekly review | 100% |
| Closure reasons | Distribution, including `contact_restored_self_report` and extended watch | System | Reported, no target |
| Time to resolution | `overdue_at` → `closed_at` for contact-restored cases | System | Reported |
| Methods tried | Cases reaching extended watch with every consented method tried | System | 100% |
| Wrong-person errors | Voided contacts; reopened cases | System | Reported; each reviewed |
| Help connected | Cases where the responder reports the follow-up connected the participant with help *they wanted* (yes/no and broad category only) | Responder | Reported |
| Follow-up actually happened | Of sampled closed cases where the participant agreed to be asked, share who confirm someone reached out | Interviews | Reported |

### C. False alarms and recording reliability

| Measure | Definition | Source | Target |
|---|---|---|---|
| Recording-gap rate | Cases closed as `recording_gap` | System | < 30% (pause trigger above) |
| "I was here" | Participants with a case who say they were around and not recorded | Interviews | Reported |
| Weak-identity contacts | Share of contacts recorded `stated` or `code_only` | System | Falling over time |
| Remote-only participants | Participants hitting the 60-day in-person prompt | System | Reported |

### D. Participant experience

Asked at about 30 days after enrollment, after any follow-up case, and at withdrawal (if the person
is willing):

| Measure | Question (plain-language versions to be tested) |
|---|---|
| Understanding | Teach-back recheck: what happens if you're not seen; is this emergency help; how do you stop? (≥ 80% pass) |
| Respect | Did staff treat you with respect when signing up and following up? |
| Surveillance | Does Heartbeat make you feel watched? |
| Voluntariness | Did you feel you had to join, or that help here depended on it? Did anyone connect it with church or religion? (Target: no "yes" answers; any "yes" triggers review and pause criterion 7) |
| Welcome follow-up | If someone followed up on you, was that welcome, too much, or not enough? |
| Recommend | Would you suggest it to a friend in your situation? |
| Leaving | Withdrawals and optional reasons; complaints received |

Also count — without keeping any record of who — how many people were offered enrollment and
declined, and the broad reasons they gave, to see who Heartbeat does not reach.

### E. Privacy

| Measure | Source | Target |
|---|---|---|
| Access-review exceptions per month, and how many were confirmed misuse | Audit | Zero misuse |
| Privacy incidents | Incident log | Zero |
| Requests for information about participants (callers, police, legal process), and outcomes | Host log kept outside Heartbeat | Reported; all handled per policy |
| Notes containing never-collected information (monthly sample of notes) | Coordinator review | ≥ 95% clean, trending to 100% |
| Retention job runs and deletions completed | System | 100% of scheduled runs |

### F. Responder workload

| Measure | Source |
|---|---|
| Responder hours per case, and weekly hours against commitment | Responder time log (simple weekly tally) |
| Open cases per responder (against CAP-R) | System |
| Observed `r × h` against the capacity assumptions in [08 §8.2](08-pilot-operations.md#82-capacity) | System + time log |
| Monthly 5-question staff survey: clarity, confidence, burden, emotional load, whether it is worth it | Survey |
| Median time to record a contact | Usability observation |
| Notification failures | System |

### G. Reliability of the system

Detector runs missed; uptime during staffed hours; restore-drill results; incidents.

## 9.3 Baseline

The host's current practice is the comparison. The partner questions
([10](10-partner-questions.md)) ask how absences are noticed today, how long that takes, and how
follow-up is documented. Where the host has no records, the evaluation uses staff estimates and
two or three anonymized "what happened last time" case reviews — not invented numbers.

## 9.4 Reporting

At the end of each stage, OMH and the host produce a short report: the measures above, every pause
event and why, every incident, and three to five anonymized case narratives agreed with the host.
If the evaluation is intended for publication as research, decide first whether ethics (IRB) review
is needed ([decision D8](11-roadmap-and-decisions.md#112-decisions-that-need-you)).
