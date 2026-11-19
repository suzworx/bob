import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { accountTablesPresent, purgeAccountContent } from '../../src/account/store.ts';
import { eraseAccount } from '../../src/account/erasure-service.ts';
import { createGoogleConsentAttempt, consumeGoogleConsentAttempt } from '../../src/integrations/google-consent-store.ts';
import { createGoogleConnectionService } from '../../src/integrations/google-connection-service.ts';
import { listGoogleAccounts } from '../../src/integrations/google-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

describe('Google consent erasure races', () => {
  let pg: TestDb;
  let db: Db;
  beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
  afterAll(async () => { await closeTestDb(pg); });

  async function erase(owner: string): Promise<void> {
    await eraseAccount({ db, userId: owner, now: Date.now() });
    await purgeAccountContent(db, owner, await accountTablesPresent(db));
  }

  it('purges fresh pending attempts without touching another owner', async () => {
    const owner = await addAccount(pg);
    const other = await addAccount(pg);
    const pending = await createGoogleConsentAttempt(db, owner.userId, { capabilities: ['gmail.read'] });
    const untouched = await createGoogleConsentAttempt(db, other.userId, { capabilities: ['gmail.read'] });
    await erase(owner.userId);
    expect(await consumeGoogleConsentAttempt(db, owner.userId, pending.state)).toBeNull();
    expect(await consumeGoogleConsentAttempt(db, other.userId, untouched.state)).not.toBeNull();
  });

  it('serializes purge behind an inserted but uncommitted fresh attempt', async () => {
    const owner = await addAccount(pg);
    let inserted: () => void = () => undefined;
    let release: () => void = () => undefined;
    const insertion = new Promise<void>(resolve => { inserted = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    const delayed: Db = {
      ...db,
      tx: fn => db.tx(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        const rows = await tx.query<T>(sql, params);
        if (sql.includes('insert into bob.google_consent_attempts')) { inserted(); await paused; }
        return rows;
      } })),
    };
    const creating = createGoogleConsentAttempt(delayed, owner.userId, { capabilities: ['gmail.read'] });
    await insertion;
    let lockRequested: () => void = () => undefined;
    const queued = new Promise<void>(resolve => { lockRequested = resolve; });
    const observed: Db = {
      ...db,
      tx: fn => db.tx(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        if (sql.includes('pg_advisory_xact_lock')) lockRequested();
        return tx.query<T>(sql, params);
      } })),
    };
    try {
      // Real database evidence that creation holds the exact purge lock.
      const probe = await withUser(db, owner.userId, tx => tx.query<{ locked: boolean }>(
        'select pg_try_advisory_xact_lock(hashtext($1)) as locked', [`google-accounts:${owner.userId}`],
      ));
      expect(probe[0]?.locked).toBe(false);
      const purging = purgeAccountContent(observed, owner.userId, await accountTablesPresent(db));
      await queued;
      release();
      const attempt = await creating;
      await purging;
      expect(await consumeGoogleConsentAttempt(db, owner.userId, attempt.state)).toBeNull();
    } finally {
      release();
      await creating;
    }
  });

  it('rejects final persistence when erasure commits during provider exchange', async () => {
    const owner = await addAccount(pg);
    let finishExchange: () => void = () => undefined;
    let enteredExchange: () => void = () => undefined;
    const entered = new Promise<void>(resolve => { enteredExchange = resolve; });
    const exchange = new Promise<void>(resolve => { finishExchange = resolve; });
    let callbackState = '';
    const service = createGoogleConnectionService({ db, clientId: 'client', callbackUrls: ['https://app.example.test/callback'],
      bridge: {
        authorize: async (_subject, _capabilities, callback) => { callbackState = new URL(callback).searchParams.get('state') ?? ''; return { url: 'https://connect.vercel.com/authorize' }; },
        token: async () => { enteredExchange(); await exchange; return { token: 'test-token', expiresAt: Date.now() + 60000 }; },
        revoke: vi.fn(),
      },
      verify: vi.fn().mockResolvedValue({ providerAccountId: 'provider', email: 'test@example.com', capabilities: ['gmail.read'] }),
    });
    await service.authorize(owner.userId, ['gmail.read'], undefined, 'https://app.example.test');
    const completing = service.complete(owner.userId, callbackState);
    const rejected = expect(completing).rejects.toThrow('google_consent_unavailable');
    await entered;
    await erase(owner.userId);
    finishExchange();
    await rejected;
    expect(await listGoogleAccounts(db, owner.userId)).toEqual([]);
  });

  it('removes a newly finalized connection when callback commits before erasure', async () => {
    const owner = await addAccount(pg);
    let state = '';
    const service = createGoogleConnectionService({ db, clientId: 'client', callbackUrls: ['https://app.example.test/callback'],
      bridge: {
        authorize: async (_subject, _capabilities, callback) => { state = new URL(callback).searchParams.get('state') ?? ''; return { url: 'https://connect.vercel.com/authorize' }; },
        token: async () => ({ token: 'test-token', expiresAt: Date.now() + 60000 }), revoke: vi.fn(),
      },
      verify: vi.fn().mockResolvedValue({ providerAccountId: 'provider', email: 'test@example.com', capabilities: ['gmail.read'] }),
    });
    await service.authorize(owner.userId, ['gmail.read'], undefined, 'https://app.example.test');
    await service.complete(owner.userId, state);
    expect(await listGoogleAccounts(db, owner.userId)).toHaveLength(1);
    await erase(owner.userId);
    expect(await listGoogleAccounts(db, owner.userId)).toEqual([]);
    await expect(service.complete(owner.userId, state)).rejects.toMatchObject({ code: 'reconnect_required' });
  });
});
