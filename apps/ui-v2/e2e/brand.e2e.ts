/**
 * BOB-WEB: the Bob brand end to end: title, favicon, welcome hero, Nunito and the shell's name.
 * Leaves screenshots in data/e2e/screenshots/bob-web-*.png.
 */
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { E2E_DATA } from './stack.ts';

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  const size = info.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  // The run account's address is masked: no email in any screenshot.
  await page.screenshot({ path: join(E2E_DATA, 'screenshots', `bob-web-${name}-${size}.png`), mask: [page.getByText(/e2e-run-/)] });
}

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('Bob title, welcome hero, logo favicon and Nunito', async ({ page }, info) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Bob');
    await expect(page.getByRole('heading', { name: 'Sign in to Bob' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hello again, friend.' })).toBeVisible();
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/brand/bob/icon.png');
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/brand/bob/apple-icon.png');
    const hero = page.getByRole('img', { name: 'Bob waving hello' });
    await expect(hero).toBeVisible();
    await expect(hero).toHaveAttribute('src', '/brand/bob/bob-playful.webp');
    await expect.poll(() => hero.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(family).toContain('Nunito');
    await shot(page, info, 'signin');
  });
});

test.describe('signed in', () => {
  test('the shell names Bob', async ({ page }, info) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Bob');
    await expect(page.getByText('Bob', { exact: true }).first()).toBeVisible();
    await shot(page, info, 'chat');
  });
});
