import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiObservabilityBoundary } from './ui-observability-boundary';

const mocks = vi.hoisted(() => ({
  session: { status: 'signed-out', session: null } as { status: string; session: { access_token: string; user: { id: string } } | null },
  install: vi.fn(),
}));
vi.mock('@/lib/auth/use-session', () => ({ useSession: () => mocks.session }));
vi.mock('./ui-observability', () => ({ installUiObservability: mocks.install }));

describe('authenticated UI observability lifetime', () => {
  afterEach(() => { vi.clearAllMocks(); mocks.install.mockReset(); mocks.session = { status: 'signed-out', session: null }; });
  it('still renders the app if instrumentation installation unexpectedly throws', () => {
    mocks.session = { status: 'signed-in', session: { access_token: 'token-a', user: { id: 'a' } } };
    mocks.install.mockImplementationOnce(() => { throw new Error('unsupported browser'); });
    expect(() => render(<UiObservabilityBoundary><span>page</span></UiObservabilityBoundary>)).not.toThrow();
  });
  it('keeps anonymous collection separate, retains token refresh and disposes account queues before ownership changes', () => {
    const anonymous = { render: vi.fn(), dispose: vi.fn(), flush: vi.fn() };
    const first = { render: vi.fn(), dispose: vi.fn(), flush: vi.fn() };
    const second = { render: vi.fn(), dispose: vi.fn(), flush: vi.fn() };
    const signedOut = { render: vi.fn(), dispose: vi.fn(), flush: vi.fn() };
    mocks.install.mockReturnValueOnce(anonymous).mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(signedOut);
    const view = render(<UiObservabilityBoundary><span>page</span></UiObservabilityBoundary>);
    expect(mocks.install).toHaveBeenCalledWith(expect.any(Function), { anonymous: true });
    mocks.session = { status: 'signed-in', session: { access_token: 'token-a', user: { id: 'a' } } };
    act(() => view.rerender(<UiObservabilityBoundary><span>page</span></UiObservabilityBoundary>));
    expect(mocks.install).toHaveBeenCalledTimes(2);
    expect(anonymous.flush).toHaveBeenCalledOnce();
    expect(anonymous.dispose).toHaveBeenCalledOnce();
    const token = mocks.install.mock.calls[1]?.[0] as () => string;
    expect(token()).toBe('token-a');
    mocks.session = { status: 'signed-in', session: { access_token: 'token-refreshed', user: { id: 'a' } } };
    view.rerender(<UiObservabilityBoundary><span>page</span></UiObservabilityBoundary>);
    expect(token()).toBe('token-refreshed');
    expect(mocks.install).toHaveBeenCalledTimes(2);
    mocks.session = { status: 'signed-in', session: { access_token: 'token-b', user: { id: 'b' } } };
    view.rerender(<UiObservabilityBoundary><span>page</span></UiObservabilityBoundary>);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledTimes(3);
    mocks.session = { status: 'signed-out', session: null };
    view.rerender(<UiObservabilityBoundary><span>page</span></UiObservabilityBoundary>);
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenLastCalledWith(expect.any(Function), { anonymous: true });
    view.unmount();
  });
});
