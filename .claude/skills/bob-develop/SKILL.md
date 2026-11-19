---
name: bob-develop
description: "Bob develop stage. Use to implement or build a planned Bob unit: work in a branch or worktree off the base branch, load the per-area skills, work test-first, and keep the diff inside the unit's owns. Covers apps/api, apps/ai, apps/ui-v2 and Cardputer firmware."
---

# Bob: develop

Load `bob-dev` first. You need a planned unit (`bob-plan`).

## Load these skills

- The per-area skills the unit names, from the AGENTS.md task-to-skill map ("Skills for Speed & Accuracy"):
  for example `esp32-firmware-engineer` for Cardputer work, `websocket-development` for the wire protocol,
  `ai-sdk` for `apps/ai`, `supabase` for migrations and RLS.
- `tdd`: the red test comes first.
- `systematic-debugging` before changing code to fix a failure.

## Steps

1. Work in a branch or worktree off the base branch ([facts.md](../bob-dev/references/facts.md#branches)).
2. State the plan (files to read, files to change, order, checks), write the red test, then the change, and
   run the unit's gates.
3. When the unit is delegated, read the result yourself: the diff and the gates' real exit statuses. A claim
   is not evidence. Send back only what must change.
4. If the unit touches the Cardputer or :7444, follow
   [shared-hardware.md](../bob-dev/references/shared-hardware.md) before any flash or HIL run.

## Done when

- every gate of the unit passed, as re-run by you;
- the diff stays inside `owns`;
- the unit is ready for `bob-test` (coverage) and `bob-validate`.
