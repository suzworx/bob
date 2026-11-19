import { useEffect, useRef, useState, type ReactElement, type SVGProps } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Circle,
  FileDown,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { useDeviceConversation } from '@/features/devices/use-device-conversation';
import { useDevicesSummary } from '@/features/devices/use-devices-summary';
import { groupedByRecency, truncateTitle } from '@/features/chat/use-conversations';
import { conversationMarkdown, downloadMarkdown, exportFileName } from './conversation-export';
import { useConversationList, type NavConversation } from './use-conversation-list';
import { conversationPath, groupChatPath } from '@/app/routes';
import type { SharedConversationList } from './use-shared-conversations';

type Conversations = ReturnType<typeof useConversationList>;

function selectLink(event: React.MouseEvent, select: () => void): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  select();
}

// The rail shows this many chats at first; "Show more" adds as many again.
const HISTORY_PAGE = 50;

const RENAME_FAILED = "Couldn't rename it. Try again.";
const DELETE_FAILED = "Couldn't delete it. Try again.";
const UPDATE_FAILED = "Couldn't update that chat.";
const DOWNLOAD_FAILED = "Couldn't download that chat.";

// A filled dot: lucide's Circle is an outline unless it is given a fill.
function FilledDot(props: SVGProps<SVGSVGElement>): ReactElement {
  return <Circle {...props} fill="currentColor" />;
}

function chatName(conversation: NavConversation): string {
  return conversation.title.trim() || 'Untitled chat';
}

// One row's actions, grouped by intent: Pin and Rename; the device's (only
// when one is paired); Download; then Archive and Delete, destructive last.
// The items are only built while the menu is open, so a long history mounts
// one trigger per row rather than every row's whole menu.
function RowMenu({
  label,
  buildItems,
}: {
  label: string;
  buildItems: () => DropdownMenuOption[];
}): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <MoreMenu
      label={label}
      size="sm"
      alignment="end"
      presentation="adaptive"
      onOpenChange={setIsOpen}
      items={isOpen ? buildItems() : []}
    />
  );
}

// Rename in a Dialog (a sheet on phone): moving focus away never loses the
// edit, and a failed save says so inline and keeps the text.
function RenameDialog({
  conversation,
  onClose,
  onSave,
}: {
  conversation: NavConversation | null;
  onClose: () => void;
  onSave: (id: string, title: string) => Promise<void>;
}): ReactElement {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setDraft(conversation?.title ?? '');
    setFailed(false);
    setSaving(false);
  }, [conversation]);
  const save = async (): Promise<void> => {
    if (conversation === null) return;
    const title = draft.trim();
    if (title === '' || title === conversation.title) {
      onClose();
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      await onSave(conversation.id, title);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      isOpen={conversation !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      purpose="form"
      width={420}
      aria-label="Rename chat"
    >
      <Layout
        header={<DialogHeader title="Rename chat" onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <TextInput
              label="Chat name"
              value={draft}
              onChange={(value) => {
                setDraft(value);
                setFailed(false);
              }}
              onEnter={() => void save()}
              hasAutoFocus
              autoComplete="off"
              width="100%"
              status={failed ? { type: 'error', message: RENAME_FAILED } : undefined}
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} isDisabled={saving} />
              <Button
                label="Save"
                variant="primary"
                isLoading={saving}
                isDisabled={draft.trim() === ''}
                onClick={() => void save()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

type ConversationNavProps = {
  list: Pick<
    Conversations,
    | 'conversations'
    | 'state'
    | 'reload'
    | 'rename'
    | 'remove'
    | 'setPinned'
    | 'setArchived'
    | 'openConversation'
  >;
  // The conversation open in the chat; null when none is, or off the chat route.
  selectedId: string | null;
  onSelect: (id: string) => void;
  // Called once a conversation is deleted, so the shell can leave it if it was open.
  onDeleted: (id: string) => void;
  // The SideNav is collapsed to its icon rail. Only SideNavItems fit there, so
  // the list becomes one item whose children the SideNav shows in a flyout.
  collapsed: boolean;
  sharedList?: SharedConversationList;
  onSelectShared?: (id: string) => void;
};

/**
 * The rail's chats: Pinned, Today, Earlier, then Archived (collapsed, last),
 * and every per-row action. Finding a chat is the command palette's job.
 * Transient results (archived, restored, sent to the device, a failure) are
 * Toasts; a failed rename or delete is said inline, in its dialog.
 */
export function ConversationNav({
  list,
  selectedId,
  onSelect,
  onDeleted,
  collapsed,
  sharedList,
  onSelectShared,
}: ConversationNavProps): ReactElement | null {
  const { state, reload, rename, remove, setPinned, setArchived, openConversation } = list;
  const conversations = [...list.conversations, ...(sharedList?.conversations ?? [])]
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const loading = [state, sharedList?.state].some((value) => value === 'idle' || value === 'loading');
  const failed = state === 'failed' || sharedList?.state === 'failed';
  const reloadHistory = async (): Promise<void> => { await Promise.all([reload(), sharedList?.reload()]); };
  const rowPath = (conversation: NavConversation): string => conversation.shared ? groupChatPath(conversation.id) : conversationPath(conversation.id);
  const selectRow = (conversation: NavConversation): void => {
    if (conversation.shared) onSelectShared?.(conversation.id);
    else onSelect(conversation.id);
  };
  const archivedList = useConversationList({ archived: true });
  const device = useDeviceConversation();
  const { isMobile } = useAppShellMobile();
  const { total: pairedDevices } = useDevicesSummary();
  const toast = useToast();
  const [renaming, setRenaming] = useState<NavConversation | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NavConversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [shownCount, setShownCount] = useState(HISTORY_PAGE);

  // The device hook reports each send's result as a status line; it is a
  // transient result, so it becomes a Toast.
  const lastDeviceStatus = useRef<string | null>(null);
  useEffect(() => {
    const text = device.status?.text ?? null;
    if (text !== null && text !== lastDeviceStatus.current) {
      toast({ body: text, uniqueID: 'chat-device-status' });
    }
    lastDeviceStatus.current = text;
  }, [device.status, toast]);

  const failToast = (body: string): void => {
    toast({ body, type: 'error', uniqueID: `chat-row-${body}` });
  };

  const togglePinned = (conversation: NavConversation): void => {
    void setPinned(conversation.id, conversation.pinned !== true).then(
      () => reload(),
      () => failToast(UPDATE_FAILED),
    );
  };

  const reloadBoth = async (): Promise<void> => {
    await Promise.all([reload(), archivedList.reload()]);
  };

  const unarchive = (id: string, confirm: boolean): void => {
    void setArchived(id, false).then(
      async () => {
        await reloadBoth();
        if (confirm) toast({ body: 'Chat restored', uniqueID: `chat-restored-${id}` });
      },
      () => failToast(UPDATE_FAILED),
    );
  };

  const archiveConversation = (conversation: NavConversation): void => {
    void setArchived(conversation.id, true).then(
      async () => {
        await reloadBoth();
        let dismiss: () => void = () => undefined;
        dismiss = toast({
          body: 'Chat archived',
          uniqueID: `chat-archived-${conversation.id}`,
          endContent: (
            <Button
              label="Undo"
              size="sm"
              variant="secondary"
              onClick={() => {
                dismiss();
                unarchive(conversation.id, false);
              }}
            />
          ),
        });
      },
      () => failToast(UPDATE_FAILED),
    );
  };

  const downloadConversation = (id: string, open: Conversations['openConversation']): void => {
    void open(id)
      .then((detail) => downloadMarkdown(exportFileName(detail.title), conversationMarkdown(detail)))
      .catch(() => failToast(DOWNLOAD_FAILED));
  };

  const saveRename = async (id: string, title: string): Promise<void> => {
    await rename(id, title);
    await reload();
  };

  // A failed delete keeps the dialog open and says so in it; the row stays.
  const confirmDelete = async (): Promise<void> => {
    if (pendingDelete === null) return;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await remove(pendingDelete.id);
      onDeleted(pendingDelete.id);
      await reloadBoth();
      setPendingDelete(null);
    } catch {
      setDeleteFailed(true);
    } finally {
      setDeleting(false);
    }
  };

  const askDelete = (conversation: NavConversation): void => {
    setDeleteFailed(false);
    setPendingDelete(conversation);
  };

  const rowItems = (conversation: NavConversation): DropdownMenuOption[] => {
    const deviceItems =
      pairedDevices > 0
        ? device.items({ conversationId: conversation.id, spaceId: null, statusKey: conversation.id })
        : [];
    return [
      conversation.pinned === true
        ? { label: 'Unpin', icon: PinOff, onClick: () => togglePinned(conversation) }
        : { label: 'Pin', icon: Pin, onClick: () => togglePinned(conversation) },
      { label: 'Rename', icon: Pencil, onClick: () => setRenaming(conversation) },
      ...(deviceItems.length > 0 ? [{ type: 'divider' as const }, ...deviceItems] : []),
      { type: 'divider' },
      { label: 'Download', icon: FileDown, onClick: () => downloadConversation(conversation.id, openConversation) },
      { type: 'divider' },
      { label: 'Archive', icon: Archive, onClick: () => archiveConversation(conversation) },
      { label: 'Delete', icon: Trash2, variant: 'destructive', onClick: () => askDelete(conversation) },
    ];
  };

  const archivedItems = (conversation: NavConversation): DropdownMenuOption[] => [
    { label: 'Unarchive', icon: ArchiveRestore, onClick: () => unarchive(conversation.id, true) },
    { type: 'divider' },
    {
      label: 'Download',
      icon: FileDown,
      onClick: () => downloadConversation(conversation.id, archivedList.openConversation),
    },
    { type: 'divider' },
    { label: 'Delete', icon: Trash2, variant: 'destructive', onClick: () => askDelete(conversation) },
  ];

  const renderRow = (conversation: NavConversation): ReactElement => (
    <SideNavItem
      key={conversation.id}
      size={isMobile ? 'sm' : 'md'}
      label={truncateTitle(chatName(conversation))}
      isSelected={conversation.id === selectedId}
      href={rowPath(conversation)}
      onClick={(event) => selectLink(event, () => selectRow(conversation))}
      endContent={
        !conversation.shared && conversation.id === device.activeId ? (
          <Icon icon={FilledDot} size="xsm" color="accent" label="On device" />
        ) : undefined
      }
      actions={conversation.shared ? undefined : <RowMenu label={`Conversation actions for ${conversation.title}`} buildItems={() => rowItems(conversation)} />}
    />
  );

  if (collapsed) {
    // No skeletons, dialogs or row menus in the icon rail: the list keeps its
    // order (newest first) and the rows are plain, pickable items.
    const recent = conversations.slice(0, shownCount);
    if (recent.length === 0 && !failed) return null;
    return (
      <SideNavSection title="Chats" isHeaderHidden>
        <SideNavItem label="Chats" icon={MessagesSquare}>
          {recent.map((conversation) => (
            <SideNavItem
              key={conversation.id}
              label={truncateTitle(chatName(conversation))}
              isSelected={conversation.id === selectedId}
              href={rowPath(conversation)}
              onClick={(event) => selectLink(event, () => selectRow(conversation))}
            />
          ))}
          {failed && <SideNavItem label="Couldn't load your chats. Retry" onClick={() => void reloadHistory()} />}
        </SideNavItem>
      </SideNavSection>
    );
  }

  const pinned = conversations.filter((c) => c.pinned === true);
  const unpinned = conversations.filter((c) => c.pinned !== true);
  const shown = unpinned.slice(0, shownCount);
  const hidden = unpinned.length - shown.length;
  const groups = groupedByRecency(shown);

  return (
    <>
      {loading && conversations.length === 0 && (
        <SideNavSection title="Chats" isHeaderHidden>
          <VStack gap={1} paddingInline={3} paddingBlock={2} role="status" aria-label="Loading chats">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} index={index} height={28} />
            ))}
          </VStack>
        </SideNavSection>
      )}
      {!loading && !failed && conversations.length === 0 && (
        <SideNavSection title="Chats" isHeaderHidden>
          <VStack padding={3}>
            <Text type="supporting" size="sm">
              No chats yet
            </Text>
          </VStack>
        </SideNavSection>
      )}
      {failed && (
        <SideNavSection title="Chats" isHeaderHidden>
          <VStack gap={2} padding={3} hAlign="start">
            <Text type="supporting" size="sm" role="alert">
              Couldn't load your chats.
            </Text>
            <Button label="Retry" size="sm" clickAction={reloadHistory} />
          </VStack>
        </SideNavSection>
      )}
      {pinned.length > 0 && (
        <SideNavSection title="Pinned">{pinned.map(renderRow)}</SideNavSection>
      )}
      {groups.map((group, index) => (
          <SideNavSection key={group.heading} title={group.heading}>
            {group.items.map(renderRow)}
            {index === groups.length - 1 && hidden > 0 && (
              <SideNavItem
                label="Show more"
                icon={ChevronDown}
                onClick={() => setShownCount((count) => count + HISTORY_PAGE)}
              />
            )}
          </SideNavSection>
        ))}
      {archivedList.state === 'ready' && archivedList.conversations.length > 0 && (
        <SideNavSection title="Archived" isHeaderHidden>
          <SideNavItem
            label="Archived"
            icon={Archive}
            collapsible={{
              isCollapsed: !archivedOpen,
              onCollapsedChange: (isCollapsed) => {
                setArchivedOpen(!isCollapsed);
                if (!isCollapsed) void archivedList.reload();
              },
            }}
          >
            {archivedList.conversations.map((conversation) => (
              <SideNavItem
                key={conversation.id}
                label={truncateTitle(chatName(conversation))}
                isSelected={conversation.id === selectedId}
                href={conversationPath(conversation.id)}
                onClick={(event) => selectLink(event, () => onSelect(conversation.id))}
                actions={
                  <RowMenu
                    label={`Archived conversation actions for ${conversation.title}`}
                    buildItems={() => archivedItems(conversation)}
                  />
                }
              />
            ))}
          </SideNavItem>
        </SideNavSection>
      )}
      <RenameDialog conversation={renaming} onClose={() => setRenaming(null)} onSave={saveRename} />
      <AlertDialog
        isOpen={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
        title={pendingDelete ? `Delete "${truncateTitle(chatName(pendingDelete))}"?` : 'Delete chat?'}
        description={`${deleteFailed ? `${DELETE_FAILED} ` : ''}This deletes the chat and its messages. Memories saved from it stay.`}
        actionLabel={deleteFailed ? 'Try again' : 'Delete'}
        isActionLoading={deleting}
        onAction={confirmDelete}
      />
    </>
  );
}
