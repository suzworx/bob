---
name: bob-visual-qa
description: "Self-verify any Bob screen, layout or animation before reporting — never ask the owner for photos. Demo page first, then device; render with the desktop simulator, capture on-device screenshots and frame bursts, run the placement checker (Bob body-centred, status icons on the top arc, eyes inside the visor, nothing clipped, one caption line), make animation strips and review them for smooth / clear / amazing, and pass the visual flash gate (npm run visual:gate) before any Waveshare flash. Use after every Bob UI, layout, emotion, scene, ring or motion change, and when the owner reports something looks off."
---

# Bob visual QA (self-check loop)

Load `bob-character` (grid, palette, budgets) and, for motion, `review-animations` + `motion-design`.
Device mechanics are in `bob-device-ops`.

## The loop (every change)

1. **Demo first** — change `docs/waveshare/device-ux-prototype.html` (rig-driven); screenshot it in the
   built-in browser at 360 px glass size and at 375 px phone width. Agree the look there.
2. **Simulator** — `node tools/bob-sim/run.mjs render -- --state <s> --emotion <e> --frames N --out <dir>`
   (gcc in Docker; renders the real firmware sources to PNG; golden test via `run.mjs test`).
3. **Device** — flash the hil build, `T screenshot` every state / scene / sample emotion; for motion,
   burst-capture frames (`T screenshot` repeatedly or a burst command) and assemble strips/GIFs with ffmpeg
   (`ffmpeg -i f%03d.png -vf "tile=12x1" strip.png`, or `-vf fps=20 out.gif`).
4. **Placement checker** — `py -3.11 -I apps/cardputer/scripts/placement_check.py <pngs...>`:
   Bob body centroid x 180 ±3 (body, not bbox — arms skew the bbox), body centre y ≈ 145 (bob_tokens.json, measured from the approved demo); status icons
   symmetric on the top arc (r ≈ 150–155), inside the chord; eye pixels inside the visor mask; nothing
   outside r 178 except the ring annulus; ≤ 1 caption line in normal states.
5. **Review** (look at every image yourself):
   - *Smooth*: no jumps, tearing or pops between frames; consistent spacing; journal `bob_motion` avg ≤ 15 ms,
     `loop_slow` absent, Bob ≥ 20–25 fps.
   - *Clear*: readable Nunito, centred, inside the circle, minimal words, kind copy.
   - *Amazing*: character first — anticipation, squash & stretch, follow-through, eyes alive (blinks,
     catch-light, gaze), adorable timing; would it make someone smile?
6. **Flash gate: a command, not a judgment call** (lesson 2026-10-16: builds with jagged rig parts, seams,
   a mirrored logo, off-centre icons and cut text kept reaching the device because this step was prose).
   `npm run visual:gate` renders the 27 gate cases (9 states, 6 emotions, 4 moves at 3 key poses) in REST mode
   (Bob held still on both sides: demo `?freeze=rest`, firmware `-DBOBSIM_FREEZE=1`) from the firmware
   with bob-sim and diffs each against the approved-demo goldens (`docs/waveshare/golden/`). Then it writes
   `data/visual-pass.json` for this exact firmware hash and Bob variant. For a rig build, run
   `BOB_RIG=1 npm run visual:gate` and flash with the same variable set. The diff registers within ±1 px, then scores SSIM over
   the circle and per region (bob plus eyes, status arc, caption, ring), each case held to its own device ceiling
   minus 0.03 (faithful.py redraws the golden's text with the firmware's Nunito fonts and Bob from device blobs). It also runs the
   structure checks:
   - part seams
   - an arc centred ±2 px, symmetric, with the demo's icon count
   - Bob centred by body
   - nothing outside r 178
   - at most one caption line
   - a "bob" logo that is not mirrored

   Every failure is named ("ring missing", "status chips differ", "eyes differ", "seam", ...).
   Thresholds come from a measured ceiling: `tools/visual-gate/faithful.py`, a perfect port through RGB565,
   scores 0.995 or more. So a FAIL is the firmware, never the threshold.

   `npm run device:flash` and `npm run device:hil` refuse any `waveshare-*` env without that PASS (exit 3).
   `--force-unsafe` flashes anyway: it prints a banner and appends a line to
   `data/visual-gate/force-unsafe.log`, so say so in the report. A FAIL leaves a golden | candidate | heatmap
   sheet per state in `data/visual-gate/report/`: fix the firmware.

   A golden changes only through `npm run visual:golden -- --update <id>` (then `faithful.py --write`), after
   the owner approves the demo change. Device captures can be judged, as a report only:
   `npm run visual:gate -- --candidates <dir>`. Guide: `docs/waveshare/visual-gate.md`.
7. **Fix and repeat** until clean; then report with the evidence (sheet/strips, checker output, timings)
   and post it on the GitHub issue.

### Model-sheet check (every Bob image: demo, bob-sim, device capture, static pose)

Run `py -3.11 apps/cardputer/scripts/bob_model_check.py <pngs...> [--rest]` and fix every FAIL before
reporting. It catches:

- a mirrored or missing "bob" logo (M1)
- a wrong or extra button (M2)
- eyes outside the visor (M3)
- a moved seam (M4)
- smeared weave (M5)
- blurry resampling (M6)
- placeholder boxes from a part that didn't load (M7)
- cracks between parts (M8)
- ragged, stair-stepped or haloed outlines (M9)

The scale comes from the visor, so any render size works. `bob_model_check_test.py` proves the checker still
catches a mirror, a blank box and a crack.

## Known blind spot

Panel glass colour/gamma isn't visible in framebuffer screenshots: verify by panel GRAM readback and a
byte-for-byte register comparison with the reference init table (muse-gadget-sdk st77916_init_185c.h).

## Sheets (handy)

`ffmpeg -i a.png -i b.png -i c.png -filter_complex hstack=3 sheet.png`;
16-up grid: `xstack=inputs=16:layout=0_0|w0_0|w0+w1_0|...`. Keep sheets in the scratchpad or
`docs/waveshare/screenshots/` (sample data only — no Wi-Fi names or pairing codes).
