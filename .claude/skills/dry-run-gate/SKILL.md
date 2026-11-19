---
name: dry-run-gate
description: Produces a read-only, no-edits implementation plan (scope, files to touch, ordered plan, risks, tests, worker contract, go/no-go) before starting any non-trivial change in this repo. This skill is the source of truth for the Bob dry-run gate. Trigger this automatically at the start of any bug fix, feature, or refactor that will touch product code (TypeScript in apps/api or apps/ai, or firmware in apps/cardputer) — before the first Edit/Write call, before flashing, before committing. Also trigger explicitly on "dry run", "dry pass", "dry-review", "go through the dry gate". Skip it for pure investigation/read-only tasks, doc-only edits, or when the user has already approved a plan produced by this skill in the current conversation.
---

# Dry Run Gate

Every Bob change task starts with a **read-only planning pass** before any product code is touched: understand the task, produce a short written plan, and get it in front of the user (or at least written down) before editing starts. This skill's procedure below is the source of truth for that gate.

The point isn't ceremony — it's catching scope creep, missing constraints, and untestable acceptance criteria *before* they're baked into a diff. A plan that takes five minutes to write and is wrong costs a lot less than a firmware flash that's wrong.

## When to actually run this

Run it for anything where getting the scope wrong would waste real work: a bug fix that touches more than one file, a new feature, a refactor, a firmware change, a schema/wire-contract change. Skip it for single-line typo fixes, doc-only edits, or when you already have an approved plan from earlier in the same conversation — don't re-run the gate for every incremental step of a task that's already scoped.

## What to do

1. **Read before writing anything.** The user's task, the relevant `AGENTS.md` (root and any nested ones), the relevant source files and existing tests, current `git status`/diff, and anything already established earlier in the conversation. Load whatever domain skill matches the work (e.g. `esp32-firmware-engineer` for cardputer changes, `websocket-development` for wire-protocol changes) — read them now, not after something breaks.
2. **Do not edit product code, flash a device, install dependencies, commit, or make network/API mutations during this pass.** This is evidence-gathering and planning only.
3. **Write the dry report** using the structure below. If the user is present in the conversation, post it as your reply and wait for a go-ahead before implementing, unless they've already signaled "just do it" for this class of task.
4. Only after the report says `GO` (and the user has had a chance to redirect it) does implementation start.

## Dry report structure

Use these seven sections, in this order. Keep it tight — this is a plan, not a design essay. A paragraph or a short list per section is usually enough; expand only where the risk is real.

```markdown
## Scope
What this change does and, just as importantly, what it deliberately does not do.

## Files
The exact files that will be touched, and why. If a file is uncertain, say so rather than guessing.

## Plan
Ordered implementation steps, each concrete enough that a different engineer could follow it without re-deriving the design.

## Risks
Correctness, safety/security, compatibility, and observability risks. Call out anything hard to reverse (firmware flash, schema change, anything touching secrets/logs).

## Tests
What verifies this actually works: unit tests, `npm run validate`, hardware/device checks, manual verification steps. Say what you *can't* verify in this environment (e.g. no physical device attached) rather than glossing over it.

## Worker contract
If a subagent or another engineer will implement this instead of you: objective, exact editable files, invariants that must hold, forbidden files/actions, commands to run, expected evidence of success, rollback notes. Skip this section if you're implementing it yourself in the same turn.

## Go / No-Go
`GO` only when the scope is bounded and the acceptance criteria in Tests are actually checkable. Otherwise `NO-GO` with the specific blockers (missing info, ambiguous requirement, needs a decision only the user can make).
```

## Notes

- Don't propose broad refactors under cover of a bug fix — flag anything that looks like scope creep instead of just doing it.
- Flag secrets, PII, destructive actions (force-push, hard delete, `git reset --hard`), shared-file collisions with other in-flight work, missing test fixtures, and any claim in the plan that can't actually be verified in the current environment (no hardware attached, no live API key, etc.) — say so plainly instead of asserting it'll work.
- If the task is small enough that writing this out feels like pure overhead, that's a signal the task didn't need the gate — say so and proceed, rather than padding a report for its own sake.
