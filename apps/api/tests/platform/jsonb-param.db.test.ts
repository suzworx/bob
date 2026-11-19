/**
 * jsonbParam against a real local Postgres (#898 escaped defect 15): parts
 * written through messages.ts land as a proper jsonb array, not the
 * double-encoded string the pre-fix `$N::jsonb` bind produced (jsonb_typeof
 * 'string'); a version already stored that way (simulated here with the old
 * bind, which still double-encodes under postgres.js prepare:true) still
 * reads back as the same parts through the existing read path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { jsonbParam } from '../../src/platform/db/jsonb.ts';
import { appendMessage, createConversation, getConversation } from '../../src/conversations/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

describe('jsonbParam (real database)', () => {
  let testDb: TestDb;
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = asDb(testDb);
    ({ userId } = await addAccount(testDb));
  });

  afterAll(async () => {
    await closeTestDb(testDb);
  });

  async function partsTypeOf(messageId: string): Promise<string> {
    return withUser(db, userId, async (tx) => {
      const rows = await tx.query<{ t: string }>(
        `SELECT jsonb_typeof(parts) AS t FROM bob.message_versions WHERE message_id = $1 AND is_selected`,
        [messageId],
      );
      return rows[0]!.t;
    });
  }

  it('returns the text-bind-and-cast form', () => {
    expect(jsonbParam('$4')).toBe('$4::text::jsonb');
  });

  it('stores parts written through messages.ts as a jsonb array, not a string', async () => {
    const conversation = await createConversation(db, userId, 'jsonb array test');
    const parts = [{ type: 'text', text: 'hello' }];
    const message = await appendMessage(db, userId, conversation.id, { role: 'user', parts });
    expect(message).not.toBeNull();
    expect(await partsTypeOf(message!.id)).toBe('array');
  });

  it('still reads a pre-existing double-encoded row as the same parts', async () => {
    const conversation = await createConversation(db, userId, 'legacy jsonb test');
    const parts = [{ type: 'text', text: 'legacy reply' }];
    const message = await appendMessage(db, userId, conversation.id, { role: 'user', parts });
    expect(message).not.toBeNull();

    // Adds a second version the way the pre-#898 editMessage/insertVersion did:
    // a bare $N::jsonb bind of an already-serialized string, which still
    // double-encodes under postgres.js prepare:true (message_versions.parts has
    // no UPDATE grant for authenticated, so legacy rows only ever arrive by INSERT).
    await withUser(db, userId, async (tx) => {
      await tx.query(`UPDATE bob.message_versions SET is_selected = false WHERE message_id = $1`, [message!.id]);
      await tx.query(
        `INSERT INTO bob.message_versions (message_id, user_id, space_id, parts, version_index, is_selected)
         SELECT $1, $2, space_id, $3::jsonb, coalesce(max(version_index) + 1, 0), true
         FROM bob.message_versions WHERE message_id = $1 GROUP BY space_id`,
        [message!.id, userId, JSON.stringify(parts)],
      );
    });
    expect(await partsTypeOf(message!.id)).toBe('string');

    const detail = await getConversation(db, userId, conversation.id);
    const stored = detail!.messages.find((m) => m.id === message!.id);
    const selected = stored!.versions.find((v) => v.selected);
    expect(selected!.parts).toEqual(parts);
  });
});
