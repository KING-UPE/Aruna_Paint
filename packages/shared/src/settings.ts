import { z } from 'zod';

/** Shop-wide settings the Super Admin edits; stored as one JSON row per key group. */
export const shopSettingsSchema = z.object({
  shopName: z.string().min(1).max(120),
  address: z.string().max(300).default(''),
  phone: z.string().max(60).default(''),
  /** Data URL or file name of the logo shown on receipts and reports. */
  logo: z.string().max(400_000).nullable().default(null),
});

export const receiptSettingsSchema = z.object({
  language: z.enum(['en', 'si']).default('en'),
  headerEn: z.string().max(500).default(''),
  footerEn: z.string().max(500).default('Goods once sold can be returned with this receipt.'),
  headerSi: z.string().max(500).default(''),
  footerSi: z.string().max(500).default(''),
  /** Characters per line on the 80 mm printer (Font A is 48, Font B is 64). */
  lineWidth: z.number().int().min(32).max(64).default(48),
});

export const billingSettingsSchema = z.object({
  quotationValidityDays: z.number().int().min(1).max(365).default(7),
  /** Net total rounding step in rupees; "0.01" means no rounding. */
  netTotalRounding: z.enum(['0.01', '1', '5', '10']).default('0.01'),
  /** The plan keeps negative stock off; it is never allowed in this version. */
  allowNegativeStock: z.literal(false).default(false),
  idleLockMinutes: z.number().int().min(1).max(240).default(5),
  timeFormat: z.enum(['12h', '24h']).default('24h'),
});

export const closingSettingsSchema = z.object({
  /** Day of the month a new month starts (the 1st by default, or e.g. the 25th). */
  monthStartDay: z.number().int().min(1).max(28).default(1),
});

export const alertSettingsSchema = z.object({
  nearExpiryDays: z.number().int().min(1).max(365).default(60),
  expiryWarningDays: z.number().int().min(1).max(365).default(90),
  highReturnsPercent: z.number().min(0).max(100).default(5),
  cashDifferenceLimit: z.number().min(0).default(100),
  syncWaitingMinutes: z.number().int().min(1).default(60),
  clockSkewMinutes: z.number().int().min(1).default(2),
});

export const backupSettingsSchema = z.object({
  folder: z.string().max(400).default(''),
  secondFolder: z.string().max(400).default(''),
  /** Nightly backup time, HH:MM in shop time. */
  nightlyAt: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('22:30'),
  keepDaily: z.number().int().min(1).default(30),
  keepMonthly: z.number().int().min(1).default(12),
});

export const cloudSettingsSchema = z.object({
  url: z.string().max(400).default(''),
  shopKey: z.string().max(200).default(''),
});

export const hrmSalarySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  role: z.string().default(''),
  amount: z.number().min(0),
});
export type HrmSalary = z.infer<typeof hrmSalarySchema>;

export const hrmMemberSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  userId: z.string().nullable().optional(),
  role: z.string().default(''),
  ratePercent: z.number().min(0).max(100),
});
export type HrmMember = z.infer<typeof hrmMemberSchema>;

export const hrmMonthConfigSchema = z.object({
  maxCommissionPercent: z.number().min(0).max(100).default(10),
  shopRent: z.number().min(0).default(45000),
  electricityBill: z.number().min(0).default(18500),
  salaries: z.array(hrmSalarySchema).default([
    { id: 'sal-1', name: 'Kasun Bandara', role: 'Cashier', amount: 35000 },
    { id: 'sal-2', name: 'Saman Kumara', role: 'Stock Keeper', amount: 40000 },
  ]),
  members: z.array(hrmMemberSchema).default([
    { id: 'mem-1', name: 'Aruna', userId: null, role: 'Partner / Store', ratePercent: 3 },
    { id: 'mem-2', name: 'Owner', userId: null, role: 'Super Admin', ratePercent: 3 },
    { id: 'mem-3', name: 'Savings', userId: null, role: 'Reserve Fund', ratePercent: 4 },
  ]),
});
export type HrmMonthConfig = z.infer<typeof hrmMonthConfigSchema>;

export const hrmSettingsSchema = hrmMonthConfigSchema.extend({
  monthlyOverrides: z.record(z.string(), hrmMonthConfigSchema.partial()).default({}),
});
export type HrmSettings = z.infer<typeof hrmSettingsSchema>;

export const SETTINGS_SCHEMAS = {
  shop: shopSettingsSchema,
  receipt: receiptSettingsSchema,
  billing: billingSettingsSchema,
  closing: closingSettingsSchema,
  alerts: alertSettingsSchema,
  backup: backupSettingsSchema,
  cloud: cloudSettingsSchema,
  hrm: hrmSettingsSchema,
} as const;

export type SettingsKey = keyof typeof SETTINGS_SCHEMAS;
export type Settings = { [K in SettingsKey]: z.infer<(typeof SETTINGS_SCHEMAS)[K]> };

export const DEFAULT_SETTINGS: Settings = {
  shop: { shopName: 'Pannala Aruna Paint Center', address: '', phone: '', logo: null },
  receipt: receiptSettingsSchema.parse({}),
  billing: billingSettingsSchema.parse({}),
  closing: closingSettingsSchema.parse({}),
  alerts: alertSettingsSchema.parse({}),
  backup: backupSettingsSchema.parse({}),
  cloud: cloudSettingsSchema.parse({}),
  hrm: hrmSettingsSchema.parse({}),
};
