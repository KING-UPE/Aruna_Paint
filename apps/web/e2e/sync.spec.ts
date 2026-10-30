import { expect, test } from '@playwright/test';

test('the shop shows its cloud link, last sync and online changes on Cloud sync', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Username')).toBeHidden();
  await page.getByRole('link', { name: 'Cloud sync' }).click();
  await expect(page.getByRole('heading', { name: 'Cloud sync', level: 1 })).toBeVisible();
  // The e2e shop isn't linked to a cloud: it says where to set it up, and keeps working.
  await expect(page.getByText('Not linked to a cloud yet.')).toBeVisible();
  await expect(page.getByText(/^Cloud not linked · \d+ changes waiting$/)).toBeVisible();
  await expect(page.getByText('Nothing has been changed online yet.')).toBeVisible();
});
