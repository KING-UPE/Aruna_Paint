import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, username: string) {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Username')).toBeHidden();
}

test('pickers suggest, drop unpicked text and add a missing supplier or rep in a pop-up', async ({
  page,
}) => {
  await login(page, 'owner');
  await page.goto('/stock/purchases/new');
  const supplier = page.getByRole('combobox', { name: 'Supplier' });
  await expect(supplier).toBeFocused();

  // Typing suggests; leaving without picking clears the box.
  await page.keyboard.type('lanka');
  await expect(page.getByRole('listbox')).toContainText('Lanka Paints Distributors');
  await page.keyboard.press('Tab');
  await expect(supplier).toHaveValue('');

  // A name that isn't there offers "+ Add supplier" and opens the form with that name.
  await supplier.focus();
  await page.keyboard.type('Aruna Paint Center');
  await expect(
    page.getByRole('option', { name: 'Add supplier “Aruna Paint Center”' }),
  ).toBeVisible();
  await page.keyboard.press('Enter');
  const form = page.getByRole('dialog', { name: 'New supplier' });
  await expect(form.getByRole('textbox').nth(1)).toHaveValue('Aruna Paint Center');
  await form.getByPlaceholder('0771234567').fill('0771234567');
  await page.keyboard.press('Enter');
  await expect(form).toBeHidden();
  await expect(supplier).toHaveValue('Aruna Paint Center');

  // The new supplier has no reps yet: add one right here.
  const rep = page.getByRole('combobox', { name: 'Sales rep' });
  await rep.focus();
  await page.keyboard.type('Nimal');
  await page.keyboard.press('Enter');
  const ask = page.getByRole('dialog', { name: /Add a sales rep/ });
  await expect(ask.getByRole('textbox')).toHaveValue('Nimal');
  await page.keyboard.press('Enter');
  await expect(ask).toBeHidden();
  await expect(rep).toHaveValue('Nimal');
});

test('a missing category is added from the product form without leaving it', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/stock/purchases/new');
  await page.getByRole('button', { name: 'New item' }).first().click();
  const form = page.getByRole('dialog', { name: /New product|New item/ });
  await expect(form).toBeVisible();

  const category = form.getByRole('combobox', { name: 'Category' });
  await category.focus();
  await page.keyboard.type('Thin');
  await expect(page.getByRole('option', { name: 'Thinner' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(category).toHaveValue('Thinner');

  await category.focus();
  await page.keyboard.type('Varnish');
  await page.keyboard.press('Enter');
  const add = page.getByRole('dialog', { name: 'Add category' });
  await expect(add.getByRole('textbox')).toHaveValue('Varnish');
  await page.keyboard.press('Enter');
  await expect(add).toBeHidden();
  // The product form is still open (its own Save didn't run) with the new category picked.
  await expect(form).toBeVisible();
  await expect(category).toHaveValue('Varnish');
});
