// #669 check e: a timer ring during a Settings join test (CONNECTING). The
// device picks the first scanned network and tests a wrong password, which
// drops the link for the test. The ring is sent while the test runs: Settings
// must not close mid-join. The ring waits until the test ends (wifi_test
// result=...) and the user closes Settings with backtick; then the device
// re-joins its saved network, reconnects, and the server's outbox delivers the
// unacked ring, which shows and rings. Nothing is saved.
export default {
  name: 'ring-during-join-test',
  issue: '#669',
  title: 'a timer ring during a join test waits for the test and for Settings to close',
  // The join test drops the link, so the device reconnects on purpose; the
  // steps prove it (welcome_accepted after settings_closed).
  expectsReconnect: true,
  requires: [
    { event: 'wifi_test', feature: 'Settings join test (#677)' },
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
    { press: 'x' },
    { press: 'x' },
    { press: 'x' },
    { press: 'x' },
    { press: 'x' },
    { press: 'x' },
    { press: 'x' },
    { press: 'enter' },
    { waitDevice: /INFO v2\.wifi_test state=SETTINGS (?:session=\S+ )?started=1/, timeoutMs: 3000 },
    { send: 'T server announce ring', expect: /^ok server$/ },
    { noDevice: /INFO v2\.settings_closed /, timeoutMs: 2000 },
    { waitDevice: /INFO v2\.wifi_test state=SETTINGS (?:session=\S+ )?result=(?!ok)/, timeoutMs: 20000 },
    { noDevice: /INFO v2\.(?:settings_closed|announce_shown|ring_started) /, timeoutMs: 1000 },
    { assertState: { state: 'SETTINGS' } },
    { press: 'backtick' },
    { press: 'backtick' },
    { press: 'backtick' },
    { press: 'backtick' },
    { waitDevice: /INFO v2\.settings_closed state=SETTINGS /, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.welcome_accepted state=READY /, timeoutMs: 40000 },
    { waitDevice: /INFO v2\.announce_shown state=ANNOUNCE .*kind=timer,ring=1/, timeoutMs: 45000 },
    { waitDevice: /INFO v2\.ring_started state=ANNOUNCE .*kind=timer/, timeoutMs: 3000 },
    { noDevice: /INFO v2\.(?:net_saved|net_updated) /, timeoutMs: 1 },
    { press: 'enter' },
    { waitDevice: /INFO v2\.ring_stopped state=ANNOUNCE .*reason=dismissed/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.announce_closed state=READY .*source=key/, timeoutMs: 3000 },
    { waitServer: /"event":"v2\.announce_acked".*"action":"dismissed"/, timeoutMs: 5000 },
    { assertState: { state: 'READY' } },
    { cleanSerial: true },
  ],
  // A failed step above (a join test in progress included) leaves Settings open, and the next scenario then starts in SETTINGS.
  finally: [
    { press: 'backtick' },
    { press: 'backtick' },
    { press: 'backtick' },
    { press: 'backtick' },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
  ],
};
