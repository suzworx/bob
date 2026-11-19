import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeAuthOperations } from './auth-observability';

const mocks = vi.hoisted(() => ({ report: vi.fn(), current: vi.fn() }));
vi.mock('@/lib/observability/ui-auth-events', () => ({ reportUiAuth: mocks.report }));
vi.mock('@/lib/observability/ui-actions', () => ({ currentUiAction: mocks.current }));

beforeEach(() => {
  mocks.report.mockReset();
  mocks.current.mockReturnValue({ action_id: '11111111-1111-4111-8111-111111111111' });
});

describe('auth operation diagnostics', () => {
  it('preserves receiver, arguments and exact promise identity without capturing provider payloads', async () => {
    const result = { data: { token: 'private-provider-result' }, error: null };
    const promise = Promise.resolve(result);
    const original = vi.fn(function (this: unknown, _credentials: unknown) { expect(this).toBe(auth); return promise; });
    const auth = { signInWithPassword: original };
    observeAuthOperations(auth);
    const credentials = { password: 'private-password', email: 'private@example.test' };
    expect(auth.signInWithPassword(credentials)).toBe(promise);
    expect(await promise).toBe(result);
    expect(original).toHaveBeenCalledWith(credentials);
    expect(mocks.report).toHaveBeenCalledWith({ operation: 'signInWithPassword', outcome: 'ok', duration_ms: expect.any(Number), action_id: '11111111-1111-4111-8111-111111111111' });
    expect(JSON.stringify(mocks.report.mock.calls)).not.toMatch(/private|password|email|token/);
  });

  it.each(['signInWithOtp', 'verifyOtp', 'signInWithPassword', 'resetPasswordForEmail', 'updateUser', 'signOut', 'refreshSession'])('records returned errors from %s as failures', async (operation) => {
    const result = { error: { message: 'private-provider-error' } };
    const auth = { [operation]: () => Promise.resolve(result) };
    observeAuthOperations(auth);
    expect(await auth[operation]?.()).toBe(result);
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ operation, outcome: 'error' }));
    expect(JSON.stringify(mocks.report.mock.calls)).not.toContain('private');
  });

  it.each([new Error('private-rejection'), new DOMException('private-abort', 'AbortError')])('preserves rejection and records only its outcome', async (error) => {
    const promise = Promise.reject(error);
    const auth = { signOut: () => promise };
    observeAuthOperations(auth);
    expect(auth.signOut()).toBe(promise);
    await expect(promise).rejects.toBe(error);
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: error.name === 'AbortError' ? 'aborted' : 'error' }));
  });

  it('preserves sync return/throw, skips absent methods and installs only once', () => {
    const result = { error: null };
    const auth = { signOut: () => result };
    observeAuthOperations(auth);
    const installed = auth.signOut;
    observeAuthOperations(auth);
    expect(auth.signOut).toBe(installed);
    expect(auth.signOut()).toBe(result);
    expect(mocks.report).toHaveBeenCalledTimes(1);
    const failure = new Error('private-sync');
    const throwing = { updateUser: () => { throw failure; } };
    observeAuthOperations(throwing);
    expect(throwing.updateUser).toThrow(failure);
    expect(mocks.report).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'error' }));
    expect(() => observeAuthOperations(Object.freeze({}))).not.toThrow();
  });

  it('contains observer failures and captures causality before async auth changes', async () => {
    const promise = Promise.resolve({ error: null });
    const auth = { signOut: () => promise };
    observeAuthOperations(auth);
    mocks.report.mockImplementation(() => { throw new Error('observer'); });
    expect(auth.signOut()).toBe(promise);
    mocks.current.mockReturnValue(null);
    await promise;
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ action_id: '11111111-1111-4111-8111-111111111111' }));
  });
});
