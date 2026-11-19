import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Archive, MessageSquare, Pencil, Plus } from 'lucide-react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { List, ListItem } from '@astryxdesign/core/List';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { useSession } from '@/lib/auth/use-session';
import { DeviceHeaderControl } from '@/features/devices/device-header-control';
import { useDeviceConversation } from '@/features/devices/use-device-conversation';
import { useThreads, type Thread } from '@/features/spaces/use-threads';
import { peopleCount, type Space } from '@/features/spaces/use-spaces';
import { HttpError } from '@/lib/query-client';
import { navigateTo, NEW_THREAD } from '@/app/routes';
import { ThreadReader } from './thread-reader';

const THREAD_HELP = 'A thread is a conversation the people in this space share. Choose Bob from @ mentions to invite him in.';

const THREAD_TITLE_MAX = 120;
const THREAD_CREATE_ERROR = 'That could not be created.';
const THREAD_RENAME_ERROR = 'That thread could not be renamed.';
const THREAD_RENAME_CONFLICT =
  'Someone else changed this thread while you were renaming it. Your title is still in the box: save again to use it.';
const THREAD_ARCHIVE_ERROR = 'That thread could not be archived.';
const ARCHIVE_UNDO_MS = 6000;

type ThreadsValue = ReturnType<typeof useThreads>;

// The "New thread" form: title input, Create, Cancel, and the failure text.
// The side rail lists threads and owns the "New thread" entry point; this is
// what it navigates here to fill in. onCancel collapses the form back to a
// plain invitation (see NewThreadControl) when the empty state renders it.
function NewThreadForm({
  threads,
  onCancel,
  onCreated,
}: {
  threads: ThreadsValue;
  onCancel: () => void;
  onCreated?: (thread: Thread) => void;
}): ReactElement {
  const [title, setTitle] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const submit = async (): Promise<void> => {
    const trimmed = title.trim();
    if (trimmed === '' || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const created = await threads.createThread(trimmed);
      if (created === null) {
        setFailed(true);
        return;
      }
      setTitle('');
      setFailed(false);
      onCreated?.(created);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="end" wrap="wrap">
        <TextInput
          label="New thread title"
          isLabelHidden
          hasAutoFocus
          value={title}
          onChange={(value) => setTitle(value.slice(0, THREAD_TITLE_MAX))}
          onEnter={submit}
          placeholder="Thread title"
        />
        <Button label="Create" size="sm" isDisabled={busy || title.trim() === ''} onClick={() => void submit()} />
        <Button
          label="Cancel new thread"
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<Icon icon="close" size="sm" />}
          onClick={onCancel}
        />
      </HStack>
      {failed && <Text role="alert">{THREAD_CREATE_ERROR}</Text>}
    </VStack>
  );
}

// The empty-space invitation's action: the create form starts open (it IS
// the action), and its ✕ collapses it back to a plain "Start a thread"
// button rather than just clearing the draft.
function NewThreadControl({
  threads,
  onCreated,
}: {
  threads: ThreadsValue;
  onCreated?: (thread: Thread) => void;
}): ReactElement {
  const [open, setOpen] = useState(true);
  if (!open) {
    return <Button label="Start a thread" size="sm" onClick={() => setOpen(true)} />;
  }
  return <NewThreadForm threads={threads} onCancel={() => setOpen(false)} onCreated={onCreated} />;
}

// The open thread's title, with a Rename/Archive menu. Renaming replaces the
// heading with an inline form; Archive is offered only to the thread's
// creator or a space owner/admin, and opens the caller's confirm dialog.
function ThreadHeader({
  thread,
  subtitle,
  canArchive,
  leading,
  onRename,
  onRequestArchive,
  onBack,
  onConflict,
}: {
  thread: Thread;
  // Set on a phone only: the thread's title becomes the page heading and this
  // muted line ("<space>, N people") sits under it. Desktop passes none.
  subtitle?: string;
  canArchive: boolean;
  // Menu rows placed before Rename: on a phone, Tools.
  leading: DropdownMenuOption[];
  onRename: (title: string) => Promise<Thread>;
  onRequestArchive: () => void;
  onBack: () => void;
  // A 409 on rename, and its clearing: the title bar announces it in its one
  // status region, and the typed title stays in the box.
  onConflict: (conflicted: boolean) => void;
}): ReactElement {
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

  const startRename = (): void => {
    setDraft(thread.title);
    setFailed(false);
    setRenaming(true);
  };

  const cancelRename = (): void => {
    setRenaming(false);
    setFailed(false);
    onConflict(false);
  };

  const save = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (trimmed === '' || inFlight.current) return;
    onConflict(false);
    if (trimmed === thread.title) {
      setRenaming(false);
      setFailed(false);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      await onRename(trimmed);
      setRenaming(false);
      setFailed(false);
    } catch (cause) {
      if (cause instanceof HttpError && cause.status === 409) onConflict(true);
      else setFailed(true);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  if (renaming) {
    return (
      <VStack gap={1}>
        <HStack gap={2} vAlign="end" wrap="wrap">
          <TextInput
            label="Thread title"
            isLabelHidden
            size="sm"
            hasAutoFocus
            value={draft}
            onChange={(value) => setDraft(value.slice(0, THREAD_TITLE_MAX))}
            onEnter={() => void save()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') cancelRename();
            }}
          />
          <Button label="Save" size="sm" isDisabled={saving || draft.trim() === ''} onClick={() => void save()} />
          <Button label="Cancel renaming thread" variant="ghost" size="sm" isIconOnly icon={<Icon icon="close" size="sm" />} onClick={cancelRename} />
        </HStack>
        {failed && <Text role="alert">{THREAD_RENAME_ERROR}</Text>}
      </VStack>
    );
  }

  // Built only while open: Rename, then Archive (destructive, last). On a
  // desktop the device lives in the bar's own DeviceHeaderControl; on a phone
  // it is a row above the composer and `leading` carries only Tools.
  const items = (): DropdownMenuOption[] => [
    ...leading,
    { label: 'Rename', icon: Pencil, onClick: startRename },
    ...(canArchive ? [{ type: 'divider' as const }, { label: 'Archive', icon: Archive, variant: 'destructive' as const, onClick: onRequestArchive }] : []),
  ];

  return (
    <HStack gap={1} vAlign="center" maxWidth="100%">
      <Button label="Back to threads" variant="ghost" size="sm" isIconOnly icon={<Icon icon="chevronLeft" size="sm" />} onClick={() => onBack()} />
      <StackItem size="fill">
        {subtitle === undefined ? (
          <Text weight="semibold" maxLines={1}>{thread.title}</Text>
        ) : (
          <VStack gap={0}>
            <Heading level={2} maxLines={1}>{thread.title}</Heading>
            <Text type="supporting" maxLines={1}>{subtitle}</Text>
          </VStack>
        )}
      </StackItem>
      <MoreMenu
        label={`Thread actions for ${thread.title}`}
        size="sm"
        alignment="end"
        presentation="adaptive"
        isMenuOpen={menuOpen}
        onOpenChange={setMenuOpen}
        items={menuOpen ? items() : []}
      />
    </HStack>
  );
}

/**
 * Archive a thread with Undo, the pattern for every reversible action: the
 * thread leaves the list at once, Undo puts it back, and the request runs only
 * when the toast closes without Undo (the server has no un-archive yet).
 */
function useArchiveThread(threads: ThreadsValue): (thread: Thread, onUndo?: () => void) => void {
  const toast = useToast();
  return (thread, onUndo) => {
    let undone = false;
    threads.hideThread(thread.id);
    const dismiss = toast({
      body: `Archived ${thread.title}`,
      uniqueID: `thread-archived-${thread.id}`,
      autoHideDuration: ARCHIVE_UNDO_MS,
      endContent: (
        <Button
          label="Undo"
          size="sm"
          variant="secondary"
          onClick={() => {
            undone = true;
            threads.unhideThread(thread);
            dismiss();
            onUndo?.();
          }}
        />
      ),
      onHide: () => {
        if (undone) return;
        void threads.archiveThread(thread.id).catch(() => {
          threads.unhideThread(thread);
          toast({ body: THREAD_ARCHIVE_ERROR, type: 'error' });
        });
      },
    });
  };
}

// The open thread's bar under the space tabs: Back to the thread list, the
// title, one MoreMenu (Rename, Archive) and the device control. Archive is
// offered to the thread's creator or a space owner/admin, with an Undo toast.
export function ThreadTitleBar({
  space,
  thread,
  threads,
  onArchived,
  onUndoArchive,
  onBack,
}: {
  space: Space;
  thread: Thread;
  threads: ThreadsValue;
  /** @deprecated New thread lives on the thread list now; ignored. */
  onNewThread?: () => void;
  /** Archive was chosen: leave the thread (the list hides it until Undo or the request). */
  onArchived: () => void;
  /** Undo on the archive toast: reopen the thread. */
  onUndoArchive?: () => void;
  /** Back to the thread list; defaults to onArchived (which also goes there). */
  onBack?: () => void;
}): ReactElement {
  const { session } = useSession();
  const selfId = session?.user?.id ?? null;
  const [renameConflict, setRenameConflict] = useState(false);
  const canArchive = thread.created_by === selfId || space.role === 'owner' || space.role === 'admin';
  const device = useDeviceConversation();
  const deviceKey = `thread:${thread.id}`;
  const { isMobile: isPhone } = useAppShellMobile();
  // On a phone the one "..." menu holds Tools above Rename and Archive; the
  // device is a row above the composer (ThreadPanel). Desktop keeps both visible.
  const phoneMenu: DropdownMenuOption[] = isPhone
    ? [
        { label: 'Tools', onClick: () => navigateTo(`/tools?spaceId=${encodeURIComponent(space.id)}&conversationId=${encodeURIComponent(thread.id)}`) },
        { type: 'divider' },
      ]
    : [];

  const archiveThread = useArchiveThread(threads);
  const archive = (): void => {
    onArchived();
    archiveThread(thread, onUndoArchive);
  };

  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <ThreadHeader
        thread={thread}
        subtitle={isPhone ? `${space.name}, ${peopleCount(space.members.length)}` : undefined}
        canArchive={canArchive}
        leading={phoneMenu}
        onRename={(title) => threads.renameThread(thread.id, title)}
        onRequestArchive={archive}
        onBack={onBack ?? onArchived}
        onConflict={setRenameConflict}
      />
      {/* Mounted empty from the first render so a rename that lost a race is
          announced. What the Cardputer did is the control's own status line. */}
      <Text type="supporting" size="sm" role="status">
        {renameConflict ? THREAD_RENAME_CONFLICT : ''}
      </Text>
      {!isPhone && <Button label="Tools" variant="ghost" size="sm" href={`/tools?spaceId=${encodeURIComponent(space.id)}&conversationId=${encodeURIComponent(thread.id)}`} />}
      {/* #667: the same visible control as the General chat header. Phone keeps it in the menu. */}
      {!isPhone && (
        <StackItem size="fill">
          <DeviceHeaderControl
            device={device}
            target={{ threadId: thread.id, spaceId: space.id, spaceName: space.name }}
            statusKey={deviceKey}
          />
        </StackItem>
      )}
    </HStack>
  );
}

function Centered({ children }: { children: ReactElement }): ReactElement {
  return (
    <VStack height="100%" gap={4} hAlign="center" vAlign="center" paddingBlock={6}>
      {children}
    </VStack>
  );
}

function ThreadRow({
  space,
  thread,
  canArchive,
  onOpen,
  onArchive,
}: {
  space: Space;
  thread: Thread;
  canArchive: boolean;
  onOpen: () => void;
  onArchive: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const device = useDeviceConversation();
  const unread = thread.unread_count > 0 ? (thread.unread_count > 99 ? '99+' : String(thread.unread_count)) : null;
  // Built only while open: device actions, then Archive (destructive, last).
  const items = (): DropdownMenuOption[] => {
    const deviceItems = device
      .items({ threadId: thread.id, spaceId: space.id, spaceName: space.name, statusKey: `thread:${thread.id}` })
      .filter((item) => 'label' in item && item.id === 'use-on-cardputer');
    const archive: DropdownMenuOption[] = canArchive
      ? [{ label: 'Archive', icon: Archive, variant: 'destructive', onClick: onArchive }]
      : [];
    return deviceItems.length > 0 && archive.length > 0 ? [...deviceItems, { type: 'divider' }, ...archive] : [...deviceItems, ...archive];
  };
  return (
    <ListItem
      label={thread.title}
      startContent={<Icon icon={MessageSquare} size="sm" />}
      description={
        <>
          {'Active '}
          <Timestamp value={thread.updated_at} format="relative" type="inherit" color="inherit" />
        </>
      }
      // The row menu renders in a portal, and React bubbles its clicks up the
      // component tree to this row; only a click inside the row's own DOM opens it.
      onClick={(event) => {
        if (event.currentTarget.contains(event.target as Node)) onOpen();
      }}
      endContent={
        <HStack gap={2} vAlign="center">
          {unread !== null && <Badge label={unread} />}
          <MoreMenu
            label={`Thread actions for ${thread.title}`}
            size="sm"
            alignment="end"
            presentation="adaptive"
            isMenuOpen={open}
            onOpenChange={setOpen}
            items={open ? items() : []}
          />
        </HStack>
      }
    />
  );
}

/**
 * The Threads tab with no thread open: the space's threads, most recent first,
 * with unread counts and one row menu. Archive is reversible, so it happens at
 * once and offers Undo (the server has no un-archive yet, so Undo holds the
 * request back until the toast closes).
 */
function ThreadList({
  space,
  threads,
  onOpenThread,
}: {
  space: Space;
  threads: ThreadsValue;
  onOpenThread: (threadId: string) => void;
}): ReactElement {
  const { session } = useSession();
  const selfId = session?.user?.id ?? null;
  const archive = useArchiveThread(threads);

  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <Text type="supporting">{THREAD_HELP}</Text>
        </StackItem>
        <Button
          label="New thread"
          variant="primary"
          size="sm"
          icon={<Icon icon={Plus} size="sm" />}
          onClick={() => onOpenThread(NEW_THREAD)}
        />
      </HStack>
      <List aria-label="Threads" hasDividers>
        {threads.threads.map((thread) => (
          <ThreadRow
            key={thread.id}
            space={space}
            thread={thread}
            canArchive={thread.created_by === selfId || space.role === 'owner' || space.role === 'admin'}
            onOpen={() => onOpenThread(thread.id)}
            onArchive={() => archive(thread)}
          />
        ))}
      </List>
    </VStack>
  );
}

// The Threads tab's body. The open thread's title bar lives in the space
// header (ThreadTitleBar); `/threads/new` shows the create form even when the
// space already has threads.
export function ThreadPanel({
  space,
  openThreadId,
  onOpenThread,
}: {
  space: Space;
  openThreadId: string | null;
  onOpenThread: (threadId: string | null) => void;
}): ReactElement {
  const threads = useThreads(space.id);
  const device = useDeviceConversation();
  const { isMobile: isPhone } = useAppShellMobile();
  const creating = openThreadId === NEW_THREAD;
  const activeThread: Thread | null =
    openThreadId !== null && !creating ? threads.threads.find((thread) => thread.id === openThreadId) ?? null : null;

  // The URL names which thread is open; keep the hook's active thread in sync
  // with it rather than the other way around.
  useEffect(() => {
    if (openThreadId !== null && !creating && openThreadId !== threads.activeThreadId) {
      void threads.openThread(openThreadId);
    }
  }, [openThreadId, creating, threads.activeThreadId, threads.openThread]);

  if (creating) {
    return (
      <Centered>
        <EmptyState
          title="Start a thread"
          description={THREAD_HELP}
          actions={
            <NewThreadForm
              threads={threads}
              onCancel={() => onOpenThread(null)}
              onCreated={(created) => onOpenThread(created.id)}
            />
          }
        />
      </Centered>
    );
  }
  if (openThreadId === null) {
    if (threads.threadsState === 'empty') {
      return (
        <Centered>
          <EmptyState
            title="Start this space's first thread"
            description={THREAD_HELP}
            actions={<NewThreadControl threads={threads} onCreated={(created) => onOpenThread(created.id)} />}
          />
        </Centered>
      );
    }
    if (threads.threadsState === 'failed') {
      return (
        <Banner
          status="error"
          title="Threads couldn't be loaded."
          container="card"
          endContent={<Button label="Retry" size="sm" onClick={() => void threads.refresh()} />}
        />
      );
    }
    if (threads.threadsState !== 'ready') {
      return (
        <VStack gap={3} role="status" aria-label="Loading threads">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} index={index} height={48} />
          ))}
        </VStack>
      );
    }
    return <ThreadList space={space} threads={threads} onOpenThread={(id) => onOpenThread(id)} />;
  }
  if (activeThread === null) {
    return (
      <Centered>
        <EmptyState
          title="That thread isn't available."
          actions={<Button label="Back to threads" onClick={() => onOpenThread(null)} />}
        />
      </Centered>
    );
  }
  // #492 on a phone: the device's actions as one row above the composer, as in
  // the main chat. It renders nothing while no device is paired.
  const deviceRow = isPhone ? (
    <DeviceHeaderControl
      device={device}
      target={{ threadId: activeThread.id, spaceId: space.id, spaceName: space.name }}
      statusKey={`thread:${activeThread.id}`}
    />
  ) : undefined;
  return <ThreadReader key={activeThread.id} space={space} thread={activeThread} threads={threads} deviceRow={deviceRow} />;
}
