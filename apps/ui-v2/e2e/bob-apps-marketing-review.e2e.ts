import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, ok, test } from './fixtures.ts';
import { BASE_URL, E2E_DATA, mintSignInCode, newRunEmail, runLocalSql, sqlText } from './stack.ts';
import { SignInPage } from './pages/sign-in-page.ts';
import type { MarketingReview } from '../src/features/bob-apps/marketing-review-schemas';

function guestIdentity(state: Awaited<ReturnType<BrowserContext['storageState']>>): { token: string; id: string } {
  const item = state.origins.flatMap((origin) => origin.localStorage).find((item) => /^sb-.+-auth-token$/.test(item.name));
  const token = (JSON.parse(item?.value ?? '{}') as { access_token: string }).access_token;
  return { token, id: (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub: string }).sub };
}
async function send(page: Page, text: string, reply: string): Promise<void> {
  const replies = page.getByRole('log').getByText(reply, { exact: true });
  const count = await replies.count();
  await page.getByRole('combobox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(replies).toHaveCount(count + 1);
}
async function editFirstPost(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Edit draft', exact: true }).first().click();
  await page.getByRole('textbox', { name: 'Caption', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}
async function captureBoard(page: Page, caption: string, mobile: boolean, shoot: (page: Page, name: string) => Promise<void>): Promise<void> {
  const composer = page.getByRole('combobox', { name: 'Message', exact: true });
  const preview = page.getByRole('img', { name: `Image of Bob for this post: ${caption}`, exact: true }).first();
  await expect.poll(() => preview.evaluate((node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of mobile ? [375, 390] : [1280]) for (const height of mobile ? [667, 844] : [800]) {
      await page.setViewportSize({ width, height });
      await expect(page.getByText(caption, { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(composer).toBeInViewport({ ratio: 1 });
      await expect(composer).toHaveCount(1);
      await shoot(page, `board-${scheme}-${width}x${height}`);
    }
  }
}

test('a team records sender-attributed notes and approves the complete plan, with explicit conflict recovery and immediate revocation', async ({ page, browser, playwright, api, cleanup, tag }, info) => {
  test.setTimeout(180000);
  const mobile = info.project.name.startsWith('mobile');
  const shots = join(E2E_DATA, 'screenshots', 'marketing-review'); mkdirSync(shots, { recursive: true });
  const shoot = async (target: Page, name: string): Promise<void> => target.screenshot({ path: join(shots, `${name}-${info.project.name}.png`) }).then(() => undefined);
  const created = await api.post('/api/spaces', { data: { name: `Review team ${tag}` } }); await ok('create review team', created);
  const { id: spaceId } = await created.json() as { id: string };
  cleanup(async () => api.delete(`/api/spaces/${spaceId}`));
  const guestContext = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] }, viewport: page.viewportSize() ?? undefined, hasTouch: mobile });
  try {
    const member = await guestContext.newPage(); await member.goto('/');
    await new SignInPage(member).signIn(mintSignInCode(newRunEmail()));
    await expect(member.getByRole('combobox', { name: 'Message input', exact: true })).toBeVisible();
    await member.goto('/');
    const identity = guestIdentity(await guestContext.storageState());
    const memberApi = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${identity.token}` } });
    try {
      // Canonical local fixture admission; content, notes, approval and revocation use real APIs.
      runLocalSql(`insert into bob.space_memberships(space_id,user_id,role) values (${sqlText(spaceId)},${sqlText(identity.id)},'member');`);
      runLocalSql(`update bob.spaces set membership_revision = membership_revision + 1 where id = ${sqlText(spaceId)};`);
      await page.goto(`/spaces/${spaceId}/apps`);
      await page.getByRole('button', { name: 'Install Marketing', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'What should we post?', exact: true })).toBeVisible();
      const appUrl = page.url(); const appId = new URL(appUrl).searchParams.get('app');
      cleanup(async () => {
        const response = await api.get(`/api/bob-apps/${appId}`); if (response.status() === 404) return;
        const { app } = await response.json() as { app: { revision: number } };
        await ok('delete review app', await api.delete(`/api/bob-apps/${appId}`, { data: { expectedRevision: app.revision, mutationId: randomUUID() } }));
      });
      let privateTurns = 0;
      for (const target of [page, member]) target.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat') privateTurns += 1; });
      await send(page, `e2e plan a week called Review ${tag}`, 'Stub: save_week_plan finished.');
      const opened = await api.post(`/api/bob-apps/${appId}/conversation`); await ok('open review thread', opened);
      const { conversationId } = await opened.json() as { conversationId: string };
      const { installations } = await (await api.get(`/api/bob-apps/marketing/installations?spaceId=${spaceId}`)).json() as { installations: Array<{ id: string }> };
      const base = `/api/bob-apps/marketing/installations/${installations[0]?.id}`;
      const { campaign } = await (await api.get(`${base}/conversations/${conversationId}/selection`)).json() as { campaign: { id: string } };
      const reviewPath = `${base}/campaigns/${campaign.id}/review`;
      await ok('member selects shared plan', await memberApi.post(`${base}/conversations/${conversationId}/selection`, { data: { campaignId: campaign.id, mutationId: randomUUID() } }));
      await member.goto(appUrl);
      await member.getByRole('button', { name: 'See the full plan', exact: true }).click();
      await expect(member.getByRole('button', { name: 'Add a review note', exact: true })).toBeVisible();
      await expect(member.getByRole('button', { name: 'Approve this plan', exact: true })).toHaveCount(0);
      await member.getByRole('button', { name: 'Add a review note', exact: true }).click();
      await expect(member.getByRole('combobox', { name: 'Message', exact: true })).toHaveText(/review note/i);
      const note = `Make Monday warmer ${tag}`;
      await send(member, `e2e add a marketing review note called ${note}`, 'Stub: add_marketing_review_note finished.');
      await expect.poll(async () => ((await (await api.get(reviewPath)).json()) as { review: MarketingReview }).review.notes.some((item) => item.text === note && item.author?.id === identity.id)).toBe(true);
      await member.getByRole('button', { name: 'Refresh plan review', exact: true }).click();
      await expect(member.getByText(note, { exact: true })).toBeVisible();
      await shoot(member, 'member-note');
      await member.getByRole('button', { name: 'See the full plan', exact: true }).click();

      await page.getByRole('button', { name: 'Edit draft', exact: true }).first().click();
      await page.getByRole('textbox', { name: 'Caption', exact: true }).fill(`Unsent caption ${tag}`);
      const composer = page.getByRole('combobox', { name: 'Message', exact: true });
      await composer.fill(`Unsent team message ${tag}`);
      await page.getByRole('button', { name: 'See the full plan', exact: true }).click();
      await expect(page.getByText(note, { exact: true })).toBeVisible();
      await expect(page.getByText('7 posts · 4 Instagram · 3 LinkedIn. Approval covers every saved post, across all channels.', { exact: true })).toBeVisible();
      let approvals = 0; page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/review/approve')) approvals += 1; });
      await page.getByRole('button', { name: 'Approve this plan', exact: true }).click();
      await expect(page.getByText('Plan approved. Publishing is not connected.', { exact: true })).toBeVisible();
      let persisted = ((await (await api.get(reviewPath)).json()) as { review: MarketingReview }).review;
      expect(persisted.state).toBe('approved'); expect(persisted.snapshot.drafts).toHaveLength(7);
      expect(persisted.snapshot.drafts.every((draft) => draft.state === 'needs_check')).toBe(true);

      const firstEdit = `Member saved caption ${tag}`; await editFirstPost(member, firstEdit);
      persisted = ((await (await api.get(reviewPath)).json()) as { review: MarketingReview }).review;
      expect(persisted.state).toBe('needs_review');
      await page.getByRole('button', { name: 'Refresh plan review', exact: true }).click();
      await expect(page.getByText(firstEdit, { exact: true })).toBeVisible();
      const lastEdit = `Conflict saved caption ${tag}`; await editFirstPost(member, lastEdit);
      await page.getByRole('button', { name: 'Approve this plan', exact: true }).click();
      await expect(page.getByText('This plan changed. Review the latest version, then approve it again.', { exact: true })).toBeVisible();
      await expect(composer).toHaveText(`Unsent team message ${tag}`);
      await expect(page.getByText(firstEdit, { exact: true })).toBeVisible();
      await expect(page.getByText(lastEdit, { exact: true })).toHaveCount(0);
      await shoot(page, 'conflict-preserved');
      await page.getByRole('button', { name: 'Refresh plan review', exact: true }).click();
      await expect(page.getByText(lastEdit, { exact: true })).toBeVisible(); expect(approvals).toBe(2);
      await page.getByRole('button', { name: 'Approve this plan', exact: true }).click();
      await expect(page.getByText('Plan approved. Publishing is not connected.', { exact: true })).toBeVisible(); expect(approvals).toBe(3);
      await shoot(page, 'admin-approved');
      await page.getByRole('button', { name: 'See the full plan', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(`Unsent caption ${tag}`);
      await expect(composer).toHaveText(`Unsent team message ${tag}`);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Discard edits', exact: true }).click();
      await expect(page.getByText(lastEdit, { exact: true })).toBeVisible();
      await expect(composer).toHaveText(`Unsent team message ${tag}`);
      const fresh = await page.context().newPage();
      try {
        const freshUrl = new URL(appUrl); freshUrl.searchParams.set('brand', 'bob');
        await fresh.goto(freshUrl.toString());
        await expect(fresh.getByText(lastEdit, { exact: true })).toBeVisible();
        await expect(fresh.getByRole('textbox', { name: 'Caption', exact: true })).toHaveCount(0);
        await captureBoard(fresh, lastEdit, mobile, shoot);
      } finally { await fresh.close(); }
      await expect(composer).toHaveText(`Unsent team message ${tag}`);
      expect(privateTurns).toBe(0);
      await ok('revoke review member', await api.delete(`/api/spaces/${spaceId}/members/${identity.id}`));
      await expect(member.getByRole('combobox', { name: 'Message', exact: true })).toHaveCount(0);
      await expect(member.getByRole('button', { name: 'Add a review note', exact: true })).toHaveCount(0);
      await shoot(member, 'revoked');
      expect((await memberApi.get(reviewPath)).status()).toBe(404);
      persisted = ((await (await api.get(reviewPath)).json()) as { review: MarketingReview }).review;
      expect(persisted.notes.some((item) => item.text === note)).toBe(true);
      expect(persisted.snapshot.drafts.some((item) => item.body === lastEdit)).toBe(true);
    } finally { await memberApi.dispose(); }
  } finally { await guestContext.close(); }
});
