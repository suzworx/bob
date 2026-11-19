import type { Page, Response } from '@playwright/test';
import { menuItem } from '../components/menu.ts';

const clockedPages = new WeakSet<Page>();

/** Install before app navigation; only browser timers advance, never the server's scheduler. */
export async function installAppClock(page: Page): Promise<void> {
  await page.clock.install({ time: new Date() });
  clockedPages.add(page);
}

/** App actions share one adaptive menu on desktop and touch layouts. */
export async function openAppMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'App actions', exact: true }).or(page.getByRole('button', { name: 'More app actions', exact: true })).click();
}

export async function clickAppAction(page: Page, name: string): Promise<void> {
  await openAppMenu(page);
  await chooseAppMenuItem(page, name);
}

/** Select from an already open menu while preserving assertions or screenshots made in it. */
export async function chooseAppMenuItem(page: Page, name: string): Promise<void> {
  const item = menuItem(page, name, { exact: true });
  const sheet = await item.evaluateHandle((element) => element.closest('dialog'));
  try {
    await item.click();
    // Accessibility hiding precedes native close. Only this originating sheet must close:
    // Delete may have opened a separate confirmation dialog that must remain available.
    if (await sheet.evaluate((dialog) => dialog !== null && dialog.isConnected && dialog.open)) {
      if (clockedPages.has(page)) await page.clock.runFor(500);
      await page.waitForFunction((dialog) => dialog === null || !dialog.isConnected || !dialog.open, sheet);
    }
  } finally { await sheet.dispose(); }
}

function appRead(page: Page, path: string): Promise<Response> {
  return page.waitForResponse(async (response) => {
    if (response.request().method() !== 'GET' || new URL(response.url()).pathname !== path) return false;
    if (await response.finished()) return false;
    try { await response.body(); return true; }
    catch { return false; } // A superseded read may have headers but no completed body.
  });
}

/** Exercise the existing visible-page poll and wait for its actual app response without replacing the page. */
export async function pollOpenApp(page: Page, appId: string): Promise<Response> {
  const fresh = appRead(page, `/api/bob-apps/${appId}`);
  await page.clock.fastForward(15_001);
  return fresh;
}

/** Exercise the existing return-to-tab observer after its throttle, retaining all open editors and drafts. */
export async function returnToApp(page: Page, path: string): Promise<Response> {
  await page.clock.fastForward(5_001);
  const fresh = appRead(page, path);
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  return fresh;
}
