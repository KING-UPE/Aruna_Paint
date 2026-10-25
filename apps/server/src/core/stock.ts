import { D, DomainError, formatQty, type DecimalLike } from '@aruna/shared';
import type { MovementType } from '@prisma/client';
import type { Tx } from '../db';
import { uuidv7 } from '../lib/ids';

export interface StockMove {
  subProductId: string;
  locationId: string;
  /** Positive in, negative out. */
  qty: DecimalLike;
  type: MovementType;
  unitCost: DecimalLike;
  docId: string;
  docNo: string;
  lineId?: string | null;
  userId: string;
  note?: string;
  /** For a clearer message when stock runs short. */
  label?: string;
}

/**
 * The only way stock changes. Updates the cached balance and writes the ledger row in the
 * caller's transaction. An out-move is a conditional UPDATE, which takes the row lock and
 * re-checks the balance after waiting, so two counters can't sell the last can twice.
 */
export async function moveStock(tx: Tx, m: StockMove): Promise<string> {
  const q = D(m.qty);
  if (q.isZero()) throw new Error('Stock move with zero qty');
  const qtyText = q.toFixed(3);
  let balanceAfter: string;

  if (q.greaterThan(0)) {
    const rows = await tx.$queryRaw<{ qty: string }[]>`
      INSERT INTO stock_balances (sub_product_id, location_id, qty, updated_at)
      VALUES (${m.subProductId}::uuid, ${m.locationId}::uuid, ${qtyText}::numeric, now())
      ON CONFLICT (sub_product_id, location_id)
      DO UPDATE SET qty = stock_balances.qty + EXCLUDED.qty, updated_at = now()
      RETURNING qty::text AS qty`;
    balanceAfter = rows[0]!.qty;
  } else {
    const rows = await tx.$queryRaw<{ qty: string }[]>`
      UPDATE stock_balances
         SET qty = qty + ${qtyText}::numeric, updated_at = now()
       WHERE sub_product_id = ${m.subProductId}::uuid
         AND location_id = ${m.locationId}::uuid
         AND qty + ${qtyText}::numeric >= 0
      RETURNING qty::text AS qty`;
    if (rows.length === 0) {
      const have = await availableQty(tx, m.subProductId, m.locationId);
      throw new DomainError(
        'INSUFFICIENT_STOCK',
        `${m.label ? `${m.label}: o` : 'O'}nly ${formatQty(have)} in stock here.`,
        undefined,
        { subProductId: m.subProductId, available: have },
      );
    }
    balanceAfter = rows[0]!.qty;
  }

  await tx.$executeRaw`
    INSERT INTO stock_movements
      (id, at, sub_product_id, location_id, type, qty, unit_cost, balance_after, doc_id, doc_no, line_id, user_id, note)
    VALUES
      (${uuidv7()}::uuid, now(), ${m.subProductId}::uuid, ${m.locationId}::uuid, ${m.type}::"MovementType",
       ${qtyText}::numeric, ${D(m.unitCost).toFixed(2)}::numeric, ${balanceAfter}::numeric,
       ${m.docId}::uuid, ${m.docNo}, ${m.lineId ?? null}::uuid, ${m.userId}::uuid, ${m.note ?? ''})`;
  return balanceAfter;
}

export async function availableQty(
  tx: Tx,
  subProductId: string,
  locationId: string,
): Promise<string> {
  const row = await tx.stockBalance.findUnique({
    where: { subProductId_locationId: { subProductId, locationId } },
  });
  return row ? row.qty.toFixed(3) : '0.000';
}

/** Stock of a sub-product across every location. */
export async function totalQty(tx: Tx, subProductId: string): Promise<string> {
  const agg = await tx.stockBalance.aggregate({ where: { subProductId }, _sum: { qty: true } });
  return (agg._sum.qty ?? D(0)).toFixed(3);
}
