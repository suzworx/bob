/**
 * The SQL id helpers (IDS epic, P1 migration) on real Postgres as bob_server:
 * bob_private.legacy_id must map every id exactly as canonicalId does, since the
 * later conversion migrations backfill with it while the server reads with the TS.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalId, ID_PREFIX, type IdKind } from '../../src/platform/ids.ts';
import { closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const UUID = '1c3434d3-d78b-4dbf-b83b-9d6c1667d84b';
const FIXTURES: [IdKind, string][] = [
  ['conversation', `cnv_${UUID}`],
  ['conversation', `thr_${UUID}`],
  ['conversation', `conv_${UUID}`],
  ['conversation', `conv_${UUID.replaceAll('-', '')}`],
  ['conversation', UUID.toUpperCase()],
  ['message', `msg_${UUID}`],
  ['memory', `mem_${UUID}`],
  ['action_item', `act_${UUID}`],
  ['message_version', `ver_${UUID}`],
  ['message', 'aB3dE5fG7hJ9kL1m'],
  ['message', 'msg-0123456789abcdef0123456789abcdef'],
  ['device', 'dev-local-01'],
  ['space', 'bad id!'],
  ['space', 'short'],
];

describe('SQL id helpers', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await closeTestDb(db);
  });

  const legacy = async (pairs: [string, string][]): Promise<(string | null)[]> => {
    const { rows } = await db.query<{ id: string | null }>(
      `select bob_private.legacy_id(p, old) as id
         from unnest($1::text[], $2::text[]) with ordinality as t(p, old, n) order by n`,
      [pairs.map(([p]) => p), pairs.map(([, old]) => old)],
    );
    return rows.map((row) => row.id);
  };

  it('legacy_id agrees with canonicalId on 1000 random uuids', async () => {
    const kinds = Object.keys(ID_PREFIX) as IdKind[];
    const cases = Array.from({ length: 1000 }, (_, i) => [kinds[i % kinds.length]!, randomUUID()] as const);
    const sql = await legacy(cases.map(([kind, uuid]) => [ID_PREFIX[kind], uuid]));
    expect(sql).toEqual(cases.map(([kind, uuid]) => canonicalId(kind, uuid)));
  });

  it('legacy_id agrees with canonicalId on the legacy fixtures', async () => {
    const sql = await legacy(FIXTURES.map(([kind, old]) => [ID_PREFIX[kind], old]));
    expect(sql).toEqual(FIXTURES.map(([kind, old]) => canonicalId(kind, old)));
  });

  it('new_id returns prefix + 32 lowercase hex', async () => {
    const { rows } = await db.query<{ id: string }>(`select bob.new_id('spc') as id`);
    expect(rows[0]!.id).toMatch(/^spc_[0-9a-f]{32}$/);
  });

  it('id_text_tables lists only bob tables whose id is text', async () => {
    const { rows } = await db.query<{ t: string }>('select t from bob_private.id_text_tables() as t');
    const tables = rows.map((row) => row.t);
    expect(tables).toContain('conversations');
    expect(tables).not.toContain('spaces');
  });
});
