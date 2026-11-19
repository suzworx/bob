/**
 * #1349: on a phone the conversation header row is gone. Tools and "Add people"
 * sit on the composer's top row as icon buttons, and a page's secondary actions
 * sit in its overflow MoreMenu (named "More options"). One place for those
 * paths so a spec does not copy them.
 */
import type { Locator, Page } from '@playwright/test';
import { menuItem } from '../components/menu.ts';

/** A phone-sized viewport (320/359/390), as opposed to the 1280 desktop. */
export function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

/** The "More options" button that is visible now (the page's overflow menu; composer actions are on its top row). */
export function moreOptions(page: Page): Locator {
  return page.getByRole('button', { name: 'More options', exact: true });
}

/** A button on the composer's top row, by name (phone only: Attach, Mention, Voice mode, Tools, Add people, People). */
export function composerAction(page: Page, name: string): Locator {
  return page.locator('.astryx-chat-composer').getByRole('button', { name, exact: true });
}

/** Opens a page's overflow menu (phone only), e.g. My Apps' "Reload latest data". */
export async function openPageMenu(page: Page): Promise<void> {
  await moreOptions(page).first().click();
}

/** Clicks a conversation action: the header button on desktop, a composer top-row button on a phone. */
export async function clickConversationAction(page: Page, name: string): Promise<void> {
  if (isPhone(page)) {
    await composerAction(page, name).click();
  } else {
    await page.getByRole('button', { name, exact: true }).click();
  }
}

/** Clicks a page action: a button on desktop, an overflow menu item on a phone. */
export async function clickPageAction(page: Page, name: string): Promise<void> {
  if (isPhone(page)) {
    await openPageMenu(page);
    await menuItem(page, name, { exact: true }).click();
  } else {
    await page.getByRole('button', { name, exact: true }).click();
  }
}

/**
 * The composer's primary action while the box is empty: Dictate on a phone
 * (Send replaces it once there is text), the disabled Send on desktop.
 */
export function emptyComposerAction(page: Page): Locator {
  return page.getByRole('button', { name: isPhone(page) ? 'Dictate' : 'Send', exact: true });
}
