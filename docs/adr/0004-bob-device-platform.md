# ADR 0004: One Bob device library across ESP32 boards, desktop and Raspberry Pi

Status: proposed; P1 done on branch `feat/bob-device-lib-p1` (2026-10-21), P2-P4 open (#1076). Date: 2026-10-16.

## Context

The device firmware (`apps/cardputer`) started on one board, the M5Stack Cardputer. The Waveshare
ESP32-S3-Touch-LCD-1.85C port added a second board through a thin seam
(`include/board.h`: begin, update, keys, id, model, battery) and a round UI drawn into a PSRAM
framebuffer. The owner now wants a common library that makes the same Bob device run on more ESP
boards and on Raspberry Pi (Linux), "inspired by the Muse Gadget SDK".

Muse (`facebookincubator/muse-gadget-sdk`, Apache-2.0, checked at `fa07304`) describes each board with
one struct of capabilities and function pointers (`muse_board_t`: geometry, `round`, touch, talk hints,
init, display start, brightness, sleep, duplex audio, buttons, power), one file per board, a per-board
settings overlay, and a desktop SDL simulator that compiles the production UI. It ships separate ESP32
(ESP-IDF 6 + LVGL 9) and Linux SDKs on its own cloud. We take the ideas, not the code, the cloud or the
stack (see "Rejected").

What we already have that is portable:

- `protocol.h/.cpp`, `end_of_speech.h`, `follow_up.h`, `card_policy.h` and the other header-only
  policies are plain C++ with host tests (`test/host/`).
- All drawing goes through the LovyanGFX API (`M5GFX` on ESP32 is LovyanGFX with M5 boards). LovyanGFX
  itself runs on ESP32, RP2040 and Linux (SDL2 window or `/dev/fb`), so UI code written against
  `lgfx::LovyanGFX&` / `LGFX_Sprite` compiles on every target.
- Audio, input and network are reached through M5Unified, Arduino WiFi and the WebSockets library;
  these are the non-portable parts.

## Decision

Build `libs/bob-device`: a C++17 library with a portable core and per-target platform layers.

```text
libs/bob-device/
  core/        app state machine, protocol, VAD/follow-up/card/ring/touch policies, UI (draws on a
               LovyanGFX canvas), emotions + motion (data tables + renderer)  -- no Arduino, no M5
  hal/         interfaces: Board (descriptor + ops), Display (framebuffer canvas + present(rects)),
               Input (key/touch/button events -> KeysState), Audio (mic 16 kHz mono frames, speaker
               PCM 16 kHz, earcons), Power, Storage (kv), Net (WebSocket client), Clock, Log
  boards/      one file per board: cardputer, waveshare_s3_185c, (next) sim, rpi
  platform/    esp32-arduino (M5Unified/M5GFX/WiFi/WebSockets), linux (SDL2 or fbdev via LovyanGFX,
               ALSA, libwebsockets or Boost.Beast, file kv), sim (SDL2, file-backed audio, local server)
```

1. **Board descriptor.** `bob::Board` replaces `board.h`: `id`, `model`, geometry (`w`, `h`, `round`),
   capability flags (keyboard, touch, buttons, speaker, mic, battery, rtc, psram, ring), talk hint
   ("Hold BOOT or tap"), and ops (`begin`, `update`, `present`, `audio`, `power`). Each pin is cited to
   its source in the board file's header, as in Muse's porting recipe.
2. **One UI per form factor, not per board.** `core/ui/rect` (240x135-class landscape: the Cardputer
   screens) and `core/ui/round` (Bob-first round UI) both draw on the shared framebuffer through
   `Display::present(dirty_rects)`. A board picks the UI from its geometry.
3. **Input is key events.** Every board produces the Cardputer's `KeysState` + GO (touch, buttons and
   Pi GPIO are mapped by a header-only policy), so the state machine stays 1:1 across devices.
4. **Audio contract.** 16 kHz mono int16 frames of 10 ms up; 16 kHz PCM / MP3 down; earcons from the
   shared cabin-chime table. Boards own codec init and the speaker/mic hand-off on shared buses.
5. **Builds.** PlatformIO consumes `libs/bob-device` as a library for ESP32 envs; CMake builds the
   `sim` (Windows/Linux/macOS desktop) and `rpi` targets. Host tests keep running on the core.
6. **The desktop simulator comes first** among the new targets: it proves the core compiles off-device,
   gives the round UI and the 47 emotions a no-flash review loop, and gets golden-frame tests (render a
   scripted scene twice, diff PNGs), the idea we take from Muse's simulator.

## Phases

- **P0 (precondition):** the Waveshare firmware PR lands on `main` with HIL attestation.
- **P1 extract:** move the portable pieces (protocol, policies, emotions table, UI drawing) from
  `apps/cardputer` into `libs/bob-device/core` with no behaviour change; Cardputer and Waveshare builds
  stay byte-equivalent in behaviour (HIL + host tests).
  *Status (2026-10-21, branch `feat/bob-device-lib-p1`, on top of #1223): done for the Bob core.*
  `libs/bob-device/src` (flat, a PlatformIO library linked with `symlink://`) holds the tokens, the
  emotion table, the move and idle tables, the rig kinematics, rasteriser, eyes and compositor (now
  drawing into a `bob::Framebuffer`), the ring spec, policy and composer, and the scene catalogue and
  clocks, behind `bob_hal.h` (a Muse-style `bob::Board`: geometry, capabilities, framebuffer, dirty and
  present, touch, button, audio levels, clock, memory). Both ESP32 envs and `tools/bob-sim` build
  against it; the visual gate's 27 cases render byte-identical PNGs before and after (rig on, and the
  15 rig-off states). Deferred to P2: the protocol and the audio/VAD/card policies (still in
  `apps/cardputer/include`), the LovyanGFX-drawing UI (round UI, face, accents, ring renderer, scene
  compositor) and moving those onto the `bob::Board` operations. See `libs/bob-device/README.md`.
- **P2 HAL:** introduce `hal/` interfaces and the board descriptor; port both ESP boards onto them.
- **P3 sim:** CMake desktop target on LovyanGFX SDL2 with file-backed audio and a real WebSocket to the
  dev server; golden-frame tests in CI.
- **P4 rpi:** Raspberry Pi target (Pi 4/5 + a round or rectangular SPI/HDMI display, USB or I2S mic,
  speaker): ALSA audio, GPIO button, fbdev/SDL display, systemd service; pairs and talks like any device
  (`board=rpi-*`).
- **P5 gadget SDK (later):** document the device protocol and the board-porting recipe so others can
  build Bob devices.

## Rejected

- Adopting the Muse SDK itself: proprietary Meta cloud (Noise/VM, SDK tokens, phone-app pairing),
  ESP-IDF 6 + LVGL 9 (a full rewrite of our Arduino 2.0.17 stack), and its Jollybot avatar is not
  Apache-licensed.
- LVGL as the common UI layer: our UI and emotions already render well on LovyanGFX, which covers
  every target; LVGL would be a second rewrite.
- A separate firmware per board (fork): breaks the owner's 1:1 Cardputer-compatibility rule and drifts.

## Consequences

The core gets a hard "no Arduino/M5 includes" rule enforced by a check script. Board ports become a
descriptor plus a platform-layer file. The Pi and simulator targets share the device protocol client,
so server changes (e.g. `express`) reach every device class at once.
