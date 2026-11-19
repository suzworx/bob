/**
 * NotifyChannel (ADR 0002, #663): the inbox channel is the mute check plus the
 * enqueue, and deliver() fans out to whatever channels it is given.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInboxChannel, deliverThrough, type NotifyChannel, type OutboundNotification } from '../../src/notifications/notify.ts';
import type { Db } from '../../src/platform/db/db.ts';

const row = { recipientUserId: 'u2', spaceId: null, type: 'mention' as const, resourceType: 'thread', resourceId: 't', revision: 1, effectKey: 'k' };
const outbound: OutboundNotification = { type: 'mention', rows: [row], threadId: null };
const channel = (id: NotifyChannel['id'], send: NotifyChannel['send']): NotifyChannel => ({ id, send });

describe('deliverThrough', () => {
  it('returns none for an empty batch without calling a channel', async () => {
    const send = vi.fn();
    expect(await deliverThrough([channel('inbox', send)], { ...outbound, rows: [] })).toEqual({ status: 'none' });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns the first channel outcome and still sends to the rest', async () => {
    const second = vi.fn(() => Promise.resolve({ status: 'none' as const }));
    const out = await deliverThrough([channel('inbox', () => Promise.resolve({ status: 'delivered', enqueued: 1, muted: 0 })), channel('email', second)], outbound);
    expect(out).toEqual({ status: 'delivered', enqueued: 1, muted: 0 });
    expect(second).toHaveBeenCalledOnce();
  });

  it('never throws when a channel does: a secondary failure is swallowed, a primary one is a failed outcome', async () => {
    const boom = (): Promise<never> => Promise.reject(new Error('boom'));
    expect(await deliverThrough([channel('inbox', () => Promise.resolve({ status: 'none' })), channel('sms', boom)], outbound)).toEqual({ status: 'none' });
    expect(await deliverThrough([channel('inbox', boom)], outbound)).toEqual({ status: 'failed', reason: 'enqueue_failed' });
  });
});

describe('createInboxChannel', () => {
  it('reports preferences_unreadable when preferences cannot be read', async () => {
    const out = await createInboxChannel({} as Db).send(outbound);
    expect(out).toEqual({ status: 'failed', reason: 'preferences_unreadable' });
  });
});
