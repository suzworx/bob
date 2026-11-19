/**
 * #550: the chat -- the new-chat landing at / and a conversation at /c/:id.
 * Sending counts against the live spend cap (BOB_E2E_LIVE_MAX_TURNS).
 */
import type { Locator, Page } from '@playwright/test';
import { SideNav } from '../components/side-nav.ts';
import { isLive } from '../stack.ts';
import { uuidOf } from '../../src/lib/ids.ts';

/** Live mode spends real money: at most this many chat turns per run. */
const LIVE_TURN_CAP = Number(process.env.BOB_E2E_LIVE_MAX_TURNS ?? '8');
let liveTurns = 0;

export class ChatPage {
  readonly page: Page;
  readonly nav: SideNav;
  readonly landingHeading: Locator;
  readonly composer: Locator;
  readonly sendButton: Locator;
  readonly userMessages: Locator;
  readonly replies: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nav = new SideNav(page);
    this.landingHeading = page.getByRole('heading', { name: 'Where should we start?' });
    this.composer = page.getByLabel('Message input');
    this.sendButton = page.getByRole('button', { name: 'Send', exact: true });
    this.userMessages = page.getByRole('article', { name: 'Message from user' });
    this.replies = page.getByRole('article', { name: 'Message from assistant' });
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
    await this.landingHeading.waitFor();
  }

  async newChat(): Promise<void> {
    await this.nav.click('New chat');
  }

  /** Types a message and sends it; refuses past the live spend cap. */
  async send(text: string): Promise<void> {
    if (isLive()) {
      liveTurns += 1;
      if (liveTurns > LIVE_TURN_CAP) {
        throw new Error(`live spend cap: more than ${LIVE_TURN_CAP} chat turns (BOB_E2E_LIVE_MAX_TURNS)`);
      }
    }
    await this.composer.click();
    await this.composer.pressSequentially(text);
    await this.sendButton.click();
  }

  lastReply(): Locator {
    return this.replies.last();
  }

  /** The chip (#544) a reply shows for something it created, by its title. */
  chip(title: string): Locator {
    return this.lastReply().getByRole('button', { name: title });
  }

  /** The open conversation's stored id, once the first reply has created it: /c/conv_<hex> is cnv_<uuid> to the API. */
  async conversationId(): Promise<string> {
    await this.page.waitForURL(/\/c\/[A-Za-z0-9_-]+$/);
    const segment = new URL(this.page.url()).pathname.split('/').pop() ?? '';
    const uuid = uuidOf('conversation', segment);
    return uuid === null ? segment : `cnv_${uuid}`;
  }
}
