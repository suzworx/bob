import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { expect, ok, test } from './fixtures.ts';
import { E2E_DATA, isLive } from './stack.ts';
import { menuItem } from './components/menu.ts';
import type { BobApp } from '../src/features/bob-apps/bob-apps-api';

const composer = (page: Page) => page.getByRole('combobox', { name: /^Message(?: input)?$/ });
async function readApp(api: APIRequestContext, id: string): Promise<BobApp> {
  const response = await api.get(`/api/bob-apps/${id}`); await ok('read accepted app', response);
  return (await response.json() as { app: BobApp }).app;
}
async function capture(page: Page, content: string, phase: string, info: TestInfo): Promise<void> {
  const fresh = await page.context().newPage();
  const directory = join(E2E_DATA, 'screenshots', 'apps-everyday'); mkdirSync(directory, { recursive: true });
  try {
    await fresh.goto(page.url());
    for (const scheme of ['light', 'dark'] as const) {
      await fresh.emulateMedia({ colorScheme: scheme });
      const mobile = info.project.name.startsWith('mobile');
      for (const width of mobile ? [375, 390] : [1280]) for (const height of mobile ? [667, 844] : [800]) {
        await fresh.setViewportSize({ width, height });
        await expect(fresh.getByText(content, { exact: true }).first()).toBeInViewport({ ratio: 1 });
        await expect(composer(fresh)).toHaveCount(1);
        await expect(composer(fresh)).toBeInViewport({ ratio: 1 });
        expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await fresh.screenshot({ path: join(directory, `${phase}-${scheme}-${width}x${height}-${info.project.name}.png`) });
      }
    }
  } finally { await fresh.close(); }
}

test('accept a real personal proposal in the conversation, then save a record with one app menu and one composer', async ({ page, api, cleanup, tag }, info) => {
  test.skip(isLive(), 'Uses the existing local scripted model; never spends on a live model.');
  test.setTimeout(180000);
  const title = `Little list ${tag}`;
  await page.goto('/');
  await composer(page).fill(`e2e make an app called ${title}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Stub: propose_bob_app finished.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this app', exact: true })).toBeVisible();
  const listed = await api.get('/api/bob-apps'); await ok('find proposed app', listed);
  const { apps } = await listed.json() as { apps: Array<{ id: string; title: string }> };
  const id = apps.find((app) => app.title === title)?.id;
  if (!id) throw new Error('Proposal did not save the requested app');
  cleanup(async () => {
    const response = await api.get(`/api/bob-apps/${id}`);
    if (response.status() === 404) return;
    const { app } = await response.json() as { app: BobApp };
    await ok('delete everyday fixture', await api.delete(`/api/bob-apps/${id}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } }));
  });
  expect((await readApp(api, id)).lifecycle).toBe('draft');
  await page.getByRole('button', { name: 'Use this app', exact: true }).click();
  await expect(page.getByText('Your app is ready. Make it yours.', { exact: true })).toBeVisible();
  expect((await readApp(api, id)).lifecycle).toBe('active');
  await page.getByRole('link', { name: 'Open app', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${id}(?:\\?|$)`));
  await expect(page.getByText('Nothing here yet', { exact: true })).toBeVisible();
  await expect(page.locator('img[src="/brand/bob/bob-playful.webp"]')).toBeVisible();
  await expect(page.getByText(/^Allowed actions:/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Automatic updates', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reload latest data', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Duplicate app', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete app', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'App actions', exact: true })).toHaveCount(1);
  await capture(page, 'Nothing here yet', 'empty', info);

  await page.getByRole('button', { name: `Add to ${title}`, exact: true }).click();
  const form = page.getByRole('dialog', { name: `Add to ${title}`, exact: true });
  const record = `A small win ${tag}`;
  await form.getByRole('textbox', { name: 'Text', exact: true }).fill(record);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications', exact: true }).getByText(`Added to ${title}`, { exact: true })).toBeVisible();
  await expect(page.getByText(record, { exact: true }).first()).toBeVisible();
  const saved = await readApp(api, id);
  expect(saved.state.items).toHaveLength(1);
  expect(saved.state.items?.[0]?.values.text).toBe(record);
  await composer(page).click();
  await composer(page).fill('Keep this little correction');
  await page.getByRole('button', { name: 'Change with Bob', exact: true }).click();
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveText('Keep this little correction');
  await page.getByRole('button', { name: 'App actions', exact: true }).click();
  await expect(menuItem(page, 'Export JSON', { exact: true })).toBeVisible();
  await menuItem(page, 'Delete app', { exact: true }).click();
  await expect(page.getByText('Delete this app?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await readApp(api, id)).state).toEqual(saved.state);
  await expect(composer(page)).toHaveText('Keep this little correction');
  await capture(page, record, 'saved', info);
  await expect(composer(page)).toHaveText('Keep this little correction');
});
