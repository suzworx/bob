import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, ok, test } from './fixtures.ts';
import { BASE_URL, E2E_DATA, mintSignInCode, newRunEmail, runLocalSql, sqlText } from './stack.ts';
import { SignInPage } from './pages/sign-in-page.ts';
import { starterApp } from '../src/features/bob-apps/app-starters.ts';
import { menuItem } from './components/menu.ts';
import { chooseAppMenuItem, openAppMenu } from './pages/bob-app-actions.ts';

function guestIdentity(state: Awaited<ReturnType<BrowserContext['storageState']>>): { token: string; id: string } {
  const item = state.origins.flatMap((origin) => origin.localStorage).find((item) => /^sb-.+-auth-token$/.test(item.name));
  const token = (JSON.parse(item?.value ?? '{}') as { access_token: string }).access_token;
  const id = (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub: string }).sub;
  return { token, id };
}
async function send(page: Page, text: string, reply: string): Promise<void> {
  const replies = page.getByRole('log').getByText(reply, { exact: true });
  const before = await replies.count();
  const input = page.getByRole('combobox', { name: 'Message', exact: true });
  await input.click(); await input.fill(text);
  await expect(input).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(replies).toHaveCount(before + 1);
}

test('a group owns generic and Marketing apps: member edits and proposes, admin applies, leaving clears access and keeps authored work', async ({ page, browser, playwright, api, cleanup, tag }, info) => {
  test.setTimeout(180000);
  const shots = join(E2E_DATA, 'screenshots', 'space-apps'); mkdirSync(shots, { recursive: true });
  const shot = async (target: Page, name: string): Promise<void> => target.screenshot({ path: join(shots, `${name}-${info.project.name}.png`) }).then(() => undefined);
  const made = await api.post('/api/spaces', { data: { name: `Team ${tag}` } }); await ok('create group', made);
  const { id: spaceId } = await made.json() as { id: string };
  cleanup(async () => api.delete(`/api/spaces/${spaceId}`));
  const privateAppResponse = await api.post('/api/bob-apps', { data: { definition: { ...starterApp('checklist'), title: `Personal ${tag}` }, mutationId: randomUUID() } });
  await ok('create personal control', privateAppResponse);
  const { app: privateApp } = await privateAppResponse.json() as { app: { id: string; revision: number } };
  cleanup(async () => api.delete(`/api/bob-apps/${privateApp.id}`, { data: { expectedRevision: privateApp.revision, mutationId: randomUUID() } }));
  const guestContext = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] }, viewport: page.viewportSize() ?? undefined, hasTouch: info.project.name.startsWith('mobile') });
  try {
    const guest = await guestContext.newPage(); await guest.goto('/');
    await new SignInPage(guest).signIn(mintSignInCode(newRunEmail()));
    await expect(guest.getByRole('combobox', { name: 'Message input', exact: true })).toBeVisible();
    const identity = guestIdentity(await guestContext.storageState());
    const memberApi = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${identity.token}` } });
    try {
      // Local fixture admission only; all app operations and revocation below use the real APIs.
      runLocalSql(`insert into bob.space_memberships(space_id,user_id,role) values (${sqlText(spaceId)},${sqlText(identity.id)},'member');`);
      runLocalSql(`update bob.spaces set membership_revision = membership_revision + 1 where id = ${sqlText(spaceId)};`);
      const index = `/spaces/${spaceId}/apps`;
      await page.goto(index);
      await expect(page.getByRole('button', { name: /^Checklist starter/ })).toBeVisible();
      await expect(page.getByText(`Personal ${tag}`, { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: /^Checklist starter/ }).click();
      await page.getByRole('button', { name: 'Use this app', exact: true }).click();
      const genericUrl = page.url(); const genericId = new URL(genericUrl).searchParams.get('app');
      cleanup(async () => { const { app } = await (await api.get(`/api/bob-apps/${genericId}`)).json() as { app: { revision: number } }; await ok('delete shared generic', await api.delete(`/api/bob-apps/${genericId}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } })); });
      await guest.goto(genericUrl);
      await expect(guest.getByRole('button', { name: 'Change with Bob' })).toBeVisible();
      await expect(guest.getByRole('button', { name: 'Delete app' })).toHaveCount(0);
      await openAppMenu(guest);
      for (const name of ['Delete app', 'Pause app', 'Undo last change']) await expect(menuItem(guest, name, { exact: true })).toHaveCount(0);
      await guest.keyboard.press('Escape');
      await guest.getByRole('button', { name: 'Add to Checklist', exact: true }).click();
      const form = guest.getByRole('dialog', { name: 'Add to Checklist', exact: true });
      await form.getByRole('textbox', { name: 'Title', exact: true }).fill(`Shared work ${tag}`);
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(guest.getByText(`Shared work ${tag}`, { exact: true })).toBeVisible();
      await shot(guest, 'member-generic');
      await guest.goto(index);
      await guest.getByRole('button', { name: /^Budget starter/ }).click();
      await expect(guest).toHaveURL(/\?app=[0-9a-f-]+$/);
      const memberDraftId = new URL(guest.url()).searchParams.get('app');
      await expect(guest.getByRole('button', { name: 'Use this app', exact: true })).toHaveCount(0);
      expect(((await (await memberApi.get(`/api/bob-apps/${memberDraftId}`)).json()) as { app: { lifecycle: string } }).app.lifecycle).toBe('draft');
      cleanup(async () => { const { app } = await (await api.get(`/api/bob-apps/${memberDraftId}`)).json() as { app: { revision: number } }; await ok('delete member draft', await api.delete(`/api/bob-apps/${memberDraftId}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } })); });
      await page.goto(index); await page.getByRole('button', { name: 'Install Marketing', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'What should we post?', exact: true })).toBeVisible();
      const marketingUrl = page.url(); const marketingId = new URL(marketingUrl).searchParams.get('app');
      cleanup(async () => { const response = await api.get(`/api/bob-apps/${marketingId}`); if (response.status() === 404) return; const { app } = await response.json() as { app: { revision: number } }; await ok('delete shared Marketing', await api.delete(`/api/bob-apps/${marketingId}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } })); });
      let privateTurns = 0; page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat') privateTurns += 1; });
      await send(page, `e2e plan a week called Owner ${tag}`, 'Stub: save_week_plan finished.');
      await expect(page.getByRole('heading', { name: 'This week', exact: true })).toBeInViewport({ ratio: 1 });
      const common = await api.post(`/api/bob-apps/${marketingId}/conversation`); await ok('open stable conversation', common);
      const { conversationId } = await common.json() as { conversationId: string };
      const { installations } = await (await api.get(`/api/bob-apps/marketing/installations?spaceId=${spaceId}`)).json() as { installations: Array<{ id: string }> };
      const base = `/api/bob-apps/marketing/installations/${installations[0]?.id}`;
      const ownerChoice = await (await api.get(`${base}/conversations/${conversationId}/selection`)).json();
      await guest.goto(marketingUrl);
      await expect(guest.getByRole('heading', { name: 'What should we post?', exact: true })).toBeVisible();
      await send(guest, `e2e plan a week called Member ${tag}`, 'Stub: save_week_plan finished.');
      expect(await (await api.get(`${base}/conversations/${conversationId}/selection`)).json()).toEqual(ownerChoice);
      await expect(guest.getByRole('button', { name: 'Edit draft', exact: true })).toHaveCount(7);
      const memberChoice = await (await memberApi.get(`${base}/conversations/${conversationId}/selection`)).json() as { campaign: { id: string } };
      await guest.getByRole('button', { name: 'Edit draft', exact: true }).first().click();
      await guest.getByRole('textbox', { name: 'Caption', exact: true }).fill(`Team caption ${tag}`);
      await guest.getByRole('button', { name: 'Save draft', exact: true }).click();
      await expect(guest.getByText(`Team caption ${tag}`, { exact: true })).toBeVisible();
      await guest.getByRole('button', { name: 'More app actions', exact: true }).click();
      await expect(menuItem(guest, 'Pause app', { exact: true })).toHaveCount(0); await shot(guest, 'member-menu');
      await chooseAppMenuItem(guest, 'Improve this app');
      await send(guest, 'e2e group marketing content by pillar', 'Stub: propose_marketing_config finished.');
      await expect(guest.getByRole('button', { name: 'Apply changes', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'More app actions', exact: true }).click(); await shot(page, 'admin-menu');
      await chooseAppMenuItem(page, 'Improve this app');
      await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
      await expect(page.getByText('Grouping: pillar', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Back to posts', exact: true }).click();
      for (const height of info.project.name.startsWith('mobile') ? [844, 667] : [800]) {
        await page.setViewportSize({ width: info.project.name.startsWith('mobile') ? 390 : 1280, height });
        await expect(page.getByRole('heading', { name: 'This week', exact: true })).toBeInViewport({ ratio: 1 });
        await expect(page.getByText('Day 1: Hello.', { exact: true }).first()).toBeInViewport({ ratio: 1 });
        await expect(page.getByRole('combobox', { name: 'Message', exact: true })).toBeInViewport({ ratio: 1 });
        const preview = page.getByRole('img', { name: 'Image of Bob for this post: Day 1: Hello.', exact: true }).first();
        await expect.poll(() => preview.evaluate((node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true);
        await shot(page, `board-${height}`);
      }
      expect(privateTurns).toBe(0);
      await ok('revoke member', await api.delete(`/api/spaces/${spaceId}/members/${identity.id}`));
      await expect(guest.getByRole('combobox', { name: 'Message', exact: true })).toHaveCount(0);
      await expect(guest.getByRole('button', { name: 'Apply changes', exact: true })).toHaveCount(0); await shot(guest, 'revoked');
      expect((await memberApi.get(`/api/bob-apps/${marketingId}`)).status()).toBe(404);
      const retained = await (await api.get(`/api/bob-apps/${genericId}`)).json();
      expect(JSON.stringify(retained)).toContain(`Shared work ${tag}`);
      const retainedPosts = await (await api.get(`${base}/drafts?campaignId=${memberChoice.campaign.id}&projection=content`)).json();
      expect(JSON.stringify(retainedPosts)).toContain(`Team caption ${tag}`);
    } finally { await memberApi.dispose(); }
  } finally { await guestContext.close(); }
});
