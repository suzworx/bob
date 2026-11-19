// Factory reset needs RESET typed exactly (#680): RESE + Enter does nothing,
// Fn+` cancels, and nothing is reset or restarted. Exercises the text field
// through the console (keys, Enter, Fn chord) without touching any data.
export default {
  name: 'factory-reset-guard',
  issue: '#680',
  title: 'reset: factory reset refuses anything but RESET',
  requires: [
    { event: 'settings_opened', feature: 'on-device Settings (#677)' },
    { event: 'reset', feature: 'reset options (#680)' },
  ],
  steps: [
    { assertState: { state: 'READY' } },
    { press: ',' },
    { waitDevice: /INFO v2\.settings_opened state=SETTINGS/, timeoutMs: 3000 },
    // Home: Wi-Fi networks, Server, Reset, About -> Reset.
    { press: '.' },
    { press: '.' },
    { press: 'enter' },
    // Reset: Forget all Wi-Fi, Server back to Production, Unpair, Factory reset.
    { press: '.' },
    { press: '.' },
    { press: '.' },
    { press: 'enter' },
    { press: 'R' },
    { press: 'E' },
    { press: 'S' },
    { press: 'E' },
    { press: 'enter' },
    { noDevice: /v2\.reset |v2\.boot /, timeoutMs: 2000 },
    { press: 'fn `' },
    { press: 'backtick' },
    { press: 'backtick' },
    { waitDevice: /INFO v2\.settings_closed state=SETTINGS (?:session=\S+ )?changed=none/, timeoutMs: 3000 },
    { assertState: { state: 'READY' } },
    { cleanSerial: true },
  ],
  // A failed step above leaves Settings open, and the next scenario then starts in SETTINGS.
  finally: [
    { press: 'backtick' },
    { press: 'backtick' },
    { press: 'backtick' },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
  ],
};
