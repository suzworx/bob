# Shared hardware: the Cardputer serial port and the dev API on :7444

Sessions on one machine may share one Cardputer (`BOB_COM_PORT`, default COM3 on Windows) and one dev API
(:7444). Another session's serial driver re-opens the port and makes flashing fail with "Access is denied". Stopping another session's
API breaks its run. Check the holders before every flash, monitor or HIL run.

## 1. Who holds them (read-only)

```powershell
# :7444 listener, with its command line
$api = (Get-NetTCPConnection -LocalPort 7444 -State Listen -ErrorAction SilentlyContinue).OwningProcess
Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in $api } |
  Select-Object ProcessId, ParentProcessId, CommandLine
# COM3 holders: anything whose command line names the port or a serial tool
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'COM3|platformio|pio|esptool|serial-bridge|device:monitor|hil/run' } |
  Select-Object ProcessId, ParentProcessId, CommandLine
```

Read the command line (and walk `ParentProcessId`) to find which checkout or worktree owns each process.

## 2. Stopping a holder

- If a process is not yours, **ask whoever started it first**. Stop nothing without their OK.
- Stop by PID only (`Stop-Process -Id <pid>`). Never stop by name: other sessions and the dev servers all
  share process names such as `node`.

## 3. Restart the dev API afterwards, with the local Supabase env

If you stopped the dev API, restart it through `npm run dev:offline`, which sets the local Supabase env. Don't use a
plain `npm run dev` or `npm run dev:api` without that env. A plain start reads the root `.env`, which may point at
another database (or set no `BOB_DATABASE_URL`, and then the server refuses to boot), and that database doesn't know
the device's token. The server then answers `pairing_required reason=unknown`, and the device **erases its stored token**
(NVS erase rule, AGENTS.md "Device Voice Contract"). Re-pairing then needs the owner.

## 4. HIL commands

- Plan only, no hardware: `node scripts/hil/run.mjs --dry-run` (`npm run device:hil:dry`).
- Full run (build + flash the hil env, every scenario, restore the product build): `node scripts/hil/run.mjs`.
- Subset: `node scripts/hil/run.mjs --scenario a,b`. `boot-ready` always runs first, and a subset is never the
  recorded pass.
- Reuse the firmware on the device: `--no-flash`; leave the hil build on it: `--keep-hil`.
- Allow for the whole run in any timeout you wrap around it: killing the runner mid-restore leaves the device on
  the `hil` build (recover with `npm run device:flash`).
- Runner, console and scenario table: `docs/cardputer/hil.md`.

## 5. Radio or boot changes: the boot-loop rule

A change to Wi-Fi, the radio or boot order can pass one boot and fail the next. Reset the device 6-10 times and
read each boot's `wifi_scan ... done_ms=` line on serial (`npm run device:monitor`). `done_ms=none` means the
scan never finished. One good boot proves nothing.

## 6. NVS upgrade tests

To prove that an upgrade keeps stored state (pairing, Wi-Fi, settings), flash the old build, then the new one with
`esptool --after no_reset` so the device does not boot between the two writes. Confirm on first boot that nothing
re-paired.

## 7. After push

A firmware change needs a full HIL pass. After pushing, run `node scripts/device-attest.mjs`
(`npm run attest:device`). It posts `data/hil-pass.json` as the `local/device-hil` status, keyed by the
firmware hash.
