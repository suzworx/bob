import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { isProviderContentTurn, markProviderContent } from '../../src/memory/provider-content.ts';
import { createMemoryExtractionWorker } from '../../src/memory/extract.ts';
import { listUnextracted } from '../../src/memory/extract-queue.ts';
import { applyExtractionOps } from '../../src/memory/store.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { await closeTestDb(pg); });
afterEach(() => { vi.useRealTimers(); });

it('does not pair an unanswered earlier user turn with a later provider reply', async () => {
  const { userId } = await addAccount(pg);
  const conversation = await createConversation(db, userId, 'Private');
  const older = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Earlier unanswered question' }] });
  const current = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Read my email' }] });
  if (!older || !current) throw new Error('missing test message');
  await markProviderContent(db, userId, conversation.id, current.id);
  await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'Private provider content' }] });
  const turns = await listUnextracted(db, userId, 10);
  expect(turns.find((turn) => turn.messageId === older.id)?.assistantText).toBe('');
  expect(turns.find((turn) => turn.messageId === current.id)?.assistantText).toBe('Private provider content');
  const earlierTurn = turns.find((turn) => turn.messageId === older.id);
  const providerTurn = turns.find((turn) => turn.messageId === current.id);
  if (!earlierTurn || !providerTurn) throw new Error('missing test turn');
  expect(await isProviderContentTurn(db, userId, earlierTurn)).toBe(false);
  expect(await isProviderContentTurn(db, userId, providerTurn)).toBe(true);
});

it('preserves earlier turns but excludes the provider turn and later history-derived turns', async () => {
  const { userId } = await addAccount(pg);
  const conversation = await createConversation(db, userId, 'Private');
  const append = async () => {
    const row = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'A turn' }] });
    if (!row) throw new Error('missing test message');
    return { messageId: row.id, conversationId: conversation.id };
  };
  const earlier = await append();
  const current = await append();
  await markProviderContent(db, userId, conversation.id, current.messageId);
  const later = await append();
  expect(await isProviderContentTurn(db, userId, earlier)).toBe(false);
  expect(await isProviderContentTurn(db, userId, current)).toBe(true);
  expect(await isProviderContentTurn(db, userId, later)).toBe(true);
  await markProviderContent(db, userId, conversation.id, later.messageId);
  expect(await isProviderContentTurn(db, userId, current)).toBe(true);
  // Regenerating an earlier turn can only widen the exclusion boundary.
  await markProviderContent(db, userId, conversation.id, earlier.messageId);
  expect(await isProviderContentTurn(db, userId, earlier)).toBe(true);
});

it('rejects another owner, an absent anchor and archived conversations before content fetch', async () => {
  const { userId } = await addAccount(pg);
  const other = await addAccount(pg);
  const conversation = await createConversation(db, userId, 'Private');
  await expect(markProviderContent(db, other.userId, conversation.id)).rejects.toThrow('provider_content_scope_unavailable');
  await expect(markProviderContent(db, userId, conversation.id, 'missing')).rejects.toThrow('provider_content_scope_unavailable');
  await expect(markProviderContent(db, userId, 'missing')).rejects.toThrow('provider_content_scope_unavailable');
  await withUser(db, userId, (tx) => tx.query('UPDATE bob.conversations SET archived_at = now() WHERE id = $1', [conversation.id]));
  await expect(markProviderContent(db, userId, conversation.id)).rejects.toThrow('provider_content_scope_unavailable');
});

it('marks an empty conversation before a device turn is persisted', async () => {
  const { userId } = await addAccount(pg);
  const conversation = await createConversation(db, userId, 'Private');
  await markProviderContent(db, userId, conversation.id);
  const message = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Read my email' }] });
  if (!message) throw new Error('missing test message');
  expect(await isProviderContentTurn(db, userId, { conversationId: conversation.id, messageId: message.id })).toBe(true);
});

it('rejects shared conversations even when the caller owns them', async () => {
  const { userId } = await addAccount(pg);
  const space = await createSpace(db, userId, { name: 'Shared' });
  const conversation = await createConversation(db, userId, 'Private');
  await withUser(db, userId, (tx) => tx.query('UPDATE bob.conversations SET space_id = $2 WHERE id = $1', [conversation.id, space.id]));
  await expect(markProviderContent(db, userId, conversation.id)).rejects.toThrow('provider_content_scope_unavailable');
});

it('startup extraction marks excluded turns without calling models or embedding', async () => {
  vi.useFakeTimers();
  const turn = { messageId: 'msg', conversationId: 'cnv', surface: 'web_text' as const, userText: 'I love coffee', assistantText: 'Provider-derived prose' };
  const extractor = vi.fn();
  const embed = vi.fn();
  const apply = vi.fn(async () => undefined);
  const list = vi.fn().mockResolvedValueOnce([turn]).mockResolvedValue([]);
  const worker = createMemoryExtractionWorker({
    db: {} as Db, extractor, embedder: { modelId: 'test', dim: 1, embed, embedMany: embed },
    listUnextracted: list, listAccounts: async () => [{ userId: 'owner' }],
    matchMemories: async () => [], applyExtractionOps: apply, memoryAvailable: async () => true,
    journal: () => undefined, clock: () => 0, debounceMs: 0,
    isProviderContentTurn: async () => true,
  });
  await worker.scanUnprocessed();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  await worker.idle();
  await worker.stop();
  expect(extractor).not.toHaveBeenCalled();
  expect(embed).not.toHaveBeenCalled();
  expect(apply).toHaveBeenCalledWith(expect.anything(), 'owner', [], expect.objectContaining({ markMessageId: 'msg' }));
});

it('startup uses the default database predicate and durably consumes excluded turns', async () => {
  const { userId } = await addAccount(pg);
  const conversation = await createConversation(db, userId, 'Private');
  const message = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Read my email' }] });
  if (!message) throw new Error('missing test message');
  await markProviderContent(db, userId, conversation.id, message.id);
  await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'Private provider content' }] });
  const extractor = vi.fn();
  const embed = vi.fn();
  const worker = createMemoryExtractionWorker({
    db, extractor, embedder: { modelId: 'test', dim: 1, embed, embedMany: embed },
    listUnextracted, listAccounts: async () => [{ userId }],
    matchMemories: async () => [], applyExtractionOps, memoryAvailable: async () => true,
    journal: () => undefined, clock: () => 0, debounceMs: 0,
  });
  try {
    expect(await worker.scanUnprocessed()).toBe(1);
    await worker.idle();
    expect(extractor).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(await listUnextracted(db, userId, 10)).toEqual([]);
  } finally { await worker.stop(); }
});
