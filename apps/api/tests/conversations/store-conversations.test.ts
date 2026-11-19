import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreConflictError, type Db } from '../../src/platform/db/db.ts';
import {
  addReplyVersion,
  appendMessage,
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
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import {
  asDb,
  closeTestDb,
  createTestDb,
  type TestDb,
} from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let userId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  userId = await resolveDevAccount(db);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

describe('conversation store', () => {
  it('orders the sidebar list by updatedAt descending and searches titles case-insensitively', async () => {
    const older = await createConversation(db, userId, 'Cardputer reply truncation');
    const newer = await createConversation(db, userId, 'Garden planning');
    await pg.query(
      `UPDATE bob.conversations SET updated_at = updated_at - interval '1 second' WHERE id = $1`,
      [older.id],
    );

    let list = await listConversations(db, userId);
    expect(list.map((entry) => entry.id)).toEqual([newer.id, older.id]);

    list = await listConversations(db, userId, { q: 'CARDPUTER' });
    expect(list.map((entry) => entry.id)).toEqual([older.id]);

    expect(await listConversations(db, userId)).toEqual(await listConversations(db, userId));
  });

  it('returns messages in position order with exactly one selected version each', async () => {
    const conversation = await createConversation(db, userId, 'versions');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'q' }] });
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'a1' }] });
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'a2' }]);
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'a3' }]);

    const detail = (await getConversation(db, userId, conversation.id))!;
    expect(detail.messages.map((message) => message.position)).toEqual([0, 1]);
    const assistant = detail.messages[1]!;
    expect(assistant.versions.map((version) => version.parts)).toEqual([
      [{ type: 'text', text: 'a1' }],
      [{ type: 'text', text: 'a2' }],
      [{ type: 'text', text: 'a3' }],
    ]);
    expect(assistant.versions.filter((version) => version.selected).map((version) => version.versionIndex))
      .toEqual([2]); // newest selected

    await selectVersion(db, userId, assistant.id, 0);
    const repaged = (await getConversation(db, userId, conversation.id))!;
    expect(repaged.messages[1]!.versions.filter((version) => version.selected).map((version) => version.versionIndex))
      .toEqual([0]); // still exactly one
  });

  it('appends a new assistant message when the last message is a user turn', async () => {
    const conversation = await createConversation(db, userId, 'turns');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'q1' }] });
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'a1' }]);
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'q2' }] });
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'a2' }]);

    const detail = (await getConversation(db, userId, conversation.id))!;
    expect(detail.messages.map((message) => message.role)).toEqual([
      'user', 'assistant', 'user', 'assistant',
    ]);
    expect(detail.messages.map((message) => message.position)).toEqual([0, 1, 2, 3]);
    // Each reply is its own message with exactly one version, not a version of
    // the first assistant turn (the answer must sit under its question).
    expect(detail.messages[1]!.versions.map((version) => version.parts)).toEqual([
      [{ type: 'text', text: 'a1' }],
    ]);
    expect(detail.messages[3]!.versions.map((version) => version.parts)).toEqual([
      [{ type: 'text', text: 'a2' }],
    ]);
  });

  it('cascades deletion to messages and versions', async () => {
    const conversation = await createConversation(db, userId, 'doomed');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [] });
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [] });
    expect(await countMessages(db, userId, conversation.id)).toBe(2);

    await deleteConversation(db, userId, conversation.id);
    expect(await getConversation(db, userId, conversation.id)).toBeNull();
    expect(await countMessages(db, userId, conversation.id)).toBe(0);
    const versions = await pg.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM bob.message_versions v
       JOIN bob.messages m ON m.id = v.message_id
       WHERE m.conversation_id = $1`,
      [conversation.id],
    );
    expect(versions.rows[0]?.total).toBe(0);
    // idempotent
    await expect(deleteConversation(db, userId, conversation.id)).resolves.toBeUndefined();
  });

  it('truncates a suffix on edit while keeping the anchor message', async () => {
    const conversation = await createConversation(db, userId, 'edit me');
    const first = (await appendMessage(db, userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'first' }],
    }))!;
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [] });
    await appendMessage(db, userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'second' }],
    });

    await truncateAfterMessage(db, userId, conversation.id, first.id);
    const detail = (await getConversation(db, userId, conversation.id))!;
    expect(detail.messages.map((message) => message.position)).toEqual([0]);
  });

  it('rejects a stale write rather than applying it, across repeated attempts', async () => {
    const conversation = await createConversation(db, userId, 'racy');
    const readAt = conversation.updatedAt;

    await renameConversation(db, userId, conversation.id, 'moved on', readAt);
    // The stored updatedAt has advanced; every replay of the stale write loses.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        renameConversation(db, userId, conversation.id, `stale ${attempt}`, readAt),
      ).rejects.toThrow(StoreConflictError);
    }
    expect((await getConversation(db, userId, conversation.id))?.title).toBe('moved on');

    const current = (await getConversation(db, userId, conversation.id))!;
    await expect(
      deleteConversation(db, userId, conversation.id, current.updatedAt - 1),
    ).rejects.toThrow(StoreConflictError);
    expect(await getConversation(db, userId, conversation.id)).not.toBeNull();
  });

  it('advances the concurrency token on every write, even within one millisecond', async () => {
    const conversation = await createConversation(db, userId, 'fast');
    // Back-to-back writes complete well inside a millisecond. If the token did
    // not advance, a stale write would be indistinguishable from a current one
    // and would silently win -- which FR-052 forbids and SC-018 measures.
    const stamps = [conversation.updatedAt];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      stamps.push((await renameConversation(db, userId, conversation.id, `title ${attempt}`)).updatedAt);
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
    expect(deriveTitle('exactly-a-long-single-word-without-spaces-that-keeps-going-and-going-and-going'))
      .toHaveLength(60);
  });
});