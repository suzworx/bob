# Work-order template

Use the block below as the prompt when you delegate one unit of work to an agent (a subagent, another
session, or a contributor). Fill every field; a vague work order costs a correction round.

## Rules for the header

- **owns** lists every path the worker may write, and nothing else. Take each path from the base branch
  (`git show origin/main:<path>`, `git ls-tree -r --name-only origin/main -- <dir>`). A path that doesn't
  exist there is a new file: say so.
- Units that run in parallel need disjoint owns. Read-only units say `owns: none`.
- **needs** names the units that must land first, or `none`.
- **kind** is the unit's kind (for example `docs`, `fix`, `feature`, `test`).
- **gate** lines are the commands that prove the unit. One command per line; each must exit 0 on a correct tree.
- **Skills to load first:** pick them from the AGENTS.md task-to-skill map ("Skills for Speed & Accuracy") and
  link to that map; don't copy it.
- No secrets, tokens, SSIDs, hosts, pairing codes or PII anywhere in the work order.

## House rules (every unit)

- A worktree installs its own packages (`npm install`), so its gates test its own code.
- Last gates: `npm run check:unit-gates` (boundaries, quality, agents manifest, dead code, agent doubles, typecheck; ~15 s), then `git diff --check origin/main`.
- A file over 600 lines must not grow; a new test file must match the owning domain's test glob in `.claude/domains.json`; agent doubles are built on `apps/api/tests/support/agent-harness.ts`; another module is imported only through its `index.ts`.
- Never junction or symlink `node_modules` between worktrees; never `git worktree remove --force`.

## Template

```text
owns: <path>, <path>
needs: none
kind: <kind>
gate: <command that proves it>
gate: npm run check:unit-gates
gate: git diff --check origin/main

Work only in the current working directory (your git worktree). Never read or write outside it.
<For units that don't need hardware:> Never touch a serial port or port 7444.

Skills to load first: `<skill>`, `<skill>` (from the AGENTS.md task-to-skill map).

# TASK <ID>: <one-line outcome>

## Why
<the problem, with evidence: issue number, log line, failing test>

## Change
<numbered, concrete steps; exact files and functions; what must NOT change>

## Tests
<the red test to write first; the subset command, e.g. npx vitest run --root apps/api tests/<file>.test.ts>

## Don't
<out-of-scope work, files not to touch, no commits>

## Write rule
At most one write per response and at most 120 lines per write; batch read-only calls together in one response.

## Plan check-in
Before your first write, state your plan in one text message, one line each:
PLAN files-to-read: ...
PLAN files-to-change: ...
PLAN order: ...
PLAN checks: ...

## Report back
- the files changed, with line counts;
- every command you ran and its real exit status;
- the output of every gate: line;
- anything you could not do, and "Findings outside owns:" (report them, don't fix them).
```

## After writing it

Hand it to the agent, then review the result against the work order's gates and owns
([sop.md](sop.md)).
