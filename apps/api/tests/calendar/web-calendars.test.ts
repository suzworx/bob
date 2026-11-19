// Calendars API tests (spec 014, S14-T006; contracts/api.md "Calendars"). A
// real HTTP server over real Postgres exercises the JWT guard and the
// /api/calendars*, /api/events*, /api/agenda router. Includes the missing-scope
// -> 400 rule and one failure-injection test per state-changing route.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import { StoreError, type Db } from '../../src/platform/db/db.ts';
import { listNotifications } from '../../src/notifications/store.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createCalendar, createEvent } from '../../src/calendar/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createCalendarsRouter } from '../../src/calendar/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

const WEEKLY_START = Date.parse('2026-10-05T09:00:00Z');
const WEEKLY_END = Date.parse('2026-10-05T10:00:00Z');

describe('calendars API (contracts/api.md "Calendars")', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server;
  let baseUrl: string;
  const journalLines: string[] = [];

  beforeAll(async () => {
    setJournalSink((line: string) => journalLines.push(line));
    pg = await createTestDb();
    db = asDb(pg);
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api', createCalendarsRouter({ getDb: () => Promise.resolve(db) }));
    app.use('/google-api', createCalendarsRouter({ getDb: () => Promise.resolve(db), projectGoogleAgenda: async () => { throw new Error('provider offline'); } }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    setJournalSink(null);
    server.close();
    await closeTestDb(pg);
  });

  async function tokenFor(account: TestAccount): Promise<string> {
    return signToken({ userId: account.userId, sessionId: account.sessionId });
  }

  async function get(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  async function send(method: string, path: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** A group space with an owner, a member, and a native calendar. */
  async function setup() {
    const owner = await addAccount(pg);
    const member = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    await addMember(db, owner.userId, space.id, member.userId, 'member');
    const calendar = await createCalendar(db, owner.userId, space.id, {
      name: 'Home',
      zone: 'UTC',
    });
    return {
      owner,
      member,
      space,
      calendar,
      ownerToken: await tokenFor(owner),
      memberToken: await tokenFor(member),
    };
  }

  it('POST /spaces/:id/calendars creates a native calendar; GET lists it', async () => {
    const { owner, space, ownerToken } = await setup();
    const created = await send('POST', `/api/spaces/${space.id}/calendars`, ownerToken, {
      name: 'Work',
      zone: 'America/Toronto',
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; name: string; origin: string; space_id: string };
    expect(body).toMatchObject({ name: 'Work', origin: 'native', space_id: space.id });

    const listed = await get(`/api/spaces/${space.id}/calendars`, ownerToken);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { calendars: Array<{ name: string }> };
    expect(listedBody.calendars.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['Home', 'Work']),
    );
  });
  it('keeps native agenda items visible when the Google projection fails', async () => {
    const { calendar, ownerToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Native dinner', all_day: false, start_at: WEEKLY_START, end_at: WEEKLY_END, zone: 'UTC',
    });
    expect(created.status).toBe(201);
    const result = await get(`/google-api/agenda?from=${WEEKLY_START - 1}&to=${WEEKLY_END + 1}`, ownerToken);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toMatchObject({ items: [expect.objectContaining({ title: 'Native dinner' })], remote_items: [], sources: [], remote_unavailable: true });
  });

  it('POST /spaces/:id/calendars trims the name and 400s on an empty one', async () => {
    const { space, ownerToken } = await setup();
    const trimmed = await send('POST', `/api/spaces/${space.id}/calendars`, ownerToken, {
      name: '  Kitchen  ',
      zone: 'UTC',
    });
    expect(trimmed.status).toBe(201);
    expect((await trimmed.json()) as { name: string }).toMatchObject({ name: 'Kitchen' });
    const empty = await send('POST', `/api/spaces/${space.id}/calendars`, ownerToken, { name: '   ', zone: 'UTC' });
    expect(empty.status).toBe(400);
  });

  it('POST /calendars/:id/events and GET /calendars/:id/events expand occurrences', async () => {
    const { owner, calendar, ownerToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Standup',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
      rrule: { freq: 'weekly' },
    });
    expect(created.status).toBe(201);
    const event = (await created.json()) as { id: string; sequence: number; uid: string };
    expect(event.sequence).toBe(0);
    expect(event.uid).toBeTypeOf('string');

    const listed = await get(
      `/api/calendars/${calendar.id}/events?from=${Date.parse('2026-10-01T00:00:00Z')}&to=${Date.parse('2026-11-01T00:00:00Z')}`,
      ownerToken,
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { events: Array<{ event_id: string }> };
    expect(body.events).toHaveLength(4);
    expect(body.events.every((entry) => entry.event_id === event.id)).toBe(true);
  });

  it('GET /events/:id returns the event master; PATCH with an explicit scope works', async () => {
    const { owner, calendar, ownerToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Dinner',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string; revision: number };

    const fetched = await get(`/api/events/${event.id}`, ownerToken);
    expect(fetched.status).toBe(200);
    expect((await fetched.json()) as { title: string }).toMatchObject({ title: 'Dinner' });

    const patched = await send('PATCH', `/api/events/${event.id}`, ownerToken, {
      revision: event.revision,
      scope: 'series',
      patch: { title: 'Dinner v2' },
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()) as { title: string; sequence: number }).toMatchObject({
      title: 'Dinner v2',
      sequence: 1,
    });
  });

  it('PATCH /events/:id with a missing scope is a 400 invalid_request, never a default', async () => {
    const { owner, calendar, ownerToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Dinner',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string; revision: number };
    const noScope = await send('PATCH', `/api/events/${event.id}`, ownerToken, {
      revision: event.revision,
      patch: { title: 'No scope' },
    });
    expect(noScope.status).toBe(400);
    expect(await noScope.json()).toEqual({ error: { code: 'invalid_request' } });
  });

  it('PATCH /events/:id with a stale revision is a 409 conflict', async () => {
    const { owner, calendar, ownerToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Dinner',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string; revision: number };
    await send('PATCH', `/api/events/${event.id}`, ownerToken, {
      revision: event.revision,
      scope: 'series',
      patch: { title: 'v2' },
    });
    const stale = await send('PATCH', `/api/events/${event.id}`, ownerToken, {
      revision: event.revision,
      scope: 'series',
      patch: { title: 'stale' },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: { code: 'conflict' } });
  });

  it('DELETE /events/:id cancels the series; GET /events/:id still returns it', async () => {
    const { owner, calendar, ownerToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Doomed',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string };
    const deleted = await send('DELETE', `/api/events/${event.id}`, ownerToken, { scope: 'series' });
    expect(deleted.status).toBe(200);
    expect((await deleted.json()) as { status: string }).toMatchObject({ status: 'cancelled' });
    const stillThere = await get(`/api/events/${event.id}`, ownerToken);
    expect(stillThere.status).toBe(200);
  });

  it('#127: cancelling an event gives each of two attendees one event_change item, the actor none', async () => {
    const { owner, member, space, calendar, ownerToken } = await setup();
    const second = await addAccount(pg);
    await addMember(db, owner.userId, space.id, second.userId, 'member');
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Picnic',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
      attendees: [{ user_id: member.userId }, { user_id: second.userId }],
    });
    expect(created.status).toBe(201);
    const event = (await created.json()) as { id: string };
    const cancelled = async (userId: string) =>
      (await listNotifications(db, userId, { limit: 100 }))
        .filter((row) => row.resourceId === event.id && row.effectKey.startsWith('event_cancelled:'));

    const deleted = await send('DELETE', `/api/events/${event.id}`, ownerToken, { scope: 'series' });
    expect(deleted.status).toBe(200);
    for (const attendee of [member, second]) {
      const rows = await cancelled(attendee.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'event_change', resourceType: 'event', spaceId: space.id });
    }
    expect(await cancelled(owner.userId)).toHaveLength(0);
  });

  it('POST/GET/DELETE /events/:id/attendees and PUT /events/:id/rsvp', async () => {
    const { owner, member, calendar, ownerToken, memberToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Dinner',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string };

    const added = await send('POST', `/api/events/${event.id}/attendees`, ownerToken, {
      user_id: member.userId,
      role: 'required',
    });
    expect(added.status).toBe(201);
    expect((await added.json()) as { response: string }).toMatchObject({ response: 'needs_action' });

    const listed = await get(`/api/events/${event.id}/attendees`, ownerToken);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { attendees: Array<{ user_id: string }> };
    expect(body.attendees.map((entry) => entry.user_id)).toContain(member.userId);

    // The attendee sets only their own response.
    const rsvp = await send('PUT', `/api/events/${event.id}/rsvp`, memberToken, { response: 'accepted' });
    expect(rsvp.status).toBe(200);
    expect((await rsvp.json()) as { response: string }).toMatchObject({ response: 'accepted' });

    const removed = await send('DELETE', `/api/events/${event.id}/attendees?user_id=${member.userId}`, ownerToken, undefined);
    expect(removed.status).toBe(204);
    const empty = await get(`/api/events/${event.id}/attendees`, ownerToken);
    expect(((await empty.json()) as { attendees: unknown[] }).attendees).toHaveLength(0);
  });

  it('GET /agenda returns occurrences across the caller calendars, labelled with origin', async () => {
    const { owner, calendar, ownerToken } = await setup();
    await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Standup',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const res = await get(
      `/api/agenda?from=${Date.parse('2026-10-01T00:00:00Z')}&to=${Date.parse('2026-11-01T00:00:00Z')}`,
      ownerToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ calendar_id: string; origin: string }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toMatchObject({ calendar_id: calendar.id, origin: 'native' });
  });

  it('GET /agenda?space_id= lists only that space, and carries no Google rows', async () => {
    const { owner, calendar, space, ownerToken } = await setup();
    const other = await createSpace(db, owner.userId, { kind: 'group', name: 'Book club' });
    const otherCalendar = await createCalendar(db, owner.userId, other.id, { name: 'Club', zone: 'UTC' });
    for (const [cal, title] of [[calendar.id, 'Family dinner'], [otherCalendar.id, 'Club night']] as const) {
      await send('POST', `/api/calendars/${cal}/events`, ownerToken, {
        title, all_day: false, start_at: WEEKLY_START, end_at: WEEKLY_END, zone: 'UTC',
      });
    }
    const window = `from=${WEEKLY_START - 1}&to=${WEEKLY_END + 1}`;
    const all = (await (await get(`/api/agenda?${window}`, ownerToken)).json()) as { items: Array<{ title: string }> };
    expect(all.items.map((item) => item.title).sort()).toEqual(['Club night', 'Family dinner']);

    const scoped = await get(`/google-api/agenda?${window}&space_id=${space.id}`, ownerToken);
    expect(scoped.status).toBe(200);
    const body = (await scoped.json()) as { items: Array<{ title: string; calendar_id: string }>; remote_items?: unknown };
    expect(body.items.map((item) => item.title)).toEqual(['Family dinner']);
    expect(body.remote_items).toBeUndefined();

    expect((await get(`/api/agenda?${window}&space_id=not-a-uuid`, ownerToken)).status).toBe(400);
  });

  it('a non-member gets the same not_found for a hidden event and a missing id', async () => {
    const { owner, calendar, ownerToken } = await setup();
    const outsider = await addAccount(pg);
    const outsiderToken = await tokenFor(outsider);
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Secret',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string };

    const hidden = await get(`/api/events/${event.id}`, outsiderToken);
    const missing = await get(`/api/events/${randomUUID()}`, outsiderToken);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const missingText = await missing.text();
    expect(JSON.parse(missingText)).toEqual({ error: { code: 'not_found', message: 'event not found' } });
    expect(await hidden.text()).toBe(missingText);
  });

  it('every state-changing route answers 500 store_error on a store outage', async () => {
    const account = await addAccount(pg);
    const token = await tokenFor(account);
    const boom = new StoreError('store down');
    const stubDb = {
      query: async (): Promise<never> => {
        throw boom;
      },
      tx: async <T>(): Promise<T> => {
        throw boom;
      },
    } as unknown as Db;

    const stubApp = express();
    stubApp.use(express.json());
    stubApp.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    stubApp.use('/api', createCalendarsRouter({ getDb: () => Promise.resolve(stubDb) }));
    const stubServer = await new Promise<Server>((resolve) => {
      const s = stubApp.listen(0, () => resolve(s));
    });
    const stubBase = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`;
    try {
      const spaceId = randomUUID();
      const calendarId = randomUUID();
      const eventId = randomUUID();
      const routes: Array<[string, string, unknown]> = [
        ['POST', `/api/spaces/${spaceId}/calendars`, { name: 'X', zone: 'UTC' }],
        ['POST', `/api/calendars/${calendarId}/events`, { title: 'X', all_day: false, start_at: WEEKLY_START, end_at: WEEKLY_END, zone: 'UTC' }],
        ['PATCH', `/api/events/${eventId}`, { revision: 1, scope: 'series', patch: { title: 'X' } }],
        ['DELETE', `/api/events/${eventId}`, { scope: 'series' }],
        ['POST', `/api/events/${eventId}/attendees`, { user_id: account.userId }],
        ['DELETE', `/api/events/${eventId}/attendees?user_id=${account.userId}`, undefined],
        ['PUT', `/api/events/${eventId}/rsvp`, { response: 'accepted' }],
      ];
      for (const [method, path, body] of routes) {
        const res = await fetch(`${stubBase}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: { code: 'store_error' } });
      }
    } finally {
      await new Promise<void>((resolve) => stubServer.close(() => resolve()));
    }
  });

  it('bad timing on create/update is 400 invalid_request', async () => {
    const { calendar, ownerToken } = await setup();
    const badCreate = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Backwards',
      all_day: false,
      start_at: WEEKLY_END,
      end_at: WEEKLY_START,
      zone: 'UTC',
    });
    expect(badCreate.status).toBe(400);
    expect(await badCreate.json()).toEqual({ error: { code: 'invalid_request' } });

    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Dinner',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string; revision: number };
    const badPatch = await send('PATCH', `/api/events/${event.id}`, ownerToken, {
      revision: event.revision,
      scope: 'series',
      patch: { end_at: WEEKLY_START },
    });
    expect(badPatch.status).toBe(400);
    expect(await badPatch.json()).toEqual({ error: { code: 'invalid_request' } });
  });

  it('PATCH with scope this_and_following is refused (400) and writes nothing', async () => {
    const { calendar, ownerToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Weekly Sync',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
      rrule: { freq: 'weekly' },
    });
    const event = (await created.json()) as { id: string; revision: number };
    const patched = await send('PATCH', `/api/events/${event.id}`, ownerToken, {
      revision: event.revision,
      scope: 'this_and_following',
      occurrence_start: WEEKLY_START,
      patch: { title: 'Renamed' },
    });
    expect(patched.status).toBe(400);
    expect(await patched.json()).toEqual({ error: { code: 'invalid_request' } });

    const listed = await get(
      `/api/calendars/${calendar.id}/events?from=${WEEKLY_START}&to=${WEEKLY_START + 4 * 7 * 86_400_000}`,
      ownerToken,
    );
    const body = (await listed.json()) as { events: Array<{ title: string }> };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((entry) => entry.title === 'Weekly Sync')).toBe(true);
  });

  it('a non-member attendee is 400 invalid_request, on add and on create, and nothing is written', async () => {
    const { calendar, ownerToken } = await setup();
    const outsider = await addAccount(pg);
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Team Sync',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string };
    const added = await send('POST', `/api/events/${event.id}/attendees`, ownerToken, {
      user_id: outsider.userId,
    });
    expect(added.status).toBe(400);
    expect(await added.json()).toEqual({ error: { code: 'invalid_request' } });

    const badCreate = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Outsider Invited',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
      attendees: [{ user_id: outsider.userId }],
    });
    expect(badCreate.status).toBe(400);

    const listed = await get(
      `/api/calendars/${calendar.id}/events?from=${WEEKLY_START - 86_400_000}&to=${WEEKLY_END + 86_400_000}`,
      ownerToken,
    );
    const body = (await listed.json()) as { events: Array<{ title: string }> };
    expect(body.events.some((entry) => entry.title === 'Outsider Invited')).toBe(false);
  });

  it('role refusals are 403 forbidden: add/remove attendee needs the organizer, rsvp needs an attendee', async () => {
    const { member, calendar, ownerToken, memberToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Dinner',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string };

    const addedByMember = await send('POST', `/api/events/${event.id}/attendees`, memberToken, {
      user_id: member.userId,
    });
    expect(addedByMember.status).toBe(403);
    expect(await addedByMember.json()).toEqual({ error: { code: 'forbidden' } });

    const removedByMember = await send(
      'DELETE',
      `/api/events/${event.id}/attendees?user_id=${member.userId}`,
      memberToken,
      undefined,
    );
    expect(removedByMember.status).toBe(403);
    expect(await removedByMember.json()).toEqual({ error: { code: 'forbidden' } });

    const ownerRsvp = await send('PUT', `/api/events/${event.id}/rsvp`, ownerToken, { response: 'accepted' });
    expect(ownerRsvp.status).toBe(403);
    expect(await ownerRsvp.json()).toEqual({ error: { code: 'forbidden' } });
  });

  it('PATCH and DELETE /events/:id by a non-organizer member are 403 forbidden', async () => {
    const { calendar, ownerToken, memberToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Dinner',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string; revision: number };

    const patched = await send('PATCH', `/api/events/${event.id}`, memberToken, {
      revision: event.revision,
      scope: 'series',
      patch: { title: 'Hijacked' },
    });
    expect(patched.status).toBe(403);
    expect(await patched.json()).toEqual({ error: { code: 'forbidden' } });

    const deleted = await send('DELETE', `/api/events/${event.id}`, memberToken, { scope: 'series' });
    expect(deleted.status).toBe(403);
    expect(await deleted.json()).toEqual({ error: { code: 'forbidden' } });
  });

  it('GET /agenda marks can_edit true for the caller own native event and false for another member', async () => {
    const { owner, member, calendar, ownerToken, memberToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Standup',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string };
    const from = WEEKLY_START - 86_400_000;
    const to = WEEKLY_END + 86_400_000;
    type Row = { event_id: string; can_edit: boolean };

    const ownerAgenda = await get(`/api/agenda?from=${from}&to=${to}`, ownerToken);
    const ownerBody = (await ownerAgenda.json()) as { items: Row[] };
    expect(ownerBody.items.find((entry) => entry.event_id === event.id)?.can_edit).toBe(true);

    const memberAgenda = await get(`/api/agenda?from=${from}&to=${to}`, memberToken);
    const memberBody = (await memberAgenda.json()) as { items: Row[] };
    expect(memberBody.items.find((entry) => entry.event_id === event.id)?.can_edit).toBe(false);
  });

  it('#873: the group owner sees can_delete and may DELETE a member event; an outsider gets not_found', async () => {
    const { calendar, ownerToken, memberToken } = await setup();
    const outsiderToken = await tokenFor(await addAccount(pg));
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, memberToken, {
      title: 'Swim',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string };
    const from = WEEKLY_START - 86_400_000;
    const to = WEEKLY_END + 86_400_000;
    type Row = { event_id: string; can_edit: boolean; can_delete: boolean };

    const ownerAgenda = await get(`/api/agenda?from=${from}&to=${to}`, ownerToken);
    const ownerItem = ((await ownerAgenda.json()) as { items: Row[] }).items.find((entry) => entry.event_id === event.id);
    expect(ownerItem).toMatchObject({ can_edit: false, can_delete: true });

    const byOutsider = await send('DELETE', `/api/events/${event.id}`, outsiderToken, { scope: 'series' });
    expect(byOutsider.status).toBe(404);
    const byOwner = await send('DELETE', `/api/events/${event.id}`, ownerToken, { scope: 'series' });
    expect(byOwner.status).toBe(200);
    expect((await byOwner.json()) as { status: string }).toMatchObject({ status: 'cancelled' });
  });

  it('an outsider RSVP on a hidden event and on a missing id are identical (identity leakage)', async () => {
    const { calendar, ownerToken } = await setup();
    const outsider = await addAccount(pg);
    const outsiderToken = await tokenFor(outsider);
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Secret',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
    });
    const event = (await created.json()) as { id: string };

    const hidden = await send('PUT', `/api/events/${event.id}/rsvp`, outsiderToken, { response: 'accepted' });
    const missing = await send('PUT', `/api/events/${randomUUID()}/rsvp`, outsiderToken, { response: 'accepted' });
    expect(hidden.status).toBe(missing.status);
    expect(await hidden.text()).toBe(await missing.text());
  });

  it("my_response reflects the caller's own RSVP on agenda and calendar events", async () => {
    const { member, calendar, ownerToken, memberToken } = await setup();
    const created = await send('POST', `/api/calendars/${calendar.id}/events`, ownerToken, {
      title: 'Standup',
      all_day: false,
      start_at: WEEKLY_START,
      end_at: WEEKLY_END,
      zone: 'UTC',
      attendees: [{ user_id: member.userId }],
    });
    const event = (await created.json()) as { id: string };
    const from = WEEKLY_START - 86_400_000;
    const to = WEEKLY_END + 86_400_000;
    type Row = { event_id: string; my_response: string | null };

    const memberBefore = await get(`/api/agenda?from=${from}&to=${to}`, memberToken);
    const memberBeforeBody = (await memberBefore.json()) as { items: Row[] };
    expect(memberBeforeBody.items.find((entry) => entry.event_id === event.id)?.my_response).toBe('needs_action');

    const rsvp = await send('PUT', `/api/events/${event.id}/rsvp`, memberToken, { response: 'accepted' });
    expect(rsvp.status).toBe(200);

    const memberAfter = await get(`/api/agenda?from=${from}&to=${to}`, memberToken);
    const memberAfterBody = (await memberAfter.json()) as { items: Row[] };
    expect(memberAfterBody.items.find((entry) => entry.event_id === event.id)?.my_response).toBe('accepted');

    const memberEvents = await get(`/api/calendars/${calendar.id}/events?from=${from}&to=${to}`, memberToken);
    const memberEventsBody = (await memberEvents.json()) as { events: Row[] };
    expect(memberEventsBody.events.find((entry) => entry.event_id === event.id)?.my_response).toBe('accepted');

    const ownerAgenda = await get(`/api/agenda?from=${from}&to=${to}`, ownerToken);
    const ownerBody = (await ownerAgenda.json()) as { items: Row[] };
    expect(ownerBody.items.find((entry) => entry.event_id === event.id)?.my_response).toBeNull();
  });
});
