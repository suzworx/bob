import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import { addReplyVersion, appendMessage, createConversation, getConversation } from '../../src/conversations/store.ts';
import { archiveThread, createThread, listMessages, postMessage, renameThread } from '../../src/conversations/thread-store.ts';
import { createTask } from '../../src/tasks/store.ts';
import { addMember, createSpace, listMembers, listSpaces } from '../../src/spaces/store.ts';
import { createInvitation, StoreForbiddenError } from '../../src/spaces/invitations.ts';
import { GroupChatSchema } from '../../src/spaces/schemas.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import {
  acceptGroupChatLink, createGroupChat, createGroupChatLink, getGroupChat,
  listGroupChatMembers, listGroupChats, previewGroupChatLink,
  removeGroupChatMember, revokeGroupChatLinks,
} from '../../src/spaces/group-chat-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, withUserRaw, withAdminAuth, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });

describe('individual group chats', () => {
  it('copies only selected history into new messages and leaves the original private and independent', async () => {
    const owner = await addAccount(pg);
    const guest = await addAccount(pg);
    const source = await createConversation(db, owner.userId, 'Weekend');
    await appendMessage(db, owner.userId, source.id, { role: 'user', parts: [{ type: 'text', text: 'A walk?' }] });
    await addReplyVersion(db, owner.userId, source.id, [{ type: 'text', text: 'Hidden first draft' }]);
    await addReplyVersion(db, owner.userId, source.id, [{ type: 'text', text: 'Try the park' }]);
    const original = await getConversation(db, owner.userId, source.id);
    if (!original) throw new Error('Source fixture missing');
    const group = await createGroupChat(db, owner.userId, { requestId: randomUUID(), sourceConversationId: source.id });
    expect(group.id).not.toBe(source.id);
    expect(group).toMatchObject({ title: 'Weekend', created_by: owner.userId, role: 'owner' });
    expect(await getConversation(db, owner.userId, source.id)).toEqual(original);
    const { token } = await createGroupChatLink(db, owner.userId, group.id);
    await acceptGroupChatLink(db, guest.userId, token);
    const copied = (await listMessages(db, guest.userId, group.id)).messages;
    expect(copied.map((message) => message.body)).toEqual(['A walk?', 'Try the park']);
    expect(copied.map((message) => message.authorUserId)).toEqual([owner.userId, null]);
    expect(copied.map((message) => message.createdAt)).toEqual(original.messages.map((message) => message.createdAt));
    expect(copied.every((message) => !original.messages.some((old) => old.id === message.id))).toBe(true);
    await expect(getConversation(db, guest.userId, source.id)).resolves.toBeNull();
    await appendMessage(db, owner.userId, source.id, { role: 'user', parts: [{ type: 'text', text: 'Private follow-up' }] });
    await postMessage(db, guest.userId, { threadId: group.id, body: 'Shared follow-up', clientMessageId: randomUUID() });
    expect((await listMessages(db, owner.userId, group.id)).messages.map((message) => message.body))
      .toEqual(['A walk?', 'Try the park', 'Shared follow-up']);
    expect((await getConversation(db, owner.userId, source.id))?.messages).toHaveLength(3);
  });

  it('requires explicit text-only consent for rich history and never copies private file parts', async () => {
    const owner = await addAccount(pg);
    const source = await createConversation(db, owner.userId, 'Attachment');
    await appendMessage(db, owner.userId, source.id, { role: 'user', parts: [
      { type: 'text', text: 'Visible caption' },
      { type: 'file', mediaType: 'image/png', url: 'https://example.invalid/private.png' },
    ] });
    const requestId = randomUUID();
    await expect(createGroupChat(db, owner.userId, { requestId, sourceConversationId: source.id })).rejects.toThrow();
    expect(await listGroupChats(db, owner.userId)).toEqual([]);
    const group = await createGroupChat(db, owner.userId, { requestId, sourceConversationId: source.id, textOnly: true });
    expect((await listMessages(db, owner.userId, group.id)).messages.map((message) => message.body)).toEqual(['Visible caption']);
    const versions = await withUserRaw(pg, owner.userId, (tx) => tx.query<{ parts: unknown }>(
      'select v.parts from bob.message_versions v join bob.messages m on m.id = v.message_id where m.conversation_id = $1', [group.id],
    ));
    expect(versions.rows.map((row) => row.parts)).toEqual([[{ type: 'text', text: 'Visible caption' }]]);
  });

  it('denies another account source without creating a group', async () => {
    const owner = await addAccount(pg);
    const outsider = await addAccount(pg);
    const source = await createConversation(db, owner.userId, 'Private');
    await expect(createGroupChat(db, outsider.userId, { requestId: randomUUID(), sourceConversationId: source.id }))
      .rejects.toBeInstanceOf(StoreNotFoundError);
    expect(await listGroupChats(db, outsider.userId)).toEqual([]);
  });

  it('retries creation atomically and hides conversation audiences from ordinary Spaces', async () => {
    const owner = await addAccount(pg);
    const requestId = randomUUID();
    const groups = await Promise.all([createGroupChat(db, owner.userId, { requestId }), createGroupChat(db, owner.userId, { requestId })]);
    expect(groups[0]?.id).toBe(groups[1]?.id);
    expect(groups[0]?.title).toBe('Chat');
    expect(await listGroupChats(db, owner.userId)).toHaveLength(1);
    expect((await listSpaces(db, owner.userId)).some((space) => space.id === groups[0]?.space_id)).toBe(false);
  });

  it('preview grants no history; one reusable link admits distinct users exactly once each', async () => {
    const owner = await addAccount(pg);
    const guest = await addAccount(pg);
    const second = await addAccount(pg);
    const group = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const { token, expires_at } = await createGroupChatLink(db, owner.userId, group.id);
    const preview = await previewGroupChatLink(db, guest.userId, token);
    expect(preview).toEqual({ title: group.title, inviter_name: expect.any(String), expires_at });
    await expect(getGroupChat(db, guest.userId, group.id)).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(listMessages(db, guest.userId, group.id)).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(postMessage(db, guest.userId, { threadId: group.id, body: 'Denied', clientMessageId: randomUUID() })).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(createGroupChatLink(db, guest.userId, group.id)).rejects.toBeInstanceOf(StoreNotFoundError);
    expect(await listGroupChats(db, guest.userId)).toEqual([]);
    expect((await acceptGroupChatLink(db, guest.userId, token)).id).toBe(group.id);
    expect((await acceptGroupChatLink(db, guest.userId, token)).id).toBe(group.id);
    expect((await acceptGroupChatLink(db, second.userId, token)).id).toBe(group.id);
    const members = await listGroupChatMembers(db, owner.userId, group.id);
    expect(members.map((member) => member.user_id).sort()).toEqual([owner.userId, guest.userId, second.userId].sort());
  });

  it('revokes old links without removing existing members', async () => {
    const owner = await addAccount(pg);
    const guest = await addAccount(pg);
    const outsider = await addAccount(pg);
    const group = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const { token } = await createGroupChatLink(db, owner.userId, group.id);
    await acceptGroupChatLink(db, guest.userId, token);
    await revokeGroupChatLinks(db, owner.userId, group.id);
    await expect(previewGroupChatLink(db, outsider.userId, token)).rejects.toThrow();
    await expect(acceptGroupChatLink(db, outsider.userId, token)).rejects.toThrow();
    expect((await getGroupChat(db, guest.userId, group.id)).id).toBe(group.id);
  });

  it('removed members immediately lose read/write access and cannot reuse their old link', async () => {
    const owner = await addAccount(pg);
    const guest = await addAccount(pg);
    const group = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const { token } = await createGroupChatLink(db, owner.userId, group.id);
    await acceptGroupChatLink(db, guest.userId, token);
    await removeGroupChatMember(db, owner.userId, group.id, guest.userId);
    await expect(listMessages(db, guest.userId, group.id)).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(postMessage(db, guest.userId, { threadId: group.id, body: 'Denied', clientMessageId: randomUUID() })).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(acceptGroupChatLink(db, guest.userId, token)).rejects.toThrow();
    const fresh = await createGroupChatLink(db, owner.userId, group.id);
    expect((await acceptGroupChatLink(db, guest.userId, fresh.token)).id).toBe(group.id);
  });

  it('refuses extra threads and tasks even through authenticated SQL', async () => {
    const owner = await addAccount(pg);
    const group = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    await expect(createThread(db, owner.userId, { spaceId: group.space_id, title: 'Extra' })).rejects.toThrow();
    await expect(createTask(db, owner.userId, group.space_id, { title: 'Extra' })).rejects.toThrow();
    await expect(withUserRaw(pg, owner.userId, (tx) => tx.query(
      'insert into bob.conversations (id, user_id, space_id, created_by, title) values ($1, $2, $3, $2, $4)',
      [randomUUID(), owner.userId, group.space_id, 'Extra'],
    ))).rejects.toThrow();
    await expect(withUserRaw(pg, owner.userId, (tx) => tx.query(
      "insert into bob.tasks (space_id, title, body, status, order_key, revision, created_by) values ($1, 'Extra', '', 'open', 'a0', 1, $2)",
      [group.space_id, owner.userId],
    ))).rejects.toThrow();
    expect((await getGroupChat(db, owner.userId, group.id)).id).toBe(group.id);
  });
});


 describe('group audience lifecycle', () => {
  it('transfers ownership to the oldest remaining member, retains retry provenance and closes an empty audience', async () => {
    const owner = await addAccount(pg);
    const first = await addAccount(pg);
    const second = await addAccount(pg);
    const requestId = randomUUID();
    const chat = await createGroupChat(db, owner.userId, { requestId });
    const link = await createGroupChatLink(db, owner.userId, chat.id);
    await acceptGroupChatLink(db, first.userId, link.token);
    await acceptGroupChatLink(db, second.userId, link.token);
    await removeGroupChatMember(db, owner.userId, chat.id, owner.userId);
    expect((await getGroupChat(db, first.userId, chat.id)).role).toBe('owner');
    expect((await getGroupChat(db, second.userId, chat.id)).role).toBe('member');
    await expect(createGroupChat(db, owner.userId, { requestId })).rejects.toThrow();
    const firstLink = await createGroupChatLink(db, first.userId, chat.id);
    await acceptGroupChatLink(db, owner.userId, firstLink.token);
    expect((await createGroupChat(db, owner.userId, { requestId })).id).toBe(chat.id);
    await removeGroupChatMember(db, owner.userId, chat.id, owner.userId);
    await removeGroupChatMember(db, first.userId, chat.id, second.userId);
    await removeGroupChatMember(db, first.userId, chat.id, first.userId);
    expect(await listGroupChats(db, first.userId)).toEqual([]);
    await expect(acceptGroupChatLink(db, second.userId, firstLink.token)).rejects.toThrow();
  });

  it('stores hash-only links and refuses expired previews and acceptance without waiting', async () => {
    const owner = await addAccount(pg);
    const guest = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const link = await createGroupChatLink(db, owner.userId, chat.id);
    const rows = await withUserRaw(pg, owner.userId, (tx) => tx.query<Record<string, unknown>>(
      'select * from bob.group_chat_links where space_id = $1', [chat.space_id],
    ));
    expect(rows.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows.rows)).not.toContain(link.token);
    const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
    await withAdmin(url, async (sql) => {
      await sql`update bob.group_chat_links set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where space_id = ${chat.space_id}`;
    });
    await expect(previewGroupChatLink(db, guest.userId, link.token)).rejects.toThrow();
    await expect(acceptGroupChatLink(db, guest.userId, link.token)).rejects.toThrow();
  });

  it('denies peer management and invalidates invitations from a removed issuer', async () => {
    const owner = await addAccount(pg);
    const guest = await addAccount(pg);
    const other = await addAccount(pg);
    const outsider = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const link = await createGroupChatLink(db, owner.userId, chat.id);
    await acceptGroupChatLink(db, guest.userId, link.token);
    await acceptGroupChatLink(db, other.userId, link.token);
    await expect(removeGroupChatMember(db, guest.userId, chat.id, other.userId)).rejects.toBeInstanceOf(StoreForbiddenError);
    await expect(revokeGroupChatLinks(db, guest.userId, chat.id)).rejects.toBeInstanceOf(StoreForbiddenError);
    const guestLink = await createGroupChatLink(db, guest.userId, chat.id);
    await removeGroupChatMember(db, owner.userId, chat.id, guest.userId);
    await expect(previewGroupChatLink(db, outsider.userId, guestLink.token)).rejects.toThrow();
    await expect(acceptGroupChatLink(db, outsider.userId, guestLink.token)).rejects.toThrow();
    expect((await getGroupChat(db, other.userId, chat.id)).role).toBe('member');
  });

  it('keeps email identities out of both member endpoints and rejects generic invitation bypasses', async () => {
    const owner = await addAccount(pg);
    const outsider = await addAccount(pg);
    await withAdminAuth(pg, (admin) => admin.setProfile(owner.userId, { email: 'private-identity@example.invalid', name: '' }));
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const members = await listGroupChatMembers(db, owner.userId, chat.id);
    expect(JSON.stringify(members)).not.toContain('private-identity');
    expect(members[0]).not.toHaveProperty('email');
    const generic = await listMembers(db, owner.userId, chat.space_id);
    expect(generic[0]?.email).toBeNull();
    expect(JSON.stringify(generic)).not.toContain('private-identity');
    await expect(addMember(db, owner.userId, chat.space_id, outsider.userId, 'member')).rejects.toThrow();
    await expect(createInvitation(db, owner.userId, chat.space_id, { email: 'new@example.invalid', role: 'member' })).rejects.toThrow();
    await expect(getGroupChat(db, outsider.userId, chat.id)).rejects.toBeInstanceOf(StoreNotFoundError);
  });
});

describe('group snapshot and lifecycle regressions', () => {
  it('copies the same private history into two independent audiences', async () => {
    const owner = await addAccount(pg);
    const source = await createConversation(db, owner.userId, 'Two copies');
    await appendMessage(db, owner.userId, source.id, { role: 'user', parts: [{ type: 'text', text: 'Shared twice' }] });
    const first = await createGroupChat(db, owner.userId, { requestId: randomUUID(), sourceConversationId: source.id });
    const second = await createGroupChat(db, owner.userId, { requestId: randomUUID(), sourceConversationId: source.id });
    expect(first.id).not.toBe(second.id);
    for (const chat of [first, second]) {
      expect((await listMessages(db, owner.userId, chat.id)).messages.map((message) => message.body)).toEqual(['Shared twice']);
    }
  });
  it('normalizes a long private title to the group contract without changing the source', async () => {
    const owner = await addAccount(pg);
    const title = 'A'.repeat(200);
    const source = await createConversation(db, owner.userId, title);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID(), sourceConversationId: source.id });
    expect(GroupChatSchema.safeParse(chat).success).toBe(true);
    expect(chat.title).toBe(title.slice(0, 120));
    expect((await getConversation(db, owner.userId, source.id))?.title).toBe(title);
  });
  it('reserves group rename for the owner and disallows generic thread archival', async () => {
    const owner = await addAccount(pg); const guest = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const link = await createGroupChatLink(db, owner.userId, chat.id);
    await acceptGroupChatLink(db, guest.userId, link.token);
    await expect(renameThread(db, guest.userId, chat.id, { title: 'Unwanted rename' })).rejects.toThrow();
    expect((await renameThread(db, owner.userId, chat.id, { title: 'Owner title' })).title).toBe('Owner title');
    await expect(archiveThread(db, guest.userId, chat.id)).rejects.toThrow();
    await expect(archiveThread(db, owner.userId, chat.id)).rejects.toThrow();
    await expect(withUserRaw(pg, guest.userId, (tx) => tx.query(
      "update bob.conversations set title = 'Direct rename' where id = $1", [chat.id],
    ))).rejects.toThrow();
    await expect(withUserRaw(pg, owner.userId, (tx) => tx.query(
      'update bob.conversations set archived_at = now() where id = $1', [chat.id],
    ))).rejects.toThrow();
    expect((await getGroupChat(db, guest.userId, chat.id)).title).toBe('Owner title');
    const ordinary = await createSpace(db, owner.userId, { kind: 'group', name: 'Ordinary space' });
    const thread = await createThread(db, owner.userId, { spaceId: ordinary.id, title: 'Ordinary thread' });
    expect((await renameThread(db, owner.userId, thread.id, { title: 'Renamed' })).title).toBe('Renamed');
    expect((await archiveThread(db, owner.userId, thread.id)).archivedAt).not.toBeNull();
  });
});
