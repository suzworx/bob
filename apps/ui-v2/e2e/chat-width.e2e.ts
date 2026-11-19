import { expect, test, type Locator } from '@playwright/test';
import { menuItem } from './components/menu.ts';
import { composerAction, isPhone } from './pages/phone.ts';
const USER = '00000000-0000-4000-8000-000000000001';
const SPACE = '00000000-0000-4000-8000-000000000002';
const THREAD = 'conv_composer_thread';
const CONVERSATION = 'conv_composer_personal';
const TIME = 1_792_137_600_000;
const DEVICE = 'A very long fictional kitchen device name';
const LONG_MESSAGE = `A long fictional link: https://example.invalid/${'longword'.repeat(80)}\n\n\`\`\`text\n${'unbroken'.repeat(80)}\n\`\`\``;
// Fictional local fixtures exercise responsive width bounds without production writes.
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: 'reduce' });
test.beforeEach(async ({ page, context, baseURL }) => {
  test.skip(
    !baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname),
    'Fictional local fixture only',
  );
  await page.addInitScript((user) => {
    localStorage.setItem('bob.dev.token', 'fictional-composer-regression');
    localStorage.setItem('bob.dev.tokenExpiry', String(Date.now() + 86_400_000));
    localStorage.setItem('bob.dev.userId', user);
  }, USER);
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const conversation = {
      id: CONVERSATION,
      title: 'A long fictional conversation about weekend plans and a quiet afternoon outdoors',
      createdAt: TIME,
      updatedAt: TIME,
      messages: Array.from({ length: 16 }, (_, i) => ({
        id: `message-${i}`,
        role: i % 2 ? 'assistant' : 'user',
        position: i,
        versions: [
          {
            id: `version-${i}`,
            parts: [{ type: 'text', text: i === 15 ? LONG_MESSAGE : 'A fictional plan with room for a gentle walk.' }],
            versionIndex: 0,
            selected: true,
          },
        ],
      })),
    };
    const responses: Record<string, unknown> = {
      '/api/public-config': { devSignIn: true },
      '/api/conversations': { conversations: [conversation] },
      '/api/group-chats': { chats: [] },
      [`/api/conversations/${CONVERSATION}`]: conversation,
      '/api/spaces': {
        spaces: [
          {
            id: SPACE,
            kind: 'group',
            name: 'Weekend plans',
            role: 'owner',
            membership_revision: 1,
            created_at: TIME,
            updated_at: TIME,
          },
        ],
      },
      [`/api/spaces/${SPACE}/members`]: {
        members: [{ user_id: USER, role: 'owner', display_name: 'Sam', handle: 'sam', joined_at: TIME }],
      },
      [`/api/spaces/${SPACE}/threads`]: {
        threads: [
          {
            id: THREAD,
            space_id: SPACE,
            title: 'A long shared conversation about weekend plans and a quiet afternoon outdoors',
            created_by: USER,
            archived_at: null,
            last_sequence: 16,
            unread_count: 0,
            created_at: TIME,
            updated_at: TIME,
          },
        ],
      },
      [`/api/threads/${THREAD}/messages`]: {
        messages: Array.from({ length: 16 }, (_, i) => ({
          id: `thread-message-${i}`,
          thread_id: THREAD,
          space_id: SPACE,
          author_user_id: i % 2 ? null : USER,
          body: i === 15 ? LONG_MESSAGE : 'A fictional shared plan with room for a gentle walk.',
          reply_to_message_id: null,
          sequence: i + 1,
          client_message_id: `client-${i}`,
          revision: 1,
          tombstoned_at: null,
          tombstoned_by: null,
          created_at: TIME,
          updated_at: TIME,
          origin: 'web_text',
        })),
        next_cursor: null,
      },
      '/api/active': {
        active: {
          conversation_id: 'conv_other',
          title:
            'A very long fictional active conversation about planning the next weekend and visiting a museum with friends',
        },
      },
      '/api/devices': { devices: [{ id: 'device_demo', name: DEVICE, model: 'Cardputer', live: { connected: true } }] },
      '/api/timers': { timers: [] },
      '/api/notifications': { notifications: [], next_cursor: null, unread_count: 0 },
      '/api/operator/access': { error: { code: 'forbidden' } },
    };
    await route.fulfill({ status: path === '/api/operator/access' ? 403 : 200, json: responses[path] ?? {} });
  });
});

async function insideViewport(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  expect(
    await locator.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    }),
  ).toBe(true);
}

for (const width of [359, 390, 1440]) {
  for (const theme of ['light', 'dark'] as const) {
    for (const surface of ['personal', 'thread'] as const) {
      test(`${width}px ${theme} ${surface} keeps named device actions and composer in view`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: 740 });
        await page.addInitScript((value) => localStorage.setItem('bob.theme', value), theme);
        await page.goto(
          surface === 'personal' ? `/c/${CONVERSATION}` : `/spaces/${SPACE}/threads/${THREAD}`,
        );
        const action = page.getByRole('button', { name: `Use on ${DEVICE}`, exact: true });
        await expect(
          page.getByRole('status').filter({ hasText: /^On A very long fictional kitchen device name:/ }),
        ).toBeVisible();
        await expect(page.locator('.astryx-chat-message')).toHaveCount(16);
        await expect(page.getByText('A long fictional link:', { exact: false }).first()).toBeVisible();
        expect(
          await page.locator('.astryx-chat-message').evaluateAll((nodes) =>
            nodes.every((node) => {
              const box = node.getBoundingClientRect();
              return box.left >= 0 && box.right <= innerWidth;
            }),
          ),
        ).toBe(true);
        await insideViewport(action);
        const options = page.getByRole('button', { name: `${DEVICE} options`, exact: true });
        await insideViewport(options);
        await options.click();
        await menuItem(page, 'Change conversation…').click();
        await insideViewport(page.getByRole('dialog'));
        await page.keyboard.press('Escape');
        const input = page.locator('.astryx-chat-composer').getByRole('combobox');
        await insideViewport(input);
        await input.fill('A fictional draft stays within the phone.');
        await page.setViewportSize({ width, height: 520 });
        await insideViewport(input);
        const send = page.getByRole('button', { name: 'Send', exact: true });
        await insideViewport(send);
        await send.click({ trial: true });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.setViewportSize({ width, height: 740 });
        await page.screenshot({ path: testInfo.outputPath(`${surface}-${theme}-${width}.png`) });
        await page.route('**/api/active', (route) =>
          route.fulfill({
            json: {
              active: {
                conversation_id: surface === 'personal' ? CONVERSATION : `thr_${THREAD}`,
                title: 'Current conversation',
              },
            },
          }),
        );
        await page.reload();
        await insideViewport(page.getByText(`On ${DEVICE}`, { exact: true }));
        if (surface === 'personal') {
          if (isPhone(page)) {
            // No conversation header on a phone: Tools is a button on the composer's top row.
            await insideViewport(composerAction(page, 'Tools'));
          } else {
            await insideViewport(page.getByLabel('Conversation', { exact: true }).getByRole('link', { name: 'Tools', exact: true }));
          }
        }
        await insideViewport(options);
      });
    }
  }
}
