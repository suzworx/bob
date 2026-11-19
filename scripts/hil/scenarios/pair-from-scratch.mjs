import { journalMatch } from '../journal-match.mjs';
import { pttTurn } from './steps.mjs';

// Epic #611: a device with no token pairs the way a new owner's does. The
// test console forgets the token (after backing it up under a test-only NVS
// key), the device reboots, says hello with no Authorization (ws_mode auth=0),
// is answered pairing_required(none) and shows a pair code. The harness then
// approves that pairing through the web's own POST /api/pair/approve (auto-
// approval off, `T server pair manual`), the device receives `paired`, saves
// its olxd_ token, reconnects with it (auth=2) and is welcomed. One push-to-
// talk turn proves the new pairing is a working session. In `finally`, which
// runs even when a step failed, the owner's token goes back and the device
// reboots onto it, so a run never leaves the device paired only to this
// throwaway server.
//
// Evidence is journal event names and fields only: no code, no token.

/** From READY on any token to READY on a token paired from scratch through
 *  the web's approve route. revoke-4003 uses it too. */
export function pairFromScratch() {
  return [
    { send: 'T server pair manual', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'pair', outcome: 'manual' }), timeoutMs: 5000 },
    { send: 'T token backup', expect: /^ok (saved|kept|none)$/ },
    { send: 'T token forget', expect: /^ok$/ },
    { send: 'T bridge reset', expect: /^ok bridge$/ },
    // Boot Wi-Fi may take one failed round's 60 s backoff (boot-wifi.mjs).
    { waitBootWifi: true },
    { waitDevice: /INFO v2\.ws_mode .*auth=0/, timeoutMs: 15_000 },
    { waitServer: /"event":"v2\.pairing_required".*"reason":"none"/, timeoutMs: 60_000 },
    { waitDevice: /INFO v2\.pairing_required .*reason=none/, timeoutMs: 10_000 },
    { waitDevice: /INFO v2\.pair_code_received state=PAIR/, timeoutMs: 15_000 },
    { waitServer: /"event":"v2\.pair_issued"/, timeoutMs: 10_000 },
    { assertState: { state: 'PAIR' } },
    ...approvePairing(),
  ];
}

/** The device shows a pair code: approve it through the web route and see
 *  the device reconnect with its new token and reach READY. */
export function approvePairing() {
  return [
    { send: 'T server pair approve', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'pair', outcome: 'approved' }), timeoutMs: 15_000 },
    { waitServer: /"event":"v2\.pair_delivered"/, timeoutMs: 5000 },
    // Every wait matches from the last send, so these come before the next one.
    { waitDevice: /INFO v2\.device_token_saved /, timeoutMs: 15_000 },
    { waitDevice: /INFO v2\.ws_mode .*auth=2/, timeoutMs: 15_000 },
    { waitDevice: /INFO v2\.welcome_accepted /, timeoutMs: 30_000 },
    { waitServer: /"event":"v2\.welcome"/, timeoutMs: 30_000 },
    { assertState: { state: 'READY' }, timeoutMs: 15_000 },
    { send: 'T server pair auto', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'pair', outcome: 'auto' }), timeoutMs: 5000 },
  ];
}

/** Puts the backed-up token back and reboots onto it (the harness knows it
 *  already, or adopts it: server-harness.ts adoptDeviceToken). */
export function restoreOwnerToken() {
  return [
    { send: 'T token restore', expect: /^ok restored$/ },
    { send: 'T bridge reset', expect: /^ok bridge$/ },
    { waitBootWifi: true },
    { waitDevice: /INFO v2\.ws_mode .*auth=2/, timeoutMs: 60_000 },
    { waitDevice: /INFO v2\.welcome_accepted /, timeoutMs: 60_000 },
    { assertState: { state: 'READY' }, timeoutMs: 15_000 },
  ];
}

/** The `finally` of both scenarios: pair auto again (a failure before approval
 *  leaves it manual), then the owner's token back. */
export function ownerTokenBack() {
  return [
    { send: 'T server pair auto', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'pair', outcome: 'auto' }), timeoutMs: 5000 },
    ...restoreOwnerToken(),
  ];
}

export default {
  name: 'pair-from-scratch',
  issue: '#611',
  title: 'no token → pairing_required → code approved via the web route → paired → READY → one turn',
  expectsReconnect: true,
  requires: [{ event: 'pair_code_received', feature: 'pairing flow' }],
  steps: [...pairFromScratch(), ...pttTurn()],
  finally: ownerTokenBack(),
};
