# Multi-speaker turns: which service labels who said what (VID-MULTI)

Research date: 2026-09-26. HEAD `9d6655d`. Feeds epic #341 and issues #360 and #363.

**How to read this.**
- Every external claim carries its source URL inline. They were read with WebSearch and WebFetch on 2026-09-26.
- **unverified** means the claim could not be confirmed from a primary page that day, for example when a pricing page did not render its figures and only a search snippet or third party gave them.
- **vendor claim** marks accuracy figures published by the vendor about itself.
- Prices and statuses are **as of 2026-09-26** and will drift.
- Nothing here is measured yet. Measuring is the job of the bake-off in *Test protocol*.
- This builds on, and does not repeat, the per-turn survey in `docs/voice-id/speaker-id-service-research.md`, the privacy research in `docs/privacy/voiceprints-research.md` and the UX research in `docs/voice-id/enrollment-and-turn-taking-research.md` (all on `origin/main2`).

## Context

**Scope.** On 2026-09-26 the owner narrowed the scope: "our scope is classification of people especially when multiple people are talking". So the core problem for #341 is now #360: one recording with 2-6 household members, enrolled or unknown, speaking one after another and sometimes over each other. The main case is a family voice game (#342, #363), for example "Sam says Paris, Alex says Rome".

**The output we need.**
- Speaker-labelled words or segments, each mapped to an enrolled person or `unknown`.
- No guessing on short or overlapping speech. #360 already fixes the rules: a segment under 0.7 s is `unknown`, overlap is `overlap/unknown`, and the multi-speaker budget is ≤ 400 ms p95 (#360).
- The owner's direction is to **buy a managed service, not DIY**.

**Code facts (verified in this worktree at `9d6655d`).**
- **Uplink frames arrive one at a time.** Each Cardputer `audio_up` frame is appended to `session.audioChunks` as it arrives (`apps/api/src/session.ts:738`). So a streaming vendor socket could be fed frame by frame, in parallel with the existing buffering.
- **STT runs once, after the turn ends.** `processTurn` (`apps/api/src/turn.ts:915`) concatenates the chunks with `assemblePcm16` (`turn.ts:918`), clears them (`turn.ts:921`) and only then calls `transcribeTurn` (`turn.ts:958`, defined at `turn.ts:331`).
- **Our STT result has no words.** `transcribePcm` (`apps/api/src/audio.ts:58`) wraps the PCM as 16 kHz mono WAV and returns only `text`, `model` and `seconds` (`SttResult`, `audio.ts:20-24`; `audio.ts:75-79`). No word timestamps and no speaker labels reach the turn pipeline today.
- **The STT model** is `fish-audio/transcribe-1` through the Vercel AI Gateway (`apps/ai/src/config.ts:56`, per the per-turn survey). The Gateway model list has no speaker-ID model (same survey).
- **The shortest turn sent to STT** is 300 ms (`MIN_STT_AUDIO_MS`, `apps/api/src/core/turn-core.ts:22`; `MIN_STT_PCM_BYTES`, `audio.ts:49`).
- **Turn shape.** Per the per-turn survey, Cardputer turns end after 1200 ms of silence, are capped at 15 s, and allow follow-ups in a 6 s window. Game answers such as "Paris" are 0.4-1.5 s of speech each (estimate).
- **No audio is stored** anywhere (#341). Any vendor that keeps audio, or needs *us* to keep enrollment audio, conflicts with that.

**What the earlier survey already settled.**
- Azure Speaker Recognition retired on 2025-09-30.
- Amazon Connect Voice ID ended on 2026-05-20.
- Google Speaker ID was withdrawn.
- Only Speechmatics and pyannoteAI, among hosted APIs, identified against enrolled voiceprints.

This survey re-checks those points for the *multi-speaker* case, and adds a 2025-2026 newcomer: OpenAI `gpt-4o-transcribe-diarize` with known-speaker references.

**Household cost basis** used everywhere below: 200 turns/day × 30 days × 3 s = **18,000 s = 5 h of audio per household per month**, or 6,000 turns.

## Options compared

Column key: **One call** means diarization plus identification against enrolled voiceprints in a single request. **Labels** covers speaker labels and word timestamps. **Min seg** is the minimum segment length the service will label. **Max** is the maximum speakers and enrolled identities. **$/h → /hh/mo** is the list price per audio hour, then the cost at 5 h per household per month (as of 2026-09-26).

| Service | One call? Realtime or batch | Labels | Overlap | Min seg | Unknown speakers | Max | Latency after end of speech | Languages (en, en-IN, hi, te) | $/h → /hh/mo | Retention, DPA | Node SDK |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Speechmatics** speaker identification | **Yes, in Realtime and in Batch.** Enrolled identifiers go in `speaker_diarization_config.speakers` in the same session ([realtime](https://docs.speechmatics.com/speech-to-text/realtime/speaker-identification), [batch](https://docs.speechmatics.com/speech-to-text/batch/speaker-identification)) | **Per word:** every word and punctuation object carries `speaker` and times ([realtime diarization](https://docs.speechmatics.com/speech-to-text/realtime/realtime-diarization)) | No overlap flag documented (**unverified**); each word gets one speaker | No setting documented (**unverified**). `speaker_sensitivity` and `prefer_current_speaker` tune changes (same page) | Unenrolled voices get `S1`, `S2`…; `UU` means unidentified ([batch diarization](https://docs.speechmatics.com/speech-to-text/batch/batch-diarization)) | `max_speakers` ≥ 2, unlimited by default, for unenrolled speakers only; 50 identifiers per session; enrollment 5-30 s per clip ([feature](https://docs.speechmatics.com/speech-to-text/features/speaker-identification)) | Realtime finals 0.7-4 s after a word (`max_delay`), partials < 500 ms ([output](https://docs.speechmatics.com/speech-to-text/realtime/output)). `ForceEndOfUtterance` flushes finals on demand ([end of turn](https://docs.speechmatics.com/speech-to-text/realtime/end-of-turn)). Real delay after our end-of-turn: **unverified** | en yes; en-IN not named, "non-native speakers" covered; **hi yes**; **te no** ([languages](https://docs.speechmatics.com/speech-to-text/languages)) | Standard $0.24, Enhanced $0.43 (search snippet, **unverified**; the page shows only "Pro from $0.129" and $100 credit) ([pricing](https://www.speechmatics.com/pricing)) → **$0.65-2.15**. No separate diarization or ID charge shown | Realtime audio "never recorded or stored"; batch deleted after 7 days; SOC 2 Type II, ISO 27001 ([security](https://docs.speechmatics.com/administration/security-and-compliance)). DPA via its trust centre (**unverified**). Identifiers are model-specific ([feature](https://docs.speechmatics.com/speech-to-text/features/speaker-identification)) | Yes: `@speechmatics/real-time-client`, `@speechmatics/batch-client` ([SDK](https://github.com/speechmatics/speechmatics-js-sdk)) |
| **pyannoteAI** `/identify` | **Yes, batch only** (async job, poll or webhook) ([identify](https://docs.pyannote.ai/api-reference/identify.md)). Streaming Live-1 diarizes with anonymous labels; naming speakers "uses voiceprints … on the batch pass" ([Live-1 blog](https://www.pyannote.ai/blog/introducing-live-1-streaming-diarization)). No streaming-identification roadmap or beta found (**unverified**) | **Per segment.** Speaker-attributed transcription exists on `/diarize` ([diarize](https://docs.pyannote.ai/api-reference/diarize.md)); on `/identify` it is **unverified** | **Best documented of all:** overlapping segments by default, `exclusive` gives a non-overlapping view ([speaker config](https://docs.pyannote.ai/tutorials/speaker-configuration.md)); Precision-3 returns `crosstalkProbability` and takes `crosstalkSensitivity` ([crosstalk](https://docs.pyannote.ai/tutorials/vad-crosstalk-sensitivity.md)) | Not documented (**unverified**) | `SPEAKER_XX` with `match: null`, plus 0-100 confidence per voiceprint and a `threshold` ([voiceprints](https://docs.pyannote.ai/tutorials/identification-with-voiceprints)) | 50 voiceprints per job ([identify](https://docs.pyannote.ai/api-reference/identify.md)); Live-1 up to 8 speakers ([streaming](https://docs.pyannote.ai/tutorials/streaming-real-time.md)) | Job turnaround not documented (**unverified**); Live-1 < 300 ms but without identities ([models](https://docs.pyannote.ai/models.md)) | Language-agnostic ([voiceprints](https://docs.pyannote.ai/tutorials/identification-with-voiceprints)) | Precision-3 €0.112/h; "Speaker Identification €0.096/h"; €0.015 per voiceprint ([pricing](https://www.pyannote.ai/pricing)); **20 s minimum per job** ([billing](https://docs.pyannote.ai/administration/billing.md)) → **≈ €3.73** (6,000 × 20 s = 33.3 h) | Media 48 h, outputs 24 h, no training, DPA in the terms, EU-only region ([retention](https://docs.pyannote.ai/data-retention.md)) | No official SDK; REST (**unverified**) |
| **Picovoice Falcon + Eagle** | **No:** two engines. Falcon diarizes a whole buffer (batch) ([Falcon](https://picovoice.ai/docs/falcon/)); Eagle scores audio against profiles ([Eagle Node](https://picovoice.ai/docs/api/eagle-nodejs/)). We would join them ourselves | Falcon: per segment `startSec`, `endSec`, `speakerTag`; no words ([Falcon web](https://picovoice.ai/docs/quick-start/falcon-web/)) | No flag | Eagle exposes `minProcessSamples()`; its value is not published (**unverified**) | No label: Eagle gives 0-1 scores or `null`, we threshold ([Eagle Node](https://picovoice.ai/docs/api/eagle-nodejs/)) | Falcon unlimited speakers; Eagle profile cap not published (**unverified**) | In-process, no network hop; CPU time **unverified** | Language-agnostic ([Eagle](https://picovoice.ai/products/voice/speaker-recognition/)) | Foundation $6,000/yr with 25K Falcon + 10K Eagle min/month (search snippet, **unverified**) ([pricing](https://picovoice.ai/pricing/)) → covers only ~33 households at 5 h each | Audio stays on our server; AccessKey calls home ([Falcon](https://github.com/Picovoice/falcon)) | **Eagle yes; Falcon no Node SDK** (Python, C, Web, iOS, Android) ([Falcon](https://github.com/Picovoice/falcon)) |
| **OpenAI `gpt-4o-transcribe-diarize`** (2025-2026 newcomer) | **Yes, batch only.** `/v1/audio/transcriptions` with `known_speaker_names[]` and `known_speaker_references[]`; "not supported in Realtime transcription sessions" ([guide](https://developers.openai.com/api/docs/guides/speech-to-text)) | **Per segment** (`speaker`, `start`, `end` in `diarized_json`); no word timestamps documented (same page) | Not documented (**unverified**) | Not documented (**unverified**) | How unmatched voices are labelled is not stated (**unverified**) | **4 references max**, each 2-10 s **of audio** (same page) | Segment events stream as each segment finalises (same page); end-to-end time **unverified** | Multilingual; en-IN, hi, te **unverified** | $2.50 per M input tokens and $10 per M output tokens ([model](https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize)) ≈ $0.36/h (third-party estimate, [costgoat](https://costgoat.com/pricing/openai-transcription)) → **≈ $1.80** | No training; ZDR-eligible ([your data](https://developers.openai.com/api/docs/guides/your-data)). **The references are raw audio we would have to keep** | Yes (`openai`) |
| **Deepgram** Nova-3 | **Diarization only**, streaming (v1) and batch (v2); no enrollment ([diarization](https://developers.deepgram.com/docs/diarization)); names need "your own additional processing" ([discussion](https://github.com/orgs/deepgram/discussions/475)) | Per word, with `speaker_confidence` on batch only (same page) | Not documented | Not documented | Numeric index | Not documented | Streaming; not measured | en, en-IN, hi, te on Nova-3 ([languages](https://developers.deepgram.com/docs/models-languages-overview)) | Streaming $0.29/h ([pricing](https://deepgram.com/pricing)) + diarization ≈ $0.12/h (**unverified**) → **≈ $2.05** + an ID service | `mip_opt_out` keeps data only while processing ([MIP](https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program)) | Yes (`@deepgram/sdk`) |
| **AssemblyAI** | **Diarization only.** "Speaker Identification" infers names from conversation content, with "no voice enrollment" ([docs](https://www.assemblyai.com/docs/speech-understanding/speaker-identification), [blog](https://www.assemblyai.com/blog/assemblyai-speaker-identification-diarization)) | Per word, streaming and batch ([streaming diarization](https://www.assemblyai.com/blog/streaming-speaker-diarization)) | Streaming "assigns the entire overlapping segment to one speaker" (same post) | Streaming segments < 1 s may come back `UNKNOWN`; "yes"/"no" may be unlabelled (same post) | Anonymous; `UNKNOWN` for short segments | 1-10 in streaming (same post) | ≈ 221-307 ms turn delivery (vendor claim, same post) | Hindi with code-switching (vendor summary, [U-3.5](https://www.assemblyai.com/blog/universal-3-5-pro-realtime)); te **unverified** | Streaming $0.15/h + diarization $0.12/h ([pricing](https://www.assemblyai.com/pricing)) → **$1.35** + an ID service | BAA available (same page); zero retention **unverified** | Yes (`assemblyai`, **unverified**) |
| **Gladia** Solaria | **Diarization only, batch** (docs mark it "Pre-recorded") ([diarization](https://docs.gladia.io/chapters/audio-intelligence/speaker-diarization)); re-identification is left to the customer ([blog, 2026-08-21](https://www.gladia.io/blog/speaker-re-identification-across-recurring-meetings)) | Per utterance, speaker index ([support](https://support.gladia.io/article/how-to-detect-speakers-and-understand-who-said-what)) | Not documented | Not documented | Anonymous index | Speaker counts are "hints" (docs above) | Batch only | 100+ languages; hi, te **unverified** | $0.55/h (**unverified**) → **≈ $2.75** + an ID service | Paid plans keep data 3 weeks; zero retention is Enterprise-only ([retention](https://docs.gladia.io/chapters/limits-and-specifications/data-retention.md)) | JS **unverified** |
| **ElevenLabs Scribe** v2 | **Diarization only, batch.** The realtime WebSocket takes no diarization parameters ([realtime API](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)) | Per word `speaker_id`, word timestamps (batch) ([STT](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)) | Not documented | Not documented | `speaker_N` | 32 speakers (same page; another source says 48, **unverified**) | Batch only for labels | 90+ languages incl. hi, te (same page) | $0.22/h batch ([API pricing](https://elevenlabs.io/pricing/api)) → **$1.10** + an ID service | Zero retention Enterprise-only ([ZRM](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode)) | Yes (`@elevenlabs/client`) |
| **Rev.ai** Reverb | **Diarization only, batch**; generic labels ([FAQ](https://docs.rev.ai/faq)) | Per element (**unverified**) | Not documented | Not documented | `Speaker N` | 8 (English), 6 (others) (same FAQ) | Streaming has no diarization; 15 s minimum per stream ([streaming](https://docs.rev.ai/api/streaming/)) | hi, te not found | $0.20/h ([pricing](https://www.rev.ai/pricing)) → **$1.00** + an ID service | **unverified** | **unverified** |
| **Google** Chirp 3 (Speech-to-Text v2) | **Diarization only, batch** (`BatchRecognize`, `Recognize`), not streaming; no enrollment; Speaker ID withdrawn ([Chirp 3](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3)) | **No word timestamps** on Chirp 3 (same page); Chirp 2 has timestamps but no diarization ([Chirp 2](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-2)) | Not documented | Not documented | Anonymous | Not documented | Batch | en-IN, hi-IN with diarization; te-IN not (same page) | ≈ $0.96/h (third party, **unverified**, [brasstranscripts](https://brasstranscripts.com/blog/google-cloud-speech-to-text-pricing-2025-gcp-integration-costs)) → **≈ $4.80** + an ID service | Audio not logged by default ([data logging](https://docs.cloud.google.com/speech-to-text/docs/data-logging)) | `@google-cloud/speech` |
| **Azure** AI Speech | **Diarization only.** Speaker Recognition, including the voice signatures that conversation transcription used, retired on 2025-09-30; diarization survived ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/4372751/azure-real-time-diarization), [retirement](https://github.com/MicrosoftDocs/azure-ai-docs/blob/main/articles/ai-services/speech-service/includes/retire-speaker-recognition.md)). Realtime `ConversationTranscriber` and batch/fast | Per phrase, with word timestamps inside ([fast transcription](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create)) | Not documented | Not documented | `Guest-1`, `Guest-2`; `Unknown` in early partials ([diarization quickstart](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-stt-diarization)) | 2-35 (fast transcription) | Realtime available; not measured | en-IN, hi-IN yes; te-IN no (fast transcription page) | Realtime $1.00 + $0.30/h diarization (third party, **unverified**, [brasstranscripts](https://brasstranscripts.com/blog/azure-speech-services-pricing-2025-microsoft-ecosystem-costs)) → **≈ $6.50** + an ID service | Microsoft DPA (**unverified** for this service) | Yes |
| **AWS Transcribe** | **Diarization only**, batch and streaming; Voice ID ended 2026-05-20 ([diarization](https://docs.aws.amazon.com/transcribe/latest/dg/diarization.html), [Voice ID EOS](https://docs.aws.amazon.com/connect/latest/adminguide/amazonconnect-voiceid-end-of-support.html)) | Per item (word) with timestamps (diarization page) | Not documented | Not documented | `spk_0`…`spk_29` | 2-30 (diarization page) | Streaming; not measured | en-IN, hi-IN, **te-IN** ([languages](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html)) | $1.44/h tier 1 (third party, **unverified**, [costgoat](https://costgoat.com/pricing/amazon-transcribe)) → **≈ $7.20** + an ID service | AWS DPA (**unverified** for this service) | `@aws-sdk/client-transcribe-streaming` |
| **Sarvam** (Indian newcomer) | **Diarization only, batch**, no enrollment ([diarization](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/how-to/enable-speaker-diarization)) | Per segment | Not documented | Not documented | Anonymous | 20 | Batch | 22 Indian languages incl. **te**, hi ([STT](https://www.sarvam.ai/apis/speech-to-text)) | ₹45/h with diarization ([pricing](https://www.sarvam.ai/api-pricing)) → **≈ ₹225** + an ID service | **unverified** | **unverified** |

**Reading the table.**
1. **Only Speechmatics does all of it in one realtime call:** diarization, enrolled identities, per-word labels and word timestamps, with a Node SDK and no stored realtime audio.
2. **pyannoteAI is the only one that reports overlap and per-speaker confidence,** but only as an async batch job with a 20 s billing minimum.
3. **OpenAI's diarize model identifies known speakers,** but only up to 4. Its references are 2-10 s of *raw audio* sent on every call, so we would have to store enrollment audio, which breaks #341's "no audio stored".
4. **Everyone else only diarizes.** Pairing any of them with a separate identifier (Eagle, or a self-hosted embedding model) is the DIY path the owner asked to avoid.
5. **Telugu is weak everywhere.** Only AWS, Deepgram, ElevenLabs and Sarvam list it, and none of them identifies enrolled voices.
6. **Newcomer search.** Searched for "speaker identification with enrolled voiceprints" from 2025-2026 vendors (Soniox, Mistral Voxtral, Sarvam, Gemini, Voicegain, hosted NVIDIA Riva). Soniox diarizes in realtime and batch without enrollment ([Soniox](https://soniox.com/docs/stt/concepts/speaker-diarization)); Voxtral Transcribe 2 diarizes in batch only and "with overlapping speech … typically transcribes one speaker" ([Mistral](https://mistral.ai/news/voxtral-transcribe-2/)). Gemini, Voicegain and Riva were **not checked**.

## Overlap and short answers

**Who flags overlap explicitly (as of 2026-09-26).**
- **pyannoteAI:** yes. Its diarization is overlap-aware by default, so two speakers can hold the same instant. `exclusive: true` adds a single-speaker view ([speaker config](https://docs.pyannote.ai/tutorials/speaker-configuration.md)). Precision-3 also returns a `crosstalkProbability` and takes a `crosstalkSensitivity` from −5 to 5, on `/identify` as well ([crosstalk](https://docs.pyannote.ai/tutorials/vad-crosstalk-sensitivity.md)). This maps directly onto #360's `overlap/unknown` label.
- **Speechmatics:** no overlap flag is documented (**unverified**). Each word carries exactly one `speaker` ([realtime diarization](https://docs.speechmatics.com/speech-to-text/realtime/realtime-diarization)). Overlap would show up only indirectly: `UU` labels, rapid speaker flips, or words missing from the transcript.
- **AssemblyAI streaming** says outright that it "assigns the entire overlapping segment to one speaker" ([blog](https://www.assemblyai.com/blog/streaming-speaker-diarization)). **Mistral Voxtral** "typically transcribes one speaker" in overlap ([Mistral](https://mistral.ai/news/voxtral-transcribe-2/)).
- **Everyone else** documents nothing about overlap.

**Short answers.** No vendor documents a minimum labelled segment, except AssemblyAI streaming. There, segments under 1 s "may come back as UNKNOWN", and "yes" or "no" may be unlabelled ([blog](https://www.assemblyai.com/blog/streaming-speaker-diarization)). That is the honest behaviour #360 wants, but AssemblyAI cannot identify enrolled voices. For every other service, **we must enforce #360's 0.7 s rule ourselves** from word or segment timestamps: a run of same-speaker words shorter than 0.7 s is relabelled `unknown`, whatever the vendor says.

**Published accuracy.** All figures are DER in %, lower is better. They come from long meetings and broadcasts, not 1-15 s household turns, so they overstate what we will see.

| Source | AMI (IHM / SDM) | DIHARD 3 | VoxConverse | Notes |
|---|---|---|---|---|
| pyannote.audio 3.1 (open) | 18.8 / 22.7 | 21.4 | 11.2 | [README](https://github.com/pyannote/pyannote-audio) |
| pyannote community-1 (open) | 17.0 / 19.9 | 20.2 | 11.2 | same |
| pyannoteAI precision-2 (hosted) | 12.9 / 15.6 | 14.7 | 8.5 | same; **vendor claim** |
| pyannoteAI precision-3 (hosted) | — | — | — | 14.35 average over 15 benchmarks; **vendor claim** ([blog](https://www.pyannote.ai/blog/precision-3-benchmarks), via search, **unverified**) |
| pyannoteAI Live-1 streaming vs Speechmatics realtime | — | 19.8 vs 31.3 | — | **vendor claim by a competitor**; most of Speechmatics' error is missed speech (19.7 %) ([blog](https://www.pyannote.ai/blog/streaming-diarization-benchmark)) |
| Picovoice Falcon vs pyannote.audio | — | — | 10.3 vs 9.0 | JER 19.9 vs 27.4; 0.1 GB vs 1.5 GB RAM; **vendor claim** ([benchmark](https://github.com/Picovoice/speaker-diarization-benchmark)) |
| NVIDIA Streaming Sortformer v2.1 (open, 4 speakers max) | 20.57 (SDM, 1.04 s latency) | 15.09 (≤ 4 spk), 41.42 (≥ 5 spk) | — | [model card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1) |
| DiariZen WavLM-L (open, non-commercial weights) | 14.0 (SDM) | 14.5 | 9.2 | CC BY-NC 4.0, so not usable ([DiariZen](https://github.com/BUTSpeechFIT/DiariZen)) |

What these numbers say for us:
- **Speechmatics publishes no DER.** Its own benchmark page says diarization "is not measured" ([accuracy](https://docs.speechmatics.com/speech-to-text/accuracy-benchmarking)). The only public number is a competitor's streaming comparison above.
- **More speakers is much harder.** Sortformer's DIHARD 3 DER nearly triples from ≤ 4 to ≥ 5 speakers (card above). A 6-player game is the hard end.
- **Short turns are hidden by DER.** Most scored time sits in long segments, so a one-word "Paris" barely moves DER even when it is misattributed. Balanced Error Rate was proposed to weight short and rare speakers fairly ([arXiv 2211.04304](https://ar5iv.labs.arxiv.org/html/2211.04304)). We found **no published speaker-attribution accuracy for turns under 2 s in 1-15 s clips**. That is why the bake-off scores *per answer*, not DER.
- **Children degrade diarization.** Adult-trained models show "substantial performance degradation" on children ([arXiv 2604.05201](https://arxiv.org/abs/2604.05201)). A foundation-model system cut child-adult speaker confusion by 62.3 % relative ([arXiv 2406.07890](https://arxiv.org/abs/2406.07890)). No vendor above makes a children's claim.
- **Identification on short audio is the weak link, not just diarization.** The per-turn survey cites EER rising from 2.4 % at 3 s to 18.4 % at 1 s for a WavLM + ECAPA baseline ([arXiv 2609.25007](https://arxiv.org/html/2609.25007), via `enrollment-and-turn-taking-research.md`). A 0.5 s "Rome" should therefore be `unknown` by default, and game design (#363) should ask for answers of at least a few words ("Alex says Rome") or use buzz-then-answer.

## Integration shape

**Today's seam.**
1. Frames are appended to `session.audioChunks` as they arrive (`apps/api/src/session.ts:738`).
2. At end of turn, `processTurn` concatenates them (`apps/api/src/turn.ts:918`), clears the buffer (`turn.ts:921`) and awaits `transcribeTurn` (`turn.ts:958`).
3. `transcribePcm` sends one WAV to `fish-audio/transcribe-1` through the AI Gateway and keeps only `text` (`apps/api/src/audio.ts:58-79`).

So today's STT is strictly *after the turn ends*, and the agent sees plain text.

**Recommended shape: replace STT for game turns only, at first.**
- **Game turns (multi-speaker mode, #360).** When a game (#342) or the Space setting turns on multi-speaker mode, open a Speechmatics Realtime session at turn start with:
  - `audio_format: {"type":"raw","encoding":"pcm_s16le","sample_rate":16000}`, which is exactly the Cardputer's uplink format, so no WAV wrapping or resampling is needed ([input](https://docs.speechmatics.com/speech-to-text/realtime/input));
  - `diarization: "speaker"` and `speaker_diarization_config.speakers` set to the Space's stored identifiers ([realtime identification](https://docs.speechmatics.com/speech-to-text/realtime/speaker-identification)).
- **Stream as it arrives.** At `session.ts:738`, forward each frame to the socket as well as buffering it. When the device ends the turn, send `ForceEndOfUtterance` to flush the finals ([end of turn](https://docs.speechmatics.com/speech-to-text/realtime/end-of-turn)). Recognition then overlaps the user's speech, and only the final flush sits on the critical path. That flush time, and therefore the ≤ 400 ms p95 budget (#360), is **unverified**; the docs give 0.7-4 s `max_delay` for finals in normal flow ([output](https://docs.speechmatics.com/speech-to-text/realtime/output)). It is bake-off metric L.
- **Hand-off.** A new adapter returns `{text, words:[{text,start,end,speaker}]}`. We map `speaker` to a profile (enrolled name → profile id; `S1`/`UU` → `unknown`), apply the 0.7 s rule, and give the agent "Sam: Paris. Alex: Rome" (#360).
- **Fallback in the turn.** If the socket fails or the budget is exceeded, fall back to today's buffered `transcribePcm` on the same `pcm` and journal `segmentation_timeout` (#360). The buffer is still built, so this costs nothing extra.
- **All other turns** stay on fish-audio through the Gateway, unchanged. Moving *all* turns to Speechmatics is a separate decision. It would put per-turn identification (#356) on the same call for free, but it takes STT off the Gateway and loses Gateway model switching. Take that decision after the bake-off, on accuracy and latency evidence.

**Why not the other shapes.**
- **pyannoteAI `/identify` beside STT.** It is an async job taking a URL or a `media://` upload that is kept for 48 h ([retention](https://docs.pyannote.ai/data-retention.md)). It cannot see audio before the turn ends, adds a poll or webhook round trip, and would need our STT to return word timestamps (it drops them today, `audio.ts:75-79`) so we could align segments to words. Use it as an overlap and accuracy reference, not as the live path.
- **OpenAI `gpt-4o-transcribe-diarize`.** One post-turn HTTP call, but only 4 known speakers, no Realtime sessions, segment-level labels only, and it needs raw reference audio on every call ([guide](https://developers.openai.com/api/docs/guides/speech-to-text)). Keeping that audio breaks #341.
- **Diarize-only STT plus our own identifier** (Deepgram or AssemblyAI streaming plus Eagle or sherpa-onnx per segment). It works technically, but it is the DIY path, and we would own the segment-to-profile scoring.

**Web surface.** `POST /api/voice` (`apps/api/src/web-voice.ts:100`, per the privacy research) receives a whole 16 kHz WAV, so it would use Speechmatics Batch or a Realtime session fed from the buffer. Both give the same labels ([batch identification](https://docs.speechmatics.com/speech-to-text/batch/speaker-identification)).

**Enrollment.** Speechmatics identifiers are generated from 5-30 s solo clips and returned to us. We store the encrypted identifier strings, never the audio. They are tied to the model version and must be regenerated after a model update ([feature](https://docs.speechmatics.com/speech-to-text/features/speaker-identification)). Because no audio is kept, a model update means everyone re-enrolls. #354 needs `provider`, `model_id` and a `needs_reenroll` state, as the per-turn survey already says.

## Cost model

Basis: 200 turns/day × 30 days × 3 s = 5 h of audio per household per month (6,000 turns). Prices as of 2026-09-26. "Game-only" assumes 20 % of turns are game turns (1 h/month), which is an **estimate**.

| Option | Billing basis | All turns /hh/mo | Game-only /hh/mo | Notes |
|---|---|---|---|---|
| Speechmatics Realtime (Pro "from $0.129/h" to Enhanced $0.43/h) | Audio seconds streamed; no separate ID charge shown | **$0.65-2.15** | **$0.13-0.43** + fish-audio stays for the rest | Replaces STT for those turns. Standard and Enhanced rates are **unverified** ([pricing](https://www.speechmatics.com/pricing)) |
| pyannoteAI `/identify` (Precision-3 €0.112/h, 20 s minimum per job) | Per job, at least 20 s | **≈ €3.73** (33.3 h billed) | **≈ €0.75** | Plus our STT; plus €0.015 per voiceprint; whether the €0.096/h identification rate is added on top is **unverified** ([pricing](https://www.pyannote.ai/pricing), [billing](https://docs.pyannote.ai/administration/billing.md)) |
| OpenAI `gpt-4o-transcribe-diarize` | Tokens (≈ $0.36/h estimate) | **≈ $1.80** | **≈ $0.36** | Reference audio tokens are re-sent on every call and would add to this (**unverified**) |
| Picovoice Falcon + Eagle, Foundation plan | $6,000/yr flat, 10K Eagle min/month included (**unverified**) | $500/month fleet-wide; Eagle minutes cover ≈ 33 households at 5 h | ≈ 166 households at 1 h | Startups only; Falcon has no Node SDK ([Falcon](https://github.com/Picovoice/falcon)) |
| Deepgram or AssemblyAI streaming + a separate identifier | STT + diarization | $2.05 / $1.35 | $0.41 / $0.27 | Plus the identifier's cost, plus our engineering |

A billing minimum matters more than the headline rate here: pyannoteAI's 20 s job minimum makes each 3 s turn cost as much as 20 s of audio. That is 6.7 times the headline rate, because we cannot batch without breaking latency. Speechmatics names no per-session minimum (**unverified**).

## Recommendation

**Primary: Speechmatics Realtime with speaker identification, for game turns (multi-speaker mode) only.**

It is the only managed service found that gives, in one streaming call:
- diarization;
- identification against enrolled identifiers, with unenrolled voices labelled `S1`/`UU` rather than guessed;
- per-word speaker labels with word timestamps.

It also takes our raw 16 kHz PCM16 frames as they arrive, has a Node SDK, and does not store realtime audio (sources in *Options compared*). At about $0.13-0.43 per household per month for game-only use, cost is not the constraint.

We add two guards on top, because Speechmatics does not provide them:
1. the 0.7 s short-segment rule, applied from word timestamps;
2. an overlap heuristic, which labels a segment `overlap/unknown` on rapid speaker flips or `UU` words inside one answer window.

**Fallback: pyannoteAI `/identify` (Precision-3) beside our STT**, used when:
- Speechmatics fails attribution or unknown rejection in the bake-off; or
- overlap handling turns out to decide the games.

It is the only service with explicit overlap (`crosstalkProbability`) and a per-speaker confidence and threshold. The costs are:
- it is async, so its latency must be measured;
- it has a 20 s billing minimum;
- `media://` uploads are kept 48 h, which needs #353 sign-off;
- fish-audio must be changed to return word timestamps for alignment, or each segment transcribed separately.

**Not recommended:**
- **OpenAI `gpt-4o-transcribe-diarize`:** at most 4 known speakers, and it needs stored raw reference audio.
- **Picovoice Falcon + Eagle:** no Falcon Node SDK, two engines to join, and included minutes that cover only about 33 households.
- **Diarize-only vendors:** DIY identification on top.

**What would change it:**
- **Speechmatics' final-flush latency after `ForceEndOfUtterance`** exceeds #360's 400 ms p95 on real turns. Then relax the budget for games (the #363 answer windows are seconds long), or move to pyannoteAI if it is faster. Neither latency is published.
- **Speechmatics mislabels short answers** (below 90 % attribution on 1-3 s answers) while pyannoteAI passes. Then switch to the fallback.
- **pyannoteAI ships voiceprint identification on Live-1 streaming.** It has none today ([Live-1 blog](https://www.pyannote.ai/blog/introducing-live-1-streaming-diarization)). That would give streaming, overlap and scores in one service, so re-run the bake-off.
- **OpenAI accepts stored speaker embeddings instead of raw audio, or raises the 4-speaker cap.** Then it becomes a candidate.
- **Telugu becomes a requirement.** None of the identifying services lists Telugu; Speechmatics lists Hindi ([languages](https://docs.speechmatics.com/speech-to-text/languages)).
- **Every service fails on 1-3 s answers.** Then games switch to buzz-then-answer or round-robin by name (#363 options b and c), and voice attribution becomes a confirmation hint only.

## Test protocol

A multi-voice fixture bake-off for #360, run on the harness from #361. The time box is 3 working days.

**Candidates.**
- **A.** Speechmatics Realtime with identifiers (EU1). PCM is streamed at real-time pace with `ForceEndOfUtterance` at the end of the turn.
- **B.** pyannoteAI `/identify` (Precision-3, `exclusive: false`), plus fish-audio for the words. It runs only with #353 sign-off, because of the 48 h `media://` retention.
- **C (optional reference).** OpenAI `gpt-4o-transcribe-diarize` with at most 4 references, for 2- and 4-speaker cases only. Reference clips are deleted after the run.

**Panel and consent.**
- 8 or more consented people (#353), including 2 or more children with parental consent, one sibling pair and one same-sex adult pair.
- 6 people are enrolled; 2 or more are held out as unknowns.
- Enrollment is 2 solo clips of 10-15 s each, on the Cardputer at 0.5 m and 1 m.

**Fixtures.** All are recorded through the real paths (Cardputer `/v2/cardputer` PCM and the web `use-voice.ts` WAV), at 0.5-2 m.

| Set | Speakers per turn | Pattern | Answer length | Count |
|---|---|---|---|---|
| S2 | 2 | sequential ("Sam says Paris, Alex says Rome") | 1-3 s each | 20 |
| S4 | 4 | sequential | 1-3 s each | 15 |
| S6 | 6 | sequential | 1-3 s each | 10 |
| O2 | 2 | overlapping by 0.3-1 s | 1-3 s each | 15 |
| O4 | 4 | two pairs overlapping | 1-3 s each | 10 |
| U | 2-4 | one or more held-out unknown speakers mixed in | 1-3 s | 15 |
| K | 2-4 | at least one child speaker | 1-3 s | 15 |
| T | 2-4 | TV speech in the background; plus 5 TV-only clips | 1-3 s | 15 + 5 |
| X | 1 | single speaker in multi-speaker mode (no spurious splits) | 2-8 s | 15 |

Every fixture has a hand-made truth file: `[{start_ms, end_ms, speaker: pseudonym | unknown | overlap, words}]`.

**Metrics.** Report each per candidate, per set, and for adults vs children:
- **Attribution accuracy:** the share of truth answers whose words carry the right enrolled label, scored per answer, not by DER. Pass: at least 90 % on S2 and S4 (#360). S6 is reported.
- **Unknown rejection:** the share of held-out-speaker, TV and overlap answers labelled `unknown` or `overlap`. Pass: at least 90 %. Also report **false attribution**, meaning an enrolled name on a wrong or unknown voice, which is the costliest error in a game.
- **Short-answer honesty:** answers under 0.7 s must be `unknown` (#360).
- **Latency:** p50 and p95 from the last PCM frame to the final labelled words, with the same clock for all candidates. Target ≤ 400 ms p95 (#360). Report candidate A's `ForceEndOfUtterance` flush time on its own.
- **Spurious splits** on set X: none in at least 95 % (#360).
- Plus: word error rate against the truth words, and cost per fixture hour.

**No audio stored.**
- Fixtures live only on the owner's encrypted local disk, outside the repo and CI, and are deleted at the end of the spike (the #352 exception).
- Candidate A runs in Realtime mode, which is not stored. B runs only with #353 sign-off.
- The repo keeps only pseudonymous truth files, per-answer labels, latencies and the accuracy table. No identifiers, voiceprints or reference clips are kept.

**Decision rule.** Choose A if it passes attribution, unknown rejection and latency. Otherwise choose B if it passes. If neither passes on 1-3 s answers but both pass on 3-8 s, adopt the #363 fallback of buzz-then-answer or round-robin, with voice as a hint.

## Impact on existing issues

- **#341 (epic scope).** The centre of gravity moves from per-turn identification (#356) to multi-speaker attribution (#360).
  - The epic's single-speaker targets (EER ≤ 5 %, ≤ 150 ms added) should get a sibling target for games, stated per answer: attribution ≥ 90 %, unknown rejection ≥ 90 %, and the #360 latency budget.
  - If Speechmatics is chosen, "managed vendor" means an STT swap for game turns, not an add-on beside STT.
- **#352 (vendor spike).** Its per-turn recommendation (Eagle primary, Speechmatics hosted alternative) was written before the scope change. For multi-speaker turns, Eagle has no diarizer and Falcon has no Node SDK, so **Speechmatics becomes the lead candidate**. The #352 bake-off should share fixtures with the protocol above, so one recording session serves both.
- **#356 (per-turn identification).** Unchanged for non-game turns. If the bake-off later moves all turns to Speechmatics, #356's identification comes from the same call, and its "parallel with STT" design no longer applies.
- **#360 (multi-speaker).**
  - The "sliding window of embeddings with change detection" component becomes a **vendor adapter** plus two local guards: the 0.7 s rule and the overlap heuristic.
  - The "word timestamps from fish-audio" question is moot for game turns, because Speechmatics returns them.
  - The ≤ 400 ms p95 budget is **unverified** against any vendor and may need relaxing for games (see *Recommendation*).
  - #360's non-goal of "more than 4 speakers" conflicts with a 6-player game; the S6 set measures it.
- **#361 (harness).**
  - The harness must score **per answer** (attribution, unknown rejection, false attribution), not only EER or DER.
  - It must store truth files and labels, never audio or vendor identifiers.
  - Speechmatics gives labels without scores, so no EER can be computed for it.
- **#363 (game turn-taking).** Voice attribution on 1-3 s answers is the weakest link. The published evidence covers long meetings, not short answers.
  - The decision record should keep buzz-then-answer (b) or round-robin (c) as the default until the bake-off shows at least 90 % attribution.
  - Open floor (a) and collect-all (d) depend on #360 passing.
  - Asking players to answer with their name ("Alex says Rome") gives both a longer voiced segment and a content cue.

## Sources

All read on 2026-09-26 with WebSearch and WebFetch, unless marked as a search snippet or third party in the text.

- **Speechmatics:**
  - [speaker identification](https://docs.speechmatics.com/speech-to-text/features/speaker-identification)
  - [realtime identification](https://docs.speechmatics.com/speech-to-text/realtime/speaker-identification)
  - [batch identification](https://docs.speechmatics.com/speech-to-text/batch/speaker-identification)
  - [realtime diarization](https://docs.speechmatics.com/speech-to-text/realtime/realtime-diarization)
  - [batch diarization](https://docs.speechmatics.com/speech-to-text/batch/batch-diarization)
  - [realtime output and `max_delay`](https://docs.speechmatics.com/speech-to-text/realtime/output)
  - [end of turn](https://docs.speechmatics.com/speech-to-text/realtime/end-of-turn)
  - [realtime input formats](https://docs.speechmatics.com/speech-to-text/realtime/input)
  - [languages](https://docs.speechmatics.com/speech-to-text/languages)
  - [security and compliance](https://docs.speechmatics.com/administration/security-and-compliance)
  - [accuracy benchmarking](https://docs.speechmatics.com/speech-to-text/accuracy-benchmarking)
  - [pricing](https://www.speechmatics.com/pricing)
  - [JS SDK](https://github.com/speechmatics/speechmatics-js-sdk)
- **pyannoteAI:**
  - [identify](https://docs.pyannote.ai/api-reference/identify.md)
  - [diarize](https://docs.pyannote.ai/api-reference/diarize.md)
  - [voiceprint](https://docs.pyannote.ai/api-reference/voiceprint.md)
  - [identification with voiceprints](https://docs.pyannote.ai/tutorials/identification-with-voiceprints)
  - [speaker configuration](https://docs.pyannote.ai/tutorials/speaker-configuration.md)
  - [crosstalk](https://docs.pyannote.ai/tutorials/vad-crosstalk-sensitivity.md)
  - [streaming](https://docs.pyannote.ai/tutorials/streaming-real-time.md)
  - [models](https://docs.pyannote.ai/models.md)
  - [billing](https://docs.pyannote.ai/administration/billing.md)
  - [data retention](https://docs.pyannote.ai/data-retention.md)
  - [pricing](https://www.pyannote.ai/pricing)
  - [Live-1 blog](https://www.pyannote.ai/blog/introducing-live-1-streaming-diarization)
  - [streaming benchmark](https://www.pyannote.ai/blog/streaming-diarization-benchmark)
  - [precision-3 benchmarks](https://www.pyannote.ai/blog/precision-3-benchmarks)
  - [pyannote-audio README](https://github.com/pyannote/pyannote-audio)
- **Picovoice:**
  - [Falcon docs](https://picovoice.ai/docs/falcon/)
  - [Falcon web quick start](https://picovoice.ai/docs/quick-start/falcon-web/)
  - [Falcon repo](https://github.com/Picovoice/falcon)
  - [Eagle Node API](https://picovoice.ai/docs/api/eagle-nodejs/)
  - [Eagle product](https://picovoice.ai/products/voice/speaker-recognition/)
  - [pricing (search snippet)](https://picovoice.ai/pricing/)
  - [diarization benchmark](https://github.com/Picovoice/speaker-diarization-benchmark)
- **OpenAI:**
  - [speech to text guide](https://developers.openai.com/api/docs/guides/speech-to-text)
  - [gpt-4o-transcribe-diarize](https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize)
  - [your data](https://developers.openai.com/api/docs/guides/your-data)
  - [costgoat estimate](https://costgoat.com/pricing/openai-transcription)
- **Deepgram:**
  - [diarization](https://developers.deepgram.com/docs/diarization)
  - [discussion 475](https://github.com/orgs/deepgram/discussions/475)
  - [languages](https://developers.deepgram.com/docs/models-languages-overview)
  - [pricing](https://deepgram.com/pricing)
  - [MIP opt-out](https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program)
- **AssemblyAI:**
  - [speaker identification](https://www.assemblyai.com/docs/speech-understanding/speaker-identification)
  - [identification blog](https://www.assemblyai.com/blog/assemblyai-speaker-identification-diarization)
  - [streaming diarization](https://www.assemblyai.com/blog/streaming-speaker-diarization)
  - [Universal-3.5 Pro realtime](https://www.assemblyai.com/blog/universal-3-5-pro-realtime)
  - [pricing](https://www.assemblyai.com/pricing)
- **Gladia:**
  - [diarization](https://docs.gladia.io/chapters/audio-intelligence/speaker-diarization)
  - [support article](https://support.gladia.io/article/how-to-detect-speakers-and-understand-who-said-what)
  - [retention](https://docs.gladia.io/chapters/limits-and-specifications/data-retention.md)
  - [re-identification blog](https://www.gladia.io/blog/speaker-re-identification-across-recurring-meetings)
- **ElevenLabs:**
  - [STT](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)
  - [realtime API](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)
  - [API pricing](https://elevenlabs.io/pricing/api)
  - [zero retention](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode)
- **Rev.ai:**
  - [FAQ](https://docs.rev.ai/faq)
  - [streaming](https://docs.rev.ai/api/streaming/)
  - [pricing](https://www.rev.ai/pricing)
- **Google:**
  - [Chirp 3](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3)
  - [Chirp 2](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-2)
  - [data logging](https://docs.cloud.google.com/speech-to-text/docs/data-logging)
  - [third-party pricing](https://brasstranscripts.com/blog/google-cloud-speech-to-text-pricing-2025-gcp-integration-costs)
- **Azure:**
  - [retirement](https://github.com/MicrosoftDocs/azure-ai-docs/blob/main/articles/ai-services/speech-service/includes/retire-speaker-recognition.md)
  - [Q&A on diarization](https://learn.microsoft.com/en-us/answers/questions/4372751/azure-real-time-diarization)
  - [diarization quickstart](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-stt-diarization)
  - [fast transcription](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create)
  - [third-party pricing](https://brasstranscripts.com/blog/azure-speech-services-pricing-2025-microsoft-ecosystem-costs)
- **AWS:**
  - [diarization](https://docs.aws.amazon.com/transcribe/latest/dg/diarization.html)
  - [languages](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html)
  - [Voice ID end of support](https://docs.aws.amazon.com/connect/latest/adminguide/amazonconnect-voiceid-end-of-support.html)
  - [third-party pricing](https://costgoat.com/pricing/amazon-transcribe)
- **Newcomers:**
  - [Sarvam diarization](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/how-to/enable-speaker-diarization)
  - [Sarvam STT](https://www.sarvam.ai/apis/speech-to-text)
  - [Sarvam pricing](https://www.sarvam.ai/api-pricing)
  - [Soniox diarization](https://soniox.com/docs/stt/concepts/speaker-diarization)
  - [Mistral Voxtral Transcribe 2](https://mistral.ai/news/voxtral-transcribe-2/)
- **Benchmarks and papers:**
  - [Streaming Sortformer v2.1](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)
  - [DiariZen](https://github.com/BUTSpeechFIT/DiariZen)
  - [Balanced Error Rate, arXiv 2211.04304](https://ar5iv.labs.arxiv.org/html/2211.04304)
  - [children's diarization, arXiv 2604.05201](https://arxiv.org/abs/2604.05201)
  - [child-adult diarization, arXiv 2406.07890](https://arxiv.org/abs/2406.07890)
  - [short-utterance EER, arXiv 2609.25007](https://arxiv.org/html/2609.25007)
- **Bob:**
  - issues #341, #352, #356, #360, #361 and #363 (#360 and #363 read with `gh issue view`)
  - `origin/main2` docs: `docs/voice-id/speaker-id-service-research.md`, `docs/privacy/voiceprints-research.md`, `docs/voice-id/enrollment-and-turn-taking-research.md`
  - code at `9d6655d`: `apps/api/src/turn.ts`, `apps/api/src/audio.ts`, `apps/api/src/session.ts`
