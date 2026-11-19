# OTA server: download, ingest, operator controls

Epic #343, see [ota-decision.md](ota-decision.md) and [ota-release.md](ota-release.md). Code: `apps/api/src/firmware`.

## Image download (device)

`GET /v2/firmware/:board/:version.bin?from=<running version>`

`GET /v2/firmware/:board/:version.manifest?from=<running version>` returns the exact signed `manifest.json` bytes with the base64 DER signature in `X-Bob-Signature`; same auth and eligibility as the image. The device verifies it against its compiled-in public keys before trusting the image.

- Auth: `Authorization: Bearer olxd_...`, the token the device socket uses. No valid, active device: `401`.
- Unknown board or version (or a version that is not X.Y.Z): `404`, one body for all of them.
- `403` unless the device could be offered that version (channel, rollout bucket, halt flag, `min_from`, failure back-off), is pinned to it, or says it is running it with `from` (so an interrupted download can resume). `from` defaults to `0.0.0`. It is a device claim: it cannot widen a rollout, only pick the version the device already runs.
- `200` with `application/octet-stream`, `ETag` (the quoted sha256), `Accept-Ranges: bytes`, `Content-Length`.
- One `Range: bytes=a-b` or `bytes=a-` gives `206` with `Content-Range`; past the end gives `416`. Suffix and multi-range requests are ignored (full body). `If-Range` with a different etag gives the full body. `If-None-Match` with the etag gives `304`.
- Journal: `v2.ota.download` once per response (version, board, `completed` or `aborted`, bytes).

## Ingest from GitHub Releases

`POST /api/operator/firmware/ingest {"tag":"vX.Y.Z"}` fetches `bob-cardputer-vX.Y.Z.bin`, `manifest.json` and `manifest.sig` from the release, verifies the signature against `BOB_FW_PUBKEYS` (JSON of key id to PEM, public keys from `apps/cardputer/keys/*.pub.pem`), checks the image against the manifest and stores it. The dev channel advances to a higher version.

Settings: `BOB_FW_GITHUB_REPO` (default `suzworx/Bob`), `BOB_FW_GITHUB_TOKEN` (optional, lifts the anonymous rate limit). Fixed: 30 s per request, 4 MB per file.

Errors are codes only: `422` `bad_manifest` / `unknown_key` / `bad_signature` / `image_mismatch`; `400` `bad_tag`; `404` `release_not_found` / `asset_missing`; `413` `too_large`; `502` `fetch_failed`.

## Operator controls

Behind the operator gate (scope `metrics.operator`, `404` for everyone else).

| Route | Body | Effect |
|---|---|---|
| `GET /api/operator/firmware?board=cardputer` | | per channel for each board: version, rollout, halted, release summary, 7-day `attempts`, `rollbacks`, `fleet_size` |
| `POST /api/operator/firmware/channel` | `{channel, board, version, rollout_pct?}` | point a channel at an ingested release (board must be in it, rollout 0..100, default 100); journals `v2.ota.promote` |
| `POST /api/operator/firmware/halt` | `{channel, board, halted}` | halt or resume; journals `v2.ota.halt` on a change |
