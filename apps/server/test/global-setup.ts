import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/** A fresh test database for each run, migrated exactly like a shop install. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://aruna:aruna@localhost:5432/aruna_test';
  const u = new URL(url);
  const dbName = u.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const prisma = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  await prisma.$disconnect();
  execSync('npx prisma migrate deploy', {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  process.env.TEST_DATABASE_URL = url;
}
