import { expect, test, type Page } from '@playwright/test';

async function loginAtCounter(page: Page, username: string) {
  await page.goto('/?counter=C1');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
}

/** Cashiers land on the Main menu after login; its banner button opens the billing screen. */
async function openBilling(page: Page) {
  await page.getByRole('button', { name: 'Open Billing Screen →' }).press('Enter');
  await expect(page.getByRole('table', { name: 'Bill lines' })).toBeVisible();
}

test('a cashier rings up the plan mock-up bill (seed prices) without the mouse', async ({
  page,
}) => {
  await loginAtCounter(page, 'cashier');
  // The first bill opens the day on this counter by itself (no opening float prompt any more).
  await openBilling(page);

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
  // Discounts are entered in percent; the seed's default sales discount is 5% (Rs 130 a can).
  await expect(page.getByLabel('Discount')).toHaveValue('5%');
  await page.keyboard.press('Enter');

  // Loose emulsion: 1.5L sells liters from mix paint at its price per liter.
  // Typing the can's code (not "white", which now also lists the mix paint item on its own).
  await page.keyboard.type('10002');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText(
    'White Emulsion 4L',
  );
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
  await expect(lines).toContainText('White Emulsion (Mix Paint), loose');
  // Quantities are editable in the bill lines; the loose line holds 1.5 (liters).
  await expect(
    lines.getByLabel('Quantity for White Emulsion (Mix Paint), loose', { exact: true }),
  ).toHaveValue('1.5');
  await expect(page.getByText('Rs 6,365.00')).toBeVisible();

  // F10, cash given, Enter shows the change, Enter prints.
  await page.keyboard.press('F10');
  await page.keyboard.type('7000');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Rs 635.00');
  await page.keyboard.press('Enter');
  await expect(page.getByText('INV-000001 · change Rs 635.00')).toBeVisible();
  await expect(page.getByText('Today: Rs 6,365.00 · 1 bills')).toBeVisible();
  await expect(lines).not.toContainText('Thinner');
});

test('hold, recall and bill history keys', async ({ page }) => {
  await loginAtCounter(page, 'cashier');
  await openBilling(page);

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
