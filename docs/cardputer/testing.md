# Cardputer firmware testing

The firmware is tested in five layers. The first three need no hardware and run in CI.

| Layer | Command | Hardware | Runs in |
| --- | --- | --- | --- |
| Host unit tests | `npm run test:firmware` | none | `npm run validate`, CI `firmware` job |
| Wire contract fixtures | `npx vitest run --root apps/api tests/voice/wire-fixtures.test.ts` | none | api suite (`validate`, CI `server`; `ci-scope.mjs` schedules `server` for fixture changes) |
| Memory budget | `npm run firmware:budget` | none (needs PlatformIO) | `npm run validate`, CI `firmware` job |
| On-device harness | `npm run device:test` | Cardputer on `BOB_COM_PORT` | by hand |
| Hardware matrix | see below | Cardputer + real server | by hand, before a release |

## 1. Host unit tests

`apps/cardputer/test/host/` compiles the **real** `src/protocol.cpp` and `src/types.cpp`,
unchanged, against a small Arduino shim (`test/host/shim/`: `String`, `millis()`,
`esp_random()`), and runs them under **AddressSanitizer + UBSan** with `-Werror`.

- **Framework:** [doctest](https://github.com/doctest/doctest) 2.4.11, one vendored header
  (`test/host/vendor/doctest.h`, MIT, licence alongside). It was chosen over Unity via a
  PlatformIO `native` env because it needs only a C++17 compiler: no PlatformIO on the
  test path, the same command locally and in CI, and it runs in a stock `gcc` image.
- **Compiler:** `$CXX`, else `g++`/`clang++` on PATH. On Windows (MinGW has no ASan
  runtime), with `--docker`, or when no compiler is found, the same build runs in
  `gcc:14.2.0` pinned by digest (`test/host/run.mjs`). Docker must be running.
- **The shim copies the ESP32 core's `String` edge cases** (`operator[]` past the end returns
  0, `indexOf` from past the end returns -1, `substring` swaps and clamps). A parser
  that only works because the shim is kinder than the device cannot pass here.
- `millis()` is test-controlled (`hostshim::setMillis`), so builder ids are exact bytes.
- Filter with doctest flags: `npm run test:firmware -- -tc="*welcome*"`, `-s` for passing detail.

Files: `test_builders.cpp` (device→server), `test_parsers.cpp` (predicates, welcome,
conversations, active, status, errors), `test_spaces.cpp` (the #301 Space picker: spaces,
space_selected, active_space, welcome.active_space), `test_pairing.cpp`, `test_olx2.cpp` (frame
headers), `test_bounds.cpp` (caps, truncation, and every prefix and byte mutation of every
fixture pushed through every parser).

**Known bugs** are tests marked `* doctest::should_fail()` with the title prefix
`KNOWN BUG:`. They pass while the bug exists. When a fix to `src/` makes one pass, doctest
reports it as a failure: drop the decorator and the prefix in the same PR as the fix.

## 2. Wire contract fixtures

`apps/cardputer/test/fixtures/wire/*.json` holds, one file per message, the **exact bytes**
the firmware sends or parses (one line, compact `JSON.stringify` output). Key order matters
because the firmware parses by substring. `frames/olx2_audio_down.json` holds OLX2
downlink headers.

- The host tests parse the server→device fixtures and compare builder output with the
  device→server fixtures byte for byte.
- `apps/api/tests/voice/wire-fixtures.test.ts` checks every fixture against its Zod schema
  (`ClientControlDtoSchema`, `ServerControlDtoSchema`, or the pairing/active schemas outside
  that union), checks the frame headers against `serializeAudioFrame`, and drives the real
  `handleControl` (store mocked, no database) to assert that welcome (all six variants,
  including `active_space` present, null and omitted on a Space store outage),
  pairing_required, conversations, conversation_selected, conversation_cleared,
  active_conversation, spaces, space_selected, active_space and error (incl.
  SPACE_NOT_FOUND) are the fixture bytes once the random ids are pinned.

So a server change the firmware would not parse (a renamed key, a reordered payload)
fails `wire-fixtures.test.ts`, and a fixture change the firmware would not accept fails
the host tests. The fake `paired` token ends in `-` so the staged-diff secret scanner
(`olxd_…\b`) does not flag it.

**Adding a test for a new message:**

1. Write the fixture: the exact bytes the sender produces, compact, key order as sent.
2. Server→device: map its type in `SERVER_SCHEMAS` and add a `handleControl` case in
   `wire-fixtures.test.ts`; add it to `kServerFixtures` (and the fuzz list in
   `test_bounds.cpp`) with a parser test in `test_parsers.cpp`.
   Device→server: add it to `DEVICE_TO_SERVER` and a builder test in `test_builders.cpp`.
3. Run both suites. Bounds worth a case: the display cut (28 chars), list caps (10), ids at
   the 64-char schema max, and input longer than the destination buffer.

A fixture change schedules both the `server` and `firmware` CI jobs (`scripts/ci-scope.mjs`),
so neither half of the contract can be skipped.

## 3. Memory budget

`apps/cardputer/memory-budget.json` sets static limits for env `m5stack-cardputer-v2-poc`
and documents the runtime heap plan with each number's source line.
`scripts/firmware-budget.mjs --check` reads the RAM/Flash summary `pio run` prints (it runs
`pio run` itself, or reads a saved log with `--log <file>`).

| Region | Baseline (2026-09-29) | Limit | Warn when growth exceeds |
| --- | --- | --- | --- |
| Static RAM (.data + .bss) | 63,656 B (19.4%) | 65,536 B (20%) | 2 KiB |
| Flash (app image) | 1,577,213 B (47.2%) | 1,605,632 B (48.0%) | 32 KiB |

`memory-budget.json` is the source of truth; its `why` fields record each re-base (#311,
#669). The #669 trim compiled the Arduino core's info/warning logs out (`CORE_DEBUG_LEVEL=1`).

The first baseline (52,484 B RAM, 1,226,157 B flash) was re-based the same day after the
Space picker and wake-word module (#331, #312) added ~2 KiB of RAM and ~171 KiB of flash.
The budget's own warning caught that growth.

**Policy.** Over a limit fails validate and CI. Growth over the baseline beyond the
threshold only warns (a GitHub `::warning::`), and the PR should say why. A PR that
intentionally grows the firmware re-bases `baselineBytes`; raising a `limitBytes` needs a
reason in `why`. If the region size changes (partition table, board), the check fails until
`totalBytes` is updated on purpose. Static RAM is budgeted tightly because every byte comes
out of the heap the playback buffer, MP3 decoder and TLS need at runtime (see
`runtimeHeap`). Runtime heap is not measured by CI: the `heap free= largest=` journal line
(`turn_heap`, `src/state_core.cpp` `journalTurnHeap`) on hardware is the check.

## 4. On-device harness

`npm run device:test` builds, flashes, streams a known MP3 from a mock server and scores
playback from serial (`--skip-flash`, `--runs=N`, `--pcm16-hello`, `--tone-test`;
see `apps/cardputer/scripts/device-test.mjs`). `npm run device:integration` drives the
`BOB_AUTO_TURN` build against the real API in `BOB_SYSTEM_TEST` mode.

## 5. Hardware matrix (by hand)

Before a release, on a flashed device against a real server: pair a fresh device; talk one
turn in MP3 and one with `--pcm16-hello`; open the picker, select a conversation, start a
new one from the keyboard; change the active conversation from the web and see the device
follow; pick a space thread in the picker (or "Use on Cardputer" on a thread on the web), talk
one turn and see both messages appear live in that thread on the web (`v2.device_thread_saved`);
archive that space and see the next turn start a new General conversation; drop Wi-Fi and see it
reconnect; revoke the device and see pairing_required.
Read `docs/log-reference.md` for the journal lines each step produces.

## Keyboard facts for text entry (#677)

Read from the pinned `m5stack/M5Cardputer` 1.1.x source (`Keyboard::updateKeysState`), not measured on a device:

- `keysState().word` holds every printable key **held right now**, space included (space also sets `space`). It is a state, not an event list, so a new key press is a character that was not in the previous state's `word` (`fieldNewlyPressed` in `include/text_field.h`).
- Shift, Ctrl or Caps Lock put the shifted glyph in `word`. **Fn does not change `word`**: Fn+`,` arrives as `,` with `fn=true`, which is how the text field tells cursor movement from typing a comma.
- `del`, `enter` and `tab` are true while held, and `isChange()` also fires on release, so Settings acts on the press edge only (`src/settings_ui.cpp`).
- There is no key auto-repeat in the library; the text field repeats Del itself (400 ms, then every 60 ms).

