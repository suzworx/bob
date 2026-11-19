/**
 * The unified thread store against real Postgres + RLS (#756 PR2,
 * CONV-UNIFY-U3A, `npm run test:db` only): the row lock dedupes a concurrent
 * client_message_id retry, a shared edit adds a version, a non-member sees no
 * shared conversation, a private one is owner-only, and the space kind (never
 * the id's shape) decides whether a conversation is shared (IDS U2).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreNotFoundError, withUser } from '../../src/platform/db/db.ts';
import { createConversation, getConversation, listConversations } from '../../src/conversations/store.ts';
import { createThread, editMessage, getMessage, getThread, listMessages, listThreads, postMessage } from '../../src/conversations/thread-store.ts';
import { searchResources } from '../../src/conversations/search-store.ts';
import { setupMemoryTestDb, teardownMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

let env: MemoryTestDb | undefined;

function ctx(): MemoryTestDb {
  if (!env) throw new Error('db harness not set up');
  return env;
}

/** Raw rows as one account, bypassing the store's queries (RLS still applies). */
async function rawSelect<T>(userId: string, sql: string, params: unknown[]): Promise<T[]> {
  return withUser(ctx().db, userId, (tx) => tx.query<T>(sql, params));
}

describe('unified thread store on Postgres (#756 CONV-UNIFY-U3A)', () => {
  beforeAll(async () => {
    env = await setupMemoryTestDb();
  }, 300_000);

  afterAll(async () => {
    await teardownMemoryTestDb(env);
  });

  it('concurrent posts with the same client_message_id yield one row', async () => {
    const { db, a, spaces } = ctx();
    const thread = await createThread(db, a.userId, { spaceId: spaces.groupABC, title: 'Retry race' });
    const post = () => postMessage(db, a.userId, { threadId: thread.id, body: 'once', clientMessageId: 'race-1' });
    const results = await Promise.all([post(), post(), post()]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    const rows = await rawSelect<{ n: unknown }>(
      a.userId,
      `select count(*)::int as n from bob.messages where conversation_id = $1`,
      [thread.id],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('a shared edit adds a selected version and bumps revision', async () => {
    const { db, a, b, spaces } = ctx();
    const thread = await createThread(db, a.userId, { spaceId: spaces.groupABC, title: 'Edits' });
    const { message } = await postMessage(db, b.userId, { threadId: thread.id, body: 'draft', clientMessageId: 'ed-1' });

    const edited = await editMessage(db, b.userId, message.id, { body: 'final' });
    expect(edited.revision).toBe(2);
    expect((await getMessage(db, a.userId, message.id)).body).toBe('final');
    const versions = await rawSelect<{ versionIndex: unknown; isSelected: unknown }>(
      a.userId,
      `select version_index as "versionIndex", is_selected as "isSelected"
         from bob.message_versions where message_id = $1 order by version_index`,
      [message.id],
    );
    expect(versions.map((v) => [Number(v.versionIndex), Boolean(v.isSelected)])).toEqual([[0, false], [1, true]]);
  });

  it('a non-member cannot read a shared conversation; a private one is owner-only', async () => {
    const { db, a, b, d, spaces } = ctx();
    const thread = await createThread(db, a.userId, { spaceId: spaces.groupABC, title: 'Members only' });
    await postMessage(db, a.userId, { threadId: thread.id, body: 'secret', clientMessageId: 'nm-1' });

    await expect(getThread(db, d.userId, thread.id)).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(listMessages(db, d.userId, thread.id)).rejects.toBeInstanceOf(StoreNotFoundError);
    const sharedForD = await rawSelect(d.userId, `select id from bob.conversations where id = $1`, [thread.id]);
    expect(sharedForD).toHaveLength(0);

    const general = await createConversation(db, a.userId, 'A only');
    const privateSql = `select id from bob.conversations where id = $1`;
    expect(await rawSelect(a.userId, privateSql, [general.id])).toHaveLength(1);
    expect(await rawSelect(b.userId, privateSql, [general.id])).toHaveLength(0);
  });

  // IDS U2: the space kind decides shared vs personal, never the id's shape.
  /** Inserts a conversation row as A with an explicit id in `spaceId`. */
  async function insertConversation(id: string, spaceId: string, title: string): Promise<void> {
    const { db, a } = ctx();
    await withUser(db, a.userId, (tx) =>
      tx.query(
        `insert into bob.conversations (id, user_id, space_id, created_by, title) values ($1, $2, $3, $2, $4)`,
        [id, a.userId, spaceId, title],
      ),
    );
  }

  it('a conversation in a private space is never listed, served or appended by the space API', async () => {
    const { db, a, spaces } = ctx();
    const id = randomUUID();
    await insertConversation(id, spaces.privateA, 'Private uuid conversation');

    expect((await listThreads(db, a.userId, spaces.privateA)).map((t) => t.id)).not.toContain(id);
    await expect(getThread(db, a.userId, id)).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(listMessages(db, a.userId, id)).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(postMessage(db, a.userId, { threadId: id, body: 'hi', clientMessageId: 'pv-1' }))
      .rejects.toBeInstanceOf(StoreNotFoundError);
    // C2: the personal API serves it instead.
    expect((await getConversation(db, a.userId, id))?.id).toBe(id);
    expect((await listConversations(db, a.userId)).map((c) => c.id)).toContain(id);
  });

  it('a conversation in a shared space is served by the space API whatever its id shape, never the personal API', async () => {
    const { db, a, spaces } = ctx();
    const id = `cnv_${randomUUID()}`;
    await insertConversation(id, spaces.groupABC, 'Shared opaque id');

    expect((await listThreads(db, a.userId, spaces.groupABC)).map((t) => t.id)).toContain(id);
    expect((await getThread(db, a.userId, id)).id).toBe(id);
    const { message } = await postMessage(db, a.userId, { threadId: id, body: 'hello', clientMessageId: 'sh-1' });
    expect((await getMessage(db, a.userId, message.id)).threadId).toBe(id);
    expect(await getConversation(db, a.userId, id)).toBeNull();
    expect((await listConversations(db, a.userId)).map((c) => c.id)).not.toContain(id);
  });

  it('creating a multi-author conversation in a private space is refused', async () => {
    const { db, a, spaces } = ctx();
    await expect(createThread(db, a.userId, { spaceId: spaces.privateA, title: 'Nope' }))
      .rejects.toBeInstanceOf(StoreNotFoundError);
    const rows = await rawSelect(a.userId, `select id from bob.conversations where space_id = $1 and title = 'Nope'`, [spaces.privateA]);
    expect(rows).toHaveLength(0);
  });

  it('search labels conversations by space kind and does not cast ids to uuid', async () => {
    const { db, a, spaces } = ctx();
    const shared = `cnv_${randomUUID()}`;
    const privateUuid = randomUUID();
    await insertConversation(shared, spaces.pairAB, 'Searchkind shared');
    await insertConversation(privateUuid, spaces.privateA, 'Searchkind private');

    const results = await searchResources(db, a.userId, { query: 'Searchkind', types: ['thread'] });
    expect(results.map((r) => r.resource_id)).toEqual([shared]);
  });
});
