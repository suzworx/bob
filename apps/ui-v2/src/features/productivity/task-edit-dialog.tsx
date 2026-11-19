import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { DateInput } from '@astryxdesign/core/DateInput';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from '@astryxdesign/core/Layout';
import { Selector } from '@astryxdesign/core/Selector';
import { StackItem } from '@astryxdesign/core/Stack';
import { Switch } from '@astryxdesign/core/Switch';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TimeInput, type ISOTimeString } from '@astryxdesign/core/TimeInput';
import { browserTimeZone, fetchWithAuth, useSession } from '@/lib/auth/use-session';
import { instantToWall, wallToInstant } from '@/features/productivity/use-reminders';
import type { DueValue, TaskPatch, TaskSummary, TaskWriteResult } from '@/features/productivity/use-tasks';

const SAVE_ERROR = 'The task could not be saved.';
const FOLLOWERS_LOAD_ERROR = "Couldn't load who gets notified.";
const FOLLOW_SAVE_ERROR = "Your edits are saved, but notifications couldn't change. Try again.";
const CONFLICT_NOTICE =
  'This task changed elsewhere. Your edits are kept — save again to apply them.';

export function isIsoDate(value: string): value is ISODateString {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isIsoTime(value: string): value is ISOTimeString {
  return /^\d{2}:\d{2}$/.test(value);
}

/** The zone a due is read and written in: a timed due keeps its own zone. */
function dueZone(due: DueValue | null): string {
  return due?.kind === 'instant' ? due.zone : browserTimeZone();
}

/** The date a due falls on, in the due's own zone for a timed due. */
export function dueToInput(due: DueValue | null): ISODateString | undefined {
  if (due === null) return undefined;
  if (due.kind === 'date') return isIsoDate(due.date) ? due.date : undefined;
  const day = instantToWall(due.at, due.zone).slice(0, 10);
  return isIsoDate(day) ? day : undefined;
}

/** The wall time of a timed due in its own zone; undefined for an all-day due. */
export function dueToTime(due: DueValue | null): ISOTimeString | undefined {
  if (due === null || due.kind !== 'instant') return undefined;
  const time = instantToWall(due.at, due.zone).slice(11, 16);
  return isIsoTime(time) ? time : undefined;
}

export type TaskEditDraft = {
  title: string;
  notes: string;
  due: ISODateString | undefined;
  /** Optional time on the due date. Without one the due is all-day. */
  time?: ISOTimeString | undefined;
  assignee: string;
};

function draftDue(
  baseDue: DueValue | null,
  date: ISODateString | undefined,
  time: ISOTimeString | undefined,
): DueValue | null {
  if (date === undefined) return null;
  if (time === undefined) return { kind: 'date', date };
  const zone = dueZone(baseDue);
  return { kind: 'instant', at: wallToInstant(`${date}T${time}`, zone), zone };
}

export function buildPatch(
  base: TaskSummary,
  draft: TaskEditDraft,
  unassignedValue: string,
): TaskPatch {
  const patch: TaskPatch = {};

  const title = draft.title.trim();
  if (title !== base.title) patch.title = title;

  const nextBody = draft.notes.trim() === '' ? null : draft.notes;
  if (nextBody !== base.body) patch.body = nextBody;

  // A timed due survives an edit that leaves its date and time alone, and a
  // changed date keeps the time; only clearing the time makes it all-day.
  if (draft.due !== dueToInput(base.due) || draft.time !== dueToTime(base.due)) {
    patch.due = draftDue(base.due, draft.due, draft.time);
  }

  const nextAssignee = draft.assignee === unassignedValue ? null : draft.assignee;
  if (nextAssignee !== base.assignee_user_id) patch.assigneeUserId = nextAssignee;

  return patch;
}

type AssigneeOption = { value: string; label: string };

/** GET /api/tasks/:id/subscribers body -> follower user ids. The API lists only
 *  active members of the task's space. */
export function parseFollowers(body: unknown): string[] {
  const subscribers = typeof body === 'object' && body !== null
    ? (body as { subscribers?: unknown }).subscribers : undefined;
  if (!Array.isArray(subscribers)) throw new Error('followers_invalid');
  return subscribers.map((sub: unknown) => {
    const userId = typeof sub === 'object' && sub !== null ? (sub as { user_id?: unknown }).user_id : undefined;
    if (typeof userId !== 'string') throw new Error('followers_invalid');
    return userId;
  });
}

async function listFollowers(taskId: string): Promise<string[]> {
  const response = await fetchWithAuth(`/api/tasks/${taskId}/subscribers`);
  if (!response.ok) throw new Error('followers_load_failed');
  return parseFollowers(await response.json());
}

async function setFollowing(taskId: string, userId: string, following: boolean): Promise<void> {
  const response = following
    ? await fetchWithAuth(`/api/tasks/${taskId}/subscribers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    })
    : await fetchWithAuth(`/api/tasks/${taskId}/subscribers/${userId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('follow_save_failed');
}

/** The names to show for the followers: "You" for the caller, a member's name
 *  otherwise. An id with no member name is left out, never shown raw. */
export function followerNames(
  followers: string[],
  me: string | null,
  options: AssigneeOption[],
  unassignedValue: string,
): string[] {
  const labels = new Map(
    options.filter((option) => option.value !== unassignedValue).map((option) => [option.value, option.label]),
  );
  return followers.flatMap((userId) => {
    if (userId === me) return ['You'];
    const label = labels.get(userId);
    return label === undefined ? [] : [label];
  });
}

/** Whether the caller is notified about a task, read once when the dialog opens. */
function useFollowing(taskId: string, me: string | null): {
  state: 'loading' | 'ready' | 'failed';
  followers: string[];
  following: boolean;
} {
  const [followers, setFollowers] = useState<string[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let live = true;
    listFollowers(taskId).then(
      (loaded) => {
        if (!live) return;
        setFollowers(loaded);
        setState('ready');
      },
      () => {
        if (live) setState('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [taskId]);
  return { state, followers, following: me !== null && followers.includes(me) };
}

export function TaskEditDialog(props: {
  task: TaskSummary | null;
  assigneeOptions: Array<{ value: string; label: string }>;
  unassignedValue: string;
  onSave: (task: TaskSummary, patch: TaskPatch) => Promise<TaskWriteResult>;
  onClose: () => void;
  /** Soft delete from inside the dialog; the caller shows the Undo toast. */
  onDelete?: (task: TaskSummary) => void;
  children?: ReactNode;
}): ReactElement {
  const { task, assigneeOptions, unassignedValue, onSave, onClose, onDelete, children } = props;
  return (
    <Dialog
      isOpen={task !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      purpose="form"
      width={480}
      aria-label="Edit task"
    >
      {task !== null && (
        <TaskEditForm
          key={task.id}
          task={task}
          assigneeOptions={assigneeOptions}
          unassignedValue={unassignedValue}
          onSave={onSave}
          onClose={onClose}
          onDelete={onDelete}
        >
          {children}
        </TaskEditForm>
      )}
    </Dialog>
  );
}

const NOTICES = { conflict: CONFLICT_NOTICE, error: SAVE_ERROR, follow: FOLLOW_SAVE_ERROR } as const;

/** The due date, and a time beside it once there is a date. */
function DueFields({
  due,
  time,
  onDue,
  onTime,
}: {
  due: ISODateString | undefined;
  time: ISOTimeString | undefined;
  onDue: (value: ISODateString | undefined) => void;
  onTime: (value: ISOTimeString | undefined) => void;
}): ReactElement {
  return (
    <HStack gap={2} vAlign="start" wrap="wrap">
      <StackItem size="fill">
        <DateInput label="Due date" isOptional hasClear value={due} onChange={onDue} />
      </StackItem>
      {due !== undefined && <TimeInput label="Time" isOptional hasClear value={time} onChange={onTime} />}
    </HStack>
  );
}

/** One switch for the caller's own notifications, saved with the form. */
function NotifySwitch({
  state,
  value,
  others,
  onChange,
}: {
  state: 'loading' | 'ready' | 'failed';
  value: boolean;
  others: string[];
  onChange: (value: boolean) => void;
}): ReactElement {
  let description: string | undefined;
  if (state === 'failed') description = FOLLOWERS_LOAD_ERROR;
  else if (others.length > 0) description = `Also notified: ${others.join(', ')}`;
  return (
    <Switch
      label="Notify me about changes"
      value={value}
      isDisabled={state !== 'ready'}
      isLoading={state === 'loading'}
      onChange={onChange}
      description={description}
    />
  );
}

function TaskEditForm({
  task,
  assigneeOptions,
  unassignedValue,
  onSave,
  onClose,
  onDelete,
  children,
}: {
  task: TaskSummary;
  assigneeOptions: Array<{ value: string; label: string }>;
  unassignedValue: string;
  onSave: (task: TaskSummary, patch: TaskPatch) => Promise<TaskWriteResult>;
  onClose: () => void;
  onDelete?: (task: TaskSummary) => void;
  children?: ReactNode;
}): ReactElement {
  const me = useSession().session?.user.id ?? null;
  const [base] = useState(task);
  const [title, setTitle] = useState(base.title);
  const [notes, setNotes] = useState(base.body ?? '');
  const [due, setDue] = useState<ISODateString | undefined>(dueToInput(base.due));
  const [time, setTime] = useState<ISOTimeString | undefined>(dueToTime(base.due));
  const [assignee, setAssignee] = useState(base.assignee_user_id ?? unassignedValue);
  const followers = useFollowing(task.id, me);
  const [notify, setNotify] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'conflict' | 'error' | 'follow' | null>(null);

  const titleInvalid = title.trim().length === 0 || title.trim().length > 200;
  const wantsNotify = notify ?? followers.following;
  const notifyChanged = followers.state === 'ready' && me !== null && wantsNotify !== followers.following;
  const others = followerNames(followers.followers.filter((id) => id !== me), me, assigneeOptions, unassignedValue);

  // Field edits first, then the notification choice; the dialog closes only
  // when both are saved.
  const write = async (patch: TaskPatch): Promise<'ok' | 'conflict' | 'error' | 'follow'> => {
    const result = Object.keys(patch).length === 0 ? 'ok' : await onSave(task, patch);
    if (result !== 'ok' || !notifyChanged || me === null) return result;
    try {
      await setFollowing(task.id, me, wantsNotify);
      return 'ok';
    } catch {
      return 'follow';
    }
  };

  const save = async (): Promise<void> => {
    if (titleInvalid || saving) return;
    const patch = buildPatch(base, { title, notes, due, time, assignee }, unassignedValue);
    if (Object.keys(patch).length === 0 && !notifyChanged) {
      onClose();
      return;
    }
    setSaving(true);
    setNotice(null);
    const result = await write(patch);
    setSaving(false);
    if (result === 'ok') onClose();
    else setNotice(result);
  };

  return (
    <Layout
      header={<DialogHeader title="Edit task" subtitle={base.title} onOpenChange={() => onClose()} />}
      content={
        <LayoutContent>
          <VStack gap={4}>
            {notice !== null && (
              <Banner status={notice === 'conflict' ? 'warning' : 'error'} container="card" title={NOTICES[notice]} />
            )}
            <TextInput
              label="Title"
              value={title}
              onChange={setTitle}
              hasAutoFocus
              status={
                title.trim().length > 200
                  ? { type: 'error', message: 'Keep the title to 200 characters.' }
                  : undefined
              }
            />
            <TextArea label="Notes" isOptional rows={4} maxLength={8000} value={notes} onChange={(value) => setNotes(value)} />
            <DueFields
              due={due}
              time={time}
              onDue={(value) => {
                setDue(value);
                if (value === undefined) setTime(undefined);
              }}
              onTime={setTime}
            />
            {assigneeOptions.length > 1 && (
              <Selector
                label="Assignee"
                options={assigneeOptions}
                value={assignee}
                onChange={setAssignee}
              />
            )}
            {me !== null && (
              <NotifySwitch state={followers.state} value={wantsNotify} others={others} onChange={setNotify} />
            )}
            {children}
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter>
          <HStack gap={2} vAlign="center">
            {onDelete !== undefined && (
              <Button
                label="Delete"
                variant="destructive"
                isDisabled={saving}
                onClick={() => onDelete(task)}
              />
            )}
            <StackItem size="fill" />
            <Button label="Cancel" variant="secondary" onClick={onClose} />
            <Button
              label="Save"
              variant="primary"
              isLoading={saving}
              isDisabled={titleInvalid || saving}
              onClick={() => void save()}
            />
          </HStack>
        </LayoutFooter>
      }
    />
  );
}
