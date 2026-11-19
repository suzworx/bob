// test:db suite (S14-SEARCH-API, issue #141): scoped search proven against real
// roles. The contract is one sentence -- "inaccessible items are absent, not
// redacted" -- so this proves the authorization happens in the search query
// itself (RLS), not in a filter afterwards: account A's search never returns
// B's private-space rows, a space A is not a member of answers an empty list
// (the same as a nonexistent space, never a 403), and removing A from a shared
// space makes those rows absent on the next search. Runs against the LOCAL
// Supabase stack only (`npm run test:db`; db-harness connects as bob_server,
// the role production uses). The lead runs it; workers do not run test:db.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { searchResources } from '../../src/conversations/search-store.ts';
import { addMember, createSpace, ensurePrivateSpace, revokeMember } from '../../src/spaces/store.ts';
import { createTask } from '../../src/tasks/store.ts';
import { createNote } from '../../src/notes/store.ts';
import { createCalendar, createEvent } from '../../src/calendar/store.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

describe('search isolation on the local stack (S14-SEARCH-API)', () => {
  let env: MemoryTestDb;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("A's search never returns B's private-space rows", async () => {
    const a = env.a.userId;
    const b = env.b.userId;
    const shared = await createSpace(env.db, a, { kind: 'group', name: 'Shared' });
    const aPrivate = await ensurePrivateSpace(env.db, a);
    const bPrivate = await ensurePrivateSpace(env.db, b);
    await addMember(env.db, a, shared.id, b, 'member');

    await createTask(env.db, a, shared.id, { title: 'plan trip', body: 'pack bags' });
    await createNote(env.db, b, shared.id, { title: 'shared notes', body: 'trip list' });
    await createTask(env.db, a, aPrivate.id, { title: 'secret a task', body: 'triple trip' });
    await createNote(env.db, b, bPrivate.id, { title: 'secret b note', body: 'trip to hide' });
    const calB = await createCalendar(env.db, b, bPrivate.id, { name: 'B cal', zone: 'UTC' });
    await createEvent(env.db, b, calB.id, {
      title: 'private b trip',
      allDay: true,
      startDate: '2026-09-01',
      endDate: '2026-09-02',
      zone: 'UTC',
    });
    await createThread(env.db, a, { spaceId: shared.id, title: 'trip planning' });

    // A sees its own private task, the shared rows, and never B's private note
    // or B's private event.
    const seenByA = await searchResources(env.db, a, { query: 'trip' });
    const aTitles = seenByA.map((r) => `${r.resource_type}:${r.title}`);
    expect(aTitles).toContain('task:plan trip');
    expect(aTitles).toContain('note:shared notes');
    expect(aTitles).toContain('thread:trip planning');
    expect(aTitles).toContain('task:secret a task');
    expect(aTitles).not.toContain('note:secret b note');
    expect(aTitles).not.toContain('event:private b trip');

    // B sees the shared rows and its own private note/event, but never A's
    // private task.
    const seenByB = await searchResources(env.db, b, { query: 'trip' });
    const bTitles = seenByB.map((r) => `${r.resource_type}:${r.title}`);
    expect(bTitles).toContain('task:plan trip');
    expect(bTitles).toContain('note:shared notes');
    expect(bTitles).toContain('thread:trip planning');
    expect(bTitles).not.toContain('task:secret a task');
    expect(bTitles).toContain('note:secret b note');
    expect(bTitles).toContain('event:private b trip');
  });

  it('a space A is not a member of answers an empty list, never an error', async () => {
    const a = env.a.userId;
    const b = env.b.userId;
    const bSpace = await ensurePrivateSpace(env.db, b);
    await createTask(env.db, b, bSpace.id, { title: 'for b eyes', body: 'trip data' });

    // A queries a space it cannot access (B's private space) and a space that
    // does not exist at all: both are empty lists, indistinguishable.
    const inaccessible = await searchResources(env.db, a, { query: 'trip', spaceId: bSpace.id });
    expect(inaccessible).toEqual([]);
    const nonexistent = await searchResources(env.db, a, {
      query: 'trip',
      spaceId: randomUUID(),
    });
    expect(nonexistent).toEqual([]);
  });

  it('removing A from the shared space makes its rows absent on the next search', async () => {
    const a = env.a.userId;
    const b = env.b.userId;
    const space = await createSpace(env.db, a, { kind: 'group', name: 'Revoke search' });
    await addMember(env.db, a, space.id, b, 'member');
    await createTask(env.db, a, space.id, { title: 'shared trip', body: 'trip plan' });

    // B sees the shared task while a member.
    expect((await searchResources(env.db, b, { query: 'trip' })).map((r) => r.title)).toContain(
      'shared trip',
    );

    // A revokes B; the same search now simply does not return the row -- absent,
    // not redacted, and no count of what was hidden.
    await revokeMember(env.db, a, space.id, b);
    const after = await searchResources(env.db, b, { query: 'trip' });
    expect(after.map((r) => r.title)).not.toContain('shared trip');
    expect(after.every((r) => r.space_id !== space.id)).toBe(true);
  });
});