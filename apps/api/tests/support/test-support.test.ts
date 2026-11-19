// T005 gate test for the shared test database + JWT helpers. Proves the
// migration-complete template is usable, withUserRaw isolates accounts, and signToken
// mints tokens the T010 guard can verify (wrong issuer/audience/expiry fail).
import { jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { signToken, testIssuer, testJwks } from './test-auth.ts';
import { addAccount, closeTestDb, createTestDb, withUserRaw, withAdminAuth } from './test-db.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const SESSION = '00000000-0000-4000-8000-0000000000aa';

describe('test support (T005)', () => {
  it('createTestDb applies the shim and every migration cleanly', async () => {
    const db = await createTestDb();
    await closeTestDb(db);
  }, 30_000);

  it('addAccount creates an auth.users row plus an auth.sessions row', async () => {
    const db = await createTestDb();
    try {
      const account = await addAccount(db);
      // auth.* is not readable as bob_server; verify through the admin seam.
      expect(await withAdminAuth(db, (admin) => admin.sessionExists(account.sessionId, account.userId))).toBe(true);
    } finally {
      await closeTestDb(db);
    }
  });

  it('isolates two accounts on bob.conversations via withUserRaw', async () => {
    const db = await createTestDb();
    try {
      const a = await addAccount(db, { id: A });
      const b = await addAccount(db, { id: B });
      await withUserRaw(db, a.userId, async (tx) => {
        await tx.query(
          "insert into bob.conversations (id, user_id, title) values ('conv_isola', $1, 'A conv')",
          [a.userId],
        );
      });
      await withUserRaw(db, b.userId, async (tx) => {
        const { rows } = await tx.query('select id from bob.conversations');
        expect(rows).toHaveLength(0);
      });
      await withUserRaw(db, a.userId, async (tx) => {
        const { rows } = await tx.query('select id from bob.conversations');
        expect(rows).toHaveLength(1);
      });
    } finally {
      await closeTestDb(db);
    }
  });

  it('signToken verifies against testJwks with the Supabase access-token shape', async () => {
    const token = await signToken({ userId: A, sessionId: SESSION });
    const { payload } = await jwtVerify(token, testJwks, {
      issuer: testIssuer,
      audience: 'authenticated',
    });
    expect(payload.sub).toBe(A);
    expect(payload.session_id).toBe(SESSION);
    expect(payload.aud).toBe('authenticated');
    expect(payload.role).toBe('authenticated');
    expect(payload.iss).toBe(testIssuer);
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
  });

  it('rejects a token with the wrong issuer', async () => {
    const token = await signToken({ userId: A, sessionId: SESSION, issuer: 'http://evil.test/auth/v1' });
    await expect(
      jwtVerify(token, testJwks, { issuer: testIssuer, audience: 'authenticated' }),
    ).rejects.toThrow(/unexpected "iss"/);
  });

  it('rejects a token with the wrong audience', async () => {
    const token = await signToken({ userId: A, sessionId: SESSION, audience: 'service_role' });
    await expect(
      jwtVerify(token, testJwks, { issuer: testIssuer, audience: 'authenticated' }),
    ).rejects.toThrow(/unexpected "aud"/);
  });

  it('rejects an expired token', async () => {
    const token = await signToken({ userId: A, sessionId: SESSION, expiresInSeconds: -60 });
    await expect(
      jwtVerify(token, testJwks, { issuer: testIssuer, audience: 'authenticated' }),
    ).rejects.toThrow(/"exp"/);
  });
});