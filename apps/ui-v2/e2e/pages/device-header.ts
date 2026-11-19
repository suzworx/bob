/**
 * #667: the Cardputer control in a conversation's header -- the General chat
 * header at /c/:id and a space thread's title bar (DeviceHeaderControl). Not
 * on the Cardputer it is a labelled "Use on Cardputer" button; on it, an
 * "On Cardputer" badge; both keep a "Cardputer options" menu.
 */
import type { Locator, Page, Response } from '@playwright/test';

export class DeviceHeader {
  readonly page: Page;
  readonly useOnCardputer: Locator;
  readonly onCardputer: Locator;
  readonly options: Locator;
  /** Whether the tab's account event stream (/api/events) has answered; see ThreadPage.eventsLive. */
  eventsLive = false;

  constructor(page: Page) {
    this.page = page;
    const main = page.getByRole('main');
    this.useOnCardputer = main.getByRole('button', { name: /^Use on /  });
    this.onCardputer = main.getByText(/^On [^:]+$/);
    // The device control's "<device> options" menu -- not the page's overflow "More options".
    // On a phone the control is the row above the composer rather than a header.
    this.options = main.getByRole('button', { name: /^(?!More options$).* options$/ });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/events') this.eventsLive = true;
    });
  }

  /** The control's status line, e.g. "No device is connected." */
  status(text: string | RegExp): Locator {
    return this.page.getByRole('main').getByText(text, { exact: typeof text === 'string' });
  }

  /** One click on the visible button; resolves with the server's answer to the PUT. */
  async use(): Promise<Response> {
    const put = this.page.waitForResponse(
      (response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/devices/active-conversation',
    );
    await this.useOnCardputer.click();
    return put;
  }
}
