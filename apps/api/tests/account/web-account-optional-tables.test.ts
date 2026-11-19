// DELETE /api/account when bob.google_accounts is absent (CU-REVIEW-11,
// PR #232, tenth Devin review round). A database that has not yet run the
// google_accounts migration must still erase cleanly instead of 500ing after
// eraseAccount has already committed irreversible work (memberships revoked,
// private space deleted). Setup mirrors web-account.test.ts; this file's own
// database additionally has bob.google_accounts dropped before every test,
// through the same admin seam store-spaces.test.ts uses for schema-level ops
// bob_server (nobypassrls, not the table owner) cannot perform itself.
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createAccountRouter } from '../../src/account/http.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { addMember, createSpace, listMembers } from '../../src/spaces/store.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb, withUserRaw } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

describe('account API without bob.google_accounts (CU-REVIEW-11)', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server;
  let baseUrl: string;
  const journalLines: string[] = [];
  const closeDevice = vi.fn();
  const revokeToken = vi.fn();

  beforeAll(async () => {
    setJournalSink((line: string) => journalLines.push(line));
    pg = await createTestDb();
    const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
    await withAdmin(url, (admin) => admin.unsafe('drop table bob.google_accounts cascade'));
    db = asDb(pg);
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use(
      '/api/account',
      createAccountRouter({
        getDb: () => Promise.resolve(db),
        requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
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
  });

  async function tokenFor(account: TestAccount): Promise<string> {
    return signToken({ userId: account.userId, sessionId: account.sessionId });
  }

  async function send(method: string, path: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function countRows(userId: string, table: string): Promise<number> {
    const result = await withUserRaw(pg, userId, (tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from bob.${table} where user_id = $1`, [userId]),
    );
    return result.rows[0]!.n;
  }

  it('204s, purges the conversation, revokes group membership, never calls revokeToken, journals google_accounts: 0', async () => {
    const account = await addAccount(pg);
    const token = await tokenFor(account);
    await createConversation(db, account.userId, 't');
    const owner = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Shared' });
    await addMember(db, owner.userId, group.id, account.userId, 'member');

    const start = journalLines.length;
    const res = await send('DELETE', '/api/account', token, { confirm: true });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    expect(await countRows(account.userId, 'conversations')).toBe(0);
    const members = await listMembers(db, owner.userId, group.id);
    expect(members.some((m) => m.userId === account.userId)).toBe(false);
    expect(revokeToken).not.toHaveBeenCalled();

    const lines = journalLines
      .slice(start)
      .map((line) => JSON.parse(line) as { event: string; google_accounts?: number });
    const deleted = lines.find((line) => line.event === 'v2.account_deleted');
    expect(deleted?.google_accounts).toBe(0);
  });
});
