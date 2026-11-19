/**
 * The #756 PR1 conversation isolation matrix on the LOCAL Supabase stack (real
 * Postgres roles; `npm run test:db` only). The migration-complete test db
 * proves the same matrix in tests/platform/conversation-unify-migration.test.ts;
 * this file repeats it where roles and RLS are production-shaped
 * (isolation-matrix.db.test.ts).
 *
 * Setup (db-harness): A owns a private space; a group holds A (owner), B
 * (admin), C (member); D is the outsider. Every row is written under
 * withUser, so the policies added by 20261001100000_conversation_unify_expand
 * decide every cell. FORMER is C after removal: it must read nothing, even the
 * group message C authored (user_id = C) -- the restrictive space guard.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { revokeMember } from '../../src/spaces/store.ts';
import { setupMemoryTestDb, teardownMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

let env: MemoryTestDb | undefined;
const run = randomUUID().slice(0, 8);
const PRIVATE_CONV = `conv_priv_${run}`;
const OLD_PATH_CONV = `conv_old_${run}`;
const GROUP_CONV = `conv_group_${run}`;

/** Ids of this run's conversations and messages visible to `userId`. */
async function visible(userId: string): Promise<{ convs: string[]; msgs: string[] }> {
  return withUser(env!.db, userId, async (tx) => {
    const convs = await tx.query<{ id: string }>(
      'select id from bob.conversations where id = any($1::text[]) order by id',
      [[PRIVATE_CONV, OLD_PATH_CONV, GROUP_CONV]],
    );
    const msgs = await tx.query<{ id: string }>(
      `select id from bob.messages where id like $1 order by id`,
      [`%_${run}_%`],
    );
    return { convs: convs.map((r) => r.id), msgs: msgs.map((r) => r.id) };
  });
}

async function insertMessage(
  tx: Db,
  userId: string,
  conv: string,
  spaceId: string | null,
  n: number,
): Promise<void> {
  await tx.query(
    `insert into bob.messages
       (id, conversation_id, space_id, user_id, author_user_id, role, position, sequence)
     values ($1, $2, $3, $4, $4, 'user', $5, $5 + 1)`,
    [`msg_${conv}_${run}_${n}`, conv, spaceId, userId, n],
  );
}

describe('conversation unify RLS matrix under real roles (#756 PR1)', () => {
  beforeAll(async () => {
    env = await setupMemoryTestDb();
    const { db, a, b, c, spaces } = env;
    await withUser(db, a.userId, async (tx) => {
      await tx.query(
        `insert into bob.conversations (id, user_id, space_id, title) values ($1, $2, $3, 'private')`,
        [PRIVATE_CONV, a.userId, spaces.privateA],
      );
      await insertMessage(tx, a.userId, PRIVATE_CONV, spaces.privateA, 0);
      // Old-code path: no space_id at all.
      await tx.query(`insert into bob.conversations (id, user_id, title) values ($1, $2, 'old path')`, [
        OLD_PATH_CONV,
        a.userId,
      ]);
      await insertMessage(tx, a.userId, OLD_PATH_CONV, null, 0);
      await tx.query(
        `insert into bob.conversations (id, user_id, space_id, created_by, title)
         values ($1, $2, $3, $2, 'group')`,
        [GROUP_CONV, a.userId, spaces.groupABC],
      );
      await insertMessage(tx, a.userId, GROUP_CONV, spaces.groupABC, 0);
    });
    await withUser(db, b.userId, (tx) => insertMessage(tx, b.userId, GROUP_CONV, spaces.groupABC, 1));
    await withUser(db, c.userId, (tx) => insertMessage(tx, c.userId, GROUP_CONV, spaces.groupABC, 2));
  }, 300_000);

  afterAll(async () => {
    await teardownMemoryTestDb(env);
  });

  const groupMsgs = () => [0, 1, 2].map((n) => `msg_${GROUP_CONV}_${run}_${n}`);
  const ownMsgs = () => [PRIVATE_CONV, OLD_PATH_CONV].map((c) => `msg_${c}_${run}_0`);

  it('A reads its private and old-path conversations; B, C and D read none of them', async () => {
    const a = await visible(env!.a.userId);
    expect(a.convs).toEqual([GROUP_CONV, OLD_PATH_CONV, PRIVATE_CONV].sort());
    expect(a.msgs).toEqual([...groupMsgs(), ...ownMsgs()].sort());
    for (const other of [env!.b, env!.c, env!.d]) {
      const seen = await visible(other.userId);
      expect(seen.convs.filter((id) => id !== GROUP_CONV)).toEqual([]);
      expect(seen.msgs.filter((id) => ownMsgs().includes(id))).toEqual([]);
    }
  });

  it('group members read the group conversation and every message; D reads nothing', async () => {
    for (const member of [env!.a, env!.b, env!.c]) {
      const seen = await visible(member.userId);
      expect(seen.convs).toContain(GROUP_CONV);
      expect(seen.msgs.filter((id) => groupMsgs().includes(id))).toEqual(groupMsgs());
    }
    expect(await visible(env!.d.userId)).toEqual({ convs: [], msgs: [] });
  });

  it('the update grant covers revision/tombstoned_at but not role/position', async () => {
    const rows = await env!.db.query<Record<string, boolean>>(
      `select ${['revision', 'tombstoned_at', 'role', 'position']
        .map((c) => `has_column_privilege('authenticated', 'bob.messages', '${c}', 'UPDATE') as ${c}`)
        .join(', ')}`,
    );
    expect(rows[0]).toEqual({ revision: true, tombstoned_at: true, role: false, position: false });
  });

  // Last: removes C from the group.
  it('a former member reads nothing, including the message they authored', async () => {
    await revokeMember(env!.db, env!.a.userId, env!.spaces.groupABC, env!.c.userId);
    expect(await visible(env!.c.userId)).toEqual({ convs: [], msgs: [] });
  });
});
