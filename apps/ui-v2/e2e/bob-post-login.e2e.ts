import { expect, test, type Locator, type Page } from '@playwright/test';
import { SideNav } from './components/side-nav.ts';

// Fictional browser-only data. Every API request is intercepted; no test writes reach a server.
const TITLE = 'A very long fictional conversation title about a calm Saturday with friends and a picnic in the park';
const CONVERSATION = {
  id: 'conv_demo_bob_audit', title: TITLE, createdAt: 1_792_137_600_000, updatedAt: 1_792_137_600_000,
  messages: [{ id: 'message-demo', role: 'user', position: 0,
    versions: [{ id: 'version-demo', parts: [{ type: 'text', text: 'A quiet Saturday sounds good.' }], versionIndex: 0, selected: true }] }],
};

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page, context, baseURL, colorScheme }) => {
  test.skip(!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Fictional local preview only');
  await page.addInitScript((theme) => {
    localStorage.setItem('bob.dev.token', 'fictional-browser-regression');
    localStorage.setItem('bob.dev.tokenExpiry', String(Date.now() + 86_400_000));
    localStorage.setItem('bob.dev.userId', '00000000-0000-4000-8000-000000000001');
    localStorage.setItem('bob.theme', theme);
  }, colorScheme === 'dark' ? 'dark' : 'light');
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/public-config': { devSignIn: true },
      '/api/conversations': { conversations: [CONVERSATION] },
      '/api/group-chats': { chats: [] },
      '/api/conversations/conv_demo_bob_audit': CONVERSATION,
      '/api/spaces': { spaces: [] }, '/api/active': { active: null },
      '/api/devices': { devices: [] }, '/api/timers': { timers: [] },
      '/api/memories': { memories: [], next_cursor: null }, '/api/action-items': { action_items: [] },
      '/api/notifications': { notifications: [], next_cursor: null, unread_count: 0 },
      '/api/notification-preferences': { preferences: [] }, '/api/google-accounts': { accounts: [] },
    };
    await route.fulfill({ status: path === '/api/operator/access' ? 403 : 200, json: responses[path] ?? {} });
  });
});

test.afterEach(async ({ page }) => {
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page.getByText('Reload the page to try again.', { exact: true })).toHaveCount(0);
});

async function fits(locator: Locator, width: number): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
}

/** Alpha of the image's corners and the share of fully transparent pixels along its top and bottom rows. */
async function edgeAlpha(page: Page, source: string | null): Promise<{ corners: number[]; transparentEdges: number[] }> {
  return page.evaluate(async (src) => {
    const image = new Image();
    image.src = src ?? '';
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(image, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    const at = (x: number, y: number): number => data[(y * width + x) * 4 + 3] ?? 255;
    return {
      corners: [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)],
      transparentEdges: [0, height - 1].map((y) => Array.from({ length: width }, (_, x) => at(x, y)).filter((a) => a === 0).length / width),
    };
  }, source);
}

async function openNavigation(page: Page): Promise<void> {
  await page.getByRole('button', { name: /open.*navigation|open.*menu|toggle.*navigation/i }).click();
}

/** The Bob mark's image href: the drawer's brand link on a phone, the assistant avatar elsewhere. */
async function markSource(page: Page, phone: boolean): Promise<string | null> {
  const assistant = page.getByRole('img', { name: 'Bob', exact: true });
  if (phone) await openNavigation(page);
  else await expect(assistant).toBeVisible();
  const mark = phone
    ? page.getByRole('link', { name: 'Bob home', exact: true }).locator('svg image').first()
    : assistant.locator('image');
  return mark.getAttribute('xlink:href');
}

test('320px Bob home keeps the greeting and shared composer inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await fits(page.getByRole('heading', { name: 'Where should we start?' }), 320);
  await fits(page.getByRole('img', { name: 'Bob waving hello' }), 320);
  await fits(page.getByRole('combobox', { name: 'Message input' }), 320);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('320px long title retains its full accessible name and shows no device control without a device', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/c/conv_demo_bob_audit');
  // The h1 is visually hidden on a phone (PageTitle) but keeps the full accessible name.
  await expect(page.getByRole('heading', { level: 1, name: TITLE, exact: true })).toHaveCount(1);
  // The visible title is the phone top bar's text: one clipped line inside the viewport.
  const title = page.getByRole('navigation', { name: 'Mobile navigation' }).getByText(TITLE, { exact: true });
  await fits(title, 320);
  expect((await title.boundingBox())?.x).toBeGreaterThanOrEqual(12);
  const lines = await title.evaluate((el) => el.getBoundingClientRect().height / (Number.parseFloat(getComputedStyle(el).lineHeight) || 1));
  expect(lines, 'the top-bar title ellipsizes on one line instead of wrapping').toBeLessThan(1.5);
  // /api/devices is stubbed empty: with no paired device the header control renders nothing.
  await expect(page.getByRole('button', { name: /^Use on / })).toHaveCount(0);
});

// The bell sits in the drawer's footer (#1240), so the inbox opens over the
// open drawer; "Notification settings" goes to /settings#notifications, and
// moving to another page closes the drawer.
test('mobile inbox opens from the drawer footer and its settings link leaves the drawer closed', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await openNavigation(page);
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'Notifications', exact: true }).click();
  const inbox = page.getByRole('dialog', { name: 'Notifications', exact: true });
  await expect(inbox).toBeVisible();
  await expect(inbox.getByText("You're all caught up", { exact: true })).toBeVisible();
  await inbox.getByRole('button', { name: 'Notification settings' }).click();
  await expect(page).toHaveURL(/\/settings#notifications$/);
  await expect(inbox).toHaveCount(0);
  await expect(page.getByTestId('mobile-nav-toggle')).toHaveAttribute('aria-expanded', 'false');
});

test('page content starts at the 16px phone gutter and the h1 stays for assistive tech', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const nav = new SideNav(page);
  for (const [path, name] of [['memory', 'Memory'], ['calendar', 'Calendar']]) {
    await nav.click(name);
    await expect(page).toHaveURL(new RegExp(`/${path}$`));
    // The phone top bar shows the title, so the h1 is visually hidden but still a level-1 heading.
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toHaveCount(1);
    await expect(page.getByRole('main')).toBeVisible();
    // The first visible, non-hidden-heading content of the page: the left edge of the first painted text or control.
    const left = await page.getByRole('main').evaluate((main) => {
      let min = Infinity;
      for (const el of main.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');
        if (r.width < 2 || r.height < 2 || !own || !el.checkVisibility() || el.closest('[aria-label="Mobile navigation"]')) continue;
        min = Math.min(min, r.left);
      }
      return min;
    });
    expect(left).toBeGreaterThanOrEqual(14);
    expect(Math.abs(left - 16)).toBeLessThanOrEqual(2);
  }
  await nav.click('New chat');
  await expect(page.getByRole('heading', { name: 'Where should we start?' })).toBeVisible();
});

test('page and conversation links support native modified clicks', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  for (const [name, path] of [['Memory', '/memory'], [TITLE, '/c/conv_demo_bob_audit']]) {
    const link = page.getByRole('link', { name: name === TITLE ? /^A very long fictional conversation/ : name, exact: name !== TITLE }).first();
    await expect(link).toHaveAttribute('href', path);
    const opened = context.waitForEvent('page');
    await link.click({ modifiers: ['Control'] });
    const other = await opened;
    await other.waitForURL(`**${path}`);
    expect(new URL(page.url()).pathname).toBe('/');
    await other.close();
  }
});

test.describe('Bob transparent shared mark', () => {
  test.use({ deviceScaleFactor: 3 });
  for (const mode of ['light', 'dark'] as const) {
    test.describe(mode, () => {
      test.use({ colorScheme: mode });
      test(`header and assistant artwork have no opaque rectangular edges in ${mode}`, async ({ page }, testInfo) => {
        await page.route('**/api/conversations/conv_demo_bob_audit', (route) => route.fulfill({ json: {
          ...CONVERSATION,
          messages: [...CONVERSATION.messages, { id: 'assistant-demo', role: 'assistant', position: 1,
            versions: [{ id: 'assistant-version', parts: [{ type: 'text', text: 'A picnic sounds lovely.' }], versionIndex: 0, selected: true }] }],
        } }));
        await page.goto('/c/conv_demo_bob_audit');
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
        // Phone replies carry no avatar; the mark is checked through the drawer's brand link below.
        const phone = (page.viewportSize()?.width ?? 1280) < 768;
        const source = await markSource(page, phone);
        expect(source).toBeTruthy();
        const alpha = await edgeAlpha(page, source);
        expect(alpha.corners).toEqual([0, 0, 0, 0]);
        for (const fraction of alpha.transparentEdges) expect(fraction).toBeGreaterThan(0.75);
        await page.screenshot({ path: testInfo.outputPath(`bob-assistant-${mode}-dpr3.png`) });
        if (phone) await page.screenshot({ path: testInfo.outputPath(`bob-assistant-${mode}-dpr3.png`) });
        // The rail's brand heading (in the drawer at phone width); the phone top bar carries the page title, not the mark.
        const header = page.getByRole('link', { name: 'Bob home', exact: true }).locator('svg image').first();
        await expect(header).toHaveAttribute('xlink:href', source ?? '');
        await page.screenshot({ path: testInfo.outputPath(`bob-header-${mode}-dpr3.png`) });
      });
    });
  }
});
