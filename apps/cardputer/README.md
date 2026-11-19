# Cardputer

The Cardputer workspace is the ESP32 firmware for the M5Stack Cardputer: a half-duplex
push-to-talk WebSocket audio client for `/v2/cardputer`. It is an independent, isolated build
target (PlatformIO) that proves the device side of the wire contract — JSON control messages plus
`OLX2` binary audio frames — and buffers the streamed reply for playback. It is a scripts-only npm
workspace member: zero dependencies, no build step, no workspace imports, and never any secret,
DB, or provider SDK code on the device.

## Run it

From `apps/cardputer`, its own scripts (`npm run <script>`):

| Command | What it does |
| --- | --- |
| `npm run compile` | PlatformIO build for env `m5stack-cardputer-v2-poc` |
| `npm run flash` | Free the serial port, build, and upload |
| `npm run monitor` | Free the serial port, then serial monitor at 115200 baud |
| `npm run run` | Free the port, flash, then open the monitor |
| `npm run debug` | Serial monitor only |
| `npm run free-port` | Release a stuck serial port |
| `npm run ca-roots` / `ca-roots:check` | (Re)generate / check the CA roots header |
| `npm run test:device` | On-device test harness (`scripts/device-test.mjs`) |

The repo root consolidates the main ones: `npm run device:compile`, `device:flash`,
`device:monitor` (tees to `data/device.log`), and `device:run`. Manual equivalent (no npm):

```text
py -3.11 -m platformio run -e m5stack-cardputer-v2-poc --target upload --upload-port COM3
```

## Configure and build

PlatformIO uses the `m5stack-stamps3` base board with the Arduino framework; hardware setup comes
from the official M5Cardputer library.

1. Install PlatformIO.
2. Optional, developer builds only: copy `include/secrets.example.h` to `include/secrets.h` and set
   the Wi-Fi credentials and `V2_HOST` (the computer's LAN IP; `V2_PORT` defaults to `7444`).
   Never commit `include/secrets.h`.

Since #669 everything is set **on the device**: Wi-Fi networks, the server (Production, Local dev,
Custom) and resets live in Settings (`[,]` on Ready; the guided Setup on first boot; hold Fn + `` ` ``
at power-on to rescue). `secrets.h` is only a **first-boot seed** on the developer envs
(`m5stack-cardputer-v2-poc`, `-hil`: `BOB_DEV_OPTIONS=1`); once NVS holds settings they win, and a
device flashed before #669 keeps its network and pairing. The customer firmware is
`m5stack-cardputer-release`: Production only, no seed. Customer steps: `docs/cardputer/device-setup.md`.

Port and toolchain are taken from the environment: `BOB_COM_PORT` (default `COM3`) and
`BOB_PIO_PY` (default `py -3.11`). On macOS, follow `../../docs/mac-setup.md` for the toolchain
instead of duplicating it here.

## How it fits

The device opens `ws://<host>:7444/v2/cardputer`, negotiates the audio format in its `hello`
(MP3 downlink by default; the `BOB_PCM16_HELLO` build flag forces PCM16), and then follows
`hello` → `turn_start` → `audio_up` frames → `turn_end`, with the reply streamed back as
`playback_start` / `audio_down` frames / `playback_end`. The wire contract lives in
`apps/api/src/voice/protocol.ts`. Device code never imports secrets, DB modules, or provider SDKs.
`docs/` holds the target architecture; no diagram directory exists yet.

## Tests

`npm run compile` (or root `npm run device:compile`) proves the target links; it is a firmware
build, not a unit suite. `npm run test:device` drives an on-device harness that flashes the board
and scores real turns. A successful compile proves only that the target links in this environment.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `i2s_driver_uninstall(2048): I2S port 1 has not installed` in logs | Benign `Speaker_Class` defensive uninstall; present in every MP3 session | Ignore — not a firmware bug |
| "CA roots drift check" fails on Windows | `core.autocrlf=true` checks `ca_roots.h` out with CRLF | Already normalized in `gen-ca-roots.mjs`; header bytes are unchanged |
| Reply audio breaks after a file edit | `tsx watch` restarts the API and drops the device socket | Listening tests use `npm run dev:debug -- --once` |
| Bad link/build after checkout | The device connects to the `V2_HOST` in `secrets.h` | Re-copy `include/secrets.example.h` to `include/secrets.h` |