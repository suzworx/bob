# Voice ID enrollment, low-confidence behaviour and game turn-taking: research

Task VID-UX, 2026-09-26, HEAD 9d6655d. Feeds epics #341 (voice ID) and #342 (voice games), and
issues #355, #356, #357, #359 and #363.

> **Evidence status (read first).** External claims were checked with web search and fetch on
> 2026-09-26, and the source URL sits next to each claim. Anything still marked **(unverified)**
> could not be confirmed. For example, several amazon.com help pages returned HTTP 503 when
> fetched. Where a claim rests on a search-result snippet rather than a fetched page, it says
> "(search snippet)". Facts about our own code were re-checked at HEAD 9d6655d and carry a
> `path:line` reference. Anything that changes over time (products, prices, law) carries an
> "as of" date.

## Context

**What the code gives us (verified at 9d6655d):**
- **Audio lives only for one turn.** `processTurn` (`apps/api/src/turn.ts:915`) assembles `pcm`
  and then clears `session.audioChunks` (`turn.ts:918-922`), before the STT call at `turn.ts:958`
  (`await transcribeTurn(...)`).
  - `pcm` is a complete `Buffer` before STT, so a speaker embedding can run next to STT
    (`Promise.all`) without adding serial latency.
  - `transcribePcm` (`apps/api/src/audio.ts:58`) wraps 16 kHz mono PCM16 as WAV.
- **The shortest turn STT accepts** is `MIN_STT_AUDIO_MS = 300` (`apps/api/src/core/turn-core.ts:22`).
- **Cardputer turn shape** since #417:
  - a turn ends after `kVadEndSilenceMs = 1200` of silence and is capped at `kVadMaxTurnMs = 15000`
    (`apps/cardputer/include/end_of_speech.h:28,30`);
  - the follow-up window is `kFollowUpWindowMs = 6000` (`apps/cardputer/include/follow_up.h:16`).
  - Follow-up answers such as "yes", "Paris" or "the red one" are realistically **1-2 s** of speech.
- **Cardputer mic:** 16 kHz, default M5 config, no AGC and no noise filter
  (`apps/cardputer/src/audio_capture.cpp:26`). ESP32-S3 without PSRAM, so all speaker ID runs on
  the server (`docs/cardputer/wake-word-decision.md`, #341).
- **Web voice:**
  - `POST /api/voice` (`apps/api/src/web-voice.ts:100`) returns `{text}`;
  - the browser re-encodes audio to 16 kHz WAV (`apps/ui-v2/src/lib/use-voice.ts`);
  - hands-free mode cuts utterances with Silero VAD (`@ricky0123/vad-web`).
- **STT** is `fish-audio/transcribe-1` through the Vercel AI Gateway (`apps/ai/src/config.ts:56`).
  Our wrapper drops segments and word timestamps (`apps/ai/src/tools.ts:207-275`), so **today we
  cannot tell who said which words in an overlapping turn**, even in principle.
- **Deploy** is Railway: Node, a slim Docker image, no GPU, no Python and no onnxruntime
  (`docs/deploy.md`). So the embedding model is either a hosted API or a pure-JS/WASM model (#352).
- **Data:** Supabase Postgres with pgvector (1536-d text memory, HNSW cosine).
  - Every Space member is an auth user. **There is no guest concept today**, yet #355 and #359
    both need guest and child profiles (#341 facts).
  - A device belongs to one user.

**Product bar:** a $500 product that is foolproof and elegant, with no hand-coded phrase rules.
Players range from young kids to adults.

**What decides everything below:** our turns are short, single-channel and far-field, and the room
has several people in it. Voice ID will often be *unsure*, so the unsure path has to be the
designed path, not an error path.

## Enrollment UX

### What shipped products do (checked 2026-09-26)

**Alexa Voice ID (Amazon)**
- **How you enroll.** In the Alexa app you give consent, then say the on-screen phrases, repeating
  any that fail. You can also say "Alexa, learn my voice" on an Echo (search snippet,
  https://www.amazon.com/gp/help/customer/display.html?nodeId=GYCXKY2AB2QWZT2X; the page returned 503).
  Family members can create a voice ID "from the Alexa app or directly on an Echo device" (search
  snippet, https://www.amazon.com/gp/help/customer/display.html?nodeId=G9TEFK45J9E3DJSE).
- **How many phrases.** In 2017 the app asked for **ten phrases**, and analysis took up to about 20
  minutes (https://www.howtogeek.com/329669/how-to-train-alexa-to-recognize-different-voices-and-give-more-personalized-answers/).
  Today's count is (unverified). A 2026 guide says only "several phrases"
  (https://tecnoyfoto.com/en/alexa-voice-profiles-setup-guide-2026, updated 2026-03-16).
- **Household.** An Amazon Household has up to 2 adults and 4 child profiles, and each can have a
  voice ID (same guide).
- **Kids.** "Voice Profiles for Kids" launched in June 2021. Parents set them up for up to four
  children, and it required Amazon Kids+ at $2.99/month at launch
  (https://techcrunch.com/2021/06/29/amazon-introduces-reading-sidekick-a-kids-reading-companion-for-alexa-and-voice-profiles-for-kids).
- **Alexa+** is the generative-AI Alexa, announced in February 2025 and free with Prime
  (search snippet, https://en.wikipedia.org/wiki/Amazon_Alexa). Whether Alexa+ changes how voice ID
  enrollment works is (unverified).

**Google Voice Match (Google Assistant, and Gemini for Home)**
- **Household.** It is designed for up to 6 people per home: "If you have more than 6 members in
  your home, prioritize setting up Voice Match…" (https://support.google.com/googlenest/answer/7342711?hl=en).
- **How you enroll.** You say "a few words" in the Google Home app. The exact count is (unverified).
- **Retraining.** "Re-record language" retrains a person's voice model
  (https://support.google.com/googlehome/answer/7320960?hl=en).
- **Where the model lives.** It is "created on Google's servers and then stored only on the
  devices where you've turned on Voice Match" (https://support.google.com/assistant/answer/9071681).
- **Kids.** A child under 13 needs a Family Link-managed account. The parent must be a member of
  the home, and the child does voice training
  (https://support.google.com/assistant/answer/9071584?hl=en).
- **Gemini for Home** (early access as of 2025-2026) still uses Voice Match. Voice-matched kids
  always get the filtered experience, and switching a home to Gemini cannot be undone
  (https://support.google.com/googlehome/answer/16618650?hl=en). An experiment setting,
  "Require Voice Match", limits access to voice-matched adults
  (https://9to5google.com/2025/05/26/google-home-voice-assistant-experiments/).

**Apple Siri / HomePod**
- **How you enroll.** On the iPhone: turn "Listen for 'Siri' or 'Hey Siri'" off and on, then
  follow the voice training (https://support.apple.com/en-us/108397). The training is five
  utterances such as "Hey Siri" (https://appleinsider.com/inside/siri/tips/understanding-hey-siri----how-to-use-it-commands-and-more).
- **Household.** Up to six users per shared home; guests can still use timers, weather and music
  (https://support.apple.com/en-us/108397).
- **Kids.** Apple documents nothing child-specific here (not found).

**Samsung Bixby**
- **Voice ID** recognises voices registered on a Family Hub fridge or a Galaxy phone, and switches
  to that person's Samsung account. It rolled out from October 2025 in the "Family Hub for 2025"
  update (https://news.samsung.com/us/samsung-family-hub-2025-update-elevates-smart-home-ecosystem/;
  search snippet, because the page timed out on fetch).
- The enrollment length is (unverified).

**Speaker-ID services (as of 2026-09-26)**
- **pyannoteAI**
  - A voiceprint is made from **at most 30 s** of one speaker, and a clean clip of **at least 10 s**
    is recommended (https://docs.pyannote.ai/tutorials/identification-with-voiceprints).
  - Identification returns 0-100 confidence, `match: null` for an unknown speaker, and a
    `matching.threshold` setting (same page).
  - It is language-agnostic (search snippet, same page).
  - Billed per audio duration, **with a 20-second minimum per identification job** (same page).
    List prices are €0.015 per hour of identification and €0.015 per voiceprint. Plans are €19 and
    €99 a month, with a trial (https://www.pyannote.ai/pricing).
- **Picovoice Eagle**
  - Text-independent and language-agnostic, and runs on the device
    (https://picovoice.ai/blog/speaker-recognition-for-developers/, https://picovoice.ai/docs/eagle/).
  - Enrollment: `EagleProfiler.enroll()` is fed utterances until it reports 100 %, then
    `export()` gives the profile. It needs 16-bit mono PCM, one speaker and a quiet room.
    `Eagle.process()` returns a score per profile, or `null` when there is too little voice.
    A Picovoice AccessKey is required (https://picovoice.ai/docs/api/eagle-nodejs/).
  - Platforms include Linux x86_64 and the web (https://picovoice.ai/docs/eagle/).
  - The free plan is non-commercial only. Commercial pricing is by sales contact
    (https://picovoice.ai/pricing/, search snippet).
- **Speechmatics**
  - Enrollment is "5-30s" of a speaker talking alone. Several clips from different acoustic
    conditions are recommended. At most 50 identifiers per session, available in batch and realtime
    (https://docs.speechmatics.com/speech-to-text/features/speaker-identification).
  - Identifiers are tied to the model that generated them (search snippet, same page).

**Patterns across the consumer assistants:**
1. **They enroll on the wake phrase.** Siri trains on "Hey Siri" utterances (AppleInsider, above).
   Our server never receives the wake word as its own segment, and our wake word "Alexa" is
   another company's. What we identify is the free-form request after it. So our enrollment must
   be **text-independent**, sized like the services' 5-30 s, not like a hotword.
2. **About six people per household** (Google 6, Apple 6; Amazon 2 adults plus 4 children, above).
   This matches #341's target of 6.
3. **Children go through a parent-controlled path** (Amazon Kids+, Google Family Link, above).
4. **Voice ID is personalisation, not authentication.** Google says Voice Match "can match similar
   voices" (https://support.google.com/websearch/answer/6030020?hl=en).

### What we need from enrollment (derived from the verified code facts)
- **Enough net speech.** The text-independent services ask for 5-30 s (Speechmatics) or at least
  10 s (pyannoteAI) of one speaker (sources above). Three phrases of 1.5 s, which is #355's current
  floor, is about 5 s. That is the bare minimum, not a target.
- **Short test turns hurt more than short enrollment.** A WavLM + ECAPA-TDNN baseline's EER "rising
  from 2.393% at 3s to 18.437% at 1s" on VoxCeleb1
  (https://arxiv.org/html/2609.25007, fetched 2026-09-26). A 1-2 s Cardputer follow-up is in the
  bad part of that curve, whatever the enrollment is.
- **Phonetic coverage.** Prompts should be varied sentences, not repeats, so the centroid is not
  biased toward a few phones. Use short everyday requests that sound like real Bob use, for
  example "What's the weather tomorrow morning?". They should be generated per person from a
  reviewed pool, not hand-typed per locale.
- **Channel match.** The runtime channels differ a lot: a browser laptop mic with browser AGC,
  versus the Cardputer's raw mic with no AGC. Speechmatics recommends "multiple clips recorded
  under different acoustic conditions" (docs above). Apple's guidance is to train where you
  actually use Siri (search snippet,
  https://appleinsider.com/inside/siri/tips/understanding-hey-siri----how-to-use-it-commands-and-more).
  So enrolling on the channel that will be used, or topping up from it, is part of the design.
- **Adaptive re-enrollment, but only from strong evidence.** Alexa and Siri are described as
  improving with use (search snippets: https://tecnoyfoto.com/en/alexa-not-recognizing-voice-fix,
  and the AppleInsider page above). Neither vendor's mechanism is documented (unverified). Google
  documents manual retraining only (above). For us, a turn may update a person's centroid only
  when all of these hold:
  - the match was high confidence and the margin to the next profile was large;
  - the turn had at least 3 s of voiced audio;
  - the person has opted in (part of the #355 consent text).

  Updates must use a bounded moving average with a cap on drift, so a sibling or the TV cannot
  slowly take over a profile. No audio is kept. Only the vector changes, which fits #341's
  "no raw audio".
- **Children's voices change fast.** Prompt a re-enroll for child profiles every 6 months, and for
  any profile whose rolling mean score falls. Children are harder to identify. Prior studies
  report "a 40-45% relative increase in equal error rate" when adult-trained embeddings enroll and
  verify children (Singh, Sahidullah, Kinnunen, 2024-02, https://arxiv.org/html/2402.15214). The
  6-month interval is our proposal, not a published figure.

### Recommended flow: web (#355)
1. **Consent.** A plain-language screen: what a voiceprint is, that it is **not a password**, who
   in the Space can use it, and how to delete it. Recording stays disabled until consent is ticked.
2. **Mic check (2 s).** A live level meter. Refuse to go on if the level is too quiet or clipped,
   and say which.
3. **Five prompts, one at a time, large text:**
   - each prompt is a varied everyday request of 6-12 words, about 3-5 s spoken;
   - the target is **at least 15 s of voiced speech in total**, measured by the VAD, not by clip
     length;
   - the person may skip a prompt and get another one;
   - child profiles get shorter prompts, and a "read it after me" mode where Bob speaks the
     prompt first, for pre-readers.
4. **Far-field phrase (optional, recommended).** "Now step back to where you usually talk to
   Bob and say …". This covers the far-field condition that hands-free mode actually uses.
5. **Quality and consistency check.** Every clip must match the running centroid. If one clip
   disagrees, re-prompt that clip once. If it still disagrees, refuse with "these sound like
   different voices", as #355 already says.
6. **Self-test.** "Say anything, and I'll tell you who I think you are." This shows the person
   the result, and gives #361 a first genuine score.
7. **Done.** Show where to delete, and "Bob will get better at knowing you as you use it" only
   if adaptation was opted into.

### Recommended flow: Cardputer (#359)
1. Someone says "Bob, learn my voice, I'm Sam". The agent tool `start_voice_enrollment` starts
   the flow. The name comes from the agent's understanding of the turn, not a phrase rule.
2. Bob speaks a short consent summary. The screen shows "Sam: press OK to agree".
   **The device owner's keypress is the consent act.** A voice "yes" is not enough (as #359 already
   says, because of the TV and recordings).
3. **Four or five prompts.**
   - The screen shows each prompt in large text. Bob also speaks it, so non-readers can repeat it.
   - Each prompt is its own device turn. Use a **longer end-of-speech silence for enrollment
     turns** (for example 1.5-2 s), so a pause while reading does not cut the phrase.
   - Target at least 15 s of voiced speech in total.
4. There is **no key needed per phrase.** An earcon marks "your turn" and "got it" (#322). The
   screen shows the count, "Sam 2/5".
5. **Failure handling:**
   - a clip that is too short or too quiet is re-prompted with a reason;
   - after 3 failures, the flow suggests a quieter spot or the web;
   - on a consistency failure, the flow restarts.
6. **Channel top-up.** Someone already enrolled on the web can say "Bob, learn my voice on this
   device". That adds Cardputer-channel clips to their existing profile, after a match check. This
   is the cheapest fix for the web-to-device channel mismatch.

## Low-confidence and unknown speakers

### What shipped assistants do (checked 2026-09-26)
- **HomePod, the clearest documented pattern.**
  - "Siri might ask you who you are from time to time. You can respond with your name, or … say
    'This is [your name]' or 'Who am I?'" (https://support.apple.com/en-us/108397).
  - Guests beyond the six users can still use music, timers, alarms, weather and news, and guest
    music plays from the primary user's account (same page).
  - Personal Requests (messages, calendar, reminders, notes) need the recognised user (same page).
- **Google.**
  - "Without a match, the device treats the query as a guest query"
    (https://support.google.com/assistant/answer/9071681).
  - For unmatched media requests, it plays from the default service of the first person who set
    up Voice Match (https://support.google.com/googlenest/answer/7342711?hl=en).
  - It warns: "Some of Google's audio technologies, like Voice Match, can match similar voices"
    (https://support.google.com/websearch/answer/6030020?hl=en).
  - Turning Voice Match off deletes the voice models from devices; "device model deletion … may
    take up to 24 hours" (https://support.google.com/accounts/answer/16467537?hl=en). That matches
    #341's 24 h deletion target.
- **Alexa.**
  - "Alexa, who am I?" tests recognition (2017,
    https://www.howtogeek.com/329669/how-to-train-alexa-to-recognize-different-voices-and-give-more-personalized-answers/).
  - Alexa's exact words on an unrecognised voice are not documented in any page I could fetch
    (unverified). The Amazon help pages returned 503.
- **Known failure modes.**
  - **Similar voices.** Alexa "could confuse voice profiles in households with similar voices".
    Recognition is "convenience-grade", "not authentication", and retraining each person
    separately in the room where the Echo lives helps most (search snippet,
    https://www.androidpolice.com/enable-amazon-echo-multiple-users/).
  - **Kids.** Children's voices raise EER 40-45 % relative (ChildAugment, above).
  - **Colds and hoarse voices.** No source found (unverified). Guides only say to retrain "if your
    voice has changed" (https://tecnoyfoto.com/en/alexa-voice-profiles-setup-guide-2026).
  - **TV and recordings.** Google's "similar voices" warning above. Synthetic-command attacks on
    voice assistants are an active research topic (https://arxiv.org/pdf/2411.08316); the paper's
    specifics are not summarised here (unverified).
- **Kids' data law (as of 2026-09-26; #353 owns the legal call).**
  - The amended COPPA Rule adds biometric identifiers, **including voiceprints**, to "personal
    information".
  - It was published on 2025-04-22, took effect on **2025-06-23**, and full compliance was due by
    **2026-04-22**, so it is being enforced now
    (https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule;
    https://bbbprograms.org/media/insights/blog/coppa-amended).
  - On 2023-05-31, Amazon agreed to a **US$25 M** civil penalty for keeping children's Alexa voice
    recordings indefinitely and for failing to honour deletion requests
    (https://www.ftc.gov/news-events/news/press-releases/2023/05/ftc-doj-charge-amazon-violating-childrens-privacy-law-keeping-kids-alexa-voice-recordings-forever;
    https://www.justice.gov/archives/opa/pr/amazon-agrees-injunctive-relief-and-25-million-civil-penalty-alleged-violations-childrens).

### Recommended runtime behaviour
- **Three outcomes, as #356 already defines them:** `high`, `low` and `none`/`unknown`.
  - Add a **fourth input: too short.** When a turn has less than about 1 s of voiced audio (a
    threshold to set in #361), skip scoring and return `none` with reason `short`. Otherwise a
    1-2 s Cardputer follow-up like "yes" produces a confident-looking guess from too little speech.
- **Within one follow-up chain,** the speaker of a `short` turn *inherits* the previous turn's
  high-confidence identity, but only when all of these hold:
  - it is the same device;
  - it is inside the 6 s follow-up window;
  - no other profile scored high on it.

  The inherited identity is marked `inherited`, and is used for non-sensitive personal reads only.
  This keeps "remind me … / at what time? / six" working for Sam without a fresh match each time.
- **What Bob says on `low` or `unknown`:**
  - For an impersonal request (weather, timers, trivia), **say nothing about identity.** Just
    answer. Asking "who are you?" on every turn is the failure that makes this feature feel broken.
  - For a personal request ("my list", "who am I") in a Space with more than one person enrolled,
    ask once: "Who's asking?". The answer is understood by the agent (no phrase rules) and treated
    as self-declared (#357).
  - **Never say the guessed name** on a `low` match. Being told "Hi Alex" when you are Sam is
    worse than "Who's asking?".
  - Offer "want me to learn your voice?" at most once per person per day, and never to a speaker
    who is still `unknown` after they declined.
- **Safe personalisation:** identity from voice unlocks **reads of non-sensitive personal data**
  only. Writes are attributed to the matched person but are harmless if wrong (a reminder "for
  Sam"). Everything in #358's sensitive list needs an authenticated session, whatever the voice score.
- **TV and recordings:** a TV voice that happens to match is the reason voice is a hint, not a key.
  No extra detector is proposed. The protection is the #358 boundary.

## Turn-taking in games

### Shipped patterns (checked 2026-09-26)
- **Alexa Echo Buttons (retired).**
  - Buttons were "game show buzzers" on the Gadgets API, sold at $19 for a two-pack (2017-09,
    https://techcrunch.com/2017/09/27/amazon-introduces-echo-buttons-for-at-home-trivia-games-using-alexa).
  - Roll call bound players to buttons. It ended either on a timeout, in which case "anyone who
    presses a button within a specified time window is added to the game in the order in which
    their presses are received", or on an expected button count. First-to-buzz trivia was a
    supported pattern (search snippet,
    https://developer.amazon.com/en-US/blogs/alexa/post/ef044c94-db8e-49da-97a6-da124b0f786b/tips-for-building-echo-button-skills-with-the-gadgets-skill-api-bet).
  - Amazon's trivia sample did roll call, spoke the questions, took **voice** answers after the buzz,
    and kept scores (https://github.com/alexa/skill-sample-nodejs-buttons-trivia, archived 2021-04-29).
  - The GameEngine and GadgetController interfaces were "no longer available" as of **2020-06-15**,
    and the Alexa Gadgets toolkit as of **2021-12-31**
    (https://developer.amazon.com/en-US/docs/alexa/ask-overviews/deprecated-features.html).
- **Alexa skill sessions in general.**
  - After a prompt, the mic stays open "a few seconds". Then "if the skill specified a reprompt,
    Alexa reprompts the user … and opens the microphone for a few more seconds. If the user still
    doesn't respond, the session ends"
    (https://developer.amazon.com/en-US/docs/alexa/custom-skills/manage-skill-session-and-session-attributes.html).
  - The commonly quoted figure is about 8 s per window, but that is a community figure, not in
    Amazon's docs (search snippet,
    https://github.com/alexa/alexa-skills-kit-sdk-for-nodejs/issues/181).
  - Nothing tells a skill *who* answered.
- **Jeopardy! on Alexa.** Daily clues from the day's broadcast, answered as "What is / Who is …",
  with Alexa keeping score. It is one contestant, with nothing attributing who spoke
  (search snippet, https://www.jeopardy.com/jbuzz/news-events/jeopardy-skill-20-amazon-alexa). Its
  support contact is Volley (search snippet, same query).
- **Song Quiz (Volley, now Weekend).**
  - It offers same-household play and online one-versus-one play. A reviewer contrasts it with
    "Guess My Name", "where the fastest player interrupts Alexa to say their answer", and says
    Song Quiz "does make sure that every player gets a fair chance" (search snippet,
    https://medium.com/voice-games/review-song-quiz-1a565581c4a6; the page returned 403). The
    exact same-room turn mechanic is (unverified).
  - Volley has rebranded as **Weekend**. It makes AI games on TV (Song Quiz, Jeopardy!, Wheel of
    Fortune) played with "voice remotes, phones as controllers" (as of 2026-09,
    https://www.ycombinator.com/companies/weekend-fmr-volley).
- **Trivia Hero (Voice Arcade).** A 60-second race to answer as many questions as you can, alone
  or against up to 20 others (search snippet,
  https://www.amazon.com/labworks-io-USA-Trivia-Hero/dp/B07DNQRN29; the page returned 500). How
  players are attributed is (unverified).
- **Google Assistant games.**
  - "Are You Feeling Lucky?" supported multiple players: "Each person answer[s] a question and, at
    the end of the round, Google Assistant proclaims the winner"
    (https://www.androidauthority.com/google-assistant-trivia-pixel-723139/). Whether it collected
    names is (unverified).
  - Smart Display games combined voice and touch (2020-07-30,
    https://blog.google/products/assistant/hey-google-lets-play-a-game-on-your-smart-display/).
  - Third-party Conversational Actions shut down on **2023-06-13**
    (https://developers.google.com/assistant/ca-sunset).
- **Common lesson.** No product I found attributes game answers by voice ID. They use a
  **physical seat** (Echo Buttons, phone controllers), **one answer per person in turn**, or a
  single contestant. Games where the fastest voice wins have no attribution at all.

### Why voice ID cannot be the referee for us (verified constraints)
1. **Short answers.** Answers are 1-2 s ("Paris"), which is under our proposed `short` threshold
   or close to it.
2. **One mic, no diarization.** One far-field mono mic, and STT output without segments or word
   timestamps (`apps/ai/src/tools.ts:207-275`). Two people answering at once become one mixed
   transcript that no one can attribute.
3. **No voice barge-in on the Cardputer.** No AEC, and wake word is paused during playback
   (`docs/cardputer/wake-word-decision.md`). Players cannot answer while Bob speaks, so answer
   windows must open *after* the question ends, with an earcon.
4. **Keys are exact.** The server can timestamp Cardputer keys and web buttons, which covers #342's
   ≤ 50 ms buzzer-fairness target. Speech onset cannot be timestamped that exactly after VAD and upload.

### Recommended model per game type
The letters refer to #363's answer models:
- **(a)** open floor;
- **(b)** buzz then answer;
- **(c)** round robin by seat or name;
- **(d)** collect all.

| Game (#342 MVP) | Model | Who gets the credit | Voice ID's role |
|---|---|---|---|
| Trivia quiz with scores | **(c) round robin** by default. **(b) buzz** in "speed" mode, only when every player has a key or button | the addressed seat, or the buzzer | confirm only. A mismatch is logged, never penalised |
| Quick-reaction buzzer | **(b) buzz**, with keys only | the key's seat | none |
| Guess the word / 20 questions | **(a) open floor**, cooperative: the room is one team | the team | optional flavour ("nice one, Sam") on `high` only |
| Word chain | **(c) round robin** by name | the addressed seat | confirm only |
| Collaborative story | **(c) round robin**, with no scoring | the addressed seat | none |
| "Everyone answers" (#363 (d)) | **not recommended** in one room on voice | none | this needs per-player devices: each remote web player answers on their own device |

**Seats are the unit of identity in a game.** At setup, "start trivia for 3 players" makes the
host collect names. Then:
- each player is bound to a **seat**: a Cardputer key, a web button, or "just my name";
- an enrolled player's voice profile is attached to their seat when voice ID is `high`.

This way a game never needs voice ID to work, and gets nicer when it has it.

### Recommended model per surface
| Surface | How a player takes their turn | Answer window | Talk-over |
|---|---|---|---|
| **Cardputer keys** | Buzz: each player owns one key (roll call at setup: "press your key"). Round robin: "Sam, your turn" plus the earcon, then Sam just speaks, with no wake word inside a game | opens after Bob stops speaking. **8 s for adults, 12 s in kid mode**, then one reprompt. Uses the device's 1200 ms end of speech | none possible during playback (no AEC). A key press skips Bob's speech (#315) and opens the window |
| **Web push-to-talk** | one device per player (a remote player), or a shared laptop with round robin by name | as for the Cardputer. A tap-and-hold answer ignores the window until release | speech is not captured while Bob speaks. The "answer" button stops playback |
| **Web hands-free (Silero VAD)** | round robin by name. Buzz uses an on-screen button per player | 8 s / 12 s from the end of Bob's audio, **plus a 300 ms grace** for echo-guard settling (the value to measure in #363) | an echo-guard barge-in from a *non-addressed* player's speech is ignored in round robin, and counted as "answer" only in open-floor games |
| **Cross-surface (#373)** | every buzz carries a server receive time. Remote web players get a latency allowance equal to half their measured RTT, capped at 150 ms (a value to prove in #371) | same windows | as above |

The window lengths above are **starting values**. Alexa's documented pattern is one listen, one
reprompt, then end, with the community-quoted figure of about 8 s per window (above).
#363's live session must replace them with measured values.

## Accessibility and kids
- **Never require speed from a child.** Kid mode, which is on when any child or guest profile is
  playing, sets these as defaults:
  - round robin, not buzz;
  - a 12 s window with one friendly reprompt;
  - the question is repeated on "again?" or "say that again", understood by the agent, not by phrase rules.
- **Multiple-choice answers** ("is it A, a dog, or B, a cat?") make short, easy-to-recognise
  answers, and help pre-readers and non-native speakers. They also keep answers inside the set that
  STT hears well.
- **Keys as an equal alternative to voice.** On the Cardputer, keys 1-4 answer multiple choice.
  This covers players with speech differences, and noisy rooms.
- **Screens are secondary.** Every state is spoken, and the screen only mirrors it (#342 non-goal).
  Use large text, and an earcon for "your turn", "right" and "time's up".
- **Enrollment for kids:**
  - parent-supervised on the web (#355);
  - "read it after me" prompts;
  - re-enroll every 6 months;
  - a child is never *required* to enroll to play.
  - Children's voiceprints are "personal information" under the amended COPPA Rule, enforced
    since 2026-04-22 (Federal Register, above). Amazon's 2023 US$25 M penalty was about keeping kids'
    voice data and not honouring deletion requests (FTC, above). #353 must decide whether child
    voiceprints ship at all in v1.
  - Both shipped precedents gate children behind a parent path: Amazon Kids+ voice profiles, up to
    4 children, and Google Family Link (above).
- **Unknown players are first-class.** A guest who never enrolls plays by seat or name. They are
  never asked to enroll mid-game.

## Impact on existing issues
These are proposed acceptance-criteria changes. Nothing has been edited on GitHub.

**#355: web enrollment**
- Change "reads 3 phrases" to **"reads 5 varied prompts, with at least 15 s of voiced speech in
  total, measured by the VAD"**. #352/#361 may lower this with evidence.
- Change the per-phrase floor from "under 1.5 s" to **"under 2 s of voiced speech"**.
- **Add:** prompts are text-independent everyday requests, drawn from a reviewed pool. There is no
  wake-word-only phrase.
- **Add:** an optional far-field prompt, and a self-test step that shows the matched name.
- **Add:** consent copy states "not a password", and states who in the Space can use the profile.
- **Add:** an adaptive-update opt-in. With it off, the vector changes only on explicit re-enroll.
- **Add:** child profiles are prompted to re-enroll after 6 months.
- **Dependency to state explicitly:** guest and child profiles need a guest-profile data model.
  None exists today (#341 facts). #354 must own it.

**#356: identify every turn**
- **Add:** turns under the `short` threshold (to set in #361, starting at about 1 s voiced) return
  `none` with reason `short`, and no embedding is scored.
- **Add:** a `short` follow-up turn inside the 6 s window on the same device may *inherit* the
  previous `high` identity, marked `inherited`. It is non-sensitive only, and ignored if another
  profile scores high.
- **Add:** the evaluation set includes siblings, parent and child pairs, a hoarse voice, and TV
  speech. Report false accepts per category.
- **Add:** a Cardputer-channel condition in the evaluation (enrolled on the web, identified on the
  device), with and without a channel top-up.

**#352: model/provider spike (inputs, not AC changes)**
- **pyannoteAI** bills identification with a **20 s minimum per job** (docs above). Per-turn
  identification of 1-8 s turns would be billed as at least 20 s each. Measure its round-trip
  against #341's 150 ms p95 budget before shortlisting it.
- **Picovoice Eagle** has a Node SDK that runs locally, including on Linux x86_64, so it could run
  on Railway without Python. It needs an AccessKey, and commercial use needs a paid licence by
  sales contact (as of 2026-09-26, sources above).
- **Speechmatics** identifiers are tied to the model that made them (search snippet, above). A
  provider model upgrade would force re-enrollment of every household.

**#357: personal answers**
- **Add:** "who am I?" and "this is Sam" are answered the way HomePod does it (Apple, above). The
  agent understands them; there is no phrase rule.
- **Add:** on `low`/`unknown` with an impersonal request, Bob says nothing about identity.
- **Add:** a `low` match never speaks the guessed name.
- **Add:** "learn your voice?" is offered at most once per person per day.

**#359: Cardputer enrollment**
- Change 3 phrases to **4-5 prompts, with at least 15 s voiced speech in total**. Each prompt is
  spoken by Bob as well as shown on screen.
- **Add:** enrollment turns use a longer end-of-speech silence (1.5-2 s) than normal turns (1200 ms).
- **Add:** a "learn my voice on this device" top-up for an existing profile, after a match check.
- **Keep:** the owner keypress as the consent act, and children excluded on the device.

**#363: turn-taking spike**
- Its constraints are **stale.** They say the Cardputer ends a turn after 700 ms of silence with an
  8 s cap. Since #417 these are 1200 ms and 15 s (`end_of_speech.h:28,30`), and there is a 6 s
  follow-up window (`follow_up.h:16`).
- **Add to the decision record:** seats are the unit of identity, and voice ID only confirms.
  Answer model (d) is dropped for single-mic rooms.
- **Add measured targets:** a missed-answer rate for 8 s and 12 s windows, and the echo-guard
  false-trigger rate with 4-6 people.
- **Add:** kid mode defaults (round robin, 12 s window, multiple choice, keys 1-4).

## Sources
**Our code and issues (verified at 9d6655d, 2026-09-26):**
- `apps/api/src/turn.ts:915,918-922,958`
- `apps/api/src/audio.ts:58`
- `apps/api/src/core/turn-core.ts:22`
- `apps/cardputer/include/end_of_speech.h:28-31`
- `apps/cardputer/include/follow_up.h:16`
- `apps/cardputer/src/audio_capture.cpp:26`
- `apps/api/src/web-voice.ts:100`
- `apps/ui-v2/src/lib/use-voice.ts`
- `apps/ai/src/config.ts:56`
- `apps/ai/src/tools.ts:207-275`
- `docs/deploy.md`
- `docs/cardputer/wake-word-decision.md`
- `gh issue view` 341, 342, 355, 356, 357, 359, 363 (`-R suzworx/Bob`)

**External sources, accessed 2026-09-26.** "Fetched" means the page itself was read. "Snippet"
means only a search-result snippet was available.

Amazon:
- Fetched: https://www.howtogeek.com/329669/how-to-train-alexa-to-recognize-different-voices-and-give-more-personalized-answers/
- Fetched: https://tecnoyfoto.com/en/alexa-voice-profiles-setup-guide-2026
- Fetched: https://www.pocket-lint.com/how-to-create-amazon-alexa-voice-profiles-so-it-can-recognise-you/
- Snippet (the page returned 503): https://www.amazon.com/gp/help/customer/display.html?nodeId=GYCXKY2AB2QWZT2X
- Snippet (the page returned 503): https://www.amazon.com/gp/help/customer/display.html?nodeId=G9TEFK45J9E3DJSE
- Snippet: https://techcrunch.com/2021/06/29/amazon-introduces-reading-sidekick-a-kids-reading-companion-for-alexa-and-voice-profiles-for-kids
- Snippet: https://en.wikipedia.org/wiki/Amazon_Alexa
- Snippet: https://www.androidpolice.com/enable-amazon-echo-multiple-users/
- Snippet: https://tecnoyfoto.com/en/alexa-not-recognizing-voice-fix
- Fetched: https://developer.amazon.com/en-US/docs/alexa/custom-skills/manage-skill-session-and-session-attributes.html
- Snippet: https://github.com/alexa/alexa-skills-kit-sdk-for-nodejs/issues/181
- Fetched: https://developer.amazon.com/en-US/docs/alexa/ask-overviews/deprecated-features.html
- Fetched: https://techcrunch.com/2017/09/27/amazon-introduces-echo-buttons-for-at-home-trivia-games-using-alexa
- Snippet: https://developer.amazon.com/en-US/blogs/alexa/post/ef044c94-db8e-49da-97a6-da124b0f786b/tips-for-building-echo-button-skills-with-the-gadgets-skill-api-bet
- Fetched: https://github.com/alexa/skill-sample-nodejs-buttons-trivia

Google:
- Fetched: https://support.google.com/googlenest/answer/7342711?hl=en
- Fetched: https://support.google.com/googlehome/answer/7320960?hl=en
- Fetched: https://support.google.com/assistant/answer/9071681
- Fetched: https://support.google.com/assistant/answer/9071584?hl=en
- Fetched: https://support.google.com/accounts/answer/16467537?hl=en
- Fetched: https://support.google.com/websearch/answer/6030020?hl=en
- Fetched: https://support.google.com/googlehome/answer/16618650?hl=en
- Snippet: https://9to5google.com/2025/05/26/google-home-voice-assistant-experiments/
- Fetched: https://www.androidauthority.com/google-assistant-trivia-pixel-723139/
- Fetched: https://blog.google/products/assistant/hey-google-lets-play-a-game-on-your-smart-display/
- Snippet: https://developers.google.com/assistant/ca-sunset

Apple and Samsung:
- Fetched: https://support.apple.com/en-us/108397
- Snippet: https://appleinsider.com/inside/siri/tips/understanding-hey-siri----how-to-use-it-commands-and-more
- Snippet (the fetch timed out): https://news.samsung.com/us/samsung-family-hub-2025-update-elevates-smart-home-ecosystem/

Speaker-ID services:
- Fetched: https://docs.pyannote.ai/tutorials/identification-with-voiceprints
- Fetched: https://www.pyannote.ai/pricing
- Fetched: https://picovoice.ai/docs/eagle/
- Fetched: https://picovoice.ai/docs/api/eagle-nodejs/
- Snippet: https://picovoice.ai/blog/speaker-recognition-for-developers/
- Snippet: https://picovoice.ai/pricing/
- Fetched: https://docs.speechmatics.com/speech-to-text/features/speaker-identification

Games:
- Snippet (the page returned 403): https://medium.com/voice-games/review-song-quiz-1a565581c4a6
- Fetched: https://www.ycombinator.com/companies/weekend-fmr-volley
- Snippet: https://www.jeopardy.com/jbuzz/news-events/jeopardy-skill-20-amazon-alexa
- Snippet (the page returned 500): https://www.amazon.com/labworks-io-USA-Trivia-Hero/dp/B07DNQRN29

Research and law:
- Fetched: https://arxiv.org/html/2609.25007
- Fetched: https://arxiv.org/html/2402.15214
- Snippet: https://arxiv.org/pdf/2411.08316
- Snippet: https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule
- Snippet: https://bbbprograms.org/media/insights/blog/coppa-amended
- Snippet: https://www.ftc.gov/news-events/news/press-releases/2023/05/ftc-doj-charge-amazon-violating-childrens-privacy-law-keeping-kids-alexa-voice-recordings-forever
- Snippet: https://www.justice.gov/archives/opa/pr/amazon-agrees-injunctive-relief-and-25-million-civil-penalty-alleged-violations-childrens
