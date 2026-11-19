import { useEffect, useRef } from 'react';
import { fetchWithAuth } from './auth/use-session';

/**
 * Account-scoped Server-Sent Events over a fetch stream (contract
 * account-events.md). The server closes the stream when the bearer token
 * expires, so this hook reconnects with a fresh token (fetchWithAuth resolves
 * authHeaders per call) on a 1 s -> 30 s capped backoff, and refetches
 * everything once on every open to converge — the stream is best-effort and
 * at-most-once, so the client converges by refetch (account-events.md
 * "Convergence by refetch"). Event payloads carry ids only; this hook never
 * fabricates content from them.
 */

export type AccountEventHandlers = {
  /**
   * A turn was saved; refetch the conversation when it is the open one. The
   * second argument is the id of the message the event names, or null when the
   * frame carries none, so a caller can tell its own message from another's.
   */
  onMessageAppended?: (conversationId: string, messageId: string | null) => void;
  /** A conversation was created or renamed; refetch the sidebar. */
  onConversationUpdated?: (conversationId: string) => void;
  /** A conversation was permanently deleted; refetch the sidebar. */
  onConversationDeleted?: (conversationId: string) => void;
  /** The account's active-conversation pointer changed; refetch /api/active. */
  onActiveChanged?: () => void;
  /** A device was paired, renamed, or revoked; refetch /api/devices. */
  onDeviceChanged?: () => void;
  /** The Cardputer's active Space was set or cleared; refetch /api/devices. */
  onActiveSpaceChanged?: () => void;
  onSpaceAccessChanged?: (spaceId: string) => void;
  /** A message landed in a space thread (#565); refetch that thread and its list. */
  onThreadMessageAppended?: (threadId: string, spaceId: string) => void;
  /** The stream (re)opened; refetch everything to converge. */
  onReconnect?: () => void;
};

type SseFrame = { event: string; data: string };

/**
 * Split buffered SSE text into complete frames (SSE spec: a blank line ends a
 * frame; `: comment` lines carry no event and are ignored; multiple `data:`
 * lines join with a newline). The trailing partial text is returned as `rest`
 * so the caller keeps it for the next chunk. Exported for the parsing tests.
 */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  const frames: SseFrame[] = [];
  for (const block of blocks) {
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') });
  }
  return { frames, rest };
}

const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

type FramePayload = { conversation_id?: unknown; message_id?: unknown; thread_id?: unknown; space_id?: unknown };

function dispatchFrame(frame: SseFrame, handlers: AccountEventHandlers): void {
  if (frame.event === '' || frame.data === '') return;
  let payload: FramePayload;
  try {
    payload = JSON.parse(frame.data) as FramePayload;
  } catch {
    // A malformed frame is dropped; ids are never guessed from text.
    return;
  }
  switch (frame.event) {
    case 'message.appended':
      if (typeof payload.conversation_id === 'string') {
        handlers.onMessageAppended?.(
          payload.conversation_id,
          typeof payload.message_id === 'string' ? payload.message_id : null,
        );
      }
      break;
    case 'conversation.updated':
      if (typeof payload.conversation_id === 'string') {
        handlers.onConversationUpdated?.(payload.conversation_id);
      }
      break;
    case 'conversation.deleted':
      if (typeof payload.conversation_id === 'string') {
        handlers.onConversationDeleted?.(payload.conversation_id);
      }
      break;
    case 'active.changed':
      handlers.onActiveChanged?.();
      break;
    case 'device.changed':
      handlers.onDeviceChanged?.();
      break;
    case 'active_space.changed':
      handlers.onActiveSpaceChanged?.();
      break;
    case 'space.access_changed':
      if (typeof payload.space_id === 'string') handlers.onSpaceAccessChanged?.(payload.space_id);
      break;
    case 'thread.message_appended':
      if (typeof payload.thread_id === 'string' && typeof payload.space_id === 'string') {
        handlers.onThreadMessageAppended?.(payload.thread_id, payload.space_id);
      }
      break;
    default:
      break;
  }
}

/**
 * Opens `GET /api/events` while mounted and dispatches frames to the handlers.
 * Handlers are read through a ref, so they may change identity without
 * reopening the stream. A close or error schedules a reconnect with backoff
 * (1 s doubling to a 30 s cap, reset on a successful open); every successful
 * open fires `onReconnect` so the caller refetches to converge.
 */
export function useAccountEvents(handlers: AccountEventHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let retryMs = MIN_RETRY_MS;

    const reconnect = (): void => {
      if (cancelled) return;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };

    const connect = async (): Promise<void> => {
      if (cancelled) return;
      try {
        controller = new AbortController();
        const response = await fetchWithAuth('/api/events', {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || response.body === null) {
          reconnect();
          return;
        }
        // The stream opened: reset the backoff and converge by refetch.
        retryMs = MIN_RETRY_MS;
        handlersRef.current.onReconnect?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = parseSseFrames(buffer);
          buffer = rest;
          for (const frame of frames) dispatchFrame(frame, handlersRef.current);
        }
        // Normal close (token exp / server): reconnect with a fresh token.
        reconnect();
      } catch {
        if (!cancelled) reconnect();
      }
    };

    void connect();
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      controller?.abort();
    };
  }, []);
}