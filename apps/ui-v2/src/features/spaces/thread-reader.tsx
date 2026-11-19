import { usePagePadding } from '@/app/page-width';
import type { ChatAppBinding } from '@/features/chat/chat-surface';
import { BRAND } from '@/lib/brand';
import { useMemo, useState, type RefObject, type ReactElement, type ReactNode } from 'react';
import { Check, Copy, Pencil, Trash2 } from 'lucide-react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Button } from '@astryxdesign/core/Button';
import { ChatLayout, ChatMessageList, ChatTokenizedText, type ChatComposerToken } from '@astryxdesign/core/Chat';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { useClipboard } from '@astryxdesign/core/hooks';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Section } from '@astryxdesign/core/Section';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { VStack } from '@astryxdesign/core/VStack';
import { useSession } from '@/lib/auth/use-session';
import { memberDisplayName } from '@/lib/display-name';
import type { MentionMember } from '@/features/chat/use-mention-picker';
import type { AskBobOutcome, Thread, ThreadMessage, useThreads } from '@/features/spaces/use-threads';
import type { Space } from '@/features/spaces/use-spaces';
import { HttpError } from '@/lib/query-client';
import type { FileUIPart, UIMessage } from 'ai';
import { ContextMenu } from '@astryxdesign/core/ContextMenu';
import { Composer } from '../chat/composer';
import { PhoneMoreActions, replyMenuItems, type MessageMenuItems } from '../chat/message-actions';
import { SpokenReplyPlayer } from '@/features/voice/spoken-reply-player';
import { useChatVoice } from '@/features/voice/use-chat-voice';
import { VoiceModeBar } from '@/features/voice/voice-mode-bar';
import { AssistantAvatar, MessageBubble, ThinkingMessage } from '../chat/message-view';
import { addressesBob, mentionToken, normalizeComposerText } from '../chat/mentions';
import { platformMentions } from '../chat/platform-mentions';
import { RichMarkdown } from '../chat/rich-markdown';
import { usePhoneChatLayout } from '../chat/chat-layout-props';
import { SPACE_GUTTER } from './space-header';

const MESSAGES_ERROR = 'Messages could not be loaded.';
const POST_ERROR = 'Your message could not be posted.';
const MESSAGE_EDIT_ERROR = 'Your edit could not be saved.';
const MESSAGE_DELETE_ERROR = 'That message could not be deleted.';

// The assistant is not a space member, so it gets a synthetic entry the @ menu
// lists alongside the people; picking it inserts the literal '@bob'.
const BOB_MENTION: MentionMember = {
  user_id: 'bob',
  role: 'assistant',
  display_name: BRAND.assistantName,
  handle: 'bob',
  email: null,
};

// The same split MessageView makes: what a person wrote keeps its mention
// badges (the real member tokens the composer itself inserts, exactly as a
// personal chat's own messages do -- not every `@word` run), what Bob wrote
// goes through the shared markdown renderer, so a thread reply is formatted
// exactly like the same reply in the main chat.
function MessageBody({ message, mentionTokens }: { message: ThreadMessage; mentionTokens: ChatComposerToken[] }): ReactElement {
  if (message.author_user_id === null) {
    return <RichMarkdown density="compact">{message.body}</RichMarkdown>;
  }
  return (
    <Text as="div">
      <ChatTokenizedText tokens={mentionTokens}>{message.body}</ChatTokenizedText>
    </Text>
  );
}

/**
 * A thread message is text on the wire (`{ body }`), so a file attached in
 * the shared composer travels as its name rather than being dropped silently.
 * Uploading thread attachments needs a server change (requested from chat).
 */
function withAttachmentNames(text: string, files?: FileUIPart[]): string {
  if (!files || files.length === 0) return text;
  const names = files.map((file) => `[${file.filename ?? 'attachment'}]`).join(' ');
  return text === '' ? names : `${text} ${names}`;
}

function memberCount(space: Space): string {
  const count = space.members.length;
  return `${count} member${count === 1 ? '' : 's'}`;
}

// What a screen reader hears before a message's body: who wrote it, who it
// reached, and whether it is still on its way. Sighted readers get the same
// from the side the bubble hangs on, the name above it and the header.
function messageLabel({
  authorName,
  isMine,
  pending,
  deleted,
  space,
}: {
  authorName: string;
  isMine: boolean;
  pending: boolean;
  deleted: boolean;
  space: Space;
}): string {
  const who = isMine ? 'You' : authorName;
  const state = pending ? ', sending' : deleted ? ', deleted' : '';
  return `${who} to ${space.name} (${memberCount(space)})${state}: `;
}

// Someone else saved the message between opening the editor and saving it.
const MESSAGE_EDIT_CONFLICT =
  'That message changed while you were editing it. Your edit is still open: save again to replace it.';

function isConflict(cause: unknown): boolean {
  return cause instanceof HttpError && cause.status === 409;
}

function InlineActions({
  canCopy,
  canManage,
  isCopied,
  onCopy,
  onEdit,
  onDelete,
}: {
  canCopy: boolean;
  canManage: boolean;
  isCopied: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): ReactElement {
  return (
    <HStack gap={1} vAlign="center">
      {canCopy && (
        <IconButton
          label={isCopied ? 'Copied' : 'Copy message'}
          tooltip="Copy"
          variant="ghost"
          size="sm"
          icon={<Icon icon={isCopied ? Check : Copy} size="sm" />}
          onClick={onCopy}
        />
      )}
      {canManage && (
        <>
          <IconButton label="Edit this message" tooltip="Edit" variant="ghost" size="sm" icon={<Icon icon={Pencil} size="sm" />} onClick={onEdit} />
          <IconButton label="Delete this message" tooltip="Delete" variant="ghost" size="sm" icon={<Icon icon={Trash2} size="sm" />} onClick={onDelete} />
        </>
      )}
    </HStack>
  );
}

function latestIdPerAuthor(messages: ThreadMessage[]): Set<string> {
  const latest = new Map<string | null, string>();
  for (const message of messages) latest.set(message.author_user_id, message.id);
  return new Set(latest.values());
}

// The desktop meta row under a bubble: the time, an edited note, the origin and the inline actions.
function metaRow(
  message: ThreadMessage,
  actions: ReactNode,
): { timestamp: ReactNode; origin: ThreadMessage['origin']; editedLabel: ReactNode; actions: ReactNode } {
  return {
    timestamp: <Timestamp value={message.created_at} format="relative" />,
    origin: message.origin,
    editedLabel: message.revision > 1 ? <Text type="supporting">edited</Text> : undefined,
    actions,
  };
}

// The long-press menu: Copy for anyone, Edit and Delete when the reader manages the message.
function phoneMenuItems(body: string, enabled: boolean, manage: { startEdit: () => void; onDelete: () => void } | null): MessageMenuItems {
  if (!enabled) return [];
  return [
    ...replyMenuItems({ text: body, busy: false }),
    ...(manage
      ? [
          { label: 'Edit', icon: Pencil, onClick: manage.startEdit },
          { label: 'Delete', icon: Trash2, variant: 'destructive' as const, onClick: manage.onDelete },
        ]
      : []),
  ];
}

// `isMine` is which side the message hangs on and is decided by authorship
// alone, exactly as MessageView decides it from the message role -- so an
// optimistic post and a tombstone stay on the reader's side instead of
// jumping. `canManage` is the permission to edit or delete it, which a pending
// or deleted message does not carry.
function MessageItem({
  message,
  authorName,
  isMine,
  canManage,
  label,
  mentionTokens,
  isPhone,
  showMoreActions,
  onEdit,
  onDelete,
  onConflict,
}: {
  message: ThreadMessage;
  authorName: string;
  isMine: boolean;
  canManage: boolean;
  isPhone: boolean;
  // Phone: the latest message of each sender carries the visible More actions button.
  showMoreActions: boolean;
  // Read before the body: see messageLabel.
  label: string;
  mentionTokens: ChatComposerToken[];
  onEdit: (body: string) => Promise<void>;
  onDelete: () => void;
  // A 409 on save, and its clearing. The reader announces it in its one
  // status region; the draft stays open in the editor either way.
  onConflict: (conflicted: boolean) => void;
}): ReactElement {
  const deleted = message.tombstoned_at !== null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const { copy, isCopied } = useClipboard({ announce: 'Copied' });

  const startEdit = (): void => {
    setDraft(message.body);
    setFailed(false);
    setEditing(true);
  };

  const cancelEdit = (): void => {
    setEditing(false);
    setFailed(false);
    onConflict(false);
  };

  const saveEdit = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (trimmed === '') return;
    onConflict(false);
    if (trimmed === message.body) {
      setEditing(false);
      setFailed(false);
      return;
    }
    setSaving(true);
    try {
      await onEdit(trimmed);
      setEditing(false);
      setFailed(false);
    } catch (cause) {
      if (isConflict(cause)) onConflict(true);
      else setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  // Inline, as the main chat puts them: edit and delete under your own
  // message, copy under any message with a body. Nothing is left for a `···`
  // menu, so the thread no longer hides its actions behind one.
  const actions = (
    <InlineActions
      canCopy={!deleted && !editing}
      canManage={canManage && !editing}
      isCopied={isCopied}
      onCopy={() => void copy(message.body)}
      onEdit={startEdit}
      onDelete={onDelete}
    />
  );

  // The same shared bubble a personal conversation renders through
  // (message-view.tsx's MessageBubble): the thread maps its own row -- a
  // human or an admin-moderated author, an in-place edit, a tombstone -- into
  // its props instead of a second hand-built component. `origin` (SPACE-MSG-ORIGIN)
  // reuses the same "via Cardputer"/"spoken" note a personal chat shows.
  // Phone: the same rule as the main chat's message-view -- no meta row under the
  // bubble; the actions open on long-press (a bottom sheet) and the latest
  // message per sender also shows the compact More actions button.
  const phoneItems = phoneMenuItems(message.body, isPhone && !deleted && !editing, canManage ? { startEdit, onDelete } : null);
  const bubble = (
    <MessageBubble
      isMine={isMine}
      avatar={message.author_user_id === null ? <AssistantAvatar /> : <Avatar name={authorName} size="sm" />}
      authorName={authorName}
      {...(isPhone
        ? { timestamp: undefined, actions: showMoreActions ? <PhoneMoreActions items={phoneItems} /> : undefined }
        : metaRow(message, actions))}
      hiddenLabel={label}
    >
      {deleted ? (
        <Text type="supporting">Message deleted</Text>
      ) : editing ? (
        <VStack gap={1}>
          <TextArea
            label="Edit message"
            isLabelHidden
            hasAutoFocus
            value={draft}
            onChange={setDraft}
            width="100%"
          />
          <HStack gap={2} hAlign="end">
            <Button label="Cancel edit" variant="secondary" size="sm" onClick={cancelEdit} />
            <Button
              label="Save edit"
              size="sm"
              isDisabled={saving || draft.trim() === ''}
              onClick={() => void saveEdit()}
            />
          </HStack>
          {failed && <Text role="alert">{MESSAGE_EDIT_ERROR}</Text>}
        </VStack>
      ) : (
        <MessageBody message={message} mentionTokens={mentionTokens} />
      )}
    </MessageBubble>
  );
  return phoneItems.length > 0 ? (
    <ContextMenu label="Message actions" presentation="bottom-sheet" items={phoneItems}>{bubble}</ContextMenu>
  ) : bubble;
}

type AskState = 'thinking' | Exclude<AskBobOutcome, 'answered'>;

// What the thread's status line says after Bob stops short of an answer on
// an @bob trigger. While she is still answering, the message list shows the
// main chat's own ThinkingMessage instead; a failure is an alert, not a status.
// There is no Cancel control: the server cannot cancel a run yet.
const BOB_NOTICE: Record<Exclude<AskState, 'thinking' | 'failed'>, string> = {
  conflict: 'This request changed or Bob is already answering. Review the current campaign, then send a new request.',
  busy: `${BRAND.name} is already answering in this thread. Ask again when that reply lands.`,
  cancelled: `${BRAND.name} stopped before answering.`,
  pending: `${BRAND.name} is still working on it. Reopen the thread to see the reply.`,
};

export function ThreadReader({
  space,
  thread,
  threads,
  requireMention = false,
  deviceRow,
  phoneActions, appBinding, fillRef, focusRef, placeholder, embeddedHeight, onBusyChange, onInvocationComplete,
}: {
  appBinding?: ChatAppBinding;
  fillRef?: RefObject<((text: string) => void) | null>;
  focusRef?: RefObject<(() => void) | null>;
  placeholder?: string;
  embeddedHeight?: string;
  onBusyChange?: (busy: boolean) => void;
  onInvocationComplete?: (turn: { succeeded: boolean }) => void;
  space: Space;
  thread: Thread;
  threads: ReturnType<typeof useThreads>;
  requireMention?: boolean;
  // Phone only: extra icon buttons for the composer's top row.
  phoneActions?: ReactNode;
  // Phone only: the paired device's compact row, shown directly above the composer.
  deviceRow?: ReactNode;
}): ReactElement {
  const { session } = useSession();
  const selfId = session?.user?.id ?? null;
  const isActive = threads.activeThreadId === thread.id;
  // The one phone chat frame, shared with the main chat: compact messages from
  // the top, a single-row composer inset to the 16px gutter.
  const phone = usePhoneChatLayout();
  const pagePadding = usePagePadding();
  const isPhone = phone.isMobile;
  const messagesState = isActive ? threads.messagesState : 'loading';
  const [asking, setAsking] = useState<AskState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ThreadMessage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postFailed, setPostFailed] = useState(false);

  // The latest message of each author, as the main chat marks its latest per sender.
  const latestPerSender = useMemo(() => latestIdPerAuthor(threads.messages), [threads.messages]);

  const mentionMembers = useMemo((): MentionMember[] => {
    const hasBob = space.members.some((member) => member.handle.toLowerCase() === BOB_MENTION.handle);
    return hasBob ? space.members : [...space.members, BOB_MENTION];
  }, [space.members]);
  // The same tokens the composer itself inserts (chat/mentions' mentionToken),
  // so a posted message badges only real members and Bob, exactly as a
  // personal chat's own messages do -- built once here, like ChatSurface does
  // for the main chat, rather than every message row deriving its own.
  const mentionTokens = useMemo(() => platformMentions(mentionMembers).map(mentionToken), [mentionMembers]);

  // #862: alone in the space, there is no one else a plain message could be
  // for, so every message reaches Bob exactly as a personal chat's does.
  // With others present, silence would mean she replies to people mid
  // conversation unasked, so only an explicit @bob still asks her.
  // Empty members (failed load, just-created space) = unknown state, require @bob.
  const isSoleMember = space.members.length === 1 && space.members[0].user_id === selfId;
  const shouldAskBob = (body: string): boolean => Boolean(appBinding) || addressesBob(body) || (!requireMention && isSoleMember);

  const ask = async (trigger: ThreadMessage, binding = appBinding): Promise<void> => {
    onBusyChange?.(true);
    setAsking('thinking');
    try {
      const outcome = await (binding ? threads.askBob(trigger, binding) : threads.askBob(trigger));
      onInvocationComplete?.({ succeeded: outcome === 'answered' });
      setAsking(outcome === 'answered' ? null : outcome);
    } catch {
      setAsking('failed');
      onInvocationComplete?.({ succeeded: false });
    } finally { onBusyChange?.(false); }
  };

  // Rejects on a failed post so the shared composer restores the typed text,
  // exactly as it already does for a busy turn or an oversized attachment.
  const submitMessage = async (value: string): Promise<void> => {
    const body = normalizeComposerText(value);
    if (body === '' || posting) return;
    const binding = appBinding ? { ...appBinding } : undefined;
    setPosting(true);
    onBusyChange?.(true);
    setPostFailed(false);
    try {
      const posted = await threads.postMessage(body);
      if (shouldAskBob(body)) void ask(posted, binding); // not awaited: the composer clears and stays usable
    } catch (cause) {
      setPostFailed(true);
      onBusyChange?.(false);
      throw cause;
    } finally {
      setPosting(false);
      if (!shouldAskBob(body)) onBusyChange?.(false);
    }
  };

  const confirmDeleteMessage = async (): Promise<void> => {
    if (pendingDelete === null) return;
    setDeleting(true);
    try {
      await threads.deleteMessage(pendingDelete.id);
      setDeleteFailed(false);
      setPendingDelete(null);
    } catch {
      setDeleteFailed(true);
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  // One status region for the whole thread, mounted from the first render
  // (a region inserted together with its text is not announced) and saying the
  // one thing that matters most now: a send on its way, an edit that lost a
  // race, what came of asking Bob, or that the messages are still loading.
  const [editConflict, setEditConflict] = useState(false);
  const statusText = posting
    ? `Sending your message to ${space.name}…`
    : editConflict
      ? MESSAGE_EDIT_CONFLICT
      : asking !== null && asking !== 'thinking' && asking !== 'failed'
        ? BOB_NOTICE[asking]
        : messagesState === 'loading'
          ? 'Loading messages…'
          : '';

  // Voice mode speaks Bob's thread replies the same way main chat does: the
  // thread's rows are mapped to the chat's message shape for the voice hook,
  // and a spoken turn is posted like a typed one, addressed to Bob.
  const voiceMessages = useMemo(
    (): UIMessage[] =>
      threads.messages.map((message) => ({
        id: message.id,
        role: message.author_user_id === null ? 'assistant' : 'user',
        parts: [{ type: 'text', text: message.body }],
      })),
    [threads.messages],
  );
  const askingNow = asking === 'thinking' || posting;
  const voice = useChatVoice({
    conversationId: thread.id,
    messages: voiceMessages,
    busy: askingNow,
    status: askingNow ? 'streaming' : 'ready',
    send: (text) => void submitMessage((!requireMention && isSoleMember) || addressesBob(text) ? text : `@bob ${text}`).catch(() => undefined),
    stop: () => undefined,
  });
  const composerVoice = {
    state: voice.mode.state,
    micLive: voice.mode.micLive,
    start: () => void voice.mode.start(),
    stop: voice.mode.stop,
    mute: voice.mode.mute,
    unmute: voice.mode.unmute,
    onPointerDown: voice.mic.onPointerDown,
  };

  const composer = (
    <VStack gap={2} paddingInline={embeddedHeight ? undefined : phone.composerInset}>
      <Text type="supporting" role="status">
        {statusText}
      </Text>
      {asking === 'failed' && <Text role="alert">{BRAND.name} could not answer. Try asking again.</Text>}
      {voice.notices.map((notice) => (
        <Text key={notice.id} type="supporting" role={notice.tone === 'error' ? 'alert' : undefined}>
          {notice.text}
        </Text>
      ))}
      <VoiceModeBar
        state={voice.mode.state}
        micLive={voice.mode.micLive}
        reason={voice.mode.reason}
        onStop={voice.mode.stop}
        onMute={voice.mode.mute}
        onUnmute={voice.mode.unmute}
        onResume={voice.mode.resume}
      />
      {deviceRow}
      {/* The one composer, in main chat's config: attach, @, Dictate, Voice
          mode, a draft per thread and the default placeholder. A thread post
          carries text only, so attachments go into the text as their names. */}
      <Composer
        fillRef={fillRef}
        focusRef={focusRef}
        placeholder={placeholder}
        draftKey={thread.id}
        inputLabel="Message"
        isDisabled={posting}
        members={mentionMembers}
        onSend={(text, files) => submitMessage(withAttachmentNames(text, files))}
        status={postFailed ? { type: 'error', message: POST_ERROR } : undefined}
        voice={composerVoice}
        phoneActions={phoneActions}
      />
      {voice.audioUrl ? (
        <SpokenReplyPlayer key={voice.audioUrl} src={voice.audioUrl} audioRef={voice.audioRef} />
      ) : null}
    </VStack>
  );

  // Loading says so in the status region above the composer, not here too.
  const emptyState =
    messagesState === 'loading' ? undefined : messagesState === 'failed' ? (
      <Text role="alert">{MESSAGES_ERROR}</Text>
    ) : (
      <EmptyState
        title="No messages yet"
        description={requireMention ? 'Anyone in this chat can start it — post the first message below.' : 'Anyone in this space can start it — post the first message below.'}
      />
    );

  return (
    // Section, not a bare <section>: ChatLayout's root is `flex: 1` and docks
    // its composer to the bottom of the container it fills, so it needs a flex
    // column with a real height above it. A bare <section> has neither, which
    // left the composer sitting on the bottom of the messages instead of the
    // pane. Section carries the landmark and the height; the VStack is the
    // column. Its padding is the space's gutter, re-applied after the Section
    // escapes the page's, so the messages and ChatLayout's docked composer sit
    // in the header's column exactly as the main chat's do in its LayoutContent.
    // On a phone the messages and the composer take the main chat's 16px gutter (spacing 4), not the 24px desktop one.
    <Section variant="transparent" padding={embeddedHeight ? pagePadding : isPhone ? 0 : SPACE_GUTTER} height={embeddedHeight ?? '100%'} role="region" aria-label="Thread messages">
      <VStack height="100%" gap={0}>
        {deleteFailed && <Text role="alert">{MESSAGE_DELETE_ERROR}</Text>}
        {/* spacious density caps the messages and the docked composer at
            800px, centred, exactly as PAGE_WIDTH documents for the main chat
            (#899): SpacesPage now renders this full bleed, so without this
            the thread would stretch past every other page's content width. */}
        <ChatLayout {...phone.layout} density={embeddedHeight ? 'compact' : phone.layout.density} composer={composer} emptyState={emptyState}>
          {messagesState === 'ready' ? (
            <ChatMessageList {...phone.list}>
              {threads.messages.map((message) => {
                // An optimistic post carries a placeholder author until the
                // server answers, but it is the reader's own message and
                // belongs on their side from the first frame.
                const pending = message.id.startsWith('pending-');
                const authored = selfId !== null && message.author_user_id === selfId;
                const isMine = pending || authored;
                const canManage = authored && message.tombstoned_at === null && !pending;
                const authorName = memberDisplayName(space.members, message.author_user_id);
                return (
                  <MessageItem
                    key={message.id}
                    message={message}
                    authorName={authorName}
                    isMine={isMine}
                    canManage={canManage}
                    label={messageLabel({
                      authorName,
                      isMine,
                      pending,
                      deleted: message.tombstoned_at !== null,
                      space,
                    })}
                    mentionTokens={mentionTokens}
                    isPhone={isPhone}
                    showMoreActions={latestPerSender.has(message.id)}
                    onConflict={setEditConflict}
                    // An edit that newly addresses Bob asks her, as a fresh
                    // post does: the reader who forgot the `@` fixes the
                    // message, not re-posts it. One that already did is not
                    // asked again, so fixing a typo never duplicates a reply.
                    onEdit={(body) =>
                      threads.editMessage(message.id, body).then((edited) => {
                        if (shouldAskBob(body) && !shouldAskBob(message.body)) void ask(edited);
                      })
                    }
                    onDelete={() => setPendingDelete(message)}
                  />
                );
              })}
              {asking === 'thinking' && <ThinkingMessage />}
            </ChatMessageList>
          ) : null}
        </ChatLayout>
        <AlertDialog
          isOpen={pendingDelete !== null}
          onOpenChange={(open) => {
            if (!open && !deleting) setPendingDelete(null);
          }}
          title="Delete this message?"
          description="Everyone in the thread will see that a message was deleted. Replies after it stay."
          actionLabel="Delete message"
          isActionLoading={deleting}
          onAction={confirmDeleteMessage}
        />
      </VStack>
    </Section>
  );
}
