import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, username: string) {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
}

test("after the Super Admin signs out, an Admin never sees the Super Admin's pages", async ({
  page,
}) => {
  await page.goto('/');
  await signIn(page, 'owner');
  await expect(page.getByRole('link', { name: 'Users and roles' })).toBeVisible();
  // The Super Admin signs out while on Settings.
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByLabel('Username')).toBeVisible();

  // The Admin signing in next starts on the Main menu, with an Admin's menu.
  await signIn(page, 'admin');
  await expect(page).toHaveURL(/\/menu$/);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Users and roles' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  // Typing a Super Admin page's address leads back to the Main menu.
  for (const path of ['/admin/settings', '/admin/users']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/menu$/);
  }
});
