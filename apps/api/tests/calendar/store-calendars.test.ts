// store/calendars.ts tests (spec 014, S14-T006). Real Postgres via createTestDb, same
// setup as store-spaces.test.ts; createTestDb applies every migration including
// 20260916053000_calendar_init.sql. Each of the seven brief rules is asserted
// with its own test, plus basic CRUD and the optimistic-conflict path.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreConflictError, StoreError, StoreNotFoundError, type Db } from '../../src/platform/db/db.ts';
import { addMember, archiveSpace, createSpace, restoreSpace, revokeMember } from '../../src/spaces/store.ts';
import {
  addAttendee,
  CalendarForbiddenError,
  cancelEvent,
  createCalendar,
  createEvent,
  getEvent,
  listAgenda,
  listAttendees,
  listCalendars,
  listEvents,
  removeAttendee,
  setAttendeeResponse,
  updateEvent,
} from '../../src/calendar/store.ts';
import { isEventModerator } from '../../src/calendar/store.ts';
import { asDb, addAccount, closeTestDb, createTestDb, withUserRaw, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

const WEEKLY_START = Date.parse('2026-10-05T09:00:00Z');
const WEEKLY_END = Date.parse('2026-10-05T10:00:00Z');

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

/** A group space with an owner and one ordinary member, plus a calendar. */
async function setup() {
  const owner = await addAccount(pg);
  const member = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  const calendar = await createCalendar(db, owner.userId, space.id, {
    name: 'Home',
    zone: 'Asia/Kolkata',
  });
  return { owner, member, space, calendar };
}

/** A weekly timed event starting Monday 2026-10-05 09:00 UTC. */
async function weeklyEvent(owner: { userId: string }, calendarId: string) {
  return createEvent(db, owner.userId, calendarId, {
    title: 'Standup',
    allDay: false,
    startAt: WEEKLY_START,
    endAt: WEEKLY_END,
    zone: 'UTC',
    rrule: { freq: 'weekly' },
  });
}

describe('calendars store', () => {
  it('listCalendars returns the space calendars and createCalendar records the creator', async () => {
    const { owner, member, space, calendar } = await setup();
    const listed = await listCalendars(db, owner.userId, space.id);
    expect(listed.map((entry) => entry.id)).toEqual([calendar.id]);
    expect(listed[0]).toMatchObject({
      spaceId: space.id,
      name: 'Home',
      zone: 'Asia/Kolkata',
      origin: 'native',
      createdBy: owner.userId,
    });
    // A member of the space sees the same calendars.
    expect((await listCalendars(db, member.userId, space.id)).map((entry) => entry.id)).toEqual([
      calendar.id,
    ]);
  });

  it('createEvent stores uid, sequence 0 and the timing mode', async () => {
    const { owner, calendar } = await setup();
    const event = await createEvent(db, owner.userId, calendar.id, {
      title: 'Dinner',
      allDay: false,
      startAt: WEEKLY_START,
      endAt: WEEKLY_END,
      zone: 'UTC',
    });
    expect(event.uid).toBeTypeOf('string');
    expect(event.sequence).toBe(0);
    expect(event.revision).toBe(1);
    expect(event.organizerUserId).toBe(owner.userId);
    expect(event.startAt).toBe(WEEKLY_START);
    expect(event.startDate).toBeNull();
    expect(event.status).toBe('confirmed');
  });

  it('rule 1: updateEvent takes an explicit scope and never defaults it', async () => {
    const { owner, calendar } = await setup();
    const event = await weeklyEvent(owner, calendar.id);
    // scope 'this' on a recurring event with no occurrence_start is an error,
    // not a silent fallback to 'series'.
    await expect(
      updateEvent(db, owner.userId, event.id, 'this', { revision: 1, patch: { title: 'Shifted' } }),
    ).rejects.toThrow(StoreError);
    // an out-of-enum scope is rejected too.
    await expect(
      updateEvent(db, owner.userId, event.id, 'bogus' as never, {
        revision: 1,
        patch: { title: 'Shifted' },
      }),
    ).rejects.toThrow(StoreError);
  });

  it('rule 2: uid is stable and sequence increments on every attendee-visible change', async () => {
    const { owner, calendar } = await setup();
    const created = await createEvent(db, owner.userId, calendar.id, {
      title: 'Dinner',
      allDay: false,
      startAt: WEEKLY_START,
      endAt: WEEKLY_END,
      zone: 'UTC',
    });
    expect(created.sequence).toBe(0);
    const first = await updateEvent(db, owner.userId, created.id, 'series', {
      revision: 1,
      patch: { title: 'Dinner v2' },
    });
    const second = await updateEvent(db, owner.userId, created.id, 'series', {
      revision: 2,
      patch: { title: 'Dinner v3' },
    });
    expect(first.uid).toBe(created.uid);
    expect(second.uid).toBe(created.uid);
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.revision).toBe(3);
    expect(second.title).toBe('Dinner v3');
  });

  it('an update with a stale revision answers StoreConflictError', async () => {
    const { owner, calendar } = await setup();
    const created = await createEvent(db, owner.userId, calendar.id, {
      title: 'Dinner',
      allDay: false,
      startAt: WEEKLY_START,
      endAt: WEEKLY_END,
      zone: 'UTC',
    });
    await updateEvent(db, owner.userId, created.id, 'series', { revision: 1, patch: { title: 'v2' } });
    await expect(
      updateEvent(db, owner.userId, created.id, 'series', { revision: 1, patch: { title: 'stale' } }),
    ).rejects.toThrow(StoreConflictError);
  });

  it('rule 3: only an attendee may set their own response', async () => {
    const { owner, member, space, calendar } = await setup();
    const bystander = await addAccount(pg);
    await addMember(db, owner.userId, space.id, bystander.userId, 'member');
    const event = await createEvent(db, owner.userId, calendar.id, {
      title: 'Dinner',
      allDay: false,
      startAt: WEEKLY_START,
      endAt: WEEKLY_END,
      zone: 'UTC',
    });
    await addAttendee(db, owner.userId, event.id, { userId: member.userId });
    // The organizer is not an attendee and cannot RSVP.
    await expect(
      setAttendeeResponse(db, owner.userId, event.id, 'accepted'),
    ).rejects.toThrow(StoreError);
    // A fellow member who is not an attendee cannot RSVP either.
    await expect(
      setAttendeeResponse(db, bystander.userId, event.id, 'declined'),
    ).rejects.toThrow(StoreError);
    // The actual attendee can set their own response.
    const rsvp = await setAttendeeResponse(db, member.userId, event.id, 'accepted');
    expect(rsvp.response).toBe('accepted');
  });

  it('rule 4: being invited grants no membership', async () => {
    const { owner, member, calendar } = await setup();
    const outsider = await addAccount(pg);
    const event = await createEvent(db, owner.userId, calendar.id, {
      title: 'Dinner',
      allDay: false,
      startAt: WEEKLY_START,
      endAt: WEEKLY_END,
      zone: 'UTC',
    });
    // An outsider who is not a member cannot even be invited.
    await expect(
      addAttendee(db, owner.userId, event.id, { userId: outsider.userId }),
    ).rejects.toThrow(/active member/);
    await addAttendee(db, owner.userId, event.id, { userId: member.userId });
    // Inviting a member creates no space_memberships row for them (it already
    // exists), and the attendee row is the only new row.
    // Read as the member: space_memberships_select allows a caller to see
    // their own row (RLS: user_id = auth.uid() or is_space_member(space_id)).
    const memberships = await withUserRaw(pg, member.userId, (tx) =>
      tx.query<{ total: number }>(
        `select count(*)::int as total from bob.space_memberships where user_id = $1`,
        [member.userId],
      ),
    );
    expect(Number(memberships.rows[0]!.total)).toBe(1);
    expect((await listAttendees(db, owner.userId, event.id)).map((a) => a.userId)).toContain(
      member.userId,
    );
  });

  it('rule 5: an all-day date survives any viewer time zone', async () => {
    const { owner, calendar } = await setup();
    const event = await createEvent(db, owner.userId, calendar.id, {
      title: 'Festival',
      allDay: true,
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      zone: 'Asia/Kolkata',
    });
    // The all-day event stores dates, never midnight instants.
    expect(event.startAt).toBeNull();
    expect(event.startDate).toBe('2026-10-01');
    // Read back (a "viewer" in any zone gets the same stored date string).
    const read = await getEvent(db, owner.userId, event.id);
    expect(read.startDate).toBe('2026-10-01');
    expect(read.endDate).toBe('2026-10-02');
    const occurrences = await listEvents(db, owner.userId, calendar.id, {
      from: Date.parse('2026-09-01T00:00:00Z'),
      to: Date.parse('2026-11-01T00:00:00Z'),
    });
    expect(occurrences[0]).toMatchObject({ allDay: true, startDate: '2026-10-01', startAt: null });
  });

  it('listEvents expands a weekly recurrence into a window', async () => {
    const { owner, calendar } = await setup();
    await weeklyEvent(owner, calendar.id);
    const occurrences = await listEvents(db, owner.userId, calendar.id, {
      from: Date.parse('2026-10-01T00:00:00Z'),
      to: Date.parse('2026-11-01T00:00:00Z'),
    });
    expect(occurrences.map((entry) => entry.startAt)).toEqual([
      WEEKLY_START,
      WEEKLY_START + 7 * 86_400_000,
      WEEKLY_START + 14 * 86_400_000,
      WEEKLY_START + 21 * 86_400_000,
    ]);
  });

  it('rule 6: cancelling one occurrence leaves the series intact; cancelling the series keeps rows', async () => {
    const { owner, calendar } = await setup();
    const event = await weeklyEvent(owner, calendar.id);
    const window = {
      from: Date.parse('2026-10-01T00:00:00Z'),
      to: Date.parse('2026-11-01T00:00:00Z'),
    };
    expect(await listEvents(db, owner.userId, calendar.id, window)).toHaveLength(4);

    await cancelEvent(db, owner.userId, event.id, 'this', { occurrenceStart: WEEKLY_START });
    const afterOne = await listEvents(db, owner.userId, calendar.id, window);
    expect(afterOne).toHaveLength(3);
    expect(afterOne.every((entry) => entry.originalOccurrenceStart !== WEEKLY_START)).toBe(true);
    // Read as the owner: event_exceptions_select is pure space-membership
    // (is_space_member(space_id)); the owner created the event's calendar and
    // is a member of the space.
    const exceptions = await withUserRaw(pg, owner.userId, (tx) =>
      tx.query<{ total: number }>(
        `select count(*)::int as total from bob.event_exceptions where event_id = $1 and cancelled`,
        [event.id],
      ),
    );
    expect(Number(exceptions.rows[0]!.total)).toBe(1);

    // Cancelling the series sets status without deleting rows, so attendees can
    // still see it was cancelled.
    await cancelEvent(db, owner.userId, event.id, 'series', {});
    const master = await getEvent(db, owner.userId, event.id);
    expect(master.status).toBe('cancelled');
    expect(await listEvents(db, owner.userId, calendar.id, window)).toHaveLength(0);
  });

  it('CU-REVIEW-4a: this_and_following across a forward DST shift keeps the occurrence just before the target', async () => {
    const { owner, calendar } = await setup();
    const dstStart = Date.parse('2027-03-11T05:30:00Z'); // Thu 2027-03-11 00:30 EST (America/New_York)
    const event = await createEvent(db, owner.userId, calendar.id, {
      title: 'Late check-in',
      allDay: false,
      startAt: dstStart,
      endAt: dstStart + 30 * 60_000,
      zone: 'America/New_York',
      rrule: { freq: 'daily' },
    });
    const mondayOccurrence = Date.parse('2027-03-15T04:30:00Z'); // Mon 00:30 EDT, first occurrence after spring-forward
    await cancelEvent(db, owner.userId, event.id, 'this_and_following', {
      occurrenceStart: mondayOccurrence,
    });
    const occurrences = await listEvents(db, owner.userId, calendar.id, {
      from: Date.parse('2027-03-10T00:00:00Z'),
      to: Date.parse('2027-03-20T00:00:00Z'),
    });
    expect(occurrences.map((entry) => entry.startAt)).toEqual([
      Date.parse('2027-03-11T05:30:00Z'),
      Date.parse('2027-03-12T05:30:00Z'),
      Date.parse('2027-03-13T05:30:00Z'),
      Date.parse('2027-03-14T05:30:00Z'),
    ]);
    expect(occurrences.every((entry) => entry.startAt! < mondayOccurrence)).toBe(true);
  });

  it('CU-REVIEW-4b: this_and_following on an all-day series west of UTC keeps the day before the target', async () => {
    const { owner, calendar } = await setup();
    const event = await createEvent(db, owner.userId, calendar.id, {
      title: 'Conference',
      allDay: true,
      startDate: '2026-10-05',
      endDate: '2026-10-06',
      zone: 'America/New_York',
      rrule: { freq: 'daily' },
    });
    await cancelEvent(db, owner.userId, event.id, 'this_and_following', {
      occurrenceStart: Date.parse('2026-10-08T00:00:00Z'),
    });
    const occurrences = await listEvents(db, owner.userId, calendar.id, {
      from: Date.parse('2026-10-01T00:00:00Z'),
      to: Date.parse('2026-10-15T00:00:00Z'),
    });
    expect(occurrences.map((entry) => entry.startDate)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
  });

  it('CU-REVIEW-4c (control, no DST): this_and_following on a UTC timed series keeps the day before the target', async () => {
    const { owner, calendar } = await setup();
    const start = Date.parse('2026-10-05T09:00:00Z');
    const event = await createEvent(db, owner.userId, calendar.id, {
      title: 'Sync',
      allDay: false,
      startAt: start,
      endAt: start + 3_600_000,
      zone: 'UTC',
      rrule: { freq: 'daily' },
    });
    await cancelEvent(db, owner.userId, event.id, 'this_and_following', {
      occurrenceStart: Date.parse('2026-10-08T09:00:00Z'),
    });
    const occurrences = await listEvents(db, owner.userId, calendar.id, {
      from: Date.parse('2026-10-01T00:00:00Z'),
      to: Date.parse('2026-10-15T00:00:00Z'),
    });
    expect(occurrences.map((entry) => entry.startAt)).toEqual([
      Date.parse('2026-10-05T09:00:00Z'),
      Date.parse('2026-10-06T09:00:00Z'),
      Date.parse('2026-10-07T09:00:00Z'),
    ]);
  });

  it('a moved occurrence keeps its original identity', async () => {
    const { owner, calendar } = await setup();
    const event = await weeklyEvent(owner, calendar.id);
    const movedTo = WEEKLY_START + 86_400_000;
    await updateEvent(db, owner.userId, event.id, 'this', {
      revision: 1,
      occurrenceStart: WEEKLY_START,
      patch: { startAt: movedTo, endAt: movedTo + 3_600_000 },
    });
    const occurrences = await listEvents(db, owner.userId, calendar.id, {
      from: Date.parse('2026-10-01T00:00:00Z'),
      to: Date.parse('2026-11-01T00:00:00Z'),
    });
    const moved = occurrences.find((entry) => entry.originalOccurrenceStart === WEEKLY_START)!;
    expect(moved).toBeDefined();
    expect(moved.startAt).toBe(movedTo);
    expect(moved.moved).toBe(true);
  });

  it('rule 7: a non-member read and a missing id are the same StoreNotFoundError', async () => {
    const { owner, calendar } = await setup();
    const outsider = await addAccount(pg);
    const event = await createEvent(db, owner.userId, calendar.id, {
      title: 'Secret',
      allDay: false,
      startAt: WEEKLY_START,
      endAt: WEEKLY_END,
      zone: 'UTC',
    });
    const hidden = await getEvent(db, outsider.userId, event.id).catch((error: unknown) => error);
    const missing = await getEvent(db, outsider.userId, randomUUID()).catch((error: unknown) => error);
    expect(hidden).toBeInstanceOf(StoreNotFoundError);
    expect(missing).toBeInstanceOf(StoreNotFoundError);
    expect((hidden as Error).message).toBe((missing as Error).message);
  });

  it('removeAttendee is organizer-only and removes the row', async () => {
    const { owner, member, calendar } = await setup();
    const event = await createEvent(db, owner.userId, calendar.id, {
      title: 'Dinner',
      allDay: false,
      startAt: WEEKLY_START,
      endAt: WEEKLY_END,
      zone: 'UTC',
    });
    await addAttendee(db, owner.userId, event.id, { userId: member.userId });
    await expect(
      removeAttendee(db, member.userId, event.id, member.userId),
    ).rejects.toThrow(/organizer/);
    await removeAttendee(db, owner.userId, event.id, member.userId);
    expect(await listAttendees(db, owner.userId, event.id)).toHaveLength(0);
  });

  it('only the organizer may edit or cancel a native event', async () => {
    const { owner, member, calendar } = await setup();
    const event = await createEvent(db, owner.userId, calendar.id, {
      title: 'Dinner',
      allDay: false,
      startAt: WEEKLY_START,
      endAt: WEEKLY_END,
      zone: 'UTC',
    });
    await expect(
      updateEvent(db, member.userId, event.id, 'series', { revision: 1, patch: { title: 'Hijacked' } }),
    ).rejects.toThrow(CalendarForbiddenError);
    await expect(
      cancelEvent(db, member.userId, event.id, 'series', {}),
    ).rejects.toThrow(CalendarForbiddenError);
    const unchanged = await getEvent(db, owner.userId, event.id);
    expect(unchanged).toMatchObject({ title: 'Dinner', status: 'confirmed', revision: 1 });

    // The organizer still can.
    const updated = await updateEvent(db, owner.userId, event.id, 'series', {
      revision: 1,
      patch: { title: 'Dinner v2' },
    });
    expect(updated.title).toBe('Dinner v2');
  });

  it('#873: a group owner or admin may delete any event in the space; editing stays organizer-only', async () => {
    const owner = await addAccount(pg);
    const admin = await addAccount(pg);
    const organizer = await addAccount(pg);
    const plainMember = await addAccount(pg);
    const outsider = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    await addMember(db, owner.userId, space.id, admin.userId, 'admin');
    await addMember(db, owner.userId, space.id, organizer.userId, 'member');
    await addMember(db, owner.userId, space.id, plainMember.userId, 'member');
    const calendar = await createCalendar(db, owner.userId, space.id, { name: 'Home', zone: 'UTC' });
    const timed = { allDay: false, startAt: WEEKLY_START, endAt: WEEKLY_END, zone: 'UTC' } as const;
    const first = await createEvent(db, organizer.userId, calendar.id, { title: 'Swim', ...timed });
    const second = await createEvent(db, organizer.userId, calendar.id, { title: 'Piano', ...timed });
    const window = { from: WEEKLY_START - 86_400_000, to: WEEKLY_END + 86_400_000 };
    const flags = async (userId: string) => {
      const item = (await listAgenda(db, userId, window)).find((entry) => entry.eventId === first.id);
      return { canEdit: item?.canEdit, canDelete: item?.canDelete };
    };

    expect(await flags(owner.userId)).toEqual({ canEdit: false, canDelete: true });
    expect(await flags(admin.userId)).toEqual({ canEdit: false, canDelete: true });
    expect(await flags(organizer.userId)).toEqual({ canEdit: true, canDelete: true });
    expect(await flags(plainMember.userId)).toEqual({ canEdit: false, canDelete: false });

    // A plain member still may not delete someone else's event, and a
    // non-member cannot even see it.
    await expect(cancelEvent(db, plainMember.userId, first.id, 'series', {})).rejects.toThrow(
      CalendarForbiddenError,
    );
    await expect(cancelEvent(db, outsider.userId, first.id, 'series', {})).rejects.toThrow(StoreNotFoundError);
    // Moderation confers no edit authority while the organizer is active.
    await expect(
      updateEvent(db, owner.userId, first.id, 'series', { revision: 1, patch: { title: 'Hijacked' } }),
    ).rejects.toThrow(CalendarForbiddenError);

    expect((await cancelEvent(db, owner.userId, first.id, 'series', {})).status).toBe('cancelled');
    expect((await cancelEvent(db, admin.userId, second.id, 'series', {})).status).toBe('cancelled');
  });

  it('#873: group moderation confers no right over an external (google) calendar event', async () => {
    const { owner, member, calendar } = await setup();
    const event = await createEvent(db, member.userId, calendar.id, {
      title: 'Synced',
      allDay: false,
      startAt: WEEKLY_START,
      endAt: WEEKLY_END,
      zone: 'UTC',
    });
    await withUserRaw(pg, owner.userId, async (tx) => {
      await tx.query(`UPDATE bob.calendars SET origin = 'google' WHERE id = $1`, [calendar.id]);
    });
    const agenda = await listAgenda(db, owner.userId, {
      from: WEEKLY_START - 86_400_000,
      to: WEEKLY_END + 86_400_000,
    });
    expect(agenda.find((entry) => entry.eventId === event.id)?.canDelete).toBe(false);
    await expect(cancelEvent(db, owner.userId, event.id, 'series', {})).rejects.toThrow(CalendarForbiddenError);
  });

  it('#873: only a group owner or admin moderates events; pair peers (both seeded owner) do not', () => {
    expect(isEventModerator('group', 'owner')).toBe(true);
    expect(isEventModerator('group', 'admin')).toBe(true);
    expect(isEventModerator('group', 'member')).toBe(false);
    expect(isEventModerator('pair', 'owner')).toBe(false);
    expect(isEventModerator('private', 'owner')).toBe(false);
    expect(isEventModerator('group', undefined)).toBe(false);
  });

  it('listAgenda merges occurrences across the caller calendars with their origin', async () => {
    const { owner, calendar } = await setup();
    await weeklyEvent(owner, calendar.id);
    const items = await listAgenda(db, owner.userId, {
      from: Date.parse('2026-10-01T00:00:00Z'),
      to: Date.parse('2026-11-01T00:00:00Z'),
    });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({ calendarId: calendar.id, origin: 'native' });
  });

  it('CU-REVIEW-9a: once the organizer leaves the space, its active owner may manage the event; a plain member never can', async () => {
    const owner = await addAccount(pg);
    const organizer = await addAccount(pg);
    const plainMember = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    await addMember(db, owner.userId, space.id, organizer.userId, 'member');
    await addMember(db, owner.userId, space.id, plainMember.userId, 'member');
    const calendar = await createCalendar(db, owner.userId, space.id, { name: 'Home', zone: 'UTC' });
    const event = await createEvent(db, organizer.userId, calendar.id, {
      title: 'Standup',
      allDay: false,
      startAt: WEEKLY_START,
      endAt: WEEKLY_END,
      zone: 'UTC',
    });
    const window = { from: WEEKLY_START - 86_400_000, to: WEEKLY_END + 86_400_000 };

    // While the organizer is still an active member, group moderation confers
    // no edit authority over their event: neither the owner nor a plain member
    // may change it (#873 lets the owner delete it; covered above).
    await expect(
      updateEvent(db, owner.userId, event.id, 'series', { revision: 1, patch: { title: 'Hijacked' } }),
    ).rejects.toThrow(CalendarForbiddenError);
    await expect(
      updateEvent(db, plainMember.userId, event.id, 'series', { revision: 1, patch: { title: 'Hijacked' } }),
    ).rejects.toThrow(CalendarForbiddenError);
    await expect(cancelEvent(db, plainMember.userId, event.id, 'series', {})).rejects.toThrow(
      CalendarForbiddenError,
    );
    const beforeAgenda = await listAgenda(db, owner.userId, window);
    expect(beforeAgenda.find((item) => item.eventId === event.id)?.canEdit).toBe(false);

    // Once the organizer is no longer an active member of the space, its
    // active owner may change the event; a plain member still may not.
    await revokeMember(db, owner.userId, space.id, organizer.userId);
    const updated = await updateEvent(db, owner.userId, event.id, 'series', {
      revision: 1,
      patch: { title: 'Owner takes over' },
    });
    expect(updated.title).toBe('Owner takes over');
    await addAttendee(db, owner.userId, event.id, { userId: plainMember.userId });
    await removeAttendee(db, owner.userId, event.id, plainMember.userId);
    await expect(
      updateEvent(db, plainMember.userId, event.id, 'series', {
        revision: updated.revision,
        patch: { title: 'Hijacked again' },
      }),
    ).rejects.toThrow(CalendarForbiddenError);
    const afterAgendaOwner = await listAgenda(db, owner.userId, window);
    expect(afterAgendaOwner.find((item) => item.eventId === event.id)?.canEdit).toBe(true);
    const afterAgendaMember = await listAgenda(db, plainMember.userId, window);
    expect(afterAgendaMember.find((item) => item.eventId === event.id)?.canEdit).toBe(false);

    // The owner can still cancel it -- last, since a cancelled event drops
    // out of the agenda window.
    const cancelled = await cancelEvent(db, owner.userId, event.id, 'series', {});
    expect(cancelled.status).toBe('cancelled');
  });

  it('listAgenda skips an archived space and includes it again after restore', async () => {
    const { owner, calendar, space } = await setup();
    await weeklyEvent(owner, calendar.id);
    const window = {
      from: Date.parse('2026-10-01T00:00:00Z'),
      to: Date.parse('2026-11-01T00:00:00Z'),
    };
    const inAgenda = async (): Promise<boolean> =>
      (await listAgenda(db, owner.userId, window)).some((item) => item.calendarId === calendar.id);

    expect(await inAgenda()).toBe(true);

    await archiveSpace(db, owner.userId, space.id);
    expect(await inAgenda()).toBe(false);

    await restoreSpace(db, owner.userId, space.id);
    expect(await inAgenda()).toBe(true);
  });
});