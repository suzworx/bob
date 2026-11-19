import { afterEach, expect, it, vi } from 'vitest';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import { NOTIFICATION_TYPES } from '../../src/notifications/store.ts';
import { deliverThrough, NOTIFICATION_COVERAGE, type NotifyChannel } from '../../src/notifications/notify.ts';
import { sendTemplateEmail } from '../../src/notifications/email-client.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, fn: () => unknown) => fn()), recordObservationMetrics: vi.fn(),
}));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('covers every notification producer type', () => {
  expect(Object.keys(NOTIFICATION_COVERAGE).sort()).toEqual([...NOTIFICATION_TYPES].sort());
});

const CHANNELS = ['inbox', 'email', 'push', 'device', 'sms'] as const satisfies readonly NotifyChannel['id'][];
it.each(NOTIFICATION_TYPES)('observes all channels for %s without recipient/resource identifiers', async (type) => {
  const channels: NotifyChannel[] = CHANNELS.map((id) => ({ id, send: vi.fn(async () => ({ status: 'delivered' as const, enqueued: 1, muted: 0 })) }));
  await deliverThrough(channels, { type, threadId: 'private-thread', rows: [{ type, recipientUserId: 'private-user', resourceType: 'private-resource', resourceId: 'private-id', effectKey: 'private-key' }] });
  expect(traceSpan).toHaveBeenCalledTimes(CHANNELS.length);
  expect(vi.mocked(traceSpan).mock.calls.map((call) => call[1].metadata?.target)).toEqual(CHANNELS);
  // The recipient is the correlation key (`userId`); no id may appear anywhere else.
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls, (key, value: unknown) => (key === 'userId' ? undefined : value))).not.toContain('private-');
  expect(vi.mocked(traceSpan).mock.calls.map((call) => call[1].userId)).toEqual(CHANNELS.map(() => 'private-user'));
});

it('records handled channel failure and still runs the secondary channel', async () => {
  const second = vi.fn(async () => ({ status: 'none' as const }));
  await deliverThrough([{ id: 'inbox', send: async () => ({ status: 'failed', reason: 'preferences_unreadable' }) }, { id: 'push', send: second }],
    { type: 'mention', threadId: null, rows: [{ type: 'mention', recipientUserId: 'u', resourceType: 'thread', resourceId: 't', effectKey: 'k' }] });
  expect(second).toHaveBeenCalledTimes(1);
  expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([{ name: 'workflow.failed', value: 1 }]));
});

it('measures email network duration and excludes template data/credentials', async () => {
  vi.stubEnv('BOB_NOTIFY_EMAIL_URL', 'https://private.invalid');
  vi.stubEnv('BOB_NOTIFY_EMAIL_SECRET', 'private-secret');
  const fetch = vi.fn(async () => new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await sendTemplateEmail({ template: 'task-assigned', to: 'private-address', data: { title: 'private-title' } });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(traceSpan).toHaveBeenCalledTimes(1);
  expect(traceSpan).toHaveBeenCalledWith('email-send', expect.any(Object), expect.any(Function));
  expect(JSON.stringify(vi.mocked(traceSpan).mock.calls)).not.toContain('private-');
});
