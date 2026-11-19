import { journalMatch } from '../journal-match.mjs';
import { approvePairing, ownerTokenBack, pairFromScratch } from './pair-from-scratch.mjs';
import { pttTurn } from './steps.mjs';

// Epic #611: an owner renames the device and then removes it on the web. The
// device first pairs from scratch (pair-from-scratch's steps), so the token
// revoked here is one only this HIL server issued, never the owner's. The
// harness renames it through PATCH /api/devices/:id and revokes it through
// DELETE /api/devices/:id, the web's own routes, which close its socket with
// 4003 (deviceSessions.closeDevice).
//
// No journal line carries the 4003 the server sent. v2.closed's `code` is the
// one in the close frame the PEER sent back (the `ws` close event), and the
// ESP32 WebSocket library echoes 1000 (run 20260929-110910-342e:
// v2.device_revoked, then v2.closed code=1000); the device's own close line
// has no code either (socket_closed clean=1). So the scenario asserts what
// the revoke does, not the code: the device drops the socket cleanly,
// reconnects once with the revoked token, is answered pairing_required
// (revoked), erases the token and shows a pair code, and then stays there,
// not looping through reconnects. The harness approves the new code as the
// web would, and one turn proves the new pairing. In `finally` the owner's
// token goes back, even when a step failed, so the scenarios after this one
// still run.
export default {
  name: 'revoke-4003',
  issue: '#611',
  title: 'rename then revoke via the web routes → socket closed → pairing_required(revoked) → token erased → pairing, no loop → re-paired',
  expectsReconnect: true,
  requires: [{ event: 'device_token_erased', feature: 'token erase on revoke' }],
  steps: [
    ...pairFromScratch(),
    { send: 'T server device rename', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'device', outcome: 'renamed' }), timeoutMs: 10_000 },
    // The re-pairing below is approved by hand, like the first one.
    { send: 'T server pair manual', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'pair', outcome: 'manual' }), timeoutMs: 5000 },
    { send: 'T server device revoke', expect: /^ok server$/ },
    { waitServer: journalMatch({ event: 'v2.hil_command', command: 'device', outcome: 'revoked' }), timeoutMs: 10_000 },
    { waitServer: /"event":"v2\.device_revoked"/, timeoutMs: 10_000 },
    { waitServer: /"event":"v2\.closed"/, timeoutMs: 10_000 },
    { waitDevice: /INFO v2\.socket_closed state=SOCKET clean=1,retry_ms=\d+/, timeoutMs: 10_000 },
    { waitDevice: /INFO v2\.ws_mode .*auth=2/, timeoutMs: 15_000 },  // the one reconnect, still on the revoked token.
    { waitServer: /"event":"v2\.pairing_required".*"reason":"revoked"/, timeoutMs: 30_000 },
    { waitDevice: /INFO v2\.device_token_erased .*reason=revoked/, timeoutMs: 30_000 },
    { waitDevice: /INFO v2\.pairing_required .*reason=revoked/, timeoutMs: 5000 },
    { waitDevice: /INFO v2\.pair_code_received state=PAIR/, timeoutMs: 15_000 },
    // No loop: from here the device sits on its pair code. The send marks the
    // point the quiet window starts from.
    { send: 'T state', expect: /^state=PAIR / },
    { noDevice: /INFO v2\.(socket_closed|socket_connect|socket_retry|pairing_required|pairing_started) /, timeoutMs: 10_000 },
    // An obsolete pre-revoke connection can finish closing after the new
    // unpaired socket is stable. Keep the close assertion on that new socket;
    // any additional pairing_required or device reconnect still fails.
    { noServer: /"event":"v2\.closed"/, sessionFrom: /"event":"v2\.pairing_required".*"reason":"revoked"/, timeoutMs: 1000 },
    { noServer: /"event":"v2\.pairing_required"/, timeoutMs: 1000 },
    ...approvePairing(),
    ...pttTurn(),
  ],
  finally: ownerTokenBack(),
};
