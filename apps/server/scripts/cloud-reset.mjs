// ONE-TIME: empties the online panel's database except the owner's account (sync_state 'owners').
// Run by a preview build on Vercel (vercel.json buildCommand on this branch only), never by main.
//   MODE 'report': lists what is there and changes nothing.
//   MODE 'clean' : drops every shop's copy database, deletes every shop row (sync_nodes), every
//                  other sync_state key and every other non-empty table, then reports again.
// The build then fails on purpose, so this preview is never served.
import { PrismaClient } from '@prisma/client';

const MODE = 'report';

const url =
  process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('No database URL in this build.');
const u = new URL(url);
const base = decodeURIComponent(u.pathname.slice(1));
const db = new PrismaClient({ datasources: { db: { url } } });
const q = (n) => `"${n.replace(/"/g, '""')}"`;
const KEEP_TABLES = new Set(['_prisma_migrations', 'sync_state', 'sync_nodes']);

async function report(label) {
  console.log(`\n===== ${label}: database "${base}" on ${u.hostname}`);
  const nodes = await db.$queryRawUnsafe(
    `SELECT id, name, db_name, last_seen_at, version FROM sync_nodes ORDER BY created_at`,
  );
  console.log(`Shops (sync_nodes): ${nodes.length}`);
  for (const n of nodes)
    console.log(`  - ${n.name} | copy ${n.db_name || '(none)'} | last seen ${n.last_seen_at?.toISOString?.() ?? '-'} | v${n.version}`);
  const keys = await db.$queryRawUnsafe(`SELECT key FROM sync_state ORDER BY key`);
  console.log(`sync_state keys: ${keys.map((k) => k.key).join(', ') || '(none)'}`);
  const owners = await db.$queryRawUnsafe(`SELECT value FROM sync_state WHERE key = 'owners'`);
  const list = Object.values(owners[0]?.value ?? {});
  console.log(`Owner accounts kept: ${list.length} (${list.map((o) => o.username).join(', ')})`);
  const dbs = await db.$queryRawUnsafe(
    `SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname`,
    `${base}\\_s\\_%`,
  );
  console.log(`Shop copy databases: ${dbs.length} ${dbs.map((d) => d.datname).join(', ')}`);
  const tables = await db.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const filled = [];
  for (const { tablename } of tables) {
    const [{ n }] = await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${q(tablename)}`);
    if (n > 0) filled.push(`${tablename}=${n}`);
  }
  console.log(`Tables with rows: ${filled.join(', ') || '(none)'}`);
  return { nodes, dbs, filled };
}

try {
  const before = await report('BEFORE');
  if (MODE === 'clean') {
    const names = new Set([
      ...before.nodes.map((n) => n.db_name).filter(Boolean),
      ...before.dbs.map((d) => d.datname),
    ]);
    for (const name of names) {
      if (!name.startsWith(`${base}_s_`)) throw new Error(`Refusing to drop ${name}`);
      await db.$queryRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        name,
      );
      await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${q(name)}`);
      console.log(`Dropped ${name}`);
    }
    await db.$executeRawUnsafe(`DELETE FROM sync_nodes`);
    await db.$executeRawUnsafe(`DELETE FROM sync_state WHERE key <> 'owners'`);
    const others = before.filled
      .map((f) => f.split('=')[0])
      .filter((t) => !KEEP_TABLES.has(t));
    // TRUNCATE skips the append-only row triggers, as the tests' resetDb does.
    if (others.length) await db.$executeRawUnsafe(`TRUNCATE ${others.map(q).join(', ')} CASCADE`);
    await report('AFTER');
  }
} finally {
  await db.$disconnect();
}
console.log(`\nMode was "${MODE}". Failing this build on purpose so it is never served.`);
process.exit(1);
