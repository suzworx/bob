---
name: bob-plan
description: Bob planning stage. Use to plan a Bob feature, fix, refactor or story, run a dry run, read the issue, and decompose the work into units with disjoint owns, skills and gates before any code is written (apps/api, apps/ai, apps/ui-v2 or Cardputer firmware).
---

# Bob: plan

Load `bob-dev` first for the ground rules. This stage writes no product code.

## Load these skills

- `find-skills`, to search for a skill that covers the work.
- `dry-run-gate` (repo skill `.claude/skills/dry-run-gate/SKILL.md`): its report structure is the plan. For a
  read-only planning pass by a subagent, use the `bob-dry-planner` agent (`.claude/agents/bob-dry-planner.md`).
- `bob-schema` for schema work (new table, fold, drop, migration): run its Stage A dry run first.
- The domain skills from the AGENTS.md task-to-skill map ("Skills for Speed & Accuracy") for the area you touch.

## Steps

1. Read the issue (`gh issue view <n>`) and its acceptance items.
2. `git fetch`, then read the code from the base branch ([facts.md](../bob-dev/references/facts.md)).
3. Run `find-skills` for any area, API or tool the map does not cover.
4. Run the dry-run gate (`dry-run-gate`, or the `bob-dry-planner` agent): scope, files, plan, risks, tests,
   go/no-go.
5. Decompose into units:
   - one objective per unit, and owns that are disjoint across units that run in parallel;
   - `needs:` for ordering, and a gate per unit that proves it (a test command, `npm run check`,
     `node scripts/check-doc-paths.mjs`, ...);
   - skills named for each unit;
   - hardware units say so, and every other unit says "Never touch a serial port or port 7444".
6. For delegated units, write each work order from [brief-template.md](../bob-dev/references/brief-template.md).

## Done when

- every unit has owns paths that exist on the base branch (or are marked new), skills and gates;
- the plan and the next action are written down (the issue or the PR description).

Next stage: `bob-develop`.
