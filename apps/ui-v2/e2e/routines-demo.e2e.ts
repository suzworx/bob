import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';

// Dedicated synthetic server only. This file does not intercept browser API
// results and is skipped by the general app suite.
test.skip(process.env.BOB_ROUTINES_DEMO !== '1', 'Run with playwright.routines-demo.config.ts');
type Routine = { id: string; localTime: string; revision: number; nextRunAt: number | null; status: string; emailResult: boolean };
type Run = { id: string; status: string; result: { id: string; summary: string } | null };
const output = fileURLToPath(new URL('../../../data/routines-demo/', import.meta.url));
const infoPath = fileURLToPath(new URL('../../../data/routines-demo/info.json', import.meta.url));

async function api<T>(request: APIRequestContext, token: string, path: string): Promise<T> {
  const response = await request.get(`http://127.0.0.1:7488${path}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<T>;
}
async function capture(page: Page, name: string): Promise<void> {
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const heading = page.getByRole('heading', { level: 1 });
  const box = await heading.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(name.endsWith('bob-creation') ? 12 : 24);
  const viewport = page.viewportSize();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}

async function selectAppearance(page: Page, mode: 'Light' | 'Dark'): Promise<void> {
  await page.goto('/settings#appearance');
  await page.getByRole('radio', { name: mode, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode.toLowerCase());
}

async function openBob(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Ask Bob', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Message input' })).toBeVisible();
}
async function signIn(page: Page, request: APIRequestContext): Promise<{ token: string; owner: string; accountId: string }> {
  const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { owner: string; accountId: string };
  const response = await request.post('http://127.0.0.1:7488/api/test-token', { data: { userId: info.owner } });
  expect(response.ok()).toBe(true);
  const credentials = await response.json() as { token: string; expiresAt: number };
  await page.context().addInitScript(({ token, expiresAt, owner }) => {
    localStorage.setItem('bob.dev.token', token); localStorage.setItem('bob.dev.tokenExpiry', String(expiresAt * 1000));
    localStorage.setItem('bob.dev.userId', owner);
    if (!localStorage.getItem('bob.theme')) localStorage.setItem('bob.theme', 'light');
  }, { ...credentials, owner: info.owner });
  return { token: credentials.token, ...info };
}
test('routine configuration, independent run recaps and daily timeline survive real scheduled execution', async ({ page: initialPage, request, context }, testInfo) => {
  let page = initialPage;
  const auth = await signIn(page, request);
  const before = await api<{ routines: Routine[] }>(request, auth.token, '/api/routines');
  const time = new Date(Date.now() + 120000).toISOString().slice(11,16);
  await page.goto('/routines');
  await expect(page.getByRole('combobox', { name: 'Message input' })).toHaveCount(0);
  await openBob(page);
  await page.getByRole('combobox', { name: 'Message input' }).fill(`Demo: create my daily email summary at ${time} UTC using morning@example.test. I authorize scheduled email reads.`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Demo model: the routine tool finished. Open Routines to inspect the saved schedule.')).toBeVisible();
  let created: Routine | undefined;
  await expect.poll(async () => {
    const current = await api<{ routines: Routine[] }>(request, auth.token, '/api/routines');
    created = current.routines.find(item => !before.routines.some(old => old.id === item.id));
    return created?.localTime;
  }).toBe(time);
  if (!created) throw new Error('missing routine');
  expect(created.emailResult).toBe(false);
  const id = created.id;
  const browserClosedAt = Date.now();
  await page.close();
  let completed: Run | undefined;
  await expect.poll(async () => {
    const history = await api<{ runs: Run[] }>(request, auth.token, `/api/routines/${id}/runs`);
    completed = history.runs.find(run => run.status === 'completed'); return Boolean(completed?.result);
  }, { timeout: 150000, intervals: [5000] }).toBe(true);
  page = await context.newPage();
  await page.goto(`/routines#${id}`);
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByRole('button', { name: /· Ready/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Highlights', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sources (2)', exact: true }).click();
  await expect(page.getByRole('link', { name: /Project ready for review/ })).toHaveAttribute('href', /mail.google.com/);
  await capture(page, `${testInfo.project.name}-routine-recap`);
  await page.getByRole('button', { name: 'Configuration', exact: true }).click();
  await page.getByRole('button', { name: 'Configure routine', exact: true }).click();
  await page.getByRole('textbox', { name: 'Routine name' }).fill(`Project brief ${testInfo.project.name}`);
  await page.getByRole('textbox', { name: 'Email filter' }).fill('label:work');
  await page.getByRole('textbox', { name: 'What should Bob focus on?' }).fill('Highlight deadlines and next steps');
  await page.getByRole('combobox', { name: 'Summary detail' }).click();
  await page.getByRole('option', { name: 'Detailed recap' }).click();
  await page.getByRole('checkbox', { name: 'Saturday', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Sunday', exact: true }).uncheck();
  await page.getByRole('textbox', { name: 'Time zone' }).fill('America/Los_Angeles');
  const emailOptIn = page.getByRole('checkbox', { name: 'Email me when a recap is ready' });
  await expect(emailOptIn).not.toBeChecked();
  await emailOptIn.check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Email filter: label:work', { exact: true })).toBeVisible();
  await expect(page.getByText('Summary: detailed', { exact: true })).toBeVisible();
  const savedRoutines = await api<{ routines: Routine[] }>(request, auth.token, '/api/routines');
  expect(savedRoutines.routines.find(item => item.id === id)?.emailResult).toBe(true);
  await page.getByRole('button', { name: 'Configure routine', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Email me when a recap is ready' })).toBeChecked();
  await capture(page, `${testInfo.project.name}-routine-email-opt-in-light`);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await selectAppearance(page, 'Dark');
  await page.goto(`/routines#${id}`);
  await page.getByRole('button', { name: 'Configuration', exact: true }).click();
  await page.getByRole('button', { name: 'Configure routine', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Email me when a recap is ready' })).toBeChecked();
  await capture(page, `${testInfo.project.name}-routine-email-opt-in-dark`);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.reload();
  await expect(page.getByText(/Paused · Mon, Tue, Wed, Thu, Fri/)).toBeVisible();
  await capture(page, `${testInfo.project.name}-routine-configuration`);
  await page.goto('/timeline');
  await expect(page.getByText('Synthetic timeline task: review the draft', { exact: true })).toBeVisible();
  await expect(page.getByText(/· conversation ·/).first()).toBeVisible();
  await expect(page.getByText(/· routine · completed/).first()).toBeVisible();
  await page.getByText(`Project brief ${testInfo.project.name}`, { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Highlights', exact: true })).toBeVisible();
  await capture(page, `${testInfo.project.name}-daily-timeline`);
  const insights = await api<{ insights: unknown[] }>(request, auth.token, '/api/insights?category=past');
  expect(insights.insights).toEqual([]);
  const openApiResponse = await request.get('http://127.0.0.1:7488/openapi.json');
  expect(openApiResponse.ok()).toBe(true);
  const openApi = await openApiResponse.json() as { paths: Record<string, Record<string, { description?: string }>> };
  const routinePatchDescription = 'Updates an owned routine. Changes that keep it active require current Gmail access; pausing or archiving does not.';
  expect(openApi.paths['/api/routines/{id}']?.patch?.description).toBe(routinePatchDescription);
  await page.goto('http://127.0.0.1:7488/docs#/routines/patch_api_routines_id');
  const routinePatchDescriptionText = page.getByText(routinePatchDescription, { exact: true });
  await expect(routinePatchDescriptionText).toBeVisible();
  await routinePatchDescriptionText.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/${testInfo.project.name}-swagger-routine-patch.png` });
  writeFileSync(`${output}/${testInfo.project.name}-evidence.json`, JSON.stringify({ synthetic:true,realHttp:true,realPostgres:true,realQueue:true,browserClosedAt,completedObservedAt:Date.now(),routineId:id,runId:completed?.id,resultId:completed?.result?.id },null,2));
});

test('custom integration mentions obey integration and conversation tool controls', async ({ page, request, context }, testInfo) => {
  const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { owner: string; accountId: string };
  const auth = await request.post('http://127.0.0.1:7488/api/test-token', { data: { userId: info.owner } });
  expect(auth.ok()).toBe(true);
  const credentials = await auth.json() as { token: string; expiresAt: number };
  await context.addInitScript(({ token, expiresAt, owner }) => {
    localStorage.setItem('bob.dev.token', token);
    localStorage.setItem('bob.dev.tokenExpiry', String(expiresAt * 1000));
    localStorage.setItem('bob.dev.userId', owner);
    if (!localStorage.getItem('bob.theme')) localStorage.setItem('bob.theme', 'light');
  }, { ...credentials, owner: info.owner });
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'Actions for morning@example.test' }).click();
  await page.getByRole('menuitem', { name: /Rename/ }).or(page.getByRole('button', { name: 'Rename…', exact: true })).click();
  await page.getByRole('textbox', { name: 'Integration name' }).fill('WorkGmail');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Name this integration' })).toBeHidden();
  await page.reload();
  await expect(page.getByText('WorkGmail', { exact: true })).toBeVisible();
  await capture(page, `${testInfo.project.name}-integration-name`);
  await page.goto('/routines');
  await openBob(page);
  const input = page.getByRole('combobox', { name: 'Message input' });
  await input.fill('@notify.email');
  const notifyEmailOption = page.getByRole('option').filter({ hasText: 'Email notifications' }).first();
  await expect(notifyEmailOption).toBeVisible();
  await notifyEmailOption.click();
  const notifyEmailToken = input.locator('[data-astryx-token-value="@notify.email"]');
  await expect(notifyEmailToken).toHaveAttribute('data-astryx-token-value', '@notify.email');
  await expect(notifyEmailToken).toContainText('Email notifications');
  await capture(page, `${testInfo.project.name}-notify-email-mention-light`);
  await selectAppearance(page, 'Dark');
  await page.goto('/routines');
  await openBob(page);
  const darkInput = page.getByRole('combobox', { name: 'Message input' });
  await darkInput.fill('@notify.email');
  const darkNotifyEmailOption = page.getByRole('option').filter({ hasText: 'Email notifications' }).first();
  await expect(darkNotifyEmailOption).toBeVisible();
  await darkNotifyEmailOption.click();
  const darkNotifyEmailToken = darkInput.locator('[data-astryx-token-value="@notify.email"]');
  await expect(darkNotifyEmailToken).toHaveAttribute('data-astryx-token-value', '@notify.email');
  await expect(darkNotifyEmailToken).toContainText('Email notifications');
  await capture(page, `${testInfo.project.name}-notify-email-mention-dark`);
  await input.fill('@WorkGmail.search');
  const option = page.getByRole('option').filter({ hasText: 'WorkGmail.search' }).first();
  await expect(option).toBeVisible();
  await option.click();
  const token = input.locator('[data-astryx-token-value="@{integration:Gmail.search:morning@example.test}"]');
  await expect(token).toHaveCount(1);
  await expect(token).toContainText('WorkGmail.search');
  await capture(page, `${testInfo.project.name}-named-mention`);
  await input.press('End');
  await input.pressSequentially(' Demo: check job updates');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const result = page.getByText(/Mention search result from the real Gmail tool/);
  await expect(result).toContainText('Synthetic job update: interview invitation.');
  await expect(result).toContainText('"ok":true');
  await capture(page, `${testInfo.project.name}-mention-search`);
  const conversationId = await page.evaluate(owner => sessionStorage.getItem(`bob:routines:conversation:${owner}`), info.owner);
  if (!conversationId) throw new Error('missing demo conversation');
  for (const scope of [`integrationId=${info.accountId}`, `conversationId=${conversationId}`]) {
    await page.goto(`/tools?${scope}`);
    const toggle = page.getByRole('switch', { name: 'Search Gmail', exact: true });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.reload();
    await expect(toggle).not.toBeChecked();
    await capture(page, `${testInfo.project.name}-tools-${scope.split('=')[0]}`);
    await page.goto('/routines'); await openBob(page);
    await input.fill('@{integration:Gmail.search:morning@example.test} Demo: check job updates');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/Mention search result from the real Gmail tool/).last()).not.toContainText('"ok":true');
    await expect(page.getByText(/Mention search result from the real Gmail tool/).last()).toContainText(/tool_disabled|not found|not available|unavailable tool|No such tool/i);
    await page.goto(`/tools?${scope}`); await toggle.click(); await expect(toggle).toBeChecked();
    await page.goto('/routines'); await openBob(page);
    await input.fill('@{integration:Gmail.search:morning@example.test} Demo: check job updates');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/Mention search result from the real Gmail tool/).last()).toContainText('"ok":true');
  }
});
