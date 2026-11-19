# Integration development agents

Three repository-local Codex roles support integration work:

| Role | Assignment |
| --- | --- |
| `bob-integration-planner` | Inspect issues and current code; produce bounded work orders and validation plans. |
| `bob-integration-builder` | Implement one assigned slice within claimed paths and existing domain boundaries. |
| `bob-integration-reviewer` | Independently inspect changes and verify fixes without editing. |

Definitions live in `.codex/agents/`. They inherit the host's model and permission defaults. Planner/reviewer read-only behavior is an instruction, not a separate sandbox guarantee.

The shared workflow is `.agents/skills/bob-integrations/SKILL.md`; review guidance is `.agents/skills/bob-integration-review/SKILL.md`. Read the relevant skill before starting a role. `.claude/domains.json` remains the canonical file-ownership source; these roles describe stages and do not replace generated domain agents or permit cross-domain edits.

## Use

Open this repository in a Codex host that supports custom subagents. Ask explicitly, for example:

- “Use bob-integration-planner to inspect issue #597 and plan the next verified slice.”
- “Use bob-integration-builder for the assigned Calendar client work order; edit only its listed paths.”
- “Use bob-integration-reviewer to review this diff against #597, focusing on two-user isolation and unknown write outcomes.”

If the current host has not rediscovered repository agent files, start a fresh repository session and check its available roles. As a fallback, explicitly ask a native Codex agent to read the matching TOML instructions and skills before its assignment. Do not assume an already-running agent has loaded new files. Configuration parsing proves syntax only; host discovery and an actual delegated run are separate activation checks.

The lead assigns precise paths and checks claims before dispatch. Builders claim their paths using the repository claims command and release them afterward. Planner edits are limited to assigned plan/ledger paths; reviewers remain read-only. All roles preserve other sessions' changes and keep evidence in the existing task ledger or assigned issue.

## Current integration constraints

Calendar and Gmail are the initial scope. Credential choice remains unresolved until its production identity and callback contracts are proven. Do not treat a local token, mocked callback, or provider client as that proof. Reuse the existing API process and Postgres; queue workers do not justify another machine or service. Keep authorization in Core and clients independent of provider/agent implementations.

Before delivery, apply the repository validation and review gates. Distinguish implemented code, passed tests, approved external prerequisites, and verified live behavior.

Configuration format: [OpenAI custom subagents documentation](https://developers.openai.com/codex/subagents).
