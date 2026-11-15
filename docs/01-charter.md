# 1. Product charter, non-goals and pilot proposal

Status: **proposal**. Nothing in this document is implemented. Numbers marked *(provisional)* are
assumptions to be confirmed with a partner organization and qualified reviewers.

## 1.1 The problem

Some people have no one who would notice if they stopped appearing. A person experiencing
homelessness may be known by first name at a day center, a meal site and an outreach team, and yet
if they stop coming, each place may assume they moved on. Homeless-response systems do try to locate
people before marking them inactive, but mainly to keep housing lists accurate: the windows are
typically 60–90 days, are not tied to how often that person expected to be in touch, and end in a
status change or an exit recorded as missing data rather than a welfare follow-up (see
[context-and-sources.md](context-and-sources.md#current-practice)). After a disaster the gap
widens: the places that would notice are themselves closed, damaged or overwhelmed.

Heartbeat's question is narrow: **when a person who asked to be noticed stops being seen, does an
accountable person find out in time and actually follow up, in the ways that person agreed to?**

## 1.2 Charter

**Purpose.** Help ensure that a participating person's unexplained absence from human contact is
noticed and receives dependable, privacy-respecting follow-up by an accountable social-service
responder.

**What Heartbeat does.**

1. A participant enrolls voluntarily through a trusted organization and agrees a *contact plan*:
   how often they expect to be in touch, how contact may happen, what follow-up they want if they go
   quiet, and who (if anyone) may be asked about them.
2. Authorized staff record *meaningful contact*, labelled by kind (firsthand, self-check-in,
   secondhand) and by how identity was confirmed.
3. When expected contact becomes overdue, a named responder receives a follow-up task, must
   explicitly accept it, and is backed up if they do not.
4. Follow-up is recorded (what was tried, what was learned, how certain it is) until the case closes
   for a stated reason. Silence never closes a case and never means death.

**Who it is for.** People without dependable everyday contact outside their household. The wider
mission includes children, homemakers, seniors, disabled people, people with mental illness and
people experiencing homelessness. The first pilot is limited to **consenting adults (18+)
experiencing homelessness in the Asheville, North Carolina area**, enrolled through one outreach or
day-service organization. Children are excluded until separate safeguarding work is done
([children.md](children.md)).

**The standard every feature must meet.** Does this help a real person's unexplained absence get
noticed and receive dependable, privacy-respecting follow-up? A feature that adds data, reach or
convenience without improving that outcome does not belong in Heartbeat.

**What a recorded contact means — and does not.** A recorded contact means *an authorized person
recorded that this kind of contact happened at this time, with this confidence about identity*.
It is not proof that the person is safe, free, well or unharmed. A person can be coerced into
checking in, impersonated, mistaken for someone else, or in contact with others while being abused.
Heartbeat's screens, reports and conversations must never say or imply "safe", "OK", "fine",
"accounted for" or "alive" on the strength of a recorded contact
([backlog HB-UI-1](05-mvp-backlog.md#hb-ui-1-language-guardrails--p0)).

## 1.3 Principles

1. **Participant control.** The participant sets the plan, chooses the follow-up they consent to,
   may pause or withdraw, and may see what is held about them and who has looked at it.
2. **Accountable humans, not alerts.** An overdue contact creates a task owned by one named person.
   Notifications are a convenience; the task queue, reviewed at every shift, is the source of truth.
3. **Minimum necessary information.** Heartbeat holds no location history, no immigration status,
   no government identifiers, no diagnoses and no case narrative beyond what follow-up needs, and it
   deletes on a schedule ([04-data-retention-audit.md](04-data-retention-audit.md)).
4. **Uncertainty is recorded, not hidden.** Every contact carries its kind and identity confidence;
   every follow-up action carries its result and certainty.
5. **No silent failure.** Unaccepted tasks escalate, stalled cases surface, uncovered cases reach
   the program lead, and the system reports on its own scheduler every day
   ([06 §6.3](06-failure-modes-and-abuse.md#63-system-and-operational-failures)).
6. **Honest limits.** Heartbeat is not emergency help and works during the host organization's
   staffed hours. Participants, staff and anyone who asks are told so plainly.
7. **Service is never conditional.** Receiving food, shelter, outreach or any other help never
   depends on enrolling, staying enrolled, religious participation or loyalty to Open Mission of
   Hope (OMH) or the host organization.

## 1.4 Non-goals

Heartbeat will **not**:

| Non-goal | Why |
|---|---|
| Integrate with, notify, give access to, or create referral workflows for law enforcement or immigration enforcement | Nonnegotiable boundary. Ordinary follow-up belongs to social-service responders. Legal duties that might involve other agencies are flagged for qualified review and handled under the organization's own policies, outside the software ([legal-review.md](legal-review.md)). |
| Collect immigration status, citizenship, country of birth, or government ID numbers | Not needed for follow-up; proxies for immigration status are excluded too. |
| Track location continuously, store movement histories, or record where a person was found | A participant may write a short, editable "where I'm usually found" note for follow-up; contacts themselves carry no location. |
| Offer public person-search, public status lookup, or confirmation of enrollment to callers | Prevents use by abusers, creditors, or anyone hunting for a person. |
| Help anyone locate a participant | A concerned relative or friend learns only what the participant has authorized — by default, nothing. |
| Provide emergency response or distress signaling | Heartbeat is not a panic button, duress code, or 911 substitute, and must not be presented as one. Immediate danger is handled through the organization's existing emergency procedures. |
| Promise rescue, survival, or protection from abuse | It promises a documented, accountable attempt at follow-up within stated hours — nothing more. |
| Require a smartphone, app, stable address, ID document, or reachable relative | Participation must work for a person with none of these. |
| Infer absence from surveillance data (camera, phone location, card swipes, social media) | Contact must be meaningful human contact, recorded deliberately. |
| Feed individual records to other OMH systems (e.g. Infrared's aggregate signals, Agape's emergency features) or to HMIS | Keeps consent scope clear. Any future integration needs its own consent and review. |
| Investigate past deaths | The priority is current lives. A short sourced note on Hurricane Helene appears in [context-and-sources.md](context-and-sources.md); no retrospective investigation is planned. |
| Enroll children in the pilot | Requires separate safeguarding work ([children.md](children.md)). |

## 1.5 Bounded pilot proposal

| Element | Proposal |
|---|---|
| Host | One Asheville-area organization with **existing, frequent, in-person contact** with people experiencing homelessness (a day center, street-outreach team, or low-barrier shelter). Not a domestic-violence agency or VAWA-funded program unless counsel approves a design ([legal-review §7](legal-review.md#7-vawa-confidentiality--blocking)). Not yet identified; no organization has been approached or has agreed to anything. |
| Participants | Adults 18+ experiencing homelessness (sheltered or unsheltered) who already have some contact with the host, can consent for themselves, and choose to enroll after a consent conversation. Adults under a court-appointed guardianship are excluded until reviewed ([legal-review §12](legal-review.md#12-adults-under-guardianship--blocking-before-including-them)). |
| Size | **Stage A:** up to 15 participants for 8 weeks. **Stage B:** up to 40 for 16 weeks, only if Stage A meets its gates. *(provisional; capacity formula in [08 §8.2](08-pilot-operations.md#82-capacity))* |
| Contact methods (MVP) | **Staff-mediated only**: in-person contact at the host and phone contact with a staff member; from Stage B, relays recorded by a partner organization. No automated texting or app ([decision D2](11-roadmap-and-decisions.md#d2-contact-channels-in-the-mvp)). |
| Hours | Host's staffed hours (assumed weekday business hours). Clocks and escalation timers run in business hours. Stated plainly to every participant. |
| Responders | Host staff (or supervised, trained volunteers if the host already uses them for outreach): one coordinator plus deputy, and four responders (at least three) committing at least 12 hours a week between them. |
| Second organization | Added only in Stage B, as a **relay partner** that can record a contact for a participant who shows their code, without seeing that person's record ([07 §7.2](07-disaster-continuity.md#72-cross-organization-continuity)). |
| Software | A small web application hosted off-site (outside western NC), built to the P0 backlog. Not deployed and not used with real people until Phase 2 gates are met ([11](11-roadmap-and-decisions.md)). |
| Before any enrollment | Qualified legal review of the items in [legal-review.md](legal-review.md); written agreement with the host; staff training; tabletop exercises of every scenario in [06](06-failure-modes-and-abuse.md). |
| Success means | Overdue participants are reliably picked up by a named responder within a business day, follow-up is documented to a reasoned close, participants say they understood and felt respected, no privacy harm occurs, and responder workload stays sustainable ([09](09-evaluation.md)). Not check-in counts. |

### Why this shape

* **Staff-mediated contact first.** The hard part is not collecting check-ins; it is making sure an
  overdue person gets a real follow-up. Automated channels add consent, impersonation, delivery and
  cost problems before the follow-up loop is proven, and they do not help participants without
  phones.
* **A host that already sees people.** If the host does not already have regular contact, Heartbeat
  would have nothing meaningful to record, and the pilot would measure recording gaps, not absences.
* **Small numbers.** Each overdue case can take hours of a skilled person's time. A pilot that
  enrolls faster than its responders can follow up would create the very failure Heartbeat exists to
  prevent.

## 1.6 Terms

| Term | Meaning |
|---|---|
| Participant | An enrolled person. Never "client", "subject", or "user" in participant-facing text. |
| Host organization | The organization that enrolled the participant and is accountable for their follow-up. |
| Contact | A recorded instance of meaningful contact, with a *kind* and an *identity confidence*. |
| Qualifying contact | A contact that, under the participant's plan, resets their contact clock. |
| Contact plan | The participant's agreed interval, methods, follow-up permissions and privacy preferences. |
| Overdue | No qualifying contact by *last qualifying contact + interval + grace*, outside any pause. |
| Follow-up case | The record of the response to one overdue period (or other trigger), from opening to close. |
| Responder | A trained staff member who accepts and carries out a follow-up case. |
| Coordinator | The person on duty who owns the queue, backs up responders, and reviews closures. |
| Relay | A contact recorded by a different participating organization, passed to the host without sharing the participant's record. |
