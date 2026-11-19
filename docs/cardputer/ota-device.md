# Cardputer OTA: the device side (epic #343)

How the firmware takes an update. The wire is in `ota-wire.md`, the policy
numbers in `apps/cardputer/include/ota_policy.h`.

## Flow

1. **Offer.** The server sends `update_offer` in `welcome` or as a message; the
   device also asks with `check_update` once an hour while idle.
2. **Decide.** `otaShouldStart` runs every loop in `Ready` only. It waits for
   120 s idle, 40 % battery (or charging), no timer within 300 s, Wi-Fi up and
   a welcome, and the offer's `apply_after_s`. A user postponement lasts 4 h
   (3 at most); a mandatory offer forces after 24 h.
3. **Countdown.** 10 s on screen. Any key postpones, unless the postpones are
   used up or the mandatory offer is 24 h old.
4. **Install.** Blocking. The device fetches the signed manifest, checks the
   ECDSA P-256 signature (key table `include/fw_keys.h`, chosen by `key_id`),
   checks version, board, size and hash against the offer, then streams the
   image into the inactive slot hashing as it goes. A dropped stream resumes
   with `Range` + `If-Range` up to 3 times. The boot partition switches only
   when the SHA-256 matches. Failure aborts the write and keeps the old slot.
5. **Reboot** with a pending record (`from`, `to`) in NVS namespace `bob_ota`.
6. **Health gate.** The new image boots `PENDING_VERIFY` (`verifyRollbackLater`
   returns true). It is confirmed only after a welcome and 60 s up. A crash,
   watchdog reset or power loss before that makes the bootloader return to the
   previous slot. A device with no Wi-Fi configured confirms after 3 boots.
7. **Report.** The outcome is `ok` only once the gate has confirmed the image
   (a crash before it settles as `rolled_back`, never `ok`). The next `hello`
   carries `last_ota` (`ok`, `rolled_back` or `failed`, with the target and a
   reason code), `ota_slot` and `board`; the device forgets it after the
   welcome that follows, so it is reported once.

## Failure codes

`no_token`, `manifest_http`, `manifest_sig`, `manifest_bad`, `image_http`,
`flash_begin`, `flash_write`, `hash_mismatch`, `aborted`. Retries back off from
5 min doubling to 6 h; three failures in a session stop trying that offer.

## Keys

`fw_keys.h` holds public keys only. The `fw-hil` key is compiled into dev
builds (`BOB_DEV_OPTIONS`) so HIL can install a test image; release builds
do not trust it. Private keys live in git-ignored `data/ota-keys/`.

## Logs

Journal events: `ota_boot`, `ota_offer`, `ota_start`, `ota_reboot`,
`ota_failed`, `ota_postponed`, `ota_refused`, `ota_valid`. They carry versions,
slot, reason codes and counts; never a URL, token or hash.

## Not covered by host tests

The mbedTLS verify, `Update`, and the bootloader rollback run only on the
device. They are proven by `node scripts/hil/run.mjs --ota` (needs the
git-ignored `data/ota-keys/fw-hil.*` and `include/secrets.h`): it builds and
signs two test releases, 99.0.0 (good) and 99.0.1 (aborts at boot before the
gate), then runs `ota-power-cut`, `ota-update-ok` and `ota-rollback-crash`
against the real device and restores the product firmware. Not yet covered:
tampered image, wrong board, low-battery deferral, settings-migration rollback.
