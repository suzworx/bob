import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../../lib/auth/use-session';

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type ConversationMessagePart = Record<string, unknown>;

type ConversationDetailMessage = {
  id: string;
  role: 'user' | 'assistant';
  position: number;
  versions: Array<{ id: string; parts: ConversationMessagePart[]; versionIndex: number; selected: boolean }>;
};

export type ConversationDetail = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationDetailMessage[];
};

export type SidebarState = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';

/**
 * Sidebar data against the conversation routes (T080). Distinguishes an empty
 * history from a failed fetch so the sidebar can say which one it is (FR-058).
 */
function useConversations(): {
  conversations: ConversationSummary[];
  state: SidebarState;
  failure: boolean;
  refresh: (query?: string) => Promise<void>;
  openConversation: (id: string) => Promise<ConversationDetail>;
  rename: (id: string, title: string, expectedUpdatedAt?: number) => Promise<void>;
  remove: (id: string, expectedUpdatedAt?: number) => Promise<void>;
} {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [state, setState] = useState<SidebarState>('idle');
  const [failure, setFailure] = useState(false);
  const queryRef = useRef<string>('');

  const refresh = useCallback(async (query?: string): Promise<void> => {
    if (query !== undefined) queryRef.current = query;
    setState((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    try {
      const url = queryRef.current
        ? `/api/conversations?q=${encodeURIComponent(queryRef.current)}`
        : '/api/conversations';
      const result = await fetchWithAuth(url);
      if (!result.ok) throw new Error('list_failed');
      const body = (await result.json()) as { conversations: ConversationSummary[] };
      setConversations(body.conversations);
      setFailure(false);
      setState(body.conversations.length === 0 ? 'empty' : 'ready');
    } catch {
      setFailure(true);
      setState('failed');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openConversation = useCallback(async (id: string): Promise<ConversationDetail> => {
    const result = await fetchWithAuth(`/api/conversations/${id}`);
    if (!result.ok) throw new Error('open_failed');
    return (await result.json()) as ConversationDetail;
  }, []);

  const rename = useCallback(async (id: string, title: string, expectedUpdatedAt?: number): Promise<void> => {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 200) {
      // A rejected rename leaves the original title in place (FR-060).
      throw new Error('invalid_title');
    }
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
      headers: {
        ...(expectedUpdatedAt ? { 'x-bob-expected-updated-at': String(expectedUpdatedAt) } : {}),
      },
    });
    if (!result.ok && result.status !== 404) throw new Error(result.status === 409 ? 'conflict' : 'delete_failed');
  }, []);

  return { conversations, state, failure, refresh, openConversation, rename, remove };
}

/** The rail's two recency groups: Today, then Earlier (newest first within each). */
export function groupedByRecency<T extends ConversationSummary>(
  conversations: T[],
  now: number = Date.now(),
): Array<{ heading: 'Today' | 'Earlier'; items: T[] }> {
  const date = new Date(now);
  const startOfToday = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = conversations.filter((conversation) => conversation.updatedAt >= startOfToday);
  const earlier = conversations.filter((conversation) => conversation.updatedAt < startOfToday);
  return [
    { heading: 'Today' as const, items: today },
    { heading: 'Earlier' as const, items: earlier },
  ].filter((group) => group.items.length > 0);
}

/** Truncates an over-long sidebar title to one line; the full text stays the accessible name. */
export function truncateTitle(title: string, max = 48): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}
