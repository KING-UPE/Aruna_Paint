import { expect, test, type Page } from '@playwright/test';

// The e2e shop server is not an installed one, so it never has an update: the "update ready"
// answer is faked in the browser, and the choice is checked as it is sent.
async function fakeUpdate(page: Page) {
  const state = { choice: null as 'night' | 'startup' | null, sent: [] as unknown[] };
  await page.route('**/api/system/status', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.update = {
      version: '9.9.9',
      notes: 'Faster search.',
      choice: state.choice,
      installing: false,
      installAt: '02:30',
    };
    await route.fulfill({ response: res, json: body });
  });
  await page.route('**/api/updates/choice', async (route) => {
    const body = route.request().postDataJSON() as { when: 'night' | 'startup' };
    state.sent.push(body);
    state.choice = body.when;
    await route.fulfill({ json: { choice: body.when } });
  });
  return state;
}

async function signIn(page: Page, username: string) {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
}

test('a downloaded update asks the Super Admin when to install; Enter takes "Tonight"', async ({
  page,
}) => {
  const state = await fakeUpdate(page);
  await signIn(page, 'owner');
  const dialog = page.getByRole('dialog', { name: 'Update ready: version 9.9.9' });
  await expect(dialog).toBeVisible();
  // The safe choice has the focus, so a stray Enter never starts an install mid-work.
  await expect(dialog.getByRole('button', { name: 'Tonight at 02:30' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Version 9.9.9 installs tonight at 02:30.')).toBeVisible();
  expect(state.sent).toEqual([{ when: 'night' }]);
  await expect(dialog).toBeHidden();
  // The status bar shows the choice and opens the pop-up again.
  const chip = page.getByRole('button', { name: 'Update 9.9.9 installs at 02:30' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Next time the shop opens' }).click();
  expect(state.sent).toEqual([{ when: 'night' }, { when: 'startup' }]);
  await expect(
    page.getByRole('button', { name: 'Update 9.9.9 installs at next start' }),
  ).toBeVisible();
});

test('"Remind me later" waits, and a cashier is never asked', async ({ page }) => {
  await fakeUpdate(page);
  await signIn(page, 'owner');
  const dialog = page.getByRole('dialog', { name: 'Update ready: version 9.9.9' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Remind me later' }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Update 9.9.9 ready' })).toBeVisible();
  await expect(dialog).toBeHidden();

  const cashier = await page.context().browser()!.newPage();
  await fakeUpdate(cashier);
  await signIn(cashier, 'cashier');
  await expect(cashier.getByText('Main menu').first()).toBeVisible();
  await cashier.waitForTimeout(1500);
  await expect(cashier.getByRole('dialog', { name: /Update ready/ })).toHaveCount(0);
  await cashier.close();
});
