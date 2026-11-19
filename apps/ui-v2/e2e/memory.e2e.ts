/**
 * /memory is facts only (#1240): a fact shows addressed to the reader, server
 * search narrows the list, an action item is not listed (it lives on Today),
 * and a row's actions sit in one menu. The test seeds one fact and one action
 * item through the API (seed), which deletes both afterwards.
 */
import { expect, test } from './fixtures.ts';
import { menuItem } from './components/menu.ts';

test('memory lists facts in the reader’s voice and keeps to-dos off the page', async ({ memoryPage, page, tag, seed }) => {
  const fact = `User prefers green tea ${tag}`;
  const shown = `You prefer green tea ${tag}`;
  const action = `Book the dentist ${tag}`;
  await seed.memory(fact, 'fact');
  await seed.memory(action, 'action_item');

  await memoryPage.goto();
  await memoryPage.waitUntilLoaded();
  const search = page.getByRole('textbox', { name: 'Search memories' });
  // Scoped to the list rows and matched exactly: each row's menu tooltip also
  // carries the text ("Actions for …").
  const row = page.getByRole('listitem').getByText(shown, { exact: true });
  await search.fill(tag);
  await expect(row).toBeVisible();
  await expect(page.getByText(fact)).toHaveCount(0);
  await expect(page.getByText(action)).toHaveCount(0);

  await page.getByRole('button', { name: `Actions for ${shown}` }).click();
  await expect(menuItem(page, 'Edit')).toBeVisible();
  await expect(menuItem(page, 'Delete')).toBeVisible();
  await page.keyboard.press('Escape');

  await search.fill(`${tag}-nothing-matches`);
  await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Delete all/ })).toHaveCount(0);
});
