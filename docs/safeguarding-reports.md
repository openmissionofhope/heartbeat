# Required abuse reports

Status: **OMH policy, decided 2026-11-15.** Implemented in the software (`src/domain/safeguarding.ts`).
How it applies in each host still needs qualified legal review ([legal-review.md](legal-review.md)).

## The policy

| If staff learn of… | They report it to | Legal basis noted so far |
|---|---|---|
| Abuse or neglect of a **child** | **Police** and **county child protective services** | G.S. 7B-301 (any person → county social services); G.S. 14-318.6 (any adult → local law enforcement, for certain offenses) |
| Abuse by an **intimate partner** | **Police** | OMH policy. This review found no North Carolina statute that requires a private nonprofit or its staff to report abuse of a competent adult by a partner to police; counsel should confirm ([legal-review §16](legal-review.md#16-reporting-intimate-partner-abuse-to-police--blocking)) |
| A **disabled adult who needs protective services** | **County adult protective services** | G.S. 108A-102 (any person → county social services) |
| Possible **immigration violations** | **Never reported, by anyone, ever** | OMH policy. Reports must not mention immigration status. |

## How it works

1. A staff member who learns something that must be reported opens **Required reports**, picks the
   category and (optionally) the participant's code.
2. Heartbeat shows exactly who to call and the local numbers the program lead has set. **If anyone is
   in immediate danger, staff call 911 first.**
3. The staff member **makes the call themselves**. Heartbeat sends nothing to police, social services
   or anyone else, and there is no data feed, portal or automatic notification. This keeps the
   original boundary: no law-enforcement *integrations*.
4. They record that the report was made, with an optional reference number. A reference that mentions
   immigration is refused.
5. A report not recorded as made within 2 staffed hours reaches the coordinator on duty, and after a
   business day the program lead, so a required report cannot be forgotten.
6. Heartbeat stores only the category, who to call, who identified it, when it was made and the
   reference. No narrative: the details go in the report itself, not in Heartbeat. Records are deleted
   after two years.

## What participants are told

The consent conversation says plainly, before anyone discloses anything
([03 §3.3](03-workflow-and-states.md#33-step-1--enrollment)):

> If you tell us about abuse of a child, about abuse by a partner, or about a disabled adult who needs
> protection, we must report it — to police for child abuse and partner abuse (and to county social
> services for a child), and to county social services for a disabled adult. We never report anyone
> about immigration.

## Risks to weigh

* **Partner abuse.** Reporting a competent adult's partner abuse to police without their agreement
  can increase danger to them, can lead people to stop disclosing or to withdraw from Heartbeat, and
  — if a host receives VAWA funds — may conflict with VAWA confidentiality, which bars disclosure of
  personally identifying information without written, time-limited consent
  ([legal-review §7](legal-review.md#7-vawa-confidentiality--blocking)). Domestic-violence agencies
  generally advise against mandatory police reporting for adults. OMH may wish to revisit this part
  of the policy after legal review and consultation with a domestic-violence agency.
* **Police involvement generally.** Any police report can bring a participant into contact with law
  enforcement, which some participants fear. Training covers how to make reports without speculating
  or adding unnecessary details, and never mentioning immigration.
* **Childhood abuse disclosed by adults.** G.S. 14-318.6 uses the victim's age at the time of the
  offense; whether it reaches an adult describing their own childhood is a question for counsel
  ([legal-review §2](legal-review.md#2-reporting-duties-involving-juveniles--blocking)).
