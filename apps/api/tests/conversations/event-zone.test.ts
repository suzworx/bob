// TZ-FIX: create_event start/end are local wall time in the ACCOUNT zone, the
// model supplies no zone, and the auto-created default calendar takes the
// account zone instead of a hardcoded UTC. Dark behind BOB_LOCAL_TIME_DUES=on;
// unset keeps the legacy schema and pass-through. Real Postgres test db, all three binders.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Db } from '../../src/platform/db/db.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';
import { getEvent, listCalendars } from '../../src/calendar/store.ts';
import { bindPrivateCallbacks as bindWeb } from '../../src/tasks/agent-callbacks.ts';
import { bindPrivateCallbacks as bindTurn } from '../../src/tasks/agent-callbacks.ts';
import { bindCallbacks } from '../../src/workflows/workflow-thread-invocation.ts';
import { type LocalTimeScope } from '../../src/conversations/invocations-service.ts';
import { createProductivityTools, type ProductivityCallbacks } from '@bob/ai';
import { createEventInputSchema, localCreateEventInputSchema } from '@bob/ai/testing';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

type Binder = (userId: string, spaceId: string, scope: LocalTimeScope) => ProductivityCallbacks;
const BINDERS: Array<[string, Binder]> = [
  ['web-chat', (userId, spaceId, scope) => bindWeb(db, userId, spaceId, scope)],
  ['turn', (userId, spaceId, scope) => bindTurn(db, userId, spaceId, scope)],
  ['invocations', (userId, spaceId, scope) => bindCallbacks(db, {
    actorUserId: userId, spaceId, threadId: 'unused', triggerMessageId: 'unused', contextHighWater: 0,
  }, scope)],
];

type Result = { ok: boolean; eventId?: string; reason?: string; items?: Array<{ startIso: string; endIso: string }> };

/** A fresh private space (no calendar yet) and its tools under `timeZone` and the flag. */
async function setup(bind: Binder, timeZone: string, localTimeDues = true) {
  const { userId } = await addAccount(pg);
  const space = await ensurePrivateSpace(db, userId);
  const tools = createProductivityTools(bind(userId, space.id, { timeZone, localTimeDues }), { localTimeDues });
  const call = (name: string, input: unknown): Promise<Result> =>
    (tools[name] as unknown as { execute(i: unknown): Promise<Result> }).execute(input);
  const stored = async (eventId: string) => {
    const event = await getEvent(db, userId, eventId);
    const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
    return { start: iso(event.startAt), end: iso(event.endAt), zone: event.zone };
  };
  const calendarZones = async () => (await listCalendars(db, userId, space.id)).map((cal) => cal.zone);
  return { call, stored, calendarZones };
}

describe.each(BINDERS)('BOB_LOCAL_TIME_DUES=on: %s binder', (_name, bind) => {
  it.each([
    ['America/Los_Angeles', '2026-09-24T16:00:00.000Z', '2026-09-24T17:00:00.000Z'],
    ['Asia/Kolkata', '2026-09-24T03:30:00.000Z', '2026-09-24T04:30:00.000Z'],
  ])('create_event in %s stores the account-zone instants and calendar zone', async (zone, start, end) => {
    const { call, stored, calendarZones } = await setup(bind, zone);
    const res = await call('create_event', { title: 'Dentist', startIso: '2026-09-24T09:00', endIso: '2026-09-24T10:00' });
    expect(res.ok).toBe(true);
    expect(await stored(res.eventId!)).toEqual({ start, end, zone });
    expect(await calendarZones()).toEqual([zone]);
  });

  it('moves a DST spring-forward gap forward', async () => {
    const { call, stored } = await setup(bind, 'America/Los_Angeles');
    const res = await call('create_event', { title: 'x', startIso: '2027-03-14T02:30', endIso: '2027-03-14T04:00' });
    expect((await stored(res.eventId!)).start).toBe('2027-03-14T10:30:00.000Z');
  });

  it.each(['2026-09-24T09:00:00Z', '2026-09-24T09:00-07:00'])('refuses %s, naming the expected shape', async (at) => {
    const { call } = await setup(bind, 'America/Los_Angeles');
    const res = await call('create_event', { title: 'x', startIso: at, endIso: '2026-09-24T10:00' });
    expect(res).toEqual({ ok: false, reason: expect.stringContaining('YYYY-MM-DDTHH:mm') });
  });

  it('list_agenda reads back local wall time plus zone, and all-day as a date', async () => {
    const { call } = await setup(bind, 'America/Los_Angeles');
    await call('create_event', { title: 'Dentist', startIso: '2026-09-24T09:00', endIso: '2026-09-24T10:00' });
    await call('create_event', { title: 'Trip', startIso: '2026-09-25', endIso: '2026-09-26', allDay: true });
    const list = await call('list_agenda', { fromIso: '2026-09-24T00:00:00Z', toIso: '2026-09-27T00:00:00Z' });
    expect(list.items?.map(({ startIso, endIso }) => [startIso, endIso])).toEqual([
      ['2026-09-24T09:00 America/Los_Angeles', '2026-09-24T10:00 America/Los_Angeles'],
      ['2026-09-25', '2026-09-26'],
    ]);
  });
});

describe('the flag-on event schema', () => {
  it('has no zone field', () => {
    const input = { title: 'x', startIso: '2026-09-24T09:00', endIso: '2026-09-24T10:00' };
    expect(localCreateEventInputSchema.safeParse(input).success).toBe(true);
    expect(localCreateEventInputSchema.safeParse({ ...input, zone: 'UTC' }).success).toBe(false);
  });
});

describe('BOB_LOCAL_TIME_DUES unset: the legacy contract', () => {
  it('offers the legacy event schema, byte-identical', () => {
    const tools = createProductivityTools({} as ProductivityCallbacks, { localTimeDues: false });
    expect(tools.create_event?.inputSchema).toBe(createEventInputSchema);
    expect(JSON.stringify(z.toJSONSchema(createEventInputSchema))).toBe(LEGACY_CREATE_EVENT_JSON);
  });

  it.each(BINDERS)('%s stores the model times and zone verbatim in a UTC calendar', async (_name, bind) => {
    const { call, stored, calendarZones } = await setup(bind, 'America/Los_Angeles', false);
    const res = await call('create_event', {
      title: 'Dentist', startIso: '2026-09-24T09:00:00Z', endIso: '2026-09-24T10:00:00Z', zone: 'UTC',
    });
    expect(await stored(res.eventId!)).toEqual({ start: '2026-09-24T09:00:00.000Z', end: '2026-09-24T10:00:00.000Z', zone: 'UTC' });
    expect(await calendarZones()).toEqual(['UTC']);
  });
});

/** The pre-TZ-FIX create_event input schema, exactly as the provider receives it. */
const LEGACY_CREATE_EVENT_JSON =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":200},"startIso":{"type":"string"},"endIso":{"type":"string"},"zone":{"type":"string","minLength":1},"allDay":{"type":"boolean"},"attendeeHandles":{"type":"array","items":{"type":"string","minLength":1}}},"required":["title","startIso","endIso","zone"],"additionalProperties":false}';
