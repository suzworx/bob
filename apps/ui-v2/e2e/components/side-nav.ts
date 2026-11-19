/**
 * #550: the app's side navigation. At phone width it collapses into a drawer
 * behind "Open navigation"; every action here opens the drawer first when it
 * is closed, so page objects and specs never branch on the viewport.
 */
import type { Locator, Page } from '@playwright/test';

export class SideNav {
  readonly page: Page;
  readonly landmark: Locator;
  readonly openButton: Locator;
  /**
   * The rail itself: the side navigation at desktop width, the drawer
   * ("Navigation" dialog) at phone width. Scoped so the phone top bar's own
   * New chat button (behind the open drawer) is never a second match.
   */
  readonly rail: Locator;

  constructor(page: Page) {
    this.page = page;
    this.landmark = page.getByRole('navigation', { name: /^(Side|Mobile) navigation$/ });
    this.openButton = page.getByRole('button', { name: 'Open navigation' });
    this.rail = page.getByRole('navigation', { name: 'Side navigation' }).or(page.getByRole('dialog', { name: 'Navigation' }));
  }

  /** Makes navigation controls reachable: opens the drawer at phone width. */
  async reveal(): Promise<void> {
    await this.landmark.waitFor();
    if (await this.openButton.isVisible()) await this.openButton.click();
  }

  /**
   * Destinations are links (Today, Calendar, Memory, Devices, Integrations, a space, All
   * spaces, a chat); commands such as New chat remain buttons. Notifications is
   * the footer bell (a button), Settings and Admin are in the account menu;
   * the rail has no More or Connectors (#1240).
   */
  async click(name: string): Promise<void> {
    await this.reveal();
    const actions = ['New chat', 'New space', 'Search', 'Notifications', 'Account menu'];
    await this.rail.getByRole(actions.includes(name) ? 'button' : 'link', { name, exact: true }).click();
  }

  /** The row menu button of a conversation in the list. */
  conversationActions(title: string): Locator {
    return this.page.getByRole('button', { name: `Conversation actions for ${title}` });
  }

  /** Opens a conversation's row menu. */
  async openConversationMenu(title: string): Promise<void> {
    await this.reveal();
    await this.rail.getByRole('button', { name: `Conversation actions for ${title}` }).click();
  }
}
