/**
 * NAV-SHELL: every signed-in page carries the app navigation (the side nav at
 * desktop width, the phone top bar's drawer toggle at phone width) and reaches
 * another page from it. Pairing is /devices/pair, the device list with the
 * pair dialog over it; an old signed-out /pair?code= link must still land
 * there, code kept, in the shell, after signing in. Creates nothing.
 */
import { join } from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { E2E_DATA, mintSignInCode } from './stack.ts';

const PAGES: Array<{ name: string; path: string; ready: (page: Page) => Locator; dismiss?: (page: Page) => Promise<void> }> = [
  // The pair dialog is modal over the device list, so the rail is inert until it closes.
  {
    name: 'pair',
    path: '/devices/pair',
    ready: (page) => page.getByRole('dialog', { name: 'Pair a device' }),
    dismiss: async (page) => {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Pair a device' })).toHaveCount(0);
      await expect(page).toHaveURL(/\/devices$/);
    },
  },
  { name: 'devices', path: '/devices', ready: (page) => page.getByRole('heading', { level: 1, name: 'Devices' }) },
  { name: 'memory', path: '/memory', ready: (page) => page.getByRole('heading', { level: 1, name: 'Memory' }) },
  { name: 'settings', path: '/settings', ready: (page) => page.getByRole('heading', { level: 1, name: 'Settings' }) },
  { name: 'chat', path: '/', ready: (page) => page.getByRole('heading', { name: 'Where should we start?' }) },
];

const SCREENSHOTS = new Set(['pair', 'devices']);

function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

/** The navigation a reader can see right now: the side nav, or the drawer's toggle at phone width. */
async function expectNavigationVisible(page: Page): Promise<void> {
  if (isPhone(page)) {
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  } else {
    const sideNav = page.getByRole('navigation', { name: 'Side navigation' });
    await expect(sideNav).toBeVisible();
    await expect(sideNav.getByRole('link', { name: 'Calendar', exact: true })).toBeVisible();
  }
}

function screenshotPath(name: string, info: TestInfo): string {
  const size = info.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  return join(E2E_DATA, 'screenshots', `nav-${name}-${size}.png`);
}

for (const target of PAGES) {
  test(`${target.name} shows the app navigation and reaches another page from it`, async ({ page, devicesPage }, info) => {
    await page.goto(target.path);
    await expect(target.ready(page)).toBeVisible({ timeout: 30_000 });
    await expectNavigationVisible(page);
    if (SCREENSHOTS.has(target.name)) await page.screenshot({ path: screenshotPath(target.name, info) });
    await target.dismiss?.(page);

    await devicesPage.nav.click('Calendar');
    await expect(page).toHaveURL(/\/calendar$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible();
  });
}

test('Devices is one click away from /devices/pair', async ({ page, devicesPage }) => {
  await page.goto('/devices/pair');
  // Wait for the pair dialog before dismissing it: an Escape sent before it opens is lost.
  const pair = page.getByRole('dialog', { name: 'Pair a device' });
  await expect(pair).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pair).toBeHidden();
  await devicesPage.nav.click('Devices');
  await expect(page).toHaveURL(/\/devices$/);
  await expect(devicesPage.heading).toBeVisible();
});

test.describe('owner viewport 1300x960', () => {
  test.use({ viewport: { width: 1300, height: 960 } });

  test('a collapsed side nav on /devices can always be reopened', async ({ page, devicesPage }, info) => {
    test.skip(info.project.name.startsWith('mobile'), 'the rail only collapses at desktop width');
    await devicesPage.goto();
    const sideNav = page.getByRole('navigation', { name: 'Side navigation' });
    await sideNav.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await expect(sideNav).toBeVisible();
    await sideNav.getByRole('button', { name: 'Expand sidebar', exact: true }).first().click();
    await expect(sideNav.getByRole('link', { name: 'Calendar', exact: true })).toBeVisible();
  });

  test('a side nav dragged shut on /devices can always be reopened', async ({ page, devicesPage }, info) => {
    test.skip(info.project.name.startsWith('mobile'), 'the rail only resizes at desktop width');
    await devicesPage.goto();
    const sideNav = page.getByRole('navigation', { name: 'Side navigation' });
    const handle = page.getByRole('separator').first();
    const box = await handle.boundingBox();
    if (!box) throw new Error('the side nav has no resize handle');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(10, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(sideNav).toBeVisible();
    const expand = sideNav.getByRole('button', { name: 'Expand sidebar', exact: true }).first();
    if (await expand.isVisible()) await expand.click();
    await expect(sideNav.getByRole('link', { name: 'Calendar', exact: true })).toBeVisible();
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('an old /pair?code= link signs in and lands on /devices/pair inside the shell, code kept', async ({ page, signInPage }) => {
    await page.goto('/pair?code=ABCD-2345');
    await signInPage.heading.waitFor();
    await signInPage.signIn(mintSignInCode());
    await expect(page).toHaveURL(/\/devices\/pair\?code=ABCD-2345$/, { timeout: 30_000 });
    await expectNavigationVisible(page);
  });
});

// One home per thing: every moved page's old link lands on its new home, query kept.
test.describe('old links', () => {
  for (const [from, to] of [
    ['/account', /\/settings#profile$/],
    ['/usage', /\/settings#usage$/],
    ['/connectors', /\/integrations$/],
    ['/gmail', /\/integrations$/],
  ] as const) {
    test(`${from} lands on its new home`, async ({ page }) => {
      await page.goto(from);
      await expect(page).toHaveURL(to, { timeout: 30_000 });
      await expectNavigationVisible(page);
    });
  }
});
