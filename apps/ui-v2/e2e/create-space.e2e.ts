/**
 * Prod 2026-10-06: New space -> Pair -> Create showed "That could not be
 * created." (the server's pair insert failed RLS). Spaces have no type now
 * (owner decision): the dialog asks only for a name, and creating one through
 * the real API opens it. Leaves data/e2e/screenshots/create-space-dialog-
 * {light,dark}-desktop.png for review. Archives the space it makes.
 */
import { isPhone } from './pages/phone.ts';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { E2E_DATA } from './stack.ts';

async function shot(page: Page, info: TestInfo, scheme: 'light' | 'dark'): Promise<void> {
  const size = info.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  if (info.repeatEachIndex === 0) {
    await page.screenshot({ path: join(E2E_DATA, 'screenshots', `create-space-dialog-${scheme}-${size}.png`) });
  }
}

test('New space asks for a name and who it is for, and creates a space the creator owns', async ({ page, devicesPage, api, cleanup, tag }, info) => {
  await page.goto('/spaces');
  // The page behind the dialog has loaded (empty state or an open space), so the screenshots show it.
  await expect(page.getByRole('heading', { name: 'No spaces yet' }).or(page.getByRole('heading', { level: 1 }))).toBeVisible();
  if (isPhone(page)) {
    // The phone drawer no longer lists New space; it is on /spaces.
    await page.getByRole('main').getByRole('button', { name: 'New space', exact: true }).click();
  } else {
    await devicesPage.nav.reveal();
    const nav = page.getByRole('navigation', { name: 'Side navigation' }).or(page.getByRole('dialog', { name: 'Navigation' }));
    await nav.getByRole('button', { name: 'New space', exact: true }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'New space' });
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(page, info, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, info, 'dark');
  await page.emulateMedia({ colorScheme: null });

  const name = `Space ${tag}`;
  const created = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/spaces'));
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Create space' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({ name });
  const space = (await response.json()) as { id: string; role: string };
  cleanup(async () => api.delete(`/api/spaces/${space.id}`));
  expect(space.role).toBe('owner');

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
});
