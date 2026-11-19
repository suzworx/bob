# Hardware-in-the-loop tests

Firmware changes must pass on a real Cardputer over the USB cable before they
can be pushed or merged. The runner, the scenarios and the gate live in
`scripts/hil/`. The guide is [`docs/cardputer/hil.md`](../../../docs/cardputer/hil.md).

```sh
node scripts/hil/run.mjs            # flash the m5stack-cardputer-hil env, run every scenario
node scripts/hil/run.mjs --dry-run  # validate the scenarios, no hardware
node scripts/device-attest.mjs      # after pushing: post local/device-hil for the PR check
```
