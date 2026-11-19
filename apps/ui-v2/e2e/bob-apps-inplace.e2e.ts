import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, BrowserContext, Page, TestInfo } from '@playwright/test';
import { expect, ok, test } from './fixtures.ts';
import { BASE_URL, E2E_DATA, mintSignInCode, newRunEmail, runLocalSql, sqlText } from './stack.ts';
import { SignInPage } from './pages/sign-in-page.ts';
import { clickAppAction, installAppClock, pollOpenApp } from './pages/bob-app-actions.ts';
import { starterApp } from '../src/features/bob-apps/app-starters';
import type { BobApp } from '../src/features/bob-apps/bob-apps-api';

const composer = (page: Page) => page.getByRole('combobox', { name: /^Message(?: input)?$/ });
async function readApp(api: APIRequestContext, id: string): Promise<BobApp> {
  const response = await api.get(`/api/bob-apps/${id}`); await ok('read app', response);
  return (await response.json() as { app: BobApp }).app;
}
async function send(page: Page, text: string, reply: string): Promise<void> {
  const replies = page.getByText(reply, { exact: true }); const before = await replies.count();
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(replies).toHaveCount(before + 1);
}
async function reloadApp(page: Page, shared: boolean): Promise<void> {
  const url = new URL(page.url()); const id = shared ? url.searchParams.get('app') : url.pathname.split('/').at(-1);
  if (!id) throw new Error('The open app has no identity');
  const response = await pollOpenApp(page, id);
  await ok('refresh open app without losing its draft', response);
}
async function seed(api: APIRequestContext, title: string, record: string, spaceId?: string): Promise<BobApp> {
  const made = await api.post('/api/bob-apps', { data: { definition: { ...starterApp('checklist'), title }, mutationId: randomUUID(), ...(spaceId ? { spaceId } : {}) } }); await ok('create app', made);
  let { app } = await made.json() as { app: BobApp };
  const active = await api.patch(`/api/bob-apps/${app.id}`, { data: { operation: 'activate', expectedRevision: app.revision, mutationId: randomUUID() } }); await ok('activate app', active);
  app = (await active.json() as { app: BobApp }).app;
  await ok('retain record', await api.post(`/api/bob-apps/${app.id}/actions`, { data: { expectedRevision: app.revision, mutationId: randomUUID(), command: { operation: 'write', action: 'create', id: 'r_retained', values: { title: record, completed: false } } } }));
  return readApp(api, app.id);
}
function identity(state: Awaited<ReturnType<BrowserContext['storageState']>>): { token: string; id: string } {
  const item = state.origins.flatMap((origin) => origin.localStorage).find((item) => /^sb-.+-auth-token$/.test(item.name));
  const token = (JSON.parse(item?.value ?? '{}') as { access_token: string }).access_token;
  return { token, id: (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub: string }).sub };
}
async function focusWithoutReplacing(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Change with Bob', exact: true }).click();
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveText(text);
}
async function captureEntry(page: Page, url: string, record: string, info: TestInfo): Promise<void> {
  const fresh = await page.context().newPage();
  const directory = join(E2E_DATA, 'screenshots', 'apps-inplace'); mkdirSync(directory, { recursive: true });
  const mobile = info.project.name.startsWith('mobile');
  try {
    const target = new URL(url); target.searchParams.set('brand', 'bob');
    await fresh.goto(target.toString());
    await expect(fresh.getByText(record, { exact: true }).first()).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await fresh.emulateMedia({ colorScheme: scheme });
      for (const width of mobile ? [375, 390] : [1280]) for (const height of mobile ? [667, 844] : [800]) {
        await fresh.setViewportSize({ width, height });
        await expect(fresh.getByText(record, { exact: true }).first()).toBeInViewport({ ratio: 1 });
        await expect(composer(fresh)).toBeInViewport({ ratio: 1 });
        await expect(composer(fresh)).toHaveCount(1);
        expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await fresh.screenshot({ path: join(directory, `${record}-${scheme}-${width}x${height}-${info.project.name}.png`) });
      }
    }
  } finally { await fresh.close(); }
}

test('a personal app proposes, previews, applies and undoes in place while preserving records and unsent words', async ({ page, api, cleanup, tag }, info) => {
  test.setTimeout(180000);
  const record = `Personal-${tag}`; const app = await seed(api, `Private ${tag}`, record);
  cleanup(async () => { const latest = await readApp(api, app.id); await ok('delete private app', await api.delete(`/api/bob-apps/${app.id}`, { data: { expectedRevision: latest.revision, mutationId: randomUUID() } })); });
  const url = `${BASE_URL}/apps/${app.id}`;
  await installAppClock(page);
  await page.goto(url); await expect(page.getByText(record, { exact: true }).first()).toBeVisible();
  await focusWithoutReplacing(page, 'Keep my private correction'); await expect(page).toHaveURL(url);
  const renamed = `Warmer ${tag}`;
  await send(page, `e2e rename this app to ${renamed}`, 'Stub: revise_bob_app finished.');
  await expect(page.getByRole('heading', { name: 'Review proposed changes', exact: true })).toBeVisible();
  expect((await readApp(api, app.id)).pendingDefinition?.title).toBe(renamed);
  await expect(page).toHaveURL(url);
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible();
  expect((await readApp(api, app.id)).definition.title).toBe(renamed);
  await clickAppAction(page, 'Undo last change');
  await expect(page.getByRole('heading', { name: app.definition.title, exact: true })).toBeVisible();
  const restored = await readApp(api, app.id);
  expect(restored.definition).toEqual(app.definition); expect(restored.state).toEqual(app.state);
  await composer(page).click();
  await composer(page).fill('Keep these working words');
  await expect(composer(page)).toHaveText('Keep these working words');
  await reloadApp(page, false); await expect(composer(page)).toHaveText('Keep these working words');
  await captureEntry(page, url, record, info);
  await expect(composer(page)).toHaveText('Keep these working words'); await expect(page).toHaveURL(url);
});

test('a member proposes in the shared app, an admin applies and undoes, and unsupported ideas stay in that space Notes', async ({ page, browser, playwright, api, cleanup, tag }, info) => {
  test.setTimeout(180000);
  const created = await api.post('/api/spaces', { data: { name: `App team ${tag}` } }); await ok('create app team', created);
  const { id: spaceId } = await created.json() as { id: string }; cleanup(async () => api.delete(`/api/spaces/${spaceId}`));
  const record = `Shared-${tag}`; const app = await seed(api, `Shared ${tag}`, record, spaceId);
  cleanup(async () => { const latest = await readApp(api, app.id); await ok('delete shared app', await api.delete(`/api/bob-apps/${app.id}`, { data: { expectedRevision: latest.revision, mutationId: randomUUID() } })); });
  const context = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] }, viewport: page.viewportSize() ?? undefined, hasTouch: info.project.name.startsWith('mobile') });
  try {
    const member = await context.newPage(); await member.goto('/');
    await new SignInPage(member).signIn(mintSignInCode(newRunEmail()));
    await expect(member.getByRole('combobox', { name: 'Message input', exact: true })).toBeVisible();
    const self = identity(await context.storageState());
    runLocalSql(`insert into bob.space_memberships(space_id,user_id,role) values (${sqlText(spaceId)},${sqlText(self.id)},'member');`);
    runLocalSql(`update bob.spaces set membership_revision = membership_revision + 1 where id = ${sqlText(spaceId)};`);
    const url = `${BASE_URL}/spaces/${spaceId}/apps?app=${app.id}`;
    await installAppClock(page); await installAppClock(member);
    await page.goto(url); await member.goto(url);
    await expect(member.getByText(record, { exact: true }).first()).toBeVisible();
    const entryUrl = member.url();
    let privateTurns = 0; member.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat') privateTurns += 1; });
    await focusWithoutReplacing(member, 'Keep my team correction'); await expect(member).toHaveURL(entryUrl);
    const renamed = `Friendlier ${tag}`;
    await send(member, `e2e rename this app to ${renamed}`, 'Stub: revise_bob_app finished.');
    await expect(member.getByRole('heading', { name: 'Review proposed changes', exact: true })).toBeVisible();
    await expect(member.getByRole('button', { name: 'Apply changes', exact: true })).toHaveCount(0);
    await reloadApp(page, true); await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
    await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible();
    expect((await readApp(api, app.id)).definition.title).toBe(renamed);
    await clickAppAction(page, 'Undo last change');
    await expect(page.getByRole('heading', { name: app.definition.title, exact: true })).toBeVisible();
    const restored = await readApp(api, app.id); expect(restored.definition).toEqual(app.definition); expect(restored.state).toEqual(app.state);
    const idea = `Automatically fetch unsupported email ${tag}`;
    await send(member, `e2e save an app idea called ${idea}`, 'Stub: save_app_idea finished.');
    const notes = await api.get(`/api/spaces/${spaceId}/notes`); await ok('read scoped Notes', notes);
    const { notes: rows } = await notes.json() as { notes: Array<{ body: string; created_by: string; space_id: string }> };
    expect(rows.some((note) => note.body === `App: ${app.id}\n\n${idea}` && note.created_by === self.id && note.space_id === spaceId)).toBe(true);
    expect((await readApp(api, app.id)).definition).toEqual(app.definition);
    await composer(member).click();
    await composer(member).fill('Keep my unsent shared idea');
    await expect(composer(member)).toHaveText('Keep my unsent shared idea');
    await reloadApp(member, true);
    await expect(composer(member)).toHaveText('Keep my unsent shared idea');
    await captureEntry(member, entryUrl, record, info);
    await expect(composer(member)).toHaveText('Keep my unsent shared idea'); expect(privateTurns).toBe(0);
    await ok('revoke shared app member', await api.delete(`/api/spaces/${spaceId}/members/${self.id}`));
    await expect(composer(member)).toHaveCount(0);
    expect((await readApp(api, app.id)).state).toEqual(app.state);
    const memberApi = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${self.token}` } });
    try { expect((await memberApi.get(`/api/bob-apps/${app.id}`)).status()).toBe(404); } finally { await memberApi.dispose(); }
  } finally { await context.close(); }
});
