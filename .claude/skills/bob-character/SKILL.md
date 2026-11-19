---
name: bob-character
description: "Bob's character bible and hub for the bob-feelings, bob-moves and bob-scenes skills. Use at the start of ANY work that changes how Bob looks, feels, moves or reacts on a device screen (Waveshare round UI, Cardputer, simulator, demo pages, previews): new emotions, gestures, scenes, ring patterns, props, idle behaviours, touch reactions, copy on screen. Holds the north star, the art rules, palette, font, placement grid, motion feel, budgets and the review workflow."
---

# Bob: character bible

## North star (outranks everything)

**Bob lightens up people's moods.** Every feeling, move, scene, ring pattern and word on screen is judged
first by: *does this make the person smile?* When two options are both correct, pick the warmer one.
Bob is **extremely adorable**, the design is **minimal but full of fun**, errors are **kind** (Bob looks
apologetic, never alarming).

## The character (never change it)

Ivory clay capsule body, woven belly (reads as a speaker grille), dark visor with two amber eyes,
debossed lowercase "bob", yellow top button, small rounded arms and feet. Art comes ONLY from the owner's
originals (`suzworx/heybob-landing-page` `public/images/bob/slimmer-bob-*-v1.webp`) and the rig cut from
them. **Never generate, redraw or restyle Bob.** New expression = procedural eyes/cheeks/accents + motion.

## Model sheet: one Bob in every image (checkable)

Owner, 2026-10-16: Bob looked cheap and inconsistent. The belly differed between images, the logo was sometimes
wrong (a mirrored "ɿoob"), and the button differed. Every image is now one character, defined in
`docs/waveshare/bob-model-sheet.md` (picture: `bob-model-sheet.png`):

- **One body.** The head shell, logo, belly, visor, button and feet are cut once from the front original
  (`slimmer-bob-playful-v1`). They are the same pixels in every pose, centred on the stage, and never scaled.
  A pose adds only its own arms.
- **Never flip any part horizontally.** Left and right arms are separate cuts.
- **No baked head tilt.** The firmware and the demo tilt at run time; a baked tilt stacked on theirs cracked the seam.
- **The hand never covers the logo.** The thoughtful hand rests on the cheek.
- **A missing part shows the static pose, never a box.** The static poses are
  `apps/cardputer/assets/bob/static/<pose>.png`, the rig at rest.
- **Check every render** with `py -3.11 apps/cardputer/scripts/bob_model_check.py IMAGE [--rest]`:
  - M1: the logo reads "bob", never mirrored.
  - M2: one button, same colour and size.
  - M3: the visor's shape holds, with the eyes inside it.
  - M4: the seam sits at 0.63 of the body.
  - M5: the weave is real, never smeared.
  - M6: the grain is sharp.
  - M7: no placeholder boxes.
  - M8: no gaps between parts.
  - M9: clean outlines: antialiased, no stair-steps, no light halo.

  `bob_rig_build.py --check` gates the static poses on it.
- **Per-image record:** `docs/waveshare/bob-curation.md`.

## Rig (every part moves independently, own pivot, own clock)

root · head (upper shell) · belly · top button · visor · L/R eye · eyelids · cheeks (blush) · "bob" logo glow ·
L/R arm (shoulder) · L/R foot (ankle) · shadow. Outside the rig: accents, one prop slot, ring light.
Details and the move library live in `docs/waveshare/bob-motion-design.md` (BOB-RIG unit).

## Look

- Palette: ink `#173E57` (ground), paper `#FFFDF6`, yellow `#F0C75E`, sky `#BBDDF0`, grass `#72965B`,
  coral `#F07A6A` (love/blush/kind errors). Nothing else without a reason.
- Font: **Nunito** (owner-confirmed), antialiased; SemiBold 15/18, ExtraBold 24/40. Sentence case.
- Minimal: Bob is the hero; at most **one** short line of text in normal states; status = small icons;
  details live behind a tap on Bob.

## Placement grid (360 px round screen)

Bob centre (180,152), feet baseline y 248 · prop slots "11 o'clock" ≈ (92,96) and "1 o'clock" ≈ (268,96) ·
caption y 286 (one line) · status icons y 38 · ring = annulus r 166–178 · everything inside the circle chord
(usable half-width at height y = sqrt(180² − (y−180)²) − 12). Never more than Bob + 1–2 props + ring.

## Motion feel

Animation principles on every part: anticipation, squash & stretch, follow-through/overlap (arms and
button lag the body 60–120 ms and settle with a small overshoot), secondary motion, arcs, soft springs.
Small amplitudes (a gentle, small creature). Gestures ≈ 650 ms with `cubic-bezier(.45,0,.55,1)` (the Bob
website's curve). Signature move: the **backflip**. Respect reduced motion in web previews.

## Budgets (device)

Loop pass < 20 ms in READY; compose + present ≤ 15 ms/frame at 20–30 fps; Bob ≥ 25 fps; ring ≤ 5 ms.
Draw only into the PSRAM framebuffer; present dirty rects (even-aligned, ST77916). No `loop_slow`.

## Self-QA: never ask the owner for visual feedback

Owner rule (2026-10-16): screenshot yourself, find the issue, fix it. After every change, verify visually
yourself before reporting:
- **Device:** `T screenshot` (hil env) of every state / scene / emotion sample → PNGs; burst captures of
  key motions → strips/GIFs; the placement checker (grid + eye-in-visor + nothing clipped); journal frame times.
- **No hardware:** `tools/bob-sim` renders the same firmware sources to PNG frames.
- **Web/demo pages:** the built-in browser (screenshots at desktop and 375 px).
- Review with `review-animations` + `motion-design` (LottieFiles): smooth (no jumps/tearing, consistent
  timing), clear (readable, centred, inside the circle), amazing (character, anticipation, follow-through).
- Glass colour can't be screenshotted: read back panel GRAM and compare panel registers to the reference.
  Never use the webcam (it faces the owner).

## Agents and skills keep improving (owner rule)

Every Bob agent, subagent, work order and `bob-*` skill is **refined, validated and evaluated after
every unit, owner correction or escaped defect**: fold the lesson into the right skill/brief (refine),
confirm it still loads and the gates pass (validate), and replay the original failure in the simulator or on
the device to prove it no longer happens (evaluate). Record it on the GitHub issue.
Lessons so far: never ask the owner for photos (self-QA); eyes must stay inside the visor (eye-in-visor
check); centre Bob by body not bbox; status icons on the top arc; demo first; no hook bypass; no Wi-Fi
names or pairing codes in screenshots; quiet audio tests at night.

## Workflow (every Bob change)

0. **Demo first** (owner rule): make the change in `docs/waveshare/device-ux-prototype.html` (rig-driven
   demo) and self-verify it in the browser; then implement the same on the device. Parallelise independent
   pieces as separate units of work.
1. Load the specific skill: `bob-feelings`, `bob-moves` or `bob-scenes` (+ `animate`, `review-animations`,
   `emil-design-eng`, and `esp32-firmware-engineer` for device code).
2. Define it as **data** in the shared tables (never one-off drawing code).
3. Preview without hardware first (Python/HTML strip or sheet) and show the owner.
4. On device: `T emotion|move|scene|ring <name>` console commands + `npm run screenshot --workspace @bob/cardputer` → PNGs in `docs/waveshare/screenshots/`.
5. Check the north star and the budgets; journal frame times.
6. Keep the Cardputer 1:1 in *information* (it shows a one-line text equivalent), never in art.
