import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailConfigured, sendTemplateEmail } from '../../src/notifications/email-client.ts';
import { ensureInviteeAccount } from '../../src/account/provisioning.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createThreadsRouter } from '../../src/spaces/threads-http.ts';
import { createGroupChatsRouter } from '../../src/spaces/group-chat-http.ts';
import { createGroupChat, createGroupChatLink, acceptGroupChatLink, revokeGroupChatLinks } from '../../src/spaces/group-chat-store.ts';
import { createConversation, appendMessage } from '../../src/conversations/store.ts';
import { AccountEvents, type AccountEvent } from '../../src/account/events-bus.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, withAdminAuth, type TestDb, type TestAccount } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { StoreError, withUser, type Db } from '../../src/platform/db/db.ts';

vi.mock('../../src/notifications/email-client.ts', async (original) => ({
  ...await original<typeof import('../../src/notifications/email-client.ts')>(),
  emailConfigured: vi.fn(() => true), sendTemplateEmail: vi.fn(async () => undefined),
}));
vi.mock('../../src/account/provisioning.ts', () => ({ ensureInviteeAccount: vi.fn() }));
beforeEach(() => {
  vi.mocked(emailConfigured).mockReturnValue(true);
  vi.mocked(sendTemplateEmail).mockReset();
  vi.mocked(ensureInviteeAccount).mockReset().mockResolvedValue('exists');
});

let pg: TestDb;
let db: Db;
let server: Server;
let base: string;
let unavailable = false;
const events = new AccountEvents();
beforeAll(async () => {
  pg = await createTestDb(); db = asDb(pg);
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api', createGroupChatsRouter({ getDb: async () => { if (unavailable) throw new StoreError('database unavailable'); return db; }, events, requireActiveSession: requireActiveSession(async () => db) }));
  app.use('/api', createThreadsRouter({ getDb: async () => db, events }));
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/group-chats`;
});
afterAll(async () => { server?.close(); if (pg) await closeTestDb(pg); });
async function request(method: string, suffix: string, account?: TestAccount, body?: unknown): Promise<Response> {
  const token = account ? await signToken({ userId: account.userId, sessionId: account.sessionId }) : null;
  return fetch(`${base}${suffix}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('group chat HTTP boundary', () => {
  it('emails a join link without granting membership or disclosing account existence', async () => {
    const owner = await addAccount(pg); const guest = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const response = await request('POST', `/${chat.id}/invitations`, owner, { email: 'guest@example.invalid' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    expect(sendTemplateEmail).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(sendTemplateEmail).mock.calls[0]?.[0];
    expect(sent).toMatchObject({ template: 'chat-invite', to: 'guest@example.invalid', data: { chatName: 'Chat' } });
    const token = String(sent?.data.acceptUrl).split('/join-chat/')[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await request('GET', `/${chat.id}`, guest)).status).toBe(404);
    expect((await request('GET', `/invitations/${token}`, guest)).status).toBe(200);
    expect((await request('POST', `/invitations/${token}/accept`, guest)).status).toBe(200);
  });
  it('authorizes and validates email sends before creating invitations', async () => {
    const owner = await addAccount(pg); const outsider = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    expect((await request('POST', `/${chat.id}/invitations`, undefined, { email: 'guest@example.invalid' })).status).toBe(401);
    expect((await request('POST', `/${chat.id}/invitations`, outsider, { email: 'guest@example.invalid' })).status).toBe(404);
    for (const body of [{ email: 'invalid' }, { email: 'guest@example.invalid', role: 'owner' }, { email: `${'a'.repeat(255)}@example.invalid` }]) {
      expect((await request('POST', `/${chat.id}/invitations`, owner, body)).status).toBe(400);
    }
    vi.mocked(emailConfigured).mockReturnValue(false);
    expect((await request('POST', `/${chat.id}/invitations`, owner, { email: 'guest@example.invalid' })).status).toBe(503);
    expect(sendTemplateEmail).not.toHaveBeenCalled();
    expect(ensureInviteeAccount).not.toHaveBeenCalled();
    const links = await withUser(db, owner.userId, (tx) => tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM bob.group_chat_links WHERE space_id = $1', [chat.space_id],
    ));
    expect(links[0]?.count).toBe('0');
  });
  it.each(['created', 'exists'] as const)('provisions %s accounts before email without revealing the outcome', async (outcome) => {
    const owner = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    vi.mocked(ensureInviteeAccount).mockResolvedValue(outcome);
    const response = await request('POST', `/${chat.id}/invitations`, owner, { email: 'guest@example.invalid' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    expect(ensureInviteeAccount).toHaveBeenCalledWith('guest@example.invalid');
    expect(vi.mocked(ensureInviteeAccount).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(sendTemplateEmail).mock.invocationCallOrder[0] ?? 0);
  });
  it.each([['failed', 502], ['skipped', 503]] as const)('refuses %s provisioning before issuing a link or sending email', async (outcome, status) => {
    const owner = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    vi.mocked(ensureInviteeAccount).mockResolvedValue(outcome);
    expect((await request('POST', `/${chat.id}/invitations`, owner, { email: 'guest@example.invalid' })).status).toBe(status);
    expect(sendTemplateEmail).not.toHaveBeenCalled();
    const links = await withUser(db, owner.userId, (tx) => tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM bob.group_chat_links WHERE space_id = $1', [chat.space_id],
    ));
    expect(links[0]?.count).toBe('0');
  });
  it('reports failed email delivery for an ordinary participant without altering access or existing links', async () => {
    const owner = await addAccount(pg); const member = await addAccount(pg); const guest = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const existing = await createGroupChatLink(db, owner.userId, chat.id);
    await acceptGroupChatLink(db, member.userId, existing.token);
    vi.mocked(sendTemplateEmail).mockRejectedValueOnce(new Error('provider unavailable'));
    expect((await request('POST', `/${chat.id}/invitations`, member, { email: 'guest@example.invalid' })).status).toBe(502);
    expect((await request('GET', `/${chat.id}`, guest)).status).toBe(404);
    expect((await request('GET', `/invitations/${existing.token}`, guest)).status).toBe(200);
    expect((await request('POST', `/${chat.id}/invitations`, member, { email: 'guest@example.invalid' })).status).toBe(200);
  });
  it('requires a live session and limits outbound email attempts per account', async () => {
    const owner = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request('POST', `/${chat.id}/invitations`, owner, { email: 'guest@example.invalid' })).status).toBe(200);
    }
    expect((await request('POST', `/${chat.id}/invitations`, owner, { email: 'guest@example.invalid' })).status).toBe(429);
    expect(sendTemplateEmail).toHaveBeenCalledTimes(5);
    await withAdminAuth(pg, (admin) => admin.endSession(owner.sessionId));
    expect((await request('POST', `/${chat.id}/invitations`, owner, { email: 'guest@example.invalid' })).status).toBe(401);
  });
  it('preserves store outages as server failures instead of treating them as invalid input', async () => {
    const owner = await addAccount(pg);
    unavailable = true;
    try {
      expect((await request('POST', '', owner, { request_id: randomUUID() })).status).toBe(500);
    } finally {
      unavailable = false;
    }
  });
  it('requires authentication for all invitation previews and validates creation strictly', async () => {
    const owner = await addAccount(pg);
    expect((await request('GET', '')).status).toBe(401);
    expect((await request('GET', `/invitations/${'a'.repeat(43)}`)).status).toBe(401);
    const invalid = await request('POST', '', owner, { request_id: randomUUID(), source_conversation_id: 'short', extra: true });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: 'invalid_request' } });
  });
  it('maps unsupported rich history to an explicit 409 and permits the same request with consent', async () => {
    const owner = await addAccount(pg);
    const source = await createConversation(db, owner.userId, 'Rich');
    await appendMessage(db, owner.userId, source.id, { role: 'user', parts: [{ type: 'text', text: 'Caption' }, { type: 'file', url: 'https://example.invalid/private', mediaType: 'image/png' }] });
    const body = { request_id: randomUUID(), source_conversation_id: source.id };
    const refused = await request('POST', '', owner, body);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'unsupported_history' } });
    expect((await request('POST', '', owner, { ...body, text_only: true })).status).toBe(201);
  });
  it('maps expired and disabled invitations to the same 404 as a missing invitation', async () => {
    const owner = await addAccount(pg); const guest = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const old = await createGroupChatLink(db, owner.userId, chat.id);
    await revokeGroupChatLinks(db, owner.userId, chat.id);
    const expiring = await createGroupChatLink(db, owner.userId, chat.id);
    const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
    await withAdmin(url, async (sql) => { await sql`update bob.group_chat_links set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where space_id = ${chat.space_id}`; });
    for (const token of [old.token, expiring.token, 'z'.repeat(43)]) {
      const preview = await request('GET', `/invitations/${token}`, guest);
      expect(preview.status).toBe(404);
      const accept = await request('POST', `/invitations/${token}/accept`, guest);
      expect(accept.status).toBe(404);
      expect(await accept.json()).toEqual({ error: { code: 'not_found' } });
    }
  });
  it('maps full audiences to 409 and limits repeated invitation attempts per account', async () => {
    const owner = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const link = await createGroupChatLink(db, owner.userId, chat.id);
    for (let i = 0; i < 19; i += 1) {
      const guest = await addAccount(pg); await acceptGroupChatLink(db, guest.userId, link.token);
    }
    const extra = await addAccount(pg);
    const full = await request('POST', `/invitations/${link.token}/accept`, extra);
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: { code: 'group_full' } });
    const limited = await addAccount(pg);
    for (let i = 0; i < 20; i += 1) expect((await request('GET', `/invitations/${'z'.repeat(43)}`, limited)).status).toBe(404);
    expect((await request('GET', `/invitations/${'z'.repeat(43)}`, limited)).status).toBe(429);
  });
  it('refuses peer removal and notifies removed members without subsequent group delivery', async () => {
    const owner = await addAccount(pg); const guest = await addAccount(pg);
    const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
    const link = await createGroupChatLink(db, owner.userId, chat.id);
    await acceptGroupChatLink(db, guest.userId, link.token);
    expect((await request('DELETE', `/${chat.id}/members/${owner.userId}`, guest)).status).toBe(403);
    const delivered: string[] = [];
    const unsubscribe = events.subscribe(guest.userId, (event) => { delivered.push(event.type); });
    expect((await request('DELETE', `/${chat.id}/members/${guest.userId}`, owner)).status).toBe(204);
    expect(delivered).toContain('conversation.deleted');
    expect((await request('GET', `/${chat.id}`, guest)).status).toBe(404);
    unsubscribe();
  });
});

it('answers 403 for generic group rename/archive bypasses without blocking owner rename', async () => {
  const owner = await addAccount(pg); const guest = await addAccount(pg);
  const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
  const link = await createGroupChatLink(db, owner.userId, chat.id);
  await acceptGroupChatLink(db, guest.userId, link.token);
  const endpoint = `${base.replace('/group-chats', '')}/threads/${chat.id}`;
  const mutate = async (method: string, account: TestAccount): Promise<Response> => {
    const token = await signToken({ userId: account.userId, sessionId: account.sessionId });
    return fetch(endpoint, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(method === 'PATCH' ? { body: JSON.stringify({ title: 'New title' }) } : {}),
    });
  };
  expect((await mutate('PATCH', guest)).status).toBe(403);
  expect((await mutate('PATCH', owner)).status).toBe(200);
  expect((await mutate('DELETE', guest)).status).toBe(403);
  expect((await mutate('DELETE', owner)).status).toBe(403);
});

it('refreshes active participants after a human message, without duplicate or removed-member delivery', async () => {
  const owner = await addAccount(pg); const guest = await addAccount(pg);
  const chat = await createGroupChat(db, owner.userId, { requestId: randomUUID() });
  const link = await createGroupChatLink(db, owner.userId, chat.id);
  await acceptGroupChatLink(db, guest.userId, link.token);
  const ownerEvents: AccountEvent[] = []; const guestEvents: AccountEvent[] = [];
  const stopOwner = events.subscribe(owner.userId, (event) => { ownerEvents.push(event); });
  const stopGuest = events.subscribe(guest.userId, (event) => { guestEvents.push(event); });
  const token = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
  const post = async (clientId: string): Promise<Response> => fetch(`${base.replace('/group-chats', '')}/threads/${chat.id}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Shared message', client_message_id: clientId }),
  });
  try {
    const clientId = randomUUID();
    const response = await post(clientId);
    expect(response.status).toBe(201);
    const message = await response.json() as { id: string; sequence: number };
    const expected = { type: 'thread.message_appended', thread_id: chat.id, space_id: chat.space_id, message_id: message.id, sequence: message.sequence };
    expect(ownerEvents).toEqual([expected]);
    expect(guestEvents).toEqual([expected]);
    expect((await post(clientId)).status).toBe(200);
    expect(guestEvents).toHaveLength(1);
    expect((await request('DELETE', `/${chat.id}/members/${guest.userId}`, owner)).status).toBe(204);
    guestEvents.length = 0;
    expect((await post(randomUUID())).status).toBe(201);
    expect(guestEvents).toEqual([]);
  } finally { stopOwner(); stopGuest(); }
});
