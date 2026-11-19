// , opens Settings from READY (#677); ; . move, Enter opens About, backtick
// goes back and closes Settings with nothing changed, and the device is back
// in READY with no raw serial output. Needs no test access point.
export default {
  name: 'settings-navigation',
  issue: '#677',
  title: 'settings: , opens, About, backtick closes, nothing changed',
  requires: [
    { event: 'settings_opened', feature: 'on-device Settings (#677)' },
    { event: 'settings_closed', feature: 'on-device Settings (#677)' },
  ],
  steps: [
    { assertState: { state: 'READY' } },
    { press: ',' },
    { waitDevice: /INFO v2\.settings_opened state=SETTINGS/, timeoutMs: 3000 },
    { assertState: { state: 'SETTINGS' } },
    // Home on the HIL (developer) build: Wi-Fi networks, Server, Reset, About.
    { press: '.' },
    { press: '.' },
    { press: '.' },
    { press: 'enter' },
    { sleep: 300 },
    { assertState: { state: 'SETTINGS' } },
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
