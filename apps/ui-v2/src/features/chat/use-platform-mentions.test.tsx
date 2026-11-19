import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useIntegrationMentions } from './use-platform-mentions';

const mocks = vi.hoisted(() => ({ owner: 'owner-a', list: vi.fn(), tools: vi.fn() }));
vi.mock('@/lib/auth/use-session', () => ({ useSession: () => ({ session: { user: { id: mocks.owner } } }) }));
vi.mock('@/features/integrations/google-accounts-api', () => ({ listGoogleAccounts: mocks.list }));
vi.mock('@/features/tools/tools-api', () => ({ getTools: mocks.tools }));
const accounts = [{ id: 'opaque-id', email: 'mine@example.test', name: null, selected: true, createdAt: 1, access: ['gmail.read'], needsReconnect: false }];
beforeEach(() => { mocks.owner = 'owner-a'; mocks.list.mockReset(); mocks.list.mockResolvedValue(accounts); mocks.tools.mockReset().mockResolvedValue({ tools: [{ toolName: 'google_gmail_search', enabled: true }, { toolName: 'google_gmail_read_thread', enabled: true }, { toolName: 'google_gmail_read_draft', enabled: true }] }); });
afterEach(cleanup);

it('never requests private accounts in a shared context', () => {
  const { result } = renderHook(() => useIntegrationMentions(false));
  expect(result.current).toEqual([]);
  expect(mocks.list).not.toHaveBeenCalled();
});

it('drops private references immediately on leaving private scope', async () => {
  const { result, rerender } = renderHook(({ privateContext }) => useIntegrationMentions(privateContext), { initialProps: { privateContext: true } });
  await waitFor(() => expect(result.current).toHaveLength(4));
  rerender({ privateContext: false });
  expect(result.current).toEqual([]);
});

it('does not retain the previous account references after auth changes or a failed refresh', async () => {
  const { result, rerender } = renderHook(() => useIntegrationMentions(true));
  await waitFor(() => expect(result.current).toHaveLength(4));
  mocks.list.mockRejectedValue(new Error('unavailable'));
  mocks.owner = 'owner-b';
  rerender();
  expect(result.current).toEqual([]);
  await act(async () => {});
  expect(result.current).toEqual([]);
});

it('a failed refresh removes stale private candidates and late responses cannot cross scope', async () => {
  const { result, rerender } = renderHook(({ privateContext }) => useIntegrationMentions(privateContext), { initialProps: { privateContext: true } });
  await waitFor(() => expect(result.current).toHaveLength(4));
  mocks.list.mockRejectedValueOnce(new Error('unavailable'));
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(result.current).toEqual([]));
  let resolve: ((value: typeof accounts) => void) | undefined;
  mocks.list.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  act(() => window.dispatchEvent(new Event('focus')));
  rerender({ privateContext: false });
  await act(async () => resolve?.(accounts));
  expect(result.current).toEqual([]);
});

it('hides disabled actions, retains bare account mentions, and fails closed on policy outage', async () => {
  mocks.tools.mockResolvedValueOnce({ tools: [{ toolName: 'google_gmail_search', enabled: false }, { toolName: 'google_gmail_read_thread', enabled: true }] });
  const { result } = renderHook(() => useIntegrationMentions(true, 'cnv_one'));
  await waitFor(() => expect(result.current).toHaveLength(2));
  expect(result.current.map((item) => item.display_name)).toEqual(['Gmail', 'Gmail.read_thread']);
  expect(mocks.tools).toHaveBeenCalledWith({ integrationId: 'opaque-id', conversationId: 'cnv_one' }, expect.any(AbortSignal));
  mocks.tools.mockRejectedValueOnce(new Error('offline'));
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(result.current.map((item) => item.display_name)).toEqual(['Gmail']));
});
it('drops action candidates immediately when conversation context changes', async () => {
  const { result, rerender } = renderHook(({ id }) => useIntegrationMentions(true, id), { initialProps: { id: 'cnv_one' } });
  await waitFor(() => expect(result.current).toHaveLength(4));
  mocks.tools.mockImplementationOnce(() => new Promise(() => {}));
  rerender({ id: 'cnv_two' });
  expect(result.current).toEqual([]);
});
