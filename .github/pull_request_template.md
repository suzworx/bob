## Summary

<!-- One or two sentences: what this PR does and why. Link every issue. -->

Closes #

## What changed

<!-- The meaningful changes, grouped by area (firmware / api / ai / ui-v2 / scripts / docs). -->

-

## Evidence

<!-- Proof it works, not a claim that it does. Paste real output; delete the
     sections that do not apply to this PR. -->

**Automated tests**

| Suite | Command | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| Validate gate | `npm run validate` | | | |

**Firmware: hardware-in-the-loop run** (required when `apps/cardputer/{src,include,lib}` or `platformio.ini` changed)

- HIL run id: `<run-id>` (`data/hil/<run-id>/report.md`)
- Firmware hash: `<fw hash>`; `local/device-hil` posted: yes / no

| Scenario | Issue | Result | Note |
| --- | --- | --- | --- |
| | | | |

<details><summary>Serial excerpt</summary>

```text
<the device journal lines that prove the behaviour, from data/hil/<run-id>/serial.log>
```

</details>

**Web: screenshots** (for `apps/ui-v2` changes: before / after, light and dark)

**API: real-path run** (for `apps/api` / `apps/ai` changes: the real server driven end to end, with the journal lines)

```text
```

## Memory

<!-- Firmware only: RAM and flash from the `pio run` summary, before and after. -->

| | Before | After | Delta |
| --- | --- | --- | --- |
| RAM | | | |
| Flash | | | |

## Risk and rollback

<!-- What could break, who would notice, and how to undo it (revert, flag, re-flash). -->

## Checklist

- [ ] `npm run validate` passes
- [ ] Firmware changed → HIL run passed on the device and `node scripts/device-attest.mjs` posted `local/device-hil`
- [ ] New or changed journal events are documented in `docs/log-reference.md`
- [ ] No secrets, keys, audio, transcripts, prompts or PII in code, logs or this PR
