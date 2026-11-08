import { expect, test, type Page } from '@playwright/test';

/** Signing out reloads the app on the sign-in page: wait for it before typing. */
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Log out' }).first().click();
  await page.waitForURL((url) => url.pathname === '/');
  await page.waitForLoadState('load');
  await expect(page.getByLabel('Username')).toBeVisible();
}

async function signIn(page: Page, username: string) {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
  // Signing in reloads the app on the Main menu.
  await page.waitForURL((url) => url.pathname === '/menu');
  await expect(page.getByRole('button', { name: 'Log out' }).first()).toBeVisible();
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
  await signOut(page);

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

test('after an Admin signs out or a cashier unlocks with their PIN, the cashier gets only their own pages', async ({
  page,
}) => {
  await page.goto('/');
  await signIn(page, 'admin');
  await page.goto('/admin/cashiers');
  await expect(page).toHaveURL(/\/admin\/cashiers$/);
  await signOut(page);
  await signIn(page, 'cashier');
  await expect(page).toHaveURL(/\/menu$/);
  await expect(page.getByRole('link', { name: 'Cashiers' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
  for (const path of ['/admin/cashiers', '/admin', '/stock/suppliers', '/admin/audit']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/menu$/);
  }

  // The screen locks on an Admin's page and the cashier's PIN opens it: a fresh start for them.
  await signOut(page);
  await signIn(page, 'admin');
  await page.goto('/admin/cashiers');
  await page.evaluate(() =>
    fetch('/api/auth/lock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.reload();
  await page.getByLabel('PIN').fill('4444');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/menu$/);
  await expect(page.getByRole('link', { name: 'Cashiers' })).toHaveCount(0);
  await expect(page.locator('footer')).toContainText('Cashier');
});

test('with no PIN, the locked screen asks for the password; a PIN set in My profile opens it next time', async ({
  page,
}) => {
  await page.goto('/');
  await signIn(page, 'owner');
  const made = await page.evaluate(async () => {
    const roles = (await (await fetch('/api/roles')).json()) as {
      items: { id: string; code: string }[];
    };
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'nopin',
        fullName: 'No Pin',
        password: 'password123',
        roleIds: [roles.items.find((r) => r.code === 'CASHIER')!.id],
        mustChangePassword: false,
      }),
    });
    return res.status;
  });
  expect(made).toBe(200);
  await signOut(page);
  await signIn(page, 'nopin');
  const lock = () =>
    page.evaluate(() =>
      fetch('/api/auth/lock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
  await lock();
  await page.reload();
  await expect(page.getByText('You have no PIN yet')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Screen locked' })).toHaveCount(0);

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Set my PIN' }).click();
  await page.getByLabel('My password').fill('password123');
  await page.getByLabel('New PIN').fill('8642');
  await page.getByRole('button', { name: 'Save my PIN' }).click();
  await expect(page.getByText('Your PIN is set.')).toBeVisible();

  await lock();
  await page.reload();
  await expect(page.getByLabel('PIN')).toBeFocused();
  await page.getByLabel('PIN').fill('8642');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Screen locked' })).toHaveCount(0);
});
