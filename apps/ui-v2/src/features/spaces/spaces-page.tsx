import { BobAppsPage } from '@/features/bob-apps/bob-apps-page';
import { useEffect, useState, type ReactElement } from 'react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { fetchWithAuth, useSession } from '@/lib/auth/use-session';
import { useSpaces, type Space } from '@/features/spaces/use-spaces';
import { useThreads } from '@/features/spaces/use-threads';
import { PAGE_WIDTH } from '../../app/page-width';
import { navigateTo, routeFromPath, spacePath, useLocationPath, type SpaceSection } from '@/app/routes';
import { AgendaPanel } from '../productivity/agenda-panel';
import { MembersPanel } from './members-panel';
import { NotesPanel } from '../productivity/notes-panel';
import { SPACE_GUTTER, SPACE_PHONE_GUTTER, SpaceHeader, spaceSections } from './space-header';
import { TasksPanel } from '../productivity/tasks-panel';
import { ThreadPanel, ThreadTitleBar } from './thread-panel';
import { useSpacesRefreshOnFocus } from './use-spaces-refresh-on-focus';

const SPACES_ERROR = "Couldn't load your spaces.";
const NOT_AVAILABLE = "That space isn't available.";
const LEAVE_FAILED = "You couldn't leave this space. Try again.";
const ARCHIVE_FAILED = "That space couldn't be archived.";
const UNDO_FAILED = "That space couldn't be restored. Find it under All spaces, Archived.";

/** Leaves a space: removes your own membership. Resolves whether it worked. */
async function leaveSpace(spaceId: string, userId: string): Promise<boolean> {
  try {
    const response = await fetchWithAuth(`/api/spaces/${spaceId}/members/${userId}`, { method: 'DELETE' });
    return response.ok;
  } catch {
    return false;
  }
}

function Frame({ children }: { children: ReactElement }): ReactElement {
  return (
    <Layout height="fill" padding={SPACE_GUTTER} contentWidth={PAGE_WIDTH} content={<LayoutContent>{children}</LayoutContent>} />
  );
}

// One space: its header and the open tab. /spaces itself is All spaces
// (all-spaces-page.tsx). The URL is the source of truth for the space, the tab
// and the open thread; the Threads tab with none open is the thread list.
export function SpacesPage(): ReactElement {
  const spaces = useSpaces();
  useSpacesRefreshOnFocus(spaces.refresh);
  const toast = useToast();
  const { session } = useSession();
  const selfId = session?.user?.id ?? null;
  const route = routeFromPath(useLocationPath());
  // useLocationPath re-renders on every navigation, so the query is read with it.
  const search = new URLSearchParams(window.location.search);
  const focusTaskId = search.get('task');
  const focusNoteId = search.get('note');
  const routeSpaceId = route.kind === 'spaces' ? route.spaceId : null;
  const routeSection: SpaceSection = route.kind === 'spaces' ? route.section : 'threads';
  const routeThreadId = route.kind === 'spaces' ? route.threadId : null;
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const { isMobile: isPhone } = useAppShellMobile();

  const routeSpace: Space | null =
    routeSpaceId !== null ? spaces.spaces.find((space) => space.id === routeSpaceId) ?? null : null;
  const routeSpaceMissing = routeSpaceId !== null && spaces.state === 'ready' && routeSpace === null;
  // A tab the space does not have (Private has no Threads or Members) opens its first one.
  const sections = routeSpace !== null ? spaceSections(routeSpace) : [];
  const section: SpaceSection = sections.length === 0 || sections.includes(routeSection) ? routeSection : sections[0];

  // The open thread's title for the header bar; shares ThreadPanel's cache entry.
  const isPrivate = routeSpace?.kind === 'private';
  const threads = useThreads(routeSpace !== null && !isPrivate ? routeSpace.id : null);
  const openThread =
    section === 'threads' && routeThreadId !== null
      ? threads.threads.find((thread) => thread.id === routeThreadId) ?? null
      : null;

  // The URL names the active space; keep the stored pick (which every panel's
  // hook reads) in sync with it rather than the other way around.
  useEffect(() => {
    if (routeSpace !== null && routeSpace.id !== spaces.activeSpaceId) {
      spaces.setActiveSpace(routeSpace.id);
    }
  }, [routeSpace, spaces.activeSpaceId, spaces.setActiveSpace]);

  if (spaces.state === 'loading') {
    return (
      <Frame>
        <VStack gap={3} role="status" aria-label="Loading spaces">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} index={index} height={48} />
          ))}
        </VStack>
      </Frame>
    );
  }

  if (spaces.state === 'failed') {
    return (
      <Frame>
        <Banner
          status="error"
          title={SPACES_ERROR}
          container="card"
          endContent={<Button label="Retry" size="sm" onClick={() => void spaces.refresh()} />}
        />
      </Frame>
    );
  }

  if (routeSpaceMissing || routeSpace === null) {
    return (
      <Frame>
        <EmptyState title={NOT_AVAILABLE} actions={<Button label="All spaces" onClick={() => navigateTo('/spaces')} />} />
      </Frame>
    );
  }

  const activeSpace = routeSpace;

  // Archive is reversible: it happens at once, the page goes to All spaces and
  // the toast offers Undo (restore).
  const archive = async (): Promise<void> => {
    if (!(await spaces.archiveSpace(activeSpace.id))) {
      toast({ body: ARCHIVE_FAILED, type: 'error' });
      return;
    }
    navigateTo('/spaces');
    const dismiss = toast({
      body: `Archived ${activeSpace.name}`,
      uniqueID: `space-archived-${activeSpace.id}`,
      endContent: (
        <Button
          label="Undo"
          size="sm"
          variant="secondary"
          onClick={() => {
            dismiss();
            void spaces.restoreSpace(activeSpace.id).then((ok) => {
              if (ok) navigateTo(spacePath(activeSpace.id, 'threads'));
              else toast({ body: UNDO_FAILED, type: 'error' });
            });
          }}
        />
      ),
    });
  };

  // Leaving is irreversible for you (only an invite brings you back), so it
  // is confirmed; afterwards you land on All spaces, not on a missing space.
  const confirmLeaveSpace = async (): Promise<void> => {
    if (selfId === null || leaving) return;
    setLeaving(true);
    const ok = await leaveSpace(activeSpace.id, selfId);
    setLeaving(false);
    setConfirmLeave(false);
    if (!ok) {
      toast({ body: LEAVE_FAILED, type: 'error' });
      return;
    }
    navigateTo('/spaces');
    toast({ body: `You left ${activeSpace.name}` });
    void spaces.refresh();
  };

  let sectionContent: ReactElement;
  if (section === 'threads') {
    sectionContent = (
      <ThreadPanel
        space={activeSpace}
        openThreadId={routeThreadId}
        onOpenThread={(threadId) => navigateTo(spacePath(activeSpace.id, 'threads', threadId ?? undefined))}
      />
    );
  } else if (section === 'apps') {
    sectionContent = <BobAppsPage key={activeSpace.id} space={activeSpace} />;
  } else if (section === 'tasks') {
    // ?task=<id> / ?note=<id> (a notification) opens that item; the key
    // remounts the tab per target so it scrolls to and highlights it.
    sectionContent = <TasksPanel key={`${activeSpace.id}:${focusTaskId ?? ''}`} space={activeSpace} focusTaskId={focusTaskId} />;
  } else if (section === 'notes') {
    sectionContent = <NotesPanel key={`notes:${activeSpace.id}:${focusNoteId ?? ''}`} space={activeSpace} focusNoteId={focusNoteId} />;
  } else if (section === 'agenda') {
    sectionContent = <AgendaPanel space={activeSpace} />;
  } else {
    sectionContent = (
      <MembersPanel
        key={activeSpace.id}
        space={activeSpace}
        inviteOpen={inviteOpen}
        onLeave={() => setConfirmLeave(true)}
        onSpaceChanged={() => void spaces.refresh()}
      />
    );
  }

  // One frame for every tab: the same width and padding, so the header and the
  // tabs never move when the tab changes, and every tab's content sits in the
  // header's column.
  return (
    <>
      <Layout
        height="fill"
        // An open thread's header and messages share the phone gutter; every other tab keeps the page's own.
        padding={isPhone && openThread !== null ? SPACE_PHONE_GUTTER : SPACE_GUTTER}
        contentWidth={PAGE_WIDTH}
        header={
          <SpaceHeader
            space={activeSpace}
            section={section}
            threadBar={
              openThread !== null ? (
                <ThreadTitleBar
                  key={openThread.id}
                  space={activeSpace}
                  thread={openThread}
                  threads={threads}
                  onBack={() => navigateTo(spacePath(activeSpace.id, 'threads'))}
                  onArchived={() => navigateTo(spacePath(activeSpace.id, 'threads'))}
                  onUndoArchive={() => navigateTo(spacePath(activeSpace.id, 'threads', openThread.id))}
                />
              ) : undefined
            }
            onSelectSection={(next) => navigateTo(spacePath(activeSpace.id, next))}
            onRename={spaces.renameSpace}
            onArchive={() => void archive()}
            onLeave={() => setConfirmLeave(true)}
            onInvite={() => {
              setInviteOpen(true);
              navigateTo(spacePath(activeSpace.id, 'members'));
            }}
          />
        }
        // #899: an open thread nests ChatLayout's own scroller and sticky dock
        // inside this LayoutContent. A second scrollable, padded box here is
        // what let the iOS keyboard scroll the outer one while the dock stayed
        // pinned inside the inner one, floating the composer mid-screen and
        // blurred under its frosted layer. Full bleed + non-scrolling makes
        // ChatLayout the thread's only scroller, exactly as chat-surface.tsx
        // does for the main chat; every other tab keeps the page's own gutter.
        content={
          openThread !== null || section === 'apps' ? (
            <LayoutContent padding={0} isScrollable={false}>
              {sectionContent}
            </LayoutContent>
          ) : (
            <LayoutContent>{sectionContent}</LayoutContent>
          )
        }
      />
      <AlertDialog
        isOpen={confirmLeave}
        onOpenChange={(open) => {
          if (!open && !leaving) setConfirmLeave(false);
        }}
        title={`Leave ${activeSpace.name}?`}
        description="You lose its threads, tasks and notes. Only a new invite brings you back."
        actionLabel="Leave space"
        isActionLoading={leaving}
        onAction={() => void confirmLeaveSpace()}
      />
    </>
  );
}
