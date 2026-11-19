/**
 * #667: the visible "Use on Cardputer" control in the real app shell, in a
 * General chat header and a space thread's title bar. A fake Cardputer
 * (support/fake-cardputer.ts) pairs to the suite's own API, as in
 * thread-pointer.e2e.ts; a second tab of the same account must follow the
 * move live. Also leaves data/e2e/screenshots/667-after-*.png for review.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { expect, ok, test as base } from './fixtures.ts';
import { PENDING } from './pages/device-card.ts';
import { DeviceHeader } from './pages/device-header.ts';
import {
  FakeCardputer, listDevices, pairFakeCardputer, revokeAllDevices, revokeDevice, type DeviceMessage, type PairedCardputer,
} from './support/fake-cardputer.ts';
import { AUTH_FILE, BASE_URL, E2E_API_PORT, E2E_DATA, FOUND_BASE_URL } from './stack.ts';

function webBearer(): string {
  const state = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as { origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }> };
  const item = state.origins?.flatMap((origin) => origin.localStorage ?? []).find((entry) => /^sb-.+-auth-token$/.test(entry.name));
  if (!item) throw new Error(`no Supabase session in ${AUTH_FILE}`);
  return (JSON.parse(item.value) as { access_token: string }).access_token;
}

const test = base.extend<{ device: FakeCardputer }, { paired: PairedCardputer }>({
  paired: [async ({ playwright }, use) => {
    const api = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${webBearer()}` } });
    const paired = await pairFakeCardputer(E2E_API_PORT, async (userCode) => {
      const lookup = await api.post('/api/pair/lookup', { data: { user_code: userCode } });
      await ok('pair lookup', lookup);
      const { pairing_id } = (await lookup.json()) as { pairing_id: string };
      await ok('pair approve', await api.post('/api/pair/approve', { data: { pairing_id, name: 'E2E Cardputer' } }));
    });
    await use(paired);
    await revokeDevice(api, paired.deviceId); // the no-device case may have revoked it already
    await api.dispose();
  }, { scope: 'worker' }],
  device: async ({ paired }, use) => {
    const device = await FakeCardputer.connect(E2E_API_PORT, paired.token);
    await device.hello();
    await use(device);
    await device.close();
  },
});

const pointsAt = (id: string) => (message: DeviceMessage): boolean => message.payload.id === id;

async function activeId(api: APIRequestContext): Promise<unknown> {
  const response = await api.get('/api/active');
  await ok('read active', response);
  return ((await response.json()) as { active?: { conversation_id?: unknown } | null }).active?.conversation_id ?? null;
}

async function shot(page: Page, info: TestInfo, surface: string): Promise<void> {
  const size = info.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  if (info.repeatEachIndex === 0) await page.screenshot({ path: join(E2E_DATA, 'screenshots', `667-after-${surface}-${size}.png`) });
}

async function newThread(api: APIRequestContext, tag: string, cleanup: (undo: () => Promise<unknown>) => void) {
  const space = await api.post('/api/spaces', { data: { kind: 'group', name: `Header ${tag}` } });
  await ok('create space', space);
  const spaceId = ((await space.json()) as { id: string }).id;
  cleanup(async () => ok('archive space', await api.delete(`/api/spaces/${spaceId}`)));
  const thread = await api.post(`/api/spaces/${spaceId}/threads`, { data: { title: `Thread ${tag}` } });
  await ok('create thread', thread);
  return { spaceId, threadId: ((await thread.json()) as { id: string }).id };
}

/**
 * The button is wholly on screen as the page first shows it, before any click:
 * the page and every scroller in it are unscrolled, so neither the user nor
 * Playwright's auto-scroll moved it there (#667: at 390px the thread's bar once
 * sat past the end of the sideways-scrolling tab row).
 */
async function expectOnScreen(tab: DeviceHeader): Promise<void> {
  await expect(tab.useOnCardputer).toBeVisible();
  const scrolled = await tab.page.evaluate(() =>
    [document.scrollingElement, ...document.querySelectorAll('*')].filter((el) => el !== null && (el.scrollLeft !== 0 || el.scrollTop !== 0)).length);
  expect(scrolled).toBe(0);
  const box = await tab.useOnCardputer.boundingBox();
  const view = tab.page.viewportSize();
  if (!box || !view) throw new Error('the button has no box, or the page no viewport');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  await expect(tab.useOnCardputer).toBeInViewport({ ratio: 1 });
}

/** Opens `path` in two tabs and waits until both hear account events. */
async function twoTabs(page: Page, second: Page, path: string, api: APIRequestContext): Promise<[DeviceHeader, DeviceHeader]> {
  const tabs: [DeviceHeader, DeviceHeader] = [new DeviceHeader(page), new DeviceHeader(second)];
  for (const tab of tabs) await tab.page.goto(path);
  await expect.poll(async () => {
    await ok('clear pointer', await api.put('/api/devices/active-conversation', { data: { conversation_id: null, space_id: null } }));
    return tabs.every((tab) => tab.eventsLive);
    // Two tabs opening their event streams can take well over 10 s on a loaded
    // machine (#668 c3); a stream that never opens still fails here.
  }, { timeout: 30_000 }).toBe(true);
  return tabs;
}

test.describe('Use on Cardputer in the header', () => {
  test.skip(Boolean(FOUND_BASE_URL), 'a found stack may have a real Cardputer; the fake one pairs only to the suite API');

  test('a General chat: one click moves the pointer, the other tab follows', async ({ page, context, api, tag, cleanup, device }, info) => {
    const turn = await api.post('/api/chat', { data: { message: { id: `msg-${randomBytes(6).toString('hex')}`, role: 'user', parts: [{ type: 'text', text: `Header ${tag}` }] } } });
    await ok('chat turn', turn);
    const id = (await turn.text()).match(/"conversationId":"([^"]+)"/)?.[1] ?? '';
    cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${id}`)));
    const [tabA, tabB] = await twoTabs(page, await context.newPage(), `/c/${id}`, api);
    await expectOnScreen(tabA);
    await shot(page, info, 'chat');

    const since = device.mark();
    expect((await tabA.use()).status()).toBe(200);
    await device.waitFor('active_conversation', pointsAt(id), since);
    expect(await activeId(api)).toBe(id);
    for (const tab of [tabA, tabB]) {
      await expect(tab.onCardputer).toBeVisible();
      await expect(tab.useOnCardputer).toHaveCount(0);
    }
    expect(device.violations).toEqual([]);
  });

  test('a space thread: one click moves both pointers, the other tab follows', async ({ page, context, api, tag, cleanup, device }, info) => {
    const { spaceId, threadId } = await newThread(api, tag, cleanup);
    const [tabA, tabB] = await twoTabs(page, await context.newPage(), `/spaces/${spaceId}/threads/${threadId}`, api);
    await expect(tabA.useOnCardputer).toBeVisible();
    await expectOnScreen(tabA);
    await shot(page, info, 'thread');

    const since = device.mark();
    expect((await tabA.use()).status()).toBe(200);
    await device.waitFor('active_space', pointsAt(spaceId), since);
    await device.waitFor('active_conversation', pointsAt(`thr_${threadId}`), since);
    expect(await activeId(api)).toBe(`thr_${threadId}`);
    for (const tab of [tabA, tabB]) await expect(tab.onCardputer).toBeVisible();
    expect(device.violations).toEqual([]);
  });

  // #682: a paired Cardputer that is offline still gets the move, as pending; its next welcome carries it.
  test('paired but offline: the click is kept as pending and the Cardputer gets it on reconnect', async ({ page, api, tag, cleanup, paired }) => {
    // Paired (this worker's fixture) and, once the last test's socket has closed, offline.
    await expect.poll(async () => (await listDevices(api)).filter((device) => device.connected)).toEqual([]);
    expect((await listDevices(api)).map((device) => device.id)).toContain(paired.deviceId);
    const { spaceId, threadId } = await newThread(api, tag, cleanup);
    const header = new DeviceHeader(page);
    await page.goto(`/spaces/${spaceId}/threads/${threadId}`);
    // "Applied" follows the account event device.changed, so the tab must be hearing events.
    await expect.poll(() => header.eventsLive).toBe(true);

    const put = await header.use();
    expect(put.status()).toBe(202);
    expect(await put.json()).toEqual({ status: 'pending' });
    expect(await activeId(api)).toBe(`thr_${threadId}`);
    // #668 U2: the 202 reads as pending, and stays until the Cardputer is back.
    await expect(header.status(PENDING)).toBeVisible();
    await expect(header.status(/^Sent to /)).toHaveCount(0);

    const device = await FakeCardputer.connect(E2E_API_PORT, paired.token);
    try {
      const welcome = await device.hello();
      expect(welcome.payload.active_conversation).toMatchObject({ id: `thr_${threadId}` });
      expect(welcome.payload.active_space).toMatchObject({ id: spaceId });
      await expect(header.status('Applied on the device.')).toBeVisible();
      await expect(header.status(PENDING)).toHaveCount(0);
      expect(device.violations).toEqual([]);
    } finally {
      await device.close();
    }
  });
});

// The base test, not this file's: no paired-device worker fixture outlives into it.
// A found stack may hold a real account's Cardputers, so the suite never revokes there.
base('with no paired device, the header shows no device control and moves nothing', async ({ page, api, tag, cleanup }) => {
  base.skip(Boolean(FOUND_BASE_URL), 'a found stack may have a real Cardputer; the suite never revokes a real device');
  // #1240: the header control appears only once a device is paired (offline or not).
  await revokeAllDevices(api);
  expect(await listDevices(api)).toEqual([]);

  const { spaceId, threadId } = await newThread(api, tag, cleanup);
  const before = await activeId(api);
  const header = new DeviceHeader(page);
  await page.goto(`/spaces/${spaceId}/threads/${threadId}`);
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
  await expect(header.useOnCardputer).toHaveCount(0);
  await expect(header.options).toHaveCount(0);
  await expect(header.onCardputer).toHaveCount(0);
  expect(await activeId(api)).toBe(before);
});
