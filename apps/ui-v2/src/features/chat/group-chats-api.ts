import { fetchWithAuth } from '@/lib/auth/use-session';
import { HttpError } from '@/lib/query-client';

export type GroupChat = {
  id: string; space_id: string; title: string; created_by: string;
  role: 'owner' | 'admin' | 'member'; created_at: number; updated_at: number;
};
export type GroupMember = { user_id: string; display_name: string | null; role: 'owner' | 'admin' | 'member' };
export type GroupInvitation = { title: string; inviter_name: string; expires_at: number };

/** Local invalidation never contains an invitation token or transcript. */
export function refreshGroupChats(): void {
  window.dispatchEvent(new Event('bob:group-chats-changed'));
}

export async function groupRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetchWithAuth(`/api/group-chats${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    throw new HttpError(detail?.error?.code ?? 'group_chat_failed', response.status);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}
