import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { GoogleCredentialError, resolveGoogleCredential } from '../../src/integrations/google-credentials.ts';
import { addGoogleAccount, deleteGoogleAccount } from '../../src/integrations/google-store.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { await closeTestDb(pg); });

it('resolves only the explicit owned account with fixed capability and verified server selectors', async () => {
  const owner = await addAccount(pg);
  const other = await addAccount(pg);
  const first = await addGoogleAccount(db, owner.userId, { installationId: randomUUID(), accountId: 'first', email: 'first@example.test' });
  const second = await addGoogleAccount(db, owner.userId, { installationId: randomUUID(), accountId: 'second', email: 'second@example.test' });
  const resolver = vi.fn(async () => 'server-token');
  const signal = new AbortController().signal;
  expect(await resolveGoogleCredential(db, resolver, owner.userId, second.id, 'gmail.read', signal)).toBe('server-token');
  expect(resolver).toHaveBeenCalledWith({ userId: owner.userId, accountId: second.id, providerAccountId: 'second', installationId: second.installationId, connectSubject: null, capability: 'gmail.read', signal });
  await expect(resolveGoogleCredential(db, resolver, other.userId, first.id, 'gmail.read')).rejects.toThrow('google_account_not_found');
  expect(resolver).toHaveBeenCalledTimes(1);
});

it('checks cancellation before and after the exchange and never caches tokens', async () => {
  const owner = await addAccount(pg);
  const account = await addGoogleAccount(db, owner.userId, { installationId: randomUUID(), accountId: 'provider', email: 'one@example.test' });
  const before = new AbortController();
  before.abort();
  const resolver = vi.fn(async () => 'token');
  await expect(resolveGoogleCredential(db, resolver, owner.userId, account.id, 'calendar.read', before.signal)).rejects.toThrow('google_credentials_cancelled');
  expect(resolver).not.toHaveBeenCalled();
  await resolveGoogleCredential(db, resolver, owner.userId, account.id, 'calendar.read');
  await resolveGoogleCredential(db, resolver, owner.userId, account.id, 'calendar.write');
  expect(resolver).toHaveBeenCalledTimes(2);
  const during = new AbortController();
  await expect(resolveGoogleCredential(db, async () => { during.abort(); return 'token'; }, owner.userId, account.id, 'gmail.draft', during.signal)).rejects.toThrow('google_credentials_cancelled');
});

it('rejects identity replacement and does not release a credential after disconnect', async () => {
  const owner = await addAccount(pg);
  const account = await addGoogleAccount(db, owner.userId, { installationId: randomUUID(), accountId: 'provider', email: 'one@example.test' });
  await expect(resolveGoogleCredential(db, async () => {
    await expect(addGoogleAccount(db, owner.userId, { installationId: account.installationId, accountId: 'replacement', email: 'two@example.test' })).rejects.toThrow('google_account_identity_mismatch');
    return 'token';
  }, owner.userId, account.id, 'gmail.read')).resolves.toBe('token');
  await expect(resolveGoogleCredential(db, async () => {
    await deleteGoogleAccount(db, owner.userId, account.id);
    return 'token';
  }, owner.userId, account.id, 'gmail.read')).rejects.toThrow('google_account_not_found');
});

it('sanitizes credential failures and rejects malformed tokens without exposing secrets', async () => {
  const owner = await addAccount(pg);
  const account = await addGoogleAccount(db, owner.userId, { installationId: randomUUID(), accountId: 'provider', email: 'one@example.test' });
  await expect(resolveGoogleCredential(db, async () => { throw new Error('secret credential details'); }, owner.userId, account.id, 'gmail.read')).rejects.toThrow(/^google_credentials_unavailable$/);
  await expect(resolveGoogleCredential(db, async () => 'secret\r\nheader', owner.userId, account.id, 'gmail.read')).rejects.toThrow(/^google_credentials_invalid_response$/);
  const resolver = vi.fn(async () => 'token');
  await expect(resolveGoogleCredential(db, resolver, owner.userId, 'not-a-uuid', 'gmail.read')).rejects.toThrow('google_credentials_invalid_input');
  expect(resolver).not.toHaveBeenCalled();
});

it.each(['reconnect_required', 'permission_required'] as const)('preserves safe %s failures without arbitrary adapter error details', async (code) => {
  const owner = await addAccount(pg);
  const account = await addGoogleAccount(db, owner.userId, { installationId: randomUUID(), accountId: 'provider', email: 'one@example.test' });
  const unsafe = new GoogleCredentialError(code);
  unsafe.message = 'secret adapter details';
  await expect(resolveGoogleCredential(db, async () => { throw unsafe; }, owner.userId, account.id, 'gmail.read'))
    .rejects.toMatchObject({ code, message: `google_credentials_${code}` });
});

it('settles cancellation even when the credential adapter ignores its signal', async () => {
  const owner = await addAccount(pg);
  const account = await addGoogleAccount(db, owner.userId, { installationId: randomUUID(), accountId: 'provider', email: 'one@example.test' });
  let rejectAdapter: (reason: Error) => void = () => undefined;
  const adapter = new Promise<string>((_resolve, reject) => { rejectAdapter = reject; });
  let resolveEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  const controller = new AbortController();
  const resolver = vi.fn(() => { resolveEntered(); return adapter; });
  const result = resolveGoogleCredential(db, resolver, owner.userId, account.id, 'gmail.read', controller.signal);
  await entered;
  controller.abort();
  await expect(result).rejects.toThrow('google_credentials_cancelled');
  // A rejected SDK response arriving after cancellation has an attached handler.
  rejectAdapter(new Error('late private adapter failure'));
  await Promise.resolve();
});
