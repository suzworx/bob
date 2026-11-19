import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, ok, test } from './fixtures.ts';
import { menuItem } from './components/menu.ts';
import { isPhone } from './pages/phone.ts';
import { clickAppAction, installAppClock, openAppMenu, pollOpenApp } from './pages/bob-app-actions.ts';
import type { BobApp } from '../src/features/bob-apps/bob-apps-api';

test('saved budget app keeps dashboard and slides in sync and supports revision undo', async ({ page, api, cleanup, browser }, testInfo) => {
  await installAppClock(page);
  await page.goto('/apps');
  await expect(page.getByRole('heading', { name: 'My Apps', exact: true })).toBeVisible();
  const titleBox = await page.getByRole('heading', { name: 'My Apps', exact: true }).boundingBox();
  // On a phone the h1 is visually hidden (the top bar is the title) and content starts at the 16px gutter.
  if (isPhone(page)) {
    await expect(page.getByRole('heading', { name: 'My Apps', exact: true })).toBeAttached();
    expect((await page.getByRole('button', { name: 'Budget starter' }).boundingBox())?.x).toBeGreaterThanOrEqual(16);
  } else {
    expect(titleBox?.x).toBeGreaterThanOrEqual(24);
  }
  await page.getByRole('button', { name: 'Budget starter' }).click();
  await expect(page.getByRole('button', { name: 'Use this app' })).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').pop();
  cleanup(async () => {
    const response = await api.get(`/api/bob-apps/${id}`);
    if (response.status() === 404) return;
    const { app } = await response.json() as { app: BobApp };
    await ok('delete app fixture', await api.delete(`/api/bob-apps/${id}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } }));
  });
  await clickAppAction(page, 'App details');
  await expect(page.getByText(/Allowed actions: create Items/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to Expenses' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Use this app' }).click();
  await page.getByRole('button', { name: 'Add to Expenses' }).click();
  const form = page.getByRole('dialog', { name: 'Add to Expenses' });
  await form.getByRole('textbox', { name: 'Title', exact: true }).fill('Lunch');
  await form.getByLabel(/^Amount/).fill('12.5');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  // A phone lists records and a desktop tables them; the text is what both must show.
  await expect(page.getByText('Lunch', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByText('12.5', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Presentation', exact: true }).click();
  await expect(page.getByText('12.5', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('presentation.png'), fullPage: true });
  await page.reload();
  await expect(page.getByText('Lunch', { exact: true })).toBeVisible();
  const secondContext = await browser.newContext({ storageState: await page.context().storageState(), viewport: page.viewportSize() ?? undefined });
  const secondPage = await secondContext.newPage();
  await secondPage.goto(page.url());
  await expect(secondPage.getByText('Lunch', { exact: true })).toBeVisible();
  await secondContext.close();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const current = await api.get(`/api/bob-apps/${id}`);
  const { app } = await current.json() as { app: BobApp };
  const definition = { ...app.definition, title: 'Lunch budget' };
  await ok('propose app revision', await api.patch(`/api/bob-apps/${id}`, { data: { operation: 'revise', expectedRevision: app.revision, mutationId: randomUUID(), definition } }));
  if (!id) throw new Error('Missing app id');
  const fresh = await pollOpenApp(page, id);
  expect((await fresh.json() as { app: BobApp }).app.pendingDefinition?.title).toBe('Lunch budget');
  await expect(page.getByRole('heading', { name: 'Review proposed changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByRole('heading', { name: 'Lunch budget', exact: true })).toBeVisible();
  await clickAppAction(page, 'Undo last change');
  await expect(page.getByRole('heading', { name: 'Budget dashboard', exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await clickAppAction(page, 'Export JSON');
  expect((await download).suggestedFilename()).toBe('bob-app.json');
  await clickAppAction(page, 'Archive app');
  await openAppMenu(page);
  await expect(menuItem(page, 'Restore app', { exact: true })).toBeVisible();
  await menuItem(page, 'Restore app', { exact: true }).click();
  await openAppMenu(page);
  await expect(menuItem(page, 'Archive app', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('saved-app.png'), fullPage: true });
  await clickAppAction(page, 'Delete app');
  await page.getByRole('button', { name: 'Delete app permanently', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My Apps', exact: true })).toBeVisible();
});

const FUEL_LOG = {
  schemaVersion: 1, title: 'Fuel log', lifecycle: 'keep',
  tables: [{ id: 'fill_ups', fields: [{ id: 'station', type: 'text' }, { id: 'litres', type: 'number' }, { id: 'cost', type: 'number' }, { id: 'full_tank', type: 'boolean' }] }],
  actions: [{ id: 'add', table: 'fill_ups', operation: 'create' }, { id: 'edit', table: 'fill_ups', operation: 'update' }, { id: 'remove', table: 'fill_ups', operation: 'delete' }],
  metrics: [{ id: 'fills', table: 'fill_ups', operation: 'count' }],
  views: [{ id: 'log', kind: 'table', title: 'Fill-ups', table: 'fill_ups', fields: ['station', 'litres', 'cost'], actions: ['add', 'edit', 'remove'] }],
};

test('log, fix and remove a fill-up, one-handed on a phone with nothing off screen', async ({ page, api, cleanup }) => {
  if (isPhone(page)) await page.setViewportSize({ width: 375, height: 667 });
  const created = await api.post('/api/bob-apps', { data: { definition: FUEL_LOG, mutationId: randomUUID() } });
  await ok('create fuel log', created);
  const { app } = await created.json() as { app: BobApp };
  await ok('activate fuel log', await api.patch(`/api/bob-apps/${app.id}`, { data: { operation: 'activate', expectedRevision: app.revision, mutationId: randomUUID() } }));
  cleanup(async () => {
    const current = await api.get(`/api/bob-apps/${app.id}`);
    if (current.status() === 404) return;
    const { app: latest } = await current.json() as { app: BobApp };
    await ok('delete fuel log', await api.delete(`/api/bob-apps/${app.id}`, { data: { expectedRevision: latest.revision, mutationId: randomUUID() } }));
  });
  const noSidewaysScroll = async (): Promise<void> => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); };

  await page.goto('/apps');
  await expect(page.getByText('Fuel log', { exact: true })).toBeInViewport();
  await noSidewaysScroll();
  await page.getByRole('button', { name: /^Fuel log/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Fuel log' })).toBeInViewport();

  await page.getByRole('button', { name: 'Add to Fill-ups' }).click();
  const form = page.getByRole('dialog', { name: 'Add to Fill-ups' });
  const save = form.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeInViewport();
  await save.click();
  await expect(form.getByText('Litres needs a number, like 12.5.')).toBeVisible();
  await expect(form.getByText('Cost needs a number, like 12.5.')).toBeVisible();
  await form.getByRole('textbox', { name: 'Station', exact: true }).fill('Shell');
  await form.getByLabel(/^Litres/).fill('41.5');
  await form.getByLabel(/^Cost/).fill('62');
  await expect(save).toBeInViewport();
  await save.click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Added to Fill-ups')).toBeVisible();
  await expect(form).toHaveCount(0);
  await expect(page.getByText('Shell', { exact: true })).toBeVisible();
  await noSidewaysScroll();
  if (isPhone(page)) {
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByText('Litres: 41.5 · Cost: 62', { exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole('cell', { name: '41.5', exact: true })).toBeVisible();
    // The table bleeds into its container's padding; the next block must still sit clear of it.
    const tableBox = await page.getByRole('table').boundingBox();
    const nextBox = await page.getByRole('button', { name: 'Change with Bob' }).boundingBox();
    expect((nextBox?.y ?? 0) - ((tableBox?.y ?? 0) + (tableBox?.height ?? 0))).toBeGreaterThanOrEqual(16);
  }

  await page.getByRole('button', { name: 'Actions for Shell' }).click();
  await menuItem(page, 'Edit', { exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit in Fill-ups' });
  await edit.getByRole('textbox', { name: 'Station', exact: true }).fill('BP');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('BP', { exact: true })).toBeVisible();
  await expect(page.getByText('Shell', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Actions for BP' }).click();
  await menuItem(page, 'Remove', { exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('BP, Litres: 41.5 · Cost: 62 will be gone for good.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('BP', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for BP' }).click();
  await menuItem(page, 'Remove', { exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Removed from Fill-ups')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nothing here yet' })).toBeVisible();
  await noSidewaysScroll();
});

async function fuelLog(api: APIRequestContext, cleanup: (step: () => Promise<void>) => void): Promise<string> {
  const created = await api.post('/api/bob-apps', { data: { definition: FUEL_LOG, mutationId: randomUUID() } });
  await ok('create fuel log', created);
  const { app } = await created.json() as { app: BobApp };
  await ok('activate fuel log', await api.patch(`/api/bob-apps/${app.id}`, { data: { operation: 'activate', expectedRevision: app.revision, mutationId: randomUUID() } }));
  cleanup(async () => {
    const { app: latest } = await (await api.get(`/api/bob-apps/${app.id}`)).json() as { app: BobApp };
    await ok('delete fuel log', await api.delete(`/api/bob-apps/${app.id}`, { data: { expectedRevision: latest.revision, mutationId: randomUUID() } }));
  });
  return app.id;
}
async function records(api: APIRequestContext, id: string): Promise<BobApp['state'][string]> {
  const { app } = await (await api.get(`/api/bob-apps/${id}`)).json() as { app: BobApp };
  return app.state.fill_ups ?? [];
}
async function fillAdd(page: Page, station: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Add to Fill-ups' }).click();
  const form = page.getByRole('dialog', { name: 'Add to Fill-ups' });
  await form.getByRole('textbox', { name: 'Station', exact: true }).fill(station);
  await form.getByLabel(/^Litres/).fill('10');
  await form.getByLabel(/^Cost/).fill('20');
  return form;
}

test('a response lost after the server saved an add ends as one record, not an error', async ({ page, api, cleanup }) => {
  const id = await fuelLog(api, cleanup);
  await page.goto(`/apps/${id}`);
  const form = await fillAdd(page, 'Lost once');
  // The real server commits; only the reply is lost on the way back.
  await page.route(`**/api/bob-apps/${id}/actions`, async (route) => { await route.fetch(); await route.abort('connectionreset'); }, { times: 1 });
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Added to Fill-ups')).toBeVisible();
  await expect(form).toHaveCount(0);
  expect((await records(api, id)).filter((row) => row.values.station === 'Lost once')).toHaveLength(1);
});

test('when the reload is lost too, retrying a saved add still ends as one record', async ({ page, api, cleanup }) => {
  const id = await fuelLog(api, cleanup);
  await page.goto(`/apps/${id}`);
  const form = await fillAdd(page, 'Lost twice');
  await page.route(`**/api/bob-apps/${id}/actions`, async (route) => { await route.fetch(); await route.abort('connectionreset'); }, { times: 1 });
  await page.route(`**/api/bob-apps/${id}`, (route) => route.abort('connectionreset'), { times: 1 });
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form.getByText(/Couldn’t save this/)).toBeVisible();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Added to Fill-ups')).toBeVisible();
  await expect(form).toHaveCount(0);
  expect((await records(api, id)).filter((row) => row.values.station === 'Lost twice')).toHaveLength(1);
});

test('another change while the form is open is reviewed in the form, then saved', async ({ page, api, cleanup }) => {
  const id = await fuelLog(api, cleanup);
  await page.goto(`/apps/${id}`);
  const form = await fillAdd(page, 'Mine');
  const { app } = await (await api.get(`/api/bob-apps/${id}`)).json() as { app: BobApp };
  await ok('change elsewhere', await api.post(`/api/bob-apps/${id}/actions`, { data: { expectedRevision: app.revision, mutationId: randomUUID(), command: { operation: 'write', action: 'add', id: 'r_elsewhere', values: { station: 'Elsewhere', litres: 1, cost: 1, full_tank: false } } } }));
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form.getByText('Saved data changed while you were editing')).toBeVisible();
  await expect(form.getByRole('textbox', { name: 'Station', exact: true })).toHaveValue('Mine');
  await expect(form.getByText(/Reload/)).toHaveCount(0);
  await form.getByRole('button', { name: 'Keep my edits against latest data' }).click();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByText('Mine', { exact: true })).toBeVisible();
  await expect(page.getByText('Elsewhere', { exact: true })).toBeVisible();
});

test('Escape asks before throwing away a filled form', async ({ page, api, cleanup }) => {
  const id = await fuelLog(api, cleanup);
  await page.goto(`/apps/${id}`);
  const form = await fillAdd(page, 'Half typed');
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Discard');
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(form.getByRole('textbox', { name: 'Station', exact: true })).toHaveValue('Half typed');
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await expect(form).toHaveCount(0);
  expect(await records(api, id)).toHaveLength(0);
});

test.describe('on a comma-decimal phone', () => {
  test.use({ locale: 'de-DE' });
  test('a comma is the decimal point, on the way in and on the way out', async ({ page, api, cleanup }) => {
    const id = await fuelLog(api, cleanup);
    await page.goto(`/apps/${id}`);
    await page.getByRole('button', { name: 'Add to Fill-ups' }).click();
    const form = page.getByRole('dialog', { name: 'Add to Fill-ups' });
    await form.getByLabel(/^Litres/).fill('1,5');
    await form.getByLabel(/^Cost/).fill('20');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect((await records(api, id))[0]?.values.litres).toBe(1.5);
    await expect(page.getByText(/1,5/).first()).toBeVisible();
  });
});

test('tasks refresh requires consent and updates a saved app through the real scheduler', async ({ page, api, seed, cleanup, tag }, testInfo) => {
  await installAppClock(page);
  const spaceId = await seed.space();
  const taskTitle = tag + ' Scheduled app task';
  const task = await api.post(`/api/spaces/${spaceId}/tasks`, { data: { title: taskTitle } });
  await ok('create source task', task);
  const taskBody = await task.json() as { id: string; revision: number };
  cleanup(async () => { await api.delete(`/api/tasks/${taskBody.id}`, { data: { expected_revision: taskBody.revision } }); });
  await page.goto('/apps');
  await page.getByRole('button', { name: 'Tasks dashboard starter' }).click();
  await page.getByRole('button', { name: 'Use this app' }).click();
  const id = new URL(page.url()).pathname.split('/').pop();
  cleanup(async () => { const { app } = await (await api.get(`/api/bob-apps/${id}`)).json() as { app: BobApp }; await ok('delete refreshed app fixture', await api.delete(`/api/bob-apps/${id}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } })); });
  await page.getByRole('button', { name: 'Configure automatic updates' }).click();
  await page.getByRole('combobox', { name: 'Tasks from space' }).click();
  await page.getByRole('option').first().click();
  await expect(page.getByRole('button', { name: 'Enable automatic updates' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Let Bob read these tasks and replace this table on this schedule' }).check();
  await page.getByRole('button', { name: 'Enable automatic updates' }).click();
  await expect(page.getByText('Automatic updates are on.', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const response = await api.get(`/api/bob-apps/${id}`);
    const { app } = await response.json() as { app: BobApp };
    return app.state.tasks?.some((row) => row.values.title === taskTitle);
  }, { timeout: 60000, intervals: [1000] }).toBe(true);
  if (!id) throw new Error('Missing scheduled app id');
  const refreshed = await pollOpenApp(page, id);
  expect((await refreshed.json() as { app: BobApp }).app.state.tasks?.some((row) => row.values.title === taskTitle)).toBe(true);
  await expect(page.getByText(taskTitle, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to Checklist' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Refresh history' })).toBeVisible();
  await page.getByRole('button', { name: 'Presentation', exact: true }).click();
  await expect(page.getByText(/^Last updated/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('scheduled-app.png'), fullPage: true });
  await page.getByRole('button', { name: 'Pause automatic updates' }).click();
  await expect(page.getByText('Automatic updates are paused.', { exact: true })).toBeVisible();
});
