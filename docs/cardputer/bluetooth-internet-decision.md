# Decision record: Cardputer internet over Bluetooth (issue #303)

Status: deferred by the owner, 2026-09-23 (result: needs a companion app). Resuming requires owner
approval of companion scope, API boundary, distribution/auth model and ownership (#303 exit
criteria). Spike output for
[suzworx/Bob#303](https://github.com/suzworx/Bob/issues/303). This is a paper spike: no
hardware was run and no production code changed. A measured prototype was not feasible inside
the spike: option C needs a companion app on two phone platforms plus a firmware transport
adapter before a single byte can be measured, and the owner deferred that scope. Every number below is labelled
**[code]** (read from this repo), **[docs]** (vendor documentation), **[est]** (engineering
estimate), or **[measure]** (must be measured by the prototype before it is trusted).

## Context

The Cardputer reaches the Bob voice server over one TLS WebSocket, `wss://<host>/v2/cardputer`,
carrying JSON control messages and binary `OLX2` audio frames. Today the only link is the
ESP32-S3's own Wi-Fi station interface:

- **Board and stack [code].** `apps/cardputer/platformio.ini`: `platform = espressif32`
  (unpinned), `board = m5stack-stamps3`, `framework = arduino`, libraries `M5Cardputer@^1.1.0`,
  `M5Unified@^0.2.8`, `links2004/WebSockets@^2.6.1`, `ESP8266Audio@^1.9.7`. No custom partition
  table, no Bluetooth library, no PSRAM flags.
- **Transport [code].** `src/network.cpp` calls `WebSocketsClient::beginSslWithCA(V2_HOST,
  V2_PORT, "/v2/cardputer", kCaRoots)`, so TLS runs on the device against a bundled CA set
  (`include/ca_roots.h`). The `WiFiClientSecure` it uses is bound to lwIP sockets on the Wi-Fi
  netif. A dedicated `ws_net` task (6144-byte stack, priority 2, core 1) pumps `client_.loop()`.
- **Auth [code].** The paired device token lives in NVS (`bob`/`dev_tok`,
  `include/device_token.h`) and is sent as `Authorization: Bearer <token>` on every WebSocket
  upgrade. The token is erased only when the server answers `pairing_required` with reason
  `unknown` or `revoked`.
- **Audio budget [code].** Uplink is PCM16 mono 16 kHz in 10 ms frames: a 20-byte OLX2 header
  plus 320 bytes of payload, which is 34,000 B/s (272 kbps) before WebSocket and TLS framing
  (`include/config.h`). The downlink is either PCM (the device allocates a 320 KB
  internal-RAM playback buffer at `playback_start`, or 160 KB if that fails,
  `src/audio_playback.cpp`) or MP3 at **32 kbps CBR** (4,000 B/s, `apps/api/src/audio.ts`),
  paced by the server in 1,024-byte chunks into a 48 KB ring. `MAX_DOWNLINK_MP3_BYTES` is 3 MB
  (`apps/api/src/schemas.ts`), but the server paces at the encoded bitrate, so a 3 MB reply is
  roughly 13 minutes of audio at 4 KB/s, not a burst. The server also caps uplink per turn at
  `ACCUMULATE_MAX_BYTES` (1 MB ≈ 31 s of 16 kHz PCM16) and grants flow-control credit in 16 KB
  steps (`INITIAL_CREDIT_BYTES`), but the firmware ignores `credit_bytes` today (no reference
  in `apps/cardputer/src` or `include`), so the uplink has no flow control.
- **Memory [code + docs].** The StampS3 module is an ESP32-S3FN8: 8 MB flash, **no PSRAM**, and
  512 KB internal SRAM [est]. The firmware already guards MP3 decoding with
  `kMp3MinDecodeHeapBytes = 32 KB` because low heap crashed the decoder. Heap is tight before any
  Bluetooth stack is added.

The question is whether a phone can carry this connection over Bluetooth when there is no
usable Wi-Fi, without changing `OLX2` or `/v2/cardputer` and without exposing the bearer
token.

## Options compared

**A. Native Bluetooth PAN/BNEP.** The phone shares its internet as a Bluetooth PAN NAP (iPhone
Personal Hotspot over Bluetooth, Android Bluetooth tethering). The Cardputer joins as a PANU and
gets a real IP interface. PAN and BNEP are **Bluetooth Classic (BR/EDR)** profiles. The ESP32-S3
radio is Bluetooth LE 5 only and has no BR/EDR controller ([docs] ESP-IDF Bluetooth LE
overview for ESP32-S3; Classic is only on the original ESP32). ESP-IDF does not ship a PAN/BNEP
profile even on Classic-capable chips ([docs] ESP-IDF Classic Bluetooth API reference, ESP32:
A2DP, AVRCP, HFP, SPP, HID, L2CAP, GAP). **Impossible on this hardware.**

**B. IP over BLE (IPSP / RFC 7668 6LoWPAN).** RFC 7668 defines IPv6 over BLE L2CAP
connection-oriented channels using the Internet Protocol Support Profile. On the device side
this would need an IPSP node plus a 6LoWPAN netif in lwIP; Arduino-ESP32 ships neither
([est]). On the phone side, neither iOS nor Android exposes an IPSP router or BLE-backed network
interface to third-party accessories. Android's public BLE API offers GATT and L2CAP CoC
sockets only ([docs] Android BLE overview, fetched), and iOS offers GATT plus `CBL2CAPChannel`
streams. Phones also do not route IPv6 from such a link to the internet. **Not available on
stock phones.**

**C. Companion app relaying a byte stream over BLE.** A phone app (iOS and Android) connects to
the Cardputer as a BLE central, opens **one TCP connection to the configured Bob host:port**,
and moves opaque bytes both ways over GATT notifications and write-without-response (or an
L2CAP CoC channel where both ends support it). The device runs the same TLS handshake it runs
today, inside that byte stream, so the relay only ever handles TLS ciphertext. `OLX2`,
`/v2/cardputer` and the server stay unchanged. The server just sees a TCP client with a
phone-carrier IP. **Feasible, but it needs a companion app, a firmware transport adapter
(TLS over a non-lwIP stream), and it carries the costs of iOS background execution and app
distribution.**

**D. Phone Wi-Fi hotspot (zero code).** The user turns on the phone's Personal Hotspot or
Android Wi-Fi hotspot, and the Cardputer joins it as an ordinary Wi-Fi network. Nothing changes
in the firmware, the protocol, or the security model. It only needs the hotspot SSID in the
device's Wi-Fi credentials, which today are compile-time `WIFI_SSID`/`WIFI_PASSWORD` in
`secrets.h`. That is a provisioning gap (see Follow-up work), not a transport gap. **Works today
wherever the carrier plan allows tethering.**

| | A. BT PAN/BNEP | B. IPSP / 6LoWPAN | C. Companion BLE relay | D. Phone Wi-Fi hotspot |
| --- | --- | --- | --- | --- |
| Feasibility on ESP32-S3 | No: needs BR/EDR, S3 is LE-only | No: no phone support, no lwIP 6LoWPAN netif | Yes, with a TLS-over-custom-stream adapter | Yes, unchanged firmware |
| Throughput vs need (~300 kbps up, ~35 kbps down) | n/a | n/a | Marginal to OK: 2M PHY + DLE GATT is roughly 0.3–1 Mbps to phones [est, measure] | Plenty (Wi-Fi) |
| iOS | Offers PAN NAP (Classic), unusable from S3 | Not exposed | Needs an app with `bluetooth-central` background mode; background wakeups are time-limited | Personal Hotspot; the user may need the hotspot screen open for it to be discoverable |
| Android | BT tethering is Classic, unusable from S3 | Not exposed | Needs an app with a `connectedDevice` foreground service (Android 14+) | Wi-Fi hotspot or tethering |
| Security | n/a | n/a | E2E TLS through an untrusted relay, LE Secure Connections pairing, relay allowlisted to one host | Same as any Wi-Fi AP; E2E TLS unchanged |
| Effort | n/a | n/a | High: firmware adapter + BLE stack + two mobile apps + store distribution | Low: document it; add on-device Wi-Fi provisioning |

## Decision

**Needs companion app.** Transparent internet over Bluetooth (options A and B) is a **No-Go** on
this hardware and on stock phones. The only Bluetooth path is option C, a companion relay app on
the phone. Under the issue's exit criteria, its scope, API boundary, distribution/auth model
and ownership must be approved **before** any Bluetooth firmware is merged. Until then, the
recommended no-Wi-Fi answer is **option D, the phone's Wi-Fi hotspot**, together with on-device
Wi-Fi provisioning so a user can join a hotspot without reflashing.

The facts that decide it:

1. **The ESP32-S3 has no Bluetooth Classic.** Its radio is BLE 5 only, so PAN/BNEP tethering,
   which is how both iPhone and Android share internet over Bluetooth, cannot be joined from a
   Cardputer. No firmware change can fix this.
2. **Phones do not expose IP over BLE to accessories.** iOS and Android give apps GATT and L2CAP
   CoC byte channels, not an IPSP/6LoWPAN router. Any BLE path therefore needs phone software
   the Bob project writes, ships in two app stores, and keeps alive in the background.
3. **A byte-stream relay can keep the security model and wire contract intact, but only just
   fits the link.** If the device runs TLS end to end through the relay, the relay never sees the
   bearer token and `OLX2`/`/v2/cardputer` stay unchanged. But the uplink needs about 300 kbps
   of sustained goodput ([code] 272 kbps of OLX2 plus WS/TLS framing). That is inside the
   documented BLE 2M PHY range but not comfortably, and it is unmeasured on a phone link that
   coexists with the phone's own radios. The device also has no PSRAM at all (the StampS3
   module has none) to hold a BLE host stack next to a 320 KB PCM playback buffer.

Boundaries held by this decision: `OLX2` and `/v2/cardputer` are unchanged. Wi-Fi remains the
default and is untouched by option D. Bluetooth, if approved, is an explicit, visible fallback
that fails closed. The stored device token is never erased or re-derived because of a Bluetooth
failure. No agent logic, provider SDK, database access or business authorization goes into the
firmware or the relay. Nothing sensitive is logged (see Threat model).

## Threat model

Scope: option C, where the relay is a phone app the user installs. Assets: the device bearer
token, conversation audio and text in transit, the user's server account, and the device's
availability. Trust: the server and the device firmware are trusted. The phone, its OS, the relay
app's process and the BLE air link are all **untrusted for confidentiality and integrity**. They
are trusted only to forward bytes, and at worst they can deny service.

| Threat | Control |
| --- | --- |
| **Passive sniffing of the BLE link** | Link-layer encryption from LE Secure Connections bonding (ECDH P-256). Independently, every relayed byte is already TLS ciphertext between device and server, so sniffing yields nothing even if the link layer is broken. |
| **Pairing MITM** | Require LE Secure Connections with MITM protection. The Cardputer has a display and keyboard, so use Numeric Comparison or Passkey Entry, never Just Works. Pairing is started only from an explicit device menu action with a short window, and bonds are stored in NVS. |
| **Bearer token exposure to the relay** | The token only travels inside the TLS session, in the WS upgrade `Authorization` header, so the relay sees ciphertext. The device keeps validating the server certificate against `kCaRoots` for `V2_HOST` exactly as today, and hostname checking must stay on. No "relay terminates TLS" mode is ever built. The relay never asks for, stores, or receives the token, and the phone app needs no Bob login for forwarding. |
| **Relay impersonation / rogue phone** | A rogue phone that bonds (which needs physical access to the device for pairing) can only drop, delay or reorder ciphertext. TLS detects tampering, and the device treats it as a network failure with the normal reconnect backoff. It cannot mint tokens or read turns. |
| **Relay used as an open proxy** | The device sends only a fixed target, the configured `V2_HOST:V2_PORT`, and the relay enforces an allowlist of Bob hosts shipped with the app. It refuses any other destination and allows one stream per bonded device. |
| **Downgrade to plaintext** | Bluetooth transport is only allowed when `V2_USE_TLS=1`. A build or config with TLS off never offers Bluetooth. If the TLS handshake fails, the result is a visible error and no retry without TLS. |
| **Token loss from a Bluetooth failure** | The fail-closed rule: BLE disconnects, pairing loss, relay errors and handshake failures never call `eraseDeviceToken()`. Only a server `pairing_required{unknown|revoked}` does, as today. |
| **Revocation** | Server-controlled and unchanged. A revoked token is refused at the upgrade no matter which transport carried it. Unbonding a phone (from the device menu or phone settings) removes the relay's ability to forward, but does not revoke the device. |
| **Replay / session hijack via relay** | TLS prevents replay into the session. Session ids and turn handles are only meaningful inside the authenticated socket. |
| **Logs** | Neither firmware nor relay logs tokens, headers, URLs, audio, transcripts, prompts or BLE payload bytes. Allowed fields are transport name, connection state, byte and frame counts, RTT, MTU/PHY, error codes and timings. The relay's own analytics and crash reporting must be configured to exclude payload buffers. |
| **Phone-side privacy** | The relay app sees traffic metadata: timing, sizes, and that an Bob host is contacted. The app's privacy disclosures must say so. The carrier sees only TLS to the Bob host. |

## Target matrix

Proposed targets for the prototype if option C is approved. No row has been exercised on
hardware yet.

| Layer | Target | Notes |
| --- | --- | --- |
| Device hardware | M5Stack Cardputer, StampS3 (ESP32-S3FN8, no PSRAM) | Same unit used for Wi-Fi turns today. |
| Firmware framework | PlatformIO `espressif32` + Arduino core as resolved today; **pin the platform version** before adding BLE | `platformio.ini` does not pin `platform`, so BLE stack behaviour would drift between builds. |
| BLE host stack | NimBLE (`h2zero/NimBLE-Arduino` 2.x) preferred over Arduino's Bluedroid-based `BLE` library | NimBLE's host has a markedly smaller RAM footprint ([docs] ESP FAQ, Bluetooth LE; [measure]). The ESP32-S3 controller is LE-only either way. |
| Existing libs | `M5Cardputer ^1.1.0`, `M5Unified ^0.2.8`, `WebSockets ^2.6.1`, `ESP8266Audio ^1.9.7` | `WebSocketsClient` needs a transport seam to run over a non-lwIP stream, either a fork or a thin `Client` adapter. |
| iOS | iOS 17 and later, with one current iPhone and one older model with BLE 5 / 2M PHY | Requires `UIBackgroundModes: bluetooth-central`, `NSBluetoothAlwaysUsageDescription`, and a CoreBluetooth restoration identifier. The app gets roughly 10 s per background wake to handle events and **stops being relaunched after a user force-quit** ([docs] Apple Core Bluetooth background guide, fetched). A long turn in the background is the key unknown [measure]. |
| Android | Android 12 (API 31) through Android 16, with at least one Pixel and one Samsung | Runtime `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` (API 31+). A foreground service with `foregroundServiceType="connectedDevice"` plus `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_CONNECTED_DEVICE` (required from Android 14 / API 34, [docs] fetched). A persistent notification is visible. Watch for OEM battery killers. |
| Phone foreground / background | Foreground: expected to work. Screen locked with the app backgrounded: iOS uncertain, Android OK under the foreground service. Force-quit: iOS stops, Android stops the service. | The device must show "phone relay unavailable" instead of hanging in `socket_connect`. |
| Server | Unchanged `/v2/cardputer`, `OLX2` v1 | The server sees a normal TCP/TLS client whose source IP is the phone's carrier NAT. |

## Resource and performance budget

**No hardware was run for this spike.** Every [est] or [docs] number is unverified on the
Cardputer and must be replaced with a [measure] number before any Go.

| Item | Need or value | Source |
| --- | --- | --- |
| Uplink goodput during a push-to-talk turn | 34,000 B/s of OLX2 (272 kbps). About 36–38 KB/s (~300 kbps) with WS mask header and TLS record overhead when each frame is sent as its own record | [code] + [est] |
| Downlink goodput, MP3 | 4,000 B/s (32 kbps CBR) + ~2% OLX2 header + WS/TLS, so about 4.5 KB/s | [code] `audio.ts` + [est] |
| Downlink, PCM fallback | 32,000 B/s of payload when played in real time. **Do not offer PCM over BLE**: it doubles downlink needs and needs the 320 KB buffer | [code] + recommendation |
| "3 MB MP3 response" | Paced at 4 KB/s by the server, so about 13 min of sustained 4.5 KB/s, not a burst. The risk is link longevity (supervision timeouts, iOS background), not peak rate | [code] + [est] |
| BLE GATT goodput, ESP32-S3 ↔ phone | 2M PHY + Data Length Extension (251-byte PDUs) + large ATT MTU: several hundred kbps up to ~1 Mbps to Android, and often lower to iOS, which sets its own connection interval | [est], **[measure]** |
| Headroom verdict | Uplink needs about 300 kbps, a thin margin. If the link is slower, audio backs up on the device. The server grants 16 KB credit steps, but the firmware ignores `credit_bytes` today, so nothing throttles the uplink before device RAM runs out. Firmware flow control is a prerequisite for any Bluetooth path | [code] + [est] |
| TLS handshake over BLE | ~5–8 KB of server certificate chain plus a few round trips, at 30–100 ms BLE round-trip time plus phone→server RTT, gives roughly 0.5–2 s | [est], **[measure]** |
| Turn latency added | Each hop adds BLE connection-interval latency (7.5–30 ms) on top of the phone's cellular RTT | [est], **[measure]** |
| Internal RAM, baseline | 512 KB SRAM total. The 320 KB PCM buffer, 48 KB MP3 ring, a TLS session (mbedTLS, commonly 30–50 KB peak during handshake) and a 32 KB MP3-decode floor already compete | [code] + [est] |
| BLE stack RAM | NimBLE host + LE controller: tens of KB. Bluedroid is substantially larger | [est], **[measure]** high-water mark |
| RAM conclusion | Only the MP3 downlink should run under BLE. Allocating the PCM buffer (320 KB, or the 160 KB fallback) alongside BLE + TLS is unlikely to fit | [est] |
| Coexistence | Wi-Fi and BLE share one 2.4 GHz RF path, time-division arbitrated by ESP-IDF coexistence. Running both degrades both, so while the BLE relay carries traffic, Wi-Fi scanning should back off | [est] |
| Task stacks | `ws_net` is 6,144 bytes today. A BLE host task plus a relay RX/TX bridge add their own stacks | [code] + **[measure]** watermark |
| Battery | BLE link at a 15–30 ms interval plus audio, compared with Wi-Fi with modem sleep disabled (`WiFi.setSleep(false)` in `state.cpp`). Likely neutral or better on the device, and a cost on the phone | [est], **[measure]** |

## Prototype plan

This runs only if the companion-app scope is approved. It is a throwaway branch and is never
merged as production code.

1. **Throughput probe before any TLS work (half a day).** A NimBLE GATT server on the Cardputer
   with one TX-notify and one RX-write-no-response characteristic. A minimal Android app and a
   minimal iOS app stream counters both ways for 60 s with the phone foregrounded, then locked.
   Record the negotiated PHY, ATT MTU, connection interval, sustained kbps each way, and drops.
   **Kill criterion:** under ~350 kbps sustained device→phone on either OS means No-Go for PCM
   uplink over BLE. The fallback would be an uplink codec change, which is a separately
   versioned contract change and out of scope.
2. **Transport adapter.** On the device, a `Client`-compatible byte stream over the GATT pipe,
   with mbedTLS run over it (custom BIO or a `Client` wrapper) using `kCaRoots` and `V2_HOST`
   hostname verification. The relay app opens one TCP socket to the allowlisted
   `V2_HOST:V2_PORT` and forwards only bytes.
3. **End-to-end turn.** Pair (LE Secure Connections, Numeric Comparison), connect, WS upgrade
   with the NVS bearer token, `hello` → `welcome`, one push-to-talk turn with an MP3 reply
   played on the device, then disconnect the phone and reconnect with normal backoff. Repeat 20
   times per OS.
4. **Failure injection.** Walk out of range mid-turn. Toggle airplane mode on the phone.
   Force-quit the relay. Lock the phone during a 60 s reply. Put the phone behind a
   captive-portal Wi-Fi. Revoke the device server-side. After each, assert the token is still in
   NVS (except for revoke), there is visible status on screen, and there is no plaintext retry.
5. **Measure and report.** Connection time, BLE and end-to-end RTT, sustained throughput, heap
   free and largest block high-water (`state.cpp` already journals them), the `ws_net` and BLE
   task stack watermarks, battery drain over 30 min on both device and phone, and
   failure-to-recovery times. Use the existing `v2.*` journal and serial tee, adding transport
   fields only.

## Follow-up work

Candidate issue titles, grouped as the issue asks. None have been created. Items marked
**(now)** are useful regardless of the companion-app decision.

**Firmware**
- (now) `Cardputer: on-device Wi-Fi provisioning so users can join a phone hotspot without reflashing`
- (now) `Cardputer: pin the espressif32 platform version in platformio.ini`
- `Cardputer: BLE throughput probe (NimBLE GATT) - measurement only, not merged`
- `Cardputer: transport seam under WebSocketsClient (TLS over a non-lwIP byte stream)`
- `Cardputer: BLE relay transport as explicit fallback with visible status; fails closed, token untouched`
- `Cardputer: MP3-only downlink and RAM guards when the BLE transport is active`

**Companion app**
- `Companion: ownership, platform (native vs cross-platform) and store distribution decision`
- `Companion (Android): connectedDevice foreground-service BLE relay to an allowlisted Bob host`
- `Companion (iOS): bluetooth-central relay with state restoration; measure locked-phone turns`

**API / security**
- `Security: threat-model review of the BLE relay (E2E TLS, allowlist, no token at relay)`
- `API: journal a transport hint for BLE-relayed sessions without breaking the /v2/cardputer contract`

**Provisioning**
- `Provisioning: pairing UX for bonding a phone relay (Numeric Comparison on the Cardputer screen)`
- `Provisioning: unbond and "forget phone" flows that never touch the device token`

**QA hardware matrix**
- `QA: Cardputer x iPhone/Android matrix for relay connect, turn, lock, force-quit, out-of-range`
- (now) `QA: verify turns over iPhone Personal Hotspot and Android hotspot on the current firmware`

**Docs**
- (now) `Docs: "No Wi-Fi? Use your phone's hotspot" guide for the Cardputer`
- `Docs: log-reference fields for the BLE transport (counts and timings only)`

## Open items

- **Hotspot test (option D): the open exit item.** No turn has yet been run over an iPhone
  Personal Hotspot or an Android hotspot. It needs no new code, only the hotspot SSID in
  `secrets.h` and one real device, and it is what backs the recommended no-Wi-Fi answer.
- **Fallback UX:** how the device shows "no Wi-Fi, try your hotspot" and "phone relay
  unavailable" is not designed.
- **Captive portals:** a hotspot or venue Wi-Fi behind a captive portal fails the TLS upgrade
  today; detection and the on-screen message are not designed.
- **Uplink flow control:** firmware must honour `credit_bytes` before any Bluetooth path.

## Sources

"Checked" means the page was fetched and read on 2026-09-23; the three Espressif URLs were
verified in the PR #309 review (2026-09-24).

- Issue #303, *Cardputer: provide internet connectivity over Bluetooth* (read via `gh`): https://github.com/suzworx/Bob/issues/303
- Repo code: `apps/cardputer/platformio.ini`, `include/config.h`, `include/network.h`,
  `include/device_token.h`, `src/network.cpp`, `src/audio_playback.cpp`, `src/state.cpp`,
  `apps/api/src/schemas.ts`, `apps/api/src/audio.ts`
- Apple, *Core Bluetooth Background Processing for iOS Apps* (checked): https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html
- Android, *Foreground service types: connectedDevice* (checked): https://developer.android.com/develop/background-work/services/fg-service-types
- Android, *Bluetooth Low Energy overview* (checked): https://developer.android.com/develop/connectivity/bluetooth/ble/ble-overview
- Apple, `CBL2CAPChannel` (page reached, body not rendered): https://developer.apple.com/documentation/corebluetooth/cbl2capchannel
- Espressif, *ESP-IDF Bluetooth LE overview, ESP32-S3* (verified in review): https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/ble/overview.html
- Espressif, *ESP-IDF Classic Bluetooth API reference, ESP32* (verified in review): https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/bluetooth/classic_bt.html
- Espressif, *ESP FAQ: Bluetooth LE* (verified in review): https://docs.espressif.com/projects/esp-faq/en/latest/software-framework/bt/ble.html

Numbers without one of these sources (SRAM size, GATT goodput, TLS and BLE stack RAM, RF
coexistence behaviour) are marked [est].
