import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { addGoogleAccount } from '../../src/integrations/google-store.ts';
import { finishGoogleOperation } from '../../src/integrations/google-operation-store.ts';
import { claimGoogleToolOperation, createGoogleMutationSlots } from '../../src/integrations/google-tool-operation.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
async function fixture() {
  const { userId } = await addAccount(pg);
  const account = await addGoogleAccount(db, userId, { installationId: randomUUID(), accountId: 'google', email: 'a@example.test' });
  const conversation = await createConversation(db, userId, 'Private');
  const message = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Create two events' }] });
  if (!message) throw new Error('missing fixture message');
  return { userId, accountId: account.id, anchor: { conversationId: conversation.id, messageId: message.id } };
}
const input = { kind: 'calendar_create' as const, intentHash: 'a'.repeat(64), targetHash: 'b'.repeat(64) };
it('persists server slots, permits sequential distinct creates and forbids new writes on replay', async () => {
  const f = await fixture();
  const slots = createGoogleMutationSlots({ ...f.anchor, allowNewOperations: true });
  const first = await claimGoogleToolOperation(db, f.userId, f.accountId, slots.next(), input);
  expect(first.execute).toBe(true);
  await finishGoogleOperation(db, f.userId, f.accountId, first.receipt.operationId, 'pending', 'succeeded', 'event1');
  const second = await claimGoogleToolOperation(db, f.userId, f.accountId, slots.next(), { ...input, intentHash: 'c'.repeat(64) });
  expect(second.execute).toBe(true);
  expect(second.receipt.operationId).not.toBe(first.receipt.operationId);
  const replay = createGoogleMutationSlots({ ...f.anchor, allowNewOperations: false });
  expect(await claimGoogleToolOperation(db, f.userId, f.accountId, replay.next(), input)).toMatchObject({ execute: false, receipt: { operationId: first.receipt.operationId } });
  await expect(claimGoogleToolOperation(db, f.userId, f.accountId, replay.next(), { ...input, intentHash: 'd'.repeat(64) })).rejects.toThrow('google_operation_needs_review');
  await expect(claimGoogleToolOperation(db, f.userId, f.accountId, replay.next(), { ...input, intentHash: 'e'.repeat(64) })).rejects.toThrow('google_operation_replay_missing');
});

it('atomically adopts unresolved cross-turn intent and retains that binding after reconciliation', async () => {
  const f = await fixture();
  const later = await appendMessage(db, f.userId, f.anchor.conversationId, { role: 'user', parts: [{ type: 'text', text: 'Try again' }] });
  if (!later) throw new Error('missing fixture message');
  const secondAnchor = { ...f.anchor, messageId: later.id };
  const claims = await Promise.all([f.anchor, secondAnchor].map((anchor) => claimGoogleToolOperation(db, f.userId, f.accountId,
    createGoogleMutationSlots({ ...anchor, allowNewOperations: true }).next(), input)));
  expect(claims.filter((claim) => claim.execute)).toHaveLength(1);
  expect(claims[0]?.receipt.operationId).toBe(claims[1]?.receipt.operationId);
  const first = claims[0];
  if (!first) throw new Error('missing claim');
  await finishGoogleOperation(db, f.userId, f.accountId, first.receipt.operationId, 'pending', 'unknown');
  const third = await appendMessage(db, f.userId, f.anchor.conversationId, { role: 'user', parts: [{ type: 'text', text: 'Reword' }] });
  if (!third) throw new Error('missing fixture message');
  await expect(claimGoogleToolOperation(db, f.userId, f.accountId,
    createGoogleMutationSlots({ ...f.anchor, messageId: third.id, allowNewOperations: true }).next(), { ...input, intentHash: 'd'.repeat(64) })).rejects.toThrow('google_operation_needs_review');
  await finishGoogleOperation(db, f.userId, f.accountId, first.receipt.operationId, 'unknown', 'succeeded', 'event1');
  const replay = await claimGoogleToolOperation(db, f.userId, f.accountId,
    createGoogleMutationSlots({ ...secondAnchor, allowNewOperations: false }).next(), input);
  expect(replay).toMatchObject({ execute: false, receipt: { operationId: first.receipt.operationId, state: 'succeeded' } });
});

it('deduplicates identical intent within an anchor and preserves receipts when its message is deleted', async () => {
  const f = await fixture();
  const slots = createGoogleMutationSlots({ ...f.anchor, allowNewOperations: true });
  const first = await claimGoogleToolOperation(db, f.userId, f.accountId, slots.next(), input);
  expect(await claimGoogleToolOperation(db, f.userId, f.accountId, slots.next(), input)).toMatchObject({ execute: false, receipt: { operationId: first.receipt.operationId } });
  await withUser(db, f.userId, (tx) => tx.query('delete from bob.messages where id=$1', [f.anchor.messageId]));
  const mappings = await withUser(db, f.userId, (tx) => tx.query('select operation_id from bob.google_operation_slots'));
  expect(mappings).toHaveLength(1);
  await expect(claimGoogleToolOperation(db, f.userId, f.accountId, slots.next(), input)).rejects.toThrow('google_operation_anchor_unavailable');
});

it('rejects wrong-owner, shared, archived and non-user anchors before reserving', async () => {
  const f = await fixture();
  const other = await addAccount(pg);
  const slot = () => createGoogleMutationSlots({ ...f.anchor, allowNewOperations: true }).next();
  await expect(claimGoogleToolOperation(db, other.userId, f.accountId, slot(), input)).rejects.toThrow('google_account_not_found');
  const assistant = await appendMessage(db, f.userId, f.anchor.conversationId, { role: 'assistant', parts: [{ type: 'text', text: 'reply' }] });
  if (!assistant) throw new Error('missing fixture message');
  await expect(claimGoogleToolOperation(db, f.userId, f.accountId, createGoogleMutationSlots({ ...f.anchor, messageId: assistant.id, allowNewOperations: true }).next(), input)).rejects.toThrow('google_operation_anchor_unavailable');
  await withUser(db, f.userId, (tx) => tx.query('update bob.conversations set archived_at=now() where id=$1', [f.anchor.conversationId]));
  await expect(claimGoogleToolOperation(db, f.userId, f.accountId, slot(), input)).rejects.toThrow('google_operation_anchor_unavailable');
  const shared = await createSpace(db, f.userId, { name: 'Shared' });
  const sharedConversation = await createThread(db, f.userId, { spaceId: shared.id, title: 'Shared' });
  const sharedMessage = await postMessage(db, f.userId, { threadId: sharedConversation.id, clientMessageId: randomUUID(), body: 'Shared request' });
  await expect(claimGoogleToolOperation(db, f.userId, f.accountId, createGoogleMutationSlots({ conversationId: sharedConversation.id, messageId: sharedMessage.message.id, allowNewOperations: true }).next(), input)).rejects.toThrow('google_operation_anchor_unavailable');
});
