// Calendar notification producers (API-TIME). A real HTTP server over the test
// db with the real store: adding an attendee invites them, a PATCH that changes
// time/place/title updates every other attendee, an RSVP tells the organizer,
// the actor is never notified, and a cancel emails attendees directly
// (email-client mocked).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import { createCalendar } from '../../src/calendar/store.ts';
import { listNotifications, type StoredNotification } from '../../src/notifications/store.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createCalendarsRouter } from '../../src/calendar/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

const sendTemplateEmail = vi.fn(async (_input: { template: string; to: string; data: Record<string, unknown> }): Promise<void> => undefined);
vi.mock('../../src/notifications/email-client.ts', () => ({
  sendTemplateEmail: (input: { template: string; to: string; data: Record<string, unknown> }) => sendTemplateEmail(input),
  recipientEmail: async (_db: Db, userId: string): Promise<string> => `${userId}@example.com`,
}));

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
let organizer: TestAccount;
let alice: TestAccount;
let bob: TestAccount;
let calendarId: string;
const tokens = new Map<string, string>();

async function send(method: string, path: string, who: TestAccount, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokens.get(who.userId)!}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function eventRows(who: TestAccount, eventId: string): Promise<StoredNotification[]> {
  const all = await listNotifications(db, who.userId, { limit: 100 });
  return all.filter((n) => n.resourceId === eventId);
}

async function newEvent(): Promise<{ id: string; revision: number }> {
  const start = Date.now() + 86_400_000;
  const created = await send('POST', `/api/calendars/${calendarId}/events`, organizer, {
    title: 'Dinner', zone: 'UTC', start_at: start, end_at: start + 3_600_000,
    attendees: [{ user_id: alice.userId }],
  });
  expect(created.status).toBe(201);
  return (await created.json()) as { id: string; revision: number };
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  [organizer, alice, bob] = [await addAccount(pg), await addAccount(pg), await addAccount(pg)];
  for (const who of [organizer, alice, bob]) {
    tokens.set(who.userId, await signToken({ userId: who.userId, sessionId: who.sessionId }));
  }
  const space = await createSpace(db, organizer.userId, { kind: 'group', name: 'Family' });
  await addMember(db, organizer.userId, space.id, alice.userId, 'member');
  await addMember(db, organizer.userId, space.id, bob.userId, 'member');
  calendarId = (await createCalendar(db, organizer.userId, space.id, { name: 'Home', zone: 'UTC' })).id;

  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api', createCalendarsRouter({ getDb: () => Promise.resolve(db) }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.close();
  await closeTestDb(pg).catch(() => undefined);
});

beforeEach(() => {
  sendTemplateEmail.mockClear();
});

describe('calendar event notifications', () => {
  it('creating with attendees and adding one invites them, never the organizer', async () => {
    const event = await newEvent();
    const added = await send('POST', `/api/events/${event.id}/attendees`, organizer, { user_id: bob.userId });
    expect(added.status).toBe(201);

    for (const who of [alice, bob]) {
      const rows = await eventRows(who, event.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'event_change', resourceType: 'event',
        effectKey: `event_invited:${event.id}:${who.userId}` });
    }
    expect(await eventRows(organizer, event.id)).toHaveLength(0);
  });

  it('a PATCH changing the title updates attendees; a body-only PATCH does not', async () => {
    const event = await newEvent();
    const titled = await send('PATCH', `/api/events/${event.id}`, organizer, {
      revision: event.revision, scope: 'series', patch: { title: 'Late dinner' },
    });
    expect(titled.status).toBe(200);
    const after = (await titled.json()) as { revision: number };

    const updates = (await eventRows(alice, event.id)).filter((n) => n.effectKey.startsWith('event_updated:'));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.effectKey).toBe(`event_updated:${event.id}:${after.revision}`);
    expect(await eventRows(organizer, event.id)).toHaveLength(0);

    const bodyOnly = await send('PATCH', `/api/events/${event.id}`, organizer, {
      revision: after.revision, scope: 'series', patch: { body: 'bring dessert' },
    });
    expect(bodyOnly.status).toBe(200);
    expect((await eventRows(alice, event.id)).filter((n) => n.effectKey.startsWith('event_updated:')))
      .toHaveLength(1);
  });

  it('an RSVP tells the organizer only', async () => {
    const event = await newEvent();
    const rsvp = await send('PUT', `/api/events/${event.id}/rsvp`, alice, { response: 'accepted' });
    expect(rsvp.status).toBe(200);

    const rows = await eventRows(organizer, event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.effectKey).toBe(`event_rsvp:${event.id}:${alice.userId}:accepted`);
    expect((await eventRows(alice, event.id)).filter((n) => n.effectKey.startsWith('event_rsvp:')))
      .toHaveLength(0);
  });

  it('a cancel emails event-cancelled to attendees but not the actor', async () => {
    const event = await newEvent();
    const cancelled = await send('DELETE', `/api/events/${event.id}`, organizer, { scope: 'series' });
    expect(cancelled.status).toBe(200);

    expect(sendTemplateEmail).toHaveBeenCalledTimes(1);
    expect(sendTemplateEmail.mock.calls[0]![0]).toMatchObject({
      template: 'event-cancelled', to: `${alice.userId}@example.com`,
      data: { eventTitle: 'Dinner', spaceName: 'Family' },
    });
  });

  it('a failing cancel email never fails the cancel', async () => {
    const event = await newEvent();
    sendTemplateEmail.mockRejectedValueOnce(new Error('send_failed'));
    const cancelled = await send('DELETE', `/api/events/${event.id}`, organizer, { scope: 'series' });
    expect(cancelled.status).toBe(200);
  });
});
