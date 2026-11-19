/**
 * #1423: a chat reply naming an invented host still opens the app in place, here,
 * on the host in use. The stub echoes the sentence, so this is the real chat path
 * with the exact bad link production stored. Stub-only: a live model would not echo it.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, ok, test } from './fixtures.ts';
import { isLive } from './stack.ts';
import type { BobApp } from '../src/features/bob-apps/bob-apps-api';

test('a reply with an invented host opens the app in place', async ({ page, chatPage, api, cleanup }) => {
  test.skip(isLive(), 'needs the echoing stub');
  await page.goto('/apps');
  await page.getByRole('button', { name: 'Budget starter' }).click();
  await expect(page.getByRole('button', { name: 'Use this app' })).toBeVisible();
  const appPath = new URL(page.url()).pathname;
  cleanup(async () => {
    const { app } = await (await api.get(`/api/bob-apps/${appPath.split('/').pop()}`)).json() as { app: BobApp };
    await ok('delete app fixture', await api.delete(`/api/bob-apps/${app.id}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } }));
  });

  await chatPage.goto();
  await chatPage.newChat();
  await chatPage.send(`Add fill-ups at https://your-app-host${appPath} today`);
  const conversationId = await chatPage.conversationId();
  cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${conversationId}`)));

  const link = chatPage.lastReply().getByRole('link', { name: 'Open app' });
  await expect(link).toHaveAttribute('href', appPath);
  await expect(chatPage.lastReply()).not.toContainText('your-app-host');

  // A full page load would drop this marker: the click must stay in the running app.
  await page.evaluate(() => { (window as unknown as { stayedInApp: boolean }).stayedInApp = true; });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${appPath}$`));
  await expect(page.getByRole('button', { name: 'Use this app' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { stayedInApp?: boolean }).stayedInApp)).toBe(true);
});

const wrapLabel = 'a multi word link label that keeps going long enough to wrap across several lines in the chat bubble on a phone and also on a wide desktop screen, because a reply can always say this much in one link';
const longUrl = `https://example.com/a/very/long/path/${'segment-'.repeat(24)}end`;
const appId = '05341dbd-2f6a-4c1e-9a77-3f1e8b2c4d10';

// Set BOB_E2E_LINK_SHOTS to keep the pictures somewhere to look at.
test('chat links flow with their text at desktop and phone, light and dark', async ({ page, chatPage, api, cleanup }, testInfo) => {
  test.skip(isLive() || testInfo.project.name !== 'desktop-1280', 'needs the echoing stub; the test sets its own widths');
  await chatPage.goto();
  await chatPage.newChat();
  await chatPage.composer.fill([
    'Links',
    `In the app: https://your-app-host/apps/${appId} today.`,
    `Long: ${longUrl} end.`,
    `Before the wrap [${wrapLabel}](https://example.com/wrap) after the wrap.`,
    '# A heading with [a link in it](https://example.com/heading) here',
  ].join('\n\n'));
  await chatPage.sendButton.click();
  await expect(chatPage.lastReply().getByRole('link', { name: 'a link in it' })).toBeVisible();
  const conversationId = await chatPage.conversationId();
  cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${conversationId}`)));
  const conversation = page.url();
  const dir = process.env.BOB_E2E_LINK_SHOTS ?? testInfo.outputPath('links');
  mkdirSync(dir, { recursive: true });

  for (const width of [1280, 375]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('bob.theme', value), theme);
      await page.goto(`${conversation}?theme=${theme}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const reply = chatPage.lastReply();
      await expect(reply.getByRole('link', { name: 'a link in it' })).toBeVisible();
      await reply.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(dir, `links-${width}-${theme}.png`), fullPage: true });
      await reply.screenshot({ path: join(dir, `reply-${width}-${theme}.png`) });
      const facts = await reply.evaluate((root, label) => {
        const links = [...root.querySelectorAll('a')];
        const named = (text: string): HTMLAnchorElement => {
          const found = links.find((link) => link.textContent?.startsWith(text));
          if (!found) throw new Error(`no link ${text}`);
          return found;
        };
        const lines = (element: Element): number => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
        };
        const wrap = named(label.slice(0, 12));
        const heading = named('a link in it');
        const external = named('https://example.com/a/very');
        const headingText = heading.closest('h1,h2,h3,h4,h5,h6');
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-text-accent)';
        root.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const bubble = root.getBoundingClientRect();
        return {
          wrapLines: lines(wrap),
          headingFont: getComputedStyle(heading.querySelector('*') ?? heading).fontSize,
          headingParentFont: headingText ? getComputedStyle(headingText).fontSize : '',
          externalColor: getComputedStyle(external.querySelector('*') ?? external).color,
          externalUnderline: getComputedStyle(external).textDecorationLine,
          accent,
          externalOverflowPx: Math.round(Math.max(...[...external.getClientRects()].map((rect) => rect.right)) - bubble.right),
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      }, wrapLabel);
      console.log(`[links ${width} ${theme}] ${JSON.stringify(facts)}`);
      expect.soft(facts.wrapLines, `wrap ${width} ${theme}`).toBeGreaterThan(1);
      expect.soft(facts.headingFont, `heading ${width} ${theme}`).toBe(facts.headingParentFont);
      expect.soft(facts.externalColor, `colour ${width} ${theme}`).toBe(facts.accent);
      expect.soft(facts.externalOverflowPx, `overflow ${width} ${theme}`).toBeLessThanOrEqual(0);
      expect.soft(facts.pageOverflow, `page ${width} ${theme}`).toBe(false);
    }
  }
});
