import { Prisma } from '@prisma/client';

/**
 * Makes rows safe for JSON columns and responses: Decimal → string, Date → ISO string,
 * BigInt → string. Calendar dates (@db.Date) come back as midnight UTC and print as YYYY-MM-DD.
 */
export function toJson(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJson(v);
    return out;
  }
  return value;
}

/** A @db.Date value as YYYY-MM-DD. */
export function dateOnly(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

/** YYYY-MM-DD → Date at midnight UTC for @db.Date columns. */
export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
