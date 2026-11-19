import { join } from 'node:path';
import { expect, ok, test } from './fixtures.ts';
import { clickConversationAction } from './pages/phone.ts';
import { SignInPage } from './pages/sign-in-page.ts';
import { BASE_URL, E2E_DATA, mintSignInCode, newRunEmail } from './stack.ts';

test('two people join a private chat copy and talk with Bob', async ({ page, browser, api, tag, cleanup }, info) => {
  test.slow(); // Two real sign-ins, shared message delivery, and an assistant turn.
  const source = await api.post('/api/chat', { data: { message: {
    id: `msg-${tag}`, role: 'user', parts: [{ type: 'text', text: `Private original ${tag}` }],
  } } });
  await ok('create source', source);
  const sourceId = (await source.text()).match(/"conversationId":"([^"]+)"/)?.[1];
  if (!sourceId) throw new Error('source conversation missing');
  cleanup(async () => ok('delete source', await api.delete(`/api/conversations/${sourceId}`)));
  const before = await (await api.get(`/api/conversations/${sourceId}`)).json();
  await page.goto(`/c/${sourceId}`);
  await clickConversationAction(page, 'Add people');
  await expect(page.getByText(/original stays private/)).toBeVisible();
  const creation = page.waitForResponse((response) => response.url().endsWith('/api/group-chats') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create chat', exact: true }).click();
  if ((await creation).status() === 409) await page.getByRole('button', { name: 'Copy text only', exact: true }).click();
  await page.waitForURL(/\/groups\//);
  const groupId = new URL(page.url()).pathname.split('/').pop();
  if (!groupId) throw new Error('group destination missing');
  // Exercise the email control without sending mail to a real recipient.
  let emailRequests = 0;
  await page.route('**/api/group-chats/*/invitations', async (route) => {
    emailRequests += 1;
    expect(route.request().postDataJSON()).toEqual({ email: 'friend@example.test' });
    await route.fulfill({ status: 200, json: { sent: true } });
  });
  await clickConversationAction(page, 'People');
  expect(emailRequests).toBe(0);
  await page.getByRole('textbox', { name: 'Email address', exact: true }).fill('friend@example.test');
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
  await expect(page.getByText('Invitation sent. They can choose whether to join.', { exact: true })).toBeVisible();
  expect(emailRequests).toBe(1);
  await page.screenshot({ path: join(E2E_DATA, 'screenshots', `chat-people-${info.project.name}.png`), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Create invite link', exact: true }).click();
  const link = await page.getByLabel('Invitation link', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  const guestContext = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] }, viewport: page.viewportSize() ?? undefined });
  try {
    const guest = await guestContext.newPage();
    await guest.goto(link);
    const signIn = new SignInPage(guest);
    await signIn.signIn(mintSignInCode(newRunEmail()));
    await expect(guest.getByRole('button', { name: 'Join chat', exact: true })).toBeVisible();
    await expect(guest.getByRole('log')).toHaveCount(0);
    await guest.getByRole('button', { name: 'Join chat', exact: true }).click();
    await expect(guest).toHaveURL(new RegExp(`/groups/${groupId}$`));
    await expect(guest.getByRole('log')).toContainText(`Private original ${tag}`);
    const menu = guest.getByRole('button', { name: /open.*navigation|open.*menu|toggle.*navigation/i });
    const mobile = await menu.isVisible();
    if (mobile) await menu.click();
    const sharedRow = guest.locator(`a[href="/groups/${groupId}"]`);
    await expect(sharedRow).toBeVisible();
    await expect(sharedRow).toHaveAttribute('aria-current', 'page');
    await expect(guest.getByText('Group chats', { exact: true })).toHaveCount(0);
    await expect(guest.getByText('No chats yet', { exact: true })).toHaveCount(0);
    const navigation = mobile ? guest.getByRole('dialog') : guest.locator('.astryx-side-nav');
    await navigation.getByRole('button', { name: 'New chat', exact: true }).click({ timeout: 10_000 });
    await expect(guest.getByRole('button', { name: 'Add people', exact: true })).toBeVisible();
    if (mobile) await menu.click();
    await sharedRow.click();
    await expect(guest).toHaveURL(new RegExp(`/groups/${groupId}$`));
    // People is in the header on desktop and on the composer's top row on a phone.
    await expect(guest.getByRole('button', { name: 'People', exact: true })).toBeVisible();
    const guestInput = guest.getByRole('combobox', { name: 'Message', exact: true });
    await guestInput.fill(`Hello everyone ${tag}`);
    await guest.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('log')).toContainText(`Hello everyone ${tag}`);
    await page.getByRole('combobox', { name: 'Message', exact: true }).fill(`@bob Say hello ${tag}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(guest.getByRole('log').getByText('System test response', { exact: true })).toBeVisible();
    expect(await (await api.get(`/api/conversations/${sourceId}`)).json()).toEqual(before);
    // On a phone the h1 is visually hidden (the shell's top bar is the header), so only desktop shows it.
    if (!mobile) expect((await guest.getByRole('heading', { level: 1 }).last().boundingBox())?.x).toBeGreaterThan(0);
    const composer = await guestInput.boundingBox();
    expect(composer?.width).toBeGreaterThan(200);
    for (const scheme of ['light', 'dark'] as const) {
      await guest.emulateMedia({ colorScheme: scheme });
      await guest.screenshot({ path: join(E2E_DATA, 'screenshots', `group-chat-${info.project.name}-${scheme}.png`), fullPage: true, animations: 'disabled' });
    }
  } finally { await guestContext.close(); }
});
