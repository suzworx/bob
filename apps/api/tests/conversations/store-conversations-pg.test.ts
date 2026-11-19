// Conversation store on the Db port (T007, specs/008-supabase-auth-pairing).
// Mirrors tests/store-conversations.test.ts on the async per-account module
// over the real Postgres test db, plus the 008 additions: cross-account isolation (SC-003),
// message origin, concurrent appends (FR-027), and millisecond timestamp
// round-trips (FR-052).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  StoreConflictError,
  StoreNotFoundError,
  type Db,
} from '../../src/platform/db/db.ts';
import {
  addReplyVersion,
  appendMessage,
  conversationExists,
  countMessages,
  createConversation,
  deleteConversation,
  deriveTitle,
  getConversation,
  listConversations,
  renameConversation,
  selectVersion,
  truncateAfterMessage,
} from '../../src/conversations/store.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

describe('conversation store on the Db port (real Postgres)', () => {
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

  it('orders the sidebar list by updatedAt descending, searches titles case-insensitively, and limits', async () => {
    const older = await createConversation(db, accountA.userId, 'Cardputer reply truncation');
    const newer = await createConversation(db, accountA.userId, 'Garden planning');
    await pg.query(
      `UPDATE bob.conversations SET updated_at = updated_at - interval '1 second' WHERE id = $1`,
      [older.id],
    );

    let list = await listConversations(db, accountA.userId);
    expect(list.map((entry) => entry.id)).toEqual([newer.id, older.id]);

    list = await listConversations(db, accountA.userId, { q: 'CARDPUTER' });
    expect(list.map((entry) => entry.id)).toEqual([older.id]);

    list = await listConversations(db, accountA.userId, { limit: 1 });
    expect(list.map((entry) => entry.id)).toEqual([newer.id]);

    // RLS: account B never sees account A's rows.
    expect(await listConversations(db, accountB.userId)).toEqual([]);
  });

  it('returns messages in position order with exactly one selected version each', async () => {
    const conversation = await createConversation(db, accountA.userId, 'versions');
    await appendMessage(db, accountA.userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'q' }],
    });
    await appendMessage(db, accountA.userId, conversation.id, {
      role: 'assistant',
      parts: [{ type: 'text', text: 'a1' }],
    });
    await addReplyVersion(db, accountA.userId, conversation.id, [{ type: 'text', text: 'a2' }]);
    await addReplyVersion(db, accountA.userId, conversation.id, [{ type: 'text', text: 'a3' }]);

    const detail = (await getConversation(db, accountA.userId, conversation.id))!;
    expect(detail.messages.map((message) => message.position)).toEqual([0, 1]);
    const assistant = detail.messages[1]!;
    expect(assistant.versions.map((version) => version.parts)).toEqual([
      [{ type: 'text', text: 'a1' }],
      [{ type: 'text', text: 'a2' }],
      [{ type: 'text', text: 'a3' }],
    ]);
    expect(
      assistant.versions
        .filter((version) => version.selected)
        .map((version) => version.versionIndex),
    ).toEqual([2]); // newest selected

    await selectVersion(db, accountA.userId, assistant.id, 0);
    const repaged = (await getConversation(db, accountA.userId, conversation.id))!;
    expect(
      repaged.messages[1]!.versions
        .filter((version) => version.selected)
        .map((version) => version.versionIndex),
    ).toEqual([0]); // still exactly one
  });

  it('appends a new assistant message when the last message is a user turn', async () => {
    const conversation = await createConversation(db, accountA.userId, 'turns');
    await appendMessage(db, accountA.userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'q1' }],
    });
    await addReplyVersion(db, accountA.userId, conversation.id, [{ type: 'text', text: 'a1' }]);
    await appendMessage(db, accountA.userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'q2' }],
    });
    await addReplyVersion(db, accountA.userId, conversation.id, [{ type: 'text', text: 'a2' }]);

    const detail = (await getConversation(db, accountA.userId, conversation.id))!;
    expect(detail.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(detail.messages.map((message) => message.position)).toEqual([0, 1, 2, 3]);
    expect(detail.messages[1]!.versions.map((version) => version.parts)).toEqual([
      [{ type: 'text', text: 'a1' }],
    ]);
    expect(detail.messages[3]!.versions.map((version) => version.parts)).toEqual([
      [{ type: 'text', text: 'a2' }],
    ]);
  });

  it('cascades deletion to messages and versions', async () => {
    const conversation = await createConversation(db, accountA.userId, 'doomed');
    await appendMessage(db, accountA.userId, conversation.id, { role: 'user', parts: [] });
    await appendMessage(db, accountA.userId, conversation.id, { role: 'assistant', parts: [] });
    expect(await countMessages(db, accountA.userId, conversation.id)).toBe(2);

    await deleteConversation(db, accountA.userId, conversation.id);
    expect(await getConversation(db, accountA.userId, conversation.id)).toBeNull();
    expect(await countMessages(db, accountA.userId, conversation.id)).toBe(0);
    const versionCount = await pg.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM bob.message_versions v
       JOIN bob.messages m ON m.id = v.message_id
       WHERE m.conversation_id = $1`,
      [conversation.id],
    );
    expect(versionCount.rows[0]?.total).toBe(0);
    // idempotent
    await expect(deleteConversation(db, accountA.userId, conversation.id)).resolves.toBeUndefined();
  });

  it('truncates a suffix on edit while keeping the anchor message', async () => {
    const conversation = await createConversation(db, accountA.userId, 'edit me');
    const first = (await appendMessage(db, accountA.userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'first' }],
    }))!;
    await appendMessage(db, accountA.userId, conversation.id, { role: 'assistant', parts: [] });
    await appendMessage(db, accountA.userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'second' }],
    });

    await truncateAfterMessage(db, accountA.userId, conversation.id, first.id);
    const detail = (await getConversation(db, accountA.userId, conversation.id))!;
    expect(detail.messages.map((message) => message.position)).toEqual([0]);
  });

  it('rejects a stale write rather than applying it, across repeated attempts', async () => {
    const conversation = await createConversation(db, accountA.userId, 'racy');
    const readAt = conversation.updatedAt;

    await renameConversation(db, accountA.userId, conversation.id, 'moved on', readAt);
    // The stored updatedAt has advanced; every replay of the stale write loses.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        renameConversation(db, accountA.userId, conversation.id, `stale ${attempt}`, readAt),
      ).rejects.toThrow(StoreConflictError);
    }
    expect((await getConversation(db, accountA.userId, conversation.id))?.title).toBe('moved on');

    const current = (await getConversation(db, accountA.userId, conversation.id))!;
    await expect(
      deleteConversation(db, accountA.userId, conversation.id, current.updatedAt - 1),
    ).rejects.toThrow(StoreConflictError);
    expect(await getConversation(db, accountA.userId, conversation.id)).not.toBeNull();
  });

  it('advances the concurrency token on every write, even within one millisecond', async () => {
    const conversation = await createConversation(db, accountA.userId, 'fast');
    // Back-to-back writes complete well inside a millisecond. If the token did
    // not advance, a stale write would be indistinguishable from a current one
    // and would silently win -- which FR-052 forbids and SC-018 measures.
    const stamps = [conversation.updatedAt];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      stamps.push((await renameConversation(db, accountA.userId, conversation.id, `title ${attempt}`)).updatedAt);
    }
    for (let index = 1; index < stamps.length; index += 1) {
      expect(stamps[index]!).toBeGreaterThan(stamps[index - 1]!);
    }
  });

  it('derives a title from the opening message on a word boundary', () => {
    expect(deriveTitle('Hello there')).toBe('Hello there');
    expect(deriveTitle('   ')).toMatch(/^Voice chat /);
    const long = 'word '.repeat(30).trim();
    const title = deriveTitle(long);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('word')).toBe(true); // cut on a word boundary, not mid-word
    expect(
      deriveTitle('exactly-a-long-single-word-without-spaces-that-keeps-going-and-going-and-going'),
    ).toHaveLength(60);
  });

  it('isolates accounts: an other-account conversation is as-if not-found (C-18)', async () => {
    const conversation = await createConversation(db, accountA.userId, 'private');
    expect(await conversationExists(db, accountA.userId, conversation.id)).toBe(true);
    expect(await conversationExists(db, accountB.userId, conversation.id)).toBe(false);
    expect(await getConversation(db, accountB.userId, conversation.id)).toBeNull();
    await expect(
      renameConversation(db, accountB.userId, conversation.id, 'hijacked'),
    ).rejects.toThrow(StoreNotFoundError);
    // A cross-account stale rename is not-found, never a conflict (C-18).
    await expect(
      renameConversation(db, accountB.userId, conversation.id, 'stale', conversation.updatedAt),
    ).rejects.toThrow(StoreNotFoundError);
    // Delete of another account's id is the same quiet success as an unknown
    // id (no existence oracle, FR-008); the owner's row is untouched.
    await expect(deleteConversation(db, accountB.userId, conversation.id)).resolves.toBeUndefined();
    expect((await getConversation(db, accountA.userId, conversation.id))?.title).toBe('private');
    await expect(
      deleteConversation(db, accountB.userId, 'conv_00000000-0000-4000-8000-000000000000'),
    ).resolves.toBeUndefined();
  });

  it('persists and returns message origin', async () => {
    const conversation = await createConversation(db, accountA.userId, 'origins');
    await appendMessage(db, accountA.userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'web' }],
    });
    await appendMessage(db, accountA.userId, conversation.id, { role: 'user', parts: [], origin: 'web_voice' });
    await appendMessage(db, accountA.userId, conversation.id, { role: 'user', parts: [], origin: 'device' });

    const detail = (await getConversation(db, accountA.userId, conversation.id))!;
    expect(detail.messages.map((message) => message.origin)).toEqual([
      'web_text',
      'web_voice',
      'device',
    ]);
  });

  it('appends concurrently with contiguous unique positions', async () => {
    const conversation = await createConversation(db, accountA.userId, 'race');
    const appended = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        appendMessage(db, accountA.userId, conversation.id, {
          role: 'user',
          parts: [{ type: 'text', text: `m${i}` }],
        }),
      ),
    );
    expect(appended.map((message) => message!.position).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    const detail = (await getConversation(db, accountA.userId, conversation.id))!;
    expect(detail.messages.map((message) => message.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it('round-trips millisecond timestamps exactly (FR-052)', async () => {
    const conversation = await createConversation(db, accountA.userId, 'tick');
    const first = (await getConversation(db, accountA.userId, conversation.id))!;
    expect(first.createdAt).toBe(conversation.createdAt);
    expect(first.updatedAt).toBe(conversation.updatedAt);

    const renamed = await renameConversation(db, accountA.userId, conversation.id, 'tock');
    expect(renamed.updatedAt).toBeGreaterThan(conversation.updatedAt);
    const reread = (await getConversation(db, accountA.userId, conversation.id))!;
    expect(reread.updatedAt).toBe(renamed.updatedAt);

    // The exact read-back value is a valid token: the equality survives the
    // timestamptz round-trip, so an exact-token rename is not a conflict.
    await renameConversation(db, accountA.userId, conversation.id, 'exact token', reread.updatedAt);
    await expect(
      renameConversation(db, accountA.userId, conversation.id, 'stale', reread.updatedAt - 1),
    ).rejects.toThrow(StoreConflictError);
  });
});

describe('guard: no store query touches bob outside withUser', () => {
  let pg: TestDb;
  let db: Db;
  let account: TestAccount;

  beforeAll(async () => {
    pg = await createTestDb();
    account = await addAccount(pg);
    // The production connection is bob_server (NOBYPASSRLS, no grants on
    // schema bob), so any RLS-external query fails here exactly as in prod
    // (spike test e: SET ROLE bob_server then SET LOCAL ROLE authenticated).
    await pg.exec('set role bob_server');
    db = asDb(pg);
  });

  afterAll(async () => {
    await closeTestDb(pg);
  });

  it('a raw base-connection read sees zero bob rows (RLS, no claims)', async () => {
    // bob_server inherits authenticated's grants (migration: grant
    // authenticated to bob_server), so the read succeeds -- but auth.uid()
    // is null and the policies filter it to nothing. Account data is
    // reachable only through withUser; a future RLS-external query would be
    // blind here, exactly as in production.
    expect(await db.query(`SELECT 1 AS one FROM bob.conversations`)).toEqual([]);
  });

  it('runs every exported store function under withUser', async () => {
    const conversation = await createConversation(db, account.userId, 'guard');
    expect(await conversationExists(db, account.userId, conversation.id)).toBe(true);
    await appendMessage(db, account.userId, conversation.id, { role: 'user', parts: [] });
    await appendMessage(db, account.userId, conversation.id, { role: 'assistant', parts: [] });
    await addReplyVersion(db, account.userId, conversation.id, [{ type: 'text', text: 'v' }]);
    const detail = (await getConversation(db, account.userId, conversation.id))!;
    expect(detail.messages).toHaveLength(2);
    await selectVersion(db, account.userId, detail.messages[1]!.id, 0);
    await truncateAfterMessage(db, account.userId, conversation.id, detail.messages[0]!.id);
    await renameConversation(db, account.userId, conversation.id, 'guard 2');
    expect(await countMessages(db, account.userId, conversation.id)).toBe(1);
    expect((await listConversations(db, account.userId)).map((entry) => entry.id)).toEqual([
      conversation.id,
    ]);
    await deleteConversation(db, account.userId, conversation.id);
    expect(await listConversations(db, account.userId)).toEqual([]);
  });
});