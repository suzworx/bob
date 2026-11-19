import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { DateInput } from '@astryxdesign/core/DateInput';
import { DateTimeInput, type ISODateTimeString } from '@astryxdesign/core/DateTimeInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { useLocale, type Locale } from '@astryxdesign/core/i18n';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { formatSharedDate, plainDateFromISO, type PlainDate } from '@astryxdesign/core/utils';
import { VStack } from '@astryxdesign/core/VStack';
import type { AgendaItem } from '@/features/productivity/use-agenda';
import { instantToWall, wallToInstant } from '@/features/productivity/use-reminders';
import { formatZoneTime, localDayKey, useAccountZone } from '@/features/productivity/use-today';
import {
  createEvent,
  ensureDefaultCalendar,
  getEvent,
  updateEvent,
  type EventPatchInput,
  type EventSummary,
  type EventTiming,
  type RecurrenceScope,
} from '@/features/productivity/use-events';
import type { Space } from '@/features/spaces/use-spaces';
import { DeleteEventStep } from './event-dialog-delete-step';
import { EventPeople } from './event-people';

const TITLE_MAX = 200;
const LOCATION_MAX = 500;
const NOTES_MAX = 8000;
const TIME_ORDER_ERROR = 'It must end after it starts.';
const PAST_DATE_WARNING = 'This date is in the past. You can still save it.';
const SAVE_INVALID_ERROR = 'Check the times: an event must end after it starts.';
const SAVE_FAILED_ERROR = 'The event could not be saved.';
const SAVE_UNAVAILABLE_ERROR = 'This event can no longer be changed.';
const LOAD_FAILED_ERROR = 'This event could not be loaded.';
const DELETED_ERROR = 'This event was deleted.';
const CONFLICT_WARNING =
  'Someone changed this event while you were editing. Your changes are still here; save again to replace theirs.';
const SERIES_TIME_LOCK_MESSAGE =
  'A repeating series keeps its times here. Choose “Only this event” to move one date.';

export type EventDialogTarget =
  | { mode: 'create'; space: Space; day: string; spaces?: Space[] }
  | { mode: 'edit'; item: AgendaItem }
  | { mode: 'view'; item: AgendaItem };

export type Draft = {
  title: string;
  allDay: boolean;
  startLocal: string;
  endLocal: string;
  startDate: string;
  endDateInclusive: string;
  location: string;
  notes: string;
};

function draftForCreate(day: string): Draft {
  return {
    title: '',
    allDay: false,
    startLocal: `${day}T09:00`,
    endLocal: `${day}T10:00`,
    startDate: day,
    endDateInclusive: day,
    location: '',
    notes: '',
  };
}

/** The wall clock 'YYYY-MM-DDTHH:mm' an instant shows in the account's zone:
 *  the one zone every calendar page reads, so the picker matches the list. */
function toLocalInput(ms: number, zone: string): string {
  return instantToWall(ms, zone);
}

/** The instant a picker's wall time names in the account's zone. */
function fromLocalInput(v: string, zone: string): number {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? wallToInstant(v.slice(0, 16), zone) : NaN;
}

/** Turning All day on or off keeps the dates the reader already picked: a
 *  timed draft's days become the all-day range, and an all-day range keeps
 *  its first day at 9:00–10:00. It never sends empty dates. */
export function toggleAllDay(draft: Draft, allDay: boolean): Draft {
  if (allDay === draft.allDay) return draft;
  if (allDay) {
    const startDate = draft.startDate || draft.startLocal.slice(0, 10);
    const endDay = draft.endDateInclusive || draft.endLocal.slice(0, 10) || startDate;
    return { ...draft, allDay, startDate, endDateInclusive: endDay < startDate ? startDate : endDay };
  }
  const day = draft.startLocal.slice(0, 10) || draft.startDate;
  return {
    ...draft,
    allDay,
    startLocal: draft.startLocal || `${day}T09:00`,
    endLocal: draft.endLocal || `${day}T10:00`,
  };
}

/** UTC date math on a YYYY-MM-DD key, so a day boundary never shifts under DST. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function toTiming(draft: Draft, zone: string): EventTiming {
  if (draft.allDay) {
    return { allDay: true, startDate: draft.startDate, endDate: addDays(draft.endDateInclusive, 1) };
  }
  return { allDay: false, startAt: fromLocalInput(draft.startLocal, zone), endAt: fromLocalInput(draft.endLocal, zone) };
}

function timesValid(draft: Draft, zone: string): boolean {
  if (draft.allDay) return draft.startDate !== '' && draft.endDateInclusive >= draft.startDate;
  const start = fromLocalInput(draft.startLocal, zone);
  const end = fromLocalInput(draft.endLocal, zone);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

/** #863: a new event starting on an earlier calendar day than today. A warning,
 *  never a block -- logging something that already happened is legitimate. */
function startsBeforeToday(draft: Draft, zone: string): boolean {
  const today = toLocalInput(Date.now(), zone).slice(0, 10);
  const startDay = draft.allDay ? draft.startDate : draft.startLocal.slice(0, 10);
  return startDay !== '' && startDay < today;
}

function isValid(draft: Draft, zone: string): boolean {
  return draft.title.trim() !== '' && timesValid(draft, zone);
}

/** The draft as the occurrence (not the master event) shows it, so editing one
 *  date of a series never leaks another occurrence's fields into the form. */
function draftFromOccurrence(item: AgendaItem, zone: string): Draft {
  if (item.all_day) {
    const startDate = item.start_date ?? '';
    const endExclusive = item.end_date ?? startDate;
    const endDateInclusive = addDays(endExclusive, -1);
    return {
      title: item.title,
      allDay: true,
      startLocal: '',
      endLocal: '',
      startDate,
      endDateInclusive: endDateInclusive < startDate ? startDate : endDateInclusive,
      location: item.location ?? '',
      notes: item.body ?? '',
    };
  }
  return {
    title: item.title,
    allDay: false,
    startLocal: item.start_at !== null ? toLocalInput(item.start_at, zone) : '',
    endLocal: item.end_at !== null ? toLocalInput(item.end_at, zone) : '',
    startDate: '',
    endDateInclusive: '',
    location: item.location ?? '',
    notes: item.body ?? '',
  };
}

/** "Mon, Sep 20, 2026", the occurrence's own day -- never the master event's
 *  date, which can differ for a moved or recurring instance. DialogHeader's
 *  subtitle is a string slot, not a ReactNode one, so this uses Astryx's own
 *  formatSharedDate (the formatter Timestamp's date_weekday renders with)
 *  against the reader's locale, rather than a format of our own. */
function occurrenceDayLabel(item: AgendaItem, locale: Locale, zone: string): string {
  let day: PlainDate | null = null;
  if (item.all_day && item.start_date !== null) {
    day = plainDateFromISO(item.start_date as ISODateString);
  } else if (item.start_at !== null) {
    day = plainDateFromISO(localDayKey(item.start_at, zone) as ISODateString);
  }
  if (day === null) return '';
  return formatSharedDate(day, 'date_weekday', locale);
}

/** "All day", or "9:00 AM – 10:00 AM" for a timed occurrence -- read-only
 *  companion to occurrenceDayLabel for the view dialog. */
function OccurrenceTimeLabel({ item, zone }: { item: AgendaItem; zone: string }): ReactElement {
  if (item.all_day) return <>All day</>;
  if (item.start_at === null || item.end_at === null) return <></>;
  return <>{`${formatZoneTime(item.start_at, zone)} – ${formatZoneTime(item.end_at, zone)}`}</>;
}

/** Only the fields that differ from the occurrence's own values, so an
 *  untouched field is never overwritten by a stale copy of itself. */
function buildPatch(draft: Draft, initial: Draft, zone: string): EventPatchInput {
  const patch: EventPatchInput = {};
  const title = draft.title.trim();
  if (title !== initial.title.trim()) patch.title = title;
  const location = draft.location.trim() === '' ? null : draft.location.trim();
  const initialLocation = initial.location.trim() === '' ? null : initial.location.trim();
  if (location !== initialLocation) patch.location = location;
  const body = draft.notes.trim() === '' ? null : draft.notes.trim();
  const initialBody = initial.notes.trim() === '' ? null : initial.notes.trim();
  if (body !== initialBody) patch.body = body;
  if (JSON.stringify(toTiming(draft, zone)) !== JSON.stringify(toTiming(initial, zone))) patch.timing = toTiming(draft, zone);
  return patch;
}

function CreateEventDialog({
  target,
  onClose,
  onChanged,
}: {
  target: Extract<EventDialogTarget, { mode: 'create' }>;
  onClose: () => void;
  onChanged: () => void;
}): ReactElement {
  const zone = useAccountZone();
  // With `spaces` (Today and Calendar), the reader picks where the event goes.
  const [space, setSpace] = useState<Space>(target.space);
  const [draft, setDraft] = useState<Draft>(() => draftForCreate(target.day));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<'invalid' | 'failed' | null>(null);
  // A double Enter/click must not fire two creates; a state flag would not be
  // visible to the second call yet, so the in-flight guard is a ref.
  const inFlight = useRef(false);

  const valid = isValid(draft, zone);
  const timeError = !timesValid(draft, zone);
  const pastStatus = startsBeforeToday(draft, zone) ? ({ type: 'warning', message: PAST_DATE_WARNING } as const) : undefined;

  const save = async (): Promise<void> => {
    if (!valid || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const calendar = await ensureDefaultCalendar(space.id, space.kind);
      if (!calendar.ok) {
        setFailure(calendar.reason === 'invalid' ? 'invalid' : 'failed');
        return;
      }
      const location = draft.location.trim();
      const notes = draft.notes.trim();
      const created = await createEvent(calendar.value, {
        title: draft.title.trim(),
        location: location === '' ? null : location,
        body: notes === '' ? null : notes,
        zone,
        timing: toTiming(draft, zone),
      });
      if (!created.ok) {
        setFailure(created.reason === 'invalid' ? 'invalid' : 'failed');
        return;
      }
      onChanged();
      onClose();
    } catch {
      setFailure('failed');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      purpose="form"
      width={480}
    >
      <Layout
        header={<DialogHeader title="New event" subtitle={`In ${space.name}`} onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label="Title"
                hasAutoFocus
                value={draft.title}
                onChange={(value) => setDraft({ ...draft, title: value.slice(0, TITLE_MAX) })}
              />
              {target.spaces !== undefined && target.spaces.length > 1 && (
                <Selector
                  label="Space"
                  options={target.spaces.map((s) => ({ value: s.id, label: s.name }))}
                  value={space.id}
                  onChange={(id) => setSpace(target.spaces?.find((s) => s.id === id) ?? space)}
                />
              )}
              <Switch label="All day" value={draft.allDay} onChange={(checked) => setDraft(toggleAllDay(draft, checked))} />
              {draft.allDay ? (
                <>
                  <DateInput
                    label="Starts"
                    value={draft.startDate as ISODateString}
                    onChange={(value) => {
                      if (value !== undefined) setDraft({ ...draft, startDate: value });
                    }}
                    status={pastStatus}
                  />
                  <DateInput
                    label="Ends"
                    value={draft.endDateInclusive as ISODateString}
                    onChange={(value) => {
                      if (value !== undefined) setDraft({ ...draft, endDateInclusive: value });
                    }}
                    status={timeError ? { type: 'error', message: TIME_ORDER_ERROR } : undefined}
                  />
                </>
              ) : (
                <>
                  <DateTimeInput
                    label="Starts"
                    value={draft.startLocal as ISODateTimeString}
                    onChange={(value) => {
                      if (value !== undefined) setDraft({ ...draft, startLocal: value });
                    }}
                    status={pastStatus}
                  />
                  <DateTimeInput
                    label="Ends"
                    value={draft.endLocal as ISODateTimeString}
                    onChange={(value) => {
                      if (value !== undefined) setDraft({ ...draft, endLocal: value });
                    }}
                    status={timeError ? { type: 'error', message: TIME_ORDER_ERROR } : undefined}
                  />
                </>
              )}
              <TextInput
                label="Location"
                isOptional
                value={draft.location}
                onChange={(value) => setDraft({ ...draft, location: value.slice(0, LOCATION_MAX) })}
              />
              <TextArea
                label="Notes"
                isOptional
                value={draft.notes}
                onChange={(value) => setDraft({ ...draft, notes: value.slice(0, NOTES_MAX) })}
              />
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
              <Button label="Save event" variant="primary" isLoading={busy} isDisabled={!valid} onClick={() => void save()} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

type LoadState = 'loading' | 'loaded' | 'error' | 'deleted';
type EditScope = '' | 'this' | 'series';
type SaveFailure = 'invalid' | 'unavailable' | 'failed';

function saveFailureMessage(reason: SaveFailure): string {
  if (reason === 'invalid') return SAVE_INVALID_ERROR;
  if (reason === 'unavailable') return SAVE_UNAVAILABLE_ERROR;
  return SAVE_FAILED_ERROR;
}

function EditEventDialog({
  target,
  onClose,
  onChanged,
}: {
  target: Extract<EventDialogTarget, { mode: 'edit' }>;
  onClose: () => void;
  onChanged: () => void;
}): ReactElement {
  const { item } = target;
  const zone = useAccountZone();
  const [initialDraft] = useState<Draft>(() => draftFromOccurrence(item, zone));
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [event, setEvent] = useState<EventSummary | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [step, setStep] = useState<'form' | 'delete'>('form');
  const [scope, setScope] = useState<EditScope>('');
  const [busy, setBusy] = useState(false);
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getEvent(item.event_id);
      if (cancelled) return;
      if (!result.ok) {
        setLoadState('error');
        return;
      }
      if (result.value.status === 'cancelled') {
        setLoadState('deleted');
        return;
      }
      setEvent(result.value);
      setLoadState('loaded');
    })();
    return () => {
      cancelled = true;
    };
  }, [item.event_id]);

  const recurring = event !== null && event.rrule !== null;
  const patch = buildPatch(draft, initialDraft, zone);
  const hasChanges = Object.keys(patch).length > 0;
  const scopeChosen = !recurring || scope !== '';
  const timeError = !timesValid(draft, zone);
  const canSave = loadState === 'loaded' && hasChanges && scopeChosen && draft.title.trim() !== '' && timesValid(draft, zone);
  const dayLabel = occurrenceDayLabel(item, useLocale(), zone);
  const timesLocked = scope === 'series';

  const handleScopeChange = (value: string): void => {
    const next = value as EditScope;
    setScope(next);
    if (next === 'series') {
      setDraft((prev) => ({
        ...prev,
        allDay: initialDraft.allDay,
        startLocal: initialDraft.startLocal,
        endLocal: initialDraft.endLocal,
        startDate: initialDraft.startDate,
        endDateInclusive: initialDraft.endDateInclusive,
      }));
    }
  };

  const save = async (): Promise<void> => {
    if (!canSave || event === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setSaveFailure(null);
    setConflict(false);
    try {
      const scopeToSend: RecurrenceScope = recurring ? (scope === 'this' ? 'this' : 'series') : 'series';
      const result = await updateEvent(
        event,
        scopeToSend,
        scopeToSend === 'this' ? item.original_occurrence_start : null,
        patch,
      );
      if (result.ok) {
        onChanged();
        onClose();
        return;
      }
      if (result.reason === 'conflict') {
        setConflict(true);
        const refreshed = await getEvent(event.id);
        if (refreshed.ok) setEvent(refreshed.value);
        onChanged();
        return;
      }
      if (result.reason === 'invalid') setSaveFailure('invalid');
      else if (result.reason === 'forbidden' || result.reason === 'not_found') setSaveFailure('unavailable');
      else setSaveFailure('failed');
    } catch {
      setSaveFailure('failed');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (loadState !== 'loaded' || event === null) {
    return (
      <Dialog
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        purpose="info"
        width={480}
      >
        <Layout
          header={<DialogHeader title="Edit event" subtitle={dayLabel} onOpenChange={() => onClose()} />}
          content={
            <LayoutContent>
              {loadState === 'loading' && (
                <Text type="supporting" role="status">
                  Loading event…
                </Text>
              )}
              {loadState === 'error' && <Banner status="error" title={LOAD_FAILED_ERROR} container="card" />}
              {loadState === 'deleted' && <Text as="p">{DELETED_ERROR}</Text>}
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button label="Close" variant="secondary" onClick={onClose} />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    );
  }

  if (step === 'delete') {
    return (
      <Dialog
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        purpose="form"
        width={480}
      >
        <DeleteEventStep event={event} item={item} onBack={() => setStep('form')} onClose={onClose} onChanged={onChanged} />
      </Dialog>
    );
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      purpose="form"
      width={480}
    >
      <Layout
        header={<DialogHeader title="Edit event" subtitle={dayLabel} onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label="Title"
                value={draft.title}
                onChange={(value) => setDraft({ ...draft, title: value.slice(0, TITLE_MAX) })}
              />
              <Switch
                label="All day"
                value={draft.allDay}
                onChange={(checked) => setDraft(toggleAllDay(draft, checked))}
                isDisabled={timesLocked}
                disabledMessage={SERIES_TIME_LOCK_MESSAGE}
              />
              {draft.allDay ? (
                <>
                  <DateInput
                    label="Starts"
                    value={draft.startDate as ISODateString}
                    onChange={(value) => {
                      if (value !== undefined) setDraft({ ...draft, startDate: value });
                    }}
                    isDisabled={timesLocked}
                    disabledMessage={SERIES_TIME_LOCK_MESSAGE}
                  />
                  <DateInput
                    label="Ends"
                    value={draft.endDateInclusive as ISODateString}
                    onChange={(value) => {
                      if (value !== undefined) setDraft({ ...draft, endDateInclusive: value });
                    }}
                    status={timeError ? { type: 'error', message: TIME_ORDER_ERROR } : undefined}
                    isDisabled={timesLocked}
                    disabledMessage={SERIES_TIME_LOCK_MESSAGE}
                  />
                </>
              ) : (
                <>
                  <DateTimeInput
                    label="Starts"
                    value={draft.startLocal as ISODateTimeString}
                    onChange={(value) => {
                      if (value !== undefined) setDraft({ ...draft, startLocal: value });
                    }}
                    isDisabled={timesLocked}
                    disabledMessage={SERIES_TIME_LOCK_MESSAGE}
                  />
                  <DateTimeInput
                    label="Ends"
                    value={draft.endLocal as ISODateTimeString}
                    onChange={(value) => {
                      if (value !== undefined) setDraft({ ...draft, endLocal: value });
                    }}
                    status={timeError ? { type: 'error', message: TIME_ORDER_ERROR } : undefined}
                    isDisabled={timesLocked}
                    disabledMessage={SERIES_TIME_LOCK_MESSAGE}
                  />
                </>
              )}
              <TextInput
                label="Location"
                isOptional
                value={draft.location}
                onChange={(value) => setDraft({ ...draft, location: value.slice(0, LOCATION_MAX) })}
              />
              <TextArea
                label="Notes"
                isOptional
                value={draft.notes}
                onChange={(value) => setDraft({ ...draft, notes: value.slice(0, NOTES_MAX) })}
              />
              {recurring && (
                <RadioList label="Change which events?" value={scope} onChange={handleScopeChange}>
                  <RadioListItem
                    value="this"
                    label="Only this event"
                    description="Changes this one date; the rest of the series stays as it is."
                  />
                  <RadioListItem
                    value="series"
                    label="Every event in the series"
                    description="Changes the title, place and notes of every date. Times stay as they are."
                  />
                </RadioList>
              )}
              {conflict && <Banner status="warning" title={CONFLICT_WARNING} container="card" />}
              {saveFailure !== null && <Banner status="error" title={saveFailureMessage(saveFailure)} container="card" />}
              <EventPeople event={event} onChanged={onChanged} canManage={target.item.can_edit === true} />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="between">
              <Button label="Delete event" variant="destructive" onClick={() => setStep('delete')} />
              <HStack gap={2}>
                <Button label="Cancel" variant="secondary" onClick={onClose} />
                <Button
                  label="Save changes"
                  variant="primary"
                  isLoading={busy}
                  isDisabled={!canSave}
                  onClick={() => void save()}
                />
              </HStack>
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/** Read-only companion to EditEventDialog for a caller who cannot edit: same
 *  loading/error/cancelled states and copy, no inputs, no Save. Delete shows
 *  only when the agenda says can_delete (a group owner/admin, #873).
 *  EventPeople still renders below it so an invitee can reach their RSVP. */
function ViewEventDialog({
  target,
  onClose,
  onChanged,
}: {
  target: Extract<EventDialogTarget, { mode: 'view' }>;
  onClose: () => void;
  onChanged: () => void;
}): ReactElement {
  const { item } = target;
  const [event, setEvent] = useState<EventSummary | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [step, setStep] = useState<'view' | 'delete'>('view');
  const zone = useAccountZone();
  const dayLabel = occurrenceDayLabel(item, useLocale(), zone);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getEvent(item.event_id);
      if (cancelled) return;
      if (!result.ok) {
        setLoadState('error');
        return;
      }
      if (result.value.status === 'cancelled') {
        setLoadState('deleted');
        return;
      }
      setEvent(result.value);
      setLoadState('loaded');
    })();
    return () => {
      cancelled = true;
    };
  }, [item.event_id]);

  if (loadState !== 'loaded' || event === null) {
    return (
      <Dialog
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        purpose="info"
        width={480}
      >
        <Layout
          header={<DialogHeader title={item.title} subtitle={dayLabel} onOpenChange={() => onClose()} />}
          content={
            <LayoutContent>
              {loadState === 'loading' && (
                <Text type="supporting" role="status">
                  Loading event…
                </Text>
              )}
              {loadState === 'error' && <Banner status="error" title={LOAD_FAILED_ERROR} container="card" />}
              {loadState === 'deleted' && <Text as="p">{DELETED_ERROR}</Text>}
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button label="Close" variant="secondary" onClick={onClose} />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    );
  }

  if (step === 'delete') {
    return (
      <Dialog
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        purpose="form"
        width={480}
      >
        <DeleteEventStep event={event} item={item} onBack={() => setStep('view')} onClose={onClose} onChanged={onChanged} />
      </Dialog>
    );
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      purpose="info"
      width={480}
    >
      <Layout
        header={<DialogHeader title={item.title} subtitle={dayLabel} onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text type="supporting">
                <OccurrenceTimeLabel item={item} zone={zone} />
              </Text>
              {item.location !== null && <Text as="p">{item.location}</Text>}
              {item.body !== null && <Text as="p">{item.body}</Text>}
              <EventPeople event={event} onChanged={onChanged} canManage={false} />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign={item.can_delete === true ? 'between' : 'end'}>
              {item.can_delete === true && (
                <Button label="Delete event" variant="destructive" onClick={() => setStep('delete')} />
              )}
              <Button label="Close" variant="secondary" onClick={onClose} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

export function EventDialog({
  target,
  onClose,
  onChanged,
}: {
  target: EventDialogTarget;
  onClose: () => void;
  onChanged: () => void;
}): ReactElement {
  if (target.mode === 'edit') {
    return <EditEventDialog target={target} onClose={onClose} onChanged={onChanged} />;
  }
  if (target.mode === 'view') {
    return <ViewEventDialog target={target} onClose={onClose} onChanged={onChanged} />;
  }
  return <CreateEventDialog target={target} onClose={onClose} onChanged={onChanged} />;
}
