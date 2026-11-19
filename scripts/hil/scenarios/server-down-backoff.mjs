import { pttTurn } from './steps.mjs';

// #709: with the server down, the device retries on its back-off (2, 4, 8, 16,
// then every 30 s), one socket_connect per step, never every second. The rig
// kills the server harness by its PID (`T rig server-stop`, rig.mjs stopServer;
// never by name) and keeps it down for ~70 s, then starts it again on the same
// port, database and journal (`T rig server-start`). The device must
// reconnect on its own, be welcomed with the token it has, and run a turn.

/** How much earlier than retry_ms a socket_connect may come (tick jitter). */
export const RETRY_TOLERANCE_MS = 500;
/** After the second failure, socket_connect lines are at least this far apart. */
export const MIN_CONNECT_GAP_MS = 1500;
const MAX_RETRY_MS = 30_000;  // config::kSocketReconnectMaxMs
const CONNECT = /^(\d+) INFO v2\.socket_connect /;
const CLOSED = /^(\d+) INFO v2\.socket_closed .*clean=([01]),retry_ms=(\d+)/;

/**
 * The engine takes a RegExp (schema.mjs); this one reads every device line of
 * a noDevice window, with the device's millis, and "matches" the first
 * socket_connect or socket_closed that breaks the back-off: a connect sooner
 * than retry_ms after a failed close, a second connect for one close, two
 * connects under MIN_CONNECT_GAP_MS apart after the second failure, or a
 * failed close whose retry_ms is not the previous one doubled (clamped).
 * `problems` says why; the step fails on that line.
 */
export class BackoffViolation extends RegExp {
  constructor() {
    super(String.raw`v2\.socket_(connect|closed) off the back-off`);
    this.reset();
  }

  reset() {
    Object.assign(this, { lastAt: -1, close: null, failures: 0, connectsSinceClose: 0, lastConnectAt: null, problems: [] });
  }

  test(line) {
    const at = Number(/^(\d+) /.exec(line)?.[1]);
    if (!Number.isFinite(at)) return false;
    if (at < this.lastAt) this.reset();  // the device rebooted: a new timeline.
    this.lastAt = at;
    const closed = CLOSED.exec(line);
    const problem = closed ? this.onClose(at, closed[2] === '1', Number(closed[3])) : CONNECT.test(line) ? this.onConnect(at) : null;
    if (problem) this.problems.push(`${problem} (device ${at} ms)`);
    return Boolean(problem);
  }

  onClose(at, clean, retryMs) {
    const previous = this.close;
    this.close = { at, clean, retryMs };
    this.connectsSinceClose = 0;
    if (clean) return null;
    this.failures += 1;
    const want = previous ? Math.min(previous.retryMs * 2, MAX_RETRY_MS) : null;
    return want !== null && retryMs !== want ? `retry_ms=${retryMs} after retry_ms=${previous.retryMs}, expected ${want}` : null;
  }

  onConnect(at) {
    const { close } = this;
    let problem = null;
    if (close && this.connectsSinceClose > 0) problem = `a second socket_connect after the close at ${close.at} ms`;
    else if (close && !close.clean && at - close.at < close.retryMs - RETRY_TOLERANCE_MS) problem = `socket_connect ${at - close.at} ms after a close with retry_ms=${close.retryMs}`;
    else if (this.failures >= 2 && this.lastConnectAt !== null && at - this.lastConnectAt < MIN_CONNECT_GAP_MS) problem = `socket_connect ${at - this.lastConnectAt} ms after the previous one`;
    this.connectsSinceClose += 1;
    this.lastConnectAt = at;
    return problem;
  }
}

const failedClose = (retryMs) => ({
  waitDevice: new RegExp(String.raw`INFO v2\.socket_closed state=\w+ clean=0,retry_ms=${retryMs}\b`), timeoutMs: 1000,
});

export default {
  name: 'server-down-backoff',
  issue: '#709',
  title: 'server down ~70 s → device retries at 2, 4, 8, 16 s, never every second → server back → welcome → turn',
  expectsReconnect: true,
  steps: [
    { assertState: { state: 'READY' } },
    { send: 'T rig server-stop', expect: /^ok rig$/, timeoutMs: 60_000 },
    // ~70 s down: 2+4+8+16 s of back-off plus attempts (each up to ~5 s when
    // the connect times out rather than being refused).
    { noDevice: new BackoffViolation(), timeoutMs: 70_000 },
    // The ladder, from the lines already seen since server-stop.
    failedClose(2000), failedClose(4000), failedClose(8000), failedClose(16000),
    { send: 'T rig server-start', expect: /^ok rig$/, timeoutMs: 120_000 },
    // The next attempt is at most 30 s away, plus a connect.
    { waitDevice: /INFO v2\.socket_connected /, timeoutMs: 40_000 },
    { waitServer: /"event":"v2\.welcome"/, timeoutMs: 40_000 },
    { waitDevice: /INFO v2\.welcome_accepted /, timeoutMs: 40_000 },
    // Its token was known to the database before the stop: no re-pairing.
    { noDevice: /INFO v2\.pairing_required /, timeoutMs: 2000 },
    { assertState: { state: 'READY' }, timeoutMs: 15_000 },
    ...pttTurn(),
  ],
  // A failed step must not leave every later scenario without a server.
  finally: [{ send: 'T rig server-start', expect: /^ok rig$/, timeoutMs: 120_000 }],
};
