---
name: bob-review
description: "Bob review stage. Use to review a Bob diff, unit, branch or PR, or to act on review feedback: the Bob review checklist (scope, owns, privacy of logs, Zod at wire boundaries, firmware mutex/stack/budget, deterministic tests, real-path proof), security review for auth and tokens, and log evidence from the Cardputer and server."
---

# Bob: review

Load `bob-dev` first. The checklist is
[review-checklist.md](../bob-dev/references/review-checklist.md). Run all of it, every time.

## Load these skills

- `code-review`: reviews against the repo's standards and against the issue or work order.
- `requesting-code-review` when you ask for a review; `receiving-code-review` when you act on one
  (verify each point before changing anything).
- `security-review` (built in) when the diff touches auth, device tokens, pairing, sessions, secrets or RLS.
- The area skills from the AGENTS.md task-to-skill map for what the diff touches (for example
  `esp32-firmware-engineer` for firmware).

## Steps

1. Get the diff against its base: `git diff origin/main...HEAD`.
2. Compare it with the work order or issue, then walk the checklist item by item. Note file:line for each failure.
3. Run `code-review`, and `security-review` if auth, tokens or secrets are touched.
4. For runtime claims (stalls, drops, truncated replies, pairing), get evidence from the logs with the
   `bob-log-rca` agent (`.claude/agents/bob-log-rca.md`). Field guide: `docs/log-reference.md`.
5. Record the verdict on the PR, naming each failed item.

## Done when

- every checklist item passes, with evidence;
- `security-review` found nothing open (when it applies).

Next stage: `bob-release`.
