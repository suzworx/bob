// wifi_join.h: 15s attempts, two 400ms-settled auth retries, scans bounded by
// (6s+4s grace)*2. Allow one failed round's 60s backoff, never its 120s successor.
// Authentication and welcome remain separate assertions after network readiness.
const INITIAL_MS = 120000;
const SCAN_MS = 20000;
const RETRY_MS = 60000;
const JOIN_MS = 45800;
const SLACK_MS = 5000;
// The manager schedules from loop time; the journal timestamp follows that work.
const JOURNAL_SLOP_MS = 100;
const RECOVERY_MS = RETRY_MS + SCAN_MS + JOIN_MS + SLACK_MS;
const EVENTS = /^\d+ INFO v2\.(boot|wifi_join_failed|wifi_all_failed|wifi_scan|wifi_try|wifi_connected) /;

function failedRound(state, line, at) {
  if (state.backoffAt !== null) throw new Error('second failed Wi-Fi round');
  if (state.failures === 0) throw new Error('missing join failure before Wi-Fi backoff');
  if (!/\bnext_retry_ms=60000\b/.test(line)) throw new Error('expected60000ms first Wi-Fi backoff');
  state.backoffAt = at;
  state.deadline = Date.now() + RECOVERY_MS;
}

function retryScan(state, line, at) {
  if (state.backoffAt === null || !/\bfound=\d+\b/.test(line)) return;
  const elapsed = at - state.backoffAt;
  const duration = /\bms=(\d+)\b/.exec(line);
  if (!duration) throw new Error('Wi-Fi retry scan missing duration');
  if (elapsed - Number(duration[1]) + JOURNAL_SLOP_MS < RETRY_MS) throw new Error('Wi-Fi retry scan started before backoff elapsed');
  if (elapsed > RETRY_MS + SCAN_MS + SLACK_MS) throw new Error('Wi-Fi retry scan exceeded policy bound');
  state.retryScanned = true;
}

function observe(state, line) {
  const [, millis, name] = /^(\d+) INFO v2\.(\w+) /.exec(line);
  const at = Number(millis);
  if (name === 'boot') {
    if (state.bootAt !== null) throw new Error('unexpected reboot during Wi-Fi recovery');
    state.bootAt = at;
    return false;
  }
  if (state.bootAt === null) throw new Error('Wi-Fi recovery missing boot evidence');
  if (state.backoffAt === null && at - state.bootAt > INITIAL_MS) throw new Error('initial Wi-Fi deadline exceeded');
  if (state.backoffAt !== null && at - state.backoffAt > RECOVERY_MS) throw new Error('Wi-Fi recovery round deadline exceeded');
  if (name === 'wifi_join_failed') state.failures++;
  if (name === 'wifi_all_failed') failedRound(state, line, at);
  if (name === 'wifi_scan') retryScan(state, line, at);
  if (name !== 'wifi_connected') return false;
  if (state.backoffAt !== null && !state.retryScanned) throw new Error('Wi-Fi connected without retry scan evidence');
  return true;
}

/** One boot's network readiness, with exactly one policy-bounded recovery round. */
export async function waitForBootWifi(device, from, evidence) {
  const state = {bootAt:null,backoffAt:null,failures:0,retryScanned:false,deadline:Date.now()+INITIAL_MS};
  // Startup calls WiFi.begin before journaling boot. Those early wifi_try lines
  // are legitimate; locate this reset's first boot with its own finite bound.
  const boot = await device.waitFor(/^\d+ INFO v2\.boot /, from, 15000);
  if (boot === null) throw new Error('missing boot evidence within15000ms');
  observe(state, boot);
  evidence.push(`device: ${boot}`);
  let cursor = device.lines.indexOf(boot, from) + 1;
  for (;;) {
    const remaining = state.deadline - Date.now();
    const line = remaining > 0 ? await device.waitFor(EVENTS, cursor, remaining) : null;
    if (line === null) throw new Error(state.backoffAt === null ? 'initial Wi-Fi deadline exceeded' : 'Wi-Fi recovery round deadline exceeded');
    cursor = device.lines.indexOf(line, cursor) + 1;
    evidence.push(`device: ${line}`);
    if (observe(state, line)) return;
  }
}
