import {
  D,
  DomainError,
  assertMixPrice,
  lineAmounts,
  money,
  priceLine,
  qty as roundQty,
  type DiscountInput,
  type SaleLineInput,
} from '@aruna/shared';
import type { Tx } from '../../db';

/** Everything a sale line stores: the name, prices and cost at the moment of sale. */
export interface PricedLine {
  productId: string;
  subProductId: string;
  code: string;
  name: string;
  printName: string;
  unitName: string;
  isLoose: boolean;
  qty: string;
  unitPrice: string;
  rPrice: string;
  discountPerUnit: string;
  gross: string;
  discount: string;
  amount: string;
  costPrice: string;
  unitCost: string;
  /** Loose line whose price per liter was changed at the counter. */
  priceChanged: boolean;
}

function withField<T>(field: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DomainError)
      throw new DomainError(err.code, err.message, field, err.details);
    throw err;
  }
}

/**
 * Prices every line on the server from the batch's own prices; nothing the screen sends is
 * trusted except which batch, how many and the discount typed. Applies every billing rule:
 * at most the batch's purchase discount, never below cost, never above the R-price, wholesale
 * takes the W-price, loose paint sells at the mix paint price per liter.
 */
/** A converted quotation's price for a line, honoured until its validity date (internal only). */
export interface QuotedPrice {
  unitPrice: string;
  discountPerUnit: string;
}

export async function priceLines(
  tx: Tx,
  lines: SaleLineInput[],
  wholesale: boolean,
  quoted: (QuotedPrice | null)[] = [],
): Promise<PricedLine[]> {
  const batchIds = lines.flatMap((l) => (l.kind === 'BATCH' ? [l.subProductId] : []));
  const looseIds = lines.flatMap((l) => (l.kind === 'LOOSE' ? [l.productId] : []));
  const subs = await tx.subProduct.findMany({
    where: { id: { in: batchIds } },
    include: { product: { include: { unit: true } } },
  });
  const subById = new Map(subs.map((s) => [s.id, s]));
  const looseProducts = await tx.product.findMany({
    where: { id: { in: looseIds } },
    include: { mixProduct: { include: { subProducts: { orderBy: { seq: 'asc' }, take: 1 } } } },
  });
  const looseById = new Map(looseProducts.map((p) => [p.id, p]));

  return lines.map((l, i) => {
    const f = (name: string) => `lines.${i}.${name}`;
    if (l.kind === 'BATCH') {
      const sp = subById.get(l.subProductId);
      if (!sp || (sp.product.type !== 'STANDARD' && sp.product.type !== 'MIX'))
        throw new DomainError('VALIDATION', 'Unknown item.', f('subProductId'));
      if (!sp.product.active || !sp.active)
        throw new DomainError('VALIDATION', `${sp.name} is inactive.`, f('subProductId'));
      const q = D(l.qty);
      if (!sp.product.unit.allowsDecimal && !q.isInteger()) {
        throw new DomainError('VALIDATION', 'Pieces and cans are whole numbers.', f('qty'));
      }
      const pricing = {
        rPrice: sp.rPrice,
        wPrice: sp.wPrice,
        cost: sp.costPrice,
        purchaseDiscount: sp.purchaseDiscount,
        salesDiscount: sp.salesDiscount,
      };
      const q0 = quoted[i];
      const price = withField(f('discount'), () => {
        if (!q0)
          return priceLine(pricing, {
            wholesale,
            discount: (l.discount as DiscountInput | null | undefined) ?? null,
          });
        // A converted quotation keeps its price unless today's is lower; it never sells below cost.
        const current = priceLine(pricing, { wholesale, discount: null });
        const quotedNet = D(q0.unitPrice).minus(D(q0.discountPerUnit));
        if (current.netUnitPrice.lessThanOrEqualTo(quotedNet)) return current;
        if (quotedNet.lessThan(D(sp.costPrice))) {
          throw new DomainError(
            'BELOW_COST',
            `The quoted price for ${sp.name} is now below cost. Quote again.`,
          );
        }
        return {
          unitPrice: money(q0.unitPrice),
          discountPerUnit: money(q0.discountPerUnit),
          netUnitPrice: money(quotedNet),
        };
      });
      const a = lineAmounts(price.unitPrice, price.discountPerUnit, q);
      return {
        productId: sp.productId,
        subProductId: sp.id,
        code: sp.code,
        name: sp.name,
        printName: sp.product.printName || sp.name,
        unitName: sp.product.unit.name,
        isLoose: false,
        qty: roundQty(q).toFixed(3),
        unitPrice: price.unitPrice.toFixed(2),
        rPrice: money(sp.rPrice).toFixed(2),
        discountPerUnit: price.discountPerUnit.toFixed(2),
        gross: a.gross.toFixed(2),
        discount: a.discount.toFixed(2),
        amount: a.amount.toFixed(2),
        costPrice: money(sp.costPrice).toFixed(2),
        unitCost: money(sp.actualPrice).toFixed(2),
        priceChanged: false,
      };
    }
    const p = looseById.get(l.productId);
    if (!p) throw new DomainError('VALIDATION', 'Unknown item.', f('productId'));
    const mix = p.mixProduct?.subProducts[0];
    if (!p.allowLooseSale || !p.mixProduct || !mix)
      throw new DomainError('VALIDATION', `${p.name} is not sold loose.`, f('qty'));
    const base = money(wholesale ? mix.wPrice : mix.salesPrice);
    if (!base.greaterThan(0))
      throw new DomainError(
        'INVALID_STATE',
        `${p.mixProduct.name} has no price per liter yet.`,
        f('qty'),
      );
    const price = l.pricePerLiter ? money(l.pricePerLiter) : base;
    withField(f('pricePerLiter'), () => assertMixPrice(price, mix.actualPrice));
    const liters = roundQty(l.liters);
    const a = lineAmounts(price, 0, liters);
    const name = `${p.mixProduct.name}, loose`;
    return {
      productId: p.id,
      subProductId: mix.id,
      code: mix.code,
      name,
      printName: name,
      unitName: 'L',
      isLoose: true,
      qty: liters.toFixed(3),
      unitPrice: price.toFixed(2),
      rPrice: (price.lessThan(base) ? base : price).toFixed(2),
      discountPerUnit: '0.00',
      gross: a.gross.toFixed(2),
      discount: '0.00',
      amount: a.amount.toFixed(2),
      costPrice: money(mix.costPrice).toFixed(2),
      unitCost: money(mix.actualPrice).toFixed(2),
      priceChanged: !price.equals(base),
    };
  });
}
