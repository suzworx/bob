---
name: bob-test
description: "Bob test stage. Use to write, run or fix Bob tests: choose the layer (api Vitest, db and scenario suites, firmware host tests, ui-v2 Playwright e2e, live AI checks and evals, Cardputer HIL scenarios), write the red test first, and keep tests deterministic. Also for flaky tests and test subsets."
---

# Bob: test

Load `bob-dev` first. Commands and configs live in [facts.md](../bob-dev/references/facts.md)
("npm scripts by stage", "Test subset commands").

## Load these skills

- `vitest` for any Vitest test, especially timer- or clock-based ones.
- `playwright-best-practices` for ui-v2 e2e.
- `tdd` for the red-green loop.
- The API and firmware rows of the AGENTS.md task-to-skill map, for route, store or firmware tests.

## Choose the layer (the lowest one that can fail for the right reason)

| What changed | Layer | Run |
| --- | --- | --- |
| api logic, routes, session/turn pipeline | api Vitest (`apps/api/tests/`) | `npx vitest run --root apps/api tests/<file>.test.ts`, then `npm run test:unit` |
| SQL, RLS, migrations, stores against Postgres | db suite | `npm run test:db` |
| multi-step flows across modules | scenarios | `npm run test:scenarios` |
| root `scripts/` | scripts suite | `npm run test:scripts` |
| firmware logic that runs without hardware | firmware host tests | `npm run test:firmware` |
| web UI behaviour | ui-v2 e2e | `npm run test:e2e` (`test:e2e:smoke` for the smoke tag) |
| real model behaviour (replies, tool choice) | live evals, on the configured model | follow [agent-behaviour.md](../bob-dev/references/agent-behaviour.md) |
| the device end to end | HIL scenarios | `node scripts/hil/run.mjs --scenario a,b` |

Never `npm test --workspace @bob/api -- <file>` (TS5042). HIL means shared hardware: follow
[shared-hardware.md](../bob-dev/references/shared-hardware.md) first. Scenario list and console:
`docs/cardputer/hil.md`. Strategy: `docs/testing/test-strategy.md`.

## Steps

1. Write the test first and watch it fail for the reason you expect (red). Record the failing line.
2. Make the change (the worker does this; see `bob-develop`), then watch the test pass (green).
3. Keep it deterministic:
   - fake timers and injected clocks, never wall-clock sleeps or polling on real time;
   - pin dates (`vi.setSystemTime`, Playwright `page.clock`); never pick days relative to "today";
   - no dependence on test order, network or a shared database row left by another test.
4. Run the new test 3 times in a row. It must pass every time.
5. For an escaped defect, add the test that would have caught it, plus one for its whole class
   (`docs/testing/escaped-defects.md`).
6. Run the wider suite for the area (`npm run test:unit`, or the layer's full command).

## Done when

- the new test failed before the change and passes after, 3 runs in a row;
- the area's full suite passes;
- no test sleeps on the wall clock.

Next stage: `bob-validate`.
