import type { ChatAppBinding } from '@/features/chat/chat-surface';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchWithAuth, useSession } from '../../lib/auth/use-session';
import { clearAccountThreadQueries, HttpError, threadKeys } from '../../lib/query-client';
import { markSpacesStale } from './use-spaces';

export type Thread = {
  id: string;
  space_id: string;
  title: string;
  created_by: string;
  archived_at: number | null;
  last_sequence: number;
  unread_count: number;
  created_at: number;
  updated_at: number;
};

export type ThreadMessage = {
  id: string;
  thread_id: string;
  space_id: string;
  author_user_id: string | null;
  body: string;
  reply_to_message_id: string | null;
  sequence: number;
  client_message_id: string;
  revision: number;
  tombstoned_at: number | null;
  tombstoned_by: string | null;
  created_at: number;
  updated_at: number;
  origin: 'web_text' | 'web_voice' | 'device';
};

/** `bob:thread-message`'s detail: the shell relays the account SSE thread.message_appended (#565). */
export type ThreadMessageEventDetail = { threadId: string; spaceId: string };

type ThreadsState = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';

type InvocationState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ThreadInvocation = {
  id: string;
  thread_id: string;
  space_id: string;
  state: InvocationState;
  result_message_id: string | null;
  error_code: string | null;
};
/** answered: the reply is in the thread; busy: 409; pending: still running after the poll budget. */
export type AskBobOutcome = 'answered' | 'failed' | 'cancelled' | 'busy' | 'pending' | 'conflict';
export const INVOCATION_POLL_ATTEMPTS = 20;
export const INVOCATION_POLL_DELAY_MS = 1500;

const MESSAGES_PAGE_LIMIT = 200;
// Runaway-loop guard: caps one thread's history fetch at 5000 messages.
const MESSAGES_MAX_PAGES = 25;

let clientSeq = 0;
function nextClientMessageId(): string {
  clientSeq += 1;
  return `web-${Date.now()}-${clientSeq}`;
}

type PostMessageVars = {
  body: string;
  clientMessageId: string;
  threadId: string;
  spaceId: string;
};

/** Map a query's state onto the five-state contract the callers switch on. */
function deriveState(
  enabled: boolean,
  status: 'pending' | 'error' | 'success',
  items: readonly unknown[],
): ThreadsState {
  if (!enabled) return 'idle';
  if (status === 'pending') return 'loading';
  if (status === 'error') return 'failed';
  return items.length === 0 ? 'empty' : 'ready';
}

/**
 * Poll one invocation until it leaves queued/running. The caller's POST
 * already waits for the run, so the first read is normally terminal; this
 * loop only covers a duplicate trigger whose original is still running.
 */
export async function waitForInvocation(
  id: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
): Promise<ThreadInvocation | null> {
  for (let attempt = 0; attempt < INVOCATION_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(INVOCATION_POLL_DELAY_MS);
    const response = await fetchWithAuth(`/api/invocations/${id}`);
    if (!response.ok) throw new HttpError('invocation_read_failed', response.status);
    const invocation = (await response.json()) as ThreadInvocation;
    if (invocation.state !== 'queued' && invocation.state !== 'running') return invocation;
  }
  return null;
}

/**
 * Threads and messages for the active space. Posting appends optimistically and
 * reconciles with the server-created message; a failed post throws so the
 * caller keeps the draft. The server is the authority on mention meaning, so
 * the body is always sent as plain text.
 */
export function useThreads(spaceId: string | null): {
  threads: Thread[];
  threadsState: ThreadsState;
  activeThreadId: string | null;
  messages: ThreadMessage[];
  messagesState: ThreadsState;
  error: string | null;
  refresh: () => Promise<void>;
  openThread: (id: string) => Promise<void>;
  createThread: (title: string) => Promise<Thread | null>;
  renameThread: (threadId: string, title: string) => Promise<Thread>;
  archiveThread: (threadId: string) => Promise<void>;
  hideThread: (threadId: string) => void;
  unhideThread: (thread: Thread) => void;
  postMessage: (body: string) => Promise<ThreadMessage>;
  editMessage: (messageId: string, body: string) => Promise<ThreadMessage>;
  deleteMessage: (messageId: string) => Promise<ThreadMessage>;
  askBob: (trigger: ThreadMessage, appBinding?: ChatAppBinding) => Promise<AskBobOutcome>;
} {
  const queryClient = useQueryClient();
  const { session } = useSession();
  const accountId = session?.user?.id ?? null;
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const threadsQuery = useQuery({
    queryKey: threadKeys.list(accountId, spaceId),
    queryFn: async (): Promise<Thread[]> => {
      if (spaceId === null) throw new Error('no_space');
      const response = await fetchWithAuth(`/api/spaces/${spaceId}/threads`);
      if (!response.ok) throw new HttpError('threads_failed', response.status);
      const body = (await response.json()) as { threads: Thread[] };
      return body.threads;
    },
    enabled: accountId !== null && spaceId !== null,
  });

  const markRead = useCallback(async (threadId: string, lastReadSequence?: number): Promise<void> => {
    try {
      await fetchWithAuth(`/api/threads/${threadId}/read`, {
        method: 'PUT',
        ...(lastReadSequence === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ last_read_sequence: lastReadSequence }),
            }),
      });
      // The space's unread total (GET /api/spaces) moved with this cursor.
      markSpacesStale();
    } catch {
      // Reading is best-effort; a failure must not hide the thread.
    }
  }, []);

  const messagesQuery = useQuery({
    queryKey: threadKeys.messages(accountId, activeThreadId),
    queryFn: async (): Promise<ThreadMessage[]> => {
      if (activeThreadId === null) throw new Error('no_thread');
      const messages: ThreadMessage[] = [];
      let cursor: string | null = null;
      let cappedByPageLimit = true;
      for (let page = 0; page < MESSAGES_MAX_PAGES; page += 1) {
        const query =
          cursor === null
            ? `?limit=${MESSAGES_PAGE_LIMIT}`
            : `?limit=${MESSAGES_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`;
        const response = await fetchWithAuth(`/api/threads/${activeThreadId}/messages${query}`);
        if (!response.ok) throw new HttpError('messages_failed', response.status);
        const body = (await response.json()) as {
          messages: ThreadMessage[];
          next_cursor: string | null;
        };
        messages.push(...body.messages);
        if (body.next_cursor === null) {
          cappedByPageLimit = false;
          break;
        }
        cursor = body.next_cursor;
      }
      // A thread capped by MESSAGES_MAX_PAGES has more messages on the server
      // than were loaded; marking it read past the last loaded message would
      // hide the unshown ones as read. Pin the read cursor to what was shown.
      if (cappedByPageLimit) {
        const last = messages[messages.length - 1];
        if (last !== undefined) void markRead(activeThreadId, last.sequence);
      } else {
        void markRead(activeThreadId);
      }
      return messages;
    },
    enabled: accountId !== null && activeThreadId !== null,
  });

  const threads = threadsQuery.data ?? [];
  const messages = messagesQuery.data ?? [];
  const threadsState = deriveState(
    accountId !== null && spaceId !== null,
    threadsQuery.status,
    threads,
  );
  const messagesState = deriveState(
    accountId !== null && activeThreadId !== null,
    messagesQuery.status,
    messages,
  );
  const error = threadsQuery.error instanceof Error ? threadsQuery.error.message : null;

  // Switching space closes whatever thread was open.
  useEffect(() => {
    setActiveThreadId(null);
  }, [spaceId]);

  // The cache is namespaced per account, but a departing reader's entries
  // should not linger in memory for the next one. Clear the previous account's
  // thread queries only when the id actually changes: not on the first render
  // (undefined sentinel), not on a loading -> loaded transition for the same
  // account, and not on a re-render where the id is unchanged.
  const previousAccountId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const previous = previousAccountId.current;
    previousAccountId.current = accountId;
    if (previous !== undefined && previous !== null && previous !== accountId) {
      clearAccountThreadQueries(queryClient, previous);
    }
  }, [accountId, queryClient]);

  useEffect(() => {
    const accessChanged = (event: Event): void => {
      if ((event as CustomEvent<{ spaceId: string }>).detail?.spaceId !== spaceId) return;
      setActiveThreadId(null);
      queryClient.removeQueries({ queryKey: threadKeys.list(accountId, spaceId) });
      if (activeThreadId) queryClient.removeQueries({ queryKey: threadKeys.messages(accountId, activeThreadId) });
    };
    window.addEventListener('bob:space-access', accessChanged);
    return () => window.removeEventListener('bob:space-access', accessChanged);
  }, [accountId, spaceId, activeThreadId, queryClient]);

  // A message landed in a thread from elsewhere (a Cardputer turn, another tab):
  // refetch that thread's messages and its space's list, which carries unread.
  useEffect(() => {
    const onThreadMessage = (event: Event): void => {
      const detail = (event as CustomEvent<ThreadMessageEventDetail>).detail;
      if (accountId === null || detail === undefined || detail === null) return;
      void queryClient.invalidateQueries({ queryKey: threadKeys.messages(accountId, detail.threadId) });
      void queryClient.invalidateQueries({ queryKey: threadKeys.list(accountId, detail.spaceId) });
      markSpacesStale();
    };
    window.addEventListener('bob:thread-message', onThreadMessage);
    return () => window.removeEventListener('bob:thread-message', onThreadMessage);
  }, [accountId, queryClient]);

  const openThread = useCallback(async (id: string): Promise<void> => {
    setActiveThreadId(id);
  }, []);

  const createThread = useCallback(
    async (title: string): Promise<Thread | null> => {
      if (spaceId === null) return null;
      const response = await fetchWithAuth(`/api/spaces/${spaceId}/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      });
      if (!response.ok) return null;
      const created = (await response.json()) as Thread;
      queryClient.setQueryData<Thread[]>(threadKeys.list(accountId, spaceId), (old) => [
        ...(old ?? []),
        created,
      ]);
      await openThread(created.id);
      return created;
    },
    [accountId, spaceId, openThread, queryClient],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string): Promise<Thread> => {
      const response = await fetchWithAuth(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      });
      if (!response.ok) throw new HttpError('rename_failed', response.status);
      const renamed = (await response.json()) as Thread;
      queryClient.setQueryData<Thread[]>(threadKeys.list(accountId, spaceId), (old) =>
        old?.map((thread) =>
          thread.id === renamed.id ? { ...renamed, unread_count: thread.unread_count } : thread,
        ),
      );
      return renamed;
    },
    [accountId, spaceId, queryClient],
  );

  const archiveThread = useCallback(
    async (threadId: string): Promise<void> => {
      const response = await fetchWithAuth(`/api/threads/${threadId}`, { method: 'DELETE' });
      if (!response.ok) throw new HttpError('archive_failed', response.status);
      queryClient.setQueryData<Thread[]>(threadKeys.list(accountId, spaceId), (old) =>
        old?.filter((thread) => thread.id !== threadId),
      );
      setActiveThreadId((current) => (current === threadId ? null : current));
    },
    [accountId, spaceId, queryClient],
  );

  // Archive with Undo: the row leaves the cached list now and comes back on
  // Undo; archiveThread runs only once the Undo window closes.
  const hideThread = useCallback(
    (threadId: string): void => {
      queryClient.setQueryData<Thread[]>(threadKeys.list(accountId, spaceId), (old) =>
        old?.filter((thread) => thread.id !== threadId),
      );
    },
    [accountId, spaceId, queryClient],
  );
  const unhideThread = useCallback(
    (restored: Thread): void => {
      queryClient.setQueryData<Thread[]>(threadKeys.list(accountId, spaceId), (old) =>
        old === undefined || old.some((thread) => thread.id === restored.id)
          ? old
          : [...old, restored].sort((a, b) => b.updated_at - a.updated_at),
      );
    },
    [accountId, spaceId, queryClient],
  );

  const postMessageMutation = useMutation({
    mutationFn: async (vars: PostMessageVars): Promise<ThreadMessage> => {
      const response = await fetchWithAuth(`/api/threads/${vars.threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: vars.body, client_message_id: vars.clientMessageId }),
      });
      if (!response.ok) throw new HttpError('post_failed', response.status);
      return (await response.json()) as ThreadMessage;
    },
    onMutate: async (vars) => {
      const messagesKey = threadKeys.messages(accountId, vars.threadId);
      // The composer stays enabled while a thread's history is still loading,
      // so a send can arrive before the initial GET resolves. Cancelling that
      // GET and snapshotting `?? []` used to mean the optimistic write replaced
      // real history with a single message, onError "restored" that empty
      // snapshot, and nothing refetched -- so a thread of twenty messages could
      // show one. When there is nothing cached yet, leave the in-flight query
      // alone and let it land; onSettled refetches so the sent message appears
      // alongside the history rather than instead of it.
      const loaded = queryClient.getQueryData<ThreadMessage[]>(messagesKey);
      if (loaded === undefined) return { previous: undefined, provisional: undefined };
      await queryClient.cancelQueries({ queryKey: messagesKey });
      const previous = loaded;
      const provisional: ThreadMessage = {
        id: `pending-${vars.clientMessageId}`,
        thread_id: vars.threadId,
        space_id: vars.spaceId,
        author_user_id: 'pending',
        body: vars.body,
        reply_to_message_id: null,
        sequence: previous.length,
        client_message_id: vars.clientMessageId,
        revision: 1,
        tombstoned_at: null,
        tombstoned_by: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        origin: 'web_text',
      };
      queryClient.setQueryData<ThreadMessage[]>(
        threadKeys.messages(accountId, vars.threadId),
        (old) => [...(old ?? []), provisional],
      );
      return { previous, provisional };
    },
    onError: (_error, vars, context) => {
      // Only roll back to a snapshot we actually took. Writing `undefined` here
      // would evict the cache -- including history that landed while the request
      // was in flight.
      if (context?.previous === undefined) return;
      queryClient.setQueryData<ThreadMessage[]>(
        threadKeys.messages(accountId, vars.threadId),
        context.previous,
      );
    },
    onSuccess: (created, vars, context) => {
      if (context?.provisional === undefined) return;
      const provisionalId = context.provisional.id;
      queryClient.setQueryData<ThreadMessage[]>(
        threadKeys.messages(accountId, vars.threadId),
        (old) => (old ?? []).map((message) => (message.id === provisionalId ? created : message)),
      );
    },
    onSettled: (_data, _error, vars, context) => {
      // No optimistic write happened, so the cache does not yet know about this
      // message. Refetch rather than patching a list that is still arriving.
      if (context?.provisional !== undefined) return;
      void queryClient.invalidateQueries({
        queryKey: threadKeys.messages(accountId, vars.threadId),
      });
    },
  });

  const postMessage = useCallback(
    async (body: string): Promise<ThreadMessage> => {
      if (activeThreadId === null) throw new Error('no_thread');
      const clientMessageId = nextClientMessageId();
      return postMessageMutation.mutateAsync({
        body,
        clientMessageId,
        threadId: activeThreadId,
        spaceId: spaceId ?? '',
      });
    },
    [activeThreadId, spaceId, postMessageMutation],
  );

  const replaceMessage = useCallback(
    (updated: ThreadMessage): void => {
      queryClient.setQueryData<ThreadMessage[]>(
        threadKeys.messages(accountId, updated.thread_id),
        (old) => old?.map((message) => (message.id === updated.id ? updated : message)),
      );
    },
    [accountId, queryClient],
  );

  const editMessage = useCallback(
    async (messageId: string, body: string): Promise<ThreadMessage> => {
      const response = await fetchWithAuth(`/api/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body.trim() }),
      });
      if (!response.ok) throw new HttpError('edit_failed', response.status);
      const updated = (await response.json()) as ThreadMessage;
      replaceMessage(updated);
      return updated;
    },
    [replaceMessage],
  );

  const deleteMessage = useCallback(
    async (messageId: string): Promise<ThreadMessage> => {
      const response = await fetchWithAuth(`/api/messages/${messageId}`, { method: 'DELETE' });
      if (!response.ok) throw new HttpError('delete_failed', response.status);
      const updated = (await response.json()) as ThreadMessage;
      replaceMessage(updated);
      return updated;
    },
    [replaceMessage],
  );

  const askBob = useCallback(
    async (trigger: ThreadMessage, appBinding?: ChatAppBinding): Promise<AskBobOutcome> => {
      const response = await fetchWithAuth(`/api/threads/${trigger.thread_id}/invocations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger_message_id: trigger.id, ...(appBinding ? { appBinding } : {}) }),
      });
      if (response.status === 409) return appBinding ? 'conflict' : 'busy';
      if (!response.ok) throw new HttpError('invocation_failed', response.status);
      const created = (await response.json()) as { invocation_id: string };
      const invocation = await waitForInvocation(created.invocation_id);
      await queryClient.invalidateQueries({
        queryKey: threadKeys.messages(accountId, trigger.thread_id),
      });
      if (invocation === null) return 'pending';
      if (invocation.state === 'completed') return 'answered';
      if (invocation.state === 'cancelled') return 'cancelled';
      return 'failed';
    },
    [accountId, queryClient],
  );

  const refresh = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: threadKeys.list(accountId, spaceId) });
    if (activeThreadId !== null) {
      await queryClient.invalidateQueries({
        queryKey: threadKeys.messages(accountId, activeThreadId),
      });
    }
  }, [queryClient, accountId, spaceId, activeThreadId]);

  return {
    threads,
    threadsState,
    activeThreadId,
    messages,
    messagesState,
    error,
    refresh,
    openThread,
    createThread,
    renameThread,
    archiveThread,
    hideThread,
    unhideThread,
    postMessage,
    editMessage,
    deleteMessage,
    askBob,
  };
}