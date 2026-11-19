// #669: a timer ring interrupts Settings. , opens Settings from READY, the
// server rings a timer, and the device closes Settings the way backtick does
// (settings_closed changed=none, back to READY) and then rings. A key
// dismisses it and the device is READY again.
export default {
  name: 'ring-over-settings',
  issue: '#669',
  title: 'a timer ring closes Settings and rings; a key dismisses it',
  requires: [
    { event: 'settings_closed', feature: 'on-device Settings (#677)' },
    { event: 'ring_started', feature: 'timer ring for ring_seconds (#389)' },
  ],
  steps: [
    { assertState: { state: 'READY' } },
    { press: ',' },
    { waitDevice: /INFO v2\.settings_opened state=SETTINGS/, timeoutMs: 3000 },
    { assertState: { state: 'SETTINGS' } },
    { send: 'T server announce ring', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.announce_sent"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.settings_closed state=SETTINGS (?:session=\S+ )?changed=none/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.announce_shown state=ANNOUNCE .*kind=timer,ring=1/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.ring_started state=ANNOUNCE .*kind=timer/, timeoutMs: 3000 },
    { assertState: { state: 'ANNOUNCE' } },
    { press: 'enter' },
    { waitDevice: /INFO v2\.ring_stopped state=ANNOUNCE .*reason=dismissed/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.announce_closed state=READY .*source=key/, timeoutMs: 3000 },
    { waitServer: /"event":"v2\.announce_acked".*"action":"dismissed"/, timeoutMs: 5000 },
    { assertState: { state: 'READY' } },
    { cleanSerial: true },
  ],
  // The ring closes Settings itself, so this backtick is only for a failure before the ring: it closes Settings from the home screen.
  finally: [
    { press: 'backtick' },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
  ],
};
