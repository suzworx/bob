// #415: loadRecentHistory is the bounded history read. Its output must equal
// what the unbounded getConversation + selected-else-first + trimHistory
// pipeline produced, while reading at most `limit` message and version rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import {
  addReplyVersion,
  appendMessage,
  createConversation,
  getConversation,
  loadRecentHistory,
  selectVersion,
  type RecentMessage,
} from '../../src/conversations/store.ts';
import { MAX_HISTORY_MESSAGES, trimHistory } from '../../src/voice/turn-core.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import { asDb, addAccount, closeTestDb, createTestDb, withUserRaw, type TestDb } from '../support/test-db.ts';

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

/** Today's pipeline: the full read, each message's selected-else-first version, then the trim. */
async function unboundedHistory(conversationId: string, limit: number): Promise<RecentMessage[]> {
  const detail = await getConversation(db, userId, conversationId);
  if (!detail) return [];
  return trimHistory(
    detail.messages.map((message) => ({
      id: message.id,
      role: message.role,
      position: message.position,
      origin: message.origin,
      parts: (message.versions.find((version) => version.selected) ?? message.versions[0])?.parts ?? [],
    })),
    limit,
  );
}

/** Bulk-seeds `count` alternating user/assistant messages, one selected version each. */
async function seeded(count: number): Promise<string> {
  const conversation = await createConversation(db, userId, `seeded ${count}`);
  await withUserRaw(pg, userId, async (tx) => {
    await tx.query(
      `INSERT INTO bob.messages (id, conversation_id, user_id, role, position, origin, created_at)
       SELECT $1 || '_m' || g, $1, $2::uuid, CASE WHEN g % 2 = 0 THEN 'user' ELSE 'assistant' END, g, 'web_text', now()
       FROM generate_series(0, $3::int - 1) AS g`,
      [conversation.id, userId, count],
    );
    await tx.query(
      `INSERT INTO bob.message_versions (id, message_id, user_id, parts, version_index, is_selected, created_at)
       SELECT $1 || '_v' || g, $1 || '_m' || g, $2::uuid,
              jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'm' || g)), 0, true, now()
       FROM generate_series(0, $3::int - 1) AS g`,
      [conversation.id, userId, count],
    );
  });
  return conversation.id;
}

describe('loadRecentHistory', () => {
  for (const count of [0, 1, 40, 41, 200]) {
    it(`equals the unbounded read + trim for M = ${count}, reading at most limit rows`, async () => {
      const id = await seeded(count);
      const recent = await loadRecentHistory(db, userId, id, MAX_HISTORY_MESSAGES);
      expect(recent).toEqual(await unboundedHistory(id, MAX_HISTORY_MESSAGES));
      expect(recent.length).toBe(Math.min(count, MAX_HISTORY_MESSAGES));
      expect(recent.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    });
  }

  it('picks the selected version, including one that is not the first or the newest', async () => {
    const conversation = await createConversation(db, userId, 'regenerated');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'q' }] });
    const answer = await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'a1' }] });
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'a2' }]);
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'a3' }]);
    await selectVersion(db, userId, answer!.id, 1);

    const recent = await loadRecentHistory(db, userId, conversation.id, MAX_HISTORY_MESSAGES);
    expect(recent.map((message) => message.parts)).toEqual([
      [{ type: 'text', text: 'q' }],
      [{ type: 'text', text: 'a2' }],
    ]);
    expect(recent).toEqual(await unboundedHistory(conversation.id, MAX_HISTORY_MESSAGES));
  });

  it('falls back to the lowest version_index when no version is selected', async () => {
    const conversation = await createConversation(db, userId, 'unselected');
    const answer = await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'a1' }] });
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'a2' }]);
    await withUserRaw(pg, userId, async (tx) => {
      await tx.query(`UPDATE bob.message_versions SET is_selected = false WHERE message_id = $1`, [answer!.id]);
    });

    const recent = await loadRecentHistory(db, userId, conversation.id, MAX_HISTORY_MESSAGES);
    expect(recent.map((message) => message.parts)).toEqual([[{ type: 'text', text: 'a1' }]]);
    expect(recent).toEqual(await unboundedHistory(conversation.id, MAX_HISTORY_MESSAGES));
  });

  it('textOnly strips a file part url but keeps its type and mediaType; full keeps it', async () => {
    const conversation = await createConversation(db, userId, 'image');
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const parts = [
      { type: 'text', text: 'look' },
      { type: 'file', mediaType: 'image/png', url, filename: 'pixel.png' },
    ];
    await appendMessage(db, userId, conversation.id, { role: 'user', parts });

    const textOnly = await loadRecentHistory(db, userId, conversation.id, MAX_HISTORY_MESSAGES, { textOnly: true });
    expect(textOnly[0]!.parts).toEqual([
      { type: 'text', text: 'look' },
      { type: 'file', mediaType: 'image/png', filename: 'pixel.png' },
    ]);
    expect(JSON.stringify(textOnly)).not.toContain('data:');

    const full = await loadRecentHistory(db, userId, conversation.id, MAX_HISTORY_MESSAGES);
    expect(full[0]!.parts).toEqual(parts);
  });

  it('answers [] to another account (RLS) and to an unknown id', async () => {
    const id = await seeded(3);
    const other = await addAccount(pg, {});
    expect(await loadRecentHistory(db, other.userId, id, MAX_HISTORY_MESSAGES)).toEqual([]);
    expect(await loadRecentHistory(db, userId, 'cnv_does_not_exist', MAX_HISTORY_MESSAGES)).toEqual([]);
  });

  it('requireConversation answers null for a missing or other-account row, history otherwise', async () => {
    const id = await seeded(3);
    const empty = await createConversation(db, userId, 'empty');
    const other = await addAccount(pg, {});
    const require = { requireConversation: true } as const;
    expect(await loadRecentHistory(db, userId, 'cnv_does_not_exist', MAX_HISTORY_MESSAGES, require)).toBeNull();
    expect(await loadRecentHistory(db, other.userId, id, MAX_HISTORY_MESSAGES, require)).toBeNull();
    expect(await loadRecentHistory(db, userId, empty.id, MAX_HISTORY_MESSAGES, require)).toEqual([]);
    expect(await loadRecentHistory(db, userId, id, MAX_HISTORY_MESSAGES, require)).toEqual(
      await loadRecentHistory(db, userId, id, MAX_HISTORY_MESSAGES),
    );
  });

  it('decodes parts stored double-encoded as a jsonb string, full and textOnly', async () => {
    const conversation = await createConversation(db, userId, 'double-encoded');
    const url = 'data:image/png;base64,iVBORw0KGgo=';
    const parts = [
      { type: 'text', text: 'look' },
      { type: 'file', mediaType: 'image/png', url, filename: 'pixel.png' },
    ];
    await withUserRaw(pg, userId, async (tx) => {
      await tx.query(
        `INSERT INTO bob.messages (id, conversation_id, user_id, role, position, origin, created_at)
         VALUES ($1 || '_m0', $1, $2::uuid, 'user', 0, 'web_text', now())`,
        [conversation.id, userId],
      );
      await tx.query(
        `INSERT INTO bob.message_versions (id, message_id, user_id, parts, version_index, is_selected, created_at)
         VALUES ($1 || '_v0', $1 || '_m0', $2::uuid, to_jsonb($3::text), 0, true, now())`,
        [conversation.id, userId, JSON.stringify(parts)],
      );
      const stored = await tx.query<{ kind: string }>(
        `SELECT jsonb_typeof(parts) AS kind FROM bob.message_versions WHERE id = $1 || '_v0'`,
        [conversation.id],
      );
      expect(stored.rows[0]!.kind).toBe('string');
    });

    const full = await loadRecentHistory(db, userId, conversation.id, MAX_HISTORY_MESSAGES);
    expect(full[0]!.parts).toEqual(parts);
    const textOnly = await loadRecentHistory(db, userId, conversation.id, MAX_HISTORY_MESSAGES, { textOnly: true });
    expect(textOnly[0]!.parts).toEqual([
      { type: 'text', text: 'look' },
      { type: 'file', mediaType: 'image/png', filename: 'pixel.png' },
    ]);
    expect(JSON.stringify(textOnly)).not.toContain('data:');
  });
});
