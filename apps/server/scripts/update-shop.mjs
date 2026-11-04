#!/usr/bin/env node
/**
 * Updates a shop server PC to the latest code on main, in one command (`pnpm shop:update` from the
 * project folder): a backup of the data first, then pull, install, build and the database changes.
 * It stops at the first step that fails and says what to do. Restart the server afterwards.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const server = join(root, 'apps', 'server');
const win = process.platform === 'win32';

function say(msg) {
  console.log(`\n» ${msg}`);
}
function stop(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

/** The server's own settings (apps/server/.env), as the server reads them. */
function readEnv(file) {
  if (!existsSync(file)) stop(`${file} is missing. This doesn't look like a set-up shop server.`);
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

function run(cmd, args, what) {
  // pnpm is a .cmd file on Windows, which needs a shell.
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: win && cmd === 'pnpm' });
  if (r.status !== 0)
    stop(`${what} failed (see above). The server was not changed past this step.`);
}

/** pg_dump from PG_BIN_DIR, PATH or PostgreSQL's usual install folders (as the backups do). */
function findPgDump(pgBinDir) {
  const file = win ? 'pg_dump.exe' : 'pg_dump';
  const versions = (base) => {
    try {
      return readdirSync(base)
        .filter((v) => /^\d+(\.\d+)?$/.test(v))
        .sort((a, b) => Number(b) - Number(a))
        .map((v) => join(base, v, 'bin'));
    } catch {
      return [];
    }
  };
  const dirs = pgBinDir
    ? [pgBinDir]
    : [
        ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean),
        ...(win
          ? [process.env.ProgramFiles, 'C:\\Program Files']
              .filter(Boolean)
              .flatMap((r) => versions(join(r, 'PostgreSQL')))
          : versions('/usr/lib/postgresql')),
      ];
  return dirs.map((d) => join(d, file)).find((p) => existsSync(p)) ?? null;
}

const env = readEnv(join(server, '.env'));
if (!env.DATABASE_URL) stop('DATABASE_URL is not set in apps/server/.env.');

// 1. Only a clean copy of main is updated, so nothing typed on this PC is lost.
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') stop(`This folder is on "${branch}", not main. Switch to main first.`);
const changed = git('status', '--porcelain', '--untracked-files=no');
if (changed) stop(`Files were changed on this PC, so the update stopped:\n${changed}`);
const before = git('rev-parse', '--short', 'HEAD');

// 2. A backup before anything changes.
say('Backing up the data');
const pgDump = findPgDump(env.PG_BIN_DIR ?? '');
if (!pgDump)
  stop(
    'pg_dump was not found. Set PG_BIN_DIR in apps/server/.env to PostgreSQL\'s bin folder, e.g. "C:/Program Files/PostgreSQL/16/bin".',
  );
const folder = join(resolve(server, env.DATA_DIR ?? './data'), 'backups');
mkdirSync(folder, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, '');
const backup = join(folder, `aruna-${stamp}-pre-update.dump`);
const url = new URL(env.DATABASE_URL);
url.searchParams.delete('schema');
const dump = spawnSync(
  pgDump,
  ['--format=custom', '--compress=6', '--no-owner', `--file=${backup}`, `--dbname=${url}`],
  { stdio: 'inherit' },
);
if (dump.status !== 0) stop('The backup failed, so nothing was updated.');
console.log(`  ${backup} (${(statSync(backup).size / 1_048_576).toFixed(1)} MB)`);

// 3. The new code, its packages, the build and the database changes.
say('Getting the latest code');
run('git', ['pull', '--ff-only', 'origin', 'main'], 'Getting the code');
const after = git('rev-parse', '--short', 'HEAD');
if (after === before) console.log('  Already up to date.');
say('Installing packages');
run('pnpm', ['install', '--frozen-lockfile'], 'Installing packages');
say('Building the server and the screens');
run('pnpm', ['build'], 'The build');
say('Applying database changes');
run('pnpm', ['--filter', '@aruna/server', 'db:deploy'], 'The database changes');

console.log(`
✓ Updated ${before} → ${after}. Now restart the server (close its window and start it again with
  "pnpm --filter @aruna/server start", or restart its Windows service), then reload each PC.
  The backup from before the update: ${backup}`);
