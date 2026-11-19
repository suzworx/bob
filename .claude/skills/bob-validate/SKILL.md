---
name: bob-validate
description: "Bob validate stage. Use before calling any Bob change done, fixed or passing: npm run validate, the firmware flash/RAM budget, HIL on the Cardputer, the acceptance replay, attesting the pass, and driving the real app once. Use to verify, validate or check a unit, branch or PR."
---

# Bob: validate

Load `bob-dev` first. Nothing is done until this stage passes on the exact tree you will ship.

## Load these skills

- `verification-before-completion`: evidence before any "done", "fixed" or "passing".
- `esp32-firmware-engineer` for firmware budget or HIL failures; `systematic-debugging` for any failure.

## Steps

1. Run the validation gate on the branch: `npm run validate`.
   - `npm run validate -- --skip-firmware` is allowed only when the change touches no firmware and needs no
     PIO build. A full run records the pass for the tree in `data/validate-pass.json`.
   - The firmware steps fail on a machine without PlatformIO; CI's `firmware` job is then the firmware
     evidence. Say so in the PR rather than calling the run green.
   - Unit tests read the root `.env` through dotenv. A worktree with a `.env` (or a link to it) leaks local
     flags into them (`BOB_PROMPT_LAYOUT`, `BOB_DATABASE_URL`, caches) and fails dozens of tests that pass
     in CI. Run the gate with them blanked, e.g.
     `BOB_PROMPT_LAYOUT= BOB_DATABASE_URL= BOB_TTS_CACHE= BOB_EMBED_CACHE= npm run validate`.
   - Before believing a failure, rerun the failing file alone: a suite run next to a dev stack or browser can
     time out under load.
2. Firmware changes:
   - `npm run firmware:budget` (the flash and static-RAM budget);
   - HIL on the real Cardputer, following [shared-hardware.md](../bob-dev/references/shared-hardware.md):
     check the holders, run `node scripts/hil/run.mjs` (a full run is the recorded pass), then apply the
     boot-loop and NVS upgrade rules if the radio, boot or stored state changed.
3. Behaviour a person hears or sees: `npm run accept:replay` (real-app replay). Agent replies: the eval
   before/after in [agent-behaviour.md](../bob-dev/references/agent-behaviour.md).
4. Drive the real app once on the real path: the web app, or the device through `npm run dev:offline`.
   Mocks on both sides can both pass while the seam is broken.
5. After push: `npm run attest` (posts `local/validate` for the tree). After a HIL pass, also run
   `node scripts/device-attest.mjs`. Never attest content the gate did not pass here.
6. Record the evidence (command, exit status, one number) in the PR.

## Done when

- `npm run validate` passes on the tree being shipped;
- firmware: `npm run firmware:budget` passes and a full HIL run passes;
- the real app was driven once and behaved as the acceptance items say;
- the pass is attested, and the evidence is recorded.

Next stage: `bob-review`.
