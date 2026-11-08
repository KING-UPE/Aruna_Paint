import { expect, test, type Page } from '@playwright/test';

/** The server says it now runs another version, as it does after an update restarts it. */
async function serverUpdatedTo(page: Page, version: string) {
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { ok: true, mode: 'shop', version, time: new Date() } }),
  );
}
/** What a screen sees when its window is shown again; the same check runs on reconnecting. */
const windowShown = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

async function signIn(page: Page, username: string) {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname === '/menu');
}

test('an open screen reloads itself once the server runs a new version, and never loops', async ({
  page,
}) => {
  await signIn(page, 'admin');
  let loads = 0;
  page.on('load', () => loads++);
  await serverUpdatedTo(page, '9.9.9');
  await windowShown(page);
  // It reloads once for the new version...
  await expect.poll(() => loads).toBe(1);
  // ...and if the screens are still not the new ones, it says so instead of reloading again.
  await expect(page.getByText('Aruna POS was updated to 9.9.9.')).toBeVisible();
  await expect(page.getByText('Reload the screen to use it.')).toBeVisible();
  await windowShown(page);
  await page.waitForTimeout(1000);
  expect(loads).toBe(1);
});

test('a bill being rung up is never lost: the reload waits until the bill is finished', async ({
  page,
}) => {
  await signIn(page, 'cashier');
  await page.getByRole('button', { name: /Open Billing Screen/ }).press('Enter');
  await expect(page.getByText(/^Your sales today: Rs/)).toBeVisible();
  const net = page.locator('[aria-live="polite"]', { hasText: /^Rs / });
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: 'Item code' })).toBeFocused();
  await page.keyboard.type('brush');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Brush 2 inch');
  await page.keyboard.press('Enter'); // the item
  await page.keyboard.press('Enter'); // 1
  await page.keyboard.press('Enter'); // no discount
  await expect(net).toHaveText('Rs 450.00');

  let loads = 0;
  page.on('load', () => loads++);
  await serverUpdatedTo(page, '9.9.9');
  await windowShown(page);
  // The bill stays on the screen, with a note.
  await expect(
    page.getByText('The screen reloads by itself when this bill is finished.'),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  expect(loads).toBe(0);
  await expect(net).toHaveText('Rs 450.00');

  // Paid: now the screen reloads on the new version.
  await page.keyboard.press('F10');
  await expect(page.getByRole('dialog')).toContainText('Rs 450.00');
  await page.keyboard.press('Enter');
  await page.keyboard.press('n');
  await expect.poll(() => loads).toBe(1);
});
