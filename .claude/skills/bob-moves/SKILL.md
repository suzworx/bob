---
name: bob-moves
description: "Create or change Bob's movements: per-body-part keyframes on the rig (head, belly, top button, arms, feet, root, shadow), gestures, the backflip, dances, idle micro-behaviours and touch reactions, with springs, squash & stretch and follow-through. Use when adding a move, making Bob feel more alive or adorable, fixing stiff or janky motion, or wiring a move to an emotion, scene or touch. Load bob-character first."
---

# Bob moves

Load `bob-character`, then `animate` and `review-animations` (motion craft) and, for device code,
`esp32-firmware-engineer` + `animation-performance` thinking (frame budget).

## Model

Each rig part has its own transform (rotate about its pivot, offset, scale) and **its own clock**
(start, duration, loop, easing). A move = a set of per-part keyframe tracks + optional eye/cheek cues.
Tables are `constexpr` data (`libs/bob-device/src/bob_moves.h`, BOB-RIG-FW); the Python rig previewer renders the same
keyframes to strips (`docs/waveshare/screenshots/rig-move-<name>.png`).

| Part | Pivot | Typical motion |
| --- | --- | --- |
| root | feet centre | hop, squash/stretch (scale about the baseline), lean, sway, backflip, mirror turn, shiver, bow |
| head | seam centre | tilt/nod/shake ≤ ±8°, bob, look |
| belly | seam centre | breathe (scale 0.98–1.02), speaker pulse from `playbackLevel01()` |
| top button | base | wobble, spin, pop-up, bounce (follow-through) |
| arms | shoulders | wave, raise, clap, point, hug, hand-to-ear, chin-rub, shrug; rubbery stretch via scale |
| feet | ankles | tap, lift, step, splay on landing |
| shadow | under feet | shrink/fade with height |

## Craft rules

- Anticipation before any big action (a 80–120 ms counter-move/crouch).
- Squash on landing/contact, stretch on launch; preserve volume (sx·sy ≈ 1).
- Overlap: arms and button start 40–80 ms after the root and settle 60–120 ms later with a small overshoot.
- Arcs, not straight lines, for arm swings and hops.
- Springs for settles (critically damped + slight overshoot); the website curve for gestures.
- Small amplitudes; Bob is small and gentle. Idle motion is rare (one micro-behaviour every 10–25 s).
- Interruptible: a new move blends from the current pose (no snaps).

## Library (extend)

wave · hand-to-ear (listening) · chin-rub (thinking) · arms-up (joy) · clap · point-to-prop · shrug ·
foot tap · hop · happy wiggle · sway/dance · bow (thanks, apology) · look-around · button spin ·
shiver (scared) · droop (sad) · yawn + stretch (sleepy) · lean/squish (held) · giggle (tapped) ·
**backflip** (signature): crouch → launch (stretch) → full backward 360° of the whole rig (parts locked)
while airborne → land squash → wobble → settle, ≈ 900 ms, arms and button following through.

## Adding a move

1. What does it express, and how does it delight? Keep it under ~1 s unless it is a loop.
2. Author per-part tracks; add eye cues (blink on landing, `^ ^` at the peak).
3. Preview the strip (no device), then `T move <name>` + screenshot on device; journal frame time.
4. Wire it: from an emotion row (`bob-feelings`), a scene (`bob-scenes`) or a touch reaction.
