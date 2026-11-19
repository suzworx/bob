# OTA release bundle

Epic #343, see [ota-decision.md](ota-decision.md). Every firmware release carries a signed manifest that the device and the API both trust.

## Bundle contents (per version X.Y.Z)

| Asset | What it is |
|---|---|
| `bob-cardputer-vX.Y.Z.bin` | the firmware image the device flashes |
| `bob-cardputer-vX.Y.Z.elf` | the release env's `firmware.elf`, for symbolising crashes |
| `manifest.json` | the signed description of the release |
| `manifest.sig` | base64 DER ECDSA signature over the exact `manifest.json` bytes |
| `SHA256SUMS` | `<hex>  <name>` for the bin, elf, manifest.json and manifest.sig |

## manifest.json

UTF-8, 2-space JSON, trailing newline, keys in this order. Static values live in `scripts/release/fw-release.json`.

| Field | Meaning |
|---|---|
| `schema` | manifest format, `1` |
| `product` | `bob-cardputer` |
| `version` | release version `X.Y.Z` |
| `boards` | boards the image runs on |
| `image` | `file`, `size` in bytes, `sha256` of the bin |
| `min_from` | oldest version allowed to update to this one |
| `allow_downgrade` | whether the device may move to an older version |
| `rollback_safe` | whether the previous image can run on this release's settings |
| `settings_schema` | version of the persisted settings layout |
| `requires_bootloader` | bootloader/core the image needs |
| `mandatory` | device must take this update (`--mandatory`) |
| `security_fix` | release fixes a vulnerability (`--security-fix`) |
| `key_id` | which trusted key signed it |
| `git_sha` | short commit sha |
| `built_at` | ISO-8601 UTC build time |
| `notes` | first line of the release notes, at most 80 chars |

## Signing and verification

The release job runs `node scripts/release/fw-manifest.mjs build ...`. It reads the private key PEM from the env var `BOB_FW_SIGNING_KEY` (never written to disk or logged; the build fails if it is unset), signs with ECDSA P-256 / SHA-256, and self-verifies with the public key derived from it. It then runs `fw-manifest.mjs verify` against the checked-in `apps/cardputer/keys/fw-2026a.pub.pem`, and the job fails if that file is missing.

Verify a download by hand:

```
node scripts/release/fw-manifest.mjs verify --manifest manifest.json --sig manifest.sig \
  --pub apps/cardputer/keys/fw-2026a.pub.pem --bin bob-cardputer-vX.Y.Z.bin
```

## Keys: generate and rotate

1. `node scripts/release/fw-keys.mjs gen --id fw-2027a --out-dir <private dir outside the repo>` writes `fw-2027a.key.pem` (mode 0600) and `fw-2027a.pub.pem`.
2. Store the private PEM in the GitHub secret `BOB_FW_SIGNING_KEY`, then delete the local copy. Never commit it.
3. Commit the public PEM as `apps/cardputer/keys/fw-2027a.pub.pem`.
4. Regenerate the device key table, listing every key the device must still trust (old and new during a rotation): `node scripts/release/fw-keys.mjs header --pub fw-2026a=apps/cardputer/keys/fw-2026a.pub.pem --pub fw-2027a=apps/cardputer/keys/fw-2027a.pub.pem --out apps/cardputer/include/fw_keys.h`.
5. Ship a release signed with the old key that carries the new header, then switch the secret and the `--key-id` / pub path in CI to the new key.

## Owed

- SBOM
- `factory.bin` (full-flash image)
- HIL attestation (OTA-6)
