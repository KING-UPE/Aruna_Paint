import { z } from 'zod';
import { D } from '../decimal';
import { cleanName, normalizePhone } from '../domain/text';

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim().replace(/,/g, ''));

/** Money is 0 or more with 2 decimals; returned as a canonical string "1250.00". */
export const moneySchema = numeric
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), { message: 'Use 0 or more with up to 2 decimals.' })
  .transform((v) => D(v).toFixed(2));

/** Signed money, for adjustments. */
export const signedMoneySchema = numeric
  .refine((v) => /^-?\d+(\.\d{1,2})?$/.test(v), { message: 'Use a number with up to 2 decimals.' })
  .transform((v) => D(v).toFixed(2));

/** Quantities are more than 0 with up to 3 decimals; returned as "1.500". */
export const qtySchema = numeric
  .refine((v) => /^\d+(\.\d{1,3})?$/.test(v) && D(v).greaterThan(0), {
    message: 'Qty must be more than 0, with up to 3 decimals.',
  })
  .transform((v) => D(v).toFixed(3));

/** 0 or more, e.g. free qty. */
export const qtyOrZeroSchema = numeric
  .refine((v) => /^\d+(\.\d{1,3})?$/.test(v), { message: 'Use 0 or more with up to 3 decimals.' })
  .transform((v) => D(v).toFixed(3));

export const percentSchema = numeric
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v) && D(v).lessThanOrEqualTo(100), {
    message: 'Use 0 to 100.',
  })
  .transform((v) => D(v).toFixed(2));

export const discountInputSchema = z.object({
  type: z.enum(['PERCENT', 'AMOUNT']),
  value: numeric.refine((v) => /^\d+(\.\d{1,2})?$/.test(v), {
    message: 'Use 0 or more with up to 2 decimals.',
  }),
});

export const idSchema = z.uuid({ message: 'Invalid id.' });

/** Calendar date YYYY-MM-DD. */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a date like 2026-10-24.' });

export const nameSchema = z
  .string()
  .transform(cleanName)
  .pipe(
    z.string().min(1, { message: 'Required.' }).max(120, { message: 'At most 120 characters.' }),
  );

export const optionalText = (max = 500) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .optional()
    .default('');

export const codeSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .min(1, { message: 'Required.' })
      .max(30, { message: 'At most 30 characters.' })
      .regex(/^[A-Za-z0-9][A-Za-z0-9\-/_.]*$/, {
        message: 'Use letters, digits and - / _ . only.',
      }),
  );

export const phoneSchema = z.string().transform((v, ctx) => {
  const p = normalizePhone(v);
  if (!p) {
    ctx.addIssue({
      code: 'custom',
      message: 'Phone numbers are 10 digits starting with 0, or +94.',
    });
    return z.NEVER;
  }
  return p;
});

export const passwordSchema = z
  .string()
  .min(8, { message: 'Passwords have at least 8 characters.' })
  .max(200);

export const pinSchema = z.string().regex(/^\d{4,6}$/, { message: 'PINs have 4 to 6 digits.' });

/** Another person's PIN typed on the same screen for a manager override. */
export const approvalSchema = z.object({ pin: pinSchema }).optional();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
