import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGmailService } from '../../src/integrations/google-gmail-service.ts';
import { createGmailProviderClient } from '../../src/integrations/google-gmail-client.ts';
import { addGoogleAccount } from '../../src/integrations/google-store.ts';
import { getGoogleOperation } from '../../src/integrations/google-operation-store.ts';
import { createGoogleMutationSlots } from '../../src/integrations/google-tool-operation.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import type { Db } from '../../src/platform/db/db.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => { throw new Error('not initialized'); };
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('Gmail service durable operations', () => {
  let pg: TestDb;
  let db: Db;
  beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
  afterAll(async () => { if (pg) await closeTestDb(pg); });
  async function account(): Promise<{ userId: string; accountId: string }> {
    const user = await addAccount(pg);
    const google = await addGoogleAccount(db, user.userId, { installationId: randomUUID(), accountId: 'provider-id', email: 'test@example.test' });
    return { userId: user.userId, accountId: google.id };
  }
  const source = (): Response => Response.json({ id: 'msg1', threadId: 'thread1', payload: { headers: [
    { name: 'From', value: 'sender@example.test' }, { name: 'Message-ID', value: '<source@example.test>' },
    { name: 'Subject', value: 'Subject' },
  ] } });

  it('uses trusted slots across restart and rejects reworded cross-turn retry without another POST', async () => {
    const identity = await account();
    const conversation = await createConversation(db, identity.userId, 'Private');
    async function anchor() {
      const message = await appendMessage(db, identity.userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Draft reply' }] });
      if (!message) throw new Error('missing message');
      return { conversationId: conversation.id, messageId: message.id };
    }
    const firstAnchor = await anchor();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(source()).mockRejectedValueOnce(new Error('lost'))
      .mockImplementation(async () => Response.json({ drafts: [] }));
    const service = createGmailService({ db, client: createGmailProviderClient(fetcher), resolveCredential: async () => 'secret' });
    const payload = { sourceMessageId: 'msg1', body: 'Thanks' };
    const first = await service.createReplyDraft(identity.userId, identity.accountId, { ...payload, slot: createGoogleMutationSlots({ ...firstAnchor, allowNewOperations: true }).next() });
    expect(first.status).toBe('unknown');
    const laterAnchor = await anchor();
    await expect(service.createReplyDraft(identity.userId, identity.accountId, { ...payload, body: 'Thanks again', slot: createGoogleMutationSlots({ ...laterAnchor, allowNewOperations: true }).next() })).rejects.toThrow('google_operation_needs_review');
    const resumed = await service.createReplyDraft(identity.userId, identity.accountId, { ...payload, slot: createGoogleMutationSlots({ ...laterAnchor, allowNewOperations: true }).next() });
    expect(resumed).toEqual(first);
    const replay = await service.createReplyDraft(identity.userId, identity.accountId, { ...payload, slot: createGoogleMutationSlots({ ...firstAnchor, allowNewOperations: false }).next() });
    expect(replay).toEqual(first);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('commits one claim before provider submission and reuses a successful receipt', async () => {
    const identity = await account();
    const operationId = randomUUID();
    const resolveCredential = vi.fn().mockResolvedValue('secret');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(source()).mockImplementationOnce(async () => {
      expect(await getGoogleOperation(asDb(pg), identity.userId, identity.accountId, operationId)).toMatchObject({ state: 'pending' });
      return Response.json({ id: 'draft1', message: { id: 'draftmsg1', threadId: 'thread1' } });
    });
    const service = createGmailService({ db, client: createGmailProviderClient(fetcher), resolveCredential });
    const input = { operationId, sourceMessageId: 'msg1', body: 'Thanks' };
    const signal = new AbortController().signal;
    expect(await service.createReplyDraft(identity.userId, identity.accountId, input, signal)).toEqual({ status: 'succeeded', operationId, draftId: 'draft1' });
    expect(await service.createReplyDraft(identity.userId, identity.accountId, input, signal)).toEqual({ status: 'succeeded', operationId, draftId: 'draft1' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(resolveCredential).toHaveBeenCalledWith(expect.objectContaining({ ...identity, capability: 'gmail.draft' }));
  });
  it('keeps a lost draft response unknown across restart and reconciles without posting again', async () => {
    const identity = await account();
    const operationId = randomUUID();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(source()).mockRejectedValueOnce(new Error('lost response'));
    const resolveCredential = vi.fn().mockResolvedValue('secret');
    const service = createGmailService({ db, client: createGmailProviderClient(fetcher), resolveCredential });
    const input = { operationId, sourceMessageId: 'msg1', body: 'Thanks' };
    expect(await service.createReplyDraft(identity.userId, identity.accountId, input)).toEqual({ status: 'unknown', operationId });
    const receipt = await getGoogleOperation(db, identity.userId, identity.accountId, operationId);
    expect(receipt?.state).toBe('unknown');
    const afterRestart = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ drafts: [], nextPageToken: 'next-page' }))
      .mockResolvedValueOnce(Response.json({ drafts: [{ id: 'draft1', message: { id: 'msg2', threadId: 'thread1' } }] }))
      .mockResolvedValueOnce(Response.json({ id: 'draft1', message: { id: 'msg2', threadId: 'thread1', payload: {
        headers: [{ name: 'Message-ID', value: receipt?.stableKey }],
      } } }));
    const resumed = createGmailService({ db: asDb(pg), client: createGmailProviderClient(afterRestart), resolveCredential });
    expect(await resumed.createReplyDraft(identity.userId, identity.accountId, input)).toEqual({ status: 'unknown', operationId, nextPageToken: 'next-page' });
    expect(await resumed.reconcileReplyDraft(identity.userId, identity.accountId, { operationId, pageToken: 'next-page' }))
      .toEqual({ status: 'succeeded', operationId, draftId: 'draft1' });
    expect(afterRestart.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    expect(await getGoogleOperation(db, identity.userId, identity.accountId, operationId)).toMatchObject({ state: 'succeeded', resultId: 'draft1' });
  });
  it('rejects changed intent, another owner and aborted calls before provider access', async () => {
    const identity = await account();
    const other = await account();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(source()).mockRejectedValueOnce(new Error('lost'));
    const resolveCredential = vi.fn().mockResolvedValue('secret');
    const service = createGmailService({ db, client: createGmailProviderClient(fetcher), resolveCredential });
    const input = { operationId: randomUUID(), sourceMessageId: 'msg1', body: 'Thanks' };
    await service.createReplyDraft(identity.userId, identity.accountId, input);
    await expect(service.createReplyDraft(identity.userId, identity.accountId, { ...input, body: 'Changed' })).rejects.toThrow('google_operation_intent_mismatch');
    await expect(service.createReplyDraft(other.userId, identity.accountId, input)).rejects.toThrow('google_account_not_found');
    await expect(service.search(identity.userId, identity.accountId, { query: 'hello' }, AbortSignal.abort())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('reports a missing source as definitively failed without draft submission', async () => {
    const identity = await account();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const service = createGmailService({ db, client: createGmailProviderClient(fetcher), resolveCredential: async () => 'secret' });
    const input = { operationId: randomUUID(), sourceMessageId: 'msg1', body: 'Thanks' };
    expect(await service.createReplyDraft(identity.userId, identity.accountId, input)).toEqual({ status: 'failed', operationId: input.operationId, reason: 'not_found' });
    expect(await getGoogleOperation(db, identity.userId, identity.accountId, input.operationId)).toMatchObject({ state: 'failed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps concurrent attempts read-only until the original submission finishes', async () => {
    const identity = await account();
    const input = { operationId: randomUUID(), sourceMessageId: 'msg1', body: 'Thanks' };
    const entered = deferred<void>();
    const response = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(source()).mockImplementationOnce(async () => {
      entered.resolve(); return response.promise;
    }).mockResolvedValueOnce(Response.json({ drafts: [] }));
    const service = createGmailService({ db, client: createGmailProviderClient(fetcher), resolveCredential: async () => 'secret' });
    const first = service.createReplyDraft(identity.userId, identity.accountId, input);
    await entered.promise;
    expect(await service.createReplyDraft(identity.userId, identity.accountId, input)).toEqual({ status: 'unknown', operationId: input.operationId });
    response.resolve(Response.json({ id: 'draft1', message: { id: 'msg2', threadId: 'thread1' } }));
    expect(await first).toMatchObject({ status: 'succeeded', draftId: 'draft1' });
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  it('uses the selected owner account and read capability for bounded search and thread reads', async () => {
    const identity = await account();
    const resolveCredential = vi.fn().mockResolvedValue('secret');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ threads: [], nextPageToken: 'next' }))
      .mockResolvedValueOnce(Response.json({ id: 'thread1', messages: [] }));
    const service = createGmailService({ db, client: createGmailProviderClient(fetcher), resolveCredential });
    expect(await service.search(identity.userId, identity.accountId, { query: 'hello', maxResults: 1 })).toEqual({ threads: [], nextPageToken: 'next' });
    expect(await service.readThread(identity.userId, identity.accountId, 'thread1')).toMatchObject({ id: 'thread1', messages: [] });
    expect(resolveCredential.mock.calls.every(([input]) => input.capability === 'gmail.read' && input.accountId === identity.accountId)).toBe(true);
    expect(fetcher.mock.calls.every(([, options]) => options?.signal instanceof AbortSignal)).toBe(true);
  });
});
