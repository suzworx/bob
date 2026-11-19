# Wake word on the Cardputer: decision record (#312)

Status: spike complete, module compiled into the firmware but not wired in (wiring is #313).
Date: 2026-09-23. Board: M5Stack Cardputer (StampS3, ESP32-S3, 8 MB flash, **no PSRAM**).

## Decision

Use **microWakeWord on TFLite Micro**, with ESPHome's **"Hey Jarvis"** model as the demo stand-in. There is no "Hey Bob" model today. A custom one comes from the microWakeWord training pipeline (see "Path to Hey Bob").
End of speech uses a small energy VAD in the same module.

## Update 2026-09-24 (CP-WAKE-BOB): "Alexa" by default, "Hey Bob" as the backup

This replaces the "Hey Jarvis" stand-in. The owner decided it, and it supersedes the history below where they differ.

| Word | Model (`lib/wake_models/`) | Source | Cutoff (uint8) | Window | Arena |
| --- | --- | --- | --- | --- | --- |
| **"Alexa"** (default) | `alexa.tflite`, 55,856 B | ESPHome micro-wake-word-models, Kevin Ahrendt, Apache-2.0 | 0.9 → 229 | 5 | 22,348 B on ESPHome's TFLM |
| "Hey Bob" | `hey_bob.tflite`, 62,304 B | Trained for Bob with kahrendt/microWakeWord (run A) | 0.988 → 252 | 5 | measured on the device (`wake_listening arena_used=`) |

- **One model at a time.** Each Invoke() takes ~16 ms of the 30 ms budget, so one 28 KB arena holds one model. Both files are `.incbin`'d, which costs flash but no RAM.
- **Switching words.** `w` in READY switches the word and journals `wake_word_changed word=<alexa|bob>,source=key`. If Always awake is listening, the running model stops and the other one starts. `wake_listening` carries `word=`. The strip, the mode toast and HELP say "Say Alexa" / "Say Hey Bob".
- **Persistence.** The choice is saved in NVS (`bob_cfg/wake`, debounced like the other settings, default alexa). It stays on the device: it is not in `device_state`, and the server and web do not sync it yet.
- **Why cutoff 252 for Hey Bob.** The owner favours recall, and triggering on "hey alexa" is acceptable. Held-out results: 0.75 % miss on clean audio, 5.5 % on the far-field proxy, 0 false accepts per hour over 5.3 h of dinner_party_eval.
- **hey_jarvis stays for comparison.** Its files remain, but the default build drops it. `-DBOB_WAKE_MODEL_JARVIS` puts it in the backup slot (`word=jarvis`, cutoff 247) for HIL comparisons.
- **The table in code.** `include/wake_models.h` has the per-model table, host-tested in `test/host/test_wake_models.cpp`.
- **HIL.** `wake-detect-speaker` covers alexa, then bob after `w`. `wake-reject-speaker` checks that "Hey Google" does not wake the device.

## Options

| Option | Runs without PSRAM? | Custom "Hey Bob" | Licence / cost | Verdict |
| --- | --- | --- | --- | --- |
| ESP-SR WakeNet9 | **No.** ESP32-S3 table: WakeNet9 needs 16 KB RAM + **324 KB PSRAM**, and the AFE needs about 740 KB PSRAM. WakeNet9s (the no-PSRAM variant) is for ESP32-C3/C5/C6 only. | Only through Espressif: 500+ speakers of corpus, 2–3 weeks of training, paid, via sales | Espressif licence | Ruled out: this board has no PSRAM |
| **microWakeWord / TFLM** | **Yes.** hey_jarvis is 52 KB of flash, with a 22.9 KB tensor arena on ESPHome's TFLM | Self-serve: Piper synthetic samples plus a training notebook; "intended for advanced users" | Apache-2.0 (code and models) | **Chosen** |
| Picovoice Porcupine | The microcontroller build targets Arm Cortex-M. The only MCU demo is `stm32f411`, and there is no ESP32 port | Console-trained `.ppn`, per platform | Commercial terms, **not checked in this spike** | Ruled out: no ESP32-S3 build |
| Energy "voice activity" trigger | Yes, about 0 KB | n/a (any loud sound wakes it) | none | Fallback only: every cough or TV line would open a turn |

Sources:
- WakeNet: https://github.com/espressif/esp-sr/blob/master/docs/en/wake_word_engine/README.rst
- ESP-SR memory and CPU: https://github.com/espressif/esp-sr/blob/master/docs/en/benchmark/README.rst
- WakeNet customisation: https://github.com/espressif/esp-sr/blob/master/docs/en/wake_word_engine/ESP_Wake_Words_Customization.rst
- microWakeWord: https://github.com/kahrendt/microWakeWord
- Pre-trained models: https://github.com/esphome/micro-wake-word-models (`models/v2/hey_jarvis.json`: cutoff 0.97, window 5, arena 22860)
- Porcupine: https://github.com/Picovoice/porcupine (README "Microcontroller" and `demo/mcu`)
- TFLM Arduino port: https://github.com/tanakamasayuki/Arduino_TensorFlowLite_ESP32

## What is real and what is a stand-in

- **Real:**
  - TFLM runtime and micro_speech frontend (40 bins, 30 ms window, 10 ms step, ESPHome's settings);
  - streaming inference every 30 ms;
  - 5-window smoothing, the latch, and a 1 s cooldown;
  - the energy VAD;
  - the model is linked into flash, 16-byte aligned.
- **Stand-in:** the word. You say **"Hey Jarvis"**. At the demo, say "Hey Jarvis wakes it; Hey Bob is being trained".
- **Pinned vendored files:**
  - `lib/wake_models/hey_jarvis.tflite` from esphome/micro-wake-word-models@05b6592, Apache-2.0, `LICENSE` beside it;
  - the TFLM library at commit 8572c72.

## Path to "Hey Bob"

1. Generate about 10k positive clips with piper-sample-generator ("hey bob", "hey oh-lexa", several voices and speeds), plus the published negative feature sets.
2. Train with microWakeWord's `basic_training_notebook.ipynb` on a GPU. Estimate: a day of iteration. Its README warns that usable models need hyperparameter work.
3. Drop the new `.tflite` into `lib/wake_models/`, rename the `.incbin` in `src/wake_word.cpp`, and copy `probability_cutoff`, `sliding_window_size` and `tensor_arena_size` from its JSON into the constants.
4. Re-run the hardware matrix below. Nothing else changes.

## Budget

| Item | Number | Kind |
| --- | --- | --- |
| Flash, main → this branch | 36.7 % → **41.7 %** (1,395,281 of 3,342,336 B), about +167 KB. That is 52 KB of model plus about 80 KB of TFLM, frontend and module code (symbol sizes), and the rest is kernels | **measured** (compile) |
| Static RAM, main → this branch | 16.0 % → **16.4 %** (53,604 of 327,680 B), about +1.3 KB (op resolver, globals) | **measured** (compile) |
| Heap while listening | 28 KB arena (hey_jarvis needs 22.9 KB on ESPHome) plus about 4–6 KB frontend (FFT, noise state). The exact figure is `wakeWordArenaBytes()`, logged as `[wake] ready held=` | **estimate** until read on a device |
| CPU | ESPHome with ESP-NN runs these models in a few ms per 30 ms. This port has **no ESP-NN**, so reference kernels could be several times slower. Estimate: 5–15 % of one core. Read `wakeWordMaxInvokeUs()` | **estimate** |
| The 320 KB PCM buffer | Already lazily allocated: `audio_playback.cpp` mallocs it only on a PCM reply and halves it on failure. MP3 replies never touch it, so no change is needed | read in code |

The heap rule for #313: listening and the MP3 decoder must not overlap. The decoder needs at least 32 KB free (`kMp3MinDecodeHeapBytes`), and the arena plus frontend is about 33 KB. Call `wakeWordEnd()` at wake, and `wakeWordBegin()` again once playback finishes. This also answers the echo question: detection is **paused during playback**. Barge-in would need AEC, which we don't have.

## False accepts and false rejects

These are expectations, not measurements. ESPHome tunes each model to minimise false accepts per hour on ambient speech, music and TV first, then maximises accuracy. The 0.97 cutoff is their shipped default.
Proposed acceptance target for #313:
- **≤ 1 false accept per 2 h** of TV or talk radio;
- **≤ 10 % false rejects** at 1–2 m in a quiet room.

If false accepts are too high, raise `kProbabilityCutoff` (247 = 0.97) before touching anything else.

## Privacy

- The module keeps no audio. Each frame becomes 40 feature bytes and is overwritten 30 ms later.
- The module sends nothing, and logs only `[wake] ready/…_failed` lines with byte counts.
- #313 must:
  - send no `turn_start` or `audio_up` before `wakeWordDetected()` or BtnA;
  - show the listening state on screen all the time;
  - implement mute by never calling `wakeWordBegin()`/`Mic.begin()` (the state saved in NVS).
- Journal counts only (`wake_detected` / `wake_rejected`).

## How #313 calls the module (`include/wake_word.h`)

Everything runs on the main loop, the same task that calls `M5Cardputer.Mic.record`. The module is not thread-safe.

```cpp
// READY, not muted: listen.
if (!wakeReady) wakeReady = wakeWordBegin();         // false: fall back to PTT (#330)
M5Cardputer.Mic.record(pcm, 160, 16000);             // same 10 ms frame as capture
wakeWordFeed(pcm, 160);
if (wakeWordDetected()) {
  wakeWordEnd(); wakeReady = false;                  // free ~33 KB before the turn
  playEarcon(); vadReset(); startTurn();             // turn_start, as BtnA does
}
// CAPTURING (wake-started turn): each captured frame
vadFeed(pcm, 160);
if (vadSpeechEnded()) endTurn();                     // turn_end; drop it if !vadHeardSpeech()
// After playback_end + reply shown: wakeWordBegin() again.
```

- VAD numbers:
  - speech is a frame 12 dB over the adaptive noise floor and at least 45 dB (about 180 RMS);
  - the turn counts as talking after 50 ms of speech;
  - it ends after 700 ms of silence (`kVadEndSilenceMs`), or at 8 s (`kVadMaxTurnMs`, well under the 1 MB uplink cap).
- `wakeWordFeed` also teaches the VAD the room's noise floor while it listens.
- **Link note:** nothing calls the module yet, and the linker's `--gc-sections` would drop it. So `platformio.ini` passes `-Wl,-u,bob_wake_word_keep`, and `wake_word.cpp` defines that table of function pointers, so the compile numbers above include the module. **Remove both** once `state.cpp` calls `wakeWordBegin()`.
- `-Wa,-I$PROJECT_DIR/lib/wake_models` lets the `.incbin` find the model. PlatformIO's `board_build.embed_files` was tried first and put the model at an odd address (`0x3c0e13c3`). The flatbuffer is read in 32-bit words, so that would fault. `wakeWordBegin()` now refuses a misaligned model.

## Owner hardware checks (not done in this spike)

1. The boot log shows `[wake] ready arena_used=… held=… stride=3`, and there is no `model_init_failed`. The older TFLM in this port has never been run with a v2 streaming model, so this is the **first risk to clear**.
2. The CPU margin: log `wakeWordMaxInvokeUs()` every 10 s while listening with Wi-Fi, TLS and the display live. It must stay well under 30 ms, and the main loop must not slip the 10 ms mic cadence.
3. Heap: `free` / `largest` (as in `state.cpp`) before and after `wakeWordBegin()`, and at `wakeWordEnd()` then the MP3 decode start.
4. Accuracy: 20 "Hey Jarvis" tries each at 0.5, 1 and 2 m, quiet and with TV. Then 1 h of TV or radio with nobody speaking, counting false accepts.
5. VAD: a short request ends about 0.7 s after you stop, a long ramble is cut at 8 s, and a noisy room still ends the turn. If the floor drifts, tune the 12 dB and 45 dB values.
6. Battery: note the drain over 1 h of listening against 1 h idle in PTT mode.

## If the first hardware check fails

- **Load error:** swap the TFLM library for Espressif's `esp-tflite-micro` (ESP-NN kernels, the one ESPHome uses). That is an ESP-IDF component, so it needs arduino-as-component, or a pioarduino platform build. That is **not this week**.
- **Demo fallback:** the same module's VAD alone gives a "tap once, then talk hands-free, ends on silence" flow: BtnA, `vadReset()`, then `vadSpeechEnded()`.
