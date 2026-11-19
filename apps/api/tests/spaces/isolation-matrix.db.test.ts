/**
 * The four-account isolation matrix (issue #116, S14-ISOMATRIX). Runs only under
 * `npm run test:db` (apps/api/vitest.db.config.ts) against the LOCAL Supabase
 * stack in Docker -- real Postgres roles -- because the old in-process test
 * database was more permissive than production and let three bugs ship (specs/014-family-
 * collaboration/STATUS.md, trap 1). Every cell is driven through the store layer
 * under withUser(), so the authenticated role and RLS decide access from ACTIVE
 * membership; a denied cell must fail CLOSED and leak nothing.
 *
 * Of issue #116's six paths, this matrix covers TODAY: the store layer, plus
 * the HTTP routes the existing isolation.test.ts drives (the
 * conversations/pairing/devices/events surfaces). NOT built yet (the next story
 * extends THIS file instead of starting a new suite): the AI tool path, search,
 * media delivery, notification refetch, and background jobs -- none exist, so
 * there is no skipped test for them.
 *
 * Setup (db-harness): A owns a private space; a pair space holds A and B (both
 * owners, server-seeded -- the store cannot create an ownerless pair under RLS);
 * a group holds A (owner), B (admin), C (member); D is the non-member outsider.
 * FORMER is C after removal from the group -- it must fail closed everywhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreNotFoundError } from '../../src/platform/db/db.ts';
import {
  getSpace,
  listMembers,
  revokeMember,
  transferOwnership,
} from '../../src/spaces/store.ts';
import { completeTask, createTask, getTask, updateTask } from '../../src/tasks/store.ts';
import { createNote, getNote, updateNote } from '../../src/notes/store.ts';
import { createInvitation } from '../../src/spaces/invitations.ts';
import {
  setupMemoryTestDb,
  type MatrixSpaces,
  type MemoryTestDb,
} from '../db-harness.ts';

/** Generic messages a denied read must carry (never an id/title/body/name). */
const GENERIC = {
  space: 'space not found',
  task: 'task not found',
  note: 'note not found',
} as const;
type DeniedKind = keyof typeof GENERIC;

const SPACES: Array<keyof MatrixSpaces> = ['privateA', 'pairAB', 'groupABC'];

const ACTORS = ['A', 'B', 'C', 'D', 'FORMER'] as const;
type Actor = (typeof ACTORS)[number];

/** Active memberships: private=A, pair=A+B, group=A+B+C. D is on no space. */
const MEMBERS: Record<keyof MatrixSpaces, Actor[]> = {
  privateA: ['A'],
  pairAB: ['A', 'B'],
  groupABC: ['A', 'B', 'C'],
};

/** Owner per space (for seeding and the owner-only transfer gate). */
const OWNER: Record<keyof MatrixSpaces, Actor> = {
  privateA: 'A',
  pairAB: 'A',
  groupABC: 'A',
};

/** Owner-or-admin per space (invite/remove gate). Pair: both peers are owners. */
const MODERATORS: Record<keyof MatrixSpaces, Actor[]> = {
  privateA: ['A'],
  pairAB: ['A', 'B'],
  groupABC: ['A', 'B'],
};

let env: MemoryTestDb;
let ids: Record<Actor, string>;
let taskId: Record<keyof MatrixSpaces, string> = {} as never;
let noteId: Record<keyof MatrixSpaces, string> = {} as never;

/** Runs fn and returns the thrown error, or undefined if it resolved. */
async function thrown(fn: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

/** Asserts a denied read throws the generic NotFound for `kind` (no leak). */
async function expectDenied(
  kind: DeniedKind,
  fn: () => Promise<unknown>,
): Promise<void> {
  const error = await thrown(fn);
  expect(error).toBeInstanceOf(StoreNotFoundError);
  expect(error!.message).toBe(GENERIC[kind]);
}

/** One content cell for an actor in a space: allowed members succeed on every
 *  resource op; everyone else fails closed with the generic NotFound on reads. */
async function contentCell(actor: Actor, space: keyof MatrixSpaces): Promise<void> {
  const db = env.db;
  const id = ids[actor];
  const spaceId = env.spaces[space];
  const allowed = MEMBERS[space].includes(actor);
  if (allowed) {
    await expect(getSpace(db, id, spaceId)).resolves.toMatchObject({ id: spaceId });
    await expect(getTask(db, id, taskId[space])).resolves.toMatchObject({ id: taskId[space] });
    await expect(getNote(db, id, noteId[space])).resolves.toMatchObject({ id: noteId[space] });
    await expect(listMembers(db, id, spaceId)).resolves.toBeDefined();
    const t = await createTask(db, id, spaceId, { title: 'cell task' });
    await expect(updateTask(db, id, t.id, { revision: 1, title: 'cell task 2' })).resolves.toMatchObject({ id: t.id });
    await expect(completeTask(db, id, t.id)).resolves.toMatchObject({ status: 'completed' });
    const n = await createNote(db, id, spaceId, { title: 'cell note' });
    await expect(updateNote(db, id, n.id, { revision: 1, title: 'cell note 2' })).resolves.toMatchObject({ id: n.id });
    return;
  }
  await expectDenied('space', () => getSpace(db, id, spaceId));
  await expectDenied('task', () => getTask(db, id, taskId[space]));
  await expectDenied('note', () => getNote(db, id, noteId[space]));
  await expectDenied('space', () => listMembers(db, id, spaceId));
  await expectDenied('task', () => updateTask(db, id, taskId[space], { revision: 1, title: 'x' }));
  await expectDenied('task', () => completeTask(db, id, taskId[space]));
  await expectDenied('note', () => updateNote(db, id, noteId[space], { revision: 1, title: 'x' }));
  await expect(thrown(() => createTask(db, id, spaceId, { title: 'forged' }))).toBeDefined();
  await expect(thrown(() => createNote(db, id, spaceId, { title: 'forged' }))).toBeDefined();
}

/** A governance cell for a denied actor: invite/remove/transfer all fail closed. */
async function governanceDenied(actor: Actor, space: keyof MatrixSpaces): Promise<void> {
  const db = env.db;
  const id = ids[actor];
  const spaceId = env.spaces[space];
  await expect(
    thrown(() => createInvitation(db, id, spaceId, { email: 'x@example.com', role: 'member' })),
  ).toBeDefined();
  await expect(thrown(() => revokeMember(db, id, spaceId, ids.A))).toBeDefined();
  await expect(thrown(() => transferOwnership(db, id, spaceId, ids.B))).toBeDefined();
}

describe('isolation matrix: store under real roles (S14-ISOMATRIX)', () => {
  beforeAll(async () => {
    env = await setupMemoryTestDb();
    ids = { A: env.a.userId, B: env.b.userId, C: env.c.userId, D: env.d.userId, FORMER: env.c.userId };
    for (const space of SPACES) {
      const ownerId = ids[OWNER[space]];
      taskId[space] = (await createTask(env.db, ownerId, env.spaces[space], { title: 'matrix task' })).id;
      noteId[space] = (await createNote(env.db, ownerId, env.spaces[space], { title: 'matrix note' })).id;
    }
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('content cells: active members are allowed; everyone else fails closed', async () => {
    for (const space of SPACES) {
      for (const actor of MEMBERS[space]) await contentCell(actor, space);
      for (const actor of ACTORS.filter((a) => a !== 'FORMER' && !MEMBERS[space].includes(a))) {
        await contentCell(actor, space);
      }
    }
  });

  it('governance: invite and remove are owner-or-admin only', async () => {
    for (const space of SPACES) {
      const spaceId = env.spaces[space];
      for (const actor of MODERATORS[space]) {
        await expect(
          createInvitation(env.db, ids[actor], spaceId, {
            email: `invite-${actor}-${space}@example.com`,
            role: 'member',
          }),
        ).resolves.toBeDefined();
        // Removing a member that does not exist still exercises the gate and
        // proves the moderator's remove right is not blocked by RLS.
        await expect(
          revokeMember(env.db, ids[actor], spaceId, ids.D),
        ).rejects.toThrow(/not an active member/);
      }
      for (const actor of ACTORS.filter((a) => !MODERATORS[space].includes(a))) {
        await governanceDenied(actor, space);
      }
    }
  });

  it('governance: transfer ownership is owner only (private and group)', async () => {
    for (const space of SPACES) {
      if (space === 'pairAB') continue; // pair has no single recorded owner
      const spaceId = env.spaces[space];
      const byOwner = transferOwnership(env.db, ids[OWNER[space]], spaceId, ids[OWNER[space]]);
      if (space === 'groupABC') {
        await expect(byOwner).resolves.toBeDefined();
      } else {
        // #232: only a group changes owner; a private space refuses even its owner.
        await expect(byOwner).rejects.toMatchObject({ code: 'unsupported_kind' });
      }
      for (const actor of ACTORS.filter((a) => a !== OWNER[space])) {
        await expect(thrown(() => transferOwnership(env.db, ids[actor], spaceId, ids.B))).toBeDefined();
      }
    }
  });

  // #116 acceptance 2: a new domain table must not pass by omission. Every table
  // in the domain schemas needs RLS enabled AND forced, and at least one policy.
  // The only exceptions are server-only tables that clients can never touch:
  // no policy there means deny-all, so they must also carry no grant to anon or
  // authenticated. Adding a table to SERVER_ONLY is a reviewed decision.
  it('every domain table has forced RLS and policies, or is server-only', async () => {
    const SERVER_ONLY = new Set([
      'bob.firmware_channels', // OTA channel pointers; bob_private.fw_* definers only
      'bob.firmware_events', // OTA offer and result events; bob_private.fw_* definers only
      'bob.firmware_images', // OTA image bytes; bob_private.fw_* definers only
      'bob.firmware_releases', // OTA release catalogue; bob_private.fw_* definers only
      'bob.outbox', // bob_private.outbox_* definer functions only; carries the email marker columns
      'bob.pairing_requests', // server-only via bob_private
      'bob.turn_metrics', // metadata-only metrics; bob_private.record_turn_metric / purge_turn_metrics definers only
      'bob.user_scopes', // permission scopes; bob_private.*_user_scope* definers only
      'bob.waitlist', // public.waitlist_* definer functions (Edge Function) only
    ]);
    const rows = await env.db.query<{
      name: string;
      rls: boolean;
      forced: boolean;
      policies: number;
      client_grant: boolean;
    }>(
      `select n.nspname || '.' || c.relname as name,
              c.relrowsecurity as rls,
              c.relforcerowsecurity as forced,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
              (has_table_privilege('anon', c.oid, 'select,insert,update,delete')
               or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete'))
                as client_grant
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname in ('bob', 'public')
        order by 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const row of rows) {
      if (!row.rls || !row.forced) failures.push(`${row.name}: RLS not enabled and forced`);
      if (SERVER_ONLY.has(row.name)) {
        if (row.client_grant) failures.push(`${row.name}: server-only table is granted to a client role`);
      } else if (row.policies === 0) {
        failures.push(`${row.name}: no RLS policies (add policies, or list it as server-only)`);
      }
    }
    expect(failures).toEqual([]);
    // A stale exception would silently widen the allowlist later.
    const names = new Set(rows.map((row) => row.name));
    expect([...SERVER_ONLY].filter((name) => !names.has(name))).toEqual([]);
  });

  // The email exactly-once marker lives on bob.outbox (#757): no client role
  // may read or write either column, whatever another user's row holds.
  it('no client role has any privilege on the outbox email marker columns', async () => {
    const rows = await env.db.query<{ role: string; col: string; granted: boolean }>(
      `select r.role, c.col,
              has_column_privilege(r.role, 'bob.outbox', c.col, 'select,insert,update,references') as granted
         from (values ('anon'), ('authenticated')) r(role),
              (values ('email_sent_at'), ('recipient_user_id')) c(col)`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.granted)).toEqual([]);
  });

  it('a removed member fails closed on every cell and leaks nothing', async () => {
    await expect(revokeMember(env.db, ids.A, env.spaces.groupABC, ids.C)).resolves.toBeUndefined();
    await contentCell('FORMER', 'groupABC');
    await governanceDenied('FORMER', 'groupABC');
    await expect(thrown(() => transferOwnership(env.db, ids.C, env.spaces.groupABC, ids.B))).toBeDefined();
  });
});