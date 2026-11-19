# OTA wire (epic #343, OTA-4B)

How a Cardputer and the server talk about firmware updates. This is the control channel only: it says *whether* to update and *to what*. There is no route and no download here (OTA-4C). The decision rules are in [ota-decision.md](ota-decision.md), the signed release in [ota-release.md](ota-release.md).

Every change is additive. An old firmware never sends the new fields and ignores the new ones it is sent; an old server strips what it does not know. Fixtures: `apps/api/tests/fixtures/ota-wire.json`. Server DTOs: `apps/api/src/voice/protocol.ts`. Device parsers and builders: `apps/cardputer/include/protocol.h`.

## hello (device to server)

New optional payload fields. A bad value reads as absent and the hello stands (HELLO-COMPAT).

| Field | Type | Meaning |
| --- | --- | --- |
| `board` | string, `[A-Za-z0-9_.-]`, 1-24 chars | The hardware target, as the release manifest names it |
| `last_ota` | `{result, to, reason?}` | The outcome of the previous attempt: `result` is `ok`, `rolled_back` or `failed`, `to` a SemVer, `reason` a code of `[a-z0-9_]`, at most 24 chars |
| `ota_slot` | `0` or `1` | The OTA partition the device is running from |

`caps` gains the token `ota`. A device that does not list it is never offered anything and nothing it reports is stored.

```json
{"v":1,"type":"hello","id":"hello_123456_v2","payload":{"format_id":2,"fw_version":"0.3.0","caps":["reply_text","ota"],"board":"cardputer","last_ota":{"result":"rolled_back","to":"0.4.0","reason":"boot_loop"},"ota_slot":1}}
```

## welcome.update_offer (server to device)

Present only when the device advertised `ota` and the offer policy returned an offer. Otherwise the key is absent.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | SemVer | What to install. This may be a stepping stone, not the channel's target |
| `size` | integer | Image bytes |
| `sha256` | 64 lowercase hex | Digest of the image |
| `key_id` | string, at most 15 chars | The signing key the device must hold |
| `mandatory` | boolean | The device may not postpone forever |
| `apply_after_s` | integer | Seconds to wait before applying (a staged rollout delay) |
| `notes` | string, at most 80 chars, optional | Display text. Omitted when empty. The device does not keep it |

```json
"update_offer":{"version":"0.4.0","size":1500000,"sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","key_id":"fw-2026a","mandatory":false,"apply_after_s":3600,"notes":"Faster wake word"}
```

The keys are written in this order. The device parses by key and tolerates any order and any extra keys, but it refuses an offer with a missing key, a string that does not fit its buffer (never truncated), a `sha256` that is not 64 lowercase hex or a `mandatory` that is not a bare `true` or `false`.

## check_update (device to server)

`{}` payload. The answer is an `update_offer` message: the offer fields above, or `{"offer":null}` when nothing is on offer.

```json
{"v":1,"type":"check_update","id":"chk_123456_v2","payload":{}}
{"v":1,"type":"update_offer","id":"updo_0123456789abcdef","payload":{"offer":null}}
```

One answer per session per 60 s. A faster request gets the last answer again, so a polling device costs the server nothing. A device below `BOB_MIN_FW_VERSION` may still send `check_update` and `ota_progress`: it must be able to fetch its update.

## ota_progress (device to server)

`stage` is `start`, `ok` or `failed`; `to` is the version being installed; `reason` is an optional code of at most 24 chars. Only `start` is stored (a `start` event in the device's firmware history and a `v2.ota.result` journal line with `result: start`). `ok` and `failed` are not needed: the device reports the outcome in its next hello as `last_ota`, which is the record that counts. The message is for the journal and never needed for correctness.

```json
{"v":1,"type":"ota_progress","id":"otap_123456_v2","payload":{"stage":"start","to":"0.4.0"}}
```

## Compatibility rules

- New fields are optional. Never make an existing field required.
- A reader ignores unknown keys. The server strips them from every new message.
- A bad value in the hello `board`, `last_ota` or `ota_slot` is dropped, not an error.
- An OTA failure on the server never fails or delays hello: the device gets its welcome without an offer, and the server journals `v2.ota.error` with a reason code.
- Logs carry versions, board, reason codes and counts. Never a URL, token, hash or id.
- The device parses the offer into `OtaOffer` (`include/ota_policy.h`) and applies the rules there. The hello and progress builders are compile-only until the update state machine uses them.
