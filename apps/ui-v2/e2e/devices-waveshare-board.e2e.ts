/**
 * WS185-SERVER: a Waveshare round-screen board pairs as its own device. The
 * devices list shows it as Bob, and the conversation header names the device
 * ("Use on Round Bob"), not "Cardputer". Leaves screenshots in
 * data/e2e/screenshots/ws185-*.png.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, ok, test } from './fixtures.ts';
import { FakeCardputer, pairFakeCardputer, revokeAllDevices } from './support/fake-cardputer.ts';
import { AUTH_FILE, BASE_URL, E2E_API_PORT, E2E_DATA, FOUND_BASE_URL } from './stack.ts';
import { menuItem } from './components/menu.ts';

const NAME = 'Round Bob';
const MODEL = 'Waveshare ESP32-S3 Round';
// The web app shows a Waveshare board as Bob (#1228), whatever model it paired
// with: the product name, then the hardware, once, under About (#1240).
const LABEL = 'Bob · Waveshare 1.85C';

function webBearer(): string {
  const state = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as { origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }> };
  const item = state.origins?.flatMap((origin) => origin.localStorage ?? []).find((entry) => /^sb-.+-auth-token$/.test(entry.name));
  if (!item) throw new Error(`no Supabase session in ${AUTH_FILE}`);
  return (JSON.parse(item.value) as { access_token: string }).access_token;
}

test.describe('Waveshare board is its own client', () => {
  test.skip(Boolean(FOUND_BASE_URL), 'the fake device pairs only to the suite API');

  test('devices list shows the model and the header names the device', async ({ page, playwright, api, tag, cleanup }, info) => {
    const owner = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${webBearer()}` } });
    await revokeAllDevices(owner); // one device: the labels name it
    const paired = await pairFakeCardputer(E2E_API_PORT, async (userCode) => {
      const lookup = await owner.post('/api/pair/lookup', { data: { user_code: userCode } });
      await ok('pair lookup', lookup);
      const { pairing_id } = (await lookup.json()) as { pairing_id: string };
      await ok('pair approve', await owner.post('/api/pair/approve', { data: { pairing_id, name: NAME } }));
    }, MODEL);
    cleanup(async () => ok('revoke device', await owner.delete(`/api/devices/${paired.deviceId}`)));
    const device = await FakeCardputer.connect(E2E_API_PORT, paired.token);
    cleanup(() => device.close());
    await device.hello('waveshare-s3-185c');

    const size = info.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
    await page.goto('/devices');
    await expect(page.getByText(NAME).first()).toBeVisible();
    // The list row is name and status; the model is on the device's own page.
    await page.getByRole('main').getByRole('button', { name: new RegExp(`^${NAME}`) }).click();
    await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible();
    await expect(page.getByText(LABEL, { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText(/Cardputer/)).toHaveCount(0);
    // Clipped past the sidebar, which shows the run account.
    const view = page.viewportSize() ?? { width: 1280, height: 800 };
    const left = view.width > 700 ? 300 : 0;
    await page.screenshot({ path: join(E2E_DATA, 'screenshots', `ws185-devices-${size}.png`), clip: { x: left, y: 0, width: view.width - left, height: 560 } });

    const turn = await api.post('/api/chat', { data: { message: { id: `msg-${tag}`, role: 'user', parts: [{ type: 'text', text: `Board ${tag}` }] } } });
    await ok('chat turn', turn);
    const id = (await turn.text()).match(/"conversationId":"([^"]+)"/)?.[1] ?? '';
    cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${id}`)));
    await page.goto(`/c/${id}`);
    const main = page.getByRole('main');
    await expect(main.getByText(`On ${NAME}`, { exact: true })).toBeVisible(); // the new chat is the device's pointer
    await expect(main.getByText(/Cardputer/)).toHaveCount(0);
    await main.getByRole('button', { name: `${NAME} options` }).click();
    await expect(menuItem(page, new RegExp(`^New conversation on ${NAME}`))).toBeVisible();
    // Clipped to the top of the page: the sidebar below shows the run account.
    await page.screenshot({ path: join(E2E_DATA, 'screenshots', `ws185-header-menu-${size}.png`), clip: { x: 0, y: 0, width: page.viewportSize()?.width ?? 1280, height: 200 } });
  });
});
