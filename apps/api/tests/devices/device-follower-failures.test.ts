// #937: a failed follower read (MD-NOTIFY) is contained -- the next queued
// delivery still runs -- and journaled as one bounded event with no raw error,
// ids, titles or SQL. Real DeviceSessions, no database: getDb is injected.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { DeviceSessions } from '../../src/voice/device-sessions.ts';

const SECRET = 'select secret_title from bob.private where url = https://leak.example/x';
const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE_A = '22222222-2222-4222-8222-222222222222';
const DEVICE_B = '33333333-3333-4333-8333-333333333333';
const SPACE = '44444444-4444-4444-8444-444444444444';
const FAILED = 'v2.device_follower_read_failed';

/** A Db answering the two follower reads: the account stamp matches `stampMs`, and device B has no own pointer. */
function followerDb(stampMs: number): Db {
  const db: Db = {
    query: async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('bob.user_state')) return [{ changedAt: stampMs }] as T[];
      if (sql.includes('bob.devices')) return [{ id: DEVICE_B }] as T[];
      return [];
    },
    tx: (fn) => fn(db),
  };
  return db;
}

const KINDS: Array<{ name: string; type: string; event: (changedAt: number) => AccountEvent }> = [
  {
    name: 'conversation', type: 'active_conversation',
    event: (changedAt) => ({ type: 'active.changed', conversation_id: 'c1', title: 'Private title', surface: 'web_text', changed_at: changedAt, device_id: DEVICE_A }),
  },
  {
    name: 'space', type: 'active_space',
    event: (changedAt) => ({ type: 'active_space.changed', space_id: SPACE, name: 'Private space', surface: 'web', changed_at: changedAt, device_id: DEVICE_A }),
  },
];

describe('follower read failures', () => {
  const lines: string[] = [];
  const listeners: Array<(event: AccountEvent) => void> = [];
  const sessionA = { id: 'sess-a', stage: 'ready' as const };
  const sessionB = { id: 'sess-b', stage: 'ready' as const };
  let registry: DeviceSessions;

  beforeEach(() => {
    lines.length = 0;
    listeners.length = 0;
    setJournalSink((line) => { lines.push(line); });
    registry = new DeviceSessions({ subscribe: (_userId, fn) => { listeners.push(fn); return () => undefined; } }, { now: () => 1_000 });
  });

  afterEach(() => {
    // clear() drops the sessions and their pending offline timers; unregister would schedule more.
    registry.clear();
    setJournalSink(null);
  });

  it.each(KINDS)('$name: journals one bounded event, resolves the flush and still delivers the next push', async ({ type, event }) => {
    const working = followerDb(6);
    let reads = 0;
    registry.rememberDb(async () => {
      reads += 1;
      if (reads === 1) throw new Error(SECRET);
      return working;
    });
    const sendA = vi.fn();
    const sendB = vi.fn();
    registry.register({ readyState: 1, send: sendA, close: vi.fn() } as unknown as WebSocket, sessionA, USER, DEVICE_A);
    registry.register({ readyState: 1, send: sendB, close: vi.fn() } as unknown as WebSocket, sessionB, USER, DEVICE_B);
    const emit = (changedAt: number): void => { for (const fn of listeners) fn(event(changedAt)); };
    const typesSentToB = (): string[] => sendB.mock.calls.map((call) => (JSON.parse(String(call[0])) as { type: string }).type);

    emit(5);
    await registry.flushDeliveries();
    const failed = lines.filter((line) => line.includes(FAILED));
    expect(failed).toHaveLength(1);
    for (const leak of [SECRET, 'secret_title', 'leak.example', 'Private title', 'Private space', USER, DEVICE_A, DEVICE_B]) {
      expect(failed[0]).not.toContain(leak);
    }
    expect(typesSentToB()).toEqual([]);

    emit(6);
    await registry.flushDeliveries();
    expect(reads).toBe(2);
    expect(typesSentToB()).toEqual([type]);
    expect(lines.filter((line) => line.includes(FAILED))).toHaveLength(1);
  });
});
