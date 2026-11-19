// Account deletion API tests (G6, issue #143, web-account.ts). Setup mirrors
// tests/web-devices.test.ts: a real HTTP server over Postgres exercises the JWT
// guard, requireActiveSession, and the /api/account router; deviceSessions
// and the Google connect adapter are stubbed (vi.fn()) since this router
// never touches the real device registry or a live provider.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pairing from '../../src/devices/pairing-service.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { asServer, StoreError, type Db } from '../../src/platform/db/db.ts';
import { installMarketingPackage, selectMarketingInstallation } from '../../src/bob-apps/marketing-install.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createAccountRouter } from '../../src/account/http.ts';
import { purgeAccountNotifications } from '../../src/account/store.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { listDevices } from '../../src/devices/store.ts';
import { createSpace, addMember, listMembers } from '../../src/spaces/store.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
  withAdminAuth,
  withUserRaw,
} from '../support/test-db.ts';

/** Fail one real content-purge transaction after the separately committed erasure, without replacing the service. */
function withPurgeFailure(base: Db, fault: { remaining: number }): Db {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (fault.remaining > 0 && /DELETE FROM bob\.memories/i.test(sql)) {
        fault.remaining -= 1;
        throw new StoreError('injected post-erasure purge failure');
      }
      return base.query<T>(sql, params);
    },
    tx: <T>(work: (tx: Db) => Promise<T>): Promise<T> => base.tx((tx) => work(withPurgeFailure(tx, fault))),
  };
}

describe('account API (G6, issue #143)', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server;
  let baseUrl: string;
  const journalLines: string[] = [];
  const closeDevice = vi.fn();
  const revokeToken = vi.fn();
  const purgeFault = { remaining: 0 };

  beforeAll(async () => {
    setJournalSink((line: string) => journalLines.push(line));
    pg = await createTestDb();
    db = asDb(pg);
    const requestDb = withPurgeFailure(db, purgeFault);
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use(
      '/api/account',
      createAccountRouter({
        getDb: () => Promise.resolve(requestDb),
        requireActiveSession: requireActiveSession(() => Promise.resolve(requestDb)),
        deviceSessions: { closeDevice },
        googleConnection: { revoke: revokeToken },
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    setJournalSink(null);
    server.close();
    await closeTestDb(pg);
  });

  beforeEach(() => {
    closeDevice.mockClear();
    revokeToken.mockReset();
    purgeFault.remaining = 0;
  });

  async function tokenFor(account: TestAccount): Promise<string> {
    return signToken({ userId: account.userId, sessionId: account.sessionId });
  }

  async function freshAccount(): Promise<{ account: TestAccount; token: string }> {
    const account = await addAccount(pg);
    return { account, token: await tokenFor(account) };
  }

  async function send(method: string, path: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function pairDevice(userId: string, name = 'Kitchen'): Promise<string> {
    const issued = await pairing.issueCode(db, {
      model: 'M5Stack Cardputer',
      fwVersion: '0.9.0',
      claim: `claim-${randomUUID()}`,
      ip: '203.0.113.77',
    });
    return pairing.approve(db, userId, issued.pairingId, name);
  }

  // insertMemory needs the vector extension, which the shared local stack's
  // authenticated role cannot reach (`permission denied for schema
  // extensions`) -- the same gap publication.test.ts's rememberedAction()
  // works around. A plain insert under the actor seeds an equivalent row
  // without exercising that broken path.
  async function seedMemory(userId: string, content: string): Promise<void> {
    await withUserRaw(pg, userId, (tx) =>
      tx.query(
        `INSERT INTO bob.memories (id, user_id, kind, content, confidence, surface)
         VALUES ($1, $2, 'fact', $3, 0.9, 'web_text')`,
        [`mem_${randomUUID()}`, userId, content],
      ),
    );
  }

  // The seed inserts the row directly with the caller's own id. It dates from
  // when addGoogleAccount put a literal `auth.uid()` in its SQL text, which the
  // authenticated role cannot resolve (`permission denied for schema auth`);
  // addGoogleAccount now passes user_id as a parameter and google-accounts.test.ts
  // exercises it on real Postgres.
  async function seedGoogleAccount(userId: string, accountId: string, installationId: string, email: string): Promise<void> {
    await withUserRaw(pg, userId, (tx) =>
      tx.query(
        `INSERT INTO bob.google_accounts (user_id, installation_id, provider_account_id, email, selected)
         VALUES ($1, $2, $3, $4, true)`,
        [userId, installationId, accountId, email],
      ),
    );
  }

  async function seedContent(userId: string): Promise<{ deviceId: string }> {
    await createConversation(db, userId, 't');
    await seedMemory(userId, 'likes tea');
    await seedGoogleAccount(userId, 'acc-1', 'inst-1', 'g@example.com');
    const deviceId = await pairDevice(userId, 'Seed device');
    return { deviceId };
  }

  async function countRows(userId: string, table: string): Promise<number> {
    const result = await withUserRaw(pg, userId, (tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from bob.${table} where user_id = $1`, [userId]),
    );
    return result.rows[0]!.n;
  }

  // Seeds through the definer the same way the server's enqueue path does
  // (store/notifications.ts) -- notifications has FORCE RLS and no insert
  // policy, so nothing else can write a row.
  async function seedNotification(
    recipientUserId: string,
    spaceId: string | null,
    type: 'mention' | 'security',
  ): Promise<void> {
    await asServer(db, (server) =>
      server.query(
        `SELECT bob_private.notifications_enqueue(
           $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::uuid[], $6::int[], $7::text[]
         )`,
        [[recipientUserId], [spaceId], [type], ['task'], [randomUUID()], [1], [`notif-${randomUUID()}`]],
      ),
    );
  }

  // A self-read under the recipient's own RLS: honest whenever their space
  // membership is untouched, but it would UNDER-count a row the purge left
  // behind once erasure has already revoked that membership -- exactly why the
  // zero-rows-left assertion below goes through purgeAccountNotifications
  // (the definer) instead of this helper.
  async function countNotifications(userId: string): Promise<number> {
    const result = await withUserRaw(pg, userId, (tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from bob.notifications where recipient_user_id = $1`,
        [userId],
      ),
    );
    return result.rows[0]!.n;
  }

  async function makeGroup(ownerId: string, name: string, members: string[] = []): Promise<{ id: string }> {
    const space = await createSpace(db, ownerId, { kind: 'group', name });
    for (const member of members) {
      await addMember(db, ownerId, space.id, member, 'member');
    }
    return space;
  }

  it('400 invalid_request for no body and for {confirm:false}; the seeded conversation still exists', async () => {
    const { account, token } = await freshAccount();
    await createConversation(db, account.userId, 't');

    const noBody = await send('DELETE', '/api/account', token, undefined);
    expect(noBody.status).toBe(400);
    expect(await noBody.json()).toEqual({ error: { code: 'invalid_request' } });

    const falseConfirm = await send('DELETE', '/api/account', token, { confirm: false });
    expect(falseConfirm.status).toBe(400);

    expect(await countRows(account.userId, 'conversations')).toBe(1);
  });

  it('401 invalid_token after the session ends; nothing deleted', async () => {
    const account = await addAccount(pg);
    const token = await tokenFor(account);
    await createConversation(db, account.userId, 't');
    await withAdminAuth(pg, (admin) => admin.endSession(account.sessionId));

    const res = await send('DELETE', '/api/account', token, { confirm: true });
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'invalid_token' } });
    expect(await countRows(account.userId, 'conversations')).toBe(1);
  });

  it('409 owns_groups when the caller solely owns a group; nothing deleted, revokeToken/closeDevice not called', async () => {
    const { account, token } = await freshAccount();
    const other = await addAccount(pg);
    await seedContent(account.userId);
    const solo = await makeGroup(account.userId, 'Solo', [other.userId]);
    await seedNotification(account.userId, solo.id, 'mention');
    await seedNotification(account.userId, null, 'security');

    const res = await send('DELETE', '/api/account', token, { confirm: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'owns_groups', count: 1 } });

    expect(await countRows(account.userId, 'conversations')).toBe(1);
    expect(await countRows(account.userId, 'memories')).toBe(1);
    expect(await countRows(account.userId, 'google_accounts')).toBe(1);
    expect(await listDevices(db, account.userId)).toHaveLength(1);
    expect(await countNotifications(account.userId)).toBe(2);
    expect(revokeToken).not.toHaveBeenCalled();
    expect(closeDevice).not.toHaveBeenCalled();
  });

  it('204 happy path purges content, revokes google + devices, removes group membership; other accounts unaffected', async () => {
    const { account, token } = await freshAccount();
    const { deviceId } = await seedContent(account.userId);
    const b = await addAccount(pg);
    const group = await makeGroup(b.userId, 'Shared', [account.userId]);
    const other = await addAccount(pg);
    await createConversation(db, other.userId, "others convo");
    await seedNotification(account.userId, group.id, 'mention');
    await seedNotification(account.userId, null, 'security');
    await seedNotification(other.userId, null, 'security');
    revokeToken.mockResolvedValue(undefined);

    const start = journalLines.length;
    const res = await send('DELETE', '/api/account', token, { confirm: true });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    expect(await countRows(account.userId, 'conversations')).toBe(0);
    expect(await countRows(account.userId, 'memories')).toBe(0);
    expect(await countRows(account.userId, 'google_accounts')).toBe(0);
    expect(await listDevices(db, account.userId)).toHaveLength(0);
    // The account's own membership is already revoked by this point, so its
    // own RLS-scoped read would hide a leftover space-scoped row -- the
    // definer (idempotent, "nothing left" -> 0) is what actually proves it.
    expect(await purgeAccountNotifications(db, account.userId)).toBe(0);

    expect(revokeToken).toHaveBeenCalledTimes(1);
    expect(revokeToken).toHaveBeenCalledWith(account.userId, expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(closeDevice).toHaveBeenCalledWith(deviceId, 4003, 'revoked');

    const members = await listMembers(db, b.userId, group.id);
    expect(members.some((m) => m.userId === account.userId)).toBe(false);

    expect(await countRows(other.userId, 'conversations')).toBe(1);
    expect(await countNotifications(other.userId)).toBe(1);

    const lines = journalLines
      .slice(start)
      .map((line) => JSON.parse(line) as { event: string; notifications?: number });
    const deleted = lines.find((line) => line.event === 'v2.account_deleted');
    expect(deleted?.notifications).toBe(2);
  });

  it('a second DELETE after success answers 204 again (idempotent)', async () => {
    const { account, token } = await freshAccount();
    await seedContent(account.userId);
    revokeToken.mockResolvedValue(undefined);

    const first = await send('DELETE', '/api/account', token, { confirm: true });
    expect(first.status).toBe(204);
    const second = await send('DELETE', '/api/account', token, { confirm: true });
    expect(second.status).toBe(204);
  });

  it('the original session retries a failed post-erasure purge while Marketing admission remains fenced', async () => {
    const { account, token } = await freshAccount();
    const { deviceId } = await seedContent(account.userId);
    revokeToken.mockResolvedValue(undefined);
    purgeFault.remaining = 1;

    const failed = await send('DELETE', '/api/account', token, { confirm: true });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: { code: 'store_error' } });
    expect(purgeFault.remaining).toBe(0);
    expect(await countRows(account.userId, 'conversations')).toBe(0); // erasure committed before the failed purge
    expect(await countRows(account.userId, 'memories')).toBe(1);
    expect(await countRows(account.userId, 'google_accounts')).toBe(1);
    expect(await listDevices(db, account.userId)).toHaveLength(1);
    expect(closeDevice).not.toHaveBeenCalled();
    await expect(installMarketingPackage(db, account.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, account.sessionId)).rejects.toThrow('marketing_session_inactive');
    await expect(selectMarketingInstallation(db, account.userId, { installationId: null, mutationId: randomUUID() }, account.sessionId)).rejects.toThrow('marketing_session_inactive');

    const retried = await send('DELETE', '/api/account', token, { confirm: true });
    expect(retried.status).toBe(204);
    expect(await withAdminAuth(pg, (admin) => admin.sessionExists(account.sessionId, account.userId))).toBe(true);
    expect(await countRows(account.userId, 'memories')).toBe(0);
    expect(await countRows(account.userId, 'google_accounts')).toBe(0);
    expect(await listDevices(db, account.userId)).toHaveLength(0);
    expect(closeDevice).toHaveBeenCalledWith(deviceId, 4003, 'revoked');
  });

  it('when revokeToken rejects, the answer is still 204, the Google row is deleted, journal has provider_revoke_failed: 1', async () => {
    const { account, token } = await freshAccount();
    await seedContent(account.userId);
    revokeToken.mockRejectedValueOnce(new Error('provider down'));

    const start = journalLines.length;
    const res = await send('DELETE', '/api/account', token, { confirm: true });
    expect(res.status).toBe(204);
    expect(await countRows(account.userId, 'google_accounts')).toBe(0);

    const lines = journalLines
      .slice(start)
      .map((line) => JSON.parse(line) as { event: string; provider_revoke_failed?: number });
    const deleted = lines.find((line) => line.event === 'v2.account_deleted');
    expect(deleted?.provider_revoke_failed).toBe(1);
  });

  it('the v2.account_deleted journal line contains no user id and no example.com', async () => {
    const { account, token } = await freshAccount();
    await seedContent(account.userId);
    revokeToken.mockResolvedValue(undefined);

    const start = journalLines.length;
    await send('DELETE', '/api/account', token, { confirm: true });

    const lines = journalLines.slice(start);
    const deletedLine = lines.find((line) => (JSON.parse(line) as { event: string }).event === 'v2.account_deleted');
    expect(deletedLine).toBeDefined();
    expect(deletedLine).not.toContain(account.userId);
    expect(deletedLine).not.toContain('example.com');
  });
});
