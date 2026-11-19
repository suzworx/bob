import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addAccount,
  closeTestDb,
  createTestDb,
  withAdminAuth,
  type TestDb,
  type TestAccount,
} from '../support/test-db.ts';

let pg: TestDb;
let actor: TestAccount;
async function search(
  query = '',
  limit = 25,
  cursor: string | null = null,
): Promise<Record<string, unknown>> {
  const { rows } = await pg.query<{ result: Record<string, unknown> }>(
    'select bob_private.admin_accounts_search($1::uuid,$2::uuid,$3::text,$4::int,$5::text) as result',
    [actor.userId, actor.sessionId, query, limit, cursor],
  );
  return rows[0]?.result ?? {};
}
describe('admin account management SQL contract', () => {
  beforeAll(async () => {
    pg = await createTestDb();
    actor = await addAccount(pg);
    await withAdminAuth(pg, (auth) =>
      auth.setProfile(actor.userId, { email: 'admin@example.test' }),
    );
    await pg.query("select bob_private.grant_user_scope($1::uuid,'accounts.admin')", [
      actor.userId,
    ]);
  });
  afterAll(async () => {
    if (pg) await closeTestDb(pg);
  });
  it('returns literal-prefix results and population counts independently of the page', async () => {
    const account = await addAccount(pg);
    await withAdminAuth(pg, (auth) =>
      auth.setProfile(account.userId, { email: 'literal_%@example.test' }),
    );
    const result = await search('literal_%');
    expect(result.accounts).toEqual([
      expect.objectContaining({
        id: account.userId,
        email: 'literal_%@example.test',
        status: 'enabled',
        emailConfirmed: false,
      }),
    ]);
    expect(result.counts).toMatchObject({
      total: 2,
      enabled: 2,
      disabled: 0,
      awaitingConfirmation: 2,
    });
  });
  it('uses ban precedence and treats awaiting confirmation as an enabled subset', async () => {
    const before = await search();
    const accounts = await Promise.all([
      addAccount(pg),
      addAccount(pg),
      addAccount(pg),
      addAccount(pg),
    ]);
    for (const account of accounts)
      await withAdminAuth(pg, (auth) =>
        auth.setProfile(account.userId, { email: `${account.userId}@example.test` }),
      );
    const [confirmed, banned, expired, deleted] = accounts;
    if (!confirmed || !banned || !expired || !deleted) throw new Error('missing fixtures');
    await withAdminAuth(pg, async (auth) => {
      await auth.setAccountState(confirmed.userId, { confirmed: true });
      await auth.banUser(banned.userId, '2099-01-01T00:00:00Z');
      await auth.banUser(expired.userId, '2000-01-01T00:00:00Z');
      await auth.setAccountState(deleted.userId, { deleted: true });
    });
    const counts = (await search()).counts as Record<string, number>;
    const initial = before.counts as Record<string, number>;
    expect(counts.total).toBe(Number(initial.total) + 3);
    expect(counts.enabled).toBe(Number(initial.enabled) + 2);
    expect(counts.disabled).toBe(Number(initial.disabled) + 1);
    expect(counts.awaitingConfirmation).toBe(Number(initial.awaitingConfirmation) + 1);
    expect(counts.total).toBe(Number(counts.enabled) + Number(counts.disabled));
    const blank = await addAccount(pg);
    await withAdminAuth(pg, (auth) => auth.setProfile(blank.userId, { email: '   ' }));
    expect((await search()).counts).toEqual(counts);
    expect(await mutate(actor, blank.userId, 'disable')).toBe('not_found');
  });
  it('paginates equal timestamps without duplicates and literal wildcard expansion', async () => {
    const targets = await Promise.all([addAccount(pg), addAccount(pg), addAccount(pg)]);
    for (const [index, target] of targets.entries()) {
      await withAdminAuth(pg, async (auth) => {
        await auth.setProfile(target.userId, { email: `page${index}@example.test` });
        await auth.setAccountState(target.userId, { createdAt: '2026-01-01T00:00:00Z' });
      });
    }
    const first = await search('page', 2);
    const second = await search('page', 2, first.nextCursor as string);
    const ids = [
      ...(first.accounts as { id: string }[]),
      ...(second.accounts as { id: string }[]),
    ].map((row) => row.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(targets.map((row) => row.userId).sort());
    expect(second.nextCursor).toBeNull();
    expect((await search('page%')).accounts).toEqual([]);
  });
  it('disables sessions and refresh tokens atomically; enabling cannot revive them', async () => {
    const target = await addAccount(pg);
    await withAdminAuth(pg, (auth) =>
      auth.setProfile(target.userId, { email: 'disable@example.test' }),
    );
    const refresh = await withAdminAuth(pg, (auth) =>
      auth.createRefreshToken(target.sessionId, target.userId),
    );
    expect(await mutate(actor, target.userId, 'disable')).toBe('updated');
    expect(await active(target)).toBe(false);
    expect(await withAdminAuth(pg, (auth) => auth.refreshTokenExists(refresh))).toBe(false);
    expect(await mutate(actor, target.userId, 'enable')).toBe('updated');
    expect(await active(target)).toBe(false);
  });
  it('binds actor sessions, refuses self changes and never accepts arbitrary scope actions', async () => {
    const other = await addAccount(pg);
    await withAdminAuth(pg, (auth) =>
      auth.setProfile(other.userId, { email: `${other.userId}@example.test` }),
    );
    expect(await mutate({ ...actor, sessionId: other.sessionId }, other.userId, 'disable')).toBe(
      'forbidden',
    );
    expect(await mutate(other, actor.userId, 'disable')).toBe('forbidden');
    expect(await mutate(actor, actor.userId, 'disable')).toBe('self_protected');
    expect(await mutate(actor, actor.userId, 'revoke_admin')).toBe('self_protected');
    expect(await mutate(actor, other.userId, 'firmware.operator')).toBe('invalid_action');
  });
  it('protects the final email-based eligible admin and excludes deleted and sentinel accounts', async () => {
    const target = await addAccount(pg);
    await withAdminAuth(pg, (auth) =>
      auth.setProfile(target.userId, { email: 'last-admin@example.test' }),
    );
    expect(await mutate(actor, target.userId, 'grant_admin')).toBe('updated');
    await withAdminAuth(pg, (auth) => auth.setProfile(actor.userId, { email: null }));
    try {
      expect(await mutate(actor, target.userId, 'disable')).toBe('last_admin');
      expect(await mutate(actor, target.userId, 'revoke_admin')).toBe('last_admin');
    } finally {
      await withAdminAuth(pg, (auth) =>
        auth.setProfile(actor.userId, { email: 'admin@example.test' }),
      );
    }
    expect(await mutate(actor, target.userId, 'revoke_admin')).toBe('updated');
    await withAdminAuth(pg, (auth) => auth.setAccountState(target.userId, { deleted: true }));
    expect(await active(target)).toBe(false);
    expect(await mutate(actor, target.userId, 'enable')).toBe('not_found');
    const sentinel = await addAccount(pg, { id: '00000000-0000-4000-8000-0000000000de' });
    await withAdminAuth(pg, (auth) =>
      auth.setProfile(sentinel.userId, { email: 'sentinel@example.test' }),
    );
    expect((await search('sentinel')).accounts).toEqual([]);
    expect(await active(sentinel)).toBe(false);
    expect(await mutate(actor, sentinel.userId, 'grant_admin')).toBe('not_found');
  });
  it('serializes competing admin revocations and rechecks a revoked actor under the lock', async () => {
    const other = await addAccount(pg);
    await withAdminAuth(pg, (auth) =>
      auth.setProfile(other.userId, { email: `${other.userId}@example.test` }),
    );
    expect(await mutate(actor, other.userId, 'grant_admin')).toBe('updated');
    const outcomes = await Promise.all([
      mutate(actor, other.userId, 'revoke_admin'),
      mutate(other, actor.userId, 'revoke_admin'),
    ]);
    expect(outcomes.sort()).toEqual(['forbidden', 'updated']);
    // Restore the fixture only through the explicitly trusted break-glass helper.
    await pg.query("select bob_private.grant_user_scope($1::uuid,'accounts.admin')", [
      actor.userId,
    ]);
  });
});

async function mutate(
  identity: TestAccount,
  target: string,
  action: string,
): Promise<string | undefined> {
  const { rows } = await pg.query<{ result: string }>(
    'select bob_private.admin_account_mutate($1::uuid,$2::uuid,$3::uuid,$4::text) as result',
    [identity.userId, identity.sessionId, target, action],
  );
  return rows[0]?.result;
}
async function active(identity: TestAccount): Promise<boolean | undefined> {
  const { rows } = await pg.query<{ active: boolean }>(
    'select bob_private.web_session_active($1::uuid,$2::uuid) as active',
    [identity.userId, identity.sessionId],
  );
  return rows[0]?.active;
}
