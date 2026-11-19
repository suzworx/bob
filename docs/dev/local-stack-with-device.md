# Run the full stack locally and point a device at it

Debug a voice turn with the server's own logs instead of Production: the whole app (web, API,
Supabase) runs on this PC and the device connects to it over the LAN. Verified on Windows with
Docker Desktop, 2026-10-16.

## Start

From a checkout of `origin/main` (a branch that lags `main` can fail Supabase with
`LegacyMigrationMissingLocalError`: `main`'s migrations match the local database, nothing to repair):

```bash
npm ci
cp <main checkout>/.env .env          # gitignored; AI_GATEWAY_API_KEY lives here, never print it
BOB_V2_HOST=0.0.0.0 npm run dev:offline
```

- `BOB_V2_HOST=0.0.0.0` makes the API listen on every interface. The root `.env` may pin it to
  loopback, and a loopback server cannot be reached from the device. The shell value wins over `.env`.
- `dev:offline` starts the local Supabase in Docker (reusing one that is already up), applies pending
  migrations, tops up the dev user, then runs the API (`:7444`) and the web app (`:5173`) with the real
  AI Gateway. `--stub-ai` stubs the AI, `--status` shows the stack, `--stop` stops it.
- Check: `curl http://<lan-ip>:7444/health` returns `"schema_status":"ok"`, and `http://<lan-ip>:5173/`
  loads. `<lan-ip>` is the address the script prints as "pairing URL".

## Let the device reach it

1. The device and this PC must be on the same subnet (same router, Wi-Fi and Ethernet bridged).
   `arp -a` after a ping sweep shows what is on the LAN; the device appears once it has joined.
2. Windows Firewall must allow inbound TCP 7444 on the network profile of the LAN adapter. Read the
   rules (do not change them from a script; it is an owner action):

   ```powershell
   Get-NetConnectionProfile | Select InterfaceAlias,NetworkCategory
   Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow |
     Where-Object { ($_ | Get-NetFirewallPortFilter).LocalPort -in '7444','Any' } | Select DisplayName,Profile
   ```

   On the development PC the rule `Bob v2 WebSocket` (inbound TCP 7444, Public) and `Node.js
   JavaScript Runtime` (Private and Public, any port) already allow it; the Ethernet adapter is Public.
3. Waveshare 1.85C: build with the LAN server seeded as the Dev profile, then flash it (only the first
   boot seeds, so erase NVS first or choose Dev in the device's Server menu):

   ```bash
   BOB_WS185_SERVER=<lan-ip>:7444 py -3.11 -m platformio run -e waveshare-s3-185c
   ```

   The build uses plain `ws://` (developer builds only). Wi-Fi comes from the git-ignored
   `.pio/ws185-secrets/secrets.real.h`; the script never prints it.

## Pair the device with the local dev user

1. Sign in at `http://<lan-ip>:5173`: choose "I already have a code", `dev@bob.local`, and the code the
   script printed (`npm run dev:offline -- --code` prints a fresh one; single use, valid for an hour).
2. The device shows a pairing code once it is connected to the local server. Enter it at
   `http://<lan-ip>:5173/pair`.
3. The device saves a token for the **Dev** profile; its Production token is separate and untouched.

## Read the server logs

| Log | Where |
| --- | --- |
| API stdout (JSON lines, `v2.*` events) | `data/dev-api.log` |
| Web dev server | `data/dev-ui.log` |
| Device-protocol journal | `apps/api/data/v2-journal.log` |

Useful filters: `grep v2.socket data/dev-api.log`, `grep turn data/dev-api.log`. Field meanings are in
`docs/log-reference.md`. Logs never contain audio, transcripts or credentials.

## Stop

Ctrl+C in the terminal stops the API and the web app. The Supabase containers stay up for the next run;
`npm run dev:offline -- --stop` stops them too.
