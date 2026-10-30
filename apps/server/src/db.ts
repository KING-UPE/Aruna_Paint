import { Prisma, PrismaClient } from '@prisma/client';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

/**
 * Drops a database our own connections may still hold (test copy, a shop's copy in the cloud).
 * Not WITH (FORCE): that is refused while autovacuum works in the database, because an ordinary
 * user may not end that process. A plain DROP stops autovacuum itself, and waits a few seconds for
 * the sessions ended here to go.
 */
export async function dropDatabase(db: PrismaClient, name: string): Promise<void> {
  await db.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = ${name} AND pid <> pg_backend_pid() AND usename = current_user`;
  await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name.replace(/"/g, '""')}"`);
}

/** Interactive transactions get room for slower shop PCs. */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;
