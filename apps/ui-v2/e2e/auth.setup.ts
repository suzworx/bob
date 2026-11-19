/**
 * #550 setup: signs this run's own account (global-setup.ts made it, never
 * dev@bob.local) in through the real sign-in page with a code minted by
 * scripts/dev-offline.mjs, then saves the session for every other spec. The
 * sign-in flow itself is also covered at both widths in sign-in.e2e.ts.
 */
import { expect, test as setup } from '@playwright/test';
import { ChatPage } from './pages/chat-page.ts';
import { SignInPage } from './pages/sign-in-page.ts';
import { AUTH_FILE, mintSignInCode } from './stack.ts';

setup("sign in the run's account", async ({ page }) => {
  const signInPage = new SignInPage(page);
  await signInPage.goto();
  await signInPage.signIn(mintSignInCode());
  await expect(new ChatPage(page).landingHeading).toBeVisible({ timeout: 30_000 });
  await page.context().storageState({ path: AUTH_FILE });
});
