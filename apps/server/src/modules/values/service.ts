import { DomainError, cleanName, codeKey, nameKey } from '@aruna/shared';

import { z } from 'zod';
import type { Tx } from '../../db';
import { audit, diff } from '../../core/audit';
import type { ActorRef } from '../../core/context';

export const VALUE_LISTS = [
  'categories',
  'brands',
  'units',
  'locations',
  'reasons',
  'cutoff-types',
] as const;
export type ValueList = (typeof VALUE_LISTS)[number];

const REASON_USES = [
  'RETURN',
  'ADJUSTMENT',
  'VOID',
  'CASH_IN',
  'CASH_OUT',
  'PURCHASE_RETURN',
] as const;

/** Extra fields some lists carry beyond name, order and the active switch. */
const extraSchemas = {
  categories: z.object({}),
  brands: z.object({}),
  units: z.object({ allowsDecimal: z.boolean().optional() }),
  locations: z.object({
    code: z
      .string()
      .min(1)
      .max(10)
      .regex(/^[A-Za-z0-9-]+$/)
      .optional(),
    kind: z.enum(['SHOP', 'WAREHOUSE']).optional(),
  }),
  reasons: z.object({ appliesTo: z.array(z.enum(REASON_USES)).optional() }),
  'cutoff-types': z.object({}),
} satisfies Record<ValueList, z.ZodObject>;

const TABLE: Record<ValueList, string> = {
  categories: 'categories',
  brands: 'brands',
  units: 'units',
  locations: 'locations',
  reasons: 'reasons',
  'cutoff-types': 'cutoff_types',
};

/** Where each list's values are used; a value in use can't be deleted, only deactivated. */
const REFERENCES: Record<ValueList, [table: string, column: string][]> = {
  categories: [['products', 'category_id']],
  brands: [['products', 'brand_id']],
  units: [
    ['products', 'unit_id'],
    ['products', 'buying_unit_id'],
  ],
  locations: [
    ['stock_balances', 'location_id'],
    ['stock_movements', 'location_id'],
    ['counters', 'location_id'],
    ['purchases', 'location_id'],
    ['sales', 'location_id'],
    ['transfers', 'from_location_id'],
    ['transfers', 'to_location_id'],
  ],
  reasons: [
    ['purchase_return_lines', 'reason_id'],
    ['adjustment_lines', 'reason_id'],
    ['sale_return_lines', 'reason_id'],
    ['sales', 'void_reason_id'],
    ['cash_movements', 'reason_id'],
  ],
  'cutoff-types': [['cutoff_rules', 'cutoff_type_id']],
};

export const createValueSchema = z.object({ name: z.string().min(1).max(80) }).loose();
export const updateValueSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .loose();

interface ValueRow {
  id: string;
  name: string;
  name_key: string;
  sort_order: number;
  active: boolean;
  [k: string]: unknown;
}

// Prisma delegates differ per model, so the value manager goes through a small typed map.
function delegate(tx: Tx, list: ValueList) {
  switch (list) {
    case 'categories':
      return tx.category;
    case 'brands':
      return tx.brand;
    case 'units':
      return tx.unit;
    case 'locations':
      return tx.location;
    case 'reasons':
      return tx.reason;
    case 'cutoff-types':
      return tx.cutoffType;
  }
}

type AnyDelegate = {
  findMany(args: object): Promise<ValueRow[]>;
  findUnique(args: object): Promise<Record<string, unknown> | null>;
  findFirst(args: object): Promise<Record<string, unknown> | null>;
  create(args: object): Promise<Record<string, unknown>>;
  update(args: object): Promise<Record<string, unknown>>;
  delete(args: object): Promise<unknown>;
  aggregate(args: object): Promise<{ _max: { sortOrder: number | null } }>;
};

function d(tx: Tx, list: ValueList): AnyDelegate {
  return delegate(tx, list) as unknown as AnyDelegate;
}

export async function listValues(tx: Tx, list: ValueList, includeInactive: boolean) {
  return d(tx, list).findMany({
    where: {
      ...(includeInactive ? {} : { active: true }),
      ...(list === 'locations' ? {} : { mergedIntoId: null }),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

async function assertNameFree(tx: Tx, list: ValueList, name: string, exceptId?: string) {
  const existing = await d(tx, list).findFirst({
    where: { nameKey: nameKey(name), ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  if (existing) {
    throw new DomainError(
      'DUPLICATE',
      `"${existing.name as string}" already exists${existing.active ? '' : ' (inactive)'}.`,
      'name',
      {
        id: existing.id,
      },
    );
  }
}

export async function createValue(tx: Tx, actor: ActorRef, list: ValueList, raw: unknown) {
  const base = createValueSchema.parse(raw);
  const extra = extraSchemas[list].parse(raw) as Record<string, unknown>;
  const name = cleanName(base.name);
  await assertNameFree(tx, list, name);
  const max = await d(tx, list).aggregate({ _max: { sortOrder: true } });
  const data: Record<string, unknown> = {
    name,
    nameKey: nameKey(name),
    sortOrder: (max._max.sortOrder ?? 0) + 1,
  };
  if (list === 'units') data.allowsDecimal = extra.allowsDecimal ?? false;
  if (list === 'reasons') data.appliesTo = extra.appliesTo ?? [...REASON_USES];
  if (list === 'locations') {
    if (!extra.code) throw new DomainError('VALIDATION', 'A location needs a short code.', 'code');
    data.code = codeKey(extra.code as string);
    data.kind = extra.kind ?? 'WAREHOUSE';
  }
  const row = await d(tx, list).create({ data });
  await audit(tx, actor, {
    action: 'value.create',
    entity: list,
    entityId: row.id as string,
    after: row,
  });
  return row;
}

export async function updateValue(
  tx: Tx,
  actor: ActorRef,
  list: ValueList,
  id: string,
  raw: unknown,
) {
  const base = updateValueSchema.parse(raw);
  const extra = extraSchemas[list].parse(raw) as Record<string, unknown>;
  const before = await d(tx, list).findUnique({ where: { id } });
  if (!before) throw new DomainError('NOT_FOUND', 'Value not found.');
  const data: Record<string, unknown> = {};
  if (base.name !== undefined) {
    const name = cleanName(base.name);
    await assertNameFree(tx, list, name, id);
    data.name = name;
    data.nameKey = nameKey(name);
  }
  if (base.sortOrder !== undefined) data.sortOrder = base.sortOrder;
  if (base.active !== undefined) {
    if (list === 'locations' && before.kind !== 'WAREHOUSE' && base.active === false) {
      const shops = await tx.location.count({
        where: { kind: 'SHOP', active: true, id: { not: id } },
      });
      if (before.kind === 'DAMAGED' || shops === 0) {
        throw new DomainError('INVALID_STATE', 'This location must stay active.');
      }
    }
    data.active = base.active;
  }
  if (list === 'units' && extra.allowsDecimal !== undefined)
    data.allowsDecimal = extra.allowsDecimal;
  if (list === 'reasons' && extra.appliesTo !== undefined) data.appliesTo = extra.appliesTo;
  if (list === 'locations' && extra.code !== undefined) data.code = codeKey(extra.code as string);
  const after = await d(tx, list).update({ where: { id }, data });
  const changes = diff(before, data);
  if (changes.changed) {
    await audit(tx, actor, {
      action: 'value.update',
      entity: list,
      entityId: id,
      before: changes.before,
      after: changes.after,
    });
  }
  return after;
}

export async function usageCount(tx: Tx, list: ValueList, id: string): Promise<number> {
  let total = 0;
  for (const [table, column] of REFERENCES[list]) {
    const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "${table}" WHERE "${column}" = $1::uuid`,
      id,
    );
    total += Number(rows[0]?.n ?? 0);
  }
  return total;
}

/** Only unused values can be deleted; anything with history is deactivated instead. */
export async function deleteValue(tx: Tx, actor: ActorRef, list: ValueList, id: string) {
  const before = await d(tx, list).findUnique({ where: { id } });
  if (!before) throw new DomainError('NOT_FOUND', 'Value not found.');
  if (list === 'locations' && before.kind !== 'WAREHOUSE') {
    throw new DomainError('IN_USE', 'Shops and the Damaged location cannot be deleted.');
  }
  if ((await usageCount(tx, list, id)) > 0) {
    throw new DomainError('IN_USE', `"${before.name as string}" is in use. Deactivate it instead.`);
  }
  await d(tx, list).delete({ where: { id } });
  await audit(tx, actor, { action: 'value.delete', entity: list, entityId: id, before });
}

/** Two duplicates can be merged into one, history included. */
export async function mergeValues(
  tx: Tx,
  actor: ActorRef,
  list: ValueList,
  sourceId: string,
  targetId: string,
) {
  if (list === 'locations') throw new DomainError('INVALID_STATE', 'Locations cannot be merged.');
  if (sourceId === targetId)
    throw new DomainError('VALIDATION', 'Pick a different value to merge into.', 'intoId');
  const source = await d(tx, list).findUnique({ where: { id: sourceId } });
  const target = await d(tx, list).findUnique({ where: { id: targetId } });
  if (!source || !target) throw new DomainError('NOT_FOUND', 'Value not found.');
  let moved = 0;
  for (const [table, column] of REFERENCES[list]) {
    moved += await tx.$executeRawUnsafe(
      `UPDATE "${table}" SET "${column}" = $1::uuid WHERE "${column}" = $2::uuid`,
      targetId,
      sourceId,
    );
  }
  if (list === 'reasons') {
    const uses = new Set([...(source.appliesTo as string[]), ...(target.appliesTo as string[])]);
    await tx.reason.update({ where: { id: targetId }, data: { appliesTo: [...uses] } });
  }
  // The duplicate keeps its row (and a freed-up name) so old audit entries still resolve.
  await d(tx, list).update({
    where: { id: sourceId },
    data: {
      active: false,
      mergedIntoId: targetId,
      nameKey: `${source.nameKey as string}#merged#${sourceId}`,
    },
  });
  await audit(tx, actor, {
    action: 'value.merge',
    entity: list,
    entityId: sourceId,
    before: { name: source.name },
    after: { mergedInto: target.name, recordsMoved: moved },
  });
  return { moved };
}

export function isValueList(v: string): v is ValueList {
  return (VALUE_LISTS as readonly string[]).includes(v);
}
