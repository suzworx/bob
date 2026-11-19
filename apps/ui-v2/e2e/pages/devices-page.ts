/**
 * #550: /devices, plus the device action every conversation offers --
 * 'Use on Cardputer' in a conversation's row menu (#498). An empty
 * conversation opens on the chat landing, which has no Cardputer header, so
 * the row menu is the one place the action is always reachable.
 */
import type { Locator, Page, Response } from '@playwright/test';
import { SideNav } from '../components/side-nav.ts';
import { menuItem } from '../components/menu.ts';

export const NO_DEVICE_STATUS = 'No device is connected.';

export class DevicesPage {
  readonly page: Page;
  readonly nav: SideNav;
  readonly heading: Locator;
  readonly pairButton: Locator;
  readonly useOnCardputer: Locator;
  readonly noDeviceStatus: Locator;
  /** /devices is always a list; each row opens one device. */
  readonly list: Locator;
  /** On a device's page, the header's way back to the list. */
  readonly back: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nav = new SideNav(page);
    this.heading = page.getByRole('heading', { level: 1, name: 'Devices' });
    // The header's, or the empty state's when there are no devices.
    this.pairButton = page.getByRole('button', { name: 'Pair a device' });
    this.useOnCardputer = menuItem(page, /^Use on /);
    this.noDeviceStatus = page.getByText(NO_DEVICE_STATUS);
    // Every row says Connected or Offline; the side nav's lists do not.
    this.list = page.getByRole('main').getByRole('list').filter({ hasText: /Connected|Offline ·/ });
    this.back = page.getByRole('button', { name: 'Back to devices', exact: true });
  }

  async goto(): Promise<void> {
    await this.page.goto('/devices');
    await this.heading.waitFor();
  }

  /** A device's row on the list, found by its name. */
  row(name: string): Locator {
    return this.list.getByRole('button', { name: new RegExp(`^${name}`) });
  }

  /** A device's name on its own page (the page title). */
  deviceName(name: string): Locator {
    return this.page.getByRole('heading', { level: 1, name, exact: true });
  }

  /** Opens a conversation's row menu at the device items. */
  async openDeviceMenu(conversationTitle: string): Promise<void> {
    await this.nav.openConversationMenu(conversationTitle);
  }

  /** Chooses 'Use on Cardputer' and returns the server's answer to it. */
  async sendToCardputer(): Promise<Response> {
    const sent = this.page.waitForResponse((response) => response.url().endsWith('/api/devices/active-conversation'));
    await this.useOnCardputer.click();
    return sent;
  }
}
