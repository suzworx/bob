import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

import {
  activateConversationRoute,
  deleteConversationRoute,
  getActiveRoute,
  getConversationRoute,
  listConversationsRoute,
  renameConversationRoute,
} from '../../src/conversations/http.ts';
import { closeDb, setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import { addReplyVersion, appendMessage, createConversation, getConversation } from '../../src/conversations/store.ts';
import { getActive, setActive } from '../../src/conversations/active.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import {
  asDb,
  closeTestDb,
  createTestDb,
  addAccount,
  type TestDb,
} from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
let pg: TestDb;
let db: Db;
let userId: string;

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  userId = await resolveDevAccount(db);
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

function request(overrides: Record<string, unknown>): unknown {
  return {
    params: {},
    query: {},
    body: {},
    get: () => '',
    account: { userId, sessionId: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
    ...overrides,
  };
}

describe('conversations API (contracts/conversations-api.md)', () => {
  it('1. lists an empty store as [] with 200, never 404', async () => {
    const result = response();
    await listConversationsRoute(appDeps)(request({}) as never, result as never);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ conversations: [] });
  });

  it('2. orders the list by updatedAt descending', async () => {
    const older = await createConversation(db, userId, 'older');
    const newer = await createConversation(db, userId, 'newer');
    await pg.query(
      `UPDATE bob.conversations SET updated_at = updated_at - interval '5 seconds' WHERE id = $1`,
      [older.id],
    );

    const result = response();
    await listConversationsRoute(appDeps)(request({}) as never, result as never);
    const { conversations } = result.body as { conversations: Array<{ id: string }> };
    expect(conversations.map((entry) => entry.id)).toEqual([newer.id, older.id]);
  });

  it('3. filters by title case-insensitively', async () => {
    await createConversation(db, userId, 'Cardputer Truncation');
    await createConversation(db, userId, 'unrelated');

    const result = response();
    await listConversationsRoute(appDeps)(request({ query: { q: 'cardputer' } }) as never, result as never);
    const { conversations } = result.body as { conversations: Array<{ id: string }> };
    expect(conversations).toHaveLength(1);
  });

  it('4. rejects a q longer than 200 characters', async () => {
    const result = response();
    await listConversationsRoute(appDeps)(request({ query: { q: 'x'.repeat(201) } }) as never, result as never);
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('5. returns messages in position order', async () => {
    const conversation = await createConversation(db, userId, 'ordered');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'q' }] });
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'a' }] });

    const result = response();
    await getConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, result as never);
    const detail = result.body as { messages: Array<{ position: number; versions: Array<{ selected: boolean }> }> };
    expect(detail.messages.map((message) => message.position)).toEqual([0, 1]);
    expect(detail.messages.filter((message) => message.versions.filter((version) => version.selected).length))
      .toHaveLength(2);
  });

  it('6. returns every version with exactly one selected', async () => {
    const conversation = await createConversation(db, userId, 'versions');
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'v0' }] });
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'v1' }]);
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'v2' }]);

    const result = response();
    await getConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, result as never);
    const detail = result.body as { messages: Array<{ versions: Array<{ selected: boolean }> }> };
    const selected = detail.messages[0]!.versions.filter((version) => version.selected);
    expect(detail.messages[0]!.versions).toHaveLength(3);
    expect(selected).toHaveLength(1);
  });

  it('7. returns 404 for an unknown id', async () => {
    const result = response();
    await getConversationRoute(appDeps)(request({ params: { id: 'cnv_missing' } }) as never, result as never);
    expect(result.statusCode).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('8. rejects empty or whitespace titles with 400', async () => {
    const conversation = await createConversation(db, userId, 'rename me');
    for (const title of ['', '   ']) {
      const result = response();
      await renameConversationRoute(appDeps)(
        request({ params: { id: conversation.id }, body: { title } }) as never,
        result as never,
      );
      expect(result.statusCode).toBe(400);
    }
  });

  it('9. renames and bumps updatedAt', async () => {
    const conversation = await createConversation(db, userId, 'before');
    const result = response();
    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { title: 'after' } }) as never,
      result as never,
    );
    expect(result.statusCode).toBe(200);
    const renamed = result.body as { title: string; updatedAt: number };
    expect(renamed.title).toBe('after');
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(conversation.updatedAt);
  });

  it('10. deletes and removes the conversation from the list', async () => {
    const conversation = await createConversation(db, userId, 'doomed');
    const result = response();
    await deleteConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, result as never);
    expect(result.statusCode).toBe(204);

    const list = response();
    await listConversationsRoute(appDeps)(request({}) as never, list as never);
    const conversations = (list.body as { conversations: Array<{ id: string }> }).conversations;
    expect(conversations.find((entry) => entry.id === conversation.id)).toBeUndefined();
  });

  it('11. deleting an already-deleted id returns 204 again', async () => {
    const result = response();
    await deleteConversationRoute(appDeps)(request({ params: { id: 'cnv_gone' } }) as never, result as never);
    expect(result.statusCode).toBe(204);
  });

  it('12. deletion cascades to messages and versions', async () => {
    const conversation = await createConversation(db, userId, 'cascade');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'q' }] });
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'a' }] });

    const result = response();
    await deleteConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, result as never);
    expect(result.statusCode).toBe(204);

    const versions = await pg.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM bob.message_versions v
       JOIN bob.messages m ON m.id = v.message_id
       WHERE m.conversation_id = $1`,
      [conversation.id],
    );
    expect(versions.rows[0]?.total).toBe(0);
  });

  it('13. a route called without req.account is refused (401 invalid_token)', async () => {
    const result = response();
    await listConversationsRoute(appDeps)(request({ account: undefined }) as never, result as never);
    expect(result.statusCode).toBe(401);
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_token');
  });

  it('14. journals ids and counts only - never titles or message text', async () => {
    const secretTitle = 'secret-title-content-xyz';
    const conversation = await createConversation(db, userId, secretTitle);
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'private text abc' }] });

    await listConversationsRoute(appDeps)(request({}) as never, response() as never);
    await getConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, response() as never);
    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { title: 'renamed ok' } }) as never,
      response() as never,
    );
    await deleteConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, response() as never);

    const { journal } = await import('../../src/platform/logger.ts');
    const logged = JSON.stringify(vi.mocked(journal).mock.calls);
    expect(logged).not.toContain(secretTitle);
    expect(logged).not.toContain('private text abc');
    expect(logged).not.toContain('renamed ok');
  });
});

describe('account scoping (C-01..C-05, C-18)', () => {
  let otherId: string;

  beforeAll(async () => {
    const other = await addAccount(pg, {});
    otherId = other.userId;
  });

  it('C-01: GET /api/conversations lists only the requesting account\'s conversations', async () => {
    const mine = await createConversation(db, userId, 'mine');
    const theirs = await createConversation(db, otherId, 'theirs');
    const result = response();
    await listConversationsRoute(appDeps)(request({}) as never, result as never);
    const ids = (result.body as { conversations: Array<{ id: string }> }).conversations.map((entry) => entry.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it('C-02: GET on another account\'s conversation -> 404 identical to unknown', async () => {
    const theirs = await createConversation(db, otherId, 'theirs');
    const viaTheirs = response();
    await getConversationRoute(appDeps)(request({ params: { id: theirs.id } }) as never, viaTheirs as never);
    const viaUnknown = response();
    await getConversationRoute(appDeps)(request({ params: { id: 'cnv_no_such_id' } }) as never, viaUnknown as never);
    expect(viaTheirs.statusCode).toBe(404);
    expect(viaUnknown.statusCode).toBe(404);
    expect(viaTheirs.body).toEqual(viaUnknown.body);
  });

  it('C-03: PATCH on another account\'s conversation -> 404 identical to unknown; DELETE -> quiet 204, owner\'s row untouched', async () => {
    const theirs = await createConversation(db, otherId, 'theirs');
    const rename = response();
    await renameConversationRoute(appDeps)(
      request({ params: { id: theirs.id }, body: { title: 'hijacked' } }) as never,
      rename as never,
    );
    expect(rename.statusCode).toBe(404);

    const removed = response();
    await deleteConversationRoute(appDeps)(request({ params: { id: theirs.id } }) as never, removed as never);
    expect(removed.statusCode).toBe(204);

    const ownerView = await getConversation(db, otherId, theirs.id);
    expect(ownerView).not.toBeNull();
    expect(ownerView!.title).toBe('theirs');
  });

  it('C-04: GET /api/conversations/:id messages include origin per message', async () => {
    const conversation = await createConversation(db, userId, 'origins');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'typed' }], origin: 'web_text' });
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'spoken' }], origin: 'web_voice' });
    const result = response();
    await getConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, result as never);
    const messages = (result.body as { messages: Array<{ origin: string }> }).messages;
    expect(messages.map((message) => message.origin)).toEqual(['web_text', 'web_voice']);
  });

  it('C-05: a device-originated message is persisted with origin device and returned on the web', async () => {
    const conversation = await createConversation(db, userId, 'device turn');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'from cardputer' }], origin: 'device' });
    const stored = await getConversation(db, userId, conversation.id);
    expect(stored!.messages[0]!.origin).toBe('device');
    const result = response();
    await getConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, result as never);
    expect((result.body as { messages: Array<{ origin: string }> }).messages[0]!.origin).toBe('device');
  });

  it('C-18: cross-account rename with a stale token -> 404, not 409 (not-found precedes concurrency)', async () => {
    const theirs = await createConversation(db, otherId, 'theirs');
    const result = response();
    await renameConversationRoute(appDeps)(
      request({ params: { id: theirs.id }, body: { title: 'stale', expectedUpdatedAt: 1 } }) as never,
      result as never,
    );
    expect(result.statusCode).toBe(404);
  });
});

describe('active-conversation routes (C-06..C-08, C-13, C-14, C-18, C-19)', () => {
  let otherId: string;

  beforeAll(async () => {
    const other = await addAccount(pg, {});
    otherId = other.userId;
  });

  function listen(userId: string): { events: AccountEvent[]; stop: () => void } {
    const events: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(userId, (event) => events.push(event));
    return { events, stop };
  }

  it('C-06: activate -> 200; GET /api/active reflects it; active.changed emitted with surface activate', async () => {
    const conversation = await createConversation(db, userId, 'continue me');
    const { events, stop } = listen(userId);
    const result = response();
    await activateConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, result as never);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ conversation_id: conversation.id, title: 'continue me' });

    const active = response();
    await getActiveRoute(appDeps)(request({}) as never, active as never);
    expect(active.statusCode).toBe(200);
    expect(active.body).toMatchObject({
      active: { conversation_id: conversation.id, title: 'continue me', surface: 'activate' },
    });

    const changed = events.filter((event) => event.type === 'active.changed');
    expect(changed).toHaveLength(1);
    if (changed[0]!.type === 'active.changed') {
      expect(changed[0]!.surface).toBe('activate');
      expect(changed[0]!.conversation_id).toBe(conversation.id);
      expect(changed[0]!.title).toBe('continue me');
    }
    stop();
  });

  it('C-07: activate on an unknown id -> 404', async () => {
    const result = response();
    await activateConversationRoute(appDeps)(request({ params: { id: 'cnv_no_such_id' } }) as never, result as never);
    expect(result.statusCode).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('C-18: activate on another account\'s conversation -> 404 identical to unknown', async () => {
    const theirs = await createConversation(db, otherId, 'theirs');
    const viaTheirs = response();
    await activateConversationRoute(appDeps)(request({ params: { id: theirs.id } }) as never, viaTheirs as never);
    const viaUnknown = response();
    await activateConversationRoute(appDeps)(request({ params: { id: 'cnv_no_such_id' } }) as never, viaUnknown as never);
    expect(viaTheirs.statusCode).toBe(404);
    expect(viaUnknown.statusCode).toBe(404);
    expect(viaTheirs.body).toEqual(viaUnknown.body);
  });

  it('C-08: GET /api/active with no pointer -> 200 { active: null }, not 404', async () => {
    const fresh = await addAccount(pg, {});
    const result = response();
    await getActiveRoute(appDeps)(
      request({
        account: { userId: fresh.userId, sessionId: fresh.sessionId, exp: Math.floor(Date.now() / 1000) + 3600 },
      }) as never,
      result as never,
    );
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ active: null });
  });

  it('C-13: rename emits conversation.updated; delete emits conversation.deleted', async () => {
    const conversation = await createConversation(db, userId, 'eventful');
    const { events, stop } = listen(userId);

    await renameConversationRoute(appDeps)(
      request({ params: { id: conversation.id }, body: { title: 'renamed' } }) as never,
      response() as never,
    );
    const updated = events.filter((event) => event.type === 'conversation.updated');
    expect(updated).toHaveLength(1);
    if (updated[0]!.type === 'conversation.updated') {
      expect(updated[0]!.conversation_id).toBe(conversation.id);
    }

    events.length = 0;
    await deleteConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, response() as never);
    const deleted = events.filter((event) => event.type === 'conversation.deleted');
    expect(deleted).toHaveLength(1);
    if (deleted[0]!.type === 'conversation.deleted') {
      expect(deleted[0]!.conversation_id).toBe(conversation.id);
    }
    stop();
  });

  it('C-14: opening/viewing a conversation does not change the pointer', async () => {
    const conversation = await createConversation(db, userId, 'viewed');
    await withUser(db, userId, (tx) => setActive(tx, userId, conversation.id, 'picker'));
    const before = (await getActive(db, userId))!;

    await getConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, response() as never);
    await listConversationsRoute(appDeps)(request({}) as never, response() as never);

    const after = await getActive(db, userId);
    expect(after?.conversationId).toBe(conversation.id);
    expect(after?.changedAt).toBe(before.changedAt);
    expect(after?.surface).toBe('picker');
  });

  it('C-19: deleting the active conversation clears the pointer (null form) and publishes active.changed with nulls', async () => {
    const conversation = await createConversation(db, userId, 'active doomed');
    await withUser(db, userId, (tx) => setActive(tx, userId, conversation.id, 'picker'));
    const { events, stop } = listen(userId);

    const result = response();
    await deleteConversationRoute(appDeps)(request({ params: { id: conversation.id } }) as never, result as never);
    expect(result.statusCode).toBe(204);

    const active = response();
    await getActiveRoute(appDeps)(request({}) as never, active as never);
    expect(active.body).toEqual({
      active: { conversation_id: null, title: null, surface: 'picker', changed_at: expect.any(Number) },
    });
    const changed = events.filter((event) => event.type === 'active.changed');
    expect(changed).toHaveLength(1);
    if (changed[0]!.type === 'active.changed') {
      expect(changed[0]!.conversation_id).toBeNull();
      expect(changed[0]!.title).toBeNull();
      expect(changed[0]!.surface).toBe('picker');
    }
    stop();
  });
});