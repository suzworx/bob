/**
 * #550 flow: start Animal Riddles (#479) from chat. There is no UI entry
 * point; the agent calls start_game. The sentence is one of the scripted stub
 * agent's (apps/ai/src/stub-agent.ts): in stub mode it runs the real game
 * engine against the local store; in live mode the model does and asks the
 * first riddle. Deleting the conversation also removes its game session
 * (on delete cascade).
 */
import { expect, ok, test } from './fixtures.ts';
import { isLive } from './stack.ts';

test('Animal Riddles starts from chat', async ({ chatPage, api, cleanup }) => {
  await chatPage.goto();
  await chatPage.newChat();
  await chatPage.send('e2e play animal riddles as Maya');
  const id = await chatPage.conversationId();
  cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${id}`)));

  const reply = chatPage.lastReply();
  await expect(reply.getByText('start_game').first()).toBeVisible();
  if (isLive()) await expect(reply).toContainText('Who am I?');
  else await expect(reply).toContainText('Stub: start_game finished.');
});
