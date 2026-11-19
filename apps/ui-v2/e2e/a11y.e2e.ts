/**
 * #550 / #522: an axe scan (WCAG 2.x A and AA rules) of every main page, at
 * both widths (the two projects). A serious or critical violation fails the
 * test and is listed in the failure message; minor and moderate findings are
 * left to the report. Each scan runs once the page has settled on a landmark
 * that only renders after loading, so it sees the rendered page, never the
 * loading state. Only the memory scan creates data (its own, deleted after).
 */
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

test.describe('accessibility', { tag: '@a11y' }, () => {
  test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('sign-in page', async ({ signInPage, makeAxeBuilder }) => {
      await signInPage.goto();
      await expect(signInPage.email).toBeVisible();
      await expectNoSeriousA11yViolations(makeAxeBuilder());
    });
  });

  test('chat landing', async ({ chatPage, makeAxeBuilder }) => {
    await chatPage.goto();
    await expect(chatPage.composer).toBeVisible();
    await expectNoSeriousA11yViolations(makeAxeBuilder());
  });

  test('calendar', async ({ calendarPage, makeAxeBuilder }) => {
    await calendarPage.goto();
    await expect(calendarPage.days.first()).toBeVisible();
    await expectNoSeriousA11yViolations(makeAxeBuilder());
  });

  // The list, its search and the row actions render only with at least one
  // memory; a fresh account (CI) has none. So the scan seeds its own fact
  // through the real API (seed), scans the populated page, and deletes it.
  test('memory', async ({ memoryPage, makeAxeBuilder, tag, seed }) => {
    const fact = `Likes jazz ${tag}`;
    await seed.memory(fact, 'fact');
    await memoryPage.goto();
    await memoryPage.waitUntilLoaded();
    await expect(memoryPage.filter).toBeVisible();
    await expect(memoryPage.entry(fact).first()).toBeVisible();
    await expectNoSeriousA11yViolations(makeAxeBuilder());
  });

  test('devices', async ({ devicesPage, makeAxeBuilder }) => {
    await devicesPage.goto();
    await expect(devicesPage.pairButton).toBeVisible();
    await expectNoSeriousA11yViolations(makeAxeBuilder());
  });
});
