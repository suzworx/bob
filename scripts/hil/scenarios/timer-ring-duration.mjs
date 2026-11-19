// #389: a timer rings for ring_seconds, then stops by itself, says "Missed
// timer" and acks `missed`; a key while it rings stops it and acks
// `dismissed`. The harness sets ring_seconds=10 through device_control (the
// same push the web settings send), so the full ring fits in the run, and
// puts the default 30 back at the end. ring_ms is the device's own measure
// from ring_started to ring_stopped: 10 s ±1 for the missed ring.
export default {
  name: 'timer-ring-duration',
  issue: '#389',
  title: 'timer ring lasts ring_seconds=10 then acks missed; a key after 2 s acks dismissed',
  requires: [
    { event: 'ring_started', feature: 'timer ring for ring_seconds (#389)' },
    { event: 'ring_stopped', feature: 'timer ring stop reasons (#389)' },
  ],
  steps: [
    { assertState: { state: 'READY', dnd: 0 } },
    { send: 'T server control ring_seconds=10', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"command":"control".*"outcome":"sent_1"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.device_control_applied .*ring_s=10/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.device_state_sent .*ring_s=10/, timeoutMs: 5000 },

    // Nobody touches it: rings 10 s, stops, acks missed, the card stays up.
    { send: 'T server announce ring', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.announce_sent"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.announce_shown state=ANNOUNCE .*kind=timer,ring=1/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.ring_started state=ANNOUNCE .*kind=timer,ring_s=10,sound=(classic|chime|pulse)/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.ring_stopped state=ANNOUNCE .*reason=missed,ring_ms=(9\d{3}|10\d{3}|11000)\b/, timeoutMs: 15_000 },
    { waitDevice: /INFO v2\.announce_acked state=ANNOUNCE .*action=missed/, timeoutMs: 3000 },
    { waitServer: /"event":"v2\.announce_acked".*"action":"missed"/, timeoutMs: 5000 },
    { assertState: { state: 'ANNOUNCE' } },
    { press: 'enter' },
    { waitDevice: /INFO v2\.announce_closed state=READY .*source=key/, timeoutMs: 3000 },
    { assertState: { state: 'READY' } },

    // A key 2 s in: stops at once and acks dismissed.
    { send: 'T server announce ring', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.ring_started state=ANNOUNCE .*ring_s=10/, timeoutMs: 5000 },
    { sleep: 2000 },
    { press: 'enter' },
    { waitDevice: /INFO v2\.ring_stopped state=ANNOUNCE .*reason=dismissed,ring_ms=(1[89]\d{2}|2\d{3}|3\d{3})\b/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.announce_acked state=ANNOUNCE .*action=dismissed/, timeoutMs: 3000 },
    { waitServer: /"event":"v2\.announce_acked".*"action":"dismissed"/, timeoutMs: 5000 },
    { assertState: { state: 'READY' }, timeoutMs: 3000 },

    // Back to the default for later scenarios and the owner's device.
    { send: 'T server control ring_seconds=30', expect: /^ok server$/ },
    { waitDevice: /INFO v2\.device_control_applied .*ring_s=30/, timeoutMs: 5000 },
    { cleanSerial: true },
  ],
};
