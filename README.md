# Bob

Bob is a personal voice assistant you can run yourself. Hold a button on a
pocket-sized ESP32 device, talk, and Bob answers out loud; the same assistant
is available from a web app and a native iPhone app. Bob keeps tasks, notes,
reminders, calendars and memories for you and the people you share a space
with, and its one guiding rule is simple: **Bob lightens up people's moods.**

Website: [heybob.xyz](https://heybob.xyz)

## How it works

A [M5Stack Cardputer](https://docs.m5stack.com/en/core/Cardputer) streams
push-to-talk audio to the voice server over a single WebSocket. The server runs
speech-to-text, the agent and text-to-speech, and streams an MP3 (or PCM)
reply back for playback on the device. Conversations, accounts and everything
Bob remembers live in Supabase Postgres. Models (chat, STT, TTS, embeddings)
are reached through the [Vercel AI Gateway](https://vercel.com/ai-gateway).

| Part | Path | What it is |
| --- | --- | --- |
| Voice and API server | `apps/api` | Node + TypeScript (run with `tsx`): the `/v2/cardputer` WebSocket, the `/api/*` HTTP routes, the turn pipeline and stores |
| Agent layer | `apps/ai` | The agent loop and tools on the Vercel AI SDK, imported by the server as `@bob/ai` |
| Web app | `apps/ui-v2` | React 19 + Vite on the Astryx design system: chat, voice, tasks, notes, calendar, memory, devices |
| Device firmware | `apps/cardputer` | PlatformIO ESP32 firmware for the Cardputer |
| iPhone app | `apps/ios` | Native SwiftUI app (`BobKit` holds the API clients and state) |
| iOS web shell | `apps/mobile` | Capacitor shell that wraps the web app |
| Database | `supabase/` | Migrations, auth config, edge functions and email templates |

`AGENTS.md` is the detailed reference (architecture, the device wire contract,
module boundaries, style). `docs/architecture.md` describes the layers, and
`docs/diagrams/` has a high-level diagram per part.

## Quick start

You need Node 22 or newer and Docker (for the local Supabase stack).

```bash
npm install
cp .env.example .env
npm run dev:offline -- --stub-ai
```

`dev:offline` starts a local Supabase stack in Docker, applies the migrations,
creates a dev user (`dev@bob.local`) and runs the server on port 7444 with the
web app on `http://localhost:5173`. It prints a one-time sign-in code: choose
"I already have a code" on the sign-in page. `--stub-ai` replaces every model
call with a stub, so nothing leaves your machine. To talk to real models, put an
`AI_GATEWAY_API_KEY` in `.env` and drop `--stub-ai`. Stop the stack with
`npm run dev:offline -- --stop`.

The HTTP API reference is served at `http://localhost:7444/docs` while the
server runs ([docs/api.md](docs/api.md)).

### The device

Copy `apps/cardputer/include/secrets.example.h` to `include/secrets.h`, fill in
your Wi-Fi and server address, then build and flash with
`npm run device:compile` and `npm run device:flash` (PlatformIO; the serial port
comes from `BOB_COM_PORT`). See `apps/cardputer/README.md` and
`docs/cardputer/device-setup.md`. macOS notes are in `docs/mac-setup.md`.

### Self-hosting

The root `Dockerfile` builds one image that serves the API, the device
WebSocket and the web app. [docs/deploy.md](docs/deploy.md) covers a hosted
Supabase project, the environment, migrations and the device settings;
[docs/secrets.md](docs/secrets.md) covers where each secret goes.

## Tests and checks

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | Strict TypeScript across the workspaces (`npm test` is an alias) |
| `npm run test:unit` | The API Vitest suite (needs the local Supabase stack) |
| `npm run test:scripts` | Tests for the repo scripts |
| `npm run test:e2e` | Playwright end-to-end tests of the web app |
| `npm run test:firmware` | Firmware host unit tests |
| `npm run check` | Fast gate: boundaries, quality, typecheck and unit tests |
| `npm run validate` | The full gate: secret scan, typecheck, all suites, firmware compile (`-- --skip-firmware` to skip PlatformIO) |
| `npm run eval` | Agent eval suites against real models (needs `AI_GATEWAY_API_KEY`) |

Run `npm run validate` before opening a pull request. Commit messages and PR
titles follow [Conventional Commits](https://www.conventionalcommits.org/);
releases are cut from them automatically ([docs/release.md](docs/release.md)).

## Contributing

Issues and pull requests are welcome. Read `AGENTS.md` first; it holds the
rules every change follows (wire boundaries validated with Zod, no audio,
transcripts or secrets in logs, tests first). UI changes in `apps/ui-v2` use
Astryx components only (`apps/ui-v2/CLAUDE.md`).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
