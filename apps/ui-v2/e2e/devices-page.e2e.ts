/**
 * #668 U2: the Devices page opens on "Now talking in", and its picker moves the
 * Cardputer to an existing General chat, an existing space thread, a new
 * General conversation or a new thread in a space; offline it is pending until
 * the device's next hello. A fake Cardputer (support/fake-cardputer.ts) pairs
 * to the suite's own API, as in use-on-cardputer.e2e.ts. Also leaves
 * data/e2e/screenshots/668-u2-{card,picker}-{desktop,mobile}.png for review.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Locator, Page, TestInfo } from '@playwright/test';
import { expect, ok, test as base } from './fixtures.ts';
import { APPLIED, DeviceCard, DeviceHome, WAITING } from './pages/device-card.ts';
import { DeviceHeader } from './pages/device-header.ts';
import { FakeCardputer, pairFakeCardputer, type DeviceMessage, type PairedCardputer } from './support/fake-cardputer.ts';
import { AUTH_FILE, BASE_URL, E2E_API_PORT, E2E_DATA, FOUND_BASE_URL } from './stack.ts';
import { prefixedId } from '../src/lib/ids.ts';
import { menuItem } from './components/menu.ts';

function webBearer(): string {
  const state = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as { origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }> };
  const item = state.origins?.flatMap((origin) => origin.localStorage ?? []).find((entry) => /^sb-.+-auth-token$/.test(entry.name));
  if (!item) throw new Error(`no Supabase session in ${AUTH_FILE}`);
  return (JSON.parse(item.value) as { access_token: string }).access_token;
}

// Each worker pairs its own device under its own name, so a page holding
// another worker's device still finds this one.
type NamedCardputer = PairedCardputer & { name: string };

const test = base.extend<{ device: FakeCardputer }, { paired: NamedCardputer }>({
  paired: [async ({ playwright }, use, workerInfo) => {
    const name = `E2E Cardputer w${workerInfo.workerIndex}`;
    const api = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${webBearer()}` } });
    const paired = await pairFakeCardputer(E2E_API_PORT, async (userCode) => {
      const lookup = await api.post('/api/pair/lookup', { data: { user_code: userCode } });
      await ok('pair lookup', lookup);
      const { pairing_id } = (await lookup.json()) as { pairing_id: string };
      await ok('pair approve', await api.post('/api/pair/approve', { data: { pairing_id, name } }));
    });
    await use({ ...paired, name });
    await ok('revoke device', await api.delete(`/api/devices/${paired.deviceId}`));
    await api.dispose();
  }, { scope: 'worker' }],
  device: async ({ paired }, use) => {
    const device = await FakeCardputer.connect(E2E_API_PORT, paired.token);
    await device.hello();
    await use(device);
    await device.close();
  },
});

type Cleanup = (undo: () => Promise<unknown>) => void;
const pointsAt = (id: string | null) => (message: DeviceMessage): boolean => message.payload.id === id;

async function activeId(api: APIRequestContext): Promise<unknown> {
  const response = await api.get('/api/active');
  await ok('read active', response);
  return ((await response.json()) as { active?: { conversation_id?: unknown } | null }).active?.conversation_id ?? null;
}

/** Leaves data/e2e/screenshots/668-<name>-<desktop|mobile>.png of a page or one section. */
async function shot(target: Page | Locator, info: TestInfo, name: string): Promise<void> {
  const size = info.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  if (info.repeatEachIndex === 0) await target.screenshot({ path: join(E2E_DATA, 'screenshots', `668-${name}-${size}.png`) });
}

async function newChat(api: APIRequestContext, tag: string, cleanup: Cleanup): Promise<{ id: string; title: string }> {
  const turn = await api.post('/api/chat', { data: { message: { id: `msg-${randomBytes(6).toString('hex')}`, role: 'user', parts: [{ type: 'text', text: `Card ${tag}` }] } } });
  await ok('chat turn', turn);
  const id = (await turn.text()).match(/"conversationId":"([^"]+)"/)?.[1] ?? '';
  cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${id}`)));
  const title = `Card chat ${tag}`;
  await ok('title chat', await api.patch(`/api/conversations/${id}`, { data: { title } }));
  return { id, title };
}

async function newSpace(api: APIRequestContext, tag: string, cleanup: Cleanup): Promise<{ spaceId: string; name: string }> {
  const name = `Card space ${tag}`;
  const space = await api.post('/api/spaces', { data: { kind: 'group', name } });
  await ok('create space', space);
  const spaceId = ((await space.json()) as { id: string }).id;
  cleanup(async () => ok('archive space', await api.delete(`/api/spaces/${spaceId}`)));
  return { spaceId, name };
}

/** Opens /devices/<id> and waits until the tab hears account events. */
async function openCard(page: Page, deviceId: string): Promise<DeviceCard> {
  const card = new DeviceCard(page);
  await card.goto(deviceId);
  await expect.poll(() => card.eventsLive).toBe(true);
  return card;
}

/**
 * c1: the device name and its badge show whole at every width (the name wraps,
 * the badge moves under it at 768px and below): no ellipsis, nothing past the
 * viewport, and no descendant cut short either.
 */
async function expectWhole(page: Page, text: string): Promise<void> {
  const element = page.getByText(text, { exact: true }).first();
  await expect(element).toBeVisible();
  const clipped = await element.evaluate((node) =>
    [node, ...node.querySelectorAll('*')].some((el) => el.scrollWidth > el.clientWidth + 1));
  expect(clipped, `"${text}" is cut short`).toBe(false);
  await expect(element).toBeInViewport({ ratio: 1 });
}

/** Waits until the server holds no connected device (a closed socket takes a moment). */
async function allOffline(api: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const body = (await (await api.get('/api/devices')).json()) as { devices: Array<{ connected?: boolean; live?: { connected?: boolean } }> };
    return body.devices.some((d) => d.connected === true || d.live?.connected === true);
  }).toBe(false);
}

test.describe('Devices page: Now talking in', () => {
  test.skip(Boolean(FOUND_BASE_URL), 'a found stack may have a real Cardputer; the fake one pairs only to the suite API');

  test('a, f: an existing General chat from the picker moves the pointer', async ({ page, api, tag, cleanup, device, paired }, info) => {
    const { id, title } = await newChat(api, tag, cleanup);
    const card = await openCard(page, paired.deviceId);
    await expectWhole(page, paired.name);
    await expectWhole(page, 'Connected');
    await card.openPicker();
    await shot(page, info, 'u2-picker');
    const since = device.mark();
    expect((await card.pick(title)).status()).toBe(200);
    await device.waitFor('active_conversation', pointsAt(id), since);
    expect(await activeId(api)).toBe(id);
    await expect(card.titleText()).toContainText(title);
    await expect(card.card.getByText(/^In General/)).toBeVisible();
    await shot(page, info, 'u2-card');
    expect(device.violations).toEqual([]);
  });

  test('b, g: an existing space thread moves both pointers', async ({ page, api, tag, cleanup, device, paired }) => {
    const { spaceId, name } = await newSpace(api, tag, cleanup);
    const threadTitle = `Card thread ${tag}`;
    const thread = await api.post(`/api/spaces/${spaceId}/threads`, { data: { title: threadTitle } });
    await ok('create thread', thread);
    const threadId = ((await thread.json()) as { id: string }).id;
    const card = await openCard(page, paired.deviceId);
    await card.openPicker();
    const since = device.mark();
    expect((await card.pick(threadTitle)).status()).toBe(200);
    await device.waitFor('active_space', pointsAt(spaceId), since);
    await device.waitFor('active_conversation', pointsAt(`thr_${threadId}`), since);
    expect(await activeId(api)).toBe(`thr_${threadId}`);
    await expect(card.titleText()).toContainText(threadTitle);
    await expect(card.card.getByText(new RegExp(`^In ${name}`))).toBeVisible();
    expect(device.violations).toEqual([]);
  });

  test('c: offline the pick is pending, and applied once the Cardputer says hello', async ({ page, api, tag, cleanup, paired }) => {
    const { id, title } = await newChat(api, tag, cleanup);
    await allOffline(api);
    const card = await openCard(page, paired.deviceId);
    await card.openPicker();
    expect((await card.pick(title)).status()).toBe(202);
    await expect(card.status(WAITING)).toBeVisible();
    await expect(card.titleText()).toContainText(title);
    const device = await FakeCardputer.connect(E2E_API_PORT, paired.token);
    try {
      const welcome = await device.hello();
      expect(welcome.payload.active_conversation).toMatchObject({ id });
      await expect(card.status(new RegExp(APPLIED.replace('.', '\\.')))).toBeVisible();
      expect(device.violations).toEqual([]);
    } finally {
      await device.close();
    }
  });

  test('d: the device changing its own conversation updates an open Devices tab', async ({ page, api, tag, cleanup, device, paired }) => {
    const { id, title } = await newChat(api, tag, cleanup);
    // A web chat turn points the Cardputer at its chat; move it off first.
    await ok('clear pointer', await api.put('/api/devices/active-conversation', { data: { conversation_id: null, space_id: null } }));
    const card = await openCard(page, paired.deviceId);
    await expect(card.titleText()).toContainText('A new conversation');
    const since = device.mark();
    device.send('select_conversation', { conversation_id: id });
    await device.waitFor('conversation_selected', (message) => message.payload.conversation_id === id, since);
    await expect(card.titleText()).toContainText(title);
  });

  test('e: the chat header control opens the same picker', async ({ page, api, tag, cleanup, device }) => {
    const here = await newChat(api, tag, cleanup);
    const other = await newChat(api, `${tag}-2`, cleanup);
    const header = new DeviceHeader(page);
    await page.goto(`/c/${here.id}`);
    await header.options.click();
    await menuItem(page, /^Change conversation/).click();
    const card = new DeviceCard(page);
    await expect(card.picker).toBeVisible();
    const since = device.mark();
    expect((await card.pick(other.title)).status()).toBe(200);
    await device.waitFor('active_conversation', pointsAt(other.id), since);
    expect(await activeId(api)).toBe(other.id);
  });

  test('h: New in General points the device at a new General conversation', async ({ page, api, cleanup, device, paired }) => {
    const card = await openCard(page, paired.deviceId);
    await card.openPicker();
    let since = device.mark();
    expect((await card.newInGeneral()).status()).toBe(200);
    await device.waitFor('active_conversation', pointsAt(null), since);
    await expect(card.titleText()).toContainText('A new conversation');
    // The next device turn creates the conversation and the device is told its id.
    since = device.mark();
    await device.voiceTurn();
    const moved = await device.waitFor('active_conversation', (message) => typeof message.payload.id === 'string', since);
    const newId = String(moved.payload.id);
    cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${newId}`)));
    expect(newId.startsWith('thr_')).toBe(false);
    expect(await activeId(api)).toBe(newId);
    await expect(card.titleText()).toContainText(String(moved.payload.title));
  });

  test('i: New in a space creates a thread there and points the device at it', async ({ page, api, tag, cleanup, device, paired }) => {
    const { spaceId, name } = await newSpace(api, tag, cleanup);
    const card = await openCard(page, paired.deviceId);
    await card.openPicker();
    const since = device.mark();
    expect((await card.newInSpace(name)).status()).toBe(200);
    const moved = await device.waitFor('active_conversation', (message) => String(message.payload.id).startsWith('thr_'), since);
    await device.waitFor('active_space', pointsAt(spaceId), since);
    const threads = (await (await api.get(`/api/spaces/${spaceId}/threads`)).json()) as { threads: Array<{ id: string; title: string }> };
    expect(threads.threads.map((t) => [`thr_${t.id}`, t.title])).toEqual([[moved.payload.id, 'Device conversation']]);
    expect(await activeId(api)).toBe(moved.payload.id);
    await expect(card.titleText()).toContainText('Device conversation');
    expect(device.violations).toEqual([]);
  });
});

// /devices is a status list once there are two devices; a row drills into one.
test.describe('Devices page: list and drill-in', () => {
  test.skip(Boolean(FOUND_BASE_URL), 'a found stack may have a real Cardputer; the fake one pairs only to the suite API');

  test('o: /devices/<id> opens only that device and survives a reload; the list leads to it and back', async ({ page, api, devicesPage, paired }) => {
    const talking = page.getByRole('heading', { name: 'Talking in', exact: true });
    await page.goto(`/devices/${paired.deviceId}`);
    await expect(devicesPage.deviceName(paired.name)).toBeVisible();
    await expect(talking).toHaveCount(1);
    await page.reload();
    await expect(devicesPage.deviceName(paired.name)).toBeVisible();

    await devicesPage.goto();
    // #1240: /devices is always the list, even with one device.
    await expect(devicesPage.row(paired.name)).toBeVisible();
    await expect(talking).toHaveCount(0);
    await devicesPage.row(paired.name).click();
    await expect(page).toHaveURL(new RegExp(`/devices/${prefixedId('device', paired.deviceId)}$`));
    await expect(devicesPage.deviceName(paired.name)).toBeVisible();
    await devicesPage.back.click();
    await expect(page).toHaveURL(/\/devices$/);
    await expect(devicesPage.row(paired.name)).toBeVisible();
    await page.goBack();
    await expect(devicesPage.deviceName(paired.name)).toBeVisible();
  });

  test('p: an unknown device id says so and leads back to the list', async ({ page, devicesPage, paired }) => {
    // A paired device, so the page is not the empty state.
    expect(paired.deviceId).not.toBe('not-a-device');
    await page.goto('/devices/not-a-device');
    await expect(page.getByRole('heading', { name: "This device isn't here anymore" })).toBeVisible();
    await page.getByRole('button', { name: 'Back to devices' }).click();
    await expect(page).toHaveURL(/\/devices$/);
    await expect(devicesPage.heading).toBeVisible();
  });
});

// #668 U4: the device's home under the card: Recent, Quick actions, Settings.
const DEVICE_STATE = { volume: 5, muted: false, mode: 'ptt', dnd: false, ring_seconds: 30, ring_sound: 'classic', battery_pct: 80, charging: false, fw_version: '0.9.0' };

/** Nothing inside `root` is cut short or runs past the viewport's width. */
async function expectNothingClipped(root: Locator): Promise<void> {
  const clipped = await root.evaluate((node) => {
    const width = window.innerWidth;
    return [...node.querySelectorAll('*')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > width + 1)
      .filter((el) => (el.textContent ?? '').trim() !== '' && getComputedStyle(el).overflowX !== 'auto')
      .map((el) => (el.textContent ?? '').slice(0, 40));
  });
  expect(clipped, 'text cut short').toEqual([]);
}

/** Opens this device's home at /devices/<id>, once the tab hears account events. */
async function openHome(page: Page, paired: NamedCardputer): Promise<DeviceHome> {
  await openCard(page, paired.deviceId);
  const home = new DeviceHome(page, paired.name);
  await home.settings.waitFor();
  return home;
}

test.describe('Devices page: the device home (#668 U4)', () => {
  test.skip(Boolean(FOUND_BASE_URL), 'a found stack may have a real Cardputer; the fake one pairs only to the suite API');

  test('j: Recent lists a turn the Cardputer spoke and opens its chat', async ({ page, api, cleanup, device, paired }, info) => {
    await ok('clear pointer', await api.put('/api/devices/active-conversation', { data: { conversation_id: null, space_id: null } }));
    const since = device.mark();
    await device.voiceTurn();
    const moved = await device.waitFor('active_conversation', (message) => typeof message.payload.id === 'string', since);
    const id = String(moved.payload.id);
    cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${id}`)));
    const home = await openHome(page, paired);
    const turn = home.recent.getByRole('listitem').getByRole('button').first();
    await expect(home.recent.getByText(/· General ·/).first()).toBeVisible();
    await expectNothingClipped(home.root);
    await shot(page, info, 'u4-page');
    await shot(home.recent, info, 'u4-recent');
    await turn.click();
    await expect(page).toHaveURL(new RegExp(`/c/${prefixedId('conversation', id)}$`));
  });

  test('k: Test speaker reaches the Cardputer as a ringing announce', async ({ page, device, paired }, info) => {
    const home = await openHome(page, paired);
    const since = device.mark();
    expect((await home.announce(() => home.action('Test speaker').click())).status()).toBe(202);
    const announce = await device.waitFor('announce', (message) => message.payload.title === 'Speaker test', since);
    expect(announce.payload).toMatchObject({ kind: 'notice', ring: true });
    device.send('announce_ack', { announce_id: announce.payload.announce_id, action: 'played' });
    await expect(home.status(`Sent to ${paired.name}.`)).toBeVisible();
    await shot(home.actions, info, 'u4-actions');
    expect(device.violations).toEqual([]);
  });

  test('l: Announce with text reaches the Cardputer without a ring', async ({ page, tag, device, paired }) => {
    const home = await openHome(page, paired);
    await home.action('Announce…').click();
    await home.announceDialog.getByRole('textbox', { name: /^Title/ }).fill(`Dinner ${tag}`.slice(0, 28));
    await home.announceDialog.getByRole('textbox', { name: /^Message/ }).fill('Come down please');
    const since = device.mark();
    expect((await home.announce(() => home.announceDialog.getByRole('button', { name: 'Announce', exact: true }).click())).status()).toBe(202);
    const announce = await device.waitFor('announce', (message) => message.payload.body === 'Come down please', since);
    expect(announce.payload).toMatchObject({ kind: 'notice', title: `Dinner ${tag}`.slice(0, 28), ring: false });
    device.send('announce_ack', { announce_id: announce.payload.announce_id, action: 'played' });
    await expect(home.announceDialog).toBeHidden();
    // The result is a toast.
    await expect(home.status(`Sent to ${paired.name}.`)).toBeVisible();
  });

  test('m: offline, Test speaker and Announce are off with the reason', async ({ page, api, paired }) => {
    await allOffline(api);
    const home = await openHome(page, paired);
    await expect(home.action('Test speaker')).toBeDisabled();
    await expect(home.action('Announce…')).toBeDisabled();
  });

  test('n: the Sound group expands and a volume change still applies', async ({ page, api, device, paired }, info) => {
    device.send('device_state', DEVICE_STATE);
    await expect.poll(async () => {
      const body = (await (await api.get('/api/devices')).json()) as { devices: Array<{ id: string; settings_supported: boolean; settings: { volume: number } }> };
      const mine = body.devices.find((d) => d.id === paired.deviceId);
      return mine?.settings_supported === true && mine.settings.volume === DEVICE_STATE.volume;
    }).toBe(true);
    const home = await openHome(page, paired);
    await expect(home.group('Sound')).toContainText(`Volume ${DEVICE_STATE.volume}`);
    await home.group('Sound').click();
    // c1: set by keyboard alone (Home, then ArrowRight x3): every key moves the
    // thumb, and the settled value is saved once and reaches the device.
    const target = 3;
    const volume = home.settings.getByRole('slider', { name: 'Volume' });
    await volume.focus();
    const patches: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && request.url().endsWith(`/api/devices/${paired.deviceId}/settings`)) patches.push(request.postData() ?? '');
    });
    const since = device.mark();
    const saved = await home.patchSettings(async () => {
      await volume.press('Home');
      await expect(volume).toHaveAttribute('aria-valuenow', '0');
      for (let step = 0; step < target; step += 1) await volume.press('ArrowRight');
      await expect(volume).toHaveAttribute('aria-valuenow', String(target));
    });
    expect(saved.status()).toBe(200);
    const control = await device.waitFor('device_control', (message) => message.payload.volume === target, since);
    expect(control.payload.volume).toBe(target);
    // c3: a pause longer than the 400 ms settle (real under CPU load) is a settle
    // of its own and may save a step on the way; the LAST save is the target.
    // "Exactly one save per burst" is the unit test's, on fake timers.
    await expect.poll(() => patches.at(-1)).toBe(JSON.stringify({ volume: target }));
    await expect(home.settings.getByText('Applying…')).toBeVisible();
    device.send('device_state', { ...DEVICE_STATE, volume: target });
    // "Applying…" shows only while the device has not confirmed.
    await expect(home.settings.getByText('Applying…')).toHaveCount(0);
    await expect(home.group('Sound')).toContainText(`Volume ${target}`);
    await expect(volume).toHaveAttribute('aria-valuenow', String(target));
    await expectNothingClipped(home.settings);
    await shot(home.settings, info, 'u4-settings');
    expect(device.violations).toEqual([]);
  });
});
