import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { createGoogleConnectionService } from '../../src/integrations/google-connection-service.ts';
import { addGoogleAccount, getGoogleAccount } from '../../src/integrations/google-store.ts';
import { randomBytes } from 'node:crypto';
import { createGoogleConsentAttempt, consumeGoogleConsentAttempt } from '../../src/integrations/google-consent-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

describe('Google connection consent lifecycle', () => {
  let pg: TestDb;
  let db: Db;
  beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
  afterAll(async () => closeTestDb(pg));

  it('binds callback to its owner and exact subject, then rejects replay', async () => {
    const owner = await addAccount(pg);
    const foreign = await addAccount(pg);
    const authorize = vi.fn().mockResolvedValue({ url: 'https://connect.vercel.com/authorize' });
    const token = vi.fn().mockResolvedValue({ token: 'test-token', expiresAt: 2000000000 });
    const verify = vi.fn().mockResolvedValue({ providerAccountId: 'google-sub', email: 'test@example.com', capabilities: ['gmail.read'] });
    const service = createGoogleConnectionService({ db, bridge: { authorize, token, revoke: vi.fn() },
      clientId: 'client', callbackUrls: ['https://app.example.test/gmail'], verify });
    await service.authorize(owner.userId, ['gmail.read'], undefined, 'https://app.example.test');
    const call = authorize.mock.calls[0];
    if (!call) throw new Error('missing authorization');
    const state = new URL(call[2] as string).searchParams.get('state');
    if (!state) throw new Error('missing state');
    await expect(service.complete(foreign.userId, state)).rejects.toMatchObject({ code: 'reconnect_required' });
    expect(token).not.toHaveBeenCalled();
    const account = await service.complete(owner.userId, state);
    expect(account.accountId).toBe('google-sub');
    expect(account.connectSubject).toBe(call[0]);
    expect(token).toHaveBeenCalledWith(call[0], ['gmail.read']);
    await expect(service.complete(owner.userId, state)).rejects.toMatchObject({ code: 'reconnect_required' });
    expect(token).toHaveBeenCalledTimes(1);
    await expect(service.capabilities(owner.userId, account.id)).resolves.toEqual(['gmail.read']);
    expect(token).toHaveBeenLastCalledWith(account.connectSubject, ['gmail.read'], undefined);
    verify.mockResolvedValue({ providerAccountId: 'google-sub', email: 'test@example.com', capabilities: [] });
    await expect(service.resolve({ userId: owner.userId, accountId: account.id, providerAccountId: account.accountId,
      installationId: account.installationId, connectSubject: account.connectSubject, capability: 'gmail.read' })).rejects.toMatchObject({ code: 'permission_required' });
  });

  it('uses the original combined selector for every lookup while enforcing actual partial grants', async () => {
    const owner = await addAccount(pg);
    let state = '';
    const requested = ['calendar.read', 'gmail.read'] as const;
    const token = vi.fn(async (_subject: string, capabilities: readonly string[]) => {
      expect(capabilities).toEqual(requested);
      return { token: 'test-token', expiresAt: Date.now() + 60000 };
    });
    const verify = vi.fn().mockResolvedValue({ providerAccountId: 'partial', email: 'partial@example.com', capabilities: ['calendar.read'] });
    const service = createGoogleConnectionService({ db, clientId: 'client', callbackUrls: ['https://app.example.test/callback'],
      bridge: { authorize: async (_subject, _capabilities, callback) => {
        state = new URL(callback).searchParams.get('state') ?? '';
        return { url: 'https://connect.vercel.com/authorize' };
      }, token, revoke: vi.fn() }, verify });
    await service.authorize(owner.userId, [...requested], undefined, 'https://app.example.test');
    const account = await service.complete(owner.userId, state);
    expect(account.authorizationCapabilities).toEqual(requested);
    expect(await service.capabilities(owner.userId, account.id)).toEqual(['calendar.read']);
    const input = { userId: owner.userId, accountId: account.id, providerAccountId: account.accountId,
      installationId: account.installationId, connectSubject: account.connectSubject };
    await expect(service.resolve({ ...input, capability: 'calendar.read' })).resolves.toBe('test-token');
    await expect(service.resolve({ ...input, capability: 'gmail.read' })).rejects.toMatchObject({ code: 'permission_required' });
    expect(token).toHaveBeenCalledTimes(4);
  });

  it('changes the persisted selector only after a successfully verified reconnect', async () => {
    const owner = await addAccount(pg);
    let state = '';
    const token = vi.fn().mockResolvedValue({ token: 'test-token', expiresAt: Date.now() + 60000 });
    const verify = vi.fn().mockResolvedValue({ providerAccountId: 'same-provider', email: 'reconnect@example.com', capabilities: ['gmail.read'] });
    const service = createGoogleConnectionService({ db, clientId: 'client', callbackUrls: ['https://app.example.test/callback'],
      bridge: { authorize: async (_subject, _capabilities, callback) => {
        state = new URL(callback).searchParams.get('state') ?? ''; return { url: 'https://connect.vercel.com/authorize' };
      }, token, revoke: vi.fn() }, verify });
    await service.authorize(owner.userId, ['gmail.read'], undefined, 'https://app.example.test');
    const account = await service.complete(owner.userId, state);
    await service.authorize(owner.userId, ['calendar.read', 'gmail.read'], account.id, 'https://app.example.test');
    verify.mockRejectedValueOnce(new Error('grant verification failed'));
    await expect(service.complete(owner.userId, state)).rejects.toThrow('grant verification failed');
    expect((await getGoogleAccount(db, owner.userId, account.id))?.authorizationCapabilities).toEqual(['gmail.read']);
    await service.authorize(owner.userId, ['calendar.read', 'gmail.read'], account.id, 'https://app.example.test');
    const changed = await service.complete(owner.userId, state);
    expect(changed.id).toBe(account.id);
    expect(changed.authorizationCapabilities).toEqual(['calendar.read', 'gmail.read']);
    await service.capabilities(owner.userId, account.id);
    expect(token).toHaveBeenLastCalledWith(account.connectSubject, ['calendar.read', 'gmail.read'], undefined);
  });

  it('requires independent explicit send/modify consent even when the provider retains broader grants', async () => {
    const owner = await addAccount(pg);
    let state = '';
    const token = vi.fn().mockResolvedValue({ token: 'test-token', expiresAt: Date.now() + 60000 });
    const verify = vi.fn().mockResolvedValue({ providerAccountId: 'consent-mail', email: 'consent@example.com',
      capabilities: ['gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'] });
    const service = createGoogleConnectionService({ db, clientId: 'client', callbackUrls: ['https://app.example.test/callback'],
      bridge: { authorize: async (_subject, _capabilities, callback) => {
        state = new URL(callback).searchParams.get('state') ?? ''; return { url: 'https://connect.vercel.com/authorize' };
      }, token, revoke: vi.fn() }, verify });
    await service.authorize(owner.userId, ['gmail.draft'], undefined, 'https://app.example.test');
    const account = await service.complete(owner.userId, state);
    const input = { userId: owner.userId, accountId: account.id, providerAccountId: account.accountId,
      installationId: account.installationId, connectSubject: account.connectSubject };
    expect(await service.capabilities(owner.userId, account.id)).toEqual(['gmail.read', 'gmail.draft']);
    await expect(service.resolve({ ...input, capability: 'gmail.send' })).rejects.toMatchObject({ code: 'permission_required' });
    await expect(service.resolve({ ...input, capability: 'gmail.modify' })).rejects.toMatchObject({ code: 'permission_required' });
    expect(token).toHaveBeenLastCalledWith(account.connectSubject, ['gmail.draft'], undefined);
    await service.authorize(owner.userId, ['gmail.send'], account.id, 'https://app.example.test');
    await service.complete(owner.userId, state);
    expect(await service.capabilities(owner.userId, account.id)).toEqual(['gmail.read', 'gmail.send']);
    await expect(service.resolve({ ...input, capability: 'gmail.send' })).resolves.toBe('test-token');
    verify.mockResolvedValue({ providerAccountId: 'consent-mail', email: 'consent@example.com', capabilities: ['gmail.read'] });
    await expect(service.resolve({ ...input, capability: 'gmail.send' })).rejects.toMatchObject({ code: 'permission_required' });
    verify.mockResolvedValue({ providerAccountId: 'consent-mail', email: 'consent@example.com',
      capabilities: ['gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'] });
    await service.authorize(owner.userId, ['gmail.modify'], account.id, 'https://app.example.test');
    await service.complete(owner.userId, state);
    expect(await service.capabilities(owner.userId, account.id)).toEqual(['gmail.read', 'gmail.modify']);
    await expect(service.resolve({ ...input, capability: 'gmail.send' })).rejects.toMatchObject({ code: 'permission_required' });
    await expect(service.resolve({ ...input, capability: 'gmail.modify' })).resolves.toBe('test-token');
  });

  it('refuses legacy records whose original authorization selector is unknown', async () => {
    const owner = await addAccount(pg);
    const account = await addGoogleAccount(db, owner.userId, { installationId: 'legacy-selector', accountId: 'legacy',
      email: 'legacy@example.com', connectSubject: `gc_${randomBytes(32).toString('base64url')}` });
    const token = vi.fn();
    const service = createGoogleConnectionService({ db, clientId: 'client', callbackUrls: ['https://app.example.test/callback'],
      bridge: { authorize: vi.fn(), token, revoke: vi.fn() } });
    await expect(service.capabilities(owner.userId, account.id)).rejects.toMatchObject({ code: 'reconnect_required' });
    await expect(service.resolve({ userId: owner.userId, accountId: account.id, providerAccountId: account.accountId,
      installationId: account.installationId, connectSubject: account.connectSubject, capability: 'gmail.read' }))
      .rejects.toMatchObject({ code: 'reconnect_required' });
    expect(token).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'capabilities'] as const)('rejects a selector changed while %s awaits the broker', async (operation) => {
    const owner = await addAccount(pg);
    let state = '';
    const token = vi.fn().mockResolvedValue({ token: 'test-token', expiresAt: Date.now() + 60000 });
    const service = createGoogleConnectionService({ db, clientId: 'client', callbackUrls: ['https://app.example.test/callback'],
      bridge: { authorize: async (_subject, _capabilities, callback) => {
        state = new URL(callback).searchParams.get('state') ?? ''; return { url: 'https://connect.vercel.com/authorize' };
      }, token, revoke: vi.fn() },
      verify: vi.fn().mockResolvedValue({ providerAccountId: 'racing-selector', email: 'race@example.com', capabilities: ['gmail.read'] }),
    });
    await service.authorize(owner.userId, ['gmail.read'], undefined, 'https://app.example.test');
    const account = await service.complete(owner.userId, state);
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    token.mockImplementationOnce(async () => {
      entered(); await paused;
      return { token: 'test-token', expiresAt: Date.now() + 60000 };
    });
    const result = operation === 'capabilities' ? service.capabilities(owner.userId, account.id)
      : service.resolve({ userId: owner.userId, accountId: account.id, providerAccountId: account.accountId,
        installationId: account.installationId, connectSubject: account.connectSubject, capability: 'gmail.read' });
    const rejection = expect(result).rejects.toMatchObject({ code: 'reconnect_required' });
    await waiting;
    // A successful reconnect can replace this field while the old exchange runs.
    await withUser(db, owner.userId, tx => tx.query(
      'update bob.google_accounts set authorization_capabilities = $1 where id = $2',
      [['calendar.read', 'gmail.read'], account.id],
    ));
    release();
    await rejection;
  });

  it('supersedes pending and consumed reconnects without invalidating fresh connections', async () => {
    const owner = await addAccount(pg);
    let state = '';
    const token = vi.fn().mockResolvedValue({ token: 'test-token', expiresAt: Date.now() + 60000 });
    const service = createGoogleConnectionService({ db, clientId: 'client', callbackUrls: ['https://app.example.test/callback'],
      bridge: { authorize: async (_subject, _capabilities, callback) => {
        state = new URL(callback).searchParams.get('state') ?? ''; return { url: 'https://connect.vercel.com/authorize' };
      }, token, revoke: vi.fn() },
      verify: vi.fn().mockResolvedValue({ providerAccountId: 'reconnect-order', email: 'order@example.com', capabilities: ['gmail.read', 'calendar.read'] }),
    });
    await service.authorize(owner.userId, ['gmail.read'], undefined, 'https://app.example.test');
    const account = await service.complete(owner.userId, state);
    const fresh = await createGoogleConsentAttempt(db, owner.userId, { capabilities: ['gmail.read'] });
    await service.authorize(owner.userId, ['gmail.read'], account.id, 'https://app.example.test');
    const supersededPending = state;
    await service.authorize(owner.userId, ['gmail.read'], account.id, 'https://app.example.test');
    await expect(service.complete(owner.userId, supersededPending)).rejects.toMatchObject({ code: 'reconnect_required' });
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    token.mockImplementationOnce(async () => {
      entered(); await paused; return { token: 'test-token', expiresAt: Date.now() + 60000 };
    });
    const olderCompletion = service.complete(owner.userId, state);
    const rejection = expect(olderCompletion).rejects.toThrow('google_consent_unavailable');
    await waiting;
    try {
      await service.authorize(owner.userId, ['gmail.read', 'calendar.read'], account.id, 'https://app.example.test');
      const newer = await service.complete(owner.userId, state);
      expect(newer.authorizationCapabilities).toEqual(['gmail.read', 'calendar.read']);
      release();
      await rejection;
      expect((await getGoogleAccount(db, owner.userId, account.id))?.authorizationCapabilities).toEqual(['gmail.read', 'calendar.read']);
      expect(await consumeGoogleConsentAttempt(db, owner.userId, fresh.state)).not.toBeNull();
    } finally {
      release();
      await olderCompletion.catch(() => undefined);
    }
  });
});
