import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type PgTool = 'pg_dump' | 'pg_restore';

const fileName = (tool: PgTool) => (process.platform === 'win32' ? `${tool}.exe` : tool);

/** `<base>/<version>/<sub>` for every numbered version folder, newest first. */
function versioned(base: string, sub: string, pattern = /^\d+(\.\d+)?$/): string[] {
  try {
    return readdirSync(base)
      .filter((v) => pattern.test(v))
      .sort((a, b) => Number(b.replace(/\D+/g, '')) - Number(a.replace(/\D+/g, '')))
      .map((v) => join(base, v, sub));
  } catch {
    return [];
  }
}

/** Where PostgreSQL's installers usually put pg_dump, newest version first. */
function installFolders(): string[] {
  if (process.platform === 'win32') {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramW6432'],
      process.env['ProgramFiles(x86)'],
      'C:\\Program Files',
    ].filter((r): r is string => Boolean(r));
    return [...new Set(roots)].flatMap((r) => versioned(join(r, 'PostgreSQL'), 'bin'));
  }
  if (process.platform === 'darwin') {
    return [
      ...versioned('/Applications/Postgres.app/Contents/Versions', 'bin'),
      ...versioned('/opt/homebrew/opt', 'bin', /^postgresql@\d+$/),
      ...versioned('/usr/local/opt', 'bin', /^postgresql@\d+$/),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
  }
  return [...versioned('/usr/lib/postgresql', 'bin'), ...versioned('/usr', 'bin', /^pgsql-\d+$/)];
}

/**
 * The pg_dump or pg_restore program: from PG_BIN_DIR when it is set, otherwise from PATH, otherwise
 * from PostgreSQL's usual install folders (Windows installs don't add it to PATH). Null when missing.
 */
export function findPgTool(tool: PgTool, pgBinDir: string): string | null {
  const file = fileName(tool);
  if (pgBinDir) {
    const p = join(pgBinDir, file);
    return existsSync(p) ? p : null;
  }
  const path = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of [...path, ...installFolders()]) {
    const p = join(dir, file);
    if (existsSync(p)) return p;
  }
  return null;
}

/** What to tell the Super Admin when the tool can't be found. */
export function pgToolMissing(tool: PgTool, pgBinDir: string): string {
  return pgBinDir
    ? `PostgreSQL's ${tool} is not in PG_BIN_DIR (${pgBinDir}). Check that folder in apps/server/.env and restart the server.`
    : `PostgreSQL's ${tool} was not found on the shop server. Set PG_BIN_DIR in apps/server/.env to PostgreSQL's bin folder (for example C:/Program Files/PostgreSQL/16/bin) and restart the server.`;
}

/** The tool's path, or an error that says in plain words how to fix it. */
export function pgTool(tool: PgTool, pgBinDir: string): string {
  const p = findPgTool(tool, pgBinDir);
  if (!p) throw new Error(pgToolMissing(tool, pgBinDir));
  return p;
}
