/**
 * #565 U7: a space thread at /spaces/spc_<hex>/conversations/conv_<hex> -- its
 * messages, the title bar (thread menu: Rename, Archive; the device control
 * beside it says "On <device>: <title>") and the same thread's row menu in the
 * space's Threads list (#1240: the rail no longer lists threads).
 */
import type { Locator, Page } from '@playwright/test';
import { prefixedId } from '../../src/lib/ids.ts';
import { menuItem, openMenu } from '../components/menu.ts';

export class ThreadPage {
  readonly page: Page;
  /** The space's Threads list, shown with no thread open. */
  readonly list: Locator;
  readonly messages: Locator;
  readonly menu: Locator;
  readonly useOnCardputer: Locator;
  readonly archiveItem: Locator;
  /** Archive is reversible: it shows a toast with Undo instead of asking first. */
  readonly undoArchive: Locator;
  /**
   * Whether the tab's account event stream (/api/events) has answered. Its
   * headers reach the page with the stream's first event, and the server
   * subscribes before it sends them, so from then on the tab hears every
   * live update (pointer moves, thread messages).
   */
  eventsLive = false;

  constructor(page: Page) {
    this.page = page;
    this.list = page.getByRole('list', { name: 'Threads' });
    this.messages = page.getByRole('region', { name: 'Thread messages' });
    this.menu = openMenu(page);
    this.useOnCardputer = menuItem(this.page, /^Use on /);
    this.archiveItem = menuItem(this.page, /^Archive/);
    this.undoArchive = page.getByRole('button', { name: 'Undo', exact: true });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/events') this.eventsLive = true;
    });
  }

  async goto(spaceId: string, threadId: string): Promise<void> {
    await this.page.goto(`/spaces/${prefixedId('space', spaceId)}/conversations/${prefixedId('conversation', threadId)}`);
    await this.messages.waitFor();
  }

  /** A message in the open thread, by its whole text or a pattern. */
  message(text: string | RegExp): Locator {
    return this.messages.getByText(text, { exact: typeof text === 'string' });
  }

  /**
   * The title bar's "On <device>" token, shown while the device is in the open thread.
   * (In a thread the bar shows no "On <device>: <title>" status line; that is for the main chat.)
   */
  onCardputerHere(): Locator {
    return this.page.getByRole('main').getByText(/^On [^:]+$/);
  }

  /** The title bar's "Use on <device>" button, shown while the device is somewhere else. */
  useOnCardputerButton(): Locator {
    return this.page.getByRole('main').getByRole('button', { name: /^Use on / });
  }

  /** Chooses 'Use on <device>' from the thread's row menu in the Threads list, then reopens the thread. */
  async useOnCardputerFromRow(title: string): Promise<void> {
    await this.page.getByRole('button', { name: 'Back to threads' }).click();
    await this.list.getByRole('button', { name: `Thread actions for ${title}` }).click();
    await this.useOnCardputer.click();
    await this.menu.waitFor({ state: 'hidden' });
    await this.list.getByText(title, { exact: true }).click();
    await this.messages.waitFor();
  }

  /** Opens the open thread's menu in its title bar. */
  async openTitleMenu(title: string): Promise<void> {
    await this.page.getByRole('main').getByRole('button', { name: `Thread actions for ${title}` }).click();
  }

  async closeMenu(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.menu.waitFor({ state: 'hidden' });
  }

  /**
   * Archive from the title bar menu. No dialog: an Undo toast, and the request
   * runs when the toast closes without Undo (about 6 s); resolves with the server's answer.
   */
  async archive(title: string): Promise<void> {
    const archived = this.page.waitForResponse(
      (response) => response.request().method() === 'DELETE' && /\/api\/threads\//.test(response.url()),
      { timeout: 20_000 },
    );
    await this.openTitleMenu(title);
    await this.archiveItem.click();
    await this.undoArchive.waitFor();
    // The toast pauses its auto-hide while hovered or focused. On a phone the
    // sheet's Archive row sat where the toast now appears, so the test pointer
    // rests on it and the timer never runs; move it away (a finger lifts).
    await this.page.mouse.move(0, 0);
    await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    if (!(await archived).ok()) throw new Error('archiving the thread failed');
  }
}
