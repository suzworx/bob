import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { createGoogleCalendarService } from './google-calendar-service.ts';
import type { InsightSchema } from '../routines/execution-schemas.ts';

type Insight = z.infer<typeof InsightSchema>;
type Draft = Omit<Insight, 'id' | 'routineId'>;
type Calendar = Pick<ReturnType<typeof createGoogleCalendarService>, 'listEvents'>;
type Event = Awaited<ReturnType<Calendar['listEvents']>>['items'][number];
interface Input { owner: string; googleAccountId: string; now: number; signal: AbortSignal }
interface Dependencies {
  calendar: Calendar;
  selectedCalendars(owner: string, googleAccountId: string): Promise<string[]>;
  history(owner: string, googleAccountId: string): Promise<Insight[]>;
}
interface Timed { start: number; end: number }
interface CalendarFacts {
  confirmed: number; unconfirmed: number; allDay: number; hours: number;
  times: Timed[]; sources: Insight['sources']; partial: boolean;
}
const WEEK = 7 * 86400000;

function validate(input: Input): void {
  input.signal.throwIfAborted();
  if (!Number.isSafeInteger(input.now) || !Number.isFinite(new Date(input.now + WEEK).getTime())) throw new Error('insight_invalid_clock');
  if (!input.owner || !input.googleAccountId) throw new Error('insight_account_required');
}

function source(calendarId: string, event: Event): Insight['sources'][number] {
  return { kind: 'calendar', id: createHash('sha256').update(JSON.stringify([calendarId, event.id])).digest('hex'),
    label: (event.summary || 'Calendar event').slice(0, 300), ...(event.htmlLink ? { url: event.htmlLink } : {}) };
}

function recordEvent(facts: CalendarFacts, calendarId: string, event: Event, input: Input): void {
  if (event.status === 'cancelled') return;
  if (!event.start || !event.end) { facts.partial = true; return; }
  if ('date' in event.start && 'date' in event.end) {
    // Date-only events have no reliable elapsed-hour duration without the
    // calendar zone; report them separately and never infer busy hours.
    // The provider applies the requested interval in the calendar's zone;
    // parsing a date-only boundary as UTC here would drop ongoing local days.
    facts.allDay += 1;
    facts.sources.push(source(calendarId, event));
    return;
  }
  if (!('dateTime' in event.start) || !('dateTime' in event.end)) { facts.partial = true; return; }
  const start = Math.max(input.now, Date.parse(event.start.dateTime));
  const end = Math.min(input.now + WEEK, Date.parse(event.end.dateTime));
  if (end <= start) return;
  facts.sources.push(source(calendarId, event));
  if (event.status !== 'confirmed') { facts.unconfirmed += 1; return; }
  facts.confirmed += 1;
  facts.hours += (end - start) / 3600000;
  facts.times.push({ start, end });
}

function overlaps(times: Timed[]): number {
  let count = 0;
  for (let i = 0; i < times.length; i += 1) {
    const first = times[i];
    if (!first) continue;
    for (const second of times.slice(i + 1)) if (first.start < second.end && second.start < first.end) count += 1;
  }
  return count;
}

async function future(deps: Dependencies, input: Input): Promise<Draft> {
  validate(input);
  const calendars = [...new Set(await deps.selectedCalendars(input.owner, input.googleAccountId))];
  if (!calendars.length) throw new Error('insight_no_selected_calendars');
  const facts: CalendarFacts = { confirmed: 0, unconfirmed: 0, allDay: 0, hours: 0, times: [], sources: [],
    partial: calendars.length > 4 };
  for (const calendarId of calendars.slice(0, 4)) {
    input.signal.throwIfAborted();
    const page = await deps.calendar.listEvents(input.owner, input.googleAccountId, calendarId, {
      limit: 40, timeMin: new Date(input.now).toISOString(), timeMax: new Date(input.now + WEEK).toISOString(),
    }, input.signal);
    facts.partial ||= Boolean(page.nextPageToken) || page.items.length > 40;
    const seen = new Set<string>();
    for (const event of page.items.slice(0, 40)) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      recordEvent(facts, calendarId, event, input);
    }
  }
  input.signal.throwIfAborted();
  const summary = `Calendar snapshot fetched at ${new Date(input.now).toISOString()}, covering the next seven days through ${new Date(input.now + WEEK).toISOString()}. `
    + `Your selected calendars contain ${facts.confirmed} confirmed timed events, ${facts.unconfirmed} tentative or unconfirmed timed events and ${facts.allDay} all-day events. `
    + `If these events go ahead as currently scheduled, confirmed events represent ${facts.hours.toFixed(1)} event-hours; overlapping events count separately. `
    + `${overlaps(facts.times)} potential overlap pairs appear among confirmed timed events. Copies on different calendars may describe the same meeting. `
    + `This is a projection of scheduled calendar load, not a prediction of actual work, attendance or free time. All-day events and unscheduled work are excluded from the hours estimate. `
    + (facts.partial ? 'Coverage is partial: additional pages or selected calendars could change these figures.' : 'Coverage includes only your selected calendars and returned events; schedules may change after this snapshot.');
  return { googleAccountId: input.googleAccountId, category: 'future', title: 'Your next seven days', summary,
    periodStart: input.now, periodEnd: input.now + WEEK, generatedAt: input.now, sources: facts.sources,
    partial: facts.partial, messageCount: 0 };
}

function distinctPeriods(history: Insight[], input: Input): Insight[] {
  const candidates = history.filter(item => item.googleAccountId === input.googleAccountId && item.category === 'past'
    && item.periodEnd <= input.now && item.generatedAt <= input.now && item.periodStart < item.periodEnd)
    .sort((a, b) => b.periodEnd - a.periodEnd || b.generatedAt - a.generatedAt);
  const selected: Insight[] = [];
  for (const item of candidates) {
    if (selected.length >= 14) break;
    if (selected.some(previous => item.periodStart < previous.periodEnd && previous.periodStart < item.periodEnd)) continue;
    selected.push(item);
  }
  return selected.sort((a, b) => a.periodStart - b.periodStart);
}

async function reflections(deps: Dependencies, input: Input): Promise<Draft | null> {
  validate(input);
  const history = await deps.history(input.owner, input.googleAccountId);
  input.signal.throwIfAborted();
  const periods = distinctPeriods(history, input);
  const first = periods[0];
  const last = periods.at(-1);
  if (periods.length < 2 || !first || !last) return null;
  const counts = periods.reduce((sum, item) => sum + item.messageCount, 0);
  const hours = periods.reduce((sum, item) => sum + (item.periodEnd - item.periodStart) / 3600000, 0);
  const gaps = periods.some((item, index) => index > 0 && periods[index - 1]?.periodEnd !== item.periodStart);
  const sourceMap = new Map<string, Insight['sources'][number]>();
  for (const item of periods) for (const ref of item.sources) sourceMap.set(`${ref.kind}:${ref.id}`, ref);
  const sources = [...sourceMap.values()].slice(0, 200);
  const partial = gaps || periods.some(item => item.partial) || sourceMap.size > 200 || history.length >= 100;
  const summary = `${periods.length} saved, nonoverlapping Gmail recap periods record ${counts} messages across ${hours.toFixed(1)} covered hours, `
    + `from ${new Date(first.periodStart).toISOString()} to ${new Date(last.periodEnd).toISOString()}. `
    + `That is ${(counts * 24 / hours).toFixed(1)} recorded messages per 24 covered hours, based only on these saved recaps. `
    + `Reviewed at ${new Date(input.now).toISOString()}; the latest included recap was generated at ${new Date(Math.max(...periods.map(item => item.generatedAt))).toISOString()}. `
    + 'This describes recorded email volume, not your effort, productivity, mood or a forecast of future mail. '
    + (partial ? 'Coverage is partial or contains gaps; missing mail and periods can change these figures.' : 'These are historical snapshots and may omit mail outside their saved coverage.');
  return { googleAccountId: input.googleAccountId, category: 'reflections', title: 'Looking back at your email recaps', summary,
    periodStart: first.periodStart, periodEnd: last.periodEnd, generatedAt: input.now, sources, partial, messageCount: 0 };
}

/** Deterministic observations from explicitly selected integration data; no model or provider writes. */
export function createInsightRefresh(deps: Dependencies): {
  future(input: Input): Promise<Draft>; reflections(input: Input): Promise<Draft | null>;
} {
  return { future: input => future(deps, input), reflections: input => reflections(deps, input) };
}
