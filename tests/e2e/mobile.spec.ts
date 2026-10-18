import { test, expect } from 'playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
});

test('mobile pages never scroll horizontally', async ({ page }) => {
  for (const p of ['/', '/shop', '/p/salicylic-acid-2-face-wash', '/cart', '/login', '/register', '/checkout', '/pharmacy', '/policies/terms']) {
    await page.goto(p);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, p).toBeLessThanOrEqual(1);
  }
});

test('mobile navigation menu opens and navigates', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Open menu').click();
  const nav = page.locator('#mobile-nav');
  await nav.getByRole('link', { name: 'Pharmacy' }).first().click();
  await expect(page).toHaveURL(/\/pharmacy$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Pharmacy/);
});

test('mobile form errors are announced and focused', async ({ page }) => {
  await page.goto('/register');
  await page.getByRole('textbox', { name: 'Email' }).fill('not-an-email');
  await page
    .locator('main form')
    .getByRole('button', { name: /create account/i })
    .click();
  const summary = page.locator('#form-errors');
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  await expect(page.getByText('Enter a valid email address.').first()).toBeVisible();
});

test('mobile add to cart works', async ({ page }) => {
  await page.goto('/p/oil-free-gel-moisturizer');
  await page.getByRole('button', { name: /add to cart/i }).click();
  await expect(page.locator('[data-cart-count]').first()).toHaveText('1');
});
