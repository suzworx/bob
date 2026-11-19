import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { BellIcon, CalendarCheckIcon, CalendarIcon, CheckSquareIcon, PlusIcon, SparklesIcon, TimerIcon } from 'lucide-react';
import { useImperativeAlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent, LayoutHeader, LayoutPanel } from '@astryxdesign/core/Layout';
import { ListItem } from '@astryxdesign/core/List';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { GoogleAgendaRow, GoogleAgendaStatus } from '@/features/integrations/google-agenda-row';
import { useSession } from '@/lib/auth/use-session';
import { BRAND } from '@/lib/brand';
import { memberDisplayName } from '@/lib/display-name';
import { useActionItems } from '@/features/memory/use-action-items';
import { isActionItemOverdue, type ActionItem } from '@/features/memory/memory-api';
import { cancelReminder, createReminder, snoozeChoices, snoozeReminder, type ReminderSummary } from '@/features/productivity/use-reminders';
import { patchTask, type TaskPatch, type TaskSummary, type TaskWriteResult } from '@/features/productivity/use-tasks';
import { formatCountdown, useTimers, type RunningTimer } from '@/features/productivity/use-timers';
import {
  formatZoneDate,
  formatZoneTime,
  localDayKey,
  useAccountZone,
  useDayItems,
  type TodayItem,
  type TodayReminderItem,
  type TodayTaskItem,
} from '@/features/productivity/use-today';
import { useOptionalSpaces, type Space } from '@/features/spaces/use-spaces';
import { GroupedList } from '../../app/grouped-list';
import { PAGE_WIDTH, PageTitle, usePagePadding } from '../../app/page-width';
import { navigateTo } from '../../app/routes';
import { useInitialLoading, useRefreshOnFocus } from '../../lib/use-refresh-on-focus';
import { CalendarGrid, DayLabel } from './calendar-grid';
import { EventDialog, type EventDialogTarget } from './event-dialog';
import { ReminderDialog, type ReminderDialogTarget } from './reminder-dialog';
import { RsvpToken } from './rsvp-token';
import { TaskEditDialog } from './task-edit-dialog';
import { isDueOverdue } from './task-filters';
import { RowMenu, rowClick, TaskOverdueMark } from './task-row-menu';

/** How many days the Calendar lists: the selected day and the week after it. */
const CALENDAR_DAYS = 8;
/** The month grid's own width beside the list (design: about 280px). */
const GRID_PANEL_WIDTH = 296;
const UNASSIGNED = '__unassigned__';

/** The reminder a notification points at (`/today?reminder=<id>`), if any. */
function linkedReminderId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('reminder');
  } catch {
    return null;
  }
}

/** Only a task is ever overdue, by the one rule every task row uses. */
function isOverdue(item: TodayItem, now: number, todayKey: string): boolean {
  return item.kind === 'task' && isDueOverdue(item.due, now, todayKey);
}

function taskLabel(item: TodayTaskItem, zone: string, overdue: boolean): string {
  const due = item.due;
  if (overdue) {
    const when = due.kind === 'instant' ? `${formatZoneTime(due.at, zone)} ${formatZoneDate(due.at, zone)}` : due.date;
    return `Task · ${item.spaceName} · due ${when}`;
  }
  if (due.kind !== 'instant') return `Task · ${item.spaceName}`;
  return `Task · ${item.spaceName} · ${formatZoneTime(due.at, zone)}`;
}

function reminderLabel(item: TodayReminderItem, zone: string): string {
  if (item.repeat === null) return `Reminder · ${item.spaceName} · ${formatZoneTime(item.at, zone)}`;
  const next = item.isNext ? ` · next ${formatZoneTime(item.at, zone)}` : '';
  return `${item.repeat}${next} · ${item.spaceName}`;
}

/** An event's (native or Google) time, or "All day", then where it lives. */
function eventLabel(item: Exclude<TodayItem, TodayTaskItem | TodayReminderItem>, zone: string): string {
  if (item.kind === 'google') {
    const when = 'date' in item.item.start ? 'All day' : formatZoneTime(item.sortAt, zone);
    return `${when} · Google Calendar · read-only`;
  }
  if (item.allDay) return `All day · ${item.spaceName}`;
  if (item.startAt === null) return `Event · ${item.spaceName}`;
  return `${formatZoneTime(item.startAt, zone)} · ${item.spaceName}`;
}

/** When an item happens, as words, and where it lives. Every time is the account zone's. */
function timeLabel(item: TodayItem, zone: string, overdue: boolean): string {
  if (item.kind === 'task') return taskLabel(item, zone, overdue);
  if (item.kind === 'reminder') return reminderLabel(item, zone);
  return eventLabel(item, zone);
}

const KIND_ICON = { task: CheckSquareIcon, reminder: BellIcon, event: CalendarIcon, google: CalendarIcon } as const;

/** `/today` (#870): my day in the account's time zone, the one place for to-dos. */
export function TodayPage(): ReactElement {
  return <CalendarPage view="today" />;
}

type Undoable = (body: string, uniqueID: string, onUndo: () => void) => void;

function useUndoToast(): { undoable: Undoable; fail: (body: string) => void; say: (body: string) => void } {
  const toast = useToast();
  const undoable: Undoable = (body, uniqueID, onUndo) => {
    let dismiss: () => void = () => undefined;
    dismiss = toast({
      body,
      uniqueID,
      isAutoHide: true,
      autoHideDuration: 8000,
      endContent: (
        <Button
          label="Undo"
          size="sm"
          variant="secondary"
          onClick={() => {
            dismiss();
            onUndo();
          }}
        />
      ),
    });
  };
  return { undoable, fail: (body) => void toast({ body, type: 'error' }), say: (body) => void toast({ body }) };
}

export function CalendarPage({ view = 'calendar' }: { view?: 'calendar' | 'today' } = {}): ReactElement {
  const isToday = view === 'today';
  const refreshKey = useRefreshOnFocus();
  const zone = useAccountZone();
  const me = useSession().session?.user.id ?? null;
  // One zone everywhere: the account's, on Today and on the Calendar alike.
  const [pickedDay, setDay] = useState<string>(() => localDayKey(Date.now(), zone));
  const day = isToday ? localDayKey(Date.now(), zone) : pickedDay;
  const { items, loading: fetching, error, unavailableSpaces, eventsUnavailable, google, loadedDay, refresh } = useDayItems(
    day,
    refreshKey,
    zone,
    isToday ? { me } : { me, days: CALENDAR_DAYS, overdue: false },
  );
  const initialLoading = useInitialLoading(fetching);
  const loading = initialLoading || loadedDay !== day || (fetching && error !== null);

  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
  const spaces = useOptionalSpaces();
  const writableSpaces = spaces?.spaces.filter((space) => !space.archived_at) ?? [];
  const spaceById = (id: string): Space | undefined => writableSpaces.find((space) => space.id === id);
  const [reminderDialog, setReminderDialog] = useState<ReminderDialogTarget | null>(null);
  const [eventDialog, setEventDialog] = useState<EventDialogTarget | null>(null);
  const [editingTask, setEditingTask] = useState<TaskSummary | null>(null);
  const alert = useImperativeAlertDialog();
  const { undoable, fail, say } = useUndoToast();
  const highlight = isToday ? linkedReminderId() : null;

  const privateSpace = writableSpaces.find((space) => space.kind === 'private') ?? writableSpaces[0];
  const canCreate = me !== null && privateSpace !== undefined;

  const openNewReminder = (): void => {
    if (me === null || writableSpaces.length === 0) return;
    setReminderDialog({ mode: 'create', spaces: writableSpaces, day, zone, me });
  };
  const openNewEvent = (): void => {
    if (privateSpace === undefined) return;
    setEventDialog({ mode: 'create', space: privateSpace, day, spaces: writableSpaces });
  };
  const openNewTask = (): void => {
    // A task has one home and one editor: its space's task list.
    const target = spaces?.activeSpace ?? privateSpace;
    if (target === undefined) return;
    navigateTo(`/spaces/${target.id}/tasks`);
  };

  const newItems: DropdownMenuOption[] = [
    { label: 'Task', icon: CheckSquareIcon, onClick: openNewTask },
    { label: 'Reminder', icon: BellIcon, onClick: openNewReminder },
    { label: 'Event', icon: CalendarIcon, onClick: openNewEvent },
  ];

  const cancelOne = async (reminder: ReminderSummary): Promise<void> => {
    const result = await cancelReminder(reminder.id);
    if (!result.ok) {
      fail('The reminder could not be cancelled.');
      return;
    }
    await refresh();
  };

  const askCancel = (reminder: ReminderSummary, space: Space | undefined): void => {
    if (space !== undefined && space.kind !== 'private') {
      // Shared: it stops for everyone it reaches, which an Undo cannot unsay.
      alert.show({
        title: `Cancel “${reminder.title}”?`,
        description: `It stops for everyone in ${space.name}, not just you.`,
        actionLabel: 'Cancel reminder',
        cancelLabel: 'Keep it',
        onAction: () => {
          alert.hide();
          void cancelOne(reminder);
        },
      });
      return;
    }
    void (async () => {
      const result = await cancelReminder(reminder.id);
      if (!result.ok) {
        fail('The reminder could not be cancelled.');
        return;
      }
      await refresh();
      undoable(`Cancelled ${reminder.title}`, `cancel-${reminder.id}`, () => {
        // The API has no "uncancel": a private reminder reaches only me, so
        // bringing it back as it was is a new one with the same schedule.
        void (async () => {
          if (reminder.due_at === null || me === null) return;
          const restored = await createReminder(
            reminder.space_id,
            { title: reminder.title, dueAt: reminder.due_at, zone: reminder.due_zone ?? zone, rrule: reminder.rrule },
            [me],
          );
          if (!restored.ok) fail('The reminder could not be brought back.');
          await refresh();
        })();
      });
    })();
  };

  const snoozeOne = async (reminder: ReminderSummary, until: number): Promise<void> => {
    const previous = reminder.due_at;
    const result = await snoozeReminder(reminder, until);
    if (!result.ok) {
      fail('The reminder could not be snoozed.');
      return;
    }
    await refresh();
    const when = localDayKey(until, zone) === localDayKey(Date.now(), zone)
      ? formatZoneTime(until, zone)
      : `${formatZoneDate(until, zone)}, ${formatZoneTime(until, zone)}`;
    undoable(`Snoozed until ${when}`, `snooze-${reminder.id}`, () => {
      if (previous === null) return;
      void snoozeReminder(reminder, previous).then(async (undone) => {
        if (!undone.ok) fail('The snooze could not be undone.');
        await refresh();
      });
    });
  };

  const complete = async (item: TodayTaskItem): Promise<void> => {
    if (completing.has(item.id)) return;
    setCompleting((prev) => new Set(prev).add(item.id));
    const result = await patchTask(item.id, { revision: item.revision, status: 'completed' });
    if (result.kind === 'ok') {
      await refresh();
      undoable(`Completed ${item.title}`, `task-${item.id}`, () => {
        void patchTask(item.id, { revision: result.task.revision, status: 'open' }).then(async (undone) => {
          if (undone.kind !== 'ok') fail('The task could not be reopened.');
          await refresh();
        });
      });
    } else if (result.kind === 'conflict') {
      fail('This task changed elsewhere. The list has been refreshed.');
      await refresh();
    } else {
      fail('The task could not be completed.');
    }
    setCompleting((prev) => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
  };

  const saveTask = async (task: TaskSummary, patch: TaskPatch): Promise<TaskWriteResult> => {
    const result = await patchTask(task.id, {
      revision: task.revision,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.due !== undefined ? { due: patch.due } : {}),
      ...(patch.assigneeUserId !== undefined ? { assignee_user_id: patch.assigneeUserId } : {}),
    });
    if (result.kind === 'ok') {
      await refresh();
      return 'ok';
    }
    return result.kind === 'conflict' ? 'conflict' : 'error';
  };

  const rowMenu = (item: TodayItem): ReactElement | null => {
    if (item.kind === 'task') {
      return (
        <RowMenu
          label={`Actions for ${item.title}`}
          items={() => [
            { label: 'Edit', onClick: () => setEditingTask(item.task) },
            { label: 'Complete', onClick: () => void complete(item) },
          ]}
        />
      );
    }
    if (item.kind === 'event') {
      const editable = item.agenda.origin === 'native' && item.agenda.can_edit === true;
      return (
        <RowMenu
          label={`Actions for ${item.title}`}
          items={() => [
            editable
              ? { label: 'Edit', onClick: () => setEventDialog({ mode: 'edit', item: item.agenda }) }
              : { label: 'Details', onClick: () => setEventDialog({ mode: 'view', item: item.agenda }) },
          ]}
        />
      );
    }
    if (item.kind === 'reminder') {
      const { reminder } = item;
      const space = spaceById(reminder.space_id);
      return (
        <RowMenu
          label={`Actions for ${item.title}`}
          items={() => [
            { label: 'Edit', onClick: () => setReminderDialog({ mode: 'edit', reminder, zone: reminder.due_zone ?? zone, space, me: me ?? undefined }) },
            reminder.rrule === null
              ? {
                  label: 'Snooze',
                  items: snoozeChoices(Date.now(), reminder.due_zone ?? zone).map((choice) => ({
                    label: choice.label,
                    onClick: () => void snoozeOne(reminder, choice.until),
                  })),
                }
              : { label: 'Snooze', isDisabled: true, description: 'Snooze a repeating reminder when it rings.' },
            { type: 'divider' },
            { label: 'Cancel reminder', variant: 'destructive', onClick: () => askCancel(reminder, space) },
          ]}
        />
      );
    }
    return null;
  };

  const openRow = (item: TodayItem): (() => void) | undefined => {
    if (item.kind === 'task') return () => setEditingTask(item.task);
    if (item.kind === 'event') {
      const editable = item.agenda.origin === 'native' && item.agenda.can_edit === true;
      return () => setEventDialog({ mode: editable ? 'edit' : 'view', item: item.agenda });
    }
    if (item.kind === 'reminder') {
      const { reminder } = item;
      return () => setReminderDialog({
        mode: 'edit', reminder, zone: reminder.due_zone ?? zone, space: spaceById(reminder.space_id), me: me ?? undefined,
      });
    }
    return undefined;
  };

  const now = Date.now();
  const todayKey = localDayKey(now, zone);
  const renderRow = (item: TodayItem): ReactElement =>
    item.kind === 'google' ? (
      <GoogleAgendaRow key={item.id} item={item.item} />
    ) : (
      <ItemRow
        key={item.id}
        item={item}
        zone={zone}
        isCompleting={completing.has(item.id)}
        overdue={isOverdue(item, now, todayKey)}
        isHighlighted={item.kind === 'reminder' && item.reminder.id === highlight}
        onComplete={(task) => void complete(task)}
        onOpen={openRow(item)}
        actions={rowMenu(item)}
      />
    );

  const dialogs = (
    <>
      {alert.element}
      {reminderDialog !== null && (
        <ReminderDialog target={reminderDialog} onClose={() => setReminderDialog(null)} onChanged={() => void refresh()} />
      )}
      {eventDialog !== null && (
        <EventDialog target={eventDialog} onClose={() => setEventDialog(null)} onChanged={() => void refresh()} />
      )}
      <TaskEditDialog
        task={editingTask}
        assigneeOptions={taskAssignees(editingTask, spaces?.spaces ?? [])}
        unassignedValue={UNASSIGNED}
        onSave={saveTask}
        onClose={() => setEditingTask(null)}
      />
    </>
  );

  const status = (
    <>
      {!loading && error === null && unavailableSpaces.length > 0 && (
        <Banner
          status="warning"
          title={`Could not load ${unavailableSpaces.join(', ')}.`}
          container="card"
          endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => void refresh()} />}
        />
      )}
      {!loading && error === null && eventsUnavailable && (
        <Banner
          status="warning"
          title="Events could not be loaded."
          container="card"
          endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => void refresh()} />}
        />
      )}
      {!loading && error === null && google !== null && <GoogleAgendaStatus state={google} />}
    </>
  );

  const { isMobile } = useAppShellMobile();
  const header = (
    <LayoutHeader>
      <HStack gap={4} hAlign="between" vAlign="center">
        <VStack gap={1}>
          <PageTitle>{isToday ? 'Today' : 'Calendar'}</PageTitle>
          <Text type="supporting" maxLines={isMobile ? 1 : undefined}>
            {isToday ? <DayLabel day={day} /> : 'Your day and what is coming up.'}
          </Text>
        </VStack>
        {canCreate && (
          <DropdownMenu
            button={{ label: 'New', variant: 'primary', size: isMobile ? 'sm' : undefined, icon: <Icon icon={PlusIcon} size="sm" /> }}
            alignment="end"
            presentation="adaptive"
            items={newItems}
          />
        )}
      </HStack>
      {dialogs}
    </LayoutHeader>
  );

  const loadingRows = (
    <VStack gap={2} role="status" aria-label="Loading">
      {[0, 1, 2].map((index) => <Skeleton key={index} height={40} index={index} />)}
    </VStack>
  );
  const loadError = (
    <Banner
      status="error"
      title="The calendar could not be loaded."
      container="card"
      endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => void refresh()} />}
    />
  );

  if (isToday) {
    return (
      <TodayLayout
        header={header}
        status={status}
        loading={loading}
        loadingRows={loadingRows}
        loadError={error !== null ? loadError : null}
        refreshKey={refreshKey}
        overdue={items.filter((item) => isOverdue(item, now, todayKey))}
        today={items.filter((item) => !isOverdue(item, now, todayKey))}
        renderRow={renderRow}
        undoable={undoable}
        fail={fail}
        say={say}
        highlight={highlight}
      />
    );
  }

  const selected = items.filter((item) => item.day === day);
  const upcoming = items.filter((item) => item.day > day);
  const upcomingGroups: Array<{ key: string; items: TodayItem[] }> = [];
  for (const item of upcoming) {
    const existing = upcomingGroups.find((group) => group.key === item.day);
    if (existing) existing.items.push(item);
    else upcomingGroups.push({ key: item.day, items: [item] });
  }

  return (
    <CalendarLayout
      header={header}
      grid={<CalendarGrid value={day} onChange={setDay} />}
      body={
        <VStack gap={6}>
          {status}
          {loading && loadingRows}
          {!loading && error !== null && loadError}
          {!loading && error === null && (
            <>
              {selected.length > 0 ? (
                <GroupedList label={<DayLabel day={day} />}>
                  {selected.map(renderRow)}
                </GroupedList>
              ) : (
                <EmptyState
                  title="Nothing on this day"
                  description="Tasks, events and reminders show up here."
                  icon={<Icon icon={CalendarCheckIcon} size="lg" />}
                  headingLevel={2}
                  isCompact
                  actions={canCreate ? <Button label="New event" variant="secondary" onClick={openNewEvent} /> : undefined}
                />
              )}
              {upcomingGroups.length > 0 && (
                <VStack gap={3}>
                  <Heading level={2}>Coming up</Heading>
                  {upcomingGroups.map((group) => (
                    <GroupedList key={group.key} label={<DayLabel day={group.key} />}>
                      {group.items.map(renderRow)}
                    </GroupedList>
                  ))}
                </VStack>
              )}
            </>
          )}
        </VStack>
      }
    />
  );
}

/** The assignee choices for a task being edited from Today or Calendar. */
function taskAssignees(task: TaskSummary | null, spaces: Space[]): Array<{ value: string; label: string }> {
  if (task === null) return [];
  const space = spaces.find((candidate) => candidate.id === task.space_id);
  if (space === undefined || space.kind === 'private') return [];
  return [
    { value: UNASSIGNED, label: 'Anyone' },
    ...space.members.map((member) => ({ value: member.user_id, label: memberDisplayName(space.members, member.user_id) })),
  ];
}

// The Calendar: the month grid at its own width beside the selected day and
// what is coming up (LayoutPanel). On a phone the grid sits above the list.
//   >768  grid panel 296 | list
//   <=768 one column: grid, then list   (Astryx mobile breakpoint)
function CalendarLayout({ header, grid, body }: { header: ReactElement; grid: ReactElement; body: ReactElement }): ReactElement {
  const { isMobile: isNarrow } = useAppShellMobile();
  const padding = usePagePadding();
  if (isNarrow) {
    return (
      <Layout
        height="fill"
        padding={padding}
        contentWidth={PAGE_WIDTH}
        header={header}
        content={
          <LayoutContent label="Calendar">
            <VStack gap={6}>
              {grid}
              {body}
            </VStack>
          </LayoutContent>
        }
      />
    );
  }
  return (
    <Layout
      height="fill"
      padding={padding}
      contentWidth={PAGE_WIDTH}
      header={header}
      start={
        <LayoutPanel width={GRID_PANEL_WIDTH} label="Month" isScrollable={false}>
          {grid}
        </LayoutPanel>
      }
      content={<LayoutContent label="Calendar">{body}</LayoutContent>}
    />
  );
}

// Today: one list in fixed groups. Timers (only while one runs), Overdue,
// Today, then Suggested by Bob. One EmptyState, only when every group is empty.
function TodayLayout({
  header,
  status,
  loading,
  loadingRows,
  loadError,
  refreshKey,
  overdue,
  today,
  renderRow,
  undoable,
  fail,
  say,
  highlight,
}: {
  header: ReactElement;
  status: ReactNode;
  loading: boolean;
  loadingRows: ReactElement;
  loadError: ReactElement | null;
  refreshKey: number;
  overdue: TodayItem[];
  today: TodayItem[];
  renderRow: (item: TodayItem) => ReactElement;
  undoable: Undoable;
  fail: (body: string) => void;
  say: (body: string) => void;
  highlight: string | null;
}): ReactElement {
  const actions = useActionItems({ refreshKey });
  const zone = useAccountZone();
  const timers = useTimers(refreshKey);
  const suggestions = actions.isUnavailable ? [] : actions.items;
  const highlightRef = useRef(false);

  // A notification link (/today?reminder=<id>) brings its row into view once.
  useEffect(() => {
    if (highlight === null || highlightRef.current || loading) return;
    const row = document.querySelector(`[data-reminder-id="${CSS.escape(highlight)}"]`);
    if (row !== null) {
      highlightRef.current = true;
      row.scrollIntoView?.({ block: 'center' });
    }
  }, [highlight, loading, today, overdue]);

  const addAsTask = async (item: ActionItem): Promise<void> => {
    const result = await actions.toTask(item.id);
    if (result === null) {
      fail(actions.error === 'no_private_space' ? 'There is no private space to add it to.' : 'It could not be added as a task.');
      return;
    }
    say(result.spaceName === null ? 'Added as a task' : `Added to ${result.spaceName}`);
  };
  const closeSuggestion = async (item: ActionItem, how: 'complete' | 'dismiss'): Promise<void> => {
    const ok = how === 'complete' ? await actions.complete(item.id) : await actions.dismiss(item.id);
    if (!ok) {
      fail('The suggestion could not be updated.');
      return;
    }
    undoable(how === 'complete' ? `Done: ${item.content}` : `Dismissed ${item.content}`, `suggestion-${item.id}`, () => {
      void actions.undo(item.id).then((undone) => {
        if (!undone) fail('That could not be undone.');
      });
    });
  };

  const everythingEmpty =
    !loading && loadError === null && overdue.length === 0 && today.length === 0 &&
    suggestions.length === 0 && !actions.isLoading && actions.error !== 'load_failed' && timers.timers.length === 0;
  const now = Date.now();

  const padding = usePagePadding();
  return (
    <Layout
      height="fill"
      padding={padding}
      contentWidth={PAGE_WIDTH}
      header={header}
      content={
        <LayoutContent label="Today">
          <VStack gap={6}>
            <RunningTimers state={timers} />
            {status}
            {loading && loadingRows}
            {!loading && loadError}
            {everythingEmpty && (
              <EmptyState
                title="Nothing due today"
                description={`Your tasks, reminders, events and ${BRAND.name}'s suggestions show up here.`}
                icon={<Icon icon={CalendarCheckIcon} size="lg" />}
                headingLevel={2}
              />
            )}
            {!loading && loadError === null && overdue.length > 0 && (
              <GroupedList label={`Overdue · ${overdue.length}`}>
                {overdue.map(renderRow)}
              </GroupedList>
            )}
            {!loading && loadError === null && today.length > 0 && (
              <GroupedList label={`Today · ${today.length}`}>
                {today.map(renderRow)}
              </GroupedList>
            )}
            {actions.error === 'load_failed' && (
              <Banner
                status="warning"
                title={`${BRAND.name}'s suggestions could not be loaded.`}
                container="card"
                endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => void actions.reload()} />}
              />
            )}
            {suggestions.length > 0 && (
              <GroupedList label={`Suggested by ${BRAND.name} · ${suggestions.length}`}>
                {suggestions.map((item) => (
                  <ListItem
                    key={item.id}
                    label={item.content}
                    description={item.due_at === null ? undefined : `Due ${formatZoneDate(item.due_at, zone)}`}
                    startContent={<Icon icon={SparklesIcon} size="sm" />}
                    endContent={
                      <HStack gap={2} vAlign="center">
                        {isActionItemOverdue(item, now) && <TaskOverdueMark />}
                        <Button label="Add" size="sm" variant="secondary" tooltip={`Add ${item.content} as a task`} onClick={() => void addAsTask(item)} />
                        <RowMenu
                          label={`Actions for ${item.content}`}
                          items={() => [
                            { label: 'Add as task', onClick: () => void addAsTask(item) },
                            { label: 'Mark done', onClick: () => void closeSuggestion(item, 'complete') },
                            { type: 'divider' },
                            { label: 'Dismiss', onClick: () => void closeSuggestion(item, 'dismiss') },
                          ]}
                        />
                      </HStack>
                    }
                  />
                ))}
              </GroupedList>
            )}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

// One row: the kind is the icon, the title is the row, and when it happens
// (and where it lives) sits under it. The tick leads a task; one menu ends it.
function ItemRow({
  item,
  zone,
  isCompleting,
  overdue,
  isHighlighted,
  onComplete,
  onOpen,
  actions,
}: {
  item: Exclude<TodayItem, { kind: 'google' }>;
  zone: string;
  isCompleting: boolean;
  overdue: boolean;
  isHighlighted: boolean;
  onComplete: (item: TodayTaskItem) => void;
  onOpen: (() => void) | undefined;
  actions: ReactElement | null;
}): ReactElement {
  const reminderId = item.kind === 'reminder' ? (item as TodayReminderItem).reminder.id : undefined;
  return (
    <ListItem
      label={item.title}
      description={timeLabel(item, zone, overdue)}
      isSelected={isHighlighted}
      data-reminder-id={reminderId}
      data-space-kind={item.spaceKind}
      onClick={onOpen === undefined ? undefined : rowClick(onOpen)}
      startContent={
        item.kind === 'task' ? (
          <CheckboxInput
            label={`Complete ${item.title}`}
            isLabelHidden
            value={isCompleting}
            onChange={() => onComplete(item)}
          />
        ) : (
          <Icon icon={KIND_ICON[item.kind]} size="sm" />
        )
      }
      endContent={
        <HStack gap={2} vAlign="center">
          {overdue && <TaskOverdueMark />}
          {item.kind === 'event' && <RsvpToken response={item.myResponse} />}
          {actions}
        </HStack>
      }
    />
  );
}

const TIMER_KIND_LABEL: Record<RunningTimer['kind'], string> = { timer: 'Timer', alarm: 'Alarm' };

// Timers and alarms that are running now (#457), first on Today so "where is
// my timer?" is answered at a glance. Renders nothing when none are running.
function RunningTimers({ state }: { state: ReturnType<typeof useTimers> }): ReactElement | null {
  const { timers, now, cancel } = state;
  const zone = useAccountZone();
  const [cancelError, setCancelError] = useState(false);
  if (timers.length === 0) return null;
  return (
    <VStack gap={2}>
      {cancelError && <Banner status="warning" title="The timer could not be cancelled." container="card" />}
      <GroupedList label="Timers">
        {timers.map((timer) => {
          const kind = TIMER_KIND_LABEL[timer.kind];
          const name = timer.label ?? kind;
          const ringsAt = new Date(timer.fire_at).getTime();
          return (
            <ListItem
              key={timer.id}
              label={name}
              description={
                timer.kind === 'timer' ? (
                  <Text type="inherit" hasTabularNumbers role="timer">
                    {`${formatCountdown(timer.endsAt - now)} left`}
                  </Text>
                ) : (
                  `Rings at ${timer.endsAt - now < 24 * 60 * 60 * 1000 ? '' : `${formatZoneDate(ringsAt, zone)}, `}${formatZoneTime(ringsAt, zone)}`
                )
              }
              startContent={<Icon icon={TimerIcon} size="sm" />}
              endContent={
                <Button
                  label="Cancel"
                  size="sm"
                  variant="ghost"
                  tooltip={`Cancel ${name}`}
                  clickAction={async () => setCancelError(!(await cancel(timer.id)))}
                />
              }
            />
          );
        })}
      </GroupedList>
    </VStack>
  );
}
