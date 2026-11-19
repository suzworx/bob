/**
 * General stays on PRIVATE conversations once #756 PR1 copies space threads
 * into bob.conversations (CONV-UNIFY-U1, `npm run test:db` only). A owns a
 * migrated group-space conversation (user_id = A, the creator): every General
 * read, write, the export, the account purge, device activity and the memory
 * extraction queue must treat it as an unknown id. Private writes fill the
 * unified columns, and a straggler row with no space is healed on append.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../../src/platform/db/db.ts';
import {
  addReplyVersion, appendMessage, conversationExists, createConversation, deleteConversation, getConversation,
  getConversationSummary, listConversations, loadRecentHistory, renameConversation, setConversationFlag,
} from '../../src/conversations/store.ts';
import { purgeAccountContent } from '../../src/account/store.ts';
import { listDeviceActivity } from '../../src/devices/activity.ts';
import { listUnextracted } from '../../src/memory/extract-queue.ts';
import * as pairing from '../../src/devices/pairing-service.ts';
import { readAccountExport } from '../../src/account/export-http.ts';
import { setupMemoryTestDb, teardownMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

let env: MemoryTestDb | undefined;
let DEVICE = '';
const GROUP = randomUUID();
const GROUP_MSG = randomUUID();
const text = (t: string) => [{ type: 'text', text: t }];

/** A's view of the raw rows, bypassing every General query. */
async function rawSelect<T>(sql: string, params: unknown[]): Promise<T[]> {
  return withUser(env!.db, env!.a.userId, (tx) => tx.query<T>(sql, params));
}

describe('General is scoped to private conversations (#756 CONV-UNIFY-U1)', () => {
  beforeAll(async () => {
    env = await setupMemoryTestDb();
    const { db, a, spaces } = env;
    const issued = await pairing.issueCode(db, {
      model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.69',
    });
    DEVICE = await pairing.approve(db, a.userId, issued.pairingId, 'Kitchen');
    await withUser(db, a.userId, async (tx) => {
      await tx.query(
        `insert into bob.conversations (id, user_id, space_id, created_by, title, last_sequence)
         values ($1, $2, $3, $2, 'family plans', 1)`,
        [GROUP, a.userId, spaces.groupABC],
      );
      await tx.query(
        `insert into bob.messages (id, conversation_id, space_id, user_id, author_user_id, role,
           position, sequence, origin, device_id)
         values ($1, $2, $3, $4, $4, 'user', 0, 1, 'device', $5)`,
        [GROUP_MSG, GROUP, spaces.groupABC, a.userId, DEVICE],
      );
      await tx.query(
        `insert into bob.message_versions (id, message_id, user_id, space_id, parts, version_index, is_selected)
         values ($1, $2, $3, $4, $5::jsonb, 0, true)`,
        [`ver_${GROUP_MSG}`, GROUP_MSG, a.userId, spaces.groupABC, JSON.stringify(text('family secret'))],
      );
    });
  }, 300_000);

  afterAll(async () => {
    await teardownMemoryTestDb(env);
  });

  it('General reads answer a shared id as unknown', async () => {
    const { db, a } = env!;
    expect((await listConversations(db, a.userId)).map((c) => c.id)).not.toContain(GROUP);
    expect(await conversationExists(db, a.userId, GROUP)).toBe(false);
    expect(await getConversationSummary(db, a.userId, GROUP)).toBeNull();
    expect(await getConversation(db, a.userId, GROUP)).toBeNull();
    expect(await loadRecentHistory(db, a.userId, GROUP, 10, { requireConversation: true })).toBeNull();
  });

  it('General writes refuse a shared id and delete leaves it in place', async () => {
    const { db, a } = env!;
    await expect(renameConversation(db, a.userId, GROUP, 'mine now')).rejects.toThrow(/not found/);
    await expect(setConversationFlag(db, a.userId, GROUP, 'pinned', true)).rejects.toThrow(/not found/);
    await expect(appendMessage(db, a.userId, GROUP, { role: 'user', parts: text('hi') })).rejects.toThrow(/not found/);
    await expect(addReplyVersion(db, a.userId, GROUP, text('reply'))).rejects.toThrow(/not found/);
    await deleteConversation(db, a.userId, GROUP);
    expect(await rawSelect('select id, title from bob.conversations where id = $1', [GROUP]))
      .toEqual([{ id: GROUP, title: 'family plans' }]);
  });

  it('export, device activity and the extraction queue skip the shared conversation', async () => {
    const { db, a } = env!;
    const exported = await readAccountExport(db, a.userId);
    expect(exported.conversations.map((c) => c.id)).not.toContain(GROUP);
    const activity = await listDeviceActivity(db, a.userId, { id: DEVICE, pairedAt: 0 }, 20);
    const turns = activity.filter((item) => item.kind === 'turn');
    // General never shows the shared conversation; it appears once, as a thread turn.
    expect(turns.filter((item) => 'conversation_id' in item && item.conversation_id === GROUP)).toEqual([]);
    expect(turns.filter((item) => 'thread_id' in item && item.thread_id === GROUP))
      .toEqual([expect.objectContaining({ thread_id: GROUP, space_id: env!.spaces.groupABC })]);
    expect((await listUnextracted(db, a.userId, 500)).map((t) => t.messageId)).not.toContain(GROUP_MSG);
  });

  it('private writes fill space_id, created_by, sequence and last_sequence', async () => {
    const { db, a, spaces } = env!;
    const conv = await createConversation(db, a.userId, 'private chat');
    await appendMessage(db, a.userId, conv.id, { role: 'user', parts: text('question') });
    await addReplyVersion(db, a.userId, conv.id, text('answer'));
    await addReplyVersion(db, a.userId, conv.id, text('answer again'));
    expect(await rawSelect('select space_id, created_by, last_sequence::int from bob.conversations where id = $1', [conv.id]))
      .toEqual([{ space_id: spaces.privateA, created_by: a.userId, last_sequence: 2 }]);
    expect(await rawSelect(
      `select role, position, sequence::int, space_id, author_user_id from bob.messages
        where conversation_id = $1 order by position`, [conv.id],
    )).toEqual([
      { role: 'user', position: 0, sequence: 1, space_id: spaces.privateA, author_user_id: a.userId },
      { role: 'assistant', position: 1, sequence: 2, space_id: spaces.privateA, author_user_id: null },
    ]);
    const versions = await rawSelect<{ space_id: string }>(
      `select v.space_id from bob.message_versions v join bob.messages m on m.id = v.message_id
        where m.conversation_id = $1`, [conv.id],
    );
    expect(versions.map((v) => v.space_id)).toEqual([spaces.privateA, spaces.privateA, spaces.privateA]);
  });

  it('an append heals a conversation row that has no space', async () => {
    const { db, a, spaces } = env!;
    const id = `cnv_straggler_${randomUUID().slice(0, 8)}`;
    await rawSelect(`insert into bob.conversations (id, user_id, title) values ($1, $2, 'old')`, [id, a.userId]);
    await appendMessage(db, a.userId, id, { role: 'user', parts: text('hello') });
    expect(await rawSelect('select space_id from bob.conversations where id = $1', [id]))
      .toEqual([{ space_id: spaces.privateA }]);
  });

  // Last: erases A's private content.
  it('the account purge never deletes a shared conversation', async () => {
    const { db, a, b } = env!;
    await purgeAccountContent(db, a.userId, { googleAccounts: false, memories: false });
    const seenByB = await withUser(db, b.userId, (tx) =>
      tx.query<{ id: string }>('select id from bob.conversations where id = $1', [GROUP]));
    expect(seenByB).toEqual([{ id: GROUP }]);
  });
});
