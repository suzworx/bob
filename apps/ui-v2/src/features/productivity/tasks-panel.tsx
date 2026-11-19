import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ArrowRightLeftIcon, ListTodoIcon, PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { DateInput } from '@astryxdesign/core/DateInput';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { List, ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { useToast } from '@astryxdesign/core/Toast';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { useSession } from '@/lib/auth/use-session';
import { memberDisplayName } from '@/lib/display-name';
import { useTasks, type TaskSummary, type DueValue } from '@/features/productivity/use-tasks';
import { useOptionalSpaces, type Space, type SpaceMember } from '@/features/spaces/use-spaces';
import { useInitialLoading, useRefreshOnFocus } from '../../lib/use-refresh-on-focus';
import { isOverdue, isTaskSort, isTaskView, sortTasks, viewTasks, type TaskSort, type TaskView } from './task-filters';
import { TaskChecklist } from './task-checklist';
import { TaskEditDialog } from './task-edit-dialog';
import { RowMenu, rowClick, TaskOverdueMark, useScrollOnce } from './task-row-menu';
import { SPACE_GUTTER } from '../spaces/space-header';

const LIST_ERROR = 'Tasks could not be loaded.';
const CREATE_ERROR = 'The task could not be created.';
const UPDATE_ERROR = 'The task could not be updated.';
const DELETE_ERROR = 'The task could not be deleted.';
const RESTORE_ERROR = 'The task could not be restored.';
const MOVE_ERROR = 'The task could not be moved.';
const TOGGLE_CONFLICT = 'This task changed elsewhere, so your change was not saved. The list now shows the latest.';
const DELETED_ERROR = 'Deleted tasks could not be loaded.';
const TITLE_MAX = 200;
const SKELETON_ROWS = 3;

const EMPTY: Record<Exclude<TaskView, 'deleted'>, { title: string; description: string }> = {
  open: { title: 'No tasks yet', description: 'Add one above and it shows up here for everyone in the space.' },
  mine: { title: 'Nothing assigned to you', description: 'Tasks someone gives you land here.' },
  done: { title: 'Nothing done yet', description: 'Tick a task and it moves here.' },
};

const SORT_OPTIONS = [
  { value: 'list', label: 'List order' },
  { value: 'due', label: 'Due date' },
  { value: 'newest', label: 'Newest' },
];

/** A task's due date, or nothing at all: an undated task carries no line for
 *  it. A function, not a component, because ListItem gives any non-null
 *  description its own line. `inherit` keeps the row's type and colour. */
function dueLabel(due: DueValue | null): ReactElement | null {
  if (due === null) return null;
  if (due.kind === 'date') {
    return <Timestamp value={`${due.date}T00:00:00`} format="date" type="inherit" color="inherit" />;
  }
  return <Timestamp value={due.at} format="date_time" type="inherit" color="inherit" />;
}

// A Selector value is a string, so "no assignee" needs a stand-in that no user id uses.
const UNASSIGNED = '__unassigned__';

type AssigneeOption = { value: string; label: string };

// "Unassigned" plus each member. Someone who has since left the space keeps an
// option of their own, so the control still shows who holds the task.
function assigneeOptions(members: SpaceMember[], assigneeId: string | null): AssigneeOption[] {
  const options: AssigneeOption[] = [
    { value: UNASSIGNED, label: 'Unassigned' },
    ...members.map((member) => ({ value: member.user_id, label: memberDisplayName(members, member.user_id) })),
  ];
  if (assigneeId !== null && !members.some((member) => member.user_id === assigneeId)) {
    options.push({ value: assigneeId, label: memberDisplayName(members, assigneeId) });
  }
  return options;
}

export function TasksPanel({
  space,
  focusTaskId = null,
}: {
  space: Space;
  /** A deep-linked task (?task=): shown highlighted and scrolled into view once loaded. */
  focusTaskId?: string | null;
}): ReactElement {
  const refreshKey = useRefreshOnFocus();
  const {
    tasks,
    loading: fetching,
    error,
    reload,
    createTask,
    toggleComplete,
    updateTask,
    deleteTask,
    moveTask,
    restoreTask,
    loadTrashed,
  } = useTasks(space.id, refreshKey);
  // Only the first load shows skeleton rows: a refetch on focus keeps the
  // list, the open edit dialog and the add row mounted.
  const loading = useInitialLoading(fetching);
  const members = space.members;
  const { session } = useSession();
  const selfUserId = session?.user.id ?? null;
  // Other spaces this task could move to; none outside a SpacesProvider.
  const moveTargets = (useOptionalSpaces()?.spaces ?? []).filter(
    (other) => other.id !== space.id && !other.archived_at,
  );
  const [draft, setDraft] = useState('');
  const [newAssignee, setNewAssignee] = useState(UNASSIGNED);
  const [newDue, setNewDue] = useState<ISODateString | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  // Enter fires both onEnter and the form's submit, and a state flag would not
  // be visible to the second call yet, so the in-flight guard is a ref.
  const inFlight = useRef(false);
  const addInput = useRef<HTMLInputElement>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [view, setView] = useState<TaskView>('open');
  const [sort, setSort] = useState<TaskSort>('list');
  const [trash, setTrash] = useState<TaskSummary[] | null>(null);
  const [trashFailed, setTrashFailed] = useState(false);
  const toast = useToast();
  const focusRef = useScrollOnce();
  const focused = focusTaskId === null ? undefined : tasks.find((task) => task.id === focusTaskId);
  const focusedDone = focused?.status === 'completed';

  // A deep-linked task that is already done lives under Done.
  useEffect(() => {
    if (focusedDone) setView('done');
  }, [focusedDone]);

  useEffect(() => {
    if (view !== 'deleted') return;
    let cancelled = false;
    setTrash(null);
    setTrashFailed(false);
    void loadTrashed().then((result) => {
      if (cancelled) return;
      if (result === null) setTrashFailed(true);
      else setTrash(result);
    });
    return () => {
      cancelled = true;
    };
  }, [view, loadTrashed]);

  const listFailed = error === LIST_ERROR;
  const now = Date.now();
  const shown = view === 'deleted' ? [] : sortTasks(viewTasks(tasks, view, selfUserId), sort);
  const editing = editingId === null ? null : tasks.find((task) => task.id === editingId) ?? null;

  const fail = (body: string): void => {
    toast({ body, type: 'error' });
  };

  const undoable = (body: string, uniqueID: string, onUndo: () => void): void => {
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

  const submit = async (): Promise<void> => {
    const title = draft.trim();
    if (!title || inFlight.current) return;
    inFlight.current = true;
    setAdding(true);
    try {
      const ok = await createTask({
        title,
        ...(newDue !== undefined ? { due: { kind: 'date', date: newDue } } : {}),
        ...(newAssignee !== UNASSIGNED ? { assigneeUserId: newAssignee } : {}),
      });
      if (ok) {
        setDraft('');
        setNewAssignee(UNASSIGNED);
        setNewDue(undefined);
      } else {
        fail(CREATE_ERROR);
      }
    } finally {
      inFlight.current = false;
      setAdding(false);
    }
  };

  const toggle = async (task: TaskSummary): Promise<void> => {
    const completing = task.status === 'open';
    const result = await toggleComplete(task);
    if (result === 'conflict') {
      fail(TOGGLE_CONFLICT);
      return;
    }
    if (result === 'error') {
      fail(UPDATE_ERROR);
      return;
    }
    if (!completing) return;
    undoable(`Completed ${task.title}`, `task-completed-${task.id}`, () => {
      const current = tasksRef.current.find((t) => t.id === task.id);
      if (current !== undefined && current.status === 'completed') void toggle(current);
    });
  };

  // Delete is a soft delete, so it needs no confirmation: the toast undoes it.
  const remove = async (task: TaskSummary): Promise<void> => {
    if (editingId === task.id) setEditingId(null);
    const ok = await deleteTask(task);
    if (!ok) {
      fail(DELETE_ERROR);
      return;
    }
    undoable(`Deleted ${task.title}`, `task-deleted-${task.id}`, () => {
      void restoreTask(task.id).then((restored) => {
        if (!restored) fail(RESTORE_ERROR);
      });
    });
  };

  const move = async (task: TaskSummary, target: Space): Promise<void> => {
    const result = await moveTask(task, target.id);
    if (result === 'ok') toast({ body: `Moved ${task.title} to ${target.name}` });
    else fail(MOVE_ERROR);
  };

  const restoreFromTrash = async (task: TaskSummary): Promise<void> => {
    const ok = await restoreTask(task.id);
    if (!ok) {
      fail(RESTORE_ERROR);
      return;
    }
    setTrash((prev) => (prev === null ? prev : prev.filter((t) => t.id !== task.id)));
    toast({ body: `Restored ${task.title}` });
  };

  const rowItems = (task: TaskSummary): DropdownMenuOption[] => [
    { label: 'Edit', icon: PencilIcon, onClick: () => setEditingId(task.id) },
    ...(moveTargets.length > 0
      ? [{
        label: 'Move to',
        icon: ArrowRightLeftIcon,
        items: moveTargets.map((target) => ({ label: target.name, onClick: () => void move(task, target) })),
      }]
      : []),
    { type: 'divider' },
    { label: 'Delete', icon: Trash2Icon, variant: 'destructive', onClick: () => void remove(task) },
  ];

  return (
    // Section, not a bare <section>: it carries the landmark AND takes part in
    // layout, so height="100%" reaches the scrollable list below it.
    <Section variant="transparent" padding={SPACE_GUTTER} height="100%" role="region" aria-label="Tasks">
      <VStack gap={4} height="100%">
        {listFailed && (
          <Banner
            status="error"
            title={LIST_ERROR}
            container="card"
            endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => void reload()} />}
          />
        )}

        {!listFailed && view === 'deleted' && (
          <HStack gap={2} vAlign="center">
            <Button
              label="Back to tasks"
              variant="ghost"
              size="sm"
              icon={<Icon icon="chevronLeft" size="sm" />}
              onClick={() => setView('open')}
            />
            <Text type="label">Recently deleted</Text>
          </HStack>
        )}

        {!listFailed && view !== 'deleted' && (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {/* One line; the due date and assignee join it once there is a title to set them for. */}
              <HStack gap={2} vAlign="end" wrap="wrap">
                <StackItem size="fill">
                  <TextInput
                    ref={addInput}
                    label="New task"
                    isLabelHidden
                    value={draft}
                    onChange={(value) => setDraft(value.slice(0, TITLE_MAX))}
                    onEnter={submit}
                    placeholder="Add a task"
                    startIcon={PlusIcon}
                  />
                </StackItem>
                {draft.trim() !== '' && (
                  <>
                    <DateInput
                      label="Due date for new task"
                      isLabelHidden
                      placeholder="Due date"
                      hasClear
                      value={newDue}
                      onChange={(value) => setNewDue(value)}
                    />
                    {members.length > 1 && (
                      <Selector
                        label="Assignee for new task"
                        isLabelHidden
                        width={160}
                        options={assigneeOptions(members, null)}
                        value={newAssignee}
                        onChange={(value) => setNewAssignee(value)}
                      />
                    )}
                    <Button label="Add task" type="submit" variant="primary" isDisabled={adding} />
                  </>
                )}
              </HStack>
            </form>

            <HStack gap={2} wrap="wrap" vAlign="center">
              <SegmentedControl
                label="Show tasks"
                size="sm"
                value={view}
                onChange={(v) => {
                  if (isTaskView(v)) setView(v);
                }}
              >
                <SegmentedControlItem value="open" label="Open" />
                <SegmentedControlItem value="mine" label="Mine" />
                <SegmentedControlItem value="done" label="Done" />
              </SegmentedControl>
              <StackItem size="fill" />
              <Selector
                label="Sort tasks"
                isLabelHidden
                size="sm"
                width={128}
                options={SORT_OPTIONS}
                value={sort}
                onChange={(v) => {
                  if (isTaskSort(v)) setSort(v);
                }}
              />
              <RowMenu
                label="Task list options"
                items={() => [
                  { label: 'Recently deleted', icon: Trash2Icon, onClick: () => setView('deleted') },
                ]}
              />
            </HStack>
          </>
        )}

        <StackItem size="fill" isScrollable>
          <VStack gap={4}>
            {loading && (
              <VStack gap={3} role="status" aria-label="Loading tasks">
                {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                  <Skeleton key={index} height={40} index={index} />
                ))}
              </VStack>
            )}

            {!loading && !listFailed && view !== 'deleted' && shown.length === 0 && (
              <EmptyState
                isCompact
                icon={<Icon icon={ListTodoIcon} size="lg" />}
                title={EMPTY[view].title}
                description={EMPTY[view].description}
                actions={
                  view === 'open'
                    ? <Button label="Add a task" variant="secondary" size="sm" onClick={() => addInput.current?.focus()} />
                    : undefined
                }
              />
            )}

            {!loading && !listFailed && view !== 'deleted' && shown.length > 0 && (
              <List aria-label={view === 'mine' ? 'My tasks' : view === 'done' ? 'Completed tasks' : 'Open tasks'} density="compact" hasDividers>
                {shown.map((task) => (
                  <ListItem
                    key={task.id}
                    ref={task.id === focusTaskId ? focusRef : undefined}
                    isSelected={task.id === focusTaskId}
                    label={task.title}
                    description={dueLabel(task.due)}
                    onClick={rowClick(() => setEditingId(task.id))}
                    startContent={
                      <CheckboxInput
                        label={`Complete ${task.title}`}
                        isLabelHidden
                        value={task.status === 'completed'}
                        onChange={() => void toggle(task)}
                      />
                    }
                    endContent={
                      <HStack gap={1} vAlign="center">
                        {isOverdue(task, now) && <TaskOverdueMark />}
                        {task.assignee_user_id !== null && (
                          <Token label={memberDisplayName(members, task.assignee_user_id)} color="default" />
                        )}
                        <RowMenu label={`Actions for ${task.title}`} items={() => rowItems(task)} />
                      </HStack>
                    }
                  />
                ))}
              </List>
            )}

            {!loading && !listFailed && view === 'deleted' && (
              <DeletedTaskList trash={trash} trashFailed={trashFailed} onRestore={(task) => void restoreFromTrash(task)} />
            )}

            <TaskEditDialog
              task={editing}
              assigneeOptions={editing === null || members.length === 0 ? [] : assigneeOptions(members, editing.assignee_user_id)}
              unassignedValue={UNASSIGNED}
              onSave={updateTask}
              onClose={() => setEditingId(null)}
              onDelete={(task) => void remove(task)}
            >
              {editing !== null && <TaskChecklist key={editing.id} taskId={editing.id} />}
            </TaskEditDialog>
          </VStack>
        </StackItem>
      </VStack>
    </Section>
  );
}

function DeletedTaskList({
  trash,
  trashFailed,
  onRestore,
}: {
  trash: TaskSummary[] | null;
  trashFailed: boolean;
  onRestore: (task: TaskSummary) => void;
}): ReactElement {
  if (trash === null) {
    if (trashFailed) {
      return <Banner status="error" title={DELETED_ERROR} container="card" />;
    }
    return (
      <VStack gap={3} role="status" aria-label="Loading deleted tasks">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} height={40} index={index} />
        ))}
      </VStack>
    );
  }

  if (trash.length === 0) {
    return <EmptyState isCompact title="Nothing deleted" description="Tasks you delete wait here, so you can bring them back." />;
  }

  return (
    <List aria-label="Deleted tasks" density="compact" hasDividers>
      {trash.map((task) => (
        <ListItem
          key={task.id}
          label={task.title}
          description={
            <>
              {'Deleted '}
              <Timestamp value={task.trashed_at!} format="date" type="inherit" color="inherit" />
            </>
          }
          endContent={
            <RowMenu
              label={`Actions for ${task.title}`}
              items={() => [{ label: 'Restore', icon: RotateCcwIcon, onClick: () => onRestore(task) }]}
            />
          }
        />
      ))}
    </List>
  );
}
