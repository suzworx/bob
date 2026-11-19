import { randomUUID } from 'node:crypto';
import { expect, ok, test } from './fixtures.ts';
import { isLive } from './stack.ts';
import { chooseAppMenuItem, clickAppAction, installAppClock, openAppMenu, returnToApp } from './pages/bob-app-actions.ts';
import { menuItem } from './components/menu.ts';
import type { APIRequestContext, Locator, Page, Route } from '@playwright/test';
import type { Installation, CampaignSummary, Draft, ConfigDetail } from '../src/features/bob-apps/marketing-api';

type Binding = { appBinding: { campaignId?: string | null } };
async function chooseNetwork(page: Page, network: 'Instagram' | 'LinkedIn', mobile: boolean): Promise<void> {
  if (mobile) {
    await page.getByRole('combobox', { name: 'Show posts for', exact: true }).click();
    await page.getByRole('option', { name: network, exact: true }).click();
    return;
  }
  await page.getByRole('group', { name: 'Show posts for' }).getByRole('button', { name: network, exact: true }).click();
}
/** Sends one message and returns the campaign target on the wire. */
async function send(page: Page, text: string, reply: string): Promise<string | null | undefined> {
  const replies = page.getByRole('article', { name: 'Message from assistant' });
  const before = await replies.count();
  const input = page.getByLabel('Message input');
  await input.click(); await input.fill(text);
  await expect(input).toHaveText(text);
  const sent = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const target = ((await sent).postDataJSON() as Binding).appBinding.campaignId;
  await expect(replies).toHaveCount(before + 1);
  await expect(replies.last()).toContainText(reply);
  return target;
}
/** Pause lives in the menu; a paused app offers Resume directly. */
async function pauseApp(page: Page): Promise<void> {
  await clickAppAction(page, 'Pause app');
  await expect(page.getByRole('button', { name: 'Resume app', exact: true })).toBeVisible();
}
async function resumeApp(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Resume app', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume app', exact: true })).toHaveCount(0);
}

test('explicit New campaign stays isolated through pause, resume and another tab selecting an old campaign', async ({ page, api, cleanup, tag }, testInfo) => {
  test.skip(isLive(), 'Scripted offered-tool proof runs locally without paid model calls.');
  await installAppClock(page);
  if (testInfo.project.name.startsWith('mobile')) await page.setViewportSize({ width: 375, height: 844 });
  await page.goto('/apps');
  await page.getByRole('button', { name: 'Install Marketing', exact: true }).click();
  await expect(page).toHaveURL(/\/apps\/[0-9a-f-]+$/);
  const appId = new URL(page.url()).pathname.split('/').pop();
  cleanup(async () => {
    const current = await api.get(`/api/bob-apps/${appId}`);
    if (current.status() === 404) return;
    const { app } = await current.json() as { app: { revision: number } };
    await ok('delete target test app', await api.delete(`/api/bob-apps/${appId}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } }));
  });
  const composer = page.getByLabel('Message input');
  await composer.fill(`e2e create a marketing campaign called ${tag}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Message from assistant' }).last()).toContainText('Stub: create_campaign finished.');
  const installations = await (await api.get('/api/bob-apps/marketing/installations')).json() as { installations: Installation[] };
  const installation = installations.installations.find((item) => item.appId === appId);
  if (!installation) throw new Error('Missing installation');
  const base = `/api/bob-apps/marketing/installations/${installation.id}`;
  const campaign = ((await (await api.get(`${base}/campaigns`)).json()) as { items: CampaignSummary[] }).items[0];
  const pointer = await (await api.get('/api/active')).json() as { active: { conversation_id: string | null } | null };
  const conversationId = pointer.active?.conversation_id;
  if (!campaign || !conversationId) throw new Error('Missing campaign or conversation');
  cleanup(async () => { await api.delete(`/api/conversations/${conversationId}`); });
  const selectionPosts: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/selection')) selectionPosts.push(request.url()); });
  await pauseApp(page);
  await page.getByRole('combobox', { name: 'Campaign', exact: true }).click();
  await page.getByRole('option', { name: 'New campaign', exact: true }).click();
  await expect.poll(() => selectionPosts.length).toBe(1);
  await resumeApp(page);
  for (const externalSelection of [false, true]) {
    if (externalSelection) {
      await page.getByRole('combobox', { name: 'Campaign', exact: true }).click();
      await page.getByRole('option', { name: 'New campaign', exact: true }).click();
      await ok('external tab select old campaign', await api.post(`${base}/conversations/${conversationId}/selection`, { data: { campaignId: campaign.id, mutationId: randomUUID() } }));
      const external = await returnToApp(page, `${base}/conversations/${conversationId}/selection`);
      expect(await external.json()).toMatchObject({ campaign: { id: campaign.id } });
      await expect(page.getByRole('combobox', { name: 'Campaign', exact: true })).toContainText('New campaign');
    }
    const replies = page.getByRole('article', { name: 'Message from assistant' });
    const previousReplies = await replies.count();
    await composer.fill(`e2e save an instagram draft called Do not write to the old campaign ${externalSelection}`);
    const sent = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    expect(((await sent).postDataJSON() as { appBinding: { campaignId?: string | null } }).appBinding.campaignId).toBeNull();
    await expect(replies).toHaveCount(previousReplies + 1);
    await expect(replies.last()).toContainText('Stub: save_draft finished.');
    expect(((await (await api.get(`${base}/drafts?campaignId=${campaign.id}`)).json()) as { items: Draft[] }).items).toHaveLength(0);
    expect((await (await api.get(`${base}/conversations/${conversationId}/selection`)).json() as { campaign: CampaignSummary | null }).campaign).toBeNull();
  }
  await page.screenshot({ path: testInfo.outputPath('marketing-explicit-new-target.png'), fullPage: true });
});

test('Marketing saves composer campaigns and distinct posts, reviews app changes and preserves work while paused', async ({ page, api, cleanup, tag }, testInfo) => {
  test.skip(isLive(), 'Scripted offered-tool proof runs locally without paid model calls.');
  test.setTimeout(120000);
  const mobile = testInfo.project.name.startsWith('mobile');
  if (mobile) await page.setViewportSize({ width: 375, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/apps');
  await page.getByRole('button', { name: 'Install Marketing', exact: true }).click();
  await expect(page).toHaveURL(/\/apps\/[0-9a-f-]+$/);
  const appId = new URL(page.url()).pathname.split('/').pop();
  cleanup(async () => {
    const current = await api.get(`/api/bob-apps/${appId}`);
    if (current.status() === 404) return;
    const { app } = await current.json() as { app: { revision: number } };
    await ok('delete Marketing test app', await api.delete(`/api/bob-apps/${appId}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } }));
  });
  await expect(page.getByRole('button', { name: 'More app actions', exact: true })).toBeVisible();
  const list = await (await api.get('/api/bob-apps/marketing/installations')).json() as { installations: Installation[] };
  const installation = list.installations.find((item) => item.appId === appId);
  if (!installation) throw new Error('Missing installed app');
  const base = `/api/bob-apps/marketing/installations/${installation.id}`;
  const instagramCopy = 'A little help. A little play. A brighter everyday with Bob. Join the early beta.';
  const linkedinCopy = 'Everyday ideas deserve a little room to grow. Bob brings a playful helper to tasks and notes. Join the early beta.';
  const editedCopy = 'One small idea. A little play. A brighter everyday with Bob. Join the early beta.';
  await send(page, `e2e create a marketing campaign called ${tag}`, 'Stub: create_campaign finished.');
  await expect.poll(async () => ((await (await api.get(`${base}/campaigns`)).json()) as { items: CampaignSummary[] }).items.length).toBe(1);
  const campaign = ((await (await api.get(`${base}/campaigns`)).json()) as { items: CampaignSummary[] }).items[0];
  if (!campaign) throw new Error('Missing saved campaign');
  const pointer = await (await api.get('/api/active')).json() as { active: { conversation_id: string | null } | null };
  if (!pointer.active?.conversation_id) throw new Error('Missing persisted conversation');
  const conversationId = pointer.active.conversation_id;
  cleanup(async () => { await api.delete(`/api/conversations/${conversationId}`); });
  await send(page, `e2e save an instagram draft called ${instagramCopy}`, 'Stub: save_draft finished.');
  await send(page, `e2e save a linkedin draft called ${linkedinCopy}`, 'Stub: save_draft finished.');
  await expect.poll(async () => ((await (await api.get(`${base}/drafts?campaignId=${campaign.id}`)).json()) as { items: Draft[] }).items.length).toBe(2);
  await chooseNetwork(page, 'LinkedIn', mobile);
  await expect(page.getByText(linkedinCopy, { exact: true })).toBeVisible();
  await expect(page.getByText(instagramCopy, { exact: true })).toHaveCount(0);
  await chooseNetwork(page, 'Instagram', mobile);
  await expect(page.getByText(instagramCopy, { exact: true })).toBeVisible();
  const composer = page.getByLabel('Message input');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
  await page.getByRole('textbox', { name: 'Caption', exact: true }).fill(editedCopy);
  await page.getByRole('textbox', { name: 'Image description', exact: true }).fill('Bob makes room for a little everyday play.');
  await page.getByRole('textbox', { name: 'Pillar', exact: true }).fill('Everyday play');
  await composer.fill('My unsent words');
  await chooseNetwork(page, 'LinkedIn', mobile);
  await clickAppAction(page, 'Improve this app');
  await page.getByRole('button', { name: 'Back to posts', exact: true }).click();
  await chooseNetwork(page, 'Instagram', mobile);
  await expect(page.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(editedCopy);
  await expect(page.getByRole('textbox', { name: 'Image description', exact: true })).toHaveValue('Bob makes room for a little everyday play.');
  await expect(page.getByRole('textbox', { name: 'Pillar', exact: true })).toHaveValue('Everyday play');
  await expect(composer).toHaveText('My unsent words');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit draft', exact: true })).toBeVisible();
  await expect(page.getByText(editedCopy, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(editedCopy, { exact: true })).toBeVisible();
  await clickAppAction(page, 'Improve this app');
  await send(page, 'e2e group marketing content by pillar', 'Stub: propose_marketing_config finished.');
  await expect(page.getByText('Content grouping: none → pillar', { exact: true })).toBeVisible();
  const before = await (await api.get(`${base}/config`)).json() as ConfigDetail;
  await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
  expect(((await (await api.get(`${base}/config`)).json()) as ConfigDetail).installation.configRevision).toBe(before.installation.configRevision);
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByText('Grouping: pillar', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Restore version 1', exact: true }).click();
  await expect(page.getByText('Grouping: none', { exact: true })).toBeVisible();
  expect(((await (await api.get(`${base}/drafts?campaignId=${campaign.id}`)).json()) as { items: Draft[] }).items).toHaveLength(2);
  await page.getByRole('button', { name: 'Back to posts', exact: true }).click();
  await page.getByRole('combobox', { name: 'Campaign', exact: true }).click();
  await page.getByRole('option', { name: 'New campaign', exact: true }).click();
  await expect.poll(async () => (await (await api.get(`${base}/conversations/${conversationId}/selection`)).json() as { campaign: CampaignSummary | null }).campaign).toBeNull();
  await pauseApp(page);
  const denied = await api.post(`${base}/campaigns`, { data: { name: 'Denied paused campaign', goal: 'curiosity', channels: ['instagram'], mutationId: randomUUID() } });
  expect(denied.status()).toBe(503);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('marketing-workspace.png'), fullPage: true });
  await clickAppAction(page, 'Archive app');
  await openAppMenu(page);
  await expect(menuItem(page, 'Restore app', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume app', exact: true })).toHaveCount(0);
  await chooseAppMenuItem(page, 'Restore app');
  await expect(page.getByRole('button', { name: 'Resume app', exact: true })).toBeVisible();
  await clickAppAction(page, 'Delete app');
  await expect(page.getByRole('alertdialog')).toContainText('saved campaigns, drafts and app history');
  await page.getByRole('button', { name: 'Delete app permanently', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Install Marketing', exact: true })).toBeVisible();
});

/** Installs and activates Marketing, creates one campaign in a real conversation, and registers the undo of all of it. */
async function campaignWorkspace(page: Page, api: APIRequestContext, cleanup: (step: () => Promise<void>) => void, tag: string) {
  await installAppClock(page);
  await page.goto('/apps');
  await page.getByRole('button', { name: 'Install Marketing', exact: true }).click();
  await expect(page).toHaveURL(/\/apps\/[0-9a-f-]+$/);
  const appId = new URL(page.url()).pathname.split('/').pop();
  cleanup(async () => {
    const current = await api.get(`/api/bob-apps/${appId}`);
    if (current.status() === 404) return;
    const { app } = await current.json() as { app: { revision: number } };
    await ok('delete Marketing test app', await api.delete(`/api/bob-apps/${appId}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } }));
  });
  await expect(page.getByRole('button', { name: 'More app actions', exact: true })).toBeVisible();
  await send(page, `e2e create a marketing campaign called ${tag}`, 'Stub: create_campaign finished.');
  const { installations } = await (await api.get('/api/bob-apps/marketing/installations')).json() as { installations: Installation[] };
  const installation = installations.find((item) => item.appId === appId);
  if (!installation) throw new Error('Missing installation');
  const base = `/api/bob-apps/marketing/installations/${installation.id}`;
  const campaign = ((await (await api.get(`${base}/campaigns`)).json()) as { items: CampaignSummary[] }).items[0];
  const pointer = await (await api.get('/api/active')).json() as { active: { conversation_id: string | null } | null };
  const conversationId = pointer.active?.conversation_id;
  if (!campaign || !conversationId) throw new Error('Missing campaign or conversation');
  cleanup(async () => { await api.delete(`/api/conversations/${conversationId}`); });
  const selection = async (): Promise<string | null> => ((await (await api.get(`${base}/conversations/${conversationId}/selection`)).json()) as { campaign: CampaignSummary | null }).campaign?.id ?? null;
  const draftCount = async (id: string): Promise<number> => ((await (await api.get(`${base}/drafts?campaignId=${id}`)).json()) as { items: Draft[] }).items.length;
  return { base, campaign, conversationId, selection, draftCount };
}
const picker = (page: Page): Locator => page.getByRole('combobox', { name: 'Campaign', exact: true });

test('Pausing and reloading keeps the stored campaign: Resume and send still target it', async ({ page, api, cleanup, tag }, testInfo) => {
  test.skip(isLive(), 'Scripted offered-tool proof runs locally without paid model calls.');
  const { campaign, selection, draftCount } = await campaignWorkspace(page, api, cleanup, tag);
  await expect(picker(page)).toContainText(tag);
  await pauseApp(page);
  await page.reload();
  await expect(picker(page)).toContainText(tag);
  expect(await selection()).toBe(campaign.id);
  await resumeApp(page);
  await expect(picker(page)).toContainText(tag);
  expect(await send(page, 'e2e save an instagram draft called Still the stored campaign', 'Stub: save_draft finished.')).toBe(campaign.id);
  expect(await selection()).toBe(campaign.id);
  await expect.poll(() => draftCount(campaign.id)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('marketing-a-resume-target.png'), fullPage: true });
});

test('A failed workspace read never claims New and never writes to a campaign the screen does not show', async ({ page, api, cleanup, tag }, testInfo) => {
  test.skip(isLive(), 'Scripted offered-tool proof runs locally without paid model calls.');
  const { base, campaign, draftCount } = await campaignWorkspace(page, api, cleanup, tag);
  const campaigns = /\/campaigns(\?.*)?$/;
  const fail = (route: Route): Promise<void> => route.request().method() === 'GET' ? route.fulfill({ status: 500, json: { error: { code: 'unavailable' } } }) : route.continue();
  await page.route(campaigns, fail);
  // Returning to this tab rereads the workspace without replacing the last known target or draft.
  expect((await returnToApp(page, `${base}/campaigns`)).status()).toBe(500);
  await expect(page.getByRole('button', { name: 'Retry workspace', exact: true })).toBeVisible();
  await expect(picker(page)).toContainText(tag);
  expect(await send(page, 'e2e save an instagram draft called Pinned to what I can see', 'Stub: save_draft finished.')).toBe(campaign.id);
  await expect.poll(() => draftCount(campaign.id)).toBe(1);
  // Page reload with nothing read yet: the target is unknown, so nothing says New and nothing can be sent.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry workspace', exact: true })).toBeVisible();
  await expect(picker(page)).not.toContainText('New campaign');
  await expect(picker(page)).toContainText('Campaign unavailable');
  await expect(page.getByLabel('Message input')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('marketing-b-unknown-target-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: testInfo.outputPath('marketing-b-unknown-target-dark.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.unroute(campaigns, fail);
  await page.getByRole('button', { name: 'Retry workspace', exact: true }).click();
  await expect(picker(page)).toContainText(tag);
  expect(await send(page, 'e2e save an instagram draft called After the retry', 'Stub: save_draft finished.')).toBe(campaign.id);
  await expect.poll(() => draftCount(campaign.id)).toBe(2);
});

test('A Refine Apply conflict stays on screen and the retry reuses its mutation id', async ({ page, api, cleanup, tag }, testInfo) => {
  test.skip(isLive(), 'Scripted offered-tool proof runs locally without paid model calls.');
  await campaignWorkspace(page, api, cleanup, tag);
  await clickAppAction(page, 'Improve this app');
  await send(page, 'e2e group marketing content by pillar', 'Stub: propose_marketing_config finished.');
  const applied: string[] = [];
  await page.route('**/config/apply', async (route) => {
    applied.push((route.request().postDataJSON() as { mutationId: string }).mutationId);
    if (applied.length === 1) await route.fulfill({ status: 409, json: { error: { code: 'revision_conflict' } } });
    else await route.continue();
  });
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/config') && response.ok());
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await refreshed;
  const message = page.getByText('The app changed. Your conversation is safe. Review the latest version before trying again.', { exact: true });
  await expect(message).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('marketing-c-conflict-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: testInfo.outputPath('marketing-c-conflict-dark.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByText('Grouping: pillar', { exact: true })).toBeVisible();
  expect(applied).toHaveLength(2);
  expect(applied[1]).toBe(applied[0]);
});

test('New is one target on screen and on the wire: reload, second tab, failed turn, then create moves it', async ({ page, api, cleanup, tag }, testInfo) => {
  test.skip(isLive(), 'Scripted offered-tool proof runs locally without paid model calls.');
  const { base, campaign, conversationId, selection, draftCount } = await campaignWorkspace(page, api, cleanup, tag);
  // New chosen while paused is stored: a page reload and a second tab both still say New.
  await pauseApp(page);
  await picker(page).click();
  await page.getByRole('option', { name: 'New campaign', exact: true }).click();
  await expect.poll(selection).toBeNull();
  await page.reload();
  await expect(picker(page)).toContainText('New campaign');
  await resumeApp(page);
  await expect(picker(page)).toContainText('New campaign');
  expect(await selection()).toBeNull();
  // Another tab selects the old campaign, then this tab's New turn fails before the server sees it: this tab still says New.
  await ok('another tab selects the old campaign', await api.post(`${base}/conversations/${conversationId}/selection`, { data: { campaignId: campaign.id, mutationId: randomUUID() } }));
  await picker(page).click();
  await page.getByRole('option', { name: tag, exact: true }).click();
  await picker(page).click();
  await page.getByRole('option', { name: 'New campaign', exact: true }).click();
  await expect.poll(selection).toBeNull();
  // This tab's last read must have seen no selection, or the other tab's write below would not be news to it.
  const settled = await returnToApp(page, `${base}/conversations/${conversationId}/selection`);
  expect(await settled.json()).toMatchObject({ campaign: null });
  await expect(page.getByRole('combobox', { name: 'Campaign', exact: true })).toBeEnabled();
  await ok('another tab selects the old campaign again', await api.post(`${base}/conversations/${conversationId}/selection`, { data: { campaignId: campaign.id, mutationId: randomUUID() } }));
  await page.route('**/api/chat', (route) => route.fulfill({ status: 500, json: { error: { code: 'unavailable' } } }));
  await page.getByLabel('Message input').fill('e2e save an instagram draft called Never reaches the server');
  const reread = page.waitForResponse(async (response) => response.url().endsWith('/selection') && response.request().method() === 'GET' && ((await response.json()) as { campaign: CampaignSummary | null }).campaign?.id === campaign.id);
  const failed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/chat');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await failed).status()).toBe(500);
  await reread;
  await expect(picker(page)).toContainText('New campaign');
  await page.unrouteAll();
  // The retry still carries New. A create_campaign turn under New legitimately moves the selection to the new campaign.
  const second = `${tag} two`;
  expect(await send(page, `e2e create a marketing campaign called ${second}`, 'Stub: create_campaign finished.')).toBeNull();
  await expect(picker(page)).toContainText(second);
  const created = await selection();
  expect(created).not.toBeNull();
  expect(created).not.toBe(campaign.id);
  expect(await send(page, 'e2e save an instagram draft called Goes to the new campaign', 'Stub: save_draft finished.')).toBe(created);
  await expect.poll(() => draftCount(created as string)).toBe(1);
  expect(await draftCount(campaign.id)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('marketing-new-target-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: testInfo.outputPath('marketing-new-target-dark.png'), fullPage: true });
});

test('A turn sent while paused says the app is paused, not gone', async ({ page, api, cleanup, tag }) => {
  test.skip(isLive(), 'Scripted offered-tool proof runs locally without paid model calls.');
  await campaignWorkspace(page, api, cleanup, tag);
  await pauseApp(page);
  await page.getByLabel('Message input').fill('e2e save an instagram draft called Sent while paused');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Marketing is paused. Resume it to keep going; your text is still here.', { exact: true })).toBeVisible();
  await expect(page.getByText('That app is no longer available.', { exact: false })).toHaveCount(0);
});

test('First run: a starter, a week of posts on the board, and Copy gives the exact post, with board and composer on screen together', async ({ page, context, api, cleanup, tag }, testInfo) => {
  test.skip(isLive(), 'Scripted offered-tool proof runs locally without paid model calls.');
  test.setTimeout(120000);
  const phone = testInfo.project.name.startsWith('mobile');
  await page.setViewportSize(phone ? { width: 375, height: 812 } : { width: 1280, height: 800 });
  const shots = process.env.MARKETING_SHOTS ?? testInfo.outputDir;
  const shoot = async (name: string): Promise<void> => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${shots}/${name}-${phone ? 375 : 1280}-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  };
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/apps');
  await page.getByRole('button', { name: 'Install Marketing', exact: true }).click();
  await expect(page).toHaveURL(/\/apps\/[0-9a-f-]+$/);
  const appId = new URL(page.url()).pathname.split('/').pop();
  cleanup(async () => {
    const current = await api.get(`/api/bob-apps/${appId}`);
    if (current.status() === 404) return;
    const { app } = await current.json() as { app: { revision: number } };
    await ok('delete first-run app', await api.delete(`/api/bob-apps/${appId}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } }));
  });
  await expect(page.getByRole('heading', { name: 'What should we post?', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this app', exact: true })).toHaveCount(0);
  for (const gone of ['Schedule', 'Results', 'Chat', 'Preview', 'Build with Bob', 'Refine app', 'Improve this app']) await expect(page.getByRole('button', { name: gone, exact: true })).toHaveCount(0);
  const composer = page.getByLabel('Message input');
  const checkPhoneRegions = async (heading: string): Promise<void> => {
    if (!phone) return;
    for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 667 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(viewport);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeInViewport({ ratio: 1 });
      await expect(composer).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  };
  await expect(composer).toBeInViewport();
  await checkPhoneRegions('What should we post?');
  await shoot('marketing-first-run');
  await page.getByRole('button', { name: 'A week of posts', exact: true }).click();
  await expect(composer).toContainText('Write a week of posts about');
  await composer.fill(`e2e plan a week called ${tag}`);
  const sent = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const binding = ((await sent).postDataJSON() as { appBinding: Record<string, unknown> }).appBinding;
  expect(binding).toMatchObject({ mode: 'run', campaignId: null });
  expect(binding).not.toHaveProperty('intent');
  await expect(page.getByRole('article', { name: 'Message from assistant' }).last()).toContainText('Stub: save_week_plan finished.');
  const conversation = await (await api.get('/api/active')).json() as { active: { conversation_id: string | null } | null };
  cleanup(async () => { if (conversation.active?.conversation_id) await api.delete(`/api/conversations/${conversation.active.conversation_id}`); });
  await expect(page.getByRole('heading', { name: 'This week', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Campaign', exact: true })).toContainText(tag);
  await expect(page.getByRole('heading', { name: 'Day 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy post', exact: true })).toHaveCount(7);
  await expect(page.getByRole('heading', { name: 'This week', exact: true })).toBeInViewport();
  await expect(composer).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByText(/^Day \d+ · /).locator('visible=true')).toHaveCount(0);
  expect((await page.getByRole('heading', { name: 'This week', exact: true }).boundingBox())?.x).toBeGreaterThanOrEqual(16);
  await checkPhoneRegions('This week');
  await shoot('marketing-week-board');
  const firstImage = page.getByRole('img', { name: /^Image of Bob for this post/ }).first();
  await firstImage.scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: /^(Share|Download) image$/ }).first()).toBeEnabled();
  await page.getByRole('button', { name: /^Open Preview image/ }).first().click();
  const fullImage = page.getByRole('dialog').getByRole('img');
  await expect(fullImage).toBeInViewport({ ratio: 1 });
  await shoot('marketing-post-image');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const copy = page.getByRole('button', { name: 'Copy post', exact: true }).first();
  await copy.scrollIntoViewIfNeeded();
  await copy.click();
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  const { installations } = await (await api.get('/api/bob-apps/marketing/installations')).json() as { installations: Installation[] };
  const installation = installations.find((item) => item.appId === appId);
  const base = `/api/bob-apps/marketing/installations/${installation?.id}`;
  const campaign = ((await (await api.get(`${base}/campaigns`)).json()) as { items: CampaignSummary[] }).items[0];
  const drafts = ((await (await api.get(`${base}/drafts?campaignId=${campaign?.id}&projection=content`)).json()) as { items: Draft[] }).items;
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(drafts.map((draft) => draft.body)).toContain(copied);
  await shoot('marketing-copied');
  await clickAppAction(page, 'Improve this app');
  await expect(page.getByRole('heading', { name: 'App history', exact: true })).toBeVisible();
  await expect(composer).toBeInViewport();
  await shoot('marketing-improve');
});
