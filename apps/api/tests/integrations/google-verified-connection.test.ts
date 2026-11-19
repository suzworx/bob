import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addGoogleAccount, deleteGoogleAccount, getGoogleAccount, listGoogleAccounts, persistVerifiedGoogleConnection, renameGoogleAccount } from '../../src/integrations/google-store.ts';
import { resolveGoogleCredential } from '../../src/integrations/google-credentials.ts';
import { createGoogleConsentAttempt, consumeGoogleConsentAttempt } from '../../src/integrations/google-consent-store.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

async function connection(db: Db, owner: string, reconnectAccountId?: string): Promise<Parameters<typeof persistVerifiedGoogleConnection>[2]> {
  const attempt = await createGoogleConsentAttempt(db, owner, { capabilities: ['gmail.read'], reconnectAccountId });
  const consumed = await consumeGoogleConsentAttempt(db, owner, attempt.state);
  if (!consumed) throw new Error('fixture failed');
  return { subject: consumed.subject, completionHash: consumed.completionHash, providerAccountId: randomUUID(),
    email: 'test@example.com', name: 'Test', reconnectAccountId: reconnectAccountId ?? null };
}

describe('verified Google connection persistence', () => {
  let pg: TestDb;
  let db: Db;
  beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
  afterAll(async () => { await closeTestDb(pg); });

  it('binds an explicit subject independently of installation ID and passes it to credentials', async () => {
    const owner = await addAccount(pg);
    const input = await connection(db, owner.userId);
    const account = await persistVerifiedGoogleConnection(db, owner.userId, input);
    expect(account.connectSubject).toBe(input.subject);
    expect(account.installationId).not.toBe(input.subject);
    expect(account.installationId).toMatch(/^[a-f0-9-]{36}$/);
    const resolver = vi.fn(async () => 'token');
    expect(await resolveGoogleCredential(db, resolver, owner.userId, account.id, 'gmail.read')).toBe('token');
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ connectSubject: input.subject, providerAccountId: input.providerAccountId }));
    expect((await createGoogleConsentAttempt(db, owner.userId, { capabilities: ['gmail.read'], reconnectAccountId: account.id })).subject).toBe(input.subject);
  });

  it('serializes concurrent same-subject insertion and rejects replacement identity', async () => {
    const owner = await addAccount(pg);
    const input = await connection(db, owner.userId);
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => persistVerifiedGoogleConnection(db, owner.userId, input)));
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
    const accounts = await listGoogleAccounts(db, owner.userId);
    expect(await listGoogleAccounts(db, owner.userId)).toHaveLength(1);
    await expect(persistVerifiedGoogleConnection(db, owner.userId, { ...input, providerAccountId: 'different' })).rejects.toThrow('google_consent_unavailable');
    const first = accounts[0];
    if (!first) throw new Error('fixture failed');
    expect((await getGoogleAccount(db, owner.userId, first.id))?.accountId).toBe(input.providerAccountId);
  });

  it('requires exact owner, subject, and provider identity on reconnect and never recreates after unlink', async () => {
    const owner = await addAccount(pg);
    const other = await addAccount(pg);
    const input = await connection(db, owner.userId);
    const first = await persistVerifiedGoogleConnection(db, owner.userId, input);
    await renameGoogleAccount(db, owner.userId, first.id, 'Job search');
    const reconnect = { ...await connection(db, owner.userId, first.id), providerAccountId: input.providerAccountId };
    await expect(persistVerifiedGoogleConnection(db, other.userId, reconnect)).rejects.toThrow('google_consent_unavailable');
    await expect(persistVerifiedGoogleConnection(db, owner.userId, { ...reconnect, subject: `gc_${randomBytes(32).toString('base64url')}` })).rejects.toThrow('google_consent_unavailable');
    await expect(persistVerifiedGoogleConnection(db, owner.userId, { ...reconnect, providerAccountId: 'wrong' })).rejects.toThrow('google_account_identity_mismatch');
    const refreshed = await persistVerifiedGoogleConnection(db, owner.userId, { ...reconnect, email: 'changed@example.com' });
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.installationId).toBe(first.installationId);
    expect(refreshed.email).toBe('changed@example.com');
    expect(refreshed.customName).toBe('Job search');
    const disconnected = { ...await connection(db, owner.userId, first.id), providerAccountId: input.providerAccountId };
    await deleteGoogleAccount(db, owner.userId, first.id);
    await expect(persistVerifiedGoogleConnection(db, owner.userId, disconnected)).rejects.toThrow('google_consent_unavailable');
    expect(await listGoogleAccounts(db, owner.userId)).toEqual([]);
  });

  it('preserves null legacy subjects and prevents legacy upserts from replacing explicit subjects', async () => {
    const owner = await addAccount(pg);
    const legacy = await addGoogleAccount(db, owner.userId, { installationId: 'legacy', accountId: 'legacy', email: 'legacy@example.com' });
    expect(legacy.connectSubject).toBeNull();
    const input = await connection(db, owner.userId);
    const account = await persistVerifiedGoogleConnection(db, owner.userId, input);
    await expect(addGoogleAccount(db, owner.userId, { installationId: account.installationId,
      accountId: input.providerAccountId, email: input.email })).rejects.toThrow('google_account_identity_mismatch');
    await expect(resolveGoogleCredential(db, async () => {
      await deleteGoogleAccount(db, owner.userId, account.id);
      return 'token';
    }, owner.userId, account.id, 'gmail.read')).rejects.toThrow('google_account_not_found');
  });
});
