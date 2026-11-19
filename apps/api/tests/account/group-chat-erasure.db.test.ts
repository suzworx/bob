import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import { readAccountExport } from '../../src/account/export-http.ts';
import { eraseAccount, ERASED_USER_ID, EraseRefusedError } from '../../src/account/erasure-service.ts';
import { acceptGroupChatLink, createGroupChat, createGroupChatLink, getGroupChat, previewGroupChatLink, removeGroupChatMember } from '../../src/spaces/group-chat-store.ts';
import { listMessages, postMessage } from '../../src/conversations/thread-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, withUserRaw, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

describe('group chat account erasure', () => {
  it('preserves a departed creator group while erasing provenance and issued links', async () => {
    const owner = await addAccount(pg);
    const member = await addAccount(pg);
    const outsider = await addAccount(pg);
    const requestId = randomUUID();
    const chat = await createGroupChat(db, owner.userId, { requestId });
    const link = await createGroupChatLink(db, owner.userId, chat.id);
    await acceptGroupChatLink(db, member.userId, link.token);
    await postMessage(db, owner.userId, { threadId: chat.id, body: 'Retained contribution', clientMessageId: randomUUID() });
    await removeGroupChatMember(db, owner.userId, chat.id, owner.userId);
    await eraseAccount({ db, userId: owner.userId, now: Date.now() });
    expect((await getGroupChat(db, member.userId, chat.id)).role).toBe('owner');
    const provenance = await withUserRaw(pg, member.userId, (tx) => tx.query<{ group_chat_created_by: string; group_chat_request_id: string }>(
      'select group_chat_created_by, group_chat_request_id from bob.spaces where id = $1', [chat.space_id],
    ));
    expect(provenance.rows[0]?.group_chat_created_by).toBe(ERASED_USER_ID);
    expect(provenance.rows[0]?.group_chat_request_id).not.toBe(requestId);
    const links = await withUserRaw(pg, member.userId, (tx) => tx.query(
      'select id from bob.group_chat_links where space_id = $1 and created_by = $2', [chat.space_id, owner.userId],
    ));
    expect(links.rows).toEqual([]);
    expect((await listMessages(db, member.userId, chat.id)).messages[0]?.authorUserId).toBe(ERASED_USER_ID);
    await expect(previewGroupChatLink(db, outsider.userId, link.token)).rejects.toThrow();
    await expect(acceptGroupChatLink(db, outsider.userId, link.token)).rejects.toThrow();
    await expect(eraseAccount({ db, userId: owner.userId, now: Date.now() })).resolves.toBeDefined();
  });

  it('exports active group membership and only the callers safe invitation metadata', async () => {
    const owner = await addAccount(pg);
    const member = await addAccount(pg);
    const outsider = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const link = await createGroupChatLink(db, owner.userId, chat.id);
    await acceptGroupChatLink(db, member.userId, link.token);
    const memberLink = await createGroupChatLink(db, member.userId, chat.id);
    const exported = await readAccountExport(db, member.userId);
    expect(exported.group_chats).toEqual([{ id: chat.id, space_id: chat.space_id, title: chat.title, role: 'member' }]);
    expect(exported.group_chat_links).toEqual([expect.objectContaining({ space_id: chat.space_id, revoked_at: null })]);
    expect(Object.keys(exported.group_chat_links[0] ?? {}).sort()).toEqual(['created_at', 'expires_at', 'id', 'revoked_at', 'space_id']);
    expect(JSON.stringify(exported)).not.toContain(link.token);
    expect(JSON.stringify(exported)).not.toContain(memberLink.token);
    expect(exported.conversations).toEqual([]);
    expect((await readAccountExport(db, outsider.userId)).group_chats).toEqual([]);
    expect((await readAccountExport(db, outsider.userId)).group_chat_links).toEqual([]);
    await removeGroupChatMember(db, member.userId, chat.id, member.userId);
    expect((await readAccountExport(db, member.userId)).group_chats).toEqual([]);
    expect((await readAccountExport(db, member.userId)).group_chat_links).toEqual([]);
  });
  it('refuses a live sole owner, then erases after the last member leaves', async () => {
    const owner = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    await expect(eraseAccount({ db, userId: owner.userId, now: Date.now() })).rejects.toBeInstanceOf(EraseRefusedError);
    expect((await getGroupChat(db, owner.userId, chat.id)).role).toBe('owner');
    await removeGroupChatMember(db, owner.userId, chat.id, owner.userId);
    await expect(eraseAccount({ db, userId: owner.userId, now: Date.now() })).resolves.toBeDefined();
  });
});
