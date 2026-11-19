---
name: bob-device-ops
description: "Operate the Bob Waveshare device (ESP32-S3-Touch-LCD-1.85C, COM4): build and flash the product or hil firmware, capture the serial journal safely, take on-device screenshots (T screenshot), drive the hil test console (T ui/scene/ring/move/touch/swipe), keep pairing (no NVS erase), use the secrets wrapper, coordinate COM4 between sessions, and run a quiet voice self-test from the PC. Use whenever you flash, monitor, screenshot, test or debug the Waveshare board."
---

# Bob device ops (Waveshare 1.85C)

Board: Waveshare ESP32-S3-Touch-LCD-1.85C **V2** (ES8311 + ES7210 on one I2S bus, ST77916 QSPI 360×360,
CST816 touch, TCA9554, 16 MB flash, 8 MB PSRAM) on **COM4** (USB 303A:1001). COM3 is the Cardputer —
never touch it. Firmware lives in `apps/cardputer` (envs `waveshare-s3-185c`, `waveshare-s3-185c-hil`,
bring-up `waveshare-s3-185c-bringup`).

## COM4 is a shared, single-owner resource

- One process at a time. Before opening it: `py -3.11 -c "import serial; serial.Serial('COM4').close()"`.
- **Opening COM4 resets the board** (USB-CDC). Plan captures so the reset is harmless.
- One session (the integrator) owns flashing; others are build-only unless handed COM4 explicitly.
- Never leave a capture running after you're done; never kill another session's process (only your own PIDs).

## Build & flash (keep pairing)

- Product: `cd apps/cardputer && py -3.11 -m platformio run -e waveshare-s3-185c -t upload --upload-port COM4`
  (or `BOB_COM_PORT=COM4 BOB_PIO_ENV=waveshare-s3-185c npm run flash --workspace @bob/cardputer`).
- **Do not erase NVS** unless the device identity changes — every erase forces the owner to re-pair.
- Needs (git-ignored, copy from the main checkout, never print or commit): `data/wake-test/hey_bob.tflite`
  and the secrets via the wrapper: `.pio/ws185-secrets/secrets.real.h` (the build refuses if
  `include/secrets.h` would shadow it). The wrapper seeds the **Production** profile.
- Use short worktree paths on Windows (PlatformIO hits MAX_PATH under the temp scratchpad).
- Temp worktrees: delete secret copies, then plain `git worktree remove` (never `--force`).

## Capture the journal (reconnecting)

Use a reader that survives the reset: loop `serial.Serial('COM4',115200,timeout=0.3)`, on exception log
`[port lost]`, sleep 0.5 s, reopen; write lines to `data/<name>-<time>.log` (redact
`ssid|host|code|token|claim|user_code|session` values). A capture that dies ~30 s after boot usually
means the board reset (watchdog) — check for `rst:`/`task_wdt`/`Guru`.

Journal keys worth reading: `v2.loop_slow(_phase)`, `v2.bob_motion frames/avg_us/max_us/loop_gap_max_ms`,
`v2.ui_present`, `v2.wake_stats fps/max_p/peak_db/floor_db/feed_avg_us/dropped`, `v2.wake_detected`,
`v2.earcon`, `v2.turn_*`, `capture_stalled`, `v2.audio_hang`, `v2.scene`, `wifi_heartbeat rssi`.

## On-device screenshots and console (hil env)

- `npm run screenshot --workspace @bob/cardputer -- out.png` (`BOB_COM_PORT=COM4`; streams the
  360×360 framebuffer; `BOB_SCREENSHOT_UI=ready,info,...` forces screens via `T ui <name>`).
- Console: `T ui <screen>`, `T scene <name> [seconds [value]]`, `T ring <name>`, `T move <name>`,
  `T emotion <name>`, `T touch x y [ms]`, `T swipe <dir>`, `T state`, `T ping`, `T panel`, `T ui colortest`.
- The framebuffer is the truth for layout; it cannot show panel colour/gamma (use GRAM readback + register compare).
- Never use the PC webcam (it faces the owner).

## Quiet voice self-test (no owner needed)

At READY with a capture running, speak from the PC at **low volume** (people may be asleep):
`Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Volume=30; $s.Speak("Hey Bob, what's the time?")`.
Raise volume only in small steps. Expect: `wake_detected` → `earcon listen_start` → `turn_started` →
`turn_ended end_reason=silence` → `earcon listen_stop` → playback → READY. If the mic level never moves,
the sound didn't reach the board (or capture is broken) — check `wake_stats peak_db`.

## Merge gate

Firmware pushes need a HIL pass (`data/hil-pass.json`); never bypass the pre-push hook. Run
`BOB_COM_PORT=COM4 BOB_HIL_ENV=waveshare-s3-185c-hil BOB_PRODUCT_ENV=waveshare-s3-185c node scripts/hil/run.mjs`.
Never push screenshots containing the Wi-Fi name or a pairing code.
