/*
 * server-harness.ts — the real API server for a HIL run, with the device
 * paired automatically.
 *
 * Starts apps/api's own startV2Server() in THIS process (so the device talks to
 * the production code path, not a mock), on the run's own database on the
 * local Supabase stack (rig.mjs acquireHilDatabase), in system-test mode (stub
 * STT/agent/TTS, no AI Gateway). Pairing is the part a
 * human normally does on the web: this harness watches its own journal for
 * `v2.pair_issued` and approves each pairing for the dev account through the
 * same approve() the web route calls. It runs in-process so its hooks
 * (slow_turn, fail_next_turn) wrap the very Db the server uses.
 *
 * Why not the legacy shared secret: that path only exists in firmware built
 * with -DBOB_LEGACY_SECRET. A device that already holds an NVS token sends
 * it first; the harness adopts that token into this database (see
 * adoptDeviceToken) so the device keeps its pairing with the owner's dev
 * server. Only a device with no token pairs, through the flow approved here.
 *
 * Env (set by run.mjs): BOB_SYSTEM_TEST=1, BOB_DATABASE_URL (loopback), BOB_V2_JOURNAL,
 * BOB_V2_HOST, BOB_V2_PORT. Run with tsx from the repo root.
 */
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';

import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket } from 'ws';

import { getDeviceSessions } from '../../apps/api/src/voice/device-sessions.ts';
import { resolveDevAccount, usesLocalDatabase } from '../../apps/api/src/account/dev-account.ts';
import { journal } from '../../apps/api/src/platform/logger.ts';
import { approve, deny, getAccountEvents, lookupCode } from '../../apps/api/src/devices/pairing-service.ts';
import { createPairingRouter } from '../../apps/api/src/devices/pairing-http.ts';
import { DeviceModeSchema, type DeviceControlPatch } from '../../apps/api/src/voice/protocol.ts';
import { startV2Server } from '../../apps/api/src/server.ts';
import { getDb, type Db } from '../../apps/api/src/platform/db/db.ts';
import { approvePairing, claimPairing, issuePairing } from '../../apps/api/src/devices/pairing-store.ts';
import { createSpace } from '../../apps/api/src/spaces/store.ts';
import { archiveThread, createThread } from '../../apps/api/src/conversations/thread-store.ts';
import { ingestRelease } from '../../apps/api/src/firmware/store.ts';
import { createDevicesRouter } from '../../apps/api/src/devices/http.ts';
import { getConversationSummary } from '../../apps/api/src/conversations/store.ts';
import { getActive } from '../../apps/api/src/conversations/active.ts';
import { canonicalId } from '../../apps/api/src/platform/ids.ts';
import { verifyThreadEvidence } from './server-harness-thread.ts';

const journalPath = process.env.BOB_V2_JOURNAL ?? '';
if (process.env.BOB_SYSTEM_TEST !== '1' || !usesLocalDatabase(process.env) || !journalPath) {
  console.error('server-harness: needs BOB_SYSTEM_TEST=1, a loopback BOB_DATABASE_URL and BOB_V2_JOURNAL (run it through scripts/hil/run.mjs).');
  process.exit(2);
}

// The server starts listening only at the end of this file, once every hook
// below (token adoption, slow_turn, fail_next_turn) is in place: /health
// answers as soon as it listens, and a device that connected earlier would
// meet the plain server (it was refused as unpaired and erased its token).
const db = await getDb();
const account = await resolveDevAccount(db);

const approved = new Set<string>();
// A harness restarted by `T rig server-restart` appends to the same journal:
// the pairings already in it were decided by the process before.
let offset = existsSync(journalPath) ? statSync(journalPath).size : 0;
// `pair manual` stops the auto-approval: the next pairing waits for
// `pair approve`, which approves it through the web's route (see pairCommand).
let autoApprove = true;
let pendingPairingId: string | null = null;

async function approvePending(): Promise<void> {
  if (!existsSync(journalPath)) return;
  const text = readFileSync(journalPath, 'utf8');
  const fresh = text.slice(offset);
  const lastNewline = fresh.lastIndexOf('\n');
  if (lastNewline < 0) return;
  offset += lastNewline + 1;
  for (const line of fresh.slice(0, lastNewline).split('\n')) {
    let entry: { event?: string; pairing_id?: string };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const pairingId = entry.pairing_id;
    if (entry.event !== 'v2.pair_issued' || !pairingId || approved.has(pairingId)) continue;
    approved.add(pairingId);
    if (!autoApprove) {
      pendingPairingId = pairingId;
      continue;
    }
    try {
      await approve(db, account, pairingId, 'HIL Cardputer');
      journal('v2.hil_pair_auto_approved', { pairing_id: pairingId });
    } catch (error) {
      journal('v2.hil_pair_auto_approve_failed', {
        pairing_id: pairingId,
        error_name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

/*
 * Scenario-driven server actions (rig.mjs routes `T server <command>` here,
 * one per stdin line), through the same registry the timer scheduler and the
 * web settings use:
 *   announce ring                      a timer ring for the dev account (#319/#320)
 *   announce voice                     a spoken reminder through the stub TTS adapter
 *   control mode=ptt|wake|announce_only dnd=0|1 muted=0|1 volume=0..10
 *           ring_seconds=10..120 ring_sound=classic|chime|pulse
 *                                      a device_control push (#314/#330/#389)
 *   slow_turn <ms>                     holds the NEXT turn in its agent stage
 *                                      for <ms>, so a stop (#315) lands while
 *                                      the server is still working on it
 *   fail_next_turn INTERNAL            fails the NEXT turn the way a real
 *                                      provider failure does: v2.turn_failed,
 *                                      then error {code:"INTERNAL"}
 *   burst_next_reply                   sends the NEXT reply (one clip) as one
 *                                      burst (see armReplyBurst)
 *   tts_next <seconds> [wav]           the NEXT reply's stub TTS lasts <seconds>
 *                                      (1..60); wav = a 16 kHz mono repo WAV (checked)
 *   pairing hold                       answers the NEXT device connection as
 *                                      one with no token (see below)
 * Only the command name and outcome are journaled.
 *
 * fail_next_turn: INTERNAL is the only code the turn pipeline sends when a
 * turn fails (turn.ts failTurn), so it is the only one accepted. When the
 * armed turn journals `v2.turn_stage_stt_started` the hook below throws out
 * of that journal() call, inside transcribeTurn, so processTurn's own STT
 * catch fails the turn (error_name HilInjectedTurnFailure). That one
 * stt_started line reaches the console but not the journal file; the harness
 * journals v2.hil_fail_turn_injected in its place.
 *
 * slow_turn: the stub agent answers in about 100 ms and has no await to slow
 * down, so the hold goes on the shared Db instead. When the armed turn
 * journals `v2.turn_stage_stt_completed` (journal() prints synchronously), the
 * next query or transaction on the server's Db waits <ms>. That is the agent
 * stage's first store read (resolveActiveSpace in generateReply), which every
 * paired turn makes. The hold is journaled as v2.hil_slow_turn_holding and
 * v2.hil_slow_turn_released.
 */
let announceCount = 0;
// #389 contract values, listed here rather than imported so the harness does
// not depend on the name the server gives its schema.
const RING_SOUNDS = ['classic', 'chime', 'pulse'] as const;
const isRingSound = (value: string): value is (typeof RING_SOUNDS)[number] =>
  (RING_SOUNDS as readonly string[]).includes(value);
let slowTurnMs = 0;       // armed by `slow_turn`, for the next turn.
let holdNextDbCallMs = 0; // set when that turn finishes STT.
const MAX_SLOW_TURN_MS = 30_000;
let failNextTurn = false;  // armed by `fail_next_turn INTERNAL`.
// armed by `tts_next <seconds> [wav]`: the stub TTS (speech-adapters.ts) reads
// BOB_SYSTEM_TEST_TTS_SECONDS and BOB_SYSTEM_TEST_TTS_WAV per call, so the
// NEXT reply is that long and voices that clip; the envs go back when that turn
// completes. `wav` is checked here (a 16 kHz mono repo WAV); without it the stub
// voices a sine.
let ttsRestore: { seconds: string | undefined; wav: string | undefined } | null = null;
const MAX_TTS_SECONDS = 60;
function armTtsNext(seconds: string | undefined, wav: string | undefined): string {
  if (!/^\d+$/.test(seconds ?? '') || Number(seconds) < 1 || Number(seconds) > MAX_TTS_SECONDS) return 'bad';
  if (wav !== undefined) {
    const path = join(process.cwd(), wav);
    const ok = /^[\w.-]+(\/[\w.-]+)*\.wav$/.test(wav) && !wav.split('/').includes('..') && existsSync(path);
    const head = ok ? readFileSync(path).subarray(0, 44) : Buffer.alloc(0);
    if (head.length < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.readUInt32LE(24) !== 16_000 || head.readUInt16LE(22) !== 1) return 'bad_wav';
  }
  ttsRestore ??= { seconds: process.env.BOB_SYSTEM_TEST_TTS_SECONDS, wav: process.env.BOB_SYSTEM_TEST_TTS_WAV };
  process.env.BOB_SYSTEM_TEST_TTS_SECONDS = seconds;
  if (wav === undefined) delete process.env.BOB_SYSTEM_TEST_TTS_WAV;
  else process.env.BOB_SYSTEM_TEST_TTS_WAV = wav;
  return 'armed';
}
// `pairing hold` (settings-from-pairing, #681): the NEXT upgrade on the
// device route loses its Authorization header before the server's own auth
// guard reads it, so the real path answers pairing_required {reason:"none"},
// as a server the active profile holds no token for does. A device erases its
// token only on unknown|revoked, so the owner's token stays. Combined with
// `pair manual` the device then sits on its pair code. One connection only:
// the device's next connect is authenticated again.
let holdNextPairing = false;

class HilInjectedTurnFailure extends Error {
  override name = 'HilInjectedTurnFailure';
}

const print = console.log.bind(console);
console.log = (...args: unknown[]): void => {
  if (slowTurnMs > 0 && typeof args[0] === 'string' && args[0].includes('"event":"v2.turn_stage_stt_completed"')) {
    holdNextDbCallMs = slowTurnMs;
    slowTurnMs = 0;
  }
  print(...args);
  if (ttsRestore !== null && typeof args[0] === 'string' && args[0].includes('"event":"v2.turn_completed"')) {
    if (ttsRestore.seconds === undefined) delete process.env.BOB_SYSTEM_TEST_TTS_SECONDS;
    else process.env.BOB_SYSTEM_TEST_TTS_SECONDS = ttsRestore.seconds;
    if (ttsRestore.wav === undefined) delete process.env.BOB_SYSTEM_TEST_TTS_WAV;
    else process.env.BOB_SYSTEM_TEST_TTS_WAV = ttsRestore.wav;
    ttsRestore = null;
  }
  if (failNextTurn && typeof args[0] === 'string' && args[0].includes('"event":"v2.turn_stage_stt_started"')) {
    failNextTurn = false;
    journal('v2.hil_fail_turn_injected', { code: 'INTERNAL' });
    throw new HilInjectedTurnFailure('injected by the HIL harness');
  }
};

/*
 * burst_next_reply: the NEXT reply goes out as one TTS clip (the stub agent's
 * reply, "System test response: <transcript>", is a single clause, so the
 * sentence player synthesizes it once), and every socket write from its
 * playback_start through its playback_end is held, then written back to back
 * in one tick. The device then holds the whole reply, and usually
 * playback_end too, before its decode task reaches the MP3 decoder's begin():
 * the order that dropped whole replies (HIL run 20260929-064635-40fc,
 * mp3_begin_failed). Journaled as v2.hil_reply_burst with the write count.
 * A reply that never sends playback_end stays held; no scenario cancels one.
 */
let burstArmed = false;
let burstQueue: unknown[][] | null = null;
type Send = (this: WebSocket, ...args: unknown[]) => void;
const wsSend = WebSocket.prototype.send as unknown as Send;
(WebSocket.prototype as unknown as { send: Send }).send = function send(this: WebSocket, ...args: unknown[]): void {
  const text = typeof args[0] === 'string' ? args[0] : '';
  if (burstArmed && burstQueue === null && text.includes('"type":"playback_start"')) burstQueue = [];
  if (burstQueue === null) {
    wsSend.apply(this, args);
    return;
  }
  burstQueue.push(args);
  if (!text.includes('"type":"playback_end"')) return;
  const held = burstQueue;
  burstQueue = null;
  burstArmed = false;
  journal('v2.hil_reply_burst', { writes: held.length });
  for (const queued of held) wsSend.apply(this, queued);
};

function armReplyBurst(): void {
  burstArmed = true;
}

async function holdIfArmed(): Promise<void> {
  if (holdNextDbCallMs === 0) return;
  const ms = holdNextDbCallMs;
  holdNextDbCallMs = 0;
  journal('v2.hil_slow_turn_holding', { ms });
  await new Promise((resolve) => setTimeout(resolve, ms));
  journal('v2.hil_slow_turn_released', { ms });
}

/*
 * The device keeps its own pairing. A device that already holds a token
 * (from the owner's dev server) presents it on connect; this fresh database
 * does not know it, and the server would answer pairing_required(unknown),
 * which makes the device ERASE the token, so after the run the owner had to
 * pair it again on the dev server. Instead, when the server's token lookup
 * (bob_private.device_for_token) finds nothing, the harness registers that
 * token's sha256 for the dev account through the same store steps a real
 * pairing takes (issue → approve → claim), then repeats the lookup: the device
 * authenticates with the token it already has and never erases it. Only the
 * hash the server was given is used; the token itself never reaches the
 * harness. A device with no token still pairs as before (auto-approved
 * below). Journaled as v2.hil_token_adopted.
 */
async function adoptDeviceToken(tokenHash: Uint8Array): Promise<boolean> {
  const random = (): Uint8Array => createHash('sha256').update(randomBytes(32)).digest();
  const claimHash = random();
  const pairingId = await issuePairing(db, {
    codeHash: random(), claimHash, model: 'HIL adopted', fwVersion: 'hil', ipHash: 'hil', ttlSeconds: 600,
  });
  await approvePairing(db, account, pairingId, 'HIL Cardputer');
  return (await claimPairing(db, pairingId, claimHash, tokenHash)) !== null;
}

let adopting = false;
const dbQuery = db.query.bind(db);
const dbTx = db.tx.bind(db);
db.query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
  await holdIfArmed();
  const rows = await dbQuery<T>(sql, params);
  const hash = params?.[0];
  if (rows.length > 0 || adopting || !sql.includes('bob_private.device_for_token(') || !(hash instanceof Uint8Array)) {
    return rows;
  }
  adopting = true;
  try {
    const adopted = await adoptDeviceToken(hash);
    journal('v2.hil_token_adopted', { outcome: adopted ? 'adopted' : 'not_claimed' });
    return adopted ? dbQuery<T>(sql, params) : rows;
  } catch (error) {
    journal('v2.hil_token_adopted', { outcome: 'failed', error_name: error instanceof Error ? error.name : 'unknown' });
    return rows;
  } finally {
    adopting = false;
  }
};
db.tx = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
  await holdIfArmed();
  return dbTx(fn);
};

/*
 * #565 thread pointer (`T server thread seed|archive`):
 *   thread seed     creates a group space and a thread in it for the dev
 *                   account (store/spaces.ts, store/threads.ts), then points
 *                   the device at the thread through the real
 *                   PUT /api/devices/active-conversation route (web-devices.ts)
 *                   with thread_id, as "Use on Cardputer" does. The route runs
 *                   unchanged on a loopback-only ephemeral port; the dev account
 *                   stands in for the JWT guard. outcome pointed, or
 *                   failed_http_<status> (409: no device connected). Each seed
 *                   makes a new space and thread (numbered) and replaces the last
 *   thread archive  archives the latest seed's thread (archiveThread, the store
 *                   call DELETE /api/threads/:id makes). The pointer is left as
 *                   it is: between turns the next turn_start finds it archived and
 *                   clears it; during a turn (held by slow_turn) the persist meets
 *                   the lost thread (v2.device_thread_lost). outcome archived, or
 *                   failed_not_seeded when no seed came first
 * An error journals outcome=failed with error_name; the harness keeps running.
 */
let seedCount = 0;
let seededThreadId: string | null = null;
let threadEvidenceOffset = 0;
let webApiUrl: string | null = null;

/** The web's own routers (devices, pairing), unchanged, on a loopback-only
 *  ephemeral port; the dev account stands in for the JWT guard. */
async function webApi(): Promise<string> {
  if (webApiUrl !== null) return webApiUrl;
  const app = express();
  app.use((request: Request, _response: Response, next: NextFunction) => {
    request.account = { userId: account, sessionId: 'hil', exp: Number.MAX_SAFE_INTEGER };
    next();
  });
  app.use(express.json());
  const requireActiveSession = async (_request: Request, _response: Response, next: NextFunction): Promise<void> => next();
  app.use('/api/devices', createDevicesRouter({
    getDb,
    requireActiveSession,
    events: getAccountEvents(),
    deviceSessions: getDeviceSessions(),
  }));
  app.use('/api/pair', createPairingRouter({ getDb, pairing: { lookupCode, approve, deny }, requireActiveSession }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();
  webApiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return webApiUrl;
}

async function devicesRoute(): Promise<string> {
  return `${await webApi()}/devices`;
}

async function isCompletedGeneral(id: string): Promise<boolean> {
  const active = await getActive(db, account);
  if (active?.kind !== 'conversation' || !active.conversationId) return false;
  if (canonicalId('conversation', id) !== canonicalId('conversation', active.conversationId)) return false;
  return (await getConversationSummary(db, account, active.conversationId)) !== null;
}

async function threadCommand(action: string | undefined): Promise<string> {
  if (action === 'verify-selected' || action === 'verify-general') {
    return verifyThreadEvidence(action, readFileSync(journalPath, 'utf8').slice(threadEvidenceOffset), seededThreadId,
      isCompletedGeneral);
  }
  if (action === 'seed') {
    threadEvidenceOffset = readFileSync(journalPath, 'utf8').length;
    seedCount += 1;
    const space = await createSpace(db, account, { kind: 'group', name: `HIL space ${seedCount}` });
    const thread = await createThread(db, account, { spaceId: space.id, title: `HIL thread ${seedCount}` });
    const response = await fetch(`${await devicesRoute()}/active-conversation`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: null, space_id: space.id, thread_id: thread.id }),
    });
    if (!response.ok) return `failed_http_${response.status}`;
    seededThreadId = thread.id;
    return 'pointed';
  }
  if (action === 'archive') {
    if (seededThreadId === null) return 'failed_not_seeded';
    threadEvidenceOffset = readFileSync(journalPath, 'utf8').length;
    await archiveThread(db, account, seededThreadId);
    return 'archived';
  }
  return 'bad';
}

/*
 * Pairing and devices the way the web does them (pair-from-scratch, revoke-4003):
 *   pair manual     stops the auto-approval above; outcome manual
 *   pair auto       auto-approval again (the default); outcome auto
 *   pair approve    approves the latest pairing issued while manual through the
 *                   real POST /api/pair/approve (pairing/http.ts). The web first
 *                   turns the typed code into that pairing_id (/api/pair/lookup);
 *                   the harness takes it from v2.pair_issued, so the pair code
 *                   never reaches it. outcome approved, failed_no_pending or
 *                   failed_http_<status>
 *   device rename   renames the device `pair approve` paired, through the real
 *                   PATCH /api/devices/:id; outcome renamed
 *   device revoke   revokes it through the real DELETE /api/devices/:id, which
 *                   closes its socket with 4003; outcome revoked
 * device: failed_not_paired before a `pair approve`, else failed_http_<status>.
 */
let pairedDeviceId: string | null = null;
const JSON_HEADERS = { 'content-type': 'application/json' };

async function pairCommand(action: string | undefined): Promise<string> {
  if (action === 'manual' || action === 'auto') {
    autoApprove = action === 'auto';
    pendingPairingId = null;
    return action;
  }
  if (action !== 'approve') return 'bad';
  await approvePending();  // a pair_issued the 250 ms poll has not read yet.
  const pairingId = pendingPairingId;
  if (pairingId === null) return 'failed_no_pending';
  pendingPairingId = null;
  const response = await fetch(`${await webApi()}/pair/approve`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ pairing_id: pairingId, name: 'HIL Cardputer' }),
  });
  if (!response.ok) return `failed_http_${response.status}`;
  pairedDeviceId = ((await response.json()) as { device_id: string }).device_id;
  return 'approved';
}

async function deviceCommand(action: string | undefined): Promise<string> {
  if (action !== 'rename' && action !== 'revoke') return 'bad';
  if (pairedDeviceId === null) return 'failed_not_paired';
  const url = `${await devicesRoute()}/${pairedDeviceId}`;
  const response = action === 'rename'
    ? await fetch(url, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: 'HIL renamed' }) })
    : await fetch(url, { method: 'DELETE' });
  if (!response.ok) return `failed_http_${response.status}`;
  if (action === 'revoke') pairedDeviceId = null;
  return action === 'rename' ? 'renamed' : 'revoked';
}

/*
 * firmware ingest <name>  stores the signed release in $BOB_OTA_DIR/<name>
 *                         (manifest.json, manifest.sig and the one .bin) and
 *                         points the dev channel at it, through the production
 *                         ingest. The keys come from BOB_FW_PUBKEYS. Outcome:
 *                         ingested, failed_no_bundle or failed_<error name>.
 */
async function firmwareCommand(action: string | undefined, name: string | undefined): Promise<string> {
  if (action !== 'ingest' || !name || !/^[a-z]+$/.test(name) || !process.env.BOB_OTA_DIR) return 'bad';
  const dir = join(process.env.BOB_OTA_DIR, name);
  const bins = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.bin')) : [];
  if (bins.length !== 1 || !existsSync(join(dir, 'manifest.json')) || !existsSync(join(dir, 'manifest.sig'))) {
    return 'failed_no_bundle';
  }
  const result = await ingestRelease(db, {
    manifestBytes: readFileSync(join(dir, 'manifest.json')),
    sigB64: readFileSync(join(dir, 'manifest.sig'), 'utf8').trim(),
    image: readFileSync(join(dir, bins[0] as string)),
  });
  // Ingest advances only the dev channel; put the HIL device on it so the offer reaches it.
  await db.query("update bob.devices set fw_channel = 'dev' where revoked_at is null");
  return result.inserted || result.advanced.length > 0 ? 'ingested' : 'ingested_unchanged';
}

const ASYNC_COMMANDS = new Map<string, (action: string | undefined, arg: string | undefined) => Promise<string>>([
  ['thread', threadCommand], ['pair', pairCommand], ['device', deviceCommand], ['firmware', firmwareCommand],
]);

function runCommand(line: string): void {
  const [name, ...args] = line.trim().split(/\s+/);
  const asyncCommand = ASYNC_COMMANDS.get(name ?? '');
  if (asyncCommand !== undefined) {
    void asyncCommand(args[0], args[1]).then(
      (outcome) => journal('v2.hil_command', { command: name, outcome }),
      (error: unknown) => journal('v2.hil_command', {
        command: name, outcome: 'failed', error_name: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return;
  }
  let outcome = 'bad';
  if (name === 'slow_turn' && /^\d+$/.test(args[0] ?? '') && Number(args[0]) > 0 && Number(args[0]) <= MAX_SLOW_TURN_MS) {
    slowTurnMs = Number(args[0]);
    outcome = 'armed';
  } else if (name === 'burst_next_reply' && args.length === 0) {
    armReplyBurst();
    outcome = 'armed';
  } else if (name === 'tts_next' && args.length >= 1 && args.length <= 2) {
    outcome = armTtsNext(args[0], args[1]);
  } else if (name === 'pairing' && args[0] === 'hold' && args.length === 1) {
    holdNextPairing = true;
    outcome = 'armed';
  } else if (name === 'fail_next_turn' && args[0] === 'INTERNAL') {
    failNextTurn = true;
    outcome = 'armed';
  } else if (name === 'announce' && (args[0] === 'ring' || args[0] === 'voice')) {
    announceCount += 1;
    const ring = args[0] === 'ring';
    outcome = getDeviceSessions().announce(account, {
      announce_id: `hil_ring_${Date.now()}_${announceCount}`,
      kind: ring ? 'timer' : 'reminder', title: 'HIL announcement', body: '', ring,
      ...(ring ? {} : { speech: 'Hardware reminder test.' }),
      expires_at: Date.now() + 60_000,
    });
  } else if (name === 'control' && args.length > 0) {
    const patch: DeviceControlPatch = {};
    let valid = true;
    for (const arg of args) {
      const [key, value = ''] = arg.split('=');
      const mode = DeviceModeSchema.safeParse(value);
      if (key === 'mode' && mode.success) patch.mode = mode.data;
      else if ((key === 'dnd' || key === 'muted') && (value === '0' || value === '1')) patch[key] = value === '1';
      else if (key === 'volume' && /^(10|\d)$/.test(value)) patch.volume = Number(value);
      else if (key === 'ring_seconds' && /^\d{2,3}$/.test(value) && Number(value) >= 10 && Number(value) <= 120) patch.ring_seconds = Number(value);
      else if (key === 'ring_sound' && isRingSound(value)) patch.ring_sound = value;
      else valid = false;
    }
    if (valid) outcome = `sent_${getDeviceSessions().sendDeviceControl(account, null, patch)}`;
  }
  journal('v2.hil_command', { command: name ?? '', outcome });
}

createInterface({ input: process.stdin }).on('line', runCommand);

const v2Server = await startV2Server();
// Before websocket-express's own upgrade listener: see holdNextPairing.
v2Server.prependListener('upgrade', (request: IncomingMessage) => {
  if (!holdNextPairing || !request.url?.startsWith('/v2/cardputer')) return;
  holdNextPairing = false;
  delete request.headers.authorization;
  journal('v2.hil_pairing_held', {});
});

let busy = false;
setInterval(() => {
  if (busy) return;
  busy = true;
  void approvePending().finally(() => {
    busy = false;
  });
}, 250);
