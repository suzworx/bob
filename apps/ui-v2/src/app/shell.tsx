import { markSpacesStale } from '@/features/spaces/use-spaces';
import { BRAND } from '@/lib/brand';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type LazyExoticComponent,
  type MutableRefObject,
  type ReactElement,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import type { UIMessage } from 'ai';
import { Blocks, Brain, CalendarDays, CircleUserRound, History, Lightbulb, LogOut, MonitorSmartphone, Plus, Repeat, Search, Settings, ShieldCheck, Sun, Wrench } from 'lucide-react';
import { AppShell, useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { MobileNavToggle } from '@astryxdesign/core/MobileNav';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { SideNav, SideNavHeading, SideNavItem, SideNavSection, useSideNavCollapse } from '@astryxdesign/core/SideNav';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StackItem } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { accountDisplayName } from '@/lib/display-name';
import type { ConversationDetail } from '@/features/chat/use-conversations';
import { useAccountEvents } from '@/lib/use-account-events';
import type { ThreadMessageEventDetail } from '@/features/spaces/use-threads';
import { useOnline } from '@/lib/use-online';
import { BrandMark } from './brand-mark';
import { PAGE_WIDTH, usePagePadding } from './page-width';
import { ChatSurface } from '../features/chat/chat-surface';
import { toUIMessages, splitWindow } from '@/features/chat/conversation-messages';
import { ConversationNav } from '../features/chat/conversation-nav';
import { notifyDevicesChanged } from '../features/devices/devices-events';
import { useDevicesSummary } from '@/features/devices/use-devices-summary';
import { useAdminAccess } from '../features/admin/use-admin-access';
import { useOperatorAccess } from '../features/metrics/use-operator-access';
import { moveDraft, NEW_CHAT_DRAFT_KEY } from '../features/chat/drafts';
import {
  conversationIdFromLocation,
  conversationPath,
  groupChatPath,
  navigateTo,
  replaceLegacyLocation,
  routeFromPath,
  spacePath,
  useLocationPath,
  type AppRoute,
} from './routes';
import { NotificationsBell } from '@/features/notifications/notifications-bell';
import { useSharedConversations } from '../features/chat/use-shared-conversations';
import { SpacesNav } from '../features/spaces/spaces-nav';
import { CreateSpaceDialog } from '@/features/spaces/create-space-controls';
import { useSpaces } from '@/features/spaces/use-spaces';
import { useConversationList } from '../features/chat/use-conversation-list';

type Page = LazyExoticComponent<() => ReactElement>;

// Pages split out of the entry chunk; each module is fetched on first visit.
const GroupChatPage = lazy(() => import('../features/chat/group-chat-page').then((m) => ({ default: m.GroupChatPage })));
const GroupChatInvitePage = lazy(() => import('../features/chat/group-chat-invite-page').then((m) => ({ default: m.GroupChatInvitePage })));
const SpacesPage: Page = lazy(() => import('../features/spaces/spaces-page').then((m) => ({ default: m.SpacesPage })));
const AllSpacesPage: Page = lazy(() => import('../features/spaces/all-spaces-page').then((m) => ({ default: m.AllSpacesPage })));
const TodayPage: Page = lazy(() => import('../features/productivity/calendar-page').then((m) => ({ default: m.TodayPage })));
const CalendarPage: Page = lazy(() => import('../features/productivity/calendar-page').then((m) => ({ default: m.CalendarPage })));
const MemoryPage: Page = lazy(() => import('../features/memory/memory-page').then((m) => ({ default: m.MemoryPage })));
const AdminPage: Page = lazy(() => import('../features/admin/admin-page').then((m) => ({ default: m.AdminPage })));
const IntegrationsPage: Page = lazy(() => import('@/features/integrations/integrations-page').then((m) => ({ default: m.IntegrationsPage })));
const InsightsPage: Page = lazy(() => import('@/features/insights/insights-page').then((m) => ({ default: m.InsightsPage })));
const RoutinesPage: Page = lazy(() => import('@/features/routines/routines-page').then((m) => ({ default: m.RoutinesPage })));
const TimelinePage: Page = lazy(() => import('@/features/timeline/timeline-page').then((m) => ({ default: m.TimelinePage })));
const BobAppsPage: Page = lazy(() => import('@/features/bob-apps/bob-apps-page').then((m) => ({ default: m.BobAppsPage })));
const ToolsPage: Page = lazy(() => import('@/features/tools/tools-page').then((m) => ({ default: m.ToolsPage })));
const SettingsPage: Page = lazy(() => import('../features/account/account-page').then((m) => ({ default: m.SettingsPage })));
const DevicesPage: LazyExoticComponent<(props: { pairing?: boolean }) => ReactElement> = lazy(() =>
  import('../features/devices/devices-page').then((m) => ({ default: m.DevicesPage })),
);

// The page a route shows; null is the chat. /devices/pair is the device list with the pair dialog over it.
function pageFor(route: AppRoute): ReactElement | null {
  switch (route.kind) {
    case 'groupChat':
      return <GroupChatPage chatId={route.chatId} />;
    case 'groupChatInvite':
      return <GroupChatInvitePage token={route.token} />;
    case 'spaces':
      return route.spaceId === null ? <AllSpacesPage /> : <SpacesPage />;
    case 'today':
      return <TodayPage />;
    case 'calendar':
      return <CalendarPage />;
    case 'memory':
      return <MemoryPage />;
    case 'admin':
      return <AdminPage />;
    case 'settings':
      return <SettingsPage />;
    case 'integrations':
      return <IntegrationsPage />;
    case 'insights':
      return <InsightsPage />;
    case 'routines':
      return <RoutinesPage />;
    case 'timeline':
      return <TimelinePage />;
    case 'apps':
      return <BobAppsPage />;
    case 'tools':
      return <ToolsPage />;
    case 'devices':
      return <DevicesPage />;
    case 'pair':
      return <DevicesPage pairing />;
    default:
      return null;
  }
}

// The rail's destinations (2026-10 redesign), in the order of use. Spaces and
// the chat history are their own sections below; settings and admin live in
// the account menu.
const NAV_ITEMS = [
  { kind: 'today', label: 'Today', icon: Sun, path: '/today' },
  { kind: 'calendar', label: 'Calendar', icon: CalendarDays, path: '/calendar' },
  { kind: 'memory', label: 'Memory', icon: Brain, path: '/memory' },
  { kind: 'devices', label: 'Devices', icon: MonitorSmartphone, path: '/devices' },
  { kind: 'integrations', label: 'Integrations', icon: Blocks, path: '/integrations' },
  { kind: 'insights', label: 'Insights', icon: Lightbulb, path: '/insights' },
  { kind: 'routines', label: 'Routines', icon: Repeat, path: '/routines' },
  { kind: 'timeline', label: 'Timeline', icon: History, path: '/timeline' },
  { kind: 'apps', label: 'My Apps', icon: Blocks, path: '/apps' },
  { kind: 'tools', label: 'Tools', icon: Wrench, path: '/tools' },
] as const;

const PAGE_TITLES: Partial<Record<AppRoute['kind'], string>> = {
  groupChat: 'Chat',
  groupChatInvite: 'Join chat',
  today: 'Today',
  calendar: 'Calendar',
  memory: 'Memory',
  devices: 'Devices',
  pair: 'Devices',
  admin: 'Admin',
  settings: 'Settings',
  integrations: 'Integrations',
  insights: 'Insights',
  routines: 'Routines',
  timeline: 'Timeline',
  tools: 'Tools',
  apps: 'My Apps',
};

// How long a background refresh of the open conversation that failed waits
// before its one retry.
const QUIET_RETRY_MS = 3000;

// The props the chat surface (chat-surface.tsx) takes from the shell.
export type ChatSlotProps = {
  conversationId: string | null;
  conversationTitle?: string;
  initialMessages: UIMessage[];
  // What the conversation holds before initialMessages, oldest first. The surface
  // offers to load it a page at a time.
  earlierMessages?: UIMessage[];
  userName: string | null;
  onConversationTouched: (finished?: { succeeded: boolean }) => void;
  onConversationCreated: (id: string, messages: UIMessage[]) => void;
  // Called with true while a turn is in flight and false when it ends.
  onBusyChange?: (busy: boolean) => void;
  // Kept equal to the ids of the messages the surface shows, so the shell can
  // tell an account event about a message this chat already has from one about
  // a message another surface added.
  knownMessageIds?: MutableRefObject<Set<string>>;
};

// Only a conversation the server says is gone (404) is reset away from; any
// other failure to open one keeps the reader on it and offers Retry.
const UNAVAILABLE_NOTICE = "That chat isn't here any more, so here's a fresh one.";
const LOAD_FAILED_NOTICE = "Couldn't open this chat.";
const OFFLINE_TITLE = "You're offline";
const OFFLINE_DESCRIPTION = "What you type stays here. Send it when you're back.";

// The account's active-conversation pointer moved (GET /api/active). The
// sidebar's active dot reads it, so it is told through a window event, as the
// command palette is; the nav re-reads the pointer when this fires.
function announceActiveChanged(): void {
  window.dispatchEvent(new Event('bob:active-changed'));
}

// A message landed in a space thread (#565, e.g. a Cardputer turn). useThreads
// listens for this and refetches that thread and its space's list.
function announceThreadMessage(threadId: string, spaceId: string): void {
  window.dispatchEvent(new CustomEvent<ThreadMessageEventDetail>('bob:thread-message', { detail: { threadId, spaceId } }));
}

// Thrown when the server answers 404: the conversation is gone, not just
// unreachable. The v1 hook's openConversation throws one plain Error for every
// failure, so the shell reads the conversation itself to tell the two apart.
class ConversationGoneError extends Error {}

async function loadConversation(id: string): Promise<ConversationDetail> {
  const response = await fetchWithAuth(`/api/conversations/${id}`);
  if (response.status === 404) throw new ConversationGoneError('conversation_gone');
  if (!response.ok) throw new Error('open_failed');
  return (await response.json()) as ConversationDetail;
}

// The reader's row: clicking it opens Settings, and its menu holds Settings,
// Admin (owners and operators only) and Sign out, last. A SideNavItem, so a
// collapsed rail shows it as an icon like every other item.
function AccountFooter({
  name,
  showAdmin,
  onSignOut,
  onOpen,
}: {
  /** The account's display name, else its email. */
  name: string | undefined;
  showAdmin: boolean;
  onSignOut: () => Promise<void>;
  onOpen: (path: string) => void;
}): ReactElement {
  return (
    <SideNavSection title="Account" isHeaderHidden>
      <SideNavItem
        label={name || 'You'}
        icon={CircleUserRound}
        onClick={() => onOpen('/settings')}
        actions={
          <MoreMenu
            label="Account menu"
            size="sm"
            placement="above"
            alignment="end"
            presentation="adaptive"
            items={[
              { label: 'Settings', icon: Settings, onClick: () => onOpen('/settings') },
              ...(showAdmin ? [{ label: 'Admin', icon: ShieldCheck, onClick: () => onOpen('/admin') }] : []),
              { type: 'divider' as const },
              { label: 'Sign out', icon: LogOut, onClick: () => void onSignOut() },
            ]}
          />
        }
      />
    </SideNavSection>
  );
}

// Devices in the rail, with a dot while any paired device is connected.
function DevicesNavItem({ isSelected, onClick }: { isSelected: boolean; onClick: (event: React.MouseEvent) => void }): ReactElement {
  const { connected } = useDevicesSummary();
  const { isMobile } = useAppShellMobile();
  return (
    <SideNavItem
      size={isMobile ? 'sm' : 'md'}
      label="Devices"
      icon={MonitorSmartphone}
      isSelected={isSelected}
      href="/devices"
      onClick={onClick}
      endContent={connected > 0 ? <StatusDot variant="success" label={`${connected} connected`} /> : undefined}
    />
  );
}

// The rail's Start and Pages rows. On a phone they take the small size, so the
// drawer shows more of the history below. Read here, inside AppShell.
function RailNav({
  selectedKind,
  onDevicesPage,
  onNewChat,
  onOpenPage,
}: {
  selectedKind: AppRoute['kind'];
  onDevicesPage: boolean;
  onNewChat: () => void;
  onOpenPage: (event: React.MouseEvent, target: string) => void;
}): ReactElement {
  const isMobile = useAppShellMobile().isMobile;
  const size = isMobile ? 'sm' : 'md';
  const start = (
    <>
      <SideNavItem size={size} label="New chat" icon={Plus} onClick={onNewChat} />
      {/* The command palette (its own unit) listens for this event, and for mod+K. */}
      <SideNavItem
        size={size}
        label="Search"
        icon={Search}
        endContent={<SearchShortcut />}
        onClick={() => window.dispatchEvent(new Event('bob:open-palette'))}
      />
    </>
  );
  const pages = NAV_ITEMS.map((item) =>
    item.kind === 'devices' ? (
      <DevicesNavItem key={item.kind} isSelected={onDevicesPage} onClick={(event) => onOpenPage(event, item.path)} />
    ) : (
      <SideNavItem
        key={item.kind}
        size={size}
        label={item.label}
        icon={item.icon}
        isSelected={selectedKind === item.kind}
        href={item.path}
        onClick={(event) => onOpenPage(event, item.path)}
      />
    ),
  );
  // One compact group on a phone, so the chats come into the first screen.
  if (isMobile) {
    return (
      <SideNavSection title="Start and pages" isHeaderHidden>
        {start}
        {pages}
      </SideNavSection>
    );
  }
  return (
    <>
      <SideNavSection title="Start" isHeaderHidden>
        {start}
      </SideNavSection>
      <Divider />
      <SideNavSection title="Pages" isHeaderHidden>
        {pages}
      </SideNavSection>
    </>
  );
}

// The Ctrl K hint on the Search row. Its key means nothing on a phone, so the
// drawer leaves it out. Read here, not in Shell, which is outside AppShell.
function SearchShortcut(): ReactElement | null {
  const { isMobile } = useAppShellMobile();
  return isMobile ? null : <Kbd keys="mod+k" />;
}

// The history reads the rail's own collapse state, which the SideNav owns (and
// saves, with the width) so it survives a reload.
function RailConversations(props: Omit<Parameters<typeof ConversationNav>[0], 'collapsed'>): ReactElement | null {
  const { isCollapsed } = useSideNavCollapse();
  return <ConversationNav {...props} collapsed={isCollapsed} />;
}

// The phone's one top bar: the page title, New chat, and the drawer toggle at the right.
// Renders nothing above the phone breakpoint, where the rail is inline. It
// also closes the drawer whenever the page changes: a rail item closes it
// itself, but the footer bell's links and Settings links do not (#1240).
function PhoneTopBar({ title, path, onNewChat }: { title: string; path: string; onNewChat: () => void }): ReactElement | null {
  const { isMobile, closeMobileNav } = useAppShellMobile();
  const gutter = usePagePadding();
  // closeMobileNav is a new function whenever the drawer opens or closes, so it
  // is read through a ref: the effect must run on a page change only.
  const close = useRef(closeMobileNav);
  close.current = closeMobileNav;
  useEffect(() => {
    close.current();
  }, [path]);
  if (!isMobile) return null;
  return (
    // Named as Astryx names its own phone bar, so assistive tech (and the e2e
    // side-nav helper) find the drawer toggle in the same landmark.
    <HStack gap={2} vAlign="center" paddingInline={gutter} paddingBlock={2} role="navigation" aria-label="Mobile navigation">
      <StackItem size="fill">
        {/* Not a heading: each page's own h1 stays the page's one. */}
        <Text weight="semibold" maxLines={1}>
          {title}
        </Text>
      </StackItem>
      <IconButton label="New chat" icon={<Icon icon={Plus} size="sm" />} variant="ghost" onClick={onNewChat} />
      <MobileNavToggle />
    </HStack>
  );
}

// While a conversation opens: message-shaped placeholders in the chat's frame.
function OpeningConversation(): ReactElement {
  return (
    <Layout
      height="fill"
      contentWidth={PAGE_WIDTH}
      content={
        <LayoutContent padding={6}>
          <VStack gap={5} role="status" aria-label="Opening chat">
            <HStack hAlign="start"><Skeleton width="72%" height={88} index={0} /></HStack>
            <HStack hAlign="end"><Skeleton width="44%" height={40} index={1} /></HStack>
            <HStack hAlign="start"><Skeleton width="60%" height={112} index={2} /></HStack>
          </VStack>
        </LayoutContent>
      }
    />
  );
}

export function Shell({
  session,
  onSignOut,
}: {
  session: Session | null;
  onSignOut: () => Promise<void>;
}): ReactElement {
  const list = useConversationList();
  const sharedList = useSharedConversations();
  const { reload } = list;
  const online = useOnline();
  const userName = accountDisplayName(session?.user) ?? null;
  const path = useLocationPath();
  const route = routeFromPath(path);
  const page = pageFor(route);
  const onDevicesPage = route.kind === 'devices' || route.kind === 'pair';
  // One Admin entry for the owner and for operators: monitoring is a tab of /admin.
  const adminAccess = useAdminAccess();
  const operatorAccess = useOperatorAccess();
  const showAdmin = adminAccess === 'yes' || operatorAccess === 'yes';
  const toast = useToast();
  const [activeId, setActiveId] = useState<string | null>(() => conversationIdFromLocation());
  const [restored, setRestored] = useState<UIMessage[]>([]);
  // The messages before `restored`, for the surface's "Load earlier messages".
  const [earlier, setEarlier] = useState<UIMessage[]>([]);
  // The conversation that failed to open for a reason other than being gone. It
  // shows a Retry banner in place of the chat, while the URL keeps naming it.
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  // Derived from the route so a failure the reader has navigated away from (Back
  // to /, another page) never shows again on something else.
  const openFailedHere =
    openFailure !== null && route.kind === 'chat' && route.conversationId === openFailure;
  const [surfaceKey, setSurfaceKey] = useState(0);
  const [restoring, setRestoring] = useState(false);
  // Owned here, not by SpacesNav: at phone width the nav drawer closes on a
  // click and unmounts the rail, which would take the dialog with it (#888).
  const [creatingSpace, setCreatingSpace] = useState(false);
  const { createSpace } = useSpaces();
  const routeRestoreStarted = useRef(false);
  // Latest-wins: a slow fetch for an earlier pick must not overwrite a later
  // pick or a new chat, so every open and reset takes a fresh sequence number.
  const openSeq = useRef(0);
  // The URL effect reads these instead of state: a store update and a state
  // update from one async callback can render apart, so the ref is set with it.
  const activeIdRef = useRef<string | null>(activeId);
  // The conversation being fetched now, so the URL effect does not fetch it twice.
  const openingId = useRef<string | null>(null);
  const previousKind = useRef<AppRoute['kind'] | null>(null);
  // Whether the chat surface has a turn in flight, and whether an event asked
  // for a reload of the open conversation meanwhile (run when the turn ends).
  const surfaceBusy = useRef(false);
  const reloadWhenIdle = useRef(false);
  const knownMessageIds = useRef<Set<string>>(new Set());
  // The background refresh of the open conversation (an event, a reconnect): its
  // sequence number, so only the newest one may act, and the timer of its one retry.
  const refreshSeq = useRef(0);
  const quietRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read by the events below, which can run after the route has changed.
  const routeKind = useRef(route.kind);
  routeKind.current = route.kind;

  // The surface is unmounted whenever the chat is replaced or a page opens, so
  // whatever it last reported is stale, and a reload asked for on behalf of the
  // old surface must not pull the reader back to it. A retry waiting to refresh
  // the old surface is dropped with them.
  const resetSurfaceTurn = useCallback((): void => {
    surfaceBusy.current = false;
    reloadWhenIdle.current = false;
    if (quietRetry.current !== null) clearTimeout(quietRetry.current);
    quietRetry.current = null;
  }, []);

  const commitActiveId = useCallback((id: string | null): void => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  // Puts a fetched conversation on screen: a fresh surface seeded with it.
  const showConversation = useCallback(
    (id: string, opened: { recent: UIMessage[]; earlier: UIMessage[] }): void => {
      setRestored(opened.recent);
      setEarlier(opened.earlier);
      commitActiveId(id);
      setSurfaceKey((key) => key + 1);
    },
    [commitActiveId],
  );

  // The conversation the server says is gone: back to a new chat, with a notice.
  const showGone = useCallback((): void => {
    commitActiveId(null);
    setRestored([]);
    setEarlier([]);
    window.history.replaceState(null, '', '/');
    toast({ body: UNAVAILABLE_NOTICE, uniqueID: 'conversation-gone' });
    setSurfaceKey((key) => key + 1);
  }, [commitActiveId, toast]);

  const openConversation = useCallback(
    async (id: string): Promise<void> => {
      const seq = ++openSeq.current;
      openingId.current = id;
      resetSurfaceTurn();
      setRestoring(true);
      setOpenFailure(null);
      try {
        const detail = await loadConversation(id);
        if (seq !== openSeq.current) return;
        showConversation(id, splitWindow(toUIMessages(detail)));
      } catch (cause) {
        if (seq !== openSeq.current) return;
        if (cause instanceof ConversationGoneError) {
          showGone();
        } else {
          commitActiveId(null);
          setRestored([]);
          setEarlier([]);
          // Not gone, only not loaded (a dropped connection, a 500): the URL and
          // the sidebar stay on it, no new chat starts, and Retry runs this again.
              setOpenFailure(id);
        }
      } finally {
        if (seq === openSeq.current) {
          openingId.current = null;
          setRestoring(false);
        }
      }
    },
    [commitActiveId, resetSurfaceTurn, showConversation, showGone],
  );

  const startNewChat = useCallback((): void => {
    openSeq.current += 1;
    openingId.current = null;
    resetSurfaceTurn();
    setRestoring(false);
    commitActiveId(null);
    setRestored([]);
    setEarlier([]);
    setOpenFailure(null);
    setSurfaceKey((key) => key + 1);
  }, [commitActiveId, resetSurfaceTurn]);

  // An old link (/family, /account, /connectors?state=..., /pair?code=...)
  // redirects once, in place, so Back never bounces between the old and new
  // URL. It runs in the first render, before anything reads the path, and the
  // routes read an old path as its new home meanwhile.
  useState(replaceLegacyLocation);

  // A reload lands on /c/<id>: open it once.
  useEffect(() => {
    const initialId = conversationIdFromLocation();
    if (initialId && !routeRestoreStarted.current) {
      routeRestoreStarted.current = true;
      void openConversation(initialId);
    }
  }, [openConversation]);

  // The URL is the source of truth. Back/forward and any surface that calls
  // navigateTo (the palette, Memory's "View conversation", Invite's link) change
  // the path, and this opens or resets the chat to match. The sidebar's own
  // handlers navigate and open in one go; `openingId` stops a second fetch.
  useEffect(() => {
    const routed = routeFromPath(path);
    const from = previousKind.current;
    previousKind.current = routed.kind;
    if (routed.kind !== 'chat') return;
    const id = routed.conversationId;
    if (id !== null) {
      if (openingId.current === id) return;
      // From a page the chat was unmounted, so even the last open one reloads.
      if (id !== activeIdRef.current || (from !== null && from !== 'chat')) void openConversation(id);
    } else if (activeIdRef.current !== null || openingId.current !== null) {
      startNewChat();
    }
  }, [path, openConversation, startNewChat]);

  const selectConversation = useCallback(
    (id: string): void => {
      // From a page the chat is unmounted, so re-picking the last open
      // conversation must reload it rather than return to a stale copy.
      if (id === activeId && route.kind === 'chat') return;
      navigateTo(conversationPath(id));
      void openConversation(id);
    },
    [activeId, openConversation, route.kind],
  );

  // A page opens over the chat. Like startNewChat it takes a sequence number,
  // so a conversation still opening cannot land on the page's URL afterwards.
  const openPage = useCallback(
    (target: string): void => {
      openSeq.current += 1;
      openingId.current = null;
      resetSurfaceTurn();
      setRestoring(false);
      navigateTo(target);
    },
    [resetSurfaceTurn],
  );

  const openPageLink = (event: React.MouseEvent, target: string): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openPage(target);
  };

  useEffect(
    () => () => {
      // A refresh still fetching must not schedule its retry after unmount.
      refreshSeq.current += 1;
      if (quietRetry.current !== null) clearTimeout(quietRetry.current);
    },
    [],
  );

  // On a new chat already, New chat leaves it as it is: no message for a no-op.
  const newChat = useCallback((): void => {
    if (activeId === null && window.location.pathname === conversationPath(null)) return;
    navigateTo(conversationPath(null));
    startNewChat();
  }, [activeId, startNewChat]);

  const handleTouched = useCallback((): void => {
    void reload();
  }, [reload]);

  // The surface stays mounted while it adopts the new id, so `surfaceKey` is not
  // bumped. Seed `restored` before `activeId` changes: React batches the two, and
  // useChat recreates its store when `id` moves, reseeding from `initialMessages`,
  // which must be the live exchange, not the empty new-chat one.
  const handleCreated = useCallback(
    (id: string, messages: UIMessage[]): void => {
      setRestored(messages);
      setEarlier([]);
      // Whatever is being typed into the composer that is still mounted moves
      // with it; it is normally empty, the first message having just been sent.
      moveDraft(NEW_CHAT_DRAFT_KEY, id);
      commitActiveId(id);
      navigateTo(conversationPath(id));
      void reload();
    },
    [commitActiveId, reload],
  );

  // Deleting the open conversation leaves a new chat. From a page the URL stays.
  const handleDeleted = useCallback(
    (id: string): void => {
      if (id !== activeIdRef.current) return;
      startNewChat();
      if (routeFromPath(window.location.pathname).kind === 'chat') navigateTo(conversationPath(null));
    },
    [startNewChat],
  );

  // Refreshes the open conversation in the background (an event named a message
  // this chat does not show, or the stream reconnected). It never disturbs what
  // is on screen: a conversation with nothing new is left alone, a failed fetch
  // keeps the chat as it is and is tried once more shortly (a restarting server
  // answers 502 for a moment), and only new messages replace it. Replacing
  // remounts the surface, which would kill a reply streaming into it, so during
  // a turn the refresh waits for the turn to end. Off the chat route the surface
  // is not mounted and reopening the conversation reloads it anyway, so there is
  // nothing to refresh. Opening a conversation is `openConversation`, which shows
  // its failures.
  const reloadOpenConversation = useCallback(
    (isRetry = false): void => {
      const id = activeIdRef.current;
      if (id === null || routeKind.current !== 'chat') return;
      // A newer refresh supersedes the retry of an older one.
      if (quietRetry.current !== null) clearTimeout(quietRetry.current);
      quietRetry.current = null;
      if (surfaceBusy.current) {
        reloadWhenIdle.current = true;
        return;
      }
      const seq = openSeq.current;
      const mine = ++refreshSeq.current;
      // Another refresh started, or the reader opened something else meanwhile.
      const superseded = (): boolean =>
        seq !== openSeq.current ||
        mine !== refreshSeq.current ||
        id !== activeIdRef.current ||
        routeKind.current !== 'chat';
      void (async (): Promise<void> => {
        try {
          const detail = await loadConversation(id);
          if (superseded()) return;
          // A turn began while the fetch ran: applying it would end that reply.
          if (surfaceBusy.current) {
            reloadWhenIdle.current = true;
            return;
          }
          // Only the recent window is on screen; the rest is offered on request.
          const opened = splitWindow(toUIMessages(detail));
          if (opened.recent.every((message) => knownMessageIds.current.has(message.id))) return;
          showConversation(id, opened);
        } catch (cause) {
          if (superseded()) return;
          if (cause instanceof ConversationGoneError) {
            showGone();
          } else if (!isRetry) {
            quietRetry.current = setTimeout(() => reloadOpenConversation(true), QUIET_RETRY_MS);
          }
        }
      })();
    },
    [showConversation, showGone],
  );

  const handleBusyChange = useCallback(
    (busy: boolean): void => {
      surfaceBusy.current = busy;
      if (busy || !reloadWhenIdle.current) return;
      reloadWhenIdle.current = false;
      reloadOpenConversation();
    },
    [reloadOpenConversation],
  );

  // The one account-events stream for the whole app. Payloads carry ids only, so
  // each event refetches what it names. A reconnect refetches everything, since
  // events sent while the stream was down are gone.
  useAccountEvents({
    // A turn typed here announces its own message, which this chat already shows,
    // so it needs no reload; a message from another surface is not shown, so it does.
    onMessageAppended: (id, messageId) => {
      if (id !== activeIdRef.current) return;
      if (messageId !== null && knownMessageIds.current.has(messageId)) return;
      reloadOpenConversation();
    },
    onConversationUpdated: (id) => {
      void reload();
      window.dispatchEvent(new CustomEvent('bob:group-chat-updated', { detail: { conversationId: id, deleted: false } }));
    },
    onConversationDeleted: (id) => {
      window.dispatchEvent(new CustomEvent('bob:group-chat-updated', { detail: { conversationId: id, deleted: true } }));
      void reload();
      handleDeleted(id);
    },
    onActiveChanged: announceActiveChanged,
    onDeviceChanged: notifyDevicesChanged,
    onActiveSpaceChanged: notifyDevicesChanged,
    onSpaceAccessChanged: (spaceId) => { window.dispatchEvent(new CustomEvent('bob:space-access', { detail: { spaceId } })); markSpacesStale(); },
    onThreadMessageAppended: (threadId, spaceId) => {
      announceThreadMessage(threadId, spaceId);
      if (sharedList.conversations.some((chat) => chat.id === threadId)) void sharedList.reload();
    },
    onReconnect: () => {
      window.dispatchEvent(new CustomEvent('bob:group-chat-updated', { detail: {} }));
      void reload();
      announceActiveChanged();
      reloadOpenConversation();
      notifyDevicesChanged();
    },
  });

  // The greeting already uses the name, so the account row does too.
  const accountLabel = userName ?? session?.user.email;
  const activeTitle = list.conversations.find((conversation) => conversation.id === activeId)?.title;
  const pageTitle =
    route.kind === 'chat' ? (activeTitle ?? BRAND.name) : route.kind === 'spaces' ? 'Spaces' : (PAGE_TITLES[route.kind] ?? BRAND.name);

  return (
    <AppShell
      variant="elevated"
      contentPadding={0}
      // The one banner: while offline. The page below is never remounted as it
      // comes and goes, so whatever is being typed stays put.
      banner={online ? undefined : <Banner status="warning" title={OFFLINE_TITLE} description={OFFLINE_DESCRIPTION} container="section" />}
      // The phone top bar below carries the drawer toggle with the page title.
      mobileNav={{ hasToggle: false }}
      sideNav={
        <SideNav
          collapsible
          // autoSaveId keeps the width and the collapsed state across reloads.
          resizable={{ autoSaveId: 'bob-rail', defaultWidth: 280, minWidth: 220, maxWidth: 400 }}
          header={
            <SideNavHeading
              heading={BRAND.name}
              icon={<Icon icon={BrandMark} size="lg" />}
              headingHref="/"
              aria-label={`${BRAND.name} home`}
              onClick={(e: React.MouseEvent<HTMLDivElement>) => {
                e.preventDefault();
                newChat();
              }}
            />
          }
          footer={<AccountFooter name={accountLabel} showAdmin={showAdmin} onSignOut={onSignOut} onOpen={openPage} />}
          footerIcons={<NotificationsBell />}
        >
          <RailNav selectedKind={route.kind} onDevicesPage={onDevicesPage} onNewChat={newChat} onOpenPage={openPageLink} />
          <SpacesNav route={route} onOpen={openPage} onCreateSpace={() => setCreatingSpace(true)} />

          <RailConversations
            list={list}
            sharedList={sharedList}
            onSelectShared={(id) => openPage(groupChatPath(id))}
            selectedId={route.kind === 'groupChat' ? route.chatId : route.kind === 'chat' ? (activeId ?? (openFailedHere ? openFailure : null)) : null}
            onSelect={selectConversation}
            onDeleted={handleDeleted}
          />
        </SideNav>
      }
    >
      <VStack height="100%">
        <PhoneTopBar title={pageTitle} path={`${path}${window.location.hash}`} onNewChat={newChat} />
        {page !== null ? (
          <Suspense
            fallback={
              <StackItem size="fill" isScrollable>
                <VStack height="100%" hAlign="center" vAlign="center">
                  <Spinner size="lg" aria-label="Loading page" />
                </VStack>
              </StackItem>
            }
          >
            {route.kind === 'spaces' && route.spaceId !== null ? (
              // A space owns its own scroll: ChatLayout inside it must fill its
              // container, which the shell's usual scroll wrapper would stop.
              <StackItem size="fill">{page}</StackItem>
            ) : (
              <StackItem size="fill" isScrollable>
                {page}
              </StackItem>
            )}
          </Suspense>
        ) : restoring ? (
          // While a conversation opens, the previous surface must not stay
          // mounted: its composer would still post to the previous id.
          <StackItem size="fill" isScrollable>
            <OpeningConversation />
          </StackItem>
        ) : openFailedHere ? (
          // Not a new chat: the URL and the sidebar still name the conversation,
          // and Retry reads it again.
          <StackItem size="fill" isScrollable>
            <Layout
              contentWidth={PAGE_WIDTH}
              content={
                <LayoutContent padding={6}>
                  <Banner
                    status="error"
                    title={LOAD_FAILED_NOTICE}
                    container="card"
                    endContent={
                      <Button label="Retry" size="sm" variant="secondary" onClick={() => void openConversation(openFailure)} />
                    }
                  />
                </LayoutContent>
              }
            />
          </StackItem>
        ) : (
          // The surface's own root is a flex child (flex 1, minHeight 0), so it gets
          // a column to be one in; the StackItem gives that column its height.
          <StackItem size="fill" isScrollable>
            <VStack height="100%">
              {/* Keyed by what the reader chose only (open a conversation, New chat).
                  A new chat adopts its id in place, so hands-free and the reply still
                  being spoken survive the first turn creating the conversation. */}
              <ChatSurface
                key={`surface:${surfaceKey}`}
                conversationId={activeId}
                conversationTitle={activeTitle}
                initialMessages={restored}
                earlierMessages={earlier}
                userName={userName}
                onConversationTouched={handleTouched}
                onConversationCreated={handleCreated}
                onBusyChange={handleBusyChange}
                knownMessageIds={knownMessageIds}
              />
            </VStack>
          </StackItem>
        )}
        {creatingSpace && (
          <CreateSpaceDialog
            onClose={() => setCreatingSpace(false)}
            onCreate={createSpace}
            onCreated={(created) => openPage(spacePath(created.id, 'threads'))}
          />
        )}
      </VStack>
    </AppShell>
  );
}
