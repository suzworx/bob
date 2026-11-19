// npm run demo:check: a 60-second go/no-go for the investor demo on the LOCAL stack.
// Usage: node scripts/demo-check.mjs [--api URL] [--web URL] [--root DEV_TREE] [--model ID]
// --root is the checkout that runs `npm run dev:offline` (its journal and device.log are read).
// Each check prints PASS/FAIL with a one-line fix; exit 1 on any FAIL. Tokens and keys are never printed;
// the one conversation it creates is deleted through the API.
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RSSI_FLOOR = -65;

export function parseArgs(argv) {
  const out = { api: 'http://localhost:7444', web: 'http://localhost:5173', root: REPO_ROOT, model: 'google/gemini-2.5-flash' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = { '--api': 'api', '--web': 'web', '--root': 'root', '--model': 'model' }[flag];
    if (!key) throw new Error(`unknown flag ${flag}`);
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`);
    out[key] = argv[i + 1]; i += 1;
  }
  return out;
}

export function readJsonLines(text) {
  const events = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith('{')) continue;
    try { events.push(JSON.parse(raw)); } catch { /* a torn last line */ }
  }
  return events;
}

/** The agent stage of one turn (web turn_id = the user message id), or null. */
export function turnOutcome(events, turnId) {
  const hit = events.findLast((e) => e.event === 'v2.turn_stage_agent_completed' && e.turn_id === turnId);
  return hit ? { outcome: hit.outcome, model: hit.model } : null;
}

/** The Cardputer is connected when the newest presence is online and its session has not closed since. */
export function deviceStatus(events) {
  const presence = events.findLast((e) => e.event === 'v2.device_presence');
  if (!presence) return { connected: false, reason: 'no device session in the journal' };
  if (presence.state !== 'online') return { connected: false, reason: `last seen ${presence.ts}, now offline`, session: presence.session };
  const closedAfter = events.some((e) => e.event === 'v2.closed' && e.session === presence.session && e.ts > presence.ts);
  return closedAfter ? { connected: false, reason: `session closed after ${presence.ts}`, session: presence.session }
    : { connected: true, session: presence.session, since: presence.ts };
}

export function lastRssi(text) {
  const all = [...text.matchAll(/rssi=(-?\d+)/g)];
  return all.length ? Number(all.at(-1)[1]) : null;
}

/** The reply text of a UI message stream, the conversation id, and whether an error part arrived. */
export function replyFromStream(stream) {
  let text = ''; let failed = false;
  for (const raw of stream.split(/\r?\n/)) {
    if (!raw.startsWith('data: {')) continue;
    try {
      const part = JSON.parse(raw.slice(6));
      if (part.type === 'text-delta') text += part.delta ?? '';
      if (part.type === 'error') failed = true;
    } catch { /* not a JSON part */ }
  }
  return { text, conversationId: stream.match(/"conversationId":"([^"]+)"/)?.[1] ?? null, failed };
}

export function report(results) {
  const lines = [];
  for (const r of results) {
    lines.push(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
    if (!r.ok && r.fix) lines.push(`      fix: ${r.fix}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  lines.push(failed ? `NO-GO: ${failed} of ${results.length} checks failed` : `GO: all ${results.length} checks passed`);
  return { lines, failed };
}

/** Runs every check with injected I/O; never throws. */
export async function runChecks({ opts, fetch, signIn, supabaseUp, readText, sleep }) {
  const results = [];
  const check = async (name, fix, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail }); return true; } catch (error) {
      results.push({ name, ok: false, detail: error.message, fix }); return false;
    }
  };
  const get = async (url, token, init = {}) => {
    const res = await fetch(url, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers } });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url.replace(opts.api, '')} answered ${res.status}`);
    return res;
  };
  const up = await check('API /health', 'start the stack: npm run dev:offline (with the demo env)', async () => { await get(`${opts.api}/health`); return opts.api; });
  await check('web app', 'the UI is not up; npm run dev:offline starts it on :5173', async () => { await get(`${opts.web}/`); return opts.web; });
  await check('local Supabase', 'start Docker Desktop, then npx supabase start', async () => { if (!supabaseUp()) throw new Error('npx supabase status failed'); return 'running'; });
  let token = null;
  await check('dev sign-in', 'npm run dev:offline creates dev@bob.local; is Supabase up?', async () => { token = await signIn(); return 'dev@bob.local'; });
  if (!up || !token) return results;
  const turnId = randomUUID(); let conversationId = null;
  await check('web chat turn (AI Gateway)', 'check AI_GATEWAY_API_KEY in the API env and the network; retry once', async () => {
    const res = await get(`${opts.api}/api/chat`, token, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'web_text', message: { id: turnId, role: 'user', parts: [{ type: 'text', text: 'What time is it in New York right now?' }] } }) });
    const reply = replyFromStream(await res.text());
    conversationId = reply.conversationId;
    if (reply.failed) throw new Error('the stream carried an error part');
    if (!reply.text.trim()) throw new Error('empty reply');
    return `"${reply.text.trim().slice(0, 60)}"`;
  });
  let events = [];
  for (let i = 0; i < 6; i += 1) {
    events = readJsonLines(readText('journal'));
    if (turnOutcome(events, turnId)) break;
    await sleep(500);
  }
  await check('chat model', `restart dev:offline with BOB_CHAT_MODEL=${opts.model} (and --root must be the dev tree)`, async () => {
    const turn = turnOutcome(events, turnId);
    const model = turn?.model ?? events.findLast((e) => e.event === 'v2.turn_stage_agent_completed')?.model;
    if (model !== opts.model) throw new Error(`journal model is ${model ?? 'unknown'}, want ${opts.model}`);
    if (turn && turn.outcome !== 'completed') throw new Error(`this turn's agent outcome was ${turn.outcome}`);
    return turn ? `${model}, this turn completed` : `${model} (latest turn; this turn not in the journal yet)`;
  });
  await check('timers API', 'see the API log (data/dev-api.log) for the error', async () => { await get(`${opts.api}/api/timers`, token); return '200'; });
  await check('reminders API', 'see the API log (data/dev-api.log) for the error', async () => {
    const { spaces } = await (await get(`${opts.api}/api/spaces`, token)).json();
    if (!spaces?.length) throw new Error('the dev user has no space');
    await get(`${opts.api}/api/spaces/${spaces[0].id}/reminders`, token);
    return '200';
  });
  await check('Cardputer connected', `power-cycle the Cardputer; keep it within ${RSSI_FLOOR} dBm of the access point`, async () => {
    const status = deviceStatus(events);
    if (!status.connected) throw new Error(status.reason);
    const rssi = lastRssi(readText('device'));
    const signal = rssi === null ? 'RSSI unknown (npm run device:monitor logs it)' : `RSSI ${rssi} dBm${rssi < RSSI_FLOOR ? ' (WEAK: move it closer)' : ''}`;
    return `online since ${status.since}, ${signal}`;
  });
  await check('cleanup', 'delete the "What time is it in New York" conversation in the web app', async () => {
    if (!conversationId) return 'nothing created';
    await get(`${opts.api}/api/conversations/${encodeURIComponent(conversationId)}`, token, { method: 'DELETE' });
    return 'test conversation deleted';
  });
  return results;
}

/** The newest ~4 MB of a file, or '' when it is missing. */
export function tailText(path, bytes = 4 * 1024 * 1024) {
  if (!existsSync(path)) return '';
  const size = statSync(path).size; const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length); const fd = openSync(path, 'r');
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  return buffer.toString('utf8');
}

async function realDeps(opts) {
  const { spawnSync } = await import('node:child_process');
  const { parseSupabaseEnv, isLoopbackUrl, readSignInCode } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'dev-offline.mjs')).href);
  let statusEnv;
  const supabaseEnv = () => {
    if (statusEnv !== undefined) return statusEnv;
    // One command string, so Windows' shell:true does not trip DEP0190.
    const status = spawnSync('npx supabase status -o env', { cwd: opts.root, encoding: 'utf8', shell: true, timeout: 30_000 });
    statusEnv = status.status === 0 ? parseSupabaseEnv(status.stdout) : null;
    return statusEnv;
  };
  // The devAccessToken pattern from apps/api/scripts/perf-baseline.mjs: LOCAL stack only, held in memory.
  const signIn = async () => {
    const env = supabaseEnv();
    if (!env) throw new Error('`npx supabase status` failed');
    if (!isLoopbackUrl(env.API_URL)) throw new Error('refusing: Supabase API is not on loopback');
    const email = 'dev@bob.local';
    const admin = { Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`, apikey: env.SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
    const link = await fetch(`${env.API_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: admin, body: JSON.stringify({ type: 'magiclink', email }) });
    if (!link.ok) throw new Error(`generate_link answered ${link.status}`);
    const code = readSignInCode(await link.json());
    if (!code) throw new Error('generate_link returned no code');
    const verify = await fetch(`${env.API_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: env.PUBLISHABLE_KEY ?? env.ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email', email, token: code }) });
    if (!verify.ok) throw new Error(`verify answered ${verify.status}`);
    const body = await verify.json();
    if (typeof body.access_token !== 'string') throw new Error('verify returned no access token');
    return body.access_token;
  };
  const files = { journal: join(opts.root, 'apps', 'api', 'data', 'v2-journal.log'), device: join(opts.root, 'data', 'device.log') };
  return { opts, signIn, supabaseUp: () => Boolean(supabaseEnv()), readText: (name) => tailText(files[name]),
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(45_000) }), sleep: (ms) => new Promise((done) => setTimeout(done, ms)) };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  console.log(`demo:check api=${opts.api} web=${opts.web} root=${opts.root}`);
  const { lines, failed } = report(await runChecks(await realDeps(opts)));
  for (const text of lines) console.log(text);
  console.log(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);
  process.exitCode = failed ? 1 : 0;
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) main().catch((error) => { console.error(`demo:check: ${error.message}`); process.exitCode = 1; });
