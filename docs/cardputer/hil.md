# Cardputer hardware-in-the-loop (HIL) tests

A firmware change counts as working only once it has run on a real Cardputer
connected to this PC over the USB cable, talking to the real API server. Unit
tests and compiles don't count as proof. `scripts/hil/` runs those checks, and
a pre-push hook plus a PR check block firmware that hasn't been through them.

## Wiring

- Connect the Cardputer to this PC with a USB-C **data** cable. The port is
  `BOB_COM_PORT` (default `COM3`).
- `apps/cardputer/include/secrets.h` must point the device at this PC's LAN IP
  on port **7444** without TLS, on a Wi-Fi network the PC can reach. The runner
  starts its own server there, so stop any dev server first (`npm run cleanup`).
- PlatformIO must run through `py -3.11` (override with `BOB_PIO_PY`). The
  serial bridge uses the pyserial that PlatformIO installs.
- The local Supabase stack must be running in Docker (`npm run dev:offline`,
  or `npx supabase start`): every run gets its own database on it. There is no
  stand-in database, so without the stack the run stops before it starts the
  server.

## Running

| Command | What it does |
| --- | --- |
| `node scripts/hil/run.mjs` | build + flash `m5stack-cardputer-hil`, run every scenario, record a pass |
| `node scripts/hil/run.mjs --no-flash` | use the hil build already on the device |
| `node scripts/hil/run.mjs --scenario boot-ready,ptt-turn` | run the named scenarios, in run order (a subset is never recorded as the pass). `boot-ready` is always run first, added if not named: opening the port resets the device, and a fresh server makes it reconnect |
| `node scripts/hil/run.mjs --ota` | build and sign the 99.0.0 / 99.0.1 test releases and run the OTA scenarios (see `ota-device.md`); the only run that installs firmware over the air |
| `node scripts/hil/run.mjs --dry-run` | validate every scenario and print the plan. Needs no hardware and is safe in CI |
| `node scripts/hil/run.mjs --keep-hil` | as above, but leave the `hil` build on the device afterwards (for `--no-flash` reruns) |
| `node scripts/device-attest.mjs` | post the pass as the `local/device-hil` status on HEAD |

What a run does, in order:

1. Refuses to start if port 7444 is busy.
2. Frees COM3 from stale monitors.
3. Creates the run's own database, `bob_hil_<run id>`, on the local
   Supabase stack (`scripts/hil/hil-db.ts`: a copy of the migration-complete
   template the api tests use, with the dev account seeded), then starts the
   real server (`scripts/hil/server-harness.ts`) on `0.0.0.0:7444` against it.
   It runs in system-test mode (stub STT, agent and TTS).
4. Builds the product env (unless `--keep-hil`), so the restore in step 8 is
   an upload, not a compile, then flashes the `hil` env. Every `pio` run
   streams into `flash.log` and ends with a `$ exit <code>` (or
   `$ killed by <signal>`) line.
5. Opens the serial bridge. It hands each device line on as soon as it
   arrives; it used to hold them up to 200 ms, which turned a scripted
   100 ms GO tap into a 300+ ms hold on the device.
6. Runs the scenarios.
7. Kills every child process and drops the run's database on every exit path,
   including errors and Ctrl+C.
8. Flashes the product env (`m5stack-cardputer-v2-poc`) back, after the run
   and after a failed hil flash, unless `--keep-hil`. A device left on the
   `hil` build points at the run's throwaway server, which is gone. The
   runner waits for the upload and prints `restore: SUCCESS` or
   `restore: FAIL (<how it ended>)`; a failure makes the run exit non-zero
   (then run `npm run device:flash`). Ctrl+C skips it. Allow for the whole
   run in any timeout you wrap around it: killing the runner mid-restore
   leaves the device on the `hil` build.

The `hil` env is the product env plus `-DBOB_TEST_CONSOLE=1`. With
`--keep-hil` it stays on the device; `npm run device:flash` goes back to the
product build.

**Pairing.** The device keeps its pairing with your dev server. A fresh
database doesn't know the token the device already holds, and the server
would answer `pairing_required`, which makes the device erase that token. So
when the server's token lookup finds nothing, the harness registers that
token's sha256 for the dev account through the store's own pairing steps
(issue, approve, claim), then repeats the lookup: the device signs in with
the token it has and nothing is erased (`v2.hil_token_adopted`). Only the
hash the server already computed is used; the token never leaves the device
or lands on disk, which is why this was chosen over saving and restoring the
NVS token around the run. The harness installs this before it starts
listening, so an early connect can't miss it. A device with no token pairs
as before: the harness sees `v2.pair_issued` and approves it for the dev
account with the same `approve()` the web page calls (the legacy shared
secret only exists in firmware built with `-DBOB_LEGACY_SECRET`). Like the
pairing auto-approval, adoption accepts any device token presented to this
throwaway system-test server for the length of the run.

### Running HIL on the Waveshare

The rig defaults to the Cardputer. To run the same suite on the Waveshare
ESP32-S3-Touch-LCD-1.85C, point it at that board's port and PlatformIO envs
(the `-hil` env ships with the Waveshare firmware branch):

```bash
BOB_COM_PORT=COM4 BOB_HIL_ENV=waveshare-s3-185c-hil BOB_PRODUCT_ENV=waveshare-s3-185c node scripts/hil/run.mjs
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOB_COM_PORT` | `COM3` | serial port of the device under test |
| `BOB_HIL_ENV` | `m5stack-cardputer-hil` | env flashed for the run; `report.md` prints it |
| `BOB_PRODUCT_ENV` | `m5stack-cardputer-v2-poc` | env flashed back afterwards |

## The serial test console

The console is compiled only into the `m5stack-cardputer-hil` env. It runs at
115200 baud and takes one command per line.

- Commands start with `T `, for example `T ping`, `T key n`, `T enter`,
  `T backtick`, `T btn down`/`up`, `T state`, `T heap` or `T audio tone <ms>`.
- Replies are single lines that start with `T> `.

| Command | Reply | Effect |
| --- | --- | --- |
| `T ping` | `pong fw=<version> build=<short sha> id=<12 hex>` | none. `build` is HEAD's short sha at build time (`dev` without git). `id` is the first 12 hex digits of sha256 over the MAC as 12 lowercase hex digits, so the raw MAC never reaches serial or a log |
| `T key <c>` | `ok` | one printable key press, through the same dispatcher as the keyboard |
| `T enter` / `T backtick` | `ok` | Enter / `` ` `` |
| `T del` / `T tab` | `ok` | Del / Tab (#677: erase in a text field; show or hide a password) |
| `T fn <c>` | `ok` | Fn + one key (#677): `T fn ,` / `T fn /` move a text field's cursor, ``T fn ` `` cancels it. Every injected key is a press then a release, like the keyboard. **The reply never echoes the key**: it may be part of a password |
| `T btn down` / `T btn up` | `ok` | GO pressed and held / released, through the same reader as the button |
| `T state` | `state=READY mode=ptt vol=5 muted=0 dnd=0 rssi=-58 rxq_max=3 rxt=41 rxt_drop=0 att_drop=0 ws_loop_max=4 log_drop=0 loop_max=151 tx_drop=0` | none. `rssi` is the WiFi signal in dBm (0 when not associated). After it, reliability counters since boot: the receive-queue high-water mark, text messages received and dropped, connect attempts whose end event the full event queue lost (#709; each then expires after 180 s), the slowest `client_.loop()` pass on `ws_net` (ms; a TLS handshake is one long pass, #710), journal lines dropped, the slowest main-loop iteration (ms), and uplink audio frames not sent because the socket stayed busy. `ws_loop_max` sits before `log_drop`, and `tx_drop` stays last: HIL checks anchor on `log_drop=N loop_max=N tx_drop=0$` |
| `T echo <n>` | `echo=<n> xxx…` | none. `n` in 16..300: the whole reply line is exactly `n` bytes, `T> ` and CRLF included (`console-packet-edge`); else `err echo_len` |
| `T zlp on` / `T zlp off` / `T zlp` | `ok zlp=on late=0` / `zlp=on late=0` | the USB packet-edge guard (#709 c3, `journal.cpp` emit, `usb_packet.h`), on from boot: a line that could end a burst on a full 64-byte packet goes out as its head, then its last byte alone once the TX ring drains (at most 10 ms), so the host never holds it waiting for a short packet. `off` writes lines in one piece, as before, for an A/B run (RAM only). `late`: tails written before the ring drained |
| `T net dump` | `net count=2 order=1,0 s1=flags:4,last:1 s0=flags:0,last:2` | none. The saved Wi-Fi networks (#675) by stable slot id in priority order, with their flags (1 hidden, 2 open, 4 seeded from `secrets.h`) and last join result (0 never, 1 ok, 2 auth, 3 no AP, 4 timeout, 5 captive, 6 no internet). **Never an SSID or password** |
| `T srv dump` | `srv profile=dev tls=0 dev_options=1 tok=prod:1,dev:1,custom:0 legacy=1` | none. The active server profile (#675), its TLS flag, whether this is a developer build, which profiles hold a device token, and whether the pre-#675 `dev_tok` is still stored. **Never a host, port or token** |
| `T srv set dev <host> <port>` / `T srv set prod` | `ok srv` / `err args` / `err host` / `err port` / `err profile` | selects the server profile and reconnects now (journaled `srv_profile_set profile=dev|prod`, never the host). The Waveshare HIL run (scripts/hil/run.mjs) sends `dev` with this PC's LAN address (or BOB_HIL_HOST) and the HIL port before the scenarios, and `prod` after them, so the product firmware is flashed back onto Production. Plain ws:// (developer builds only) |
| `T heap` | `free=<b> min=<b> largest=<b>` | none (8-bit heap; `min` is since boot) |
| `T audio tone <ms>` | `ok` | the next capture sends a 440 Hz tone for its first `ms` (1..10000) instead of the mic. The capture that is open when it is armed takes it, so arm it after `turn_started` for a wake turn, or while the follow-up window is open |
| `T wake fire` | `ok` / `err not_listening` | while Always awake listens (`wake_listening`), the next wake tick counts as a detection: `wake_detected` and a hands-free turn, no speaker or recording needed. Outside wake listening nothing is armed |
| `T wake word <alexa|bob>` | `ok` / `err word` | sets the wake word outright (saved to NVS like `w`; `wake_word_changed … source=test` when it changes), so a scenario never depends on the word an earlier run left |
| `T token forget` | `ok` | erases the **active** profile's device token (the same erase as `pairing_required` unknown/revoked, journaled `device_token_erased … reason=test`) and reconnects now, so the server asks the device to pair (pair-from-scratch then resets the device, which boots with no Authorization). A `T token backup` stays. The HIL server re-pairs it; without a `T token restore` the device's pairing with its own dev server is gone afterwards. **Never prints the token** |
| `T state reset` | `ok` | `loop_max`, `ws_loop_max` and `tx_drop` back to 0, so one scenario's stall does not fail the next |
| `T mp3 abort_at_begin` | `ok` | the next MP3 decode task journals `test_mp3_hold` and waits before `begin()` until playback is stopped (at most 5 s), so a stop pressed as the reply starts always lands before the decoder begins |
| `T token backup` | `ok saved` / `ok kept` / `ok none` / `err nvs` | copies the **active** profile's device token to a test-only NVS key (`hil_` + its token key, e.g. `hil_tok_dev`, namespace `bob`; a factory reset erases it too); `kept` when a backup is already there (a run that failed midway left the owner's token in it), `none` when the device has no token. Never prints the token |
| `T token restore` | `ok restored` / `err no_backup` / `err nvs` | writes the backup back as the active profile's device token and deletes the backup; takes effect on the next connect (scenarios reset the device after it) |
| `T hello pcm` / `T hello mp3` | `ok` / `err format` | every later hello asks for PCM16 / MP3 (RAM only: a reboot asks for the build's default, MP3). Journals `hello_format_forced format=pcm16_16k_mono\|mp3_16k_mono` and reconnects the socket at once, so the next hello uses it; the device then plays in the welcome's `format_id` |
| anything else | `err unknown` | lines over 64 chars are dropped and answered `err too_long` |

The console runs at most one command per loop iteration. The product env has
none of it: every line is behind `BOB_TEST_CONSOLE`, and the product
`firmware.bin` contains no `pong fw=` string.

**Server commands.** `T server <command>` never reaches the device. The rig
writes it to the server harness and answers `T> ok server` itself:
`T server announce ring` rings a timer for the dev account (the same
`announce()` the timer scheduler calls), `T server control mode=ptt
dnd=0` (also `muted=`, `volume=`, `ring_seconds=10..120` and
`ring_sound=classic|chime|pulse`) pushes a `device_control`, and
`T server slow_turn <ms>` holds the next turn's agent stage for `<ms>` (at
most 30000). The stub AI answers in about 100 ms, so without the hold a stop
can only land after the server has finished. The hold delays the server's
first store read after that turn's STT, and is journaled as
`v2.hil_slow_turn_holding` / `v2.hil_slow_turn_released`.
`T server tts_next <seconds> [wav]` makes the next reply's stub TTS last `<seconds>` (1-60). `T rig speak <volume> <tries> <words>` speaks through the PC speaker (System.Speech, volume 1-30, 1-3 tries until `v2.barge_in`) and answers `T> ok rig`; quiet on purpose, the household sleeps.

`T server burst_next_reply` sends the next reply the way production does
(`BOB_STREAMING_REPLY=0`, one clip) and holds every socket write from its
`playback_start` through its `playback_end`, then writes them back to back
(journaled `v2.hil_reply_burst writes=N`). The device then holds the whole
reply, usually with `playback_end`, before its decode task begins.
`T server fail_next_turn INTERNAL` fails the next turn the way a real
provider failure does: the harness throws out of that turn's STT stage, so
the server journals `v2.hil_fail_turn_injected`, then `v2.turn_failed
stage=stt error_name=HilInjectedTurnFailure`, and sends the device
`error {code:"INTERNAL"}`. `INTERNAL` is the only code a failed turn sends,
so it is the only one accepted. `T server thread seed` (#565) creates a
space and a thread in it for the dev account and points the device at the
thread through the real `PUT /api/devices/active-conversation` route (run on a
loopback-only ephemeral port, never 7444). Each seed makes a new space and
thread. `T server thread archive` archives the latest seed's thread and leaves
the pointer: between turns the next turn's start clears it; during a turn the
persist meets a lost thread. Archive before seed journals `outcome=failed_not_seeded`. The harness journals
every command as `v2.hil_command` with its outcome.

**Pairing and devices (#611).** The harness normally approves every pairing
itself (`v2.hil_pair_auto_approved`). `T server pair manual` turns that off:
the next `v2.pair_issued` waits, and `T server pair approve` approves it
through the web's own `POST /api/pair/approve` (the pairing router, on the
same loopback port as the devices router). The web gets that `pairing_id`
from `/api/pair/lookup` with the typed code; the harness takes it from the
journal, so the pair code never reaches the harness or a log. `T server pair
auto` turns auto-approval back on. `T server device rename` and `T server
device revoke` call the real `PATCH` and `DELETE /api/devices/:id` for the
device `pair approve` paired; the revoke closes its socket with 4003.
`T server pairing hold` (#681) answers the device's **next** connection as
one with no token: the harness drops that upgrade's Authorization header
before the server's auth guard reads it (`v2.hil_pairing_held`), so the real
path sends `pairing_required` reason `none`, which never erases the device's
token. With `pair manual` the device then sits on its pair code; its next
connection is authenticated again, so no release command is needed.

**Server restart.** `T rig server-restart` never reaches the device or the
harness: the rig kills the server harness by its PID (`taskkill /PID … /T
/F`, never by process name), waits for the port to free, starts it again on
the same port, database and journal file, and answers `T> ok rig`
once `/health` does (`T> err server_not_healthy` if it never does). The
restarted harness skips the pairings already in the journal. The journal
stream keeps reading the same file, so waits after the command see the new
process's lines.

**Server down.** `T rig server-stop` and `T rig server-start` are the two
halves of `server-restart`, for a scenario that keeps the server down in
between (`server-down-backoff`). `server-stop` kills the harness by the PID
the rig recorded when it spawned it (never by name) and waits for the port to
free: `T> ok rig`, or `T> err server_port_busy` if the port never frees.
`server-start` starts it again on the same port, database and journal
file and answers `T> ok rig` once `/health` does (`T> err
server_not_healthy` otherwise). With the harness still running it starts
nothing and only checks `/health`, so a scenario's `finally` can always send
it to bring the server back after a failed step.

**Resets.** Opening the USB serial port can reset the ESP32-S3. It did on
the first open after a flash, and it doesn't when the lines stay low on a
running device. `T bridge reset` (answered by the rig, `T> ok bridge`) makes
the serial bridge pulse RTS, esptool's hard reset. `boot-ready` sends it
after the console handshake, so it always watches a fresh boot → welcome →
READY. `T bridge pause <ms>` makes the bridge close the port for `<ms>` and
reopen it without a reset, so the host stops reading (`log-backpressure`).
An `assertState` step with `timeoutMs` polls `T state` until it
matches or times out; without `timeoutMs`, one readback decides.

The console only drives the device. The evidence comes from journal lines
(`docs/log-reference.md`) and from the `T state`/`T heap` readbacks. A wait
only matches lines that arrive after the step's command.

## Adding a scenario

1. Add `scripts/hil/scenarios/<name>.mjs`, which default-exports
   `{ name, issue, title, board?, requires?, requiresFiles?, expectsReconnect?, steps }`.
   `board: 'cardputer' | 'waveshare'` runs it only on that board's hil env (`waveshare-…` is the
   Waveshare); on the other board it reports SKIP.
   A scenario that reconnects the device on purpose (a server restart, a
   revoke, a reboot onto a new token) sets `expectsReconnect: true`: the run
   then leaves out the transport watch, which would otherwise fail it as
   `transport: reconnect`, and the scenario's own steps must prove the
   reconnect. `finally: [steps]` (same grammar) runs after the steps whether
   they passed or failed, to put back device state that later scenarios
   depend on (pcm-reply's `T hello mp3`); its evidence is prefixed
   `finally: `, and a failing finally step fails a scenario that had passed.
   The step
   grammar is at the top of `scripts/hil/schema.mjs`: `send`, `press`,
   `waitDevice`, `waitServer`, `noDevice`, `noServer`, `cleanSerial`,
   `assertState`, `saveState`, `assertHeapMin`, `sleep` and `playAudio`.
   Each step takes an optional `timeoutMs`, and an optional `onlyIf: /re/`:
   the step runs only if a device line matching `/re/` arrived since the last
   send/press/playAudio, else it is skipped and the evidence says so.
   `playAudio: 'data/….wav'` plays a WAV through the PC's default speaker
   (PowerShell `System.Media.SoundPlayer`, waits for the end); with
   `repeat: n, until: /re/` it plays up to n times and stops at the first
   device line matching `/re/` (waiting `timeoutMs`, default 2 s, after each).
   The WAV must be listed in `requiresFiles`: test media stays local under
   the git-ignored `data/`, and a PC without it reports **SKIP**.
   `noDevice`/`noServer` need one: they wait out that window and fail on a
   matching line. `cleanSerial: true` fails if any device line since the
   scenario began is neither a journal line nor a `T> ` reply (a raw print).
   `scenarios/steps.mjs` has ready-made turn steps.
2. List the scenario in `scenarios/index.mjs`.
3. If the scenario proves a feature that isn't built yet, name the feature's
   journal event in `requires: [{ event, feature }]`. While the firmware
   source has no `"<event>"` string, the scenario reports **SKIP** with that
   reason, never PASS. When you build the feature, journal exactly that event
   name, or update the scenario to match.
4. Run `node scripts/hil/run.mjs --dry-run` and `npx vitest run scripts/hil`.

Current scenarios:

| Scenario | Issue | Key evidence |
| --- | --- | --- |
| `console-packet-edge` | #709 | `T zlp on` (or `off` with `BOB_HIL_ZLP=off`, the A/B run), then `T echo n` for n = 63, 64, 65, 127, 128, 129, 192, 256, 3 rounds: each reply exactly its own `echo=<n> x…` within 500 ms (run 20260929-233629-b7e0: a 128-byte `T state` reply held 3 s by the host until the next line, then every reply one behind); `T zlp` readback of `late`; `finally` turns the guard back on |
| `boot-ready` | #baseline | `v2.welcome`, `T state` READY, then `device_control_applied … mode=ptt,dnd=0` |
| `ptt-turn` | #baseline | `turn_started state=LISTEN` → `turn_ended state=WAIT` → `playback_completed … mp3_exit=eof`, then `T state` `loop_max` < 300 and `tx_drop=0`, and `cleanSerial` (no raw print during the turn) |
| `reply-burst` | #313 | three turns after `T server burst_next_reply`: server `v2.hil_reply_burst`, device `playback_started … format=2`, `mp3_ring_ready avail=…,eof=…` (the order each turn hit), `playback_completed … mp3_exit=eof`, no `mp3_begin_failed`, `T state` READY; then `loop_max` < 300 (MP3-BEGIN-RACE: run 20260929-064635-40fc dropped whole replies buffered before `begin()`) |
| `pair-from-scratch` | #611 | `pair manual`, `T token backup` + `forget`, `T bridge reset`: `v2.boot`, `ws_mode … auth=0`, server `v2.pairing_required` reason `none`, device `pairing_required … reason=none`, `pair_code_received state=PAIR`, server `v2.pair_issued`; `pair approve` (web route): server `v2.hil_command … approved` + `v2.pair_delivered`, device `device_token_saved`, `ws_mode … auth=2`, `welcome_accepted`, server `v2.welcome`, READY; a full turn; `T token restore` + reset: `auth=2`, `welcome_accepted`, READY on the owner's token |
| `pcm-reply` | #611 | `T hello pcm`: `hello_format_forced … format=pcm16_16k_mono`, `hello_sent … format=pcm16_16k_mono`, server `v2.welcome … format_id 1`, `welcome_accepted … format=1`; a turn: server `v2.downlink_started … pcm_bytes`, `playback_started … format=1`, no `playback_buffer_failed` (fails at once with that line), server `v2.turn_completed`, `playback_completed … format=pcm16` with `samples` > 0, `dropped_bytes=0` and `seq_gaps=0` (`replyPlayed('pcm16')` in `steps.mjs`, the PCM form of the shared "reply played" wait; needs the streamed PCM of PCM-BUFFER-674. `playback_end_received` and READY also come when nothing played), READY; then `T hello mp3` and the same with MP3 (`format_id 2`, `mp3_bytes`, `format=2`, `replyPlayed('mp3')` = `REPLY_PLAYED`, `mp3_exit=eof`). `finally`: `T hello mp3`, `welcome_accepted … format=2`, READY, even after a failed step. Run 20260929-110910-342e: the PCM buffer (320 KB, then 160 KB of internal RAM) did not fit the largest free block (~156 KB), `playback_buffer_failed`, a silent reply |
| `server-restart-reconnect` | #611 | `T rig server-restart` while READY: device `socket_closed state=SOCKET clean=… retry_ms=…`, `socket_connect`, `socket_connected`, `hello_sent`, server `v2.hello` + `v2.welcome` from the new process, `welcome_accepted … format=2` (MP3: a PCM hello left by pcm-reply fails here, not in the turn), no `pairing_required`, READY, a full turn |
| `server-down-backoff` | #709 | `T rig server-stop` while READY, then ~70 s with the server down: every device `socket_connect` / `socket_closed` since the stop is checked with its device millis (`BackoffViolation`): no `socket_connect` sooner than `retry_ms` − 500 ms after a failed close (`clean=0`), one `socket_connect` per close, none under 1.5 s apart after the second failure, and each failed close's `retry_ms` the previous one doubled (max 30000); the ladder `retry_ms=2000`, `4000`, `8000`, `16000` seen; then `T rig server-start`, `socket_connected`, server `v2.welcome` and device `welcome_accepted` within 40 s each, no `pairing_required`, READY, a full turn. `finally` sends `T rig server-start`, so a failed run still leaves the server up |
| `settings-from-pairing` | #681 | `pair manual`, `pairing hold`, `T bridge reset`: `ws_mode … profile=dev auth=2`, server `v2.hil_pairing_held` + `v2.pairing_required` reason `none`, device `pairing_required … reason=none`, `pair_code_received`, `T state` PAIR; `,` → `settings_opened`; Server > Local dev > `e` > Save > Enter: `profile_set profile=dev tls=0`; `` ` `` `` ` ``: `settings_closed … changed=server`; then 10 s with no `pair_request_sent`/`pairing_started`/`device_token_erased`, `ws_mode … profile=dev auth=2`, `welcome_accepted`, READY; `finally` `pair auto` |
| `revoke-4003` | #611 | `pair-from-scratch`'s pairing, `device rename` (`… renamed`), `pair manual`, `device revoke`: server `v2.hil_command … revoked`, `v2.device_revoked`, `v2.closed` (any code: it is the code the device echoed, 1000, not the 4003 sent, and nothing journals the sent code), device `socket_closed … clean=1` (no code), one reconnect on the revoked token (`ws_mode … auth=2`), server `v2.pairing_required` reason `revoked`, device `device_token_erased … reason=revoked`, `pairing_required … reason=revoked`, `pair_code_received`; then 10 s with no `socket_closed`/`socket_connect`/`socket_retry`/`pairing_required`/`pairing_started` (no loop); re-paired through `pair approve`, a full turn, owner token restored |
| `go-tap-ignored` | #311 | GO down 100 ms: no server `v2.turn_started`/`turn_ended`/`error`, device `turn_tap_ignored state=READY held_ms=…`, `cleanSerial`. Cardputer only (`board`) |
| `go-release-320ms` | #311 | GO released on the `turn_started … held_frames=N` line (~320 ms): the queued frames drain from the uplink queue and `turn_end` follows the last, so server `v2.turn_ended` has 10–59 frames and no `SEQUENCE_GAP`; `loop_max` < 300 and `tx_drop=0` |
| `turn-error-recovers` | #311 | `fail_next_turn INTERNAL`, a GO turn: server `v2.turn_failed` + `v2.error … INTERNAL`, device `server_error state=READY … code=INTERNAL` and `T state` READY within 3 s, then `k` cycles wake → announce_only → ptt, `cleanSerial` |
| `turn-error-recovers-wake` | #311 | the same failed turn in Always awake (`control mode=wake`): `server_error state=READY … code=INTERNAL`, `T state` READY in wake, and after `T state reset` before the turn, `loop_max` < 300 and `tx_drop=0` (the wake mic waits for the error tone without blocking the loop); ends in ptt |
| `reply-card` | #318 | `reply_text_received … kept=1`, `reply_card_shown state=READY lines=N` |
| `new-conversation` | #302 | `new_conversation_acked`, server `v2.new_conversation` |
| `space-picker` | #301 | `spaces_received`, `space_selected`, `picker_cancelled` |
| `thread-pointer` | #565 | `T server thread seed` (a space + thread, the device pointed through the real `PUT /api/devices/active-conversation` with `thread_id`): server `v2.hil_command … outcome=pointed`, device `active_conversation_applied`; `c` → `conversations_received count≥1`, Enter → server `v2.conversation_selected` with the 40-char `thr_` id; a tone turn → server `v2.device_thread_saved … outcome=completed`; archived **between turns** (`T server thread archive`): the next turn's start clears the pointer, server `v2.active_changed surface=device` while GO is held, `v2.turn_completed` with a `cnv_` `conversation_id`, no `device_thread_lost`/`saved`, `T state` READY; archived **during a turn** (a second `thread seed`, `slow_turn 8000`, archive on `v2.hil_slow_turn_holding`): `v2.device_thread_lost`, then `v2.turn_completed` with a `cnv_` id, no `device_thread_saved`, `T state` READY (run 20260928-213237-c16a showed the between-turns path never journals `device_thread_lost`). The thread's title on the screen has no journal line; check it by eye |
| `volume-mute` | #314 | `T state` vol/muted readbacks, `mute_changed` |
| `mode-cycle` | #330 | `mode_changed` ×3, back to the start mode |
| `help-overlay` | #311 | `help_opened state=HELP`, `help_closed state=READY` (`` ` `` and GO) |
| `touch-tap-talk` | #1063 | Waveshare only. `T touch 60 200` (off Bob): `touch state=READY gesture=tap,action=go`, `turn_started state=LISTEN`, server `v2.turn_started`; a tone, then `turn_ended state=WAIT … end_reason=silence` (700 ms of silence on this board), `reply_shown_live state=WAIT` (the reply's words over the speaking Bob), the reply played, `reply_card_shown state=READY` |
| `touch-bob-info` | #1063 | Waveshare only. `T touch 180 180` (Bob): `touch … action=bob_info`, `info_opened state=READY source=bob`; 9 s with no `turn_started`/`turn_tap_ignored`/`info_closed`/`earcon` (the view used to close at 8 s and the tap opened the mic); a tap off Bob gives `info_closed … source=tap` and no turn |
| `touch-swipe-volume` | #1063 | Waveshare only. `T swipe up` / `down` on READY: `touch … gesture=swipe_up,action=volume` and the `T state` vol readback +1, then −1; no turn |
| `touch-long-press-chips` | #1063 | Waveshare only. `T touch 60 200 900`: `touch … gesture=long_press,action=chips`, no `turn_started`/`turn_tap_ignored`/`earcon` (a long press is no longer push-to-talk) |
| `touch-stop-and-talk` | #1063 | Waveshare only. A turn held by `slow_turn`: a tap gives `touch state=WAIT … action=go`, `turn_cancelled state=READY … source=touch` and `turn_started state=LISTEN`; a second tap gives `touch state=LISTEN … action=go` and `turn_ended … end_reason=key`; READY |
| `barge-in` | #1364 | Waveshare only. Wake mode, `T server tts_next 20` (a 20 s reply): `barge_listening`, no `barge_in` for 3 s (Bob's own sine), then `T rig speak 30 3 Hey Bob` (PC speech at volume 30, up to 3 tries): `barge_in`, `turn_cancelled … source=wake`, server `v2.turn_cancelled`, a new `turn_started`, READY |
| `barge-in-soak` | #1364 | Opt-in (not in the full run; `--scenario barge-in-soak`), Waveshare only, needs a `hey_bob.wav` under `data/wake-test`. 18 wake turns (~10 min) whose replies say "hey bob" (`tts_next 20 <wav>`): zero `v2.barge_in` since the run began; the evidence lists each `barge_stats erle_db`. the stub TTS voices the clip (`BOB_SYSTEM_TEST_TTS_WAV`, set by `tts_next`), resampled to 24 kHz and looped |
| `boot-tap-hands-free` | #1063 | Waveshare only. `btn down` + `btn up` under 300 ms with a tone armed: `turn_tap_hands_free state=LISTEN held_ms=…`, server `v2.turn_started`, no `turn_tap_ignored`, `turn_ended … end_reason=silence`, the reply played, READY |
| `stop-reply` | #315 | mid-turn (server held by `slow_turn`): `turn_cancelled state=READY … source=key`, server `v2.cancelled` then `v2.turn_cancelled stage=tts` |
| `stop-reply-late` | #315 | mid-playback after the server finished: `turn_cancelled state=READY … source=key`, server `v2.cancelled` |
| `stop-at-reply-start` | #315 | `mp3 abort_at_begin`, `x` after `test_mp3_hold`: `playback_aborted`, `mp3_began … ok=0`, `mp3_begin_failed`, `turn_cancelled … source=key`, no `v2.boot`/`Rebooting`/assert for 3 s, `T state` READY, then a full turn plays, `cleanSerial` |
| `announce-ring` | #319 | `announce_shown … kind=timer,ring=1`, `announce_acked … action=dismissed`, server `v2.announce_acked` |
| `timer-ring-duration` | #389 | `control ring_seconds=10`: `ring_started … ring_s=10`, then `ring_stopped reason=missed,ring_ms=` 9000–11000, `announce_acked … action=missed` and server `v2.announce_acked … missed`; a second ring with a key after 2 s: `ring_stopped reason=dismissed`, ack `dismissed`; ends with `ring_seconds=30` again |
| `ring-over-settings` | #669 | `,` opens Settings, `T server announce ring`: `settings_closed … changed=none`, then `announce_shown … kind=timer,ring=1` and `ring_started`; a key gives `ring_stopped reason=dismissed`, `announce_closed state=READY` and server `v2.announce_acked … dismissed` |
| `ring-over-settings-typing` | #669 | Settings → Wi-Fi → `a` scan → first network → two characters in the password field, then a ring: `settings_closed … changed=none`, `announce_shown … ring=1`, `ring_started`, and no `net_saved`/`net_updated`/`wifi_test`; a key dismisses it back to READY |
| `ring-during-join-test` | #669 | a wrong password starts a join test (`wifi_test started=1`) and a ring is sent: no `settings_closed` while the test runs and no ring after `wifi_test result=…` while Settings is open; backtick closes Settings, the device reconnects, and the ring shows and rings (`announce_shown … ring=1`, `ring_started`); nothing saved; a key dismisses it |
| `settings-wifi-list-end` | #728 | `,` → Wi-Fi → `a`: `wifi_scan … listed=` 9–12 (9+ networks must be in range); `.` past the end stops on "Scan again", whose Enter rescans; one `;` up is "? My network isn't listed", whose Enter opens the not-listed screen (no scan) and Enter there rescans; backtick ×3 closes Settings, `changed=none` |
| `wake-mode` | #313 | `mode_changed … mode=wake`, then `wake_listening` or `wake_unavailable`: both pass, the evidence says which |
| `wake-capture-rate` | #313 | gap-free capture (CP-WAKE-MIC): `wake_stats … fps=97..103` while listening, then a tone PTT turn whose `turn_ended … fps=97..103`, `loop_max`/`tx_drop` healthy |
| `wake-detect-speaker` | #313 | `data/wake-test/alexa.wav` then `hey_bob.wav` (local, SKIP without them), each played from the PC speaker up to 3×. First `wake_listening … word=alexa,…arena_used=`, then `wake_detected`, and the hands-free turn ends (`wake_rejected` or `playback_completed`). `w` then gives `wake_word_changed … word=bob` and `wake_listening … word=bob,…arena_used=`; `hey_bob.wav` then passes on `wake_detected` (its turn is waited out) or on a `wake_stats … max_p=` ≥ 200, and the evidence line says which. The backup word is scored, not required to fire, because the local clip is a synthetic Windows SAPI voice and the Hey Bob model was trained on Piper voices (run 20260924-202048-b051: max_p 167/248/222 against cutoff 251); tuning to it would be overfitting. A second `w` goes back to alexa, then ptt. Put the device within ~1 m of the speaker |
| `wake-reject-speaker` | #313 | `data/wake-test/hey_google.wav` (local, SKIP without it) played once in Always awake (alexa): no `wake_detected` during it or in the 10 s after, then back to ptt |
| `wake-followup` | #313 | follow-up listening (CP-WAKE-FOLLOWUP): `T wake fire` + a tone make a wake turn; its reply gives `followup_opened … window_ms=6000`; a tone with no wake word gives `followup_closed … reason=speech`, `turn_started state=LISTEN … mode=followup` and a completed turn; its reply reopens the window; then silence: no `followup_closed` for 5 s, `reason=timeout` by 7 s, `wake_listening` again, back to ptt |
| `wake-followup-key` | #313 | same wake turn, then `h` in the open window: `followup_closed … reason=key`, no `help_opened` (the key does nothing else), `wake_listening`, back to ptt |
| `turn-long-sentence` | #392 | `data/wake-test/long_sentence.wav` (local, SKIP without it; ~7 s of speech with ~900 ms pauses) played from the PC speaker into a `T wake fire` wake turn: `turn_ended … end_reason=silence,speech_ms=` ≥ 5000 (not cut mid-sentence), reply, `followup_opened`, `h` closes it, back to ptt |
| `heap-per-mode` | #333 | `T heap` over the floors in ptt, wake and announce_only |
| `log-backpressure` | #340 | the port closed for 2.5 s mid-capture: server `v2.turn_ended` with `frames` ≥ 230 for a GO held over 3 s (~100 frames/s since CP-WAKE-MIC, 82–88 before), turn completes, `T state` shows `log_drop`/`loop_max` |
| `heap-floor` | #333 | `T heap` over the floors after 3 turns, then `T state` `loop_max` < 300 and `tx_drop=0` since its own baseline (it runs last) |

`boot-ready` proves `mode=ptt dnd=0`. Every later scenario starts with
`baseline()` (`scenarios/steps.mjs`, prepended in `scenarios/index.mjs`):
`T server control mode=ptt dnd=0`, `T state` READY (polled up to 15 s),
`T wake word alexa`, `T state reset`. So a scenario that failed mid-way
(left in wake mode, a wake word from an earlier run in NVS, one stalled
loop) no longer fails the next one's first step (run
20260924-165003-c15f: four scenarios failed only on that). The wake
scenarios still end in ptt where they can. `boot-ready` also checks the boot line names the flashed firmware
(`boot state=… fw=<x.y.z> build=<sha|dev>`).

**boot-ready always runs first.** Opening the serial port resets the device.
A `--scenario` subset without `boot-ready` sent its first command about 1 ms
after `pong`, while the device was still booting, and the server delivered
it to the dead session from before the reset
(`docs/investigations/hil-wake-followup-2026-09-25.md`). So the runner
prepends `boot-ready` to any subset that does not name it, and says so
(`boot-ready added first: …`).

**Pre-flight.** Once `boot-ready` passes, the runner reads `rssi=` from
`T state` (`scripts/hil/preflight.mjs`) and prints the reading
(`pre-flight: WiFi RSSI <n> dBm`). The floor is **-65 dBm**. Weaker than
that (or 0, not associated), the run stops: the remaining scenarios are
reported SKIP with `not run: environment: WiFi RSSI <n> dBm is below the -65
dBm floor; move the device or the access point until T state shows rssi=-65
or stronger`. The run is never recorded as a pass, and it exits non-zero.
Healthy runs sit at -55..-63. Failing runs sat at -70..-80: run
20260924-172308-5a8c at -74..-80, and run 20260925-205858-29cd, which the old
-70 floor let through at exactly -70, then stayed at -70..-75 until the
socket closed mid-reply. Aim for -63 or stronger before a full run. Firmware
without `rssi=` is not blocked; the report says WiFi was not checked.

**Transport failures.** The runner watches the `session=` id on the device's
journal lines during each scenario after `boot-ready`. A new id means the
socket closed and the device reconnected. Every pending wait then gives up
at once, and the scenario FAILs with a reason that starts `transport:
reconnect (session <old> → <new>); step <n>: …`. Read that as the link, not
the product: check the RSSI in `serial.log` (`wifi_heartbeat`),
`uplink_backlog_full`, `downlink_stalled`, and `socket_closed` / server
`v2.closed code=1002`. Then move the device or the access point and run it
again. A `v2.boot` line in the scenario is a reboot, the firmware's own
failure, and is never blamed on the link. `wake-followup` also requires its
follow-up reply to end with `mp3_exit=eof`. A reply stopped by a dropped
socket (`mp3_exit=stopped`) fails at that step, not 60 s later at the window
that correctly never reopens.

`baseline()` does not reset `ring_seconds`, so `timer-ring-duration` puts it
back to the default 30 itself.

The ring and mute (#389): a muted device (or volume 0) rings silently. The
card still says Ringing, the ring still stops after `ring_seconds`, and the
ack is still `missed`: mute silences the sound, never the timer. So
`timer-ring-duration` passes muted or not.

The heap floors in `heap-floor` and `heap-per-mode` (the lower
`WAKE_HEAP_FLOORS` for Always awake) are starting values. Tighten them from
the `heap:` lines of real runs.

## Reading the evidence

Each run writes `data/hil/<run-id>/` (git-ignored). It contains:

- `report.md`: the scenario table and, for each scenario, the console
  exchanges and journal lines that satisfied or failed it. Paste it into the
  PR's Evidence section.
- `serial.log`: the device lines. `>>` marks console commands.
- `server-journal.log`, `server-console.log` and `flash.log`. The runner
  replaces the MAC esptool prints with `<mac>` in `flash.log`.

A full run with no FAIL and at least one PASS, on the firmware HEAD builds,
writes `data/hil-pass.json`. That file holds `firmware_hash`, `tree`,
`run_id`, `scenarios`, `device_id_hash` (the `id=` from `T ping`: 12 hex
digits of a sha256 of the device MAC, never the MAC), `ts` and
`runner_version`. With `--no-flash` the device must also
report HEAD's build in `T ping`.

After the scenarios, the runner scans that run's `server-journal.log` for
privacy leaks (spec 002 V12, SC-010): no journal line from a real device turn
may carry audio, a transcript, agent text, a prompt or a credential. The rules
are the V11 ones `npm run validate:non-device` applies to stub turns, from one
source, `scripts/hil/journal-privacy.mjs`. The HIL scan adds one rule of its
own: the transcript the harness feeds in (`hardware in the loop test`). A
finding fails the run and blocks `data/hil-pass.json`. It prints as
`line N: rule`, never the offending text, so the report does not repeat the
leak. Open the journal at that line to see what leaked.

`firmware_hash` is a sha256 over the tracked files under
`apps/cardputer/{src,include,lib}` plus `platformio.ini`. The files are
sorted, and CRLF is normalised to LF. Editing scripts or docs doesn't
invalidate a pass. Any firmware byte does.

## The gate

"Changes firmware" means the branch's own change touches a firmware input.
The gate diffs the branch's merge-base with `origin/main` against the pushed
commit, which is exactly what the PR will merge. Firmware you merged in from
main doesn't count, so a docs-only branch that merged main still pushes
freely. The PR check does the same with `base...head`. A push to `main`
itself is judged on the pushed range. If `origin/main` is missing, the hook
falls back to the pushed range and says so; `git fetch origin` fixes that.

- **pre-push** (`.githooks/pre-push`, which calls `scripts/hil/push-gate.mjs`):
  a push that changes a firmware input is refused unless `data/hil-pass.json`
  passed on exactly the pushed firmware. The refusal lists the files and the
  commands to run. After a push that gets through, the hook posts
  `local/device-hil` in the background.
- **Bypass:** `BOB_SKIP_HOOKS=1 git push` still pushes, but prints a loud
  warning.
- **Reviewing a firmware PR:** look for a `local/device-hil` status on its
  head commit whose `fw=` names the PR's firmware hash
  (`node scripts/device-attest.mjs` posts it after a full HIL pass).

### Owner-token restore: network readiness before authentication

`restoreOwnerToken` waits for the reboot to regain Wi-Fi before its existing auth=2, welcome and READY assertions. `waitBootWifi: true` observes the boot and connection-manager events: fast joins pass immediately; one failed round may use the documented 60-second backoff and one subsequent scan/join round. It requires failed-join evidence, the exact first backoff, and a completed retry scan after the backoff; a second failed round, unexpected reboot, early retry or exceeded phase budget fails. The initial phase is capped at 120 seconds, and recovery at 130.8 seconds after the first failed round (60-second backoff + 20-second scan budget + 45.8-second join/retry budget + 5-second scheduling margin). These are bounded one-network HIL recovery budgets, not a new product reconnect SLA. Scenarios cannot override them. Authentication checks are unchanged.

This separates network availability from token restoration: the previous 60-second auth wait could expire before the existing manager scheduled its first retry around 100 seconds after boot. The failure was reproduced on the previous private product as a direct-join timeout followed by scan recovery; no firmware retry timing was changed.
