# Over-the-air updates on the Cardputer: decision record (#344)

Status: design decided on paper; the on-device prototype and the owner's approval are still open (see "Prototype checks owed").
Date: 2026-09-23. Board: M5Stack Cardputer (StampS3, ESP32-S3, 8 MB flash, **no PSRAM**). Epic: #343.

Every number carries a label: **measured** (from this checkout's build), **docs** (vendor or framework source), **[est]** (estimate or proposed policy value, not yet measured).

## Context

- **Firmware.** Devices are flashed over USB only; nothing on the device can install an update today.
  - The CI `release` job attaches the app image as `bob-cardputer-vX.Y.Z.bin` to every GitHub Release cut from `main` (`.github/workflows/ci.yml`, `release` job). It does not check hardware first.
  - `kFirmwareVersion` is hard-coded as `"0.1.0"` (`apps/cardputer/include/types.h:80`) and is sent only in `pair_request`, not in `hello`.
- **Toolchain** (**measured**, `npm run device:compile`):
  - the platform is `espressif32` 7.0.1, unpinned in `apps/cardputer/platformio.ini`;
  - the framework is `framework-arduinoespressif32` 3.20017 (Arduino-ESP32 2.0.17), built on **ESP-IDF v4.4.7** (`tools/sdk/versions.txt`);
  - the board is `m5stack-stamps3`: QIO flash at 80 MHz, 8 MB.
- **What the precompiled Arduino SDK provides** (**measured**, `tools/sdk/esp32s3/qio_qspi/include/sdkconfig.h`, `tools/sdk/esp32s3/lib`):
  - available: `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE 1`, `libapp_update.a` (`esp_ota_ops`), `libesp_https_ota.a`, and the Arduino `Update` and `HTTPUpdate` libraries;
  - not enabled: Secure Boot, flash encryption, and the eFuse anti-rollback counter (`CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK`).
- **The rollback trap** (**measured**, `cores/esp32/esp32-hal-misc.c:207-231`).
  - `initArduino()` checks a weak `verifyRollbackLater()`, which returns `false` by default.
  - When it returns `false`, the core calls `esp_ota_mark_app_valid_cancel_rollback()` **before `setup()` runs**.
  - So rollback is on in the bootloader but protects nothing today. The OTA work must first override `verifyRollbackLater()` to return `true`.
- **Where the boot slot gets switched** (**measured**, `libraries/Update/src/Updater.cpp:111,257-262`; `esp_https_ota.h`).
  - Arduino `Update.end()` calls `esp_ota_set_boot_partition()`.
  - `esp_https_ota_finish()` does the same.
  - So every check must run **before** those calls, not after them.
- **Connection.**
  - The device holds one TLS WebSocket to `api.heybob.xyz`. It trusts four bundled roots: ISRG X1 and X2, and GTS R1 and R4 (`apps/cardputer/include/ca_roots.h`, `apps/cardputer/src/network.cpp:163`).
  - Railway's edge certificate chains to one of these roots today.
  - The device authenticates with a bearer device token held in NVS.
- **Heap is tight.**
  - The MP3 decoder needs 32 KB or more free (`kMp3MinDecodeHeapBytes`, `apps/cardputer/include/config.h:78`).
  - The wake-word module holds about 33 KB **[est]** (`docs/cardputer/wake-word-decision.md` also labels it an estimate).
  - A second mbedTLS session costs roughly 40–50 KB **[est]**: two 16 KB record buffers, plus the handshake and certificate parsing.

## Options compared

| Option | How it works | Heap | Protocol cost | Recovery if it breaks | Verdict |
| --- | --- | --- | --- | --- | --- |
| **A. HTTPS pull from a signed manifest** | The server sends `update_available` over the WebSocket. The device closes the socket, downloads over its own HTTPS session with the existing roots (`HTTPClient` + `Update.write()`), verifies, then switches slots. | One TLS session at a time, because the WebSocket is closed first. That is about today's use. | One new control message, one `hello` field and one HTTP route. | The old slot keeps booting. | **Chosen** |
| B. Push over the existing WebSocket | A new OLX2 kind (`fw_down`) streams the image in 1 KB chunks (about 1,370 chunks **[est]**) into `Update.write()`. | No second TLS session. But the receive path (`kMaxRxFrameBytes` 16 KB) and the frame parser stay busy for the whole transfer, next to the flash writes. | A new frame kind, flow control and acknowledgements, plus `schemas.ts`, the codec, host tests and wire fixtures. Node streams 1,401,488 B per device. | The same slot safety as A. | Rejected. It adds more protocol surface than A, and A gains nothing from it once the socket is closed. |
| C. USB only, with a web flasher (ESP Web Tools) | Chrome or Edge (WebSerial) writes the bootloader, partitions, `boot_app0` and the app at their offsets. | Not applicable. | None on the device. Releases must also publish those parts or a merged image. | Always works, even when the device will not boot. | **Kept as the recovery path**, not the update path: it needs a person, a computer and a cable. |

**Also rejected:**
- `ArduinoOTA` (LAN push): it needs a computer on the same LAN, and it has no real authentication.
- A factory or recovery app partition: it costs a 3,342,336 B (**measured**) slot, and C already covers recovery.

## Decision

**The device pulls a signed image over HTTPS from the API, and nowhere else.**
- **Offer:** a bounded `update_available` control message on the existing WebSocket.
- **Install:** only when the device is idle and the user consents, into the inactive OTA slot of the **unchanged** `default_8MB.csv` table.
- **Verification:** the image must match the SHA-256 in a manifest signed with **ECDSA P-256**. The device checks the manifest against public keys compiled into the firmware, before the boot slot is switched.
- **Rollback:** the new image stays in `PENDING_VERIFY` until it has reached `welcome` **and** passed a self-test. Failing either one rolls it back.
- **Recovery:** USB with ESP Web Tools.

**Secure Boot v2 and flash encryption are deferred.**
- They burn eFuses, which is irreversible.
- They need a bootloader built from ESP-IDF, which this Arduino build does not produce.
- They return as phase 2, only when devices leave the owner's hands, and only with the owner's written acknowledgement.

## Partition layout and flash budget

The table is **measured**: `partitions.bin` from this build, decoded. It matches the framework's `tools/partitions/default_8MB.csv`, which the board file `m5stack-stamps3.json` names.

| Partition | Type | Offset | Size |
| --- | --- | --- | --- |
| `nvs` | data/nvs | 0x9000 | 0x5000 (20,480 B) |
| `otadata` | data/ota | 0xE000 | 0x2000 (8,192 B) |
| `app0` | app/ota_0 | 0x10000 | 0x330000 (3,342,336 B) |
| `app1` | app/ota_1 | 0x340000 | 0x330000 (3,342,336 B) |
| `spiffs` | data/spiffs | 0x670000 | 0x180000 (1,572,864 B) |
| `coredump` | data/coredump | 0x7F0000 | 0x10000 (65,536 B) |

Headroom is computed as **slot size − `firmware.bin` size**, both measured.

| Item | Number | Kind |
| --- | --- | --- |
| Slot size | 3,342,336 B (0x330000) per slot | measured |
| `firmware.bin`, including the wake-word module and the hey_jarvis model | 1,401,488 B. The size check reports 1,401,121 B (41.9 %) | measured |
| Headroom per slot | 3,342,336 − 1,401,488 = **1,940,848 B** (58.1 %) | measured |
| Wake-word growth so far | +167 KB, of which the model is 52 KB | measured in #312 |
| "Alexa" plus the trained "Hey Bob" model, both in flash in place of hey_jarvis (CP-WAKE-BOB) | +66,720 B (1,453,725 → 1,520,445 B) | measured |
| OTA code: `HTTPClient`, `Update`, the ECDSA verify. mbedTLS is already linked | +20 to +60 KB | [est] |
| Static RAM | 54,492 of 327,680 B (16.6 %) | measured |
| `spiffs` | 1,572,864 B that no code mounts: no SPIFFS, LittleFS or FFat in `apps/cardputer/src/` | measured (grep) |

**The layout stays exactly as it is.**
- Every device already has two OTA slots and `otadata`, so OTA needs **no USB reflash of the partition table**.
- A table change is the one thing that would need a USB flash of every device, and nothing here needs one.
- The idle `spiffs` partition is left alone.

## Signing and trust

**Threat model.**

| Threat | Mitigation in phase 1 | Residual risk |
| --- | --- | --- |
| A malicious or compromised update server, or a man in the middle | TLS to the existing roots. The image must also match the SHA-256 in a manifest signed by a key the server never holds. | The server can withhold updates. |
| A corrupt or truncated download | A streaming SHA-256 of the bytes against the signed manifest, and the size check, both before `Update.end()`. `Update.end()` also runs ESP-IDF's own image check. | None found. |
| A downgrade to an older signed image | The version must be greater than the running version. A downgrade needs a manifest with `allow_downgrade`, bound to `from_versions` and `expires_at` (below). | USB flashing can still downgrade. |
| A stolen `primary` key | "Key authority" and "If a key leaks" below. | Until rotation, the thief also needs the server or TLS. |
| Physical access (USB) | None in phase 1. `esptool` can write any image and read flash, including the NVS token. | Accepted while devices stay with the owner and beta users. Phase 2 addresses it. |

**Option 1: ESP32-S3 Secure Boot v2 plus flash encryption.**
- The bootloader checks each image against a key digest burned into eFuse. It is the only defence against reflashing.
- It needs a bootloader built from ESP-IDF with `CONFIG_SECURE_BOOT_V2_ENABLED`. The Arduino 2.0.17 package ships a **prebuilt** bootloader without it, so it means moving to pioarduino or arduino-as-component.
- The burn is **irreversible**. **Nothing in this spike enables or burns anything.**

**Option 2: an app-level signature (chosen for phase 1).**
- The signature is ECDSA P-256 over SHA-256. mbedTLS 2.x in IDF 4.4 has it, but has no ed25519.
- It is reversible and burns no eFuse, but it does not stop an attacker with a cable.
- **Signed bytes** are the canonical JSON (sorted keys, no whitespace) of every field below. Only `url`, `rollout_pct` and `sig` are left out: they are server policy, or the signature itself.

| Field | Bound (Zod on the server, the same limits in the device parser) |
| --- | --- |
| `version`, `min_server` | SemVer, 32 characters or fewer |
| `sha256` | exactly 64 lowercase hex characters, over the whole `.bin` file |
| `size` | an integer from 1 to 3,342,336 |
| `channel` | `dev`, `beta` or `stable` |
| `key_id` | `^[a-z0-9-]{1,16}$`, for example `primary-1` or `backup-1` |
| `security` | boolean. When true, skip the snooze (see "Consent") |
| `retire` | up to 4 `key_id`s. Allowed only when `key_id` is a backup key |
| `allow_downgrade` | boolean |
| `from_versions` | up to 4 SemVer strings. Required and non-empty when `allow_downgrade` is true, empty otherwise |
| `expires_at` | Unix seconds. Required when `allow_downgrade` is true, and no more than 7 days after signing **[est]** |
| `sig` (not signed) | base64 DER, 128 bytes or fewer decoded |

**Key authority.**
- The firmware embeds a `primary` key, which signs releases, and a `backup` key, which exists to rotate keys.
- The device rejects any manifest signed by `primary` that has a non-empty `retire`. **`primary` can never retire or replace `backup`.**
- A manifest signed by `backup` may retire `primary`. The device writes the retired ids to NVS **before** it downloads, so the old primary is refused even if the install fails.
- Key rotation is a firmware release signed by `backup`. That release embeds a new `primary` **and a new `backup`**, so the fleet never ends up with a single trusted key. The used backup becomes a retired id in the next rotation.

**Downgrade replay.**
- The device accepts `allow_downgrade: true` only when all of these hold:
  - its running version is listed in `from_versions`;
  - `now < expires_at`;
  - the manifest's version is lower.
- `now` comes from SNTP on the device, never from the server, because the server is outside the trust boundary. With no SNTP time, the device rejects the downgrade (fail closed).
- The device keeps the highest version it has ever installed in NVS. Any other lower version is refused.

**Custody.**
- `primary-N` lives only in a GitHub Actions environment, `firmware-signing`, that requires the owner's approval. Only the release job can reach it, and only after the HIL gate (#347).
- `backup-N` is generated offline, stored offline (a password-manager export plus paper), and never enters CI.

**If a key leaks.**
- **`primary` leaks:**
  1. halt every rollout (#346);
  2. sign a rotation release with `backup` that retires `primary-N` and embeds `primary-N+1` and `backup-N+1`;
  3. roll it out.
- **`backup` leaks:** rotate at once with `primary`, by shipping firmware that embeds a new backup. `primary` cannot *retire* the old backup, so the stolen one stays trusted by every device until that device installs the new firmware. Treat this as urgent.
- **Both leak:** recover over USB (option C).

**Phase 2** (Secure Boot v2 and flash encryption) gets its own record and the owner's written acknowledgement of the eFuse burn.

## Delivery

**Verification order on the device.** This is `HTTPClient` + `Update.write()`, not `esp_https_ota`.
1. Check the manifest: its bounds, its signature against a key that is not retired, the key's authority over `retire`, and the version and downgrade rules.
2. Call `Update.begin(size)`. This erases only the bytes needed, not the whole slot.
3. For each chunk read from HTTP, feed an mbedTLS SHA-256 context, then call `Update.write()`.
4. Compare the byte count with `size` and the digest with `sha256`. On a mismatch, call `Update.abort()`: the boot slot is never touched.
5. Only then call `Update.end()`. This runs ESP-IDF's image check and `esp_ota_set_boot_partition()` (`Updater.cpp:257-262`).

Why not `esp_https_ota`:
- `esp_https_ota_finish()` switches the boot slot, and the IDF 4.4 API has no data hook to hash the bytes as they arrive.
- The only way to check before `finish()` would be `esp_partition_get_sha256()`. That returns the digest of the image **contents**, not of the `.bin` file, so the manifest would need a second digest.

**Hosting: the API serves it; GitHub Releases is the record.**
- The release job publishes the `.bin`, `manifest.json` and the signature to the GitHub Release.
- The API serves `GET /v2/firmware/:version.bin`:
  - it accepts the device bearer token;
  - it fetches the asset once, checks the signed `sha256`, and holds its 1,401,488 B (**measured**, today's size) in memory, because the Railway service has no volume attached.
- Why not download straight from GitHub? A GitHub download redirects to an asset host whose chain may use roots that are not in `ca_roots.h` **[est; check the chain before any change]**. It would also mean following redirects on the device, and it would expose device downloads to a third party.

**How the device learns of an update.**
- `hello` carries `fw_version` and `caps` (#345).
- After `welcome`, the server sends `update_available {manifest}` when the device is eligible (#346).
- A rollout change reaches devices that are connected and idle through the device-control channel (#314).
- No polling: the socket is persistent, and an offline device gets the offer at its next `hello`.

**Time** to install the image:

| Step | Time | Kind |
| --- | --- | --- |
| Download at 1–4 Mbit/s of effective TLS throughput | 3–12 s | [est] |
| Erase and write 1,401,488 B | 5–20 s | [est] |
| Reboot, reconnect, `welcome` and the self-test | 5–10 s | [est] |
| **Consent to a working device** | **15–45 s** | [est]. The prototype measures it |

**Heap.**
- In the `UPDATING` state the device:
  - stops the mic and the wake word;
  - frees the playback buffers;
  - **closes the WebSocket** before it opens HTTPS.
- The prototype logs `free` and `largest` before the download, at the low point, and after. The pass mark is a low point of 20 KB or more **[est]**.

**Consent, idle and power.**
- The device offers an update only in `READY`, and never interrupts a turn, playback or capture.
- The screen says "Update X available — Enter to install, Esc for later". "Later" snoozes for 24 h **[est]**.
- An owner's "Update now" from the web (#346) still waits until the device is idle.
- A `security` manifest skips the snooze, but not the idle rule.
- Battery: install only at 50 % or more **[est]**, or on USB power. Whether the device can detect charging is **unverified**; without it, the rule uses the battery level alone.

**Failure during delivery.**
- **Wi-Fi drops:** `Update.abort()`, then **restart the download from byte 0** at the next `welcome`, with backoff. There is no resume: `Update` and `esp_ota_begin()` cannot reopen a partly written slot, so a resume would have to stay inside one boot and one `Update` session. That is not worth it at 3–12 s **[est]** per download.
- **Power lost while writing:** `otadata` is untouched until step 5, so the old slot boots.
- **Rejected manifest or image:** the device does not retry that version, and it reports the rejection in its next `hello` (see "Rollback").

## Rollback

1. **Keep the image pending.** Override `verifyRollbackLater()` to return `true`. An image installed over the air then boots in `ESP_OTA_IMG_PENDING_VERIFY`.
2. **Mark it valid** with `esp_ota_mark_app_valid_cancel_rollback()` only after all of these, in order:
   - Wi-Fi is up;
   - the TLS WebSocket is open;
   - `welcome` has arrived;
   - the self-test passes: the display, `Mic.begin()`, `Speaker.begin()`, and 32 KB or more of free heap.
3. **A failed self-test** calls `esp_ota_mark_app_invalid_rollback_and_reboot()`.
4. **Boot loops.** Any reset while the image is pending makes the bootloader mark it `ABORTED` and boot the previous slot. That covers a panic, the watchdog, a brownout and a power cycle (**docs**: ESP-IDF v4.4 "App rollback").
5. **A hang with no reset.** If `welcome` has not arrived within 5 min **[est]** of Wi-Fi being up, the device invalidates the image and reboots. With no Wi-Fi at all, the image stays pending until the next power cycle rolls it back.
6. **Reporting: one path, a `hello` field.**
   - `hello` gains an optional `last_ota {version, result, reason}`. There is no separate message: every outcome, rollbacks included, is known at the next connection.
   - The device reads rollbacks from `esp_ota_get_last_invalid_partition()`, and keeps the other outcomes in NVS until they are reported.
   - Bounds:
     - `version` is SemVer, 32 characters or fewer;
     - `result` is one of `installed`, `rolled_back`, `rejected` or `failed`;
     - `reason` is one of `sig_invalid`, `key_retired`, `hash_mismatch`, `size_mismatch`, `image_invalid`, `downgrade_refused`, `download_failed`, `flash_failed`, `low_battery`, `self_test_failed`, `no_welcome` or `boot_failed`.
   - An unknown value fails Zod for that field only: the field is dropped, `hello` survives, and the journal records `invalid` (#345's rule).
7. **Server-side minimum firmware (#345).** `BOB_MIN_FW_VERSION` sends `update_required`. A bad version that marked itself valid is replaced by a **higher** version built from good source. `allow_downgrade` is the last resort.
8. **The eFuse anti-rollback counter is not used**, because it burns eFuses. The version rules above stand in for it.

**Effect on development, USB flashing and the HIL console.**
- **USB flashing is unaffected.** PlatformIO writes `boot_app0.bin` over `otadata` at 0xE000 on every upload (**measured**, `framework-arduinoespressif32/tools/platformio-build.py:215`). This resets the device to boot `app0`, and a USB-flashed image is **not** `PENDING_VERIFY` (**docs**). So `verifyRollbackLater()` returning `true` changes nothing for USB-flashed builds, and marking such an image valid does no harm.
- **Offline benches.** The 5-minute no-`welcome` rule would roll back a freshly updated image on a bench with no server. Dev and HIL builds therefore set the timeout at build time: off for plain dev builds, and short **[est: 30 s]** in the HIL rollback scenario. Only release builds use the 5-minute value.
- **The HIL serial console (#340)** keeps working throughout. The OTA scenarios add log lines with the slot, the image state, `last_ota` and the heap low point.

## Channels and staged rollout

Channels (`dev`, `beta`, `stable`), deterministic bucketing and the rollout panel belong to **#346**. This record fixes three things only:
- the automatic halt counts **`rolled_back` only**. A `rejected` report alerts the owner, but does not count toward the halt, because it usually means a network or artifact problem rather than a bad image;
- only a HIL-attested release enters `beta` or `stable` (#347);
- the server never offers a manifest whose `min_server` is newer than itself.

## Server and web patches

Today, Railway deploys the server and web image on every green push to `main`, and rollback is manual. Supabase migrations deploy through `.github/workflows/supabase.yml` (`docs/deploy.md`). Migration ordering is **#349**, post-deploy verification and a rehearsed rollback are **#350**, and the emergency path and the compatibility block in release notes are **#351**. The one constraint from this record: **ship the server before the firmware that needs it**, which `min_server` enforces.

## HIL gate for releases

The gate itself is **#347**. The rule it must meet: no release firmware is signed with `primary` or offered over the air without an attested HIL run of **that exact binary**, keyed by the `sha256` of `bob-cardputer-vX.Y.Z.bin`.

**Breaking the circle.** The release suite must install the candidate over the air, but `primary` signs only after attestation, and release firmware trusts only production keys. Resolved with a **HIL-only dev signing key**:
- **Where the key lives:** `hil-dev` is compiled only into the `m5stack-cardputer-hil` env. That env is on `main` (`scripts/hil/rig.mjs:19`), but not yet on this branch. Its private key lives in the rig's local config, never in CI.
- **How it runs:** the rig flashes the HIL build of the candidate commit over USB. A local server then offers the **CI candidate `.bin`**, signed with `hil-dev`. The HIL build installs it, the candidate boots, reaches `welcome`, marks itself valid and reports its version. That attests the exact binary.
- **The negative test:** the rig then offers the candidate a `hil-dev`-signed image, which it must reject as `sig_invalid`. This proves the release trusts no dev key.
- **What stops the key leaking into a release:** a build flag adds the key. A release build fails with `#error` if that flag is set, and the release job fails if the dev public key's bytes appear in the `.bin`.
- **Why not sign with `primary` for `dev` before attestation?** That would let the fleet key sign unproven code. A leaked `hil-dev` key reaches no production device.
- **The known gap:** the candidate's *own* updater is proven by the HIL build of the same commit, which differs only in its key table. It is not proven by the candidate performing an install itself.

## Emergency patch runbook

The runbook for every target belongs to **#351**. For firmware:
1. Halt the rollout (#346), and turn off any flag for the feature (#348).
2. Raise `BOB_MIN_FW_VERSION` (#345) once a fixed version exists.
3. Fix forward: a PR, `npm run validate`, then squash-merge. The fix is a higher version, even when it is a revert.
4. Run the HIL emergency subset against the CI `.bin` (#347).
5. Roll out.
   - **Exception:** an emergency may go straight to `beta` at 100 %, skipping the 10/50/100 steps and the 24 h soak. Only the owner may take it, and each use is logged in the incident record.
6. Recover stranded devices over USB (option C, or `npm run device:flash`).

## Implementation cost

Most of this is #325's work. All figures are working days **[est]**.

| Piece | Days |
| --- | --- |
| Device: `UPDATING` state, the download with a streaming SHA, the manifest and ECDSA check, the key table with retirement in NVS, the self-test, mark-valid, `last_ota`, the consent screen | 4–6 |
| Server: `update_available`, `/v2/firmware/:version.bin`, the manifest store, `last_ota` in `hello`, all with Zod | 2–3 |
| Release job: keys, the `firmware-signing` environment, the manifest and signature, the dev-key scan | 1–2 |
| HIL: the `hil-dev` key, the OTA scenarios, the rollback-timeout flag | 2–3 |
| **Total** | **9–14** |

## Prototype checks owed

These are #344's exit criteria. None has been run yet. Each run id and serial excerpt goes in this table, and in the PR that closes #344.

| # | Check (over USB, through the HIL harness) | Run id | Result |
| --- | --- | --- | --- |
| 1 | Install a signed image over Wi-Fi, with the heap low point and the time to install | owed | owed |
| 2 | Reject a corrupt image (`hash_mismatch`) | owed | owed |
| 3 | Reject an unsigned or wrongly signed image (`sig_invalid`) | owed | owed |
| 4 | Roll back an image that crashes before it marks itself valid (`rolled_back`) | owed | owed |
| 5 | Report the new version in `hello` | owed | owed |

## Prerequisites (done in OTA-1)

- The release env ships: CI attaches `m5stack-cardputer-release` (no developer options) as `firmware.bin`, not the developer build.
- The platform is pinned at `espressif32@7.0.1`, so the bootloader and Arduino core no longer move between builds.
- The flash limit is 1,740,800 B (1,700 KiB, 52 % of the slot), which leaves room for the OTA client.

## Follow-up work

| Issue | What this record asks of it |
| --- | --- |
| #325 OTA | Everything in "Delivery" and "Rollback", and the device and server rows of "Implementation cost". |
| #345 version | Build-time `fw_version`, and `last_ota` in `hello`. |
| #346 channels | Halt on `rolled_back` only, and `min_server` enforcement. |
| #347 HIL gate | Attest the binary's `sha256`, add the `hil-dev` key and the OTA scenarios, and scan releases for the dev key. |
| #348 flags | An `ota_offers` kill switch. |
| #349, #350, #351 | See "Server and web patches". #351 adopts the firmware runbook above. |
| New: "Firmware signing keys and manifest in the release job" | The keys, the environment, and the manifest and signature assets. |
| New: "USB recovery page with ESP Web Tools" | Publish the flashable parts, and build the page to the Astryx rules (`apps/ui-v2/CLAUDE.md`). |
| New: "Pin the PlatformIO platform" | The unpinned `espressif32` could change the bootloader or the partition defaults under devices already in the field. |
| New: "Secure Boot v2 and flash encryption (phase 2)" | Its own record, a bootloader built from ESP-IDF, and the owner's written acknowledgement of the eFuse burn. |

## Sources

- `npm run device:compile` (2026-09-23): `Espressif 32 (7.0.1)`, `framework-arduinoespressif32 @ 3.20017.241212`, "Flash: 41.9 % (used 1401121 bytes from 3342336 bytes)", and `apps/cardputer/.pio/build/m5stack-cardputer-v2-poc/partitions.bin` and `firmware.bin`.
- `~/.platformio/packages/framework-arduinoespressif32/`:
  - `tools/partitions/default_8MB.csv`;
  - `tools/sdk/versions.txt`;
  - `tools/sdk/esp32s3/qio_qspi/include/sdkconfig.h`;
  - `cores/esp32/esp32-hal-misc.c:207-231`;
  - `libraries/Update/src/Updater.cpp:111,257-262`;
  - `tools/sdk/esp32s3/include/esp_https_ota/include/esp_https_ota.h`;
  - `tools/platformio-build.py:215`.
- `~/.platformio/platforms/espressif32/boards/m5stack-stamps3.json`.
- ESP-IDF v4.4 OTA and rollback: https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32s3/api-reference/system/ota.html
- ESP32-S3 Secure Boot v2: https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32s3/security/secure-boot-v2.html
- ESP32-S3 flash encryption: https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32s3/security/flash-encryption.html
- ESP Web Tools: https://esphome.github.io/esp-web-tools/
- In this repository:
  - `.github/workflows/ci.yml`, `docs/release.md` and `docs/deploy.md`;
  - `apps/cardputer/include/ca_roots.h`, `apps/cardputer/src/network.cpp:163`, `apps/cardputer/include/types.h:80` and `apps/cardputer/include/config.h:78`;
  - `docs/cardputer/wake-word-decision.md`;
  - issues #343–#351.
