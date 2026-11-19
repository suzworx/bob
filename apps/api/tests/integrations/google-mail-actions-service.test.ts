import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGmailActionsService, type GmailActionsClient } from '../../src/integrations/google-mail-actions-service.ts';
import { GoogleCredentialError } from '../../src/integrations/google-credentials.ts';
import { GmailProviderError } from '../../src/integrations/google-gmail-client.ts';
import { addGoogleAccount } from '../../src/integrations/google-store.ts';
import { getGoogleOperation } from '../../src/integrations/google-operation-store.ts';
import { claimGoogleToolOperation, createGoogleMutationSlots } from '../../src/integrations/google-tool-operation.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import type { Db } from '../../src/platform/db/db.ts';

const content = { to: ['recipient@example.test'], cc: [], bcc: [], subject: 'Test', body: 'Test body' };
const fingerprint = 'a'.repeat(64);
function clientFixture() {
  return {
    composeDraft: vi.fn<GmailActionsClient['composeDraft']>().mockResolvedValue({ id: 'draft1' }),
    readDraft: vi.fn<GmailActionsClient['readDraft']>().mockResolvedValue({ id: 'draft1', fingerprint, rfcMessageId: null, content }),
    updateDraft: vi.fn<GmailActionsClient['updateDraft']>().mockResolvedValue({ id: 'draft1' }),
    sendDraft: vi.fn<GmailActionsClient['sendDraft']>().mockResolvedValue({ id: 'sent1' }),
    findDrafts: vi.fn<GmailActionsClient['findDrafts']>().mockResolvedValue({ drafts: [] }),
    findSent: vi.fn<GmailActionsClient['findSent']>().mockResolvedValue({ messages: [] }),
    readMessageState: vi.fn<GmailActionsClient['readMessageState']>().mockResolvedValue({ id: 'msg1', labelIds: ['TRASH'] }),
    trashMessage: vi.fn<GmailActionsClient['trashMessage']>().mockResolvedValue({ id: 'msg1' }),
    restoreMessage: vi.fn<GmailActionsClient['restoreMessage']>().mockResolvedValue({ id: 'msg1' }),
  };
}
describe('Gmail CRUD durable service', () => {
  let pg: TestDb;
  let db: Db;
  beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
  afterAll(async () => { if (pg) await closeTestDb(pg); });
  async function fixture() {
    const { userId } = await addAccount(pg);
    const account = await addGoogleAccount(db, userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'owner@example.test' });
    const client = clientFixture();
    const resolveCredential = vi.fn().mockResolvedValue('secret');
    return { userId, accountId: account.id, client, resolveCredential, service: createGmailActionsService({ db, client, resolveCredential }) };
  }
  it('reads drafts with read consent and does not treat send-only consent as read consent', async () => {
    const f = await fixture();
    f.resolveCredential.mockImplementation(async (input: { capability: string }) => {
      if (input.capability !== 'gmail.read') throw new GoogleCredentialError('permission_required');
      return 'secret';
    });
    expect(await f.service.readDraft(f.userId, f.accountId, 'draft1')).toMatchObject({ id: 'draft1' });
    expect(f.resolveCredential).toHaveBeenLastCalledWith(expect.objectContaining({ capability: 'gmail.read' }));
    f.resolveCredential.mockImplementation(async (input: { capability: string }) => {
      if (input.capability !== 'gmail.send') throw new GoogleCredentialError('permission_required');
      return 'secret';
    });
    await expect(f.service.readDraft(f.userId, f.accountId, 'draft1')).rejects.toThrow('permission_required');
    expect(f.client.readDraft).toHaveBeenCalledTimes(1);
  });
  it('commits compose intent before HTTP, binds normalized content and reuses its receipt', async () => {
    const f = await fixture();
    const operationId = randomUUID();
    f.client.composeDraft.mockImplementation(async (_token, input) => {
      expect(await getGoogleOperation(asDb(pg), f.userId, f.accountId, operationId)).toMatchObject({ state: 'pending', stableKey: input.messageId });
      return { id: 'draft1' };
    });
    const input = { content, operationId };
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'succeeded', resultId: 'draft1' });
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'succeeded' });
    expect(f.client.composeDraft).toHaveBeenCalledTimes(1);
    await expect(f.service.composeDraft(f.userId, f.accountId, { ...input, content: { ...content, to: ['changed@example.test'] } })).rejects.toThrow('google_operation_intent_mismatch');
  });
  it('serializes simultaneous requests and never submits from the second claim', async () => {
    const f = await fixture();
    let entered: () => void = () => undefined;
    let release: (value: { id: string }) => void = () => undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<{ id: string }>((resolve) => { release = resolve; });
    f.client.composeDraft.mockImplementation(async () => { entered(); return pending; });
    const input = { operationId: randomUUID(), content };
    const first = f.service.composeDraft(f.userId, f.accountId, input);
    await started;
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown' });
    await expect(f.service.composeDraft(f.userId, f.accountId, { ...input, operationId: randomUUID() })).rejects.toThrow('google_operation_needs_review');
    release({ id: 'draft1' });
    expect(await first).toMatchObject({ status: 'succeeded' });
    expect(f.client.composeDraft).toHaveBeenCalledTimes(1);
  });
  it('keeps ambiguous compose unknown and reconciles an exact unique marker without resubmission', async () => {
    const f = await fixture();
    const input = { operationId: randomUUID(), content };
    f.client.composeDraft.mockRejectedValue(new Error('response lost'));
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown' });
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown' });
    f.client.findDrafts.mockResolvedValue({ drafts: [{ id: 'draft1' }] });
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'succeeded', resultId: 'draft1' });
    expect(f.client.composeDraft).toHaveBeenCalledTimes(1);
  });
  it('rejects a fresh operation ID for the same unresolved target instead of bypassing the receipt', async () => {
    const f = await fixture();
    f.client.updateDraft.mockRejectedValue(new Error('lost'));
    const input = { operationId: randomUUID(), draftId: 'draft1', expectedFingerprint: fingerprint, content };
    expect(await f.service.updateDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown' });
    await expect(f.service.updateDraft(f.userId, f.accountId, { ...input, operationId: randomUUID() })).rejects.toThrow('google_operation_needs_review');
    expect(f.client.updateDraft).toHaveBeenCalledTimes(1);
  });
  it('does not declare a partial or duplicate marker scan successful', async () => {
    const f = await fixture();
    const input = { operationId: randomUUID(), content };
    f.client.composeDraft.mockRejectedValue(new Error('lost'));
    await f.service.composeDraft(f.userId, f.accountId, input);
    f.client.findDrafts.mockResolvedValue({ drafts: [{ id: 'draft1' }], nextPageToken: 'more' });
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown', nextPageToken: 'more' });
    f.client.findDrafts.mockResolvedValue({ drafts: [{ id: 'draft1' }, { id: 'draft2' }] });
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown' });
  });
  it('follows marker-query pagination and requires a unique match across the complete scan', async () => {
    const f = await fixture();
    const input = { operationId: randomUUID(), content };
    f.client.composeDraft.mockRejectedValue(new Error('lost'));
    await f.service.composeDraft(f.userId, f.accountId, input);
    f.client.findDrafts.mockResolvedValueOnce({ drafts: [], nextPageToken: 'second' })
      .mockResolvedValueOnce({ drafts: [{ id: 'draft1' }] });
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'succeeded', resultId: 'draft1' });
    expect(f.client.findDrafts).toHaveBeenLastCalledWith('secret', expect.objectContaining({ pageToken: 'second' }), expect.any(AbortSignal));
    const other = { operationId: randomUUID(), content: { ...content, subject: 'Second test' } };
    await f.service.composeDraft(f.userId, f.accountId, other);
    f.client.findDrafts.mockResolvedValueOnce({ drafts: [{ id: 'draft1' }], nextPageToken: 'second' })
      .mockResolvedValueOnce({ drafts: [{ id: 'draft2' }] });
    expect(await f.service.composeDraft(f.userId, f.accountId, other)).toMatchObject({ status: 'unknown' });
    expect(f.client.composeDraft).toHaveBeenCalledTimes(2);
  });
  it('bounds continued marker scans and never accepts a partial match', async () => {
    const f = await fixture();
    const input = { operationId: randomUUID(), content };
    f.client.composeDraft.mockRejectedValue(new Error('lost'));
    await f.service.composeDraft(f.userId, f.accountId, input);
    let page = 0;
    f.client.findDrafts.mockImplementation(async () => ({ drafts: [{ id: 'draft1' }], nextPageToken: String(++page) }));
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown', nextPageToken: '5' });
    expect(f.client.findDrafts).toHaveBeenCalledTimes(5);
    expect(f.client.composeDraft).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale draft before update and binds both prior fingerprint and replacement content', async () => {
    const f = await fixture();
    const input = { operationId: randomUUID(), draftId: 'draft1', expectedFingerprint: 'b'.repeat(64), content };
    expect(await f.service.updateDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'failed', reason: 'stale_draft' });
    expect(f.client.updateDraft).not.toHaveBeenCalled();
    await expect(f.service.updateDraft(f.userId, f.accountId, { ...input, expectedFingerprint: fingerprint })).rejects.toThrow('google_operation_intent_mismatch');
  });
  it('reconciles an uncertain update only when marker and full content agree', async () => {
    const f = await fixture();
    const input = { operationId: randomUUID(), draftId: 'draft1', expectedFingerprint: fingerprint, content };
    f.client.updateDraft.mockRejectedValue(new Error('lost'));
    expect(await f.service.updateDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown' });
    const receipt = await getGoogleOperation(db, f.userId, f.accountId, input.operationId);
    if (!receipt) throw new Error('missing receipt');
    f.client.readDraft.mockResolvedValue({ id: 'draft1', fingerprint, rfcMessageId: receipt.stableKey, content: { ...content, body: 'Different' } });
    expect(await f.service.updateDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown' });
    f.client.readDraft.mockResolvedValue({ id: 'draft1', fingerprint, rfcMessageId: receipt.stableKey, content });
    expect(await f.service.updateDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'succeeded' });
    expect(f.client.updateDraft).toHaveBeenCalledTimes(1);
  });
  it('rejects another owner, malformed content, cancellation and absent capability before provider writes', async () => {
    const f = await fixture();
    const other = await addAccount(pg);
    const input = { operationId: randomUUID(), content };
    await expect(f.service.composeDraft(other.userId, f.accountId, input)).rejects.toThrow('google_account_not_found');
    expect(() => f.service.composeDraft(f.userId, f.accountId, { ...input, content: { ...content, subject: 'bad\r\nBcc: victim@example.test' } })).toThrow('gmail_invalid_input');
    await expect(f.service.composeDraft(f.userId, f.accountId, input, AbortSignal.abort())).rejects.toThrow();
    f.resolveCredential.mockRejectedValue(new Error('permission_required'));
    await expect(f.service.composeDraft(f.userId, f.accountId, input)).rejects.toThrow();
    expect(f.client.composeDraft).not.toHaveBeenCalled();
  });
  it('records definitive pre-submission failure and never retries it', async () => {
    const f = await fixture();
    const input = { operationId: randomUUID(), content };
    f.client.composeDraft.mockRejectedValue(new GmailProviderError('not_found', undefined, false));
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'failed' });
    expect(await f.service.composeDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'failed' });
    expect(f.client.composeDraft).toHaveBeenCalledTimes(1);
  });
  it('blocks opposite mailbox actions while a trusted target receipt remains unresolved', async () => {
    const f = await fixture();
    const conversation = await createConversation(db, f.userId, 'Private');
    const message = await appendMessage(db, f.userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Trash test' }] });
    if (!message) throw new Error('missing anchor');
    const slots = createGoogleMutationSlots({ conversationId: conversation.id, messageId: message.id, allowNewOperations: true });
    const intent = { kind: 'gmail_trash' as const, intentHash: 'a'.repeat(64), targetHash: 'b'.repeat(64), targetMessageId: 'msg1' };
    await claimGoogleToolOperation(db, f.userId, f.accountId, slots.next(), intent);
    await expect(claimGoogleToolOperation(db, f.userId, f.accountId, slots.next(), { ...intent, kind: 'gmail_restore' })).rejects.toThrow('google_operation_needs_review');
  });
  it('sends reviewed bytes once and reconciles response loss through SENT marker evidence', async () => {
    const f = await fixture();
    const input = { operationId: randomUUID(), draftId: 'draft1', expectedFingerprint: fingerprint, content };
    f.client.sendDraft.mockRejectedValue(new Error('lost'));
    expect(await f.service.sendDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown' });
    expect(f.resolveCredential).toHaveBeenLastCalledWith(expect.objectContaining({ capability: 'gmail.send' }));
    expect(await f.service.sendDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown' });
    f.client.findSent.mockResolvedValue({ messages: [{ id: 'sent1' }] });
    expect(await f.service.sendDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'succeeded', resultId: 'sent1' });
    expect(f.client.sendDraft).toHaveBeenCalledTimes(1);
    expect(f.client.sendDraft).toHaveBeenCalledWith('secret', expect.objectContaining({ content, draftId: 'draft1' }), expect.any(AbortSignal));
  });
  it('does not send when reviewed content disagrees with the draft even with matching fingerprint', async () => {
    const f = await fixture();
    const input = { operationId: randomUUID(), draftId: 'draft1', expectedFingerprint: fingerprint, content: { ...content, to: ['wrong@example.test'] } };
    expect(await f.service.sendDraft(f.userId, f.accountId, input)).toMatchObject({ status: 'failed', reason: 'stale_draft' });
    expect(f.client.sendDraft).not.toHaveBeenCalled();
  });
  it('requires modify capability and reconciles Trash using observed label state without retrying', async () => {
    const f = await fixture();
    const input = { operationId: randomUUID(), messageId: 'msg1' };
    f.client.trashMessage.mockRejectedValue(new Error('lost'));
    expect(await f.service.trashMessage(f.userId, f.accountId, input)).toMatchObject({ status: 'unknown' });
    expect(f.resolveCredential).toHaveBeenLastCalledWith(expect.objectContaining({ capability: 'gmail.modify' }));
    expect(await f.service.trashMessage(f.userId, f.accountId, input)).toMatchObject({ status: 'succeeded', resultId: 'msg1' });
    expect(f.client.trashMessage).toHaveBeenCalledTimes(1);
    f.client.restoreMessage.mockRejectedValue(new Error('lost'));
    const restore = { ...input, operationId: randomUUID() };
    expect(await f.service.restoreMessage(f.userId, f.accountId, restore)).toMatchObject({ status: 'unknown' });
    expect(await f.service.restoreMessage(f.userId, f.accountId, restore)).toMatchObject({ status: 'unknown' });
    f.client.readMessageState.mockResolvedValue({ id: 'msg1', labelIds: ['INBOX'] });
    expect(await f.service.restoreMessage(f.userId, f.accountId, restore)).toMatchObject({ status: 'succeeded' });
    expect(f.client.restoreMessage).toHaveBeenCalledTimes(1);
  });
});

