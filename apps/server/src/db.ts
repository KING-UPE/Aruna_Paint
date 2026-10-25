import { Prisma, PrismaClient } from '@prisma/client';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

/** Interactive transactions get room for slower shop PCs. */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;
