import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useAppConversation } from './use-app-conversation';
import { openAppConversation } from './bob-apps-api';
import { fetchWithAuth } from '@/lib/auth/use-session';
const callbacks = vi.hoisted(() => ({ open: vi.fn(), refresh: vi.fn() }));
vi.mock('./bob-apps-api', () => ({ openAppConversation: vi.fn() }));
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/features/spaces/use-threads', () => ({ useThreads: () => ({ threads: [], openThread: callbacks.open, refresh: callbacks.refresh }) }));
const id = '00000000-0000-4000-8000-000000000001';
const spaceId = '00000000-0000-4000-8000-000000000002';
beforeEach(() => { vi.clearAllMocks(); });
it('opens the canonical app thread even when it is outside the latest thread list', async () => {
  vi.mocked(openAppConversation).mockResolvedValue({ conversationId: id, spaceId });
  vi.mocked(fetchWithAuth).mockResolvedValue(Response.json({ id, space_id: spaceId, title: 'Team app', created_by: id, archived_at: null, last_sequence: 0, unread_count: 0, created_at: 1, updated_at: 1 }));
  const { result } = renderHook(() => useAppConversation(id, spaceId));
  await waitFor(() => expect(result.current.thread?.id).toBe(id));
  expect(callbacks.open).toHaveBeenCalledWith(id);
  expect(fetchWithAuth).toHaveBeenCalledWith(`/api/threads/${id}`);
});
it('refuses a conversation factory response in a different audience before opening any thread', async () => {
  vi.mocked(openAppConversation).mockResolvedValue({ conversationId: id, spaceId: id });
  const { result } = renderHook(() => useAppConversation(id, spaceId));
  await waitFor(() => expect(result.current.error).toBe(true));
  expect(callbacks.open).not.toHaveBeenCalled();
  expect(fetchWithAuth).not.toHaveBeenCalled();
});
