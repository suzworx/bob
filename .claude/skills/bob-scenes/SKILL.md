---
name: bob-scenes
description: "Create or change Bob's scenes and ring-light patterns: layered compositions where Bob (feeling + moves), props (clock, sun, cloud, rain, bell, checklist, calendar, magnifier, envelope, cake, confetti) and the ring light each animate on their own clock, triggered by the server's `scene`/`express` messages (chosen by tool call, never by phrase) or by device states. Use when adding a scene for a new action or moment, designing a ring pattern, or mapping an agent tool to a scene. Load bob-character first."
---

# Bob scenes

Load `bob-character`, `bob-feelings`, `bob-moves`; for device code also `esp32-firmware-engineer`;
for the server side `ai-sdk` + `websocket-development`.

## Anatomy of a scene (data, `libs/bob-device/src/scene_table.h`)

`{ name, bob: emotion + move(s), ring: RingSpec name, props[≤2]: prop + slot + keyframes, caption: label/value
(one short line max), seconds }`. Layers (ring, bob, props, caption) each have their own clock; dirty rects
per layer into the round UI `present()` list. Budget ≤ 15 ms/frame.

## Triggers (never phrase matching)

- Server → device `scene { scene, seconds 1..20, label?, value? }` when an agent **tool call succeeds**;
  the tool→scene map is ONE table on the server with a test (timer set → `timer_set` with value = seconds,
  weather → `weather_*` from the result, task → `task_added`, …).
- Server → device `express { emotion, seconds }` from the `express` agent tool ("show me some love" →
  love, "show me some moves" → music/backflip).
- Device states and announcements (timer/alarm/reminder) pick their scene locally.
- Devices advertise caps `scene` / `express` in hello; unknown names are ignored and journaled.

## Ring light language (`RingSpec` in `libs/bob-device/src/round_ring_policy.h`)

pattern × colours[1..4] × motion × speed × direction × segments. Patterns: solid, breathe, pulse, comet
(1–3 tails), dual comet, spinner, chase, wave, gradient sweep, fill/drain (progress), ticks, sparkle,
rainbow (sparingly), level (audio: `captureLevel01()` / `playbackLevel01()`), heartbeat. Motions: cw, ccw,
ping-pong, ease-in/out, bounce, still. Colour changes crossfade 300 ms. Precomputed annulus table; ≤ 5 ms.

## Catalogue (extend)

Signature: backflip, dance, happy wiggle, hug/love, celebrate · Daily: good morning, good night, wake-up
hello · Actions: timer_set, timer_done, alarm, weather_sun/cloud/rain/snow, music, task_added, note_added,
reminder, calendar, search, message_sent, success, failed · Kind errors: oops bow, no-Wi-Fi droop, mic-error
ear tap · Idle delights.

## Adding a scene

1. The moment and its mood lift (what makes someone smile here?).
2. Compose: Bob feeling + one move, ≤ 2 props in the 11/1 o'clock slots, one RingSpec, ≤ 1 caption line.
3. If server-triggered: add the name to the `scene` enum + tool map + test on the server, and to the device
   table (exact same name).
4. Preview (HTML/Python storyboard), then `T scene <name>` + screenshot on device; journal frame time.
5. Cardputer: one-line text equivalent (e.g. "[clock] 10:00") so information stays 1:1.
