import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb, type TestTx } from '../support/pg-template.ts';

const migrationDir = new URL('../../../../supabase/migrations/', import.meta.url);
const migrationFiles = readdirSync(migrationDir).filter((f) => f.endsWith('_bob_init.sql'));
const migrationFileName = migrationFiles[migrationFiles.length - 1];
if (!migrationFileName) {
  throw new Error('no bob_init migration found under supabase/migrations');
}
const migration = readFileSync(new URL(migrationFileName, migrationDir), 'utf8');

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const CODE = 'aa'.repeat(32);
const CLAIM = 'bb'.repeat(32);
const TOKEN = 'cc'.repeat(32);
const CODE2 = 'dd'.repeat(32);
const CLAIM2 = 'ee'.repeat(32);

const EXPECTED_TABLES = [
  'active_conversations',
  'conversations',
  'devices',
  'message_versions',
  'messages',
  'pairing_requests',
];

const EXPECTED_FUNCTIONS = [
  'account_disabled',
  'approve_pairing',
  'claim_pairing',
  'deny_pairing',
  'device_for_token',
  'expire_pairings',
  'issue_pairing',
  'lookup_pairing',
  'revoke_device',
  'session_active',
  'touch_device',
];

async function withUser<T>(
  db: TestDb,
  userId: string,
  fn: (tx: TestTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(
      `select set_config('request.jwt.claims',
         json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`,
      [userId],
    );
    await tx.query('set local role authenticated');
    return fn(tx);
  });
}

async function asServer<T>(db: TestDb, fn: (db: TestDb) => Promise<T>): Promise<T> {
  await db.query('set role bob_server');
  try {
    return await fn(db);
  } finally {
    await db.query('reset role');
  }
}

describe('bob_init migration (T004)', () => {
  let db: TestDb;

  beforeAll(async () => {
    // The init migration alone, on the Supabase base.
    db = await createMigratedDb({ skip: (file) => file !== migrationFileName });
    await db.exec(`insert into auth.users (id) values ('${A}'), ('${B}')`);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('creates all 6 bob tables with RLS enabled AND forced', async () => {
    const { rows } = await db.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'bob' and c.relkind = 'r'
        order by c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual(EXPECTED_TABLES);
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.relforcerowsecurity).toBe(true);
    }
  });

  it('creates the 11 bob_private functions SECURITY DEFINER with search_path set', async () => {
    const { rows } = await db.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'bob_private'
        order by p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(EXPECTED_FUNCTIONS);
    for (const r of rows) {
      expect(r.prosecdef).toBe(true);
      expect(r.proconfig?.some((c) => c.startsWith('search_path'))).toBe(true);
    }
  });

  it('gives anon no privilege on schema bob', async () => {
    const { rows } = await db.query<{ can_use: boolean }>(
      `select has_schema_privilege('anon', 'bob', 'USAGE') as can_use`,
    );
    expect(rows[0]?.can_use).toBe(false);
  });

  it('keeps the role block idempotent; the full file is not (schemas already exist)', async () => {
    const roleBlock = migration.match(/do \$\$ begin[\s\S]*?grant authenticated to bob_server;/)?.[0];
    expect(roleBlock).toBeDefined();
    await expect(db.exec(roleBlock!)).resolves.toBeUndefined();
    await expect(db.exec(migration)).rejects.toThrow();
  });

  it('isolates two accounts on conversations and messages via withUser', async () => {
    await withUser(db, A, async (tx) => {
      await tx.query(
        "insert into bob.conversations (id, user_id, title) values ('conv_isola', $1, 'A conv')",
        [A],
      );
      await tx.query(
        `insert into bob.messages (id, conversation_id, user_id, role, position)
         values ('msg_isola', 'conv_isola', $1, 'user', 0)`,
        [A],
      );
    });
    await withUser(db, B, async (tx) => {
      const convs = await tx.query('select id from bob.conversations');
      expect(convs.rows).toHaveLength(0);
      const msgs = await tx.query('select id from bob.messages');
      expect(msgs.rows).toHaveLength(0);
    });
    await withUser(db, A, async (tx) => {
      const convs = await tx.query('select id from bob.conversations');
      expect(convs.rows).toHaveLength(1);
      const msgs = await tx.query('select id from bob.messages');
      expect(msgs.rows).toHaveLength(1);
    });
  });

  it('pairing smoke: issue → approve (NULL token) → claim → device_for_token → revoke', async () => {
    const issue = await asServer(db, (d) =>
      d.query<{ issue_pairing: string }>(
        `select bob_private.issue_pairing(
           decode($1, 'hex'), decode($2, 'hex'), $3, $4, $5, $6) as issue_pairing`,
        [CODE, CLAIM, 'M5Stack Cardputer', '2.0.1', '10.0.0.1', 600],
      ),
    );
    const pairingId = issue.rows[0]!.issue_pairing;

    const approve = await withUser(db, A, (tx) =>
      tx.query<{ approve_pairing: string }>(
        'select bob_private.approve_pairing($1, $2) as approve_pairing',
        [pairingId, 'Living Room'],
      ),
    );
    const deviceId = approve.rows[0]!.approve_pairing;

    const before = await db.query<{ token_hash: Uint8Array | null; revoked_at: string | null }>(
      'select token_hash, revoked_at from bob.devices where id = $1',
      [deviceId],
    );
    expect(before.rows[0]?.token_hash).toBeNull();
    expect(before.rows[0]?.revoked_at).toBeNull();

    const claim = await asServer(db, (d) =>
      d.query<{ device_id: string; name: string }>(
        `select * from bob_private.claim_pairing($1, decode($2, 'hex'), decode($3, 'hex'))`,
        [pairingId, CLAIM, TOKEN],
      ),
    );
    expect(claim.rows).toHaveLength(1);
    expect(claim.rows[0]!.device_id).toBe(deviceId);

    const delivered = await db.query<{ status: string }>(
      'select status from bob.pairing_requests where id = $1',
      [pairingId],
    );
    expect(delivered.rows[0]?.status).toBe('delivered');
    const hashed = await db.query<{ token_hash: Uint8Array | null }>(
      'select token_hash from bob.devices where id = $1',
      [deviceId],
    );
    expect(Array.from(hashed.rows[0]!.token_hash!)).toEqual(Array.from(Buffer.from(TOKEN, 'hex')));

    const found = await asServer(db, (d) =>
      d.query<{ device_id: string; revoked: boolean; disabled: boolean }>(
        `select * from bob_private.device_for_token(decode($1, 'hex'))`,
        [TOKEN],
      ),
    );
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]!.device_id).toBe(deviceId);
    expect(found.rows[0]!.revoked).toBe(false);
    expect(found.rows[0]!.disabled).toBe(false);
    const seen = await db.query<{ last_seen_at: string | null }>(
      'select last_seen_at from bob.devices where id = $1',
      [deviceId],
    );
    expect(seen.rows[0]?.last_seen_at).not.toBeNull();

    await withUser(db, A, (tx) => tx.query('select bob_private.revoke_device($1)', [deviceId]));

    const after = await asServer(db, (d) =>
      d.query<{ device_id: string; revoked: boolean }>(
        `select * from bob_private.device_for_token(decode($1, 'hex'))`,
        [TOKEN],
      ),
    );
    expect(after.rows[0]?.revoked).toBe(true);
  });

  it('expire_pairings deletes a never-delivered device', async () => {
    const issue = await asServer(db, (d) =>
      d.query<{ issue_pairing: string }>(
        `select bob_private.issue_pairing(
           decode($1, 'hex'), decode($2, 'hex'), $3, $4, $5, $6) as issue_pairing`,
        [CODE2, CLAIM2, 'M5Stack Cardputer', '2.0.1', '10.0.0.2', 600],
      ),
    );
    const pairingId = issue.rows[0]!.issue_pairing;

    const approve = await withUser(db, A, (tx) =>
      tx.query<{ approve_pairing: string }>(
        'select bob_private.approve_pairing($1, $2) as approve_pairing',
        [pairingId, 'Den'],
      ),
    );
    const deviceId = approve.rows[0]!.approve_pairing;

    const expired = await asServer(db, (d) =>
      d.query<{ expire_pairings: string }>(
        `select * from bob_private.expire_pairings(now() + interval '20 minutes')`,
      ),
    );
    expect(expired.rows.some((r) => r.expire_pairings === pairingId)).toBe(true);

    const device = await db.query<{ id: string }>('select id from bob.devices where id = $1', [
      deviceId,
    ]);
    expect(device.rows).toHaveLength(0);
    const status = await db.query<{ status: string }>(
      'select status from bob.pairing_requests where id = $1',
      [pairingId],
    );
    expect(status.rows[0]?.status).toBe('expired');
  });
});
