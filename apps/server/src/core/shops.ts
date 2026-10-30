import { DomainError } from '@aruna/shared';
import type { AppConfig } from '../config';
import { createPrisma, type Db } from '../db';
import { migrationStatements } from './migrations';

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * The online panel serves several shops. Its own database holds the list (sync_nodes); each shop
 * that syncs gets its own copy database, made the first time it connects, with the same
 * migrations a shop install runs. Requests then work on the copy of the shop they are about.
 */
export class CloudShops {
  private clients = new Map<string, Db>();
  private making = new Map<string, Promise<void>>();

  constructor(
    /** The cloud's own database: the list of shops. */
    readonly control: Db,
    private readonly config: AppConfig,
  ) {}

  private urlFor(dbName: string) {
    const u = new URL(this.config.databaseUrl);
    u.pathname = `/${dbName}`;
    return u.toString();
  }

  private dbNameFor(shopId: string) {
    const base = decodeURIComponent(new URL(this.config.databaseUrl).pathname.slice(1));
    return `${base}_s_${shopId
      .replace(/[^0-9a-f]/gi, '')
      .slice(0, 12)
      .toLowerCase()}`;
  }

  /** The shop's copy, for the database proxy; null until `open()` has run. */
  client(shopId: string): Db | null {
    return this.clients.get(shopId) ?? null;
  }

  list() {
    return this.control.syncNode.findMany({
      where: { dbName: { not: '' } },
      orderBy: { name: 'asc' },
    });
  }

  /** Opens a shop that already synced; false when there is no such shop. */
  async open(shopId: string): Promise<boolean> {
    if (this.clients.has(shopId)) return true;
    if (!/^[0-9a-f-]{36}$/i.test(shopId)) return false;
    const node = await this.control.syncNode.findUnique({ where: { id: shopId } });
    if (!node?.dbName) return false;
    if (!this.clients.has(shopId)) this.clients.set(shopId, createPrisma(this.urlFor(node.dbName)));
    return true;
  }

  /** A shop server connecting: its copy is made the first time. */
  async ensure(shopId: string, name: string): Promise<void> {
    if (await this.open(shopId)) return;
    let job = this.making.get(shopId);
    if (!job) {
      job = this.make(shopId, name).finally(() => this.making.delete(shopId));
      this.making.set(shopId, job);
    }
    await job;
  }

  private async make(shopId: string, name: string) {
    const dbName = this.dbNameFor(shopId);
    try {
      await this.control.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${q(dbName)} WITH (FORCE)`);
      await this.control.$executeRawUnsafe(`CREATE DATABASE ${q(dbName)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DomainError(
        'INVALID_STATE',
        /permission denied/i.test(msg)
          ? 'The cloud database user must be allowed to create databases (CREATEDB), one per shop.'
          : `Could not make the shop's copy in the cloud: ${msg}`,
      );
    }
    const db = createPrisma(this.urlFor(dbName));
    for (const sql of await migrationStatements()) await db.$executeRawUnsafe(sql);
    await this.control.syncNode.upsert({
      where: { id: shopId },
      create: { id: shopId, name: name || 'Shop', dbName },
      update: { dbName, ...(name ? { name } : {}) },
    });
    this.clients.set(shopId, db);
  }

  /** Tests: forget every shop. */
  async reset() {
    await this.close();
    const rows = await this.control.$queryRaw<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname LIKE ${`${this.dbNameFor('').replace(/_$/, '')}_%`}`;
    for (const r of rows)
      await this.control.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${q(r.datname)} WITH (FORCE)`);
  }

  async close() {
    await Promise.all([...this.clients.values()].map((c) => c.$disconnect()));
    this.clients.clear();
  }
}
