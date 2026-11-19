import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import {
  asDb,
  closeTestDb,
  createTestDb,
  type TestDb,
  withAdminAuth,
} from '../support/test-db.ts';

const DEV_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

describe('dev account (T008)', () => {
  let pg: TestDb;
  let db: Db;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
  });

  afterAll(async () => {
    delete process.env.BOB_PRODUCTION;
    await closeTestDb(pg).catch(() => undefined);
  });

  // These two tests were written for a superuser connection, where
  // resolveDevAccount's own INSERT succeeded and the test could read auth.users
  // back directly. On real Postgres the connection is bob_server, which has no
  // grant on schema auth. resolveDevAccount documents that its insert is then
  // EXPECTED to be refused, because the test setup has already created the row
  // (createTestDb seeds it). So "creates the row on first use" no longer
  // describes anything that happens; what still matters is that the account
  // resolves and that its row exists with a shape GoTrue can scan.
  it(
    'returns the fixed uuid, and that account has an auth.users row',
    async () => {
      const userId = await resolveDevAccount(db);
      expect(userId).toBe(DEV_ACCOUNT_ID);
      const row = await withAdminAuth(pg, (admin) => admin.getUser(userId));
      expect(row, 'the dev account must exist in auth.users or every FK to it fails').not.toBeNull();
    },
    30_000,
  );

  it(
    'the dev account row carries GoTrue token columns as the empty string, never NULL',
    async () => {
      // A NULL in any of these makes GoTrue fail to scan the row into a
      // non-nullable string, which breaks /auth/v1/admin/users for the WHOLE
      // project, not just this account (S14-DEVAUTH-FIX). The row is now created
      // by the harness through bob_private.ensure_test_session rather than by
      // resolveDevAccount's insert, so this guards that definer's output.
      const freshPg = await createTestDb();
      const freshDb = asDb(freshPg);
      try {
        await resolveDevAccount(freshDb);
        const row = await withAdminAuth(freshPg, (admin) => admin.getUser(DEV_ACCOUNT_ID));
        expect(row).not.toBeNull();
        expect(row!.aud).toBe('authenticated');
        expect(row!.role).toBe('authenticated');
        for (const col of [
          'confirmation_token',
          'recovery_token',
          'email_change',
          'email_change_token_new',
          'email_change_token_current',
          'phone_change',
          'phone_change_token',
          'reauthentication_token',
        ]) {
          expect(row![col], `${col} must be '' not NULL`).toBe('');
        }
      } finally {
        await closeTestDb(freshPg).catch(() => undefined);
      }
    },
    30_000,
  );

  it(
    'throws under BOB_PRODUCTION=1 and never touches the store',
    async () => {
      process.env.BOB_PRODUCTION = '1';
      await expect(resolveDevAccount(db)).rejects.toThrow(/production/i);
    },
    30_000,
  );

  it(
    'throws against a hosted BOB_DATABASE_URL, outside production too',
    async () => {
      delete process.env.BOB_PRODUCTION;
      const original = process.env.BOB_DATABASE_URL;
      // Fake project ref; the short password keeps the staged secret scan quiet.
      const hosted = 'postgresql://bob_server.abcdefghijklmnop:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
      process.env.BOB_DATABASE_URL = hosted;
      try {
        await expect(resolveDevAccount(db)).rejects.toThrow(/local database/i);
      } finally {
        if (original === undefined) delete process.env.BOB_DATABASE_URL;
        else process.env.BOB_DATABASE_URL = original;
      }
    },
    30_000,
  );
});