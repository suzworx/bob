import type { MouseEvent, ReactElement } from 'react';
import { LayoutGrid, Plus, Users } from 'lucide-react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Badge } from '@astryxdesign/core/Badge';
import { SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { useSpaces, type Space } from '@/features/spaces/use-spaces';
import { spacePath, type AppRoute } from '@/app/routes';

/** How many spaces the rail shows before "All spaces" holds the rest. */
const RAIL_SPACE_LIMIT = 4;
/** The phone drawer is short on room, so it shows fewer; New space lives on /spaces there. */
const PHONE_SPACE_LIMIT = 3;

function openLink(event: MouseEvent, path: string, onOpen: (path: string) => void): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onOpen(path);
}

/**
 * The spaces the rail shows: shared ones only (Private is your personal chats,
 * which the rail already lists under Chats), most recent activity first.
 */
function railSpaces(spaces: readonly Space[], limit: number): Space[] {
  return spaces
    .filter((space) => space.kind !== 'private')
    .sort((a, b) => (b.last_activity_at ?? b.updated_at) - (a.last_activity_at ?? a.updated_at))
    .slice(0, limit);
}

/** An unread total as the rail shows it: nothing at zero, 99+ past 99. */
export function unreadLabel(count: number | undefined): string | null {
  if (count === undefined || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

// The rail's Spaces section: flat, the few most recent spaces with their
// server-side unread totals, then "All spaces" (/spaces) for the rest and for
// archived ones. Threads live inside each space, so rows never expand here.
export function SpacesNav({
  route,
  onOpen,
  onCreateSpace,
}: {
  /** The current route, so the rail can mark what is open. */
  route: AppRoute;
  /** Navigate. The shell passes its own openPage so a page swap resets chat state. */
  onOpen: (path: string) => void;
  /** "New space" was clicked. The owner mounts the form outside this rail, which unmounts. */
  onCreateSpace: () => void;
  /** @deprecated Archived spaces are a filter on All spaces now; ignored. */
  onOpenArchivedSpaces?: () => void;
}): ReactElement {
  const { spaces, state, refresh } = useSpaces();
  const { isMobile } = useAppShellMobile();
  const size = isMobile ? 'sm' : 'md';
  const routeSpaceId = route.kind === 'spaces' ? route.spaceId : null;
  const onAllSpaces = route.kind === 'spaces' && route.spaceId === null;

  return (
    <SideNavSection title="Spaces">
      {state === 'loading' && <SideNavItem size={size} label="Loading spaces…" isDisabled />}
      {state === 'failed' && (
        <SideNavItem size={size} label="Couldn't load spaces. Retry" icon={Users} onClick={() => void refresh()} />
      )}
      {railSpaces(spaces, isMobile ? PHONE_SPACE_LIMIT : RAIL_SPACE_LIMIT).map((space) => {
        const unread = unreadLabel(space.unread_count);
        const path = spacePath(space.id, 'threads');
        return (
          <SideNavItem
            key={space.id}
            size={size}
            icon={Users}
            label={space.name}
            endContent={unread !== null ? <Badge label={unread} /> : undefined}
            isSelected={space.id === routeSpaceId}
            href={path}
            onClick={(event) => openLink(event, path, onOpen)}
          />
        );
      })}
      <SideNavItem
        size={size}
        label="All spaces"
        icon={LayoutGrid}
        isSelected={onAllSpaces}
        href="/spaces"
        onClick={(event) => openLink(event, '/spaces', onOpen)}
      />
      {!isMobile && <SideNavItem label="New space" icon={Plus} onClick={onCreateSpace} />}
    </SideNavSection>
  );
}
