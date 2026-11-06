// Brings the shop's database up to date without the Prisma CLI. The Windows installer runs it as
//   node --env-file=<config.env> migrate.mjs            take the new migrations
//   node --env-file=<config.env> migrate.mjs --create   first make the role and database
// --create needs ADMIN_DATABASE_URL (the PostgreSQL superuser the installer set up); the role,
// password and database are read from DATABASE_URL. It exits non-zero on any failure, so the
// installer can put the previous version back.
import { createPrisma } from '../db';
import { migrateShop } from '../core/migrations';

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function createRoleAndDatabase(databaseUrl: string, adminUrl: string) {
  const target = new URL(databaseUrl);
  const role = decodeURIComponent(target.username);
  const password = decodeURIComponent(target.password);
  const dbName = target.pathname.slice(1);
  const admin = new URL(adminUrl);
  admin.pathname = '/postgres';
  admin.search = '';
  const db = createPrisma(admin.toString());
  try {
    const roles = await db.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM pg_roles WHERE rolname = $1`,
      role,
    );
    // CREATEDB: test mode builds its copy database itself.
    if (!roles.length)
      await db.$executeRawUnsafe(`CREATE ROLE ${q(role)} LOGIN CREATEDB PASSWORD ${lit(password)}`);
    else
      await db.$executeRawUnsafe(`ALTER ROLE ${q(role)} LOGIN CREATEDB PASSWORD ${lit(password)}`);
    const dbs = await db.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      dbName,
    );
    if (!dbs.length) {
      await db.$executeRawUnsafe(
        `CREATE DATABASE ${q(dbName)} OWNER ${q(role)} ENCODING 'UTF8' TEMPLATE template0`,
      );
      console.log(`Made the database ${dbName}.`);
    }
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');
  if (process.argv.includes('--create')) {
    const adminUrl = process.env.ADMIN_DATABASE_URL;
    if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is not set.');
    await createRoleAndDatabase(databaseUrl, adminUrl);
  }
  const db = createPrisma(databaseUrl);
  try {
    const applied = await migrateShop(db, (line) => console.log(line));
    console.log(
      applied.length
        ? `Database updated (${applied.length} changes).`
        : 'Database already up to date.',
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
