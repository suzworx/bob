/**
 * #550 flow: a chat reply that creates a task shows the task's chip (#544),
 * and the chip opens the space's tasks. The sentence is one of the scripted
 * stub agent's (apps/ai/src/stub-agent.ts): in stub mode it makes a real
 * create_task call against the local store; in live mode the model does.
 * Deletes the task and the conversation it made.
 */
import type { APIRequestContext } from '@playwright/test';
import { expect, ok, test } from './fixtures.ts';

/** Deletes every open task titled `title` in the dev user's spaces. */
async function deleteTasksTitled(api: APIRequestContext, title: string): Promise<void> {
  const spaces = (await (await api.get('/api/spaces')).json()) as { spaces: Array<{ id: string }> };
  for (const space of spaces.spaces) {
    const list = (await (await api.get(`/api/spaces/${space.id}/tasks?status=open`)).json()) as {
      tasks?: Array<{ id: string; title: string }>;
    };
    for (const task of list.tasks ?? []) {
      if (task.title === title) await ok('delete task', await api.delete(`/api/tasks/${task.id}`));
    }
  }
}

test('a reply that creates a task shows its chip', async ({ page, chatPage, tag, api, cleanup }) => {
  const title = `Buy stamps ${tag}`;
  cleanup(() => deleteTasksTitled(api, title));

  await chatPage.goto();
  await chatPage.newChat();
  await chatPage.send(`e2e add a task called ${title}`);
  const id = await chatPage.conversationId();
  cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${id}`)));

  const chip = chatPage.chip(title);
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(/\/spaces\/[^/]+\/tasks/);
  await expect(page.getByText(title).first()).toBeVisible();
});
