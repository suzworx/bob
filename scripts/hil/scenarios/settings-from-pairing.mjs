import { journalMatch } from '../journal-match.mjs';
// #679/#681: [,] opens Settings from the pairing screen, a server change
// there reconnects on that profile's own token, and the old server's pair
// code never comes back. `T server pair manual` stops the auto-approval and
// `T server pairing hold` makes the harness answer the device's next
// connection as one with no token, so after the reset the real server path
// sends pairing_required {reason:"none"} (as a server the active profile has
// no token for does) and the device sits on its pair code. It keeps its token:
// only unknown|revoked erase it. In Settings the Local dev endpoint is saved
// again through Server > [e] > Save > Use (the firmware's server change,
// profile_set; the rig has one server and a test never touches Production).
// Leaving Settings then reconnects with the dev token (auth=2) and is
// welcomed, with no pair_request_sent and no token erased.
export default {
  name: 'settings-from-pairing',
  issue: '#681',
  title: 'pairing screen → , Settings → Local dev saved → reconnect on its token → READY, no pair request',
  expectsReconnect: true,
  requires: [
    { event: 'settings_opened', feature: 'on-device Settings (#677)' },
    { event: 'profile_set', feature: 'server profiles (#679)' },
  ],
  steps: [
    { send: 'T server pair manual', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'pair', outcome: 'manual' }), timeoutMs: 5000 },
    { send: 'T server pairing hold', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'pairing', outcome: 'armed' }), timeoutMs: 5000 },
    { send: 'T bridge reset', expect: /^ok bridge$/ },
    { waitDevice: /INFO v2\.boot /, timeoutMs: 15_000 },
    { waitDevice: /INFO v2\.ws_mode .*profile=dev auth=2/, timeoutMs: 60_000 },
    { waitServer: /"event":"v2\.hil_pairing_held"/, timeoutMs: 60_000 },
    { waitServer: /"event":"v2\.pairing_required".*"reason":"none"/, timeoutMs: 60_000 },
    { waitDevice: /INFO v2\.pairing_required .*reason=none/, timeoutMs: 10_000 },
    { waitDevice: /INFO v2\.pair_code_received state=PAIR/, timeoutMs: 15_000 },
    { assertState: { state: 'PAIR' } },
    { press: ',' },
    { waitDevice: /INFO v2\.settings_opened state=SETTINGS/, timeoutMs: 3000 },
    // Home (developer build): Wi-Fi networks, Server, Reset, About.
    { press: '.' },
    { press: 'enter' },
    // Server: Production, Local dev, Custom. [e] edits Local dev; its rows are
    // Host, Port, Secure (TLS), Save; Save asks "Use Local dev?", Enter says yes.
    { press: '.' },
    { press: 'e' },
    { press: '.' },
    { press: '.' },
    { press: '.' },
    { press: 'enter' },
    { press: 'enter' },
    { waitDevice: /INFO v2\.profile_set state=SETTINGS (?:session=\S+ )?profile=dev tls=0/, timeoutMs: 3000 },
    { press: 'backtick' },
    { press: 'backtick' },
    { waitDevice: /INFO v2\.settings_closed state=SETTINGS (?:session=\S+ )?changed=server/, timeoutMs: 3000 },
    // The old pair code never resumes and the dev token is never erased.
    { noDevice: /INFO v2\.(pair_request_sent|pairing_started|device_token_erased) /, timeoutMs: 10_000 },
    { waitDevice: /INFO v2\.ws_mode .*profile=dev auth=2/, timeoutMs: 30_000 },
    { waitDevice: /INFO v2\.welcome_accepted /, timeoutMs: 30_000 },
    { assertState: { state: 'READY' }, timeoutMs: 15_000 },
  ],
  finally: [
    { send: 'T server pair auto', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'pair', outcome: 'auto' }), timeoutMs: 5000 },
    // A failure in Settings leaves it open: two backticks leave it, as the scenario's own close does.
    { press: 'backtick' },
    { press: 'backtick' },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
  ],
};
