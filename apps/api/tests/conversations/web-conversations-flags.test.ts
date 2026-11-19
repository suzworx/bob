/**
 * Conversation pin/archive routes (CU-CHAT-1, G21): PATCH /api/conversations/:id
 * with `pinned` or `archived` instead of `title`, and GET /api/conversations
 * with `archived=1`. Runs on the real Postgres test db, where the pin/archive migration applies.
 * Mirrors the harness of tests/heard-portion.test.ts: a partial store mock so
 * setConversationFlag is spy-able per test, a fresh account per test (RLS
 * isolation), and the same fake request()/response() shape used across the
 * conversations route tests.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());
// Partial store mock: setConversationFlag is spy-able per test, every other
// export runs the real implementation (createTestDb applies the migration).
vi.mock('../../src/conversations/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/conversations/store.ts')>();
  return { ...actual, setConversationFlag: vi.fn(actual.setConversationFlag) };
});

import { listConversationsRoute, renameConversationRoute } from '../../src/conversations/http.ts';
import { createConversation, listConversations, setConversationFlag } from '../../src/conversations/store.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { journal } from '../../src/platform/logger.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
let pg: TestDb;
let db: Db;

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
});

afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
    },
    end() {},
  };
}

function request(overrides: Record<string, unknown>, who: TestAccount): unknown {
  return {
    params: {},
    query: {},
    body: {},
    get: () => '',
    account: { userId: who.userId, sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
    ...overrides,
  };
}

// Copied from tests/web-conversations.test.ts:318-322.
function listen(userId: string): { events: AccountEvent[]; stop: () => void } {
  const events: AccountEvent[] = [];
  const stop = getAccountEvents().subscribe(userId, (event) => events.push(event));
  return { events, stop };
}

describe('conversation pin/archive (CU-CHAT-1, G21)', () => {
  it('F1: a pinned conversation lists first, and entries carry pinned/archived booleans', async () => {
    const account = await addAccount(pg);
    const older = await createConversation(db, account.userId, 'older');
    const newer = await createConversation(db, account.userId, 'newer');
    await setConversationFlag(db, account.userId, older.id, 'pinned', true);

    const result = response();
    await listConversationsRoute(appDeps)(request({}, account) as never, result as never);
    const { conversations } = result.body as {
      conversations: Array<{ id: string; pinned: boolean; archived: boolean }>;
    };
    expect(conversations.map((entry) => entry.id)).toEqual([older.id, newer.id]);
    expect(conversations.find((entry) => entry.id === older.id)?.pinned).toBe(true);
    expect(conversations.every((entry) => typeof entry.archived === 'boolean')).toBe(true);
  });

  it('F2: PATCH {pinned:true} pins without changing updatedAt; {pinned:false} unpins', async () => {
    const account = await addAccount(pg);
    const conversation = await createConversation(db, account.userId, 'pin me');

    const pinned = response();
    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { pinned: true } }, account) as never,
      pinned as never,
    );
    expect(pinned.statusCode).toBe(200);
    const pinnedBody = pinned.body as { pinned: boolean; archived: boolean; updatedAt: number };
    expect(pinnedBody.pinned).toBe(true);
    expect(pinnedBody.archived).toBe(false);
    expect(pinnedBody.updatedAt).toBe(conversation.updatedAt);

    const unpinned = response();
    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { pinned: false } }, account) as never,
      unpinned as never,
    );
    expect(unpinned.statusCode).toBe(200);
    expect((unpinned.body as { pinned: boolean }).pinned).toBe(false);
  });

  it('F3: archiving hides from the default list; archived=1 lists only it; unarchiving restores it', async () => {
    const account = await addAccount(pg);
    const conversation = await createConversation(db, account.userId, 'archive me');
    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { archived: true } }, account) as never,
      response() as never,
    );

    const defaultList = response();
    await listConversationsRoute(appDeps)(request({}, account) as never, defaultList as never);
    expect(
      (defaultList.body as { conversations: Array<{ id: string }> }).conversations.map((entry) => entry.id),
    ).not.toContain(conversation.id);

    const archivedList = response();
    await listConversationsRoute(appDeps)(request({ query: { archived: '1' } }, account) as never, archivedList as never);
    expect(
      (archivedList.body as { conversations: Array<{ id: string }> }).conversations.map((entry) => entry.id),
    ).toEqual([conversation.id]);

    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { archived: false } }, account) as never,
      response() as never,
    );
    const restoredList = response();
    await listConversationsRoute(appDeps)(request({}, account) as never, restoredList as never);
    expect(
      (restoredList.body as { conversations: Array<{ id: string }> }).conversations.map((entry) => entry.id),
    ).toContain(conversation.id);
  });

  it('F4: q search honours the archived filter', async () => {
    const account = await addAccount(pg);
    const conversation = await createConversation(db, account.userId, 'Trip notes');
    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { archived: true } }, account) as never,
      response() as never,
    );

    const active = response();
    await listConversationsRoute(appDeps)(request({ query: { q: 'trip' } }, account) as never, active as never);
    expect((active.body as { conversations: unknown[] }).conversations).toEqual([]);

    const archived = response();
    await listConversationsRoute(appDeps)(
      request({ query: { q: 'trip', archived: '1' } }, account) as never,
      archived as never,
    );
    expect(
      (archived.body as { conversations: Array<{ id: string }> }).conversations.map((entry) => entry.id),
    ).toEqual([conversation.id]);
  });

  it('F5: invalid bodies and query values are 400 invalid_request', async () => {
    const account = await addAccount(pg);
    const conversation = await createConversation(db, account.userId, 'bad input');
    for (const body of [{}, { pinned: 'yes' }, { title: 'x', pinned: true }, { archived: null }]) {
      const result = response();
      await renameConversationRoute(appDeps)(
        request({ params: { id: conversation.id }, body }, account) as never,
        result as never,
      );
      expect(result.statusCode).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe('invalid_request');
    }
    const badQuery = response();
    await listConversationsRoute(appDeps)(request({ query: { archived: '2' } }, account) as never, badQuery as never);
    expect(badQuery.statusCode).toBe(400);
    expect((badQuery.body as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it("F6: another account's id is 404 identical to unknown; the owner's row stays unpinned", async () => {
    const owner = await addAccount(pg);
    const attacker = await addAccount(pg);
    const theirs = await createConversation(db, owner.userId, 'theirs');

    const viaTheirs = response();
    await renameConversationRoute(appDeps)(
      request({ params: { id: theirs.id }, body: { pinned: true } }, attacker) as never,
      viaTheirs as never,
    );
    const viaUnknown = response();
    await renameConversationRoute(appDeps)(
      request({ params: { id: 'cnv_no_such_id' }, body: { pinned: true } }, attacker) as never,
      viaUnknown as never,
    );
    expect(viaTheirs.statusCode).toBe(404);
    expect(viaUnknown.statusCode).toBe(404);
    expect(viaTheirs.body).toEqual(viaUnknown.body);

    const ownerList = response();
    await listConversationsRoute(appDeps)(request({}, owner) as never, ownerList as never);
    const entry = (ownerList.body as { conversations: Array<{ id: string; pinned: boolean }> }).conversations.find(
      (row) => row.id === theirs.id,
    );
    expect(entry?.pinned).toBe(false);
  });

  it('F7: a stale expectedUpdatedAt gives 409 conflict', async () => {
    const account = await addAccount(pg);
    const conversation = await createConversation(db, account.userId, 'racy');
    // Bump updatedAt so the originally-read token is stale.
    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { title: 'bumped' } }, account) as never,
      response() as never,
    );

    const result = response();
    await renameConversationRoute(appDeps)(
      request(
        { params: { id: conversation.id }, body: { pinned: true, expectedUpdatedAt: conversation.updatedAt } },
        account,
      ) as never,
      result as never,
    );
    expect(result.statusCode).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('F8: pin and archive each publish exactly one conversation.updated naming the id', async () => {
    const account = await addAccount(pg);
    const conversation = await createConversation(db, account.userId, 'events');
    const { events, stop } = listen(account.userId);

    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { pinned: true } }, account) as never,
      response() as never,
    );
    let updated = events.filter((event) => event.type === 'conversation.updated');
    expect(updated).toHaveLength(1);
    if (updated[0]!.type === 'conversation.updated') expect(updated[0]!.conversation_id).toBe(conversation.id);

    events.length = 0;
    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { archived: true } }, account) as never,
      response() as never,
    );
    updated = events.filter((event) => event.type === 'conversation.updated');
    expect(updated).toHaveLength(1);
    if (updated[0]!.type === 'conversation.updated') expect(updated[0]!.conversation_id).toBe(conversation.id);
    stop();
  });

  it('F9: journals pinned/archived with ids and booleans only, never a title', async () => {
    vi.mocked(journal).mockClear();
    const account = await addAccount(pg);
    const secretTitle = 'secret-title-pin-archive-xyz';
    const conversation = await createConversation(db, account.userId, secretTitle);

    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { pinned: true } }, account) as never,
      response() as never,
    );
    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { archived: true } }, account) as never,
      response() as never,
    );

    const pinnedCall = vi.mocked(journal).mock.calls.find((call) => call[0] === 'v2.conversation_pinned');
    expect(pinnedCall).toBeDefined();
    expect(pinnedCall![1]).toEqual({ id: conversation.id, pinned: true });
    const archivedCall = vi.mocked(journal).mock.calls.find((call) => call[0] === 'v2.conversation_archived');
    expect(archivedCall).toBeDefined();
    expect(archivedCall![1]).toEqual({ id: conversation.id, archived: true });

    const logged = JSON.stringify(vi.mocked(journal).mock.calls);
    expect(logged).not.toContain(secretTitle);
  });

  it('F10: a 42703 from setConversationFlag maps to 503 feature_unavailable and journals it', async () => {
    const account = await addAccount(pg);
    const conversation = await createConversation(db, account.userId, 'unavailable');
    vi.mocked(setConversationFlag).mockRejectedValueOnce(
      Object.assign(new Error('column "pinned_at" does not exist'), { code: '42703' }),
    );

    const result = response();
    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { pinned: true } }, account) as never,
      result as never,
    );
    expect(result.statusCode).toBe(503);
    expect((result.body as { error: { code: string } }).error.code).toBe('feature_unavailable');
    const unavailable = vi.mocked(journal).mock.calls.find(
      (call) => call[0] === 'v2.conversation_flags_unavailable',
    );
    expect(unavailable).toBeDefined();
    expect(unavailable![1]).toEqual({ reason: 'undefined_column' });
  });

  it('F11: listConversations with no options (the device picker call) excludes an archived conversation', async () => {
    const account = await addAccount(pg);
    const conversation = await createConversation(db, account.userId, 'device picker');
    await setConversationFlag(db, account.userId, conversation.id, 'archived', true);

    const list = await listConversations(db, account.userId);
    expect(list.map((entry) => entry.id)).not.toContain(conversation.id);
  });
});
