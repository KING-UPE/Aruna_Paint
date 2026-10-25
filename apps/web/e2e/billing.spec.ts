import { expect, test, type Page } from '@playwright/test';

async function loginAtCounter(page: Page, username: string) {
  await page.goto('/?counter=C1');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
}

test('a cashier rings up the plan mock-up bill without the mouse', async ({ page }) => {
  await loginAtCounter(page, 'cashier');

  // Start of day: the opening float.
  await expect(page.getByRole('dialog', { name: 'Start the day' })).toBeVisible();
  await page.keyboard.type('5000');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeHidden();

  // Thinner 4L has two batches at different prices: the pop-up opens with the oldest highlighted.
  await page.keyboard.press('F2');
  await page.keyboard.type('10001');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Thinner 4L');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Batches' })).toContainText('different prices');
  await expect(page.getByRole('listbox', { name: 'Batches' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Discount')).toHaveValue('150.00');
  await page.keyboard.press('Enter');

  // Loose emulsion: 1.5L sells liters from mix paint at its price per liter.
  await page.keyboard.type('white');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('White Emulsion');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1.5L');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Price per liter')).toHaveValue('650.00');
  await page.keyboard.press('Enter');

  await page.keyboard.type('brush');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Brush 2 inch');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  const lines = page.getByRole('table', { name: 'Bill lines' });
  await expect(lines).toContainText('Thinner 4L');
  await expect(lines).toContainText('White Emulsion, loose');
  await expect(lines).toContainText('1.5 L');
  await expect(page.getByText('Rs 6,325.00')).toBeVisible();

  // F10, cash given, Enter shows the change, Enter prints.
  await page.keyboard.press('F10');
  await page.keyboard.type('7000');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Rs 675.00');
  await page.keyboard.press('Enter');
  await expect(page.getByText('INV-000001 · change Rs 675.00')).toBeVisible();
  await expect(page.getByText('This counter today: Rs 6,325.00 · 1 bills')).toBeVisible();
  await expect(lines).not.toContainText('Thinner');
});

test('hold, recall and bill history keys', async ({ page }) => {
  await loginAtCounter(page, 'cashier');
  await expect(page.getByRole('table', { name: 'Bill lines' })).toBeVisible();

  await page.keyboard.press('F2');
  await page.keyboard.type('brush');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Rs 1,350.00')).toBeVisible();

  // F7 parks the bill; F8 brings it back.
  await page.keyboard.press('F7');
  await expect(page.getByText('Bill held.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Bill lines' })).not.toContainText('Brush');
  await page.keyboard.press('F8');
  await expect(page.getByRole('dialog', { name: 'Held bills' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('table', { name: 'Bill lines' })).toContainText('Brush 2 inch');

  // Pay with exact cash and no receipt.
  await page.keyboard.press('F10');
  await page.keyboard.press('Enter');
  await page.keyboard.press('n');
  const toast = page.getByText(/INV-\d{6} · change Rs 0.00/);
  await expect(toast).toBeVisible();
  const invoiceNo = (await toast.textContent())!.slice(0, 10);

  // F9 bill history: the newest bill is selected; P reprints it.
  await page.keyboard.press('F9');
  const history = page.getByRole('dialog', { name: 'Bill history' });
  await expect(history.getByRole('heading', { level: 2 })).toHaveText('Bill history');
  await expect(history).toContainText(`Invoice ${invoiceNo}`);
  await page.keyboard.press('Enter');
  await expect(history.getByLabel('Bills', { exact: true })).toBeFocused();
  await page.keyboard.press('p');
  await expect(
    page.getByText(`Reprint #2 of ${invoiceNo}`).or(page.getByText(`Reprint #2 logged`)),
  ).toBeVisible();
});
