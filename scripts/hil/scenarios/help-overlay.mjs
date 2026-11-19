// h opens the key help from READY; backtick closes it, and so does GO (the
// firmware's two ways out of HELP; a second h scrolls nothing and stays).
// Each time the device is back in READY.
export default {
  name: 'help-overlay',
  issue: '#311',
  title: 'help: h opens, backtick or GO closes',
  requires: [
    { event: 'help_opened', feature: 'help overlay on h (#311)' },
    { event: 'help_closed', feature: 'help overlay close (#311)' },
  ],
  steps: [
    { assertState: { state: 'READY' } },
    { press: 'h' },
    { waitDevice: /INFO v2\.help_opened state=HELP/, timeoutMs: 3000 },
    { assertState: { state: 'HELP' } },
    { press: 'backtick' },
    { waitDevice: /INFO v2\.help_closed state=READY/, timeoutMs: 3000 },
    { assertState: { state: 'READY' } },
    { press: 'h' },
    { waitDevice: /INFO v2\.help_opened state=HELP/, timeoutMs: 3000 },
    { press: 'btn down' },
    { waitDevice: /INFO v2\.help_closed state=READY/, timeoutMs: 3000 },
    // The release lands in READY and must not start a turn.
    { press: 'btn up' },
    { sleep: 300 },
    { assertState: { state: 'READY' } },
  ],
};
