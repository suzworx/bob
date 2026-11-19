import { z } from 'zod';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { useEffect, useRef, useState } from 'react';
import { openAppConversation } from './bob-apps-api';
import { useThreads, type Thread } from '@/features/spaces/use-threads';

const threadSchema = z.strictObject({ id: z.uuid(), space_id: z.uuid(), title: z.string().min(1).max(120), created_by: z.uuid(), archived_at: z.number().int().positive().nullable(), last_sequence: z.number().int().nonnegative(), unread_count: z.number().int().nonnegative(), created_at: z.number().int().positive(), updated_at: z.number().int().positive() });

async function readAppThread(conversationId: string, spaceId: string): Promise<Thread> {
  const response = await fetchWithAuth(`/api/threads/${encodeURIComponent(conversationId)}`);
  if (!response.ok) throw new Error('app_thread_unavailable');
  const thread = threadSchema.parse(await response.json());
  if (thread.id !== conversationId || thread.space_id !== spaceId || thread.archived_at !== null) throw new Error('wrong_app_thread');
  return thread;
}

export function useAppConversation(appId: string, spaceId: string): { id: string | null; error: boolean; thread: Thread | undefined; threads: ReturnType<typeof useThreads> } {
  const threads = useThreads(spaceId);
  const [state, setState] = useState<{ id: string | null; error: boolean; thread?: Thread }>({ id: null, error: false });
  const { openThread } = threads;
  const refresh = useRef(threads.refresh); refresh.current = threads.refresh;
  useEffect(() => {
    let live = true;
    setState({ id: null, error: false });
    void openAppConversation(appId).then(async (conversation) => {
      if (!live) return;
      if (conversation.spaceId !== spaceId) throw new Error('wrong_app_audience');
      const thread = await readAppThread(conversation.conversationId, spaceId);
      if (!live) return;
      await openThread(conversation.conversationId);
      await refresh.current();
      if (live) setState({ id: conversation.conversationId, thread, error: false });
    }).catch(() => { if (live) setState({ id: null, error: true }); });
    return () => { live = false; };
  }, [appId, spaceId, openThread]);
  return { threads, ...state, thread: state.thread };
}
