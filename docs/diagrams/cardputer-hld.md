# `@bob/cardputer` — ESP32 firmware

PlatformIO firmware for the M5Stack Cardputer (`apps/cardputer`). Modules:
`state.h` (main loop / state machine), `protocol.h` (control JSON + OLX2
parse), `audio_capture.h` (mic + uplink framing), `audio_playback.h`
(downlink PCM/MP3), `network.h` (Wi-Fi/WebSocket), `device_token.h` (NVS
`olxd_` token). Constants in `config.h`; shared types in `types.h`.

## Main loop and state machine

```mermaid
stateDiagram-v2
    [*] --> kBoot
    kBoot --> kWifi: stateSetup (WiFi.begin, setSleep false)
    kWifi --> kSocket: wifi connected → network.start()
    kSocket --> kReady: welcome (hello accepted, format negotiated)
    kSocket --> kWifi: wifi lost
    kReady --> kCapturing: BtnA held → beginTurn (turn_start)
    kCapturing --> kAwaiting: BtnA released → endTurn (turn_end)
    kAwaiting --> kReady: playback done / status idle
    kReady --> kSelecting: 'c' key (conversation picker)
    kSelecting --> kReady: select / cancel
    kSocket --> kPairing: pairing_required
    kPairing --> kSocket: paired (reconnect with NVS token)
    kReady --> kError: server error / mic failure
    kError --> kSocket: BtnA retry (requestSocketRetry)
    kAwaiting --> kCapturing: (ignored; turns only begin in kReady)
```

The `State` enum and `ServerStage` live in `types.h`. `stateLoop` calls
`network.pollEvents()`, `playback.loop()`, Wi-Fi supervision, PTT/reply
handling, keyboard, and pairing housekeeping each iteration.

## Audio capture (uplink)

```mermaid
flowchart LR
    Mic["microphone 16 kHz mono"] --> Capture["AudioCapture.captureFrame"]
    Capture -->|"160 PCM16 samples = 10 ms"| Frame["build OLX2 frame<br/>20-byte header + 320 B payload"]
    Frame -->|"SendFrameCallback"| Net["network.sendBinary"]
    Net -->|"ws:// /v2/cardputer"| Server["server handleBinary → parseAudioUp"]
    Capture -->|"resetSequence / nextSequence"| Seq["sequence counter"]
```

`capturePcm_[160]` (10 ms) and `audioFrame_[340]` (header + samples). The
uplink sequence resets at `turn_start`.

## OLX2 frame codec

The 20-byte header, byte layout from `config.h` / `schemas.ts`:

```mermaid
flowchart LR
    F["OLX2 binary frame"] --> H["20-byte header"] --> P["payload<br/>≤ 4096 B (PCM 320 B / MP3 1024 B)"]
    H -->|"0-3"| Magic["magic 'OLX2'"]
    H -->|"4"| Ver["version = 1"]
    H -->|"5"| Kind["kind 1=audio_up 2=audio_down"]
    H -->|"6"| Fmt["format 1=PCM16 2=MP3"]
    H -->|"7"| Ch["channels = 1"]
    H -->|"8-11"| TH["turnHandle"]
    H -->|"12-15"| Seq["sequence"]
    H -->|"16-19"| PB["payloadBytes"]
```

Server builds downlink frames with `serializeAudioFrame`; the device parses
them with `parseOlx2Header` and feeds `AudioPlayback.pushDownlink`.

## Downlink playback

```mermaid
flowchart LR
    Server["server streamPlayback"] -->|"playback_start"| Start["AudioPlayback.beginPlayback(format)"]
    Server -->|"audio_down frames"| Push["pushDownlink(header, payload)"]
    Push -->|"PCM16"| PcmBuf["320 KB PCM buffer<br/>(lazy, freed after drain)"]
    Push -->|"MP3"| Ring["48 KB ring buffer"]
    Ring --> Decode["MP3 decode task<br/>(requires ≥ 32 KB heap)"]
    PcmBuf --> I2S["I2S speaker (ES8311 codec)"]
    Decode --> I2S
    Server -->|"playback_end"| End["endPlayback + drain"]
```

- MP3 is the default downlink format; the device hello advertises it
  (`BOB_PCM16_HELLO` forces PCM16).
- The server paces chunks and the device tracks downlink sequence gaps; a
  missing frame past the stall threshold is journaled as `downlink_stalled`.

## Pairing / follow-me wiring

```mermaid
flowchart LR
    Net["network"] -->|"hello"| Welcome["welcome (device + active_conversation)"]
    Net -->|"pairing_required {unknown|revoked}"| Erase["eraseDeviceToken (NVS)"]
    Net -->|"pair_code"| Pair["PairingInfo (RAM only, claim per boot)"]
    Pair -->|"approved on web"| Paired["paired {olxd_ token}<br/>saveDeviceToken then reconnect"]
    Net -->|"active_conversation push"| Hold["held during playback (R10)<br/>applied at playback_end"]
```

The NVS `olxd_` token is erased **only** on `pairing_required {unknown|revoked}`
— never on close code 4003, a 401 upgrade rejection, reboot, or `pair_expired`.

The active conversation id is opaque to the firmware. Since #565 it may be a General conversation
(`cnv_...`) or a space thread (`thr_<uuid>`, 40 chars). Both show in the `c` picker, and both go back
in `select_conversation` unchanged. The server decides where a turn is saved, so the firmware did not
change.