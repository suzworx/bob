/**
 * #1240: one shared way to find a toast. Astryx announces every toast twice:
 * the visible toast in the "Notifications" region, and a visually hidden live
 * region ([data-astryx-live-region], role=status) for screen readers. A bare
 * getByText matches both (strict-mode violation), so specs read toasts here.
 */
import type { Locator, Page } from '@playwright/test';

/** The visible toast carrying `text` (exact, or a pattern). */
export function toast(page: Page, text: string | RegExp): Locator {
  return page.getByRole('region', { name: 'Notifications' }).getByText(text, { exact: typeof text === 'string' });
}
