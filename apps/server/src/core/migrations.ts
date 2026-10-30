import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db';
import { splitSql } from './sqlsplit';

/** The same migrations a shop install runs, in order, wherever the server was started from. */
export async function migrations(): Promise<{ name: string; statements: string[] }[]> {
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
  const out: { name: string; statements: string[] }[] = [];
  for (const name of names) {
    const file = join(dir, name, 'migration.sql');
    if (existsSync(file)) out.push({ name, statements: splitSql(await readFile(file, 'utf8')) });
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
