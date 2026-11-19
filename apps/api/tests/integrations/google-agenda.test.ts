import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createGoogleAgendaService } from '../../src/integrations/google-agenda-service.ts';
import { addGoogleAccount, deleteGoogleAccount } from '../../src/integrations/google-store.ts';
import { GoogleCredentialError } from '../../src/integrations/google-credentials.ts';
import { withUser } from '../../src/platform/db/db.ts';
import { listGoogleCalendarSelections } from '../../src/integrations/google-calendar-selection-store.ts';
import { listAgenda } from '../../src/calendar/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
beforeAll(async () => { pg = await createTestDb(); });
afterAll(async () => { await closeTestDb(pg); });
async function owner(): Promise<{ userId: string; accountId: string }> {
  const { userId } = await addAccount(pg);
  const account = await addGoogleAccount(asDb(pg), userId, { installationId: randomUUID(), accountId: 'provider', email: 'user@example.test' });
  return { userId, accountId: account.id };
}
function provider() {
  return {
    listCalendars: vi.fn().mockResolvedValue({ items: [{ id: 'calendar', summary: 'Personal', accessRole: 'owner', timeZone: 'America/Los_Angeles' }] }),
    listEvents: vi.fn().mockResolvedValue({ items: [{ id: 'event', etag: 'version', summary: 'Appointment',
      start: { date: '2026-10-20' }, end: { date: '2026-10-21' } }] }),
  };
}
const window = { from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-11-01T00:00:00Z') };

it('fetches nothing until explicit selection and projects date-only events without native records', async () => {
  const identity = await owner();
  const calendar = provider();
  const service = createGoogleAgendaService({ db: asDb(pg), calendar });
  expect(await service.project(identity.userId, window)).toEqual({ remote_items: [], sources: [] });
  expect(calendar.listEvents).not.toHaveBeenCalled();
  await service.selectCalendars(identity.userId, identity.accountId, { calendarIds: ['calendar'] });
  const result = await service.project(identity.userId, window);
  expect(result.remote_items).toMatchObject([{ origin: 'google', read_only: true, start: { date: '2026-10-20' },
    source: { account_id: identity.accountId, calendar_id: 'calendar', event_id: 'event' } }]);
  expect(result.sources).toMatchObject([{ state: 'fresh', last_success_at: expect.any(Number) }]);
  expect(await listAgenda(asDb(pg), identity.userId, window)).toEqual([]);
  await deleteGoogleAccount(asDb(pg), identity.userId, identity.accountId);
  expect(await service.project(identity.userId, window)).toEqual({ remote_items: [], sources: [] });
});

it('enforces five selected calendars across accounts and does not persist invalid or duplicate choices', async () => {
  const identity = await owner();
  const second = await addGoogleAccount(asDb(pg), identity.userId, { installationId: randomUUID(), accountId: 'provider2', email: 'two@example.test' });
  const calendar = provider();
  calendar.listCalendars.mockResolvedValue({ items: Array.from({ length: 6 }, (_, index) => ({ id: `calendar${index}`, summary: 'Calendar', accessRole: 'reader' })) });
  const service = createGoogleAgendaService({ db: asDb(pg), calendar });
  await service.selectCalendars(identity.userId, identity.accountId, { calendarIds: ['calendar0', 'calendar1', 'calendar2', 'calendar3', 'calendar4'] });
  await expect(service.selectCalendars(identity.userId, second.id, { calendarIds: ['calendar5'] })).rejects.toThrow('google_selection_limit');
  await expect(service.selectCalendars(identity.userId, second.id, { calendarIds: ['calendar0', 'calendar0'] })).rejects.toThrow('google_selection_invalid');
  expect(await listGoogleCalendarSelections(asDb(pg), identity.userId)).toHaveLength(5);
});

it('fails cancelled projection sources honestly without calling the provider or losing successful freshness', async () => {
  const identity = await owner();
  const calendar = provider();
  const service = createGoogleAgendaService({ db: asDb(pg), calendar });
  await service.selectCalendars(identity.userId, identity.accountId, { calendarIds: ['calendar'] });
  const result = await service.project(identity.userId, window, AbortSignal.abort());
  expect(result).toMatchObject({ remote_items: [], sources: [{ state: 'unavailable', last_success_at: null }] });
  expect(calendar.listEvents).not.toHaveBeenCalled();
});

it('denies another owner selection before provider calls and enforces composite account ownership in SQL', async () => {
  const identity = await owner();
  const other = await owner();
  const calendar = provider();
  const service = createGoogleAgendaService({ db: asDb(pg), calendar });
  await expect(service.selectCalendars(other.userId, identity.accountId, { calendarIds: ['calendar'] })).rejects.toThrow('google_account_not_found');
  expect(calendar.listCalendars).not.toHaveBeenCalled();
  await expect(withUser(asDb(pg), other.userId, (tx) => tx.query(`insert into bob.google_calendar_selections
    (user_id,google_account_id,calendar_id,title) values ($1,$2,'calendar','')`, [other.userId, identity.accountId]))).rejects.toThrow();
  expect(await service.project(other.userId, window)).toEqual({ remote_items: [], sources: [] });
});

it('keeps independent source results, stable identities and last successful fetch across partial failures', async () => {
  const identity = await owner();
  const second = await addGoogleAccount(asDb(pg), identity.userId, { installationId: randomUUID(), accountId: 'provider2', email: 'two@example.test' });
  const calendar = provider();
  const service = createGoogleAgendaService({ db: asDb(pg), calendar });
  await service.selectCalendars(identity.userId, identity.accountId, { calendarIds: ['calendar'] });
  await service.selectCalendars(identity.userId, second.id, { calendarIds: ['calendar'] });
  const success = await service.project(identity.userId, window);
  expect(new Set(success.remote_items.map((item) => item.source_key)).size).toBe(2);
  const previous = success.sources.find((source) => source.account_id === identity.accountId)?.last_success_at;
  calendar.listEvents.mockImplementation(async (_user, accountId) => {
    if (accountId === identity.accountId) throw new GoogleCredentialError('reconnect_required');
    return { items: [], nextPageToken: 'next-page' };
  });
  const partial = await service.project(identity.userId, window);
  expect(partial.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ account_id: identity.accountId, state: 'reconnect_required', last_success_at: previous }),
    expect.objectContaining({ account_id: second.id, state: 'partial', next_page_token: 'next-page' }),
  ]));
  expect(calendar.listEvents.mock.calls.every(([, , , input]) => input.limit === 50)).toBe(true);
});

it('requires known readable calendars, preserves old selection on failed validation and supports explicit removal', async () => {
  const identity = await owner();
  const calendar = provider();
  const service = createGoogleAgendaService({ db: asDb(pg), calendar });
  await service.selectCalendars(identity.userId, identity.accountId, { calendarIds: ['calendar'] });
  await expect(service.selectCalendars(identity.userId, identity.accountId, { calendarIds: ['unknown'] })).rejects.toThrow('google_calendar_selection_unavailable');
  expect(await listGoogleCalendarSelections(asDb(pg), identity.userId)).toHaveLength(1);
  calendar.listCalendars.mockRejectedValue(new Error('provider secret'));
  await service.selectCalendars(identity.userId, identity.accountId, { calendarIds: [] });
  expect(await service.project(identity.userId, window)).toEqual({ remote_items: [], sources: [] });
});

it('preserves offsets and recurrence original date while isolating malformed sources', async () => {
  const identity = await owner();
  const calendar = provider();
  const service = createGoogleAgendaService({ db: asDb(pg), calendar });
  await service.selectCalendars(identity.userId, identity.accountId, { calendarIds: ['calendar'] });
  calendar.listEvents.mockResolvedValue({ items: [{ id: 'event', etag: 'v2', summary: 'DST', recurringEventId: 'series', originalStartTime: { date: '2026-11-01' },
    start: { dateTime: '2026-11-01T01:30:00-07:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-11-01T01:30:00-08:00', timeZone: 'America/Los_Angeles' } }] });
  const result = await service.project(identity.userId, window);
  expect(result.remote_items[0]).toMatchObject({ original_start: { date: '2026-11-01' }, start: { dateTime: '2026-11-01T01:30:00-07:00' }, end: { dateTime: '2026-11-01T01:30:00-08:00' } });
  calendar.listEvents.mockResolvedValue({ items: [{ id: 'event', etag: 'v3' }] });
  expect(await service.project(identity.userId, window)).toMatchObject({ remote_items: [], sources: [{ state: 'unavailable' }] });
});
