/**
 * #668, #1240: a device's page at /devices/<id>: the "Talking in" row (its
 * title opens the chat; "Change" opens the picker), and the "Change
 * conversation" picker it shares with the chat and thread header control.
 * Other suites may leave more paired devices on the account, so the page is
 * reached by the device's own path.
 */
import type { Locator, Page, Response } from '@playwright/test';
import { menuItem } from '../components/menu.ts';

/** The header control's status line for a pick made while offline. */
export const PENDING = /^Pending — applies when .+ reconnects.$/;
/** The Talking in row's note for the same wait. */
export const WAITING = /Waiting for .+ to come online/;
export const APPLIED = 'Applied on the device.';

export class DeviceCard {
  readonly page: Page;
  readonly card: Locator;
  readonly title: Locator;
  readonly change: Locator;
  readonly picker: Locator;
  /** Whether the tab's account event stream (/api/events) has answered. */
  eventsLive = false;

  constructor(page: Page) {
    this.page = page;
    // The section under the "Talking in" heading: its one row.
    this.card = page.getByRole('main').locator('section, div').filter({
      has: page.getByRole('heading', { level: 2, name: 'Talking in', exact: true }),
    }).last();
    this.change = this.card.getByRole('button', { name: 'Change', exact: true });
    // The row's own button is labelled by its title.
    this.title = this.card.getByRole('listitem').getByRole('button').first();
    this.picker = page.getByRole('dialog', { name: /^Change conversation/ });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/events') this.eventsLive = true;
    });
  }

  /** Opens one device's page, /devices/<id>. */
  async goto(deviceId: string): Promise<void> {
    await this.page.goto(`/devices/${encodeURIComponent(deviceId)}`);
    await this.change.waitFor();
  }

  /** The row's title text (its conversation). */
  titleText(): Locator {
    return this.card.getByRole('listitem').first();
  }

  status(text: string | RegExp): Locator {
    return this.card.getByText(text, { exact: typeof text === 'string' });
  }

  /** Resolves with the server's answer to the pointer PUT that `act` causes. */
  async put(act: () => Promise<void>): Promise<Response> {
    const put = this.page.waitForResponse(
      (response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/devices/active-conversation',
    );
    await act();
    return put;
  }

  async openPicker(): Promise<void> {
    await this.change.click();
    await this.picker.waitFor();
  }

  /** Searches the picker for `title` and picks it; resolves with the PUT's answer. */
  async pick(title: string): Promise<Response> {
    await this.picker.getByRole('textbox', { name: 'Search conversations' }).fill(title);
    return this.put(() => this.picker.getByRole('button', { name: new RegExp(`^${title}`) }).first().click());
  }

  /** "New conversation" (starts in the device's default space). */
  newInGeneral(): Promise<Response> {
    return this.put(() => this.picker.getByRole('button', { name: /^New conversation/ }).click());
  }

  /** "New in a space", then the space: creates a thread there and points at it. */
  newInSpace(spaceName: string): Promise<Response> {
    return this.put(async () => {
      await this.picker.getByRole('button', { name: 'New in a space' }).click();
      await menuItem(this.page, spaceName, { exact: true }).click();
    });
  }
}

/**
 * #1240: one device's page, its header (quick actions) and sections:
 * Talking in, Settings, Recent, About.
 */
export class DeviceHome {
  readonly page: Page;
  readonly root: Locator;
  readonly recent: Locator;
  readonly actions: Locator;
  readonly settings: Locator;
  readonly announceDialog: Locator;

  constructor(page: Page, deviceName: string) {
    this.page = page;
    this.root = page.getByRole('main');
    this.recent = this.section('Recent');
    // The quick actions live in the page header, next to the device's name.
    this.actions = page.locator('header, div').filter({ has: page.getByRole('heading', { level: 1, name: deviceName, exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'Test speaker' }) }).last();
    this.settings = this.section('Settings');
    this.announceDialog = page.getByRole('dialog', { name: /^Announce on / });
  }

  /** The innermost block under a section heading: the section itself. */
  private section(title: string): Locator {
    return this.page.locator('section, div').filter({
      has: this.page.getByRole('heading', { name: title, exact: true, level: 2 }),
    }).last();
  }

  action(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true });
  }

  /** A settings group's row, named by its name and one-line summary. */
  group(name: string): Locator {
    return this.settings.getByRole('button', { name: new RegExp(`^${name}`) });
  }

  /** A result toast (the app's one transient feedback), in the toast region,
   *  not the Astryx live region that announces the same text. */
  status(text: string | RegExp): Locator {
    return this.page.getByRole('region', { name: 'Notifications' }).getByText(text, { exact: typeof text === 'string' });
  }

  /** Resolves with the server's answer to the announce POST that `act` causes. */
  async announce(act: () => Promise<void>): Promise<Response> {
    const post = this.page.waitForResponse(
      (response) => response.request().method() === 'POST' && /^\/api\/devices\/[^/]+\/announce$/.test(new URL(response.url()).pathname),
    );
    await act();
    return post;
  }

  /** Resolves with the server's answer to the settings PATCH that `act` causes. */
  async patchSettings(act: () => Promise<void>): Promise<Response> {
    const patch = this.page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && /^\/api\/devices\/[^/]+\/settings$/.test(new URL(response.url()).pathname),
    );
    await act();
    return patch;
  }
}
