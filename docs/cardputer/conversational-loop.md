# Conversational loop: follow-up turns, endpointing and barge-in (research for #392)

Status: research and recommendation, 2026-09-24. No code was changed. Every nontrivial claim links a
source. Items marked **(unverified)** could not be confirmed from a primary source.

Grounding in our code (read before writing this):

- `apps/cardputer/include/wake_word.h`: `kVadEndSilenceMs = 700`, `kVadMaxTurnMs = 8000`.
- `apps/cardputer/src/wake_word.cpp`: energy VAD, 10 ms frames. A frame counts as speech at > 45 dB
  and > noise floor + 12 dB. 5 speech frames (50 ms) set `heardSpeech`. Any single speech frame resets
  the silence counter. The noise floor drops at once and rises 1 dB/s, and only moves on non-speech frames.
- `apps/cardputer/src/state.cpp` (`loop` near line 1932): a wake turn streams until `vadSpeechEnded()`.
  A turn with no speech is cancelled (`wake_rejected`). After playback the device goes back to Ready,
  so the next turn needs the wake word or GO again. That is problem 1.
- `apps/api/src/schemas.ts`: every control payload is `.strict()`. `turn_start`, `turn_end`,
  `playback_end` all have `payload: {}`. **Any new field must be added to the server schema before
  firmware sends it**, or the server rejects the message.
- `apps/api/src/turn.ts` / `audio.ts`: STT is batch (`transcribePcm` sends a WAV after `turn_end`).
  Turns shorter than 300 ms (`MIN_STT_PCM_BYTES`) are rejected. A rejected clip now speaks "I did not
  hear anything" (#388). That is right for a wake turn and wrong for a follow-up turn (see D5).
- `apps/ai/src/prompts.ts`: the agent already uses conversation history ("Use the conversation history
  to answer follow-up questions") and is told to keep replies short. The pineapple then "remind me to
  buy one at 6" flow **already works on the server** if the second utterance reaches it in the same
  conversation. What is missing is the device re-opening the mic.

---

## 1. Executive summary: the decisions

| # | Decision | Recommended value | Why (short) |
|---|---|---|---|
| D1 | **Open a follow-up window after every reply** (setting, default on), timed from speaker *drain*, not from `playback_end` arrival | **6,000 ms** window, starting **250 ms** after the last sample plays | Alexa Follow-Up Mode listens 5 s ([TechCrunch](https://techcrunch.com/2018/03/10/now-you-can-have-a-conversation-with-alexa-without-screaming-hey-alexa-for-every-request/)). Google Continued Conversation listens "about 10 seconds" ([Google Nest Help](https://support.google.com/googlenest/answer/7685981)). Xiaozhi waits for its playback queue to drain before listening, "to prevent audio truncation when STOP arrives late" ([application.cc](https://github.com/78/xiaozhi-esp32/blob/main/main/application.cc)) |
| D2 | **In the follow-up window, listen locally and stream nothing until speech starts.** Keep a pre-roll ring buffer and send `turn_start` + pre-roll only when speech onset is confirmed | onset **≥ 200 ms** of speech frames. Pre-roll **300 ms** (9.6 KB). No onset in the window: close silently with a soft "mic closed" earcon | HA's segmenter needs `speech_seconds = 0.3` before a command starts ([vad.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/assist_pipeline/vad.py)). Silero's `min_speech_duration_ms` default is 250 ([utils_vad.py](https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/utils_vad.py)). ESP-SR VADNet recommends a pre-trigger cache because onset lags 1 to 3 frames ([VADNet](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/vadnet/README.html)) |
| D3 | **Lengthen end-of-speech silence** (problem 2) and make it depend on utterance length | **1,000 ms** base (was 700). **1,200 ms** while total speech < 1,500 ms | 700 ms is HA's *default* sensitivity. HA's "relaxed" setting is 1.25 s ([vad.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/assist_pipeline/vad.py)). AssemblyAI's default acoustic fallback is 1,280 ms ([AssemblyAI](https://www.assemblyai.com/docs/streaming/universal-streaming/turn-detection)). Pipecat's plain VAD default is 0.8 s ([voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/)). Speechmatics recommends 0.5 to 0.8 s for agents and 0.8 to 1.2 s for dictation ([Speechmatics](https://docs.speechmatics.com/speech-to-text/realtime/turn-detection)) |
| D4 | **Raise max turn and add a no-speech timeout** | max turn **15,000 ms** (was 8,000). No-speech after wake: **5,000 ms** | HA `timeout_seconds = 15.0` ([vad.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/assist_pipeline/vad.py)). OVOS `recording_timeout 10.0`, `recording_timeout_with_silence 3.0` ([ovos-dinkum-listener](https://github.com/OpenVoiceOS/ovos-dinkum-listener)). The server accepts 1 MB of uplink, about 32 s of PCM16 |
| D5 | **Tag follow-up turns** (`turn_start.payload.trigger = "follow_up"`). The server **ends a follow-up turn silently** when the transcript is empty, too short or not addressed to the assistant | no error speech. Close the loop after **2** silent drops in a row | Alexa Follow-Up Mode drops speech it judges to be background or unclear ([TechCrunch](https://techcrunch.com/2018/03/10/now-you-can-have-a-conversation-with-alexa-without-screaming-hey-alexa-for-every-request/)). Google: after 3 no-input or no-match errors, exit ([Google conversation design](https://developers.google.com/assistant/conversation-design/errors)) |
| D6 | **Server says whether it expects an answer.** `playback_end.payload.expect_reply: boolean`: true when the reply ends in a question (HA's rule) or the agent sets a flag | expect_reply: **8,000 ms** window + "listening" earcon. Otherwise the D1 window (6,000 ms, quieter cue) | HA keeps listening when the last assistant message ends in `?`, `;` or `？` ([chat_log.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/conversation/chat_log.py)). ESPHome re-opens the mic without the wake word when `continue_conversation == "1"` ([voice_assistant.cpp](https://github.com/esphome/esphome/blob/dev/esphome/components/voice_assistant/voice_assistant.cpp)) |
| D7 | **Phase 2: semantic end-of-turn on the server** (Silero VAD, Smart Turn v3.1 ONNX) sends `end_of_turn` to the device. The device VAD becomes a fallback | device fallback silence **2,000 ms**. Server: VAD stop **200 ms**, then Smart Turn. Force the end after **~1,500 ms** (tunable) | Pipecat recommends VAD `stop_secs = 0.2` with Smart Turn, with a 3 s fallback ([Pipecat docs](https://docs.pipecat.ai/api-reference/server/utilities/turn-detection/smart-turn-overview)). Smart Turn v3.1: 8 MB int8, 94.7 % English accuracy ([Daily](https://www.daily.co/blog/improved-accuracy-in-smart-turn-v3-1/)), about 10 to 100 ms on CPU ([smart-turn](https://github.com/pipecat-ai/smart-turn)) |
| D8 | **Barge-in stays half-duplex** (keys and BtnA stop playback, and the mic is closed while the speaker plays) until an AEC experiment proves it fits in memory. No full-duplex VAD barge-in without AEC | n/a | ESP-SR full AFE needs about 740 to 1,240 KB of PSRAM ([benchmark](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/benchmark/README.html)). The standalone AEC needs 18.8 KB internal + 64 KB PSRAM ([AEC](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/acoustic_echo_cancellation/README.html)). Xiaozhi only allows its `realtime` (full-duplex) mode with AEC ([protocol.h](https://github.com/78/xiaozhi-esp32/blob/main/main/protocols/protocol.h)) |

Latency target (checklist, section 8): **first reply audio ≤ 1,000 ms after the user stops talking;
stretch goal 800 ms**. Endpoint silence counts toward that budget, which is why D7 matters. Humans
answer in about 0 to 200 ms ([Stivers et al., PNAS 2009](https://www.pnas.org/doi/10.1073/pnas.0903616106)),
so a fixed 1,000 ms silence rule always feels slow.

---

## 2. Q1: how shipping assistants handle follow-up windows

### Amazon Alexa

- **Follow-Up Mode** (opt-in, 2018): after a reply, "Alexa ... listen[s] for five seconds", with the blue
  light on ([TechCrunch](https://techcrunch.com/2018/03/10/now-you-can-have-a-conversation-with-alexa-without-screaming-hey-alexa-for-every-request/),
  [Voicebot](https://voicebot.ai/2018/03/11/amazon-introduces-alexa-follow-mode-streamline-user-interactions/)).
  It does not respond if "she detects that speech was background noise or that the intent of the speech
  was not clear" ([TechCrunch](https://techcrunch.com/2018/03/10/now-you-can-have-a-conversation-with-alexa-without-screaming-hey-alexa-for-every-request/)).
  Whether it is still 5 s today is **(unverified)**. Amazon's help page returned 503.
- **Skill sessions** (`shouldEndSession: false`): "Alexa speaks the outputSpeech, and then opens the
  microphone for a few seconds." With no answer, the reprompt plays and the mic opens "for a few more
  seconds", then the session ends ([ASK docs](https://developer.amazon.com/en-US/docs/alexa/custom-skills/manage-skill-session-and-session-attributes.html)).
  Amazon gives no exact figure. The commonly quoted 8 s is **(unverified)**. So Alexa gets two
  chances: prompt, then reprompt.
- **Conversation Mode** (Echo Show 10/8): no wake word for several people. It uses **visual
  directedness** (head orientation from the camera) plus **audio device-directed VAD** (a separable
  CNN on LFBE features). It "exit[s] the mode if there is no interaction for a short period of time".
  The audio model cut false wakes from Alexa's own responses by 42 %
  ([Amazon Science](https://www.amazon.science/blog/new-alexa-feature-enables-natural-multiparty-interactions)).
  We have no camera, so only the audio and lexical side applies to us.

### Google Assistant / Nest

- Continued Conversation: "it listens for about 10 seconds for your follow-up questions". It ends on
  "Thank you", "Stop" or "I'm done", and "your microphone turns off automatically after 10 seconds of
  silence" ([Google Nest Help](https://support.google.com/googlenest/answer/7685981)). At launch in 2018
  the window was 8 s ([TechRadar](https://www.techradar.com/news/google-assistant-update-adds-continued-conversations)).
  Cue: moving lights, or a white circle on displays.
- Google's help page does not say how it rejects speech that was not meant for it.

### Apple Siri

- iOS 17 added back-to-back requests without "Siri" again on iPhone 11 or later
  ([AppleInsider](https://appleinsider.com/inside/ios-17/tips/how-to-use-back-to-back-commands-with-siri-in-ios-17)).
  Apple publishes no window length **(unverified)**.
- Apple's research on detecting device-directed speech without a trigger phrase combines acoustic
  features, the ASR 1-best text given to an LLM, and ASR decoder signals. The multimodal version beats
  text-only by up to 39 % EER and audio-only by up to 61 % ([arXiv 2403.14438](https://arxiv.org/abs/2403.14438);
  see also [Apple ML: streaming device-directed speech](https://machinelearning.apple.com/research/streaming-on-device)).
  **For us: a lexical check on the transcript is a cheap, useful way to reject speech not meant for the
  assistant (Phase 2).**

### Home Assistant Assist + ESPHome

- **Decision rule** (2025.4+): `ChatLog.continue_conversation` is true when the last assistant message
  `.strip().endswith(("?", ";", "？"))`. The `;` is the Greek question mark
  ([chat_log.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/conversation/chat_log.py),
  [2025.4 release](https://www.home-assistant.io/blog/2025/04/02/release-20254/)).
- Known weakness: an LLM question sometimes ends with `continue_conversation: false`, or the question
  mark is missing ([core#142310](https://github.com/home-assistant/core/issues/142310)). An earlier issue
  suggested asking the LLM for a structured `follow_up` boolean ([core#137450](https://github.com/home-assistant/core/issues/137450)).
  2025.7 added an "Ask question" action for automations ([2025.7 release](https://www.home-assistant.io/blog/2025/07/02/release-20257/)).
- **Device side (ESPHome)**: the `continue_conversation` flag arrives in the `INTENT_END` event data.
  After TTS, the device goes to `START_MICROPHONE` instead of `IDLE`, and the next request drops the
  `USE_WAKE_WORD` flag (`if (!this->continue_conversation_ && this->use_wake_word_)`)
  ([voice_assistant.cpp](https://github.com/esphome/esphome/blob/dev/esphome/components/voice_assistant/voice_assistant.cpp)).
  In ESPHome, endpointing for that turn is done by HA's server-side VAD (`USE_VAD` flag).
  `start_continuous` is a separate always-listening loop
  ([ESPHome docs](https://esphome.io/components/voice_assistant/)).
- **Endpointing numbers** (`VoiceCommandSegmenter`): speech 0.3 s to start a command, minimum command
  1.0 s, end silence 0.7 s, timeout 15 s. Hysteresis thresholds: 0.2 before a command, 0.5 inside one.
  User setting `VadSensitivity`: aggressive 0.25 s, default 0.7 s, relaxed 1.25 s
  ([vad.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/assist_pipeline/vad.py)).
  **Our 700 ms matches HA's default. HA ships "relaxed" at 1.25 s for people who get cut off.**

### Rhasspy / Wyoming

- Wyoming is an event protocol (`audio-chunk`, `transcript`, `voice-started`, `voice-stopped`, etc.)
  used by HA satellites ([wyoming README](https://github.com/rhasspy/wyoming/blob/master/README.md),
  [wyoming-satellite](https://github.com/rhasspy/wyoming-satellite)). The satellite streams, and the
  server-side VAD or STT decides when speech stops. It has no follow-up concept of its own. HA's pipeline
  supplies it.

### Mycroft / OpenVoiceOS

- Skills call `speak_dialog(..., expect_response=True)` (or `get_response`) to re-open the mic after
  speaking ([ovos-skill-alerts PR](https://github.com/OpenVoiceOS/ovos-skill-alerts/pull/253)).
- Listener config: `speech_begin 0.1`, `silence_end 0.5`, `recording_timeout 10.0`,
  `recording_timeout_with_silence 3.0`. Experimental `hybrid_listen` needs no wake word for
  `listen_timeout: 45` s after an interaction. `continuous_listen` warns that the assistant may "hear
  its own TTS responses as questions" ([ovos-dinkum-listener](https://github.com/OpenVoiceOS/ovos-dinkum-listener)).

### Xiaozhi (ESP32, closest to us)

- `listen` message with `state: start|stop|detect` and `mode: auto|manual|realtime`. The server sends
  `tts start|stop|sentence_start`. On `tts stop`, auto mode goes **back to Listening** and manual mode
  goes to Idle ([websocket.md](https://github.com/78/xiaozhi-esp32/blob/main/docs/websocket.md)).
  Downlink audio received while listening is dropped.
- `GetDefaultListeningMode()` returns `AutoStop` when AEC is off and `Realtime` only when AEC is on
  (device-side or server-side). The header comments say realtime "needs AEC support"
  ([application.cc](https://github.com/78/xiaozhi-esp32/blob/main/main/application.cc),
  [protocol.h](https://github.com/78/xiaozhi-esp32/blob/main/main/protocols/protocol.h)).
- It defers starting the mic until the playback queue drains (`pending_listening_start_`), which is the
  pattern in D1.
- The reference server ends turns with server-side Silero VAD: `threshold 0.5`, `threshold_low 0.3`
  (hysteresis), `min_silence_duration_ms: 200`. It closes the connection after 120 s without voice and
  supports exit phrases ([xiaozhi-esp32-server config.yaml](https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/main/main/xiaozhi-server/config.yaml)).
  200 ms is very aggressive. It suits fast Chinese chat. For English commands, treat it as an example of
  a server-side endpoint, not as a number to copy.

**Cross-assistant pattern.** The window is 5 to 10 s. The mic re-opens always (Alexa and Google
follow-up modes) or only when the reply is a question (HA, OVOS `expect_response`, Alexa skills). There
is always a visual "listening" cue. Stop phrases end the loop. Speech not meant for the assistant is
dropped silently, with no error prompt.

---

## 3. Q2: endpointing (end-of-turn) state of the art

### 3.1 Silence-only VAD (what we have)

| System | End silence | Min speech | Notes |
|---|---|---|---|
| Bob today | 700 ms | 50 ms (5 frames) | energy VAD, any 10 ms speech frame resets silence |
| HA Assist | 700 ms (aggressive 250, relaxed 1,250) | 300 ms + 1.0 s min command | [vad.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/assist_pipeline/vad.py) |
| OVOS dinkum | 500 ms | 100 ms | [README](https://github.com/OpenVoiceOS/ovos-dinkum-listener) |
| Pipecat VAD only | 800 ms | n/a | [voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/) |
| OpenAI Realtime `server_vad` | 500 ms, prefix 300 ms, threshold 0.5 | n/a | [OpenAI VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad) |
| Silero `get_speech_timestamps` | 100 ms (segmentation, not turn end) | 250 ms, pad 30 ms, `neg_threshold = threshold − 0.15` | [utils_vad.py](https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/utils_vad.py) |
| WebRTC VAD | frame classifier only (10/20/30 ms, modes 0–3); example segmenter uses a 300 ms ring with 90 % voiced ratio | | [py-webrtcvad](https://github.com/wiseman/py-webrtcvad) |
| ESP-SR VADNet | `vad_min_noise_ms 1000`, `vad_min_speech_ms 128`, `vad_delay_ms 128` | | [VADNet](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/vadnet/README.html) |
| Deepgram `endpointing` | default 10 ms. 300–500 ms "for conversations where speakers pause mid-thought". `utterance_end_ms` ≥ 1,000 | | [endpointing](https://developers.deepgram.com/docs/understand-endpointing-interim-results), [UtteranceEnd](https://developers.deepgram.com/docs/understanding-end-of-speech-detection) |
| Speechmatics | 0.5–0.8 s for voice agents, 0.8–1.2 s for dictation (range 0–2 s) | | [Speechmatics](https://docs.speechmatics.com/speech-to-text/realtime/turn-detection) |

Takeaways for our energy VAD:

1. **700 ms sits at the fast end.** Everyone who waits for complete thoughts uses 1.0 to 1.3 s of plain
   silence. That costs 300 to 500 ms of latency, which Phase 2 wins back with a semantic model.
2. **Short utterances need more patience.** "Remind me to…" followed by a pause is the classic cut-off.
   HA's 1.0 s minimum command length and Google's work on end-of-query detection
   ([Shannon et al., Interspeech 2017](https://www.isca-archive.org/interspeech_2017/shannon17_interspeech.html),
   which uses filler sounds and speaking rate to tell a mid-query pause from the end, about 100 ms
   better) both support a length-dependent rule. Hence D3: 1,200 ms while speech < 1.5 s, then 1,000 ms.
3. **Hysteresis.** Silero and Xiaozhi both use a lower exit threshold than entry threshold (0.5/0.35,
   0.5/0.3). Our energy VAD has one threshold (floor + 12 dB). While in speech, count a frame as speech
   at floor + **8 dB** and keep floor + 12 dB for onset. Soft word endings and breathy consonants then
   stop starting the silence clock early. This is a cheap Phase 1 tweak.
4. **A better on-device VAD with no PSRAM:** microWakeWord's own VAD model has
   `tensor_arena_size: 16772` (≈16.4 KB), `probability_cutoff 0.5`, `sliding_window_size 5` and the same
   10 ms feature step as our wake model ([vad.json](https://github.com/esphome/micro-wake-word-models/blob/main/models/v2/vad.json),
   [ESPHome micro_wake_word](https://esphome.io/components/micro_wake_word/)). It reuses the micro-frontend
   features we already compute. It is a strong Phase 1b candidate if the energy VAD misfires in noise
   (fans, TV). The ESP-SR VADNet needs PSRAM (see section 5).

### 3.2 Semantic and acoustic turn detection (Phase 2)

| Model / service | Input | Size / latency | Defaults | Source |
|---|---|---|---|---|
| **Pipecat Smart Turn v3.1** | audio only, 16 kHz, last 8 s, Whisper log-mel features | 8 MB int8 ONNX; "as little as 10 ms on some CPUs, under 100 ms on most cloud instances". 94.7 % EN accuracy (v3.0: 88.3 %). 23 languages. BSD-2 | VAD `stop_secs 0.2`, then the model. Fallback `stop_secs 3.0`, `pre_speech_ms 500`, `max_duration_secs 8` | [repo](https://github.com/pipecat-ai/smart-turn), [v3.1 blog](https://www.daily.co/blog/improved-accuracy-in-smart-turn-v3-1/), [v3 blog](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/), [Pipecat docs](https://docs.pipecat.ai/api-reference/server/utilities/turn-detection/smart-turn-overview) |
| **LiveKit turn detector** | audio model (v1 hosted, v1-mini local CPU), 14 languages | not published | `min_delay 0.5 s`, `max_delay 3.0 s`. With the audio model: 0.3 s / 2.5 s. VAD `min_silence_duration ≥ 0.25 s` | [LiveKit turn detector](https://docs.livekit.io/agents/build/turns/turn-detector/) |
| **OpenAI Realtime `semantic_vad`** | words uttered (classifier) | hosted | `eagerness` low/medium(auto)/high. Max timeouts 8 s / 4 s / 2 s, per the API reference in search results **(not fetched directly)** | [OpenAI VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad), [client events ref](https://developers.openai.com/api/reference/resources/realtime/client-events) |
| **AssemblyAI Universal-Streaming** | streaming STT + semantic end-of-turn | hosted | `end_of_turn_confidence_threshold 0.4`, `min_turn_silence 400`, `max_turn_silence 1280`. Aggressive 0.4/160/400, conservative 0.7/800/3600 | [AssemblyAI](https://www.assemblyai.com/docs/streaming/universal-streaming/turn-detection) |
| **Deepgram Flux** | conversational STT with turn events | hosted | `eot_threshold 0.7` (0.5–1.0), `eager_eot_threshold` 0.3–0.9, `eot_timeout_ms 5000`. Events `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn` | [Flux config](https://developers.deepgram.com/docs/flux/configuration) |
| **TEN Turn Detection** | text, Qwen2.5-7B-based. finished / unfinished / wait | 7B: needs a GPU for real time **(unverified)** | EN finished-state accuracy 90.64 % | [ten-turn-detection](https://github.com/TEN-framework/ten-turn-detection) |

**What fits Bob:** Smart Turn v3.1 is the only open, audio-native, CPU-cheap option. The official
inference is about 40 lines: Whisper feature extractor, then ONNX, then a sigmoid
([inference.py](https://github.com/pipecat-ai/smart-turn/blob/main/inference.py)). In Node it needs
`onnxruntime-node` plus a Whisper log-mel port (transformers.js has one). The accuracy match of a JS
feature extractor is **(unverified)** and must be checked against Python on a fixture set.
LiveKit's Node agents package ships Silero VAD and the turn detector as plugins
(`@livekit/agents-plugin-silero`, `@livekit/agents-plugin-livekit`, [agents-js](https://github.com/livekit/agents-js)).
They sit inside the LiveKit agent runtime and are not simple libraries. If we move to a hosted streaming
STT, AssemblyAI or Deepgram Flux give end-of-turn at no extra cost, and Flux's `EagerEndOfTurn` also
allows speculative LLM starts.

**Speculative processing with batch STT** (no vendor change): the device streams frames already. When
the server-side VAD sees ≥ 300 ms of silence, start `transcribePcm` on the audio so far. If speech
resumes, discard the result. At the real end-of-turn the transcript is usually ready, which saves most
of the STT time. This borrows Flux's `EagerEndOfTurn` / `TurnResumed` idea. Our Fish STT has only a
file-upload endpoint in its docs ([Fish STT guide](https://docs.fish.audio/features/speech-to-text.md)).
A streaming Fish ASR is **(unverified / not found)**.

---

## 4. Q3: frameworks

| Framework | What it gives | Fit for our TS server + OLX2 WebSocket | Adoption cost | Verdict: borrow what |
|---|---|---|---|---|
| **Pipecat** (Python, 15.8k★) | Full pipeline, Silero, Smart Turn default stop strategy, interruptions, many STT/TTS plugins. `pipecat-esp32` client is WebRTC, tested on S3-BOX-3 / CoreS3 ([pipecat-esp32](https://github.com/pipecat-ai/pipecat-esp32)) | Poor: Python, own transports. We would rewrite `apps/api`'s turn pipeline or run a Python sidecar | High | **Borrow Smart Turn (ONNX) and the "VAD 0.2 s + turn model + 3 s fallback" strategy** |
| **LiveKit Agents** (Python + Node `agents-js`) | Rooms/WebRTC, Silero + turn detector plugins, adaptive interruption, false-interruption resume, preemptive generation ([turns](https://docs.livekit.io/agents/build/turns/)). ESP32 SDK for S3/P4 with PSRAM ([ESP32 docs](https://docs.livekit.io/frontends/build/hardware/esp32/)) | Medium in theory (Node), poor in practice: needs a LiveKit server and WebRTC on the device, and the SDK expects PSRAM | High | **Borrow endpointing numbers (min 0.3–0.5 s, max 2.5–3 s) and the false-interruption pattern** |
| **OpenAI Realtime / Agents SDK (TS)** | `RealtimeAgent`/`RealtimeSession`, WebRTC / WebSocket / SIP transports, `server_vad`/`semantic_vad`, interruptions, tools ([agents-js voice](https://openai.github.io/openai-agents-js/guides/voice-agents/)) | Medium: could replace STT+LLM+TTS with one speech-to-speech session bridged from our socket. We would lose provider choice, the Vercel AI SDK tool loop and the memory design | Medium to high, plus vendor lock-in | **Borrow `semantic_vad` eagerness as a user-facing "patience" setting** |
| **Vocode** | Python voice-agent framework | Poor. Repo last pushed 2024-11-15 (GitHub API, checked 2026-09-24) | n/a | Skip |
| **TEN framework** (11k★) | Graph-based agent runtime, TEN VAD, TEN turn detection (7B text model) ([turn detection](https://github.com/TEN-framework/ten-turn-detection)) | Poor (C++/Go/Python runtime) | High | Borrow the **three-state** idea: finished / unfinished / **wait** ("hold on") |
| **HA Assist pipeline + ESPHome** | Wake → STT → intent → TTS, `continue_conversation`, VAD sensitivity presets, timers on the device | Poor to adopt (it is HA). Great to copy | n/a | **Borrow the question-mark rule, the preset numbers (0.25 / 0.7 / 1.25 s), the "no wake word on the next request" flag, and the 15 s timeout** |
| **ESPHome `micro_wake_word`** | microWakeWord + a **16 KB VAD model** | Excellent: we already run microWakeWord | Low | **Borrow `vad.tflite` as a Phase 1b VAD** |
| **Xiaozhi-esp32** (30k★, MIT) | Full ESP32 client: `listen` modes, TTS sentence events, abort, MCP over WS, server-side AEC option | Protocol is close to ours (JSON + binary on one WS) | Adopting would mean replacing our firmware (Opus, their server) | **Borrow: auto-continue after `tts stop`, wait for playback drain, `abort` with reason, `sentence_start` subtitles, realtime mode only with AEC** |
| **Willow** (S3-BOX) | ESP-SR AFE (AEC/BSS/NS/VAD), WIS server ([willow](https://github.com/HeyWillow/willow)) | Hardware mismatch (needs S3-BOX with PSRAM) | n/a | Skip |
| **Espressif ESP-SR** | AFE, WakeNet, VADNet, AEC | Full AFE needs PSRAM (739.7–1,238.5 KB) ([benchmark](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/benchmark/README.html)) | Standalone AEC: see section 5 | Only standalone AEC is worth a spike |

**Recommendation: do not adopt a framework.** Our transport (OLX2 over one WebSocket, paced PCM/MP3
downlink, pairing, spaces) and our agent (Vercel AI SDK ToolLoopAgent, memory) are already built. None
of these frameworks runs on a no-PSRAM ESP32-S3 with our protocol. Borrow three pieces: Smart Turn
(model), HA's continue-conversation rule plus its preset numbers, and Xiaozhi's state transitions.

---

## 5. Q4: barge-in and echo without hardware AEC

Facts:

- The Cardputer ADV has an ESP32-S3FN8 (8 MB flash; the product page lists no PSRAM), an ES8311 codec,
  one MEMS mic and an NS4150B amp with a 1 W speaker ([M5Stack](https://docs.m5stack.com/en/core/Cardputer-Adv)).
  The codec gives no echo reference, so a software reference would have to come from our own
  playback buffer. Aligning it with the mic is **(unverified)**.
- ESP-SR full AFE: 48.7–91.1 KB internal RAM **plus** 739.7–1,238.5 KB PSRAM
  ([benchmark](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/benchmark/README.html)). Does not fit.
- ESP-SR **standalone AEC**: SR_LOW_COST uses 18.8 KB internal RAM and 7.2 % CPU, **plus 64–126 KB
  PSRAM** depending on mode. The example allocates with `MALLOC_CAP_PSRAM`. Frames are 32 ms (SR/FD)
  or 16 ms (VOIP) ([AEC](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/acoustic_echo_cancellation/README.html)).
  Whether `caps` can point to internal RAM and fit in our ~230 KB free heap next to the WebSocket, TLS
  and microWakeWord (~26 KB arena for a v2 model, [okay_nabu.json](https://github.com/esphome/micro-wake-word-models/blob/main/models/v2/okay_nabu.json))
  is **(unverified)**. It needs roughly 85 KB contiguous in the best case.
- Commercial devices with barge-in use dedicated DSPs: HA Voice PE pairs the ESP32-S3 (8 MB octal
  PSRAM) with an XMOS XU316 for echo cancellation ([HA Voice PE](https://www.home-assistant.io/voice-pe/)).
  Alexa's Conversation Mode still needed a directedness model to cut self-wakes by 42 %
  ([Amazon Science](https://www.amazon.science/blog/new-alexa-feature-enables-natural-multiparty-interactions)).
- OVOS warns that listening without AEC means the assistant may hear its own TTS
  ([ovos-dinkum-listener](https://github.com/OpenVoiceOS/ovos-dinkum-listener)). Xiaozhi turns voice
  processing off while speaking unless in realtime (AEC) mode
  ([application.cc](https://github.com/78/xiaozhi-esp32/blob/main/main/application.cc)).

What is feasible, in order of cost:

1. **Half-duplex + explicit stop (have it).** Keys and BtnA send `cancel`. The server aborts
   (`session.ts` `turnAbort`, #377/#378).
2. **Wake word during playback, with ducking.** Keep microWakeWord running while the speaker plays.
   On detection, stop playback, send `cancel`, open a new turn. Mitigations: duck playback volume
   (for example −12 dB) while a partial detection is rising, and raise the probability cutoff during
   playback. The echo will raise false accepts **(unverified; must be measured)**. This is how Xiaozhi
   handles barge-in on AFE-wake-word boards (`EnableWakeWordDetection(IsAfeWakeWord())` while speaking).
3. **Short replies.** Brevity is the cheapest barge-in (section 6).
4. **Software AEC spike** (ESP-SR standalone AEC with internal allocation, reference from the playback
   ring). Only if (2) is not enough. Without AEC, never allow VAD-triggered barge-in.
5. **Server-side AEC** (Xiaozhi's `kAecOnServerSide`): the device streams mic audio during playback and
   the server, which knows exactly what it sent, cancels it. This moves the problem off the MCU, costs
   uplink bandwidth during playback, and needs time alignment through the network jitter. Xiaozhi's
   implementation details are **(unverified)**.

---

## 6. Q5: multi-turn task completion and dialog design

- **Context already persists.** `buildAgentMessages` sends conversation history. So "how much is a
  pineapple?" then "remind me to buy one at 6" resolves "one" if the second turn lands in the same
  conversation. **The loop, not the dialog manager, is the gap.**
- **Slot filling with a question.** If the reminder tool lacks a slot ("at 6: am or pm?"), the agent
  asks one short question. The reply ends in "?", so `expect_reply` is set (D6) and the window is
  8 s with the listening earcon. This is Alexa's prompt, then reprompt, then end pattern
  ([ASK sessions](https://developer.amazon.com/en-US/docs/alexa/custom-skills/manage-skill-session-and-session-attributes.html)).
- **Reprompt on no-input.** Google: first no-input, rephrase the question shorter. Second, restate once
  more. At most 3 errors, then exit ([Google errors](https://developers.google.com/assistant/conversation-design/errors),
  [Dialogflow CX voice design](https://docs.cloud.google.com/dialogflow/cx/docs/concept/voice-agent-design)).
  For a personal device, **one** reprompt is enough: if the window times out after a real question,
  play a short reprompt ("Six in the morning or evening?") and open one more 8 s window. Then close.
- **Confirmation.** Use implicit confirmation for low-risk actions ("OK, 6 pm: buy a pineapple").
  Use explicit confirmation only for destructive or irreversible ones. Confirm only the part that was
  unclear ("You mean 6 pm?") ([Dialogflow CX](https://docs.cloud.google.com/dialogflow/cx/docs/concept/voice-agent-design),
  [Voiceflow](https://www.voiceflow.com/pathways/conversation-design-best-practices)).
- **Brevity.** Alexa's one-breath test ([Alexa blog](https://developer.amazon.com/en-US/blogs/alexa/alexa-skills-kit/2019/08/five-benchmarks-for-writing-dialog-that-sounds-great-to-alexa-customers)).
  "Limit your voice agent to one or two sentences per turn" ([Dialogflow CX](https://docs.cloud.google.com/dialogflow/cx/docs/concept/voice-agent-design)).
  Our prompt already says "a few sentences". Tighten it to "one or two".
- **Ask a question only when you need an answer.** With continue-conversation keyed on "?", a
  rhetorical "Anything else?" makes the mic re-open every time. HA users ran into exactly this
  ([core#137450](https://github.com/home-assistant/core/issues/137450)). Prompt rule: *end with a
  question only when you cannot finish without the user's answer. Never end with "anything else?".*
  Better still, have the agent set an explicit flag (Phase 2, D6).
- **Exit phrases.** "Stop", "thanks", "that's all", "never mind" in a follow-up turn close the loop
  with no reply or a one-word "OK" (Google's list: [Nest Help](https://support.google.com/googlenest/answer/7685981)).

---

## 7. Recommended architecture for Bob, in phases

### Phase 1: firmware follow-up window and endpoint tuning (being built now)

**State machine** (in `state.cpp`; new state `kFollowUp`, or a flag on `kReady`):

```
Playing --playback_end + speaker drained--> (guard 250 ms, mic muted) --> FollowUp(window W)
FollowUp: mic on, VAD armed, pre-roll ring 300 ms, NOT streaming, UI "Listening…" + shrinking bar
  onset (>= 200 ms speech)  --> send turn_start{trigger:"follow_up"} + pre-roll frames --> Capturing (wake-style VAD end)
  window expires, no onset  --> kListenStop earcon (soft) --> Ready (wake word armed)
  key / BtnA / GO           --> Ready (or GO turn)
  wake word detected        --> normal wake turn
Capturing (wake or follow-up):
  end: speech then silence >= S(speechMs); or turnMs >= 15 s; no-speech 5 s -> cancel (wake_rejected)
```

Concrete changes:

| File | Change |
|---|---|
| `apps/cardputer/include/wake_word.h` | `kVadEndSilenceMs 700 → 1000`. Add `kVadEndSilenceShortMs = 1200` and `kVadShortUtteranceMs = 1500` (use the longer silence while total speech < 1.5 s). `kVadMaxTurnMs 8000 → 15000`. Add `kVadNoSpeechTimeoutMs = 5000`. Add `kFollowUpWindowMs = 6000`, `kFollowUpGuardMs = 250`, `kFollowUpOnsetMs = 200`, `kPreRollMs = 300` (these may go in `config.h`) |
| `apps/cardputer/src/wake_word.cpp` | Track `speechMs` (sum of speech frames). The end rule uses the silence value for the current speech length. Exit hysteresis: while in speech, a frame counts as speech at floor + 8 dB (onset stays at + 12 dB). Onset frames become a parameter, so a follow-up needs 20 frames and a wake turn keeps 5. After the no-speech timeout, `ended` with `heardSpeech == false` (already dropped as `wake_rejected`) |
| `apps/cardputer/src/state.cpp` | Enter the follow-up window only once playback has drained (`playback` idle), after the guard. Pre-roll ring of 30 frames × 320 B = 9.6 KB, allocated statically or once at boot, never per turn. On onset, open the turn (`turn_start`) and flush the pre-roll through `sendOrHoldFrame` before live frames. Consecutive-empty counter: 2 silent drops close the loop. Setting "Follow-up: on/off" (default on); "Always awake" stays as it is. `journal("followup_open"/"followup_onset"/"followup_expired")`, never audio or text |
| `apps/cardputer/src/protocol.cpp` | `buildTurnStart(turnRef, trigger)` adds `"payload":{"trigger":"follow_up"}` **only after** the server accepts it |
| UI / earcons | Keep `kListenStart` for wake/GO. For the follow-up window use a **distinct, softer** cue (one short note) or visual only, plus a countdown bar. Mic-open must always be visible (privacy, section 8) |
| `apps/api/src/schemas.ts` (**small server change, same phase, land first**) | `turn_start.payload`: `z.object({ trigger: z.enum(['wake','button','follow_up']).optional() }).strict()` |
| `apps/api/src/turn.ts` | If `trigger === 'follow_up'` and the turn is empty, too short, rejected by STT, or has an empty transcript: send `playback_end` with no audio and **no** "I did not hear anything" (#388 stays for wake/button turns). Journal `v2.turn_followup_dropped` |

Memory: pre-roll 9.6 KB + a few counters. No new tensors. Check free heap and largest block in the
HIL log after 20 follow-up cycles (no fragmentation from per-turn allocations).

Acceptance tests (Phase 1):

1. Host unit (`apps/cardputer/test/host`, doctest), `vadFeed` fed synthetic frames:
   - speech 2 s, silence 900 ms, speech: **not ended**; then 1,000 ms silence: ended.
   - speech 800 ms ("remind me to"), silence 1,100 ms: **not ended** (short-utterance rule); at 1,200 ms: ended.
   - silence only: ended at 5,000 ms with `heardSpeech == false`.
   - continuous speech: ended at 15,000 ms.
   - onset 150 ms burst with onset = 200 ms: `heardSpeech == false` (a door click does not open a follow-up turn).
2. Host unit for the follow-up state logic (if extracted as a pure function): window opens only after
   drain + guard, expires at 6,000 ms, 2 consecutive drops close the loop.
3. Server vitest: `turn_start` with `trigger:'follow_up'` validates. Unknown trigger rejects. An empty or
   too-short follow-up produces no TTS and no `error`. A wake turn still speaks "I did not hear anything".
4. **HIL on the real device** (per the "drive the app" rule), with recorded WAVs played from a speaker
   1 m away:
   - "Hey Bob, how much is a pineapple?", reply, then within 3 s "remind me to buy one at 6 pm":
     a reminder is created with "pineapple" in it, and no wake word was needed.
   - A 1-second mid-sentence pause ("remind me to … call mom") is not cut.
   - Reply, then silence: the mic closes at about 6.25 s and Ready shows. No uplink frames are sent in
     the window (journal shows no `audio_up`).
   - Reply, then TV speech in the window: at most one silent drop. No spoken error.
   - The reply's own tail does not open a follow-up turn (guard + drain): 20 cycles, 0 self-triggers.

### Phase 2: server semantic end-of-turn, `expect_reply`, streaming STT

Protocol additions (all optional, server schema first, then firmware):

| Message | Field | Meaning |
|---|---|---|
| `playback_end.payload` | `expect_reply: boolean`, `listen_ms?: int (0..10000)` | Server's view: the reply asked something. The device opens an 8 s window with the listening earcon; `listen_ms` overrides |
| new server→device `end_of_turn` `{turn_ref}` | | Semantic end-of-turn decided on the server. The device stops capture and sends `turn_end` as today (keeps a single end path) |
| `hello.payload` | `caps: { server_eot: true }` | The device advertises that it honours `end_of_turn`. Then the device fallback silence rises to **2,000 ms** |

Server work (`apps/api`):

1. **`expect_reply`**: compute from the final assistant text (HA rule: trimmed text ends with `?`),
   OR from a structured flag the agent sets (a zero-arg tool `expect_reply()` or an output field).
   Take the OR, so a missing "?" does not break a real question ([core#142310](https://github.com/home-assistant/core/issues/142310)).
   Add the prompt rule from section 6.
2. **Server-side endpointing** in a new module (for example `apps/api/src/endpoint.ts`): Silero VAD
   (ONNX, <1 ms per 32 ms chunk on one CPU thread, [silero-vad](https://github.com/snakers4/silero-vad))
   on uplink frames as they arrive. At 200 ms of silence, run Smart Turn v3.1 on the last ≤ 8 s.
   - p(complete) ≥ 0.5: send `end_of_turn` now.
   - Otherwise keep waiting. Re-run at each new silence. Force the end at **1,500 ms** of silence
     (tunable; Pipecat's default is 3 s, and 1.5 s is a middle point between AssemblyAI balanced and
     conservative).
   - Expected effect: complete sentences end about 200–400 ms after the last word (faster than today's
     700 ms), and incomplete ones wait up to 1.5 s (slower than today, which is what problem 2 needs).
3. **Speculative STT** at the first 300 ms pause (section 3.2). Or switch to a streaming STT with
   built-in end-of-turn (AssemblyAI Universal-Streaming or Deepgram Flux) behind the existing
   `transcribeAudio` seam. This is a provider decision for the owner (cost, privacy).
4. **Directedness filter for follow-up turns**: after STT, drop silently if the transcript is empty,
   is only fillers, is fewer than 2 words with low confidence, or a small classifier prompt ("Is this
   addressed to the assistant, given the last reply? yes/no") says no. This is a cheap version of
   Apple's lexical signal ([arXiv 2403.14438](https://arxiv.org/abs/2403.14438)). Log a counter only.
5. **Exit phrases** (`stop|thanks|that's all|never mind`) in a follow-up turn: no agent call. Short
   "OK" or silence, and `expect_reply:false` plus `listen_ms: 0`.
6. **Latency**: stream TTS per sentence (the first sentence starts playing while the rest is generated),
   and journal `eot_to_first_audio_ms` per turn so the section 8 budget can be checked.

Acceptance tests (Phase 2):

- Vitest: `expect_reply` true for "At 6 am or pm?", false for "Done, I'll remind you at 6 pm."; true
  when the agent flag is set without "?".
- Vitest with fixture WAVs (recorded, non-PII, in test fixtures): complete sentence gives `end_of_turn`
  ≤ 600 ms after last speech. "Remind me to… [1.2 s pause] call mom" gives no `end_of_turn` during the
  pause.
- A parity test between JS Smart Turn features and Python reference probabilities on ≥ 20 clips
  (|Δp| < 0.05).
- HIL: median `eot_to_first_audio_ms` ≤ 1,000 over 20 turns. Follow-up "remind me" flow passes with
  `expect_reply` driving an 8 s window.

### Phase 3: barge-in and hands-free polish

1. **Wake-word barge-in during playback** (microWakeWord stays on; duck to −12 dB on a rising score;
   `cancel` then a new wake turn). Acceptance: 20 barge-ins at normal voice from 1 m with the reply at
   default volume ≥ 80 % success, and < 1 false barge-in per hour of TTS playback (measure first).
2. **AEC spike** (ESP-SR standalone AEC, internal allocation, SR_LOW_COST, 32 ms frames, reference
   from the playback ring). Go/no-go: free heap after init ≥ 60 KB with Wi-Fi + TLS + WS up, CPU
   headroom for the capture loop, echo return loss ≥ 15 dB measured with a sweep. Only after it passes:
   VAD-based barge-in with a minimum of 300 ms speech (LiveKit's false-interruption idea: pause, then
   resume if no words follow, [LiveKit turns](https://docs.livekit.io/agents/build/turns/)).
3. **Subtitles**: `reply_text` per sentence (Xiaozhi `sentence_start`), so a long reply can be read and
   stopped early.
4. **Optional "Patience" setting** mapping to end-silence presets (fast 700 / normal 1,000 / relaxed
   1,250 ms), like HA's `VadSensitivity` and OpenAI's `eagerness`.

---

## 8. Design checklist

**Latency budget** (target first audio ≤ 1,000 ms after the user stops; stretch 800 ms).
Pipecat's primer measures about 1.3 s round trip in a typical cloud pipeline, "300 ms transcription
and endpointing, 650 ms LLM TTFT, 120 ms TTS TTFB", and calls 1,500 ms "an important target". Its
rule of thumb is LLM TTFT ≤ 600 ms ([voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/)).
Our budget:

| Stage | Phase 1 | Phase 2 target |
|---|---|---|
| End-of-speech detection | 1,000–1,200 ms (device silence) | 200–400 ms (Smart Turn) |
| Uplink tail + `turn_end` | ~50 ms | ~50 ms |
| STT | batch, measure (`v2` journal) | ~0 with speculative STT, or streaming STT |
| LLM first sentence | ≤ 600 ms | ≤ 600 ms |
| TTS first bytes + downlink prime | measure | ≤ 200 ms (per-sentence TTS) |

Phase 1 will not hit 1 s end to end, because the endpoint silence alone is 1 s. That is the accepted
trade for not cutting people off. Phase 2 wins it back.

**Earcons and visual cues**

- A distinct cue for each: mic opens (wake/GO), mic opens for follow-up (softer), mic closes / turn
  sent, error. Our `Earcon` enum has four of these. Add one follow-up cue.
- Always show a visual **"Listening"** state while the mic is open, including during the silent
  follow-up window, with a countdown bar. AVS requires "a prominent visual cue … for the duration of
  the time the product is recording" and says conveying mic on/off "is very important"
  ([AVS privacy & security](https://developer.amazon.com/en-US/alexa/voice-interoperability/design-guide/privacy-security)).
  Google and Alexa both show lights during follow-up windows.
- Attention states: Idle, Listening, Thinking, Speaking, Mic off, Error. Never use the same colour for
  two of them ([AVS privacy & security](https://developer.amazon.com/en-US/alexa/voice-interoperability/design-guide/privacy-security)).

**Privacy**

- Follow-up audio is **not streamed** until speech onset (D2). Nothing leaves the device during an
  empty window.
- Follow-up is a setting (Alexa made it opt-in). Mute or "mic off" disables it.
- Logs: counters and timings only (AGENTS.md rules). Never follow-up transcripts or directedness
  decisions with text.

**Error recovery**

- Wake turn with no speech: silent cancel (have it). Wake turn with a rejected clip: "I did not hear
  anything" (have it, #388).
- Follow-up with no speech, or speech not meant for the assistant: silent. Two in a row close the loop.
- `expect_reply` question with no answer: one shorter reprompt, then close
  ([Google errors](https://developers.google.com/assistant/conversation-design/errors)).
- Network or server error during a follow-up: the error earcon, then Ready. Do not re-open the loop.

---

## 9. Risks and open questions

1. **Self-trigger from the reply tail or room reverb** opening a follow-up turn. Mitigations: drain +
   250 ms guard, 200 ms onset, and the server-side silent drop. Measure on HIL (20 cycles, 0
   self-triggers). If it fails, raise the guard to 400 ms or use the microWakeWord VAD model.
2. **TV and background speech** in the window. Energy VAD cannot tell voices apart. The server
   directedness filter (Phase 2) and the 2-drop limit bound the damage. It is still a cost: each drop is
   one STT call.
3. **1,000–1,200 ms endpoint makes replies feel slower** until Phase 2. Consider shipping the
   "Patience" preset early if the owner prefers speed.
4. **Strict schemas**: firmware that sends `trigger` before the server accepts it breaks every turn.
   Land the server schema first and deploy. Firmware must also ignore unknown `playback_end` payload
   keys (check the `protocol.cpp` parser) before Phase 2 adds `expect_reply`.
5. **Smart Turn in Node** needs a Whisper feature extractor port. Its parity with Python is unverified.
   Fallback: run it in a small Python sidecar, or use a hosted streaming STT with end-of-turn.
6. **Question-mark heuristic** false positives and negatives (HA issues). Use the OR with an agent
   flag, and the prompt rule.
7. **Fish STT has no documented streaming mode**, so Phase 2 latency depends on speculative STT or a
   provider change. That is the owner's call (cost, privacy, vendor).
8. **AEC memory without PSRAM** is unverified. It is a spike, not a plan.
9. Open: should the follow-up window also follow timers and announcements (for example "Timer done…
   stop it?")? Alexa and Google do not open follow-up after alarms (**unverified**). Recommend no for
   now.
10. Open: exact current Alexa and Siri window lengths are not published (**unverified**). The numbers
    here come from the Google help page (10 s) and Alexa's 2018 launch coverage (5 s).

---

## Sources (primary unless noted)

Assistants: [Google Nest Help: continued conversation](https://support.google.com/googlenest/answer/7685981) ·
[TechCrunch: Alexa Follow-Up Mode](https://techcrunch.com/2018/03/10/now-you-can-have-a-conversation-with-alexa-without-screaming-hey-alexa-for-every-request/) ·
[Voicebot: Follow-Up Mode](https://voicebot.ai/2018/03/11/amazon-introduces-alexa-follow-mode-streamline-user-interactions/) ·
[TechRadar: Continued Conversation launch](https://www.techradar.com/news/google-assistant-update-adds-continued-conversations) ·
[Amazon Science: Conversation Mode](https://www.amazon.science/blog/new-alexa-feature-enables-natural-multiparty-interactions) ·
[ASK: manage skill sessions](https://developer.amazon.com/en-US/docs/alexa/custom-skills/manage-skill-session-and-session-attributes.html) ·
[AppleInsider: Siri back-to-back](https://appleinsider.com/inside/ios-17/tips/how-to-use-back-to-back-commands-with-siri-in-ios-17) ·
[arXiv 2403.14438 device-directed speech with LLMs](https://arxiv.org/abs/2403.14438) ·
[Apple ML: streaming device-directed speech](https://machinelearning.apple.com/research/streaming-on-device)

Home Assistant / ESPHome / OVOS / Rhasspy: [chat_log.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/conversation/chat_log.py) ·
[assist_pipeline/vad.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/assist_pipeline/vad.py) ·
[core#142310](https://github.com/home-assistant/core/issues/142310) · [core#137450](https://github.com/home-assistant/core/issues/137450) ·
[HA 2025.4](https://www.home-assistant.io/blog/2025/04/02/release-20254/) · [HA 2025.7](https://www.home-assistant.io/blog/2025/07/02/release-20257/) ·
[ESPHome voice_assistant docs](https://esphome.io/components/voice_assistant/) · [voice_assistant.cpp](https://github.com/esphome/esphome/blob/dev/esphome/components/voice_assistant/voice_assistant.cpp) ·
[ESPHome micro_wake_word](https://esphome.io/components/micro_wake_word/) · [vad.json](https://github.com/esphome/micro-wake-word-models/blob/main/models/v2/vad.json) ·
[HA Voice PE](https://www.home-assistant.io/voice-pe/) · [ovos-dinkum-listener](https://github.com/OpenVoiceOS/ovos-dinkum-listener) ·
[wyoming](https://github.com/rhasspy/wyoming/blob/master/README.md) · [wyoming-satellite](https://github.com/rhasspy/wyoming-satellite)

ESP32: [xiaozhi websocket.md](https://github.com/78/xiaozhi-esp32/blob/main/docs/websocket.md) ·
[xiaozhi application.cc](https://github.com/78/xiaozhi-esp32/blob/main/main/application.cc) ·
[xiaozhi protocol.h](https://github.com/78/xiaozhi-esp32/blob/main/main/protocols/protocol.h) ·
[xiaozhi-esp32-server config.yaml](https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/main/main/xiaozhi-server/config.yaml) ·
[ESP-SR benchmark](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/benchmark/README.html) ·
[ESP-SR AEC](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/acoustic_echo_cancellation/README.html) ·
[ESP-SR AFE](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/audio_front_end/README.html) ·
[ESP-SR VADNet](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/vadnet/README.html) ·
[M5Stack Cardputer-Adv](https://docs.m5stack.com/en/core/Cardputer-Adv) · [Willow](https://github.com/HeyWillow/willow) ·
[pipecat-esp32](https://github.com/pipecat-ai/pipecat-esp32) · [LiveKit ESP32](https://docs.livekit.io/frontends/build/hardware/esp32/)

Endpointing: [OpenAI Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad) ·
[LiveKit turn detector](https://docs.livekit.io/agents/build/turns/turn-detector/) · [LiveKit turns](https://docs.livekit.io/agents/build/turns/) ·
[smart-turn](https://github.com/pipecat-ai/smart-turn) · [Smart Turn v3](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/) ·
[Smart Turn v3.1](https://www.daily.co/blog/improved-accuracy-in-smart-turn-v3-1/) · [Pipecat Smart Turn docs](https://docs.pipecat.ai/api-reference/server/utilities/turn-detection/smart-turn-overview) ·
[AssemblyAI turn detection](https://www.assemblyai.com/docs/streaming/universal-streaming/turn-detection) ·
[Deepgram endpointing](https://developers.deepgram.com/docs/understand-endpointing-interim-results) · [Deepgram UtteranceEnd](https://developers.deepgram.com/docs/understanding-end-of-speech-detection) ·
[Deepgram Flux](https://developers.deepgram.com/docs/flux/configuration) · [Speechmatics turn detection](https://docs.speechmatics.com/speech-to-text/realtime/turn-detection) ·
[silero-vad](https://github.com/snakers4/silero-vad) · [silero utils_vad.py](https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/utils_vad.py) ·
[py-webrtcvad](https://github.com/wiseman/py-webrtcvad) · [TEN turn detection](https://github.com/TEN-framework/ten-turn-detection) ·
[Shannon et al. 2017](https://www.isca-archive.org/interspeech_2017/shannon17_interspeech.html) · [Stivers et al. 2009](https://www.pnas.org/doi/10.1073/pnas.0903616106) ·
[Fish STT guide](https://docs.fish.audio/features/speech-to-text.md)

Frameworks and design: [agents-js (LiveKit)](https://github.com/livekit/agents-js) · [OpenAI Agents SDK voice](https://openai.github.io/openai-agents-js/guides/voice-agents/) ·
[voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/) · [Google conversation design: errors](https://developers.google.com/assistant/conversation-design/errors) ·
[Dialogflow CX voice agent design](https://docs.cloud.google.com/dialogflow/cx/docs/concept/voice-agent-design) ·
[Alexa: five dialog benchmarks](https://developer.amazon.com/en-US/blogs/alexa/alexa-skills-kit/2019/08/five-benchmarks-for-writing-dialog-that-sounds-great-to-alexa-customers) ·
[AVS privacy & security design guide](https://developer.amazon.com/en-US/alexa/voice-interoperability/design-guide/privacy-security) ·
[Voiceflow conversation design](https://www.voiceflow.com/pathways/conversation-design-best-practices)
