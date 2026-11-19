# ADR 0001: Feature modules with a public API (DDD-lite)

Status: superseded by [ADR 0003](0003-flat-feature-folders.md) (2026-10-07). Accepted 2026-09-29 (epic #611, story #620).

## Context

`apps/api/src` grew as horizontal folders: every feature had a file in `store/`, one in `core/`, one `web-*.ts` router and its DTOs in the shared `web-schemas.ts`. To change tasks or reminders a developer touched four folders, and anything could import anything, so a "small" change had an unbounded blast radius and the import graph had cycles.

## Decision

Group code by **feature** under `apps/api/src/modules/<name>/`, keep the layers *inside* the feature, and expose a small public API:

```
modules/productivity/
  index.ts        public data API: stores, recurrence, timer tools, scheduler, types
  wiring.ts       transport entry for the roots: routers, reminder fan-out, summary mappers
  schemas.ts      the module's HTTP DTOs (web-schemas.ts re-exports them for the web client)
  recurrence.ts   pure domain logic
  <feature>/store.ts   SQL and row mapping   (bottom layer)
  <feature>/http.ts    Express router        (transport)
```

Rules, enforced by `scripts/check-boundaries.mjs`:

1. **`module-public-api`** – code outside `modules/<name>/` imports only `index.ts` or `wiring.ts` of that module (and `web-schemas.ts` its `schemas.ts`). Tests are exempt: they mirror the module and may reach in.
2. **`module-store-below-http`** – `store.ts`, `tools.ts`, `scheduler.ts`, `fanout.ts` and `recurrence.ts` never import the module's `http.ts`, the transport (`web-*.ts`, `session`, `turn`, `server`) or the device wire contract.

`index.ts` and `wiring.ts` are split on purpose: `core/` and `turn/` need the data API, and a router re-exported from the same barrel closes an import cycle (`core -> index -> http -> core`). The quality gate's cycle ratchet catches that.

### Ports only at swappable seams

We do **not** put an interface in front of every store. A port (interface + adapter) exists only where the implementation really varies: speech-to-text, text-to-speech, the agent, notification channels (see the ports spike, #627). Stores talk to Postgres directly; the seam for tests is `AppDeps` / `TurnDeps`, not a repository interface.

### Shared code

Anything two modules need lives below them: `store/` (db, spaces, membership helpers such as `requireSpaceMember`), `domain/`, `core/` (cross-feature orchestration), `logger.ts`. A module never imports another module's internals; if it needs its data it goes through that module's `index.ts`.

## Consequences

- One feature is one folder: tasks, reminders, timers and notes are found under `modules/productivity/`, and `git grep modules/productivity/index.ts` lists every consumer.
- Moving a file inside a module cannot break code outside it.
- Each remaining feature (collaboration #621, memory #622, identity & devices #623, conversations & chat #624, notifications #625, voice #626) follows this template; the legacy horizontal folders shrink until `store/` and `core/` hold only shared code (#630).
- Cost: an extra hop through `index.ts` when reading a call site, and a re-export list to keep in step; knip flags an export nobody uses.

## Test layout (decided in the close-out, #630)

Tests mirror the source tree rather than sitting beside it: `apps/api/tests/modules/<name>/` for a module's tests, `apps/api/tests/platform/` for infrastructure. Tests that cut across modules (route-table snapshot, agent factory and eval scorers) plus `support/`, `helpers/`, `integration/`, `compat/` and `fixtures/` stay at the top of `tests/`. Tests may import a module's internals (the `module-public-api` rule only covers `src/`); a test should still prefer the module's `index.ts` when it is not testing a private file.
