# Test strategy: closing each class of escaped defect

The defects, the reasons the tests missed them and the gap classes A to K are in [escaped-defects.md](escaped-defects.md).
Each remedy below closes one class with one shared harness or table, so later features are covered without new work.
Effort: XS under 1 h, S one worker unit, M one or two units, L three or more units or hardware time.

## Remedies, ranked by defects caught per unit of effort

| # | Remedy | Class | Effort | Would have caught |
|---|---|---|---|---|
| 1 | Merge train | I | XS | #542+#543, #545+#546 |
| 2 | Gate-runner check in briefs | K | XS | MIG-ORDER shim (L-105) |
| 3 | Game mode transition table | E, B | S | 2, all five parts of 5 |
| 4 | Safety matrix: every write and view path, one sample table | F | M | 5 (web stream, title cue), 6 (all three) |
| 5 | Real-SDK agent harness, no hand-rolled agent doubles | A, B | M | 1, 2 |
| 6 | Bounds and time budgets from the Zod route schemas | D | M | 4, 5 (recentlyEnded), 7 (timer fan-out) |
| 7 | Wire compatibility, new against released | C | M | 3 (both parts) |
| 8 | Export and erasure coverage read from the schema | H | S | 7 (export), the #546 class |
| 9 | Fresh-stack e2e and db gates | J | S | #561 |
| 10 | Cross-member scope matrix for tools | G | M | 7 (voice cancel) |
| 11 | HIL: streamed reply on the real provider, and new firmware against the prod server | A, B, C | L | 1, 2, 3 on the real path |

## 1. Merge train (I)
Turn on "require branches to be up to date" for main2, or have the lead rebase onto current main2 and wait for fresh CI
right before each merge. Touches: GitHub branch protection only, or the maintainer's merge step. No code.

## 2. Gate-runner check (K)
Before writing a `gate:` line, the lead looks up the runner in `package.json` scripts (vitest for `scripts/`, api subsets
with `npx vitest run --root apps/api`). Optional: a lint that rejects `node --test` for `*.test.mjs`
files the repo runs under vitest. Touches: brief template; nothing in the repo.

## 3. Game mode transition table (E, B)
One table-driven test with a row per state: none, active, paused, paused and quiet, resumed, ended, ended past the
play_again window. The columns: kids filter, cue guard, streamed (device and web), memory tools offered, memory extracted,
tools offered, recentlyEnded size. Each row runs the real `resolveGameScope` on the test store, then the turn. A new
game or mode is one new row. Touches: new `apps/api/tests/voice/game-modes.test.ts` and a small `tests/support/game-states.ts`
seeding helper; it uses the `games-scope.test.ts` helpers.

## 4. Safety matrix (F)
- `apps/ai/tests/fixtures/hostile-samples.ts`: one table of samples, each with the expected verdict. It holds secrets,
  Luhn-valid card numbers, SSNs, "ignore previous instructions" text, invented game commands, and the game title as a
  benign case.
- `apps/ai/tests/memory-write-paths.test.ts`: every row against every memory write path (`remember` tool, extractor
  `filterOps`, the web memory edit route, import). Each path must give the same verdict, and none may trust a
  model-supplied `sensitive` flag.
- `apps/api/tests/guard-views.test.ts`: every game guard verdict checked on every view of the reply (stored row, SSE bytes,
  device TTS text). A reply the guard rejects must not appear in any of them.
- A prompt-layout case: a hostile memory is rendered as quoted data, never as an instruction.
Adding a write path means adding one entry to a `WRITE_PATHS` array. Touches: the files above; fixes go in
`memory-safety.ts` and `memory-tools.ts`.

## 5. Real-SDK agent harness (A, B)
- `apps/api/tests/support/agent-harness.ts`: builds a real `ToolLoopAgent` on `ai/test` `MockLanguageModelV4` from a
  script of steps (text deltas, tool calls, errors, delays). `turn-streaming-sdk.test.ts` already does this; lift it out.
- `apps/api/tests/support/paired-turn.ts`: a paired MP3 device session with a store, memory on and the real game scope.
  This is the production shape; a no-store session stays only for fallback tests.
- Rule test `scripts/no-agent-doubles.test.mjs`: fails when a test mocks `@bob/ai` agents with `stream: vi.fn` or
  `generate: vi.fn` (14 files today). The listed files are migrated, then the allowlist is emptied.
- One invariant test: a paired turn with no active game streams.
Touches: the two support files, the rule test, and the 14 test files (migrated in batches).

How to use it (TG-AGENT-HARNESS): `createAgentHarness(steps, { tools })` returns a real `ToolLoopAgent`; each step is
one model call made of parts (`words('It is sunny.')` for text deltas, `{ type: 'tool', name, input, result }`,
`{ type: 'delay', ms }`, `{ type: 'error', message }`, `{ type: 'abort' }`), and `harness.timeline` marks when each step
started and ended. For a whole device turn, mock the agent factory to `pairedAgent` and use `openPairedStore`,
`pairedSession(store, 'none' | 'paused' | 'active')` and `runPairedTurn(store, session, steps)`, which returns the wire
frames (types, audio seqs, error codes), journal events and the stored message count;
`apps/api/tests/voice/paired-turn-invariants.test.ts` is the worked example, and it fails on turn.ts from before #569.
`scripts/no-agent-doubles.test.mjs` refuses any new test that fakes `stream`/`generate` with `vi.fn`, a hand-written
object or a mocked implementation. Its allowlist (21 files, each with a reason) only shrinks: remove an entry when you
migrate that file, and the rule fails if an entry no longer fakes an agent.

## 6. Bounds and time budgets (D)
- `apps/api/tests/route-bounds.test.ts`: walks each route's exported Zod query and body schema and generates edge values:
  min and max, `Number.MAX_SAFE_INTEGER`, 0, negative, a 1 MB string, a 10k-item array. Each request must answer 2xx or 4xx
  within 250 ms. Routes register their schema in one array, and the test fails if a route under `web-*.ts` is missing.
  No new dependency.
- `tests/support/growth.ts`: runs an operation N times and asserts that module maps (`recentlyEnded`, timer signatures)
  stay bounded, and that store reads per change do not grow with the number of connected accounts.
Touches: the two files; export each route's schemas where they are not exported yet.

## 7. Wire compatibility (C)
- Firmware: `test_builders.cpp` writes every device->server builder's exact output (hello with and without version and
  caps, pair_request, turn_start, turn_end, cancel, the pickers, device_state, every announce_ack) to
  `apps/cardputer/test/fixtures/wire/emitted/`. The files are committed; the host test fails when one is stale, missing
  or orphaned. Regenerate them with `npm run wire:emit` after changing a builder, and commit the result.
- Server: `apps/api/tests/voice/wire-compat.test.ts` parses each emitted message under the current `schemas.ts` and under
  `apps/api/tests/compat/released-schemas.ts`, a frozen copy of the released server's client-message schemas. A message
  the released server refuses fails, unless `RELEASED_FALLBACKS` names the firmware fallback, its host test case and a
  fallback message the released server accepts. An entry the released server now accepts also fails, so the list
  shrinks at each release. It is empty since Release 1: the four extended hellos, listed against the pre-release
  snapshot (9d6655d) with the bare-hello fallback of #574 (`test_hello_fallback.cpp`), parse under Release 1 and were
  dropped. Unit cases against a synthetic strict-hello server keep the mechanism itself tested.
- Current snapshot: Release 1 (#444), `origin/main` at 6ddb3e9, taken 2026-09-28.
- Refresh the snapshot at every release, from the ref actually deployed, and commit it with the release:
  `node scripts/release/schema-snapshot.mjs --ref <deployed tag>`. It reads `apps/api/src/schemas.ts` at that ref with
  `git show` (no network), keeps `ClientControlDtoSchema` and every const it needs, and names the ref, sha and date in
  the header. `scripts/release/schema-snapshot.test.mjs` proves the committed file is exactly what the script makes
  from the sha in that header.
- Absent optional fields get their own fixture: `hello_no_version` goes through the real `handleControl` with
  `BOB_MIN_FW_VERSION` set and must get welcome and never `update_required`.
- Not yet built: the reverse direction (the release job builds the host parser tests at the released firmware tag and
  feeds them the server fixtures from `wire-fixtures.test.ts`), and running the snapshot step in the `release` job.
Touches: host `test_builders.cpp`, `wire-compat.test.ts`, `scripts/release/schema-snapshot.mjs`; later the `release` job in `ci.yml`.

## 8. Export and erasure from the schema (H)
A db-suite test lists every table with a user-owned column (the same query the erasure guard uses) and requires each one
to be in `web-export.ts` or on an exclusion list with a reason. Touches: `apps/api/tests/*.db.test.ts`, `web-export.ts`.

## 9. Fresh-stack gates (J)
The e2e `globalSetup` resets the DB, and each spec seeds what it reads. Worker gates for e2e and db run `test:db` or
`test:e2e` on a fresh template DB, never the dev DB. Touches: `apps/ui-v2/e2e` setup, brief template.

## 10. Cross-member scope matrix (G)
A table of every tool that lists, cancels or edits family data (reminders, timers, tasks, memories). Each runs as member A
in a Space with member B, with empty, vague and exact arguments; B's rows must be unchanged. This extends the RLS matrix
from SQL to the tool layer. Touches: new `apps/api/tests/tool-scope-matrix.test.ts`, shared Space seeding.

## 11. HIL real path (A, B, C)
Two new `scripts/hil/scenarios`: a streamed reply on the real provider over MP3 (the journal must show first audio before
the model finishes), and the main2 firmware against a server at the prod release tag (the journal must show a welcome).
Run before each release. Touches: `scripts/hil/scenarios`, `server-harness.ts`. It needs the rig, so it is run by hand.

## Suggested units

| Unit | owns | gates |
|---|---|---|
| TG-MERGE-TRAIN | branch protection (lead, no files) | `gh api repos/suzworx/Bob/branches/main2/protection` shows strict=true |
| TG-GAME-MODES | `apps/api/tests/voice/game-modes.test.ts`, `apps/api/tests/support/game-states.ts` | `npx vitest run --root apps/api tests/voice/game-modes.test.ts` |
| TG-SAFETY-MATRIX | `apps/ai/tests/fixtures/hostile-samples.ts`, `apps/ai/tests/memory-write-paths.test.ts`, `apps/api/tests/guard-views.test.ts`, `apps/ai/src/memory-safety.ts`, `apps/ai/src/memory-tools.ts` | `npx vitest run --root apps/ai tests/memory-write-paths.test.ts`; `npx vitest run --root apps/api tests/guard-views.test.ts` |
| TG-AGENT-HARNESS | `apps/api/tests/support/agent-harness.ts`, `apps/api/tests/support/paired-turn.ts`, `scripts/no-agent-doubles.test.mjs` | `npx vitest run scripts/no-agent-doubles.test.mjs`; `npm run test:unit` |
| TG-AGENT-MIGRATE-1..2 | 7 of the 14 double-using test files each | `npx vitest run scripts/no-agent-doubles.test.mjs` with those files removed from the allowlist |
| TG-ROUTE-BOUNDS | `apps/api/tests/route-bounds.test.ts`, `apps/api/tests/support/growth.ts`, schema exports in `apps/api/src/web-*.ts` | `npx vitest run --root apps/api tests/route-bounds.test.ts` |
| TG-WIRE-COMPAT | `apps/cardputer/test/host/test_builders.cpp`, `apps/cardputer/test/fixtures/wire/emitted/**`, `apps/api/tests/voice/wire-compat.test.ts`, `apps/api/tests/compat/**`, `scripts/release/schema-snapshot.mjs` | `npm run test:firmware`; `npx vitest run --root apps/api tests/voice/wire-compat.test.ts`, which fails on 8026995 with the origin/main snapshot |
| TG-EXPORT-SCHEMA | `apps/api/tests/export-coverage.db.test.ts`, `apps/api/src/account/export-http.ts` | `npm run test:db` |
| TG-FRESH-E2E | `apps/ui-v2/e2e/global-setup.ts`, `apps/ui-v2/playwright.config.ts` | `npm run test:e2e` on a fresh DB |
| TG-TOOL-SCOPE | `apps/api/tests/tool-scope-matrix.test.ts` | `npx vitest run --root apps/api tests/tool-scope-matrix.test.ts` |
| TG-HIL-STREAM | `scripts/hil/scenarios/**`, `scripts/hil/server-harness.ts` | `npm run device:hil:dry`; then one HIL run by the owner |

Every test unit also runs a break-proof step: revert the matching fix branch's source change in a scratch copy, show the
new test fails, then restore the original bytes (L-107).
