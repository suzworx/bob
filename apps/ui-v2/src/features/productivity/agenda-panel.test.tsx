import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import type { AgendaItem } from '@/features/productivity/use-agenda';
import type { Space } from '@/features/spaces/use-spaces';
import { AgendaPanel } from './agenda-panel';
import { SPACE_GUTTER } from '../spaces/space-header';

// Records every Section's props so a test can read the tab root's padding:
// jsdom computes no layout, and padding={0} makes a nested Section escape the
// page gutter and start 24px left of the space name.
const sectionProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@astryxdesign/core/Section', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/Section')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Section: (props: Parameters<typeof actual.Section>[0]) => {
      sectionProps.push(props as Record<string, unknown>);
      return createElement(actual.Section, props);
    },
  };
});

function rootSectionPadding(label: string): unknown {
  return sectionProps.filter((props) => props['aria-label'] === label).at(-1)?.padding;
}

vi.mock('@/lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  // No account zone: the browser's, which is what these day keys are built in.
  useSession: () => ({ session: { user: { id: 'me', user_metadata: {} } } }),
  browserTimeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
}));

const BASE: AgendaItem = {
  event_id: 'evt_1',
  uid: 'uid-1',
  title: 'Standup',
  location: null,
  body: null,
  all_day: false,
  start_date: null,
  end_date: null,
  start_at: null,
  end_at: null,
  zone: 'UTC',
  original_occurrence_start: 0,
  cancelled: false,
  moved: false,
  calendar_id: 'cal_1',
  space_id: 's1',
  origin: 'native',
  pending: false,
  can_edit: true,
};

/** A timed event starting at a local hour on a day of September 2026. */
function timed(title: string, day: number, hour: number, over: Partial<AgendaItem> = {}): AgendaItem {
  const start = new Date(2026, 8, day, hour, 0).getTime();
  return { ...BASE, event_id: `evt_${title}`, title, start_at: start, original_occurrence_start: start, ...over };
}

const EARLY = timed('Early', 20, 9);
const LATER = timed('Later', 22, 10, { origin: 'google' });
const PICNIC: AgendaItem = {
  ...BASE,
  event_id: 'evt_Picnic',
  title: 'Picnic',
  all_day: true,
  start_date: '2026-09-20',
  end_date: '2026-09-20',
};

/** The day heading for a day of September 2026 ("Sun, Sep 20, 2026"), as
 *  <Timestamp format="date_weekday"> renders it. */
function heading(day: number): string {
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    calendar: 'gregory',
  }).format(new Date(2026, 8, day));
}

// A line that mixes plain text with a <Timestamp> is several DOM nodes, so its
// assertion reads the whole line rather than the loose text nodes around it.
function line(text: string): boolean {
  return screen.getAllByText((_content, element) => element?.textContent === text).length > 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

// The panel now asks twice on mount (the hook's default window, then the month's
// grid), so a canned answer must serve every call, not just the first.
function answer(response: Response): void {
  fetchMock.mockImplementation(async () => response.clone());
}

/** Answer /api/agenda the way the server does: the events of `pool` that start
 *  inside the asked half-open [from, to) window. */
function serveAgenda(pool: AgendaItem[]): void {
  const startOf = (item: AgendaItem): number => item.start_at ?? new Date(`${item.start_date}T00:00:00`).getTime();
  fetchMock.mockImplementation(async (input) => {
    const params = new URL(String(input), 'http://localhost').searchParams;
    const from = Number(params.get('from'));
    const to = Number(params.get('to'));
    return json(200, { items: pool.filter((item) => startOf(item) >= from && startOf(item) < to) });
  });
}

/** The /api/agenda URL for a window that starts and ends at local midnight. */
function agendaUrl(from: Date, to: Date): string {
  return `/api/agenda?from=${from.getTime()}&to=${to.getTime()}`;
}

function lastUrl(): string {
  return String(fetchMock.mock.calls.at(-1)?.[0]);
}

/** The Calendar's grid, named by the month it shows ("September 2026"). */
function calendar(month: string): HTMLElement {
  return screen.getByRole('grid', { name: month });
}

/** One day's button, as a user finds it by its date, e.g. "Tuesday, September 22,
 *  2026"; the name goes on with ", selected" for the chosen day. */
function dayButton(date: string): HTMLElement {
  return within(screen.getByRole('grid')).getByRole('button', { name: new RegExp(`^${date}(,|$)`) });
}

/** The last day of September: in September's list, never in October's. */
const MONTH_END = timed('Month end', 30, 9);
const HARVEST_AT = new Date(2026, 9, 14, 10, 0).getTime();
const HARVEST: AgendaItem = {
  ...BASE,
  event_id: 'evt_Harvest',
  title: 'Harvest',
  start_at: HARVEST_AT,
  original_occurrence_start: HARVEST_AT,
};

const SPACE = {
  id: 's1', kind: 'group', name: 'Family', role: 'owner', membership_revision: 1, created_at: 0, updated_at: 0, members: [],
} as unknown as Space;

function renderPanel({ space = null }: { space?: Space | null } = {}): void {
  render(
    <Theme theme={neutralTheme} mode="system">
      <AgendaPanel space={space} />
    </Theme>,
  );
}

beforeEach(() => {
  // Pin "today" (Friday, September 18 2026) so the calendar opens on September.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 18, 12, 0));
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AgendaPanel', () => {
  it('re-applies the space gutter on its root Section, so its content starts where the space name starts', async () => {
    answer(json(200, { items: [] }));
    renderPanel();
    await screen.findByText('Nothing on the agenda this month.');
    expect(screen.getByRole('region', { name: 'Agenda' })).toBeTruthy();
    expect(rootSectionPadding('Agenda')).toBe(SPACE_GUTTER);
  });

  it('has no panel heading, and names the Agenda landmark for a screen reader', async () => {
    answer(json(200, { items: [] }));
    renderPanel();
    await screen.findByText('Nothing on the agenda this month.');
    expect(screen.queryByRole('heading', { name: 'Agenda' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Agenda' })).toBeTruthy();
  });

  it('lists events grouped by day, above nothing but the calendar', async () => {
    answer(json(200, { items: [LATER, EARLY, PICNIC] }));
    renderPanel();
    await screen.findByText('Early');

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^\/api\/agenda\?from=\d+&to=\d+$/);

    // Each day is its own list, named by its header, in date order.
    const firstDay = screen.getByRole('list', { name: heading(20) });
    const secondDay = screen.getByRole('list', { name: heading(22) });
    expect(firstDay.compareDocumentPosition(secondDay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => /Early|Picnic|Later/.exec(row.textContent ?? '')?.[0])).toEqual([
      'Early',
      'Picnic',
      'Later',
    ]);
    expect(screen.getAllByText('All day')).toHaveLength(1);
    // Plain words for where an event lives, never the raw origin value.
    expect(screen.getAllByText('Bob')).toHaveLength(2);
    expect(screen.getAllByText('Google')).toHaveLength(1);
    expect(screen.queryByText('native')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Pending' })).toBeNull();

    expect(calendar('September 2026').compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('asks only for its own space: the Agenda is scoped to the space it sits in', async () => {
    answer(json(200, { items: [EARLY] }));
    renderPanel({ space: SPACE });
    await screen.findByText('Early');
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^\/api\/agenda\?from=\d+&to=\d+&space_id=s1$/);
  });

  it('opens the event a notification links to (?event=)', async () => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    };
    window.history.replaceState(null, '', `/spaces/s1/agenda?event=${EARLY.event_id}`);
    answer(json(200, { items: [EARLY] }));
    renderPanel({ space: SPACE });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    // Close it, so its portal does not outlive the test.
    fireEvent.click(within(dialog).getAllByRole('button', { name: /Cancel|Close/ })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('starts weeks on Monday, the same as the Calendar page', async () => {
    answer(json(200, { items: [] }));
    renderPanel();
    const headers = await screen.findAllByRole('columnheader');
    expect(headers[0]?.textContent ?? '').toMatch(/^M/);
  });

  it('shows a pending dot only on a pending event', async () => {
    answer(json(200, { items: [EARLY, { ...LATER, pending: true }] }));
    renderPanel();
    await screen.findByText('Later');
    const dots = screen.getAllByRole('img', { name: 'Pending' });
    expect(dots).toHaveLength(1);
    expect(dots[0].closest('li')?.textContent).toContain('Later');
  });

  it("shows the caller's RSVP status on the row it belongs to", async () => {
    answer(
      json(200, {
        items: [{ ...EARLY, my_response: 'accepted' }, { ...LATER, my_response: 'needs_action' }, PICNIC],
      }),
    );
    renderPanel();
    await screen.findByText('Later');

    const going = screen.getByText('Going');
    expect(going.closest('li')?.textContent).toContain('Early');
    const invited = screen.getByText('Invited');
    expect(invited.closest('li')?.textContent).toContain('Later');
    // Picnic carries no my_response, so its row shows no RSVP token.
    const picnicRow = screen.getByText('Picnic').closest('li');
    expect(picnicRow?.textContent).not.toMatch(/Going|Invited|Maybe|Not going/);
  });

  it('shows Edit on a native row the caller can edit, and Details on one the caller cannot', async () => {
    const mine = timed('Mine', 20, 9, { can_edit: true });
    const someoneElses = timed('Someone else', 20, 11, { can_edit: false });
    answer(json(200, { items: [mine, someoneElses] }));
    renderPanel();
    await screen.findByText('Someone else');

    expect(screen.getByRole('button', { name: 'Edit Mine' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Details Mine' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Details Someone else' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Someone else' })).toBeNull();
  });

  it('says it is loading, then says the agenda is empty', async () => {
    answer(json(200, { items: [] }));
    renderPanel();
    // Every Astryx Button carries an empty status live region, so find ours by its text.
    expect(screen.getByText('Loading agenda…').closest('[role="status"]')).not.toBeNull();
    expect(await screen.findByText('Nothing on the agenda this month.')).toBeTruthy();
    expect(screen.queryByText('Loading agenda…')).toBeNull();
  });

  it('shows an error and keeps the calendar when the agenda cannot load', async () => {
    answer(json(500, { error: { code: 'server_error' } }));
    renderPanel();
    // Our alert by its text: a closing dialog from an earlier test can still hold its own.
    const message = await screen.findByText('The agenda could not be loaded.');
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText('Nothing on the agenda this month.')).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(calendar('September 2026')).toBeTruthy();
  });

  it('filters the list to the day that was clicked, and that day becomes the selected one', async () => {
    answer(json(200, { items: [EARLY, LATER, PICNIC] }));
    renderPanel();
    await screen.findByText('Later');
    // Today (Friday, September 18) starts as the selected day.
    expect(screen.getByRole('button', { name: 'Friday, September 18, 2026, selected' })).toBeTruthy();

    fireEvent.click(dayButton('Tuesday, September 22, 2026'));
    expect(screen.getByRole('button', { name: 'Tuesday, September 22, 2026, selected' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Friday, September 18, 2026, selected' })).toBeNull();
    expect(screen.getByText('Later')).toBeTruthy();
    expect(screen.queryByText('Early')).toBeNull();
    expect(screen.queryByText('Picnic')).toBeNull();
    expect(screen.queryByRole('list', { name: heading(20) })).toBeNull();
  });

  it('keeps the day filter while keyboard focus moves inside the month', async () => {
    answer(json(200, { items: [EARLY, LATER, PICNIC] }));
    renderPanel();
    await screen.findByText('Later');

    const user = userEvent.setup();
    await user.click(dayButton('Tuesday, September 22, 2026'));
    await user.keyboard('{ArrowRight}');
    // The arrow keys really moved focus (across the week too), and changed nothing else.
    expect(document.activeElement).toBe(dayButton('Wednesday, September 23, 2026'));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(dayButton('Wednesday, September 30, 2026'));
    expect(screen.getByText('Later')).toBeTruthy();
    expect(screen.queryByText('Early')).toBeNull();
    expect(screen.getByRole('button', { name: 'Tuesday, September 22, 2026, selected' })).toBeTruthy();
  });

  it('says so when the clicked day has nothing on it', async () => {
    answer(json(200, { items: [EARLY, LATER] }));
    renderPanel();
    await screen.findByText('Later');

    fireEvent.click(dayButton('Monday, September 21, 2026'));
    expect(line(`Nothing on ${heading(21)}.`)).toBe(true);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryByText('Nothing on the agenda this month.')).toBeNull();
  });

  it('asks for the month on screen, and pages to the next one', async () => {
    serveAgenda([EARLY, MONTH_END, HARVEST]);
    renderPanel();
    await screen.findByText('Early');
    // September 2026 is asked for from its 1st to the 1st of October.
    expect(lastUrl()).toBe(agendaUrl(new Date(2026, 8, 1), new Date(2026, 9, 1)));
    expect(screen.getByText('Month end')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(await screen.findByText('Harvest')).toBeTruthy();
    expect(lastUrl()).toBe(agendaUrl(new Date(2026, 9, 1), new Date(2026, 10, 1)));
    expect(calendar('October 2026')).toBeTruthy();
    // The list changed with the month: October's own event, none of September's.
    expect(screen.queryByText('Month end')).toBeNull();
    expect(screen.queryByText('Early')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(await screen.findByText('Early')).toBeTruthy();
    expect(calendar('September 2026')).toBeTruthy();
    expect(screen.queryByText('Harvest')).toBeNull();
  });

  it('says the month is empty when nothing falls in it', async () => {
    serveAgenda([EARLY]);
    renderPanel();
    await screen.findByText('Early');

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('Loading agenda…')).toBeTruthy();
    expect(await screen.findByText('Nothing on the agenda this month.')).toBeTruthy();
    expect(screen.queryByText('Early')).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('goes back to the whole month when the month changes under a picked day', async () => {
    serveAgenda([EARLY, HARVEST]);
    renderPanel();
    await screen.findByText('Early');
    fireEvent.click(dayButton('Monday, September 21, 2026'));
    expect(line(`Nothing on ${heading(21)}.`)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(await screen.findByText('Harvest')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Nothing on ');
  });

  it('refetches the same window in place when the tab comes back', async () => {
    serveAgenda([EARLY]);
    renderPanel();
    await screen.findByText('Early');
    const seen = fetchMock.mock.calls.length;
    const url = lastUrl();

    // Hold the refetch open: the list must stay on screen while it runs.
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    try {
      fireEvent(document, new Event('visibilitychange'));
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
    expect(fetchMock.mock.calls.length).toBe(seen + 1);
    expect(lastUrl()).toBe(url);
    expect(screen.getByText('Early')).toBeTruthy();
    expect(screen.queryByText('Loading agenda…')).toBeNull();
  });
});
