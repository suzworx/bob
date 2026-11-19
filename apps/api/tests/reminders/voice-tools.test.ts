// Voice tools binder tests (#321/#323): bindVoiceTools over the PG test DB,
// driven through createVoiceTools as the agent would call them. A voice
// reminder is due-queryable by the fan-out and lands in the caller's inbox;
// notes create/append/read; search finds a task and a note; nothing crosses a
// Space or an account.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVoiceTools } from '@bob/ai';
import { type VoiceOutput } from '@bob/ai/testing';
import { createReminderFanout } from '../../src/workflows/workflow-reminder-fire.ts';
import { bindVoiceTools, parseWhen, speakAgo } from '../../src/voice/voice-tools.ts';
import { type Db } from '../../src/platform/db/db.ts';
import { createNote } from '../../src/notes/store.ts';
import { createReminder, dueOccurrences, listReminders } from '../../src/reminders/store.ts';
import { addMember, createSpace, ensurePrivateSpace } from '../../src/spaces/store.ts';
import { createTask } from '../../src/tasks/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb, withUserRaw } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const ZONE = 'Asia/Kolkata';
let pg: TestDb;
let db: Db;
let me: TestAccount;
let other: TestAccount;
let privateId: string;
let groupId: string;
let otherPrivateId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  me = await addAccount(pg);
  other = await addAccount(pg);
  privateId = (await ensurePrivateSpace(db, me.userId)).id;
  groupId = (await createSpace(db, me.userId, { kind: 'group', name: 'Family' })).id;
  otherPrivateId = (await ensurePrivateSpace(db, other.userId)).id;
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

type Call = (name: string, input?: unknown) => Promise<VoiceOutput>;

function voice(userId: string, spaceId: string, now: () => number = Date.now): Call {
  const tools = createVoiceTools(bindVoiceTools(db, userId, { spaceId, timeZone: ZONE, now }));
  return async (name, input = {}) =>
    (await tools[name]!.execute!(input as never, { toolCallId: 't', messages: [], context: {} })) as VoiceOutput;
}

function said(out: VoiceOutput): string {
  if (!out.ok) throw new Error(`tool failed: ${out.reason}`);
  return out.say;
}

describe('bindVoiceTools helpers', () => {
  it('reads a time without an offset as wall time in the zone', () => {
    expect(parseWhen('2026-09-23T18:00', ZONE)).toBe(Date.parse('2026-09-23T12:30:00Z'));
    expect(parseWhen('2026-09-23T18:00:00+05:30', 'UTC')).toBe(Date.parse('2026-09-23T12:30:00Z'));
    expect(() => parseWhen('six o clock', ZONE)).toThrow('could not understand');
  });

  it('speaks elapsed time', () => {
    expect(speakAgo(0, 30_000)).toBe('just now');
    expect(speakAgo(0, 5 * 60_000)).toBe('5 minutes ago');
    expect(speakAgo(0, 26 * 3_600_000)).toBe('1 day ago');
  });
});

describe('reminders by voice', () => {
  it('lands for the caller, is due-queryable by the fan-out and reaches the inbox', async () => {
    const due = Date.now() + 3_600_000;
    const call = voice(me.userId, privateId);
    const out = said(await call('create_reminder', { text: 'call mum', when: new Date(due).toISOString() }));
    expect(out).toMatch(/^Reminder set: call mum, /);

    const [created] = (await listReminders(db, me.userId, privateId)).filter((r) => r.title === 'call mum');
    expect(created).toMatchObject({ spaceId: privateId, dueAt: due, dueZone: ZONE, rrule: null, createdBy: me.userId });
    const occurrences = await dueOccurrences(db, { now: due + 1_000 });
    expect(occurrences.filter((o) => o.reminderId === created!.id).map((o) => o.userId)).toEqual([me.userId]);

    await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => due + 1_000 }).tick();
    // The inbox row is stamped by the DB clock when the fan-out wrote it, not at
    // the due time; 150 s keeps a few seconds of DB/Node skew inside "2 minutes".
    const later = Date.now() + 150_000;
    const inbox = said(await voice(me.userId, privateId, () => later)('read_inbox'));
    expect(inbox).toContain('Reminder: call mum, 2 minutes ago.');
    // The inbox is per Space: the group Space has nothing of this.
    expect(said(await voice(me.userId, groupId)('read_inbox'))).toBe('Nothing new. You are all caught up.');
  });

  it('writes the caller as the only recipient with the reminder, in one step (#508)', async () => {
    const due = Date.now() + 7_200_000;
    said(await voice(me.userId, groupId)('create_reminder', { text: 'feed the cat', when: new Date(due).toISOString() }));
    const [created] = (await listReminders(db, me.userId, groupId)).filter((r) => r.title === 'feed the cat');
    const recipients = await withUserRaw(pg, me.userId, (tx) => tx.query<{ user_id: string }>(
      'SELECT user_id FROM bob.reminder_recipients WHERE reminder_id = $1', [created!.id]));
    expect(recipients.rows.map((r) => r.user_id)).toEqual([me.userId]);
  });

  it('refuses a one-shot time already passed', async () => {
    const out = await voice(me.userId, privateId)('create_reminder', { text: 'too late', when: '2020-01-01T09:00:00Z' });
    expect(out).toEqual({ ok: false, reason: 'that time has already passed' });
  });

  it('stores a weekday repeat as a weekly rule and lists it', async () => {
    const call = voice(me.userId, groupId);
    said(await call('create_reminder', { text: 'stand-up', when: '2026-09-24T09:30:00+05:30', repeat: 'weekdays' }));
    const [row] = (await listReminders(db, me.userId, groupId)).filter((r) => r.title === 'stand-up');
    expect(row!.rrule).toEqual({ freq: 'weekly', byWeekday: [1, 2, 3, 4, 5] });
    expect(said(await call('list_reminders'))).toContain('stand-up, Thu, Sep 24, 9:30 AM, every weekday.');
  });

  it('an hourly repeat defaults to waking hours and starts at its first real ring (#456)', async () => {
    // 23:10 in Kolkata: outside 08:00-22:00, so the first ring is 08:00 next morning.
    const late = Date.parse('2026-09-25T23:10:00+05:30');
    const call = voice(me.userId, privateId, () => late);
    const out = said(await call('create_reminder', { text: 'have water', when: '2026-09-25T23:10:00+05:30', repeat: 'hourly' }));
    expect(out).toBe('Reminder set: have water, starting Sat, Sep 26, 8:00 AM, every hour from 8 a.m. to 10 p.m.');

    const [row] = (await listReminders(db, me.userId, privateId)).filter((r) => r.title === 'have water');
    expect(row).toMatchObject({
      dueAt: Date.parse('2026-09-26T08:00:00+05:30'),
      rrule: { freq: 'hourly', interval: 1, window: { start: '08:00', end: '22:00' } },
    });
    const due = await dueOccurrences(db, { now: Date.parse('2026-09-26T09:00:30+05:30') });
    expect(due.filter((o) => o.reminderId === row!.id)).toMatchObject([
      { occurrenceAt: Date.parse('2026-09-26T09:00:00+05:30'), catchUp: true },
    ]);
  });

  it('every few hours inside named hours is stored and read back as said', async () => {
    const call = voice(me.userId, groupId, () => Date.parse('2026-09-25T10:15:00+05:30'));
    said(await call('create_reminder', {
      text: 'stretch', when: '2026-09-25T10:15:00+05:30', repeat: 'hourly', every_hours: 3,
      active_hours: { from: '09:00', to: '18:00' },
    }));
    const [row] = (await listReminders(db, me.userId, groupId)).filter((r) => r.title === 'stretch');
    expect(row).toMatchObject({
      dueAt: Date.parse('2026-09-25T12:00:00+05:30'),
      rrule: { freq: 'hourly', interval: 3, window: { start: '09:00', end: '18:00' } },
    });
    expect(said(await call('list_reminders'))).toContain('stretch, starting Fri, Sep 25, 12:00 PM, every 3 hours from 9 a.m. to 6 p.m.');
  });

  it('asks which one when a cancel is ambiguous, then cancels the exact one', async () => {
    const call = voice(me.userId, groupId);
    const when = new Date(Date.now() + 7_200_000).toISOString();
    said(await call('create_reminder', { text: 'water plants', when }));
    said(await call('create_reminder', { text: 'water plants outside', when }));
    const ambiguous = await call('cancel_reminder', { text: 'water' });
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    expect(ambiguous.candidates?.map((c) => c.title).sort()).toEqual(['water plants', 'water plants outside']);

    expect(said(await call('cancel_reminder', { text: 'Water plants' }))).toBe('Cancelled the reminder: water plants.');
    const listed = said(await call('list_reminders'));
    expect(listed).toContain('water plants outside');
    expect(listed).not.toMatch(/water plants,/);
  });
});

describe('notes and search by voice', () => {
  it('creates, appends to and reads back a note', async () => {
    const call = voice(me.userId, privateId);
    expect(said(await call('create_note', { title: 'Groceries', text: 'milk' }))).toBe('Saved a note called Groceries.');
    expect(said(await call('append_note', { note: 'grocer', text: 'eggs' }))).toBe('Added that to your note Groceries.');
    expect(said(await call('read_note', { note: 'groceries' }))).toBe('Groceries: milk eggs');
    expect(said(await call('create_note', { text: 'the wifi password is on the fridge door' })))
      .toBe('Saved a note called the wifi password is on the.');
    expect(await call('read_note', { note: 'no such thing' })).toEqual({ ok: false, reason: 'no note called no such thing' });
  });

  it('finds a task and a note in the bound Space, one line each', async () => {
    await createTask(db, me.userId, privateId, { title: 'Book the plumber' });
    await createNote(db, me.userId, privateId, { title: 'Plumber numbers', body: 'Ravi 98450' });
    const out = said(await voice(me.userId, privateId)('search', { query: 'plumber' }));
    expect(out).toMatch(/^Top 2 matches\./);
    expect(out).toContain('task Book the plumber.');
    expect(out).toContain('note Plumber numbers: Ravi 98450.');
    const tasksOnly = said(await voice(me.userId, privateId)('search', { query: 'plumber', kinds: ['task'] }));
    expect(tasksOnly).not.toContain('note');
  });
});

describe('isolation', () => {
  it('never reads, appends to or finds another Space or account', async () => {
    const theirs = await createNote(db, other.userId, otherPrivateId, { title: 'Secret diary', body: 'hidden words' });
    const shared = await createNote(db, me.userId, groupId, { title: 'Family diary', body: 'hidden words' });
    const mine = voice(me.userId, privateId);

    for (const note of ['Secret diary', theirs.id, 'Family diary', shared.id]) {
      expect((await mine('read_note', { note })).ok).toBe(false);
      expect((await mine('append_note', { note, text: 'x' })).ok).toBe(false);
    }
    expect(said(await mine('search', { query: 'hidden words' }))).toBe('Nothing found for hidden words.');
    // The group Space binder sees its own note, still not the other account's.
    expect(said(await voice(me.userId, groupId)('search', { query: 'hidden words' }))).toBe(
      'Top 1 match. note Family diary: hidden words.',
    );
  });

  it('cannot write into a Space the caller is not a member of', async () => {
    const intruder = voice(me.userId, otherPrivateId);
    expect((await intruder('create_note', { text: 'planted' })).ok).toBe(false);
    const when = new Date(Date.now() + 3_600_000).toISOString();
    expect((await intruder('create_reminder', { text: 'planted', when })).ok).toBe(false);
    expect(said(await voice(other.userId, otherPrivateId)('list_reminders'))).toBe('You have no upcoming reminders.');
    expect(await intruder('cancel_reminder', { text: 'anything' }))
      .toEqual({ ok: false, reason: 'no upcoming reminder matches that' });
  });
});

describe('reminders in a group Space are only those of the caller (release audit)', () => {
  it('lists and cancels only reminders the caller created or receives, never those of another member', async () => {
    const kin = await addAccount(pg);
    const shared = (await createSpace(db, me.userId, { kind: 'group', name: 'Scoped' })).id;
    await addMember(db, me.userId, shared, kin.userId, 'member');
    const due = { kind: 'instant' as const, at: Date.now() + 3_600_000, zone: ZONE };
    await createReminder(db, kin.userId, shared, { title: 'kin private dentist', due, recipients: [kin.userId] });
    await createReminder(db, kin.userId, shared, { title: 'kin asks me to feed the cat', due, recipients: [me.userId] });
    await createReminder(db, me.userId, shared, { title: 'my own errand', due, recipients: [me.userId] });

    const call = voice(me.userId, shared);
    const listed = said(await call('list_reminders'));
    expect(listed).toMatch(/^You have 2 reminders\./);
    expect(listed).toContain('feed the cat');
    expect(listed).toContain('my own errand');
    expect(listed).not.toContain('dentist');
    expect(await call('cancel_reminder', { text: 'dentist' })).toEqual({ ok: false, reason: 'no upcoming reminder matches that' });
    const [kinsOwn] = (await listReminders(db, kin.userId, shared)).filter((r) => r.title === 'kin private dentist');
    expect(kinsOwn?.status).toBe('active');
    expect(said(await call('cancel_reminder', { text: 'feed the cat' }))).toBe('Cancelled the reminder: kin asks me to feed the cat.');
  });

  it('a cancel naming nothing cancels nothing, even with one reminder active', async () => {
    const lone = (await createSpace(db, me.userId, { kind: 'group', name: 'Lone' })).id;
    const due = { kind: 'instant' as const, at: Date.now() + 3_600_000, zone: ZONE };
    await createReminder(db, me.userId, lone, { title: 'the only one', due, recipients: [me.userId] });
    const callbacks = bindVoiceTools(db, me.userId, { spaceId: lone, timeZone: ZONE });
    await expect(callbacks.cancelReminder({})).rejects.toThrow('say which reminder to cancel');
    expect((await listReminders(db, me.userId, lone)).map((r) => r.status)).toEqual(['active']);
  });
});

describe('tool output links the written item (#517)', () => {
  it('names the note and reminder a turn wrote, and the Space they are in; read_note links nothing', async () => {
    const call = voice(me.userId, groupId);
    const note = await call('create_note', { title: 'Shopping', text: 'bread' });
    expect(note).toMatchObject({ ok: true, spaceId: groupId, title: 'Shopping' });
    const noteId = (note as { noteId?: string }).noteId;
    expect(noteId).toEqual(expect.any(String));
    expect(await call('append_note', { note: 'shop', text: 'jam' })).toMatchObject({ noteId, spaceId: groupId });
    expect(await call('read_note', { note: 'shopping' })).not.toHaveProperty('noteId');

    const due = Date.now() + 3_600_000;
    const reminder = await call('create_reminder', { text: 'pay rent', when: new Date(due).toISOString() });
    const [row] = (await listReminders(db, me.userId, groupId)).filter((r) => r.title === 'pay rent');
    expect(reminder).toMatchObject({ ok: true, reminderId: row!.id, spaceId: groupId, title: 'pay rent' });
  });
});
