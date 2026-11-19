// #398 (PERF-S03): drives the fixed #394 baseline script against a local server.
// Usage (from the repo root):
//   node apps/api/scripts/perf-baseline.mjs --make-clips            # real Gateway TTS, writes git-ignored WAVs
//   node apps/api/scripts/perf-baseline.mjs --surface voice --runs 3 [--stub] [--gap-ms 20000]
//   node apps/api/scripts/perf-baseline.mjs --surface web --runs 3
// Auth, never printed: BOB_DEVICE_TOKEN (a paired olxd_ token) or, to pair a
// fresh device, BOB_SESSION_TOKEN (the dev user's Supabase access token);
// --dev-sign-in mints that access token for dev@bob.local from the LOCAL
// Supabase stack. --stub sends synthetic PCM instead of clips (for a server
// started with BOB_AI_STUB, whose STT ignores the audio). The driven turn ids
// are printed as `turn_id <surface> <run> <line> <id>`; nothing else is logged.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const SCRIPT_PATH = join(REPO_ROOT, 'docs', 'perf', '394', 'baseline', 'script.json');
export const CLIPS_DIR = join(REPO_ROOT, 'data', 'perf-baseline', 'clips');

export const V = 1;
export const FORMAT_PCM16 = 1;
export const FORMAT_MP3 = 2;
export const HEADER_BYTES = 20;
export const SAMPLE_RATE = 16_000;
export const FRAME_BYTES = 320; // 10 ms of 16 kHz mono PCM16
export const FRAME_MS = 10;
export const CATEGORY_MIX = { chit_chat: 12, tool: 5, follow_up: 3 };
export const TOOL_TURNS = ['timer', 'task', 'agenda', 'memory_remember', 'memory_forget'];

/** Parses CLI flags; unknown flags throw so a typo never runs a silent default. */
export function parseArgs(argv) {
  const out = { surface: null, runs: 1, stub: false, makeClips: false, devSignIn: false, gapMs: 20_000,
    host: 'localhost', port: 7444, turnTimeoutMs: 120_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => { const v = argv[i + 1]; if (v === undefined) throw new Error(`${flag} needs a value`); i += 1; return v; };
    if (flag === '--surface') out.surface = value();
    else if (flag === '--runs') out.runs = Number(value());
    else if (flag === '--gap-ms') out.gapMs = Number(value());
    else if (flag === '--host') out.host = value();
    else if (flag === '--port') out.port = Number(value());
    else if (flag === '--turn-timeout-ms') out.turnTimeoutMs = Number(value());
    else if (flag === '--stub') out.stub = true;
    else if (flag === '--make-clips') out.makeClips = true;
    else if (flag === '--dev-sign-in') out.devSignIn = true;
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!out.makeClips && out.surface !== 'voice' && out.surface !== 'web') throw new Error('--surface voice|web or --make-clips is required');
  for (const key of ['runs', 'gapMs', 'port', 'turnTimeoutMs']) {
    if (!Number.isInteger(out[key]) || out[key] < 0) throw new Error(`bad ${key}`);
  }
  if (out.runs < 1) throw new Error('--runs must be >= 1');
  return out;
}

/** Validates the script: 20 numbered lines, the 12/5/3 mix, one line per tool, follow-ups point back. */
export function validateScript(script) {
  const errors = [];
  const lines = Array.isArray(script?.lines) ? script.lines : [];
  if (lines.length !== 20) errors.push(`expected 20 lines, got ${lines.length}`);
  const counts = { chit_chat: 0, tool: 0, follow_up: 0 };
  lines.forEach((line, index) => {
    if (line.n !== index + 1) errors.push(`line ${index + 1}: n is ${line.n}`);
    if (typeof line.text !== 'string' || line.text.trim().length === 0 || line.text.length > 200) errors.push(`line ${index + 1}: bad text`);
    if (!(line.category in counts)) { errors.push(`line ${index + 1}: bad category ${line.category}`); return; }
    counts[line.category] += 1;
    if (line.category === 'follow_up' && !(Number.isInteger(line.refers_to) && line.refers_to < line.n)) errors.push(`line ${line.n}: refers_to must name an earlier line`);
  });
  for (const [category, want] of Object.entries(CATEGORY_MIX)) {
    if (counts[category] !== want) errors.push(`${category}: expected ${want}, got ${counts[category]}`);
  }
  const tools = lines.filter((line) => line.category === 'tool').map((line) => line.tool).sort();
  if (JSON.stringify(tools) !== JSON.stringify([...TOOL_TURNS].sort())) errors.push(`tool lines must be ${TOOL_TURNS.join(', ')}`);
  return errors;
}

export function loadScript(path = SCRIPT_PATH) {
  const script = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateScript(script);
  if (errors.length > 0) throw new Error(`script.json invalid: ${errors.join('; ')}`);
  return script;
}

/** One OLX2 audio_up frame: 20-byte big-endian header + PCM16 payload (schemas.ts parseAudioUp). */
export function buildAudioFrame(payload, sequence, turnHandle = 0) {
  const frame = Buffer.alloc(HEADER_BYTES + payload.length);
  frame.write('OLX2', 0, 'ascii');
  frame.writeUInt8(V, 4);
  frame.writeUInt8(1, 5); // kind audio_up
  frame.writeUInt8(FORMAT_PCM16, 6);
  frame.writeUInt8(1, 7); // channels
  frame.writeUInt32BE(turnHandle, 8);
  frame.writeUInt32BE(sequence, 12);
  frame.writeUInt32BE(payload.length, 16);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

/** Splits PCM into 10 ms frames (the last one may be shorter, never empty). */
export function pcmFrames(pcm) {
  const frames = [];
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) frames.push(pcm.subarray(offset, Math.min(pcm.length, offset + FRAME_BYTES)));
  return frames;
}

/** An opaque id matching the wire's /^[A-Za-z0-9_-]{8,64}$/. */
export function opaqueId(prefix) {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function control(type, extra = {}) {
  return JSON.stringify({ v: V, type, id: opaqueId(type.slice(0, 6)), payload: {}, ...extra });
}

/** Synthetic speech-length PCM for --stub: a quiet 220 Hz tone, ~65 ms per character, 1-6 s. */
export function synthPcm(text) {
  const ms = Math.max(1000, Math.min(6000, text.length * 65));
  const samples = Math.round((SAMPLE_RATE * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE)), i * 2);
  return pcm;
}

/** 16-bit mono WAV around raw PCM. */
export function encodeWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** The PCM of a 16 kHz mono PCM16 WAV; anything else throws. */
export function decodeWav(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let offset = 12; let format = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4); const size = wav.readUInt32LE(offset + 4); const body = offset + 8;
    if (id === 'fmt ') format = { channels: wav.readUInt16LE(body + 2), rate: wav.readUInt32LE(body + 4), bits: wav.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!format || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) throw new Error('clip must be 16 kHz mono PCM16');
      return wav.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

/** Linear-interpolation resample of mono PCM16 (OpenAI `pcm` is 24 kHz). */
export function resamplePcm16(pcm, fromRate, toRate = SAMPLE_RATE) {
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.floor((inSamples * toRate) / fromRate);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i += 1) {
    const pos = (i * fromRate) / toRate; const left = Math.floor(pos); const right = Math.min(inSamples - 1, left + 1); const t = pos - left;
    out.writeInt16LE(Math.round(pcm.readInt16LE(left * 2) * (1 - t) + pcm.readInt16LE(right * 2) * t), i * 2);
  }
  return out;
}

export function clipPath(line) {
  return join(CLIPS_DIR, `line-${String(line.n).padStart(2, '0')}.wav`);
}

/** --make-clips: each line once through the product's TTS model (Gateway), to git-ignored WAVs. */
async function makeClips(script) {
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY is not set');
  // #1041: never on the production key's budget. Node strips the guard's types;
  // a Node too old to do that fails here, before any spend.
  (await import('@bob/ai/key-guard')).refuseProductionKey();
  const { generateSpeech } = await import('ai');
  mkdirSync(CLIPS_DIR, { recursive: true });
  for (const line of script.lines) {
    const result = await generateSpeech({
      model: process.env.BOB_TTS_MODEL ?? 'microsoft/mai-voice-2.1-flash',
      text: line.text,
      voice: process.env.BOB_TTS_VOICE ?? 'en-US-Harper',
      outputFormat: 'pcm',
      maxRetries: 1,
    });
    const pcm = resamplePcm16(Buffer.from(result.audio.uint8Array), 24_000);
    writeFileSync(clipPath(line), encodeWav(pcm));
    console.log(`clip ${line.n}: ${Math.round(pcm.length / 32)} ms`);
  }
}

/** The uplink PCM for a line: synthetic under --stub, else the recorded clip. */
export function linePcm(line, stub) {
  if (stub) return synthPcm(line.text);
  const path = clipPath(line);
  if (!existsSync(path)) throw new Error(`missing clip ${path}; run --make-clips first (or --stub)`);
  return decodeWav(readFileSync(path));
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** --dev-sign-in: an access token for the dev user from the LOCAL stack only; held in memory, never printed. */
async function devAccessToken() {
  const { spawnSync } = await import('node:child_process');
  const { parseSupabaseEnv, isLoopbackUrl, readSignInCode } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'dev-offline.mjs')).href);
  const status = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['supabase', 'status', '-o', 'env'],
    { cwd: REPO_ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  if (status.status !== 0) throw new Error('`npx supabase status -o env` failed; is the local stack up?');
  const env = parseSupabaseEnv(status.stdout);
  if (!isLoopbackUrl(env.API_URL)) throw new Error('refusing: Supabase API is not on loopback');
  const email = process.env.BOB_DEV_EMAIL ?? 'dev@bob.local';
  const admin = { Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`, apikey: env.SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  const link = await fetch(`${env.API_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: admin, body: JSON.stringify({ type: 'magiclink', email }) });
  if (!link.ok) throw new Error(`generate_link failed (${link.status})`);
  const code = readSignInCode(await link.json());
  if (!code) throw new Error('generate_link returned no code');
  const publishable = env.PUBLISHABLE_KEY ?? env.ANON_KEY;
  const verify = await fetch(`${env.API_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: publishable, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email, token: code }) });
  if (!verify.ok) throw new Error(`verify failed (${verify.status})`);
  const body = await verify.json();
  if (typeof body.access_token !== 'string') throw new Error('verify returned no access token');
  return body.access_token;
}

/** A control-message client: every text frame is buffered; waitFor scans from a cursor. */
export async function openSocket(url, token) {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const messages = [];
  let wake = () => {};
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    try { messages.push(JSON.parse(raw.toString())); } catch { return; }
    wake();
  });
  let closed = false;
  ws.on('close', () => { closed = true; messages.push({ type: '__closed' }); wake(); });
  await new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); ws.once('unexpected-response', (req, res) => {
    // Handling this event stops ws aborting the handshake itself: drain and destroy, or the socket leaks.
    ws.on('error', () => {}); // the destroyed request may still report an error; the promise is already settled
    res.resume();
    req.destroy();
    fail(new Error(`upgrade refused ${res.statusCode}`));
  }); });
  let cursor = 0;
  const waitFor = async (predicate, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (cursor < messages.length) {
        const msg = messages[cursor]; cursor += 1;
        if (predicate(msg)) return msg;
        if (msg.type === 'error') throw new Error(`server error ${msg.payload?.code} while waiting for ${what}`);
        if (msg.type === '__closed') throw new Error(`socket closed while waiting for ${what}`);
      }
      // A dropped socket fails every later wait at once, not after the full timeout.
      if (closed) throw new Error(`socket closed while waiting for ${what}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${what}`);
      await new Promise((done) => { const timer = setTimeout(done, left); wake = () => { clearTimeout(timer); done(); }; });
    }
  };
  return { ws, waitFor, isClosed: () => closed, send: (data) => ws.send(data), close: () => ws.close(1000, 'done') };
}

async function api(base, path, token, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return response.json();
}

/** Pairs a fresh simulated device to the signed-in user (web approve), returning its olxd_ token in memory. */
async function pairDevice(opts, sessionToken) {
  const base = `http://${opts.host}:${opts.port}`;
  const socket = await openSocket(`ws://${opts.host}:${opts.port}/v2/cardputer`);
  try {
    socket.send(control('hello', { payload: { format_id: FORMAT_MP3 } }));
    await socket.waitFor((m) => m.type === 'pairing_required', 10_000, 'pairing_required');
    socket.send(control('pair_request', { payload: { model: 'perf-baseline-sim', fw_version: 'perf-398', claim: randomBytes(16).toString('hex') } }));
    const code = await socket.waitFor((m) => m.type === 'pair_code', 10_000, 'pair_code');
    const lookup = await api(base, '/api/pair/lookup', sessionToken, { user_code: code.payload.user_code });
    await api(base, '/api/pair/approve', sessionToken, { pairing_id: lookup.pairing_id, name: 'perf-baseline' });
    const paired = await socket.waitFor((m) => m.type === 'paired', 10_000, 'paired');
    return paired.payload.device_token;
  } finally {
    socket.close();
  }
}

/** Sends PCM as OLX2 frames at real-time pace (drift-corrected against the start time). */
async function streamPcm(socket, pcm) {
  const frames = pcmFrames(pcm);
  const started = Date.now();
  for (let i = 0; i < frames.length; i += 1) {
    const due = started + i * FRAME_MS - Date.now();
    if (due > 0) await sleep(due);
    socket.send(buildAudioFrame(frames[i], i));
  }
  return frames.length;
}

/** Opens a device socket and waits for a paired welcome; any failure closes the opened socket, then rethrows. */
export async function connectDevice(opts, deviceToken, open = openSocket) {
  const opened = await open(`ws://${opts.host}:${opts.port}/v2/cardputer`, deviceToken);
  try {
    opened.send(control('hello', { payload: { format_id: FORMAT_MP3 } }));
    const welcome = await opened.waitFor((m) => m.type === 'welcome', 10_000, 'welcome');
    if (!welcome.payload?.device) throw new Error('session is not paired (welcome has no device)');
    return opened;
  } catch (error) {
    // Left open, the socket keeps the process alive after the failure.
    opened.close();
    throw error;
  }
}

/** One voice run: a fresh conversation, then every line as a push-to-talk turn with a fixed gap. */
async function runVoice(opts, script, deviceToken, run) {
  const connect = () => connectDevice(opts, deviceToken);
  let socket = await connect();
  const results = [];
  try {
    socket.send(control('new_conversation', { payload: { request_id: opaqueId('newconv') } }));
    await socket.waitFor((m) => m.type === 'conversation_cleared', 10_000, 'conversation_cleared');
    for (const line of script.lines) {
      const turnRef = opaqueId(`r${run}l${line.n}`);
      const result = { line: line.n, turn_id: turnRef, ok: false, playback: false, errors: [] };
      try {
        // A server restart drops the socket: reconnect (same active conversation) and go on.
        if (socket.isClosed()) {
          socket = await connect();
          console.log(`reconnected before line ${line.n}`);
        }
        socket.send(control('turn_start', { turn_ref: turnRef }));
        const frames = await streamPcm(socket, linePcm(line, opts.stub));
        socket.send(control('turn_end', { turn_ref: turnRef, seq: frames - 1 }));
        for (;;) {
          const m = await socket.waitFor((x) => x.type === 'error' || x.type === 'playback_end'
            || (x.type === 'status' && x.payload?.stage === 'idle' && (x.turn_ref === undefined || x.turn_ref === turnRef)), opts.turnTimeoutMs, `idle for line ${line.n}`);
          if (m.type === 'error') result.errors.push(m.payload?.code ?? 'unknown');
          else if (m.type === 'playback_end') result.playback = true;
          else break;
        }
        result.ok = result.errors.length === 0;
      } catch (error) {
        result.errors.push(error.message);
      }
      results.push(result);
      console.log(`turn_id voice ${run} ${line.n} ${turnRef} ${result.ok ? 'ok' : `failed:${result.errors.join('|')}`}`);
      if (line.n < script.lines.length) await sleep(opts.gapMs);
    }
  } finally {
    socket.close();
  }
  return results;
}

/** One web run: the same lines as text to POST /api/chat; the message id is the journal turn_id. */
async function runWeb(opts, script, sessionToken, run) {
  const results = [];
  let conversationId;
  for (const line of script.lines) {
    const turnId = randomUUID();
    const result = { line: line.n, turn_id: turnId, ok: false, errors: [] };
    try {
      const response = await fetch(`http://${opts.host}:${opts.port}/api/chat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...(conversationId ? { id: conversationId } : {}), origin: 'web_text',
          message: { id: turnId, role: 'user', parts: [{ type: 'text', text: line.text }] } }),
        signal: AbortSignal.timeout(opts.turnTimeoutMs),
      });
      const stream = await response.text(); // drained, never printed
      conversationId ??= stream.match(/"conversationId":"([^"]+)"/)?.[1];
      if (!response.ok) result.errors.push(`http_${response.status}`);
      if (stream.includes('"type":"error"')) result.errors.push('stream_error');
      result.ok = result.errors.length === 0;
    } catch (error) {
      result.errors.push(error.name);
    }
    results.push(result);
    console.log(`turn_id web ${run} ${line.n} ${turnId} ${result.ok ? 'ok' : `failed:${result.errors.join('|')}`}`);
    if (line.n < script.lines.length) await sleep(opts.gapMs);
  }
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const script = loadScript();
  if (opts.makeClips) return makeClips(script);
  let sessionToken = process.env.BOB_SESSION_TOKEN;
  if (!sessionToken && opts.devSignIn) sessionToken = await devAccessToken();
  let token = sessionToken;
  if (opts.surface === 'voice') {
    token = process.env.BOB_DEVICE_TOKEN;
    if (!token) {
      if (!sessionToken) throw new Error('set BOB_DEVICE_TOKEN, BOB_SESSION_TOKEN or pass --dev-sign-in');
      token = await pairDevice(opts, sessionToken);
      console.log('paired a simulated device for the dev user');
    }
  } else if (!token) {
    throw new Error('set BOB_SESSION_TOKEN or pass --dev-sign-in');
  }
  const all = [];
  for (let run = 1; run <= opts.runs; run += 1) {
    console.log(`run ${run}/${opts.runs} surface=${opts.surface} stub=${opts.stub}`);
    all.push(...(opts.surface === 'voice' ? await runVoice(opts, script, token, run) : await runWeb(opts, script, token, run)));
    if (run < opts.runs) await sleep(opts.gapMs);
  }
  const ok = all.filter((r) => r.ok).length;
  console.log(`summary surface=${opts.surface} runs=${opts.runs} turns=${all.length} ok=${ok} failed=${all.length - ok}`);
  process.exitCode = ok >= Math.ceil(all.length * 0.95) ? 0 : 1;
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) main().catch((error) => { console.error(`perf-baseline: ${error.message}`); process.exitCode = 1; });
