import { useRef, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList';
import { DateTimeInput, type ISODateTimeString } from '@astryxdesign/core/DateTimeInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TimeInput, type ISOTimeString } from '@astryxdesign/core/TimeInput';
import { VStack } from '@astryxdesign/core/VStack';
import { memberDisplayName } from '@/lib/display-name';
import {
  createReminder,
  instantToWall,
  updateReminder,
  useReminderPreview,
  wallToInstant,
  type ReminderRule,
  type ReminderSummary,
} from '@/features/productivity/use-reminders';
import type { Space } from '@/features/spaces/use-spaces';

const TITLE_MAX = 200;

/** "Sat, Oct 24, 8:00 AM" in the reminder's own zone: the reader checks the
 *  time the reminder rings there, never the browser's translation of it. */
function ringLabel(at: number, zone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(at);
}

/** The next three rings (#126), shown before Save so a wrong rule is caught here. */
function ReminderPreview({ dueAt, zone, rrule }: { dueAt: number | null; zone: string; rrule: ReminderRule | null }): ReactElement | null {
  const preview = useReminderPreview(dueAt, zone, rrule);
  if (preview.status === 'idle') return null;
  if (preview.status === 'error') return <Text type="supporting" role="status">The next reminders could not be previewed.</Text>;
  if (preview.status === 'ready' && preview.occurrences.length === 0) {
    return <Text type="supporting" role="status">This reminder will not ring again.</Text>;
  }
  return (
    <List density="compact" hasDividers header={rrule === null ? 'Rings' : 'Next reminders'} aria-busy={preview.status === 'loading'}>
      {preview.occurrences.map((occurrence) => (
        <ListItem key={occurrence.at} label={ringLabel(occurrence.at, zone)} />
      ))}
    </List>
  );
}
const SAVE_INVALID_ERROR = 'Check the reminder: it needs a title, a time and at least one person.';
const SAVE_FAILED_ERROR = 'The reminder could not be saved.';

/** `spaceId` is optional: a new reminder is private unless the reader picks a
 *  space. `space` on an edit names the audience (who gets it). */
export type ReminderDialogTarget =
  | { mode: 'create'; spaces: Space[]; spaceId?: string; day: string; zone: string; me: string; now?: number }
  | { mode: 'edit'; reminder: ReminderSummary; zone: string; space?: Space; me?: string };

type Repeat = 'none' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';

type Draft = { title: string; spaceId: string; when: string; repeat: Repeat; every: number; from: string; until: string; recipients: string[] };

const REPEAT_OPTIONS: Array<{ value: Repeat; label: string }> = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'hourly', label: 'Every few hours' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'yearly', label: 'Every year' },
];

/** The rule a draft asks for; hourly rings only inside its waking window. */
export function ruleOf(draft: Pick<Draft, 'repeat' | 'every' | 'from' | 'until'>): ReminderRule | null {
  if (draft.repeat === 'none') return null;
  if (draft.repeat === 'hourly') return { freq: 'hourly', interval: draft.every, window: { start: draft.from, end: draft.until } };
  if (draft.repeat === 'weekdays') return { freq: 'weekly', byWeekday: [1, 2, 3, 4, 5] };
  return { freq: draft.repeat };
}

function repeatOf(rule: ReminderRule | null): Pick<Draft, 'repeat' | 'every' | 'from' | 'until'> {
  const base = { every: 1, from: '08:00', until: '22:00' };
  if (rule === null) return { ...base, repeat: 'none' };
  if (rule.freq === 'hourly') {
    return { repeat: 'hourly', every: rule.interval ?? 1, from: rule.window?.start ?? '00:00', until: rule.window?.end ?? '23:59' };
  }
  if (rule.freq === 'weekly' && rule.byWeekday?.join() === '1,2,3,4,5') return { ...base, repeat: 'weekdays' };
  return { ...base, repeat: rule.freq };
}

const HALF_HOUR_MS = 30 * 60 * 1000;

/** The default ring time for a new reminder on `day` in `zone`: 9:00 AM, or,
 *  when that has already gone by (today after 9, or a past day), the next
 *  half-hour from now. Never a time already past, which would never ring. */
export function defaultWhen(day: string, zone: string, now = Date.now()): string {
  const nine = `${day}T09:00`;
  if (wallToInstant(nine, zone) > now) return nine;
  return instantToWall(Math.floor(now / HALF_HOUR_MS) * HALF_HOUR_MS + HALF_HOUR_MS, zone);
}

/** Private, unless the caller named a space: a reminder is the reader's own by default. */
function defaultSpaceId(target: Extract<ReminderDialogTarget, { mode: 'create' }>): string {
  if (target.spaceId !== undefined && target.spaces.some((s) => s.id === target.spaceId)) return target.spaceId;
  return (target.spaces.find((s) => s.kind === 'private') ?? target.spaces[0])?.id ?? '';
}

function initialDraft(target: ReminderDialogTarget): Draft {
  if (target.mode === 'create') {
    return {
      title: '', spaceId: defaultSpaceId(target), when: defaultWhen(target.day, target.zone, target.now),
      ...repeatOf(null), recipients: [target.me],
    };
  }
  const { reminder } = target;
  const when = reminder.due_at === null ? '' : instantToWall(reminder.due_at, target.zone);
  return { title: reminder.title, spaceId: reminder.space_id, when, ...repeatOf(reminder.rrule), recipients: [] };
}

/** Who an existing reminder reaches, in plain words. The reminder list does
 *  not carry its recipients yet, so a shared one names its space. */
export function audienceLabel(reminder: ReminderSummary, space: Space | undefined, me: string | undefined): string {
  if (space === undefined || space.kind === 'private') return 'Only you';
  const ids = reminder.recipient_user_ids;
  if (ids !== undefined && ids.length > 0) {
    return ids.map((id) => (id === me ? 'You' : memberDisplayName(space.members, id))).join(', ');
  }
  return `People in ${space.name}`;
}

/** The instant a draft's 'YYYY-MM-DDTHH:mm' names in `zone`, or null. */
function draftDueAt(when: string, zone: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when)) return null;
  const instant = wallToInstant(when, zone);
  return Number.isFinite(instant) ? instant : null;
}

/** A title, a time, a sane hourly window and, for a new one, someone to remind. */
function draftIsValid(draft: Draft, dueAt: number | null, hourlyError: boolean, creating: boolean): boolean {
  if (draft.title.trim() === '' || dueAt === null || hourlyError) return false;
  return !creating || draft.recipients.length > 0;
}

/** One dialog for a new reminder and for changing one (#509). */
export function ReminderDialog({ target, onClose, onChanged }: {
  target: ReminderDialogTarget;
  onClose: () => void;
  onChanged: () => void;
}): ReactElement {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(target));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<'invalid' | 'failed' | null>(null);
  const inFlight = useRef(false);
  const creating = target.mode === 'create';
  const space = creating ? target.spaces.find((s) => s.id === draft.spaceId) : undefined;
  const dueAt = draftDueAt(draft.when, target.zone);
  const rule = ruleOf(draft);
  const hourlyError = draft.repeat === 'hourly' && !(draft.from < draft.until);
  const valid = draftIsValid(draft, dueAt, hourlyError, creating);

  const save = async (): Promise<void> => {
    if (!valid || dueAt === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const input = { title: draft.title.trim(), dueAt, zone: target.zone, rrule: rule };
    const result = creating
      ? await createReminder(draft.spaceId, input, draft.recipients)
      : await updateReminder(target.reminder.id, input);
    inFlight.current = false;
    setBusy(false);
    if (!result.ok) {
      setFailure(result.reason);
      return;
    }
    onChanged();
    onClose();
  };

  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) onClose(); }} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title={creating ? 'New reminder' : 'Edit reminder'} onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label="Title"
                hasAutoFocus
                value={draft.title}
                onChange={(value) => setDraft({ ...draft, title: value.slice(0, TITLE_MAX) })}
              />
              {creating && target.spaces.length > 1 && (
                <Selector
                  label="Space"
                  options={target.spaces.map((s) => ({ value: s.id, label: s.name }))}
                  value={draft.spaceId}
                  onChange={(id) => setDraft({ ...draft, spaceId: id, recipients: [target.me] })}
                />
              )}
              {!creating && (
                <VStack gap={1}>
                  <Text type="label">Who gets it</Text>
                  <Text>{audienceLabel(target.reminder, target.space, target.me)}</Text>
                </VStack>
              )}
              <DateTimeInput
                label="When"
                description={`Time in ${target.zone}`}
                value={draft.when as ISODateTimeString}
                onChange={(value) => setDraft({ ...draft, when: value ?? '' })}
              />
              <Selector
                label="Repeat"
                options={REPEAT_OPTIONS}
                value={draft.repeat}
                onChange={(value) => setDraft({ ...draft, repeat: value as Repeat })}
              />
              {draft.repeat === 'hourly' && (
                <FormLayout direction="horizontal">
                  <NumberInput
                    label="Every"
                    units="hours"
                    min={1}
                    max={12}
                    isIntegerOnly
                    value={draft.every}
                    onChange={(value) => setDraft({ ...draft, every: Math.min(12, Math.max(1, value)) })}
                  />
                  <TimeInput label="From" hourFormat="24h" value={draft.from as ISOTimeString}
                    onChange={(value) => setDraft({ ...draft, from: value?.slice(0, 5) ?? draft.from })} />
                  <TimeInput label="Until" hourFormat="24h" value={draft.until as ISOTimeString}
                    onChange={(value) => setDraft({ ...draft, until: value?.slice(0, 5) ?? draft.until })}
                    status={hourlyError ? { type: 'error', message: 'Must end after it starts.' } : undefined} />
                </FormLayout>
              )}
              {creating && space !== undefined && space.kind !== 'private' && (
                <CheckboxList
                  label="Remind"
                  value={draft.recipients}
                  onChange={(recipients) => setDraft({ ...draft, recipients })}
                  status={draft.recipients.length === 0 ? { type: 'error', message: 'Pick at least one person.' } : undefined}
                >
                  {space.members.map((member) => (
                    <CheckboxListItem
                      key={member.user_id}
                      value={member.user_id}
                      label={member.user_id === target.me ? 'Me' : memberDisplayName(space.members, member.user_id)}
                    />
                  ))}
                </CheckboxList>
              )}
              {!hourlyError && <ReminderPreview dueAt={dueAt} zone={target.zone} rrule={rule} />}
              {failure !== null && (
                <Banner status="error" title={failure === 'invalid' ? SAVE_INVALID_ERROR : SAVE_FAILED_ERROR} container="card" />
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Save reminder" variant="primary" isLoading={busy} isDisabled={!valid} onClick={() => void save()} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
