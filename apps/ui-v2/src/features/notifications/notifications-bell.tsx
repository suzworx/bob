import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  AlarmClock,
  AtSign,
  Bell,
  BellDot,
  CalendarClock,
  ClipboardCheck,
  Eye,
  FileText,
  ShieldAlert,
  UserPlus,
} from 'lucide-react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { BottomSheet } from '@astryxdesign/core/BottomSheet';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { List, ListItem } from '@astryxdesign/core/List';
import { Popover } from '@astryxdesign/core/Popover';
import { Section } from '@astryxdesign/core/Section';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { VStack } from '@astryxdesign/core/VStack';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { browserTimeZone, useSession } from '@/lib/auth/use-session';
import { useOptionalSpaces } from '@/features/spaces/use-spaces';
import { navigateTo } from '@/app/routes';
import { useRefreshOnFocus } from '@/lib/use-refresh-on-focus';
import { notificationRow } from './notification-rows';
import {
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
  type InboxNotification,
  type NotificationType,
} from './notifications-api';

const NOTIFICATION_ICON: Record<NotificationType, typeof Bell> = {
  mention: AtSign,
  assignment: ClipboardCheck,
  reminder: AlarmClock,
  event_change: CalendarClock,
  invitation: UserPlus,
  security: ShieldAlert,
  task_update: Eye,
  bob_message: FileText,
};

// Astryx's adaptive-presentation policy (DialogAdaptivePresentation): a touch
// surface up to large widths gets the bottom sheet, everything else the popover.
const TOUCH_QUERY = '(max-width: 1024px) and (pointer: coarse) and (hover: none)';
const POPOVER_WIDTH = 380;
const POLL_MS = 60_000;
const PAGE_SIZE = 25;
const SKELETON_ROWS = 4;

const NOTIFICATION_SETTINGS_PATH = '/settings#notifications';

type ListState = 'loading' | 'ready' | 'failed';

/** The account's zone (seeded from the browser at first sign-in), else the browser's. */
function useAccountZone(): string {
  const { session } = useSession();
  const zone: unknown = session?.user.user_metadata?.time_zone;
  return typeof zone === 'string' && zone !== '' ? zone : browserTimeZone();
}

function unreadLabel(unread: number): string {
  return unread > 99 ? '99+' : String(unread);
}

function NotificationList({
  items,
  zone,
  now,
  onOpen,
}: {
  items: InboxNotification[];
  zone: string;
  now: number;
  onOpen: (n: InboxNotification, target: string) => void;
}): ReactElement {
  return (
    <List hasDividers>
      {items.map((n) => {
        const row = notificationRow(n, zone, now);
        const target = row.target;
        return (
          <ListItem
            key={n.id}
            label={row.label}
            description={row.description || undefined}
            startContent={<Icon icon={NOTIFICATION_ICON[n.type]} size="sm" />}
            endContent={
              <HStack gap={2} vAlign="center">
                <Timestamp value={n.created_at} format="relative_short" />
                {n.read_at === null && <StatusDot variant="accent" label="Unread" />}
              </HStack>
            }
            onClick={target === null ? undefined : () => onOpen(n, target)}
          />
        );
      })}
    </List>
  );
}

function BellTrigger({ unread, onClick }: { unread: number; onClick?: () => void }): ReactElement {
  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
  return (
    <HStack gap={1} vAlign="center">
      <IconButton
        label={label}
        tooltip="Notifications"
        icon={<Icon icon={unread > 0 ? BellDot : Bell} size="sm" />}
        variant="ghost"
        onClick={onClick}
      />
      {unread > 0 && <Badge variant="info" label={unreadLabel(unread)} />}
    </HStack>
  );
}

/**
 * The footer bell: an IconButton with the unread count, opening the inbox in a
 * Popover anchored to it (a bottom sheet on touch phones). Lives in the shell's
 * SideNav footer, so its state survives the phone drawer closing.
 */
export function NotificationsBell(): ReactElement {
  const [unread, setUnread] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<ListState>('loading');
  const [items, setItems] = useState<InboxNotification[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [markAllFailed, setMarkAllFailed] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const isTouch = useMediaQuery(TOUCH_QUERY);
  const zone = useAccountZone();
  const spaces = useOptionalSpaces();
  const focusTick = useRefreshOnFocus();
  const loadSeq = useRef(0);
  // Two quick clicks can land before a re-render disables the button.
  const loadingMoreRef = useRef(false);

  const refreshCount = useCallback(async (): Promise<void> => {
    try {
      setUnread(await unreadNotificationCount());
    } catch {
      // Keep the last known count.
    }
  }, []);

  useEffect(() => {
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshCount]);

  useEffect(() => {
    if (focusTick > 0) void refreshCount();
  }, [focusTick, refreshCount]);

  const loadFirstPage = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    setState('loading');
    setLoadMoreFailed(false);
    try {
      const page = await listNotifications({ limit: PAGE_SIZE });
      if (seq !== loadSeq.current) return;
      setItems(page.notifications);
      setNextCursor(page.nextCursor);
      setUnread(page.unreadCount);
      setState('ready');
    } catch {
      if (seq !== loadSeq.current) return;
      setState('failed');
    }
  }, []);

  const setOpen = useCallback(
    (open: boolean): void => {
      setIsOpen(open);
      if (open) {
        setMarkAllFailed(false);
        void loadFirstPage();
      }
    },
    [loadFirstPage],
  );

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const page = await listNotifications({ limit: PAGE_SIZE, after: nextCursor });
      setItems((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...page.notifications.filter((n) => !seen.has(n.id))];
      });
      setNextCursor(page.nextCursor);
      setUnread(page.unreadCount);
    } catch {
      setLoadMoreFailed(true);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [nextCursor]);

  const openItem = useCallback(
    async (n: InboxNotification, target: string): Promise<void> => {
      if (n.read_at === null) {
        try {
          await markNotificationsRead({ ids: [n.id] });
        } catch {
          // Navigation still goes ahead; the dot comes back on the next load.
        }
      }
      if (n.space_id !== null) spaces?.setActiveSpace(n.space_id);
      setIsOpen(false);
      navigateTo(target);
      void refreshCount();
    },
    [refreshCount, spaces],
  );

  const openSettings = useCallback((): void => {
    setIsOpen(false);
    navigateTo(NOTIFICATION_SETTINGS_PATH);
  }, []);

  // Items are newest first and the read endpoint marks every row at or below
  // the cursor, so the top row's cursor covers every row, loaded or not.
  const markAll = useCallback(async (): Promise<void> => {
    setMarkAllFailed(false);
    const top = items[0];
    if (top === undefined) return;
    try {
      await markNotificationsRead({ upToCursor: top.cursor });
      void loadFirstPage();
    } catch {
      setMarkAllFailed(true);
    }
  }, [items, loadFirstPage]);

  const hasUnread = unread > 0 || items.some((n) => n.read_at === null);
  const now = Date.now();

  const body =
    state === 'loading' ? (
      <VStack gap={2} role="status" aria-label="Loading notifications">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} height={48} index={index} />
        ))}
      </VStack>
    ) : state === 'failed' ? (
      <Banner
        status="error"
        title="Couldn't load notifications."
        container="card"
        endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => void loadFirstPage()} />}
      />
    ) : items.length === 0 ? (
      <EmptyState
        title="You're all caught up"
        description="Mentions, assignments, reminders and notes from Bob show up here."
        icon={<Icon icon={Bell} size="md" />}
        isCompact
      />
    ) : (
      <VStack gap={2}>
        <NotificationList items={items} zone={zone} now={now} onOpen={(n, target) => void openItem(n, target)} />
        {loadMoreFailed && (
          <Banner
            status="error"
            title="Couldn't load older notifications."
            container="card"
            endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => void loadMore()} />}
          />
        )}
        {nextCursor !== null && !loadMoreFailed && (
          <Button label="Show older" variant="ghost" isLoading={loadingMore} onClick={() => void loadMore()} />
        )}
      </VStack>
    );

  const content = (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center" hAlign="between">
        <Heading level={3}>Notifications</Heading>
        <Button label="Mark all read" variant="ghost" size="sm" isDisabled={!hasUnread || items.length === 0} onClick={() => void markAll()} />
      </HStack>
      {markAllFailed && <Banner status="error" title="Couldn't mark notifications read. Try again." container="card" />}
      {body}
      <HStack hAlign="start">
        <Button label="Notification settings" variant="ghost" size="sm" onClick={openSettings} />
      </HStack>
    </VStack>
  );

  const trigger = <BellTrigger unread={unread} onClick={isTouch ? () => setOpen(true) : undefined} />;

  if (isTouch) {
    return (
      <>
        {trigger}
        <BottomSheet isOpen={isOpen} onOpenChange={setOpen} label="Notifications" height="capped">
          <Section paddingBlock={4} paddingInline={4}>
            {content}
          </Section>
        </BottomSheet>
      </>
    );
  }

  return (
    <Popover
      isOpen={isOpen}
      onOpenChange={setOpen}
      label="Notifications"
      placement="above"
      alignment="start"
      width={POPOVER_WIDTH}
      content={content}
    >
      {trigger}
    </Popover>
  );
}
