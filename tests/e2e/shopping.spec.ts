import { test, expect, type Page } from 'playwright/test';
import { a11yProblems } from './a11y.ts';

const PASSWORD = 'GlowDemo#2026';

// External fonts are blocked in CI sandboxes; the system fallback is used.
test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
});

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.locator('main form').getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test('browse, search and filter the catalogue', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Know what');
  const search = page.getByRole('combobox', { name: /search/i }).first();
  await search.fill('sunscreen');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=sunscreen/);
  await expect(page.getByRole('link', { name: 'Matte Fluid Sunscreen SPF 50' })).toBeVisible();

  await page.goto('/skincare');
  const filters = page.locator('form[aria-label="Filter products"]').filter({ visible: true });
  await filters.getByLabel('Sunscreen', { exact: true }).check();
  await filters.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/category=sunscreen/);
  await expect(page.getByRole('link', { name: 'Hydrating Gel Sunscreen SPF 30' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ceramide Moisturizer' })).toHaveCount(0);

  await page.goto('/shop?min=100&max=200');
  await expect(page.getByRole('link', { name: 'Calamine Lotion' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Vitamin C Face Serum' })).toHaveCount(0);

  await page.goto('/search?q=qqqzzzxx');
  await expect(page.getByText(/No (products|results)/i).first()).toBeVisible();
});

test('add, update and remove cart items with stock validation', async ({ page }) => {
  await page.goto('/p/salicylic-acid-2-face-wash');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Salicylic Acid 2% Face Wash');
  await page.locator('form[aria-label^="Buy"]').getByText('200 ml', { exact: true }).click();
  await page.getByLabel('Quantity').selectOption('2');
  await page.getByRole('button', { name: /add to cart/i }).click();
  await expect(page.locator('[data-cart-count]').first()).toHaveText('2');

  await page.goto('/cart');
  await expect(page.getByText('Salicylic Acid 2% Face Wash')).toBeVisible();
  await expect(page.getByText('₹1,198').first()).toBeVisible(); // 2 × ₹599, server-calculated

  // Low-stock item: asking for more than available is refused
  await page.goto('/p/micellar-cleansing-water'); // 4 in stock
  await page.getByLabel('Quantity').selectOption('4');
  await page.getByRole('button', { name: /add to cart/i }).click();
  await expect(page.locator('[data-cart-count]').first()).toHaveText('6');
  await page.getByRole('button', { name: /add to cart/i }).click();
  await expect(page.getByText(/Only 4/).first()).toBeVisible();

  await page.goto('/cart');
  const qtyForm = page.locator('form[aria-label="Quantity for Micellar Cleansing Water"]');
  await qtyForm.getByRole('spinbutton').fill('1');
  await qtyForm.getByRole('button').click();
  await expect(page.getByText(/Cart updated|Item removed/)).toBeVisible();
  await page.getByRole('button', { name: /remove.*micellar/i }).click();
  await expect(page.getByText('Micellar Cleansing Water')).toHaveCount(0);
});

test('signed-in customer completes a sandbox checkout end to end', async ({ page }) => {
  await login(page, 'customer@glowderma.test');
  await page.goto('/p/ceramide-moisturizer');
  await page.getByRole('button', { name: /add to cart/i }).click();
  await expect(page.locator('[data-cart-count]').first()).not.toHaveText('0');
  await page.goto('/cart');
  await page
    .getByRole('link', { name: /checkout/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByText('12 Sample Street')).toBeVisible();

  // Form errors: terms not accepted
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText(/accept the terms/i).first()).toBeVisible();

  await page.getByLabel(/I have reviewed my order/i).check();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/checkout\/pay\/GD-\d+/);
  const orderNumber = (/GD-\d+/.exec(page.url()) ?? [''])[0];
  await page.getByRole('link', { name: 'Continue to sandbox payment' }).click();
  await expect(page.getByText(/sandbox/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${orderNumber}/confirmation`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/thank|confirmed|order/i);
  await expect(page.getByText(orderNumber).first()).toBeVisible();

  await page.goto('/account/orders');
  await expect(page.getByRole('link', { name: orderNumber })).toBeVisible();
});

test('failed sandbox payment can be retried', async ({ page }) => {
  await login(page, 'customer@glowderma.test');
  await page.goto('/p/hydrating-night-cream');
  await page.getByRole('button', { name: /add to cart/i }).click();
  await expect(page.locator('[data-cart-count]').first()).not.toHaveText('0');
  await page.goto('/checkout');
  await page.getByLabel(/I have reviewed my order/i).check();
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByRole('link', { name: 'Continue to sandbox payment' }).click();
  await page.getByRole('button', { name: 'Simulate failed payment' }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /did not go through/ })
      .first(),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Continue to sandbox payment' }).click();
  await page.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expect(page).toHaveURL(/\/confirmation$/);
});

test('customers cannot open the admin dashboard; admins can', async ({ page }) => {
  await login(page, 'customer@glowderma.test');
  const res = await page.goto('/admin');
  expect(res?.status()).toBe(403);
  await expect(page.getByText(/do not have access/i)).toBeVisible();
  await page.context().clearCookies();
  await login(page, 'admin@glowderma.test');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText(/Sandbox payments are active/)).toBeVisible();
});

test('prescription-only product cannot be bought while ordering is disabled', async ({ page }) => {
  await page.goto('/p/tretinoin-0025-cream-rx-demo');
  await expect(page.getByText('Prescription required').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /add to cart/i })).toHaveCount(0);
  await expect(page.getByText(/not medical advice/i).first()).toBeVisible();
});

test('keyboard users get a skip link and visible focus', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  const outline = await skip.evaluate((el) => getComputedStyle(el).outlineStyle + getComputedStyle(el).boxShadow);
  expect(outline).not.toBe('nonenone');
});

for (const path of ['/', '/shop', '/p/salicylic-acid-2-face-wash', '/cart', '/login', '/register', '/contact', '/faq', '/pharmacy', '/policies/privacy']) {
  test(`accessibility checks: ${path}`, async ({ page }) => {
    await page.goto(path);
    expect(await a11yProblems(page)).toEqual([]);
  });
}

test('accessibility checks: checkout and admin', async ({ page }) => {
  await login(page, 'customer@glowderma.test');
  await page.goto('/p/vitamin-c-face-serum');
  await page.getByRole('button', { name: /add to cart/i }).click();
  await expect(page.locator('[data-cart-count]').first()).not.toHaveText('0');
  for (const p of ['/checkout', '/account', '/account/orders']) {
    await page.goto(p);
    expect(await a11yProblems(page), p).toEqual([]);
  }
  await page.context().clearCookies();
  await login(page, 'admin@glowderma.test');
  for (const p of ['/admin', '/admin/orders', '/admin/products', '/admin/settings']) {
    await page.goto(p);
    expect(await a11yProblems(page), p).toEqual([]);
  }
});
