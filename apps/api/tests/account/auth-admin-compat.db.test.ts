// test:db suite (S14-DEVAUTH-FIX): the behavioural proof that a dev account
// row no longer breaks GoTrue's admin API on the REAL stack (only the real
// stack runs GoTrue; a bare Postgres cannot prove it). resolveDevAccount's raw insert
// is a silent no-op on the real stack (bob_server has no INSERT grant on
// auth.users), so the row is created here through the SECURITY DEFINER
// system-test helper — the path that actually works as bob_server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import { ensureLocalStack, setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

const DEV_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

describe('auth admin users with the dev account (S14-DEVAUTH-FIX)', () => {
  let env: MemoryTestDb;
  let apiUrl: string;
  let serviceRoleKey: string;

  beforeAll(async () => {
    // The service role key stays in memory only — used in request headers,
    // never printed or asserted on.
    const stack = await ensureLocalStack();
    apiUrl = stack.API_URL!;
    serviceRoleKey = stack.SERVICE_ROLE_KEY!;
    env = await setupMemoryTestDb();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  async function adminUsersStatus(): Promise<number> {
    const res = await fetch(`${apiUrl}/auth/v1/admin/users`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });
    return res.status;
  }

  it(
    'GET /auth/v1/admin/users returns 200 with the dev account present',
    async () => {
      await resolveDevAccount(env.db);
      await env.db.query(
        'select bob_private.ensure_test_session($1, $2)',
        [DEV_ACCOUNT_ID, randomUUID()],
      );
      expect(await adminUsersStatus()).toBe(200);
    },
    60_000,
  );

  it(
    'stays 200 after a second resolveDevAccount (idempotent)',
    async () => {
      await resolveDevAccount(env.db);
      await env.db.query(
        'select bob_private.ensure_test_session($1, $2)',
        [DEV_ACCOUNT_ID, randomUUID()],
      );
      expect(await adminUsersStatus()).toBe(200);
    },
    60_000,
  );
});