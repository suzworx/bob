import { HEAP_FLOORS } from './heap-floor.mjs';

// The heap floor in each listening mode, idle in READY. Always awake holds the
// wake word arena (~28 KB) plus the mic while it listens, so it gets its own,
// lower floors. Starting values: tighten both from the `heap:` lines of real
// runs (data/hil/<run-id>/report.md). Modes are set through device_control so
// each step lands on a known mode; mode-cycle and wake-mode cover the k key.
export const WAKE_HEAP_FLOORS = { free: 16_000, min: 8_000, largest: 8_000 };

function inMode(mode, floors, extra = []) {
  return [
    { send: `T server control mode=${mode}`, expect: /^ok server$/ },
    { waitDevice: new RegExp(`INFO v2\\.mode_changed .*mode=${mode},.*source=server`), timeoutMs: 5000 },
    ...extra,
    // Let the mode settle (wake arena, mic) before reading.
    { sleep: 1000 },
    { assertState: { state: 'READY', mode } },
    { assertHeapMin: floors },
  ];
}

export default {
  name: 'heap-per-mode',
  issue: '#333',
  title: 'heap floor holds in ptt, wake and announce_only',
  requires: [{ event: 'mode_changed', feature: 'listening modes (#330)' }],
  steps: [
    { assertState: { state: 'READY' } },
    ...inMode('ptt', HEAP_FLOORS),
    ...inMode('wake', WAKE_HEAP_FLOORS, [
      { waitDevice: /INFO v2\.(wake_listening|wake_unavailable) /, timeoutMs: 5000 },
    ]),
    ...inMode('announce_only', HEAP_FLOORS),
    // Back to the baseline for the scenarios after this one.
    ...inMode('ptt', HEAP_FLOORS),
  ],
};
