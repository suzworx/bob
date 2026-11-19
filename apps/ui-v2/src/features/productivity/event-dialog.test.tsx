import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import type { AgendaItem } from '@/features/productivity/use-agenda';
import type { Attendee, EventSummary } from '@/features/productivity/use-events';
import type { Space } from '@/features/spaces/use-spaces';
import { AgendaPanel } from './agenda-panel';
import { toggleAllDay } from './event-dialog';

vi.mock('@/lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  useSession: () => ({ session: { user: { id: 'u-self' } } }),
  browserTimeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
}));

// jsdom has no modal <dialog>; the Astryx dialog calls showModal() on open.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

const SPACE: Space = {
  id: 'space-1',
  kind: 'group',
  name: 'Home',
  role: 'owner',
  membership_revision: 1,
  created_at: 1,
  updated_at: 1,
  members: [],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let calendars: Array<{ id: string }>;
let createdEventBody: unknown;
let createdCalendarBody: unknown;
let eventsStatus: number;
let agendaItems: AgendaItem[];
let eventBody: EventSummary;
let eventStatus: number;
let getEventCalls: number;
let patchStatus: number;
let patchBody: unknown;
let deleteStatus: number;
let deleteBody: unknown;
type MemberFixture = {
  user_id: string;
  role: string;
  joined_at: number;
  display_name?: string | null;
  handle?: string;
  email?: string | null;
};
let memberFixtures: MemberFixture[];
let attendees: Attendee[];
let attendeesStatus: number;
let addAttendeeStatus: number;
let addedAttendeeBody: unknown;
let removedAttendeeUserId: string | null;
let rsvpBody: unknown;

const PAST_DATE_WARNING = 'This date is in the past. You can still save it.';
const START = new Date(2026, 8, 18, 9, 0).getTime();
const END = new Date(2026, 8, 18, 10, 0).getTime();

const EVENT: EventSummary = {
  id: 'evt_1',
  calendar_id: 'cal_1',
  space_id: 'space-1',
  uid: 'u1',
  sequence: 0,
  organizer_user_id: 'u-self',
  title: 'Standup',
  location: null,
  body: null,
  all_day: false,
  start_date: null,
  end_date: null,
  start_at: START,
  end_at: END,
  zone: 'UTC',
  rrule: null,
  status: 'confirmed',
  revision: 3,
  created_at: 1,
  updated_at: 1,
};

const AGENDA_ITEM: AgendaItem = {
  event_id: 'evt_1',
  uid: 'u1',
  title: 'Standup',
  location: null,
  body: null,
  all_day: false,
  start_date: null,
  end_date: null,
  start_at: START,
  end_at: END,
  zone: 'UTC',
  original_occurrence_start: START,
  cancelled: false,
  moved: false,
  calendar_id: 'cal_1',
  space_id: 's1',
  origin: 'native',
  pending: false,
  // EVENT.organizer_user_id defaults to 'u-self' (the signed-in user), so the
  // Edit button is reachable in every test that opens the dialog through it.
  can_edit: true,
};

/** Routes every request the panel + dialog can make: agenda reads, the
 *  calendars lookup/create, the events create, and one event's read/patch/delete. */
function route(): void {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/agenda')) return json(200, { items: agendaItems });
    if (url === '/api/spaces/space-1/calendars' && method === 'GET') {
      return json(200, { calendars });
    }
    if (url === '/api/spaces/space-1/calendars' && method === 'POST') {
      createdCalendarBody = JSON.parse(String(init?.body));
      calendars = [{ id: 'cal-new' }];
      return json(200, { id: 'cal-new' });
    }
    if (url.startsWith('/api/calendars/') && url.endsWith('/events') && method === 'POST') {
      createdEventBody = JSON.parse(String(init?.body));
      return json(eventsStatus, { id: 'evt-new' });
    }
    if (url === '/api/events/evt_1' && method === 'GET') {
      getEventCalls += 1;
      return json(eventStatus, eventBody);
    }
    if (url === '/api/events/evt_1' && method === 'PATCH') {
      patchBody = JSON.parse(String(init?.body));
      if (patchStatus === 409) eventBody = { ...eventBody, revision: 4 };
      return json(patchStatus, eventBody);
    }
    if (url === '/api/events/evt_1' && method === 'DELETE') {
      deleteBody = JSON.parse(String(init?.body));
      return json(deleteStatus, eventBody);
    }
    if (url === '/api/spaces/space-1/members' && method === 'GET') {
      return json(200, { members: memberFixtures });
    }
    if (url === '/api/spaces/space-1/invitations' && method === 'GET') {
      return json(403, { error: { code: 'forbidden' } });
    }
    if (url === '/api/events/evt_1/attendees' && method === 'GET') {
      if (attendeesStatus !== 200) return json(attendeesStatus, {});
      return json(200, { attendees });
    }
    if (url === '/api/events/evt_1/attendees' && method === 'POST') {
      addedAttendeeBody = JSON.parse(String(init?.body));
      if (addAttendeeStatus !== 201) return json(addAttendeeStatus, { error: { code: 'x' } });
      const created: Attendee = {
        event_id: 'evt_1',
        user_id: (addedAttendeeBody as { user_id: string }).user_id,
        email: null,
        response: 'needs_action',
        role: 'required',
      };
      attendees = [...attendees, created];
      return json(201, created);
    }
    if (url.startsWith('/api/events/evt_1/attendees?user_id=') && method === 'DELETE') {
      removedAttendeeUserId = new URL(url, 'http://local').searchParams.get('user_id');
      attendees = attendees.filter((attendee) => attendee.user_id !== removedAttendeeUserId);
      return new Response(null, { status: 204 });
    }
    if (url === '/api/events/evt_1/rsvp' && method === 'PUT') {
      rsvpBody = JSON.parse(String(init?.body));
      const response = (rsvpBody as { response: Attendee['response'] }).response;
      const updated: Attendee = { event_id: 'evt_1', user_id: 'u-self', email: null, response, role: 'required' };
      attendees = attendees.map((attendee) => (attendee.user_id === 'u-self' ? updated : attendee));
      return json(200, updated);
    }
    throw new Error(`unrouted: ${method} ${url}`);
  });
}

function renderPanel(space: Space | null = SPACE): void {
  render(
    <Theme theme={neutralTheme} mode="system">
      <AgendaPanel space={space} />
    </Theme>,
  );
}

/** The Calendar's grid, named by the month it shows. */
function dayButton(date: string): HTMLElement {
  return within(screen.getByRole('grid')).getByRole('button', { name: new RegExp(`^${date}(,|$)`) });
}

async function openNewEvent(): Promise<HTMLElement> {
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole('button', { name: 'New event' }));
  return screen.findByRole('dialog', { name: 'New event' });
}

/** Opens the edit dialog for a native agenda row by its title, and waits past
 *  the "Loading event…" state so the form is ready to interact with. */
async function openEditEvent(title: string): Promise<HTMLElement> {
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole('button', { name: `Edit ${title}` }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit event' });
  await within(dialog).findByLabelText('Title');
  return dialog;
}

/** Opens the read-only view dialog for a native agenda row the caller cannot
 *  edit, by its title on the "Details" button. The dialog's own accessible
 *  name is the event's title, known from the agenda item before the load
 *  even resolves. */
async function openViewEvent(title: string): Promise<HTMLElement> {
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole('button', { name: `Details ${title}` }));
  return screen.findByRole('dialog', { name: title });
}

function agendaCallCount(): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/agenda')).length;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 18, 12, 0));
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  calendars = [];
  createdEventBody = undefined;
  createdCalendarBody = undefined;
  eventsStatus = 200;
  agendaItems = [];
  eventBody = { ...EVENT };
  eventStatus = 200;
  getEventCalls = 0;
  patchStatus = 200;
  patchBody = undefined;
  deleteStatus = 200;
  deleteBody = undefined;
  memberFixtures = [
    { user_id: 'u-self', role: 'owner', joined_at: 1, display_name: 'Me', handle: 'me' },
    { user_id: 'u-olive', role: 'member', joined_at: 2, display_name: 'Olive', handle: 'olive' },
  ];
  attendees = [];
  attendeesStatus = 200;
  addAttendeeStatus = 201;
  addedAttendeeBody = undefined;
  removedAttendeeUserId = null;
  rsvpBody = undefined;
  route();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Every fetch call as "METHOD url", minus the agenda polling the panel does
 *  on its own -- so a test can assert the calendar/event call sequence alone. */
function nonAgendaCalls(): string[] {
  return fetchMock.mock.calls
    .map(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`)
    .filter((call) => !call.includes('/api/agenda'));
}

describe('EventDialog', () => {
  it('shows no New event button without a space', async () => {
    renderPanel(null);
    await screen.findByText('Nothing on the agenda this month.');
    expect(screen.queryByRole('button', { name: 'New event' })).toBeNull();
  });

  it('creates a timed event on the prefilled day, creating a default calendar first', async () => {
    renderPanel();
    const dialog = await openNewEvent();
    const user = userEvent.setup({ delay: null });
    await user.type(within(dialog).getByLabelText('Title'), 'Dinner');
    await user.click(within(dialog).getByRole('button', { name: 'Save event' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New event' })).toBeNull());
    expect(nonAgendaCalls()).toEqual([
      'GET /api/spaces/space-1/calendars',
      'POST /api/spaces/space-1/calendars',
      'POST /api/calendars/cal-new/events',
    ]);
    expect(createdCalendarBody).toEqual({ name: 'Family', zone: expect.any(String) });
    expect(createdEventBody).toMatchObject({
      title: 'Dinner',
      all_day: false,
      start_at: new Date(2026, 8, 18, 9, 0).getTime(),
      end_at: new Date(2026, 8, 18, 10, 0).getTime(),
    });
  });

  it('reuses an existing calendar instead of creating one', async () => {
    calendars = [{ id: 'cal-existing' }];
    renderPanel();
    const dialog = await openNewEvent();
    const user = userEvent.setup({ delay: null });
    await user.type(within(dialog).getByLabelText('Title'), 'Dinner');
    await user.click(within(dialog).getByRole('button', { name: 'Save event' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New event' })).toBeNull());
    expect(nonAgendaCalls()).toEqual(['GET /api/spaces/space-1/calendars', 'POST /api/calendars/cal-existing/events']);
  });

  it('sends calendar dates and no instants for an all-day event', async () => {
    renderPanel();
    const dialog = await openNewEvent();
    const user = userEvent.setup({ delay: null });
    await user.type(within(dialog).getByLabelText('Title'), 'Trip');
    await user.click(within(dialog).getByRole('switch', { name: 'All day' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save event' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New event' })).toBeNull());
    expect(createdEventBody).toMatchObject({ all_day: true, start_date: '2026-09-18', end_date: '2026-09-19' });
    expect(createdEventBody).not.toHaveProperty('start_at');
    expect(createdEventBody).not.toHaveProperty('end_at');
  });

  it('prefills the day picked in the calendar grid first', async () => {
    renderPanel();
    await screen.findByText('Nothing on the agenda this month.');
    await userEvent.setup({ delay: null }).click(dayButton('Tuesday, September 22, 2026'));

    const dialog = await openNewEvent();
    const value = (label: string): string => (within(dialog).getByLabelText(label) as HTMLInputElement).value;
    expect(value('Starts')).toBe('September 22, 2026');
    expect(value('Starts time')).toBe('9:00 AM');
    expect(value('Ends')).toBe('September 22, 2026');
    expect(value('Ends time')).toBe('10:00 AM');
  });

  it('disables Save with an empty title, and keeps the draft after a failed save', async () => {
    renderPanel();
    const dialog = await openNewEvent();
    const saveButton = (): HTMLButtonElement => within(dialog).getByRole('button', { name: 'Save event' }) as HTMLButtonElement;
    expect(saveButton().disabled).toBe(true);

    const user = userEvent.setup({ delay: null });
    await user.type(within(dialog).getByLabelText('Title'), 'Dinner');
    expect(saveButton().disabled).toBe(false);

    eventsStatus = 500;
    await user.click(saveButton());

    // Every Astryx date field carries its own always-mounted, empty aria-live
    // alert region, so the banner is found by its text rather than its role.
    expect(await within(dialog).findByText('The event could not be saved.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'New event' })).toBeTruthy();
    expect((within(dialog).getByLabelText('Title') as HTMLInputElement).value).toBe('Dinner');
  });

  it('#863: warns, without blocking, when the new event starts on a past date', async () => {
    renderPanel();
    await screen.findByText('Nothing on the agenda this month.');
    const user = userEvent.setup({ delay: null });
    await user.click(dayButton('Tuesday, September 15, 2026'));
    const dialog = await openNewEvent();
    expect(within(dialog).getByText(PAST_DATE_WARNING)).toBeTruthy();

    await user.click(within(dialog).getByRole('switch', { name: 'All day' }));
    expect(within(dialog).getByText(PAST_DATE_WARNING)).toBeTruthy();

    await user.type(within(dialog).getByLabelText('Title'), 'Dentist');
    await user.click(within(dialog).getByRole('button', { name: 'Save event' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New event' })).toBeNull());
    expect(createdEventBody).toMatchObject({ title: 'Dentist', start_date: '2026-09-15' });
  });

  it('#863: no past-date warning for an event today, even at an earlier hour', async () => {
    renderPanel();
    const dialog = await openNewEvent();
    expect(within(dialog).queryByText(PAST_DATE_WARNING)).toBeNull();
  });

  it('closes on Cancel without posting anything', async () => {
    renderPanel();
    const dialog = await openNewEvent();
    await userEvent.setup({ delay: null }).click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New event' })).toBeNull());
    expect(createdEventBody).toBeUndefined();
    expect(createdCalendarBody).toBeUndefined();
  });
});

describe('EventDialog: edit', () => {
  it('shows an Edit button on a native row but not a google-origin row', async () => {
    agendaItems = [AGENDA_ITEM, { ...AGENDA_ITEM, event_id: 'evt_2', title: 'Sync', origin: 'google' }];
    renderPanel();
    await screen.findByText('Standup');
    expect(screen.getByRole('button', { name: 'Edit Standup' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Sync' })).toBeNull();
  });

  it('edits a non-recurring event with the whole-series scope, refetches the agenda, and closes', async () => {
    agendaItems = [AGENDA_ITEM];
    renderPanel();
    const dialog = await openEditEvent('Standup');
    const before = agendaCallCount();
    const user = userEvent.setup({ delay: null });
    const title = within(dialog).getByLabelText('Title') as HTMLInputElement;
    await user.clear(title);
    await user.type(title, 'Standup v2');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit event' })).toBeNull());
    expect(patchBody).toEqual({ revision: 3, scope: 'series', patch: { title: 'Standup v2' } });
    expect(agendaCallCount()).toBeGreaterThan(before);
  });

  it('turning All day on keeps the event\'s own date instead of sending empty dates', async () => {
    agendaItems = [AGENDA_ITEM];
    renderPanel();
    const dialog = await openEditEvent('Standup');
    const user = userEvent.setup({ delay: null });
    await user.click(within(dialog).getByRole('switch', { name: 'All day' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patchBody).toBeDefined());
    const day = toggleAllDay(
      { title: '', allDay: false, startLocal: '2026-09-18T09:00', endLocal: '2026-09-18T10:00', startDate: '', endDateInclusive: '', location: '', notes: '' },
      true,
    );
    expect(day).toMatchObject({ allDay: true, startDate: '2026-09-18', endDateInclusive: '2026-09-18' });
    expect(JSON.stringify(patchBody)).toContain('"all_day":true');
    expect(JSON.stringify(patchBody)).toContain('"start_date":"2026-09-18"');
    expect(JSON.stringify(patchBody)).not.toContain('"start_date":""');
  });

  it('requires a scope before saving a recurring event, locks times for a series edit, and drops this_and_following from the edit step', async () => {
    agendaItems = [AGENDA_ITEM];
    eventBody = { ...EVENT, rrule: { freq: 'weekly' } };
    renderPanel();
    const dialog = await openEditEvent('Standup');
    const user = userEvent.setup({ delay: null });
    const saveButton = (): HTMLButtonElement => within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;

    const title = within(dialog).getByLabelText('Title') as HTMLInputElement;
    await user.clear(title);
    await user.type(title, 'Standup v2');
    expect(saveButton().disabled).toBe(true);
    expect(within(dialog).queryByRole('radio', { name: /later/i })).toBeNull();

    await user.click(within(dialog).getByRole('radio', { name: 'Every event in the series' }));
    expect(within(dialog).getByLabelText('Starts').getAttribute('aria-disabled')).toBe('true');

    await user.click(within(dialog).getByRole('radio', { name: 'Only this event' }));
    expect(within(dialog).getByLabelText('Starts').getAttribute('aria-disabled')).not.toBe('true');
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    expect(patchBody).toEqual({
      revision: 3,
      scope: 'this',
      occurrence_start: START,
      patch: { title: 'Standup v2' },
    });
  });

  it('shows a conflict banner, keeps the edited draft, and resends with the fresh revision', async () => {
    agendaItems = [AGENDA_ITEM];
    patchStatus = 409;
    renderPanel();
    const dialog = await openEditEvent('Standup');
    const user = userEvent.setup({ delay: null });
    const title = within(dialog).getByLabelText('Title') as HTMLInputElement;
    await user.clear(title);
    await user.type(title, 'Standup v2');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await within(dialog).findByText(/Someone changed this event while you were editing/);
    expect(title.value).toBe('Standup v2');
    expect(getEventCalls).toBe(2);
    expect(patchBody).toMatchObject({ revision: 3 });

    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(patchBody).toMatchObject({ revision: 4 });
  });

  it('deletes a non-recurring event as a whole, and Back returns to the form without a request', async () => {
    agendaItems = [AGENDA_ITEM];
    renderPanel();
    const dialog = await openEditEvent('Standup');
    const user = userEvent.setup({ delay: null });
    await user.click(within(dialog).getByRole('button', { name: 'Delete event' }));
    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).getByLabelText('Title')).toBeTruthy();
    expect(deleteBody).toBeUndefined();

    await user.click(within(dialog).getByRole('button', { name: 'Delete event' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteBody).toEqual({ scope: 'series' });
  });

  it('sends this_and_following with the occurrence start on a recurring delete', async () => {
    agendaItems = [AGENDA_ITEM];
    eventBody = { ...EVENT, rrule: { freq: 'weekly' } };
    renderPanel();
    const dialog = await openEditEvent('Standup');
    const user = userEvent.setup({ delay: null });
    await user.click(within(dialog).getByRole('button', { name: 'Delete event' }));
    await user.click(within(dialog).getByRole('radio', { name: /This and every later event/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteBody).toEqual({ scope: 'this_and_following', occurrence_start: START });
  });
});

describe('EventDialog: people', () => {
  it('a failed attendee list says so with Retry, never "No one invited yet"', async () => {
    agendaItems = [AGENDA_ITEM];
    attendeesStatus = 500;
    renderPanel();
    const dialog = await openEditEvent('Standup');
    expect(await within(dialog).findByText("Who's invited could not be loaded.")).toBeTruthy();
    expect(within(dialog).queryByText('No one invited yet.')).toBeNull();

    attendeesStatus = 200;
    attendees = [{ event_id: 'evt_1', user_id: 'u-self', email: null, response: 'accepted', role: 'required' }];
    const user = userEvent.setup({ delay: null });
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByText('Me')).toBeTruthy();
  });

  it('organizer: attendees show by member name with their RSVP token, and inviting a member adds them', async () => {
    agendaItems = [AGENDA_ITEM];
    attendees = [{ event_id: 'evt_1', user_id: 'u-self', email: null, response: 'accepted', role: 'required' }];
    renderPanel();
    const dialog = await openEditEvent('Standup');
    await within(dialog).findByText('Me');
    const peopleList = within(dialog).getByRole('list');
    expect(within(peopleList).getByText('Going')).toBeTruthy();

    const user = userEvent.setup({ delay: null });
    await user.click(within(dialog).getByRole('combobox', { name: 'Invite someone' }));
    await user.click(await screen.findByRole('option', { name: 'Olive' }));

    await waitFor(() => expect(addedAttendeeBody).toEqual({ user_id: 'u-olive', role: 'required' }));
    await within(peopleList).findByText('Olive');
    expect(within(peopleList).getByText('Invited')).toBeTruthy();
  });

  it('"Remove Olive" sends a DELETE with her user id as a query param', async () => {
    agendaItems = [AGENDA_ITEM];
    attendees = [
      { event_id: 'evt_1', user_id: 'u-self', email: null, response: 'accepted', role: 'required' },
      { event_id: 'evt_1', user_id: 'u-olive', email: null, response: 'needs_action', role: 'required' },
    ];
    renderPanel();
    const dialog = await openEditEvent('Standup');
    await within(dialog).findByText('Olive');

    await userEvent.setup({ delay: null }).click(within(dialog).getByRole('button', { name: 'Remove Olive' }));

    await waitFor(() => expect(removedAttendeeUserId).toBe('u-olive'));
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === '/api/events/evt_1/attendees?user_id=u-olive' &&
          (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('not the organizer: no invite control, no remove buttons, and the note is shown', async () => {
    agendaItems = [{ ...AGENDA_ITEM, can_edit: false }];
    eventBody = { ...EVENT, organizer_user_id: 'u-other' };
    attendees = [{ event_id: 'evt_1', user_id: 'u-olive', email: null, response: 'accepted', role: 'required' }];
    renderPanel();
    const dialog = await openViewEvent('Standup');
    await within(dialog).findByText('Olive');

    expect(within(dialog).queryByRole('combobox', { name: 'Invite someone' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Remove Olive' })).toBeNull();
    expect(within(dialog).getByText("Only the organizer can change who's invited.")).toBeTruthy();
  });

  it('an attendee with needs_action sees Your answer and setting it PUTs the response', async () => {
    agendaItems = [{ ...AGENDA_ITEM, can_edit: false }];
    attendees = [{ event_id: 'evt_1', user_id: 'u-self', email: null, response: 'needs_action', role: 'required' }];
    renderPanel();
    const dialog = await openViewEvent('Standup');
    const control = await within(dialog).findByRole('radiogroup', { name: 'Your answer' });

    await userEvent.setup({ delay: null }).click(within(control).getByRole('radio', { name: 'Going' }));
    await waitFor(() => expect(rsvpBody).toEqual({ response: 'accepted' }));
  });

  it('a non-attendee sees no Your answer control', async () => {
    agendaItems = [{ ...AGENDA_ITEM, can_edit: false }];
    attendees = [];
    renderPanel();
    const dialog = await openViewEvent('Standup');
    await within(dialog).findByText('No one invited yet.');
    expect(within(dialog).queryByRole('radiogroup', { name: 'Your answer' })).toBeNull();
  });

  it('the view dialog has no Save, no Delete, and no text inputs', async () => {
    agendaItems = [{ ...AGENDA_ITEM, can_edit: false }];
    attendees = [];
    renderPanel();
    const dialog = await openViewEvent('Standup');
    await within(dialog).findByText('No one invited yet.');

    expect(within(dialog).queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Delete event' })).toBeNull();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });

  it('#873: a space owner who cannot edit can still delete from the view dialog', async () => {
    agendaItems = [{ ...AGENDA_ITEM, can_edit: false, can_delete: true }];
    eventBody = { ...EVENT, organizer_user_id: 'u-olive' };
    renderPanel();
    const dialog = await openViewEvent('Standup');
    const user = userEvent.setup({ delay: null });
    await user.click(await within(dialog).findByRole('button', { name: 'Delete event' }));
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteBody).toEqual({ scope: 'series' });
  });

  it('shows the occurrence\'s title and location from the agenda item, not the recurring master', async () => {
    agendaItems = [{ ...AGENDA_ITEM, title: 'Swim at school', location: 'School pool', can_edit: false }];
    eventBody = { ...EVENT, title: 'Swim', location: 'Leisure centre' };
    attendees = [];
    renderPanel();
    const dialog = await openViewEvent('Swim at school');
    await within(dialog).findByText('No one invited yet.');

    expect(within(dialog).getByRole('heading', { name: 'Swim at school' })).toBeTruthy();
    expect(within(dialog).getByText('School pool')).toBeTruthy();
    expect(within(dialog).queryByRole('heading', { name: 'Swim' })).toBeNull();
    expect(within(dialog).queryByText('Leisure centre')).toBeNull();
  });

  it('offers a member with only a handle as @handle in the invite list, never their email', async () => {
    agendaItems = [AGENDA_ITEM];
    memberFixtures = [
      { user_id: 'u-self', role: 'owner', joined_at: 1, display_name: 'Me', handle: 'me' },
      { user_id: 'u-nick', role: 'member', joined_at: 2, display_name: null, handle: 'nick', email: 'nick@example.com' },
    ];
    renderPanel();
    const dialog = await openEditEvent('Standup');
    await userEvent.setup({ delay: null }).click(within(dialog).getByRole('combobox', { name: 'Invite someone' }));

    expect(await screen.findByRole('option', { name: '@nick' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /nick@example\.com/ })).toBeNull();
  });

  it('never shows a matched attendee\'s own email, even when their display name is blank', async () => {
    agendaItems = [AGENDA_ITEM];
    memberFixtures = [
      { user_id: 'u-self', role: 'owner', joined_at: 1, display_name: 'Me', handle: 'me' },
      { user_id: 'u-nick', role: 'member', joined_at: 2, display_name: null, handle: 'nick', email: 'nick@example.com' },
    ];
    attendees = [
      { event_id: 'evt_1', user_id: 'u-nick', email: 'nick@example.com', response: 'needs_action', role: 'required' },
    ];
    renderPanel();
    const dialog = await openEditEvent('Standup');

    expect(await within(dialog).findByText('@nick')).toBeTruthy();
    expect(within(dialog).queryByText('nick@example.com')).toBeNull();
  });

  it('shows an unmatched invitee by their own email', async () => {
    agendaItems = [AGENDA_ITEM];
    attendees = [
      { event_id: 'evt_1', user_id: 'u-left', email: 'left@example.com', response: 'needs_action', role: 'required' },
    ];
    renderPanel();
    const dialog = await openEditEvent('Standup');

    expect(await within(dialog).findByText('left@example.com')).toBeTruthy();
  });

  it('shows Someone for an unmatched invitee with no email, never an id fragment', async () => {
    agendaItems = [AGENDA_ITEM];
    attendees = [
      { event_id: 'evt_1', user_id: 'u-0123456789abcdef', email: null, response: 'needs_action', role: 'required' },
    ];
    renderPanel();
    const dialog = await openEditEvent('Standup');

    expect(await within(dialog).findByText('Someone')).toBeTruthy();
    expect(within(dialog).queryByText(/u-0123456789abcdef|u-01234567…/)).toBeNull();
  });

  it('a 403 adding an attendee shows the organizer-only banner', async () => {
    agendaItems = [AGENDA_ITEM];
    attendees = [];
    addAttendeeStatus = 403;
    renderPanel();
    const dialog = await openEditEvent('Standup');
    const user = userEvent.setup({ delay: null });
    await user.click(await within(dialog).findByRole('combobox', { name: 'Invite someone' }));
    await user.click(await screen.findByRole('option', { name: 'Olive' }));

    expect(await within(dialog).findByText("Only the organizer can change who's invited.")).toBeTruthy();
  });
});
