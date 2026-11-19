import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId } from '../../src/platform/ids.ts';
import { appendMessage } from '../../src/conversations/store.ts';
import { listUnextracted, listAccountsWithUnextracted } from '../../src/memory/extract-queue.ts';
import { preparePrivateDeviceTurn, persistDeviceTurn, releasePreparedDeviceTurn } from '../../src/voice/cardputer-conversation.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
beforeAll(async () => { pg = await createTestDb(); });
afterAll(async () => { await closeTestDb(pg); });

it('withholds the in-flight user anchor then permits the completed ordinary turn', async () => {
  const db = asDb(pg);
  const { userId } = await addAccount(pg);
  const prepared = await preparePrivateDeviceTurn(db, userId, { pinnedRef: undefined, transcriptText: 'I like blue',
    deviceId: null, userMessageId: newId('message'), replyMessageId: newId('message') });
  if (!prepared) throw new Error('missing prepared turn');
  expect(await listUnextracted(db, userId, 10)).toEqual([]);
  expect(await listAccountsWithUnextracted(db, 0, 100)).not.toContainEqual({ userId });
  const foreign = await addAccount(pg);
  await releasePreparedDeviceTurn(db, foreign.userId, prepared);
  expect(await listUnextracted(db, userId, 10)).toEqual([]);
  await persistDeviceTurn(db, userId, { prepared, pinnedRef: prepared.conversationId, sessionId: 's', turnRef: 't',
    transcriptText: 'I like blue', replyText: 'Noted.' }, { publish: () => undefined });
  expect(await listUnextracted(db, userId, 10)).toMatchObject([{ messageId: prepared.userMessageId, assistantText: 'Noted.' }]);
  expect(await listAccountsWithUnextracted(db, 0, 100)).toContainEqual({ userId });
});

it('holds a prepared turn across another user and restart until explicit failure release; ordinary orphans remain eligible', async () => {
  const db = asDb(pg);
  const { userId } = await addAccount(pg);
  const prepared = await preparePrivateDeviceTurn(db, userId, { pinnedRef: undefined, transcriptText: 'old request',
    deviceId: null, userMessageId: newId('message'), replyMessageId: newId('message') });
  if (!prepared) throw new Error('missing prepared turn');
  const ordinary = await appendMessage(db, userId, prepared.conversationId, { role: 'user', parts: [{ type: 'text', text: 'new request' }] });
  expect(await listUnextracted(asDb(pg), userId, 10)).toMatchObject([{ messageId: ordinary?.id, assistantText: '' }]);
  expect(await listUnextracted(db, userId, 10)).toHaveLength(1);
  await releasePreparedDeviceTurn(db, userId, prepared);
  expect(await listUnextracted(db, userId, 10)).toHaveLength(2);
});
