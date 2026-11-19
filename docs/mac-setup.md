# Continuing Bob on macOS

This repository was developed on Windows. Everything in `apps/` is Node or PlatformIO and runs
unchanged on macOS; the differences are the Python launcher and the serial port. This page is the
complete list.

## 1. Clone and install

```bash
git clone https://github.com/suzworx/bob.git
cd bob
npm run setup       # Node check, .env from example if missing, npm install, prerequisite checks
```

Put your `AI_GATEWAY_API_KEY` in `.env` (spelled exactly like that — `OPEN_ROUTER_API_KEY` is a
typo nothing reads, and `npm run setup` flags it). It is git-ignored by design and never leaves the
machine it was created on, so it does not travel with the clone.

Confirm the checkout is healthy before changing anything:

```bash
npm run validate -- --skip-firmware
```

Expect `==== validate: PASS (7 steps) ====`. The firmware step is covered in section 3.

Then run the app itself. Nothing above proves the two servers actually talk to each other:

```bash
npm run validate:non-device   # the gate, plus live HTTP checks against a real server
```

Expect `==== validate: PASS non-device autonomous (18 live checks) ====`. Add `--live-only` to skip
the three full gate runs inside it while iterating.

## 2. Agent skills and commands are in the repository

`.claude/skills/` (the project's own `bob-*` skills), `.claude/commands/` and `.claude/agents/` are
tracked. Third-party skills listed in `skills-lock.json` are installed per machine.

Still machine-local and absent on a fresh clone: `.claude/settings.local.json` (per-machine tool
permissions), `.env`, `certs/`, `data/`, and `apps/cardputer/include/secrets.h`.

## 3. Cardputer firmware

`apps/cardputer/scripts/run-pio.mjs` invokes PlatformIO through a Python launcher that defaults to
the Windows-only `py -3.11`. Override it, and the serial port, in your shell profile:

```bash
export BOB_PIO_PY=python3
export BOB_COM_PORT=$(ls /dev/tty.usbmodem* | head -1)
```

`apps/cardputer/scripts/free-serial-port.mjs` already detects a non-Windows platform and no-ops, so
`device:flash`, `device:monitor` and `device:run` work once those two variables are set.

Firmware secrets are not in the repository:

```bash
cp apps/cardputer/include/secrets.example.h apps/cardputer/include/secrets.h
```

With PlatformIO installed the full gate runs as on Windows:

```bash
npm run validate          # 8 steps, including the firmware compile
```

## 4. Running the browser client

No certificate and no privileged port. The client is served over **plain HTTP on 5173**, which is
unprivileged, so nothing needs elevation:

```bash
npm run dev:all      # API on 7444 + client on 5173
```

Open `http://localhost:5173`. `localhost` is a secure context, so the microphone works there.
A LAN address over plain HTTP — `http://192.168.x.x:5173` — is **not** a secure context: text chat
works and the record control stays inert. See `apps/ui-v2/README.md` for that rule.

> Earlier revisions of this page described `npm run certs`, an HTTPS origin at `http://bob.local/`
> and binds on 80/443. That design was reverted — there is no `certs` script, `apps/ui-v2/vite.config.ts`
> has no HTTPS branch, and `BOB_HTTP_PORT` is read by nothing. Use `BOB_WEB_PORT` to move the
> client's port.

## 4a. Signing in — the part a fresh clone does not get for free

Every `/api/*` route is behind a Supabase JWT guard, so a checkout with an empty `.env` boots fine
and then shows *"Sign-in is not available right now"*. Pick one of two paths:

**Local, no internet except the AI** (needs Docker Desktop running):

```bash
npm run dev:offline            # local Supabase in Docker, a dev user, then both servers
npm run dev:offline -- --status
npm run dev:offline -- --stop
```

Add `--stub-ai` to stub the model too. Emails land in Mailpit on `http://localhost:54324`.

**Against the hosted project:** put `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and
`BOB_DATABASE_URL` in `.env`, then sign in with the emailed six-digit code. Sign-up is
invite-only, so the address must have been invited already.

One trap worth knowing before you spend an hour on it: `BOB_SYSTEM_TEST=1` is what mounts the
"Dev sign-in (local only)" button, **and** it stubs the AI. So that button and a real model reply
are mutually exclusive — with it set, every reply reads `System test response: …`. To sign in
locally *and* talk to the real AI, use the emailed code instead.
