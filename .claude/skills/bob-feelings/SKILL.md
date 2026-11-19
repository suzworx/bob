---
name: bob-feelings
description: "Create or change one of Bob's feelings (emotions/expressions): procedural visor eyes, eyelids, catch-lights, cheeks/blush, accents (hearts, Zzz, ?, !, sparkles, tears, notes) and the matching body language + ring. Use when adding an emotion, tuning how an existing one reads, mapping a device state or an agent mood to an emotion, or reviewing whether Bob looks adorable. Load bob-character first."
---

# Bob feelings

Load `bob-character` first (north star, art rules, palette, budgets).

## What a feeling is

A feeling = **eyes + lids + cheeks + accent + body language + ring**, all data. It never needs new art.

| Layer | Vocabulary (extend, don't replace) |
| --- | --- |
| Eyes (each eye independent) | dot, wide, big/small, `^ ^` happy arc, closed arc, half-lid, squint, angry slant, sad slant, heart, star, X, spiral, look L/R/U, roll, wink, skeptic (one squint), shades band, wavy (sick) — always with a small white **catch-light** that shifts with motion |
| Eyelids | slow squish blink (~180 ms, slight widen), double blink, sleepy droop, surprised lift |
| Cheeks | coral blush fade (shy, love, proud, embarrassed) |
| Accent (one at a time) | hearts rise, Zzz, ?, !, sparkles, tears, sweat drop, notes, confetti, lightbulb, check, X, bell, no-signal, spinner |
| Body language | a move from `bob-moves` (tilt, wiggle, droop, hop, shiver, bow…) |
| Ring | a RingSpec name from the ring table (see `bob-scenes`) |

## The table (single source)

The 47 emotions live in `libs/bob-device/src/bob_emotion_table.h` (X-macro: name, pose/moves, eyes, gesture,
accent, loop) on the Waveshare branch; the Python previewer `apps/cardputer/scripts/bob_emotions_preview.py`
parses the same header (`--check` keeps `docs/cardputer/bob-emotions.png` in sync). Wire name = lowercase
snake (`waking_up`); the server's `express` enum must match exactly.

Device states use these: Idle, Listening, Thinking, Speaking, Sleeping, WakingUp, Hello, Updating, Offline,
Error, Success, Failed. The other 35 serve `express` and scenes.

## Adding or changing a feeling

1. Ask: what moment is it for, and how does it **lift the mood**? Name it (one word).
2. Compose from the vocabulary above; prefer eyes first (they carry most of it), then one accent, then a small move.
3. Add the row to the table (+ the server enum and evals if it is user-requestable via `express`).
4. Regenerate the preview sheet; review: does it read in 1 second at 192 px? Is it distinct from its
   neighbours (e.g. Happy vs Joyful must differ by motion/accent)? Is it kind (no scary faces for errors)?
5. Device: `T emotion <name>`, screenshot, check frame time.

## Adorable checklist

Soft rounded eyes + catch-light · slow blinks · gaze toward the person/touch/prop · head tilt for
curiosity · tiny hops not big jumps · blush for warmth · sleepy yawns when idle long · tap Bob → giggle
wiggle + `^ ^` + one small heart. Never: sharp/angry-looking defaults, harsh flashes, red alarm screens.
