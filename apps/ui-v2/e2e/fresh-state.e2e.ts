/**
 * TG-FRESH-E2E guard: the run's account starts empty. It runs in its own
 * project, after sign-in and before every other spec (playwright.config.ts),
 * so any leak into the suite's account (a reused account, another run's data,
 * the developer's) fails here, loudly, instead of making some later spec pass
 * on data it never seeded. Signing in makes no Space: a new account gets its
 * private Space only from its first chat turn (seed.space()).
 */
import { expect, ok, test } from './fixtures.ts';
import { runAccountEmail } from './stack.ts';

test("the run's account is brand new and empty", async ({ api }) => {
  expect(runAccountEmail()).toMatch(/^e2e-run-\d+-[0-9a-f]+@bob\.local$/);

  const memories = await api.get('/api/memories');
  await ok('list memories', memories);
  expect((await memories.json()) as { memories: unknown[] }).toMatchObject({ memories: [] });

  const conversations = await api.get('/api/conversations');
  await ok('list conversations', conversations);
  expect((await conversations.json()) as { conversations: unknown[] }).toMatchObject({ conversations: [] });

  const spaces = await api.get('/api/spaces');
  await ok('list spaces', spaces);
  expect((await spaces.json()) as { spaces: unknown[] }).toMatchObject({ spaces: [] });
});

test('the memory page shows no memories', async ({ memoryPage }) => {
  await memoryPage.goto();
  await memoryPage.waitUntilLoaded();
  await expect(memoryPage.emptyState).toBeVisible();
  await expect(memoryPage.filter).toHaveCount(0);
});
