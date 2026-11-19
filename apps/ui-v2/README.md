# `@bob/ui-v2` — Web client

React 19 + Vite on Astryx 0.6.2 design system. The UI for Bob conversations, Spaces (a nested rail of spaces and their threads, opening into a tabbed space — threads, tasks, notes, agenda, members — each section its own URL), notifications, search, account settings. Built with template-first (discover components via `npx astryx build`, use the CLI to explore).

## Running

```bash
npm run dev              # dev server from workspace root
npm run dev:ui          # or ui-v2 only, Vite on port 5173
BOB_WEB_PORT=6000 npm run dev:ui   # override port
```

Dev server proxies `/api` to the API on 7444. Auth works over the Supabase JWT guard; loopback dev mode is advertised by `GET /api/public-config` and mints a token via `POST /api/test-token` for testing without Supabase.

`localhost` is a secure context (microphone works); plain-HTTP LAN addresses are not.

## Testing and building

| Command | What it does |
| --- | --- |
| `npm test --workspace @bob/ui-v2` | Vitest suite (colocated `*.test.tsx` / `*.test.ts`) |
| `npm run typecheck --workspace @bob/ui-v2` | TypeScript check |
| `npm run build --workspace @bob/ui-v2` | Vite build to `dist/` (typecheck first) |
| `npm run astryx` | Astryx CLI (equivalent: `npx astryx ...`), e.g., `npm run astryx -- build "sign in flow"` |

## File layout

- **`src/main.tsx`** — React entry point
- **`src/app/app.tsx`** — Session gate and route dispatcher
- **`src/app/shell.tsx`** — Shell frame with sidebar navigation and pages map
- **`src/app/routes.ts`** — Route definitions (`/c/:id`, `/spaces`, `/spaces/:id/:section`, `/today`, etc.)
- **`src/app/`** — also the theme, page width and stale-build reload
- **`src/features/`** — one folder per feature, each with its `*-api.ts` client, hooks, components and tests
  - `chat/` — conversation surface, composer, message view, command palette and search
  - `voice/` — speech capture (VAD), transcription, playback (`mode/`)
  - `spaces/` — spaces page, nested side-nav rail (`spaces-nav.tsx`), threads, members, invitations
  - `productivity/` — tasks, agenda, events, notes, reminders, timers and the Today page
  - `memory/`, `devices/`, `account/`, `notifications/`
- **`src/lib/auth/`** — Session state and Supabase setup
- **`src/lib/`** — shared hooks (`use-online`, `use-refresh-on-focus`, `use-account-events`), query client, display name
- **`src/components/`** — Astryx-based UI components and pages

## Design guidelines

See `AGENTS.md` (Astryx rules, CLI workflow, self-check before finishing) and `CLAUDE.md` (workspace guidance for AI coding agents).

Template-first: `npx astryx build "<idea>"` → pick the result → `astryx template <name>` → customize → typecheck → test.

Independent static hosting from this workspace is documented in [the web deployment guide](../../docs/deploy-web.md). Railway remains the production fallback until cutover is verified.
