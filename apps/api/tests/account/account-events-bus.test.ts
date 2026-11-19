import { describe, expect, it, vi } from 'vitest';
import { AccountEvents, AccountEventSchema, type AccountEvent } from '../../src/account/events-bus.ts';

const CONV_ID = 'conv_9f2b2e7c1a4d3e9a5b0c1d2e3f4a5b6c7d';
const MSG_ID = 'msg_0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const DEVICE_ID = '0c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const NOW = 1_756_100_000_000;

const events = {
  messageAppended: (): AccountEvent => ({ type: 'message.appended', conversation_id: CONV_ID, message_id: MSG_ID, updated_at: NOW }),
  conversationUpdated: (): AccountEvent => ({ type: 'conversation.updated', conversation_id: CONV_ID, updated_at: NOW }),
  conversationDeleted: (): AccountEvent => ({ type: 'conversation.deleted', conversation_id: CONV_ID, updated_at: NOW }),
  activeChanged: (): AccountEvent => ({ type: 'active.changed', conversation_id: CONV_ID, title: 'Bob', surface: 'web_text', changed_at: NOW }),
  deviceChanged: (): AccountEvent => ({ type: 'device.changed', device_id: DEVICE_ID }),
};

describe('account event bus', () => {
  it('isolates events per account', () => {
    const bus = new AccountEvents();
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    bus.subscribe('user-a', listenerA);
    bus.subscribe('user-b', listenerB);

    bus.publish('user-a', events.messageAppended());
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();

    bus.publish('user-b', events.deviceChanged());
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new AccountEvents();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe('user-a', listener);
    unsubscribe();
    bus.publish('user-a', events.messageAppended());
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing listener does not break other listeners or the publisher', () => {
    const bus = new AccountEvents();
    const boom = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const ok = vi.fn();
    bus.subscribe('user-a', boom);
    bus.subscribe('user-a', ok);

    expect(() => bus.publish('user-a', events.messageAppended())).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('delivers to all listeners in publish order', () => {
    const bus = new AccountEvents();
    const seen: string[] = [];
    bus.subscribe('user-a', (event) => seen.push(event.type));
    bus.subscribe('user-a', (event) => seen.push(event.type));

    bus.publish('user-a', events.conversationUpdated());
    bus.publish('user-a', events.messageAppended());
    bus.publish('user-a', events.activeChanged());

    expect(seen).toEqual([
      'conversation.updated', 'conversation.updated',
      'message.appended', 'message.appended',
      'active.changed', 'active.changed',
    ]);
  });

  it('validates the active.changed null form: both null or both set', () => {
    const cleared: AccountEvent = { type: 'active.changed', conversation_id: null, title: null, surface: 'activate', changed_at: NOW };
    expect(AccountEventSchema.safeParse(cleared).success).toBe(true);
    expect(AccountEventSchema.safeParse({ ...events.activeChanged(), title: null }).success).toBe(false);
    expect(AccountEventSchema.safeParse({ ...events.activeChanged(), conversation_id: null }).success).toBe(false);
  });

  it('validates active_space.changed: uuid id, 1..60 name, both null or both set, web|device surface', () => {
    const set = { type: 'active_space.changed', space_id: DEVICE_ID, name: 'Kitchen', surface: 'device', changed_at: NOW };
    expect(AccountEventSchema.safeParse(set).success).toBe(true);
    expect(AccountEventSchema.safeParse({ ...set, space_id: null, name: null, surface: 'web' }).success).toBe(true);
    expect(AccountEventSchema.safeParse({ ...set, name: null }).success).toBe(false);
    expect(AccountEventSchema.safeParse({ ...set, space_id: null }).success).toBe(false);
    expect(AccountEventSchema.safeParse({ ...set, space_id: CONV_ID }).success).toBe(false);
    expect(AccountEventSchema.safeParse({ ...set, name: 'x'.repeat(61) }).success).toBe(false);
    expect(AccountEventSchema.safeParse({ ...set, surface: 'picker' }).success).toBe(false);
    expect(AccountEventSchema.safeParse({ ...set, title: 'Kitchen' }).success).toBe(false);
  });

  it('rejects malformed events on publish', () => {
    const bus = new AccountEvents();
    const listener = vi.fn();
    bus.subscribe('user-a', listener);
    // Runtime-invalid events: the schema is the boundary, so cast through
    // unknown to bypass compile-time narrowing of the event union.
    const malformed = (event: unknown): AccountEvent => event as AccountEvent;

    expect(() => bus.publish('user-a', malformed({ type: 'message.appended' }))).toThrow();
    expect(() => bus.publish('user-a', malformed({ ...events.messageAppended(), updated_at: -1 }))).toThrow();
    expect(() => bus.publish('user-a', malformed({ ...events.activeChanged(), surface: 'bogus' }))).toThrow();
    expect(() => bus.publish('user-a', malformed({ ...events.messageAppended(), extra: true }))).toThrow();
    expect(() => bus.publish('user-a', malformed({ ...events.deviceChanged(), device_id: 'not-a-uuid' }))).toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it('thread.message_appended carries ids only and is publishable', () => {
    const event: AccountEvent = {
      type: 'thread.message_appended',
      thread_id: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
      space_id: '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e',
      message_id: '3c4d5e6f-7a8b-4c3d-ae4f-5a6b7c8d9e0f',
      sequence: 7,
    };
    const bus = new AccountEvents();
    const listener = vi.fn();
    bus.subscribe('user-a', listener);
    bus.publish('user-a', event);
    expect(listener).toHaveBeenCalledWith(event);

    const parse = (value: unknown): boolean => AccountEventSchema.safeParse(value).success;
    expect(parse({ ...event, body: 'hello' })).toBe(false);
    expect(parse({ ...event, title: 'Groceries' })).toBe(false);
    expect(parse({ ...event, thread_id: 'not-a-uuid' })).toBe(false);
    expect(parse({ ...event, sequence: 0 })).toBe(false);
    expect(parse({ ...event, sequence: 1.5 })).toBe(false);
    const { message_id: _omitted, ...missing } = event;
    expect(parse(missing)).toBe(false);
  });

  it('space.access_changed carries only a space UUID and reaches only the affected account', () => {
    const event = { type: 'space.access_changed', space_id: DEVICE_ID } as const;
    expect(AccountEventSchema.safeParse(event).success).toBe(true);
    for (const invalid of [
      { type: event.type },
      { ...event, space_id: null },
      { ...event, space_id: CONV_ID },
      { ...event, name: 'Kitchen' },
      { ...event, text: 'Access changed' },
      { ...event, changed_at: NOW },
    ]) {
      expect(AccountEventSchema.safeParse(invalid).success).toBe(false);
    }
    const bus = new AccountEvents();
    const affected = vi.fn();
    const other = vi.fn();
    bus.subscribe('affected', affected);
    bus.subscribe('other', other);
    bus.publish('affected', event);
    expect(affected).toHaveBeenCalledExactlyOnceWith(event);
    expect(other).not.toHaveBeenCalled();
  });

  it('publishing to an account with no listeners is a no-op', () => {
    const bus = new AccountEvents();
    expect(() => bus.publish('ghost', events.messageAppended())).not.toThrow();
  });
});
