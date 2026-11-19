/**
 * Voice tools tests: createVoiceTools over fake callbacks. Outputs are one
 * speakable line inside the reply cap, rejections become { ok: false }, an
 * ambiguous cancel returns candidates, and input schemas stay narrow.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AmbiguousReminderError,
  SAY_MAX_CHARS,
  clip,
  cancelReminderInputSchema,
  createReminderInputSchema,
  firstHourlyRing,
  createVoiceTools,
  searchInputSchema,
  type VoiceCallbacks,
  type VoiceOutput,
} from '../src/voice-tools.ts';

const mum = { id: 'r-1', title: 'call mum', when: 'Wed, Sep 23, 6:00 PM', repeat: null };

function fakes(overrides: Partial<VoiceCallbacks> = {}): VoiceCallbacks {
  return {
    createReminder: async () => mum,
    listReminders: async () => [mum, { ...mum, id: 'r-2', title: 'take pills', repeat: 'daily' }],
    cancelReminder: async () => mum,
    createNote: async (input) => ({ id: 'n-1', title: input.title ?? 'Groceries', body: input.text }),
    appendNote: async () => ({ id: 'n-1', title: 'Groceries', body: 'milk\neggs' }),
    readNote: async () => ({ id: 'n-1', title: 'Groceries', body: 'x'.repeat(5000) }),
    search: async () => [
      { kind: 'task', title: 'Buy milk', snippet: '' },
      { kind: 'note', title: 'Groceries', snippet: 'milk and eggs and bread' },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: 'event' as const, title: `Event ${i}`, snippet: '' })),
    ],
    readInbox: async () => ({ unread: 3, items: [{ label: 'Reminder: call mum', when: '5 minutes ago' }] }),
    ...overrides,
  };
}

async function run(name: string, input: unknown, cb = fakes()): Promise<VoiceOutput> {
  const tools = createVoiceTools(cb);
  return (await tools[name]!.execute!(input as never, { toolCallId: 't', messages: [] })) as VoiceOutput;
}

describe('createVoiceTools', () => {
  it('offers exactly the eight voice tools', () => {
    expect(Object.keys(createVoiceTools(fakes())).sort()).toEqual([
      'append_note', 'cancel_reminder', 'create_note', 'create_reminder',
      'list_reminders', 'read_inbox', 'read_note', 'search',
    ]);
  });

  it('answers each tool with one short speakable line and no ids', async () => {
    const cases: [string, unknown, string][] = [
      ['create_reminder', { text: 'call mum', when: '2026-09-23T18:00:00+05:30' }, 'Reminder set: call mum'],
      ['list_reminders', {}, 'You have 2 reminders.'],
      ['cancel_reminder', { text: 'mum' }, 'Cancelled the reminder: call mum.'],
      ['create_note', { text: 'milk' }, 'Saved a note called Groceries.'],
      ['append_note', { note: 'groceries', text: 'eggs' }, 'Added that to your note Groceries.'],
      ['read_note', { note: 'groceries' }, 'Groceries: xxx'],
      ['search', { query: 'milk' }, 'Top 5 matches.'],
      ['read_inbox', {}, 'You have 3 unread items. Reminder: call mum, 5 minutes ago.'],
    ];
    for (const [name, input, expected] of cases) {
      const out = await run(name, input);
      expect(out.ok, name).toBe(true);
      if (!out.ok) continue;
      expect(out.say, name).toContain(expected);
      expect(out.say.length, name).toBeLessThanOrEqual(SAY_MAX_CHARS);
      expect(out.say, name).not.toMatch(/\b(r|n)-\d\b/);
    }
  });

  it('says "repeating daily" and caps search at five one-line hits', async () => {
    const list = await run('list_reminders', {});
    expect(list.ok && list.say).toContain('take pills, Wed, Sep 23, 6:00 PM, repeating daily.');
    const search = await run('search', { query: 'milk' });
    expect(search.ok && search.say).toContain('note Groceries: milk and eggs and bread.');
    expect(search.ok && search.say).not.toContain('Event 3');
  });

  it('speaks the empty cases', async () => {
    const cb = fakes({ listReminders: async () => [], search: async () => [], readInbox: async () => ({ unread: 0, items: [] }) });
    expect(await run('list_reminders', {}, cb)).toEqual({ ok: true, say: 'You have no upcoming reminders.' });
    expect(await run('search', { query: 'zebra' }, cb)).toEqual({ ok: true, say: 'Nothing found for zebra.' });
    expect(await run('read_inbox', {}, cb)).toEqual({ ok: true, say: 'Nothing new. You are all caught up.' });
  });

  it('turns a rejected callback into { ok: false, reason }', async () => {
    const cb = fakes({ readNote: async () => { throw new Error('no note matches'); } });
    expect(await run('read_note', { note: 'zzz' }, cb)).toEqual({ ok: false, reason: 'no note matches' });
  });

  it('returns candidates with ids when a cancel is ambiguous', async () => {
    const two = [mum, { ...mum, id: 'r-3', title: 'call mum back' }];
    const cb = fakes({ cancelReminder: async () => { throw new AmbiguousReminderError(two); } });
    const out = await run('cancel_reminder', { text: 'mum' }, cb);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.candidates?.map((c) => c.id)).toEqual(['r-1', 'r-3']);
  });

  it('refuses a cancel that names nothing, without calling back', async () => {
    let called = false;
    const cb = fakes({ cancelReminder: async () => { called = true; return mum; } });
    expect((await run('cancel_reminder', {}, cb)).ok).toBe(false);
    expect(called).toBe(false);
  });

  it('requires an id or text to cancel a reminder: naming nothing is a schema error', () => {
    expect(cancelReminderInputSchema.safeParse({}).success).toBe(false);
    expect(cancelReminderInputSchema.safeParse({ text: '  ' }).success).toBe(false);
    expect(cancelReminderInputSchema.safeParse({ text: 'mum' }).success).toBe(true);
    expect(cancelReminderInputSchema.safeParse({ id: 'r-1' }).success).toBe(true);
  });

  it('keeps input schemas narrow: no space, account or unknown kind', () => {
    expect(createReminderInputSchema.safeParse({ text: 'x', when: 'y', spaceId: 's' }).success).toBe(false);
    expect(createReminderInputSchema.safeParse({ text: 'x', when: 'y', repeat: 'minutely' }).success).toBe(false);
    expect(searchInputSchema.safeParse({ query: 'x', kinds: ['email'] }).success).toBe(false);
  });

  it('takes hourly with every_hours 1..12 and 24-hour active hours, and only with repeat hourly (#456)', () => {
    const ok = (input: object): boolean => createReminderInputSchema.safeParse({ text: 'water', when: 'y', ...input }).success;
    expect(ok({ repeat: 'hourly' })).toBe(true);
    expect(ok({ repeat: 'hourly', every_hours: 12, active_hours: { start: '08:00', end: '22:00' } })).toBe(true);
    expect(ok({ repeat: 'hourly', every_hours: 0 })).toBe(false);
    expect(ok({ repeat: 'hourly', every_hours: 13 })).toBe(false);
    expect(ok({ repeat: 'hourly', every_hours: 1.5 })).toBe(false);
    expect(ok({ repeat: 'hourly', active_hours: { start: '8am', end: '22:00' } })).toBe(false);
    expect(ok({ repeat: 'hourly', active_hours: { start: '22:00', end: '08:00' } })).toBe(false);
    expect(ok({ repeat: 'daily', every_hours: 2 })).toBe(false);
    expect(ok({ active_hours: { start: '08:00', end: '22:00' } })).toBe(false);
  });

  it('hands callers the stored { from, to } window; the model-facing keys are start/end (RELIABLE)', () => {
    const parsed = createReminderInputSchema.parse({ text: 'water', when: 'y', repeat: 'hourly', active_hours: { start: '09:00', end: '18:00' } });
    expect(parsed.active_hours).toEqual({ from: '09:00', to: '18:00' });
    // gemini-2.5-flash once sent `from1` for `from`; a stray key still fails loudly rather than guessing.
    expect(createReminderInputSchema.safeParse({ text: 'water', when: 'y', repeat: 'hourly', active_hours: { from1: '08:00', end: '22:00' } }).success)
      .toBe(false);
  });

  it('lets an hourly repeat with no start leave out `when`: the first ring is one interval from now (RELIABLE)', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-26T03:07:30Z') });
    try {
      expect(createReminderInputSchema.parse({ text: 'water', repeat: 'hourly' }).when).toBe('2026-09-26T04:08:00.000Z');
      expect(createReminderInputSchema.parse({ text: 'water', repeat: 'hourly', every_hours: 2 }).when).toBe('2026-09-26T05:08:00.000Z');
      expect(createReminderInputSchema.parse({ text: 'water', when: '2026-09-26T09:00:00-07:00', repeat: 'hourly' }).when)
        .toBe('2026-09-26T09:00:00-07:00');
    } finally {
      vi.useRealTimers();
    }
    expect(firstHourlyRing(Date.parse('2026-09-26T03:00:00Z'), 1)).toBe('2026-09-26T04:00:00.000Z');
    for (const repeat of [undefined, 'daily', 'weekly']) {
      expect(createReminderInputSchema.safeParse({ text: 'water', ...(repeat ? { repeat } : {}) }).success).toBe(false);
    }
  });

  it('speaks an hourly repeat with its hours, one full stop, in create and list', async () => {
    const water = { ...mum, title: 'have water', when: 'Sat, Sep 26, 8:00 AM', repeat: 'hourly' as const,
      hourly: { everyHours: 1, from: '08:00', to: '22:00' } };
    const stretch = { ...water, title: 'stretch', hourly: { everyHours: 3, from: '00:00', to: '23:59' } };
    const lunch = { ...water, title: 'eat', hourly: { everyHours: 2, from: '12:00', to: '13:30' } };
    const cb = fakes({ createReminder: async () => water, listReminders: async () => [water, stretch, lunch] });
    expect(await run('create_reminder', { text: 'have water', when: 'y', repeat: 'hourly' }, cb)).toEqual({
      ok: true, say: 'Reminder set: have water, starting Sat, Sep 26, 8:00 AM, every hour from 8 a.m. to 10 p.m.',
    });
    const list = await run('list_reminders', {}, cb);
    expect(list.ok && list.say).toContain('10 p.m. stretch, starting Sat, Sep 26, 8:00 AM, every 3 hours, day and night.');
    expect(list.ok && list.say).toContain('every 2 hours from noon to 1:30 p.m.');
    expect(list.ok && list.say).not.toContain('..');
  });

  it('clip cuts on a word boundary with an ellipsis', () => {
    expect(clip('one  two\nthree', 50)).toBe('one two three');
    expect(clip('alpha beta gamma delta', 12)).toBe('alpha beta…');
  });
});

describe('item links in the output (#517)', () => {
  const placed = fakes({
    createReminder: async () => ({ ...mum, spaceId: 's-1' }),
    createNote: async () => ({ id: 'n-1', title: 'Groceries', body: 'milk', spaceId: 's-1' }),
    appendNote: async () => ({ id: 'n-1', title: 'Groceries', body: 'milk\neggs', spaceId: 's-1' }),
    readNote: async () => ({ id: 'n-1', title: 'Groceries', body: 'milk', spaceId: 's-1' }),
  });

  it('links a written note or reminder to its Space, beside an unchanged say', async () => {
    expect(await run('create_note', { text: 'milk' }, placed))
      .toEqual({ ok: true, say: 'Saved a note called Groceries.', noteId: 'n-1', spaceId: 's-1', title: 'Groceries' });
    expect(await run('append_note', { note: 'groc', text: 'eggs' }, placed))
      .toEqual({ ok: true, say: 'Added that to your note Groceries.', noteId: 'n-1', spaceId: 's-1', title: 'Groceries' });
    expect(await run('create_reminder', { text: 'call mum', when: '2026-09-23T18:00:00+05:30' }, placed))
      .toMatchObject({ ok: true, reminderId: 'r-1', spaceId: 's-1', title: 'call mum' });
  });

  it('links nothing without a Space, and never for a read or a failure', async () => {
    expect(await run('create_note', { text: 'milk' })).toEqual({ ok: true, say: 'Saved a note called Groceries.' });
    expect(await run('read_note', { note: 'groc' }, placed)).not.toHaveProperty('noteId');
    const failing = fakes({ createNote: async () => Promise.reject(new Error('no space')) });
    expect(await run('create_note', { text: 'milk' }, failing)).toEqual({ ok: false, reason: 'no space' });
  });
});
