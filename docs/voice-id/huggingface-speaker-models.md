# Hugging Face models that tell who is speaking (identity only)

Research date: 2026-09-26. Download counts are the Hugging Face "last 30 days" figure, and last-update dates are `lastModified` values. Both were read from `https://huggingface.co/api/models/<id>` on that date. Prices were read on the same date and will drift. A claim marked **unverified** could not be confirmed from a primary source. Nothing here is measured: numbers are **card** (the model card), **paper**, **vendor** or **estimate**.

## Context

The owner's scope, 2026-09-26: "classification of people especially when multiple people are talking", and "no age, demographics needed". For each part of a recording with 2-6 people, the output is which enrolled household member said it, or `unknown`. The owner prefers hosted or managed options to DIY, and HF Inference Endpoints and HF Inference Providers count as hosted.

What this doc does **not** repeat:

- The commercial API survey (Picovoice Eagle, Speechmatics, pyannoteAI and the rest) is in `docs/voice-id/speaker-id-service-research.md` on `origin/main2`, and a sibling unit (VID-MULTI) is extending it.
- That survey's "Self-hosted fallback" already covers `sherpa-onnx-node` with WeSpeaker, 3D-Speaker and TitaNet ONNX files, their VoxCeleb EERs, sizes and CPU estimates. This doc adds the **diarization** layer, the HF-hosted deployment route and the cluster-to-person mapping.

Constraints carried over from that survey:

- Bob runs on Railway: Node, no GPU, no Python, no onnxruntime.
- Voiceprints go into Supabase pgvector.
- Cardputer turns are 1-15 s, and 1-2 s follow-ups are normal.

Two kinds of model matter here:

1. **Diarization** answers "who spoke when": anonymous labels such as `SPEAKER_00`, consistent within one recording.
2. **Speaker embedding** (verification) turns a stretch of speech into a vector. Comparing that vector with stored household voiceprints turns an anonymous label into a name.

No model on the Hub does both steps against *enrolled* people out of the box; you always glue 1 and 2 together (see [From clusters to named people](#from-clusters-to-named-people)).

## Models compared

Commercial use is judged from the licence tag on the card. Weights trained on VoxCeleb inherit that dataset's CC BY 4.0 terms ([WeSpeaker pretrained notes](https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md)); legal review stays with #353. "Gated" means the Hub asks you to accept conditions and share contact details before you can download.

### Diarization pipelines

| Model | Licence, gating | Downloads / last update | DER, card (lower is better) | Overlap | Streaming? | Max speakers | CPU, ONNX / Node |
|---|---|---|---|---|---|---|---|
| [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) | **CC-BY-4.0**, commercial OK; gated (accept conditions) | 5,463,929 / 2025-09-29 | AMI-IHM 17.0 %, DIHARD3 20.2 %, VoxConverse 11.2 %, CALLHOME 26.7 % | Yes: overlapped speech is detected, plus an `exclusive_speaker_diarization` output with one speaker at a time ([card](https://huggingface.co/pyannote/speaker-diarization-community-1)) | Offline only | Unbounded; `num_speakers` / `min_speakers` / `max_speakers` hints ([card](https://huggingface.co/pyannote/speaker-diarization-community-1)) | Runs on CPU, but CPU speed is unpublished (**unverified**). H100: 31 s per hour of audio ([pyannote-audio](https://github.com/pyannote/pyannote-audio)). pyannote.audio 4.0 **dropped ONNX runtime support** ([CHANGELOG](https://raw.githubusercontent.com/pyannote/pyannote-audio/main/CHANGELOG.md)); Python only |
| [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) (legacy) | **MIT**; gated | 7,376,915 / 2024-05-10 | AMI-IHM 18.8 %, DIHARD3 21.7 %, VoxConverse 11.3 % ([card](https://huggingface.co/pyannote/speaker-diarization-3.1)) | Yes (evaluated with overlap and no collar, per the card) | Offline | Unbounded, same hints | Pure PyTorch, "removes the problematic use of onnxruntime" ([card](https://huggingface.co/pyannote/speaker-diarization-3.1)) |
| [pyannote/speaker-diarization-precision](https://huggingface.co/pyannote/speaker-diarization-precision) | A thin client: "runs `Precision` speaker diarization on pyannoteAI cloud" and needs a pyannoteAI API key ([card](https://huggingface.co/pyannote/speaker-diarization-precision)) | 15,585 / 2026-09-18 | precision-2: AMI-IHM 12.9 %, DIHARD3 14.7 %, VoxConverse 8.5 %, CALLHOME 16.6 % ([community-1 card](https://huggingface.co/pyannote/speaker-diarization-community-1)) | Yes | Async jobs; covered by the main2 survey | — | Not an HF-hosted model: it is pyannoteAI's API, already costed in the main2 survey |
| [nvidia/diar_streaming_sortformer_4spk-v2.1](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1) | **NVIDIA Open Model License** (Hub `license: other`, `license_name: nvidia-open-model-license`). "Models are commercially usable". Anyone redistributing the model needs a Notice file, and the licence ends on patent or copyright litigation or on guardrail bypass ([licence](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/), last modified 2025-10-24). Not gated | 114,258 / 2026-09-23 | At 1.04 s latency: DIHARD3 15.09 % (≤ 4 speakers), 41.42 % (≥ 5); CALLHOME-part2 6.65 / 11.25 / 13.35 % (2 / 3 / 4 speakers); AMI-IHM 16.67 % ([card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)) | Yes: end-to-end, with per-frame activity for each of 4 speakers | **Streaming**; 1.04 s latency at RTF 0.093 on an RTX 6000 Ada ([card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)) | **4**; "performance degrades" at 5 or more ([v2 card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2)) | GPU-benchmarked, CPU speed **unverified**. NeMo/Python; community GGUF and CoreML ports exist ([HF search](https://huggingface.co/api/models?search=sortformer&sort=downloads&direction=-1)) |
| [nvidia/diar_streaming_sortformer_4spk-v2](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2) | **CC-BY-4.0** | 40,027 / 2026-09-23 | DIHARD3 13.24 % (≤ 4 speakers, post-processed); CALLHOME-part2 6.57 / 10.05 / 12.44 % ([card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2)) | Yes | Streaming; ultra-low mode 0.32 s latency at RTF 0.180 | 4 | As v2.1 |
| [nvidia/diar_sortformer_4spk-v1](https://huggingface.co/nvidia/diar_sortformer_4spk-v1) | **CC-BY-NC-4.0: not commercial** | 105,066 / 2026-09-23 | DIHARD3 14.76 %; CALLHOME 5.85 / 8.46 / 12.59 % ([card](https://huggingface.co/nvidia/diar_sortformer_4spk-v1)) | Yes | Offline | 4 | — |
| [BUT-FIT/diarizen-wavlm-large-s80-md-v2](https://huggingface.co/BUT-FIT/diarizen-wavlm-large-s80-md-v2) | **CC-BY-NC-4.0: not commercial**, because "some training datasets are research-only or non-commercial" ([card](https://huggingface.co/BUT-FIT/diarizen-wavlm-large-s80-md-v2)) | 2,047 / 2026-08-31 | Collar 0: AMI 13.9 %, DIHARD3 14.5 %, VoxConverse 9.1 %, versus pyannote 3.1 at 22.4 / 21.7 / 11.3 % on the same card | Yes, up to 4 overlapping speakers | Offline | Pipeline clusters globally; 4 overlapping per frame | 63.3 M parameters after pruning, 3.8 GMACs per second of audio ([card](https://huggingface.co/BUT-FIT/diarizen-wavlm-large-s80-md-v2)); CPU speed unpublished |
| [BUT-FIT/diarizen-wavlm-base-s80-md](https://huggingface.co/BUT-FIT/diarizen-wavlm-base-s80-md) | **CC-BY-NC-4.0: not commercial** | 225 / 2026-08-31 | AMI 15.8 %, DIHARD3 15.9 %, VoxConverse 9.7 % ([card](https://huggingface.co/BUT-FIT/diarizen-wavlm-base-s80-md)) | Yes | Offline | As above | 18.8 M parameters, 1.1 GMACs per second of audio (card) |
| [onnx-community/pyannote-segmentation-3.0](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) | **MIT**, not gated | 12,449 / 2025-07-08 | None: this is only the segmentation stage | Up to 2 speakers per frame ([segmentation-3.0 card](https://huggingface.co/pyannote/segmentation-3.0)) | Works on 10 s windows | 3 per 10 s chunk; it "cannot be used to perform speaker diarization of full recordings on its own" ([card](https://huggingface.co/pyannote/segmentation-3.0)) | **Runs in Node** through Transformers.js ([card](https://huggingface.co/onnx-community/pyannote-segmentation-3.0)). sherpa-onnx also ships it with a clustering step and Node bindings ([sherpa-onnx diarization](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html)) |

Speaker labels from every row above are anonymous. None of the cards documents a way to attach enrolled names.

**Hub check.** `hf models info <id> --format json` was run on every model in this section and the next, on 2026-09-26. Licence tag, `gated`, downloads and `lastModified` **matched every row**; the only correction was the Sortformer v2.1 licence cell. The pipeline tag and library the Hub reports:

| Model | `pipeline_tag` | `library_name` | Gated (Hub) |
|---|---|---|---|
| pyannote/speaker-diarization-community-1 | automatic-speech-recognition | pyannote-audio | `auto`. The prompt asks for company or university and a use case, and agreeing lets pyannote "email you occasionally … invitations to try premium pipelines" (card metadata `extra_gated_prompt`) |
| pyannote/speaker-diarization-3.1 | automatic-speech-recognition | pyannote-audio | `auto`. It asks for company or university and a website; the licence stays MIT (card metadata) |
| pyannote/segmentation-3.0 | voice-activity-detection | pyannote-audio | `auto` |
| pyannote/speaker-diarization-precision | voice-activity-detection | pyannote-audio | no (no licence tag) |
| nvidia/diar_streaming_sortformer_4spk-v2.1, -v2, diar_sortformer_4spk-v1 | automatic-speech-recognition | nemo | no |
| BUT-FIT/diarizen-wavlm-large-s80-md-v2 | voice-activity-detection | transformers | no |
| BUT-FIT/diarizen-wavlm-base-s80-md | none | none | no |
| onnx-community/pyannote-segmentation-3.0 | none | transformers.js | no |
| pyannote/wespeaker-voxceleb-resnet34-LM | none | pyannote-audio | no |
| speechbrain/spkrec-ecapa-voxceleb | none | speechbrain | no |
| nvidia/speakerverification_en_titanet_large | none | nemo | no |
| Wespeaker/wespeaker-voxceleb-redimnet2-B6-LM, Wespeaker/wespeaker-voxceleb-campplus-LM | none | none | no |
| funasr/campplus | audio-classification | funasr | no |
| soniqo/ReDimNet2-B6-ONNX-FP32 | audio-classification | onnx | no |
| microsoft/wavlm-base-plus-sv | none (no licence tag either) | transformers | no |

The Hub's `pipeline_tag` for the pyannote and NVIDIA diarizers is `automatic-speech-recognition`, even though they do no transcription. So filtering the Hub by task will not find them; search by name instead.

**Also found by `hf models list --search`, not added as rows:**

- [litert-community/Speaker-Diarization-LiteRT](https://huggingface.co/litert-community/Speaker-Diarization-LiteRT) (MIT, 213 downloads, 2026-09-08) is an on-device port of the pyannote 3.1 recipe: segmentation ONNX plus a WeSpeaker ResNet34 TFLite that outputs a 256-d embedding. Its card reports 186 ms p50 on a Raspberry Pi 5 CPU, but for what input length is **unverified**. It shows the recipe runs on small CPUs; it is not a hosted option.
- [christopherthompson81/sortformer_parakeet_onnx](https://huggingface.co/christopherthompson81/sortformer_parakeet_onnx) (mixed licence, 218 downloads) is an ONNX export of Streaming Sortformer v2.1 and Parakeet. It proves Sortformer can leave NeMo; it is still 4 speakers and unofficial.
- "speaker-verification", "speaker-recognition" and "speaker embedding" searches: beyond TitaNet, the results are small personal uploads (under 50 downloads) or non-commercial licences (for example `hynt/Speaker-Embedding-30M-Low-Quality-Speech`, CC-BY-NC-4.0). There are no new strong candidates.

### Speaker embedding and verification models

These turn a segment into a voiceprint. EER is on VoxCeleb1-O (cleaned) unless noted. Lower is better, and every figure is near-field adult web audio (see the main2 survey's caveats).

| Model | Licence, gating | Downloads / last update | EER | Dim | CPU, ONNX / Node |
|---|---|---|---|---|---|
| [pyannote/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM) | **CC-BY-4.0**, not gated | 6,298,868 / 2024-05-10 | 0.69 % ([WeSpeaker results](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md)) | 256 (same source) | This is the embedding model inside pyannote 3.1 and community-1, so its vectors share a space with the diarizer's clusters. An ONNX copy for sherpa-onnx is in the main2 survey |
| [speechbrain/spkrec-ecapa-voxceleb](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb) | **Apache-2.0**, not gated | 2,236,304 / 2025-02-18 | 0.80 % ([card](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb)) | 192 (**unverified**; not stated on the card) | SpeechBrain/PyTorch. The card scores by cosine similarity. No official ONNX |
| [nvidia/speakerverification_en_titanet_large](https://huggingface.co/nvidia/speakerverification_en_titanet_large) | **CC-BY-4.0** | 159,593 / 2023-11-14 | 0.66 % ([card](https://huggingface.co/nvidia/speakerverification_en_titanet_large)) | 192 (**unverified**) | 23 M parameters (card). Trained on more than VoxCeleb (Fisher, Switchboard, LibriSpeech, SRE), which may help on non-celebrity speech (**unverified**). ONNX via sherpa-onnx (main2 survey) |
| [Wespeaker/wespeaker-voxceleb-redimnet2-B6-LM](https://huggingface.co/Wespeaker/wespeaker-voxceleb-redimnet2-B6-LM) | **Apache-2.0** tag; the README is empty ([card](https://huggingface.co/Wespeaker/wespeaker-voxceleb-redimnet2-B6-LM)) | 2,730 / 2026-07-03 | ReDimNet (v1) B6: 0.40 %, or 0.37 % with LM and AS-norm; B2: 0.57 % at 4.7 M parameters ([IDRnD evaluation](https://github.com/IDRnD/redimnet/blob/master/EVALUATION.md)). The ReDimNet2 figure is **unverified** | **unverified** | Code is MIT ([IDRnD/redimnet](https://github.com/IDRnD/redimnet)). A community ONNX export exists, [soniqo/ReDimNet2-B6-ONNX-FP32](https://huggingface.co/soniqo/ReDimNet2-B6-ONNX-FP32) (MIT tag, 66 downloads): unofficial |
| [Wespeaker/wespeaker-voxceleb-campplus-LM](https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus-LM) and [funasr/campplus](https://huggingface.co/funasr/campplus) (3D-Speaker CAM++) | **Apache-2.0** (both tags) | 195 / 2024-05-06; 1,545 / 2026-06-19 | 0.73 %, or 0.65 % with LM ([3D-Speaker](https://github.com/modelscope/3D-Speaker/blob/main/egs/voxceleb/sv-cam++/README.md)) | 192 or 512 (**unverified**) | Light: 1.15 GFLOPs in WeSpeaker's table. ONNX via sherpa-onnx (main2 survey). 3D-Speaker's ERes2NetV2 targets short utterances ([paper](https://arxiv.org/html/2406.02167v1)), but its HF copies are small community uploads |
| [microsoft/wavlm-base-plus-sv](https://huggingface.co/microsoft/wavlm-base-plus-sv) | No licence tag on the Hub; the card points to the [UniSpeech licence](https://github.com/microsoft/UniSpeech/blob/main/LICENSE) (terms **unverified**) | 274,292 / 2022-03-25 | Not on the card (**unverified**) | x-vector head | Loads with `AutoModelForAudioXVector` in Transformers; the example threshold is 0.86, "dataset-dependent" ([card](https://huggingface.co/microsoft/wavlm-base-plus-sv)). Stale (2022) and weaker than the rows above |

### End-to-end "who said what"

- **WhisperX** ([m-bain/whisperX](https://github.com/m-bain/whisperX), BSD-2-Clause) is Whisper plus pyannote `speaker-diarization-community-1` plus `assign_word_speakers()`, which puts a speaker label on each word. The labels are anonymous; it has no enrolled-speaker matching (per its README). It is a Python/GPU pipeline, and HF only hosts forks of it (the HF API search for "whisperx" returns forks with at most 15 downloads).
- **NVIDIA Multitalker Parakeet** ([nvidia/multitalker-parakeet-streaming-0.6b-v1](https://huggingface.co/nvidia/multitalker-parakeet-streaming-0.6b-v1)) is speaker-attributed streaming ASR under the NVIDIA Open Model License: 649 downloads, updated 2026-01-28. It runs "one model instance per speaker", fed by Streaming Sortformer, with a latency of up to 1.12 s. It "does not bind to enrolled speaker identities" (card summary). It is the closest HF match for "who said what, live" in overlapped speech, but it still needs our own identity step and a GPU.
- **MOSS-Transcribe-Diarize** ([OpenMOSS-Team/MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize)) was **added after the Hub check**.
  - Hub facts (`hf models info`): **Apache-2.0**, not gated, 163,483 downloads, updated 2026-09-02, `pipeline_tag: audio-text-to-text`, library `transformers`, 0.91 B parameters.
  - It transcribes and diarizes in one pass, emitting "anonymous speaker labels such as `[S01]`, `[S02]`" with timestamps, on recordings of up to 90 minutes. It is served through the OpenAI-compatible `/v1/audio/transcriptions` API on SGLang Omni or vLLM (card; paper [2601.01554](https://huggingface.co/papers/2601.01554), 2026-01-04).
  - It is the strongest **"who said what"** model on the Hub for replacing STT and diarization together. It still gives **no enrolled names**, and it needs a GPU.
  - It is not in the Inference Endpoints catalogue, so it would need a custom vLLM or SGLang container. No DER or cpWER table was found in the card excerpt we read (**unverified**).
- **Target-speaker ASR** exists on the Hub (this corrects the first draft). [BUT-FIT/SE-DiCoW](https://huggingface.co/BUT-FIT/SE-DiCoW):
  - Hub facts: **Apache-2.0**, 1,900 downloads, updated 2026-01-26, `automatic-speech-recognition`, `transformers`, 1.10 B parameters.
  - It is "Self-Enrolled Diarization-Conditioned Whisper": diarization masks plus an enrollment segment that it "automatically selects … from the conversation" (card; DiCoW paper [2501.00114](https://huggingface.co/papers/2501.00114)).
  - The enrollment comes from inside the recording, not from our household voiceprints, so it improves *who-said-what in overlap*, not *who is this person*. It needs a GPU and custom remote code.
  - The earlier DiCoW v3 checkpoints are CC-BY-4.0 (`BUT-FIT/DiCoW_v3_3`, 718 downloads).
- **8-speaker Sortformer fine-tune** ([mago-ai/ultra_diar_streaming_sortformer_8spk_v1](https://huggingface.co/mago-ai/ultra_diar_streaming_sortformer_8spk_v1)):
  - Hub facts: 259 downloads, updated 2026-04-09, NeMo.
  - It extends v2.1 "from 4 speakers to 8 speakers". Its card claims Apache-2.0, but also says "the upstream base model may be subject to separate terms". The licence chain is unclear, it is a one-person project, and no DER table was found. **Watch, don't adopt.**
- **HF's own ASR + diarization handler**: the HF blog shows one Inference Endpoint that runs Whisper and pyannote behind a single custom handler ([blog](https://huggingface.co/blog/asr-diarization)). This is the pattern the recommendation below reuses.

## Hosted on Hugging Face

### Inference Providers (serverless, pay per call): no speaker ID

- HF's Inference Providers partner table lists these task columns only: chat completion (LLM and VLM), feature extraction, text-to-image, text-to-video and speech-to-text. The speech-to-text column is filled for Fal AI, HF Inference, Replicate and Together ([Inference Providers](https://huggingface.co/docs/inference-providers/index), read 2026-09-26). **No provider offers diarization, speaker verification or speaker identification** as a task.
- The Hub API agrees. `https://huggingface.co/api/models?search=pyannote&inference_provider=all` and the same query for `pipeline_tag=voice-activity-detection` both returned `[]` on 2026-09-26, so no provider serves a pyannote model.
- Serverless "just call an API" is therefore **not available** for this job on HF.

### Inference Endpoints (dedicated, managed hardware): yes, with a custom handler

- **The one-click Model Catalog has no speaker model.** `hf endpoints catalog list`, run unauthenticated on 2026-09-26, returned **128 models**. The only audio entries were `openai/whisper-large-v3` and `openai/whisper-large-v3-turbo`. There is no pyannote, Sortformer, TitaNet, ECAPA, WeSpeaker, DiariZen or MOSS entry, so **none of the models here can be deployed from the catalogue**.
- **So every one of them needs a custom handler or a custom container.** HF runs the machine, TLS, autoscaling and logs; **we** write the `handler.py` that loads the model and returns JSON ([custom handler guide](https://huggingface.co/docs/inference-endpoints/en/guides/custom_handler)). A custom image is needed when the default one lacks a dependency (the `hf endpoints deploy` flags include `--custom-image` and `--engine custom`, per the CLI skill reference). MOSS-Transcribe-Diarize would take the `vllm` or `sglang` engine route (**unverified** for this model).
- **Hardware list: not checked through the CLI.** `hf endpoints hardware` refused: "Error: Not logged in. Run 'hf auth login' first." (exit 1). We did not log in, per the brief. The prices below come from the web pricing page, dated.
- HF publishes a worked example that runs Whisper plus pyannote diarization behind one endpoint ([HF blog](https://huggingface.co/blog/asr-diarization)), and public pyannote handler repos exist (for example [KIFF/pyannote-speaker-diarization-endpoint](https://huggingface.co/KIFF/pyannote-speaker-diarization-endpoint/blame/main/handler.py)).
- Gated pyannote weights need an HF token that has accepted the conditions, passed to the endpoint as a secret.
- pyannote.audio 4.x replaced torchaudio with torchcodec ([CHANGELOG](https://raw.githubusercontent.com/pyannote/pyannote-audio/main/CHANGELOG.md)). Whether the default endpoint image has the FFmpeg that torchcodec needs, or a custom container is required, is **unverified**.
- This is "managed", not "hosted API". HF owns uptime and hardware; we own the handler code, its dependency pins and the matching logic. That is less than DIY on Railway, and more than Speechmatics.

**Instance prices** (per hour, billed per minute; [pricing](https://huggingface.co/docs/inference-endpoints/pricing), as of 2026-09-26):

| Instance | $/h | Always-on, 730 h/month |
|---|---|---|
| AWS Intel Sapphire Rapids, 1 vCPU, 2 GB | $0.033 | **$24.09** |
| AWS Intel Sapphire Rapids, 2 vCPU (HF's own example) | $0.067 | **$48.91** (HF's own figure) |
| AWS or GCP NVIDIA T4, 1 GPU | $0.50 | **$365** |
| GCP NVIDIA L4 | $0.70 | $511 |
| AWS NVIDIA L4 | $0.80 | $584 |

**Scale-to-zero versus always-on:**

- Scale-to-zero turns the endpoint off after an idle period, 1 hour by default. The next request gets **HTTP 503** while a replica starts, unless the caller sends `X-Scale-Up-Timeout`. HF says scaling up "can take a few minutes" and that scaling from 0 to 1 on a request "is typically not recommended if your application needs to be responsive" ([autoscaling guide](https://huggingface.co/docs/inference-endpoints/guides/autoscaling)).
- A household talks on and off all day, so the endpoint would rarely stay idle a full hour. Each cold start would stall a spoken turn for minutes. **For per-turn speaker ID, only always-on is realistic.**
- One replica serves every household, so the fixed cost is shared. Our estimate: a 2-vCPU CPU endpoint at $48.91/month is **$0.05 per household per month at 1,000 households**, until CPU saturates and autoscaling adds replicas (capacity is **unverified**; measure it).
- Scale-to-zero only makes sense for an **offline** job, for example nightly re-clustering of enrollment audio.

**Latency (estimate, unverified).** An endpoint adds one HTTPS round trip from Railway to the HF region, plus inference:

- **Embedding one 1-5 s segment** with ResNet34-LM or CAM++ on CPU: the main2 survey estimates tens of ms. Round trip included, that should fit #341's 150 ms p95 budget if the regions are close (**unverified**).
- **Full pyannote diarization of a 5-15 s turn** on 2 vCPU: **unverified**. The only published speed is GPU (31 s per hour of audio on an H100, [pyannote-audio](https://github.com/pyannote/pyannote-audio)). Measure it before choosing CPU over T4.
- **Streaming Sortformer** needs a GPU endpoint (T4 or better, from $365/month) for its published 0.3-1 s latency, and it caps at 4 speakers. Our households have up to 6 people.

## From clusters to named people

Diarization gives `SPEAKER_00`, `SPEAKER_01` and so on, valid only inside one recording. To name them:

1. **Enroll.** For each household member, embed several clean clips, ideally on the Cardputer at the distance people will actually use. Store the mean vector (the centroid), and optionally k extra vectors for different conditions, in pgvector with a `model_id`. The main2 survey already requires the `model_id` column for re-enrollment. The approach of one embedding per known person, then cosine matching, is the community answer in [pyannote discussion #1667](https://github.com/pyannote/pyannote-audio/discussions/1667). A search summary suggested keeping k representative embeddings per person (k-means over their samples), but which source says so is **unverified**. [Discussion #1589](https://github.com/pyannote/pyannote-audio/discussions/1589) is the related thread.
2. **Diarize the recording** and take the **exclusive** (one speaker at a time) timeline, so overlapped frames do not pollute the vectors. community-1 outputs `exclusive_speaker_diarization` directly ([card](https://huggingface.co/pyannote/speaker-diarization-community-1)).
3. **Embed each cluster.** Concatenate or average the segments of each anonymous label, embed them with the **same model** used at enrollment, and match against the household centroids by cosine similarity.
4. **Assign or reject.** Take the best-scoring member if the score passes threshold `τ`, **and** it beats the runner-up by a margin; otherwise `unknown`. `τ` must be tuned on our own recordings (#361). WavLM's card calls its 0.86 example "dataset-dependent" ([card](https://huggingface.co/microsoft/wavlm-base-plus-sv)), and the discussion above says the same for pyannote.
5. **Enforce uniqueness in the recording.** Two clusters must not both become "Sam". Solve it as an assignment problem (Hungarian matching on the cluster × member score matrix); a duplicate that loses becomes `unknown`, or is merged if its score is close (estimate: a design choice, not a published method).

**Which pipelines expose embeddings per speaker:**

| Pipeline | Per-speaker vector out of the box? |
|---|---|
| pyannote community-1 / 3.1 | Internally yes: it clusters WeSpeaker ResNet34 embeddings, 256-d. A third-party port documents that community-1 "returns one 256-dimensional centroid per detected speaker" ([Soniqo guide](https://soniqo.audio/guides/diarize)). The official Python attribute name for that output was **not confirmed** in the pyannote README or card (**unverified**). Safe route: re-embed each cluster with `pyannote/wespeaker-voxceleb-resnet34-LM` in the handler. That is the same model, so the vectors share a space ([discussion #1667](https://github.com/pyannote/pyannote-audio/discussions/1667)) |
| Streaming Sortformer v2 / v2.1 | **No.** It outputs a T × 4 speaker-activity matrix, not speaker embeddings ([v2.1 card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)). Pair it with TitaNet-Large for identity |
| DiariZen | Clusters internally; whether its per-speaker embeddings are exposed is **unverified**. Non-commercial anyway |
| sherpa-onnx diarization (Node) | Takes a separate embedding model (3D-Speaker or NeMo) ([docs](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html)), so we can embed the resulting segments with the same extractor used for enrollment |
| WhisperX | No: word-level anonymous labels only ([README](https://github.com/m-bain/whisperX)) |

**Short cut for single-speaker turns.** Most Cardputer turns are one person. Embed the whole turn and match it, and **skip diarization**. Run diarization only when the turn is long, for example over 4 s (estimate), or when a sliding-window embedding score changes identity mid-turn. That keeps the common path to one embedding call.

## Overlap and short answers

- **Overlap.** The diarizers that model overlap are community-1 (overlapped speech detection), Sortformer (per-frame activity for 4 speakers) and DiariZen (up to 4 overlapping speakers). What they return in overlapped stretches is **who is active**, not a clean voice to embed, and speaker embeddings of mixed speech are unreliable (**unverified** for these exact models). The rules:
  - identify people from their **non-overlapped** speech (the exclusive timeline);
  - carry the label into the overlapped frames by time;
  - never enroll from overlapped audio.
- **Separation first?** Running a speech-separation model before embedding is possible, but it is another model and more latency. No HF-hosted API offers it for this task (see the Providers finding above). Out of scope for v1.
- **Short answers ("yes", "Paris").** A 0.3-1 s clip gives a weak embedding. The main2 survey already cites the short-utterance accuracy drop and sets the rule: a turn under about 1 s is `unknown` or inherits the wake turn's speaker. Inside a multi-person recording, apply that rule **per segment**:
  - a segment under about 1 s takes its identity from the cluster it belongs to, because the cluster pools all of that person's speech in the recording;
  - it is `unknown` only when its cluster is itself too short.
  - Clustering first, then naming, is what makes short answers work at all.
- **Short-utterance models.** ERes2NetV2 was designed for short-duration verification ([paper](https://arxiv.org/html/2406.02167v1)). ReDimNet B2 and B3 are small at 0.50-0.57 % EER ([evaluation](https://github.com/IDRnD/redimnet/blob/master/EVALUATION.md)). Both are candidates for the #361 bake-off's 1-2 s condition.
- **More than 4 people.** Sortformer and DiariZen are built around 4 simultaneous speakers, and Sortformer degrades at 5 or more (DIHARD3 ≥ 5 speakers: 41-43 % DER, from its cards). pyannote's clustering has no hard cap. For a 6-person household in one recording, pyannote is the safer diarizer.

## Recommendation

**Best HF-hosted option:** one always-on **HF Inference Endpoint on a 2-vCPU CPU instance ($0.067/h, about $49/month as of 2026-09-26)**, running a custom handler with two routes:

- `POST /embed`: a turn or segment goes in, a **`pyannote/wespeaker-voxceleb-resnet34-LM`** vector (CC-BY-4.0, 256-d, 0.69 % EER) comes out. This is the common single-speaker path.
- `POST /diarize`: a multi-person recording goes in. **`pyannote/speaker-diarization-community-1`** (CC-BY-4.0, gated) returns the exclusive timeline plus one ResNet34 vector per cluster.

Matching against enrolled centroids, the `unknown` threshold and uniqueness all stay in our Node API against pgvector. The endpoint never stores voiceprints, so HF holds no biometric data at rest (retention of request payloads by HF is **unverified**; check the Endpoints data policy for #353).

Why this pair:

- Both licences allow commercial use.
- They share one embedding space, so enrollment vectors and diarization clusters compare directly.
- pyannote has no speaker cap, unlike Sortformer's 4. Our households have up to 6.
- It is the most downloaded pipeline on the Hub (5.46 M/month), and it scores better than 3.1 on every public set its card lists.

Upgrade path: move to a T4 ($365/month) only if CPU diarization latency fails the bake-off.

**Not recommended:**

- **Streaming Sortformer**: a 4-speaker cap, GPU only, and no embeddings.
- **DiariZen and Sortformer v1**: non-commercial licences.
- **Scale-to-zero**: cold starts take minutes and return 503s.
- **HF Inference Providers**: no speaker task exists.

**Compared with Speechmatics**, the commercial frontrunner. Figures are from the main2 survey, as of 2026-09-26:

| | HF Endpoint (community-1 + ResNet34) | Speechmatics Realtime |
|---|---|---|
| What is managed | Hardware and uptime only. We write and maintain the handler, pins, thresholds and matching | Everything: STT, diarization, enrolled-speaker labels and word timestamps in one call |
| Transcript attribution | We must align STT words to the diarization timeline ourselves (exclusive diarization makes this easier) | Built in: words carry speaker labels |
| Streaming | No: per-turn, offline requests | Yes: realtime |
| Scores for #361 thresholds | Yes: raw cosine scores, fully tunable | Labels; whether scores are exposed is **unverified** in the main2 survey |
| Cost | About $49/month flat for the fleet (1 replica, estimate), so about $0.05/household at 1,000 households | $1.20-2.15 per household per month, but it **replaces** our STT spend |
| Lock-in and churn | Open weights; we control model updates and re-enrollment | Identifiers must be regenerated when their model updates |
| STT change | None: keep `fish-audio/transcribe-1` | Moves voice STT off the AI Gateway |

**Verdict.** If the owner's "managed" means "no model code of ours", **Speechmatics still wins**: the HF route is managed hardware running our own handler. The HF endpoint is the right choice when:

- cost per household or data control matters more;
- the owner wants to keep today's STT;
- or Speechmatics fails the bake-off.

Put it in the #361 bake-off as the "HF-hosted open-weights" arm, beside Speechmatics and Eagle.

**Do the 2025-2026 papers change this?** No, but one of them adds an option. `hf papers search` found these recent end-to-end "who spoke when and what" systems:

- SpeakerLM ([2508.06372](https://huggingface.co/papers/2508.06372), 2025-08-08). It has a "flexible speaker registration mechanism", which is the closest in concept to enrolled identity. No HF model was found for it (`hf models list --search speakerlm` returned nothing).
- MOSS Transcribe Diarize ([2601.01554](https://huggingface.co/papers/2601.01554), 2026-01-04). Weights are on the Hub, as above.
- TellWhisper ([2601.03712](https://huggingface.co/papers/2601.03712), 2026-01-08).
- Self-speaker adaptation for multi-talker ASR ([2506.22646](https://huggingface.co/papers/2506.22646), 2025-06-27). This is the method behind NVIDIA's Multitalker Parakeet: "eliminates the need for explicit speaker queries".
- SE-DiCoW / DiCoW ([2501.00114](https://huggingface.co/papers/2501.00114)).

All of these label speakers **anonymously**, or enroll from inside the same recording. SpeakerLM is the exception, and it has no public weights. So the identity step (embedding plus centroid match) is still ours, whichever diarizer or transcriber sits in front of it.

**The added option: MOSS-Transcribe-Diarize** (Apache-2.0) on a GPU endpoint (T4 from $365/month, as of 2026-09-26). It is an open-weights stand-in for Speechmatics' "STT + diarization in one call" for multi-person recordings (#360), with our own ResNet34 matching on its `[S01]` segments. It is worth a bake-off arm only if the owner wants to drop both `fish-audio` and Speechmatics.

## Excluded

Excluded by the owner's rule (identity only: no age, gender, emotion, accent, language or other demographics). Download counts were read on 2026-09-26.

- [audeering/wav2vec2-large-robust-24-ft-age-gender](https://huggingface.co/audeering/wav2vec2-large-robust-24-ft-age-gender): age and gender (2.4 M downloads).
- [griko/gender_cls_svm_ecapa_voxceleb](https://huggingface.co/griko/gender_cls_svm_ecapa_voxceleb): gender from ECAPA embeddings.
- [Jzuluaga/accent-id-commonaccent_ecapa](https://huggingface.co/Jzuluaga/accent-id-commonaccent_ecapa): accent.
- [speechbrain/lang-id-voxlingua107-ecapa](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa): spoken language, a demographic proxy.
- [speechbrain/emotion-recognition-wav2vec2-IEMOCAP](https://huggingface.co/speechbrain/emotion-recognition-wav2vec2-IEMOCAP): emotion.
- [superb/wav2vec2-base-superb-er](https://huggingface.co/superb/wav2vec2-base-superb-er): emotion.
- [ehcalabres/wav2vec2-lg-xlsr-en-speech-emotion-recognition](https://huggingface.co/ehcalabres/wav2vec2-lg-xlsr-en-speech-emotion-recognition): emotion.

## Sources

All read on 2026-09-26.

Hugging Face model cards:

- [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
- [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
- [pyannote/speaker-diarization-precision](https://huggingface.co/pyannote/speaker-diarization-precision)
- [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)
- [onnx-community/pyannote-segmentation-3.0](https://huggingface.co/onnx-community/pyannote-segmentation-3.0)
- [pyannote/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM)
- [nvidia/diar_streaming_sortformer_4spk-v2.1](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)
- [nvidia/diar_streaming_sortformer_4spk-v2](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2)
- [nvidia/diar_sortformer_4spk-v1](https://huggingface.co/nvidia/diar_sortformer_4spk-v1)
- [nvidia/speakerverification_en_titanet_large](https://huggingface.co/nvidia/speakerverification_en_titanet_large)
- [nvidia/multitalker-parakeet-streaming-0.6b-v1](https://huggingface.co/nvidia/multitalker-parakeet-streaming-0.6b-v1)
- [BUT-FIT/diarizen-wavlm-large-s80-md-v2](https://huggingface.co/BUT-FIT/diarizen-wavlm-large-s80-md-v2)
- [BUT-FIT/diarizen-wavlm-base-s80-md](https://huggingface.co/BUT-FIT/diarizen-wavlm-base-s80-md)
- [speechbrain/spkrec-ecapa-voxceleb](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb)
- [microsoft/wavlm-base-plus-sv](https://huggingface.co/microsoft/wavlm-base-plus-sv)
- [Wespeaker/wespeaker-voxceleb-redimnet2-B6-LM](https://huggingface.co/Wespeaker/wespeaker-voxceleb-redimnet2-B6-LM)
- [Wespeaker/wespeaker-voxceleb-campplus-LM](https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus-LM)
- [funasr/campplus](https://huggingface.co/funasr/campplus)
- [soniqo/ReDimNet2-B6-ONNX-FP32](https://huggingface.co/soniqo/ReDimNet2-B6-ONNX-FP32)

Hugging Face Hub API (downloads, `lastModified`, licence tags and gating):

- `https://huggingface.co/api/models/<id>?expand[]=downloads&expand[]=lastModified&expand[]=cardData&expand[]=gated`
- `https://huggingface.co/api/models?search=<term>&sort=downloads&direction=-1`, with the terms speaker-diarization, sortformer, diarizen, redimnet, campplus, eres2net, speaker-verification, titanet, whisperx, target-speaker, speaker-attributed, ecapa and multitalker
- `https://huggingface.co/api/models?search=pyannote&inference_provider=all`

Hugging Face docs:

- [Inference Providers overview](https://huggingface.co/docs/inference-providers/index)
- [Inference Endpoints pricing](https://huggingface.co/docs/inference-endpoints/pricing)
- [Inference Endpoints autoscaling](https://huggingface.co/docs/inference-endpoints/guides/autoscaling)
- [Custom handler guide](https://huggingface.co/docs/inference-endpoints/en/guides/custom_handler)
- [HF blog: ASR + diarization on Inference Endpoints](https://huggingface.co/blog/asr-diarization)
- [KIFF pyannote endpoint handler](https://huggingface.co/KIFF/pyannote-speaker-diarization-endpoint/blame/main/handler.py)

pyannote:

- [pyannote-audio README](https://github.com/pyannote/pyannote-audio)
- [pyannote-audio CHANGELOG](https://raw.githubusercontent.com/pyannote/pyannote-audio/main/CHANGELOG.md)
- [pyannoteAI blog: community-1](https://www.pyannote.ai/blog/community-1)
- [pyannote discussion #1667](https://github.com/pyannote/pyannote-audio/discussions/1667)
- [pyannote discussion #1589](https://github.com/pyannote/pyannote-audio/discussions/1589)

Speaker-embedding repos and papers:

- [WeSpeaker VoxCeleb results](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md)
- [WeSpeaker pretrained-model licence notes](https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md)
- [IDRnD/redimnet](https://github.com/IDRnD/redimnet)
- [ReDimNet evaluation](https://github.com/IDRnD/redimnet/blob/master/EVALUATION.md)
- [3D-Speaker CAM++ results](https://github.com/modelscope/3D-Speaker/blob/main/egs/voxceleb/sv-cam++/README.md)
- [ERes2NetV2 paper](https://arxiv.org/html/2406.02167v1)

Other tools:

- [sherpa-onnx speaker diarization](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html)
- [WhisperX](https://github.com/m-bain/whisperX)
- [Soniqo diarization guide](https://soniqo.audio/guides/diarize) (a third-party port)
- [UniSpeech licence](https://github.com/microsoft/UniSpeech/blob/main/LICENSE)

In-repo: `git show origin/main2:docs/voice-id/speaker-id-service-research.md`, for Speechmatics, Eagle and pyannoteAI pricing and the self-hosted sherpa-onnx fallback.

Added on the Hub check (2026-09-26):

- [OpenMOSS-Team/MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize)
- [BUT-FIT/SE-DiCoW](https://huggingface.co/BUT-FIT/SE-DiCoW)
- [BUT-FIT/DiCoW_v3_3](https://huggingface.co/BUT-FIT/DiCoW_v3_3)
- [mago-ai/ultra_diar_streaming_sortformer_8spk_v1](https://huggingface.co/mago-ai/ultra_diar_streaming_sortformer_8spk_v1)
- [litert-community/Speaker-Diarization-LiteRT](https://huggingface.co/litert-community/Speaker-Diarization-LiteRT)
- [christopherthompson81/sortformer_parakeet_onnx](https://huggingface.co/christopherthompson81/sortformer_parakeet_onnx)
- [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/)
- Papers: [2508.06372](https://huggingface.co/papers/2508.06372), [2601.01554](https://huggingface.co/papers/2601.01554), [2601.03712](https://huggingface.co/papers/2601.03712), [2506.22646](https://huggingface.co/papers/2506.22646), [2501.00114](https://huggingface.co/papers/2501.00114)

### How this was checked

The `hf` CLI is `huggingface_hub` v2.0.0 (`hf version`), unauthenticated, run on 2026-09-26. Every command was read-only: nothing was deployed, created or deleted, and no weights were downloaded. `hf models card` fetches only the README.

```sh
hf version
hf models info <repo_id> --format json      # every model in "Models compared", plus MOSS, SE-DiCoW, the 8-speaker Sortformer
hf models card <repo_id> --metadata --format json   # gating prompt and licence metadata (pyannote community-1 and 3.1, Sortformer v2.1)
hf models card <repo_id>                    # full cards for the new candidates
hf models list --help
hf models list --search "speaker-diarization" --sort downloads --limit 12 --expand downloads,lastModified,cardData,pipeline_tag --format json
hf models list --search "speaker-verification" --sort downloads --limit 12 --expand downloads,lastModified,cardData,pipeline_tag --format json
hf models list --search "speaker-recognition" --sort downloads --limit 12 --expand downloads,lastModified,cardData,pipeline_tag --format json
hf models list --search "speaker embedding" --sort downloads --limit 12 --expand downloads,lastModified,cardData,pipeline_tag --format json
hf models list --search "sortformer" --sort downloads --limit 12 --expand downloads,lastModified,cardData,pipeline_tag --format json
hf models list --search "diarizen" --sort downloads --limit 12 --expand downloads,lastModified,cardData,pipeline_tag --format json
hf models list --search "target speaker" --sort downloads --limit 12 --expand downloads,lastModified,cardData,pipeline_tag --format json
hf models list --search dicow|speakerlm|moss-transcribe --sort downloads --limit 6 --expand downloads,lastModified,cardData --format json
hf papers search --help
hf papers search "speaker diarization" --limit 20 --format json
hf papers search "speaker identification overlap" --limit 20 --format json
hf papers info <arxiv_id> --format json     # 2508.06372 2501.00114 2601.01554 2601.03712 2506.22646
hf endpoints catalog list --format json     # worked unauthenticated: 128 models, no speaker model
hf endpoints hardware --format json         # exit 1: "Not logged in. Run 'hf auth login' first." (not attempted further)
```
