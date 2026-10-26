import { z } from 'zod';
import {
  codeSchema,
  dateSchema,
  discountInputSchema,
  idSchema,
  moneySchema,
  nameSchema,
  optionalText,
  phoneSchema,
  qtyOrZeroSchema,
  qtySchema,
  signedMoneySchema,
  approvalSchema,
} from './common';

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export const supplierRepSchema = z.object({
  id: idSchema.optional(),
  name: nameSchema,
  phone: z.union([phoneSchema, z.literal('')]).default(''),
  active: z.boolean().default(true),
});

export const supplierInputSchema = z.object({
  /** Blank gets the next SUP- number; old codes are kept on import. */
  code: codeSchema.optional().nullable(),
  name: nameSchema,
  phones: z
    .array(phoneSchema)
    .min(1, { message: 'Add at least one phone number.' })
    .max(3, { message: 'At most 3 phone numbers.' }),
  address: optionalText(300),
  description: optionalText(500),
  email: z.union([z.email({ message: 'Check the email address.' }), z.literal('')]).default(''),
  creditDays: z.number().int().min(0).max(365).default(0),
  /** Positive means the shop owes the supplier. */
  openingBalance: signedMoneySchema.default('0.00'),
  active: z.boolean().default(true),
  reps: z.array(supplierRepSchema).default([]),
  /** Set after the "A supplier with this name already exists" warning. */
  confirmSimilarName: z.boolean().optional(),
});
export type SupplierInput = z.input<typeof supplierInputSchema>;

export const supplierPaymentSchema = z
  .object({
    supplierId: idSchema,
    date: dateSchema,
    method: z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER']),
    amount: moneySchema.refine((v) => Number(v) > 0, { message: 'Amount must be more than 0.' }),
    reference: optionalText(100),
    note: optionalText(300),
    cheque: z
      .object({
        number: z.string().min(1).max(30),
        bank: z.string().min(1).max(60),
        chequeDate: dateSchema,
      })
      .optional(),
    /** Set after the "more than the balance" warning; the extra is kept as an advance. */
    confirmAdvance: z.boolean().optional(),
  })
  .refine((v) => v.method !== 'CHEQUE' || v.cheque, {
    message: 'Enter the cheque number, bank and date.',
    path: ['cheque'],
  });
export type SupplierPaymentInput = z.input<typeof supplierPaymentSchema>;

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const productInputSchema = z.object({
  /** Blank gets the next 5-digit code. */
  code: codeSchema.optional().nullable(),
  name: nameSchema,
  /** Short name for the receipt. */
  printName: z
    .string()
    .max(40)
    .transform((v) => v.trim())
    .default(''),
  description: optionalText(500),
  categoryId: idSchema.nullable().optional(),
  brandId: idSchema.nullable().optional(),
  unitId: idSchema,
  /** Liters per can (4 L), for liter conversion. */
  packSize: qtySchema.nullable().optional(),
  buyingUnitId: idSchema.nullable().optional(),
  piecesPerBox: z.number().int().min(1).max(10000).default(1),
  reorderLevel: qtyOrZeroSchema.default('0.000'),
  reorderQty: qtyOrZeroSchema.default('0.000'),
  allowLooseSale: z.boolean().default(false),
  /** Link this size to an existing mix paint item instead of making a new one. */
  mixProductId: idSchema.nullable().optional(),
  trackExpiry: z.boolean().default(false),
  active: z.boolean().default(true),
  /** Changing a main code renames its sub-product and mix paint codes after a confirmation. */
  confirmCodeChange: z.boolean().optional(),
});
export type ProductInput = z.input<typeof productInputSchema>;

export const priceChangeSchema = z.object({
  /** Empty means every sub-product of the main product. */
  subProductIds: z.array(idSchema).default([]),
  rPrice: moneySchema.optional(),
  wPrice: moneySchema.optional(),
  salesDiscount: discountInputSchema.optional(),
  salesPrice: moneySchema.optional(),
  note: optionalText(200),
});
export type PriceChangeInput = z.input<typeof priceChangeSchema>;

export const subProductEditSchema = z.object({
  name: nameSchema.optional(),
  description: optionalText(500).optional(),
});

// ---------------------------------------------------------------------------
// Purchases (GRN)
// ---------------------------------------------------------------------------

export const purchaseLineInputSchema = z.object({
  productId: idSchema,
  /** Market price per buying unit (per box for boxed items). */
  value: moneySchema,
  qty: qtySchema,
  free: qtyOrZeroSchema.default('0.000'),
  discount: discountInputSchema.default({ type: 'AMOUNT', value: '0' }),
  rPrice: moneySchema.optional().nullable(),
  wPrice: moneySchema.optional().nullable(),
  salesDiscount: discountInputSchema.default({ type: 'AMOUNT', value: '0' }),
  salesPrice: moneySchema.optional().nullable(),
  expiryDate: dateSchema.optional().nullable(),
});
export type PurchaseLineInputBody = z.input<typeof purchaseLineInputSchema>;

export const purchaseInputSchema = z.object({
  supplierId: idSchema,
  supplierInvoiceNo: z
    .string()
    .max(40)
    .transform((v) => v.trim())
    .default(''),
  date: dateSchema,
  /** A free-text note. */
  ref: optionalText(200),
  locationId: idSchema.optional().nullable(),
  salesRepId: idSchema.optional().nullable(),
  invoiceDiscount: moneySchema.default('0.00'),
  otherCharges: moneySchema.default('0.00'),
  supplierInvoiceTotal: moneySchema.default('0.00'),
  lines: z.array(purchaseLineInputSchema).min(1, { message: 'Add at least one line.' }).max(500),
});
export type PurchaseInput = z.input<typeof purchaseInputSchema>;

export const purchasePostSchema = z.object({
  /** Paid now (any amount); the rest goes to the supplier balance. */
  paidNow: moneySchema.default('0.00'),
  paymentMethod: z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER']).default('CASH'),
  cheque: z
    .object({ number: z.string().min(1), bank: z.string().min(1), chequeDate: dateSchema })
    .optional(),
  /** Set after "the same supplier with the same invoice no" warning. */
  confirmDuplicateInvoice: z.boolean().optional(),
});
export type PurchasePostInput = z.input<typeof purchasePostSchema>;

export const purchaseReverseSchema = z.object({
  reason: z.string().min(3).max(300),
  approval: approvalSchema,
});

// ---------------------------------------------------------------------------
// Stock work
// ---------------------------------------------------------------------------

export const mixTransferSchema = z.object({
  sourceSubProductId: idSchema.optional().nullable(),
  sourceProductId: idSchema.optional().nullable(),
  cans: z.number().int().min(1, { message: 'Move whole cans only.' }).max(1000),
  /** Keep the price per liter or change it */
  pricePerLiter: moneySchema.optional().nullable(),
  /** The total can price set by admin; price per 1L = adminCanPrice / packSize */
  adminCanPrice: moneySchema.optional().nullable(),
  locationId: idSchema.optional().nullable(),
  /** A Stock Manager or Admin PIN when a cashier opens a can at the counter. */
  approval: approvalSchema,
});
export type MixTransferInput = z.input<typeof mixTransferSchema>;

export const transferSchema = z.object({
  fromLocationId: idSchema,
  toLocationId: idSchema,
  note: optionalText(300),
  lines: z.array(z.object({ subProductId: idSchema, qty: qtySchema })).min(1),
});

export const adjustmentSchema = z.object({
  locationId: idSchema.optional().nullable(),
  note: optionalText(300),
  lines: z
    .array(
      z.object({
        subProductId: idSchema,
        /** Positive adds, negative removes. */
        qty: z
          .union([z.string(), z.number()])
          .transform((v) => String(v).trim())
          .refine((v) => /^-?\d+(\.\d{1,3})?$/.test(v) && Number(v) !== 0, {
            message: 'Use a quantity other than 0.',
          }),
        reasonId: idSchema,
      }),
    )
    .min(1),
  /** Write-offs need Admin approval. */
  approval: approvalSchema,
});
