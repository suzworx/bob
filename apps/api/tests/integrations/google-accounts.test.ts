import { Readable, Writable } from 'node:stream';
import express, { type Express } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import { addGoogleAccount, deleteGoogleAccount, getSelectedGoogleAccount, listGoogleAccounts, selectGoogleAccount } from '../../src/integrations/google-store.ts';
import { createGmailClient, type GmailClient } from '../../src/integrations/google-connect.ts';
import { createGoogleBridge } from '../../src/integrations/google-bridge.ts';
import { verifyGoogleGrant } from '../../src/integrations/google-grant.ts';
import type { createGoogleConnectionService } from '../../src/integrations/google-connection-service.ts';
import { GoogleCredentialError } from '../../src/integrations/google-credentials.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createGoogleAccountsRouter } from '../../src/integrations/google-http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

describe('google accounts store', () => {
  let pg: TestDb;
  let db: Db;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
  });

  afterAll(async () => {
    await closeTestDb(pg);
  });

  it('keeps two accounts for one user, selects explicitly, denies cross-user ids, and reselects on disconnect', async () => {
    const user = await addAccount(pg);
    const other = await addAccount(pg);
    const first = await addGoogleAccount(db, user.userId, { installationId: 'inst-a', accountId: 'acct-a', email: 'a@example.com' });
    const second = await addGoogleAccount(db, user.userId, { installationId: 'inst-b', accountId: 'acct-b', email: 'b@example.com', name: 'B' });
    await addGoogleAccount(db, other.userId, { installationId: 'inst-c', accountId: 'acct-c', email: 'c@example.com' });

    expect((await listGoogleAccounts(db, user.userId)).map((account) => account.email)).toEqual(['a@example.com', 'b@example.com']);
    expect((await getSelectedGoogleAccount(db, user.userId))?.id).toBe(first.id);
    expect(await selectGoogleAccount(db, other.userId, first.id)).toBeNull();
    expect((await selectGoogleAccount(db, user.userId, second.id))?.selected).toBe(true);
    expect((await getSelectedGoogleAccount(db, user.userId))?.id).toBe(second.id);
    expect(await deleteGoogleAccount(db, user.userId, second.id)).toBe(true);
    expect((await getSelectedGoogleAccount(db, user.userId))?.id).toBe(first.id);
  });
});

describe('google accounts HTTP E2E', () => {
  let pg: TestDb;
  let db: Db;
  let app: Express;
  let account: TestAccount;
  let token: string;
  let sequence = 0;
  const connection: ReturnType<typeof createGoogleConnectionService> = {
    capabilities: vi.fn(async () => []),
    authorize: vi.fn(async () => ({ url: 'https://connect.vercel.com/consent', expiresAt: 1_800_000_000_000 })),
    complete: vi.fn(async (owner: string) => {
      const id = ++sequence === 1 ? 'a' : 'b';
      return addGoogleAccount(db, owner, { installationId: `inst-${id}`, accountId: `acct-${id}`, email: `${id}@example.com` });
    }),
    revoke: vi.fn(async () => undefined),
    resolve: vi.fn(async (input) => `token-${input.providerAccountId}`),
  };
  const gmail: GmailClient = { smoke: vi.fn(async (bearer: string) => ({ email: 'b@example.com', messages: [{ id: 'm1', subject: `subject ${bearer}` }] })) };

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    account = await addAccount(pg);
    token = await signToken({ userId: account.userId, sessionId: account.sessionId });
    app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api/google-accounts', createGoogleAccountsRouter({ getDb: () => Promise.resolve(db), connection, gmail }));
  });

  afterAll(async () => {
    await closeTestDb(pg);
  });

  async function dispatch(method: string, path: string, body?: unknown): Promise<{ status: number; json: () => Promise<unknown> }> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from(payload ? [payload] : []) as Readable & { method: string; url: string; headers: Record<string, string>; socket: object };
    req.method = method;
    req.url = path;
    req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), origin: 'https://app.example.test' };
    req.socket = {};
    let statusCode = 200;
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    }) as Writable & { statusCode: number; setHeader: () => void; getHeader: () => undefined };
    res.statusCode = statusCode;
    res.setHeader = () => undefined;
    res.getHeader = () => undefined;
    await new Promise<void>((resolve, reject) => {
      res.end = ((chunk?: unknown): typeof res => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        statusCode = res.statusCode;
        resolve();
        return res;
      }) as typeof res.end;
      (app as unknown as { handle: (req: unknown, res: unknown, done: (error?: unknown) => void) => void })
        .handle(req, res, (error?: unknown) => error ? reject(error) : resolve());
    });
    return { status: statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  }

  async function post(path: string, body: unknown): Promise<{ status: number; json: () => Promise<unknown> }> {
    return dispatch('POST', path, body);
  }

  it('runs route -> store -> selected account -> token adapter -> Gmail request boundary', async () => {
    expect((await post('/api/google-accounts/authorize', { capabilities: ['gmail.read'] })).status).toBe(200);
    const a = await post('/api/google-accounts/callback', { state: 'a'.repeat(43) });
    const b = await post('/api/google-accounts/callback', { state: 'a'.repeat(43) });
    const bBody = await b.json() as { account: { id: string } };
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await post(`/api/google-accounts/${bBody.account.id}/select`, {})).status).toBe(200);
    // The list carries the last requested access (for Change access) and flags
    // a row with no consent subject as needing reconnection.
    const listed = await dispatch('GET', '/api/google-accounts');
    expect(await listed.json()).toMatchObject({ accounts: [
      { email: 'a@example.com', access: [], needsReconnect: true },
      { email: 'b@example.com', access: [], needsReconnect: true, selected: true },
    ] });

    const smoke = await dispatch('GET', '/api/google-accounts/smoke?limit=1');
    expect(smoke.status).toBe(200);
    expect(await smoke.json()).toMatchObject({ mailbox: { email: 'b@example.com' }, messages: [{ id: 'm1' }] });
    expect(connection.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ userId: account.userId, providerAccountId: 'acct-b', installationId: 'inst-b', capability: 'gmail.read' }));
    expect(connection.authorize).toHaveBeenCalledWith(account.userId, ['gmail.read'], undefined, 'https://app.example.test');
    expect(connection.complete).toHaveBeenCalledWith(account.userId, 'a'.repeat(43));
    expect(gmail.smoke).toHaveBeenCalledWith('token-acct-b', 1);
  });
  it('renames only owned accounts, trims names, clears them and rejects invalid input', async () => {
    const own = await addGoogleAccount(db, account.userId, { installationId: 'rename-own', accountId: 'rename-own', email: 'rename@example.test', name: 'Provider name' });
    const other = await addAccount(pg);
    const foreign = await addGoogleAccount(db, other.userId, { installationId: 'rename-other', accountId: 'rename-other', email: 'other@example.test' });
    const renamed = await dispatch('PATCH', `/api/google-accounts/${own.id}`, { customName: '  Job search  ' });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ account: { customName: 'Job search', name: 'Provider name' } });
    const refreshed = await addGoogleAccount(db, account.userId, { installationId: 'rename-own', accountId: 'rename-own', email: 'rename@example.test', name: 'Updated provider' });
    expect(refreshed).toMatchObject({ customName: 'Job search', name: 'Updated provider' });
    expect((await dispatch('PATCH', `/api/google-accounts/${foreign.id}`, { customName: 'No access' })).status).toBe(404);
    for (const body of [{ customName: '' }, { customName: '   ' }, { customName: 'x'.repeat(61) }, {}, { customName: 'Work', selected: true }]) {
      expect((await dispatch('PATCH', `/api/google-accounts/${own.id}`, body)).status).toBe(400);
    }
    const cleared = await dispatch('PATCH', `/api/google-accounts/${own.id}`, { customName: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ account: { customName: null } });
  });

  it('rejects unbound callbacks and browser selectors', async () => {
    expect((await post('/api/google-accounts/callback', {})).status).toBe(400);
    expect((await post('/api/google-accounts/callback', { state: 'short' })).status).toBe(400);
    expect((await post('/api/google-accounts/authorize', { capabilities: ['gmail.permanent-delete'] })).status).toBe(400);
    expect((await post('/api/google-accounts/authorize', { capabilities: ['gmail.read'], subject: 'injected' })).status).toBe(400);
  });

  it('returns safe failures without upstream details', async () => {
    vi.mocked(connection.authorize).mockRejectedValueOnce(new Error('private-provider-token'));
    const unavailable = await post('/api/google-accounts/authorize', { capabilities: ['gmail.read'] });
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({ error: { code: 'unavailable' } });
    vi.mocked(connection.complete).mockRejectedValueOnce(new GoogleCredentialError('reconnect_required'));
    const reconnect = await post('/api/google-accounts/callback', { state: 'a'.repeat(43) });
    expect(reconnect.status).toBe(403);
    expect(await reconnect.json()).toEqual({ error: { code: 'reconnect_required' } });
  });

  it('fails closed when no connection service is configured', async () => {
    app.use('/unconfigured', createGoogleAccountsRouter({ getDb: () => Promise.resolve(db) }));
    const response = await post('/unconfigured/authorize', { capabilities: ['gmail.read'] });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'connect_not_configured' } });
    expect((await post('/unconfigured/callback', { state: 'a'.repeat(43) })).status).toBe(503);
  });

});

describe('google accounts live gate', () => {
  it('skips unless opted in, then verifies a configured exact subject grant before reading Gmail', async () => {
    if (process.env.BOB_GOOGLE_E2E !== '1') return;
    const url = process.env.BOB_GOOGLE_BRIDGE_URL;
    const secret = process.env.BOB_GOOGLE_BRIDGE_SECRET;
    const subject = process.env.BOB_GOOGLE_TEST_SUBJECT;
    const clientId = process.env.BOB_GOOGLE_CLIENT_ID;
    const providerAccountId = process.env.BOB_GOOGLE_TEST_PROVIDER_ACCOUNT_ID;
    if (!url || !secret || !subject || !clientId || !providerAccountId) throw new Error('Google bridge live test configuration missing');
    const token = await createGoogleBridge({ url, secret }).token(subject, ['gmail.read']);
    const grant = await verifyGoogleGrant(token.token, { expectedClientId: clientId, expectedProviderAccountId: providerAccountId });
    expect(grant.capabilities).toContain('gmail.read');
    const result = await createGmailClient().smoke(token.token, 1);
    expect(result.email).toBe(grant.email);
  });
});
