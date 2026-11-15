# Issues for qualified legal review

**This is not legal advice.** It is a list of questions for North Carolina–licensed counsel,
compiled on 2026-11-14 from primary sources (ncleg.gov, eCFR, govinfo, Federal Register, HUD
Exchange, U.S. Department of Justice, FCC) with AI-assisted research. Counsel should verify every
citation and summary. Items marked **blocking** must be answered in writing before any participant
is enrolled.

Heartbeat's boundaries stay in force whatever the answers: the software will not integrate with,
notify or route referrals to law enforcement or immigration enforcement. Where the law places a duty
on a *person* (for example, to report), that duty is handled by that person under the host's own
policies, outside Heartbeat. The design's job is to make such duties visible in training and
consent, not to hide or automate them.

## 1. Adult protective services reporting — blocking

**Law.** G.S. 108A-102: "Any person having reasonable cause to believe that a disabled adult is in
need of protective services shall report such information to the director" of the county department
of social services; good-faith reporters are immune. G.S. 108A-101 defines a "disabled adult" broadly
(18 or older, or an emancipated minor, substantially incapacitated by conditions including mental or
physical illness or "continued consumption or absorption of substances") and includes neglect by a
person living alone who cannot provide for themselves.

* https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_108A/GS_108A-102.html
* https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_108A/GS_108A-101.html

**Questions.** When might a follow-up finding (for example, "found, unable to care for themselves")
give a responder reasonable cause to report? What must the consent conversation say about this?
How should the responder document their judgment without Heartbeat appearing to make the decision?

## 2. Reporting duties involving juveniles — blocking

**Law.** G.S. 7B-301: any person or institution that suspects a juvenile is abused, neglected or
dependent must report to county social services; knowing or wanton failure is a Class 1
misdemeanor. G.S. 14-318.6: any person 18 or older who knows or should reasonably have known that a
juvenile has been or is the victim of a violent offense, sexual offense or misdemeanor child abuse
must immediately report to **local law enforcement**; "the age of the juvenile at the time of the
abuse or offense governs".

* https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_7B/GS_7B-301.html
* https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_14/GS_14-318.6.html

**Questions.** Excluding children from the pilot does not remove these duties when an adult
participant mentions a child, or possibly describes abuse they suffered as a juvenile. What do staff
need to know and say? How does a personal duty to report to police sit alongside Heartbeat's
no-law-enforcement boundary, and what — if anything — should Heartbeat record?

## 3. Missing-person reports — blocking for the extended-watch policy

**Law.** G.S. 143B-1760 to -1775 (recodified in 2025). No law-enforcement agency may require a
waiting period before accepting a missing-person report (143B-1765(a)). The immediate duties
(national database entry, statewide broadcast) are triggered by a report from a "parent, spouse,
guardian, legal custodian, or person responsible for the supervision" of the person. The NC Center
for Missing Persons, within the State Highway Patrol, acts as a central repository. The statutory
definition of a missing adult refers to having a temporary or permanent residence in North Carolina.

* https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_143B/GS_143B-1765.html
  (and -1761, -1764, -1769)

**Questions.** If a host decides, outside Heartbeat, that a missing-person report is warranted, who
may make it, with what consent, and what may they disclose? Does the residence element create
problems for unhoused people? What should the consent conversation say? Heartbeat will not prompt,
draft or route such reports.

## 4. HIPAA — blocking if the host is a covered entity

**Law.** 45 CFR 160.103 defines covered entities (including health-care providers that conduct
standard electronic transactions) and business associates (anyone who creates, receives, maintains
or transmits protected health information for a covered entity, including subcontractors). HHS
guidance says a cloud host storing ePHI is a business associate even if it only stores encrypted data
without the key.

* https://www.ecfr.gov/current/title-45/section-160.103
* https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html

**Questions.** Is the host (or a component of it, such as a street-medicine or Health Care for the
Homeless program) a covered entity? Would Heartbeat contact and follow-up records be PHI? If so, OMH
needs a business associate agreement and Security Rule compliance — or the pilot should use a host or
program component that is not covered.

## 5. 42 CFR Part 2 (substance-use treatment records) — blocking to confirm

**Law.** Part 2 protects records identifying a person as having a substance-use disorder that come
from a federally assisted program holding itself out as providing SUD diagnosis, treatment or
referral for treatment (42 CFR 2.11, 2.12). "Federally assisted" is broad (it includes tax-exempt
status). Recipients of such records remain bound by restrictions on use and redisclosure.

* https://www.ecfr.gov/current/title-42/section-2.12

**Questions.** Could the host, or a relay partner such as a recovery center, be a Part 2 program?
Is Heartbeat's "no substance-use information" rule, with warnings on free-text notes, sufficient,
or must such organizations be excluded or separated?

## 6. HUD HMIS privacy and security standards — blocking if the host is HUD-funded

**Law.** HUD's 2004 HMIS Data and Technical Standards (69 FR 45888) define a "covered homeless
organization" (including its contractors) and state that "all PPI maintained by a CHO is subject to
these standards" — which on its face may include data held outside HMIS. HUD Exchange still directs
communities to follow the 2004 privacy and security standards; the 2011 proposed HMIS rule was never
finalized. CoC program recipients must also keep participant records confidential (24 CFR
578.103(b)).

* https://www.federalregister.gov/d/04-17097
* https://www.hudexchange.info/programs/hmis/hmis-data-and-technical-standards/

**Questions.** Would Heartbeat data held by a HUD-funded host fall under these standards (including
privacy-notice disclosures)? Is OMH a "contractor" within the definition?

## 7. VAWA confidentiality — blocking

**Law.** 34 U.S.C. 12291(b)(2) and 28 CFR 90.4(b): grantees and subgrantees under the Violence
Against Women Act (not only victim service providers) may not disclose personally identifying
information — which includes phone numbers and location information — "regardless of whether the
information has been encoded, encrypted, hashed", except with informed, written, reasonably
time-limited consent or a statutory or court mandate; consent cannot be a condition of services; the
rule applies between parts of the same organization. Separately, victim service providers may not
enter personally identifying information into HMIS (42 U.S.C. 11363). DOJ's Office on Violence
Against Women has said cloud storage is possible with sufficient precautions, including contract terms
that the service provider (the grantee) owns the information.

* https://www.govinfo.gov/content/pkg/USCODE-2024-title34/html/USCODE-2024-title34-subtitleI-chap121-subchapIII-sec12291.htm
* https://www.justice.gov/ovw/page/file/1006896/download (FAQ, 2017)

**Questions.** If the host receives VAWA funds, do relays, transfers, asking a named person, or
giving a partner organization the participant's permitted message count as disclosures needing
written, time-limited consent? Should VAWA-funded organizations and
domestic-violence agencies be excluded from the pilot (the current default), or included only with
a separately controlled design?

## 8. Breach notification — not blocking

**Law.** The NC Identity Theft Protection Act applies to nonprofits, but "personal information"
means a name combined with identifiers such as Social Security, driver's licence or passport
numbers, account numbers or biometric data (G.S. 75-61, 14-113.20(b)); phone numbers are not
listed. Heartbeat, which collects none of these, would likely fall outside — unless free-text notes
capture such numbers. A party holding data it does not own must notify the owner immediately
(75-65(b)).

* https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_75/GS_75-61.html
* https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_75/GS_75-65.html

**Question.** What voluntary breach-notice terms should the OMH–host agreement adopt anyway?

## 9. Subpoenas, court orders and other compelled disclosure — blocking

**Law.** G.S. 108A-80's confidentiality protections cover public social-services agencies, not
private nonprofits; no general privilege for a private nonprofit's records was found. Role-specific
privileges exist (G.S. Chapter 8, Article 7), including communications with clergy seeking spiritual
counsel (8-53.2), licensed social workers (8-53.7), counselors (8-53.8), and domestic-violence and
rape-crisis agents (8-53.12). As reported, a new G.S. 108A-80(b2), effective 1 October 2026, requires
the state Department of Health and Human Services to refer applicants whose immigration status cannot
be verified to federal immigration authorities — a reason to keep Heartbeat data out of public-agency
systems entirely.

* https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByArticle/Chapter_8/Article_7.html

**Questions.** What subpoena and court-order response policy should the host and OMH adopt
(require valid process, narrow it, notify the participant where lawful)? What honest sentence about
compelled disclosure belongs in the consent conversation? Does any privilege realistically apply?

## 10. Automated texts and calls — not blocking for the MVP; blocking for HB-P2-1

**Law.** The TCPA rules (47 CFR 64.1200(a)(1)(iii)) prohibit autodialed or prerecorded calls,
including texts, to mobile numbers without prior express consent, except for emergency purposes —
which Heartbeat, as a non-emergency service, should not rely on. Revocation of consent must be
honored by any reasonable means; an FCC order (FCC 26-67) reported as taking effect 25 November 2026
changes how revocation may be handled. US carriers require application-to-person texting from
standard numbers to be registered through The Campaign Registry (10DLC), with verified brand status.

* https://www.ecfr.gov/current/title-47/section-64.1200
* https://www.federalregister.gov/d/2026-21821

**Question.** If text check-ins are added later, what written consent and opt-out handling are
required?

## 11. Documenting emergencies and deaths — blocking for training

**Questions.** When a responder finds someone in danger or dead and follows the host's emergency
procedures outside Heartbeat, what (if anything) should Heartbeat record, given that its records may
later be subpoenaed? What source is sufficient to close a case as `reported_deceased`, and who may
lawfully tell a responder of a death?

## 12. Adults under guardianship — blocking before including them

Adults with a court-appointed guardian (G.S. Chapter 35A) may not be able to consent on their own,
and a guardian's authority over enrollment, records and withdrawal raises the same problems as for
children. **Default:** excluded from the pilot until reviewed.

## 13. Faith-based hosts and federal funds — not blocking

If the host receives federal funds, rules on the equal participation of faith-based organizations
(for HUD programs, 24 CFR 5.109) require explicitly religious activities to be separate from funded
services and voluntary. Heartbeat's own rule is stricter: enrollment and assistance never depend on
religious participation. **Not verified in this review.**

**Question.** Does anything in the host's funding change how Heartbeat must be presented?

## 14. The OMH–host agreement

As far as this review found, North Carolina has no comprehensive consumer-privacy statute defining
"controller" and "processor" roles (several other states do, often exempting nonprofits) — counsel
should confirm. Either way, the agreement must spell out: who decides
about participant data; OMH acting only on the host's instructions; purpose limits (follow-up only;
never eligibility, sanctions or discharge); retention and deletion; legal-process handling; breach
notice; what happens if either party withdraws; and the boundaries in [01 §1.4](01-charter.md#14-non-goals).

## 15. Informal requests from police or immigration officers — blocking for training

Officers may ask front-desk or outreach staff, in person or by phone, whether a person is around or
what is known about them, sometimes without any legal process. Heartbeat gives staff nothing to
look up for them, but staff still need a lawful, consistent response.

**Questions.** What should the host's policy and staff script say? When may staff decline to answer,
and how should they distinguish a request from a warrant, subpoena or court order? Who on the host's
side receives formal process, and how is OMH told?

## Not verified from primary text during this review

* HHS cloud guidance was read via an archived copy because hhs.gov blocked automated access.
* FCC 26-67 and the revocation-rule timeline; session laws amending G.S. 75-65 (2025) and adding
  108A-80(b2) (2026) — codified text was relied on, session laws were not read.
* The absence of a general privilege for private nonprofit records (no case-law check).
* Whether OVW has issued guidance newer than its 2017 FAQ.
* 24 CFR 5.109 and G.S. Chapter 35A were not reviewed.
