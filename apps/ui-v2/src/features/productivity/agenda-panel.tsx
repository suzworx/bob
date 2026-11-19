import { googleAgendaDays, type GoogleAgendaItem } from '@/features/integrations/google-agenda';
import { GoogleAgendaRow, GoogleAgendaStatus } from '@/features/integrations/google-agenda-row';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { InfoIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { List, ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { StackItem } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useAgenda, type AgendaItem, type AgendaRange } from '@/features/productivity/use-agenda';
import { formatZoneTime, localDayKey, useAccountZone, zoneDayStart } from '@/features/productivity/use-today';
import { CalendarGrid, DayLabel } from './calendar-grid';
import type { Space } from '@/features/spaces/use-spaces';
import { useInitialLoading, useRefreshOnFocus } from '../../lib/use-refresh-on-focus';
import { EventDialog, type EventDialogTarget } from './event-dialog';
import { RsvpToken } from './rsvp-token';
import { SPACE_GUTTER } from '../spaces/space-header';

const LOADING = 'Loading agenda…';

/** The event a notification points at (`?event=<id>`), if any. */
function linkedEventId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('event');
  } catch {
    return null;
  }
}

/** Today's day key in the account's zone. */
function todayKey(zone: string): ISODateString {
  return localDayKey(Date.now(), zone) as ISODateString;
}

/** The instant window of the month a day key falls in, in the account's zone:
 *  midnight of the 1st up to (not including) midnight of the next 1st. */
function monthRange(monthKey: string, zone: string): AgendaRange {
  const [y, m] = monthKey.split('-').map(Number);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const next = m === 12 ? `${(y ?? 0) + 1}-01-01` : `${y}-${String((m ?? 0) + 1).padStart(2, '0')}-01`;
  return { from: zoneDayStart(first, zone), to: zoneDayStart(next, zone) };
}

/** Render an event time honestly: an all-day event shows its date and never an
 *  invented time; a timed event shows its time in the account's zone. */
function TimeLabel({ item, zone }: { item: AgendaItem; zone: string }): ReactElement {
  if (!item.all_day && item.start_at !== null) {
    return <Text type="supporting" size="xsm">{formatZoneTime(item.start_at, zone)}</Text>;
  }
  if (!item.all_day && item.start_date !== null) {
    return <Text type="supporting" size="xsm"><DayLabel day={item.start_date} /></Text>;
  }
  return (
    <Text type="supporting" size="xsm">
      All day
    </Text>
  );
}

/** The day (in the account's zone) an event is listed under, or 'unknown'. */
function dayKey(item: AgendaItem, zone: string): string {
  if (item.all_day && item.start_date !== null) return item.start_date;
  if (item.start_at !== null) return localDayKey(item.start_at, zone);
  return 'unknown';
}

function EventRow({
  item,
  zone,
  onEdit,
  onView,
}: {
  item: AgendaItem;
  zone: string;
  onEdit: () => void;
  onView: () => void;
}): ReactElement {
  const pendingDot = item.pending ? <StatusDot variant="warning" label="Pending" /> : null;
  const rsvpToken = item.my_response ? <RsvpToken response={item.my_response} /> : null;
  const editButton =
    item.origin === 'native' && item.can_edit === true ? (
      <IconButton
        label={`Edit ${item.title}`}
        tooltip="Edit"
        icon={<Icon icon={PencilIcon} size="sm" />}
        variant="ghost"
        size="sm"
        onClick={onEdit}
      />
    ) : null;
  const detailsButton =
    item.origin === 'native' && item.can_edit !== true ? (
      <IconButton
        label={`Details ${item.title}`}
        tooltip="Details"
        icon={<Icon icon={InfoIcon} size="sm" />}
        variant="ghost"
        size="sm"
        onClick={onView}
      />
    ) : null;
  return (
    <ListItem
      label={item.title}
      description={
        <HStack gap={2}>
          <TimeLabel item={item} zone={zone} />
          {item.all_day && (
            <Text type="supporting" size="xsm" aria-hidden>
              ·
            </Text>
          )}
          <Text type="supporting" size="xsm">
            {item.origin === 'native' ? 'Bob' : item.origin === 'google' ? 'Google' : 'iCloud'}
          </Text>
        </HStack>
      }
      endContent={
        pendingDot || rsvpToken || editButton || detailsButton ? (
          <HStack gap={1} vAlign="center">
            {pendingDot}
            {rsvpToken}
            {editButton}
            {detailsButton}
          </HStack>
        ) : undefined
      }
    />
  );
}

function rowOrder(item: AgendaItem | GoogleAgendaItem): number {
  if ('source_key' in item) return 'date' in item.start ? 0 : Date.parse(item.start.dateTime);
  return item.all_day ? 0 : item.start_at ?? Number.MAX_SAFE_INTEGER;
}

function rowIdentity(item: AgendaItem | GoogleAgendaItem): string {
  return 'source_key' in item ? item.source_key : `${item.event_id}:${item.original_occurrence_start}`;
}

function groupAgenda(items: AgendaItem[], remoteItems: GoogleAgendaItem[], month: Date, zone: string): Array<{ key: string; items: Array<AgendaItem | GoogleAgendaItem> }> {
  const grouped: Array<{ key: string; items: Array<AgendaItem | GoogleAgendaItem> }> = [];
  const entries = [...items.map((item) => ({ item, key: dayKey(item, zone) })), ...remoteItems.flatMap((item) => googleAgendaDays(item, month).map((key) => ({ item, key })))];
  for (const { item, key } of entries) {
    const existing = grouped.find((group) => group.key === key);
    if (existing) existing.items.push(item);
    else grouped.push({ key, items: [item] });
  }
  grouped.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const group of grouped) {
    if (group.items.some((item) => 'source_key' in item)) group.items.sort((a, b) => rowOrder(a) - rowOrder(b) || rowIdentity(a).localeCompare(rowIdentity(b)));
  }

  return grouped;
}

export function AgendaPanel({ space = null }: { space?: Space | null }): ReactElement {
  const refreshKey = useRefreshOnFocus();
  const zone = useAccountZone();
  // Scoped to this space: its Agenda lists its own events, never every space's.
  const { items, google, loading: fetching, error, range, setRange } = useAgenda(space?.id ?? null);

  // Day keys in the account's zone, the same days Today and Calendar show.
  const [monthKey, setMonthKey] = useState<string>(() => todayKey(zone));
  const [selectedKey, setSelectedKey] = useState<string>(() => todayKey(zone));
  const [filtering, setFiltering] = useState(false);
  const [dialog, setDialog] = useState<EventDialogTarget | null>(null);

  // The hook opens on a fixed window around today; ask for the month on screen
  // instead, so the list is real for any month.
  const monthPrefix = monthKey.slice(0, 7);
  useEffect(() => {
    setRange(monthRange(monthPrefix, zone));
  }, [monthPrefix, zone, setRange]);

  // Coming back to the tab refetches the same range. The refetch replaces the
  // list in place: only the first load and a month change show the loading message.
  const rangeRef = useRef<AgendaRange>(range);
  rangeRef.current = range;
  const refreshing = useRef(false);
  useEffect(() => {
    if (refreshKey === 0) return;
    refreshing.current = true;
    setRange({ ...rangeRef.current });
  }, [refreshKey, setRange]);
  useEffect(() => {
    if (!fetching) refreshing.current = false;
  }, [fetching]);
  const reload = (): void => {
    refreshing.current = true;
    setRange({ ...rangeRef.current });
  };
  const firstLoad = useInitialLoading(fetching);
  const loading = fetching && (firstLoad || !refreshing.current);

  const month = new Date(`${monthPrefix}-01T12:00:00`);
  const grouped = groupAgenda(items, google.remote_items, month, zone);

  // The hook's first window (around today) can spill into the neighbouring months; the list is the month's own.
  const inMonth = grouped.filter((group) => group.key === 'unknown' || group.key.startsWith(monthPrefix));
  const visible = filtering ? grouped.filter((group) => group.key === selectedKey) : inMonth;
  const settled = !loading && error === null;

  // A notification link (/spaces/<id>/agenda?event=<id>) opens that event once it has loaded.
  const linkedEvent = useRef<string | null>(linkedEventId());
  useEffect(() => {
    const wanted = linkedEvent.current;
    if (wanted === null || loading) return;
    const item = items.find((candidate) => candidate.event_id === wanted);
    if (item === undefined) return;
    linkedEvent.current = null;
    setDialog({ mode: item.origin === 'native' && item.can_edit === true ? 'edit' : 'view', item });
  }, [items, loading]);

  return (
    // Section, not a bare <section>: it carries the landmark AND takes part in
    // layout, so every line below sits inside the same gutter it sets.
    <Section variant="transparent" padding={SPACE_GUTTER} height="100%" role="region" aria-label="Agenda">
      <VStack gap={3} height="100%">
        {space !== null && (
          <HStack hAlign="end">
            <Button
              label="New event"
              variant="secondary"
              size="sm"
              icon={<Icon icon={PlusIcon} size="sm" />}
              onClick={() => setDialog({ mode: 'create', space, day: selectedKey })}
            />
          </HStack>
        )}

        <CalendarGrid
          value={selectedKey}
          onChange={(picked) => {
            setSelectedKey(picked);
            setFiltering(true);
          }}
          focusDate={monthKey}
          onFocusDateChange={(focus) => {
            setMonthKey(focus);
            // A day picked in the old month is not in this month's list to filter.
            setFiltering(false);
          }}
        />

        <StackItem size="fill" isScrollable>
          <VStack gap={3}>
            {loading && (
              <Text type="supporting" size="sm" role="status">
                {LOADING}
              </Text>
            )}
            {!loading && error !== null && <Banner status="error" title={error} container="card" />}
            {settled && <GoogleAgendaStatus state={google} />}
            {/* The Calendar above already names the month on screen, so the
                sentence does not repeat it — and no locale is hardcoded here. */}
            {settled && !filtering && visible.length === 0 && (
              <Text type="supporting" size="sm" as="p">
                Nothing on the agenda this month.
              </Text>
            )}

            {settled &&
              visible.map((group) => (
                <List key={group.key} density="compact" hasDividers header={<DayLabel day={group.key} />}>
                  {group.items.map((item) => 'source_key' in item ? <GoogleAgendaRow key={item.source_key} item={item} /> : (
                    <EventRow
                      item={item}
                      zone={zone}
                      key={`${item.event_id}:${item.original_occurrence_start}`}
                      onEdit={() => setDialog({ mode: 'edit', item })}
                      onView={() => setDialog({ mode: 'view', item })}
                    />
                  ))}
                </List>
              ))}

            {/* A selected day with nothing on it must still change the page: the
                filter is only observable if the empty result is said out loud, or
                a tap on an event-free day reads as a dead control. */}
            {settled && filtering && visible.length === 0 && (
              <Text type="supporting" size="sm" as="p">
                {'Nothing on '}
                <DayLabel day={selectedKey} />
                {'.'}
              </Text>
            )}
          </VStack>
        </StackItem>
      </VStack>

      {dialog !== null && <EventDialog target={dialog} onClose={() => setDialog(null)} onChanged={reload} />}
    </Section>
  );
}
