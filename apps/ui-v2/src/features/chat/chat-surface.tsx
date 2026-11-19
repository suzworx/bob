import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactElement } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type FileUIPart, type UIMessage } from 'ai';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { ChatLayout, ChatMessageList } from '@astryxdesign/core/Chat';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { PageTitle } from '@/app/page-width';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Stack, StackItem } from '@astryxdesign/core/Stack';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { BRAND } from '@/lib/brand';
import { authHeaders, fetchWithAuth, handleUnauthorized } from '@/lib/auth/use-session';
import { DeviceHeaderControl } from '@/features/devices/device-header-control';
import { useDeviceConversation } from '@/features/devices/use-device-conversation';
import { navigateTo } from '@/app/routes';
import { ChatLanding } from './chat-landing';
import { usePhoneChatLayout } from './chat-layout-props';
import { NoticeRegion, OUT_OF_CREDIT_NOTICE, type ChatNotice } from './chat-notices';
import { Composer } from './composer';
import { NEW_CHAT_DRAFT_KEY } from './drafts';
import { MESSAGE_WINDOW } from './conversation-messages';
import { mentionToken } from './mentions';
import { DeviceNameProvider, MessageView, ThinkingMessage, messageText, type MessageVersions } from './message-view';
import type { ChatSlotProps } from '../../app/shell';
import { SpokenReplyPlayer } from '../voice/spoken-reply-player';
import { useChatVoice, type TurnOrigin } from '../voice/use-chat-voice';
import { messageTraceId } from '@/features/metrics/reply-feedback';
import { useMentionMembers } from './use-mention-members';
import { VoiceModeBar } from '../voice/voice-mode-bar';
import { CollaborateButton, CollaborateDialog } from './collaborate-button';
import { Users, Wrench } from 'lucide-react';

// The session versions of one reply: its texts, oldest first, and which shows.
type VersionEntry = { versions: string[]; traceIds: Array<string | undefined>; active: number };

const COPY_FAILED_NOTICE = "Couldn't copy. Select the text to copy it yourself.";

// An edit of an earlier user message, as /api/chat names it: `editFrom` is the
// last message kept (the server deletes everything after it), and `editFromStart`
// edits the first message, which no message precedes.
type ChatEdit = { editFrom: string } | { editFromStart: true };

// The app a turn is aimed at. Same shape as the API's ChatAppBinding: targeting
// only, the server authorizes the installation itself. `channel` is the network
// the reader has open; omitted means all channels. `campaignId` requests a saved
// campaign; null explicitly selects New and omission follows stored targeting.
// The server authorizes the target before writing the turn. Run intent selects
// the workflow; it never carries instructions or permissions.
export type ChatAppBinding = { installationId: string; mode: 'run' | 'refine'; channel?: 'instagram' | 'linkedin'; campaignId?: string | null; intent?: 'posts' | 'campaign' };

function appBindingBody(appBinding: ChatAppBinding): Record<string, unknown> {
  return {
    installationId: appBinding.installationId,
    mode: appBinding.mode,
    ...(appBinding.channel ? { channel: appBinding.channel } : {}),
    ...(appBinding.campaignId !== undefined ? { campaignId: appBinding.campaignId } : {}),
    ...(appBinding.mode === 'run' && appBinding.intent ? { intent: appBinding.intent } : {}),
  };
}

// The body /api/chat expects: the transport always supplies the newest user
// turn, and the server decides whether it appends it (contracts/chat-stream.md).
// With no edit and no origin it is byte-identical to v1's.
export function buildChatRequestBody(
  conversationId: string | null,
  messages: UIMessage[],
  trigger: string,
  edit?: ChatEdit,
  origin?: TurnOrigin,
  workflowId?: string,
  appBinding?: ChatAppBinding,
  resend?: boolean,
): Record<string, unknown> {
  const newestUser = [...messages].reverse().find((candidate) => candidate.role === 'user');
  return {
    ...(conversationId ? { id: conversationId } : {}),
    message: {
      id: newestUser?.id,
      role: newestUser?.role ?? 'user',
      parts: newestUser?.parts ?? [],
    },
    regenerate: trigger === 'regenerate-message' || undefined,
    ...(resend ? { resend: true } : {}),
    ...edit,
    ...(origin ? { origin } : {}),
    ...(workflowId && trigger !== 'regenerate-message' ? { workflowId } : {}),
    ...(appBinding ? { appBinding: appBindingBody(appBinding) } : {}),
  };
}

// What the next submitted turn carries beyond its text. sendMessage takes only
// the message, so ChatSurface sets this right before it and the transport's
// body builder reads it once (as v1 did for its voice-turn flag).
type NextTurn = { edit?: ChatEdit; origin?: TurnOrigin; workflowId?: string; resend?: boolean };

// A turn that ended in error: named as a dropped connection when any assistant
// text had streamed for it, otherwise a plain failure. Both offer Retry.
const CONNECTION_LOST_NOTICE = 'The connection dropped mid-reply.';
const REQUEST_FAILED_NOTICE = `${BRAND.assistantName} couldn't finish that.`;

// Refusals the server words for the reader. Its other messages are not written for them.
const READER_REFUSALS = new Set(['not_found', 'app_paused', 'invalid_document', 'document_busy']);

/** The server's wording when the turn was refused before it began, or null. The transport's error.message is the body. */
function refusalMessage(error: Error): string | null {
  try {
    const refusal = (JSON.parse(error.message) as { error?: { code?: unknown; message?: unknown } }).error;
    return typeof refusal?.code === 'string' && READER_REFUSALS.has(refusal.code) && typeof refusal.message === 'string' ? refusal.message : null;
  } catch {
    return null;
  }
}

/** The notice for a failed turn: out of credit, a refusal, a connection dropped mid-reply, or a plain failure. */
function turnFailedNotice(error: Error, streamedBeforeError: boolean): string {
  if (error.message.includes('out_of_credit')) return OUT_OF_CREDIT_NOTICE;
  const refusal = refusalMessage(error);
  if (refusal) return refusal;
  return streamedBeforeError ? CONNECTION_LOST_NOTICE : REQUEST_FAILED_NOTICE;
}
// A conversation reopened on a user message the assistant never answered.
const UNANSWERED_NOTICE = 'No reply was received for your last message.';
// v1 added "You can retry saving it", but nothing retries a save, so v2 drops it.
const SAVE_FAILED_NOTICE = 'The reply could not be saved.';
const DELETE_FAILED_NOTICE = "Couldn't delete those messages.";

// The assistant replies the server stores: it saves none for a reply with no parts.
function storableReplies(messages: UIMessage[]): number {
  return messages.filter((candidate) => candidate.role === 'assistant' && candidate.parts.length > 0)
    .length;
}

export function ChatSurface({
  conversationId,
  conversationTitle,
  initialMessages,
  earlierMessages,
  userName,
  onConversationTouched,
  onConversationCreated,
  onBusyChange,
  knownMessageIds,
  embedded = false,
  draftKey,
  placeholder,
  appBinding,
  embeddedHeight = 'min(600px, 65dvh)',
  composerFillRef,
  composerFocusRef,
}: ChatSlotProps & { embedded?: boolean; draftKey?: string; placeholder?: string; appBinding?: ChatAppBinding; embeddedHeight?: string; composerFillRef?: MutableRefObject<((text: string) => void) | null>; composerFocusRef?: MutableRefObject<(() => void) | null> }): ReactElement {
  // The messages older than the thread's first one that are not loaded yet,
  // oldest first. A ref holds them so two loads in one tick cannot both take the
  // same page; the count is state so the button appears and goes with it.
  const earlierRef = useRef<UIMessage[]>(earlierMessages ?? []);
  const [earlierCount, setEarlierCount] = useState(earlierRef.current.length);
  // Set once this surface has unmounted. The shell unmounts it on every
  // conversation switch, new chat and load, but useChat's request outlives the
  // unmount; without this a late onConversationCreated would navigate the
  // reader back to the chat they just left.
  const disposedRef = useRef(false);
  // The regenerate in flight, if any: the user turn whose reply it replaces and
  // the id of the reply it is replacing. Cleared when the new reply lands, and
  // when the regenerate ends in an error or an abort.
  const pendingRegenRef = useRef<{ key: string; previousAssistantId: string } | null>(null);
  // The edit and origin of the turn about to be submitted, read once by the
  // transport's body builder below. Cleared by every request, so a Retry never
  // replays an earlier turn's edit (which the server refuses next to regenerate).
  const nextTurnRef = useRef<NextTurn | null>(null);
  const requestBindingRef = useRef<{ binding: ChatAppBinding | undefined } | null>(null);
  // The newest sent turn. While it is the unanswered tail, a Retry sends it again
  // as it was sent: the failure may have come before the server stored it, when a
  // regenerate would answer the previous turn and drop this one.
  const sentTurnRef = useRef<(NextTurn & { messageId?: string }) | null>(null);
  // Assistant replies streamed in this session. The server stores a reply under
  // an id of its own, not the one the stream carried, so such a reply is no
  // anchor for an edit until the conversation is reloaded from the server.
  const [liveReplyIds, setLiveReplyIds] = useState<ReadonlySet<string>>(() => new Set());
  // #492: the Cardputer's conversation, shown and changed from the header.
  const device = useDeviceConversation();
  const { isMobile } = useAppShellMobile();

  // Persistence check, ported from v1: once a turn ends cleanly, read the
  // conversation back and flag a reply the server never stored. The server
  // stores a reply under an id of its own, so ids cannot be matched; instead
  // the read-back must hold as many assistant replies as the thread shows, and
  // a lost newest reply cannot hide behind the older stored ones. One check at
  // a time; a new turn or an unmount aborts the one in flight so it stays
  // silent.
  const [saveFailed, setSaveFailed] = useState(false);
  const saveCheckRef = useRef<AbortController | null>(null);
  const cancelSaveCheck = (): void => {
    saveCheckRef.current?.abort();
    saveCheckRef.current = null;
  };
  const verifySaved = (id: string, expectedReplies: number): void => {
    cancelSaveCheck();
    const controller = new AbortController();
    saveCheckRef.current = controller;
    void fetchWithAuth(`/api/conversations/${id}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('verify_failed');
        return (await response.json()) as { messages?: Array<{ role: string }> };
      })
      .then((detail) => {
        const storedReplies = (detail.messages ?? []).filter(
          (candidate) => candidate.role === 'assistant',
        ).length;
        if (!controller.signal.aborted && storedReplies < expectedReplies) setSaveFailed(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSaveFailed(true);
      });
  };

  const { messages, sendMessage, setMessages, regenerate, status, error, stop, clearError } = useChat({
    id: conversationId ?? undefined,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/chat',
      headers: () => authHeaders(),
      prepareSendMessagesRequest: ({ messages: outgoing, trigger }) => {
        const capturedBinding = requestBindingRef.current;
        requestBindingRef.current = null;
        const turn = nextTurnRef.current;
        nextTurnRef.current = null;
        if (trigger === 'submit-message') {
          sentTurnRef.current = { ...turn, messageId: [...outgoing].reverse().find((candidate) => candidate.role === 'user')?.id };
        }
        return {
          body: buildChatRequestBody(conversationId, outgoing, turn ? 'submit-message' : trigger, turn?.edit, turn?.origin, turn?.workflowId, capturedBinding ? capturedBinding.binding : appBinding, turn?.resend),
        };
      },
    }),
    onError: (cause) => {
      if (disposedRef.current) return;
      const statusCode = (cause as Error & { status?: number }).status;
      if (statusCode === 401 || cause.message.includes('401')) {
        // The chat transport carries its own headers function, so it is not
        // fetchWithAuth; refresh once and let a failed refresh flip the
        // session gate to the sign-in screen.
        void handleUnauthorized();
      }
    },
    onFinish: ({ message, messages: settled, isError, isAbort, isDisconnect }) => {
      // A regenerate that errored or was stopped is over: the next reply, from
      // whatever send, is not another version of the answer it set out to replace.
      if (isError || isAbort || isDisconnect) pendingRegenRef.current = null;
      if (disposedRef.current) return;
      // Even a stopped or dropped reply is stored (partial) under a store-made id.
      if (message.role === 'assistant') setLiveReplyIds((prev) => new Set(prev).add(message.id));
      // Only an existing conversation is checked: a brand-new one is handed up
      // just below and the shell passes its id back to this same, still mounted,
      // surface, so the next turn posts it and hands-free carries on.
      if (conversationId && !isError && !isAbort && !isDisconnect) {
        verifySaved(conversationId, storableReplies(settled));
      }
      const metadata = (message as UIMessage & { metadata?: unknown }).metadata;
      if (
        !conversationId &&
        metadata &&
        typeof metadata === 'object' &&
        typeof (metadata as { conversationId?: unknown }).conversationId === 'string'
      ) {
        // useChat recreates its internal Chat store the instant `id` moves from
        // null to this new id, reseeding from `initialMessages` -- still empty
        // for a brand-new conversation. Hand the just-finished exchange up so
        // the parent can seed `restored` before that happens, or the reply that
        // streamed in a second ago disappears from view. `settled` is the
        // SDK's own list at finish; a ref synced by an effect can still be
        // empty here, since onFinish may run before that effect commits.
        const combined = settled.at(-1)?.id === message.id ? settled : [...settled, message];
        onConversationCreated((metadata as { conversationId: string }).conversationId, combined);
      }
      onConversationTouched({ succeeded: !isError && !isAbort && !isDisconnect });
    },
  });

  useEffect(() => {
    if (knownMessageIds) knownMessageIds.current = new Set(messages.map((message) => message.id));
  }, [knownMessageIds, messages]);

  // Prepends the next page of earlier messages, newest of them first. Keeping the
  // reader's place is left to ChatMessageList, which this is also handed to as
  // its scrollToTopAction (it runs that inside a transition).
  const loadEarlier = async (): Promise<void> => {
    const remaining = earlierRef.current;
    if (remaining.length === 0) return;
    const page = remaining.slice(-MESSAGE_WINDOW);
    earlierRef.current = remaining.slice(0, -MESSAGE_WINDOW);
    setEarlierCount(earlierRef.current.length);
    setMessages((current) => [...page, ...current]);
  };

  // useChat's `stop` is bound to the current Chat and changes when `id` does,
  // so the unmount cleanup reads it through a ref instead of closing over the
  // first one.
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  // Unmount abandons the request: stop it (the server persists a partial reply
  // either way) and mark the surface disposed so onFinish/onError, which still
  // fire for an aborted request, stay silent. StrictMode runs mount -> cleanup
  // -> mount on one instance in development, so mounting resets the flag; a
  // stop with nothing in flight is a no-op.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      saveCheckRef.current?.abort();
      void stopRef.current();
    };
  }, []);

  // The one members list for the whole surface. It is derived from the spaces
  // SpacesProvider already loaded, so it is built once here and passed down:
  // the composer gets the list and every message row gets the tokens derived
  // from it, instead of each one deriving its own. Because the landing and the
  // thread are branches of this same component, switching between them keeps
  // the list rather than rebuilding it.
  const members = useMentionMembers(conversationId ?? undefined);
  const mentionTokens = useMemo(() => members.map(mentionToken), [members]);

  const busy = status === 'submitted' || status === 'streaming';
  // Reported upward so the shell can hold an event-driven reload of this
  // conversation (it remounts the surface) until the turn has ended.
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  useEffect(() => {
    onBusyChangeRef.current?.(busy);
  }, [busy]);
  // Every new turn (a send, a Retry, a reply regeneration) starts clean: the
  // previous turn's notices go and an in-flight save check is abandoned.
  const beginTurn = (): void => {
    cancelSaveCheck();
    setSaveFailed(false);
    clearError();
    nextTurnRef.current = null;
    // Auth headers resolve asynchronously; each explicit send/retry pins its current target first.
    requestBindingRef.current = { binding: appBinding ? { ...appBinding } : undefined };
  };
  const sendTurn = (text: string, turn: NextTurn & { files?: FileUIPart[] } = {}): void => {
    beginTurn();
    nextTurnRef.current = { edit: turn.edit, origin: turn.origin, workflowId: turn.workflowId };
    void sendMessage({
      text,
      ...(turn.files?.length ? { files: turn.files } : {}),
      // Shown as the message's time; the request body never carries it.
      metadata: { createdAt: Date.now() },
    });
  };
  const send = (text: string, files?: FileUIPart[]): void => sendTurn(text, { files });
  const retry = (): void => {
    beginTurn();
    const sent = sentTurnRef.current;
    const tailMessage = messages.at(-1);
    if (sent && tailMessage?.role === 'user' && tailMessage.id === sent.messageId) {
      // An edit is safe to replay as it is: the server cuts back to its anchor
      // first, so a stored copy goes before the message is stored again.
      nextTurnRef.current = { edit: sent.edit, origin: sent.origin, workflowId: sent.workflowId, resend: !sent.edit };
    }
    void regenerate();
  };
  // #466: closing the stream no longer cancels the turn server-side (a timer
  // asked for must survive a closed tab), so an explicit Stop also tells the
  // server, by the id the turn was sent with. Unmount stays a plain stop().
  // A failed POST is not the reader's problem: the stream still stops.
  const stopTurn = (): void => {
    const newestUser = [...messages].reverse().find((candidate) => candidate.role === 'user');
    if (newestUser) {
      void fetchWithAuth('/api/chat/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: newestUser.id }),
      }).catch(() => undefined);
    }
    void stop();
  };
  // All voice wiring: the mic, hands-free, spoken replies and their notices.
  const voice = useChatVoice({
    conversationId,
    messages,
    busy,
    status,
    send: (text, origin, workflowId) => sendTurn(text, { origin, workflowId }),
    stop: stopTurn,
  });

  // Session reply versions retain the trace belonging to each generated text.
  const [versionState, setVersionState] = useState<Record<string, VersionEntry>>({});

  const turnKeyFor = (assistantIndex: number): string | null => {
    for (let index = assistantIndex; index >= 0; index -= 1) {
      if (messages[index]?.role === 'user') return messages[index].id;
    }
    return null;
  };

  const regenerateReply = (assistantIndex: number): void => {
    const turnKey = turnKeyFor(assistantIndex);
    const current = messages[assistantIndex];
    const currentText = current ? messageText(current) : '';
    if (!turnKey || !current || !currentText.trim()) return;
    setVersionState((prev) =>
      prev[turnKey] ? prev : { ...prev, [turnKey]: { versions: [currentText], traceIds: [messageTraceId(current)], active: 0 } },
    );
    pendingRegenRef.current = { key: turnKey, previousAssistantId: current.id };
    sentTurnRef.current = null;
    beginTurn();
    void regenerate();
  };

  useEffect(() => {
    const pending = pendingRegenRef.current;
    if (!pending || busy) return;
    // Never file a failed partial reply as a version.
    if (error) {
      pendingRegenRef.current = null;
      return;
    }
    const lastAssistant = [...messages].reverse().find((candidate) => candidate.role === 'assistant');
    const text = lastAssistant ? messageText(lastAssistant) : '';
    if (!lastAssistant || !text) return;
    // A new assistant id completes regeneration, including identical text.
    if (lastAssistant.id !== pending.previousAssistantId) {
      pendingRegenRef.current = null;
      setVersionState((prev) => {
        const entry = prev[pending.key];
        if (!entry) return prev;
        // Identical words from a new generation still belong to a new trace.
        return { ...prev, [pending.key]: {
          versions: [...entry.versions, text], traceIds: [...entry.traceIds, messageTraceId(lastAssistant)], active: entry.versions.length,
        } };
      });
      return;
    }
    setVersionState((prev) => {
      const entry = prev[pending.key];
      if (entry && entry.versions.at(-1) !== text) {
        const versions = [...entry.versions, text];
        return { ...prev, [pending.key]: { versions, traceIds: [...entry.traceIds, messageTraceId(lastAssistant)], active: versions.length - 1 } };
      }
      return prev;
    });
  }, [busy, messages, error]);

  const versionsFor = (index: number): MessageVersions | undefined => {
    const turnKey = turnKeyFor(index);
    const entry = turnKey ? versionState[turnKey] : undefined;
    if (!turnKey || !entry || entry.versions.length < 2) return undefined;
    return {
      texts: entry.versions,
      traceIds: entry.traceIds,
      active: entry.active,
      onSelect: (active) =>
        setVersionState((prev) =>
          prev[turnKey] ? { ...prev, [turnKey]: { ...prev[turnKey], active } } : prev,
        ),
    };
  };

  // Transient results go to a Toast, never a Banner above the composer.
  const toast = useToast();
  const copyFailed = (): void => {
    toast({ body: COPY_FAILED_NOTICE, uniqueID: 'chat-copy-failed' });
  };
  const copied = (): void => {
    toast({ body: 'Copied', uniqueID: 'chat-copied' });
  };
  // Delete-from-here: the user message index pending confirmation, whether the
  // delete request is in flight, and whether the last one failed.
  const [pendingDeleteIndex, setPendingDeleteIndex] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const confirmDelete = async (): Promise<void> => {
    if (pendingDeleteIndex === null || !conversationId) return;
    const index = pendingDeleteIndex;
    const target = messages[index];
    setDeleting(true);
    try {
      const response = await fetchWithAuth(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(target.id)}`,
        { method: 'DELETE' },
      );
      if (response.ok || response.status === 404) {
        const remaining = messages.slice(0, index);
        setMessages(remaining);
        if (remaining.length === 0 && earlierRef.current.length > 0) await loadEarlier();
        onConversationTouched();
      } else {
        toast({ body: DELETE_FAILED_NOTICE, type: 'error', uniqueID: 'chat-delete-failed' });
      }
    } catch {
      toast({ body: DELETE_FAILED_NOTICE, type: 'error', uniqueID: 'chat-delete-failed' });
    }
    setDeleting(false);
    setPendingDeleteIndex(null);
  };

  // `error` is only set while the last turn failed and useChat clears it as the
  // next request starts, so the failure notice needs no state of its own. A
  // turn streamed text before failing when the tail is an assistant reply with
  // text: a failed regenerate has already dropped the reply it replaces.
  const tail = messages.at(-1);
  const streamedBeforeError = tail?.role === 'assistant' && messageText(tail).trim() !== '';
  const notices: ChatNotice[] = [];
  if (error) {
    const text = turnFailedNotice(error, streamedBeforeError);
    // Out of credit cannot be retried: a Retry would only fail again.
    notices.push({
      id: 'turn-failed',
      tone: 'error',
      text,
      action:
        text === OUT_OF_CREDIT_NOTICE
          ? { label: 'See usage', onPress: () => navigateTo('/settings#usage') }
          : { label: 'Retry', onPress: retry },
    });
  } else if (!busy && tail?.role === 'user') {
    // `error` does not survive a reload and the server stores no reply for a
    // failed turn, so a reopened conversation can end on a bare user message.
    // The same Retry asks for its reply: regenerate() keeps a user tail.
    notices.push({
      id: 'turn-unanswered',
      tone: 'error',
      text: UNANSWERED_NOTICE,
      action: { label: 'Retry', onPress: retry },
    });
  }
  if (saveFailed && !busy) {
    notices.push({
      id: 'save-failed',
      tone: 'error',
      text: SAVE_FAILED_NOTICE,
      action: { label: 'Dismiss', onPress: () => setSaveFailed(false) },
    });
  }
  notices.push(...voice.notices);

  // The composer's way to put text in its box: the landing's suggestion cards
  // fill it (for the reader to edit and send) rather than send.
  const ownFillRef = useRef<((text: string) => void) | null>(null);
  const fillRef = composerFillRef ?? ownFillRef;
  // The notice region sits just above the composer, on the landing and in the
  // thread alike, so a notice never has to move the composer.
  const composerVoice = {
    state: voice.mode.state,
    micLive: voice.mode.micLive,
    start: () => void voice.mode.start(),
    stop: voice.mode.stop,
    mute: voice.mode.mute,
    unmute: voice.mode.unmute,
    onPointerDown: voice.mic.onPointerDown,
    onCaptureUnavailable: voice.mic.onCaptureUnavailable,
  };
  // On a phone an open chat has one header (the shell's top bar), so the
  // conversation's own actions sit on the composer's top row as icon buttons.
  const [collaborateOpen, setCollaborateOpen] = useState(false);
  const phoneActions =
    isMobile && conversationId && !embedded ? (
      <>
        <Button label="Tools" variant="ghost" size="sm" icon={<Icon icon={Wrench} size="sm" />} isIconOnly onClick={() => navigateTo(`/tools?conversationId=${encodeURIComponent(conversationId)}`)} />
        <Button label="Add people" variant="ghost" size="sm" icon={<Icon icon={Users} size="sm" />} isIconOnly onClick={() => setCollaborateOpen(true)} />
      </>
    ) : undefined;
  const composerWithNotices = (): ReactElement => (
    <VStack gap={2}>
      <NoticeRegion notices={notices} />
      <VoiceModeBar
        state={voice.mode.state}
        micLive={voice.mode.micLive}
        reason={voice.mode.reason}
        onStop={voice.mode.stop}
        onMute={voice.mode.mute}
        onUnmute={voice.mode.unmute}
        onResume={voice.mode.resume}
      />
      {phoneActions && conversationId ? (
        // #492 on a phone: the device's actions as one row above the composer.
        // It renders nothing while no device is paired, so there is no extra row.
        <DeviceHeaderControl device={device} target={{ conversationId }} statusKey="chat" />
      ) : null}
      <Composer
        busy={busy}
        draftKey={draftKey ?? conversationId ?? NEW_CHAT_DRAFT_KEY}
        placeholder={placeholder}
        fillRef={fillRef}
        focusRef={composerFocusRef}
        members={members}
        onSend={send}
        onStop={voice.stop}
        voice={composerVoice}
        phoneActions={phoneActions}
      />
      {phoneActions ? (
        <CollaborateDialog conversationId={conversationId} isOpen={collaborateOpen} onOpenChange={setCollaborateOpen} />
      ) : null}
      {voice.audioUrl ? (
        <SpokenReplyPlayer key={voice.audioUrl} src={voice.audioUrl} audioRef={voice.audioRef} />
      ) : null}
    </VStack>
  );

  if (messages.length === 0) {
    if (embedded) return composerWithNotices();
    return (
      <ChatLanding
        headerAction={<CollaborateButton conversationId={conversationId} />}
        userName={userName}
        composer={composerWithNotices()}
        onPrompt={(text) => fillRef.current?.(text)}
      />
    );
  }

  const lastIndex = messages.length - 1;
  // The edit /api/chat needs to resend the user message at `index`: the server
  // keeps the message before it and deletes the rest, or everything for the first
  // message. Only a message the server holds can be that anchor, so a
  // conversation with no id yet, or a reply streamed in this session, has none
  // and editing waits. An open conversation is reloaded from the server once its
  // turn ends (the shell does it on message.appended); a brand-new one is not.
  const editFor = (index: number): ChatEdit | null => {
    if (!conversationId) return null;
    if (index === 0) {
      // The thread opens on a window: while older messages are not loaded, the
      // first one shown is not the conversation's first, and editing "from the
      // start" would delete them. The last unloaded message is its anchor.
      const before = earlierRef.current.at(-1);
      return before ? { editFrom: before.id } : { editFromStart: true };
    }
    const anchor = messages[index - 1];
    return anchor && !liveReplyIds.has(anchor.id) ? { editFrom: anchor.id } : null;
  };
  // useChat's regenerate() acts on the last reply, so only that reply offers it.
  const lastUserIndex = messages.reduce(
    (found, candidate, index) => (candidate.role === 'user' ? index : found),
    -1,
  );
  const lastAssistantIndex = messages.reduce(
    (found, candidate, index) => (candidate.role === 'assistant' ? index : found),
    -1,
  );
  const phone = usePhoneChatLayout();
  const composer = (
    <VStack paddingInline={embedded ? undefined : phone.composerInset}>{composerWithNotices()}</VStack>
  );
  // ChatLayoutPanelChat uses the same transcript in a bounded embedded panel.
  const conversation = (
    <VStack height={embedded ? embeddedHeight : '100%'} gap={0}>
      <ChatLayout density={embedded ? 'compact' : phone.layout.density} composer={composer}>
        <DeviceNameProvider value={device.deviceName ?? null}>
        <ChatMessageList
          {...phone.list}
          isStreaming={busy}
          scrollToTopAction={earlierCount > 0 ? loadEarlier : undefined}
        >
          {earlierCount > 0 && (
            <HStack hAlign="center">
              <Button
                label="Load earlier messages"
                variant="secondary"
                size="sm"
                onClick={() => void loadEarlier()}
              />
            </HStack>
          )}
          {messages.map((message, index) => (
            <MessageView
              key={message.id}
              message={message}
              isStreaming={busy && index === lastIndex}
              mentionTokens={mentionTokens}
              busy={busy}
              editDisabled={editFor(index) === null}
              versions={message.role === 'assistant' ? versionsFor(index) : undefined}
              onRegenerate={index === lastAssistantIndex ? () => regenerateReply(index) : undefined}
              onEditResend={(newText) => {
                const edit = editFor(index);
                if (!edit) return;
                setMessages(messages.slice(0, index));
                sendTurn(newText, { edit });
              }}
              onDeleteFrom={
                conversationId && message.role === 'user' ? () => setPendingDeleteIndex(index) : undefined
              }
              onCopyFailure={copyFailed}
              onCopied={copied}
              showMoreActions={index === lastAssistantIndex || index === lastUserIndex}
            />
          ))}
          {status === 'submitted' && <ThinkingMessage />}
        </ChatMessageList>
        </DeviceNameProvider>
      </ChatLayout>
      <AlertDialog
        isOpen={pendingDeleteIndex !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDeleteIndex(null);
        }}
        title="Delete from here?"
        description="This message and everything after it will be permanently deleted. Memories already saved from them are kept."
        actionLabel="Delete messages"
        isActionLoading={deleting}
        onAction={confirmDelete}
      />
    </VStack>
  );
  if (embedded) return conversation;
  return (
    // The ai-chat template's frame: ChatLayout is full bleed and owns the
    // scroll, so its scrollbar sits at the pane's edge and a wheel anywhere in
    // the pane scrolls the conversation. Spacious density is what caps the
    // messages and the docked composer (800px, centred); PAGE_WIDTH is sized so
    // the landing's composer has the same edges. `padding={0}` is full bleed on
    // purpose here. The VStack gives ChatLayout's flex:1 root a real height, so
    // the composer stays docked and the scroll-to-bottom button keeps working.
    <Layout
      height="fill"
      header={
        // #492, #667: what the Cardputer is in, and the shared control to change it.
        conversationId && !isMobile ? (
          <LayoutHeader hasDivider label="Conversation">
            <Stack direction="horizontal" gap={2} vAlign="center" hAlign="between" paddingInline={3} paddingBlock={1}>
              <StackItem size="fill">
                <HStack gap={2} vAlign="center">
                  <StackItem size="fill">
                    <Heading level={1} maxLines={1}>
                      {conversationTitle?.trim() || 'Conversation'}
                    </Heading>
                  </StackItem>
                  <Button label="Tools" variant="ghost" size="sm" href={`/tools?conversationId=${encodeURIComponent(conversationId)}`} />
                  <CollaborateButton conversationId={conversationId} />
                </HStack>
              </StackItem>
              <StackItem size="fill">
                <DeviceHeaderControl device={device} target={{ conversationId }} statusKey="chat" />
              </StackItem>
            </Stack>
          </LayoutHeader>
        ) : undefined
      }
      content={
        <LayoutContent padding={0} isScrollable={false}>
          {/* Phone: the header row is gone, so the title rides here as the visually hidden h1. */}
          {conversationId && isMobile ? <PageTitle>{conversationTitle?.trim() || 'Conversation'}</PageTitle> : null}
          {conversation}
        </LayoutContent>
      }
    />
  );
}
