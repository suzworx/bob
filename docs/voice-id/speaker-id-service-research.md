# Speaker identification: service research for spike #352

Research date: 2026-09-26. Every price, status and retirement date below was read on that date and will drift; re-check before signing anything. A claim marked **unverified** could not be confirmed from a primary source on that date. Numbers are labelled **vendor**, **paper**, **estimate** or **measured**. Nothing here is measured yet; measuring is the job of the bake-off.

**How this was researched.** The first pass read primary sources with `curl` and `gh api`: vendor docs, the npm registry, the arXiv API and GitHub. A second pass on the same day re-checked the claims with WebSearch and WebFetch. That pass:

- corrected the Google, Nuance and pyannoteAI-billing entries;
- flagged conflicting Picovoice benchmark figures;
- added GoVivace, VeriSpeak, the 2025 exit of the big clouds from voice biometrics, and 2024-2025 US biometric law changes.

Each claim carries its source inline.

## Context

Epic #341 wants Bob to know which enrolled household member (up to 6) is speaking on every turn, and to reject unknown speakers. Its targets are: EER ≤ 5 %, ≥ 95 % closed-set identification, ≥ 90 % unknown-speaker rejection, and ≤ 150 ms added p95 latency while running in parallel with STT. Voice ID is a convenience hint and never authentication (#341, #358). The owner's direction for #352 is to **buy a managed service unless the evidence shows no service fits**.

Code facts this research is grounded on (HEAD 9d6655d, re-checked on 2026-09-26):

- **Audio is in memory only.** `processTurn` (`apps/api/src/turn.ts:915`) builds `pcm` with `assemblePcm16` and clears `session.audioChunks` straight away (`turn.ts:918-922`). The STT call is `await transcribeTurn(session, pcm, …)` at `turn.ts:958`. `pcm` is a complete Buffer before that call, so a speaker-ID call can sit beside it in a `Promise.all`.
- `transcribePcm` (`apps/api/src/audio.ts:58`) wraps 16 kHz mono PCM16 as WAV. Clips shorter than `MIN_STT_AUDIO_MS = 300` are never sent (`apps/api/src/core/turn-core.ts:22`).
- **Cardputer turn shape** (#417):
  - A turn ends after 1200 ms of silence and is capped at 15 s (`apps/cardputer/include/end_of_speech.h:28,30`).
  - The follow-up window is 6 s, with at most 2 follow-ups per wake (`apps/cardputer/include/follow_up.h:16,33`).
  - So **1-2 s follow-up turns are normal**, well under the 2-8 s range that #341's accuracy target assumes.
- **Cardputer mic:** 16 kHz with the default M5 mic config (`apps/cardputer/src/audio_capture.cpp:26`), no AGC and no noise filter.
- **No on-device ID.** The ESP32-S3 has no PSRAM (`docs/cardputer/wake-word-decision.md`).
- **Web voice:** `POST /api/voice` (`apps/api/src/web-voice.ts:100`) returns `{text}`. The browser re-encodes audio to 16 kHz WAV (`apps/ui-v2/src/lib/use-voice.ts`), and hands-free mode cuts utterances with Silero VAD.
- **STT is `fish-audio/transcribe-1` through the Vercel AI Gateway** (`apps/ai/src/config.ts:56`). Our wrapper returns only `text`, `model` and usage seconds, so any segments or word timestamps are dropped (`apps/ai/src/tools.ts:265-275`).
- **Deploy:** Railway, Node, a slim Docker image. There is no GPU, no Python and no onnxruntime today (`docs/deploy.md`).
- **Database:** Supabase Postgres with pgvector already in use for 1536-d text memory. Space members must be auth users, and a device belongs to one user (#341, #354).

## Managed services compared

"Per household" assumes **200 turns/day × 30 days = 6,000 turns/month** and an average turn of **3 s** (estimate: 1-2 s follow-ups mixed with 3-8 s wake turns). That is 5 h of audio per household per month.

| Service | Status on 2026-09-26 | Matches enrolled voiceprints? | Enrollment / shortest utterance | Latency mode, region | Price → per household/month | Data handling | Node SDK | Children / far-field |
|---|---|---|---|---|---|---|---|---|
| **Picovoice Eagle** (licensed SDK that runs in our Node process) | Live. v3.0.0 released 2026-04-06; `@picovoice/eagle-node` 3.0.1 published 2026-05-06 ([releases](https://github.com/Picovoice/eagle#releases), [npm](https://registry.npmjs.org/@picovoice/eagle-node)) | **Yes.** `EagleProfiler.enroll()` builds a profile; `Eagle.process(audio, profiles)` returns one score per profile ([README](https://github.com/Picovoice/eagle#nodejs)) | Enrollment runs until `enroll()` reports 100 %. The profiler wants a single speaker, a normal voice and a quiet room ([Node API](https://picovoice.ai/docs/api/eagle-nodejs/)). The seconds needed are not published; the vendor's marketing line is "Enroll users in seconds and identify who's speaking in a word or two" ([product page](https://picovoice.ai/products/voice/speaker-recognition/)). The shortest input is exposed as `minProcessSamples` at runtime, with no documented value ([Node API](https://picovoice.ai/docs/api/eagle-nodejs/)). Text-independent ([README](https://github.com/Picovoice/eagle)) | Synchronous and in-process; no network hop per turn. Runs on Linux x86_64, Node ≥ 18 ([README](https://github.com/Picovoice/eagle), [npm](https://registry.npmjs.org/@picovoice/eagle-node/latest)). Per-turn CPU time **unverified** | **No price on the live site** (as of 2026-09-26): `picovoice.ai/pricing` redirects to a contact form. There is a one-time free trial and "no dedicated free or paid plans for personal or non-commercial use" ([FAQ](https://picovoice.ai/docs/faq/general/)). Search-engine snippets of [picovoice.ai/pricing](https://picovoice.ai/pricing/) and [/checkout](https://picovoice.ai/checkout/) describe a **Foundation Plan at $6,000/year**: self-service, for startups under 5 years old with under $50 M raised and at most 20 staff, covering all engines. This figure is **unverified** on the live page. A search summary also claimed Enterprise starts at $30,000/year, but the page it cited says "Picovoice does not publish fixed paid-plan pricing" ([checkthat.ai](https://checkthat.ai/brands/picovoice/pricing), updated 2026-05-29), so that figure is dropped | Audio never leaves our server ("All voice processing runs locally"). The profile is a `Uint8Array` that **we store**. The AccessKey needs internet to validate the licence and to meter usage ([README](https://github.com/Picovoice/eagle#accesskey)) | Yes (`@picovoice/eagle-node`, SDK code Apache-2.0; the engine is proprietary) | No vendor claim for children, far-field or anti-spoofing ([product page](https://picovoice.ai/products/voice/speaker-recognition/), read 2026-09-26). Vendor benchmark: EER 0.18 % against pyannote 0.49 % and SpeechBrain 0.70 %; model 4.48 MB ([benchmark](https://github.com/Picovoice/speaker-recognition-benchmark#results)). The **product page swaps the two baselines** (SpeechBrain 0.49 %, pyannote 0.70 %), so the vendor's own figures conflict. Treat all three as vendor claims |
| **Speechmatics** (hosted STT with speaker identification) | Live. Speaker identification is available in Batch, Realtime and Agent STT ([docs](https://docs.speechmatics.com/speech-to-text/features/speaker-identification)) | **Yes.** Enrolled "speaker identifiers" are passed in each session, and matching speakers are labelled by name; anyone else gets a generic label such as S1 ([realtime docs](https://docs.speechmatics.com/speech-to-text/realtime/speaker-identification)) | 5-30 s clips per speaker, ideally speaking alone; several clips per person are allowed; at most 50 identifiers per session ([docs](https://docs.speechmatics.com/speech-to-text/features/speaker-identification)). Shortest identifiable utterance **unverified** | Realtime WebSocket. The final transcript comes 0.7-4 s after the end of a word (`max_delay`) ([output docs](https://docs.speechmatics.com/speech-to-text/realtime/output)). Regions EU1, US1, AU1 ([regions](https://docs.speechmatics.com/administration/regions)) | Realtime Standard $0.24/h, Enhanced $0.43/h; Pro plan "from $0.129/hr" ([pricing](https://www.speechmatics.com/pricing)). **About $1.20-2.15** for 5 h. This **replaces** STT spend rather than adding to it. Volume discounts apply automatically above 500 h/month per STT type ([pricing](https://www.speechmatics.com/pricing)). The page names no separate charge for diarization or identification and no per-session minimum; both are **unverified**. Prices as of 2026-09-26, read from the static page table | Realtime audio "is never recorded or stored"; ISO 27001, SOC 2 Type II, GDPR ([security](https://docs.speechmatics.com/administration/security-and-compliance)). Identifiers are encrypted, scoped to our account and project, and **we store** them. They are tied to the model version and must be regenerated after a model update ([docs](https://docs.speechmatics.com/speech-to-text/features/speaker-identification)) | Yes (`@speechmatics/real-time-client` 8.5.1, [npm](https://registry.npmjs.org/@speechmatics/real-time-client/latest)) | No children or far-field claim (**unverified**) |
| **pyannoteAI** (hosted API) | Live, with `/v1/voiceprint` and `/v1/identify` endpoints ([docs index](https://docs.pyannote.ai/llms.txt)) | **Yes.** `/identify` runs diarization and matches up to 50 voiceprints, with a `threshold` (0-100) and `exclusive` matching ([identify API](https://docs.pyannote.ai/api-reference/identify.md), [FAQ](https://docs.pyannote.ai/support/faqs.md)) | One voiceprint per speaker from ≤ 30 s of single-speaker audio ([tutorial](https://docs.pyannote.ai/tutorials/identification-with-voiceprints.md)). Shortest identifiable utterance **unverified** | **Asynchronous jobs** (submit, then poll or webhook). Audio arrives by URL or through a `media://` upload ([tutorial](https://docs.pyannote.ai/tutorials/identification-with-voiceprints.md)). The live WebSocket stream only diarizes, with no voiceprints documented ([streaming](https://docs.pyannote.ai/tutorials/streaming-real-time.md)) | Every job is billed at least 20 s ([billing](https://docs.pyannote.ai/administration/billing.md)). Developer plan €19/month at €0.112/h (Precision-3); voiceprints €0.015 each ([pricing](https://www.pyannote.ai/pricing)). Identification is billed "per audio hour processed. Same hourly rate as Precision-3 diarization" ([models](https://www.pyannote.ai/md/models)). 6,000 jobs × 20 s = 33.3 h, so **about €3.73** (Developer) plus the plan fee. Prices as of 2026-09-26 | No training on customer data; job outputs, including voiceprints, are deleted after 24 h; `media://` uploads are kept up to **48 h**. The DPA is part of the terms of use ([retention](https://docs.pyannote.ai/data-retention.md)). pyannoteAI keeps no voiceprint database: **we store** the voiceprints ([tutorial](https://docs.pyannote.ai/tutorials/identification-with-voiceprints.md)) | No official Node SDK; plain REST with `fetch` ([tutorial](https://docs.pyannote.ai/tutorials/identification-with-voiceprints.md)) | No children or far-field claim (**unverified**) |
| **Phonexia Voice Verify** | Live, deployed on-premises or in a private cloud ([product](https://www.phonexia.com/product/voice-verify/)) | Yes (voiceprints) | "3 seconds of net speech"; "20+ seconds of net speech creates a robust referential voiceprint" ([product](https://www.phonexia.com/product/voice-verify/)) | We host it (Docker); latency **unverified** | Sales only (**unverified**) | Stays in our infrastructure | Node SDK **unverified** (REST) | Aimed at public-safety and call-centre use |
| **ID R&D IDVoice** (part of Mitek Systems since its $49 M acquisition in 2021) | ID R&D is "now part of Mitek" ([Mitek](https://www.miteksystems.com/idrnd-mitek); [Biometric Update, 2021](https://www.biometricupdate.com/202106/mitek-to-integrate-id-rd-biometrics-for-full-transaction-lifecycle-security-in-49m-acquisition)). IDVoice Server is a Docker image with REST and WebSocket APIs ([examples](https://github.com/IDRnD/idvoice-docker-examples)). On 2026-09-26, idrnd.ai timed out, so current packaging is **unverified** | Yes (voiceprints). IDLive Voice clone detection scores 3 s of speech for cloning ([Mitek press release](https://www.miteksystems.com/press-releases/id-rd-introduces-voice-clone-detection-for-protection-against-gen-ai-based-identity)) | **unverified** | Self-hosted, or cloud per Mitek ([Mitek](https://www.miteksystems.com/idrnd-mitek)); latency **unverified** | Sales only (**unverified**) | Stays in our infrastructure if self-hosted | JS examples for its REST API ([examples](https://github.com/IDRnD/idvoice-docker-examples)) | **unverified** |
| **GoVivace Speaker ID API** (found during verification) | Hosted at `services.govivace.com`. The spec is undated ([spec](https://govivace.com/documentation/speaker-id-api-specification/)), so current status is **unverified** | Yes. "Voiceprints … are stored internally in the server" ([spec](https://govivace.com/documentation/speaker-id-api-specification/)) | Repeat enrollment "until enrollment_audio_time is 60 seconds or more" ([spec](https://govivace.com/documentation/speaker-id-api-specification/)) | REST, or WebSocket streaming ended by an "EOS" marker ([spec](https://govivace.com/documentation/speaker-id-api-specification/)); region **unverified** | Not published (**unverified**) | **Vendor stores the voiceprints**, which makes deletion and BIPA handling harder for us; DPA **unverified** | None found (plain REST/WS) | **unverified**. 60 s of enrollment per child is a heavy ask |
| **Neurotechnology VeriSpeak** (found during verification) | SDK; brochure dated 2026-03-12 ([VeriSpeak](https://www.neurotechnology.com/verispeak.html)) | Yes. Mainly text-dependent, with a "phrase-independent" mode ([VeriSpeak](https://www.neurotechnology.com/verispeak.html)) | **unverified** | We host it (Windows, Linux, macOS, iOS, Android) ([VeriSpeak](https://www.neurotechnology.com/verispeak.html)) | Pricing calculator or sales (**unverified**) | Stays in our infrastructure | **No Node SDK listed** ([VeriSpeak](https://www.neurotechnology.com/verispeak.html)) | Liveness means saying an enrolled phrase, which does not suit free-form turns |

**Diarization only: they cannot match anyone against enrolled voiceprints.** These label speakers as "speaker 0" or "speaker 1" within a single file, which is useful for #360 but not for #356.

- **Deepgram.** Offers versioned diarizer models (batch v2, streaming v1) that label a speaker on every word. Its docs describe no enrollment or voiceprints ([diarization](https://developers.deepgram.com/docs/diarization.md)).
- **Gladia.** `"diarization": true` gives each utterance a `speaker` index ([diarization](https://docs.gladia.io/chapters/audio-intelligence/speaker-diarization.md)).
- **ElevenLabs Scribe.** Diarizes up to 32 speakers and returns a `speaker_id` such as `speaker_0` on each word ([STT](https://elevenlabs.io/docs/overview/capabilities/speech-to-text.md)).
- **AssemblyAI "Speaker Identification".** This is **not voiceprint-based**. It "uses conversation content to infer who's speaking" and needs "no voice enrollment". It can only name someone whose name, or a role clue, appears in the transcript ([docs](https://www.assemblyai.com/docs/speech-understanding/speaker-identification)). That is useless for "who said *turn on the lights*".
- **Google Cloud.** Speech-to-Text offers diarization only ([multiple voices](https://docs.cloud.google.com/speech-to-text/docs/multiple-voices)). Google's voiceprint product, **Speaker ID**, launched in 2021 for caller authentication in Dialogflow CX and was only available on paid accounts ([Google Cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/google-cloud-announces-speaker-id); [SiliconANGLE, 2021-10-01](https://siliconangle.com/2021/10/01/speaker-id-callers-can-now-use-voice-authenticate/)). It has been **withdrawn without a formal notice**: Google "removed all references to Speaker ID from its website" ([CX Today, 2025-08-14](https://www.cxtoday.com/contact-center/aws-google-have-left-the-voice-biometrics-market-microsoft-is-retreating-why/)), and "the company has not issued a formal announcement" ([ID Tech, 2025-08-15](https://idtechwire.com/aws-and-microsoft-exit-voice-biometrics-as-google-pulls-back-amid-deepfake-risks/)). Its docs pages return 404 as of 2026-09-26. It was also an authentication product, which is a non-goal for #341.
- **Gladia, again.** A Gladia post dated 2026-08-21 confirms there is no native re-identification: "the vector database and embedding extraction layer sit outside our API" ([Gladia blog](https://www.gladia.io/blog/speaker-re-identification-across-recurring-meetings)).
- **Vercel AI Gateway.** The public model list (`https://ai-gateway.vercel.sh/v1/models`, read 2026-09-26) has transcription models and text-embedding models: `fish-audio/transcribe-1`, `google/gemini-3.5-transcribe`, `openai/gpt-4o-transcribe` and others. It has **no speaker-embedding or speaker-ID model**.

**Ruled out, with dates:**

- **Microsoft Azure AI Speaker Recognition.** "Retired on September 30th, 2025. Applications can no longer use the speaker recognition APIs" ([Microsoft docs](https://github.com/MicrosoftDocs/azure-ai-docs/blob/main/articles/ai-services/speech-service/includes/retire-speaker-recognition.md)). The old overview URL now redirects to the Speech overview.
- **Amazon Connect Customer Voice ID.** It stopped taking new customers on 2025-05-20, and AWS ended support on **2026-05-20** ([AWS](https://docs.aws.amazon.com/connect/latest/adminguide/amazonconnect-voiceid-end-of-support.html)). It was also tied to Connect telephony.
- **Nuance Gatekeeper (Microsoft).** It "hasn't been 'officially' on sale since July 2024, although it's still being bought and used, with no end-of-life date set" ([CX Today, 2025-08-14](https://www.cxtoday.com/contact-center/aws-google-have-left-the-voice-biometrics-market-microsoft-is-retreating-why/)). Its sales teams left in July 2024, and the products are "off sale (although some exceptions are being made)" ([Opus Research, 2025-08-13](https://opusresearch.net/2025/08/13/microsofts-voice-biometrics-retreat-what-practitioners-need-to-know/)). The old product URL now redirects to a Microsoft health-solutions page (2026-09-26). It is also a contact-centre authentication product, which is out of scope.
- **Context: the big clouds have left voice biometrics.** AWS and Google have exited, and Microsoft is retreating ([CX Today, 2025-08-14](https://www.cxtoday.com/contact-center/aws-google-have-left-the-voice-biometrics-market-microsoft-is-retreating-why/)). Press coverage ties this partly to deepfake risk ([ID Tech, 2025-08-15](https://idtechwire.com/aws-and-microsoft-exit-voice-biometrics-as-google-pulls-back-amid-deepfake-risks/)). Buying from a small specialist vendor is now the only "buy" path, so vendor viability is a risk in its own right.
- **Pindrop (Passport, Pulse).** Pindrop sells phone-channel caller authentication ("Authenticate known callers") and deepfake detection for contact centres ([Pindrop](https://www.pindrop.com/products/pindrop-passport/)). It does not fit a household assistant. Pindrop Pulse is noted under replay and clone risks.
- **VoiceIt.** The site now sells "Biometric Access Protection", which is authentication. `voiceit2-nodejs` was last published on 2022-05-23 ([npm](https://registry.npmjs.org/voiceit2-nodejs)). A stale SDK with an authentication focus is a poor fit.
- **Google Cloud Speaker ID.** Withdrawn without a formal date: public references were removed by August 2025 (see above).
- **AssemblyAI, Deepgram, Gladia and ElevenLabs** are out for #356 because they only diarize (see above). They are still usable for #360 segmentation.

**Notes that decide the choice:**

1. **Only two hosted APIs identify against enrolled voiceprints in 2026: pyannoteAI and Speechmatics.** Azure and AWS, the two big-cloud options named in #352, are gone.
2. **pyannoteAI cannot meet the latency budget per turn.** It only offers asynchronous jobs: upload or URL, then poll or webhook. Its identification is batch-only, and every job bills at least 20 s even though our turns average about 3 s. It is a good accuracy reference, but not a per-turn service. Its `media://` uploads persist for up to 48 h, which sits badly with #341's "no raw audio is ever stored" and needs #353 sign-off.
3. **Speechmatics bundles identification with STT.** Using it means replacing `fish-audio/transcribe-1` and moving STT off the Vercel AI Gateway for voice turns. The speaker label arrives with the transcript, so identification adds no extra latency beyond STT itself. In return, we get only a label and **no per-candidate score** (**unverified**: the docs describe labels and a `speakers_sensitivity` knob, and no scores). That makes EER and threshold tuning (#361) hard to measure honestly.
4. **Picovoice Eagle is "buy" but not "hosted".** We pay a vendor for the model and its updates, and it runs inside our Node process. It is the only option that returns per-profile scores synchronously, with no network hop per turn and no audio leaving our server. Its risks:
   - the price is unknown until sales quotes it;
   - it needs an internet licence check (an outage risk; what happens when the check fails is **unverified**);
   - the trial is one-time only.

## Self-hosted fallback

Use this only if no bought option passes the bake-off. The best CPU-only route in Node is **`sherpa-onnx-node`** running a WeSpeaker or 3D-Speaker ONNX speaker-embedding model. Its embeddings go into pgvector, and matching is by cosine similarity, which is the design #354 and #356 already assume.

- **Runtime.** `sherpa-onnx-node` 1.13.8 is Apache-2.0 and was last modified on 2026-09-10 ([npm](https://registry.npmjs.org/sherpa-onnx-node)). It ships prebuilt native addons and bundles its own ONNX Runtime, so it **adds a native dependency to the slim Docker image**. `docs/deploy.md` has no onnxruntime today. `onnxruntime-node` with hand-written fbank feature extraction is the alternative, with more code of our own.
- **Models.** Ready-made ONNX files sit in the `speaker-recongition-models` release (the tag's spelling), read with `gh api repos/k2-fsa/sherpa-onnx/releases/tags/speaker-recongition-models` on 2026-09-26:

| Model (ONNX file) | Size | VoxCeleb1-O EER | Embedding dim | Licence and caveat |
|---|---|---|---|---|
| `wespeaker_en_voxceleb_resnet34_LM.onnx` | 26.5 MB | 0.69 % (ResNet34, large-margin fine-tuned) ([WeSpeaker results](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md)) | 256 (`ResNet34-TSTP-emb256`, same source) | "The pretrained model … follows the license of its corresponding dataset": **CC BY 4.0** for VoxCeleb ([WeSpeaker](https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md)) |
| `wespeaker_en_voxceleb_CAM++.onnx` | 29.3 MB | 0.80 % ([WeSpeaker results](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md)) | 512 (**unverified**) | Same CC BY 4.0 dataset licence |
| `3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx` | 29.6 MB | 0.73 % (0.65 % with large-margin fine-tuning) ([3D-Speaker](https://github.com/modelscope/3D-Speaker/blob/main/egs/voxceleb/sv-cam++/README.md)) | 192 (**unverified**) | 3D-Speaker code is Apache-2.0; the licence of the ModelScope weights is **unverified** |
| `nemo_en_titanet_large.onnx` | 101 MB | 0.66 % ([model card](https://huggingface.co/nvidia/speakerverification_en_titanet_large)) | 192 (**unverified**) | **CC BY 4.0** ([model card](https://huggingface.co/nvidia/speakerverification_en_titanet_large)) |

- **Training-data caveat.** Every model above is trained on VoxCeleb, which is YouTube interviews of adult celebrities. The CC BY 4.0 licence allows commercial use with attribution. Using biometric models derived from scraped YouTube speech is still a legal-review item for #353 (**unverified**: no ruling found). VoxCeleb also has almost no children, and it is near-field web audio rather than a far-field MEMS mic.
- **CPU latency for 3-5 s of audio: unverified. Estimate: tens of ms.**
  - WeSpeaker lists CAM++ at 1.15 GFLOPs and ResNet34 at 4.55 GFLOPs ([results](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md)). The audio length those figures assume is **unverified**.
  - On one modern x86 core, that is roughly 10-80 ms (estimate). It must be measured on Railway, which is bake-off metric M5.
- **RAM.** Model file plus runtime, **about 60-150 MB resident** (estimate from the file sizes above; to be measured).
- **Cost.** No per-call fee. The marginal CPU time for 6,000 turns/month is a few CPU-minutes per household (estimate).
- **What we would own.** Model updates, score normalisation, and noise and far-field robustness. The owner asked to avoid exactly this, so it stays a fallback.

## Multi-speaker turns

What #360 needs from a provider: who spoke when, and a way to line that up with the words.

| Option | Diarization and identification in one call? | Word timestamps? | Notes |
|---|---|---|---|
| Speechmatics Realtime | **Yes.** Diarization plus enrolled-speaker labels ([docs](https://docs.speechmatics.com/speech-to-text/realtime/speaker-identification)) | Yes: words carry times and speaker labels ([docs](https://docs.speechmatics.com/speech-to-text/realtime/realtime-diarization.md)) | The only option that gives #360's labelled transcript ("Sam: Paris. Alex: Rome") from one call |
| pyannoteAI `/identify` | **Yes.** Diarization plus voiceprint matching per segment ([identify API](https://docs.pyannote.ai/api-reference/identify.md)) | Only through its "STT Orchestration" on `/diarize` ([STT orchestration](https://docs.pyannote.ai/tutorials/speech-to-text-diarization.md)). **Unverified** whether `/identify` and transcription combine in one job | Asynchronous, so it cannot meet #360's ≤ 400 ms p95 budget |
| Picovoice Eagle | No diarizer. `process()` scores short windows against every profile, so change detection is a sliding window of scores we build ourselves (#360 option A) | No (Eagle does not transcribe) | Picovoice sells a separate diarization SDK, Falcon, listed in its docs navigation ([docs](https://picovoice.ai/docs/eagle/)). It was not evaluated here |
| Deepgram, Gladia, ElevenLabs Scribe | Diarization only ([Deepgram](https://developers.deepgram.com/docs/diarization.md), [Gladia](https://docs.gladia.io/chapters/audio-intelligence/speaker-diarization.md), [ElevenLabs](https://elevenlabs.io/docs/overview/capabilities/speech-to-text.md)) | Yes, per word | Would still need an identification step per segment |
| Our current STT (`fish-audio/transcribe-1`) | No | **Unknown.** Our wrapper keeps only `text` (`apps/ai/src/tools.ts:265-275`), so any segments the provider returns are dropped today | #360's "transcribe each segment separately" route works with any STT, at the cost of extra STT calls |

## Risks and accuracy caveats

Vendor and VoxCeleb EERs of 0.2-0.8 % come from clean, near-field adult speech. None of them predicts our conditions, so #361 must measure them.

- **Short 1-2 s follow-up turns.** Accuracy falls as enrollment and test audio get shorter, a long-standing result in speaker verification ([Sarkar et al., "Quality Measures for Speaker Verification with Short Utterances"](https://arxiv.org/abs/1901.10345)). #341's targets are stated for 2-8 s turns, but our follow-ups (`follow_up.h:16,33`) are often shorter. Mitigation to test in the bake-off:
  - a follow-up inside the 6 s window **inherits the wake turn's speaker**, unless ID confidently disagrees;
  - a turn under about 1 s is labelled `unknown`, never a guess. This matches #360's 0.7 s rule.
- **Far-field MEMS mic at 0.5-2 m.** The Cardputer mic has no AGC and no noise filter (`audio_capture.cpp:26`). Reverberation and distance degrade speaker embeddings enough that there is a dedicated far-field challenge ([FFSVC 2020 system paper](https://arxiv.org/abs/2008.03521); [far-field SV](https://arxiv.org/abs/2311.15627)). Enroll on the **same device and distance** people will use. Speechmatics recommends enrolling "multiple clips recorded under different acoustic conditions" ([docs](https://docs.speechmatics.com/speech-to-text/features/speaker-identification)).
- **Children and siblings.** ASV systems trained on adults "drop substantially when applied to children's speech" ([ChildAugment, arXiv 2402.15214](https://arxiv.org/abs/2402.15214); see also [arXiv 2502.10511](https://arxiv.org/abs/2502.10511)). Children's voices also change as they grow, so profiles need periodic re-enrollment. Siblings of similar age are the hardest case of all (**unverified**: no vendor publishes sibling numbers). No vendor above makes a children's-accuracy claim. The bake-off reports children separately (#361 per-group reporting).
- **TV audio.** TV speech is not an enrolled voice, so good unknown rejection handles it. The risk is TV plus a real speaker in one turn: the TV voice can drag the embedding. This needs a "TV on" fixture condition (#361 already lists it).
- **Replays and voice clones (informational only).** ASVspoof 5 found that "attacks significantly compromise the baseline systems" ([ASVspoof 5, arXiv 2408.08739](https://arxiv.org/abs/2408.08739); [asvspoof.org](https://www.asvspoof.org/)).
  - Of the vendors above, these sell anti-spoofing:
    - ID R&D's IDLive Voice clone detection ([Mitek](https://www.miteksystems.com/press-releases/id-rd-introduces-voice-clone-detection-for-protection-against-gen-ai-based-identity));
    - Pindrop Pulse ([Pindrop](https://www.pindrop.com/products/pindrop-passport/));
    - VeriSpeak, whose liveness check is a spoken enrolled phrase ([VeriSpeak](https://www.neurotechnology.com/verispeak.html)).
  - Picovoice's product page makes no anti-spoofing claim ([product page](https://picovoice.ai/products/voice/speaker-recognition/), 2026-09-26). We found no such claim from Speechmatics or pyannoteAI either (**unverified**).
  - This is acceptable only because voice ID is never authentication (#341, #358). A cloned voice can at most read that person's "my reminders", so #358 must keep sensitive data behind an account session.
- **Law (input for #353, not legal advice; as of 2026-09-26).** The choice of vendor changes who holds biometric data, and two recent changes matter:
  - **Colorado HB24-1130** took effect on 2025-07-01. It adds voiceprints to the Colorado Privacy Act's biometric rules: notice before collection, affirmative consent, and a written retention and deletion policy. It has no private right of action ([Colorado General Assembly](https://leg.colorado.gov/bills/hb24-1130); [Forbes, 2025-06-27](https://www.forbes.com/sites/alonzomartinez/2025/06/27/colorados-biometric-privacy-law-takes-effect-july-1-are-you-ready/)).
  - **Illinois BIPA** was amended by SB 2979, signed on 2024-08-02. Repeated collection from the same person by the same method is now a single violation, and consent can be given by electronic signature ([Covington Inside Privacy](https://www.insideprivacy.com/data-privacy/illinois-enacts-bipa-amendment-limiting-violation-accrual/)). Per-turn identification is still collection, so written consent is required before enrollment.
  - **Who holds the data.** Vendors that keep voiceprints on their side (GoVivace) add a processor holding biometric data. Eagle keeps nothing outside our database. Speechmatics and pyannoteAI return identifiers or voiceprints that we store (see the table).
- **Model churn.** Speechmatics identifiers must be regenerated whenever its model is updated ([docs](https://docs.speechmatics.com/speech-to-text/features/speaker-identification)). Eagle v2 to v3 "improved the enrollment and recognition process" ([releases](https://github.com/Picovoice/eagle#releases)); whether v2 profiles still work on v3 is **unverified**. Any vendor update may force every household to re-enroll, and **no audio is kept** to re-enroll from. #354's `model_id` column and a "please re-enroll" flow are therefore mandatory.

## Cost model

Assumptions: 6,000 turns per household per month, 3 s average (5 h of audio), up to 6 enrolled people each re-enrolled twice a year (estimate). Prices were read on 2026-09-26.

| Option | Per-turn charge basis | Per household / month | Fixed cost | Source |
|---|---|---|---|---|
| Picovoice Eagle | Flat annual licence; the usage limits are set by plan and visible in the Console ([README](https://github.com/Picovoice/eagle#accesskey)). Whether those limits count per call, per user or per device is **unverified** | **If** the $6,000/year Foundation Plan applies and its limits cover us: $500/month in total, so $0.50 per household at 1,000 households or $0.05 at 10,000 (estimate) | $6,000/year Foundation Plan (search snippet only, **unverified**; startups only), otherwise an Enterprise quote | [search snippet of picovoice.ai/pricing](https://picovoice.ai/pricing/), [FAQ](https://picovoice.ai/docs/faq/general/) |
| Speechmatics Realtime Standard / Enhanced | Seconds of audio streamed | **$1.20 / $2.15**. This *replaces* STT spend, so the net change is that minus today's fish-audio STT cost (not computed here) | Pay as you go; $100 free credit | [pricing](https://www.speechmatics.com/pricing) |
| pyannoteAI `/identify` | Seconds, with a **20 s minimum per job** | **About €3.73** (Developer) or **€3.20** (Starter €0.096/h). Identification bills at the Precision-3 rate ([models](https://www.pyannote.ai/md/models)); voiceprints are €0.015 each | €19 or €99 per month per account (includes that much usage) | [billing](https://docs.pyannote.ai/administration/billing.md), [pricing](https://www.pyannote.ai/pricing) |
| Self-hosted sherpa-onnx | CPU time on the existing container | **About $0** marginal (estimate) | Engineering and maintenance time, which the owner wants to avoid | Estimate |

Batching turns into one pyannote job would dodge the 20 s minimum, but it breaks per-turn latency, so we do not batch.

## Recommendation

**Primary: Picovoice Eagle**, a bought and vendor-maintained engine running inside our Node process. It is chosen because it is the only bought option that meets all three hard constraints at once:

- a synchronous per-turn call that can sit in `Promise.all` next to `transcribeTurn` (`turn.ts:958`), with no network hop;
- per-profile scores that #361 can turn into an EER and two thresholds;
- raw audio never leaving our server, which is the simplest position for #353 (BIPA and GDPR Art. 9).

This is conditional on two things:

1. A written quote that fits a consumer product priced per household. The live site shows no price, and the trial is one-time ([FAQ](https://picovoice.ai/docs/faq/general/)). Search snippets show a $6,000/year Foundation Plan for startups under 5 years old, under $50 M raised, with at most 20 staff (**unverified**, see the cost model). If Bob qualifies and the plan's usage limits cover our households, the licence costs about $0.50 per household per month at 1,000 households (estimate).
2. The bake-off passing. Treat it as "buy the model", not "buy a hosted API". If the owner reads "managed" strictly as hosted, see the next point.

**Hosted alternative, run in the same bake-off: Speechmatics Realtime.** It is the only live hosted API with enrolled-voiceprint identification that can answer per turn, and it also solves #360: one call gives STT, diarization, speaker labels and word timestamps. The costs:

- replacing `fish-audio/transcribe-1` and leaving the AI Gateway for voice STT;
- labels without scores, which weakens the #361 harness (**unverified**);
- identifiers that must be regenerated whenever its model is updated.

**Fallback: self-hosted `sherpa-onnx-node` with WeSpeaker ResNet34-LM** (256-d, 0.69 % VoxCeleb1-O EER). Use it if Eagle's quote or accuracy fails and the owner will not move STT to Speechmatics.

**Ruled out for per-turn identification:**

- pyannoteAI: asynchronous only, with a 20 s minimum job and 48 h media retention. It is kept as an optional offline accuracy reference.
- AssemblyAI: infers speakers from content.
- Deepgram, Gladia, ElevenLabs and Google: diarization only.
- Azure: retired 2025-09-30.
- AWS Voice ID: ended 2026-05-20.

**Ruled out on the verification pass (2026-09-26):**

- GoVivace: it stores voiceprints on its own servers and needs 60 s of enrollment per person ([spec](https://govivace.com/documentation/speaker-id-api-specification/)).
- Neurotechnology VeriSpeak: no Node SDK, and it is mainly text-dependent ([VeriSpeak](https://www.neurotechnology.com/verispeak.html)).
- Google Speaker ID: withdrawn by August 2025 ([CX Today](https://www.cxtoday.com/contact-center/aws-google-have-left-the-voice-biometrics-market-microsoft-is-retreating-why/)).

**What would change the decision:**

- **The vendor weakens or exits.** All three big clouds have left or are leaving voice biometrics ([CX Today, 2025-08-14](https://www.cxtoday.com/contact-center/aws-google-have-left-the-voice-biometrics-market-microsoft-is-retreating-why/)). If Picovoice signals Eagle's end of life, move to the self-hosted fallback. Eagle profiles are vendor-format, so everyone must re-enroll either way.

- **Eagle's quote is not viable per household**, or its licence check cannot tolerate Railway restarts or outages. Then Speechmatics, if the owner accepts the STT swap; otherwise the self-hosted fallback.
- **Eagle's accuracy fails** on the 0.5-2 m Cardputer fixtures or on children while Speechmatics passes. Then Speechmatics.
- **Every option fails** the #341 targets on 1-2 s follow-ups, but passes on 2-8 s turns. Keep the chosen option and adopt "follow-ups inherit the wake turn's speaker". Revise #341's target so it applies to 2-8 s turns only.
- **Every option fails** on 2-8 s turns. Then **No-Go**: the epic narrows to "name or seat" identification, as #352 already allows.
- **A new hosted per-turn API with scores appears.** For example, if pyannoteAI adds voiceprints to its live WebSocket, which today only diarizes ([streaming](https://docs.pyannote.ai/tutorials/streaming-real-time.md)), re-run the bake-off with it.

## Bake-off protocol

This is the concrete #352 experiment. The time box is #352's 5 working days.

**Candidates:**

- **A.** Picovoice Eagle (free trial AccessKey), in-process through `@picovoice/eagle-node`.
- **B.** Speechmatics Realtime, EU1 or US1, with speaker identifiers.
- **C.** sherpa-onnx-node with WeSpeaker ResNet34-LM plus cosine scoring (the fallback, and our baseline).
- **D (optional).** pyannoteAI `/identify`, used only as an accuracy reference, and only if #353 approves its 48 h `media://` retention.

**Consent and who records.** The owner runs every session. Only volunteers who signed #353's consent take part, and for children a parent consents (`subject = parent` in #354). The target panel is 8 people:

- 6 are enrolled;
- 2 or more are held out as unknowns;
- the panel includes 2 or more children and, where possible, one sibling pair and one same-sex adult pair.

**Fixtures, per person:**

- **Enrollment.** 3 clips of 8-10 s each, spoken alone: Cardputer at 0.5 m in a quiet room, Cardputer at 1 m, and a laptop mic.
- **Test.** 24 utterances, spread across:
  - **length:** 1-2 s ("and tomorrow?"), 3-5 s, and 6-8 s;
  - **distance:** Cardputer at 0.5, 1 and 2 m, plus the laptop;
  - **condition:** quiet, TV on, and kitchen noise.
- **Extra clips:**
  - 10 two-speaker turns for #360, including 2 that overlap;
  - 5 TV-only clips with no one speaking;
  - 5 replays of an enrolled person played through a phone speaker (informational only).
- **Audio path.** Capture through the real paths: Cardputer `/v2/cardputer` PCM, and the web `use-voice.ts` re-encode. That way the gain and codec match production.

**The no-audio rule.** Bob systems, the repo, CI and vendors keep **no audio**:

- Clips are held in RAM for each run. The only copies are on the owner's encrypted local disk, outside the repo, which is the exception #352 already allows. They are deleted at the end of the spike, and the deletion date is written in `docs/voice-id-decision.md`.
- Candidate B runs in Realtime mode, which never stores audio. Candidate D runs only with #353 sign-off.
- What is kept: pseudonymous labels (`spk_03`), per-trial scores, and C's embeddings, as #361 specifies. No Eagle profile bytes or Speechmatics identifiers are kept after the spike.

**Metrics.** Each is reported per candidate, per length bucket, per distance and per group (adult or child):

- **M1.** EER, from genuine and impostor scores. For B, which has labels only, report the confusion matrix and note that it has no EER.
- **M2.** Closed-set top-1 identification at the chosen `high` threshold, for household sizes 2, 4 and 6.
- **M3.** Unknown-speaker rejection: held-out speakers and TV-only clips returning `unknown`.
- **M4.** Multi-speaker attribution on the two-speaker turns, using #360's acceptance criteria.
- **M5.** Added latency: p50 and p95 of `max(0, t_id − t_stt)` when the two calls run in parallel on a Railway-sized container. For B, it is the extra time to the labelled final transcript compared with fish-audio.
- **M6.** RAM, cold start, and Docker image growth, for A and C.

**Pass thresholds** (on the 2-8 s buckets, at 0.5-1 m, with 6 enrolled):

- EER ≤ 5 %;
- top-1 identification ≥ 95 %;
- unknown rejection ≥ 90 %;
- added latency ≤ 150 ms at p95.

The 1-2 s and 2 m buckets are reported but do not gate. They decide whether follow-ups inherit the wake turn's speaker and whether #341's target wording changes. Any group, such as children, that falls more than 10 points below the adult top-1 is flagged to the owner before the decision.

**Decision rule.** Choose the cheapest candidate that passes. If both A and B pass, choose A, for the reasons under "Recommendation". If only C passes, choose C and record that "buy" failed on evidence. If nothing passes, No-Go.

## Impact on existing issues

- **#352 (spike).**
  - The artifact "a prototype embedding function on the server" becomes **a provider adapter prototype** behind `identify(audio, candidates)`.
  - The decision record also needs the vendor quote, licence-check behaviour, the DPA (for hosted options) and the profile format.
  - "Embedding dimension" applies only to the self-hosted fallback.
- **#354 (data model).**
  - `voice_embeddings.vector` (pgvector) is right only for the fallback. With Eagle, the stored item is an **opaque vendor profile** (`Uint8Array`); with Speechmatics, it is **encrypted identifier strings**. Neither is a vector we can compare with cosine similarity in SQL.
  - Add `provider` and a nullable `profile_blob bytea`, keep `vector` nullable, and keep `model_id` mandatory. Model updates force re-enrollment, so add a `needs_reenroll` state.
  - Deletion stays local for all three front-runners, because none of them keeps voiceprints on the vendor side.
- **#356 (per-turn identification).**
  - "Compared by cosine similarity against the stored vectors" becomes a **vendor scoring call**, for example Eagle `process(pcm, profiles)`.
  - With Speechmatics, identification is no longer "parallel with STT": it **is** the STT call. That changes the `transcribeTurn` seam and the Vercel AI Gateway dependency.
  - Add two acceptance criteria:
    - a follow-up turn inside the 6 s window inherits the wake turn's identity unless ID confidently disagrees;
    - a turn shorter than about 1 s is `unknown`.
  - The 300 ms model timeout and "the turn goes on as unknown" stay as written. So does the rule that the server never accepts a profile id from the client.
- **#360 (multi-speaker).**
  - Speechmatics satisfies "diarization plus identification plus word timestamps" in one call.
  - With Eagle or the fallback, #360 needs its own sliding-window change detection, because Eagle has no diarizer.
  - Word-timestamp alignment with fish-audio requires changing `apps/ai/src/tools.ts:265-275`, which drops everything except `text` today. Otherwise the "transcribe each segment" route is needed.
- **#361 (harness).**
  - "Embeddings in the repo" only works for the fallback. For Eagle or Speechmatics, the repo can store **per-trial scores or labels**, never vendor profiles.
  - Re-scoring after a vendor model update needs the audio, which is deleted after the spike. So a model change means **re-recording** the consented fixtures, and the harness must fail closed on a `model_id` mismatch, as it already says.
  - The "EER worsens by more than 1 point" regression gate cannot be computed for a labels-only provider such as Speechmatics (**unverified**: no scores documented). The gate becomes top-1 accuracy and unknown rejection.

## Sources

All sources were read on 2026-09-26.

- **Picovoice Eagle:** [README and releases](https://github.com/Picovoice/eagle), [npm @picovoice/eagle-node](https://registry.npmjs.org/@picovoice/eagle-node), [docs](https://picovoice.ai/docs/eagle/), [FAQ: business model, trial](https://picovoice.ai/docs/faq/general/), [speaker recognition benchmark](https://github.com/Picovoice/speaker-recognition-benchmark)
- **Speechmatics:** [speaker identification](https://docs.speechmatics.com/speech-to-text/features/speaker-identification), [realtime speaker identification](https://docs.speechmatics.com/speech-to-text/realtime/speaker-identification), [realtime diarization](https://docs.speechmatics.com/speech-to-text/realtime/realtime-diarization.md), [latency / max_delay](https://docs.speechmatics.com/speech-to-text/realtime/output), [regions](https://docs.speechmatics.com/administration/regions), [security and data handling](https://docs.speechmatics.com/administration/security-and-compliance), [pricing](https://www.speechmatics.com/pricing), [npm @speechmatics/real-time-client](https://registry.npmjs.org/@speechmatics/real-time-client/latest)
- **pyannoteAI:** [docs index](https://docs.pyannote.ai/llms.txt), [voiceprint identification](https://docs.pyannote.ai/tutorials/identification-with-voiceprints.md), [identify API](https://docs.pyannote.ai/api-reference/identify.md), [billing](https://docs.pyannote.ai/administration/billing.md), [data retention](https://docs.pyannote.ai/data-retention.md), [streaming](https://docs.pyannote.ai/tutorials/streaming-real-time.md), [FAQ](https://docs.pyannote.ai/support/faqs.md), [output scores](https://docs.pyannote.ai/tutorials/output-scores.md), [pricing](https://www.pyannote.ai/pricing)
- **AssemblyAI:** [speaker identification](https://www.assemblyai.com/docs/speech-understanding/speaker-identification)
- **Deepgram:** [diarization](https://developers.deepgram.com/docs/diarization.md)
- **Gladia:** [diarization](https://docs.gladia.io/chapters/audio-intelligence/speaker-diarization.md)
- **ElevenLabs:** [speech to text](https://elevenlabs.io/docs/overview/capabilities/speech-to-text.md)
- **Google:** [Speech-to-Text multiple voices](https://docs.cloud.google.com/speech-to-text/docs/multiple-voices); Speaker ID pages returned 404 on 2026-09-26
- **Vercel AI Gateway:** [model list](https://ai-gateway.vercel.sh/v1/models)
- **Retirements:**
  - [Azure Speaker Recognition retirement](https://github.com/MicrosoftDocs/azure-ai-docs/blob/main/articles/ai-services/speech-service/includes/retire-speaker-recognition.md)
  - [Amazon Connect Voice ID end of support](https://docs.aws.amazon.com/connect/latest/adminguide/amazonconnect-voiceid-end-of-support.html)
- **Others:**
  - [Phonexia Voice Verify](https://www.phonexia.com/product/voice-verify/)
  - [ID R&D GitHub](https://github.com/IDRnD) and [IDVoice Docker examples](https://github.com/IDRnD/idvoice-docker-examples)
  - [Pindrop Passport](https://www.pindrop.com/products/pindrop-passport/)
  - [npm voiceit2-nodejs](https://registry.npmjs.org/voiceit2-nodejs)
- **Self-hosted fallback:**
  - [npm sherpa-onnx-node](https://registry.npmjs.org/sherpa-onnx-node) and [sherpa-onnx speaker models release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)
  - [WeSpeaker pretrained models and licence](https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md) and [WeSpeaker VoxCeleb results](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md)
  - [3D-Speaker CAM++ VoxCeleb](https://github.com/modelscope/3D-Speaker/blob/main/egs/voxceleb/sv-cam++/README.md)
  - [NVIDIA TitaNet-L model card](https://huggingface.co/nvidia/speakerverification_en_titanet_large)
- **Accuracy and spoofing research:**
  - [short utterances, arXiv 1901.10345](https://arxiv.org/abs/1901.10345)
  - [ChildAugment, arXiv 2402.15214](https://arxiv.org/abs/2402.15214)
  - [children's SV, arXiv 2502.10511](https://arxiv.org/abs/2502.10511)
  - [FFSVC 2020 system, arXiv 2008.03521](https://arxiv.org/abs/2008.03521)
  - [far-field SV, arXiv 2311.15627](https://arxiv.org/abs/2311.15627)
  - [ASVspoof 5, arXiv 2408.08739](https://arxiv.org/abs/2408.08739)
  - [asvspoof.org](https://www.asvspoof.org/)
- **Added on the verification pass (WebSearch and WebFetch, 2026-09-26):**
  - **Picovoice:** [Eagle product page](https://picovoice.ai/products/voice/speaker-recognition/), [Eagle Node.js API](https://picovoice.ai/docs/api/eagle-nodejs/), [pricing (search snippet; the live page redirects)](https://picovoice.ai/pricing/), [checkout / Foundation Plan (search snippet)](https://picovoice.ai/checkout/), [checkthat.ai Picovoice pricing](https://checkthat.ai/brands/picovoice/pricing)
  - **pyannoteAI:** [models and identification billing](https://www.pyannote.ai/md/models)
  - **Google Speaker ID:** [Google Cloud announcement](https://cloud.google.com/blog/products/ai-machine-learning/google-cloud-announces-speaker-id), [SiliconANGLE 2021-10-01](https://siliconangle.com/2021/10/01/speaker-id-callers-can-now-use-voice-authenticate/)
  - **Big-cloud exits:** [CX Today 2025-08-14](https://www.cxtoday.com/contact-center/aws-google-have-left-the-voice-biometrics-market-microsoft-is-retreating-why/), [ID Tech 2025-08-15](https://idtechwire.com/aws-and-microsoft-exit-voice-biometrics-as-google-pulls-back-amid-deepfake-risks/), [Opus Research 2025-08-13](https://opusresearch.net/2025/08/13/microsofts-voice-biometrics-retreat-what-practitioners-need-to-know/)
  - **ID R&D / Mitek:** [ID R&D now part of Mitek](https://www.miteksystems.com/idrnd-mitek), [IDLive Voice clone detection](https://www.miteksystems.com/press-releases/id-rd-introduces-voice-clone-detection-for-protection-against-gen-ai-based-identity), [Biometric Update on the 2021 acquisition](https://www.biometricupdate.com/202106/mitek-to-integrate-id-rd-biometrics-for-full-transaction-lifecycle-security-in-49m-acquisition)
  - **Other vendors:** [GoVivace Speaker ID API spec](https://govivace.com/documentation/speaker-id-api-specification/), [Neurotechnology VeriSpeak](https://www.neurotechnology.com/verispeak.html), [Gladia speaker re-identification post, 2026-08-21](https://www.gladia.io/blog/speaker-re-identification-across-recurring-meetings)
  - **Law:** [Colorado HB24-1130](https://leg.colorado.gov/bills/hb24-1130), [Forbes on Colorado, 2025-06-27](https://www.forbes.com/sites/alonzomartinez/2025/06/27/colorados-biometric-privacy-law-takes-effect-july-1-are-you-ready/), [Illinois SB 2979 BIPA amendment](https://www.insideprivacy.com/data-privacy/illinois-enacts-bipa-amendment-limiting-violation-accrual/)
- **Bob issues** (read with `gh issue view`): #341, #352, #354, #356, #360, #361
