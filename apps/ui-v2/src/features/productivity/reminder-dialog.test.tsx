import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import type { ReminderSummary } from '@/features/productivity/use-reminders';
import type { Space } from '@/features/spaces/use-spaces';
import { audienceLabel, defaultWhen, ReminderDialog, ruleOf, type ReminderDialogTarget } from './reminder-dialog';

vi.mock('@/lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  useSession: () => ({ session: { user: { id: 'me', user_metadata: {} } } }),
  browserTimeZone: () => 'UTC',
}));

const member = (user_id: string, display_name: string): Space['members'][number] => ({
  user_id, role: 'member', joined_at: 0, display_name, handle: display_name.toLowerCase(), email: null,
});

const family: Space = {
  id: 's1', kind: 'group', name: 'Family', role: 'owner', membership_revision: 1, created_at: 0, updated_at: 0,
  members: [member('me', 'Alex'), member('u2', 'Sam'), member('u3', 'Kim')],
};

// #126 acceptance 1: daily 08:00 London over the October change.
const LONDON = [Date.UTC(2026, 9, 24, 7), Date.UTC(2026, 9, 25, 8), Date.UTC(2026, 9, 26, 8)];

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  // Fixtures name 2026-10-24 as the day; a real clock past it rolls the ring to the next day.
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 23, 12));
  // jsdom has no modal <dialog>; the Astryx Dialog calls these on open/close.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.removeAttribute('open');
  };
  fetchMock = vi.fn<typeof fetch>(async (input) => {
    if (String(input).startsWith('/api/reminders/preview')) {
      return json(200, { occurrences: LONDON.map((at, i) => ({ at, wall_time: `2026-10-2${4 + i}T08:00` })) });
    }
    return json(201, { reminder: {} });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderDialog(target: ReminderDialogTarget, onChanged = vi.fn(), onClose = vi.fn()): void {
  render(
    <Theme theme={neutralTheme}>
      <ReminderDialog target={target} onClose={onClose} onChanged={onChanged} />
    </Theme>,
  );
}

function writes(): Array<{ path: string; method: string; body: unknown }> {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method !== undefined)
    .map(([path, init]) => ({ path: String(path), method: String(init?.method), body: JSON.parse(String(init?.body)) }));
}

describe('ReminderDialog', () => {
  it('previews the next three rings before Save, then creates it for two members', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    renderDialog({ mode: 'create', spaces: [family], spaceId: 's1', day: '2026-10-24', zone: 'Europe/London', me: 'me' }, onChanged);
    await user.type(screen.getByRole('textbox', { name: /Title/ }), 'Bins out');
    await user.click(screen.getByRole('checkbox', { name: 'Sam' }));

    // #126 acceptance 4: the three dates render while nothing has been saved.
    await waitFor(() => expect(screen.getByText(/Oct 26, 2026/)).toBeTruthy());
    expect(screen.getByText(/Oct 24, 2026/)).toBeTruthy();
    expect(screen.getByText(/Oct 25, 2026/)).toBeTruthy();
    expect(writes()).toEqual([]);
    const preview = String(fetchMock.mock.calls.find(([p]) => String(p).startsWith('/api/reminders/preview'))?.[0]);
    expect(preview).toContain(`due=${Date.UTC(2026, 9, 24, 8)}`);
    expect(preview).toContain('zone=Europe%2FLondon');

    await user.click(screen.getByRole('button', { name: 'Save reminder' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes()).toEqual([{
      path: '/api/spaces/s1/reminders',
      method: 'POST',
      body: { title: 'Bins out', due_at: Date.UTC(2026, 9, 24, 8), due_zone: 'Europe/London', rrule: null, recipient_user_ids: ['me', 'u2'] },
    }]);
  });

  it('refuses to save with no one to remind', async () => {
    const user = userEvent.setup();
    renderDialog({ mode: 'create', spaces: [family], spaceId: 's1', day: '2026-10-24', zone: 'Europe/London', me: 'me' });
    await user.type(screen.getByRole('textbox', { name: /Title/ }), 'Bins out');
    await user.click(screen.getByRole('checkbox', { name: 'Me' }));
    expect(screen.getByText('Pick at least one person.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save reminder' }) as HTMLButtonElement).disabled
      || screen.getByRole('button', { name: 'Save reminder' }).getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('edits an hourly reminder in its own zone and keeps its waking window', async () => {
    const user = userEvent.setup();
    const reminder: ReminderSummary = {
      id: 'r1', space_id: 's1', title: 'Water', due_at: Date.UTC(2026, 9, 24, 7), due_zone: 'Europe/London',
      rrule: { freq: 'hourly', interval: 2, window: { start: '08:00', end: '20:00' } }, status: 'active',
    };
    renderDialog({ mode: 'edit', reminder, zone: 'Europe/London' });
    expect(screen.getByRole('heading', { name: 'Edit reminder' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Sam' })).toBeNull();
    await user.clear(screen.getByRole('textbox', { name: /Title/ }));
    await user.type(screen.getByRole('textbox', { name: /Title/ }), 'Drink water');
    await user.click(screen.getByRole('button', { name: 'Save reminder' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      path: '/api/reminders/r1',
      method: 'PATCH',
      body: { title: 'Drink water', due_at: Date.UTC(2026, 9, 24, 7), due_zone: 'Europe/London', rrule: reminder.rrule },
    });
  });
});

describe('ReminderDialog defaults', () => {
  const personal: Space = { ...family, id: 's0', kind: 'private', name: 'Private', members: [member('me', 'Alex')] };

  it('a new reminder is private unless a space is picked', () => {
    renderDialog({ mode: 'create', spaces: [family, personal], day: '2026-10-24', zone: 'Europe/London', me: 'me', now: Date.UTC(2026, 9, 24, 6) });
    expect(screen.getByRole('combobox', { name: /Space/ }).textContent).toContain('Private');
    expect(screen.queryByRole('checkbox', { name: 'Sam' })).toBeNull();
  });

  it('defaults to 9:00 AM while that is still ahead, else the next half-hour, never a past time', () => {
    expect(defaultWhen('2026-10-24', 'Europe/London', Date.UTC(2026, 9, 24, 6))).toBe('2026-10-24T09:00');
    // 14:10 London (13:10Z, BST) → 14:30, not 09:00 that already went by.
    expect(defaultWhen('2026-10-24', 'Europe/London', Date.UTC(2026, 9, 24, 13, 10))).toBe('2026-10-24T14:30');
    expect(defaultWhen('2026-10-24', 'Europe/London', Date.UTC(2026, 9, 24, 13, 30))).toBe('2026-10-24T15:00');
    // A past day picked on the calendar still gets a time to come.
    expect(defaultWhen('2026-10-20', 'Europe/London', Date.UTC(2026, 9, 24, 13, 10))).toBe('2026-10-24T14:30');
  });

  it('Edit shows who gets the reminder', () => {
    const reminder: ReminderSummary = {
      id: 'r1', space_id: 's1', title: 'Bins', due_at: Date.UTC(2026, 9, 24, 7), due_zone: 'Europe/London', rrule: null, status: 'active',
      recipient_user_ids: ['me', 'u2'],
    };
    renderDialog({ mode: 'edit', reminder, zone: 'Europe/London', space: family, me: 'me' });
    expect(screen.getByText('Who gets it')).toBeTruthy();
    expect(screen.getByText('You, Sam')).toBeTruthy();
    expect(audienceLabel({ ...reminder, recipient_user_ids: undefined }, family, 'me')).toBe('People in Family');
    expect(audienceLabel(reminder, personal, 'me')).toBe('Only you');
  });
});

describe('ruleOf', () => {
  it('turns the repeat choice into the API rule', () => {
    const base = { every: 3, from: '08:00', until: '22:00' };
    expect(ruleOf({ ...base, repeat: 'none' })).toBeNull();
    expect(ruleOf({ ...base, repeat: 'weekdays' })).toEqual({ freq: 'weekly', byWeekday: [1, 2, 3, 4, 5] });
    expect(ruleOf({ ...base, repeat: 'hourly' })).toEqual({ freq: 'hourly', interval: 3, window: { start: '08:00', end: '22:00' } });
    expect(ruleOf({ ...base, repeat: 'monthly' })).toEqual({ freq: 'monthly' });
  });
});
