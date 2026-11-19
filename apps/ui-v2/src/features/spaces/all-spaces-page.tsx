import { useEffect, useState, type ReactElement } from 'react';
import { ArchiveRestore, Plus } from 'lucide-react';
import { Avatar } from '@astryxdesign/core/Avatar';
import { AvatarGroup, AvatarGroupOverflow } from '@astryxdesign/core/AvatarGroup';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Section } from '@astryxdesign/core/Section';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import {
  peopleCount,
  spaceKindLabel,
  useSpaces,
  type Space,
  type SpaceSummary,
} from '@/features/spaces/use-spaces';
import { PAGE_WIDTH, PageTitle, usePagePadding } from '@/app/page-width';
import { navigateTo, spacePath } from '@/app/routes';
import { CreateSpaceDialog } from './create-space-controls';
import { unreadLabel } from './spaces-nav';
import { useSpacesRefreshOnFocus } from './use-spaces-refresh-on-focus';

const LOAD_FAILED = "Couldn't load your spaces.";
const ARCHIVED_FAILED = "Couldn't load archived spaces.";
const RESTORE_FAILED = "That space couldn't be restored.";
const AVATARS_SHOWN = 4;

type Filter = 'active' | 'archived';

function activityOf(space: SpaceSummary): number {
  return space.last_activity_at ?? space.updated_at;
}

/** "Family · 2 people · 3 threads": who it is for, who is in it, what is in it. */
export function spaceRowDescription(space: Space | SpaceSummary): string {
  const parts = [spaceKindLabel(space)];
  if (space.kind === 'private') {
    parts[0] = 'Just you';
  } else if ('members' in space && space.members.length > 0) {
    parts.push(peopleCount(space.members.length));
  }
  const threads = space.thread_count ?? 0;
  if (threads > 0) parts.push(`${threads} ${threads === 1 ? 'thread' : 'threads'}`);
  return parts.join(' · ');
}

/** The spaces' order on this page and in the rail: most recent activity first. */
export function byActivity<T extends SpaceSummary>(spaces: readonly T[]): T[] {
  return [...spaces].sort((a, b) => activityOf(b) - activityOf(a));
}

function LoadingRows(): ReactElement {
  return (
    <VStack gap={3}>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} index={index} height={48} />
      ))}
    </VStack>
  );
}

function Members({ space }: { space: Space }): ReactElement | null {
  if (space.members.length < 2) return null;
  const shown = space.members.slice(0, AVATARS_SHOWN);
  const hidden = space.members.length - shown.length;
  return (
    <AvatarGroup size="sm">
      {shown.map((member) => (
        <Avatar key={member.user_id} name={member.display_name ?? member.handle} />
      ))}
      {hidden > 0 && <AvatarGroupOverflow count={hidden} />}
    </AvatarGroup>
  );
}

// Phone: the rows form one compact card (Section muted, mockup 14) and drop the
// member avatars; desktop keeps the balanced list with them.
function ActiveRows({ spaces }: { spaces: Space[] }): ReactElement {
  const { isMobile } = useAppShellMobile();
  const list = (
    <List aria-label="Spaces" hasDividers density={isMobile ? 'compact' : undefined}>
      {byActivity(spaces).map((space) => {
        const unread = unreadLabel(space.unread_count);
        const path = spacePath(space.id, 'threads');
        return (
          <ListItem
            key={space.id}
            label={space.name}
            description={spaceRowDescription(space)}
            onClick={() => navigateTo(path)}
            endContent={
              <HStack gap={2} vAlign="center">
                {!isMobile && <Members space={space} />}
                {unread !== null && <Badge label={unread} />}
                <Timestamp value={activityOf(space)} format="relative_short" />
              </HStack>
            }
          />
        );
      })}
    </List>
  );
  return isMobile ? <Section variant="muted">{list}</Section> : list;
}

// Archived spaces load only when the filter is opened (owner-only on the server).
function ArchivedRows({
  onList,
  onRestore,
}: {
  onList: () => Promise<SpaceSummary[] | null>;
  onRestore: (id: string) => Promise<boolean>;
}): ReactElement {
  const toast = useToast();
  const [spaces, setSpaces] = useState<SpaceSummary[] | null | 'loading'>('loading');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setSpaces('loading');
    void onList().then((result) => {
      if (active) setSpaces(result);
    });
    return () => {
      active = false;
    };
  }, [onList, attempt]);

  const restore = async (space: SpaceSummary): Promise<void> => {
    if (!(await onRestore(space.id))) {
      toast({ body: RESTORE_FAILED, type: 'error' });
      return;
    }
    setSpaces((prev) => (Array.isArray(prev) ? prev.filter((item) => item.id !== space.id) : prev));
    const dismiss = toast({
      body: `Restored ${space.name}`,
      endContent: (
        <Button
          label="Open"
          size="sm"
          variant="secondary"
          onClick={() => {
            dismiss();
            navigateTo(spacePath(space.id, 'threads'));
          }}
        />
      ),
    });
  };

  if (spaces === 'loading') return <LoadingRows />;
  if (spaces === null) {
    return (
      <Banner
        status="error"
        title={ARCHIVED_FAILED}
        container="card"
        endContent={<Button label="Retry" size="sm" onClick={() => setAttempt((n) => n + 1)} />}
      />
    );
  }
  if (spaces.length === 0) {
    return <EmptyState title="No archived spaces" description="Spaces you archive wait here until you restore them." />;
  }
  return (
    <List aria-label="Archived spaces" hasDividers>
      {byActivity(spaces).map((space) => {
        const items = (): DropdownMenuOption[] => [
          { label: 'Restore', icon: ArchiveRestore, onClick: () => void restore(space) },
        ];
        return (
          <ListItem
            key={space.id}
            label={space.name}
            description={
              space.archived_at ? (
                <>
                  {'Archived '}
                  <Timestamp value={space.archived_at} format="relative" type="inherit" color="inherit" />
                </>
              ) : (
                'Archived'
              )
            }
            endContent={
              <MoreMenu
                label={`Actions for ${space.name}`}
                size="sm"
                alignment="end"
                presentation="adaptive"
                isMenuOpen={openMenu === space.id}
                onOpenChange={(open) => setOpenMenu(open ? space.id : null)}
                items={openMenu === space.id ? items() : []}
              />
            }
          />
        );
      })}
    </List>
  );
}

/** /spaces: every space you are in, most recent first, with Archived as a filter. */
export function AllSpacesPage(): ReactElement {
  const spaces = useSpaces();
  useSpacesRefreshOnFocus(spaces.refresh);
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('active');
  const [creating, setCreating] = useState(false);
  const padding = usePagePadding();
  const { isMobile } = useAppShellMobile();
  const filterControl = (
    <SegmentedControl label="Show" value={filter} onChange={(value) => setFilter(value as Filter)}>
      <SegmentedControlItem value="active" label="Active" />
      <SegmentedControlItem value="archived" label="Archived" />
    </SegmentedControl>
  );
  const newSpace = (
    <Button label="New space" variant="primary" size={isMobile ? 'sm' : undefined} icon={<Icon icon={Plus} size="sm" />} onClick={() => setCreating(true)} />
  );

  let body: ReactElement;
  if (filter === 'archived') {
    body = <ArchivedRows onList={spaces.listArchivedSpaces} onRestore={spaces.restoreSpace} />;
  } else if (spaces.state === 'loading') {
    body = <LoadingRows />;
  } else if (spaces.state === 'failed') {
    body = (
      <Banner
        status="error"
        title={LOAD_FAILED}
        container="card"
        endContent={<Button label="Retry" size="sm" onClick={() => void spaces.refresh()} />}
      />
    );
  } else if (spaces.spaces.length === 0) {
    body = (
      <EmptyState
        title="No spaces yet"
        description="A space is for you and the people you share with: family, a partner, friends."
        actions={newSpace}
      />
    );
  } else {
    body = <ActiveRows spaces={spaces.spaces} />;
  }

  return (
    <Layout
      height="fill"
      padding={padding}
      contentWidth={PAGE_WIDTH}
      header={
        <LayoutHeader>
          <VStack gap={3}>
            {isMobile ? (
              // The title is hidden on a phone, so the filter and the action share one row.
              <HStack gap={2} vAlign="center">
                <PageTitle>Spaces</PageTitle>
                <StackItem size="fill">{filterControl}</StackItem>
                {newSpace}
              </HStack>
            ) : (
              <>
                <HStack gap={2} vAlign="center">
                  <StackItem size="fill">
                    <PageTitle>Spaces</PageTitle>
                  </StackItem>
                  {newSpace}
                </HStack>
                <HStack>{filterControl}</HStack>
              </>
            )}
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          {body}
          {creating && (
            <CreateSpaceDialog
              onClose={() => setCreating(false)}
              onCreate={spaces.createSpace}
              onCreated={(created, failedInvites) => {
                if (failedInvites > 0) {
                  toast({ body: `${failedInvites} ${failedInvites === 1 ? 'invite' : 'invites'} couldn't be sent. Try again from Members.`, type: 'error' });
                }
                navigateTo(spacePath(created.id, 'threads'));
              }}
            />
          )}
        </LayoutContent>
      }
    />
  );
}
