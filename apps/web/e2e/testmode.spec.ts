import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, username: string, url = '/') {
  await page.goto(url);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Username')).toBeHidden();
}

test('the Super Admin puts one cashier in test mode; only that cashier sees TEST MODE', async ({
  page,
  browser,
}) => {
  await login(page, 'owner');
  await page.goto('/admin/users');
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'cashier', exact: true }) });
  await row.getByRole('button', { name: 'Put in test mode' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Put in test mode' }).click();
  await expect(row.getByText('Test mode', { exact: true })).toBeVisible({ timeout: 30_000 });

  // The cashier, at a counter elsewhere, works in test mode.
  const counter = await browser.newPage();
  await login(counter, 'cashier', '/?counter=C1');
  const banner = (p: Page) => p.getByRole('status').filter({ hasText: 'TEST MODE' });
  await expect(banner(counter)).toBeVisible();
  // The Super Admin stays on the real data.
  await expect(banner(page)).toBeHidden();

  await row.getByRole('button', { name: 'Back to real data' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Back to real data' }).click();
  await expect(row.getByText('Test mode', { exact: true })).toBeHidden();
  // The cashier's screens hear about it and drop the banner.
  await expect(banner(counter)).toBeHidden({ timeout: 15_000 });
  await counter.close();
});
