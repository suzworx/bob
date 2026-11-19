import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { useInvitation } from '@/features/spaces/use-invitation';

vi.mock('@/lib/auth/use-session',() => ({ fetchWithAuth: vi.fn() }));

const mockFetch = vi.mocked(fetchWithAuth);

const PREVIEW = {
  space_name: 'Family',
  space_kind: 'family',
  inviter_display_name: 'Sam',
  exposes_history: false,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  mockFetch.mockReset();
});

describe('useInvitation preview', () => {
  it.each([500, 503])(
    '#857 reports network_error when the preview answers %i',
    async (status) => {
      mockFetch.mockResolvedValueOnce(jsonResponse(status, { error: { code: 'store_error' } }));

      const { result } = renderHook(() => useInvitation('tok'));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.preview).toBeNull();
      expect(result.current.error?.kind).toBe('network_error');
    },
  );

  it.each([500, 503])(
    '#857 retry refetches after a %i and recovers into a valid preview',
    async (status) => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(status, { error: { code: 'store_error' } }))
        .mockResolvedValueOnce(jsonResponse(200, { preview: PREVIEW }));

      const { result } = renderHook(() => useInvitation('tok'));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error?.kind).toBe('network_error');

      act(() => result.current.retry());

      await waitFor(() => expect(result.current.preview).toEqual(PREVIEW));
      expect(result.current.error).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([{}, { preview: null }])(
    '#857 reports a retryable network_error for a malformed 200 preview %j',
    async (body) => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, body));

      const { result } = renderHook(() => useInvitation('tok'));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.preview).toBeNull();
      expect(result.current.error?.kind).toBe('network_error');
    },
  );

  it('keeps a 404 preview as not_usable', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, {}));

    const { result } = renderHook(() => useInvitation('tok'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.preview).toBeNull();
    expect(result.current.error?.kind).toBe('not_usable');
  });

  it('keeps a 401 preview as sign_in_required', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(401, {}));

    const { result } = renderHook(() => useInvitation('tok'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.preview).toBeNull();
    expect(result.current.error?.kind).toBe('sign_in_required');
  });
});
