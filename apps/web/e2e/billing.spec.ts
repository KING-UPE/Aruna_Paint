import { expect, test, type Page } from '@playwright/test';

async function loginAtCounter(page: Page, username: string) {
  await page.goto('/?counter=C1');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.keyboard.press('Enter');
  // Staff land on the main menu; the billing screen opens from there.
  await page.getByRole('button', { name: /Open Billing Screen/ }).press('Enter');
  await expect(page.getByRole('table', { name: 'Bill lines' })).toBeVisible();
  // Wait until the counter's day is loaded (it starts by itself), so no typed key is lost.
  await expect(page.getByText(/^Today: Rs/)).toBeVisible();
}

test('a cashier rings up the plan mock-up bill without the mouse', async ({ page }) => {
  await loginAtCounter(page, 'cashier');

  // The day starts by itself with the first bill; no opening float is asked for.
  await expect(page.getByRole('dialog')).toBeHidden();

  // Thinner 4L has two batches at different prices: the pop-up opens with the oldest highlighted.
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: 'Item code' })).toBeFocused();
  await page.keyboard.type('10001');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Thinner 4L');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Batches' })).toContainText('different prices');
  await expect(page.getByRole('listbox', { name: 'Batches' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  // The seeded batch carries a 5% sales discount (Rs 130 on Rs 2,600), shown as a percent.
  await expect(page.getByLabel('Discount')).toHaveValue('5%');
  await page.keyboard.press('Enter');

  // Loose emulsion: the 4 L can's code, then 1.5L, sells liters from mix paint at its price
  // per liter. (Its mix paint item also shows in suggestions and sells by its MP code.)
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
  await expect(
    lines.getByRole('textbox', { name: 'Quantity for White Emulsion (Mix Paint), loose' }),
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

  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: 'Item code' })).toBeFocused();
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

test('No discount (Alt+N) bills every line at full price and can be turned off again', async ({
  page,
}) => {
  await loginAtCounter(page, 'cashier');
  const net = page.locator('[aria-live="polite"]', { hasText: /^Rs / });

  // Thinner 4L with its 5% default discount: Rs 2,470.00.
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: 'Item code' })).toBeFocused();
  await page.keyboard.type('10001');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Thinner 4L');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Batches' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(net).toHaveText('Rs 2,470.00');

  // Alt+N: full price, and the next item skips the discount box.
  await page.keyboard.press('Alt+N');
  await expect(page.getByRole('switch', { name: /No discount/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(net).toHaveText('Rs 2,600.00');
  await page.keyboard.type('brush');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Brush 2 inch');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(net).toHaveText('Rs 3,050.00');

  // Off again: the Thinner gets its own discount back.
  await page.keyboard.press('Alt+N');
  await expect(net).toHaveText('Rs 2,920.00');

  // On, then pay: the server charges the same full price.
  await page.keyboard.press('Alt+N');
  await expect(net).toHaveText('Rs 3,050.00');
  await page.keyboard.press('F10');
  await expect(page.getByRole('dialog')).toContainText('Rs 3,050.00');
  await page.keyboard.press('Enter');
  await page.keyboard.press('n');
  await expect(page.getByText(/INV-\d{6} · change Rs 0.00/)).toBeVisible();
});

test('the same item at the same discount joins its line; arrows move between Yes and No', async ({
  page,
}) => {
  await loginAtCounter(page, 'cashier');
  const lines = page.getByRole('table', { name: 'Bill lines' });
  for (const qty of ['2', '3']) {
    await page.keyboard.press('F2');
    await expect(page.getByRole('textbox', { name: 'Item code' })).toBeFocused();
    await page.keyboard.type('brush');
    await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Brush 2 inch');
    await page.keyboard.press('Enter');
    await page.keyboard.type(qty);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
  }
  // One line of 5, not two lines.
  await expect(lines.getByRole('textbox', { name: 'Quantity for Brush 2 inch' })).toHaveCount(1);
  await expect(lines.getByRole('textbox', { name: 'Quantity for Brush 2 inch' })).toHaveValue('5');
  await expect(page.locator('[aria-live="polite"]', { hasText: /^Rs / })).toHaveText('Rs 2,250.00');

  // Pay with exact cash; on "Print receipt?" the arrows move between Yes and No.
  await page.keyboard.press('F10');
  await page.keyboard.press('Enter');
  const yes = page.getByRole('button', { name: 'Yes' });
  const no = page.getByRole('button', { name: 'No', exact: true });
  await expect(yes).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(no).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(yes).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/INV-\d{6} · change Rs 0.00/)).toBeVisible();
});

test('a held bill is deleted with a reason and stays in history under Deleted', async ({
  page,
}) => {
  await loginAtCounter(page, 'cashier');
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: 'Item code' })).toBeFocused();
  await page.keyboard.type('putty');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Wall Putty');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('F7');
  await expect(page.getByText('Bill held.')).toBeVisible();

  await page.keyboard.press('F8');
  const held = page.getByRole('dialog', { name: 'Held bills' });
  const rows = held.getByRole('option');
  await expect(rows).toHaveCount(1);

  // The bin button asks why; Cancel keeps the bill.
  await held.getByRole('button', { name: 'Delete held bill' }).click();
  const ask = page.getByRole('dialog', { name: 'Delete this held bill?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(rows).toHaveCount(1);

  // The Delete key asks too; a reason and Enter delete it.
  await page.keyboard.press('Delete');
  await expect(ask).toBeVisible();
  await page.keyboard.type('Customer left');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Held bill deleted.')).toBeVisible();
  await expect(held.getByText('No held bills.')).toBeVisible();
  await page.keyboard.press('Escape');

  // Bill history keeps it, with who and why.
  await page.keyboard.press('F9');
  const history = page.getByRole('dialog', { name: 'Bill history' });
  await history.getByRole('button', { name: 'Deleted' }).click();
  await expect(history).toContainText('Held bill');
  await expect(history).toContainText('Customer left');
});

test('a quotation is deleted from bill history with D and a reason', async ({ page }) => {
  await loginAtCounter(page, 'cashier');
  await page.keyboard.press('F4');
  await expect(page.getByRole('button', { name: /QUOTATION/ })).toBeVisible();
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: 'Item code' })).toBeFocused();
  // (Earlier tests sold every brush; putty is still in stock.)
  await page.keyboard.type('putty');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Wall Putty');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('F10');
  await page.keyboard.press('n');
  const issued = page.getByText(/^QT-\d+ issued$/);
  await expect(issued).toBeVisible();
  const quoteNo = (await issued.textContent())!.replace(' issued', '');

  await page.keyboard.press('F9');
  const history = page.getByRole('dialog', { name: 'Bill history' });
  await history.getByRole('button', { name: 'Quotation Bills' }).click();
  await expect(history).toContainText(quoteNo);
  await history.getByLabel('Bills', { exact: true }).focus();
  await page.keyboard.press('d');
  const ask = page.getByRole('dialog', { name: `Delete quotation ${quoteNo}?` });
  await expect(ask).toBeVisible();
  await page.keyboard.type('Wrong prices');
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Quotation ${quoteNo} deleted.`)).toBeVisible();

  await history.getByRole('button', { name: 'Deleted' }).click();
  await expect(history).toContainText(quoteNo);
  await expect(history).toContainText('Wrong prices');
});

test('a resting mouse never changes which suggestion Enter takes', async ({ page }) => {
  await loginAtCounter(page, 'cashier');
  const lines = page.getByRole('table', { name: 'Bill lines' });
  await page.keyboard.press('F2');
  await page.keyboard.type('10003');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('10003');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(lines).toContainText('Gloss Enamel Black 1L');
  // Remove it with the mouse; the pointer now rests where the suggestion list will open.
  await lines.getByRole('button', { name: /Remove Gloss Enamel/ }).click();
  await expect(lines).not.toContainText('Gloss Enamel');
  await page.keyboard.press('F2');
  await page.keyboard.type('10004');
  await expect(
    page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option').first(),
  ).toContainText('10004');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(lines).toContainText('Wall Putty 5kg');
  await expect(lines).not.toContainText('Gloss Enamel');
});
