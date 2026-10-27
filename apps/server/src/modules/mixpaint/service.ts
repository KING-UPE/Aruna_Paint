import {
  D,
  DomainError,
  assertMixPrice,
  cansToLiters,
  costPerLiter,
  mixTransferSchema,
  money,
  weightedAverageCost,
} from '@aruna/shared';
import { z } from 'zod';
import type { Tx } from '../../db';
import { audit } from '../../core/audit';
import type { ActorRef } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { availableQty, moveStock, totalQty } from '../../core/stock';
import { ensureMixProduct } from '../products/service';

type Actor = ActorRef & { userId: string };

/** The single sub-product (MP-20001) that holds a mix paint item's liters. */
export async function mixSubProduct(tx: Tx, mixProductId: string) {
  const sp = await tx.subProduct.findFirst({
    where: { productId: mixProductId },
    orderBy: { seq: 'asc' },
  });
  if (!sp) throw new DomainError('INVALID_STATE', 'This mix paint item has no MP code.');
  return sp;
}

export interface MixTransferResult {
  id: string;
  no: string;
  mixSubProductId: string;
  sourceSubProductId: string;
  liters: string;
  newAverageCost: string;
  pricePerLiter: string;
  litersHere: string;
}

/**
 * Turns whole cans into liters of mix paint: the can's liters go into MP-<main code> (or the item
 * its size is linked to) at a new weighted-average cost. The price per liter can be kept or
 * changed, never below the new average cost.
 */
export async function transferToMix(
  tx: Tx,
  actor: Actor,
  input: z.output<typeof mixTransferSchema> & { locationId: string },
  opts: { approverId: string; fromCounter: boolean },
): Promise<MixTransferResult> {
  let source = input.sourceSubProductId
    ? await tx.subProduct.findUnique({
        where: { id: input.sourceSubProductId },
        include: { product: true },
      })
    : null;

  if (!source && input.sourceProductId) {
    source = await tx.subProduct.findFirst({
      where: { productId: input.sourceProductId, active: true },
      include: { product: true },
      orderBy: { seq: 'asc' },
    });
  }

  if (!source) throw new DomainError('NOT_FOUND', 'Can / paint product not found.');
  const product = source.product;
  if (!product.packSize || Number(product.packSize) <= 0)
    throw new DomainError(
      'INVALID_STATE',
      `${product.name} has no pack size in liters (needed for can-to-units conversion).`,
    );

  const mixProduct = await ensureMixProduct(tx, product);
  const mix = await mixSubProduct(tx, mixProduct.id);

  const liters = cansToLiters(input.cans, product.packSize);
  const perLiter = costPerLiter(source.actualPrice, product.packSize);

  const oldLiters = D(await totalQty(tx, mix.id));
  const oldAvg = D(mix.actualPrice);
  const newAvg = weightedAverageCost({
    oldLiters,
    oldCost: oldAvg,
    addLiters: liters,
    addCost: perLiter,
  });
  const oldPrice = D(mix.salesPrice);
  let price: typeof oldPrice;
  if (input.adminCanPrice) {
    price = money(D(input.adminCanPrice).dividedBy(product.packSize));
  } else if (input.pricePerLiter) {
    price = money(input.pricePerLiter);
  } else if (oldPrice.greaterThan(0)) {
    price = oldPrice;
  } else {
    price = money(D(source.salesPrice).dividedBy(product.packSize));
  }
  // "The price per liter can be kept or changed, never below the new average cost."
  assertMixPrice(price, newAvg);

  // Update MP selling price so POS sells at this price per liter
  await tx.subProduct.update({
    where: { id: mix.id },
    data: {
      salesPrice: price.toFixed(2),
      wPrice: price.toFixed(2),
      rPrice: price.toFixed(2),
      costPrice: perLiter.toFixed(2),
      actualPrice: newAvg.toFixed(2),
    },
  });

  const no = await nextNumber(tx, 'MP_TRANSFER');
  const transfer = await tx.mpTransfer.create({
    data: {
      no,
      locationId: input.locationId,
      sourceSubProductId: source.id,
      mixSubProductId: mix.id,
      cans: input.cans,
      litersPerCan: product.packSize,
      liters: liters.toFixed(3),
      canActualPrice: source.actualPrice,
      costPerLiter: perLiter.toFixed(2),
      oldLiters: oldLiters.toFixed(3),
      oldAverageCost: oldAvg.toFixed(2),
      newAverageCost: newAvg.toFixed(2),
      oldPricePerLiter: oldPrice.toFixed(2),
      newPricePerLiter: price.toFixed(2),
      fromCounter: opts.fromCounter,
      createdById: actor.userId,
      approvedById: opts.approverId === actor.userId ? null : opts.approverId,
    },
  });
  await moveStock(tx, {
    subProductId: source.id,
    locationId: input.locationId,
    qty: D(input.cans).negated(),
    type: 'MP_OUT',
    unitCost: source.actualPrice,
    docId: transfer.id,
    docNo: no,
    userId: actor.userId,
    label: source.code,
  });
  await moveStock(tx, {
    subProductId: mix.id,
    locationId: input.locationId,
    qty: liters,
    type: 'MP_IN',
    unitCost: perLiter,
    docId: transfer.id,
    docNo: no,
    userId: actor.userId,
  });
  // Mix paint sells at one price per liter with no discount; cost floor is the average cost.
  await tx.subProduct.update({
    where: { id: mix.id },
    data: {
      actualPrice: newAvg.toFixed(2),
      costPrice: newAvg.toFixed(2),
      marketValue: price.toFixed(2),
      purchaseDiscount: '0',
      salesDiscount: '0',
      rPrice: price.toFixed(2),
      wPrice: price.toFixed(2),
      salesPrice: price.toFixed(2),
      active: true,
      firstReceivedAt: mix.firstReceivedAt ?? new Date(),
    },
  });
  if (!price.equals(oldPrice)) {
    await tx.priceHistory.create({
      data: {
        subProductId: mix.id,
        changedById: opts.approverId,
        source: 'MIX_TRANSFER',
        oldRPrice: mix.rPrice,
        newRPrice: price.toFixed(2),
        oldWPrice: mix.wPrice,
        newWPrice: price.toFixed(2),
        oldSalesDiscount: mix.salesDiscount,
        newSalesDiscount: '0',
        oldSalesPrice: mix.salesPrice,
        newSalesPrice: price.toFixed(2),
        note: no,
      },
    });
  }
  await audit(tx, actor, {
    action: 'mix_paint.transfer',
    entity: 'mp_transfer',
    entityId: transfer.id,
    approverId: opts.approverId === actor.userId ? null : opts.approverId,
    after: {
      no,
      source: source.code,
      cans: input.cans,
      liters: liters.toFixed(3),
      mix: mix.code,
      price: price.toFixed(2),
    },
  });
  return {
    id: transfer.id,
    no,
    mixSubProductId: mix.id,
    sourceSubProductId: source.id,
    liters: liters.toFixed(3),
    newAverageCost: newAvg.toFixed(2),
    pricePerLiter: price.toFixed(2),
    litersHere: await availableQty(tx, mix.id, input.locationId),
  };
}

/** The mix paint box: liters, price per liter, and (for cost viewers) the average cost. */
export async function mixStatus(
  tx: Tx,
  mixProductId: string,
  locationId: string,
  canSeeCost: boolean,
) {
  const product = await tx.product.findUnique({ where: { id: mixProductId } });
  if (!product || product.type !== 'MIX')
    throw new DomainError('NOT_FOUND', 'Mix paint item not found.');
  const mix = await mixSubProduct(tx, mixProductId);
  const feeders = await tx.product.findMany({
    where: { mixProductId },
    select: { id: true, code: true, name: true, packSize: true },
  });
  return {
    product: { id: product.id, code: product.code, name: product.name },
    subProductId: mix.id,
    litersHere: await availableQty(tx, mix.id, locationId),
    litersTotal: await totalQty(tx, mix.id),
    pricePerLiter: mix.salesPrice.toFixed(2),
    ...(canSeeCost ? { averageCost: mix.actualPrice.toFixed(2) } : {}),
    feeders: feeders.map((f) => ({
      id: f.id,
      code: f.code,
      name: f.name,
      packSize: f.packSize?.toFixed(3) ?? null,
    })),
  };
}
