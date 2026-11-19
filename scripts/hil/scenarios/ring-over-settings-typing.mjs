// #669 check d: a timer ring while a Wi-Fi password is being typed. `,` opens
// Settings, Enter opens Wi-Fi networks, `a` scans, Enter picks the first
// network and opens the password field. Two characters are typed, then the
// server rings: Settings closes with nothing changed and nothing saved or
// joined (the typed text is dropped, as backtick drops it), then the ring
// shows and rings. A key dismisses it and the device is READY.
export default {
  name: 'ring-over-settings-typing',
  issue: '#669',
  title: 'a timer ring while typing a Wi-Fi password closes Settings, saves nothing, rings',
  requires: [
    { event: 'settings_closed', feature: 'on-device Settings (#677)' },
    { event: 'ring_started', feature: 'timer ring for ring_seconds (#389)' },
  ],
  steps: [
    { assertState: { state: 'READY' } },
    { press: ',' },
    { waitDevice: /INFO v2\.settings_opened state=SETTINGS/, timeoutMs: 3000 },
    { press: 'enter' },
    { press: 'a' },
    // A Settings scan runs while connected and can pass the core's 6 s timeout;
    // it must still list networks (found=0 or failed=1 here was a bug).
    { waitDevice: /INFO v2\.wifi_scan state=SETTINGS (?:session=\S+ )?found=[1-9]\d* listed=[1-9]/, timeoutMs: 15000 },
    { press: 'enter' },
    { press: 'x' },
    { press: 'y' },
    { noDevice: /INFO v2\.wifi_test /, timeoutMs: 300 },
    { send: 'T server announce ring', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.announce_sent"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.settings_closed state=SETTINGS (?:session=\S+ )?changed=none/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.announce_shown state=ANNOUNCE .*kind=timer,ring=1/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.ring_started state=ANNOUNCE .*kind=timer/, timeoutMs: 3000 },
    { noDevice: /INFO v2\.(?:net_saved|net_updated|wifi_test) /, timeoutMs: 1 },
    { assertState: { state: 'ANNOUNCE' } },
    { press: 'enter' },
    { waitDevice: /INFO v2\.ring_stopped state=ANNOUNCE .*reason=dismissed/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.announce_closed state=READY .*source=key/, timeoutMs: 3000 },
    { assertState: { state: 'READY' } },
    { cleanSerial: true },
  ],
  // The ring closes Settings itself. A failure before it can leave the password field open: the first backtick cancels the field, the next two leave Settings.
  finally: [
    { press: 'backtick' },
    { press: 'backtick' },
    { press: 'backtick' },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
  ],
};
