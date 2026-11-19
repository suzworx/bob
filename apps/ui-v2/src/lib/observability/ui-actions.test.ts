import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentUiAction, observeUiAction, subscribeUiActions } from './ui-actions';

const ACTION = 'app.app.session-gate.button.back-to-home.click';

describe('semantic action execution', () => {
  afterEach(() => vi.restoreAllMocks());
  it('preserves receiver, callback identity, return value and arguments while emitting only fixed metadata', () => {
    const events: unknown[] = [];
    const stop = subscribeUiActions((event) => events.push(event));
    const receiver = { value: 41 };
    function callback(this: typeof receiver, secret: string): number {
      expect(secret).toBe('private-text');
      expect(currentUiAction()?.action).toBe(ACTION);
      return this.value + 1;
    }
    const wrapped = observeUiAction(ACTION, callback);
    expect(observeUiAction(ACTION, callback)).toBe(wrapped);
    expect(wrapped.call(receiver, 'private-text')).toBe(42);
    expect(events).toMatchObject([{ action: ACTION, stage: 'start' }, { action: ACTION, stage: 'complete', outcome: 'returned' }]);
    expect(JSON.stringify(events)).not.toContain('private-text');
    expect(currentUiAction()).toBeNull();
    stop();
  });

  it('preserves promise and error identity and observes their terminal outcomes', async () => {
    const events: unknown[] = [];
    const stop = subscribeUiActions((event) => events.push(event));
    const promise = Promise.resolve('private-result');
    expect(observeUiAction(ACTION, () => promise)()).toBe(promise);
    await promise;
    const failure = new Error('private-failure');
    expect(() => observeUiAction(ACTION, () => { throw failure; })()).toThrow(failure);
    const rejection = Promise.reject(failure);
    expect(observeUiAction(ACTION, () => rejection)()).toBe(rejection);
    await expect(rejection).rejects.toBe(failure);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'complete', outcome: 'resolved' }),
      expect.objectContaining({ stage: 'complete', outcome: 'error' }),
    ]));
    expect(JSON.stringify(events)).not.toContain('private-');
    stop();
  });

  it('contains observer failures, rejects noncatalog IDs and retains optional callbacks', () => {
    const stop = subscribeUiActions(() => { throw new Error('observer failed'); });
    expect(observeUiAction(ACTION, () => 'result')()).toBe('result');
    const handler = vi.fn();
    expect(observeUiAction('private-runtime-label', handler)).toBe(handler);
    expect(observeUiAction(ACTION, undefined)).toBeUndefined();
    stop();
  });

  it('never delivers late completion from a disposed account to its replacement', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const stop = subscribeUiActions(first);
    let resolve: () => void = () => undefined;
    const pending = new Promise<void>((done) => { resolve = done; });
    observeUiAction(ACTION, () => pending)();
    stop();
    const stopSecond = subscribeUiActions(second);
    resolve();
    await pending;
    expect(second).not.toHaveBeenCalled();
    stopSecond();
  });
});
