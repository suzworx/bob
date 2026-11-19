import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { addGoogleAccount, getGoogleAccount } from '../../src/integrations/google-store.ts';
import { claimGoogleOperation, finishGoogleOperation, getGoogleOperation } from '../../src/integrations/google-operation-store.ts';
import { createGmailService } from '../../src/integrations/google-gmail-service.ts';
import { createGmailProviderClient } from '../../src/integrations/google-gmail-client.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { await closeTestDb(pg); });

it('preserves completed receipt identity when another provider account attempts the same installation', async () => {
  const { userId } = await addAccount(pg);
  const original = { installationId: randomUUID(), accountId: 'provider-a', email: 'a@example.test' };
  const account = await addGoogleAccount(db, userId, original);
  const operationId = randomUUID();
  await claimGoogleOperation(db, userId, account.id, { operationId, kind: 'gmail_draft', intentHash: 'a'.repeat(64), stableKey: '<marker@heybob.xyz>' });
  await finishGoogleOperation(db, userId, account.id, operationId, 'pending', 'succeeded', 'draft1');
  await expect(addGoogleAccount(db, userId, { ...original, accountId: 'provider-b', email: 'b@example.test' })).rejects.toThrow('google_account_identity_mismatch');
  expect(await getGoogleAccount(db, userId, account.id)).toMatchObject({ accountId: 'provider-a', email: 'a@example.test' });
  expect(await getGoogleOperation(db, userId, account.id, operationId)).toMatchObject({ state: 'succeeded', resultId: 'draft1' });
  expect(await addGoogleAccount(db, userId, { ...original, name: 'Updated name' })).toMatchObject({ id: account.id, accountId: 'provider-a', name: 'Updated name' });
});

it.each(['id', 'user_id', 'installation_id', 'provider_account_id'] as const)('rejects direct application-role mutation of %s', async (column) => {
  const { userId } = await addAccount(pg);
  const account = await addGoogleAccount(db, userId, { installationId: randomUUID(), accountId: 'provider-a', email: 'a@example.test' });
  await expect(withUser(db, userId, (tx) => tx.query(`UPDATE bob.google_accounts SET ${column} = $2 WHERE id = $1`, [account.id, randomUUID()])))
    .rejects.toThrow('google_account_identity_mismatch');
  expect(await getGoogleAccount(db, userId, account.id)).toMatchObject({ accountId: 'provider-a', installationId: account.installationId });
});

it('cannot reinterpret a completed draft under a replacement mailbox on service retry', async () => {
  const { userId } = await addAccount(pg);
  const original = { installationId: randomUUID(), accountId: 'provider-a', email: 'a@example.test' };
  const account = await addGoogleAccount(db, userId, original);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: 'source', threadId: 'thread1', payload: { headers: [
    { name: 'From', value: 'sender@example.test' }, { name: 'Subject', value: 'Question' }, { name: 'Message-ID', value: '<source@example.test>' },
  ] } })).mockResolvedValueOnce(Response.json({ id: 'draft1', message: { id: 'message1', threadId: 'thread1' } }));
  const resolver = vi.fn(async () => 'token');
  const service = createGmailService({ db, client: createGmailProviderClient(fetcher), resolveCredential: resolver });
  const input = { operationId: randomUUID(), sourceMessageId: 'source', body: 'Reply' };
  expect(await service.createReplyDraft(userId, account.id, input)).toMatchObject({ status: 'succeeded', draftId: 'draft1' });
  await expect(addGoogleAccount(db, userId, { ...original, accountId: 'provider-b' })).rejects.toThrow('google_account_identity_mismatch');
  expect(await service.createReplyDraft(userId, account.id, input)).toMatchObject({ status: 'succeeded', draftId: 'draft1' });
  expect(resolver).toHaveBeenNthCalledWith(2, expect.objectContaining({ providerAccountId: 'provider-a' }));
  expect(fetcher).toHaveBeenCalledTimes(2);
});
