// The server rings a timer (the same announce() the timer scheduler calls);
// the device shows the ANNOUNCE card ringing, a key dismisses it, the device
// acks `dismissed`, and the server records the ack. boot-ready turned DND off,
// so nothing holds the announcement.
export default {
  name: 'announce-ring',
  issue: '#319',
  title: 'timer ring (#319/#320): shown, key dismisses, ack reaches the server',
  requires: [
    { event: 'announce_shown', feature: 'announcement card (#319)' },
    { event: 'announce_closed', feature: 'announcement dismiss (#319)' },
  ],
  steps: [
    { assertState: { state: 'READY', dnd: 0 } },
    { send: 'T server announce ring', expect: /^ok server$/ },
    { waitServer: /"event":"v2\.hil_command".*"outcome":"queued"/, timeoutMs: 5000 },
    { waitServer: /"event":"v2\.announce_sent"/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.announce_shown state=ANNOUNCE .*kind=timer,ring=1/, timeoutMs: 5000 },
    { assertState: { state: 'ANNOUNCE' } },
    { press: 'enter' },
    { waitDevice: /INFO v2\.announce_acked state=ANNOUNCE .*action=dismissed/, timeoutMs: 3000 },
    { waitDevice: /INFO v2\.announce_closed state=READY .*source=key/, timeoutMs: 3000 },
    { waitServer: /"event":"v2\.announce_acked".*"action":"dismissed"/, timeoutMs: 5000 },
    { assertState: { state: 'READY' } },
  ],
};
