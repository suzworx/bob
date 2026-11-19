/**
 * BOB-LOGIN-SPLIT: Bob's split welcome + sign-in at 320, 390 and 1280 px, light and dark. All network is
 * mocked in the browser (public-config and the Supabase auth host), so nothing is sent to a real
 * provider and no email goes out. Geometry is positive: gutters > 0, no horizontal overflow, the form
 * reachable. Screenshots: data/e2e/screenshots/sign-in-bob-<state>-<width>-<scheme>.png.
 */
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_DATA } from './stack.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const SUPABASE = 'http://localhost:54321';
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
  { width: 844, height: 390 },
  { width: 600, height: 800 },
];

async function mockNetwork(page: Page, authStatus = 400): Promise<void> {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'mock-only' } }));
  await page.route('**/api/public-config', (route) =>
    route.fulfill({
      json: { supabaseUrl: SUPABASE, supabasePublishableKey: 'pk_mock', pairingUrl: '', devSignIn: false },
    }),
  );
  await page.route(`${SUPABASE}/**`, (route) =>
    route.fulfill({ status: authStatus, json: { code: 'validation_failed', msg: 'mock', error_code: 'validation_failed' } }),
  );
}

async function expectComposed(page: Page, width: number): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const email = page.getByLabel('Email');
  await email.scrollIntoViewIfNeeded();
  const box = await email.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) throw new Error('Email has no rendered bounds');
  expect(box.x).toBeGreaterThan(0);
  expect(box.x + box.width).toBeLessThan(width);
  const hero = await page.getByRole('heading', { name: 'Hello again, friend.' }).boundingBox();
  expect(hero).not.toBeNull();
  if (hero === null) throw new Error('Hero has no rendered bounds');
  expect(hero.x).toBeGreaterThan(0);
  expect(hero.x + hero.width).toBeLessThanOrEqual(width);
  if (width >= 640) expect(hero.x + hero.width).toBeLessThanOrEqual(box.x); // art + welcome left, form right
  else expect(hero.y + hero.height).toBeLessThan(box.y); // stacked: welcome before the form
  const submit = page.getByRole('button', { name: /^(Send code|Verify|Sign in with password|Send reset link)$/ });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  await expect(submit).toBeEnabled();
}

async function shot(page: Page, state: string, width: number, scheme: string): Promise<void> {
  await page.screenshot({ path: join(E2E_DATA, 'screenshots', `sign-in-bob-${state}-${width}-${scheme}.png`), fullPage: true });
}

for (const scheme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.width}px ${scheme}`, () => {
      test.use({ viewport, colorScheme: scheme });

      test('code, password, reset and error states keep the split frame', async ({ page }) => {
        await mockNetwork(page);
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Sign in to Bob' })).toBeVisible();
        await expect(page.getByRole('img', { name: /bob/i })).toBeVisible();
        await expectComposed(page, viewport.width);
        await shot(page, 'code', viewport.width, scheme);

        await page.getByLabel('Email').fill('qa-invalid');
        await page.getByRole('button', { name: 'Send code' }).click();
        await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
        await expectComposed(page, viewport.width);
        await shot(page, 'error', viewport.width, scheme);

        await page.getByLabel('Email').fill('me@example.com');
        await page.getByRole('button', { name: 'I have a code' }).click();
        await expect(page.getByLabel('Six-digit code')).toBeVisible();
        await expectComposed(page, viewport.width);
        await shot(page, 'code-sent', viewport.width, scheme);

        await page.getByRole('button', { name: 'Use password' }).click();
        await expect(page.getByLabel('Password')).toBeVisible();
        await expectComposed(page, viewport.width);
        await shot(page, 'password', viewport.width, scheme);

        await page.getByRole('button', { name: 'Forgot password?' }).click();
        await expect(page.getByRole('button', { name: 'Send reset link' })).toBeVisible();
        await expectComposed(page, viewport.width);
        await shot(page, 'reset', viewport.width, scheme);
      });
    });
  }
}

test('Bob host keeps the plain card (no Bob hero)', async ({ page }) => {
  await mockNetwork(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hello again, friend.' })).toHaveCount(0);
});

test('Bob deep links keep the back action in one frame at phone and desktop widths', async ({ page }) => {
  await mockNetwork(page);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto('/c/conv_mock_login');
    await expect(page.getByRole('heading', { name: 'Sign in to Bob' })).toBeVisible();
    await expectComposed(page, viewport.width);
    const back = page.getByRole('button', { name: 'Back to home' });
    await back.scrollIntoViewIfNeeded();
    await expect(back).toBeInViewport();
    await shot(page, 'deep', viewport.width, 'light');
    await back.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Sign in to Bob' })).toBeVisible();
  }
});

test('Bob submits code, password and reset only to the mocked auth service', async ({ page }) => {
  await mockNetwork(page);
  await page.route(`${SUPABASE}/auth/v1/otp*`, (route) => route.fulfill({ json: {} }));
  await page.route(`${SUPABASE}/auth/v1/recover*`, (route) => route.fulfill({ json: {} }));
  await page.goto('/');
  await page.getByLabel('Email').fill('me@example.com');
  const codeRequest = page.waitForRequest((request) => request.url().startsWith(`${SUPABASE}/auth/v1/otp`));
  await page.getByRole('button', { name: 'Send code' }).click();
  const sent = await codeRequest;
  expect(sent.postDataJSON()).toMatchObject({ email: 'me@example.com', create_user: false });
  expect(new URL(sent.url()).searchParams.get('redirect_to')).toBe(new URL(page.url()).origin);
  await expect(page.getByText('Enter the code from your email.')).toBeVisible();
  await page.getByLabel('Six-digit code').fill('123456');
  const verifyRequest = page.waitForRequest(`${SUPABASE}/auth/v1/verify`);
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  expect((await verifyRequest).postDataJSON()).toMatchObject({ email: 'me@example.com', token: '123456', type: 'email' });
  await expect(page.getByText('Sign-in failed. Check your details and try again.')).toBeVisible();
  await page.getByRole('button', { name: 'Use password', exact: true }).click();
  await page.getByLabel('Password').fill('mock-password-only');
  const passwordRequest = page.waitForRequest(`${SUPABASE}/auth/v1/token?grant_type=password`);
  await page.getByRole('button', { name: 'Sign in with password' }).click();
  expect((await passwordRequest).postDataJSON()).toMatchObject({ email: 'me@example.com', password: 'mock-password-only' });
  await expect(page.getByText('Sign-in failed. Check your details and try again.')).toBeVisible();
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  const resetRequest = page.waitForRequest((request) => request.url().startsWith(`${SUPABASE}/auth/v1/recover`));
  await page.getByRole('button', { name: 'Send reset link' }).click();
  expect(new URL((await resetRequest).url()).searchParams.get('redirect_to')).toBe(`${new URL(page.url()).origin}/reset`);
  await expect(page.getByText('Check your email for a password reset link.')).toBeVisible();
});
