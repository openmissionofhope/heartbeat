# 11. Phased implementation plan and decisions

Status: **proposal**. Durations are rough and assume a small team. No phase starts without the
previous phase's exit criteria being met.

## 11.1 Phases

| Phase | What happens | Exit criteria |
|---|---|---|
| **0. Discovery and review** (no software, no participants; ~6–10 weeks) | Decide D1–D8 below. Identify and approach a prospective host; hold the partner conversation ([10](10-partner-questions.md)). Obtain qualified legal review of [legal-review.md](legal-review.md). Draft and plain-language-test the consent conversation, card and summaries (English and Spanish). Draft the OMH–host agreement. Set up the participant complaint route to OMH. | Signed host agreement, or a documented decision not to proceed. Counsel's written answers to every item marked *blocking*. Consent materials tested with people with lived experience of homelessness (paid for their time). |
| **1. Build with synthetic data** (~8–12 weeks) | Choose the stack (D5). Build every P0 item in [05](05-mvp-backlog.md) with automated and scenario tests. Independent security review. Usability sessions with host staff on synthetic participants. Tabletop exercises of every scenario in [06](06-failure-modes-and-abuse.md); paper disaster drill; restore drill. Training modules delivered. | All P0 acceptance criteria pass. Security findings fixed or accepted in writing by the host and OMH. Host signs off that staff can run it. |
| **2. Stage A pilot** (≤ 15 participants, ≥ 8 weeks) | Enrollment at the host only, staff-mediated contact only. Weekly huddles, monthly reviews, interviews. In parallel, build and test the P1 items (relay, hash-chained audit export) and agree terms with a relay partner. | Gates in [08 §8.6](08-pilot-operations.md#86-stage-gates). |
| **3. Stage B pilot** (≤ 40 participants, ~16 weeks) | Add the relay partner organization under its own agreement. | Evaluation report ([09](09-evaluation.md)); decision with the host to continue, change or stop. |
| **4. Later, only on evidence** | P2 items one at a time, each with its own review. Continuity partners. Other Asheville organizations. Other populations — seniors, disabled people, homemakers — each groomed separately, because their contact patterns, risks and partners differ. Children only after the work in [children.md](children.md). | Each expansion has its own charter addendum, consent review and pilot gates. |

What is **not** on the roadmap: law-enforcement or immigration integrations, location features,
public lookup, emergency features, or retrospective death investigation.

## 11.2 Decisions that need you

These change what gets built or who carries risk; they are not mine to default.

### D1. Who operates the system and holds the data

* **Recommended:** OMH hosts and operates Heartbeat as a service provider acting only on the host's
  written instructions (processor), with the host as the party that decides about participant data
  (controller). The written agreement covers the responsibilities in
  [02 §2.5](02-roles-and-permissions.md#25-organizational-accountability).
* Consequence: OMH becomes a recipient of subpoenas and breach duties, may become a HIPAA business
  associate or fall under HUD HMIS or VAWA rules depending on the host ([legal-review.md](legal-review.md)),
  and needs a named person reachable during the host's hours.
* Alternative: the host runs the open-source software itself — less OMH exposure, but *(assumption,
  to check in the partner conversation)* most Asheville outreach organizations are unlikely to have
  the technical staff.

### D2. Contact channels in the MVP

* **Recommended:** staff-mediated only (in person, phone with staff, relay) for Stages A and B.
* Alternative: add text-message self-check-in at Stage A. That brings TCPA consent and opt-out
  handling, 10DLC brand verification and registration, delivery costs, impersonation risk, and a new
  kind of false reassurance — before the follow-up loop is proven.

### D3. Approaching a host

Who makes the first approach, and to which kind of organization. The host should be one with
**daily, in-person contact** (day center, outreach team or low-barrier shelter) and responders who
already do outreach. An organization whose staff encouraged the idea may be a good source of
introductions without being the right host. Candidate organizations are listed, uncontacted, in
[context-and-sources.md](context-and-sources.md#asheville-service-landscape).

### D4. Legal review

Who provides qualified review (North Carolina–licensed counsel, pro bono or paid), and the budget.
Several items in [legal-review.md](legal-review.md) are *blocking*: no enrollment until they are
answered.

### D5. Technology stack

No stack exists. The original repository stub had a Rust `.gitignore`, which suggests Rust was
considered; nothing else was decided.

* **Recommended:** reuse the approach OMH already runs in production for Agape — one server-rendered
  TypeScript (Node.js) service that works without JavaScript, a scheduled worker, append-only audit
  triggers, and hosting outside the region — because OMH can maintain one pattern more reliably than
  two. **One change:** use a managed PostgreSQL database instead of Agape's SQLite, because Heartbeat
  needs separate database roles for the application, the retention job and audit export
  ([04 §4.3](04-data-retention-audit.md#43-storage-and-security-baseline)), which SQLite cannot
  provide.
* Alternative: Rust (as in OMH Infrared), if you prefer it for this project.

### D6. Default for remote withdrawal

* **Recommended:** "confirm with me in person if you see me within 30 days", with "stop right away"
  as the participant's alternative at enrollment ([03 §3.10](03-workflow-and-states.md#310-enrollment-states-pauses-plan-changes-and-withdrawal)).
* This is a values choice between protecting autonomy (honor every withdrawal instantly) and
  guarding against a controlling person withdrawing someone. Outreach stops immediately either way;
  only deletion and the record's existence wait.

### D7. Funding and staff time

Who pays for responder and coordinator hours at the host (about 12–25 hours a week across a team in
Stage B), OMH operator time, interview payments, and legal review.

### D8. Evaluation ethics and pay

Whether the pilot evaluation is intended for publication (if so, seek IRB review before Stage A),
and whether to pay participants for interviews (recommended: yes, modestly, with separate consent).

## 11.3 Defaults I chose (say if you disagree)

| Default | Where |
|---|---|
| Adults 18+ who can consent for themselves; no one under a court-appointed guardianship until reviewed | [01](01-charter.md), [legal-review.md](legal-review.md) |
| Business-hours operation, stated plainly | [03 §3.2](03-workflow-and-states.md#32-provisional-parameters) |
| Contact intervals of 7 / 14 / 30 days and the escalation timers | [03 §3.2](03-workflow-and-states.md#32-provisional-parameters) |
| Retention periods (contacts 90 days; notes 180 days after closure; audit 2 years) | [04 §4.4](04-data-retention-audit.md#44-retention) |
| Participants may choose code-only lookup, so they do not appear in name searches | [02 §2.4](02-roles-and-permissions.md#24-participant-control) |
| No photos in the MVP | [05 HB-P2-3](05-mvp-backlog.md#p2--later-phases-each-needs-separate-review) |
| No victim-service-provider or VAWA-funded host in the pilot unless counsel approves a design | [legal-review.md](legal-review.md) |
| No further Hurricane Helene death-toll research beyond the sourced note | [context-and-sources.md](context-and-sources.md#hurricane-helene) |
| Apache License 2.0, as already in the repository | [LICENSE](../LICENSE) |
