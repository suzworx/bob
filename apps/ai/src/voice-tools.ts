/**
 * Voice agent tools for reminders, notes, search and the inbox:
 * `create_reminder`, `list_reminders`, `cancel_reminder`, `create_note`,
 * `append_note`, `read_note`, `search` and `read_inbox`, built in the same
 * `tool()` style as productivity-tools.ts over injected callbacks.
 *
 * The injection rule from productivity-tools.ts holds here too: no input
 * schema names a space, an account or a recipient. apps/api binds the
 * callbacks to one account and one Space (core/voice-tools.ts); the model can
 * only act inside what it was handed.
 *
 * Every output carries a short `say` line meant to be spoken on the device,
 * kept well inside the 700-character reply cap. Raw ids are returned only when
 * a request was ambiguous and the model has to pick. A rejected callback
 * becomes { ok: false, reason } instead of throwing, as in the other tools.
 */
import { z } from 'zod';
import { asSchema, jsonSchema, tool } from 'ai';
import type { Tool } from 'ai';

/** How often a reminder repeats; absent = once. weekdays = Monday to Friday. */
const repeatSchema = z
  .enum(['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'])
  .describe('How often it repeats; leave out for a one-time reminder. hourly = every hour or every few hours.');
export type Repeat = z.infer<typeof repeatSchema>;

/** Most hours between hourly rings; past that it is a daily reminder. */
const EVERY_HOURS_MAX = 12;

const wallTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour HH:mm time');

/**
 * The daily window an hourly reminder rings in, as local 24-hour times. The model sends `start`/`end`
 * (it garbles a `from` key); callers get `{ from, to }`, the stored shape.
 */
const activeHoursSchema = z
  .object({
    start: wallTimeSchema.describe('First ring of each day, 24-hour HH:mm local time.'),
    end: wallTimeSchema.describe('Last possible ring of each day, 24-hour HH:mm local time, after `start`.'),
  })
  .strict()
  .refine((w) => w.start < w.end, { message: '`start` must be before `end`' })
  .transform((w) => ({ from: w.start, to: w.end }))
  .describe('Only with repeat hourly: the hours of the day it may ring. Leave out unless the person named hours: without it the reminder rings from 08:00 to 22:00 so it never wakes them, so "every hour" needs no question about hours. For all day and night use 00:00 to 23:59.');
type ActiveHours = z.infer<typeof activeHoursSchema>;

/** The kinds `search` can look through. */
const searchKindSchema = z.enum(['task', 'note', 'event', 'thread']);
type SearchKind = z.infer<typeof searchKindSchema>;

/** The first ring of an hourly reminder with no start named: `everyHours` from `nowMs`, on the next whole minute (UTC ISO). */
export function firstHourlyRing(nowMs: number, everyHours: number): string {
  return new Date(Math.ceil((nowMs + everyHours * 3_600_000) / 60_000) * 60_000).toISOString();
}

/**
 * "Every hour" names no start and models omit `when` even when told it is required, so for an hourly
 * repeat `when` may be left out (first ring one interval from now). Callers always get a `when`.
 */
export const createReminderInputSchema = z
  .object({
    text: z.string().trim().min(1).max(200),
    when: z.string().min(1).optional()
      .describe('When it rings (the first ring for a repeat). Leave out only for repeat hourly with no start named: it then first rings one interval from now (every hour: an hour from now).'),
    repeat: repeatSchema.optional(),
    every_hours: z.number().int().min(1).max(EVERY_HOURS_MAX).optional()
      .describe('Only with repeat hourly: hours between rings (2 = every two hours). Leave out for every hour.'),
    active_hours: activeHoursSchema.optional(),
  })
  .strict()
  .refine((r) => r.repeat === 'hourly' || (r.every_hours === undefined && r.active_hours === undefined), {
    message: 'every_hours and active_hours need repeat hourly',
  })
  .refine((r) => r.when !== undefined || r.repeat === 'hourly', { message: '`when` is required unless repeat is hourly', path: ['when'] })
  .transform((r) => ({ ...r, when: r.when ?? firstHourlyRing(Date.now(), r.every_hours ?? 1) }));
export type CreateReminderInput = z.infer<typeof createReminderInputSchema>;

/**
 * The SDK stores the PARSED input on the tool part (active_hours as
 * `{ from, to }`), and replaying a conversation validates it again: map it
 * back to `{ start, end }` first, or every later turn fails. The model still
 * sees exactly the zod schema.
 */
const createReminderToolSchema = jsonSchema<CreateReminderInput>(() => asSchema(createReminderInputSchema).jsonSchema, {
  validate: (value) => {
    const result = createReminderInputSchema.safeParse(asModelShape(value));
    return result.success ? { success: true, value: result.data } : { success: false, error: result.error };
  },
});

/** A stored create_reminder input with its active hours back in the model's `{ start, end }` keys. */
function asModelShape(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('active_hours' in value)) return value;
  const hours = value.active_hours;
  if (typeof hours !== 'object' || hours === null || !('from' in hours) || !('to' in hours)) return value;
  return { ...value, active_hours: { start: hours.from, end: hours.to } };
}

const listRemindersInputSchema = z.object({}).strict();

/** cancel_reminder input: the id (from an earlier ambiguous answer) or words
 *  of its text. One of them is required: naming nothing would match every reminder. */
export const cancelReminderInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    text: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((r) => r.id !== undefined || r.text !== undefined, { message: 'say which reminder to cancel: an id or words of its text' });
type CancelReminderInput = z.infer<typeof cancelReminderInputSchema>;

const createNoteInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    text: z.string().trim().min(1).max(8000),
  })
  .strict();
type CreateNoteInput = z.infer<typeof createNoteInputSchema>;

/** `note` is a note title (or part of one) or its id. */
const appendNoteInputSchema = z
  .object({
    note: z.string().trim().min(1),
    text: z.string().trim().min(1).max(8000),
  })
  .strict();
type AppendNoteInput = z.infer<typeof appendNoteInputSchema>;

const readNoteInputSchema = z.object({ note: z.string().trim().min(1) }).strict();
type ReadNoteInput = z.infer<typeof readNoteInputSchema>;

export const searchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    kinds: z.array(searchKindSchema).min(1).optional(),
  })
  .strict();
type SearchInput = z.infer<typeof searchInputSchema>;

const readInboxInputSchema = z
  .object({ limit: z.number().int().min(1).max(5).optional() })
  .strict();
type ReadInboxInput = z.infer<typeof readInboxInputSchema>;

/** An hourly repeat as stored: every `everyHours` hours from `from` to `to` (HH:mm, local). */
export type HourlyRepeat = { everyHours: number; from: string; to: string };
/** A reminder as the callbacks describe it; `when` is already speakable local time.
 *  `spaceId` names the Space it lives in when the binder knows it, so a reply can link it. */
export type ReminderLine = {
  id: string;
  title: string;
  when: string;
  repeat: Repeat | null;
  hourly?: HourlyRepeat;
  spaceId?: string;
};
/** A note as read back, with its Space when the binder names it (see ReminderLine). */
export type NoteContent = { id: string; title: string; body: string; spaceId?: string };
/** One search hit; snippet is a short plain-text excerpt, possibly empty. */
type SearchHit = { kind: SearchKind; title: string; snippet: string };
/** One unread inbox item, already a short phrase ("Reminder: call mum"). */
type InboxItem = { label: string; when: string };
type InboxSummary = { unread: number; items: InboxItem[] };

/** Several reminders matched: the caller lists them so the model can ask which. */
export class AmbiguousReminderError extends Error {
  readonly candidates: ReminderLine[];
  constructor(candidates: ReminderLine[]) {
    super('more than one reminder matches');
    this.name = 'AmbiguousReminderError';
    this.candidates = candidates;
  }
}

/** The callback bag apps/api binds to one account and one Space. */
export interface VoiceCallbacks {
  createReminder(input: CreateReminderInput): Promise<ReminderLine>;
  listReminders(): Promise<ReminderLine[]>;
  cancelReminder(input: CancelReminderInput): Promise<ReminderLine>;
  createNote(input: CreateNoteInput): Promise<NoteContent>;
  appendNote(input: AppendNoteInput): Promise<NoteContent>;
  readNote(input: ReadNoteInput): Promise<NoteContent>;
  search(input: SearchInput): Promise<SearchHit[]>;
  readInbox(input: ReadInboxInput): Promise<InboxSummary>;
}

/** Every voice tool answers with one speakable line, or a structured failure. */
const voiceOutputSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      say: z.string(),
      // The item a create or append wrote, so a reply can link it; never spoken.
      noteId: z.string().min(1).optional(),
      reminderId: z.string().min(1).optional(),
      spaceId: z.string().min(1).optional(),
      title: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.string(),
      candidates: z.array(z.object({ id: z.string(), title: z.string(), when: z.string() }).strict()).optional(),
    })
    .strict(),
]);
export type VoiceOutput = z.infer<typeof voiceOutputSchema>;

/** Longest `say` a tool returns: room left for the model's own words under the 700 cap. */
export const SAY_MAX_CHARS = 500;
const SEARCH_TOP = 5;
const SNIPPET_CHARS = 60;

/** Collapses whitespace and cuts to max characters on a word boundary with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** '08:00' -> '8 a.m.', '22:30' -> '10:30 p.m.', '12:00' -> 'noon', '00:00' -> 'midnight'. */
function clockPhrase(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  if (m === 0 && h === 0) return 'midnight';
  if (m === 0 && h === 12) return 'noon';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m === 0 ? '' : `:${String(m).padStart(2, '0')}`} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

/** "every hour from 8 a.m. to 10 p.m.", "every 3 hours, day and night". */
function hourlyPhrase(h: HourlyRepeat): string {
  const every = h.everyHours === 1 ? 'every hour' : `every ${h.everyHours} hours`;
  if (h.from === '00:00' && h.to === '23:59') return `${every}, day and night`;
  return `${every} from ${clockPhrase(h.from)} to ${clockPhrase(h.to)}`;
}

function repeatPhrase(r: ReminderLine): string {
  if (r.hourly !== undefined) return `, ${hourlyPhrase(r.hourly)}`;
  if (r.repeat === null) return '';
  return r.repeat === 'weekdays' ? ', every weekday' : `, repeating ${r.repeat}`;
}

/** The phrase as a sentence: one full stop, even after "p.m.". */
function reminderSentence(r: ReminderLine): string {
  const phrase = reminderPhrase(r);
  return phrase.endsWith('.') ? phrase : `${phrase}.`;
}

function reminderPhrase(r: ReminderLine): string {
  const when = r.hourly === undefined ? r.when : `starting ${r.when}`;
  return `${r.title}, ${when}${repeatPhrase(r)}`;
}

type ItemLink = { noteId?: string; reminderId?: string; spaceId?: string; title?: string };

/** The link fields for an item its binder placed in a Space; none without one. */
function linkOf(item: { id: string; title: string; spaceId?: string }, kind: 'note' | 'reminder'): ItemLink {
  if (item.spaceId === undefined) return {};
  const id = kind === 'note' ? { noteId: item.id } : { reminderId: item.id };
  return { ...id, spaceId: item.spaceId, title: item.title };
}

/** Runs a callback and maps its result to a clipped `say` plus any link, or a rejection to a failure. */
async function speak<T>(
  run: () => Promise<T>,
  say: (value: T) => string,
  link: (value: T) => ItemLink = () => ({}),
): Promise<VoiceOutput> {
  try {
    const value = await run();
    return { ok: true, say: clip(say(value), SAY_MAX_CHARS), ...link(value) };
  } catch (error) {
    if (error instanceof AmbiguousReminderError) {
      return {
        ok: false,
        reason: `${error.message}; ask which one, then cancel by id`,
        candidates: error.candidates.slice(0, SEARCH_TOP).map((c) => ({ id: c.id, title: c.title, when: c.when })),
      };
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Builds the eight voice tools over the callback bag. Descriptions are the
 * model's only instructions: what the tool does, and when not to use it.
 */
export function createVoiceTools(cb: VoiceCallbacks): Record<string, Tool> {
  const common = { outputSchema: voiceOutputSchema } as const;
  return {
    create_reminder: tool({
      ...common,
      description: 'Set one reminder. Any request with a time to tell the person something is a reminder, never a memory. It is not for marking the person away, busy or unavailable, even phrased \"remember that...\" -- that is create_event. `when` is an ISO 8601 date-time resolved from what they said, in their time zone with its offset (e.g. 2026-09-23T18:00:00+05:30). Use `repeat` only when they asked for a repeating reminder. Call it once per reminder. For a reminder on each of several days that is not a standing repeat, call it once per day. For a to-do without a time, use create_task instead.',
      inputSchema: createReminderToolSchema,
      execute: (input): Promise<VoiceOutput> =>
        speak(() => cb.createReminder(input), (r) => `Reminder set: ${reminderSentence(r)}`, (r) => linkOf(r, 'reminder')),
    }),
    list_reminders: tool({
      ...common,
      description: 'List upcoming reminders ("what reminders do I have").',
      inputSchema: listRemindersInputSchema,
      execute: (): Promise<VoiceOutput> =>
        speak(
          () => cb.listReminders(),
          (rows) =>
            rows.length === 0
              ? 'You have no upcoming reminders.'
              : `You have ${plural(rows.length, 'reminder', 'reminders')}. ${rows.map(reminderSentence).join(' ')}`,
        ),
    }),
    cancel_reminder: tool({
      ...common,
      description: 'Cancel one reminder by words from its text, or by id only from listed candidates. If several match you get candidates: ask which one; never cancel them all.',
      inputSchema: cancelReminderInputSchema,
      execute: (input): Promise<VoiceOutput> => {
        if (input.id === undefined && input.text === undefined) {
          return Promise.resolve({ ok: false, reason: 'say which reminder to cancel' });
        }
        return speak(() => cb.cancelReminder(input), (r) => `Cancelled the reminder: ${r.title}.`);
      },
    }),
    create_note: tool({
      ...common,
      description: 'Save a new note with text and an optional short title when asked to note or write something down. To add to an existing note, use append_note.',
      inputSchema: createNoteInputSchema,
      execute: (input): Promise<VoiceOutput> =>
        speak(() => cb.createNote(input), (n) => `Saved a note called ${n.title}.`, (n) => linkOf(n, 'note')),
    }),
    append_note: tool({
      ...common,
      description: 'Add text to the end of an existing note, named by its title or part of it. Not for a new note.',
      inputSchema: appendNoteInputSchema,
      execute: (input): Promise<VoiceOutput> =>
        speak(() => cb.appendNote(input), (n) => `Added that to your note ${n.title}.`, (n) => linkOf(n, 'note')),
    }),
    read_note: tool({
      ...common,
      description: 'Read out one note, named by its title or part of it.',
      inputSchema: readNoteInputSchema,
      execute: (input): Promise<VoiceOutput> =>
        speak(
          () => cb.readNote(input),
          (n) => (n.body.trim() === '' ? `Your note ${n.title} is empty.` : `${n.title}: ${n.body}`),
        ),
    }),
    search: tool({
      ...common,
      description: 'Search tasks, notes, calendar events and threads for words; answers the top five matches. Set `kinds` only when they asked for one kind.',
      inputSchema: searchInputSchema,
      execute: (input): Promise<VoiceOutput> =>
        speak(
          () => cb.search(input),
          (hits) => {
            if (hits.length === 0) return `Nothing found for ${input.query}.`;
            const top = hits.slice(0, SEARCH_TOP);
            const lines = top.map((h) => {
              const snippet = clip(h.snippet, SNIPPET_CHARS);
              return `${h.kind} ${h.title}${snippet === '' ? '' : `: ${snippet}`}.`;
            });
            return `Top ${plural(top.length, 'match', 'matches')}. ${lines.join(' ')}`;
          },
        ),
    }),
    read_inbox: tool({
      ...common,
      description: 'Answer "what did I miss?": the unread inbox count and the newest few items.',
      inputSchema: readInboxInputSchema,
      execute: (input): Promise<VoiceOutput> =>
        speak(
          () => cb.readInbox(input),
          (inbox) =>
            inbox.unread === 0
              ? 'Nothing new. You are all caught up.'
              : `You have ${plural(inbox.unread, 'unread item', 'unread items')}. ${inbox.items.map((i) => `${i.label}, ${i.when}.`).join(' ')}`,
        ),
    }),
  };
}
