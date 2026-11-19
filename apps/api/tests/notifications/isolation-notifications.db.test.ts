// test:db suite (S14-INBOX-STORE, issue #127): the durable-inbox acceptance
// criterion proven against real roles. When a member loses access to a space,
// refetching the inbox must show none of its items and leak no title or
// snippet. That is the notifications SELECT policy -- the recipient's own rows
// AND (space_id is null or is_space_member(space_id)) -- so a removed member's
// rows simply do not appear; the inbox carries no title/body/snippet columns
// at all. A security notice (space_id null) survives any space removal. Runs
// against the LOCAL Supabase stack only (`npm run test:db`; db-harness connects
// as bob_server, the role production uses).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  enqueueNotifications,
  listNotifications,
  type NewNotification,
} from '../../src/notifications/store.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

function notif(recipientUserId: string, spaceId: string | null, effectKey: string): NewNotification {
  return {
    recipientUserId,
    spaceId,
    type: 'mention',
    resourceType: 'thread',
    resourceId: randomUUID(),
    effectKey,
  };
}

describe('notifications isolation on the local stack (S14-INBOX-STORE)', () => {
  let env: MemoryTestDb;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('two accounts in a shared space: each sees only its own notifications', async () => {
    const a = env.a.userId;
    const b = env.b.userId;
    const space = await createSpace(env.db, a, { kind: 'group', name: 'Family' });
    await addMember(env.db, a, space.id, b, 'member');
    await enqueueNotifications(env.db, [
      notif(a, space.id, 'k1-a-space'),
      notif(b, space.id, 'k1-b-space'),
      notif(a, null, 'k1-a-sec'),
      notif(b, null, 'k1-b-sec'),
    ]);

    const seenByA = await listNotifications(env.db, a, { limit: 20 });
    const seenByB = await listNotifications(env.db, b, { limit: 20 });
    expect(seenByA.map((n) => n.effectKey).sort()).toEqual(['k1-a-sec', 'k1-a-space']);
    expect(seenByB.map((n) => n.effectKey).sort()).toEqual(['k1-b-sec', 'k1-b-space']);
  });

  it('removing a member hides their space notifications; security notices survive', async () => {
    const a = env.a.userId;
    const b = env.b.userId;
    const space = await createSpace(env.db, a, { kind: 'group', name: 'Revoke me' });
    await addMember(env.db, a, space.id, b, 'member');
    await enqueueNotifications(env.db, [
      notif(b, space.id, 'k2-b-space'),
      notif(b, null, 'k2-b-sec'),
    ]);

    // B sees its own two while a member (B may also hold earlier-run rows from
    // the shared account, so assert membership, not an exact set).
    const before = (await listNotifications(env.db, b, { limit: 20 })).map((n) => n.effectKey);
    expect(before).toContain('k2-b-sec');
    expect(before).toContain('k2-b-space');

    // A revokes B.
    await revokeMember(env.db, a, space.id, b);

    // Refetch as B: the space notification is GONE -- the row simply does not
    // appear, and there is no title/body/resource-name column to leak -- while
    // the security notice (space_id null) survives the removal.
    const after = await listNotifications(env.db, b, { limit: 20 });
    const afterKeys = after.map((n) => n.effectKey);
    expect(afterKeys).not.toContain('k2-b-space');
    expect(afterKeys).toContain('k2-b-sec');
    expect(after.every((n) => n.spaceId !== space.id)).toBe(true);
    for (const n of after) {
      expect(Object.keys(n)).not.toContain('title');
      expect(Object.keys(n)).not.toContain('body');
    }

    // A's own inbox is unaffected by the removal.
    expect((await listNotifications(env.db, a, { limit: 20 })).map((n) => n.effectKey)).toContain(
      'k1-a-space',
    );
  });
});