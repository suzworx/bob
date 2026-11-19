/**
 * #550: /memory -- what Bob remembers (facts only since #1240) and the search.
 */
import type { Locator, Page } from '@playwright/test';

export class MemoryPage {
  readonly page: Page;
  readonly heading: Locator;
  /** The page's primary action; it shows while the list is still loading too. */
  readonly addButton: Locator;
  /** Shown instead of the list (and the filter) when there is nothing remembered. */
  readonly emptyState: Locator;
  /** The search over the list; only rendered with at least one memory. */
  readonly filter: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { level: 1, name: 'Memory' });
    this.addButton = page.getByRole('button', { name: 'Add memory' });
    this.emptyState = page.getByRole('heading', { level: 2, name: 'Nothing remembered yet' });
    this.filter = page.getByRole('textbox', { name: 'Search memories' });
  }

  async goto(): Promise<void> {
    await this.page.goto('/memory');
    await this.heading.waitFor();
  }

  /**
   * Waits until the list has loaded: the search (shown with the list) or the
   * empty state. "Add memory" is no signal, since it shows while loading too.
   */
  async waitUntilLoaded(): Promise<void> {
    await this.filter.or(this.emptyState).first().waitFor();
  }

  async filterBy(text: string): Promise<void> {
    await this.filter.fill(text);
  }

  /** Every place a memory's text is shown. */
  entry(content: string): Locator {
    return this.page.getByText(content);
  }
}
