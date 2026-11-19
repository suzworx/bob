---
name: bob-dev
description: Bob development hub and entry point for the bob-* skill family. Use at the start of any Bob work (plan, dry run, implement, test, validate, review, release, merge, HIL, Cardputer) to find the stage skill, the ground rules, and the shared facts (branches, npm scripts, test commands, shared hardware, work-order template, review checklist).
---

# Bob dev hub

Start here, then load the skill for your stage. Facts live once, in `references/`, and every stage skill
links to them.

## Lifecycle map

| Stage | Skill | Done when this passes |
| --- | --- | --- |
| Plan | `bob-plan` | every unit has a work order with disjoint owns, skills and gates |
| Develop | `bob-develop` | the work order's gates pass and the diff stays inside its owns |
| Test | `bob-test` | the new test fails before the change and passes after (`npx vitest run --root apps/api <file>` or the layer's command) |
| Validate | `bob-validate` | `npm run validate` passes on the tree (plus HIL for firmware) |
| Review | `bob-review` | the review checklist passes with file:line evidence |
| Release | `bob-release` | the PR is squash-merged with CI green |

Schema change (fold, drop or add a table; expand/contract migration): load `bob-schema` alongside the stage skill.

## Ground rules (one line each)

1. Work from the base branch in [facts.md](references/facts.md#branches) (PRs target it too).
2. Every work order names the skills to load first (from the AGENTS.md task-to-skill map).
3. No secrets or PII in logs, evidence, work orders, issues or PRs (SSIDs, passwords, hosts, tokens, pairing codes, audio, transcripts, prompts).
4. `npm run validate` passes before anything is called done.
5. A Cardputer and :7444 may be shared between sessions: check the holders first ([shared-hardware.md](references/shared-hardware.md)).

## References

- [sop.md](references/sop.md): **the standard operating procedure** for one unit of work, start to merge.
- [facts.md](references/facts.md): branches, workspaces, where code lives, npm scripts per stage, test subset commands, key docs.
- [shared-hardware.md](references/shared-hardware.md): serial-port/:7444 holders, safe stop and restart, HIL, boot-loop and NVS upgrade rules, device attest.
- [brief-template.md](references/brief-template.md): the work-order template for delegating a unit to an agent.
- [review-checklist.md](references/review-checklist.md): what every diff must pass.
- [agent-behaviour.md](references/agent-behaviour.md): reproducing, testing and fixing what the assistant says or calls (configured model, flag matrix, red evals, gateway budget, model comparison).

The task-to-skill map and the long-form rules stay in `AGENTS.md` ("Skills for Speed & Accuracy"). Link to them;
don't copy them.
