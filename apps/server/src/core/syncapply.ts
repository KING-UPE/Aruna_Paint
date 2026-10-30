import type { Tx } from '../db';

/** One captured row change, as it travels between the shop and the cloud. */
export interface RowChange {
  table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  pk: Record<string, unknown>;
  /** The row after the change; null for a delete. */
  data: Record<string, unknown> | null;
  /** The row before an update or delete (null on changes captured before 30 Oct 2026). */
  old: Record<string, unknown> | null;
}

/** A field changed online that the shop also changed while the two weren't talking. */
export interface Conflict {
  table: string;
  pk: Record<string, unknown>;
  /** The field, or "" when the whole row is at stake (deleted on one side). */
  field: string;
  was: unknown;
  online: unknown;
  shop: unknown;
}

/** Never sent, never compared: the PIN stays at the shop unless an online PIN reset sends it. */
const NEVER_COMPARED: Record<string, string[]> = { users: ['pin_hmac'] };
/** Ledgers that are only ever added to. */
const APPEND_ONLY = new Set(['audit_logs', 'stock_movements', 'supplier_ledger']);
/** Bookkeeping that changes on its own, never a reason for a conflict. */
const IGNORED = new Set(['updated_at', 'last_login_at']);

interface TableInfo {
  columns: Set<string>;
  pk: string[];
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Table and column names come from the database itself, never from what was sent. */
export class TableCatalog {
  private tables: Map<string, TableInfo> | null = null;

  async info(tx: Tx, table: string): Promise<TableInfo> {
    if (!this.tables) {
      const rows = await tx.$queryRaw<{ t: string; c: string; pk: boolean }[]>`
        SELECT c.table_name AS t, c.column_name AS c,
               EXISTS (
                 SELECT 1 FROM information_schema.table_constraints tc
                   JOIN information_schema.key_column_usage k
                     ON k.constraint_name = tc.constraint_name AND k.table_name = tc.table_name
                  WHERE tc.table_schema = 'public' AND tc.table_name = c.table_name
                    AND tc.constraint_type = 'PRIMARY KEY' AND k.column_name = c.column_name
               ) AS pk
          FROM information_schema.columns c
         WHERE c.table_schema = 'public'
         ORDER BY c.table_name, c.ordinal_position`;
      const map = new Map<string, TableInfo>();
      for (const r of rows) {
        const t = map.get(r.t) ?? { columns: new Set(), pk: [] };
        t.columns.add(r.c);
        if (r.pk) t.pk.push(r.c);
        map.set(r.t, t);
      }
      this.tables = map;
    }
    const t = this.tables.get(table);
    if (!t || table.startsWith('sync_') || table === 'sessions' || table === '_prisma_migrations')
      throw new Error(`Unknown table ${table}`);
    return t;
  }
}

function pkWhere(info: TableInfo, alias = 't', key = 'k') {
  return info.pk.map((c) => `${alias}.${q(c)} = ${key}.${q(c)}`).join(' AND ');
}

/** The row as it is now (JSON in UTC, like captured rows), or null. */
export async function currentRow(tx: Tx, catalog: TableCatalog, ch: RowChange) {
  await catalog.info(tx, ch.table);
  const [r] = await tx.$queryRawUnsafe<{ row: Record<string, unknown> | null }[]>(
    `SELECT sync_row($1::regclass, $2::jsonb) AS row`,
    q(ch.table),
    JSON.stringify(ch.pk),
  );
  return r?.row ?? null;
}

/** The fields an update changed, without bookkeeping. */
export function changedFields(ch: RowChange): string[] {
  if (ch.op !== 'UPDATE' || !ch.data) return [];
  const old = ch.old ?? {};
  return Object.keys(ch.data).filter((f) => !IGNORED.has(f) && !same(ch.data![f], old[f]));
}

/**
 * Field by field: an online change conflicts only where the shop changed the same field to
 * something else meanwhile. Different fields changed on each side are both kept.
 */
export async function findConflicts(
  tx: Tx,
  catalog: TableCatalog,
  changes: RowChange[],
): Promise<Conflict[]> {
  const out: Conflict[] = [];
  for (const ch of changes) {
    if (APPEND_ONLY.has(ch.table)) continue;
    const cur = await currentRow(tx, catalog, ch);
    const skip = new Set([...(NEVER_COMPARED[ch.table] ?? []), ...IGNORED]);
    if (ch.op === 'INSERT') {
      if (cur && ch.data) {
        const diff = Object.keys(ch.data).find((f) => !skip.has(f) && !same(cur[f], ch.data![f]));
        if (diff)
          out.push({
            table: ch.table,
            pk: ch.pk,
            field: diff,
            was: null,
            online: ch.data[diff],
            shop: cur[diff],
          });
      }
    } else if (ch.op === 'UPDATE') {
      if (!cur) {
        out.push({
          table: ch.table,
          pk: ch.pk,
          field: '',
          was: ch.old,
          online: ch.data,
          shop: null,
        });
        continue;
      }
      for (const f of changedFields(ch)) {
        if (skip.has(f) || !ch.old) continue;
        if (!same(cur[f], ch.old[f]) && !same(cur[f], ch.data![f]))
          out.push({
            table: ch.table,
            pk: ch.pk,
            field: f,
            was: ch.old[f],
            online: ch.data![f],
            shop: cur[f],
          });
      }
    } else if (cur && ch.old) {
      const diff = Object.keys(ch.old).find((f) => !skip.has(f) && !same(cur[f], ch.old![f]));
      if (diff)
        out.push({
          table: ch.table,
          pk: ch.pk,
          field: diff,
          was: ch.old[diff],
          online: null,
          shop: cur[diff],
        });
    }
  }
  return out;
}

/**
 * Applies an online change at the shop. Updates set only the fields changed online, so whatever
 * the shop changed in other fields stays. The shop's own capture sends the result back up.
 */
export async function mergeChange(tx: Tx, catalog: TableCatalog, ch: RowChange) {
  const info = await catalog.info(tx, ch.table);
  const t = q(ch.table);
  if (ch.op === 'INSERT' && ch.data) {
    const cur = await currentRow(tx, catalog, ch);
    if (cur) return; // already there (sent twice)
    await tx.$executeRawUnsafe(
      `INSERT INTO ${t} SELECT * FROM jsonb_populate_record(NULL::${t}, $1::jsonb)`,
      JSON.stringify(ch.data),
    );
  } else if (ch.op === 'UPDATE' && ch.data) {
    const fields = Object.keys(ch.data).filter(
      (f) =>
        info.columns.has(f) &&
        !info.pk.includes(f) &&
        f !== 'updated_at' &&
        (!ch.old || !same(ch.data![f], ch.old[f])),
    );
    if (!fields.length) return;
    const sets = fields.map((f) => `${q(f)} = s.${q(f)}`);
    if (info.columns.has('updated_at')) sets.push(`"updated_at" = now()`);
    await tx.$executeRawUnsafe(
      `UPDATE ${t} AS t SET ${sets.join(', ')}
         FROM jsonb_populate_record(NULL::${t}, $1::jsonb) AS s,
              jsonb_populate_record(NULL::${t}, $2::jsonb) AS k
        WHERE ${pkWhere(info)}`,
      JSON.stringify(ch.data),
      JSON.stringify(ch.pk),
    );
  } else if (ch.op === 'DELETE' && !APPEND_ONLY.has(ch.table)) {
    await tx.$executeRawUnsafe(
      `DELETE FROM ${t} AS t USING jsonb_populate_record(NULL::${t}, $1::jsonb) AS k
        WHERE ${pkWhere(info)}`,
      JSON.stringify(ch.pk),
    );
  }
}

/**
 * Applies a shop change on the cloud mirror: the shop is the authority, so the whole row is
 * taken as sent (only the columns sent, so a PIN reset online isn't wiped). The caller sets
 * aruna.sync_apply so the cloud doesn't capture it again.
 */
export async function mirrorChange(tx: Tx, catalog: TableCatalog, ch: RowChange) {
  const info = await catalog.info(tx, ch.table);
  const t = q(ch.table);
  if (ch.op === 'DELETE') {
    if (APPEND_ONLY.has(ch.table)) return;
    await tx.$executeRawUnsafe(
      `DELETE FROM ${t} AS t USING jsonb_populate_record(NULL::${t}, $1::jsonb) AS k
        WHERE ${pkWhere(info)}`,
      JSON.stringify(ch.pk),
    );
    return;
  }
  if (!ch.data) return;
  const cols = Object.keys(ch.data).filter((c) => info.columns.has(c) && !info.pk.includes(c));
  const onConflict =
    APPEND_ONLY.has(ch.table) || !cols.length
      ? 'DO NOTHING'
      : `DO UPDATE SET ${cols.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')}`;
  const keep = new Set([...cols, ...info.pk]);
  const colList = [...info.columns].filter((c) => keep.has(c));
  await tx.$executeRawUnsafe(
    `INSERT INTO ${t} (${colList.map(q).join(', ')})
       SELECT ${colList.map(q).join(', ')} FROM jsonb_populate_record(NULL::${t}, $1::jsonb)
       ON CONFLICT (${info.pk.map(q).join(', ')}) ${onConflict}`,
    JSON.stringify(ch.data),
  );
}

/** A row's real state at the shop, so the cloud can drop an online change the shop didn't take. */
export async function realRow(tx: Tx, catalog: TableCatalog, ch: RowChange): Promise<RowChange> {
  const cur = await currentRow(tx, catalog, ch);
  const strip = NEVER_COMPARED[ch.table] ?? [];
  return {
    table: ch.table,
    op: cur ? 'UPDATE' : 'DELETE',
    pk: ch.pk,
    data: cur ? Object.fromEntries(Object.entries(cur).filter(([k]) => !strip.includes(k))) : null,
    old: null,
  };
}
