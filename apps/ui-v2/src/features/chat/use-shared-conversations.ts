import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/use-session';
import { groupRequest, type GroupChat } from './group-chats-api';
import type { NavConversation } from './use-conversation-list';
import type { SidebarState } from './use-conversations';
import { useGroupChatRefresh } from './use-group-chat-refresh';

export interface SharedConversationList {
  conversations: NavConversation[];
  state: SidebarState;
  reload: () => Promise<void>;
}

/** Shared individual chats use the same history rows, with their own access-
 * checked endpoint. The wire name stays compatible with existing invite links. */
export function useSharedConversations(): SharedConversationList {
  const { session } = useSession();
  const accountId = session?.user.id ?? null;
  useGroupChatRefresh();
  const query = useQuery({
    queryKey: ['group-chats', accountId], enabled: accountId !== null,
    queryFn: () => groupRequest<{ chats: GroupChat[] }>(''),
    refetchOnWindowFocus: 'always', staleTime: 0,
  });
  const conversations = (query.data?.chats ?? []).map((chat) => ({
    id: chat.id, title: chat.title, createdAt: chat.created_at, updatedAt: chat.updated_at, shared: true,
  }));
  let state: SidebarState = conversations.length > 0 ? 'ready' : 'empty';
  if (query.isError) state = 'failed';
  else if (query.isPending && accountId !== null) state = 'loading';
  return { conversations, state, reload: async () => { await query.refetch(); } };
}
