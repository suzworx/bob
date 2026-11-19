import { BRAND } from '@/lib/brand';
import {
  AssistantActions,
  PhoneMoreActions,
  VersionSelector,
  replyMenuItems,
  type MessageMenuItems,
  type MessageVersions,
} from './message-actions';
export type { MessageVersions } from './message-actions';
import { messageTraceId } from '@/features/metrics/reply-feedback';
import {
  createContext,
  useContext,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { FileUIPart, UIMessage } from 'ai';
import {
  Bell,
  CalendarDays,
  ListChecks,
  Paperclip,
  Pencil,
  StickyNote,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatToolCalls,
  ChatTokenizedText,
  type ChatComposerToken,
  type ChatToolCallItem,
} from '@astryxdesign/core/Chat';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { ContextMenu } from '@astryxdesign/core/ContextMenu';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Thumbnail } from '@astryxdesign/core/Thumbnail';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { Token } from '@astryxdesign/core/Token';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import { VStack } from '@astryxdesign/core/VStack';
import { useOptionalSpaces } from '@/features/spaces/use-spaces';
import { BrandMark } from '../../app/brand-mark';
import { Reasoning } from './reasoning';
import { RichMarkdown } from './rich-markdown';
import { navigateTo, resourcePath, type ResourceKind } from '../../app/routes';
import { hasSavedWeek, isToolPart, toAppProposals, toResourceRef, toToolCall, type ResourceRef } from './tool-calls';
import { AppProposal } from './app-proposal';

type Segment =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tools'; key: string; calls: ChatToolCallItem[] }
  | { kind: 'reasoning'; key: string; text: string; streaming: boolean }
  | { kind: 'stub'; key: string };

// The text of a message: its text parts joined, nothing else.
export function messageText(message: UIMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

// Set by the shell from the stored message's origin when a conversation opens
// (and, once CONV-VIEW-ONE's API finding is addressed, the same field a space
// message would carry): a device turn or one spoken to the web mic gets a
// small note beside its timestamp; a typed one gets none.
export type MessageOrigin = 'web_text' | 'web_voice' | 'device';

function originOf(message: UIMessage): MessageOrigin | undefined {
  const origin = (message.metadata as { origin?: unknown } | undefined)?.origin;
  return origin === 'device' || origin === 'web_voice' || origin === 'web_text' ? origin : undefined;
}

// A device turn is named after the device it came from; with no name known it
// says "via your device", never a hardware model.
function originNoteText(origin: MessageOrigin | undefined, deviceName?: string | null): string | null {
  if (origin === 'device') return `via ${deviceName?.trim() || 'your device'}`;
  if (origin === 'web_voice') return 'spoken';
  return null;
}

// The paired device's name for "via <name>" notes, set once by the surface
// that knows it (ChatSurface reads it from the device hook).
const DeviceNameContext = createContext<string | null>(null);
export const DeviceNameProvider = DeviceNameContext.Provider;

// Shared by the main chat and a space conversation (see MessageBubble below):
// whichever one carries a message's origin maps it to the same word, in the
// same place next to the timestamp. Plain text: it is history, not news, so it
// is not a live region announced for every message.
function OriginNote({ origin }: { origin?: MessageOrigin }): ReactElement | null {
  const deviceName = useContext(DeviceNameContext);
  const label = originNoteText(origin, deviceName);
  if (label === null) return null;
  return <Text type="supporting">{label}</Text>;
}

// When the message was sent, from `metadata.createdAt` (epoch ms): the shell
// sets it from the stored message, a live turn from when it was sent or began
// streaming. Null when neither is known.
function sentAt(message: UIMessage): number | null {
  const createdAt = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt;
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null;
}

// The message's time, as the ai-chat template shows it: the time alone for
// today, the date too for anything older.
function SentTime({ at }: { at: number }): ReactElement {
  const isToday = new Date(at).toDateString() === new Date().toDateString();
  return <Timestamp value={new Date(at).toISOString()} format={isToday ? 'time' : 'date_time'} />;
}

// Parts stay in order; consecutive tool parts fold into one segment. Reasoning
// and the local-stub marker get their own segments; every other part type
// (file, source-*, step-start, other data-*) is skipped.
function toSegments(message: UIMessage): Segment[] {
  const segments: Segment[] = [];
  message.parts.forEach((part, index) => {
    if (part.type === 'text') {
      if (part.text.trim() === '') return;
      segments.push({ kind: 'text', key: `${message.id}:${index}`, text: part.text });
    } else if (part.type === 'reasoning') {
      const streaming = part.state === 'streaming';
      if (part.text.trim() === '' && !streaming) return;
      segments.push({ kind: 'reasoning', key: `${message.id}:${index}`, text: part.text, streaming });
    } else if (part.type === 'data-stub') {
      segments.push({ kind: 'stub', key: `${message.id}:${index}` });
    } else if (isToolPart(part)) {
      const previous = segments.at(-1);
      if (previous?.kind === 'tools') previous.calls.push(toToolCall(part));
      else segments.push({ kind: 'tools', key: `${message.id}:${index}`, calls: [toToolCall(part)] });
    }
  });
  return segments;
}

// Every item the reply's tools created or changed, once each, in call order.
function toResources(message: UIMessage): ResourceRef[] {
  const seen = new Set<string>();
  return message.parts.flatMap((part) => {
    const ref = isToolPart(part) ? toResourceRef(part) : null;
    if (ref === null || seen.has(`${ref.kind}:${ref.id}`)) return [];
    seen.add(`${ref.kind}:${ref.id}`);
    return [ref];
  });
}

function appProposals(message: UIMessage, isStreaming: boolean, shown?: MessageVersions): ReturnType<typeof toAppProposals> {
  if (isStreaming || (shown && shown.active !== shown.texts.length - 1)) return [];
  const proposals = message.parts.flatMap((part) => isToolPart(part) ? toAppProposals(part) : []);
  return [...new Map(proposals.map((proposal) => [proposal.id, proposal])).values()];
}

function WeekReady({ message, isStreaming }: { message: UIMessage; isStreaming: boolean }): ReactElement | null {
  if (isStreaming || !message.parts.some((part) => isToolPart(part) && hasSavedWeek(part))) return null;
  return <Text role="status" type="supporting">Your week is ready to review.</Text>;
}

const RESOURCE_LABELS: Record<ResourceKind, string> = {
  task: 'Task',
  event: 'Event',
  note: 'Note',
  reminder: 'Reminder',
};

const RESOURCE_ICONS: Record<ResourceKind, LucideIcon> = {
  task: ListChecks,
  event: CalendarDays,
  note: StickyNote,
  reminder: Bell,
};

// One chip per item, opening it in its space. A space the reader is no longer
// in (once the list has loaded) makes the chip inert and says so, rather than
// linking to a page that cannot open.
function ResourceChips({ refs }: { refs: ResourceRef[] }): ReactElement {
  const spaces = useOptionalSpaces();
  const known = spaces !== null && (spaces.state === 'ready' || spaces.state === 'empty');
  return (
    <HStack gap={2} wrap="wrap">
      {refs.map((ref) => {
        const label = ref.title ?? RESOURCE_LABELS[ref.kind];
        const icon = <Icon icon={RESOURCE_ICONS[ref.kind]} size="sm" />;
        const left = known && !spaces.spaces.some((space) => space.id === ref.spaceId);
        return left ? (
          <Token
            key={ref.key}
            size="sm"
            label={label}
            icon={icon}
            isDisabled
            description="Unavailable: you are no longer in this space"
            endContent={<Text type="supporting">Unavailable</Text>}
          />
        ) : (
          <Token
            key={ref.key}
            size="sm"
            label={label}
            icon={icon}
            description={`Open this ${RESOURCE_LABELS[ref.kind].toLowerCase()} in its space`}
            onClick={() => navigateTo(resourcePath(ref.spaceId, ref.kind))}
          />
        );
      })}
    </HStack>
  );
}

// On a phone there is no avatar column: the assistant's text starts at the
// page gutter (about a fifth of the width otherwise goes to the avatar).
function useAvatarColumn(): boolean {
  return !useAppShellMobile().isMobile;
}

export function AssistantAvatar(): ReactElement {
  return <Icon icon={BrandMark} size="md" label={BRAND.assistantName} />;
}

// The one message bubble a space conversation renders through (CONV-VIEW-ONE):
// same avatar/name/bubble/metadata/origin-note shape as a personal chat's own
// messages, with the thread's multi-author name, edit/delete actions and a11y
// label handed in as props instead of a second hand-built component. A thread
// message's shape (revisions, tombstones) legitimately differs from UIMessage,
// so the caller maps its own row into these props rather than this component
// understanding both.
export function MessageBubble({
  isMine,
  avatar,
  authorName,
  timestamp,
  origin,
  editedLabel,
  actions,
  hiddenLabel,
  children,
}: {
  isMine: boolean;
  avatar?: ReactElement;
  authorName?: string | null;
  timestamp: ReactNode;
  origin?: MessageOrigin;
  editedLabel?: ReactNode;
  actions?: ReactNode;
  hiddenLabel?: string;
  children: ReactNode;
}): ReactElement {
  const hasAvatarColumn = useAvatarColumn();
  return (
    <ChatMessage sender={isMine ? 'user' : 'assistant'} avatar={isMine || !hasAvatarColumn ? undefined : avatar}>
      <ChatMessageBubble
        name={
          !isMine && authorName ? (
            <Text type="supporting" weight="semibold" color="secondary">
              {authorName}
            </Text>
          ) : undefined
        }
        metadata={
          <ChatMessageMetadata
            timestamp={timestamp}
            footer={
              <HStack gap={1} vAlign="center">
                {editedLabel}
                <OriginNote origin={origin} />
                {actions}
              </HStack>
            }
          />
        }
      >
        {hiddenLabel && <VisuallyHidden>{hiddenLabel}</VisuallyHidden>}
        {children}
      </ChatMessageBubble>
    </ChatMessage>
  );
}

export function ThinkingMessage(): ReactElement {
  const hasAvatarColumn = useAvatarColumn();
  return (
    <ChatMessage sender="assistant" avatar={hasAvatarColumn ? <AssistantAvatar /> : undefined}>
      <ChatMessageBubble variant="ghost">
        <HStack gap={2} vAlign="center">
          <Spinner size="sm" aria-label="Thinking" />
          <Text type="supporting">Thinking…</Text>
        </HStack>
      </ChatMessageBubble>
    </ChatMessage>
  );
}

function fileParts(message: UIMessage): FileUIPart[] {
  return message.parts.filter((part): part is FileUIPart => part.type === 'file');
}

// What the reader attached: images as thumbnails, any other file as its name.
function Attachments({ files }: { files: FileUIPart[] }): ReactElement {
  return (
    <HStack gap={2} wrap="wrap">
      {files.map((file, index) =>
        file.mediaType.startsWith('image/') ? (
          <Thumbnail
            key={index}
            src={file.url}
            alt={file.filename ?? 'Attached image'}
            label={file.filename ?? 'Attached image'}
          />
        ) : (
          <Token
            key={index}
            size="sm"
            label={file.filename ?? 'Attached file'}
            icon={<Icon icon={Paperclip} size="sm" />}
          />
        ),
      )}
    </HStack>
  );
}

// The phone menu of a user message: the long-press sheet and the More actions button share it.
function userMenuItems({ busy, editDisabled, onEdit, onDeleteFrom }: {
  busy: boolean;
  editDisabled: boolean;
  onEdit?: () => void;
  onDeleteFrom?: () => void;
}): MessageMenuItems {
  return [
    ...(onEdit ? [{ label: 'Edit', icon: Pencil, isDisabled: busy || editDisabled, onClick: onEdit }] : []),
    ...(onDeleteFrom ? [{ label: 'Delete from here', icon: Trash2, variant: 'destructive' as const, isDisabled: busy, onClick: onDeleteFrom }] : []),
  ];
}

function UserMessageView({
  message,
  mentionTokens,
  busy = false,
  editDisabled = false,
  onEditResend,
  onDeleteFrom,
  showMoreActions = false,
}: {
  message: UIMessage;
  mentionTokens: ChatComposerToken[];
  busy?: boolean;
  editDisabled?: boolean;
  onEditResend?: (text: string) => void;
  onDeleteFrom?: () => void;
  showMoreActions?: boolean;
}): ReactElement | null {
  const { isMobile } = useAppShellMobile();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const text = messageText(message);
  const files = fileParts(message);
  const origin = originOf(message);
  const time = sentAt(message);
  if (text === '' && files.length === 0) return null;

  // Unchanged or empty text is a no-op: the edit closes and nothing is sent.
  const confirm = (): void => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed === '' || trimmed === text) return;
    onEditResend?.(trimmed);
  };
  // Keys bubble up from the textarea: Enter sends, Shift+Enter keeps the
  // newline, Escape cancels.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      confirm();
    } else if (event.key === 'Escape') {
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <ChatMessage sender="user">
        <ChatMessageBubble variant="ghost" width="100%">
          <VStack gap={2}>
            <TextArea
              label="Edit your message"
              isLabelHidden
              description="Sends again and replaces the replies below."
              value={draft}
              onChange={setDraft}
              onKeyDown={onKeyDown}
              hasAutoFocus
              width="100%"
            />
            <HStack gap={2} hAlign="end">
              <Button label="Cancel edit" variant="secondary" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button label="Send edited message" variant="primary" size="sm" onClick={confirm}>
                Send
              </Button>
            </HStack>
          </VStack>
        </ChatMessageBubble>
      </ChatMessage>
    );
  }

  const actions =
    onEditResend || onDeleteFrom ? (
      <HStack gap={1} wrap="wrap">
        <IconButton
          label="Edit and resend this message"
          tooltip={editDisabled ? 'Available after this chat reloads' : 'Edit'}
          variant="ghost"
          size="sm"
          icon={<Icon icon={Pencil} size="sm" />}
          isDisabled={busy || editDisabled}
          onClick={() => {
            setDraft(text);
            setEditing(true);
          }}
        />
        {onDeleteFrom && (
          <MoreMenu
            label="More actions for this message"
            size="sm"
            alignment="end"
            presentation="adaptive"
            isDisabled={busy}
            items={[
              {
                label: 'Delete from here',
                description: 'Deletes this message and everything after it',
                icon: Trash2,
                variant: 'destructive',
                onClick: onDeleteFrom,
              },
            ]}
          />
        )}
      </HStack>
    ) : undefined;

  const note = <OriginNote origin={origin} />;
  const startEdit = (): void => { setDraft(text); setEditing(true); };
  const phoneItems = userMenuItems({ busy, editDisabled, onEdit: onEditResend ? startEdit : undefined, onDeleteFrom });
  const phoneMetadata =
    showMoreActions && phoneItems.length > 0 ? <ChatMessageMetadata footer={<PhoneMoreActions items={phoneItems} />} /> : undefined;
  const bubbleMessage = (
    <ChatMessage sender="user">
      {files.length > 0 && (
        <ChatMessageBubble variant="ghost">
          <Attachments files={files} />
        </ChatMessageBubble>
      )}
      {text !== '' && (
        <ChatMessageBubble
          // Phone bubble cap: 85% of the column. Desktop keeps Astryx's default max(80%, 280px).
          width={isMobile ? '85%' : undefined}
          metadata={
            isMobile ? phoneMetadata : time !== null || actions || origin ? (
              <ChatMessageMetadata
                timestamp={time !== null ? <SentTime at={time} /> : undefined}
                footer={
                  <HStack gap={2} vAlign="center">
                    {note}
                    {actions}
                  </HStack>
                }
              />
            ) : undefined
          }
        >
          <ChatTokenizedText tokens={mentionTokens}>{text}</ChatTokenizedText>
        </ChatMessageBubble>
      )}
    </ChatMessage>
  );
  // Phone: no action row under the bubble; its actions open on long-press.
  return isMobile && phoneItems.length > 0 ? (
    <ContextMenu label="Message actions" presentation="bottom-sheet" items={phoneItems}>{bubbleMessage}</ContextMenu>
  ) : bubbleMessage;
}

// `metadata` rides the segment's bubble (the message's last one); a tool-call
// segment is no bubble, so AssistantMessageView hands its metadata to the
// message instead.
function renderSegment(
  segment: Segment,
  isLast: boolean,
  isStreaming: boolean,
  metadata?: ReactNode,
): ReactElement | null {
  switch (segment.kind) {
    case 'text':
      return (
        <ChatMessageBubble key={segment.key} variant="ghost" metadata={metadata}>
          <RichMarkdown density="compact" isStreaming={isStreaming && isLast}>
            {segment.text}
          </RichMarkdown>
        </ChatMessageBubble>
      );
    case 'tools':
      return <ChatToolCalls key={segment.key} calls={segment.calls} />;
    case 'reasoning':
      // A part an aborted reply left "streaming" must not keep thinking, so it
      // only counts as live while the message itself is still streaming.
      return (
        <ChatMessageBubble key={segment.key} variant="ghost" metadata={metadata}>
          <Reasoning text={segment.text} isStreaming={isStreaming && segment.streaming} />
        </ChatMessageBubble>
      );
    case 'stub':
      return (
        <ChatMessageBubble key={segment.key} variant="ghost" metadata={metadata}>
          <Text type="supporting">System test mode: this response is a local stub.</Text>
        </ChatMessageBubble>
      );
  }
}

// The segments a reply shows: a chosen earlier version stands in for its text.
function replySegments(message: UIMessage, shownText: string | undefined): Segment[] {
  const live = toSegments(message);
  if (shownText === undefined) return live;
  return [
    ...live.filter((segment) => segment.kind !== 'text'),
    { kind: 'text', key: `${message.id}:version`, text: shownText },
  ];
}

// Phone: no action row; the footer is only the version stepper and the compact
// More actions button (the long-press menu's visible second path).
function phoneFooter(shown: MessageVersions | undefined, items: MessageMenuItems | undefined): ReactNode {
  const more = items ? <PhoneMoreActions items={items} /> : null;
  if (!shown && !more) return undefined;
  return (
    <ChatMessageMetadata
      footer={
        <HStack gap={1} vAlign="center">
          {shown && <VersionSelector versions={shown} />}
          {more}
        </HStack>
      }
    />
  );
}

// While a reply streams its footer shows only its time and origin note (both
// known from the first frame); the actions wait for the end.
function assistantFooter(
  message: UIMessage,
  isStreaming: boolean,
  {
    busy,
    shown,
    shownText,
    onRegenerate,
    onCopyFailure,
    phone,
    moreItems,
  }: {
    phone?: boolean;
    moreItems?: MessageMenuItems;
    busy: boolean;
    shown?: MessageVersions;
    shownText?: string;
    onRegenerate?: () => void;
    onCopyFailure?: () => void;
  },
): ReactNode {
  if (phone) return phoneFooter(shown, moreItems);
  const origin = originOf(message);
  const note = <OriginNote origin={origin} />;
  const time = sentAt(message);
  const timestamp = time !== null ? <SentTime at={time} /> : undefined;
  if (isStreaming) {
    return (timestamp || origin) && <ChatMessageMetadata timestamp={timestamp} footer={note} />;
  }
  return (
    <ChatMessageMetadata
      timestamp={timestamp}
      footer={
        <HStack gap={2} vAlign="center">
          {note}
          <AssistantActions
            text={shownText ?? messageText(message)}
            busy={busy}
            versions={shown}
            onRegenerate={onRegenerate}
            onCopyFailure={onCopyFailure}
            traceId={shown ? shown.traceIds?.[shown.active] : messageTraceId(message)}
          />
        </HStack>
      }
    />
  );
}

// The phone menu of a finished reply (undefined while it has no text to act on).
function assistantMenuItems(
  message: UIMessage,
  shown: MessageVersions | undefined,
  shownText: string | undefined,
  handlers: { busy: boolean; onRegenerate?: () => void; onCopyFailure?: () => void; onCopied?: () => void },
): MessageMenuItems | undefined {
  const text = shownText ?? messageText(message);
  if (text === '') return undefined;
  const traceId = shown ? shown.traceIds?.[shown.active] : messageTraceId(message);
  return replyMenuItems({ text, traceId, ...handlers });
}

function AssistantMessageView({
  message,
  isStreaming,
  busy = false,
  versions,
  onRegenerate,
  onCopyFailure,
  onCopied,
  showMoreActions = false,
}: {
  message: UIMessage;
  isStreaming: boolean;
  busy?: boolean;
  versions?: MessageVersions;
  onRegenerate?: () => void;
  onCopyFailure?: () => void;
  onCopied?: () => void;
  showMoreActions?: boolean;
}): ReactElement | null {
  const hasAvatarColumn = useAvatarColumn();
  const { isMobile } = useAppShellMobile();
  // The selector only exists for two or more versions, and a reply that is
  // still streaming shows its live text rather than an older version.
  const shown = !isStreaming && versions && versions.texts.length > 1 ? versions : undefined;
  const shownText = shown ? (shown.texts[shown.active] ?? '') : undefined;
  const segments = replySegments(message, shownText);
  if (segments.length === 0) return isStreaming ? <ThinkingMessage /> : null;
  const menuItems = isMobile && !isStreaming
    ? assistantMenuItems(message, shown, shownText, { busy, onRegenerate, onCopyFailure, onCopied })
    : undefined;
  const footer = assistantFooter(message, isStreaming, {
    busy, shown, shownText, onRegenerate, onCopyFailure, phone: isMobile,
    moreItems: showMoreActions ? menuItems : undefined,
  });
  // The chips sit under the whole reply, so with any the footer moves to the
  // message, as it does when the reply ends in tool calls.
  const resources = toResources(message);
  const proposals = appProposals(message, isStreaming, shown);
  const endsInBubble = resources.length + proposals.length === 0 && segments.at(-1)?.kind !== 'tools';
  const body = (
    <ChatMessage
      sender="assistant"
      avatar={hasAvatarColumn ? <AssistantAvatar /> : undefined}
      metadata={endsInBubble ? undefined : footer}
    >
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return renderSegment(segment, isLast, isStreaming, isLast && endsInBubble ? footer : undefined);
      })}
      {resources.length > 0 && <ResourceChips refs={resources} />}
      {proposals.map((proposal) => <AppProposal key={`${proposal.id}:${proposal.revision}`} proposal={proposal} />)}
      <WeekReady message={message} isStreaming={isStreaming} />
    </ChatMessage>
  );
  return menuItems ? (
    <ContextMenu label="Reply actions" presentation="bottom-sheet" items={menuItems}>
      {body}
    </ContextMenu>
  ) : body;
}

// The mention tokens come from ChatSurface, which owns the one members lookup,
// so a long thread never mounts more member fetches.
//
// The action props are all optional: `busy` disables regenerate and edit while
// a turn is in flight, `versions` carries the session versions of an assistant
// reply, and a missing `onRegenerate` / `onEditResend` hides that action.
// `editDisabled` keeps the edit action visible but inert, for a message the
// server cannot anchor an edit on (see ChatSurface).
export function MessageView({
  message,
  isStreaming,
  mentionTokens,
  busy = false,
  editDisabled = false,
  versions,
  onRegenerate,
  onEditResend,
  onDeleteFrom,
  onCopyFailure,
  onCopied,
  showMoreActions = false,
}: {
  message: UIMessage;
  isStreaming: boolean;
  mentionTokens: ChatComposerToken[];
  busy?: boolean;
  editDisabled?: boolean;
  versions?: MessageVersions;
  onRegenerate?: () => void;
  onEditResend?: (text: string) => void;
  onDeleteFrom?: () => void;
  onCopyFailure?: () => void;
  onCopied?: () => void;
  // Phone: show the visible More actions button (the latest message of each sender).
  showMoreActions?: boolean;
}): ReactElement | null {
  if (message.role === 'user') {
    return (
      <UserMessageView
        message={message}
        mentionTokens={mentionTokens}
        busy={busy}
        editDisabled={editDisabled}
        onEditResend={onEditResend}
        onDeleteFrom={onDeleteFrom}
        showMoreActions={showMoreActions}
      />
    );
  }
  if (message.role === 'assistant') {
    return (
      <AssistantMessageView
        message={message}
        isStreaming={isStreaming}
        busy={busy}
        versions={versions}
        onRegenerate={onRegenerate}
        onCopyFailure={onCopyFailure}
        onCopied={onCopied}
        showMoreActions={showMoreActions}
      />
    );
  }
  return null;
}
