import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSql } from './sqlsplit';

/** The same migrations a shop install runs, wherever the server was started from. */
export async function migrationStatements(): Promise<string[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = [
    join(process.cwd(), 'prisma', 'migrations'),
    join(here, '..', '..', 'prisma', 'migrations'),
    join(here, '..', 'prisma', 'migrations'),
  ].find((d) => existsSync(d));
  if (!dir) throw new Error('The prisma/migrations folder is missing next to the server.');
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const out: string[] = [];
  for (const n of names) {
    const file = join(dir, n, 'migration.sql');
    if (existsSync(file)) out.push(...splitSql(await readFile(file, 'utf8')));
  }
  return out;
}
