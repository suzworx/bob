---
description: Answer whether this repo is ready to deploy — runs the full validation gate, checks tree/branch state, and returns a GO / NO-GO verdict with the blocking reasons.
argument-hint: [--skip-firmware]
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git rev-list:*), Bash(git stash list:*), Bash(npm run validate:*), Read, Grep
---

Working tree: !`git status --short`
Branch: !`git rev-parse --abbrev-ref HEAD`
Unpushed commits: !`git rev-list --count --left-right origin/main...HEAD 2>/dev/null || echo "no upstream"`
Recent commits: !`git log --oneline -5`
Stashes: !`git stash list`

Extra flags for the gate: $ARGUMENTS

Decide whether this repo is ready to deploy, and report a single verdict of **GO** or **NO-GO**.

1. **Run the gate.** Execute `npm run validate` (append `$ARGUMENTS` verbatim if non-empty — e.g. `npm run validate -- --skip-firmware` when the user wants to skip the PlatformIO firmware build). This is the authoritative check: git whitespace, staged-ignored scan, secret-pattern scan, typecheck, unit tests, firmware compile. Report its real PASS/FAIL and quote the failing step's output — never infer the result or claim it passed without seeing the output.
2. **Judge the working state** from the context above: uncommitted changes, unpushed commits, a non-`main` branch, or lingering stashes each mean work that would not reach the deployed server. Name them; don't silently ignore them.
3. **Check for anything obviously deploy-relevant and unconfigured** — e.g. `.env` missing while `.env.example` exists, or `apps/cardputer/include/secrets.h` missing when firmware is in scope. Do not read or print the contents of either file.

Then output, in this order:

- **VERDICT:** GO or NO-GO, one line.
- **Blockers:** the specific things that must be fixed first, each with the evidence (failing step name, file). Empty list if GO.
- **Warnings:** non-blocking things worth knowing before shipping (unpushed commits, skipped firmware build).
- **Next step:** the single command or action to run next — either the deploy/test command, or the fix for the top blocker.

Do not fix anything, commit, push, flash the device, or start the server. This command reports readiness only.
