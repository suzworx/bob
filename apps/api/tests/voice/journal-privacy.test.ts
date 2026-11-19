/**
 * Journal privacy scan (T040, SC-008; P-27, A-17, D-25, E-16): runs a full
 * in-process 008 pairing/follow-me flow on Postgres in BOB_SYSTEM_TEST=1 and
 * proves no journal line leaks a credential (olxd_ token, JWT), a pairing code
 * (XXXX-XXXX or its 8 bare alphabet letters), a claim (32 lowercase hex), an
 * email ('@'), the account's raw uuid, or any transcript/agent text.
 *
 * T033 (DELETE /api/devices/:id revoke, close 4003, v2.device_revoked) is
 * exercised through the real devices router. Device, conversation and pairing
 * ids are opaque by design and may appear in the journal; only the ACCOUNT
 * uuid is asserted absent.
 *
 * Environment is set in vi.hoisted so BOB_SYSTEM_TEST is visible before
 * @bob/ai (and every module that transitively imports it) evaluates.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { setJournalSink } from '../../src/platform/logger.ts';
import {
  createDeviceAuthGuard,
  resetUnpairedSockets,
  type DeviceAuth,
} from '../../src/devices/device-auth.ts';
import { createSession, resetPairRequestBucket, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleBinary, handleControl } from '../../src/voice/session.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { webChat } from '../../src/conversations/chat-http.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import * as pairing from '../../src/devices/pairing-service.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import { activateConversationRoute } from '../../src/conversations/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { listConversations } from '../../src/conversations/store.ts';
import { createSpace } from '../../src/spaces/store.ts';
import {
  MP3_16K_MONO_FORMAT,
  PCM16_16K_MONO_FORMAT,
  V2_VERSION,
  serializeAudioFrame,
  type AudioFrameDto,
  type ClientControlDto,
} from '../../src/voice/protocol.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
vi.hoisted(() => {
  process.env.BOB_SYSTEM_TEST = '1';
});

const PRIVACY_TRANSCRIPT = 'privacy-scan-turn-one-secret';
const PRIVACY_EMAIL = 'privacy-scan@example.com';
const WRONG_CODE = 'WWWW-WWWW';
const PRIVACY_SPACE_NAME = 'Privacy Scan Space Name';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  bufferedAmount: number;
  _socket: { remoteAddress: string };
}

function makeSocket(ip = '203.0.113.1'): FakeSocket {
  return { readyState: 1, send: vi.fn(), close: vi.fn(), once: vi.fn(), bufferedAmount: 0, _socket: { remoteAddress: ip } };
}

function control(type: string, extra: Record<string, unknown> = {}): ClientControlDto {
  return { v: V2_VERSION, type, id: 'ctrl_test_000001', payload: {}, ...extra } as unknown as ClientControlDto;
}

function lastSent(socket: FakeSocket): Record<string, unknown> {
  const calls = socket.send.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls[calls.length - 1]![0] as string) as Record<string, unknown>;
}

function sentTypes(socket: FakeSocket): string[] {
  const types: string[] = [];
  for (const call of socket.send.mock.calls) {
    const raw = call[0] as string;
    if (typeof raw !== 'string' || !raw.startsWith('{')) continue;
    types.push((JSON.parse(raw) as { type: string }).type);
  }
  return types;
}

interface GuardRequest {
  get: (name: string) => string | undefined;
  socket: { remoteAddress: string; once: (event: string, handler: () => void) => void };
  deviceAuth?: DeviceAuth;
}

function guardRequest(auth: string | undefined, ip: string, closeHandlers: Array<() => void>): GuardRequest {
  return {
    get: (name: string): string | undefined => (name.toLowerCase() === 'authorization' ? auth : undefined),
    socket: {
      remoteAddress: ip,
      once: (event: string, handler: () => void): void => {
        if (event === 'close') closeHandlers.push(handler);
      },
    },
    deviceAuth: undefined,
  };
}

function wsResponse() {
  let rejected: { code?: number; message?: string } | null = null;
  return {
    reject(code?: number, message?: string): void {
      rejected = { code, message };
    },
    rejected: (): { code?: number; message?: string } | null => rejected,
  } as never;
}

function webResponse() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    writableEnded: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string): void {
      this.headers[name] = value;
    },
    write(chunk: Buffer | string): void {
      this.chunks.push(String(chunk));
    },
    end(): void {
      this.writableEnded = true;
    },
    json(body: unknown): void {
      this.chunks.push(JSON.stringify(body));
    },
    on(): never {
      throw new Error('not expected');
    },
  };
}

function audioUpFrame(sequence: number): Buffer {
  // 100 ms of PCM16 16 kHz; four (400 ms) clear the 300 ms turn.ts sends to STT.
  const payload = Buffer.alloc(3200);
  payload.writeInt16LE(800, 0);
  const frame: AudioFrameDto = {
    header: {
      magic: 'OLX2',
      version: V2_VERSION,
      kind: 'audio_up',
      formatId: PCM16_16K_MONO_FORMAT,
      channels: 1,
      turnHandle: 1,
      sequence,
      payloadBytes: payload.length,
    },
    payload,
  };
  return serializeAudioFrame(frame);
}

/** Opens an unpaired device socket through the real guard and runs pair_request. */
async function unpairedPair(
  ip: string,
): Promise<{ socket: FakeSocket; session: DeviceSession; code: string; bareCode: string; claim: string; pairingId: string }> {
  const closeHandlers: Array<() => void> = [];
  const request = guardRequest(undefined, ip, closeHandlers);
  const next = vi.fn();
  await createDeviceAuthGuard('device-secret', appDeps.getDb)(request as never, wsResponse(), next);
  expect(next).toHaveBeenCalledOnce();
  expect(request.deviceAuth).toEqual({ kind: 'unpaired', reason: 'none' });

  const socket = makeSocket(ip);
  const session = createSession(request.deviceAuth);
  await handleControl(appDeps, socket as unknown as WebSocket, session, control('hello', { payload: { format_id: PCM16_16K_MONO_FORMAT } }), vi.fn());
  expect(lastSent(socket)).toMatchObject({ type: 'pairing_required' });
  socket.send.mockClear();

  const claim = randomBytes(16).toString('hex');
  await handleControl(appDeps, 
    socket as unknown as WebSocket,
    session,
    control('pair_request', { payload: { model: 'M5Stack Cardputer', fw_version: '0.9.0', claim } }),
    vi.fn(),
  );
  const sent = lastSent(socket) as { type: string; payload: { pairing_id: string; user_code: string } };
  expect(sent.type).toBe('pair_code');
  const payload = sent.payload as { pairing_id: string; user_code: string };
  return { socket, session, code: payload.user_code, bareCode: payload.user_code.replace('-', ''), claim, pairingId: payload.pairing_id };
}

describe('journal privacy scan (T040, SC-008)', () => {
  let pg: TestDb;
  let db: Db;
  let account: TestAccount;
  let webToken: string;
  let server: Server;
  let baseUrl: string;
  const journalLines: string[] = [];

  beforeAll(async () => {
    process.env.BOB_SYSTEM_TEST_TRANSCRIPT = PRIVACY_TRANSCRIPT;
    process.env.BOB_SYSTEM_TEST_TTS_SECONDS = '1';
    pg = await createTestDb();
    db = asDb(pg);
    account = await addAccount(pg);
    setSharedDb(Promise.resolve(db));
    webToken = await signToken({ userId: account.userId, sessionId: account.sessionId });
    // The devices router (T033) over real HTTP so the DELETE revoke path and
    // its closeDevice(4003) run through the mounted route.
    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use(
      '/api/devices',
      createDevicesRouter({
        getDb: () => Promise.resolve(db),
        requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
        events: pairing.getAccountEvents(),
        deviceSessions: getDeviceSessions(),
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setJournalSink((line) => journalLines.push(line));
  });

  afterEach(() => {
    resetUnpairedSockets();
    resetPairRequestBucket();
  });

  afterAll(async () => {
    server.close();
    setJournalSink(null);
    getDeviceSessions().clear();
    delete process.env.BOB_SYSTEM_TEST;
    delete process.env.BOB_SYSTEM_TEST_TRANSCRIPT;
    delete process.env.BOB_SYSTEM_TEST_TTS_SECONDS;
    await closeDb().catch(() => undefined);
    await closeTestDb(pg).catch(() => undefined);
  });

  it(
    'exercises the full 008 flow and never leaks a credential, code, claim, email, account uuid, or text',
    async () => {
      // 1. Web chat turn (system-test stub journals nothing itself, but the
      //    route must run without leaking the message text or an email).
      const webRes = webResponse();
      await webChat(appDeps)(
        {
          body: {
            message: { id: 'msg_privacy_01', role: 'user', parts: [{ type: 'text', text: `privacy scan ${PRIVACY_EMAIL}` }] },
          },
          account: { userId: account.userId, sessionId: account.sessionId, exp: Math.floor(Date.now() / 1000) + 3600 },
        } as never,
        webRes as never,
      );
      expect(webRes.statusCode).toBe(200);
      expect(webRes.chunks.join('')).toContain('System test response');

      // 2. Rejected web auth: missing, invalid, and expired tokens.
      const guard = createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer }));
      for (const header of [undefined, 'Bearer not-a-jwt', `Bearer ${webToken.slice(0, 20)}`]) {
        const next = vi.fn();
        const res = webResponse();
        await guard({ get: () => header, path: '/api/chat', account: undefined } as never, res as never, next);
        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
      }
      const expired = await signToken({ userId: account.userId, sessionId: account.sessionId, expiresInSeconds: -60 });
      const nextExpired = vi.fn();
      const resExpired = webResponse();
      await guard(
        { get: () => `Bearer ${expired}`, path: '/api/chat', account: undefined } as never,
        resExpired as never,
        nextExpired,
      );
      expect(resExpired.statusCode).toBe(401);
      expect(nextExpired).not.toHaveBeenCalled();

      // 3. A device bearer that is neither olxd_ nor the legacy secret is refused.
      const badRes = wsResponse();
      await createDeviceAuthGuard('device-secret', appDeps.getDb)(
        guardRequest('Bearer not-a-device-token', '203.0.113.30', []) as never,
        badRes,
        vi.fn(),
      );
      expect((badRes as { rejected: () => { code?: number } | null }).rejected()?.code).toBe(401);

      // 4. A device connects unpaired and requests a code.
      const codes: string[] = [];
      const claims: string[] = [];
      const pair = await unpairedPair('203.0.113.10');
      codes.push(pair.code, pair.bareCode);
      claims.push(pair.claim);

      // 5. A wrong code lookup from the web.
      await expect(pairing.lookupCode(db, account.userId, WRONG_CODE, '198.51.100.1')).rejects.toThrow();

      // 6. Web approve -> the waiting socket receives `paired` with its token.
      const deviceId = await pairing.approve(db, account.userId, pair.pairingId, 'Kitchen');
      const paired = lastSent(pair.socket) as { type: string; payload: { device_token: string } };
      expect(paired.type).toBe('paired');
      const deviceToken = (paired.payload as { device_token: string }).device_token;
      expect(deviceToken.startsWith('olxd_')).toBe(true);

      // 7. Reconnect with the token, then run a real device turn.
      const reconnectHandlers: Array<() => void> = [];
      const reconnectReq = guardRequest(`Bearer ${deviceToken}`, '203.0.113.20', reconnectHandlers);
      const nextReconnect = vi.fn();
      await createDeviceAuthGuard('device-secret', appDeps.getDb)(reconnectReq as never, wsResponse(), nextReconnect);
      expect(nextReconnect).toHaveBeenCalledOnce();
      expect(reconnectReq.deviceAuth).toMatchObject({ kind: 'device', userId: account.userId, deviceId });

      const turnSocket = makeSocket('203.0.113.20');
      const turnSession = createSession(reconnectReq.deviceAuth);
      await handleControl(appDeps, turnSocket as unknown as WebSocket, turnSession, control('hello', { payload: { format_id: MP3_16K_MONO_FORMAT } }), vi.fn());
      expect(lastSent(turnSocket)).toMatchObject({ type: 'welcome' });
      turnSocket.send.mockClear();

      await handleControl(appDeps, turnSocket as unknown as WebSocket, turnSession, control('turn_start', { turn_ref: 'turn_privacy_01' }), vi.fn());
      handleBinary(appDeps, turnSocket as unknown as WebSocket, turnSession, audioUpFrame(0));
      handleBinary(appDeps, turnSocket as unknown as WebSocket, turnSession, audioUpFrame(1));
      handleBinary(appDeps, turnSocket as unknown as WebSocket, turnSession, audioUpFrame(2));
      handleBinary(appDeps, turnSocket as unknown as WebSocket, turnSession, audioUpFrame(3));
      // Wait on the turn itself, not a polled stage: runTurn resets the session
      // to 'ready' in its finally, so its settling IS the end of the turn. The
      // old vi.waitFor on the stage used the 1 s default, which a loaded
      // machine's full turn (STT, agent, TTS, paced downlink) outlasts.
      let turnDone: Promise<void> | undefined;
      await handleControl(appDeps,
        turnSocket as unknown as WebSocket,
        turnSession,
        control('turn_end', { turn_ref: 'turn_privacy_01', seq: 3 }),
        (session, turnRef): void => {
          turnDone = runTurn(appDeps.turn, turnSocket as unknown as WebSocket, session, turnRef);
        },
      );
      expect(turnDone).toBeDefined();
      await turnDone;
      expect(turnSession.stage).toBe('ready');

      // 8. Picker select on the account's conversation.
      const conversations = await listConversations(db, account.userId);
      expect(conversations.length).toBeGreaterThan(0);
      const targetId = conversations[0]!.id;
      await handleControl(appDeps, 
        turnSocket as unknown as WebSocket,
        turnSession,
        control('select_conversation', { payload: { conversation_id: targetId } }),
        vi.fn(),
      );
      expect(lastSent(turnSocket)).toMatchObject({ type: 'conversation_selected' });

      // 9. An active-pointer change is pushed to the registered device socket.
      const activateRes = webResponse();
      await activateConversationRoute(appDeps)(
        {
          params: { id: targetId },
          body: {},
          account: { userId: account.userId, sessionId: account.sessionId, exp: Math.floor(Date.now() / 1000) + 3600 },
        } as never,
        activateRes as never,
      );
      expect(activateRes.statusCode).toBe(200);
      expect(sentTypes(turnSocket)).toContain('active_conversation');

      // 9b. Space picker (#301): list and select a Space; its name must never
      //     be journaled (the journal keeps the count and surface only).
      const space = await createSpace(db, account.userId, { kind: 'group', name: PRIVACY_SPACE_NAME });
      await handleControl(appDeps, turnSocket as unknown as WebSocket, turnSession, control('list_spaces'), vi.fn());
      expect(lastSent(turnSocket)).toMatchObject({ type: 'spaces' });
      await handleControl(appDeps, 
        turnSocket as unknown as WebSocket,
        turnSession,
        control('select_space', { payload: { space_id: space.id } }),
        vi.fn(),
      );
      expect(lastSent(turnSocket)).toMatchObject({ type: 'space_selected', payload: { name: PRIVACY_SPACE_NAME } });

      // 10. Revoke the paired device via DELETE /api/devices/:id (T033): the
      //     live socket is closed with 4003, and a reconnect with the revoked
      //     olxd_ token is answered pairing_required {reason:'revoked'}.
      const revokeRes = await fetch(`${baseUrl}/api/devices/${deviceId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(revokeRes.status).toBe(204);
      expect(turnSocket.close).toHaveBeenCalledWith(4003, 'revoked');

      const revokedHandlers: Array<() => void> = [];
      const revokedReq = guardRequest(`Bearer ${deviceToken}`, '203.0.113.21', revokedHandlers);
      const nextRevoked = vi.fn();
      await createDeviceAuthGuard('device-secret', appDeps.getDb)(revokedReq as never, wsResponse(), nextRevoked);
      expect(nextRevoked).toHaveBeenCalledOnce();
      expect(revokedReq.deviceAuth).toEqual({ kind: 'unpaired', reason: 'revoked' });

      const revokedSocket = makeSocket('203.0.113.21');
      const revokedSession = createSession(revokedReq.deviceAuth);
      await handleControl(appDeps, revokedSocket as unknown as WebSocket, revokedSession, control('hello', { payload: { format_id: PCM16_16K_MONO_FORMAT } }), vi.fn());
      expect(lastSent(revokedSocket)).toMatchObject({ type: 'pairing_required', payload: { reason: 'revoked' } });

      // 11. A deny of a fresh pairing.
      const denyPair = await unpairedPair('203.0.113.11');
      codes.push(denyPair.code, denyPair.bareCode);
      claims.push(denyPair.claim);
      await pairing.deny(db, account.userId, denyPair.pairingId);

      // --- scan ---
      const joined = journalLines.join('\n');
      const events = new Set(journalLines.map((line) => (JSON.parse(line) as { event: string }).event));

      // The flow is real, not vacuous: each expected event appeared.
      for (const event of [
        'v2.auth_rejected',
        'v2.device_refused',
        'v2.device_authenticated',
        'v2.device_revoked',
        'v2.pair_issued',
        'v2.pair_rejected',
        'v2.pair_approved',
        'v2.pair_delivered',
        'v2.pair_denied',
        'v2.pairing_required',
        'v2.turn_completed',
        'v2.active_changed',
        'v2.space_listed',
        'v2.active_space_changed',
      ]) {
        expect(events.has(event), `expected ${event} to be journaled`).toBe(true);
      }

      // No credential, code, claim, JWT, email, account uuid, or text.
      expect(joined).not.toContain('olxd_');
      expect(joined).not.toContain(deviceToken);
      for (const code of codes) {
        expect(joined).not.toContain(code);
      }
      for (const claim of claims) {
        expect(joined).not.toContain(claim);
      }
      expect(joined).not.toContain(WRONG_CODE);
      expect(joined).not.toContain('eyJ');
      expect(joined).not.toContain('@');
      expect(joined).not.toContain(account.userId);
      expect(joined).not.toContain(PRIVACY_TRANSCRIPT);
      expect(joined).not.toContain('System test response');
      expect(joined).not.toContain(PRIVACY_EMAIL);
      expect(joined).not.toContain(PRIVACY_SPACE_NAME);

      // #396: the AI-stub device turn is marked stub and carries no model, and
      // every usage / timing / section-size field is a number, a boolean or an
      // allow-listed string (model id, tool names, finish-reason enum).
      const entries = journalLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const agentDone = entries.find((entry) => entry.event === 'v2.turn_stage_agent_completed' && entry.interface === 'cardputer');
      expect(agentDone).toMatchObject({ stub: true, turn_id: 'turn_privacy_01', steps: 0, tool_calls: 0 });
      expect(agentDone).not.toHaveProperty('model');
      expect(entries.find((entry) => entry.event === 'v2.turn_completed')).toMatchObject({ turn_id: 'turn_privacy_01' });
      const numeric = [
        'input_tokens', 'output_tokens', 'tokens', 'cached_input_tokens', 'cache_write_tokens', 'reasoning_tokens',
        'steps', 'tool_calls', 'prep_ms', 'model_ms', 'first_token_ms', 'context_ms', 'space_ms', 'since_prev_turn_ms',
        'first_audio_ms', 'tool_count', 'tools_chars', 'instructions_chars', 'memory_chars', 'context_chars',
        'history_messages', 'history_chars', 'history_attachment_bytes', 'extract_input_tokens', 'extract_output_tokens', 'extract_ms',
      ];
      const allowListed: Record<string, RegExp> = {
        model: /^[A-Za-z0-9._:/@-]+$/,
        extract_model: /^[A-Za-z0-9._:/@-]+$/,
        provider: /^[A-Za-z0-9._-]+$/,
        called_tools: /^[A-Za-z0-9_,-]*$/,
        finish_reason: /^(stop|length|content-filter|tool-calls|error|other)$/,
      };
      for (const entry of entries) {
        for (const key of numeric) {
          if (key in entry) expect(typeof entry[key], `${String(entry.event)}.${key}`).toBe('number');
        }
        for (const [key, pattern] of Object.entries(allowListed)) {
          if (key in entry) expect(entry[key], `${String(entry.event)}.${key}`).toMatch(pattern);
        }
        if ('stub' in entry) expect(entry.stub).toBe(true);
      }
    },
    30_000,
    );
});
// Epic #311: every new journal line (device_state, device_control, announce_*,
// the announcement player) carries kinds, counts and ids only -- never a timer
// label, a reminder title/body, its speech, or the account's uuid. reply_text
// rides every runTurn above, whose PRIVACY_TRANSCRIPT assertion covers it.
describe('journal privacy: device control and announcements (#311)', () => {
  it('journals no announcement text, label or account id', async () => {
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    try {
      const userId = '7d0c7a3e-1111-4c1e-9d2a-5b8f0e6a9c01';
      const socket = { readyState: 1, send: vi.fn(), once: vi.fn() };
      const session = createSession({ kind: 'legacy', userId } as DeviceAuth);
      session.stage = 'ready';
      getDeviceSessions().register(socket as unknown as WebSocket, session, userId, null);
      const control = (type: string, payload: Record<string, unknown>): ClientControlDto =>
        ({ v: V2_VERSION, type, id: 'privacy_ctrl_01', payload }) as unknown as ClientControlDto;
      await handleControl(appDeps, socket as unknown as WebSocket, session, control('device_state', {
        volume: 3, muted: false, mode: 'ptt', dnd: false, battery_pct: 40, charging: null, fw_version: 'fw-Quixotic',
      }), vi.fn());
      getDeviceSessions().sendDeviceControl(userId, null, { volume: 4 });
      getDeviceSessions().announce(userId, {
        announce_id: 'rm_privacy_0001', kind: 'reminder', title: 'Quixotic title', body: 'Quixotic body',
        ring: false, expires_at: Date.now() + 60_000, speech: 'Reminder: Quixotic speech',
      });
      getDeviceSessions().announce(userId, {
        announce_id: 'tm_privacy_0001', kind: 'timer', title: 'Quixotic label', body: '', ring: true, expires_at: Date.now() + 60_000,
      });
      await handleControl(appDeps, socket as unknown as WebSocket, session, control('announce_ack', { announce_id: 'rm_privacy_0001', action: 'played' }), vi.fn());
      const joined = lines.join('\n');
      expect(joined).toContain('v2.announce_sent');
      expect(joined).toContain('v2.device_control');
      expect(joined).not.toContain('Quixotic');
      expect(joined).not.toContain(userId);
      getDeviceSessions().unregister(session);
    } finally {
      setJournalSink(null);
    }
  });
});
