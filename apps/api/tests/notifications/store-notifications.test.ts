// store/notifications.ts tests (spec 014, S14-INBOX-STORE). A real Postgres
// database, same setup as store-tasks.test.ts. Exercises the inbox against real
// RLS: enqueue idempotency per (recipient, effect_key), newest-first cursor
// pagination without gaps or repeats, markRead by id and by cursor with the
// unread count following, isMuted precedence (thread > space > type > global),
// the all-or-nothing quiet-hours rule, and the one email.notification outbox
// row each new notification gets.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import {
  EMAIL_NOTIFICATION_EVENT,
  deletePreference,
  emailEffectKey,
  enqueueNotifications,
  getPreferences,
  isMuted,
  listNotifications,
  markRead,
  parseEmailEffectKey,
  type NewNotification,
  type NotificationType,
  type StoredPreference,
  unreadCount,
  upsertPreference,
} from '../../src/notifications/store.ts';
import { claimOutboxBatch, pendingOutboxCount } from '../../src/platform/outbox/store.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

/** A NewNotification with a fresh resource id (each effect key is unique per
 *  recipient, so the tests never collide across accounts). */
function notif(
  recipientUserId: string,
  effectKey: string,
  type: NotificationType = 'mention',
  extra: Partial<NewNotification> = {},
): NewNotification {
  return {
    recipientUserId,
    type,
    resourceType: 'thread',
    resourceId: randomUUID(),
    effectKey,
    ...extra,
  };
}

/** A StoredPreference with a null key (global) unless the test overrides it. */
function pref(fields: Partial<StoredPreference> & Pick<StoredPreference, 'muted'>): StoredPreference {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    spaceId: null,
    threadId: null,
    type: null,
    quietHoursStart: null,
    quietHoursEnd: null,
    quietZone: null,
    ...fields,
  };
}

describe('notifications store', () => {
  it('enqueue is idempotent per (recipient, effect_key); other recipients get their own row', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    await enqueueNotifications(db, [notif(a.userId, 'k-shared')]);
    // Same (recipient, effect_key) replayed -- the outbox worker retried.
    await enqueueNotifications(db, [notif(a.userId, 'k-shared')]);
    // The same effect_key for a DIFFERENT recipient is a different row.
    await enqueueNotifications(db, [notif(b.userId, 'k-shared')]);

    const seenByA = await listNotifications(db, a.userId, { limit: 10 });
    const seenByB = await listNotifications(db, b.userId, { limit: 10 });
    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(1);
    expect(seenByA[0]!.effectKey).toBe('k-shared');
    expect(seenByB[0]!.effectKey).toBe('k-shared');
    expect(seenByA[0]!.id).not.toBe(seenByB[0]!.id);
    expect(seenByA[0]!.cursor).not.toBe(seenByB[0]!.cursor);
  });

  it('each notification writes one email and one push outbox row; a duplicate writes none', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    // bob.outbox is FORCE RLS with no policies and this connection is the
    // nobypassrls bob_server role, so it is read only through the definers.
    const pending = (): Promise<number> => pendingOutboxCount(db);
    const before = await pending();

    const first = notif(a.userId, 'k-mail');
    await enqueueNotifications(db, [first]);
    expect(await pending()).toBe(before + 2);
    const claimed = (await claimOutboxBatch(db, { owner: 'test', limit: 1000, leaseMs: 60_000, now: Date.now() + 60_000 }))
      .filter((r) => r.effectKey.endsWith(':k-mail'));
    expect(claimed.map((r) => ({ eventType: r.eventType, resourceType: r.resourceType,
      resourceId: r.resourceId, effectKey: r.effectKey, payload: r.payload }))).toEqual([{
      eventType: EMAIL_NOTIFICATION_EVENT,
      resourceType: 'notification',
      resourceId: first.resourceId,
      effectKey: emailEffectKey(a.userId, 'k-mail'),
      payload: { resource_type: 'notification', recipient_user_id: a.userId,
        event_type: EMAIL_NOTIFICATION_EVENT },
    }]);

    // The replayed notification is a no-op, and so is its mail.
    await enqueueNotifications(db, [first]);
    expect(await pending()).toBe(before + 2);
    expect(await listNotifications(db, a.userId, { limit: 10 })).toHaveLength(1);

    // Another recipient of the same effect is mailed separately.
    await enqueueNotifications(db, [notif(b.userId, 'k-mail')]);
    expect(await pending()).toBe(before + 4);
    expect(parseEmailEffectKey(emailEffectKey(b.userId, 'k-mail')))
      .toEqual({ recipientUserId: b.userId, effectKey: 'k-mail' });
    expect(parseEmailEffectKey('assignment:task:x:1')).toBeNull();
  });

  it('listing is newest first and the cursor pages without gaps or repeats', async () => {
    const a = await addAccount(pg);
    for (let i = 0; i < 5; i += 1) {
      await enqueueNotifications(db, [notif(a.userId, `k-${i}`)]);
    }

    const page1 = await listNotifications(db, a.userId, { limit: 2 });
    expect(page1).toHaveLength(2);
    const page2 = await listNotifications(db, a.userId, { limit: 2, afterCursor: page1[1]!.cursor });
    expect(page2).toHaveLength(2);
    const page3 = await listNotifications(db, a.userId, { limit: 2, afterCursor: page2[1]!.cursor });
    expect(page3).toHaveLength(1);

    // Every page is newest-first internally.
    for (const page of [page1, page2, page3]) {
      for (let i = 1; i < page.length; i += 1) {
        expect(page[i - 1]!.cursor).toBeGreaterThan(page[i]!.cursor);
      }
    }
    // All five rows, each exactly once, in insertion order.
    const all = [...page1, ...page2, ...page3];
    expect(all).toHaveLength(5);
    expect(new Set(all.map((n) => n.cursor)).size).toBe(5);
    expect(all.map((n) => n.effectKey).sort()).toEqual(['k-0', 'k-1', 'k-2', 'k-3', 'k-4']);
    // The pages' union equals a single unfiltered read (no gaps or repeats).
    const allAtOnce = await listNotifications(db, a.userId, { limit: 10 });
    expect(all.map((n) => n.id).sort()).toEqual(allAtOnce.map((n) => n.id).sort());
  });

  it('markRead by id and by cursor moves only unread rows; unread count follows', async () => {
    const a = await addAccount(pg);
    for (let i = 0; i < 4; i += 1) {
      await enqueueNotifications(db, [notif(a.userId, `k-${i}`)]);
    }
    expect(await unreadCount(db, a.userId)).toBe(4);

    const all = await listNotifications(db, a.userId, { limit: 10 });
    const [newest, second, , oldest] = all;

    // By id: moves exactly the newest row.
    expect(await markRead(db, a.userId, { ids: [newest!.id] })).toBe(1);
    expect(await unreadCount(db, a.userId)).toBe(3);
    // Replaying the same mark moves nothing.
    expect(await markRead(db, a.userId, { ids: [newest!.id] })).toBe(0);
    expect(await unreadCount(db, a.userId)).toBe(3);

    // By cursor: everything unread at or below the second-newest cursor.
    expect(await markRead(db, a.userId, { upToCursor: second!.cursor })).toBe(3);
    expect(await unreadCount(db, a.userId)).toBe(0);
    expect(await listNotifications(db, a.userId, { limit: 10, unreadOnly: true })).toHaveLength(0);

    // An already-read id in the set moves nothing; a fresh row is still unread.
    await enqueueNotifications(db, [notif(a.userId, 'k-fresh')]);
    expect(await markRead(db, a.userId, { ids: [oldest!.id, randomUUID()] })).toBe(0);
    expect(await unreadCount(db, a.userId)).toBe(1);
  });

  it('isMuted resolves the most specific preference: thread > space > type > global', () => {
    const space = randomUUID();
    const thread = randomUUID();
    const prefs: StoredPreference[] = [
      pref({ muted: true }), // global
      pref({ type: 'mention', muted: true }), // type
      pref({ spaceId: space, muted: true }), // space
      pref({ spaceId: space, threadId: thread, muted: false }), // thread, unmuted
    ];

    // Thread beats everything, even when global/space/type are muted.
    expect(isMuted(prefs, { spaceId: space, threadId: thread, type: 'mention' })).toBe(false);
    expect(isMuted(prefs, { spaceId: space, threadId: thread, type: 'assignment' })).toBe(false);
    // Space beats type and global.
    expect(isMuted(prefs, { spaceId: space, type: 'mention' })).toBe(true);
    // Type beats global.
    expect(isMuted(prefs, { type: 'mention' })).toBe(true);
    // Global is the fallback.
    expect(isMuted(prefs, { type: 'assignment' })).toBe(true);
    expect(isMuted(prefs, {})).toBe(true);

    // A non-applying preference (wrong space) is ignored.
    expect(
      isMuted([pref({ spaceId: space, muted: true })], { spaceId: randomUUID(), type: 'mention' }),
    ).toBe(false);
    // No preferences at all -> not muted.
    expect(isMuted([], { type: 'mention' })).toBe(false);
    // Within a tier, the preference scoping MORE dimensions wins.
    expect(
      isMuted(
        [
          pref({ spaceId: space, muted: true }),
          pref({ spaceId: space, type: 'mention', muted: false }),
        ],
        { spaceId: space, type: 'mention' },
      ),
    ).toBe(false);
  });

  it('quiet-hours columns are all-or-nothing; upsert updates, delete removes', async () => {
    const a = await addAccount(pg);

    // All three together is accepted and read back as 'HH:MM:SS'.
    const full = await upsertPreference(db, a.userId, {
      quietHoursStart: '22:00:00',
      quietHoursEnd: '07:00:00',
      quietZone: 'Asia/Kolkata',
      muted: true,
    });
    expect(full.quietHoursStart).toBe('22:00:00');
    expect(full.quietHoursEnd).toBe('07:00:00');
    expect(full.quietZone).toBe('Asia/Kolkata');
    expect(full.muted).toBe(true);

    // A partial quiet-hours row is refused (store and DB CHECK agree).
    await expect(upsertPreference(db, a.userId, { quietHoursStart: '22:00:00' })).rejects.toThrow(
      /all-or-nothing/,
    );
    await expect(
      upsertPreference(db, a.userId, { quietHoursStart: '22:00:00', quietHoursEnd: '07:00:00' }),
    ).rejects.toThrow(/all-or-nothing/);

    // Upsert on the same (all-null) key updates instead of duplicating; the
    // quiet hours are replaced in full (undefined clears them).
    await upsertPreference(db, a.userId, { muted: false });
    expect(await getPreferences(db, a.userId)).toHaveLength(1);

    // A scoped key is a distinct row from the global one.
    const scoped = await upsertPreference(db, a.userId, { type: 'mention', muted: true });
    expect(scoped.type).toBe('mention');
    expect(await getPreferences(db, a.userId)).toHaveLength(2);

    // Delete by key removes only the matching row.
    await deletePreference(db, a.userId, {});
    const remaining = await getPreferences(db, a.userId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.type).toBe('mention');
    await deletePreference(db, a.userId, { type: 'mention' });
    expect(await getPreferences(db, a.userId)).toHaveLength(0);
    // Deleting an absent preference is a quiet no-op.
    await deletePreference(db, a.userId, { type: 'reminder' });
    expect(await getPreferences(db, a.userId)).toHaveLength(0);
  });

  it('thread preferences key on conversation_id: re-upsert is idempotent, two threads in one space coexist', async () => {
    const a = await addAccount(pg);
    const space = await createSpace(db, a.userId, { kind: 'group', name: 'Family' });
    const t1 = await createThread(db, a.userId, { spaceId: space.id, title: 'one' });
    const t2 = await createThread(db, a.userId, { spaceId: space.id, title: 'two' });
    const first = await upsertPreference(db, a.userId, { spaceId: space.id, threadId: t1.id, muted: true });
    const again = await upsertPreference(db, a.userId, { spaceId: space.id, threadId: t1.id, muted: false });
    expect([again.id, again.threadId, again.muted]).toEqual([first.id, t1.id, false]);
    await upsertPreference(db, a.userId, { spaceId: space.id, threadId: t2.id, muted: true });
    expect((await getPreferences(db, a.userId)).map((p) => p.threadId).sort()).toEqual([t1.id, t2.id].sort());
    await deletePreference(db, a.userId, { spaceId: space.id, threadId: t1.id });
    expect((await getPreferences(db, a.userId)).map((p) => p.threadId)).toEqual([t2.id]);
  });

  it('preferences are only visible to their owner (RLS)', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    await upsertPreference(db, a.userId, { muted: true });
    expect(await getPreferences(db, a.userId)).toHaveLength(1);
    expect(await getPreferences(db, b.userId)).toHaveLength(0);
  });
});