# Review checklist

Run it on every diff before a merge. Each item is pass or fail, with the file:line
as evidence.

## Scope

- [ ] The diff does what the brief (or issue) asked, all of it, and nothing more.
- [ ] Every changed path is in the brief's `owns`. Anything else is a finding, not a fix.
- [ ] The branch is based on origin/main (`git merge-base --is-ancestor origin/main HEAD`).

## Privacy and secrets

- [ ] No log, journal line, test fixture, evidence file or brief contains Wi-Fi SSIDs, passwords, hosts or URLs,
      tokens (`olxd_...`, JWTs, API keys), pairing codes, audio, transcripts, agent text or prompts.
- [ ] Nothing in the diff adds `.env`, `secrets.h`, keys or PII.
- [ ] Auth, tokens, pairing or secrets touched? Then run the `security-review` skill as well.

## Contracts

- [ ] A Zod schema at every wire boundary: device protocol (`apps/api/src/voice/protocol.ts`),
      `/api/*` request and response DTOs, env and config parsing.
- [ ] A wire change keeps the firmware parser's key order. Device and server change together, or the change
      is additive.
- [ ] Module boundaries hold: `npm run check:boundaries` passes with "no exceptions".
- [ ] Every new table, and every new one-row-per-owner table, is justified by one of the reasons in the
      "Composition and denormalization" section of [agent-contract.md](agent-contract.md). Otherwise it is
      columns, or a `kind` value, on an existing table.

## Firmware (apps/cardputer)

- [ ] Every mutex is held briefly, and never across network, audio or display I/O.
- [ ] Waits in the main loop are bounded (timeouts, not `portMAX_DELAY`); nothing blocks the loop.
- [ ] New tasks have a stated priority, core and stack size; the stack is sized from a high-water mark.
- [ ] Flash and static RAM stay within budget: `npm run firmware:budget`.
- [ ] Radio or boot changes pass the boot-loop rule, and NVS changes pass an upgrade test
      ([shared-hardware.md](shared-hardware.md)).

## Tests

- [ ] Deterministic: fake timers and injected clocks; no wall-clock sleeps, no dates relative to "today",
      no dependence on test order.
- [ ] New behaviour has a test that failed before the change.
- [ ] Any escaped defect (a bug found outside tests) gets the test that would have caught it, plus a fix for
      its whole class (`docs/testing/escaped-defects.md`).

## Real path

- [ ] Proven on the real path, not only against mocks: the real app, the real device (HIL) or
      `npm run accept:replay`, as the change needs. Both sides mocked can both pass while the seam is broken.
- [ ] `npm run validate` passed on this tree (`data/validate-pass.json`), and the pass was attested after push.

## Verdict

Record the verdict on the PR. Name each failed item with its file:line and send it back to whoever wrote
the change.
