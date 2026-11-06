import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db';
import { splitSql } from './sqlsplit';

/** The same migrations a shop install runs, in order, wherever the server was started from. */
export async function migrations(): Promise<
  { name: string; statements: string[]; checksum: string }[]
> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = [
    join(process.cwd(), 'prisma', 'migrations'),
    // The bundled function on Vercel sits next to its own copy.
    join(here, 'prisma', 'migrations'),
    join(here, '..', '..', 'prisma', 'migrations'),
    join(here, '..', 'prisma', 'migrations'),
  ].find((d) => existsSync(d));
  if (!dir) throw new Error('The prisma/migrations folder is missing next to the server.');
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const out: { name: string; statements: string[]; checksum: string }[] = [];
  for (const name of names) {
    const file = join(dir, name, 'migration.sql');
    if (!existsSync(file)) continue;
    const sql = await readFile(file, 'utf8');
    // The same checksum Prisma keeps, so `prisma migrate deploy` and the shop install agree.
    const checksum = createHash('sha256').update(sql).digest('hex');
    out.push({ name, statements: splitSql(sql), checksum });
  }
  return out;
}

/**
 * Brings a copy database (a shop's copy in the cloud, a test-mode copy) up to the current
 * migrations, so an update reaches the copies too. What it has is noted in its sync_state.
 */
export async function bringUpToDate(db: Db): Promise<void> {
  const all = await migrations();
  const [state] = await db.$queryRaw<{ value: { names: string[] } }[]>`
      SELECT value FROM sync_state WHERE key = 'schema'`.catch(
    () => [] as { value: { names: string[] } }[],
  );
  // A copy without the note is new and empty: it takes every migration.
  const done = new Set(state?.value.names ?? []);
  const missing = all.filter((m) => !done.has(m.name));
  if (!missing.length) return;
  for (const m of missing) for (const sql of m.statements) await db.$executeRawUnsafe(sql);
  const names = JSON.stringify({ names: all.map((m) => m.name) });
  await db.$executeRawUnsafe(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('schema', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    names,
  );
}

/**
 * Brings the shop's own database up to the current migrations, the way `prisma migrate deploy`
 * does and in the same `_prisma_migrations` table, so the installed server needs no Prisma CLI
 * (`src/scripts/migrate.ts`, run by the installer before it starts the new version). Like Prisma
 * it runs each file's statements in order, outside a transaction; the installer's backup taken
 * just before is what undoes a failed update. Returns the names it applied.
 */
export async function migrateShop(
  db: Db,
  log: (line: string) => void = () => {},
): Promise<string[]> {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
  )`);
  const rows = await db.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null }[]>(
    `SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL`,
  );
  const unfinished = rows.find((r) => !r.finished_at);
  if (unfinished)
    throw new Error(
      `The update ${unfinished.migration_name} did not finish earlier. Restore the backup taken before it.`,
    );
  const done = new Set(rows.map((r) => r.migration_name));
  const applied: string[] = [];
  for (const m of await migrations()) {
    if (done.has(m.name)) continue;
    log(`Applying ${m.name}`);
    for (const sql of m.statements) await db.$executeRawUnsafe(sql);
    await db.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
       VALUES ($1, $2, $3, now(), now(), 1)`,
      randomUUID(),
      m.checksum,
      m.name,
    );
    applied.push(m.name);
  }
  return applied;
}
