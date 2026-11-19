# The db suite (`*.db.test.ts`)

`npm run test:db` runs the 15 `apps/api/tests/*.db.test.ts` files against the
LOCAL Supabase stack (full `npx supabase start`: they need gotrue for the
throwaway accounts). CI runs them in the `db` job of `.github/workflows/ci.yml`
(#116), separate from the `server` job, which starts the stack with `-x` and
runs only the default suite.

## Run it locally

Needs Docker running. Nothing else: no provider keys, since the model, STT,
embedder and extractor are all faked, and every test creates its own users.

```
npx supabase start                  # the full stack, not -x
npx supabase migration up --local   # the harness also does this
npm run test:db                     # all *.db.test.ts, serially
```

One or two files:

```
npx vitest run --root apps/api --config vitest.db.config.ts \
  tests/spaces/isolation-matrix.db.test.ts tests/memory/e2e-memory-parity.db.test.ts
```

- The harness refuses any non-loopback Supabase URL, so it cannot hit the
  hosted project. `BOB_TEST_DATABASE_URL` can pin a loopback connection.
- The `bob_server` password lives in `data/offline.env`. The first run
  creates it; `serverPasswordAt()` in `tests/db-harness.ts` is the one reader,
  safe when workers race to create it. Never print it.
- Set `CI=1` to skip SC-005 the way CI does (see below).

## What the CI job does

`db` runs when `changes` schedules `server` (api or migrations changed):
full `npx supabase start` with one retry after a clean stop, `migration up
--local`, then `npm run test:db`. GitHub sets `CI=true`, so SC-005 (a timing
budget) is skipped there. The job is not part of `validate` and not a
required check until about 2026-10-10 (two weeks green). Then add it to the
required checks.

## RLS coverage (#116 acceptance 2)

`isolation-matrix.db.test.ts` reads the catalog for every table in the `bob`
and `public` schemas. Each must have RLS enabled and forced and at least one
policy, so a new table without policies fails the suite. The only exceptions
are the listed server-only tables (`outbox`, `pairing_requests`, `waitlist`).
They must hold no grant to `anon` or `authenticated`, and a listed table that
no longer exists also fails. Adding to that list is a reviewed decision.

Two different databases are in play:

- `tests/db-harness.ts` (`setupMemoryTestDb`, used by `e2e-memory-parity` and
  `isolation-matrix`) connects as `bob_server` to the stack's live `postgres`
  database, after `supabase migration up --local`.
- `tests/support/pg-template.ts` (`createTestDb`, the default suite) clones a
  per-checkout template built from a schema-only dump of `auth`/`storage` plus
  this checkout's migrations.

## #435 triage (2026-09-25)

Five of nine tests failed on main2 in `e2e-memory-parity.db.test.ts` and
`isolation-matrix.db.test.ts`. All five were **test drift**. None was a
cross-account isolation or privacy bug in the product.

| Test | Cause | Kind |
| --- | --- | --- |
| US4-1 device to web | The device turn sent 10 x 320 B = 3,200 B (100 ms). CP-SRV-SHORT drops turns under `MIN_STT_PCM_BYTES` (9,600 B, 300 ms) before STT, so the journal showed `v2.turn_too_short` and the input stage finished with `empty: true`. No fact reached the extractor. | drift |
| US4-1 reverse (web to device) | Same short device turn: the agent was never built, so `agentOpts` stayed empty. | drift |
| SC-003 B's device sees none of A's | Same: its `agentOpts.length > 0` precondition failed before the isolation assertion ran. Isolation itself was never observed to leak. | drift |
| FR-013/SC-006 journal privacy | Counted `v2.memory_extracted` >= 2, but only the web turn extracted. The content-leak checks were never violated. | drift |
| governance: transfer ownership | #232 (2026-09-22) made `transferOwnership` group-only (`unsupported_kind`). The test (2026-09-16) still expected a private owner's transfer to resolve. The rule is fail-closed, so the test now asserts the rejection. | drift |

Fixes:

- The parity test sends `ceil(MIN_STT_PCM_BYTES / 320) + 10` frames, derived
  from the product constant so it follows any later change to the floor.
- The isolation matrix expects `unsupported_kind` for the private owner and
  success for the group owner. Non-owners are still refused everywhere.

### The pg-template lead (SCEN-LIVE)

It was real but did not cause these five. `pg-template.ts` restored `auth` and
`storage` with `--no-privileges`, so every cloned test database had empty schema
ACLs. As `authenticated`, the old template fails with `permission denied for
schema extensions` on `'[1,2,3]'::extensions.vector` and `permission denied for
schema auth` on `auth.uid()`. The live local database grants USAGE on `auth`,
`storage` and `extensions` to `anon, authenticated, service_role`; the template
now grants the same (recipe v3, so v2 templates are never reused), and both
probes succeed. The two #435 suites use the live database, so they were never
affected. `grantPlatformUsage()` in `tests/scenarios/harness.ts` (SCEN-LIVE, #453)
is now redundant and can be deleted once this branch sits on top of #453.

### SC-005, the 20 ms memory latency budget

Until now SC-005 passed without measuring anything: with 100 ms turns, no turn
reached STT, memory or the agent. With real turns it measured, median
end-of-speech to reply:

| Setup | Memory on | Memory off | Delta |
| --- | --- | --- | --- |
| Isolated, before the drain fix (3 runs) | 76.5 / 75.5 / 87.5 ms | 40 / 45.5 / 57.5 ms | 36.5 / 30 / 30 ms |
| Full suite, before the drain fix | 90 ms | 54.5 ms | 35.5 ms |
| Isolated, after the drain fix, silent (3 runs) | not printed | not printed | <= 20 ms (3/3 pass) |
| Isolated, after the drain fix, `--silent=false` (2 runs) | 79.5 / 84 ms | 45 / 48.5 ms | 34.5 / 35.5 ms |

With memory on, the fake extractor adds a fact after every turn, and the
debounced worker wrote to the database during the next timed turn, only
milliseconds later. Spoken turns are seconds apart, so both arms now call
`worker.idle()` between turns. The budget is still fragile: printing the
journal to stdout alone pushes the delta past 20 ms, because the memory-on arm
journals more lines. Treat SC-005 as a local smoke check, not a CI gate, until
it is measured on the real path (#394 perf work).

## Should a db-suite job run in CI?

**Recommendation: yes, as its own non-required job, then required after two
weeks green.** Done in #116: see "What the CI job does" above.

- Why: every failure in #435 was drift that CI could have caught the day it
  landed (#232 and CP-SRV-SHORT each broke a db test silently). The db suite is
  the only place the isolation matrix and the journal privacy checks run
  under real roles and RLS.
- Cost: the whole suite took 277 s locally (15 files, 125 tests) on a warm
  stack. In CI add a full `npx supabase start` (gotrue needed), a few minutes
  cold.
- Shape: a separate `db` job gated on the same `changes` filter as `server`
  (api, supabase/migrations). Run `npm run test:db`, exclude SC-005 from the
  gate (`-t` filter or skip it when `CI` is set), and keep it non-required
  until it has a green history.
- Measured on this branch: the full run before the drain fix passed 124 of 125
  (SC-005 failed, 277 s); the final full run passed 125 of 125 (15 files, 212 s).
