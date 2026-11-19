import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

import { formatFindings, scanJournalFile } from './hil/journal-privacy.mjs';

/*
 * validate-non-device.mjs — autonomous validation for everything that does
 * not require Cardputer firmware/hardware, a phone, a trusted microphone, or a
 * fresh human contributor.
 *
 * It runs the normal non-firmware gate, verifies V12 by injecting and removing
 * a temporary failing UI test, exercises the browser HTTP routes in
 * BOB_SYSTEM_TEST mode, checks the public-bind guard contract, scans journal
 * privacy, and confirms no user-visible fabricated strings remain in app code.
 *
 * Pass --live-only to skip the three full gate runs while iterating on the
 * live checks.
 */

const ROOT = resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';
const TEMP_UI_TEST = resolve(ROOT, 'apps/ui-v2/src/non-device-validation-fail.test.tsx');
const JOURNAL = resolve(ROOT, 'data/non-device-validation-journal.log');

const failures = [];

function run(label, command, args, options = {}) {
  process.stdout.write(`\n==> ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    shell,
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...options.env },
  });
  if (options.capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  const ok = options.expectFailure ? result.status !== 0 : result.status === 0;
  if (!ok) failures.push(label);
  return result;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolvePort(address.port);
        else reject(new Error('Could not allocate a free TCP port'));
      });
    });
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError ?? new Error(`Timed out waiting for health on ${port}`);
}

async function withServer(label, env, fn) {
  const port = env.BOB_V2_PORT ?? String(await freePort());
  const child = spawn(npm, ['run', 'start'], {
    cwd: ROOT,
    detached: process.platform !== 'win32',
    shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env, BOB_V2_PORT: port },
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  try {
    await waitForHealth(port);
    return await fn(Number(port), () => output.join(''));
  } catch (error) {
    failures.push(label);
    console.error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    const text = output.join('');
    if (text) console.error(text);
  } finally {
    if (process.platform === 'win32' || child.pid === undefined) {
      child.kill('SIGTERM');
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
    await delay(250);
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }
}

async function readText(response) {
  return await response.text();
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function assertIncludes(label, value, expected) {
  if (!value.includes(expected)) throw new Error(`${label}: expected output to include ${expected}`);
}

/*
 * Record a failed check and keep going. A throwing assertion aborts the whole
 * withServer body, so the first failure hides every check after it — which is
 * exactly how this harness stopped exercising V8: once feature 008 replaced the
 * shared browser token with the Supabase JWT guard, the "chat right token"
 * assertion started failing and the oversized-recording check below it silently
 * stopped running. Collect instead, so one regression reports one failure.
 */
let checksPassed = 0;
function check(label, fn) {
  try {
    fn();
    checksPassed += 1;
    return true;
  } catch (error) {
    failures.push(label);
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/*
 * Mint a browser bearer the way the app does (contracts/web-auth.md): the
 * loopback-only POST /api/test-token under BOB_SYSTEM_TEST=1 issues a JWT the
 * ordinary /api/* guard verifies. There is no shared-secret bearer any more.
 */
async function mintWebToken(base) {
  const response = await fetch(`${base}/api/test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: crypto.randomUUID() }),
  });
  if (!response.ok) throw new Error(`test-token ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error('test-token returned no token');
  }
  return body.token;
}

/* True when the /v2/cardputer upgrade is accepted — FR-029: a browser-side
 * setting must never take the device path down with it. */
async function deviceSocketOpens(port) {
  return await new Promise((settle) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v2/cardputer`);
    const finish = (ok) => {
      clearTimeout(timer);
      // terminate(), not close(): a close handshake the server never answers
      // leaves a handle open and the gate never exits.
      try { socket.terminate(); } catch {}
      settle(ok);
    };
    const timer = setTimeout(() => finish(false), 5_000);
    socket.on('open', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

/*
 * --live-only skips the three full gate runs (the plain gate plus V12's
 * red/green pair, ~8 minutes) and goes straight to the live HTTP and journal
 * checks. For iterating on those; a release claim still needs the whole run.
 */
const liveOnly = process.argv.includes('--live-only');
if (liveOnly) console.log('--live-only: skipping the gate runs and V2/V12.');

if (!liveOnly) {
  run('validate gate without firmware', npm, ['run', 'validate', '--', '--skip-firmware']);

  process.stdout.write('\n==> V2 fabrication string scan\n');
  const grep = spawnSync('rg', [
    '-i',
    'simulated|mock|prototype|fixture',
    'apps/ui-v2/src',
    '-g',
    '*.ts',
    '-g',
    '*.tsx',
    '-g',
    '!*.test.ts',
    '-g',
    '!*.test.tsx',
    '-g',
    '!test-setup.ts',
  ], { cwd: ROOT, encoding: 'utf8' });
  if (grep.status === 0) {
    failures.push('V2 fabrication string scan');
    process.stdout.write(grep.stdout);
  } else {
    console.log('No user-visible fabrication strings found in app code.');
  }

  process.stdout.write('\n==> V12 UI gate red/green\n');
  try {
    writeFileSync(
      TEMP_UI_TEST,
      "import { expect, it } from 'vitest';\n\nit('temporary non-device validation failure', () => {\n  expect(true).toBe(false);\n});\n",
    );
    const red = run('V12 deliberately broken UI test', npm, ['run', 'validate', '--', '--skip-firmware'], { capture: true, expectFailure: true });
    const combined = `${red.stdout ?? ''}\n${red.stderr ?? ''}`;
    if (!combined.includes('unit tests (ui-v2)') || !combined.includes('==== validate: FAIL')) {
      failures.push('V12 failure attribution');
      console.error('V12 failure did not clearly name unit tests (ui-v2).');
    }
  } finally {
    rmSync(TEMP_UI_TEST, { force: true });
  }
  run('V12 restored validation gate', npm, ['run', 'validate', '--', '--skip-firmware']);
}

mkdirSync(dirname(JOURNAL), { recursive: true });
rmSync(JOURNAL, { force: true });

await withServer('live API checks', {
  BOB_SYSTEM_TEST: '1',
  BOB_V2_HOST: '127.0.0.1',
  BOB_V2_JOURNAL: JOURNAL,
}, async (port) => {
  process.stdout.write('\n==> V8/V9 live HTTP checks\n');
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'content-type': 'application/json' };
  const token = await mintWebToken(base);
  const authHeaders = { ...headers, authorization: `Bearer ${token}` };
  // POST /api/chat takes the newest user message, not a history array — the
  // 006 redesign moved history server-side (web-schemas.ts webChatRequestSchema).
  const chatBody = JSON.stringify({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } });

  let response = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: chatBody });
  check('chat missing token', () => assertEqual('chat missing token', response.status, 401));
  response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body: chatBody });
  check('chat wrong token', () => assertEqual('chat wrong token', response.status, 401));
  response = await fetch(`${base}/api/chat`, { method: 'POST', headers: authHeaders, body: chatBody });
  check('chat right token', () => assertEqual('chat right token', response.status, 200));
  const chatStream = await readText(response);
  check('chat stream', () => assertIncludes('chat stream', chatStream, 'System test response'));
  response = await fetch(`${base}/api/chat`, { method: 'POST', headers: authHeaders, body: '{not json' });
  check('chat malformed json', () => assertEqual('chat malformed json', response.status, 400));
  const malformed = await readText(response);
  check('chat malformed json body', () => assertIncludes('chat malformed json body', malformed, 'invalid_json'));
  response = await fetch(`${base}/api/voice`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ audio: 'abcd', format: 'not-a-format' }) });
  check('voice unsupported format', () => assertEqual('voice unsupported format', response.status, 400));
  response = await fetch(`${base}/api/voice`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ audio: 'not-base64', format: 'webm' }) });
  check('voice invalid base64', () => assertEqual('voice invalid base64', response.status, 400));
  response = await fetch(`${base}/api/voice`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ audio: 'A'.repeat(2_796_208), format: 'webm' }) });
  check('voice oversized (V8)', () => assertEqual('voice oversized (V8)', response.status, 413));
  response = await fetch(`${base}/api/voice`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ audio: 'AAAA', format: 'webm' }) });
  check('voice system-test transcript', () => assertEqual('voice system-test transcript', response.status, 200));
  const transcript = await readText(response);
  check('voice system-test transcript body', () => assertIncludes('voice system-test transcript body', transcript, 'system test transcript'));
  response = await fetch(`${base}/api/speech`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ text: 'hello from validation' }) });
  check('speech system-test', () => assertEqual('speech system-test', response.status, 200));
  const speechType = response.headers.get('content-type') ?? '';
  check('speech content type', () => assertIncludes('speech content type', speechType, 'audio/mpeg'));
  console.log(`Live HTTP checks done (${checksPassed} passed).`);
});

/*
 * V9, second half. The original scenario asked that clearing BOB_WEB_TOKEN on
 * a non-loopback bind UNMOUNT /api/* (404). Feature 008 deliberately removed
 * that rule: the JWT guard is always mounted (server.ts, web-auth.md
 * "Production gate matrix" last row), so an unauthenticated call is 401, never
 * 404. What the scenario was actually protecting still holds and is what we
 * assert now — the dev token path is never reachable off loopback, the
 * unauthenticated surface is exactly /health and /api/public-config, and the
 * device path is untouched by any of it (FR-029).
 */
await withServer('public-bind guard contract', {
  BOB_SYSTEM_TEST: '1',
  BOB_V2_HOST: '0.0.0.0',
  BOB_V2_JOURNAL: JOURNAL,
}, async (port) => {
  process.stdout.write('\n==> V9 public-bind guard contract\n');
  const base = `http://127.0.0.1:${port}`;
  let response = await fetch(`${base}/health`);
  check('health is unauthenticated', () => assertEqual('health is unauthenticated', response.status, 200));
  response = await fetch(`${base}/api/public-config`);
  check('public-config is unauthenticated', () => assertEqual('public-config is unauthenticated', response.status, 200));
  response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('guarded api route answers 401', () => assertEqual('guarded api route answers 401', response.status, 401));
  response = await fetch(`${base}/api/test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: crypto.randomUUID() }),
  });
  check('test-token is 404 off loopback', () => assertEqual('test-token is 404 off loopback', response.status, 404));
  const deviceOk = await deviceSocketOpens(port);
  check('device socket still accepted', () => assertEqual('device socket still accepted', deviceOk, true));
  console.log(`Public-bind guard contract done (${checksPassed} passed in total).`);
});

process.stdout.write('\n==> V11 journal privacy scan\n');
// The rules live in scripts/hil/journal-privacy.mjs, shared with the HIL runner.
const privacy = scanJournalFile(JOURNAL);
if (privacy.length > 0) {
  failures.push('V11 journal privacy scan');
  console.log(formatFindings(privacy));
} else {
  console.log('Journal privacy scan found no payload/token terms.');
}

if (failures.length > 0) {
  console.error(`\n==== validate: FAIL non-device autonomous (${failures.length} failure(s)) ====`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`\n==== validate: PASS non-device autonomous (${checksPassed} live checks) ====`);
// Exit explicitly. The failure path already did, so nobody noticed that the
// success path fell off the end and hung on a lingering socket/child handle.
process.exit(0);
