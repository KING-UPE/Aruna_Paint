// Builds the Windows installer: dist/ArunaPOS-Setup-<version>.exe and dist/latest.json.
//
//   node installer/build.mjs            (Linux or Windows; needs makensis and internet)
//
// What goes in (installer/.cache keeps the downloads between builds):
//   node/      Node.js for Windows (node.exe only)
//   pgsql/     PostgreSQL 16 for Windows (EDB binaries: bin, lib, share)
//   app/       the server bundled into server.mjs and migrate.mjs, Prisma's client with its
//              Windows engine, the migrations, and the screens (app/web)
//   service/   WinSW, which runs the server as a Windows service
//   redist/    Microsoft Visual C++ runtime (PostgreSQL needs it)
//   tools/     the PowerShell steps the installer and the updater run (installer/windows)
//
// Environment: PG_ZIP (a local PostgreSQL binaries zip), PG_VERSIONS (comma list to try),
// NODE_VERSION, SKIP_WEB_BUILD=1, NSIS_FAST=1 (quicker, larger: zlib instead of LZMA).
//
// Update tests only (.github/workflows/installer.yml, job update-tests): VERSION_OVERRIDE builds
// the same app under another version number, and TEST_VARIANT changes the staged copy:
//   good-migration  adds a migration that makes a table (an update with a database change)
//   bad-migration   adds a migration that makes a table, then fails (rollback must undo it)
//   broken-server   a server that exits at start (the health check fails; rollback)
// Never published: the variants use 0.9.x numbers, below every real release.
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const server = join(root, 'apps', 'server');
const cache = join(here, '.cache');
const stage = join(here, '.stage');
const dist = join(root, 'dist');
const version =
  process.env.VERSION_OVERRIDE ||
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const TEST_VARIANT = process.env.TEST_VARIANT || '';
if (TEST_VARIANT && !/^0\.9\.\d+$/.test(version))
  throw new Error('Update-test variants must use a 0.9.x VERSION_OVERRIDE.');
const NODE_VERSION = process.env.NODE_VERSION || '22.21.1';
const PG_VERSIONS = (
  process.env.PG_VERSIONS || '16.13-1,16.12-1,16.11-1,16.10-1,16.9-1,16.8-1'
).split(',');
const WINSW_URL = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe';
const VCREDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

const run = (cmd, cwd = root, env = {}) =>
  execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
const step = (s) => console.log(`\n== ${s}`);

/**
 * Downloads with retries: a download server's passing hiccup (a 5xx, a timeout, a dropped
 * connection) must not stop a release. Any other 4xx means the file isn't there: fail at once.
 */
async function download(url, file, tries = 5) {
  if (existsSync(file) && statSync(file).size > 0) return file;
  for (let attempt = 1; ; attempt++) {
    console.log(`Downloading ${url}${attempt > 1 ? ` (try ${attempt} of ${tries})` : ''}`);
    let failure;
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
      if (res.ok && res.body) {
        await pipeline(res.body, createWriteStream(`${file}.part`));
        renameSync(`${file}.part`, file);
        return file;
      }
      const passing = res.status >= 500 || res.status === 408 || res.status === 429;
      if (!passing) throw Object.assign(new Error(`${url}: HTTP ${res.status}`), { final: true });
      failure = new Error(`${url}: HTTP ${res.status}`);
    } catch (err) {
      if (err.final) throw err;
      failure = err;
    }
    if (attempt >= tries) throw failure;
    const wait = 5_000 * 2 ** (attempt - 1);
    console.log(`  ${failure.message}; trying again in ${wait / 1000} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

function unzip(zip, to) {
  mkdirSync(to, { recursive: true });
  if (process.platform === 'win32')
    run(
      `powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${to}'"`,
    );
  else run(`unzip -q -o "${zip}" -d "${to}"`);
}

async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

async function postgresZip() {
  if (process.env.PG_ZIP) return process.env.PG_ZIP;
  for (const v of PG_VERSIONS) {
    const name = `postgresql-${v}-windows-x64-binaries.zip`;
    const file = join(cache, name);
    if (existsSync(file)) return file;
    const url = `https://get.enterprisedb.com/postgresql/${name}`;
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
    if (head?.ok) return download(url, file);
    console.log(`PostgreSQL ${v}: not available (${head?.status ?? 'no answer'})`);
  }
  throw new Error('No PostgreSQL 16 Windows binaries could be downloaded. Set PG_ZIP.');
}

mkdirSync(cache, { recursive: true });
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(dist, { recursive: true });

step(`Aruna POS ${version}`);

step('Screens');
if (process.env.SKIP_WEB_BUILD !== '1') run('pnpm --filter @aruna/web build');
cpSync(join(root, 'apps', 'web', 'dist'), join(stage, 'app', 'web'), { recursive: true });

step("Prisma's client (with the Windows engine)");
run('npx prisma generate', server);

step('Server bundle');
const req = createRequire(join(server, 'package.json'));
const esbuild = createRequire(req.resolve('tsup'))('esbuild');
await esbuild.build({
  entryPoints: {
    server: join(server, 'src', 'index.ts'),
    migrate: join(server, 'src', 'scripts', 'migrate.ts'),
  },
  outdir: join(stage, 'app'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  tsconfig: join(server, 'tsconfig.json'),
  external: ['@prisma/client', '.prisma/client', 'bufferutil', 'utf-8-validate'],
  define: { 'process.env.ARUNA_BUILD_VERSION': JSON.stringify(version) },
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __fu } from 'node:url';",
      "import { dirname as __dn } from 'node:path';",
      'const require = __cr(import.meta.url);',
      'const __filename = __fu(import.meta.url);',
      'const __dirname = __dn(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
});
const prismaClient = dirname(realpathSync(req.resolve('@prisma/client/package.json')));
const generated = join(prismaClient, '..', '..', '.prisma', 'client');
if (!existsSync(join(generated, 'query_engine-windows.dll.node')))
  throw new Error('The Windows Prisma engine is missing: binaryTargets must include "windows".');
cpSync(prismaClient, join(stage, 'app', 'node_modules', '@prisma', 'client'), {
  recursive: true,
  dereference: true,
});
cpSync(generated, join(stage, 'app', 'node_modules', '.prisma', 'client'), {
  recursive: true,
  dereference: true,
  // Only Windows runs this copy.
  filter: (f) => !/libquery_engine-.*\.so\.node$|query_engine_bg\.(js|wasm)$/.test(f),
});
cpSync(join(server, 'prisma'), join(stage, 'app', 'prisma'), { recursive: true });
if (TEST_VARIANT) {
  console.log(`Update-test variant: ${TEST_VARIANT}`);
  const migration = (name, sql) => {
    const dir = join(stage, 'app', 'prisma', 'migrations', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'migration.sql'), sql);
  };
  if (TEST_VARIANT === 'good-migration')
    migration(
      '29990101000000_update_test_marker',
      "CREATE TABLE update_test_marker (id INT PRIMARY KEY, note TEXT NOT NULL);\nINSERT INTO update_test_marker VALUES (1, 'applied');\n",
    );
  else if (TEST_VARIANT === 'bad-migration')
    migration(
      '29990102000000_update_test_fails',
      'CREATE TABLE update_test_half (id INT PRIMARY KEY);\nSELECT 1 / 0;\n',
    );
  else if (TEST_VARIANT === 'broken-server')
    writeFileSync(
      join(stage, 'app', 'server.mjs'),
      "console.error('Update test: this server exits on purpose.');\nprocess.exit(1);\n",
    );
  else throw new Error(`Unknown TEST_VARIANT ${TEST_VARIANT}`);
}
writeFileSync(
  join(stage, 'app', 'package.json'),
  JSON.stringify({ name: 'aruna-pos-server', version, type: 'module', private: true }, null, 2),
);

step(`Node.js ${NODE_VERSION} for Windows`);
const nodeZip = await download(
  `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  join(cache, `node-v${NODE_VERSION}-win-x64.zip`),
);
const nodeTmp = join(cache, 'node-x');
rmSync(nodeTmp, { recursive: true, force: true });
unzip(nodeZip, nodeTmp);
const nodeDir = join(nodeTmp, `node-v${NODE_VERSION}-win-x64`);
mkdirSync(join(stage, 'node'), { recursive: true });
for (const f of ['node.exe', 'LICENSE']) cpSync(join(nodeDir, f), join(stage, 'node', f));

step('PostgreSQL 16 for Windows');
const pgZip = await postgresZip();
const pgTmp = join(cache, 'pg-x');
rmSync(pgTmp, { recursive: true, force: true });
unzip(pgZip, pgTmp);
const pgsql = existsSync(join(pgTmp, 'pgsql')) ? join(pgTmp, 'pgsql') : pgTmp;
for (const exe of ['postgres.exe', 'initdb.exe', 'pg_ctl.exe', 'pg_dump.exe', 'pg_restore.exe'])
  if (!existsSync(join(pgsql, 'bin', exe))) throw new Error(`PostgreSQL zip has no bin/${exe}`);
// pgAdmin, StackBuilder, headers, docs and debug symbols aren't needed at a shop.
for (const d of ['bin', 'lib', 'share'])
  cpSync(join(pgsql, d), join(stage, 'pgsql', d), {
    recursive: true,
    filter: (f) => !/\.pdb$|[\\/]pgAdmin|[\\/]stackbuilder/i.test(f),
  });

step('Service wrapper and Visual C++ runtime');
mkdirSync(join(stage, 'service'), { recursive: true });
cpSync(
  await download(WINSW_URL, join(cache, 'WinSW-x64.exe')),
  join(stage, 'service', 'ArunaPOS-Server.exe'),
);
mkdirSync(join(stage, 'redist'), { recursive: true });
cpSync(
  await download(VCREDIST_URL, join(cache, 'vc_redist.x64.exe')),
  join(stage, 'redist', 'vc_redist.x64.exe'),
);

step('Install steps');
cpSync(join(here, 'windows', 'tools'), join(stage, 'tools'), { recursive: true });
writeFileSync(join(stage, 'tools', 'version.txt'), version);

step('makensis');
const exeName = `ArunaPOS-Setup-${version}.exe`;
const exe = join(dist, exeName);
rmSync(exe, { force: true });
execFileSync(
  'makensis',
  [
    '-V2',
    `-DVERSION=${version}`,
    ...(process.env.NSIS_FAST === '1' ? ['-DFAST'] : []),
    `-DSTAGE=${stage}`,
    `-DOUTFILE=${exe}`,
    join(here, 'windows', 'aruna.nsi'),
  ],
  { stdio: 'inherit' },
);

const hash = await sha256(exe);
const size = statSync(exe).size;
writeFileSync(
  join(dist, 'latest.json'),
  JSON.stringify({ version, file: exeName, sha256: hash, size }, null, 2),
);
writeFileSync(join(dist, `${exeName}.sha256`), `${hash}  ${exeName}\n`);
console.log(`\nBuilt ${exe} (${(size / 1_048_576).toFixed(1)} MB)\nsha256 ${hash}`);
console.log(`Staged files: ${readdirSync(stage).join(', ')}`);
