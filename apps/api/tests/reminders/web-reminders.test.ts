// web-reminders.ts route tests (REM-CAL). A real HTTP server over Postgres with
// the real store, so membership is decided by genuine RLS, and a non-member is
// compared against what the tasks list answers for the same request.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createReminderFanout } from '../../src/workflows/workflow-reminder-fire.ts';
import { type Db } from '../../src/platform/db/db.ts';
import { listNotifications } from '../../src/notifications/store.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { cancelReminder, createReminder } from '../../src/reminders/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createRemindersRouter, ReminderRuleSchema } from '../../src/reminders/http.ts';
import { RecurrenceRuleSchema } from '../../src/web-schemas.ts';
import { createTasksRouter } from '../../src/tasks/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
  withUserRaw,
} from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;

async function get(path: string, tok: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${tok}` } });
}

async function tokenFor(account: TestAccount): Promise<string> {
  return signToken({ userId: account.userId, sessionId: account.sessionId });
}

async function send(method: string, path: string, tok: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type ReminderBody = { reminder: { id: string; space_id: string; status: string; schedule_revision: number } };

type ListBody ={ reminders: Array<{ id: string; title: string; status: string; due_at: number; due_zone: string; rrule: unknown }> };

describe('reminders HTTP API', () => {
  let owner: TestAccount;
  let outsider: TestAccount;
  let ownerToken: string;
  let outsiderToken: string;
  let spaceId: string;
  let otherSpaceId: string;
  let emptySpaceId: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    owner = await addAccount(pg);
    outsider = await addAccount(pg);
    ownerToken = await tokenFor(owner);
    outsiderToken = await tokenFor(outsider);

    spaceId = (await createSpace(db, owner.userId, { kind: 'group', name: 'Family' })).id;
    otherSpaceId = (await createSpace(db, owner.userId, { kind: 'group', name: 'Work' })).id;
    emptySpaceId = (await createSpace(db, owner.userId, { kind: 'group', name: 'Empty' })).id;

    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api', createTasksRouter({ getDb: () => Promise.resolve(db) }));
    app.use('/api', createRemindersRouter({ getDb: () => Promise.resolve(db) }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  it('previews the next three rings in the reminder zone (#126)', async () => {
    type Preview = { occurrences: Array<{ at: number; wall_time: string }> };
    const due = Date.UTC(2026, 9, 24, 7, 0);
    const rule = encodeURIComponent(JSON.stringify({ freq: 'daily' }));
    const res = await get(`/api/reminders/preview?due=${due}&zone=Europe/London&rrule=${rule}`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Preview;
    expect(body.occurrences).toEqual([
      { at: Date.UTC(2026, 9, 24, 7, 0), wall_time: '2026-10-24T08:00' },
      { at: Date.UTC(2026, 9, 25, 8, 0), wall_time: '2026-10-25T08:00' },
      { at: Date.UTC(2026, 9, 26, 8, 0), wall_time: '2026-10-26T08:00' },
    ]);
    const monthly = encodeURIComponent(JSON.stringify({ freq: 'monthly' }));
    const from = Date.UTC(2026, 8, 1);
    const month = await get(`/api/reminders/preview?due=${Date.UTC(2026, 7, 31, 7, 0)}&zone=Europe/London&rrule=${monthly}&from=${from}`, ownerToken);
    expect(((await month.json()) as Preview).occurrences.map((o) => o.wall_time.slice(0, 10))).toEqual(['2026-10-31', '2026-12-31', '2027-01-31']);
    const once = (await (await get(`/api/reminders/preview?due=${due}&zone=Europe/London`, ownerToken)).json()) as Preview;
    expect(once.occurrences).toHaveLength(1);
    const badHourly = encodeURIComponent(JSON.stringify({ freq: 'hourly', window: { start: '22:00', end: '08:00' } }));
    expect((await get(`/api/reminders/preview?due=${due}&zone=Europe/London&rrule=${badHourly}`, ownerToken)).status).toBe(400);
    expect((await get(`/api/reminders/preview?due=${due}&zone=Nowhere/Land`, ownerToken)).status).toBe(400);
    expect((await get(`/api/reminders/preview?due=${due}&zone=UTC&rrule=nope`, ownerToken)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/reminders/preview?due=${due}&zone=UTC`)).status).toBe(401);
  });

  it('refuses a due or from centuries away, fast, and answers a far but sane from fast', async () => {
    const daily = encodeURIComponent(JSON.stringify({ freq: 'daily' }));
    const hourly = encodeURIComponent(JSON.stringify({ freq: 'hourly', count: 1_000_000_000 }));
    const now = Date.now();
    const hostile = [
      `due=1&zone=UTC&rrule=${daily}&from=8000000000000000`,
      `due=8000000000000000&zone=UTC&rrule=${daily}`,
      `due=${now}&zone=UTC&rrule=${daily}&from=${now + 51 * 366 * 86_400_000}`,
      `due=1&zone=UTC&rrule=${hourly}`,
    ];
    for (const query of hostile) {
      const started = performance.now();
      const res = await get(`/api/reminders/preview?${query}`, ownerToken);
      expect(performance.now() - started).toBeLessThan(200);
      expect(res.status).toBe(400);
    }
    const started = performance.now();
    const res = await get(`/api/reminders/preview?due=${now - 49 * 366 * 86_400_000}&zone=America/Toronto&rrule=${hourly}&from=${now + 49 * 366 * 86_400_000}`, ownerToken);
    expect(performance.now() - started).toBeLessThan(200);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { occurrences: unknown[] }).occurrences).toHaveLength(3);
  });

  it('lists only the reminders of the requested space, with what the calendar needs', async () => {
    const at = Date.UTC(2026, 8, 26, 3, 0);
    const lunch = await createReminder(db, owner.userId, spaceId, {
      title: 'have lunch',
      due: { kind: 'instant', at, zone: 'America/Los_Angeles' },
    });
    const daily = await createReminder(db, owner.userId, spaceId, {
      title: 'stretch',
      due: { kind: 'instant', at, zone: 'America/Los_Angeles' },
      rrule: { freq: 'daily' },
    });
    await cancelReminder(db, owner.userId, daily.id);
    await createReminder(db, owner.userId, otherSpaceId, {
      title: 'standup',
      due: { kind: 'instant', at, zone: 'UTC' },
    });

    // Pin both rows to one created_at: the list orders by it, and tied rows have no defined order.
    await withUserRaw(pg, owner.userId, (tx) => tx.query(
      'UPDATE bob.reminders SET created_at = $1 WHERE id IN ($2, $3)',
      [new Date(Date.UTC(2026, 8, 25, 12, 0)).toISOString(), lunch.id, daily.id]));

    const res = await get(`/api/spaces/${spaceId}/reminders`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.reminders).toHaveLength(2);
    expect(body.reminders.map((r) => r.title).sort()).toEqual(['have lunch', 'stretch']);
    const lunchRow = body.reminders.find((r) => r.id === lunch.id);
    const dailyRow = body.reminders.find((r) => r.id === daily.id);
    expect(lunchRow).toMatchObject({
      id: lunch.id,
      title: 'have lunch',
      due_at: at,
      due_zone: 'America/Los_Angeles',
      rrule: null,
      status: 'active',
    });
    expect(dailyRow).toMatchObject({ title: 'stretch', rrule: { freq: 'daily' }, status: 'cancelled' });
  });

  it('lists an hourly reminder with its interval and daily window (#456)', async () => {
    const hourlySpace = (await createSpace(db, owner.userId, { kind: 'group', name: 'Hourly' })).id;
    const rrule = { freq: 'hourly' as const, interval: 2, window: { start: '08:00', end: '22:00' } };
    await createReminder(db, owner.userId, hourlySpace, {
      title: 'have water',
      due: { kind: 'instant', at: Date.UTC(2026, 8, 26, 2, 30), zone: 'Asia/Kolkata' },
      rrule,
    });
    const res = await get(`/api/spaces/${hourlySpace}/reminders`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.reminders).toMatchObject([{ title: 'have water', due_zone: 'Asia/Kolkata', rrule, status: 'active' }]);
  });

  it('the reminder rule schema takes hourly; the event rule schema never does', () => {
    expect(ReminderRuleSchema.safeParse({ freq: 'hourly', interval: 12, window: { start: '00:00', end: '23:59' } }).success).toBe(true);
    expect(ReminderRuleSchema.safeParse({ freq: 'hourly', interval: 13 }).success).toBe(false);
    expect(ReminderRuleSchema.safeParse({ freq: 'hourly', window: { start: '8am', end: '22:00' } }).success).toBe(false);
    expect(ReminderRuleSchema.safeParse({ freq: 'weekly', byWeekday: [1, 2, 3, 4, 5] }).success).toBe(true);
    expect(RecurrenceRuleSchema.safeParse({ freq: 'hourly' }).success).toBe(false);
  });

  it('a non-member gets the same answer the tasks list gives', async () => {
    const reminders = await get(`/api/spaces/${spaceId}/reminders`, outsiderToken);
    const tasks = await get(`/api/spaces/${spaceId}/tasks`, outsiderToken);
    expect(reminders.status).toBe(tasks.status);
    expect(reminders.status).toBe(200);
    expect((await reminders.json()) as ListBody).toEqual({ reminders: [] });
  });

  it('an empty space lists no reminders', async () => {
    const res = await get(`/api/spaces/${emptySpaceId}/reminders`, ownerToken);
    expect(res.status).toBe(200);
    expect((await res.json()) as ListBody).toEqual({ reminders: [] });
  });

  it('rejects a malformed space id', async () => {
    const res = await get('/api/spaces/not-a-uuid/reminders', ownerToken);
    expect(res.status).toBe(400);
  });

  describe('writes (#508)', () => {
    let member: TestAccount;
    let memberToken: string;

    beforeAll(async () => {
      member = await addAccount(pg);
      memberToken = await tokenFor(member);
      await addMember(db, owner.userId, spaceId, member.userId, 'member');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function create(tok: string, body: Record<string, unknown>, space = spaceId): Promise<Response> {
      return send('POST', `/api/spaces/${space}/reminders`, tok, { due_zone: 'Asia/Kolkata', ...body });
    }

    async function inbox(userId: string, reminderId: string): Promise<number> {
      return (await listNotifications(db, userId, { limit: 200 })).filter((n) => n.resourceId === reminderId).length;
    }

    async function occurrenceOf(userId: string, reminderId: string): Promise<string> {
      const res = await withUserRaw(pg, userId, (tx) => tx.query<{ id: string }>(
        'SELECT id FROM bob.reminder_occurrences WHERE reminder_id = $1', [reminderId]));
      return res.rows[0]!.id;
    }

    it('c1: two recipients each get exactly one inbox item at the due time', async () => {
      const due = Date.now() + 60_000;
      const res = await create(ownerToken, { title: 'pay rent', due_at: due, recipient_user_ids: [owner.userId, member.userId] });
      expect(res.status).toBe(201);
      const { reminder } = (await res.json()) as ReminderBody;
      expect(reminder).toMatchObject({ space_id: spaceId, due_at: due, schedule_revision: 1, status: 'active' });

      await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => due + 1_000 }).tick();
      await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => due + 2_000 }).tick();
      expect(await inbox(owner.userId, reminder.id)).toBe(1);
      expect(await inbox(member.userId, reminder.id)).toBe(1);
    });

    it('c2: a non-member recipient is a 400 and nothing is written', async () => {
      const res = await create(ownerToken, { title: 'never saved', due_at: Date.now() + 60_000,
        recipient_user_ids: [owner.userId, outsider.userId] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_recipient');
      // Read as the space owner, who sees every reminder in the space.
      const rows = await withUserRaw(pg, owner.userId, (tx) => tx.query(
        'SELECT id FROM bob.reminders WHERE space_id = $1 AND title = $2', [spaceId, 'never saved']));
      expect(rows.rows).toHaveLength(0);
      const all = await withUserRaw(pg, owner.userId, (tx) => tx.query(
        'SELECT id FROM bob.reminders WHERE space_id = $1', [spaceId]));
      expect(all.rows.length).toBeGreaterThan(0);
    });

    it('refuses a bad body, and a caller outside the space answers not found', async () => {
      const due = Date.now() + 60_000;
      expect((await create(ownerToken, { title: 'x', due_at: due, due_zone: 'Mars/Base', recipient_user_ids: [owner.userId] })).status).toBe(400);
      expect((await create(ownerToken, { title: 'x', due_at: due, recipient_user_ids: [] })).status).toBe(400);
      expect((await create(ownerToken, { title: 'x', due_at: due, rrule: { freq: 'hourly', interval: 13 },
        recipient_user_ids: [owner.userId] })).status).toBe(400);
      expect((await create(outsiderToken, { title: 'x', due_at: due, recipient_user_ids: [outsider.userId] })).status).toBe(404);
    });

    it('c3/c4: PATCH bumps the revision; the old pending snooze produces nothing; nobody snoozes another', async () => {
      const due = Date.now() - 30_000;
      const created = (await (await create(ownerToken, { title: 'meds', due_at: due,
        recipient_user_ids: [owner.userId, member.userId] })).json()) as ReminderBody;
      const id = created.reminder.id;
      await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => Date.now() }).tick();
      expect(await inbox(member.userId, id)).toBe(1);

      const occurrence = await occurrenceOf(member.userId, id);
      const until = Date.now() + 60_000;
      // c4: the owner, an outsider and a wrong reminder path all miss the member's row.
      expect((await send('POST', `/api/reminders/${id}/occurrences/snooze`, ownerToken, { occurrence_id: occurrence, until })).status).toBe(404);
      expect((await send('POST', `/api/reminders/${id}/occurrences/snooze`, outsiderToken, { occurrence_id: occurrence, until })).status).toBe(404);
      const other = (await (await create(ownerToken, { title: 'other', due_at: Date.now() + 3_600_000,
        recipient_user_ids: [member.userId] })).json()) as ReminderBody;
      expect((await send('POST', `/api/reminders/${other.reminder.id}/occurrences/snooze`, memberToken, { occurrence_id: occurrence, until })).status).toBe(404);
      expect((await send('POST', `/api/reminders/${id}/occurrences/snooze`, memberToken, { occurrence_id: occurrence, until })).status).toBe(204);

      // Only the creator (or a space owner/admin) edits; a plain member sees 404.
      const later = { due_at: Date.now() + 3_600_000, due_zone: 'Asia/Kolkata' };
      expect((await send('PATCH', `/api/reminders/${id}`, memberToken, later)).status).toBe(404);
      expect((await send('PATCH', `/api/reminders/${id}`, ownerToken, { due_at: later.due_at })).status).toBe(400);
      const patched = await send('PATCH', `/api/reminders/${id}`, ownerToken, later);
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as ReminderBody).reminder.schedule_revision).toBe(2);
      await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db, now: () => until + 1_000 }).tick();
      expect(await inbox(member.userId, id)).toBe(1);
      expect(await inbox(owner.userId, id)).toBe(1);
    });

    it('cancels for the creator; others get 404; journal events carry ids and counts only', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const created = (await (await create(ownerToken, { title: 'secret title', due_at: Date.now() + 60_000,
        recipient_user_ids: [owner.userId] })).json()) as ReminderBody;
      expect((await send('POST', `/api/reminders/${created.reminder.id}/cancel`, outsiderToken)).status).toBe(404);
      expect((await send('POST', `/api/reminders/${created.reminder.id}/cancel`, memberToken)).status).toBe(404);
      const res = await send('POST', `/api/reminders/${created.reminder.id}/cancel`, ownerToken);
      expect(res.status).toBe(200);
      expect(((await res.json()) as ReminderBody).reminder.status).toBe('cancelled');
      const entries = log.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('v2.reminder_'));
      expect(entries.some((line) => line.includes('"v2.reminder_created"') && line.includes('"recipients":1'))).toBe(true);
      expect(entries.some((line) => line.includes('"v2.reminder_cancelled"'))).toBe(true);
      expect(entries.join('\n')).not.toContain('secret title');
    });
  });
});
