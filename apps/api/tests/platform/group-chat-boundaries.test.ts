import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import { createGroupChat, createGroupChatLink, acceptGroupChatLink, removeGroupChatMember, listGroupChatMembers } from '../../src/spaces/group-chat-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, withUserRaw, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

it('blocks direct membership and audience mutation, including attempts by the owner', async () => {
  const owner = await addAccount(pg);
  const guest = await addAccount(pg);
  const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
  await expect(withUserRaw(pg, owner.userId, (tx) => tx.query(
    "INSERT INTO bob.space_memberships(space_id,user_id,role) VALUES($1,$2,'member')", [chat.space_id, guest.userId],
  ))).rejects.toThrow();
  await expect(withUserRaw(pg, owner.userId, (tx) => tx.query(
    'UPDATE bob.spaces SET conversation_id = NULL, group_chat_request_id = NULL, group_chat_created_by = NULL WHERE id = $1', [chat.space_id],
  ))).rejects.toThrow('immutable group chat binding');
  await expect(withUserRaw(pg, owner.userId, (tx) => tx.query(
    'UPDATE bob.spaces SET owner_user_id = $2 WHERE id = $1', [chat.space_id, guest.userId],
  ))).rejects.toThrow('use group chat lifecycle');
  const deleted = await withUserRaw(pg, owner.userId, (tx) => tx.query(
    'DELETE FROM bob.space_memberships WHERE space_id = $1 RETURNING user_id', [chat.space_id],
  ));
  expect(deleted.rows).toHaveLength(0);
});

it('rejects the ordinary invitation path and hides member email at the SQL profile boundary', async () => {
  const owner = await addAccount(pg);
  const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
  await expect(withUserRaw(pg, owner.userId, (tx) => tx.query(
    `INSERT INTO bob.space_invitations(space_id, invited_email, role, token_hash, expires_at, created_by)
     VALUES($1,'synthetic@example.invalid','member',$2,now()+interval '1 day',$3)`,
    [chat.space_id, 'a'.repeat(64), owner.userId],
  ))).rejects.toThrow('conversation-only audience');
  const profiles = await withUserRaw(pg, owner.userId, (tx) => tx.query<{ email: string | null }>(
    'SELECT email FROM bob_private.space_member_profiles($1)', [chat.space_id],
  ));
  expect(profiles.rows).toEqual([{ email: null }]);
});

it('transfers ownership on departure while retaining the original retry provenance', async () => {
  const owner = await addAccount(pg);
  const guest = await addAccount(pg);
  const requestId = randomUUID();
  const chat = await createGroupChat(db, owner.userId, { requestId });
  const link = await createGroupChatLink(db, owner.userId, chat.id);
  await acceptGroupChatLink(db, guest.userId, link.token);
  await removeGroupChatMember(db, owner.userId, chat.id, owner.userId);
  expect(await listGroupChatMembers(db, guest.userId, chat.id)).toEqual([
    expect.objectContaining({ user_id: guest.userId, role: 'owner' }),
  ]);
  const provenance = await withUserRaw(pg, guest.userId, (tx) => tx.query<{ group_chat_created_by: string; group_chat_request_id: string }>(
    'SELECT group_chat_created_by, group_chat_request_id FROM bob.spaces WHERE id=$1', [chat.space_id],
  ));
  expect(provenance.rows).toEqual([{ group_chat_created_by: owner.userId, group_chat_request_id: requestId }]);
});

