# Bob facts (the one place these live)

The other bob-* skills link here and don't repeat these facts. When one changes, change it here only.

## Branches

- `origin/main` is the base branch: base every branch, worktree and PR on it, and merge PRs into it.
- This is the one place the base branch is named. The other bob-* files say "the base branch" and link
  here, or spell it only inside a command.
- Units may run in parallel, each in its own worktree, only when no two running units own the same file.
  Grep the callers and tests of any seam a unit changes and put them in its owns.

## Database and secrets

- Hosted migrations are applied deliberately (`supabase db push` against your own project, after review);
  local development, tests and CI use the local Supabase stack in Docker.
- Secrets live only in the git-ignored `.env` (from `.env.example`) and your hosting platform's
  environment. Never commit a filled env file, and never print a secret in a log, PR or issue.

## Workspaces (npm workspaces, Node >= 22, strict TypeScript run by `tsx`)

| Workspace | Package | What |
| --- | --- | --- |
| `apps/api` | `@bob/api` | voice WebSocket server on :7444, `/api/*` web routes, stores; tests in `apps/api/tests/` |
| `apps/ai` | `@bob/ai` | agent loop (Vercel AI SDK) and tools; api imports it only as `@bob/ai` |
| `apps/ui-v2` | `@bob/ui-v2` | React 19 + Vite web client on Astryx; Playwright e2e in `apps/ui-v2/e2e/` |
| `apps/cardputer` | `@bob/cardputer` | PlatformIO ESP32 firmware; host tests in `apps/cardputer/test/host/` |
| `apps/mobile` | `@bob/mobile` | Capacitor iOS shell; never part of `validate` |

- The device wire contract (Zod DTOs + OLX2 frame codec) is `apps/api/src/voice/protocol.ts`.
- Where each feature lives (modules, `platform/`, composition roots): AGENTS.md "Structure & Workspaces"
  and "Where does X live?". Layering rules: AGENTS.md "Module boundaries".

## npm scripts by stage (names copied from the root package.json)

| Stage | Scripts |
| --- | --- |
| Develop | `npm run dev`, `npm run dev:offline` (`-- --stub-ai`, `-- --stop`, `-- --status`) |
| Fast gate | `npm run check` (boundaries + quality + typecheck + unit tests), `npm run typecheck` (`typecheck:api`, `typecheck:ai`) |
| Test | `npm run test:unit`, `test:db`, `test:scenarios`, `test:scripts`, `test:firmware`, `test:e2e`, `test:e2e:smoke`, `test:e2e:live`, `test:live`, `eval:local`, `eval:tools`, `eval:advice` (live evals: [agent-behaviour.md](agent-behaviour.md)) |
| Firmware | `npm run device:compile`, `device:flash`, `device:monitor`, `firmware:budget`, `device:hil`, `device:hil:dry` |
| Validate | `npm run validate` (`-- --skip-firmware`), `check:docs`, `check:quality`, `check:boundaries`, `lint:dead`, `accept:replay` |
| Release | `npm run attest`, `attest:device`, `release:check` |

The root `npm test` is typecheck only; the Vitest suite is `npm run test:unit`.

## Test subset commands

- One api test file: `npx vitest run --root apps/api tests/<file>.test.ts`.
  Never `npm test --workspace @bob/api -- <file>`: it forwards the file to tsc and fails with TS5042.
- DB suite: `npm run test:db` (`apps/api/vitest.db.config.ts`). Scenarios: `npm run test:scenarios`
  (`apps/api/vitest.scenarios.config.ts`). Integration config: `apps/api/vitest.integration.config.ts`.
- Firmware host tests: `npm run test:firmware`.
- HIL subset: `node scripts/hil/run.mjs --scenario a,b`. `boot-ready` always runs first, and a subset is never
  recorded as the pass. To check the plan without hardware: `node scripts/hil/run.mjs --dry-run`.

## Key docs

| Doc | For |
| --- | --- |
| `AGENTS.md` | architecture, wire contract, style, the task-to-skill map ("Skills for Speed & Accuracy") |
| `CLAUDE.md` | quick-start and commands |
| `docs/architecture.md` | target architecture and layer boundaries |
| `docs/testing.md`, `docs/testing/test-strategy.md`, `docs/testing/escaped-defects.md` | test layers, the escaped-defect rule |
| `docs/cardputer/hil.md`, `docs/cardputer/testing.md` | HIL runner, serial test console, scenarios |
| `docs/log-reference.md` | server journal and device serial log fields |
| `docs/deploy.md` | self-hosting and local sign-in |
| `apps/ui-v2/CLAUDE.md` | the Astryx template-first rule for UI work |
