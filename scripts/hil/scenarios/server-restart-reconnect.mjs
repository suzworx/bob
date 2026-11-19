import { pttTurn } from './steps.mjs';

// Epic #611: the server goes away under a READY device and comes back. The
// rig kills the server harness by its PID (`T rig server-restart`, rig.mjs
// restartServer; never by name) and starts it again on the same port,
// database and journal file, answering once /health does. The device must
// notice the dropped socket, back off and retry on its own (no console
// command touches it), re-hello with the token it has, be welcomed by the new
// process's session and complete a push-to-talk turn on it.
//
// Every wait below matches from the restart command on, so the server's
// hello/welcome lines can only come from the new process.
export default {
  name: 'server-restart-reconnect',
  issue: '#611',
  title: 'server killed and restarted → device backs off, re-hellos on its own → turn',
  expectsReconnect: true,
  steps: [
    { assertState: { state: 'READY' } },
    { send: 'T rig server-restart', expect: /^ok rig$/, timeoutMs: 120_000 },
    // The drop, with the delay before the next attempt (network.cpp backoff).
    { waitDevice: /INFO v2\.socket_closed state=SOCKET clean=[01],retry_ms=\d+/, timeoutMs: 30_000 },
    { waitDevice: /INFO v2\.socket_connect /, timeoutMs: 60_000 },
    { waitDevice: /INFO v2\.socket_connected /, timeoutMs: 90_000 },
    { waitDevice: /INFO v2\.hello_sent /, timeoutMs: 90_000 },
    { waitServer: /"event":"v2\.hello"/, timeoutMs: 90_000 },
    { waitServer: /"event":"v2\.welcome"/, timeoutMs: 90_000 },
    // MP3 (format_id 2), the product default: run 20260929-110910-342e ran
    // this in PCM because pcm-reply left its forced hello behind (it now puts
    // MP3 back in `finally`), and the silent PCM reply failed the turn.
    { waitDevice: /INFO v2\.welcome_accepted .*format=2/, timeoutMs: 90_000 },
    // Its token was known to the database before the restart: no re-pairing.
    { noDevice: /INFO v2\.pairing_required /, timeoutMs: 2000 },
    { assertState: { state: 'READY' }, timeoutMs: 15_000 },
    ...pttTurn(),
  ],
};
