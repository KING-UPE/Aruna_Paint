import { expect, test } from '@playwright/test';

test('the Super Admin turns test mode on and off; every screen shows it meanwhile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Username')).toBeHidden();
  await page.goto('/admin/settings');

  await page.getByLabel('Your password').fill('password123');
  await page.getByRole('button', { name: 'Turn test mode on' }).click();
  const banner = page.getByRole('status').filter({ hasText: 'TEST MODE' });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/^Test mode is on: since/)).toBeVisible();

  // The banner stays on other screens too.
  await page.goto('/stock/products');
  await expect(banner).toBeVisible();

  await page.goto('/admin/settings');
  await page.getByRole('button', { name: 'Turn test mode off' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn test mode off' }).click();
  await expect(banner).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Turn test mode on' })).toBeVisible();
});
