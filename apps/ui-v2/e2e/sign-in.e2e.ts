/**
 * #550 flow: sign in with a code. Starts signed out (no saved session), signs
 * in with a code minted by scripts/dev-offline.mjs, and checks a wrong code is
 * refused with the page's own message. Creates nothing.
 */
import { expect, test } from './fixtures.ts';
import { mintSignInCode } from './stack.ts';

const DEV_EMAIL = process.env.BOB_DEV_EMAIL ?? 'dev@bob.local';

test.use({ storageState: { cookies: [], origins: [] } });

test('a minted code signs the dev user in to the chat landing', { tag: '@smoke' }, async ({ signInPage, chatPage }) => {
  await signInPage.goto();
  await signInPage.signIn(mintSignInCode());
  await expect(chatPage.landingHeading).toBeVisible({ timeout: 30_000 });
  await expect(chatPage.composer).toBeVisible();
});

test('a wrong code is refused and the page stays signed out', async ({ signInPage, chatPage }) => {
  await signInPage.goto();
  await signInPage.signIn({ email: DEV_EMAIL, code: '000000' });
  await expect(signInPage.wrongCodeError).toBeVisible();
  await expect(chatPage.landingHeading).toHaveCount(0);
});

// #864, #865: a malformed address and a missing code are answered on the field,
// before anything reaches Supabase, and never beside the "check your email" notice.
test('a malformed email and an empty code are flagged on their fields', async ({ signInPage, page }) => {
  await signInPage.goto();
  await signInPage.email.fill('qa-invalid');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(signInPage.email).toHaveAccessibleDescription('Enter a valid email address, like you@example.com.');
  await expect(signInPage.email).toHaveAttribute('aria-invalid', 'true');
  await expect(signInPage.code).toHaveCount(0);

  await signInPage.email.fill(DEV_EMAIL);
  await signInPage.haveCodeButton.click();
  await signInPage.verifyButton.click();
  await expect(signInPage.code).toHaveAccessibleDescription('Enter the 6-digit code from your email.');
  await expect(page.getByText('Sign-in failed. Check your details and try again.')).toHaveCount(0);
  await expect(page.getByText('Check your email for a sign-in code or a magic link.')).toHaveCount(0);
});
