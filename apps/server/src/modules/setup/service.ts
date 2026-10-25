import {
  BUILT_IN_ROLE_LABELS,
  BUILT_IN_ROLES,
  DEFAULT_NUMBER_FORMATS,
  DEFAULT_SETTINGS,
  DomainError,
  codeKey,
  nameKey,
  passwordSchema,
  pinSchema,
  type DocType,
} from '@aruna/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../../config';
import { TX_OPTIONS, type Db, type Tx } from '../../db';
import { audit } from '../../core/audit';
import {
  hashPassword,
  newRecoveryCode,
  normalizeRecoveryCode,
  pinHmac,
  sha256,
} from '../../auth/crypto';

export const setupSchema = z.object({
  shop: z.object({
    shopName: z.string().min(1).max(120),
    address: z.string().max(300).default(''),
    phone: z.string().max(60).default(''),
  }),
  admin: z.object({
    username: z
      .string()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9._-]+$/, { message: 'Use letters, digits and . _ - only.' }),
    fullName: z.string().min(1).max(120),
    password: passwordSchema,
    pin: pinSchema,
  }),
  counterCode: z.string().min(1).max(10).default('C1'),
});
export type SetupInput = z.input<typeof setupSchema>;

/** The value lists the shop starts with; the Super Admin edits them in the value manager. */
const STARTING_LISTS = {
  units: [
    { name: 'piece', allowsDecimal: false },
    { name: 'box', allowsDecimal: false },
    { name: 'can', allowsDecimal: false },
    { name: 'L', allowsDecimal: true },
    { name: 'kg', allowsDecimal: true },
  ],
  categories: ['Emulsion', 'Enamel', 'Thinner', 'Putty', 'Brushes'],
  reasons: [
    { name: 'Damaged', appliesTo: ['RETURN', 'ADJUSTMENT', 'PURCHASE_RETURN'] },
    { name: 'Expired', appliesTo: ['RETURN', 'ADJUSTMENT', 'PURCHASE_RETURN'] },
    { name: 'Wrong item', appliesTo: ['RETURN', 'VOID', 'PURCHASE_RETURN'] },
    { name: 'Customer changed mind', appliesTo: ['RETURN', 'VOID'] },
    { name: 'Wrong entry', appliesTo: ['VOID', 'ADJUSTMENT'] },
    { name: 'Count correction', appliesTo: ['ADJUSTMENT'] },
    { name: 'MP wastage', appliesTo: ['ADJUSTMENT'] },
    { name: 'Petty expense', appliesTo: ['CASH_OUT'] },
    { name: 'Float top-up', appliesTo: ['CASH_IN'] },
  ],
  cutoffTypes: ['Salary', 'Rent', 'Bills', 'Savings'],
};

export async function needsSetup(db: Db): Promise<boolean> {
  return (await db.user.count()) === 0;
}

/**
 * First-run wizard: shop details, the Super Admin account and recovery codes, the first shop
 * (plus the built-in Damaged location), counter C1, starting lists and number formats.
 * Returns the recovery codes once; only their hashes are stored.
 */
export async function runSetup(db: Db, config: AppConfig, rawInput: SetupInput) {
  const input = setupSchema.parse(rawInput);
  return db.$transaction(async (tx) => {
    if ((await tx.user.count()) > 0)
      throw new DomainError('INVALID_STATE', 'The shop is already set up.');

    await ensureBuiltInRoles(tx);

    const shop = await tx.location.create({
      data: { code: 'SHOP', name: 'Shop', nameKey: nameKey('Shop'), kind: 'SHOP', sortOrder: 1 },
    });
    await tx.location.create({
      data: {
        code: 'DMG',
        name: 'Damaged',
        nameKey: nameKey('Damaged'),
        kind: 'DAMAGED',
        sortOrder: 99,
      },
    });
    await tx.counter.create({
      data: {
        code: codeKey(input.counterCode),
        name: `Counter ${input.counterCode.replace(/\D/g, '') || '1'}`,
        locationId: shop.id,
      },
    });

    for (const [i, u] of STARTING_LISTS.units.entries()) {
      await tx.unit.create({
        data: {
          name: u.name,
          nameKey: nameKey(u.name),
          allowsDecimal: u.allowsDecimal,
          sortOrder: i + 1,
        },
      });
    }
    for (const [i, c] of STARTING_LISTS.categories.entries()) {
      await tx.category.create({ data: { name: c, nameKey: nameKey(c), sortOrder: i + 1 } });
    }
    for (const [i, r] of STARTING_LISTS.reasons.entries()) {
      await tx.reason.create({
        data: { name: r.name, nameKey: nameKey(r.name), appliesTo: r.appliesTo, sortOrder: i + 1 },
      });
    }
    for (const [i, c] of STARTING_LISTS.cutoffTypes.entries()) {
      await tx.cutoffType.create({ data: { name: c, nameKey: nameKey(c), sortOrder: i + 1 } });
    }
    for (const [docType, format] of Object.entries(DEFAULT_NUMBER_FORMATS) as [DocType, string][]) {
      await tx.numberFormat.create({ data: { docType, format } });
    }
    await tx.setting.create({
      data: {
        key: 'shop',
        value: { ...DEFAULT_SETTINGS.shop, ...input.shop } as Prisma.InputJsonValue,
      },
    });

    const superAdminRole = await tx.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
    const admin = await tx.user.create({
      data: {
        username: input.admin.username,
        usernameKey: nameKey(input.admin.username),
        fullName: input.admin.fullName,
        passwordHash: await hashPassword(input.admin.password),
        pinHmac: pinHmac(input.admin.pin, config.pinSecret),
        roles: { create: [{ roleId: superAdminRole.id }] },
      },
    });

    const recoveryCodes = Array.from({ length: 8 }, () => newRecoveryCode());
    for (const code of recoveryCodes) {
      await tx.recoveryCode.create({ data: { codeHash: sha256(normalizeRecoveryCode(code)) } });
    }

    await audit(
      tx,
      { userId: admin.id },
      { action: 'setup', entity: 'shop', note: input.shop.shopName },
    );
    return { adminId: admin.id, recoveryCodes };
  }, TX_OPTIONS);
}

export async function ensureBuiltInRoles(tx: Tx): Promise<void> {
  for (const [i, code] of BUILT_IN_ROLES.entries()) {
    const name = BUILT_IN_ROLE_LABELS[code];
    await tx.role.upsert({
      where: { code },
      create: { code, name, nameKey: nameKey(name), builtIn: true, sortOrder: i + 1 },
      update: { name, builtIn: true },
    });
  }
}
