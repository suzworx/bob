// #709 c3: a serial line that ends a burst on a full 64-byte USB packet stuck
// on the host until more output followed (HIL run 20260929-233629-b7e0: a
// 128-byte `T state` reply 3 s late, then every console reply one behind).
// `T echo <n>` (test console) answers with a line of exactly n bytes, "T> "
// and CRLF included, so this probes the lengths around each packet edge,
// 3 times each, and every reply must come back, and be its own, in 500 ms.
//
// A/B on the device: the packet-edge guard (journal.cpp emit, usb_packet.h)
// is on from boot. BOB_HIL_ZLP=off runs the same probes with it off (the
// run before the fix: expect 64/128/192/256 to fail); `finally` turns it back
// on either way, so later scenarios never run without it.

export const PROBE_LENGTHS = [63, 64, 65, 127, 128, 129, 192, 256];
export const ROUNDS = 3;
export const REPLY_WITHIN_MS = 500;

/** The exact reply text of `T echo n`: "echo=<n> " and 'x' filler, n - 5 bytes. */
export function echoReply(n) {
  const prefix = `echo=${n} `;
  return new RegExp(`^${prefix}x{${n - 5 - prefix.length}}$`);
}

/** The guard setting for this run: 'off' only when asked for explicitly. */
export function guardSetting(env = process.env) {
  return env.BOB_HIL_ZLP === 'off' ? 'off' : 'on';
}

export function probeSteps(lengths = PROBE_LENGTHS, rounds = ROUNDS) {
  const steps = [];
  for (let round = 0; round < rounds; round++) {
    for (const n of lengths) steps.push({ send: `T echo ${n}`, expect: echoReply(n), timeoutMs: REPLY_WITHIN_MS });
  }
  return steps;
}

const guard = guardSetting();

export default {
  name: 'console-packet-edge',
  issue: '#709',
  title: `T echo at ${PROBE_LENGTHS.join('/')} bytes, ${ROUNDS} rounds: each reply, and only its own, within ${REPLY_WITHIN_MS} ms (guard ${guard})`,
  steps: [
    { send: `T zlp ${guard}`, expect: new RegExp(`^ok zlp=${guard} late=\\d+$`) },
    ...probeSteps(),
    // The guard's late count (tails written before the ring drained), as evidence.
    { send: 'T zlp', expect: /^zlp=(on|off) late=\d+$/ },
  ],
  finally: [
    // A reply stuck by a failed probe may answer this one; `T zlp` below then
    // proves the guard is back on, with the console in step again.
    { send: 'T zlp on' },
    { send: 'T zlp', expect: /^zlp=on late=\d+$/ },
  ],
};
