import { z } from 'zod';
import {
  approvalSchema,
  dateSchema,
  discountInputSchema,
  idSchema,
  moneySchema,
  optionalText,
  paginationSchema,
  phoneSchema,
  qtySchema,
} from './common';

/** A line sold from one batch (sub-product). The screen splits a qty across batches first-in, first-out. */
export const batchLineSchema = z.object({
  kind: z.literal('BATCH'),
  subProductId: idSchema,
  qty: qtySchema,
  /** Null keeps the batch's default sales discount. */
  discount: discountInputSchema.nullable().optional(),
});

/** Loose paint in liters from the product's mix paint stock. */
export const looseLineSchema = z.object({
  kind: z.literal('LOOSE'),
  productId: idSchema,
  liters: qtySchema,
  /** A changed price per liter needs an Admin PIN. */
  pricePerLiter: moneySchema.nullable().optional(),
});

export const saleLineSchema = z.discriminatedUnion('kind', [batchLineSchema, looseLineSchema]);
export type SaleLineInput = z.input<typeof saleLineSchema>;

export const saleInputSchema = z.object({
  kind: z.enum(['INVOICE', 'QUOTATION']).default('INVOICE'),
  wholesale: z.boolean().default(false),
  customerName: optionalText(80),
  customerPhone: z.union([phoneSchema, z.literal('')]).default(''),
  lines: z.array(saleLineSchema).min(1, { message: 'Add at least one item.' }).max(300),
  /** Cash only; empty means exact cash. */
  cashGiven: moneySchema.nullable().optional(),
  /** "Print receipt?" — Yes is the default. The drawer opens either way. */
  print: z.boolean().default(true),
  /** Completing a recalled held bill removes it from the held list. */
  heldSaleId: idSchema.optional(),
  approval: approvalSchema,
});
export type SaleInput = z.input<typeof saleInputSchema>;

export const holdInputSchema = z.object({
  kind: z.enum(['INVOICE', 'QUOTATION']).default('INVOICE'),
  wholesale: z.boolean().default(false),
  customerName: optionalText(80),
  customerPhone: z.union([phoneSchema, z.literal('')]).default(''),
  lines: z.array(saleLineSchema).min(1).max(300),
  /** Re-holding a recalled bill replaces it. */
  heldSaleId: idSchema.optional(),
});

export const convertQuotationSchema = z.object({
  cashGiven: moneySchema.nullable().optional(),
  print: z.boolean().default(true),
});

export const voidSaleSchema = z.object({
  reasonId: idSchema,
  note: optionalText(300),
  approval: approvalSchema,
});

export const saleReturnSchema = z
  .object({
    /** Null for an old-system bill (Admin only). */
    saleId: idSchema.nullable().optional(),
    oldBillRef: optionalText(60),
    lines: z
      .array(
        z.object({
          saleLineId: idSchema.optional(),
          /** Old-system returns name the item and the refund. */
          subProductId: idSchema.optional(),
          refund: moneySchema.optional(),
          qty: qtySchema,
          reasonId: idSchema,
          disposition: z.enum(['RESTOCK', 'DAMAGED']),
        }),
      )
      .min(1, { message: 'Select at least one line.' }),
    note: optionalText(300),
    print: z.boolean().default(true),
    approval: approvalSchema,
  })
  .refine((v) => v.saleId || v.oldBillRef, {
    message: 'Find the invoice, or enter the old bill number.',
    path: ['saleId'],
  });
export type SaleReturnInput = z.input<typeof saleReturnSchema>;

/**
 * Lines taken off a bill (or quantities lowered) before it is paid or held. The bill only lives
 * on the screen until then, so the screen reports them and they go into the audit log.
 */
export const removedLinesSchema = z.object({
  why: z.enum(['removed', 'qty_lowered']),
  lines: z
    .array(
      z.object({
        code: z.string().max(40),
        name: z.string().max(200),
        qty: z.string().max(20),
        amount: z.string().max(20),
      }),
    )
    .min(1)
    .max(100),
});

/** Taking away a held bill or a quotation: it is kept as DELETED, with why. */
export const deleteBillSchema = z.object({
  reason: z
    .string()
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(3, { message: 'Say why, in a few words.' })
        .max(200, { message: 'At most 200 characters.' }),
    ),
});

export const billHistoryQuerySchema = paginationSchema.extend({
  q: z.string().optional(),
  kind: z.enum(['INVOICE', 'QUOTATION']).optional(),
  status: z.enum(['HELD', 'COMPLETED', 'VOID', 'DELETED']).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  cashierId: idSchema.optional(),
  counterId: idSchema.optional(),
  customer: z.string().optional(),
  amount: moneySchema.optional(),
});

// ---------------------------------------------------------------------------
// Day end
// ---------------------------------------------------------------------------

export const openShiftSchema = z.object({
  openingFloat: z
    .string()
    .trim()
    .refine((v) => v === '' || /^-?\d+(\.\d{1,2})?$/.test(v), { message: 'Enter a valid amount.' })
    .default('0.00')
    .transform((v) => (v === '' ? '0.00' : v))
    .optional(),
});

export const cashMovementSchema = z.object({
  kind: z.enum(['IN', 'OUT']),
  amount: moneySchema.refine((v) => Number(v) > 0, { message: 'Amount must be more than 0.' }),
  reasonId: idSchema,
  note: optionalText(200),
});

/** Notes and coins in Sri Lanka. */
export const DENOMINATIONS = [
  '5000',
  '2000',
  '1000',
  '500',
  '100',
  '50',
  '20',
  '10',
  '5',
  '2',
  '1',
] as const;

export const closeShiftSchema = z.object({
  /** Count of each note and coin, e.g. { "5000": 3, "1000": 12 }. */
  denominations: z
    .partialRecord(z.enum(DENOMINATIONS), z.number().int().min(0).max(100000))
    .default({}),
  note: optionalText(300),
});
