// #757 contract lock (U1): the active-conversation pointer, the active-space
// pointer and the game settings as they behave today, before the three tables
// move into bob.user_state. Real stores and routers over the test database,
// volatile ids and times normalised, every result snapshotted (HTTP with its
// exact status). Later #757 units must leave the .snap byte-identical.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// AI-stub mode as core-invocations-stub.test.ts: no real model call anywhere.
vi.mock('@bob/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  AI_STUB_MODE: true,
}));

import { createAppDeps } from '../../src/app-deps.ts';
import { closeDb, setSharedDb, StoreError, withUser, type Db } from '../../src/platform/db/db.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import * as pairing from '../../src/devices/pairing-service.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import { createThreadsRouter } from '../../src/spaces/threads-http.ts';
import { addMember, archiveSpace, createSpace, ensurePrivateSpace } from '../../src/spaces/store.ts';
import { clearActiveSpaceIf, getActiveSpace, setActiveSpace } from '../../src/spaces/active.ts';
import {
  clearActiveThread, clearActiveThreadInSpace, getActive, setActive, type ActiveSurface,
} from '../../src/conversations/active.ts';
import { activateConversationRoute, deleteConversationRoute, getActiveRoute } from '../../src/conversations/http.ts';
import { createConversation, deleteConversation } from '../../src/conversations/store.ts';
import { getGameSettings, upsertGameSettings } from '../../src/voice/games-store.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { readAccountExport } from '../../src/account/export-http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const appDeps = createAppDeps();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

let ids = new Map<string, string>();
beforeEach(() => {
  ids = new Map();
});

/** One stable placeholder per distinct id, numbered in order of first sight within a test. */
function stable(raw: string, kind: string): string {
  const key = raw.toLowerCase();
  if (!ids.has(key)) ids.set(key, `<${kind}-${ids.size + 1}>`);
  return ids.get(key)!;
}

function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    if (UUID.test(value)) return stable(value, 'uuid');
    if (ISO.test(value)) return '<iso>';
    // thr_ and bob: refs wrap a uuid; the prefix is contract, the uuid is not.
    const prefixed = /^([a-z]+[_:])(.+)$/.exec(value);
    if (prefixed && UUID.test(prefixed[2]!)) return `${prefixed[1]}${stable(prefixed[2]!, 'uuid')}`;
    if (/^cnv_[A-Za-z0-9_-]+$/.test(value)) return `cnv_${stable(value, 'cnv')}`;
    return value;
  }
  if (typeof value === 'number' && value > 1e12) return '<epoch-ms>';
  if (value instanceof Date) return '<date>';
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalize(inner)]));
  }
  return value;
}

/** A resolved value, or the error's class name (plus code/message where stable), normalised. */
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: normalize(await run()) };
  } catch (error) {
    const e = error as Error & { code?: unknown };
    if (error instanceof StoreError) return { error: { class: e.constructor.name, message: e.message } };
    // Driver error classes vary; the SQLSTATE is the contract.
    return { error: { code: e.code ?? null } };
  }
}

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;

type User = { userId: string; token: string };

async function account(): Promise<User> {
  const a = await addAccount(pg);
  return { userId: a.userId, token: await signToken({ userId: a.userId, sessionId: a.sessionId }) };
}

let ipSeq = 9;
let pairedSequence = 0;
/** Pairs a Cardputer to the account; `online` registers a live socket for it. */
async function pairDevice(user: User, online: boolean): Promise<void> {
  const issued = await pairing.issueCode(db, {
    model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: `203.0.113.${ipSeq++}`,
  });
  const deviceId = await pairing.approve(db, user.userId, issued.pairingId, 'Desk');
  // The contract expects newest-paired first; wall-clock timestamps cannot
  // establish fixture order reliably when the database clock moves or ties.
  const pairedAt = new Date(Date.UTC(2025, 0, 1) + ++pairedSequence * 1000).toISOString();
  const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
  await withAdmin(url, (sql) => sql.unsafe(
    'update bob.devices set paired_at = $1::timestamptz where id = $2::uuid', [pairedAt, deviceId],
  ));
  if (!online) return;
  const socket = { readyState: 1, close: (): void => {}, send: (): void => {} };
  getDeviceSessions().register(socket as unknown as WebSocket, { id: `sess-${deviceId}`, stage: 'ready' }, user.userId, deviceId);
}

async function send(method: string, path: string, user: User, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${user.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Asserts the exact status and normalises the body (204 has none). */
async function contract(res: Response, status: number): Promise<{ status: number; body: unknown }> {
  const text = await res.text();
  const body = text === '' ? null : (JSON.parse(text) as unknown);
  expect({ status: res.status, body }).toMatchObject({ status });
  return { status: res.status, body: normalize(body) };
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
  const getDb = (): Promise<Db> => Promise.resolve(db);
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.get('/api/active', getActiveRoute(appDeps));
  app.delete('/api/conversations/:id', deleteConversationRoute(appDeps));
  app.post('/api/conversations/:id/activate', activateConversationRoute(appDeps));
  app.use('/api/devices', createDevicesRouter({
    getDb, requireActiveSession: requireActiveSession(getDb), events: pairing.getAccountEvents(), deviceSessions: getDeviceSessions(),
  }));
  app.use('/api', createThreadsRouter({ getDb, events: { publish: () => undefined } }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  getDeviceSessions().clear();
  server?.close();
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

const asUser = <T>(user: User, run: (tx: Db) => Promise<T>): Promise<T> => withUser(db, user.userId, run);

/** A shared (group) space owned by `owner`, with `members` added. */
async function sharedSpace(owner: User, name: string, ...members: User[]): Promise<string> {
  const id = (await createSpace(db, owner.userId, { kind: 'group', name })).id;
  for (const m of members) await addMember(db, owner.userId, id, m.userId, 'member');
  return id;
}

async function newThread(owner: User, space: string, title: string): Promise<string> {
  const res = await send('POST', `/api/spaces/${space}/threads`, owner, { title });
  return ((await res.json()) as { id: string }).id;
}

const SURFACES: ActiveSurface[] = ['web_text', 'web_voice', 'device', 'picker', 'activate'];

describe('conversations/active.ts', () => {
  it('no row, then a pointer set from every surface', async () => {
    const a = await account();
    const conversation = await createConversation(db, a.userId, 'Kitchen');
    const seen: Record<string, unknown> = { none: await outcome(() => getActive(db, a.userId)) };
    for (const surface of SURFACES) {
      seen[`set ${surface}`] = await outcome(() => asUser(a, (tx) => setActive(tx, a.userId, conversation.id, surface)));
      seen[`get after ${surface}`] = await outcome(() => getActive(db, a.userId));
    }
    expect(seen).toMatchSnapshot('active conversation: no row, then each surface');
  });

  it('refs: unknown cnv_, malformed, thread, foreign thread; clear; delete sets null', async () => {
    const a = await account();
    const b = await account();
    const space = await sharedSpace(a, 'Family');
    const thread = await newThread(a, space, 'Weekend');
    const conversation = await createConversation(db, a.userId, 'Notes');
    const seen: Record<string, unknown> = {};
    const set = (u: User, ref: string | null, surface: ActiveSurface): Promise<unknown> =>
      outcome(() => asUser(u, (tx) => setActive(tx, u.userId, ref, surface)));
    seen['set unknown cnv_'] = await set(a, 'cnv_doesnotexist', 'picker');
    seen['set malformed'] = await set(a, 'thr_not-a-uuid', 'picker');
    seen['set thread'] = await set(a, `thr_${thread}`, 'device');
    seen['get thread'] = await outcome(() => getActive(db, a.userId));
    seen['b sets a thread'] = await set(b, `thr_${thread}`, 'device');
    seen['b get'] = await outcome(() => getActive(db, b.userId));
    seen['clear'] = await set(a, null, 'picker');
    seen['get cleared'] = await outcome(() => getActive(db, a.userId));
    seen['set conversation'] = await set(a, conversation.id, 'web_voice');
    await deleteConversation(db, a.userId, conversation.id);
    seen['get after conversation deleted'] = await outcome(() => getActive(db, a.userId));
    expect(seen).toMatchSnapshot('active conversation: refs, clear, delete');
  });

  it('clearActiveThread and clearActiveThreadInSpace, archived space', async () => {
    const a = await account();
    const space = await sharedSpace(a, 'Chores');
    const other = await sharedSpace(a, 'Trips');
    const thread = await newThread(a, space, 'Rota');
    const conversation = await createConversation(db, a.userId, 'Private');
    const seen: Record<string, unknown> = {};
    const point = (ref: string): Promise<unknown> => asUser(a, (tx) => setActive(tx, a.userId, ref, 'device'));
    seen['bad uuid thread'] = await outcome(() => clearActiveThread(db, a.userId, 'nope'));
    seen['bad uuid space'] = await outcome(() => clearActiveThreadInSpace(db, a.userId, 'nope'));
    seen['no row thread'] = await outcome(() => clearActiveThread(db, a.userId, thread));
    await point(conversation.id);
    seen['pointer is a conversation: clearActiveThread'] = await outcome(() => clearActiveThread(db, a.userId, thread));
    seen['pointer is a conversation: in space'] = await outcome(() => clearActiveThreadInSpace(db, a.userId, space));
    await point(`thr_${thread}`);
    seen['other space'] = await outcome(() => clearActiveThreadInSpace(db, a.userId, other));
    seen['still thread'] = await outcome(() => getActive(db, a.userId));
    seen['clearActiveThread'] = await outcome(() => clearActiveThread(db, a.userId, thread));
    seen['after clearActiveThread'] = await outcome(() => getActive(db, a.userId));
    await point(`thr_${thread}`);
    seen['clearActiveThreadInSpace'] = await outcome(() => clearActiveThreadInSpace(db, a.userId, space));
    seen['after clearActiveThreadInSpace'] = await outcome(() => getActive(db, a.userId));
    await point(`thr_${thread}`);
    await archiveSpace(db, a.userId, space);
    seen['get after space archived'] = await outcome(() => getActive(db, a.userId));
    seen['get again'] = await outcome(() => getActive(db, a.userId));
    expect(seen).toMatchSnapshot('active conversation: clear helpers and archive');
  });
});

describe('collaboration/spaces/active.ts', () => {
  it('no row, private, shared, refused, cleared', async () => {
    const a = await account();
    const b = await account();
    const priv = (await ensurePrivateSpace(db, a.userId)).id;
    const shared = await sharedSpace(a, 'Family', b);
    const mine = await sharedSpace(b, 'Book club');
    const seen: Record<string, unknown> = {};
    const set = (u: User, id: string | null, surface: 'web' | 'device'): Promise<unknown> =>
      outcome(() => asUser(u, (tx) => setActiveSpace(tx, u.userId, id, surface)));
    seen['none'] = await outcome(() => getActiveSpace(db, a.userId));
    seen['set private'] = await set(a, priv, 'web');
    seen['get private'] = await outcome(() => getActiveSpace(db, a.userId));
    seen['set shared (device)'] = await set(a, shared, 'device');
    seen['get shared'] = await outcome(() => getActiveSpace(db, a.userId));
    seen['set space a is not in'] = await set(a, mine, 'web');
    seen['set unknown uuid'] = await set(a, randomUUID(), 'web');
    seen['set malformed'] = await set(a, 'not-a-uuid', 'web');
    seen['get after refusals'] = await outcome(() => getActiveSpace(db, a.userId));
    seen['clearIf bad uuid'] = await outcome(() => clearActiveSpaceIf(db, a.userId, 'nope'));
    seen['clearIf other space'] = await outcome(() => clearActiveSpaceIf(db, a.userId, priv));
    seen['clearIf this space'] = await outcome(() => clearActiveSpaceIf(db, a.userId, shared));
    seen['get after clearIf'] = await outcome(() => getActiveSpace(db, a.userId));
    seen['set null'] = await set(a, null, 'web');
    seen['get cleared'] = await outcome(() => getActiveSpace(db, a.userId));
    seen['b get'] = await outcome(() => getActiveSpace(db, b.userId));
    expect(seen).toMatchSnapshot('active space: module');
  });

  it('a stale pointer (archived space) is nulled on read', async () => {
    const a = await account();
    const space = await sharedSpace(a, 'Temporary');
    await asUser(a, (tx) => setActiveSpace(tx, a.userId, space, 'web'));
    await archiveSpace(db, a.userId, space);
    const seen = {
      first: await outcome(() => getActiveSpace(db, a.userId)),
      second: await outcome(() => getActiveSpace(db, a.userId)),
    };
    expect(seen).toMatchSnapshot('active space: archived');
  });
});

describe('voice/games-store.ts game settings', () => {
  it('defaults, then every field non-default, partial patch, dedupe, quiet hours reset', async () => {
    const a = await account();
    const seen: Record<string, unknown> = {};
    seen['defaults'] = await outcome(() => getGameSettings(db, a.userId));
    seen['upsert all fields'] = await outcome(() => upsertGameSettings(db, a.userId, {
      enabled: false, kidsMode: false, maxBand: 'grown', allowedGames: ['simon_says', 'family_quiz', 'simon_says'],
      dailyLimitMinutes: 600, quietHours: { start: '21:30', end: '07:00' },
    }));
    seen['get'] = await outcome(() => getGameSettings(db, a.userId));
    seen['patch one field'] = await outcome(() => upsertGameSettings(db, a.userId, { maxBand: 'little', dailyLimitMinutes: 1 }));
    seen['quiet hours back to null'] = await outcome(() => upsertGameSettings(db, a.userId, { quietHours: null }));
    seen['empty allowedGames'] = await outcome(() => upsertGameSettings(db, a.userId, { allowedGames: [] }));
    seen['empty patch'] = await outcome(() => upsertGameSettings(db, a.userId, {}));
    expect(seen).toMatchSnapshot('game settings: defaults and upserts');
  });

  it('rejects: schema paths through upsert, check constraints through SQL', async () => {
    const a = await account();
    const bad = (patch: unknown): Promise<unknown> =>
      outcome(() => upsertGameSettings(db, a.userId, patch as Parameters<typeof upsertGameSettings>[2]));
    const seen: Record<string, unknown> = {
      'band': await bad({ maxBand: 'adult' }),
      'game id': await bad({ allowedGames: ['chess'] }),
      'limit 0': await bad({ dailyLimitMinutes: 0 }),
      'limit 601': await bad({ dailyLimitMinutes: 601 }),
      'limit fraction': await bad({ dailyLimitMinutes: 1.5 }),
      'quiet clock': await bad({ quietHours: { start: '24:00', end: '07:00' } }),
      'unknown key': await bad({ nickname: 'x' }),
      'after rejects, still defaults': await outcome(() => getGameSettings(db, a.userId)),
    };
    const insert = (column: string, value: unknown, withEnd = false): Promise<unknown> =>
      outcome(() => asUser(a, (tx) => tx.query(
        `INSERT INTO bob.user_state (user_id, games_${column}${withEnd ? ', games_quiet_end' : ''}) VALUES ($1, $2${withEnd ? ", '07:00'" : ''})`,
        [a.userId, value],
      )));
    seen['sql max_band'] = await insert('max_band', 'adult');
    seen['sql allowed_games'] = await outcome(() => asUser(a, (tx) => tx.query(
      'INSERT INTO bob.user_state (user_id, games_allowed_games) VALUES ($1, $2::text[])', [a.userId, ['chess']],
    )));
    seen['sql daily 0'] = await insert('daily_limit_minutes', 0);
    seen['sql daily 601'] = await insert('daily_limit_minutes', 601);
    seen['sql quiet_start format'] = await insert('quiet_start', '9pm', true);
    seen['sql quiet_start without quiet_end'] = await insert('quiet_start', '21:00');
    expect(seen).toMatchSnapshot('game settings: rejects');
  });
});

describe('HTTP pointer routes', () => {
  it('GET /api/active, POST activate, DELETE conversation', async () => {
    const a = await account();
    const b = await account();
    const conversation = await createConversation(db, a.userId, 'Garden');
    const activate = (u: User, id: string, body: unknown = {}): Promise<Response> =>
      send('POST', `/api/conversations/${id}/activate`, u, body);
    const seen: Record<string, unknown> = {};
    seen['GET active, no pointer'] = await contract(await send('GET', '/api/active', a), 200);
    seen['activate, bad body'] = await contract(await activate(a, conversation.id, { surface: 'device' }), 400);
    seen['activate, foreign'] = await contract(await activate(b, conversation.id), 404);
    seen['activate, unknown'] = await contract(await activate(a, 'cnv_doesnotexist'), 404);
    seen['activate'] = await contract(await activate(a, conversation.id), 200);
    seen['GET active'] = await contract(await send('GET', '/api/active', a), 200);
    seen['GET active, b'] = await contract(await send('GET', '/api/active', b), 200);
    seen['DELETE foreign'] = await contract(await send('DELETE', `/api/conversations/${conversation.id}`, b), 204);
    seen['GET active after foreign delete'] = await contract(await send('GET', '/api/active', a), 200);
    seen['DELETE active conversation'] = await contract(await send('DELETE', `/api/conversations/${conversation.id}`, a), 204);
    seen['GET active after delete'] = await contract(await send('GET', '/api/active', a), 200);
    expect(seen).toMatchSnapshot('HTTP: active, activate, delete');
  });

  it('PUT /api/devices/active-space and GET /api/devices', async () => {
    const a = await account();
    const b = await account();
    const shared = await sharedSpace(a, 'Family');
    const foreign = await sharedSpace(b, 'Book club');
    const put = (body: unknown): Promise<Response> => send('PUT', '/api/devices/active-space', a, body);
    const seen: Record<string, unknown> = {};
    seen['GET devices, none'] = await contract(await send('GET', '/api/devices', a), 200);
    seen['PUT space'] = await contract(await put({ space_id: shared }), 200);
    seen['GET devices'] = await contract(await send('GET', '/api/devices', a), 200);
    seen['PUT null'] = await contract(await put({ space_id: null }), 200);
    seen['PUT bad uuid'] = await contract(await put({ space_id: 'x' }), 400);
    seen['PUT extra key'] = await contract(await put({ space_id: shared, name: 'x' }), 400);
    seen['PUT foreign space'] = await contract(await put({ space_id: foreign }), 404);
    seen['PUT unknown space'] = await contract(await put({ space_id: randomUUID() }), 404);
    seen['GET devices after refusals'] = await contract(await send('GET', '/api/devices', a), 200);
    expect(seen).toMatchSnapshot('HTTP: active-space');
  });

  it('PUT /api/devices/active-conversation: 409, 202, 200, 400, 404', async () => {
    const c = await account();
    const b = await account();
    const shared = await sharedSpace(c, 'Home');
    const other = await sharedSpace(c, 'Work');
    const thread = await newThread(c, shared, 'Rota');
    const mine = await createConversation(db, c.userId, 'Notes');
    const theirs = await createConversation(db, b.userId, 'Secret');
    const put = (body: unknown): Promise<Response> => send('PUT', '/api/devices/active-conversation', c, body);
    const seen: Record<string, unknown> = {};
    seen['no device'] = await contract(await put({ conversation_id: mine.id, space_id: null }), 409);
    await pairDevice(c, false);
    seen['device offline'] = await contract(await put({ conversation_id: mine.id, space_id: null }), 202);
    seen['GET active (offline write)'] = await contract(await send('GET', '/api/active', c), 200);
    await pairDevice(c, true);
    seen['conversation and space'] = await contract(await put({ conversation_id: mine.id, space_id: shared }), 200);
    seen['thread'] = await contract(await put({ conversation_id: null, space_id: shared, thread_id: thread }), 200);
    seen['GET active (thread)'] = await contract(await send('GET', '/api/active', c), 200);
    seen['clear both'] = await contract(await put({ conversation_id: null, space_id: null }), 200);
    seen['GET active (cleared)'] = await contract(await send('GET', '/api/active', c), 200);
    seen['thread in another space'] = await contract(await put({ conversation_id: null, space_id: other, thread_id: thread }), 400);
    seen['thread with a conversation id'] = await contract(await put({ conversation_id: mine.id, space_id: shared, thread_id: thread }), 400);
    seen['missing space_id'] = await contract(await put({ conversation_id: mine.id }), 400);
    seen['foreign conversation'] = await contract(await put({ conversation_id: theirs.id, space_id: null }), 404);
    seen['foreign space'] = await contract(await put({ conversation_id: null, space_id: (await sharedSpace(b, 'B')) }), 404);
    seen['unknown thread'] = await contract(await put({ conversation_id: null, space_id: shared, thread_id: randomUUID() }), 404);
    seen['GET devices'] = await contract(await send('GET', '/api/devices', c), 200);
    expect(seen).toMatchSnapshot('HTTP: active-conversation');
  });
});

describe('web export and two-account isolation', () => {
  const sections = async (u: User): Promise<unknown> => {
    const data = await readAccountExport(db, u.userId);
    return normalize({ sections: Object.keys(data), game_settings: data.game_settings });
  };

  it('export sections with no rows and with rows', async () => {
    const a = await account();
    const space = await sharedSpace(a, 'Export');
    const seen: Record<string, unknown> = { empty: await sections(a) };
    await asUser(a, (tx) => setActiveSpace(tx, a.userId, space, 'web'));
    await upsertGameSettings(db, a.userId, { kidsMode: false, maxBand: 'grown', quietHours: { start: '22:00', end: '06:30' } });
    seen['with rows'] = await sections(a);
    expect(seen).toMatchSnapshot('export: game_settings and absent active sections');
  });

  it('account B never sees account A pointers or settings', async () => {
    const a = await account();
    const b = await account();
    const space = await sharedSpace(a, 'Private to A');
    const conversation = await createConversation(db, a.userId, 'A notes');
    await asUser(a, (tx) => setActive(tx, a.userId, conversation.id, 'device'));
    await asUser(a, (tx) => setActiveSpace(tx, a.userId, space, 'web'));
    await upsertGameSettings(db, a.userId, { enabled: false, dailyLimitMinutes: 5 });
    const seen = {
      active: await outcome(() => getActive(db, b.userId)),
      activeSpace: await outcome(() => getActiveSpace(db, b.userId)),
      settings: await outcome(() => getGameSettings(db, b.userId)),
      export: await sections(b),
      'GET /api/active': await contract(await send('GET', '/api/active', b), 200),
      'GET /api/devices': await contract(await send('GET', '/api/devices', b), 200),
    };
    expect(seen).toMatchSnapshot('isolation: account B sees nothing of A');
  });
});
