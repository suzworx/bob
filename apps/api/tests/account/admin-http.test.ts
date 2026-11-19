import { createSpace } from '../../src/spaces/store.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createV2Server } from '../../src/server.ts';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { asDb, addAccount, withAdminAuth, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const invitation = vi.hoisted(() => vi.fn(async (): Promise<'queued' | 'sent' | 'failed'> => 'queued'));
vi.mock('../../src/account/admin-invitation.ts', () => ({ queueAdminInvitation: invitation, ADMIN_INVITATION_EVENT: 'email.admininvite', createAdminInvitationHandler: () => async () => undefined }));
const provision = vi.hoisted(() => vi.fn(async (_email: string): Promise<'created' | 'exists' | 'failed' | 'skipped'> => 'created'));
vi.mock('../../src/account/provisioning.ts', () => ({ ensureInviteeAccount: provision }));
let pg: TestDb;
let server: Server;
let stopWorker: () => Promise<void>;
let base: string;
let admin: string;
let adminId: string;
let ordinary: string;
let operator: string;
const lines: string[] = [];
async function token(userId: string): Promise<string> {
  const response = await fetch(`${base}/api/test-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }) });
  return ((await response.json()) as { token: string }).token;
}
function request(path: string, bearer?: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
describe('account administration', () => {
  beforeAll(async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    delete process.env.BOB_OPERATOR_USER_IDS;
    setJournalSink(line => lines.push(line));
    pg = await createTestDb();
    setSharedDb(Promise.resolve(asDb(pg)));
    adminId = (await addAccount(pg)).userId;
    const ordinaryId = (await addAccount(pg)).userId;
    const operatorId = (await addAccount(pg)).userId;
    await createSpace(asDb(pg), ordinaryId, { kind: 'group', name: 'Example group' });
    await pg.query('SELECT bob_private.grant_user_scope($1::uuid, $2::text)', [adminId, 'accounts.admin']);
    await pg.query('SELECT bob_private.grant_user_scope($1::uuid, $2::text)', [operatorId, 'metrics.operator']);
    const created = await createV2Server();
    server = created.server;
    stopWorker = () => created.memoryWorker.stop();
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    [admin, ordinary, operator] = await Promise.all([token(adminId), token(ordinaryId), token(operatorId)]);
  });
  beforeEach(() => { provision.mockClear(); provision.mockResolvedValue('created'); invitation.mockReset(); invitation.mockResolvedValue('queued'); });
  afterAll(async () => {
    setJournalSink(null);
    if (server) await new Promise<void>(done => server.close(() => done()));
    if (stopWorker) await stopWorker();
    if (pg) await closeTestDb(pg);
    await closeDb();
    delete process.env.BOB_SYSTEM_TEST;
    delete process.env.BOB_V2_HOST;
  });
  it('requires JWT and a separate admin scope for probe and mutation', async () => {
    expect((await request('/api/admin/access')).status).toBe(401);
    for (const denied of [ordinary, operator]) {
      expect((await request('/api/admin/access', denied)).status).toBe(404);
      expect((await request('/api/admin/accounts', denied, { email: 'person@example.test' })).status).toBe(404);
    }
    expect(provision).not.toHaveBeenCalled();
    expect((await request('/api/admin/access', admin)).status).toBe(204);
  });
  it('allows admin monitoring without granting firmware access', async () => {
    expect((await request('/api/operator/access', admin)).status).toBe(204);
    expect((await request('/api/operator/metrics/usage', admin)).status).toBe(200);
    expect((await request('/api/operator/firmware/', admin)).status).toBe(404);
  });
  it('restricts waitlist directory to administrators and validates requests without sending invitations', async () => {
    expect((await request('/api/admin/waitlist/search', undefined, {})).status).toBe(401);
    for (const denied of [ordinary, operator]) expect((await request('/api/admin/waitlist/search', denied, {})).status).toBe(404);
    for (const body of [{ status: 'unknown' }, { cursor: 'invalid' }, { limit: 51 }, { query: '', extra: true }]) {
      expect((await request('/api/admin/waitlist/search', admin, body)).status).toBe(400);
    }
    const response = await request('/api/admin/waitlist/search', admin, { query: 'private-prefix', status: 'waiting' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ entries: [], counts: { total: 0 }, nextCursor: null });
    expect(lines.join('')).not.toContain('private-prefix');
    expect(invitation).not.toHaveBeenCalled();
    expect((await request('/api/operator/metrics/users', admin)).status).toBe(200);
    expect((await request('/api/operator/metrics/users', operator)).status).toBe(200);
  });
  it('normalizes a bounded address and reports existing accounts idempotently', async () => {
    const created = await request('/api/admin/accounts', admin, { email: ' Person@Example.Test ' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ status: 'created', invitation: 'queued' });
    expect(provision).toHaveBeenCalledWith('person@example.test');
    provision.mockResolvedValue('exists');
    const existing = await request('/api/admin/accounts', admin, { email: 'person@example.test' });
    expect(existing.status).toBe(200);
    expect(await existing.json()).toEqual({ status: 'exists', invitation: 'queued' });
  });
  it.each(['skipped', 'failed'] as const)('never reports %s provisioning as success', async outcome => {
    provision.mockResolvedValue(outcome);
    const response = await request('/api/admin/accounts', admin, { email: 'person@example.test' });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe(outcome === 'skipped' ? 'provisioning_unavailable' : 'provisioning_failed');
    expect(invitation).not.toHaveBeenCalled();
  });
  it('keeps created account success when the queue fails and retries existing account invitations explicitly', async () => {
    invitation.mockRejectedValueOnce(new Error('synthetic queue outage'));
    const first = await request('/api/admin/accounts', admin, { email: 'person@example.test' });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ status: 'created', invitation: 'failed' });
    provision.mockResolvedValue('exists');
    invitation.mockResolvedValue('sent');
    const second = await request('/api/admin/accounts', admin, { email: 'person@example.test', retryInvitation: true });
    expect(await second.json()).toEqual({ status: 'exists', invitation: 'sent' });
    expect(invitation.mock.calls.at(-1)?.at(-1)).toBe(true);
  });
  it('rejects invalid and extra fields before provisioning', async () => {
    for (const body of [{ email: 'invalid' }, { email: `${'x'.repeat(255)}@example.test` }, { email: 'person@example.test', role: 'admin' }]) {
      expect((await request('/api/admin/accounts', admin, body)).status).toBe(400);
    }
    expect(provision).not.toHaveBeenCalled();
  });
  it('refuses inactive sessions even when their JWT and scope remain valid', async () => {
    const account = await addAccount(pg);
    await pg.query('SELECT bob_private.grant_user_scope($1::uuid, $2::text)', [account.userId, 'accounts.admin']);
    const bearer = await token(account.userId);
    const payload = JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString()) as { session_id: string };
    await withAdminAuth(pg, auth => auth.endSession(payload.session_id));
    expect((await request('/api/admin/access', bearer)).status).toBe(401);
    expect((await request('/api/admin/accounts', bearer, { email: 'person@example.test' })).status).toBe(401);
    expect(provision).not.toHaveBeenCalled();
  });
  it('fails closed when the scope store is unavailable', async () => {
    const original = pg.query.bind(pg);
    const spy = vi.spyOn(pg, 'query').mockImplementation((sql, args) => {
      if (sql.includes('user_has_scope')) throw new Error('scope unavailable');
      return original(sql, args);
    });
    try {
      expect((await request('/api/admin/accounts', admin, { email: 'person@example.test' })).status).toBe(404);
      expect(provision).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('bounds each administrator to a ten-request token burst', async () => {
    const account = await addAccount(pg);
    await pg.query('SELECT bob_private.grant_user_scope($1::uuid, $2::text)', [account.userId, 'accounts.admin']);
    const bearer = await token(account.userId);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < 10; i += 1) expect((await request('/api/admin/accounts', bearer, { email: 'person@example.test' })).status).toBe(201);
      expect((await request('/api/admin/accounts', bearer, { email: 'person@example.test' })).status).toBe(429);
      expect(provision).toHaveBeenCalledTimes(10);
      vi.advanceTimersByTime(6000);
      expect((await request('/api/admin/accounts', bearer, { email: 'person@example.test' })).status).toBe(201);
    } finally { vi.useRealTimers(); }
  });
  it('honors revocation immediately without restarting or advancing time', async () => {
    await pg.query('SELECT bob_private.revoke_user_scope($1::uuid, $2::text)', [adminId, 'accounts.admin']);
    expect((await request('/api/admin/access', admin)).status).toBe(404);
    expect((await request('/api/admin/accounts', admin, { email: 'person@example.test' })).status).toBe(404);
    expect((await request('/api/operator/access', admin)).status).toBe(404);
    expect(provision).not.toHaveBeenCalled();
    await pg.query('SELECT bob_private.grant_user_scope($1::uuid, $2::text)', [adminId, 'accounts.admin']);
    expect((await request('/api/admin/access', admin)).status).toBe(204);
  });
  it('audits outcomes without addresses or account identifiers', async () => {
    const start = lines.length;
    await request('/api/admin/accounts', admin, { email: 'person@example.test' });
    const audit = lines.slice(start).filter(line => line.includes('v2.admin_account_provisioned'));
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.join('')).not.toContain('person@');
    expect(audit.join('')).not.toContain(adminId);
  });
  it('lists accounts only for site admins, rejects query-string search and malformed cursors', async () => {
    for (const denied of [ordinary, operator]) {
      expect((await request('/api/admin/accounts/search', denied, {})).status).toBe(404);
      expect((await request('/api/admin/accounts/manage', denied, { accountId: adminId, action: 'disable' })).status).toBe(404);
    }
    for (const body of [{ query: 'x'.repeat(255) }, { limit: 51 }, { cursor: 'not-a-cursor' }, { scope: 'arbitrary' }]) {
      expect((await request('/api/admin/accounts/search', admin, body)).status).toBe(400);
    }
    expect((await request('/api/admin/accounts/search?query=private', admin, {})).status).toBe(400);
    const listed = await addAccount(pg);
    await withAdminAuth(pg, async auth => {
      await auth.setProfile(adminId, { email: 'admin@example.test' });
      await auth.setProfile(listed.userId, { email: 'listed@example.test' });
    });
    const result = await request('/api/admin/accounts/search', admin, { limit: 1 });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ accounts: [expect.objectContaining({ status: 'enabled' })], counts: { total: expect.any(Number) }, nextCursor: expect.any(String) });
  });
  it('enforces disabled web access globally and old JWTs stay revoked after enabling', async () => {
    const target = await addAccount(pg);
    await withAdminAuth(pg, auth => auth.setProfile(target.userId, { email: 'global-guard@example.test' }));
    const bearer = await token(target.userId);
    const body = { accountId: target.userId, action: 'disable' };
    expect((await request('/api/admin/accounts/manage', admin, body)).status).toBe(200);
    expect((await request('/api/conversations', bearer)).status).toBe(401);
    expect((await request('/api/admin/accounts/manage', admin, { ...body, action: 'enable' })).status).toBe(200);
    expect((await request('/api/conversations', bearer)).status).toBe(401);
    expect((await request('/api/public-config')).status).toBe(200);
    const fresh = await token(target.userId);
    expect((await request('/api/conversations', fresh)).status).toBe(200);
  });
  it('does not log account search text or managed addresses', async () => {
    const start = lines.length;
    await request('/api/admin/accounts/search', admin, { query: 'private-needle@example.test' });
    expect(lines.slice(start).join('')).not.toContain('private-needle');
  });

});
