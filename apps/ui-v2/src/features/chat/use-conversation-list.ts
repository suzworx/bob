import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/auth/use-session';
import type { ConversationDetail, ConversationSummary, SidebarState } from '@/features/chat/use-conversations';

export type NavConversation = ConversationSummary & { pinned?: boolean; archived?: boolean; shared?: boolean };

/**
 * GET /api/conversations: the whole list, or with a query only the conversations
 * whose title matches it. The one place that builds this request; the list
 * below and the command palette's title search both call it.
 */
export async function fetchConversations(
  options: { query?: string; archived?: boolean; signal?: AbortSignal } = {},
): Promise<NavConversation[]> {
  const { query, archived, signal } = options;
  const base = query ? `/api/conversations?q=${encodeURIComponent(query)}` : '/api/conversations';
  const url = archived ? `${base}${query ? '&' : '?'}archived=1` : base;
  const result = await fetchWithAuth(url, { signal });
  if (!result.ok) throw new Error('list_failed');
  const body = (await result.json()) as { conversations: NavConversation[] };
  return body.conversations;
}

/**
 * The conversation list against the conversation routes. Distinguishes an empty
 * history from a failed fetch so the sidebar can say which one it is.
 *
 * `reload()` takes nothing, so it is safe to hand to an event handler. Every
 * list request carries a sequence number and only the newest response is
 * applied, so a slow earlier load can never replace a later one.
 */
export function useConversationList(options: { archived?: boolean } = {}): {
  conversations: NavConversation[];
  state: SidebarState;
  failure: boolean;
  reload: () => Promise<void>;
  openConversation: (id: string) => Promise<ConversationDetail>;
  rename: (id: string, title: string, expectedUpdatedAt?: number) => Promise<void>;
  remove: (id: string, expectedUpdatedAt?: number) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  setArchived: (id: string, archived: boolean) => Promise<void>;
} {
  const archived = options.archived === true;
  const [conversations, setConversations] = useState<NavConversation[]>([]);
  const [state, setState] = useState<SidebarState>('idle');
  const [failure, setFailure] = useState(false);
  const latest = useRef(0);

  // Takes nothing, so an event handler can be handed it as is.
  const reload = useCallback(async (): Promise<void> => {
    const seq = ++latest.current;
    setState((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    try {
      const list = await fetchConversations({ archived });
      // A newer request has been sent since; its answer is the one to show.
      if (seq !== latest.current) return;
      setConversations(list);
      setFailure(false);
      setState(list.length === 0 ? 'empty' : 'ready');
    } catch {
      if (seq !== latest.current) return;
      setFailure(true);
      setState('failed');
    }
  }, [archived]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openConversation = useCallback(async (id: string): Promise<ConversationDetail> => {
    const result = await fetchWithAuth(`/api/conversations/${id}`);
    if (!result.ok) throw new Error('open_failed');
    return (await result.json()) as ConversationDetail;
  }, []);

  const rename = useCallback(async (id: string, title: string, expectedUpdatedAt?: number): Promise<void> => {
    const trimmed = title.trim();
    // A rejected rename leaves the original title in place.
    if (!trimmed || trimmed.length > 200) throw new Error('invalid_title');
    const result = await fetchWithAuth(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: trimmed, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) }),
    });
    if (!result.ok) throw new Error(result.status === 409 ? 'conflict' : 'rename_failed');
  }, []);

  const remove = useCallback(async (id: string, expectedUpdatedAt?: number): Promise<void> => {
    const result = await fetchWithAuth(`/api/conversations/${id}`, {
      method: 'DELETE',
      headers: expectedUpdatedAt ? { 'x-bob-expected-updated-at': String(expectedUpdatedAt) } : {},
    });
    // Already gone is the outcome the caller wanted.
    if (!result.ok && result.status !== 404) throw new Error(result.status === 409 ? 'conflict' : 'delete_failed');
  }, []);

  const setPinned = useCallback(async (id: string, pinned: boolean): Promise<void> => {
    const result = await fetchWithAuth(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned }),
    });
    if (!result.ok) throw new Error('pin_failed');
  }, []);

  const setArchived = useCallback(async (id: string, archived: boolean): Promise<void> => {
    const result = await fetchWithAuth(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived }),
    });
    if (!result.ok) throw new Error('archive_failed');
  }, []);

  return {
    conversations,
    state,
    failure,
    reload,
    openConversation,
    rename,
    remove,
    setPinned,
    setArchived,
  };
}
