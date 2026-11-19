/**
 * Binds the voice tools to one account and one Space through the existing
 * stores, so RLS and active membership decide access. Reminders are created
 * with the caller as the only recipient, so the reminder fan-out delivers them.
 * An id from another Space answers "not found", exactly like a missing one.
 * Callbacks throw plain Errors with speakable messages.
 */
import { z } from 'zod';
import { cancelReminder as storeCancelReminder, createReminder as storeCreateReminder, getReminder, listReminders as storeListReminders, type StoredReminder } from '../reminders/store.ts';
import { createNote as storeCreateNote, getNote, listNotes, NoteConflictError, updateNote, type StoredNote } from '../notes/store.ts';
import { DEFAULT_HOURLY_WINDOW, firstOccurrence, type ReminderRule } from '../calendar/recurrence.ts';
import { getEvent } from '../calendar/store.ts';
import { getTask } from '../tasks/store.ts';
import { withUser, type Db } from '../platform/db/db.ts';
import { listNotifications, type StoredNotification } from '../notifications/store.ts';
import { searchResources } from '../conversations/search-store.ts';
import { AmbiguousReminderError, type CreateReminderInput, type HourlyRepeat, type Repeat, type ReminderLine, type VoiceCallbacks } from '@bob/ai';

type VoiceToolsScope = {
  /** The Space every read and write is confined to (private or the active Space). */
  spaceId: string;
  /** The caller's IANA zone: a `when` without an offset is wall time here, and times are spoken in it. */
  timeZone: string;
  /** Clock seam for tests. */
  now?: () => number;
};

/** A one-shot reminder this far in the past is refused as "already passed". */
const PAST_GRACE_MS = 60_000;
const OFFSET_PATTERN = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** Milliseconds a zone is ahead of UTC at an instant. */
function zoneOffsetMs(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(at);
  const g: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') g[p.type] = Number(p.value);
  const wall = Date.UTC(g.year!, g.month! - 1, g.day!, g.hour!, g.minute!, g.second!);
  return wall - Math.floor(at / 1000) * 1000;
}

/** Parses an ISO time; one without an offset is read as wall time in `zone`. */
export function parseWhen(when: string, zone: string): number {
  const trimmed = when.trim();
  if (OFFSET_PATTERN.test(trimmed)) {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) throw new Error('I could not understand that time');
    return at;
  }
  const asUtc = Date.parse(`${trimmed}Z`);
  if (Number.isNaN(asUtc)) throw new Error('I could not understand that time');
  const first = asUtc - zoneOffsetMs(asUtc, zone);
  return asUtc - zoneOffsetMs(first, zone);
}

/** "Wed, Sep 23, 6:00 PM" in the zone. */
function speakTime(at: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(at);
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago". */
export function speakAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** The stored rule for a create_reminder input; hourly without hours gets the waking-hours default. */
function ruleOf(input: CreateReminderInput): ReminderRule | null {
  const { repeat } = input;
  if (repeat === undefined) return null;
  if (repeat === 'weekdays') return { freq: 'weekly', byWeekday: [1, 2, 3, 4, 5] };
  if (repeat !== 'hourly') return { freq: repeat };
  const hours = input.active_hours;
  return {
    freq: 'hourly',
    interval: input.every_hours ?? 1,
    window: hours === undefined ? DEFAULT_HOURLY_WINDOW : { start: hours.from, end: hours.to },
  };
}

function repeatOf(rule: ReminderRule | null): Repeat | null {
  if (rule === null) return null;
  if (rule.freq === 'hourly') return 'hourly';
  const days = rule.byWeekday ?? [];
  if (rule.freq === 'weekly' && days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) {
    return 'weekdays';
  }
  return rule.freq;
}

function hourlyOf(rule: ReminderRule | null): HourlyRepeat | undefined {
  if (rule === null || rule.freq !== 'hourly') return undefined;
  const window = rule.window ?? { start: '00:00', end: '23:59' };
  return { everyHours: rule.interval ?? 1, from: window.start, to: window.end };
}

function lineOf(r: StoredReminder, zone: string): ReminderLine {
  const when = r.dueAt === null ? 'no time set' : speakTime(r.dueAt, r.dueZone ?? zone);
  const hourly = hourlyOf(r.rrule);
  return { id: r.id, title: r.title, when, repeat: repeatOf(r.rrule), ...(hourly === undefined ? {} : { hourly }) };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_TITLE_WORDS = 6;
const INBOX_SCAN = 50;
const INBOX_DEFAULT = 3;

/** A title for an untitled spoken note: its first few words. */
function titleFromText(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, NOTE_TITLE_WORDS).join(' ');
  return words.length > 200 ? words.slice(0, 200) : words;
}

/** Picks the one note a spoken name means: an id, an exact title, else the newest title containing it. */
async function resolveNote(db: Db, userId: string, spaceId: string, name: string): Promise<StoredNote> {
  if (UUID_PATTERN.test(name)) {
    const note = await getNote(db, userId, name).catch(() => undefined);
    if (note !== undefined && note.spaceId === spaceId && note.trashedAt === null) return note;
  }
  const wanted = name.trim().toLowerCase();
  const notes = await listNotes(db, userId, spaceId);
  const exact = notes.find((n) => n.title.toLowerCase() === wanted);
  const partial = [...notes].sort((a, b) => b.updatedAt - a.updatedAt)
    .find((n) => n.title.toLowerCase().includes(wanted));
  const found = exact ?? partial;
  if (found === undefined) throw new Error(`no note called ${name}`);
  return found;
}

/** The title of the resource a notification points at, or '' when it cannot be read. */
async function inboxTitle(db: Db, userId: string, n: StoredNotification): Promise<string> {
  const read = async (): Promise<string> => {
    if (n.resourceType === 'reminder') return (await getReminder(db, userId, n.resourceId)).title;
    if (n.resourceType === 'task') return (await getTask(db, userId, n.resourceId)).title;
    if (n.resourceType === 'note') return (await getNote(db, userId, n.resourceId)).title;
    if (n.resourceType === 'event') return (await getEvent(db, userId, n.resourceId)).title;
    return '';
  };
  return read().catch(() => '');
}

const INBOX_LABELS: Record<StoredNotification['type'], string> = {
  reminder: 'Reminder',
  assignment: 'Assigned to you',
  mention: 'You were mentioned',
  event_change: 'Event changed',
  invitation: 'Invitation to a Space',
  security: 'Security notice',
  task_update: 'A task you follow changed',
  bob_message: 'A note from Bob',
};

const ReceivedRowSchema = z.object({ id: z.string() }).strict();

/** Ids of the reminders in `spaceId` the caller is a recipient of. */
async function receivedReminderIds(db: Db, userId: string, spaceId: string): Promise<Set<string>> {
  const rows = await withUser(db, userId, (tx) => tx.query<unknown>(
    `SELECT rr.reminder_id::text AS id FROM bob.reminder_recipients rr
     JOIN bob.reminders r ON r.id = rr.reminder_id
     WHERE rr.user_id = $1 AND r.space_id = $2 AND r.kind = 'reminder'`,
    [userId, spaceId],
  ));
  return new Set(rows.map((row) => ReceivedRowSchema.parse(row).id));
}

export function bindVoiceTools(db: Db, userId: string, scope: VoiceToolsScope): VoiceCallbacks {
  const { spaceId, timeZone } = scope;
  const now = scope.now ?? Date.now;

  /** The caller's upcoming reminders: in a group Space only those they created
   *  or receive, never another member's. */
  async function activeReminders(): Promise<StoredReminder[]> {
    const rows = await storeListReminders(db, userId, spaceId);
    const received = await receivedReminderIds(db, userId, spaceId);
    const cutoff = now() - PAST_GRACE_MS;
    return rows.filter((r) => (r.createdBy === userId || received.has(r.id))
      && r.status === 'active' && (r.rrule !== null || (r.dueAt ?? 0) >= cutoff));
  }

  return {
    async createReminder(input) {
      const at = parseWhen(input.when, timeZone);
      const rrule = ruleOf(input);
      if (rrule === null && at < now() - PAST_GRACE_MS) throw new Error('that time has already passed');
      // An hourly rule is stored at its first real ring, never a slot outside its hours.
      const first = rrule?.freq === 'hourly' ? firstOccurrence(rrule, Math.max(at, now()), timeZone) : at;
      if (first === null) throw new Error('that reminder would never ring');
      const created = await storeCreateReminder(db, userId, spaceId, {
        title: input.text,
        due: { kind: 'instant', at: first, zone: timeZone },
        rrule,
        recipients: [userId],
      });
      return { ...lineOf(created, timeZone), spaceId: created.spaceId };
    },
    async listReminders() {
      const rows = await activeReminders();
      return rows.sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0)).map((r) => lineOf(r, timeZone));
    },
    async cancelReminder(input) {
      // Naming nothing would match every reminder; never cancel on a guess.
      if (input.id === undefined && input.text === undefined) throw new Error('say which reminder to cancel');
      const rows = await activeReminders();
      let matches: StoredReminder[];
      if (input.id !== undefined) matches = rows.filter((r) => r.id === input.id);
      else {
        const wanted = (input.text ?? '').toLowerCase();
        const exact = rows.filter((r) => r.title.toLowerCase() === wanted);
        matches = exact.length > 0 ? exact : rows.filter((r) => r.title.toLowerCase().includes(wanted));
      }
      if (matches.length === 0) throw new Error('no upcoming reminder matches that');
      if (matches.length > 1) throw new AmbiguousReminderError(matches.map((r) => lineOf(r, timeZone)));
      return lineOf(await storeCancelReminder(db, userId, matches[0]!.id), timeZone);
    },
    async createNote(input) {
      const title = input.title ?? titleFromText(input.text);
      const note = await storeCreateNote(db, userId, spaceId, { title, body: input.text, aiAssisted: true });
      return { id: note.id, title: note.title, body: note.body, spaceId: note.spaceId };
    },
    async appendNote(input) {
      const append = (current: StoredNote): Promise<StoredNote> => {
        const body = current.body.trim() === '' ? input.text : `${current.body.replace(/\s+$/, '')}\n${input.text}`;
        return updateNote(db, userId, current.id, { revision: current.revision, body, aiAssisted: true });
      };
      const current = await resolveNote(db, userId, spaceId, input.note);
      let note: StoredNote;
      try {
        note = await append(current);
      } catch (error) {
        if (!(error instanceof NoteConflictError)) throw error;
        // Someone saved between the read and the write: append to their text once, never overwrite it.
        if (error.current.trashedAt !== null) throw new Error(`no note called ${input.note}`);
        try {
          note = await append(error.current);
        } catch (again) {
          if (again instanceof NoteConflictError) throw new Error('that note is being edited right now, try again in a moment');
          throw again;
        }
      }
      return { id: note.id, title: note.title, body: note.body, spaceId: note.spaceId };
    },
    async readNote(input) {
      const note = await resolveNote(db, userId, spaceId, input.note);
      return { id: note.id, title: note.title, body: note.body };
    },
    async search(input) {
      const rows = await searchResources(db, userId, { query: input.query, spaceId, types: input.kinds, limit: 5 });
      return rows.map((r) => ({ kind: r.resource_type, title: r.title, snippet: r.snippet }));
    },
    async readInbox(input) {
      const rows = (await listNotifications(db, userId, { limit: INBOX_SCAN, unreadOnly: true }))
        .filter((n) => n.spaceId === null || n.spaceId === spaceId);
      const top = rows.slice(0, input.limit ?? INBOX_DEFAULT);
      const items = await Promise.all(top.map(async (n) => {
        const title = await inboxTitle(db, userId, n);
        const label = title === '' ? INBOX_LABELS[n.type] : `${INBOX_LABELS[n.type]}: ${title}`;
        return { label, when: speakAgo(n.createdAt, now()) };
      }));
      return { unread: rows.length, items };
    },
  };
}
