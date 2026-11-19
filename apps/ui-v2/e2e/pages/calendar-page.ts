/**
 * #550: /calendar -- the day's tasks, events and reminders, the one "New" menu
 * (Task, Reminder, Event), the reminder dialog and row menu (Snooze is a
 * submenu), and the running timers.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { menuItem } from '../components/menu.ts';

export type SnoozeChoice = '10 minutes' | '1 hour' | 'Tomorrow 9:00 AM';

export class CalendarPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly days: Locator;
  /** The one "New" menu button: Task, Reminder, Event. */
  readonly newButton: Locator;
  readonly reminderDialog: Locator;
  readonly snoozeError: Locator;
  readonly cancelError: Locator;
  readonly timerCancelError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { level: 1, name: 'Calendar' });
    this.days = page.locator('.astryx-calendar-day');
    this.newButton = page.getByRole('button', { name: 'New', exact: true });
    this.reminderDialog = page.getByRole('dialog', { name: 'New reminder' });
    this.snoozeError = page.getByText('The reminder could not be snoozed.');
    this.cancelError = page.getByText('The reminder could not be cancelled.');
    this.timerCancelError = page.getByText('The timer could not be cancelled.');
  }

  async goto(): Promise<void> {
    await this.page.goto('/calendar');
    await this.heading.waitFor();
  }

  /**
   * Selects the day after today. On a month's last day tomorrow is an outside
   * (next-month) cell, which Astryx renders aria-disabled and ignores clicks
   * on, so the grid first moves on with its own "Next month" control.
   */
  async selectTomorrow(): Promise<void> {
    const today = await this.page.getByRole('grid').locator('button[aria-current="date"]').getAttribute('data-date');
    if (today === null) throw new Error('the calendar grid marks no day as today');
    const next = new Date(`${today}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const tomorrow = this.day(next.toISOString().slice(0, 10));
    if ((await tomorrow.getAttribute('aria-disabled')) === 'true') {
      await this.page.getByRole('button', { name: 'Next month' }).click();
      await expect(tomorrow).not.toHaveAttribute('aria-disabled', 'true');
    }
    await tomorrow.click();
  }

  /** A day's button in the month grid, by its ISO date (the calendar's data-date). */
  day(iso: string): Locator {
    return this.page.getByRole('grid').locator(`button[data-date="${iso}"]`);
  }

  /** The selected day's button (its gridcell carries aria-selected). */
  selectedDay(): Locator {
    return this.page.getByRole('gridcell', { selected: true }).getByRole('button');
  }

  /** Creates a reminder at the dialog's default time (09:00) on the selected day. */
  async createReminder(title: string): Promise<void> {
    await this.newButton.click();
    await menuItem(this.page, 'Reminder').click();
    await this.reminderDialog.getByLabel('Title').fill(title);
    await this.reminderDialog.getByRole('button', { name: 'Save reminder' }).click();
  }

  /** A reminder row's menu button; the row exists while this is attached. */
  reminderActions(title: string): Locator {
    return this.page.getByRole('button', { name: `Actions for ${title}` });
  }

  reminderRow(title: string): Locator {
    return this.page.getByRole('listitem').filter({ has: this.reminderActions(title) });
  }

  /** Snooze is a submenu of the row menu; the result is a toast with Undo. */
  async snooze(title: string, choice: SnoozeChoice): Promise<void> {
    await this.reminderActions(title).first().click();
    await menuItem(this.page, 'Snooze').click();
    await menuItem(this.page, choice).click();
  }

  /** A private reminder is cancelled at once (Undo toast); a shared one asks first, confirmed here. */
  async cancelReminder(title: string): Promise<void> {
    await this.reminderActions(title).first().click();
    await menuItem(this.page, 'Cancel reminder').click();
    const confirm = this.page.getByRole('alertdialog').getByRole('button', { name: 'Cancel reminder' });
    if (await confirm.isVisible()) await confirm.click();
  }

  /** A running timer's row in the "Running" list, by its label. */
  timer(label: string): Locator {
    return this.page.getByRole('listitem').filter({ hasText: label });
  }

  /** The "<m:ss> left" countdown of a running timer. */
  countdown(label: string): Locator {
    return this.timer(label).getByRole('timer');
  }

  async cancelTimer(label: string): Promise<void> {
    await this.timer(label).getByRole('button', { name: 'Cancel' }).click();
  }
}
