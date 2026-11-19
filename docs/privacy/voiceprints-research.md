# Voiceprints: legal basis, consent, retention and children (research for #353)

> **This is not legal advice.** It is engineering research written to brief qualified counsel for
> spike #353 (epic #341). Nothing here is a legal opinion. Counsel must review it before Bob stores
> any voiceprint outside the owner's own household.

**Date:** 2026-09-26. **Code baseline:** HEAD `9d6655d`.

**How to read the citations.**
- External claims were checked with web search and fetch on **2026-09-26**. Each carries its source URL
  inline, and all of them are listed under *Sources*.
- Anything that could not be confirmed that day is marked **(unverified)**.
- Laws, deadlines, product behaviour and vendor status change over time. Where they appear, they
  carry an **"as of"** date.
- Some primary texts could not be fetched: the ILGA statute page (certificate error), eCFR and the
  Federal Register (bot wall), and Amazon's help pages (HTTP 503). For those, the claim is cited to a
  secondary source that quotes the text, and the primary URL is given alongside.
- Code facts were re-checked at HEAD and are cited as `path:line`.

## Context

**What we plan to build (#341).**
- Bob will store a **speaker embedding** (a fixed-length vector, the "voiceprint") for each enrolled
  household member. That includes account holders, **guests without accounts** and **children**.
- On every voice turn, it will compare the speaker against the enrolled vectors (1:N identification
  within one Space).
- Identification is a convenience hint and is never authentication (#358).
- Raw audio is never stored.
- The owner prefers a **managed speaker-ID vendor**, so turn audio may also go to a third party.

**Facts from the code that shape the legal analysis:**
- **Uplink audio lives only in memory for the length of one turn.**
  - `processTurn` (`apps/api/src/turn.ts:915`) assembles the PCM (`turn.ts:918`).
  - It clears the chunk buffer straight away (`turn.ts:921-922`).
  - The STT seam is `transcribeTurn(...)` at `turn.ts:958`.
  - `pcm` is a complete `Buffer` before that call. So an embedding could be computed in parallel
    (`Promise.all`) and thrown away in the same turn.
  - There is no audio column or bucket (#341).
- **STT is already a third-party processor.**
  - Audio goes to `fish-audio/transcribe-1` through the Vercel AI Gateway
    (`apps/ai/src/config.ts:56`), wrapped as 16 kHz mono WAV by `transcribePcm`
    (`apps/api/src/audio.ts:58`).
  - Any vendor added for speaker ID would be a **second** audio recipient.
- **Turns are short.**
  - The minimum STT length is 300 ms (`apps/api/src/core/turn-core.ts:22`).
  - Cardputer turns end after 1200 ms of silence, are capped at 15 s, and allow up to 2 follow-ups
    in a 6 s window (`apps/cardputer/include/end_of_speech.h`, `include/follow_up.h`).
  - So a 1-2 s turn is common. That affects accuracy (#352), not the law: a short embedding is still
    a voiceprint.
- **On-device identification is not possible.** The ESP32-S3 has no PSRAM
  (`docs/cardputer/wake-word-decision.md`). So biometric matching will happen on our server or at a
  vendor, never on the device.
- **Our data model has no place for guests or children yet.**
  - Every Space member is an `auth.users` row (#341, citing
    `supabase/migrations/20260916050000_spaces_init.sql:29-37`).
  - Guests and children cannot be represented, and there is no feature-flag table.
  - #354 must add profiles that are not accounts, and those profiles need their own consent records.
- **The web voice path** is `POST /api/voice` (`apps/api/src/web-voice.ts:100`), which returns `{text}`.
- **Deployment.** We run on Railway with Node (`docs/deploy.md`), and store data in Supabase Postgres
  with pgvector.

**The question.** What must be true, legally, before the first embedding row is written? Who can
consent for whom? How long can we keep a voiceprint? What changes if a vendor is involved?

## Laws that apply

### Illinois BIPA (740 ILCS 14), as of 2026-09-26

The primary text is at https://www.ilga.gov/legislation/ilcs/ilcs3.asp?ActID=3004&ChapterID=57, but
that page failed its TLS check on 2026-09-26. The provisions below are verified through the secondary
sources cited with each one.

- **Scope, §10.**
  - "Biometric identifier" expressly lists a **"voiceprint"**. The Texas CUBI definition uses the same
    list; see *US states*.
  - "Biometric information" is information based on a biometric identifier and *used to identify* an
    individual. Martell v. X Corp. (N.D. Ill., 13 June 2024) relied on that wording, dismissing because
    the data could not identify anyone:
    https://www.insideprivacy.com/privacy-and-data-security/illinois-federal-court-dismisses-bipa-suit-against-x-holding-biometric-identifiers-must-identify-individuals/.
  - BIPA has no revenue or size threshold (unverified this session; the statute says "private entity").
- **Is our embedding covered? Treat it as a voiceprint.**
  - It exists to identify a speaker, which is exactly the element Martell found missing.
  - *Rivera v. Google* (N.D. Ill. 2017) held that face templates are biometric identifiers however they
    were derived: https://natlawreview.com/article/court-refuses-to-dismiss-biometric-privacy-action-over-facial-recognition-technology.
    Google later won that case on standing, in December 2018:
    https://blog.ericgoldman.org/archives/2018/12/google-photos-defeats-privacy-lawsuit-over-face-scans-rivera-v-google.htm.
  - *Wilcosky v. Amazon* (N.D. Ill., 1 November 2023) treated Alexa Voice ID data as a voiceprint;
    see *Voice-assistant cases* below.
- **Retention schedule, §15(a).**
  - We must publish a written policy that sets a retention schedule.
  - It must require permanent destruction "when the initial purpose … has been satisfied or within
    three years of the individual's last interaction with the private entity, whichever occurs first":
    https://www.thompsoncoburn.com/insights/illinois-appeals-court-holds-that-bipa-section-15a-requires-retention-and-destruction-policies-upon-possession-of-any-biometric-data/.
  - The duty starts when we first possess any biometric data (*Mora v. J&M Plating*, Ill. App.). So the
    policy has to exist **before** the first enrolment.
- **Informed written consent, §15(b).** We must:
  1. tell the person in writing that we collect the data;
  2. tell them the **specific purpose and length of term**;
  3. obtain a **written release**.
  - *Wilcosky* found that describing Voice ID and "an acoustic model" was **not** enough. The notice
    must say plainly that a voiceprint, a biometric identifier, is being collected:
    https://blogs.duanemorris.com/classactiondefense/2023/11/04/illinois-federal-court-allows-amazon-alexa-privacy-class-action-to-proceed/.
- **Other duties.**
  - No selling or profiting from the data, §15(c).
  - No disclosure without consent, §15(d).
  - A reasonable standard of care in security, §15(e).
  - These three were not re-read in the primary text on 2026-09-26: **(unverified wording)**.
- **Damages, §20.**
  - **$1,000** per negligent violation, or **$5,000** per reckless or intentional one:
    https://openclassactions.com/settlements/amazon-alexa-voice-id-bipa-class-action.php.
  - No actual harm needs to be shown (*Rosenbach v. Six Flags*, 2019 IL 123186).
  - Claims can be brought for 5 years (*Tims v. Black Horse Carriers*, 2023 IL 127801, decided
    2 February 2023): https://www.privacyworld.blog/2023/02/breaking-illinois-supreme-court-sets-five-year-statute-of-limitations-for-all-bipa-claims/.
- **The 2024 amendment: SB 2979, Public Act 103-0769.**
  - Signed **2 August 2024**:
    https://www.bytebacklaw.com/2024/08/bipa-amendment-bill-signed-into-law/, bill text at
    https://legiscan.com/IL/text/SB2979/id/2999068.
  - **Per-person damages.** Repeated collection of the same identifier, from the same person, by the
    same method, is **one violation** with "at most, one recovery". The same rule now applies to
    §15(d) disclosures. This reverses the per-scan accrual of *Cothron v. White Castle* (Ill. 2023).
  - **Electronic signatures.** "Written release" now includes an **electronic signature**: "an
    electronic sound, symbol, or process attached to or logically associated with a record and executed
    or adopted by a person with the intent to sign the record".
    - A web checkbox plus a typed name qualifies.
    - A spoken "yes" is an "electronic sound", so it *may* qualify as a release. But it would need an
      intent-to-sign record and a stored record of what was agreed. **Question for counsel.**
  - **Retroactive.** The Seventh Circuit held on **1 April 2026** that the amendment applies to cases
    already pending (*Clay v. Union Pacific*, No. 25-2185):
    https://law.justia.com/cases/federal/appellate-courts/ca7/25-2185/25-2185-2026-04-01.html.
  - **What it means for us.** Exposure is now **$1,000–$5,000 per person**, not per turn. It is still
    material: a household of 6 plus guests without a valid release.
- **Voice-assistant voiceprint cases, as of 2026-09-26.**
  - **Amazon Alexa Voice ID.** *Wilcosky v. Amazon* was renamed *Gunderson v. Amazon*, No.
    1:19-cv-05061, N.D. Ill., before Judge Valderrama.
    - **1 November 2023:** Amazon's motion to dismiss the §15(b) claims was **denied**.
    - The court held that a **non-user who spoke near someone else's device** (plaintiff Stebbins,
      never enrolled) can sue. BIPA requires no relationship between the collector and the person:
      https://blogs.duanemorris.com/classactiondefense/2023/11/04/illinois-federal-court-allows-amazon-alexa-privacy-class-action-to-proceed/.
    - **November 2025:** the court certified a class of about **1.18 million** Illinois Voice ID
      enrollees:
      https://blogs.duanemorris.com/classactiondefense/2025/11/26/the-class-action-weekly-wire-episode-128-illinois-federal-judge-certifies-class-of-1-2-million-amazon-alexa-users-in-bipa-class-action/.
    - There has been no settlement as of the last report:
      https://openclassactions.com/settlements/amazon-alexa-voice-id-bipa-class-action.php.
  - **May 2026 suits over voices used to train AI.** Loevy + Loevy sued Adobe, Google, Amazon, Apple,
    ElevenLabs, Meta, Microsoft, NVIDIA and Samsung under BIPA. They allege voiceprints were extracted
    from public audio (for example *Rogers v. Amazon*, No. 1:26-cv-05497, filed 12 May 2026):
    https://www.loevy.com/class-actions/artificial-intelligence/bipa-ai-class-action/.
    This is directly relevant to "no training on our data".
  - **Google Assistant.** *In re Google Assistant Privacy Litigation* is about false accepts and
    wiretapping, not BIPA. It settled for **$68M**, with a claims deadline of 27 August 2026:
    https://www.techrepublic.com/article/news-google-assistant-privacy-settlement-claims/.
  - **Apple Siri.** *Lopez v. Apple* is about false accepts and graders listening to recordings, not
    BIPA. It settled for **$95M**, given final approval on 16 October 2025:
    https://www.courthousenews.com/judge-approves-95-million-apple-settlement-over-siri-privacy-case/.
  - **McDonald's drive-through voice AI.** In *Carpenter v. McDonald's* (N.D. Ill. 2022), the
    §15(b) claim survived a motion to dismiss, and the §15(d) claim was dismissed. The case was
    voluntarily dismissed in July 2023:
    https://topclassactions.com/lawsuit-settlements/privacy/mcdonalds-denies-collecting-customers-biometric-data-at-drive-thrus/.
  - **The lesson.** The live litigation risk comes from **bystanders and guests**, and from notices
    that don't say "voiceprint" out loud.

### GDPR Art. 9 and UK GDPR

Sources: Regulation (EU) 2016/679, https://eur-lex.europa.eu/eli/reg/2016/679/oj; the UK Data
Protection Act 2018, https://www.legislation.gov.uk/ukpga/2018/12. The article numbers and recitals
below are standard GDPR provisions; their text was not re-fetched on 2026-09-26.

- **When voice becomes special-category data.**
  - A voice recording is ordinary personal data.
  - It becomes *biometric data* under Art. 4(14) when specific technical processing produces something
    that allows or confirms unique identification. An embedding is exactly that.
  - It becomes *special-category data* under Art. 9(1) when it is processed "for the purpose of
    uniquely identifying a natural person" (Recital 51).
  - Our speaker ID is 1:N identification, so Art. 9 applies. Plain STT does not trigger it on its own.
- **Lawful basis.**
  - **Explicit consent**, Art. 9(2)(a), freely given and withdrawable (Art. 7).
  - The ICO's biometric recognition guidance (February 2024) says explicit consent is **likely the only
    valid condition** for biometric recognition. It also says to **offer an alternative** so the choice
    is genuine: https://www.ropesgray.com/en/insights/viewpoints/102j5cq/ico-publishes-biometric-data-guidance
    and https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/biometric-data-guidance-biometric-recognition/.
  - As of 2026-09-26, the ICO says the guidance is **under review** because of the Data (Use and
    Access) Act 2025.
- **UK update.** The Data (Use and Access) Act 2025 received Royal Assent on **19 June 2025**. Most of
  its data-protection provisions came into force on **5 February 2026**.
  - It adds "children's higher protection matters" for services likely to be used by children:
    https://www.hunton.com/privacy-and-cybersecurity-law-blog/main-uk-data-use-and-access-act-provisions-enter-into-force.
- **DPIA, Art. 35.**
  - A DPIA is required **before** processing: this is new-technology processing of biometric
    special-category data, and it may include children. See WP248,
    https://ec.europa.eu/newsroom/article29/items/611236 (unverified this session).
- **The household exemption does not cover us.**
  - Art. 2(2)(c) exempts "purely personal or household activity".
  - **Recital 18** adds that the Regulation still applies to "controllers or processors which provide
    the means for processing personal data for such personal or household activities".
  - So the family is exempt, and **Bob, as the provider, is the controller** for the voiceprints it
    creates.
- **EDPB Guidelines 02/2021 on virtual voice assistants.**
  - Version 2.0 was adopted on **7 July 2021**:
    https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-022021-virtual-voice-assistants_en.
  - Voice used to identify users is biometric data and needs explicit consent. **Consent can only be
    obtained from registered users.** For people who are not registered, the assistant should **only
    execute commands**, not identify them:
    https://www.lexology.com/library/detail.aspx?g=9723c5e4-10c1-4f25-a540-a6702b01514d.
  - Controllers should reduce the capture of voices that aren't needed (background speakers), and
    process voice locally where possible:
    https://www.dataguidance.com/news/eu-edpb-publishes-final-guidelines-virtual-voice.
    The exact paragraph numbers were not checked, because the PDF did not parse on 2026-09-26
    **(unverified)**.
  - Every data subject, **including people who are not registered users**, must be able to exercise
    their rights: https://www.hunton.com/privacy-and-cybersecurity-law-blog/edpb-releases-guidelines-on-virtual-voice-assistants.
  - **(Unverified)** Two further points still need to be pinned in the PDF: that voice ID should be off
    by default, and the guidance on children.
  - **What we can't do.** Matching on the device is ruled out by our hardware. So the DPIA must justify
    server-side matching, using:
    - embeddings for unenrolled voices that exist only for the turn;
    - no storage of an unmatched voice;
    - matching scoped to a Space.
- **EU AI Act**, Regulation (EU) 2024/1689, https://eur-lex.europa.eu/eli/reg/2024/1689/oj.
  - **Definitions, Art. 3.** *Biometric identification* (1:N) is comparison "to biometric data of
    individuals stored in a database". **Annex III(1)(a)** makes remote biometric identification systems
    high-risk, but "shall not include AI systems intended to be used for biometric verification" (1:1):
    https://artificialintelligenceact.eu/annex/3/ and https://artificialintelligenceact.eu/article/3/.
  - **Our case.** Bob is 1:N **identification**, not verification. Whether it is "remote" is open.
    Household members who enrolled are actively involved; a guest or a TV voice matched passively is
    the weak point. **Question for counsel.**
  - **Emotion, age and gender.** #341 already excludes inferring them. Emotion recognition and
    biometric categorisation carry their own Annex III and Art. 50 duties, so keep them out.
  - **Dates, as of 2026-09-26.** The Digital Omnibus on AI:
    - was approved by Parliament on 16 June 2026;
    - was adopted by the Council on 29 June 2026;
    - came into force on **27 July 2026**.
    - It moves the Annex III high-risk deadline from 2 August 2026 to **2 December 2027**:
      https://usercentrics.com/knowledge-hub/eu-ai-act-high-risk-delay-article-50-transparency-consent/
      and https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/.
    - The Art. 50 transparency duties are unchanged.

### US states, as of 2026-09-26

- **Texas CUBI**, Tex. Bus. & Com. Code §503.001,
  https://texas.public.law/statutes/tex._bus._and_com._code_section_503.001.
  - The biometric identifiers include a **voiceprint**.
  - We must **inform the person and get their consent** before capturing one for a commercial purpose.
  - We must destroy it **within one year after the purpose for collecting it expires**.
  - Only the AG enforces it: up to **$25,000 per violation**.
  - **AG v. Meta** settled for **$1.4B** on 30 July 2024. It was the first CUBI settlement, over
    facial geometry ("tag suggestions"):
    https://www.texasattorneygeneral.gov/news/releases/attorney-general-ken-paxton-secures-14-billion-settlement-meta-over-its-unauthorized-capture
    and https://www.hunton.com/privacy-and-cybersecurity-law-blog/meta-settles-texas-biometric-data-lawsuit-for-record-1-4-billion.
  - **AG v. Google** alleged **voiceprints collected through Google Assistant**, Nest Hub Max and
    Google Photos.
    - It settled for **$1.375B** together with a location and incognito suit.
    - Announced 9 May 2025, and finalized 31 October 2025:
      https://www.texasattorneygeneral.gov/news/releases/attorney-general-ken-paxton-secures-historic-1375-billion-settlement-google-related-texans-data
      and https://natlawreview.com/article/google-agrees-1375-billion-settlement-texas-attorney-general-continues-data-privacy.
  - **TRAIGA**, HB 149, in force **1 January 2026**, adds CUBI exemptions for biometric data used to
    train or evaluate AI. That exemption does **not** apply where the system is used to uniquely
    identify a person, and our use does exactly that:
    https://www.insideprivacy.com/artificial-intelligence/texas-enacts-ai-consumer-protection-law/.
- **Washington RCW 19.375**, https://app.leg.wa.gov/rcw/default.aspx?cite=19.375.010.
  - A "biometric identifier" is data from automatic measurements of biological characteristics, such as
    a **voiceprint**, used to identify a person.
  - To "enroll" means to capture the identifier, convert it into a reference template that cannot be
    reconstructed into the original, and store it in a database linked to the person. **That is exactly
    our design.**
  - Enrolling for a commercial purpose needs one of these first: notice, consent, or a way to prevent
    later commercial use.
  - We may not use the data in ways materially inconsistent with the original terms.
  - A violation is an unfair practice under the Consumer Protection Act:
    https://law.justia.com/codes/washington/title-19/chapter-19-375/section-19-375-020/.
  - The "reasonably necessary" retention limit is **(unverified this session)**.
- **Washington My Health My Data Act**, RCW 19.373,
  https://app.leg.wa.gov/rcw/default.aspx?cite=19.373.010.
  - "Biometric data" is data from measuring physiological, biological or **behavioral** characteristics
    that identifies a consumer.
  - It is expressly one of the categories of **consumer health data**.
  - A "consumer" includes anyone whose data is collected **in Washington**.
  - In force from **31 March 2024** (30 June 2024 for small businesses).
  - It has a **private right of action**: actual damages, trebled up to $25,000. The AG can seek up to
    $7,500 per violation: https://www.goodwinlaw.com/en/insights/publications/2024/03/alerts-technology-hltc-my-health-my-data-act-mhmda
    and https://www.sidley.com/en/insights/newsupdates/2023/05/washington-state-enacts-my-health-my-data-act.
  - Separate consent to collect and to share, and a dedicated consumer health data privacy policy:
    reported by the sources above, but the statute text was **(unverified this session)**.
- **Colorado HB24-1130**, C.R.S. §6-1-1314, part of the Colorado Privacy Act.
  - Signed 31 May 2024, in force from **1 July 2025**: https://leg.colorado.gov/bills/hb24-1130.
  - Its biometric duties apply **regardless of the CPA's volume thresholds**: consent, notice, a
    published written policy, the retention schedule, and no sale.
  - We must destroy the data at the **earliest** of:
    - the purpose being fulfilled;
    - **24 months after the consumer last interacted** with us;
    - 45 days (extendable by 45 more) after an annual review finds it no longer necessary:
      https://captaincompliance.com/education/colorados-biometrics-privacy-rules/ and
      https://www.thompsonhine.com/insights/colorado-adds-biometric-data-requirements-to-privacy-law/.
  - **Minors.** SB24-041, in force **1 October 2025**, adds duties for under-18s, again without the
    thresholds. A data protection assessment is required for any heightened risk to minors. There is
    no private right of action:
    https://www.lowenstein.com/news-insights/publications/client-alerts/colorado-tightens-rules-on-minors-online-data-are-you-ready-for-october-1-data-privacy.
- **CCPA/CPRA**, Cal. Civ. Code §1798.100 et seq.
  - Processing biometric information to uniquely identify a consumer is "sensitive personal
    information", and consumers have the right to limit its use. This is standard CCPA text, not
    re-fetched on 2026-09-26.
  - **New from 1 January 2026.** Regulations approved on 23 September 2025 bring in:
    - **risk assessments before processing sensitive personal information**, with summary submissions
      due by 1 April 2028;
    - a definition of sensitive personal information that now includes **all personal information of
      consumers the business knows are under 16**:
      https://cppa.ca.gov/announcements/2025/20250923.html and
      https://www.insideprivacy.com/state-privacy/california-finalizes-updates-to-existing-ccpa-regulations/.
  - **Thresholds.** From 1 January 2025 the revenue threshold is **$26,625,000**; the alternatives are
    100k+ California consumers, or half of revenue from selling or sharing data:
    https://www.cppa.ca.gov/regulations/cpi_adjustment.html.
    Bob is probably below all three today. Build to CCPA anyway.
- **Comprehensive state privacy laws.** Most of them treat biometric data as sensitive and require
  opt-in consent.
  - **2025:** Delaware, Iowa, Nebraska and New Hampshire (1 January); New Jersey (15 January);
    Tennessee (1 July); Minnesota (31 July):
    https://www.duanemorris.com/alerts/eight_new_state_privacy_laws_take_effect_2025_are_you_ready_1224.html.
  - **Maryland MODPA** (1 October 2025) allows sensitive data only when **strictly necessary** for the
    requested service, and **bans its sale even with consent**:
    https://www.multistate.us/insider/2026/2/4/all-of-the-comprehensive-privacy-laws-that-take-effect-in-2026.
  - **2026:** Indiana, Kentucky and Rhode Island (1 January):
    https://www.koleyjessen.com/insights/publications/new-state-privacy-laws-effective-january-1-2026-indiana-kentucky-and-rhode-island.
- **New dedicated biometric statutes, as of 2026-09-26.**
  - None were found. Illinois, Texas and Washington are still the only three states with a dedicated
    biometric statute.
  - BIPA-style bills are pending: New York S.B. 1422, Missouri S.B. 554, Michigan S.B. 359:
    https://www.recordinglaw.com/us-laws/data-privacy-laws/biometric-privacy-laws/.

## Children

- **COPPA: the amended rule**, 16 C.F.R. Part 312, as of 2026-09-26.
  - **Dates.** Published **22 April 2025**, effective **23 June 2025**, with a **compliance date of
    22 April 2026**. It is fully enforceable now, at more than $53,000 per violation:
    https://www.privacyanddatasecurityinsight.com/2026/04/enforcement-begins-soon-for-significant-coppa-rule-amendments/.
  - **Primary text.** https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule,
    which was behind a bot wall on 2026-09-26.
  - **Voiceprints are personal information.** The rule now covers "biometric identifiers" such as
    fingerprints, retina patterns, face templates and **voiceprints**:
    https://www.finnegan.com/en/insights/articles/the-ftcs-updated-coppa-rule-redefining-childrens-digital-privacy-protection.html.
  - **When it applies.** COPPA applies to services directed to children, or where we have **actual
    knowledge** that a user is under 13. A parent creating a child profile gives us that knowledge.
    This is a standard COPPA reading; counsel should confirm it.
  - **Retention.** We need a **written data retention policy** and may not keep data indefinitely:
    https://compliancehub.wiki/coppa-april-22-deadline-ftc-updated-rule-compliance/.
    The exact §312.10 wording is **(unverified)**.
  - **Third parties.** Separate verifiable parental consent (VPC) is needed to disclose to third
    parties. That is reported by the sources above, but the wording and the carve-out for disclosures
    "integral" to the service are **(unverified)**.
  - **The audio-file exception, §312.5(c)(9).**
    - We may collect a child's voice without VPC only when it is used **solely as a replacement for
      written words** to answer the child's request.
    - It must be **deleted immediately**, never used for anything else, and never disclosed. It must
      also be described in the privacy notice:
      https://www.finnegan.com/en/insights/articles/the-ftcs-updated-coppa-rule-redefining-childrens-digital-privacy-protection.html.
    - That covers our STT path. It **does not** cover speaker ID, which is a different purpose.
- **FTC v. Amazon (Alexa), 2023.**
  - Charged on 31 May 2023, with a **$25M civil penalty**:
    https://www.ftc.gov/news-events/news/press-releases/2023/05/ftc-doj-charge-amazon-violating-childrens-privacy-law-keeping-kids-alexa-voice-recordings-forever.
  - **Alleged.**
    - Amazon kept children's voice recordings **indefinitely**.
    - It kept **transcripts** after parents asked for deletion.
    - It used the retained recordings "to help improve its Alexa algorithm".
  - **Ordered.**
    - Delete inactive child accounts, and certain voice and geolocation data.
    - **Do not use** voice information that is subject to a deletion request "for the creation or
      improvement of any data product".
    - Tell users about its retention and deletion practices.
    - Run a privacy program.
  - **Lesson for us.** Deletion must cascade to **every derived artifact**: embeddings, logs,
    evaluation fixtures and vendor copies.
- **GDPR Art. 8.**
  - For information society services relying on consent, a child can consent from **16**. Member
    states may lower this to 13. Below that age, a **holder of parental responsibility** consents, and
    we must make reasonable efforts to verify it.
  - The UK age is **13** (DPA 2018 s.9).
  - These are the standard provisions; they were not re-fetched on 2026-09-26.
- **UK Age Appropriate Design Code (the Children's code).**
  - It has applied from **2 September 2021** to services **likely to be accessed** by under-18s, and it
    includes a standard on **connected toys and devices**:
    https://techcrunch.com/2021/09/01/uk-now-expects-compliance-with-its-child-privacy-design-code/.
  - It sets 15 standards, including:
    - best interests;
    - a DPIA;
    - **high-privacy defaults**;
    - data minimisation;
    - **profiling off by default**;
    - no nudge techniques;
    - parental controls.
    Guidance: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/.
  - From 5 February 2026, the DUAA also adds "children's higher protection matters" (see *GDPR*).
- **Acceptable verifiable parental consent when a parent account holder enrols a child**
  (https://blog.promise.legal/coppa-verified-parental-consent-methods/, with the FTC overview at
  https://www.ftc.gov/business-guidance/privacy-security/verifiable-parental-consent-childrens-online-privacy-rule).
  - The accepted methods:
    - a signed form;
    - a **credit or debit card transaction** that notifies the account holder;
    - a toll-free call or video call with trained staff;
    - a **government ID plus a face match**, with both deleted afterwards;
    - **knowledge-based challenge questions**;
    - **"text plus"**, new in 2025;
    - "email plus", which is limited to internal uses.
  - **Recommendation.** Use a card transaction or KBA, done by the signed-in parent on the web (#355)
    and recorded as a VPC event.
    - Being signed in to an account is **not** VPC on its own.
    - Whether a **$0 authorisation** counts as a "transaction" is **(unverified)**; ask counsel.
  - **Precedent.** Amazon asks for **parental consent** during Alexa child Voice ID setup, for up to
    four children: https://www.amazon.com/gp/help/customer/display.html?nodeId=G3UFSS8YLN4P59KD
    (search snippet; the page returned HTTP 503).
  - **Simplest compliant launch.** **No child voiceprints at launch.**
    - Apple itself notes HomePod "can have trouble distinguishing some voices, like those of young
      children" (see *Industry precedents*).

## Using a vendor

- **Roles.**
  - A managed speaker-ID vendor must be our **processor** under GDPR Art. 28, and our **service
    provider** under the CCPA. It must never be an independent controller.
  - The DPA needs the Art. 28(3) terms:
    - process only on our instructions;
    - confidentiality;
    - security;
    - sub-processors only with our approval;
    - help with data-subject rights and the DPIA;
    - **delete or return the data at the end**;
    - audits.
  - These are standard GDPR terms, not re-fetched on 2026-09-26.
- **BIPA sees it differently.**
  - BIPA has no processor exception, and the 2024 amendment extended the one-recovery rule to §15(d)
    disclosures (see above).
  - **Sending audio for the vendor to create a voiceprint is a disclosure.** It needs the person's
    consent.
  - The vendor may also be sued directly. The May 2026 Loevy suits target platform vendors such as
    ElevenLabs, Microsoft and NVIDIA.
  - The consent text must therefore **name the vendor category and the purpose**. The contract should
    include BIPA warranties and an indemnity.
- **Voiceprints stored at the vendor.**
  - **Prefer a stateless design.** The vendor returns an embedding, or a score against vectors we
    send. It keeps no profile, and it deletes the audio as soon as it responds.
  - Our Postgres then holds the only copy, under our RLS and deletion cascade. The 24-hour SLA, export
    and expiry are enforced in **our** code.
  - If the vendor must hold profiles, deletion has to call its delete API within our SLA and log the
    call, with no biometric content in the log.
- **Market facts for #352, as of 2026-09-26: managed speaker ID from the big clouds is disappearing.**
  - **Azure AI Speaker Recognition was retired on 30 September 2025**, and Microsoft points users to
    diarization instead: https://www.azalio.io/retirement-azure-ai-speaker-recognition/ and
    https://picovoice.ai/blog/microsoft-azure-ai-speaker-recognition-alternatives/.
  - **Amazon Connect Voice ID** stopped taking new customers on 20 May 2025 and **ended support on
    20 May 2026**. AWS recommended Pindrop:
    https://docs.aws.amazon.com/connect/latest/adminguide/amazonconnect-voiceid-end-of-support.html and
    https://www.biometricupdate.com/202506/amazon-to-end-support-for-voice-biometrics-recommends-pindrop.
  - The practical choices are therefore narrower: a specialist vendor, a stateless embedding API, or
    self-hosting a model. #352 decides.
- **Cross-border transfer.**
  - For EU and UK users, sending audio to a US vendor is a Chapter V transfer.
  - It can rely on the **EU-US Data Privacy Framework** (adequacy decision of 10 July 2023) if the vendor
    is certified, https://www.dataprivacyframework.gov/list. The UK Extension, or data bridge, has been
    in force since **12 October 2023**:
    https://www.insideprivacy.com/eu-u-s-data-privacy-framework/european-commission-adopts-adequacy-decision-on-the-eu-u-s-data-privacy-framework/
    and https://www.kennedyslaw.com/en/thought-leadership/article/2023/uk-us-data-bridge-takes-effect-today-12-october-2023/.
  - **The DPF is under appeal.** The General Court upheld it on 3 September 2025 (*Latombe*, T-553/23).
    Latombe appealed on 31 October 2025 (C-703/25 P), and the appeal is pending as of 2026-09-26:
    https://edpl.lexxion.eu/article/EDPL/2026/1/15. So the DPA should also include **SCCs** as a
    fallback.
  - The same question already applies to **our existing STT audio**, sent to Fish Audio through the
    Vercel AI Gateway (see *Findings outside owns*).
- **No training on our data.**
  - The DPA must forbid using audio, embeddings or metadata to train or improve any model, including
    "de-identified" data.
  - The reasons:
    - BIPA §15(c) bans profiting from biometrics;
    - the FTC v. Amazon order banned using deleted voice data for "any data product";
    - the May 2026 BIPA suits are about training on voiceprints;
    - Maryland requires sensitive data to be strictly necessary.
  - The DPA must also require:
    - zero retention of audio;
    - no human review;
    - breach notice within 72 hours or less;
    - a sub-processor list;
    - EU processing for EU users, if we launch there.

## Industry precedents

As of 2026-09-26.

- **Amazon Alexa Voice ID.** Help: "What Is Alexa Voice ID?",
  https://www.amazon.com/gp/help/customer/display.html?nodeId=GYCXKY2AB2QWZT2X, and
  "Delete an Alexa Voice ID", https://www.amazon.com/gp/help/customer/display.html?nodeId=GVGTM57CWHHHFMY6.
  Both returned HTTP 503; the details below come from search snippets and press.
  - **Enrolment.** Each person enrols in the Alexa app. Child voice IDs are set up by a parent through
    Amazon Kids, and **parental consent is required**:
    https://www.amazon.com/gp/help/customer/display.html?nodeId=G3UFSS8YLN4P59KD.
  - **Retention is tied to recordings.** Voice ID depends on stored recordings. Deleting them, including
    through auto-delete after 3 or 18 months, may stop Voice ID working or delete it:
    https://www.amazon.com/gp/help/customer/display.html?nodeId=G68KUKTXN92WY3C3.
    My earlier claim that Voice IDs unused for "3 years" are deleted is **(unverified)** and has been
    removed.
  - **March 2025.** From **28 March 2025**, "Do Not Send Voice Recordings" was removed, and users of
    "Don't Save Recordings" **lost Voice ID**:
    https://www.theregister.com/2025/03/17/amazon_kills_on_device_alexa/ and
    https://www.malwarebytes.com/blog/news/2025/03/amazon-disables-option-to-store-echo-voice-recordings-on-your-device.
    Bob must never tie voice ID to keeping audio.
  - **In court.** Amazon's Voice ID notice was held inadequate under BIPA in *Wilcosky/Gunderson*,
    now a certified class.
- **Google Voice Match.** Help: https://support.google.com/assistant/answer/9071681.
  - **Where the model lives.** The voice model "is created on Google's servers and then stored only on
    the devices where you've turned on Voice Match".
  - **Server-side matching is transient.** On a query, the device "sends the voice model to Google to
    process the query and determine if it's you … Google deletes the voice model and comparison data
    immediately after the process."
  - **Deletion.** Remove Voice Match from one home, or from all devices.
  - **Children.** A parent adds a child under 13 through **Family Link**, and the parent must be a
    member of the home. Removing the model from a device does **not** delete the enrolment clips; the
    parent has to delete those separately at g.co/assistant/match:
    https://support.google.com/families/answer/9071584?hl=en.
  - **For us.** This is the closest model to our constraints: transient server-side comparison. The
    lesson is to **never keep enrolment clips**.
- **Apple Siri "Recognize My Voice" / Personal Requests on HomePod.**
  Help: https://support.apple.com/en-us/108397.
  - **Enrolment.** Each user enables it themselves on their **own iPhone or iPad with their own Apple
    Account**. The owner cannot enrol another adult.
  - **Limit.** Up to **six users** per home.
  - **Children.** Family members, children included, enable it on their own devices. Apple notes HomePod
    may struggle with young children's voices, and "whenever HomePod isn't sure, it will ask who's
    speaking" (reported by https://www.idownloadblog.com/2024/04/05/homepod-voice-recognition-personal-requests/;
    the Apple wording is **(unverified)**).
  - **Processing and storage.** Personalised recognition runs **on the device**. Setup audio syncs with
    **end-to-end encryption**. Apple stores no Siri audio unless the user opts in to "Improve Siri &
    Dictation", in which case it may keep it for up to two years:
    https://www.apple.com/legal/privacy/data/en/ask-siri-dictation/.
- **Patterns to copy.**
  - Each person enrols themselves.
  - Off by default.
  - A match is never a password.
  - Self-service deletion that also covers **enrolment clips**.
  - Children only through a parent-controlled flow with explicit parental consent.
  - Keep templates on the device where possible. Where not, as for us, compare transiently as Google
    does.

## Requirements mapped to law

| # | Requirement | Law(s) | How to enforce it in code | Owner |
|---|---|---|---|---|
| R1 | **Consent record before any embedding exists.** Fields: `profile_id`, `subject_kind` (adult / guest / child), `consent_text_version`, `consent_text_sha256`, `locale`, `purpose` (`speaker_identification`), `retention_months`, `signer_user_id` or guest signer contact, `signer_typed_name`, `signed_at` (UTC), `method` (`web_esign` / `vpc_card` / `vpc_kba`), `vendor_disclosed` (the category), `jurisdiction_at_consent`, `withdrawn_at` | BIPA §15(b), as amended by PA 103-0769 (e-signature); GDPR Art. 7, 9(2)(a); CUBI; CO §6-1-1314; RCW 19.375; COPPA VPC | A `voice_consents` table. The embedding row has a `NOT NULL` FK to an active consent, checked by a trigger. There is no insert path without it. RLS: only the signer, the parent or the Space owner can read it. | #354 |
| R2 | **Explicit, per-person opt-in, off by default.** Adults and guests sign themselves, and the owner can't sign for another adult. The notice must say "voiceprint" and "biometric" in plain words. | BIPA §15(b) (*Wilcosky*); GDPR Art. 9, 25; EDPB 02/2021 (registered users only); ICO (offer an alternative); AADC defaults | The enrolment UI requires the subject's own e-signature. Guests sign on their own phone through a short-lived link or QR code. Voice ID stays off in a Space until one consent exists. | #355 |
| R3 | **The Cardputer doesn't complete consent.** | BIPA written release; COPPA VPC | "Learn my voice" hands off to a web link. Phrases are accepted only after a consent row exists. | #359 |
| R4 | **Retention: expire after 12 months without a match**, and hold the written schedule before the first enrolment. | CUBI (1 year after the purpose expires); CO (24 months after the last interaction); BIPA §15(a) (3 years, and a policy on possession); COPPA written retention policy | A `last_matched_at` column, and a daily job that hard-deletes expired profiles. The deletion count is a metric, with no identities. | #362 |
| R5 | **Deletion SLA: at most 24 hours**, from the person or the owner, and at the vendor too. | GDPR Art. 17; CCPA delete; MHMDA; FTC v. Amazon; BIPA §15(a) | Delete synchronously in the request, with retries for the vendor call. A test asserts the rows are gone and the next turn is `unknown`. | #355, #362 |
| R6 | **Cascade.** Leaving a Space, closing the account, withdrawing consent or removing a guest deletes the embeddings, any enrolment audio (never stored), and evaluation fixtures. Only a tombstone is kept. | FTC v. Amazon (transcripts kept after deletion); Google's lesson on enrolment clips; GDPR Art. 17 | `ON DELETE CASCADE` from the profile, and membership removal triggers deletion. The tombstone is `{profile_id, deleted_at, reason}`. | #354 |
| R7 | **Export what we hold.** Consent records, profile metadata and dates. Whether to export the vector itself is decided by counsel (Q11). | GDPR Art. 15, 20; CCPA right to know; CO right of access | An export endpoint scoped to the signed-in subject or parent. It never appears in logs. | #355 |
| R8 | **No secondary use.** No training, no evaluation on production vectors, no sale, no profiling, no inference of emotion, age or gender, and no clustering of unknown voices. | BIPA §15(c); FTC v. Amazon; MD MODPA; CCPA/CPPA risk-assessment regs; AI Act Annex III | One read path: the match function. #361 uses only consented fixtures. A privacy test and a review rule enforce it. | #356, #362 |
| R9 | **Unenrolled speakers leave no trace.** The turn embedding is computed in memory, compared, and dropped in the same turn, like `pcm` (`turn.ts:918-922`). Skip identification in any Space with no consents. | BIPA §15(b) (the bystander holding in *Wilcosky*); EDPB (non-registered users: execute commands only); GDPR Art. 5(1)(c) | The embedding lives only as a local variable in `processTurn`. A test asserts that no DB write, log line or trace carries it. | #356, #362 |
| R10 | **No raw audio stored**, by us or the vendor. | COPPA §312.5(c)(9); FTC v. Amazon; EDPB | Audio is already held in memory only. The vendor DPA requires zero retention. A privacy test covers the buckets and columns. | #356 |
| R11 | **Geo gating.** Only regions counsel has approved. No child profiles until VPC ships. | All; AI Act (Annex III from 2 December 2027); AADC; MHMDA | Record the region at consent. A server-side allow-list, since there is no flag table. The UI hides voice ID where it isn't allowed. | #355, #356 |
| R12 | **Public biometric retention policy**, plus a consumer-health-data policy. | BIPA §15(a); CO §6-1-1314; MHMDA; COPPA notice | Policy text versioned in the repo and linked at enrolment. `consent_text_version` records which version was shown. | #355 |
| R13 | **Observability without biometric leakage.** | GDPR Art. 5(1)(f), 32; BIPA §15(e) | Aggregate counts only. No score is ever paired with a profile (#362 rules). | #362 |
| R14 | **Security.** Encryption at rest, RLS, and the service role used only in the match path. | BIPA §15(e); GDPR Art. 32; COPPA security program | RLS tests: anonymous and other-Space reads fail. | #354 |

## Proposed defaults

Build to the strictest regime everywhere: BIPA, GDPR Art. 9, COPPA, CUBI and Colorado.

1. **Voice ID is off** until the first person opts in, and Bob works fully without it.
2. **Every adult, guests included, signs their own electronic release on the web.**
   - The owner can invite, but never consent for, another adult.
   - The Cardputer only hands off to the web.
3. **Children: none at launch.** Once counsel approves, a child profile needs:
   - a parent signed in on the web;
   - VPC by card transaction or KBA;
   - the parent-for-child consent text below.
   It has a **6-month** inactivity expiry.
4. **Retention.** Delete after **12 months without a match**, which meets CUBI's one-year rule and is
   inside Colorado's 24 months and BIPA's 3 years. The written schedule is published **before** the
   first enrolment (*Mora*).
5. **Deletion SLA of 24 hours**, and it cascades on leaving a Space, closing the account or withdrawing
   consent.
6. **Only vectors are stored, and only by us.**
   - A vendor may compute embeddings statelessly, with zero retention, no training, no human review,
     and DPF or SCC coverage.
   - A vendor-held profile store is a fallback, and it needs the owner's approval.
7. **Unknown voices are embedded only in memory and dropped in the same turn.** Spaces with no
   consents skip identification entirely.
8. **Geography.**
   - The owner's household first.
   - Then US states counsel approves.
   - **Illinois last among the US states**, given the certified 1.18M-member Alexa Voice ID class and
     the bystander holding.
   - EU/UK waits for a DPIA and counsel's view on the AI Act. Annex III applies from 2 December 2027.
9. **Nothing beyond identification.** No emotion, age or gender inference, and no clustering.

## Draft consent text

Versioned as `voice-consent/<kind>/v1`, dated 2026-09-26. Store the SHA-256 of the exact text shown.
Following *Wilcosky*, each version says "voiceprint" and "biometric identifier" in plain words.

**Adult (`voice-consent/adult/v1`)**
> Bob can learn to recognise your voice so it can answer you personally, with your reminders,
> tasks and memories. To do this, we create and store a **voiceprint of your voice. A voiceprint is a
> biometric identifier.**
> - **Purpose:** only to recognise who is speaking to Bob in your household. It is never used as a
>   password, never sold, and never used to train AI models.
> - **What we keep:** the voiceprint only. We never store recordings of your voice.
> - **Who processes it:** Bob, and our speech-processing provider, which acts only on our
>   instructions and keeps nothing.
> - **How long:** until you delete it, leave the household or close your account, or after 12 months
>   in which Bob hasn't recognised you, whichever comes first. We delete it within 24 hours.
>   Our retention policy: {link}.
> - **Your choice:** Bob works without this. You can delete your voiceprint at any time in
>   Settings → Voices.
>
> ☐ I agree to Bob collecting, storing and using my voiceprint as described. Type your full name
> to sign: ____

**Guest (`voice-consent/guest/v1`)**, signed on the guest's own device, through a link from the owner
> **{Owner name}** has invited you to let their Bob recognise your voice in their household. You
> don't need an Bob account, and saying no changes nothing about how Bob talks to you.
> If you agree, we create and store a **voiceprint, a biometric identifier**, of your voice. We never
> keep recordings. It is used only to recognise you in {Owner name}'s household. It is never used as
> a password, never sold, and never used to train AI models. Our speech-processing provider handles it
> for us and keeps nothing.
> We delete it within 24 hours when you ask (using the link in your confirmation), when {Owner name}
> removes you, or after 12 months in which Bob hasn't recognised you.
>
> ☐ I agree, and I am 18 or older. Type your full name to sign: ____

**Parent for a child (`voice-consent/child/v1`)**, available only after parental verification
> You are giving consent as the parent or legal guardian of **{child name}**. Bob will create and
> store a **voiceprint of your child's voice. A voiceprint is a biometric identifier.** It lets Bob
> answer your child as themselves: their reminders, their games, their name.
> - We never store recordings of your child's voice.
> - We never use the voiceprint for advertising, profiling or AI training.
> - We never share it, except with our speech-processing provider, which acts only on our instructions
>   and keeps nothing.
> - Bob does not guess your child's age, mood or gender from their voice.
> - We delete it within 24 hours when you ask, when you remove the profile, or after 6 months in which
>   Bob hasn't recognised your child.
> - You can review or delete your child's data at any time in Settings → Voices.
> - Your child can use Bob without this.
>
> We verified that you are a parent by {method} on {date}.
> ☐ I am the parent or legal guardian of {child name}, and I consent. Type your full name to sign: ____

## Questions for counsel

1. **Bystanders.** *Wilcosky* lets a non-user who spoke near a device sue. Is an in-memory embedding
   of an unenrolled voice, compared and discarded within the same turn, a "collection" under BIPA
   §15(b)? What mitigation is enough? The EDPB says to only execute commands for people who aren't
   registered.
2. **Embeddings.** Is a neural speaker embedding a "voiceprint" or "biometric information"? Does
   quantising or encrypting it change anything?
3. **Guest releases.** Is a checkbox plus a typed name on the guest's own phone a valid BIPA release
   after PA 103-0769? Could a **spoken** "yes", which is an "electronic sound", ever qualify?
4. **The vendor.** Does sending audio to a stateless embedding vendor need a specific §15(d)
   disclosure consent? Under COPPA, is the vendor "integral", so that no separate VPC is needed?
5. **AI Act.** Is 1:N identification among at most 6 enrolled household members a "remote biometric
   identification system" under Annex III(1)(a)? It applies from 2 December 2027.
6. **Children.** Is a $0 card authorisation or KBA enough VPC for a signed-in parent? Do COPPA's
   written-retention-policy and security-program duties need their own published documents?
7. **Retention.** Does "12 months without a match" meet CUBI's "one year after the purpose expires"?
8. **Thresholds.** Which laws apply to a pre-revenue product with one household and its guests? BIPA,
   CUBI, RCW 19.375, MHMDA and Colorado §6-1-1314 have no size threshold.
9. **Transfers.** Is our existing STT flow (Fish Audio through the Vercel AI Gateway) already a Chapter
   V transfer that needs the DPF or SCCs? The DPF appeal C-703/25 P is pending.
10. **Wording.** Does the draft consent text satisfy BIPA's "specific purpose and length of term" as
    read in *Wilcosky*, and GDPR's "explicit" standard?
11. **Export.** Should an access request export the raw vector, or a description of it?

## Sources

All accessed on 2026-09-26 unless marked (unverified).

**Illinois BIPA**
- BIPA statute (primary; the page failed its TLS check on this date): https://www.ilga.gov/legislation/ilcs/ilcs3.asp?ActID=3004&ChapterID=57
- §15(a) and *Mora*: https://www.thompsoncoburn.com/insights/illinois-appeals-court-holds-that-bipa-section-15a-requires-retention-and-destruction-policies-upon-possession-of-any-biometric-data/
- SB 2979 / PA 103-0769: https://www.bytebacklaw.com/2024/08/bipa-amendment-bill-signed-into-law/ and https://legiscan.com/IL/text/SB2979/id/2999068
- *Clay v. Union Pacific* (7th Cir., 1 April 2026): https://law.justia.com/cases/federal/appellate-courts/ca7/25-2185/25-2185-2026-04-01.html
- *Tims*: https://www.privacyworld.blog/2023/02/breaking-illinois-supreme-court-sets-five-year-statute-of-limitations-for-all-bipa-claims/
- *Rosenbach*, 2019 IL 123186 (unverified URL): https://www.illinoiscourts.gov/Opinions/SupremeCourt/2019/123186.pdf
- *Martell v. X Corp.*: https://www.insideprivacy.com/privacy-and-data-security/illinois-federal-court-dismisses-bipa-suit-against-x-holding-biometric-identifiers-must-identify-individuals/
- *Rivera v. Google*: https://natlawreview.com/article/court-refuses-to-dismiss-biometric-privacy-action-over-facial-recognition-technology and https://blog.ericgoldman.org/archives/2018/12/google-photos-defeats-privacy-lawsuit-over-face-scans-rivera-v-google.htm
- *Wilcosky/Gunderson v. Amazon*: https://blogs.duanemorris.com/classactiondefense/2023/11/04/illinois-federal-court-allows-amazon-alexa-privacy-class-action-to-proceed/ and https://blogs.duanemorris.com/classactiondefense/2025/11/26/the-class-action-weekly-wire-episode-128-illinois-federal-judge-certifies-class-of-1-2-million-amazon-alexa-users-in-bipa-class-action/ and https://openclassactions.com/settlements/amazon-alexa-voice-id-bipa-class-action.php
- May 2026 voiceprint AI suits: https://www.loevy.com/class-actions/artificial-intelligence/bipa-ai-class-action/
- Google Assistant settlement: https://www.techrepublic.com/article/news-google-assistant-privacy-settlement-claims/
- *Lopez v. Apple*: https://www.courthousenews.com/judge-approves-95-million-apple-settlement-over-siri-privacy-case/
- *Carpenter v. McDonald's*: https://topclassactions.com/lawsuit-settlements/privacy/mcdonalds-denies-collecting-customers-biometric-data-at-drive-thrus/

**EU and UK**
- GDPR: https://eur-lex.europa.eu/eli/reg/2016/679/oj
- UK DPA 2018: https://www.legislation.gov.uk/ukpga/2018/12
- ICO biometric guidance: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/biometric-data-guidance-biometric-recognition/ and https://www.ropesgray.com/en/insights/viewpoints/102j5cq/ico-publishes-biometric-data-guidance
- DUAA 2025: https://www.hunton.com/privacy-and-cybersecurity-law-blog/main-uk-data-use-and-access-act-provisions-enter-into-force
- WP248 on DPIAs (unverified): https://ec.europa.eu/newsroom/article29/items/611236
- EDPB 02/2021: https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-022021-virtual-voice-assistants_en and https://www.lexology.com/library/detail.aspx?g=9723c5e4-10c1-4f25-a540-a6702b01514d and https://www.dataguidance.com/news/eu-edpb-publishes-final-guidelines-virtual-voice and https://www.hunton.com/privacy-and-cybersecurity-law-blog/edpb-releases-guidelines-on-virtual-voice-assistants
- AI Act: https://eur-lex.europa.eu/eli/reg/2024/1689/oj and https://artificialintelligenceact.eu/annex/3/ and https://artificialintelligenceact.eu/article/3/
- Digital Omnibus on AI: https://usercentrics.com/knowledge-hub/eu-ai-act-high-risk-delay-article-50-transparency-consent/ and https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/
- ICO Children's code: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/ and https://techcrunch.com/2021/09/01/uk-now-expects-compliance-with-its-child-privacy-design-code/
- DPF: https://www.dataprivacyframework.gov/list and https://www.insideprivacy.com/eu-u-s-data-privacy-framework/european-commission-adopts-adequacy-decision-on-the-eu-u-s-data-privacy-framework/
- UK data bridge: https://www.kennedyslaw.com/en/thought-leadership/article/2023/uk-us-data-bridge-takes-effect-today-12-october-2023/
- *Latombe*: https://edpl.lexxion.eu/article/EDPL/2026/1/15

**US states**
- Texas CUBI: https://texas.public.law/statutes/tex._bus._and_com._code_section_503.001
- Texas AG v. Meta: https://www.texasattorneygeneral.gov/news/releases/attorney-general-ken-paxton-secures-14-billion-settlement-meta-over-its-unauthorized-capture and https://www.hunton.com/privacy-and-cybersecurity-law-blog/meta-settles-texas-biometric-data-lawsuit-for-record-1-4-billion
- Texas AG v. Google: https://www.texasattorneygeneral.gov/news/releases/attorney-general-ken-paxton-secures-historic-1375-billion-settlement-google-related-texans-data and https://natlawreview.com/article/google-agrees-1375-billion-settlement-texas-attorney-general-continues-data-privacy
- TRAIGA: https://www.insideprivacy.com/artificial-intelligence/texas-enacts-ai-consumer-protection-law/
- Washington biometric law: https://app.leg.wa.gov/rcw/default.aspx?cite=19.375.010 and https://law.justia.com/codes/washington/title-19/chapter-19-375/section-19-375-020/
- MHMDA: https://app.leg.wa.gov/rcw/default.aspx?cite=19.373.010 and https://www.goodwinlaw.com/en/insights/publications/2024/03/alerts-technology-hltc-my-health-my-data-act-mhmda and https://www.sidley.com/en/insights/newsupdates/2023/05/washington-state-enacts-my-health-my-data-act
- Colorado: https://leg.colorado.gov/bills/hb24-1130 and https://captaincompliance.com/education/colorados-biometrics-privacy-rules/ and https://www.thompsonhine.com/insights/colorado-adds-biometric-data-requirements-to-privacy-law/ and https://www.lowenstein.com/news-insights/publications/client-alerts/colorado-tightens-rules-on-minors-online-data-are-you-ready-for-october-1-data-privacy
- CCPA: https://cppa.ca.gov/announcements/2025/20250923.html and https://www.insideprivacy.com/state-privacy/california-finalizes-updates-to-existing-ccpa-regulations/ and https://www.cppa.ca.gov/regulations/cpi_adjustment.html
- State comprehensive laws: https://www.duanemorris.com/alerts/eight_new_state_privacy_laws_take_effect_2025_are_you_ready_1224.html and https://www.multistate.us/insider/2026/2/4/all-of-the-comprehensive-privacy-laws-that-take-effect-in-2026 and https://www.koleyjessen.com/insights/publications/new-state-privacy-laws-effective-january-1-2026-indiana-kentucky-and-rhode-island
- Pending biometric bills: https://www.recordinglaw.com/us-laws/data-privacy-laws/biometric-privacy-laws/

**Children**
- COPPA rule (primary; bot wall on this date): https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule
- COPPA summaries: https://www.finnegan.com/en/insights/articles/the-ftcs-updated-coppa-rule-redefining-childrens-digital-privacy-protection.html and https://www.privacyanddatasecurityinsight.com/2026/04/enforcement-begins-soon-for-significant-coppa-rule-amendments/ and https://compliancehub.wiki/coppa-april-22-deadline-ftc-updated-rule-compliance/
- VPC methods: https://blog.promise.legal/coppa-verified-parental-consent-methods/ and https://www.ftc.gov/business-guidance/privacy-security/verifiable-parental-consent-childrens-online-privacy-rule
- FTC v. Amazon: https://www.ftc.gov/news-events/news/press-releases/2023/05/ftc-doj-charge-amazon-violating-childrens-privacy-law-keeping-kids-alexa-voice-recordings-forever

**Vendors and precedents**
- Azure Speaker Recognition retirement: https://www.azalio.io/retirement-azure-ai-speaker-recognition/ and https://picovoice.ai/blog/microsoft-azure-ai-speaker-recognition-alternatives/
- Amazon Connect Voice ID end of support: https://docs.aws.amazon.com/connect/latest/adminguide/amazonconnect-voiceid-end-of-support.html and https://www.biometricupdate.com/202506/amazon-to-end-support-for-voice-biometrics-recommends-pindrop
- Alexa help pages (HTTP 503 on this date): https://www.amazon.com/gp/help/customer/display.html?nodeId=GYCXKY2AB2QWZT2X and https://www.amazon.com/gp/help/customer/display.html?nodeId=GVGTM57CWHHHFMY6 and https://www.amazon.com/gp/help/customer/display.html?nodeId=G3UFSS8YLN4P59KD and https://www.amazon.com/gp/help/customer/display.html?nodeId=G68KUKTXN92WY3C3
- Alexa, March 2025 change: https://www.theregister.com/2025/03/17/amazon_kills_on_device_alexa/ and https://www.malwarebytes.com/blog/news/2025/03/amazon-disables-option-to-store-echo-voice-recordings-on-your-device
- Google Voice Match: https://support.google.com/assistant/answer/9071681 and https://support.google.com/families/answer/9071584?hl=en
- Apple: https://support.apple.com/en-us/108397 and https://www.apple.com/legal/privacy/data/en/ask-siri-dictation/ and https://www.idownloadblog.com/2024/04/05/homepod-voice-recognition-personal-requests/
