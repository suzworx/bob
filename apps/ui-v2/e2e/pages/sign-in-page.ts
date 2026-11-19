/**
 * #550: the sign-in page (shown at / whenever signed out), "I already have a
 * code" path. The dev user's code comes from scripts/dev-offline.mjs --code.
 */
import type { Locator, Page } from '@playwright/test';
import type { SignInCode } from '../stack.ts';

export class SignInPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly email: Locator;
  readonly haveCodeButton: Locator;
  readonly code: Locator;
  readonly verifyButton: Locator;
  readonly wrongCodeError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Sign in' });
    this.email = page.getByLabel('Email');
    this.haveCodeButton = page.getByRole('button', { name: 'I already have a code' });
    this.code = page.getByLabel('Six-digit code');
    this.verifyButton = page.getByRole('button', { name: 'Verify' });
    this.wrongCodeError = page.getByText('That code is wrong or has expired. Request a new code.');
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
    await this.heading.waitFor();
  }

  /** Fills email and code on the code path, stopping before Verify. */
  async enterCode({ email, code }: SignInCode): Promise<void> {
    await this.email.fill(email);
    await this.haveCodeButton.click();
    await this.code.fill(code);
  }

  /** Enters the code and submits it. */
  async signIn(signIn: SignInCode): Promise<void> {
    await this.enterCode(signIn);
    await this.verifyButton.click();
  }
}
