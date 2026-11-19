# ADR 0003: Flat feature folders

Status: accepted. Date: 2026-10-07. Supersedes [ADR 0001](0001-feature-modules.md).

## Context

ADR 0001 grouped `apps/api/src` into eight umbrella modules (`modules/identity`, `modules/productivity`, …), each with
features nested two or three levels deep, a `domain/` folder, and 15 `index.ts`/`wiring.ts` barrels that every
cross-module import had to go through. The barrels were pure pass-through, there were no import cycles to guard
against, and one concept (a device message, a conversation) was spread over many small files in several folders. Agent
ownership was sliced a third way, by 23 domains that did not match the folders.

## Decision

`apps/api/src` has one level of feature folders and no barrels:

```text
server.ts startup.ts shutdown.ts api-modules.ts app-deps.ts outbox-module.ts web-*.ts
platform/  account/  devices/  integrations/  spaces/  conversations/  memory/  notifications/  firmware/
tasks/  notes/  calendar/  reminders/  timers/  voice/ (keeps turn/ and audio/)
```

Three rules, enforced by `scripts/check-boundaries.mjs`:

1. Feature folders are flat, and features import each other's files directly.
2. `platform/` imports only `platform/`.
3. Root files wire everything together. Inside a feature, only `http.ts`, `<part>-http.ts` and `schemas.ts` (and the
   voice transport) touch the transport.

Tests mirror the folders: `apps/api/tests/<feature>/`.

## Consequences

- One place to look per concept, and no barrel to keep in sync with the files behind it.
- The `module-public-api`, `store-is-bottom-layer` and `domain-not-wire-format` boundary rules are gone with the
  folders they described.
- A feature's public surface is no longer declared in one file. If a cycle or an unwanted reach-in shows up, add a rule
  for that edge rather than bringing the barrels back.
