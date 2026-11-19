/**
 * #550 flows on /calendar: create, snooze and cancel a reminder; a running
 * timer counts down and is cancelled. The reminder is made for TOMORROW 09:00
 * (the dialog's default time on the selected day), so it is always in the
 * future and never rings during the run. The timer has no create endpoint
 * (only the AI tools make one), so seed.timer() inserts its own row in the
 * local database and deletes that row afterwards.
 */
import type { APIRequestContext } from '@playwright/test';
import { expect, ok, test } from './fixtures.ts';
import { menuItem } from './components/menu.ts';

/** Cancels every live reminder titled `title` in the account's spaces (the test's own undo). */
async function cancelRemindersTitled(api: APIRequestContext, title: string): Promise<void> {
  const spaces = (await (await api.get('/api/spaces')).json()) as { spaces: Array<{ id: string }> };
  for (const space of spaces.spaces) {
    const list = (await (await api.get(`/api/spaces/${space.id}/reminders`)).json()) as {
      reminders?: Array<{ id: string; title: string; status?: string }>;
    };
    for (const reminder of list.reminders ?? []) {
      if (reminder.title !== title || reminder.status === 'cancelled') continue;
      await ok('cancel reminder', await api.post(`/api/reminders/${reminder.id}/cancel`));
    }
  }
}

// "New reminder" needs a Space; a brand-new account has none until its first
// chat turn, so every test seeds one (seed.space()).
test.beforeEach(async ({ seed }) => {
  await seed.space();
});

test('the calendar loads with its month grid', { tag: '@smoke' }, async ({ page, calendarPage }) => {
  await calendarPage.goto();
  await expect(calendarPage.heading).toBeVisible();
  await expect(calendarPage.days.first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeVisible();
});

test('create, snooze and cancel a reminder', async ({ page, calendarPage, tag, api, cleanup }) => {
  const title = `Water the plants ${tag}`;
  cleanup(() => cancelRemindersTitled(api, title));
  await calendarPage.goto();
  await calendarPage.selectTomorrow();

  // One "New" menu (Task, Reminder, Event); the reminder defaults to Private.
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await menuItem(page, 'Reminder').click();
  await calendarPage.reminderDialog.getByLabel('Title').fill(title);
  await calendarPage.reminderDialog.getByRole('button', { name: 'Save reminder' }).click();
  await expect(calendarPage.reminderDialog).toHaveCount(0);
  await expect(calendarPage.reminderActions(title)).toBeVisible();
  // textContent, the same text toHaveText compares: innerText skips the
  // row's visually hidden text, so it never equals toHaveText's reading and
  // the wait below would pass before the snoozed row (a new occurrence, so
  // a new row) had even loaded.
  const before = (await calendarPage.reminderRow(title).textContent()) ?? '';

  // Snooze is a submenu, counted from now, confirmed by a toast.
  await calendarPage.reminderActions(title).first().click();
  await menuItem(page, 'Snooze').click();
  await menuItem(page, '1 hour').click();
  // Scoped to the toast viewport: Astryx also mirrors toast text into a hidden live region.
  const notifications = page.getByRole('region', { name: 'Notifications' });
  await expect(notifications.getByText(/^Snoozed until/)).toBeVisible();
  await expect(calendarPage.snoozeError).toHaveCount(0);
  // Snooze counts from now, so the reminder leaves tomorrow for today (or, in the
  // last hour of the day, a later time tomorrow). Find it on whichever day it landed.
  const landed = async (): Promise<boolean> =>
    calendarPage.reminderActions(title).first().waitFor({ timeout: 3_000 }).then(() => true, () => false);
  await expect
    .poll(
      async () => {
        await calendarPage.goto();
        if (await landed()) return 'today';
        await calendarPage.selectTomorrow();
        if (!(await landed())) return 'missing';
        return (await calendarPage.reminderRow(title).first().textContent()) ?? 'missing';
      },
      { timeout: 30_000 },
    )
    .not.toMatch(new RegExp(`^(missing|${before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`));

  // A private reminder is cancelled at once, with Undo; no confirmation.
  await calendarPage.reminderActions(title).first().click();
  await menuItem(page, 'Cancel reminder').click();
  await expect(calendarPage.reminderActions(title)).toHaveCount(0);
  await expect(notifications.getByText(`Cancelled ${title}`)).toBeVisible();
  await expect(calendarPage.cancelError).toHaveCount(0);
});

// On a month's last day tomorrow is an outside (next-month) cell, which the
// grid will not select; selectTomorrow() must page on to next month. The
// browser clock is pinned to a month end so this runs any day, selection only.
// It is LAST month's end: the dev sign-in token expires against the browser's
// Date.now(), so a clock in the future would sign the page out.
test('tomorrow on the last day of a month is day 1 of the next', async ({ page, calendarPage }) => {
  const now = new Date();
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 10);
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 10);
  const iso = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  await page.clock.install({ time: monthEnd });
  await calendarPage.goto();
  await expect(calendarPage.selectedDay()).toHaveAttribute('data-date', iso(monthEnd));

  await calendarPage.selectTomorrow();
  await expect(calendarPage.selectedDay()).toHaveAttribute('data-date', iso(firstOfMonth));
});

test('a running timer counts down and can be cancelled', async ({ page, calendarPage, tag, seed }) => {
  await seed.timer(tag, 10);

  // Running timers live on Today, the one to-do place.
  await page.goto('/today');
  const countdown = calendarPage.countdown(tag);
  await expect(countdown).toHaveText(/ left$/);
  const first = await countdown.innerText();
  await expect(countdown).not.toHaveText(first, { timeout: 5_000 });

  await calendarPage.cancelTimer(tag);
  await expect(calendarPage.timer(tag)).toHaveCount(0);
  await expect(calendarPage.timerCancelError).toHaveCount(0);
});
