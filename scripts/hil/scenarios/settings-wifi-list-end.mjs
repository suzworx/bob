// #728: with 9 or more networks in range, Choose Wi-Fi holds more rows than
// the old 11-row cap, and its last rows still work. `,` → Wi-Fi networks →
// `a` scans (needs listed >= 9); `.` past the end stops on "Scan again", and
// Enter rescans; one `;` up is "? My network isn't listed", whose Enter opens
// the not-listed screen, and Enter there scans again. Backtick back to READY.
// Whether the rows are drawn is covered by test_picker_window.cpp.
const DOWN_PAST_END = Array.from({ length: 16 }, () => ({ press: '.' }));
const LISTED_9_PLUS = /INFO v2\.wifi_scan state=SETTINGS (?:session=\S+ )?found=\d+ listed=(?:9|1[0-2])\b/;

export default {
  name: 'settings-wifi-list-end',
  issue: '#728',
  title: 'Choose Wi-Fi with 9+ networks: "Scan again" and "My network isn\'t listed" work',
  requires: [
    { event: 'settings_opened', feature: 'on-device Settings (#677)' },
    { event: 'wifi_scan', feature: 'Settings Wi-Fi scan (#677)' },
  ],
  steps: [
    { assertState: { state: 'READY' } },
    { press: ',' },
    { waitDevice: /INFO v2\.settings_opened state=SETTINGS/, timeoutMs: 3000 },
    { press: 'enter' },
    { press: 'a' },
    { waitDevice: LISTED_9_PLUS, timeoutMs: 15000 },
    ...DOWN_PAST_END,
    { press: 'enter' },
    { waitDevice: LISTED_9_PLUS, timeoutMs: 15000 },
    ...DOWN_PAST_END,
    { press: ';' },
    { press: 'enter' },
    { noDevice: /INFO v2\.wifi_scan /, timeoutMs: 500 },
    { press: 'enter' },
    { waitDevice: LISTED_9_PLUS, timeoutMs: 15000 },
    { press: 'backtick' },
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
