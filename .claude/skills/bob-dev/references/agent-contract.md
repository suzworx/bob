# Bob agent contract

Every Bob dev agent follows this contract. Your brief adds the task, `owns`, skills and gates; this file
adds the rules that hold for every task. When the brief and this file disagree, the brief wins.

## North star

**Bob lightens up people's moods.** It is the single most important objective and
outranks every other rule here except safety and privacy. Judge your work first by whether it makes people
smile: Bob is extremely adorable, minimal but full of fun, and kind when things go wrong (warm replies,
apologetic not alarming errors). Anything that changes how Bob looks, feels, moves, sounds or speaks loads
the `bob-character` skill first (then `bob-feelings`, `bob-moves`, `bob-scenes` as relevant).

## Base branch

Read the base branch from [facts.md](facts.md#branches) "Branches" before you read or diff any code. Work
from that branch in your worktree. Never read from the main checkout's HEAD: it can sit on any branch.

## Ownership

Write only the paths listed in your `owns`. Everything else is read-only for you. When a fix belongs in a
file outside `owns`, record it under "Findings outside owns:" in your report and leave the file alone.
That includes the shared seams owned by `bob-platform`: schemas, registries, the app shell and
migration ordering. Report the seam change you need; the platform agent makes it.

## Red first

1. Write the failing test.
2. Run it and record the failing output.
3. Change the code until the test passes, then run it again and record the passing output.

## KISS, YAGNI, DRY

Make the smallest diff that meets the brief. Reuse the existing helpers before writing a new one. Build
only what the brief asks for: no speculative options, flags or extension points.

## Composition and denormalization

Prefer composition. Build behaviour by combining the modules and helpers that exist, not by adding layers,
tables or abstractions.

Prefer denormalization over normalization. Data with one row per owner (per user, per device) is columns on
the owner's row or on the shared per-user `bob.user_state`, never a new table. A concept that already has
a table gets a `kind` column, not a sibling table: timers are `reminders` rows with `kind` timer or alarm.

A new table needs a reason in the brief or the PR:

- a real one-to-many with its own lifecycle;
- row-level security through `bob_private.is_space_member`;
- an `on delete cascade` that account erasure depends on;
- a queue.

Keep user references as rows. A per-row foreign key to `auth.users` with `on delete cascade` is what makes
erasure work, so never fold them into JSONB or arrays: `event_attendees`, `task_subscribers` and
`reminder_recipients` stay tables.

Issue #757 is the worked example.

## Git and hardware

Git is read-only: never commit, push, stash, reset, checkout, branch or add. Use the device serial port
and port 7444 only when the brief says so; see [shared-hardware.md](shared-hardware.md) first.

## Privacy

Log and paste only metadata: ids, counts, durations, sizes, status codes. Never log or paste audio,
transcripts, agent text, prompts, credentials or URLs, in code, tests, evidence or the report. The allowed
fields are in [docs/log-reference.md](../../../../docs/log-reference.md).

## Honesty

Report the real exit code of every command. A type error is an error, even when the tests pass. A gate you
did not run is reported as skipped, with the reason. Quote evidence; a claim without output is not evidence.

## Report format

End with a report under exactly these headings, in this order:

```markdown
## PLAN
What you set out to do, one line per step.

## CHANGES
Each file changed, with its line count (added/removed).

## GATES RUN
Each command, verbatim, with its exit code. Skipped gates listed as skipped, with the reason.

## EVIDENCE
Test output, screenshot path or log excerpt that proves the change works (metadata only).

## RISKS
What could still be wrong, and what you could not verify here.

## Findings outside owns:
Problems or needed changes in files outside `owns`, including platform seams. "None" if none.
```
