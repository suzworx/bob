/**
 * NAV-SHELL: /devices/pair, the pair dialog over the Devices list that a
 * device's QR code or typed link opens (/pair redirects here, keeping ?code=).
 * It sits inside the signed-in shell like every other page.
 */
import type { Locator, Page } from '@playwright/test';
import { SideNav } from '../components/side-nav.ts';

export class PairPage {
  readonly page: Page;
  readonly nav: SideNav;
  readonly dialog: Locator;
  /** The dialog's title. */
  readonly heading: Locator;
  readonly code: Locator;
  readonly name: Locator;
  readonly pair: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nav = new SideNav(page);
    this.dialog = page.getByRole('dialog', { name: 'Pair a device' });
    this.heading = this.dialog.getByRole('heading', { name: 'Pair a device' });
    this.code = this.dialog.getByRole('textbox', { name: /^Code on the screen/ });
    this.name = this.dialog.getByRole('textbox', { name: /^Name/ });
    this.pair = this.dialog.getByRole('button', { name: 'Pair', exact: true });
  }

  async goto(path = '/devices/pair'): Promise<void> {
    await this.page.goto(path);
    await this.heading.waitFor();
  }
}
