Help me thoroughly groom **Heartbeat**, an Open Mission of Hope (OMH) project, into a concrete, bounded, implementable product and operating plan.

This is our last new OMH project for a while. Prioritize depth, reliability, and a realistic pilot over adding features or expanding scope. Treat this as serious product grooming, not permission to deploy a live service or enroll real people.

## Purpose

Heartbeat helps ensure that someone notices when a person disappears from independent human contact—and that an accountable person follows up.

The name references a computing/Kubernetes heartbeat. No scaling-up/down analogy is intended.

The motivating example:

> I have not seen Laura for years. I do not need to know her whereabouts or monitor her activities. But if she disappears and nobody can establish recent contact with her, I care deeply about her safety.

That concern does not automatically entitle me to see Laura’s information. Access must follow participant consent and appropriate roles.

Important beneficiaries include children, homemakers, seniors, disabled people, people with mental illness, and people experiencing homelessness—especially those without dependable everyday contact outside their household.

A dead person cannot personally produce a genuine heartbeat. However, impersonation, mistaken identification, secondhand reports, and coerced check-ins are possible. A kidnapped or abused person may still have contact with others. **Evidence of recent contact must never be presented as proof of safety or freedom from abuse.**

## First pilot

Focus initially on **voluntarily participating people experiencing homelessness in the Asheville, North Carolina area**, working through an appropriate social-service or outreach organization.

Someone I spoke with at NC Baptists on Mission thought the concept was promising. This is individual encouragement, not an organizational endorsement or partnership.

The motivating discussion concerned people experiencing homelessness who may have died during Hurricane Helene without adequate accounting. An informal claim of more than 250 deaths was mentioned; it is unverified and must not appear as an established fact or product justification.

Our priority is **protecting current lives**. Historical death-toll research is optional only if straightforward, sourced, and inexpensive. Do not turn this project into a retrospective investigation.

## Nonnegotiable boundaries

- No law-enforcement or immigration-enforcement integrations, access portals, automatic notifications, or referral workflows.
- Connect with social services; accountable social-service responders own ordinary follow-up.
- Do not collect immigration status.
- No continuous location tracking, movement histories, public person-search, or public participant-status lookup.
- Participation must work without a smartphone, app installation, stable address, or dependable relative.
- Participation is voluntary. Receiving assistance must not depend on enrollment, religious participation, or loyalty to OMH.
- Heartbeat is separate from immediate distress signaling and must not imply that it provides emergency response.
- Do not promise that enrollment guarantees rescue, survival, or protection from abuse.
- Do not silently route around these boundaries. If a proposed use case raises legal obligations or emergency-response questions, identify the issue for qualified review and keep it distinct from the software’s integrations.

## Core workflow to design

1. A participant enrolls through a trusted organization, with understandable consent and minimal necessary information.
2. They agree on realistic contact intervals, acceptable contact methods, privacy preferences, and safe ways to reach them.
3. An authorized person records meaningful contact, distinguishing firsthand interaction, self-check-in, and secondhand information.
4. When expected contact becomes overdue, an assigned responder receives a follow-up task.
5. The responder explicitly accepts responsibility. A backup receives the task if it remains unaccepted or overdue.
6. Follow-up records its source, actions, uncertainty, and outcome.
7. Cases close for a specific reason: contact restored, voluntary withdrawal, verified transfer of responsibility, or another documented outcome. Silence never automatically means death.

Design participant withdrawal, pauses, changed contact plans, and transfers carefully. Protect voluntary autonomy while considering attempts by controlling third parties to impersonate the participant or disable follow-up.

## Required analysis

Work through concrete scenarios, including:

- A lost phone, ordinary travel, or a participant wanting privacy.
- Someone using an alias or being confused with another person.
- A false, stale, mistaken, or coerced heartbeat.
- An abusive household member seeking access.
- An unavailable or unreliable responder.
- Contact through another participating organization.
- Disaster displacement, network outages, and an unavailable home organization.
- An overwhelmed team receiving more overdue cases than it can handle.

Cross-organization continuity must not become unrestricted record sharing. Explain consent, authorization, identity matching, and the minimum information exchanged.

Children remain within the broader mission, but do not assume adult enrollment and consent arrangements are suitable for them. Identify the separate safeguarding work needed before including them.

## Deliverables

Produce:

1. A concise product charter, explicit non-goals, and a bounded pilot proposal.
2. Roles and permissions, including participant control and organizational accountability.
3. The end-to-end workflow and case state transitions.
4. A minimal data model, retention/deletion approach, and access-audit design.
5. A prioritized MVP backlog with concrete acceptance criteria.
6. A failure-mode and abuse-case review with practical mitigations and residual limitations.
7. A disaster-continuity design, clearly separating MVP requirements from later enhancements.
8. A pilot operating plan: staffing assumptions, capacity limits, training, backup coverage, and criteria for pausing enrollment.
9. Evaluation measures focused on timely, completed follow-up, participant experience, privacy, false alarms, and responder workload—not merely check-in counts.
10. A short set of questions for an Asheville outreach partner about how they currently notice absences, follow up, and lose continuity.
11. A phased implementation plan and the decisions that genuinely require my input.

If an existing Heartbeat repository or specification is available, inspect it first and distinguish implemented behavior from proposals. Otherwise, do not invent an existing stack or infrastructure.

Use reasonable provisional assumptions and label them. Research current factual, legal, or service-specific claims using authoritative sources when needed; distinguish sourced facts from design recommendations.

The central standard is: **Does this help a real person’s unexplained absence get noticed and receive dependable, privacy-respecting follow-up?**

Start with your recommended design and the most consequential unresolved decisions. Do not begin with a long questionnaire or generic praise.
