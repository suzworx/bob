import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AlarmClock, MessageSquare } from 'lucide-react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { List, ListItem } from '@astryxdesign/core/List';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { VStack } from '@astryxdesign/core/VStack';
import { fetchWithAuth } from '@/lib/auth/use-session';
import type { Space } from '@/features/spaces/use-spaces';
import { conversationPath, navigateTo, spacePath } from '../../app/routes';

// #668 "Recent": the turns this device heard and the account's
// timers that fired alongside them, newest first (GET /api/devices/:id/activity,
// DeviceActivityResponseSchema in the api's identity schemas).

type TurnFields = { kind: 'turn'; at: number; title: string; heard_excerpt: string };
export type DeviceActivityItem =
  | (TurnFields & { conversation_id: string })
  | (TurnFields & { thread_id: string; space_id: string })
  | { kind: 'timer'; at: number; label: string | null; status: 'fired' | 'dismissed'; scope: 'account' };

export type DeviceActivity = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; items: DeviceActivityItem[] };

const RECENT_LIMIT = 5;
const TIMER_NOTE = 'A timer rings on every device on your account.';

/** Reads the device's recent activity; `refreshKey` re-reads it without a loading flash. */
export function useDeviceActivity(deviceId: string, refreshKey = 0): DeviceActivity & { retry?: () => void } {
  const [activity, setActivity] = useState<DeviceActivity>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setActivity({ state: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetchWithAuth(`/api/devices/${encodeURIComponent(deviceId)}/activity?limit=${RECENT_LIMIT}`);
        if (!response.ok) throw new Error('activity_failed');
        const body = (await response.json()) as { items: DeviceActivityItem[] };
        if (live) setActivity({ state: 'ready', items: body.items });
      } catch {
        if (live) setActivity((prev) => (prev.state === 'ready' ? prev : { state: 'failed' }));
      }
    })();
    return () => {
      live = false;
    };
  }, [deviceId, refreshKey, attempt]);
  return { ...activity, retry } as DeviceActivity & { retry: () => void };
}

/** The newest turn this device spoke, or null when it has none (or none loaded). */
export function newestTurnAt(activity: DeviceActivity): number | null {
  if (activity.state !== 'ready') return null;
  return activity.items.find((item) => item.kind === 'turn')?.at ?? null;
}

function turnPath(item: Exclude<DeviceActivityItem, { kind: 'timer' }>): string {
  return 'thread_id' in item ? spacePath(item.space_id, 'threads', item.thread_id) : conversationPath(item.conversation_id);
}

function When({ at }: { at: number }): ReactElement {
  return <Timestamp value={at} format="relative" type="inherit" color="inherit" />;
}

function ActivityRow({ item, spaces }: { item: DeviceActivityItem; spaces: Space[] }): ReactElement {
  if (item.kind === 'timer') {
    const status = item.status === 'fired' ? 'rang' : 'dismissed';
    return (
      <ListItem
        label={`Timer: ${item.label ?? 'untitled'}, ${status}`}
        description={<When at={item.at} />}
        startContent={<Icon icon={AlarmClock} size="sm" />}
      />
    );
  }
  const space = 'space_id' in item ? (spaces.find((s) => s.id === item.space_id)?.name ?? 'a space') : 'General';
  return (
    <ListItem
      label={item.heard_excerpt === '' ? item.title : `“${item.heard_excerpt}”`}
      description={<>{`${item.title} · ${space} · `}<When at={item.at} /></>}
      startContent={<Icon icon={MessageSquare} size="sm" />}
      onClick={() => navigateTo(turnPath(item))}
    />
  );
}

type DeviceRecentProps = { deviceName: string; activity: DeviceActivity & { retry?: () => void }; spaces: Space[] };

/** The list only; the page gives it its "Recent" heading. */
export function DeviceRecent({ deviceName, activity, spaces }: DeviceRecentProps): ReactElement {
  const hasTimer = activity.state === 'ready' && activity.items.some((item) => item.kind === 'timer');
  return (
    <VStack gap={2}>
      {activity.state === 'loading' && (
        <VStack gap={2} role="status" aria-label="Loading recent activity">
          {[0, 1, 2].map((index) => <Skeleton key={index} height={40} index={index} />)}
        </VStack>
      )}
      {activity.state === 'failed' && (
        <Banner
          status="error"
          title="Couldn't load recent activity."
          endContent={activity.retry && <Button label="Retry" size="sm" variant="secondary" onClick={activity.retry} />}
        />
      )}
      {activity.state === 'ready' && activity.items.length === 0 && (
        <Text type="supporting">{`Nothing yet. What you say to ${deviceName} shows up here.`}</Text>
      )}
      {activity.state === 'ready' && activity.items.length > 0 && (
        <List hasDividers density="compact">
          {activity.items.map((item, index) => (
            <ActivityRow key={`${item.kind}-${item.at}-${index}`} item={item} spaces={spaces} />
          ))}
        </List>
      )}
      {hasTimer && <Text type="supporting" size="sm">{TIMER_NOTE}</Text>}
    </VStack>
  );
}
