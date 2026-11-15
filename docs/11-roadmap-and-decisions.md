# 11. Phased plan and decisions

Status: the software is **built** (2026-11-15, decision to "build everything that needs to be
built"). What remains phased is **rollout**: no host enrolls real people until its readiness gate
passes, and each pilot stage has its own gates.

## 11.1 Phases

| Phase | What happens | Exit criteria |
|---|---|---|
| **0. Discovery and review** (no participants) | Find a prospective host and the people to staff it (D3, D7); hold the partner conversation ([10](10-partner-questions.md)). Obtain qualified legal review of [legal-review.md](legal-review.md) (D4). Plain-language-test the consent conversation, card and summaries (English and Spanish) with people with lived experience, paid for their time. Draft the OMH–host agreement and the complaint route to OMH. | Signed host agreement, or a documented decision not to proceed. Counsel's written answers to every item marked *blocking*. |
| **1. Prepare the host** (training mode) | The software is ready. Create the host in setup; train staff (modules recorded in Admin); run usability sessions, tabletop exercises of every scenario in [06](06-failure-modes-and-abuse.md), the paper disaster drill and a restore drill with made-up participants. Independent security review. Register texting (10DLC). Delete training participants. | Every readiness item recorded; an OMH operator approves going live. |
| **2. Stage A pilot** (≤ 15 participants, ≥ 8 weeks) | Enrollment at the host. Weekly huddles, monthly reviews, interviews. Agree terms with a relay partner. | Gates in [08 §8.6](08-pilot-operations.md#86-stage-gates). |
| **3. Stage B pilot** (≤ 40 participants, ~16 weeks) | Add the relay partner organization under its own agreement. | Evaluation report ([09](09-evaluation.md)); decision with the host to continue, change or stop. |
| **4. Later, only on evidence** | Turn on features that are built but off by default (photos, continuity partner, transfers between hosts) only after their own review. Other Asheville organizations. Other populations — seniors, disabled people, homemakers — each groomed separately. Children only after the work in [children.md](children.md). | Each expansion has its own charter addendum, consent review and pilot gates. |

What is **not** on the roadmap: law-enforcement or immigration integrations, location features,
public lookup, emergency features, or retrospective death investigation.

## 11.2 Decisions

### Made

| # | Decision | Date | Effect |
|---|---|---|---|
| D1 | **OMH operates the service** for host organizations, acting on each host's instructions | 2026-11-14 | Operator role, readiness gate, two-person break-glass, host-silence alerts. OMH becomes a recipient of legal process and breach duties, and may fall under HIPAA, HUD HMIS or VAWA rules depending on the host ([legal-review.md](legal-review.md)). |
| D2 | **Text-message check-ins** are offered (plus phone keypad check-ins) | 2026-11-14 | Participants choose; consent recorded; STOP/START/HELP; quiet hours; 10DLC registration is a readiness item ([legal-review §10](legal-review.md#10-automated-texts-and-calls--blocking-before-texting-is-used)). |
| — | **Build everything** in the backlog now; phase rollout, not construction | 2026-11-14 | All P0, P1 and P2 items are built; riskier ones are off by default ([05](05-mvp-backlog.md)). |
| D5 | **TypeScript/Node with PostgreSQL**, following OMH's Agape pattern | 2026-11-14 | [ARCHITECTURE.md](ARCHITECTURE.md). |
| D6 | **Remote withdrawal needs the participant's personal confirmation** | 2026-11-14 | Outreach stops at once; the withdrawal takes effect only when confirmed in person; never by silence. After 180 days pending, the program lead may end the enrollment as inactive (a documented decision, not a withdrawal). |
| — | **Required abuse reports**: child abuse to police and county CPS; intimate-partner abuse to police; disabled adults needing protective services to county APS; never anyone for immigration | 2026-11-15 | Staff make the reports by phone; Heartbeat records that they were made ([safeguarding-reports.md](safeguarding-reports.md)). |

### Open

| # | Decision | Notes |
|---|---|---|
| D4 | **Qualified legal review** | Not available yet. Blocking: no host can go live without it. Pro bono or paid North Carolina counsel; the questions are ready ([legal-review.md](legal-review.md)). |
| D3 | **Which organization to approach, and who approaches it** | The host should have daily, in-person contact (day center, outreach team or low-barrier shelter). Candidates are listed, uncontacted, in [context-and-sources.md](context-and-sources.md#asheville-service-landscape). |
| D7 | **Who pays for responder and coordinator time** | About 12–25 hours a week across a team in Stage B, plus OMH operator time, interview payments and legal review. |
| D8 | **Evaluation ethics and pay** | Whether the evaluation is for publication (if so, seek IRB review before Stage A), and whether to pay interviewees (recommended: yes, modestly, with separate consent). |
| — | **Intimate-partner reporting** | Consider revisiting after legal review and consultation with a domestic-violence agency ([safeguarding-reports.md](safeguarding-reports.md#risks-to-weigh)). |

## 11.3 Defaults I chose (say if you disagree)

| Default | Where |
|---|---|
| Adults 18+ who can consent for themselves; no one under a court-appointed guardianship until reviewed | [01](01-charter.md), [legal-review.md](legal-review.md) |
| Business-hours operation, stated plainly | [03 §3.2](03-workflow-and-states.md#32-provisional-parameters) |
| Contact intervals of 7 / 14 / 30 days and the escalation timers | [03 §3.2](03-workflow-and-states.md#32-provisional-parameters) |
| Retention periods (contacts 90 days; notes 180 days after closure; audit 2 years) | [04 §4.4](04-data-retention-audit.md#44-retention) |
| Participants may choose code-only lookup, so they do not appear in name searches | [02 §2.4](02-roles-and-permissions.md#24-participant-control) |
| Photos built but **off** for every host unless its program lead turns them on, and only with the participant's agreement | [05 HB-P2-3](05-mvp-backlog.md#p2--built-off-by-default-or-needing-review-before-use) |
| No victim-service-provider or VAWA-funded host in the pilot unless counsel approves a design | [legal-review.md](legal-review.md) |
| No further Hurricane Helene death-toll research beyond the sourced note | [context-and-sources.md](context-and-sources.md#hurricane-helene) |
| Apache License 2.0, as already in the repository | [LICENSE](../LICENSE) |
