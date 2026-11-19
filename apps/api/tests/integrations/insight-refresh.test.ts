import { describe, expect, it, vi } from 'vitest';
import { createInsightRefresh } from '../../src/integrations/insight-refresh.ts';
import type { z } from 'zod';
import type { InsightSchema } from '../../src/routines/execution-schemas.ts';
import type { createGoogleCalendarService } from '../../src/integrations/google-calendar-service.ts';

const now = Date.parse('2026-10-22T08:00:00Z');
const input = { owner: 'owner', googleAccountId: 'account', now, signal: new AbortController().signal };
function fixture() {
  const calendar = {
    listCalendars: vi.fn(async () => ({ items: [{ id: 'calendar', summary: 'Work', accessRole: 'reader' as const }], nextPageToken: undefined as string | undefined })),
    listEvents: vi.fn<ReturnType<typeof createGoogleCalendarService>['listEvents']>(async () => ({ items: [
      { id: 'a', etag: 'one', summary: 'One', htmlLink: 'https://calendar.google.com/calendar/event?eid=actual-provider-link', status: 'confirmed' as const, start: { dateTime: '2026-10-23T09:00:00Z' }, end: { dateTime: '2026-10-23T10:00:00Z' } },
      { id: 'b', etag: 'two', summary: 'Two', status: 'confirmed' as const, start: { dateTime: '2026-10-23T09:30:00Z' }, end: { dateTime: '2026-10-23T10:30:00Z' } },
    ], nextPageToken: undefined as string | undefined })),
  };
  const history = vi.fn(async (): Promise<z.infer<typeof InsightSchema>[]> => []);
  const selectedCalendars = vi.fn(async () => ['calendar']);
  return { calendar, history, selectedCalendars, service: createInsightRefresh({ calendar, history, selectedCalendars }) };
}
describe('integration-grounded insights', () => {
  it('forecasts scheduled workload and potential conflicts from actual bounded events', async () => {
    const f = fixture(); const result = await f.service.future(input);
    expect(result).toMatchObject({ category: 'future', periodStart: now, periodEnd: now + 7 * 86400000,
      generatedAt: now, partial: false, messageCount: 0 });
    expect(result.summary).toContain('2 confirmed');
    expect(result.summary).toContain('2.0 event-hours');
    expect(result.summary).toContain('1 potential overlap');
    expect(result.summary).toContain('If these events go ahead');
    expect(result.summary).toContain('not a prediction of actual work');
    expect(result.sources.map(source => source.label)).toEqual(['One', 'Two']);
    expect(result.sources[0]?.url).toBe('https://calendar.google.com/calendar/event?eid=actual-provider-link');
    expect(result.sources[1]?.url).toBeUndefined();
    expect(f.calendar.listEvents).toHaveBeenCalledWith('owner', 'account', 'calendar',
      { limit: 40, timeMin: new Date(now).toISOString(), timeMax: new Date(now + 7 * 86400000).toISOString() }, input.signal);
  });
  it('discloses bounded provider pages and never follows an unbounded continuation', async () => {
    const f = fixture(); f.selectedCalendars.mockResolvedValue(['one', 'two', 'three', 'four', 'five']);
    expect(await f.service.future(input)).toMatchObject({ partial: true });
    expect(f.calendar.listCalendars).not.toHaveBeenCalled();
    expect(f.calendar.listEvents).toHaveBeenCalledTimes(4);
    expect(f.calendar.listEvents.mock.calls.map(call => call[2])).toEqual(['one', 'two', 'three', 'four']);
  });
  it('only reads explicitly selected calendars and never scans accessible unselected ones', async () => {
    const f = fixture(); f.selectedCalendars.mockResolvedValue(['selected-only']);
    await f.service.future(input);
    expect(f.selectedCalendars).toHaveBeenCalledWith('owner', 'account');
    expect(f.calendar.listCalendars).not.toHaveBeenCalled();
    expect(f.calendar.listEvents.mock.calls.map(call => call[2])).toEqual(['selected-only']);
  });
  it('marks selected calendar event pagination as partial without following it', async () => {
    const f = fixture(); f.calendar.listEvents.mockResolvedValue({ items: [], nextPageToken: 'more-events' });
    expect(await f.service.future(input)).toMatchObject({ partial: true });
    expect(f.calendar.listEvents).toHaveBeenCalledTimes(1);
  });
  it('refuses an empty calendar selection without provider reads', async () => {
    const f = fixture(); f.selectedCalendars.mockResolvedValue([]);
    await expect(f.service.future(input)).rejects.toThrow('insight_no_selected_calendars');
    expect(f.calendar.listCalendars).not.toHaveBeenCalled();
    expect(f.calendar.listEvents).not.toHaveBeenCalled();
  });
  it('does not translate denied or unavailable calendar reads into an empty forecast', async () => {
    const f = fixture(); f.calendar.listEvents.mockRejectedValue(new Error('google_permission_required'));
    await expect(f.service.future(input)).rejects.toThrow('google_permission_required');
  });
  it('keeps all-day and tentative events out of confirmed hours and ignores cancelled events', async () => {
    const f = fixture();
    f.calendar.listEvents.mockResolvedValue({ items: [
      { id: 'day', etag: 'day', status: 'confirmed', start: { date: '2026-10-22' }, end: { date: '2026-10-23' } },
      { id: 'maybe', etag: 'maybe', status: 'tentative', start: { dateTime: '2026-10-23T09:00:00Z' }, end: { dateTime: '2026-10-23T10:00:00Z' } },
      { id: 'cancelled', etag: 'cancelled', status: 'cancelled' },
    ] });
    const result = await f.service.future(input);
    expect(result.summary).toContain('0 confirmed timed events, 1 tentative or unconfirmed timed events and 1 all-day');
    expect(result.summary).toContain('0.0 event-hours');
    expect(result.sources).toHaveLength(2);
  });
  it('cancels before any provider reads', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.service.future({ ...input, signal: controller.signal })).rejects.toThrow();
    expect(f.calendar.listCalendars).not.toHaveBeenCalled();
  });
  it('returns no reflection when there are fewer than two saved coverage periods', async () => {
    expect(await fixture().service.reflections(input)).toBeNull();
  });
  it('reflects only on disjoint saved periods for the selected account', async () => {
    const f = fixture();
    const recap = (id: string, start: number, end: number, count: number): z.infer<typeof InsightSchema> => ({
      id, routineId: null, googleAccountId: 'account', category: 'past', title: 'Recap', summary: 'Untrusted summary',
      periodStart: start, periodEnd: end, generatedAt: end, partial: false, messageCount: count,
      sources: [{ kind: 'gmail', id, label: 'Mail' }],
    });
    f.history.mockResolvedValue([recap('first', now - 2 * 86400000, now - 86400000, 3),
      recap('second', now - 86400000, now, 5), recap('duplicate', now - 86400000, now, 100),
      { ...recap('foreign', now - 3 * 86400000, now - 2 * 86400000, 99), googleAccountId: 'other' }]);
    const result = await f.service.reflections(input);
    expect(result).toMatchObject({ category: 'reflections', messageCount: 0, partial: false });
    expect(result?.summary).toContain('8 messages');
    expect(result?.summary).toContain('2 saved');
    expect(result?.summary).not.toContain('Untrusted summary');
    expect(result?.sources.map(source => source.id).sort()).toEqual(['first', 'second']);
  });
});
