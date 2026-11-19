/**
 * #550 flow: new chat and reply. Stub mode answers from the scripted stub
 * agent, which echoes an unscripted sentence as "System test response: ...";
 * live mode answers from the model. Either way the turn stores the
 * conversation, which the test deletes (only that one, by its own id).
 */
import { expect, ok, test } from './fixtures.ts';
import { emptyComposerAction } from './pages/phone.ts';
import { isLive } from './stack.ts';

test('a new chat gets a reply', { tag: '@smoke' }, async ({ chatPage, tag, api, cleanup }) => {
  const text = `Say hello back in three words. ${tag}`;
  await chatPage.goto();
  await chatPage.newChat();
  await chatPage.send(text);

  const id = await chatPage.conversationId();
  cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${id}`)));
  await expect(chatPage.userMessages.last()).toContainText(tag);
  if (isLive()) await expect(chatPage.lastReply()).not.toHaveText('');
  else await expect(chatPage.lastReply()).toContainText(`System test response: ${text}`);
  await expect(emptyComposerAction(chatPage.page)).toBeVisible();
});

test('#1396: Retry after a refused send delivers the typed text once, and it survives a reload', async ({ chatPage, tag, api, cleanup }) => {
  test.skip(isLive(), 'stub mode: the reply echoes the text the server answered');
  const first = 'First question ' + tag;
  await chatPage.goto();
  await chatPage.newChat();
  await chatPage.send(first);
  const id = await chatPage.conversationId();
  cleanup(async () => ok('delete conversation', await api.delete('/api/conversations/' + id)));
  await expect(chatPage.lastReply()).toContainText('System test response: ' + first);

  // Refused before the server stores anything, as a paused app's preflight does.
  const page = chatPage.page;
  await page.route('**/api/chat', (route) => route.fulfill({ status: 404, body: '{}' }), { times: 1 });
  const typed = 'Second question ' + tag;
  await chatPage.send(typed);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(chatPage.lastReply()).toContainText('System test response: ' + typed);

  await page.reload();
  await expect(chatPage.userMessages.filter({ hasText: typed })).toHaveCount(1);
  await expect(chatPage.lastReply()).toContainText('System test response: ' + typed);
});
