/**
 * Deterministic, human-free end-to-end test of the REAL server over a REAL
 * loopback WebSocket, with a simulated Cardputer (helpers/sim-device.ts).
 *
 * Runs inside the normal suite (`npm test --workspace @bob/api`) so every
 * validate and CI run exercises a full voice turn. No provider calls, no fixed
 * sleeps, and no network beyond 127.0.0.1.
 *
 * Environment is set BEFORE any src module imports, then server.ts is loaded
 * with a dynamic import in beforeAll: BOB_SYSTEM_TEST_MODE is read once when
 * @bob/ai loads, and vitest isolates modules per file.
 *
 * NOTE (deviation from brief): case 3 asks to create the second conversation
 * via POST /api/chat, but in system-test mode webChat returns early and never
 * creates or persists a conversation (src/web-chat.ts). The second conversation
 * is therefore created directly through the store so the picker case stays
 * deterministic with strong assertions.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket, { type RawData } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimDevice, type SimAudioDownFrame, type SimControlDto } from '../helpers/sim-device.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import { appendMessage, createConversation, listConversations } from '../../src/conversations/store.ts';
import { getActive, setActive } from '../../src/conversations/active.ts';
import { revokeDevice } from '../../src/devices/pairing-store.ts';
import { resolveDevAccount, DEV_ACCOUNT_ID } from '../../src/account/dev-account.ts';
import {
  asDb,
  addAccount,
  addSession,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';
import { collectEvents, openSse } from '../support/sse.ts';
import {
  DOWNLINK_FRAME_BYTES,
  DOWNLINK_MP3_CHUNK_BYTES,
  MP3_16K_MONO_FORMAT,
  PCM16_16K_MONO_FORMAT,
  PCM16_16K_MONO_RATE_HZ,
  V2_VERSION,
  messageId,
  type AudioFrameDto,
} from '../../src/voice/protocol.ts';
import { audioStartOffset, parseMp3Frame } from '../../src/voice/audio/mp3.ts';

const TRANSCRIPT = 'e2e what time is it';
const REPLY = `System test response: ${TRANSCRIPT}`;
const DEVICE_SECRET = 'e2e-secret';
const TTS_SECONDS = 2;

let pg: TestDb;
let db: Db;
let userId: string;
let webToken: string;
let server: Server;
let port: number;
let baseUrl: string;
const journalLines: string[] = [];

const guardRole = process.env.BOB_TEST_GUARD_ROLE === '1';

/** Resolves after `ms` with 'timeout', for Promise.race deadlines. */
function delay(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
}

async function addAccountSafe(options: Parameters<typeof addAccount>[1] = {}): Promise<TestAccount> {
  return addAccount(pg, options);
}

/** A test-token for the account whose session actually exists in auth.sessions.
 *  createTestTokenHandler (issue #151) now inserts the matching auth.sessions
 *  row itself, tolerantly (`on conflict (id) do nothing`); this helper's own
 *  session ensure is a defensive fallback for that same row and must be just as
 *  tolerant, or it 23505s on the row the handler already created. */
async function mintActiveWebToken(userId: string): Promise<string> {
  const issued = await fetch(`${baseUrl}/api/test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  expect(issued.status).toBe(200);
  const { token } = (await issued.json()) as { token: string };
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
    session_id: string;
  };
  await addSession(pg, userId, payload.session_id);
  return token;
}

function countJournal(event: string): number {
  return journalLines.reduce((count, line) => (JSON.parse(line).event === event ? count + 1 : count), 0);
}

/** Counts `event` occurrences among journal lines appended from `startIndex` on. */
function countJournalSince(startIndex: number, event: string): number {
  let count = 0;
  for (let index = startIndex; index < journalLines.length; index += 1) {
    if ((JSON.parse(journalLines[index]!) as { event: string }).event === event) count += 1;
  }
  return count;
}

/** Waits until at least `minCount` occurrences of `event` appear after `startIndex`. */
function waitForJournalSince(startIndex: number, event: string, minCount: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (countJournalSince(startIndex, event) >= minCount) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${minCount} occurrences of '${event}' after line ${startIndex}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

/** First `event` entry (of the given shape) among lines appended from `startIndex` on. */
function journalEventSince<T>(startIndex: number, event: string): T | undefined {
  for (let index = startIndex; index < journalLines.length; index += 1) {
    const entry = JSON.parse(journalLines[index]!) as { event: string } & T;
    if (entry.event === event) return entry;
  }
  return undefined;
}

/** Waits until at least `minCount` occurrences of a journal event exist. */
function waitForJournalCount(event: string, minCount: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (countJournal(event) >= minCount) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${minCount} occurrences of '${event}'`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function wsUrl(): string {
  return `ws://127.0.0.1:${port}/v2/cardputer`;
}

function webHeaders(): Record<string, string> {
  return { authorization: `Bearer ${webToken}` };
}

/** Collects the SSE event names an account's /api/events stream receives within
 *  `ms` (isolation check E-11 only). */
async function collectSseEventNamesFor(token: string, ms: number): Promise<string[]> {
  const { events, abort } = await openSse(baseUrl, token);
  const { frames } = collectEvents(events);
  try {
    await delay(ms);
  } finally {
    abort();
  }
  return frames.map((frame) => frame.type);
}

function controlDto(
  type: string,
  payload: Record<string, unknown> = {},
  extra: { turn_ref?: string; seq?: number } = {},
): SimControlDto {
  return { v: V2_VERSION, type, id: messageId(type), ...extra, payload };
}

/** Non-empty PCM16 16 kHz mono sine as uplink OLX2 frames with contiguous seq. */
function sinePcmFrames(frameBytes: number, frameCount: number): AudioFrameDto[] {
  const frames: AudioFrameDto[] = [];
  const samplesPerFrame = frameBytes / 2;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const payload = Buffer.alloc(frameBytes);
    for (let sample = 0; sample < samplesPerFrame; sample += 1) {
      const phase = frameIndex * samplesPerFrame + sample;
      const value = Math.round(8000 * Math.sin((2 * Math.PI * 440 * phase) / PCM16_16K_MONO_RATE_HZ));
      payload.writeInt16LE(value, sample * 2);
    }
    frames.push({
      header: {
        magic: 'OLX2',
        version: V2_VERSION,
        kind: 'audio_up',
        formatId: 1,
        channels: 1,
        turnHandle: 1,
        sequence: frameIndex,
        payloadBytes: frameBytes,
      },
      payload,
    });
  }
  return frames;
}

/** Runs one voice turn on an already-welcomed socket and returns the downlink. */
async function runVoiceTurn(
  device: SimDevice,
  turnRef: string,
): Promise<{ downFrames: number; frames: SimAudioDownFrame[]; mp3: Buffer }> {
  device.reset();
  const completedBefore = countJournal('v2.turn_completed');
  device.sendControl(controlDto('turn_start', {}, { turn_ref: turnRef }));
  const frames = sinePcmFrames(320, 32);
  for (const frame of frames) device.sendAudioFrame(frame);
  device.sendControl(controlDto('turn_end', {}, { turn_ref: turnRef, seq: frames.length - 1 }));

  // Both waiters are registered before the reply streams in: ws delivers the
  // whole playback burst (playback_start, frames, playback_end) in one batch.
  await Promise.all([device.waitFor('playback_start', 30000), device.waitFor('playback_end', 30000)]);
  // v2.turn_completed is journaled synchronously before resetSession, so this
  // guarantees the session has returned to 'ready' before the caller reuses
  // the socket for another turn (starting one while still 'responding' would
  // be a STATE_VIOLATION).
  await waitForJournalCount('v2.turn_completed', completedBefore + 1);

  const down = device.audioEvents();
  const payloads = down.map((frame) => frame.payload);
  return {
    downFrames: down.length,
    frames: down,
    mp3: Buffer.concat(payloads),
  };
}

/** Sums the duration (seconds) of the contiguous MP3 frames in a buffer. */
function mp3Duration(buffer: Buffer): number {
  let offset = audioStartOffset(buffer);
  let total = 0;
  let guard = 0;
  while (offset + 4 <= buffer.length && guard < 100_000) {
    const frame = parseMp3Frame(buffer, offset);
    if (!frame) break;
    total += frame.samplesPerFrame / frame.sampleRateHz;
    offset += frame.frameLengthBytes;
    guard += 1;
  }
  return total;
}

function assertMp3Turn(result: { downFrames: number; frames: SimAudioDownFrame[]; mp3: Buffer }): void {
  expect(result.downFrames).toBeGreaterThan(0);
  for (let index = 0; index < result.frames.length; index += 1) {
    const frame = result.frames[index]!;
    expect(frame.kind).toBe('audio_down');
    expect(frame.formatId).toBe(MP3_16K_MONO_FORMAT);
    expect(frame.sequence).toBe(index);
    expect(frame.payload.length).toBeLessThanOrEqual(DOWNLINK_MP3_CHUNK_BYTES);
  }
  const first = parseMp3Frame(result.mp3, audioStartOffset(result.mp3));
  expect(first).not.toBeNull();
  expect(first!.sampleRateHz).toBe(PCM16_16K_MONO_RATE_HZ);
  expect(first!.bitrateKbps).toBe(32);
  const duration = mp3Duration(result.mp3);
  expect(duration).toBeGreaterThanOrEqual(TTS_SECONDS - 0.15);
  expect(duration).toBeLessThanOrEqual(TTS_SECONDS + 0.15);
  expect(result.downFrames).toBe(Math.ceil(result.mp3.length / DOWNLINK_MP3_CHUNK_BYTES));
}

interface StoredMessageLike {
  role: string;
  versions: Array<{ selected: boolean; parts: Array<{ type?: string; text?: string }> }>;
}

/** Flattens a stored conversation's selected-version parts into plain text. */
function flattenedTexts(detail: { messages: StoredMessageLike[] }): Array<{ role: string; text: string }> {
  return detail.messages.map((message) => {
    const version = message.versions.find((candidate) => candidate.selected) ?? message.versions[0]!;
    const text = (version.parts ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join(' ')
      .trim();
    return { role: message.role, text };
  });
}

async function fetchConversation(id: string): Promise<{ status: number; detail: { messages: StoredMessageLike[] } | null }> {
  const response = await fetch(`${baseUrl}/api/conversations/${id}`, { headers: webHeaders() });
  const detail = response.status === 200 ? ((await response.json()) as { messages: StoredMessageLike[] }) : null;
  return { status: response.status, detail };
}

/** Opens a device and asserts the server rejects the upgrade with `status`. */
async function expectRejection(device: SimDevice, status: number): Promise<void> {
  const result = await device.open();
  if (result.connected) throw new Error('expected the server to reject the upgrade');
  expect(result.status).toBe(status);
}

/** A raw ws device client that also surfaces the close code/reason (SimDevice
 *  does not). Used by the P-18 revoke-close assertion only. */
interface RawDeviceClient {
  send: (raw: string) => void;
  waitFor: (type: string, timeoutMs?: number) => Promise<SimControlDto>;
  closed: Promise<{ code: number; reason: Buffer }>;
  close: () => void;
}

function rawDevice(token: string): Promise<RawDeviceClient> {
  return new Promise((resolve, reject) => {
    const received: SimControlDto[] = [];
    const waiters: Array<{ type: string; resolve: (dto: SimControlDto) => void }> = [];
    const socket = new WebSocket(wsUrl(), { headers: { authorization: `Bearer ${token}` }, autoPong: true });
    const closed = new Promise<{ code: number; reason: Buffer }>((resolveClose) => {
      socket.on('close', (code: number, reason: Buffer) => resolveClose({ code, reason }));
    });
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const dto = JSON.parse(raw.toString()) as SimControlDto;
      received.push(dto);
      const index = waiters.findIndex((waiter) => waiter.type === dto.type);
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        waiter!.resolve(dto);
      }
    });
    socket.on('open', () => resolve({
      send: (raw: string): void => socket.send(raw),
      waitFor: (type: string, timeoutMs = 5000): Promise<SimControlDto> => {
        const existing = received.find((dto) => dto.type === type);
        if (existing !== undefined) return Promise.resolve(existing);
        return new Promise((resolveWait, rejectWait) => {
          const waiter = { type, resolve: (dto: SimControlDto): void => resolveWait(dto) };
          const timer = setTimeout(() => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            rejectWait(new Error(`Timed out waiting for '${type}'`));
          }, timeoutMs);
          waiters.push(waiter);
        });
      },
      closed,
      close: (): void => socket.terminate(),
    }));
    socket.on('error', (error: Error) => reject(error));
  });
}

describe('device e2e flow', () => {
  beforeAll(async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_SYSTEM_TEST_TTS_SECONDS = String(TTS_SECONDS);
    process.env.BOB_SYSTEM_TEST_TRANSCRIPT = TRANSCRIPT;
    process.env.BOB_V2_HOST = '127.0.0.1';
    process.env.DEVICE_SHARED_SECRET = DEVICE_SECRET;
    setJournalSink((line) => journalLines.push(line));

    // The whole suite shares one test db (T009): the server's lazy getDb()
    // resolves to this instance so device turns and web routes read the same
    // rows, exactly as the shared SQLite file did. With BOB_TEST_GUARD_ROLE=1
    // the connection first switches to bob_server (the production role).
    pg = await createTestDb();
    db = asDb(pg);
    await addAccount(pg, { id: DEV_ACCOUNT_ID });
    userId = await resolveDevAccount(db);
    // T018: device upgrades authenticate per the pairing rules; the legacy
    // shared-secret path lets this suite's devices act as the dev account so
    // the turn flow and web visibility stay unchanged.
    process.env.BOB_LEGACY_DEVICE_OWNER = userId;
    if (guardRole) await pg.exec('set role bob_server');
    setSharedDb(Promise.resolve(db));

    const { createV2Server } = await import('../../src/server.ts');
    server = (await createV2Server()).server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;

    // T011: the web routes scope to req.account.userId, so mint a signed token
    // for the dev account through the loopback system-test issuer.
    const issued = await fetch(`${baseUrl}/api/test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    expect(issued.status).toBe(200);
    webToken = ((await issued.json()) as { token: string }).token;
  }, 30000);

  afterAll(async () => {
    setJournalSink(null);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb().catch(() => undefined);
    await closeTestDb(pg).catch(() => undefined);
    delete process.env.BOB_SYSTEM_TEST;
    delete process.env.BOB_SYSTEM_TEST_TTS_SECONDS;
    delete process.env.BOB_SYSTEM_TEST_TRANSCRIPT;
    delete process.env.BOB_V2_HOST;
    delete process.env.DEVICE_SHARED_SECRET;
    delete process.env.BOB_LEGACY_DEVICE_OWNER;
    delete process.env.BOB_MAX_DEVICE_SESSIONS;
    delete process.env.BOB_RATE_LIMIT_DEVICE_RPM;
    delete process.env.BOB_WS_HEARTBEAT_MS;
  });

  it('runs a full MP3 voice turn end to end, twice, deterministically', async () => {
    const device = new SimDevice(wsUrl(), { auth: DEVICE_SECRET });
    expect((await device.open()).connected).toBe(true);

    device.sendControl(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT }));
    const welcome = await device.waitFor('welcome', 30000);
    expect(welcome.payload.format_id).toBe(MP3_16K_MONO_FORMAT);
    expect(welcome.payload.max_audio_bytes).toBe(4096);

    const first = await runVoiceTurn(device, messageId('turn'));
    assertMp3Turn(first);

    const second = await runVoiceTurn(device, messageId('turn'));
    assertMp3Turn(second);
    expect(second.downFrames).toBe(first.downFrames);
    expect(second.mp3.equals(first.mp3)).toBe(true);

    const completed = journalLines
      .map((line) => JSON.parse(line) as { event: string; down_frames?: number })
      .filter((entry) => entry.event === 'v2.turn_completed');
    expect(completed.length).toBeGreaterThanOrEqual(2);
    expect(completed.at(-2)!.down_frames).toBe(first.downFrames);
    expect(completed.at(-1)!.down_frames).toBe(second.downFrames);

    device.close();
  }, 30000);

  it('persists the device conversation and exposes it to the web', async () => {
    const listResponse = await fetch(`${baseUrl}/api/conversations`, { headers: webHeaders() });
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { conversations: Array<{ id: string; title: string }> };
    // T028: the first device turn created a conversation titled
    // deriveTitle(TRANSCRIPT) and set it as the account's pointer.
    const deviceChat = listBody.conversations.find((candidate) => candidate.title === TRANSCRIPT);
    expect(deviceChat).toBeDefined();

    const { status, detail } = await fetchConversation(deviceChat!.id);
    expect(status).toBe(200);
    const texts = flattenedTexts(detail!);
    expect(texts.at(-2)!.role).toBe('user');
    expect(texts.at(-2)!.text).toBe(TRANSCRIPT);
    expect(texts.at(-1)!.role).toBe('assistant');
    expect(texts.at(-1)!.text).toBe(REPLY);
  }, 30000);

  it('lists, selects, and writes to a non-default conversation; rejects unknown ids', async () => {
    // See file header note: POST /api/chat does not persist in system-test
    // mode, so the second conversation is created via the store.
    const second = await createConversation(db, userId, 'Second chat');

    const device = new SimDevice(wsUrl(), { auth: DEVICE_SECRET });
    expect((await device.open()).connected).toBe(true);
    device.sendControl(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT }));
    await device.waitFor('welcome', 30000);

    device.sendControl(controlDto('list_conversations'));
    const listed = await device.waitFor('conversations', 30000);
    const titles = (listed.payload.conversations as Array<{ id: string; title: string }>).map((item) => item.title);
    expect(titles).toContain(TRANSCRIPT);
    expect(titles).toContain('Second chat');

    device.sendControl(controlDto('select_conversation', { conversation_id: second.id }));
    const selected = await device.waitFor('conversation_selected', 30000);
    expect(selected.payload.conversation_id).toBe(second.id);

    const turn = await runVoiceTurn(device, messageId('turn'));
    expect(turn.downFrames).toBeGreaterThan(0);

    const { status, detail } = await fetchConversation(second.id);
    expect(status).toBe(200);
    const texts = flattenedTexts(detail!);
    expect(texts.some((entry) => entry.role === 'user' && entry.text === TRANSCRIPT)).toBe(true);
    expect(texts.some((entry) => entry.role === 'assistant' && entry.text === REPLY)).toBe(true);

    device.sendControl(controlDto('select_conversation', { conversation_id: 'cnv_unknown_0000000000' }));
    const error = await device.waitFor('error', 30000);
    expect(error.payload.code).toBe('CONVERSATION_NOT_FOUND');

    device.close();
  }, 30000);

  it('recreates a fresh conversation after the active one is deleted (pointer cleared)', async () => {
    const active = await getActive(db, userId);
    expect(active?.conversationId).not.toBeNull();
    const deletedId = active!.conversationId!;

    const deleteResponse = await fetch(`${baseUrl}/api/conversations/${deletedId}`, { method: 'DELETE', headers: webHeaders() });
    expect(deleteResponse.status).toBe(204);

    // Deleting the active conversation cleared the pointer (FK on delete set null).
    const cleared = await getActive(db, userId);
    expect(cleared?.conversationId).toBeNull();

    const device = new SimDevice(wsUrl(), { auth: DEVICE_SECRET });
    expect((await device.open()).connected).toBe(true);
    device.sendControl(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT }));
    await device.waitFor('welcome', 30000);
    const turn = await runVoiceTurn(device, messageId('turn'));
    expect(turn.downFrames).toBeGreaterThan(0);
    device.close();

    // The next device turn created a fresh conversation (plan §E), never
    // falling back to an older one.
    const after = await getActive(db, userId);
    expect(after?.conversationId).not.toBeNull();
    const freshId = after!.conversationId!;
    expect(freshId).not.toBe(deletedId);

    const { status, detail } = await fetchConversation(freshId);
    expect(status).toBe(200);
    const texts = flattenedTexts(detail!);
    expect(texts.some((entry) => entry.role === 'user' && entry.text === TRANSCRIPT)).toBe(true);

    const persistFailed = journalLines
      .map((line) => JSON.parse(line) as { event: string })
      .filter((entry) => entry.event === 'v2.turn_persist_failed');
    expect(persistFailed).toHaveLength(0);
  }, 30000);

  it('rejects a wrong-secret upgrade with 401; a credential-less upgrade is accepted as unpaired', async () => {
    const before = countJournal('v2.connected');

    const wrongAuth = new SimDevice(wsUrl(), { auth: 'wrong-secret' });
    await expectRejection(wrongAuth, 401);

    expect(countJournal('v2.connected')).toBe(before);

    // T018: no header is a legitimate unpaired connection, not a refusal.
    const unpaired = new SimDevice(wsUrl());
    expect((await unpaired.open()).connected).toBe(true);
    unpaired.sendControl(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT }));
    const required = await unpaired.waitFor('pairing_required', 30000);
    expect(required.payload.reason).toBe('none');
    unpaired.close();
  }, 30000);

  it('limits concurrent sessions and rate-limits device upgrades', async () => {
    process.env.BOB_MAX_DEVICE_SESSIONS = '1';
    process.env.BOB_RATE_LIMIT_DEVICE_RPM = '3';
    const { createV2Server } = await import('../../src/server.ts');
    const limitsServer = (await createV2Server()).server;
    await new Promise<void>((resolve) => limitsServer.listen(0, '127.0.0.1', resolve));
    const limitsPort = (limitsServer.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${limitsPort}/v2/cardputer`;
    try {
      const first = new SimDevice(url, { auth: DEVICE_SECRET });
      expect((await first.open()).connected).toBe(true);

      // Second concurrent connect is refused for concurrency.
      const second = new SimDevice(url, { auth: DEVICE_SECRET });
      await expectRejection(second, 503);

      // Once the first closes, the slot is released and a new connect succeeds.
      const closedBefore = countJournal('v2.closed');
      first.close();
      await waitForJournalCount('v2.closed', closedBefore + 1);
      const third = new SimDevice(url, { auth: DEVICE_SECRET });
      expect((await third.open()).connected).toBe(true);

      // Rate budget (3 rpm) is now exhausted: the next upgrade is 429.
      const fourth = new SimDevice(url, { auth: DEVICE_SECRET });
      await expectRejection(fourth, 429);

      third.close();
    } finally {
      await new Promise<void>((resolve) => limitsServer.close(() => resolve()));
      delete process.env.BOB_MAX_DEVICE_SESSIONS;
      delete process.env.BOB_RATE_LIMIT_DEVICE_RPM;
    }
  }, 30000);

  it('terminates a pong-silent client and frees the session slot', async () => {
    process.env.BOB_WS_HEARTBEAT_MS = '100';
    process.env.BOB_MAX_DEVICE_SESSIONS = '1';
    const { createV2Server } = await import('../../src/server.ts');
    const heartbeatServer = (await createV2Server()).server;
    await new Promise<void>((resolve) => heartbeatServer.listen(0, '127.0.0.1', resolve));
    const heartbeatPort = (heartbeatServer.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${heartbeatPort}/v2/cardputer`;
    try {
      const journalStart = journalLines.length;
      const closedBefore = countJournal('v2.closed');
      const silent = new SimDevice(url, { auth: DEVICE_SECRET, autoPong: false });
      expect((await silent.open()).connected).toBe(true);

      // The server pings once, then a silent peer misses two consecutive ticks
      // before it is terminated (~300 ms at a 100 ms interval).
      await waitForJournalSince(journalStart, 'v2.heartbeat_timeout', 1, 10_000);
      await silent.waitForClose(1000);
      await waitForJournalSince(journalStart, 'v2.closed', 1);
      const timeoutEntry = journalEventSince<{ missed?: number }>(journalStart, 'v2.heartbeat_timeout');
      expect(timeoutEntry?.missed).toBeGreaterThanOrEqual(2);

      // The slot was released, so a fresh connect succeeds.
      const replacement = new SimDevice(url, { auth: DEVICE_SECRET });
      expect((await replacement.open()).connected).toBe(true);
      replacement.close();
    } finally {
      await new Promise<void>((resolve) => heartbeatServer.close(() => resolve()));
      delete process.env.BOB_WS_HEARTBEAT_MS;
      delete process.env.BOB_MAX_DEVICE_SESSIONS;
    }
  }, 30000);

  it('heartbeat never cuts off a streaming reply', async () => {
    process.env.BOB_WS_HEARTBEAT_MS = '20';
    process.env.BOB_SYSTEM_TEST_TTS_SECONDS = String(TTS_SECONDS);
    // PCM downlink is used (not MP3): the MP3 path sends a reply under the
    // 24 KB prime burst unpaced, so it reaches the peer in one ~2 ms batch and
    // would not span any heartbeat interval. PCM is paced at real time (#674),
    // so a 2 s reply streams over ~2 s on the wire: ~100 heartbeat intervals.
    const { createV2Server } = await import('../../src/server.ts');
    const hbServer = (await createV2Server()).server;
    await new Promise<void>((resolve) => hbServer.listen(0, '127.0.0.1', resolve));
    const hbPort = (hbServer.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${hbPort}/v2/cardputer`;
    const journalStart = journalLines.length;
    try {
      const device = new SimDevice(url, { auth: DEVICE_SECRET, autoPong: false });
      expect((await device.open()).connected).toBe(true);
      // A close (the heartbeat firing) fails the wait at once, not at 30 s.
      const unlessClosed = <T>(wait: Promise<T>): Promise<T> => Promise.race([
        wait,
        device.waitForClose(30000).then((): never => { throw new Error('the server closed the pong-less device'); }),
      ]);

      // This device never pongs, and any message it sends counts as alive. Out
      // of the 'responding' stage the heartbeat may cut it after two 20 ms
      // ticks, which a slow hello (store lookups) used to exceed, so setup
      // traffic keeps it alive: an unknown control, rejected without touching
      // the session. It stops before the reply streams, so the stream itself
      // is the silent, pong-less window this case is about.
      const keepAlive = setInterval(() => device.sendControl(controlDto('keepalive_probe')), 5);
      let silentFrom = 0;
      try {
        device.sendControl(controlDto('hello', { format_id: PCM16_16K_MONO_FORMAT }));
        await unlessClosed(device.waitFor('welcome', 30000));

        const turnRef = messageId('turn');
        device.sendControl(controlDto('turn_start', {}, { turn_ref: turnRef }));
        const frames = sinePcmFrames(320, 32);
        for (const frame of frames) device.sendAudioFrame(frame);
        device.sendControl(controlDto('turn_end', {}, { turn_ref: turnRef, seq: frames.length - 1 }));
        // reply_text goes out in the 'responding' stage, before playback_start (#318).
        await unlessClosed(device.waitFor('reply_text', 30000));
      } finally {
        clearInterval(keepAlive);
        silentFrom = Date.now();
      }

      await unlessClosed(Promise.all([device.waitFor('playback_start', 30000), device.waitFor('playback_end', 30000)]));

      // The stream must span several heartbeat intervals on the wire, with the
      // device already silent; otherwise this case would pass even if the
      // heartbeat terminated mid-stream, so the guard it tests could be removed
      // without failing it.
      const controls = device.controlEvents();
      const playbackStart = controls.find((entry) => entry.type === 'playback_start');
      const playbackEnd = controls.find((entry) => entry.type === 'playback_end');
      const streamMs = playbackEnd!.receivedAt - playbackStart!.receivedAt;
      expect(streamMs).toBeGreaterThanOrEqual(100);
      const silentStreamMs = playbackEnd!.receivedAt - Math.max(silentFrom, playbackStart!.receivedAt);
      expect(silentStreamMs).toBeGreaterThanOrEqual(100);

      const down = device.audioEvents();
      expect(down.length).toBeGreaterThan(0);
      for (let index = 0; index < down.length; index += 1) {
        expect(down[index]!.sequence).toBe(index);
        expect(down[index]!.formatId).toBe(PCM16_16K_MONO_FORMAT);
      }
      const total = down.reduce((sum, frame) => sum + frame.payload.length, 0);
      expect(down.length).toBe(Math.ceil(total / DOWNLINK_FRAME_BYTES));
      expect(countJournalSince(journalStart, 'v2.heartbeat_timeout')).toBe(0);

      // Now silent post-stream, the server terminates after 2 missed ticks.
      await waitForJournalSince(journalStart, 'v2.heartbeat_timeout', 1, 10_000);
      await device.waitForClose(1500);
      const timeoutEntry = journalEventSince<{ missed?: number }>(journalStart, 'v2.heartbeat_timeout');
      expect(timeoutEntry?.missed).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve) => hbServer.close(() => resolve()));
      delete process.env.BOB_WS_HEARTBEAT_MS;
      process.env.BOB_SYSTEM_TEST_TTS_SECONDS = String(TTS_SECONDS);
    }
  }, 30000);

  it('still requires a bearer token for /api', async () => {
    const response = await fetch(`${baseUrl}/api/conversations`);
    expect(response.status).toBe(401);
  }, 30000);

  describe('pairing, follow-me, and device push (e2e)', () => {
    let fresh: TestAccount;
    let freshToken: string;
    let paired: { token: string; deviceId: string; name: string } | null = null;
    let pinnedConversationId = '';
    let device: SimDevice;
    let revokedToken = '';

    it('P-28/D-11: first pairing code -> approve -> paired -> ready without a reboot; paired within 3 s', async () => {
      fresh = await addAccountSafe();
      freshToken = await mintActiveWebToken(fresh.userId);

      const unpaired = new SimDevice(wsUrl());
      expect((await unpaired.open()).connected).toBe(true);
      unpaired.sendControl(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT }));
      const required = await unpaired.waitFor('pairing_required', 30000);
      expect(required.payload.reason).toBe('none');

      unpaired.sendControl(controlDto('pair_request', { model: 'M5Stack Cardputer', fw_version: '0.9.0', claim: '4f1c2b3a9e8d7c6b5a4f3e2d1c0b9a8f' }));
      const pairCode = await unpaired.waitFor('pair_code', 30000);
      const userCode = pairCode.payload.user_code as string;
      const pairingId = pairCode.payload.pairing_id as string;
      expect(userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
      expect(pairCode.payload.expires_in).toBe(600);

      const lookup = await fetch(`${baseUrl}/api/pair/lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${freshToken}` },
        body: JSON.stringify({ user_code: userCode }),
      });
      expect(lookup.status).toBe(200);

      const approve = await fetch(`${baseUrl}/api/pair/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${freshToken}` },
        body: JSON.stringify({ pairing_id: pairingId, name: 'Test Card' }),
      });
      expect(approve.status).toBe(200);
      const approved = (await approve.json()) as { device_id: string; name: string };

      // D-11: `paired` reaches the waiting socket within 3 s of approval.
      const pairedDto = await unpaired.waitFor('paired', 3000);
      const payload = pairedDto.payload as { device_id: string; device_token: string; name: string };
      expect(payload.device_id).toBe(approved.device_id);
      expect(payload.name).toBe('Test Card');
      expect(payload.device_token).toMatch(/^olxd_[A-Za-z0-9_-]{43}$/);
      paired = { token: payload.device_token, deviceId: payload.device_id, name: payload.name };
      unpaired.close();

      // SC-002: reconnect with the stored token is ready immediately, no reboot.
      device = new SimDevice(wsUrl(), { auth: paired.token });
      expect((await device.open()).connected).toBe(true);
    }, 30000);

    it('a paired olxd_ token is answered welcome with device.name and active_conversation', async () => {
      const conversation = await createConversation(db, fresh.userId, 'welcome pointer');
      await withUser(db, fresh.userId, (tx) => setActive(tx, fresh.userId, conversation.id, 'activate'));
      device.sendControl(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT }));
      const welcome = await device.waitFor('welcome', 30000);
      expect(welcome.payload.device).toEqual({ id: paired!.deviceId, name: 'Test Card' });
      expect(welcome.payload.active_conversation).toEqual({ id: conversation.id, title: 'welcome pointer' });
    }, 30000);

    it('C-12/E-12: a picker select writes the pointer and pushes active_conversation within 3 s', async () => {
      const target = await createConversation(db, fresh.userId, 'picked from device');
      device.reset();
      device.sendControl(controlDto('select_conversation', { conversation_id: target.id }));
      const selected = await device.waitFor('conversation_selected', 30000);
      expect(selected.payload.conversation_id).toBe(target.id);

      const pushed = await device.waitFor('active_conversation', 3000);
      expect(pushed.payload).toEqual({ id: target.id, title: 'picked from device' });
      const active = await getActive(db, fresh.userId);
      expect(active?.conversationId).toBe(target.id);
      expect(active?.surface).toBe('picker');
      pinnedConversationId = target.id;
    }, 30000);

    it('E-13/P-24: a pointer change mid-turn is held and pushed only after playback_end', async () => {
      const held = await createConversation(db, fresh.userId, 'held target');
      device.reset();
      const journalStart = journalLines.length;
      const turnRef = messageId('turn');
      device.sendControl(controlDto('turn_start', {}, { turn_ref: turnRef }));
      const frames = sinePcmFrames(320, 32);
      for (const frame of frames) device.sendAudioFrame(frame);

      // Audio is handled after turn_start's awaited conversation lookup. Sending
      // turn_start alone does not prove the server has pinned this turn yet.
      await waitForJournalSince(journalStart, 'v2.audio_up', 1);

      // Pointer change while capturing: nothing may reach the device mid-turn.
      const activate = await fetch(`${baseUrl}/api/conversations/${held.id}/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${freshToken}` },
        body: JSON.stringify({}),
      });
      expect(activate.status).toBe(200);
      expect(device.controlEvents().filter((entry) => entry.type === 'active_conversation')).toHaveLength(0);

      const completedBefore = countJournal('v2.turn_completed');
      device.sendControl(controlDto('turn_end', {}, { turn_ref: turnRef, seq: frames.length - 1 }));
      await device.waitFor('playback_end', 30000);
      await waitForJournalCount('v2.turn_completed', completedBefore + 1);

      const pushed = await device.waitFor('active_conversation', 3000);
      const playbackEnd = device.controlEvents().find((entry) => entry.type === 'playback_end');
      const pushedEntry = device.controlEvents().find((entry) => entry.type === 'active_conversation');
      expect(pushedEntry!.receivedAt).toBeGreaterThanOrEqual(playbackEnd!.receivedAt);
      // The turn persisted into the pinned conversation; its own active.changed
      // is the latest held push, so the flush delivers that one.
      expect(pushed.payload.id).toBe(pinnedConversationId);
    }, 30000);

    it('E-17/P-31: deleting the active conversation pushes the null form; the next turn creates a fresh one', async () => {
      device.reset();
      const remove = await fetch(`${baseUrl}/api/conversations/${pinnedConversationId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${freshToken}` },
      });
      expect(remove.status).toBe(204);

      const nullPush = await device.waitFor('active_conversation', 3000);
      expect(nullPush.payload).toEqual({ id: null, title: null });

      const turn = await runVoiceTurn(device, messageId('turn'));
      expect(turn.downFrames).toBeGreaterThan(0);
      const after = await getActive(db, fresh.userId);
      expect(after?.conversationId).not.toBeNull();
      expect(after!.conversationId).not.toBe(pinnedConversationId);
    }, 30000);

    it('#302: new_conversation pushes the null form then acks; the next turn creates exactly one fresh conversation', async () => {
      device.reset();
      const previous = await getActive(db, fresh.userId);
      expect(previous?.conversationId).not.toBeNull();
      const countBefore = (await listConversations(db, fresh.userId)).length;

      device.sendControl(controlDto('new_conversation', { request_id: messageId('newc') }));
      const nullPush = await device.waitFor('active_conversation', 3000);
      expect(nullPush.payload).toEqual({ id: null, title: null });
      const cleared = await device.waitFor('conversation_cleared', 3000);
      const pushEntry = device.controlEvents().find((entry) => entry.type === 'active_conversation');
      const ackEntry = device.controlEvents().find((entry) => entry.type === 'conversation_cleared');
      expect(ackEntry!.receivedAt).toBeGreaterThanOrEqual(pushEntry!.receivedAt);
      expect(await getActive(db, fresh.userId)).toMatchObject({
        conversationId: null, surface: 'device', changedAt: cleared.payload.changed_at,
      });
      expect((await listConversations(db, fresh.userId)).length).toBe(countBefore);

      device.reset();
      const turn = await runVoiceTurn(device, messageId('turn'));
      expect(turn.downFrames).toBeGreaterThan(0);
      const after = await getActive(db, fresh.userId);
      expect(after?.conversationId).not.toBeNull();
      expect(after!.conversationId).not.toBe(previous!.conversationId);
      expect((await listConversations(db, fresh.userId)).length).toBe(countBefore + 1);
    }, 30000);

    it('C-16: two surfaces submit to one conversation near-simultaneously; both save in acceptance order', async () => {
      const w = await createConversation(db, fresh.userId, 'dual surface');
      await withUser(db, fresh.userId, (tx) => setActive(tx, fresh.userId, w.id, 'picker'));
      const webAppend = withUser(db, fresh.userId, async (tx) => {
        await appendMessage(tx, fresh.userId, w.id, {
          role: 'user',
          parts: [{ type: 'text', text: 'web surface turn' }],
          origin: 'web_text',
        });
      });
      const [turn] = await Promise.all([runVoiceTurn(device, messageId('turn')), webAppend]);
      expect(turn.downFrames).toBeGreaterThan(0);

      const response = await fetch(`${baseUrl}/api/conversations/${w.id}`, {
        headers: { authorization: `Bearer ${freshToken}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        messages: Array<{
          role: string;
          position: number;
          origin: string;
          versions: Array<{ selected: boolean; parts: Array<{ type?: string; text?: string }> }>;
        }>;
      };
      const userMessages = body.messages.filter((message) => message.role === 'user');
      expect(userMessages).toHaveLength(2);
      expect(userMessages.map((message) => message.position).sort()).toEqual([0, 1]);
      expect(userMessages.map((message) => message.origin).sort()).toEqual(['device', 'web_text']);
      const texts = userMessages.map((message) =>
        (message.versions.find((version) => version.selected)?.parts ?? [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join(' ')
          .trim(),
      );
      expect(texts).toContain('web surface turn');
      expect(texts).toContain(TRANSCRIPT);
    }, 30000);

    it('a revoked device token is answered pairing_required {reason: revoked}', async () => {
      await revokeDevice(db, fresh.userId, paired!.deviceId);
      device.close();
      await device.waitForClose(2000);

      const revoked = new SimDevice(wsUrl(), { auth: paired!.token });
      expect((await revoked.open()).connected).toBe(true);
      revoked.sendControl(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT }));
      const required = await revoked.waitFor('pairing_required', 30000);
      expect(required.payload.reason).toBe('revoked');
      revoked.close();
    }, 30000);

    it('E-11: account B\'s events never appear on account A\'s stream (e2e)', async () => {
      const devToken = await mintActiveWebToken(userId);
      const streamA = collectSseEventNamesFor(devToken, 500);
      const streamB = collectSseEventNamesFor(freshToken, 500);
      const conversation = await createConversation(db, fresh.userId, 'isolation');
      const activate = await fetch(`${baseUrl}/api/conversations/${conversation.id}/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${freshToken}` },
        body: JSON.stringify({}),
      });
      expect(activate.status).toBe(200);
      const [namesA, namesB] = await Promise.all([streamA, streamB]);
      expect(namesB).toContain('active.changed');
      expect(namesA).not.toContain('active.changed');
    }, 30000);

    it('P-18: DELETE /api/devices/:id revokes and closes the live socket with WS 4003 within 5 s', async () => {
      // A fresh pairing for the same account so this flow is independent of the
      // earlier paired device (already revoked by the store-level test above).
      const unpaired = new SimDevice(wsUrl());
      expect((await unpaired.open()).connected).toBe(true);
      unpaired.sendControl(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT }));
      await unpaired.waitFor('pairing_required', 30000);

      const claim = '6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e';
      unpaired.sendControl(controlDto('pair_request', { model: 'M5Stack Cardputer', fw_version: '0.9.0', claim }));
      const pairCode = await unpaired.waitFor('pair_code', 30000);
      const pairingId = pairCode.payload.pairing_id as string;

      const approve = await fetch(`${baseUrl}/api/pair/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${freshToken}` },
        body: JSON.stringify({ pairing_id: pairingId, name: 'Revoke target' }),
      });
      expect(approve.status).toBe(200);
      const paired = await unpaired.waitFor('paired', 3000);
      const payload = paired.payload as { device_id: string; device_token: string };
      revokedToken = payload.device_token;
      expect(payload.device_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      unpaired.close();

      // Connect with the token so the session registers, then revoke over the
      // web: the live socket must close with WS code 4003 within 5 s (SC-006).
      const live = await rawDevice(revokedToken);
      try {
        live.send(JSON.stringify(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT })));
        const welcome = await live.waitFor('welcome', 30000);
        expect((welcome.payload as { device?: { id: string } }).device?.id).toBe(payload.device_id);

        const del = await fetch(`${baseUrl}/api/devices/${payload.device_id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${freshToken}` },
        });
        expect(del.status).toBe(204);

        const outcome = await Promise.race([live.closed, delay(5000)]);
        expect(outcome).not.toBe('timeout');
        expect((outcome as { code: number }).code).toBe(4003);
      } finally {
        live.close();
      }
    }, 30000);

    it('P-19: a revoked token answers pairing_required {reason: revoked} on every reconnect', async () => {
      // SC-006: the revoked credential is refused on 100% of later attempts.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const revived = new SimDevice(wsUrl(), { auth: revokedToken });
        expect((await revived.open()).connected).toBe(true);
        revived.sendControl(controlDto('hello', { format_id: MP3_16K_MONO_FORMAT }));
        const required = await revived.waitFor('pairing_required', 30000);
        expect(required.payload.reason).toBe('revoked');
        revived.close();
      }
    }, 30000);
  });
});
