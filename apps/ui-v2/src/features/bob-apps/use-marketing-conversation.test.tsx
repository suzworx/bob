import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useMarketingConversation } from './use-marketing-conversation';
import { fetchWithAuth } from '@/lib/auth/use-session';

vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth: vi.fn() }));
beforeEach(() => { sessionStorage.clear(); vi.mocked(fetchWithAuth).mockReset(); });
it('keeps generic app conversation pointers and drafts separate from Marketing and other apps', () => {
  const { result, unmount } = renderHook(() => useMarketingConversation('member', 'app-installation', 'app'));
  expect(result.current.draftKey).toBe('app:member:app-installation:new');
  act(() => result.current.created('conversation-one', []));
  expect(sessionStorage.getItem('bob:app:member:app-installation:conversation')).toBe('conversation-one');
  expect(sessionStorage.getItem('bob:marketing:member:app-installation:conversation')).toBeNull();
  unmount();
  const other = renderHook(() => useMarketingConversation('member', 'another-installation', 'app'));
  expect(other.result.current.id).toBeNull();
  expect(other.result.current.draftKey).toBe('app:member:another-installation:new');
});
it('preserves the default Marketing pointer namespace', () => {
  const { result } = renderHook(() => useMarketingConversation('member', 'marketing-installation'));
  expect(result.current.draftKey).toBe('marketing:member:marketing-installation:new');
});
it('keeps the missing-conversation recovery inside the same generic app scope', async () => {
  sessionStorage.setItem('bob:app:member:app-installation:conversation', 'missing');
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(new Response(null, { status: 404 }));
  const { result } = renderHook(() => useMarketingConversation('member', 'app-installation', 'app'));
  await waitFor(() => expect(result.current.missing).toBe(true));
  expect(result.current.id).toBeNull();
  expect(result.current.draftKey).toBe('app:member:app-installation:new');
  expect(fetchWithAuth).toHaveBeenCalledWith('/api/conversations/missing', expect.any(Object));
});
