import { expect, test, type Locator, type Page } from '@playwright/test';
import { menuItem } from './components/menu.ts';
import { isPhone } from './pages/phone.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const SPACE = '00000000-0000-4000-8000-000000000002';
const THREAD = 'conv_composer_thread';
const CONVERSATION = 'conv_composer_personal';
const TIME = 1_792_137_600_000;
type ComposerState = 'empty' | 'focused' | 'scrolled' | 'resized';

async function prepareState(page: Page, input: Locator, scroller: Locator, state: ComposerState, touch: boolean): Promise<void> {
  if (state === 'focused') await input.fill('A fictional draft stays readable.');
  if (state === 'scrolled') {
    await input.blur();
    await scroller.evaluate((node) => { node.scrollTop = 0; });
    await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeLessThan(1);
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
    await expect.poll(() => scroller.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
  }
  if (state === 'resized' && touch) await page.setViewportSize({ width: 393, height: 520 });
}

async function assertControls(composer: Locator, input: Locator, state: ComposerState): Promise<void> {
  await expect(input).toBeVisible();
  if (state !== 'empty') await expect(input).toHaveText('A fictional draft stays readable.');
  const hit = await input.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return target === node || node.contains(target);
  });
  expect(hit).toBe(true);
  // On a phone the mic shows while the box is empty; Send replaces it once there is text.
  const send = composer.getByRole('button', { name: isPhone(composer.page()) && state === 'empty' ? 'Dictate' : 'Send', exact: true });
  await expect(send).toBeVisible();
  if (state !== 'empty') {
    await expect(send).toBeEnabled();
    await send.click({ trial: true });
  }
  const fits = await send.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
  });
  expect(fits).toBe(true);
}

// Exercise Astryx's documented jump-to-bottom path instead of measuring the
// spring's frame/scrollTop rounding; this suite verifies dock compositing.
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: 'reduce' });
test.beforeEach(async ({ page, context, baseURL }) => {
  test.skip(!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Fictional local fixture only');
  await page.addInitScript((user) => {
    localStorage.setItem('bob.dev.token', 'fictional-composer-regression');
    localStorage.setItem('bob.dev.tokenExpiry', String(Date.now() + 86_400_000));
    localStorage.setItem('bob.dev.userId', user);
  }, USER);
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const conversation = { id: CONVERSATION, title: 'A fictional plan', createdAt: TIME, updatedAt: TIME,
      messages: Array.from({ length: 16 }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? 'assistant' : 'user', position: i,
        versions: [{ id: `version-${i}`, parts: [{ type: 'text', text: 'A fictional plan with room for a gentle walk.' }], versionIndex: 0, selected: true }] })) };
    const responses: Record<string, unknown> = {
      '/api/public-config': { devSignIn: true }, '/api/conversations': { conversations: [conversation] },
      '/api/group-chats': { chats: [] },
      [`/api/conversations/${CONVERSATION}`]: conversation,
      '/api/spaces': { spaces: [{ id: SPACE, kind: 'group', name: 'Weekend plans', role: 'owner', membership_revision: 1, created_at: TIME, updated_at: TIME }] },
      [`/api/spaces/${SPACE}/members`]: { members: [{ user_id: USER, role: 'owner', display_name: 'Sam', handle: 'sam', joined_at: TIME }] },
      [`/api/spaces/${SPACE}/threads`]: { threads: [{ id: THREAD, space_id: SPACE, title: 'A shared plan', created_by: USER, archived_at: null, last_sequence: 16, unread_count: 0, created_at: TIME, updated_at: TIME }] },
      [`/api/threads/${THREAD}/messages`]: { messages: Array.from({ length: 16 }, (_, i) => ({ id: `thread-message-${i}`, thread_id: THREAD, space_id: SPACE, author_user_id: i % 2 ? null : USER,
        body: 'A fictional shared plan with room for a gentle walk.', reply_to_message_id: null, sequence: i + 1, client_message_id: `client-${i}`, revision: 1,
        tombstoned_at: null, tombstoned_by: null, created_at: TIME, updated_at: TIME, origin: 'web_text' })), next_cursor: null },
      '/api/active': { active: null }, '/api/devices': { devices: [] }, '/api/timers': { timers: [] },
      '/api/notifications': { notifications: [], next_cursor: null, unread_count: 0 }, '/api/operator/access': { error: { code: 'forbidden' } },
    };
    await route.fulfill({ status: path === '/api/operator/access' ? 403 : 200, json: responses[path] ?? {} });
  });
});

for (const theme of ['light', 'dark'] as const) {
  for (const surface of ['personal', 'thread'] as const) {
    test(`${theme} ${surface} keeps touch composers outside decorative backdrop effects`, async ({ page }, testInfo) => {
      await page.addInitScript((value) => localStorage.setItem('bob.theme', value), theme);
      await page.goto(surface === 'personal' ? `/c/${CONVERSATION}` : `/spaces/${SPACE}/threads/${THREAD}`);
      const composer = page.locator('.astryx-chat-composer');
      const input = composer.getByRole('combobox');
      await expect(input).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const touch = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
      const scroller = page.locator('.astryx-chat-layout');
      await expect.poll(() => scroller.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(100);
      await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
      for (const state of ['empty', 'focused', 'scrolled', 'resized'] as const) {
        await prepareState(page, input, scroller, state, touch);
        const backdropCount = await composer.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return [...document.querySelectorAll('.astryx-chat-layout *')].filter((element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return (style.backdropFilter !== 'none' || (style.getPropertyValue('-webkit-backdrop-filter') || 'none') !== 'none')
              && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top;
          }).length;
        });
        expect(backdropCount, `${state}: touch controls must not intersect a decorative blur layer`).toBe(touch ? 0 : 1);
        await assertControls(composer, input, state);
      }
      if (surface === 'thread') {
        // The composer's top row: @ opens the same member list on a phone and on desktop.
        await composer.getByRole('button', { name: 'Mention Bob, people or features', exact: true }).click();
        if (isPhone(page)) {
          // Picking one inserts a token.
          await expect(menuItem(page, /^Bob/)).toBeVisible();
          await menuItem(page, /^Bob/).click();
          const token = input.locator('[data-astryx-token-value]');
          await expect(token).toHaveCount(1);
          // The caret stays after the token, so the next keystrokes land behind it.
          await page.keyboard.type('hi');
          await expect(input).toContainText(/hi$/);
          await expect(token).toHaveCount(1);
        } else {
          await expect(page.getByRole('menu')).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(page.getByRole('menu')).toBeHidden();
        }
      } else {
        const picker = page.waitForEvent('filechooser');
        await composer.getByRole('button', { name: 'Attach', exact: true }).click();
        await (await picker).setFiles([]);
      }
      await expect(page.getByText('Reload the page to try again.', { exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-${theme}.png`) });
    });
  }
}
