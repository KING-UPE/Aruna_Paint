import type { Shop } from './helpers';
import { valueId } from './helpers';

export interface Catalog {
  supplierA: string;
  supplierB: string;
  thinner: string; // 10001 Thinner 4L (can)
  emulsion: string; // 10002 White Emulsion 4L (can, sold loose → MP-10002)
  mixEmulsion: string; // MP-10002
  brush: string; // 10003 Brush 2 inch (piece)
  sandpaper: string; // 10004 Sandpaper, bought in boxes of 12
}

const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
export const TODAY = today;

/** Suppliers and products the tests share, entered by the Stock Manager. */
export async function createCatalog(shop: Shop): Promise<Catalog> {
  const s = shop.stock;
  const can = await valueId(s, 'units', 'can');
  const piece = await valueId(s, 'units', 'piece');
  const box = await valueId(s, 'units', 'box');
  const thinnerCat = await valueId(s, 'categories', 'Thinner');
  const emulsionCat = await valueId(s, 'categories', 'Emulsion');
  const brand = (await s.post('/api/values/brands', { name: 'Dulux' })).body.id;

  const supplier = async (name: string, phone: string) => {
    const r = await s.post('/api/suppliers', { name, phones: [phone], creditDays: 30 });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body.id as string;
  };
  const product = async (body: Record<string, unknown>) => {
    const r = await s.post('/api/products', body);
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body;
  };
  const supplierA = await supplier('Supplier A', '0771234567');
  const supplierB = await supplier('Supplier B', '+94 77 765 4321');
  const thinner = await product({
    name: 'Thinner 4L',
    unitId: can,
    categoryId: thinnerCat,
    brandId: brand,
    reorderLevel: '5',
    reorderQty: '10',
  });
  const emulsion = await product({
    name: 'White Emulsion 4L',
    unitId: can,
    categoryId: emulsionCat,
    brandId: brand,
    packSize: '4',
    allowLooseSale: true,
  });
  const brush = await product({ name: 'Brush 2 inch', unitId: piece });
  const sandpaper = await product({
    name: 'Sandpaper P120',
    unitId: piece,
    buyingUnitId: box,
    piecesPerBox: 12,
  });
  return {
    supplierA,
    supplierB,
    thinner: thinner.product.id,
    emulsion: emulsion.product.id,
    mixEmulsion: emulsion.product.mixProduct.id,
    brush: brush.product.id,
    sandpaper: sandpaper.product.id,
  };
}

export interface GrnLine {
  productId: string;
  value: string;
  qty: string;
  free?: string;
  discount?: { type: 'PERCENT' | 'AMOUNT'; value: string };
  salesDiscount?: { type: 'PERCENT' | 'AMOUNT'; value: string };
  rPrice?: string;
  wPrice?: string;
  salesPrice?: string;
  expiryDate?: string;
}

/** Creates and posts a GRN whose supplier invoice total matches the net total. */
export async function postGrn(
  shop: Shop,
  supplierId: string,
  lines: GrnLine[],
  extra: Record<string, unknown> = {},
  post: Record<string, unknown> = {},
) {
  const { computePurchaseLine, computePurchaseTotals } = await import('@aruna/shared');
  const amounts = lines.map((l) => computePurchaseLine(l).amount);
  const totals = computePurchaseTotals({
    lineAmounts: amounts,
    invoiceDiscount: (extra.invoiceDiscount as string) ?? '0',
    otherCharges: (extra.otherCharges as string) ?? '0',
  });
  const r = await shop.stock.post('/api/purchases', {
    supplierId,
    supplierInvoiceNo: `INV-${Math.random().toString(36).slice(2, 8)}`,
    date: TODAY(),
    supplierInvoiceTotal: totals.netTotal.toFixed(2),
    lines,
    ...extra,
    post: { ...post },
  });
  if (r.status !== 200) throw new Error(`GRN failed: ${JSON.stringify(r.body)}`);
  return r.body as { id: string; no: string; warnings: string[]; subProductIds: string[] };
}

export async function subProducts(shop: Shop, productId: string) {
  const r = await shop.sa.get(`/api/products/${productId}`);
  return r.body.subProducts as {
    id: string;
    code: string;
    name: string;
    totalStock: string;
    rPrice: string;
    salesPrice: string;
    actualPrice: string;
    costPrice: string;
    hidden: boolean;
  }[];
}
