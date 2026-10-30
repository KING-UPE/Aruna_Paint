// Builds the online panel for Vercel (Build Output API v3), run by vercel.json's buildCommand:
//   .vercel/output/static            the screens (apps/web)
//   .vercel/output/functions/api.func  the server, bundled into one file, with Prisma's client
//                                      and engine and the migrations each shop's copy is built with
// Vercel builds on the same Linux its functions run on, so the Prisma engine made here fits.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(server, '..', '..');
const out = join(root, '.vercel', 'output');
const fn = join(out, 'functions', 'api.func');
const run = (cmd, cwd = root, env = {}) =>
  execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

// 1. The screens.
run('pnpm --filter @aruna/web build');
cpSync(join(root, 'apps', 'web', 'dist'), join(out, 'static'), { recursive: true });

// 2. Prisma's client for this machine.
run('npx prisma generate', server);

// 3. The cloud's own database (the list of shops) takes the migrations. Each shop's copy is
//    made and kept up to date by the server itself.
const direct =
  process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (direct && process.env.SKIP_MIGRATE !== '1')
  run('npx prisma migrate deploy', server, { DATABASE_URL: direct });

// 4. The server in one file. CommonJS packages inside need require, __dirname and __filename.
const req = createRequire(join(server, 'package.json'));
const esbuild = createRequire(req.resolve('tsup'))('esbuild');
await esbuild.build({
  entryPoints: [join(server, 'src', 'vercel.ts')],
  outfile: join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  tsconfig: join(server, 'tsconfig.json'),
  // Prisma loads its engine from disk; ws's speed-ups are optional.
  external: ['@prisma/client', '.prisma/client', 'bufferutil', 'utf-8-validate'],
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

// 5. Prisma's client and engine, and the migrations.
const prismaClient = dirname(realpathSync(req.resolve('@prisma/client/package.json')));
const generated = join(prismaClient, '..', '..', '.prisma', 'client');
if (!existsSync(generated)) throw new Error(`Prisma's generated client is missing at ${generated}`);
cpSync(prismaClient, join(fn, 'node_modules', '@prisma', 'client'), {
  recursive: true,
  dereference: true,
});
cpSync(generated, join(fn, 'node_modules', '.prisma', 'client'), {
  recursive: true,
  dereference: true,
});
cpSync(join(server, 'prisma'), join(fn, 'prisma'), { recursive: true });
writeFileSync(join(fn, 'package.json'), JSON.stringify({ type: 'module' }));
writeFileSync(
  join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      // A shop's first sync makes its copy database, which takes a few seconds.
      maxDuration: 60,
    },
    null,
    2,
  ),
);

// 6. /api/* to the function, files as they are, every other path to the screens.
writeFileSync(
  join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/api/(.*)$', dest: '/api' },
        { handle: 'filesystem' },
        { src: '^/(.*)$', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);
console.log('Vercel output ready in .vercel/output');
