// Active-conversation pointer store (T028, specs/008-supabase-auth-pairing).
// Covers the pointer upsert/read round-trip, the FK on-delete-set-null clear,
// cross-account isolation, the bob_server guard-role run, and the web_voice
// pointer write on an accepted POST /api/voice turn.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  transcribeAudio: vi.fn(async () => ({ text: 'hello' })),
  synthesizeSpeech: vi.fn(async () => ({ audio: Buffer.from('mp3').toString('base64'), format: 'mp3', contentType: 'audio/mpeg' })),
  capSpeechInput: vi.fn((text: string) => text),
  providerErrorStatus: () => undefined,
  isProviderError: (error: unknown) =>
    error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || /fetch failed|timeout/i.test(error.message)),
}) ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

import { webVoice } from '../../src/voice/http.ts';
import { clearActiveThreadInSpace, getActive, setActive } from '../../src/conversations/active.ts';
import { parseDeviceRef, THREAD_REF_PREFIX, threadRef } from '../../src/devices/conversation-ref.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { archiveThread, createThread } from '../../src/conversations/thread-store.ts';
import { createConversation, deleteConversation, listConversations } from '../../src/conversations/store.ts';
import { closeDb, setSharedDb, StoreNotFoundError, withUser, type Db } from '../../src/platform/db/db.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  withUserRaw,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
    },
  };
}

describe('active-conversation store', () => {
  let pg: TestDb;
  let db: Db;
  let accountA: TestAccount;
  let accountB: TestAccount;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    accountA = await addAccount(pg);
    accountB = await addAccount(pg);
  });

  afterAll(async () => {
    await closeTestDb(pg);
  });

  it('returns null when no pointer was ever set', async () => {
    expect(await getActive(db, accountA.userId)).toBeNull();
  });

  it('round-trips an upsert: title is joined from the conversation', async () => {
    const conversation = await createConversation(db, accountA.userId, 'Trip planning');
    const stamp = await withUser(db, accountA.userId, (tx) =>
      setActive(tx, accountA.userId, conversation.id, 'picker'),
    );
    const active = await getActive(db, accountA.userId);
    expect(active).toEqual({
      conversationId: conversation.id,
      kind: 'conversation',
      threadId: null,
      spaceId: null,
      title: 'Trip planning',
      surface: 'picker',
      changedAt: stamp,
      cleared: false,
    });
  });

  it('upserts in place: a second write replaces surface and bumps changed_at', async () => {
    const conversation = await createConversation(db, accountA.userId, 'same');
    const first = await withUser(db, accountA.userId, (tx) =>
      setActive(tx, accountA.userId, conversation.id, 'picker'),
    );
    const second = await withUser(db, accountA.userId, (tx) =>
      setActive(tx, accountA.userId, conversation.id, 'web_text'),
    );
    expect(second).toBeGreaterThan(first);
    // Read as accountA: user_state_select is auth.uid() = user_id,
    // so only the pointer's own account can see its row.
    const rows = await withUserRaw(pg, accountA.userId, (tx) =>
      tx.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM bob.user_state WHERE user_id = $1`,
        [accountA.userId],
      ),
    );
    expect(rows.rows[0]?.total).toBe(1);
    expect((await getActive(db, accountA.userId))?.surface).toBe('web_text');
  });

  it('clears the pointer when the active conversation is deleted (FK on delete set null)', async () => {
    const conversation = await createConversation(db, accountA.userId, 'doomed');
    await withUser(db, accountA.userId, (tx) => setActive(tx, accountA.userId, conversation.id, 'picker'));
    await deleteConversation(db, accountA.userId, conversation.id);

    const active = await getActive(db, accountA.userId);
    expect(active).not.toBeNull();
    // ON DELETE SET NULL nulls conversation_id only; surface/changed_at stay.
    expect(active?.conversationId).toBeNull();
    expect(active?.title).toBeNull();
    expect(active?.surface).toBe('picker');
  });

  it('isolates accounts: another account has no pointer (C-18 shape)', async () => {
    const conversation = await createConversation(db, accountA.userId, 'private');
    await withUser(db, accountA.userId, (tx) => setActive(tx, accountA.userId, conversation.id, 'activate'));
    expect(await getActive(db, accountB.userId)).toBeNull();
  });

  it('reports a deleted title as null even while the pointer row survives', async () => {
    const conversation = await createConversation(db, accountA.userId, 'vanish');
    await withUser(db, accountA.userId, (tx) => setActive(tx, accountA.userId, conversation.id, 'device'));
    await deleteConversation(db, accountA.userId, conversation.id);
    const active = await getActive(db, accountA.userId);
    expect(active?.title).toBeNull();
  });
});

describe('guard: active pointer reads and writes run under withUser', () => {
  let pg: TestDb;
  let db: Db;
  let account: TestAccount;

  beforeAll(async () => {
    pg = await createTestDb();
    account = await addAccount(pg);
    // The production connection is bob_server (NOBYPASSRLS, no grants on
    // schema bob), so any RLS-external query fails here exactly as in prod
    // (the same guard helper as tests/store-conversations-pg.test.ts).
    await pg.exec('set role bob_server');
    db = asDb(pg);
  });

  afterAll(async () => {
    await closeTestDb(pg);
  });

  it('a raw base-connection read sees zero pointer rows (RLS, no claims)', async () => {
    expect(await db.query(`SELECT 1 AS one FROM bob.user_state`)).toEqual([]);
  });

  it('runs getActive and setActive under withUser on the guarded connection', async () => {
    const conversation = await createConversation(db, account.userId, 'guard');
    const stamp = await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, conversation.id, 'device'),
    );
    const active = await getActive(db, account.userId);
    expect(active?.conversationId).toBe(conversation.id);
    expect(active?.surface).toBe('device');
    expect(active?.changedAt).toBe(stamp);
    expect(await listConversations(db, account.userId)).toHaveLength(1);
  });
});

describe('web voice turn writes the pointer (surface web_voice)', () => {
  let pg: TestDb;
  let db: Db;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    setSharedDb(Promise.resolve(db));
  });

  afterAll(async () => {
    await closeDb().catch(() => undefined);
    await closeTestDb(pg).catch(() => undefined);
  });

  function request(account: TestAccount): unknown {
    return {
      body: { audio: Buffer.from('audio').toString('base64'), format: 'webm' },
      account: { userId: account.userId, sessionId: account.sessionId, exp: Math.floor(Date.now() / 1000) + 3600 },
    };
  }

  it('moves the pointer to the active conversation and publishes active.changed', async () => {
    const account = await addAccount(pg);
    const conversation = await createConversation(db, account.userId, 'voice target');
    await withUser(db, account.userId, (tx) => setActive(tx, account.userId, conversation.id, 'web_text'));
    const received: AccountEvent[] = [];
    const unsubscribe = getAccountEvents().subscribe(account.userId, (event) => received.push(event));

    const result = response();
    await webVoice(appDeps)(request(account) as never, result as never);

    expect(result.statusCode).toBe(200);
    const active = await getActive(db, account.userId);
    expect(active?.conversationId).toBe(conversation.id);
    expect(active?.surface).toBe('web_voice');
    const changed = received.filter((event) => event.type === 'active.changed');
    expect(changed).toHaveLength(1);
    if (changed[0]!.type === 'active.changed') {
      expect(changed[0]!.conversation_id).toBe(conversation.id);
      expect(changed[0]!.surface).toBe('web_voice');
      expect(changed[0]!.title).toBe('voice target');
    }
    unsubscribe();
  });

  it('writes nothing and publishes nothing when no pointer exists yet', async () => {
    const account = await addAccount(pg);
    const received: AccountEvent[] = [];
    const unsubscribe = getAccountEvents().subscribe(account.userId, (event) => received.push(event));

    const result = response();
    await webVoice(appDeps)(request(account) as never, result as never);

    expect(result.statusCode).toBe(200);
    expect(await getActive(db, account.userId)).toBeNull();
    expect(received.filter((event) => event.type === 'active.changed')).toHaveLength(0);
    unsubscribe();
  });

  it('writes nothing when the pointer was cleared (active conversation deleted)', async () => {
    const account = await addAccount(pg);
    const conversation = await createConversation(db, account.userId, 'deleted soon');
    await withUser(db, account.userId, (tx) => setActive(tx, account.userId, conversation.id, 'device'));
    await deleteConversation(db, account.userId, conversation.id);

    const result = response();
    await webVoice(appDeps)(request(account) as never, result as never);

    expect(result.statusCode).toBe(200);
    const active = await getActive(db, account.userId);
    expect(active?.conversationId).toBeNull();
    expect(active?.surface).toBe('device'); // unchanged by the voice turn
  });

  it('keeps transcribing without touching the store when no account is present', async () => {
    const result = response();
    await webVoice(appDeps)({ body: { audio: Buffer.from('audio').toString('base64'), format: 'webm' } } as never, result as never);
    expect(result.statusCode).toBe(200);
    expect((result.body as { text: string }).text).toBe('hello');
  });
});
describe('device conversation ref (#565 D2)', () => {
  const uuid = '0f8b7c2e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';

  it('round-trips a thread id through threadRef and parseDeviceRef', () => {
    const ref = threadRef(uuid.toUpperCase());
    expect(ref).toBe(`${THREAD_REF_PREFIX}${uuid}`);
    expect(ref).toHaveLength(40);
    expect(ref).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(parseDeviceRef(ref)).toEqual({ kind: 'thread', threadId: uuid });
  });

  it('passes a conversation id through unchanged', () => {
    expect(parseDeviceRef('cnv_abc12345')).toEqual({ kind: 'conversation', conversationId: 'cnv_abc12345' });
  });

  it('refuses an empty ref and a thr_ ref without a uuid', () => {
    expect(parseDeviceRef('')).toBeNull();
    expect(parseDeviceRef('thr_')).toBeNull();
    expect(parseDeviceRef('thr_not-a-uuid')).toBeNull();
  });
});

describe('active pointer names a space thread (#565 U1)', () => {
  let pg: TestDb;
  let db: Db;
  let owner: TestAccount;
  let outsider: TestAccount;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    owner = await addAccount(pg);
    outsider = await addAccount(pg);
  });

  afterAll(async () => {
    await closeTestDb(pg);
  });

  async function newThread(title: string): Promise<{ spaceId: string; threadId: string }> {
    const space = await createSpace(db, owner.userId, { kind: 'group', name: `Space ${title}` });
    const thread = await createThread(db, owner.userId, { spaceId: space.id, title });
    return { spaceId: space.id, threadId: thread.id };
  }

  it('points at a thread and reads it back as a thr_ ref with its space and title', async () => {
    const { spaceId, threadId } = await newThread('Dinner plans');
    const stamp = await withUser(db, owner.userId, (tx) => setActive(tx, owner.userId, threadRef(threadId), 'picker'));
    expect(await getActive(db, owner.userId)).toEqual({
      conversationId: threadRef(threadId),
      kind: 'thread',
      threadId,
      spaceId,
      title: 'Dinner plans',
      surface: 'picker',
      changedAt: stamp,
      cleared: false,
    });
  });

  it('refuses a thread the caller cannot see, an archived thread and a malformed ref alike', async () => {
    const { threadId } = await newThread('Private');
    await expect(withUser(db, outsider.userId, (tx) =>
      setActive(tx, outsider.userId, threadRef(threadId), 'picker'))).rejects.toBeInstanceOf(StoreNotFoundError);
    await archiveThread(db, owner.userId, threadId);
    await expect(withUser(db, owner.userId, (tx) =>
      setActive(tx, owner.userId, threadRef(threadId), 'picker'))).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(withUser(db, owner.userId, (tx) =>
      setActive(tx, owner.userId, 'thr_nope', 'picker'))).rejects.toBeInstanceOf(StoreNotFoundError);
  });

  it('a conversation ref nulls the thread side, and a thread ref nulls the conversation side', async () => {
    const { threadId } = await newThread('Swap');
    const conversation = await createConversation(db, owner.userId, 'General chat');
    await withUser(db, owner.userId, (tx) => setActive(tx, owner.userId, threadRef(threadId), 'picker'));
    await withUser(db, owner.userId, (tx) => setActive(tx, owner.userId, conversation.id, 'web_text'));
    expect(await getActive(db, owner.userId)).toMatchObject({ kind: 'conversation', threadId: null, spaceId: null });
    await withUser(db, owner.userId, (tx) => setActive(tx, owner.userId, threadRef(threadId), 'picker'));
    expect(await getActive(db, owner.userId)).toMatchObject({ kind: 'thread', threadId });
  });

  it('nulls an archived thread on read and reports cleared once', async () => {
    const { threadId } = await newThread('Goes stale');
    await withUser(db, owner.userId, (tx) => setActive(tx, owner.userId, threadRef(threadId), 'device'));
    await archiveThread(db, owner.userId, threadId);
    expect(await getActive(db, owner.userId)).toMatchObject({ conversationId: null, kind: null, cleared: true });
    expect(await getActive(db, owner.userId)).toMatchObject({ conversationId: null, kind: null, cleared: false });
  });

  it('clearActiveThreadInSpace clears only a thread in that space', async () => {
    const first = await newThread('First');
    const second = await newThread('Second');
    await withUser(db, owner.userId, (tx) => setActive(tx, owner.userId, threadRef(first.threadId), 'picker'));
    expect(await clearActiveThreadInSpace(db, owner.userId, second.spaceId)).toBeNull();
    expect((await getActive(db, owner.userId))?.threadId).toBe(first.threadId);
    expect(await clearActiveThreadInSpace(db, owner.userId, first.spaceId)).toEqual(expect.any(Number));
    expect(await getActive(db, owner.userId)).toMatchObject({ conversationId: null, kind: null, cleared: false });
    expect(await clearActiveThreadInSpace(db, owner.userId, 'not-a-uuid')).toBeNull();
  });
});
