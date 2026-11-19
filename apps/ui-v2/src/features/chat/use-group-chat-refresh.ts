import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/use-session';
import { useRefreshOnFocus } from '@/lib/use-refresh-on-focus';

/** The shell relays ids-only account events; no additional SSE connection. */
export function useGroupChatRefresh(onChange?: (conversationId?: string, deleted?: boolean) => void): void {
  const client = useQueryClient();
  const { session } = useSession();
  const accountId = session?.user.id ?? null;
  const focus = useRefreshOnFocus();
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    const refresh = (event: Event): void => {
      const detail = (event as CustomEvent<{ conversationId?: string; deleted?: boolean }>).detail;
      void client.invalidateQueries({ queryKey: ['group-chats', accountId] });
      void client.invalidateQueries({ queryKey: ['group-chat-members', accountId] });
      void client.invalidateQueries({ queryKey: ['threads', 'list', accountId] });
      if (detail?.deleted) client.removeQueries({ queryKey: ['threads', 'messages', accountId, detail.conversationId] });
      else void client.invalidateQueries({ queryKey: ['threads', 'messages', accountId] });
      callback.current?.(detail?.conversationId, detail?.deleted);
    };
    window.addEventListener('bob:group-chat-updated', refresh);
    window.addEventListener('bob:group-chats-changed', refresh);
    return () => {
      window.removeEventListener('bob:group-chat-updated', refresh);
      window.removeEventListener('bob:group-chats-changed', refresh);
    };
  }, [client, accountId]);
  useEffect(() => { if (focus > 0) callback.current?.(); }, [focus]);
}
