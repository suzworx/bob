import { trace, type Span } from '@opentelemetry/api';
import { afterEach, expect, it, vi } from 'vitest';
import { recordObservationMetrics, traceSpan } from '@bob/ai';
import { AccountEvents, AccountEventSchema, ACCOUNT_EVENT_COVERAGE, type AccountEvent } from '../../src/account/events-bus.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, fn: () => unknown) => fn()), recordObservationMetrics: vi.fn(),
}));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

it('covers every account event schema variant', () => {
  expect(Object.keys(ACCOUNT_EVENT_COVERAGE).sort()).toEqual(AccountEventSchema.options.map((schema) => schema.shape.type.value).sort());
});

it('keeps synchronous delivery ordered, observes caught errors, and omits event content', () => {
  const bus = new AccountEvents();
  const delivered: string[] = [];
  bus.subscribe('user', () => { throw new Error('private-error'); });
  bus.subscribe('user', (event) => delivered.push(event.type));
  const event: AccountEvent = { type: 'active.changed', conversation_id: 'private-conversation', title: 'private-title', surface: 'device', changed_at: 1 };
  bus.publish('user', event);
  expect(delivered).toEqual(['active.changed']);
  expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([{ name: 'workflow.failed', value: 1 }]));
  expect(JSON.stringify([vi.mocked(traceSpan).mock.calls, vi.mocked(recordObservationMetrics).mock.calls])).not.toContain('private-');
});

it('records an account event as a span event on the active span, never as its own span', () => {
  const addEvent = vi.fn();
  const spy = vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ addEvent } as unknown as Span);
  new AccountEvents().publish('user', { type: 'device.changed', device_id: crypto.randomUUID() });
  expect(addEvent).toHaveBeenCalledWith('account-event', { 'bob.account_event': 'device.changed' });
  expect(traceSpan).not.toHaveBeenCalled();
  spy.mockRestore();
});

it('publishes without an active span', () => {
  vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
  expect(() => new AccountEvents().publish('user', { type: 'device.changed', device_id: crypto.randomUUID() })).not.toThrow();
});
