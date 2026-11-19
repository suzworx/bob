import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimGoogleOperation, getGoogleOperation, finishGoogleOperation } from '../../src/integrations/google-operation-store.ts';
import { addGoogleAccount, deleteGoogleAccount } from '../../src/integrations/google-store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

describe('durable Google write receipts', () => {
  let pg: TestDb;
  let db: Db;
  beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
  afterAll(async () => { if (pg) await closeTestDb(pg); });
  async function account(): Promise<{ owner: string; accountId: string }> {
    const user = await addAccount(pg);
    const google = await addGoogleAccount(db, user.userId, { installationId: randomUUID(), accountId: 'google-id', email: 'test@example.test' });
    return { owner: user.userId, accountId: google.id };
  }
  const intent = (): { operationId: string; kind: 'calendar_create'; intentHash: string; stableKey: string } => ({ operationId: randomUUID(), kind: 'calendar_create', intentHash: 'a'.repeat(64), stableKey: 'abc123' });

  it('grants exactly one concurrent caller execution and persists pending recovery', async () => {
    const { owner, accountId } = await account();
    const input = intent();
    const claims = await Promise.all([claimGoogleOperation(db, owner, accountId, input), claimGoogleOperation(db, owner, accountId, input)]);
    expect(claims.map((claim) => claim.execute).sort()).toEqual([false, true]);
    const resumed = await claimGoogleOperation(asDb(pg), owner, accountId, input);
    expect(resumed).toMatchObject({ execute: false, receipt: { state: 'pending', stableKey: 'abc123' } });
  });
  it('rejects changed intent and keeps unknown or definitive failure non-executable', async () => {
    const { owner, accountId } = await account();
    const input = intent();
    await claimGoogleOperation(db, owner, accountId, input);
    await expect(claimGoogleOperation(db, owner, accountId, { ...input, intentHash: 'b'.repeat(64) })).rejects.toThrow('google_operation_intent_mismatch');
    await expect(claimGoogleOperation(db, owner, accountId, { ...input, stableKey: 'abc124' })).rejects.toThrow('google_operation_intent_mismatch');
    expect(await finishGoogleOperation(db, owner, accountId, input.operationId, 'pending', 'unknown')).toMatchObject({ state: 'unknown' });
    expect((await claimGoogleOperation(db, owner, accountId, input)).execute).toBe(false);
    expect(await finishGoogleOperation(db, owner, accountId, input.operationId, 'pending', 'succeeded', 'abc123')).toBeNull();
    expect(await finishGoogleOperation(db, owner, accountId, input.operationId, 'unknown', 'failed')).toMatchObject({ state: 'failed' });
    expect((await claimGoogleOperation(db, owner, accountId, input)).execute).toBe(false);
  });
  it('scopes receipts and mutations to both owner and linked account, with disconnect cascade', async () => {
    const first = await account();
    const other = await account();
    const second = await addGoogleAccount(db, first.owner, { installationId: randomUUID(), accountId: 'second', email: 'second@example.test' });
    const input = intent();
    await claimGoogleOperation(db, first.owner, first.accountId, input);
    expect(await getGoogleOperation(db, other.owner, first.accountId, input.operationId)).toBeNull();
    expect(await getGoogleOperation(db, first.owner, second.id, input.operationId)).toBeNull();
    await expect(claimGoogleOperation(db, other.owner, first.accountId, input)).rejects.toThrow('google_account_not_found');
    expect(await finishGoogleOperation(db, other.owner, first.accountId, input.operationId, 'pending', 'failed')).toBeNull();
    expect(await finishGoogleOperation(db, first.owner, second.id, input.operationId, 'pending', 'failed')).toBeNull();
    await deleteGoogleAccount(db, first.owner, first.accountId);
    expect(await getGoogleOperation(db, first.owner, first.accountId, input.operationId)).toBeNull();
  });
  it('enforces ownership FK and immutable intent even through direct SQL', async () => {
    const first = await account();
    const other = await account();
    const input = intent();
    await claimGoogleOperation(db, first.owner, first.accountId, input);
    await expect(withUser(db, other.owner, (tx) => tx.query(`insert into bob.google_operations
      (user_id, google_account_id, operation_id, kind, intent_hash, stable_key) values ($1,$2,$3,'calendar_create',$4,'abc123')`,
    [other.owner, first.accountId, randomUUID(), input.intentHash]))).rejects.toThrow();
    await expect(withUser(db, first.owner, (tx) => tx.query('update bob.google_operations set intent_hash = $1', ['b'.repeat(64)]))).rejects.toThrow();
    await finishGoogleOperation(db, first.owner, first.accountId, input.operationId, 'pending', 'succeeded', 'abc123');
    await expect(withUser(db, first.owner, (tx) => tx.query("update bob.google_operations set state = 'pending', result_id = null"))).rejects.toThrow('google_operation_invalid_transition');
    expect((await getGoogleOperation(db, first.owner, first.accountId, input.operationId))?.state).toBe('succeeded');
  });
  it('validates provider stable identity for each operation kind without storing content', async () => {
    const { owner, accountId } = await account();
    await expect(claimGoogleOperation(db, owner, accountId, { ...intent(), kind: 'gmail_draft', stableKey: 'not-a-message-id' })).rejects.toThrow('google_operation_invalid_input');
    await expect(claimGoogleOperation(db, owner, accountId, { ...intent(), stableKey: 'INVALID' })).rejects.toThrow('google_operation_invalid_input');
    const input = { ...intent(), kind: 'gmail_draft' as const, stableKey: '<bob-123@heybob.xyz>' };
    await claimGoogleOperation(db, owner, accountId, input);
    await finishGoogleOperation(db, owner, accountId, input.operationId, 'pending', 'unknown');
    expect(await finishGoogleOperation(db, owner, accountId, input.operationId, 'unknown', 'succeeded', 'r-123')).toMatchObject({ state: 'succeeded', resultId: 'r-123' });
    expect((await claimGoogleOperation(db, owner, accountId, input)).execute).toBe(false);
  });
});
