import { useEffect, type ReactElement, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Text } from '@astryxdesign/core/Text';
import { fetchWithAuth, useSession } from '@/lib/auth/use-session';
import { HttpError } from '@/lib/query-client';
import { ThreadReader } from './thread-reader';
import { useThreads } from './use-threads';
import type { Space, SpaceMember } from './use-spaces';

/** Conversation audiences use the existing thread list and composer, with only
 * their own participants. They never need the normal Spaces provider/list. */
export function GroupThreadContent({ chatId, spaceId, phoneActions }: { chatId: string; spaceId: string; phoneActions?: ReactNode }): ReactElement {
  const { session } = useSession();
  const accountId = session?.user.id ?? null;
  const threads = useThreads(spaceId);
  const { openThread } = threads;
  const members = useQuery({
    queryKey: ['group-chat-members', accountId, chatId],
    queryFn: async (): Promise<SpaceMember[]> => {
      const response = await fetchWithAuth(`/api/spaces/${spaceId}/members`);
      if (!response.ok) throw new HttpError('members_failed', response.status);
      return ((await response.json()) as { members: SpaceMember[] }).members;
    },
    enabled: accountId !== null,
  });
  useEffect(() => { void openThread(chatId); }, [chatId, openThread]);
  const thread = threads.threads.find((item) => item.id === chatId);
  if (members.isError || threads.threadsState === 'failed' || threads.threadsState === 'empty') {
    return <Text role="status">This chat is no longer available to you.</Text>;
  }
  if (!thread || !members.data) return <Text role="status">Loading chat…</Text>;
  const space: Space = {
    id: spaceId, kind: 'group', name: thread.title,
    role: members.data.find((member) => member.user_id === accountId)?.role ?? 'member',
    membership_revision: 0, created_at: thread.created_at, updated_at: thread.updated_at,
    members: members.data,
  };
  return <ThreadReader space={space} thread={thread} threads={threads} requireMention phoneActions={phoneActions} />;
}
