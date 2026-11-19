import type { Locator, Page } from '@playwright/test';

type Name = string | RegExp;

/**
 * A menu item, at any width. Astryx menus with presentation="adaptive" are a
 * popover of role=menuitem rows on desktop, but on a phone they open as a
 * BottomSheet (a dialog) whose rows are ListItem buttons, with no menuitem
 * role. Look for either, so one spec covers both projects.
 */
export function menuItem(scope: Page | Locator, name?: Name, options: { exact?: boolean } = {}): Locator {
  const page = 'page' in scope && typeof scope.page === 'function' ? scope.page() : (scope as Page);
  const byName = name === undefined ? {} : { name, ...options };
  return scope.getByRole('menuitem', byName).or(page.getByRole('dialog').getByRole('listitem').getByRole('button', byName));
}

/** The open menu: the desktop popover or the phone sheet. */
export function openMenu(page: Page): Locator {
  return page.getByRole('menu').or(page.getByRole('dialog').filter({ has: page.getByRole('list') }));
}
