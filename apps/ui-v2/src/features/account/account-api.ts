// Typed client for DELETE /api/account. Same style as devices-api.ts: the
// call goes through fetchWithAuth, so a 401 refreshes the session once.

import { fetchWithAuth } from '@/lib/auth/use-session';

type DeleteAccountResult = { kind: 'deleted' } | { kind: 'owns_groups'; count: number } | { kind: 'failed' };

/** Rejects only on a network failure. */
export async function deleteAccount(): Promise<DeleteAccountResult> {
  const response = await fetchWithAuth('/api/account', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  if (response.status === 204) return { kind: 'deleted' };
  if (response.status === 409) {
    try {
      const body = (await response.json()) as { error?: { code?: string; count?: unknown } };
      if (body.error?.code === 'owns_groups' && typeof body.error.count === 'number') {
        return { kind: 'owns_groups', count: body.error.count };
      }
    } catch {
      // fall through to failed
    }
  }
  return { kind: 'failed' };
}
