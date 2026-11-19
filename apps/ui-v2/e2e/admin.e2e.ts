import { expect, test, type Route } from '@playwright/test';
import { menuItem } from './components/menu.ts';

test.use({
  reducedMotion: 'reduce',
  storageState: { cookies: [], origins: [] },
});
test.beforeEach(async ({ page, context, baseURL }) => {
  test.skip(
    !baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname),
    'Fictional local requests only',
  );
  await context.addInitScript(() => {
    localStorage.setItem('bob.dev.token', 'fictional-admin-test');
    localStorage.setItem('bob.dev.tokenExpiry', String(Date.now() + 86400000));
    localStorage.setItem('bob.dev.userId', '00000000-0000-4000-8000-000000000001');
  });
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/access' || path === '/api/operator/access') {
      await route.fulfill({ status: 204 });
      return;
    }
    if (path.startsWith('/api/operator/metrics/')) {
      await route.fulfill({ status: 503, json: { error: 'unavailable' } });
      return;
    }
    const data: Record<string, unknown> = {
      '/api/public-config': { devSignIn: true },
      '/api/admin/accounts/search': {
        accounts: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            email: 'a-long-fictional-address-for-mobile-layout@example.test',
            createdAt: '2026-01-01T00:00:00Z',
            lastSignInAt: null,
            status: 'enabled',
            isAdmin: false,
            emailConfirmed: false,
          },
        ],
        counts: {
          total: 24,
          enabled: 20,
          disabled: 4,
          awaitingConfirmation: 3,
        },
        nextCursor: null,
      },
      '/api/admin/accounts/manage': { status: 'updated' },
      '/api/admin/accounts': { status: 'created', invitation: 'queued' },
      '/api/conversations': { conversations: [] },
      '/api/group-chats': { chats: [] },
      '/api/spaces': { spaces: [] },
      '/api/active': { active: null },
      '/api/devices': { devices: [] },
      '/api/timers': { timers: [] },
      '/api/notifications': {
        notifications: [],
        next_cursor: null,
        unread_count: 0,
      },
      '/api/google-accounts': { accounts: [] },
    };
    if (path === '/api/admin/accounts/search') {
      populateDirectoryPage(data, path, route);
    }
    await route.fulfill({ status: 200, json: data[path] ?? {} });
  });
});
for (const width of [320, 359, 390, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`admin ${width}px ${theme} users, confirmation, add person and tabs`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => localStorage.setItem('bob.theme', value), theme);
      await page.goto(`/admin?theme=${theme}`);
      const heading = page.getByRole('heading', { name: 'Admin', exact: true });
      await expect(heading).toBeVisible();
      for (const name of ['Users', 'Waitlist', 'Monitoring']) {
        await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
      }
      await expect(page.getByText('Sign-in enabled', { exact: true })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Accounts' })).toBeVisible();
      const search = page.getByRole('textbox', { name: 'Search by email prefix' });
      await page.getByRole('button', { name: 'Manage account', exact: true }).first().click();
      // Astryx uses menuitems in pointer popovers and buttons in adaptive touch sheets.
      const disableAction = menuItem(page, 'Disable sign-in', { exact: true })
        .or(page.getByRole('button', { name: 'Disable sign-in', exact: true }));
      await disableAction.click();
      const confirm = page.getByRole('alertdialog', {
        name: 'Disable sign-in for a-long-fictional-address-for-mobile-layout@example.test?',
      });
      await expect(confirm).toBeVisible();
      await confirm.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      });
      await page.screenshot({
        path: testInfo.outputPath(`admin-confirm-${width}-${theme}.png`),
      });
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();

      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      // On a phone the h1 is visually hidden (the top bar carries the title): it
      // stays in the accessibility tree and the content starts at the 16px gutter.
      const phone = width < 768;
      if (phone) {
        await expect(heading).toBeAttached();
        expect((await search.boundingBox())?.x).toBeGreaterThanOrEqual(16);
      } else {
        expect((await heading.boundingBox())?.x).toBeGreaterThan(0);
      }
      for (const locator of [
        page.getByRole('table', { name: 'Accounts' }),
        page.getByRole('button', { name: 'Manage account', exact: true }).first(),
        search,
        page.getByRole('button', { name: 'Add person', exact: true }),
        ...(phone ? [] : [heading]),
      ]) {
        const box = await locator.boundingBox();
        expect(box).not.toBeNull();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await expect(page.getByRole('link', { name: 'Open monitoring' })).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`admin-${width}-${theme}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(page.getByText('next-page@example.test', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Previous page', exact: true }).click();
      await expect(page.getByText('site-admin@example.test', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Add person', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Email address' }).fill('person@example.test');
      await dialog.getByRole('button', { name: 'Send invite' }).click();
      // Scoped to the toast region: Astryx also mirrors the text into a hidden live region.
      await expect(
        page.getByRole('region', { name: 'Notifications' }).getByText('Invite sent to person@example.test', { exact: true }),
      ).toBeVisible();
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    });
  }
}

test('monitoring is a tab of Admin that survives reload, and old monitoring links land on it', async ({
  page,
}) => {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Monitoring', exact: true }).click();
  await expect(page).toHaveURL(/\/admin(\?[^#]*)?#monitoring$/);
  await expect(page.getByRole('tab', { name: 'Monitoring', selected: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Monitoring', selected: true })).toBeVisible();
  await page.goto('/admin/monitoring');
  await expect(page).toHaveURL(/\/admin#monitoring$/);
  await expect(page.getByRole('tab', { name: 'Monitoring', selected: true })).toBeVisible();
});

function populateDirectoryPage(data: Record<string, unknown>, path: string, route: Route): void {
  const payload = data[path] as {
    accounts: Array<Record<string, unknown>>;
    nextCursor: string | null;
  };
  const first = payload.accounts[0];
  if (!first) throw new Error('missing fictional account');
  const body = route.request().postDataJSON() as { cursor?: string };
  payload.accounts = body.cursor
    ? [
        {
          ...first,
          id: '44444444-4444-4444-8444-444444444444',
          email: 'next-page@example.test',
        },
      ]
    : [
        first,
        {
          ...first,
          id: '22222222-2222-4222-8222-222222222222',
          email: 'site-admin@example.test',
          isAdmin: true,
          emailConfirmed: true,
        },
        {
          ...first,
          id: '33333333-3333-4333-8333-333333333333',
          email: 'disabled@example.test',
          status: 'disabled',
          emailConfirmed: true,
        },
      ];
  payload.nextCursor = body.cursor ? null : 'fictional-next-page';
}
