import { loopHealthy, pttTurn } from './steps.mjs';

// Three full turns back to back, then the heap must still clear its floors: a
// per-turn leak or fragmentation shows up here long before a crash does.
//
// Floors (bytes) are the first line of defence, set below what a healthy
// ESP32-S3 Cardputer (no PSRAM) has after boot; tighten them from real run
// evidence (`heap:` lines in data/hil/<run-id>/report.md).
export const HEAP_FLOORS = { free: 40_000, min: 20_000, largest: 16_000 };

export default {
  name: 'heap-floor',
  issue: '#333',
  title: 'heap floor holds after 3 turns',
  steps: [
    { assertState: { state: 'READY' } },
    { assertHeapMin: HEAP_FLOORS },
    ...pttTurn(),
    ...pttTurn(),
    ...pttTurn(),
    // Let the decoder task and socket buffers settle before reading.
    { sleep: 1500 },
    { assertHeapMin: HEAP_FLOORS },
    // The last scenario: the whole run's slowest loop and uplink drops.
    loopHealthy(),
  ],
};
