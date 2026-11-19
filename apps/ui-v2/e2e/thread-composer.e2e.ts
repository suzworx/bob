/**
 * #899: on iPhone Safari, opening a space thread and raising the keyboard left
 * the composer floating mid-screen with a gap above the keyboard, blurred by
 * ChatLayout's frosted dock. Root cause: the thread nested ChatLayout's own
 * scroller and sticky dock inside a second scrollable, padded LayoutContent
 * (spaces-page.tsx), so the keyboard-driven scroll moved the outer box while
 * the dock stayed pinned inside the inner one. Playwright cannot drive a real
 * on-screen keyboard, so shrinking the viewport height stands in for it: that
 * shorter visual viewport is what actually floated the composer on the phone.
 *
 * c2: an empty thread has nothing to overflow, so "<=1 scroller" passed on
 * the broken layout too (0 scrollers either way). Every run here seeds enough
 * messages to overflow the shrunk viewport, then asserts EXACTLY one vertical
 * scroller and that it is ChatLayout's own (an ancestor of the message list,
 * role="log"), not a second one wrapping it. The frosted-dock blur is
 * WebKit-specific rendering, so it gets its own describe with
 * devices['iPhone 14'] alongside the existing mobile-390 (Chromium) run.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { devices, webkit, type APIRequestContext, type Page } from '@playwright/test';
import { expect, ok, test } from './fixtures.ts';
import { ThreadPage } from './pages/thread-page.ts';
import { AUTH_FILE, E2E_DATA } from './stack.ts';

const MESSAGE_COUNT = 20;
const SHRUNK_HEIGHT = 500;

/** A space + thread with enough messages to overflow a shrunk phone viewport, made through the real API. */
async function seedOverflowingThread(api: APIRequestContext, tag: string): Promise<{ spaceId: string; threadId: string }> {
  const space = await api.post('/api/spaces', { data: { kind: 'group', name: `Composer ${tag}` } });
  await ok('create space', space);
  const spaceId = ((await space.json()) as { id: string }).id;
  const thread = await api.post(`/api/spaces/${spaceId}/threads`, { data: { title: `Thread ${tag}` } });
  await ok('create thread', thread);
  const threadId = ((await thread.json()) as { id: string }).id;
  for (let index = 0; index < MESSAGE_COUNT; index += 1) {
    const posted = await api.post(`/api/threads/${threadId}/messages`, {
      data: { body: `Message ${index} of the overflow fixture, long enough to wrap a line or two.`, client_message_id: `${tag}-seed-${index}` },
    });
    await ok(`seed message ${index}`, posted);
  }
  return { spaceId, threadId };
}

interface ScrollCheck {
  logFound: boolean;
  scrollerCount: number;
  oneScrollerWrapsLog: boolean;
}

/** Counts every element that actually scrolls vertically, and whether the (at
 * most one) such element is the message list (role="log") or an ancestor of
 * it -- ChatLayout's own scroller, not a second one wrapping it. */
async function checkScrollers(page: Page): Promise<ScrollCheck> {
  return page.evaluate((): ScrollCheck => {
    const log = document.querySelector('[role="log"]');
    const scrollers: Element[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const style = getComputedStyle(el);
      const scrolls = (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
      if (scrolls) scrollers.push(el);
    }
    return {
      logFound: log !== null,
      scrollerCount: scrollers.length,
      oneScrollerWrapsLog: log !== null && scrollers.length === 1 && scrollers[0].contains(log),
    };
  });
}

// #899 said "about 150 px of blank space" above the keyboard; the fixed
// layout's own gap is three *intentional* insets stacking (measured by
// dumping getBoundingClientRect up the send button's ancestor chain): the
// Section's page gutter (SPACE_GUTTER, 24px -- re-applied for every tab, not
// something this fix changed), ChatLayout's own spacious composer-dock inset
// (12px -- the same spacing-3 token PAGE_WIDTH's own comment documents for
// main chat), and the composer card's inner padding below the send button
// (12px). 24+12+12 = 48px measured exactly; 64 leaves slack for rounding
// while staying far below the ~150px the bug actually produced.
const DOCKED_GAP_MAX = 64;

/** (a) the composer's bottom sits close to the (shrunk) viewport bottom -- not
 * floating mid-screen above it. */
async function expectComposerDocked(page: Page): Promise<void> {
  const inputBox = await page.getByRole('combobox', { name: 'Message' }).boundingBox();
  const sendBox = await page.getByRole('button', { name: 'Send' }).boundingBox();
  if (!inputBox || !sendBox) throw new Error('composer has no layout box');
  const composerBottom = Math.max(inputBox.y + inputBox.height, sendBox.y + sendBox.height);
  expect(SHRUNK_HEIGHT - composerBottom).toBeLessThanOrEqual(DOCKED_GAP_MAX);
}

/** Nothing is painted over the send button at its own centre -- #899's
 * frosted-blur dock (WebKit) or a mispositioned composer (any engine) in the
 * nested-scroller layout, the symptom this check exists to catch. */
async function expectNothingOverSendButton(page: Page): Promise<void> {
  const sendButton = page.getByRole('button', { name: 'Send' });
  const sendBox = await sendButton.boundingBox();
  if (!sendBox) throw new Error('send button has no layout box');
  const centre = { x: sendBox.x + sendBox.width / 2, y: sendBox.y + sendBox.height / 2 };
  const onTop = await sendButton.evaluate((button, point) => {
    const top = document.elementFromPoint(point.x, point.y);
    return top !== null && (top === button || button.contains(top));
  }, centre);
  expect(onTop).toBe(true);
}

/** Seeds an overflowing thread, opens it, types a draft, then shrinks the
 * viewport to stand in for the iOS keyboard opening. Registers the space's
 * cleanup on the caller's fixture. */
async function openOverflowingThreadAndShrink(
  page: Page,
  api: APIRequestContext,
  tag: string,
  cleanup: (undo: () => Promise<unknown>) => void,
): Promise<void> {
  const { spaceId, threadId } = await seedOverflowingThread(api, tag);
  cleanup(async () => ok('archive space', await api.delete(`/api/spaces/${spaceId}`)));
  await new ThreadPage(page).goto(spaceId, threadId);
  await page.getByRole('combobox', { name: 'Message' }).click();
  await page.getByRole('combobox', { name: 'Message' }).fill('Hi');

  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport size');
  await page.setViewportSize({ width: viewport.width, height: SHRUNK_HEIGHT });
}

test('the thread composer docks above a shrunk viewport with exactly one scroller', async ({ page, api, tag, cleanup }, info) => {
  test.skip(info.project.name !== 'mobile-390', 'the keyboard-gap regression is a phone-width layout bug');

  await openOverflowingThreadAndShrink(page, api, tag, cleanup);
  await page.screenshot({ path: join(E2E_DATA, 'screenshots', 'thread-composer-after-chromium.png') });

  await expectComposerDocked(page);
  const scrolling = await checkScrollers(page);
  expect(scrolling.logFound).toBe(true);
  expect(scrolling.scrollerCount).toBe(1);
  expect(scrolling.oneScrollerWrapsLog).toBe(true);
  await expectNothingOverSendButton(page);
});

// The frosted dock's blur-over-send symptom is WebKit rendering specifically
// (backdrop-filter stacking inside a nested scroller). Playwright refuses
// `test.use({ defaultBrowserType })` inside a describe ("forces a new
// worker"; only valid top-level in the file or in the config, and a
// file-level use() would force EVERY test in this file onto WebKit, losing
// the Chromium run above) -- so this launches its own WebKit browser/context
// directly instead of asking the fixture system for one. CI installs only
// Chromium, so this skips there with a clear reason; install locally with
// `npx playwright install webkit` from apps/ui-v2.
test.describe('WebKit (#899 frosted dock)', () => {
  test('the composer docks with exactly one scroller and nothing painted over Send', async ({ api, tag, cleanup }, info) => {
    test.skip(info.project.name !== 'mobile-390', 'one run is enough; this test launches its own WebKit browser');
    test.skip(
      !existsSync(webkit.executablePath()),
      'WebKit is not installed locally (CI installs only Chromium); run `npx playwright install webkit` from apps/ui-v2.',
    );

    // `@playwright/test`'s `webkit` export inherits this project's `channel:
    // 'msedge'` (a Chromium-only option), so a bare launch() fails with
    // "Unsupported webkit channel msedge"; clearing it here overrides that.
    const browser = await webkit.launch({ channel: undefined });
    try {
      const context = await browser.newContext({ ...devices['iPhone 14'], storageState: AUTH_FILE });
      try {
        const page = await context.newPage();
        await openOverflowingThreadAndShrink(page, api, tag, cleanup);
        await page.screenshot({ path: join(E2E_DATA, 'screenshots', 'thread-composer-after-webkit.png') });

        await expectComposerDocked(page);
        const scrolling = await checkScrollers(page);
        expect(scrolling.logFound).toBe(true);
        expect(scrolling.scrollerCount).toBe(1);
        expect(scrolling.oneScrollerWrapsLog).toBe(true);
        await expectNothingOverSendButton(page);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
});
