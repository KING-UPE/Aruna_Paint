import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError, formatMoney } from '@aruna/shared';
import type { AppConfig } from '../config';
import { createPrisma, type Db } from '../db';
import { audit } from './audit';
import type { ActorRef } from './context';
import { inTestData } from './dbscope';
import { splitSql } from './sqlsplit';

export interface TestModeStatus {
  /** When the test copy was last made from the real data. */
  copyMadeAt: string | null;
  users: { id: string; username: string; fullName: string }[];
}

// Document numbers in test mode start with TEST-, so a test receipt can never pass for a real one.
export function testNumberPrefix(): string {
  return inTestData() ? 'TEST-' : '';
}

/** Tables the copy leaves out: migration history, logins (they stay real) and the sync queue. */
const NOT_COPIED = new Set(['_prisma_migrations', 'sessions', 'sync_outbox']);
const PAGE = 2000;

/** The same migrations a shop install runs, wherever the server was started from. */
async function migrationStatements(): Promise<string[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = [
    join(process.cwd(), 'prisma', 'migrations'),
    join(here, '..', '..', 'prisma', 'migrations'),
    join(here, '..', 'prisma', 'migrations'),
  ].find((d) => existsSync(d));
  if (!dir) throw new Error('The prisma/migrations folder is missing next to the server.');
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const out: string[] = [];
  for (const n of names) {
    const file = join(dir, n, 'migration.sql');
    if (existsSync(file)) out.push(...splitSql(await readFile(file, 'utf8')));
  }
  return out;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Copies every row from the real database into the freshly migrated copy, in one consistent
 * snapshot so a bill and its lines always come together, while the shop keeps working.
 */
async function copyRows(production: Db, copy: Db) {
  const tables = (
    await copy.$queryRaw<{ t: string }[]>`
      SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  )
    .map((r) => r.t)
    .filter((t) => !NOT_COPIED.has(t));
  // Foreign keys come off during the copy (any order works) and go back on after, which also
  // checks the copy.
  const fks = await copy.$queryRaw<{ t: string; name: string; def: string }[]>`
    SELECT conrelid::regclass::text AS t, conname AS name, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`;
  for (const fk of fks)
    await copy.$executeRawUnsafe(`ALTER TABLE ${fk.t} DROP CONSTRAINT ${q(fk.name)}`);
  // No append-only or sync triggers while loading.
  for (const t of tables) await copy.$executeRawUnsafe(`ALTER TABLE ${q(t)} DISABLE TRIGGER USER`);
  await copy.$executeRawUnsafe(`TRUNCATE ${tables.map(q).join(', ')}`);

  await production.$transaction(
    async (tx) => {
      for (const t of tables) {
        let after = '(0,0)';
        for (;;) {
          // Rows travel as JSON text, so money, dates and big numbers arrive exactly as stored.
          const [page] = await tx.$queryRawUnsafe<
            { rows: string; last: string | null; n: number }[]
          >(
            `WITH page AS (
               SELECT ctid AS c, r FROM ${q(t)} r WHERE ctid > $1::tid ORDER BY ctid LIMIT ${PAGE})
             SELECT COALESCE(json_agg(r ORDER BY c), '[]')::text AS rows,
                    (array_agg(c ORDER BY c DESC))[1]::text AS last, count(*)::int AS n
               FROM page`,
            after,
          );
          if (!page || page.n === 0) break;
          await copy.$executeRawUnsafe(
            `INSERT INTO ${q(t)} SELECT * FROM json_populate_recordset(NULL::${q(t)}, $1::json)`,
            page.rows,
          );
          if (page.n < PAGE || !page.last) break;
          after = page.last;
        }
      }
    },
    { isolationLevel: 'RepeatableRead', maxWait: 10_000, timeout: 10 * 60_000 },
  );

  for (const fk of fks)
    await copy.$executeRawUnsafe(`ALTER TABLE ${fk.t} ADD CONSTRAINT ${q(fk.name)} ${fk.def}`);
  for (const t of tables) await copy.$executeRawUnsafe(`ALTER TABLE ${q(t)} ENABLE TRIGGER USER`);
  await copy.$executeRawUnsafe('ANALYZE');
}

/**
 * Test mode, per user (the Super Admin switches single accounts, usually from afar). A user in
 * test mode works on a copy of the shop's data, while everyone else keeps working on the real
 * data at the same time. On the copy, receipts say TEST, numbers start with TEST-, the cash
 * drawer stays shut and backups don't run. Nothing done there ever reaches the real data.
 */
export class TestModeService {
  private copy: Db | null = null;
  private building: Promise<Db> | null = null;
  private madeAt: string | null = null;

  constructor(
    /** Always the real database: users, sessions and test mode's own records live here. */
    readonly production: Db,
    private readonly config: AppConfig,
    /** Something changed: caches of the copy and every screen of the users switched. */
    private readonly onChange: () => void,
  ) {}

  private get file() {
    return join(this.config.dataDir, 'test-mode.json');
  }

  /** The copy sits next to the real database: aruna_pos → aruna_pos_testmode. */
  private get testUrl() {
    const u = new URL(this.config.databaseUrl);
    const name = decodeURIComponent(u.pathname.slice(1));
    if (!/^[A-Za-z0-9_]+$/.test(name))
      throw new Error(`Test mode needs a plain database name, not "${name}".`);
    u.pathname = `/${name}_testmode`;
    return { url: u.toString(), name: `${name}_testmode` };
  }

  /** The copy's client for the proxy; null until a user in test mode needs it. */
  current(): Db | null {
    return this.copy;
  }

  async start() {
    try {
      this.madeAt = (
        JSON.parse(await readFile(this.file, 'utf8')) as { copyMadeAt: string }
      ).copyMadeAt;
    } catch {
      this.madeAt = null;
    }
  }

  async status(): Promise<TestModeStatus> {
    const users = await this.production.user.findMany({
      where: { testMode: true },
      select: { id: true, username: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });
    return { copyMadeAt: this.madeAt, users };
  }

  /** The copy, connected; made from the real data if there is none yet (after a restart too). */
  async ready(): Promise<Db> {
    if (this.copy) return this.copy;
    if (this.building) return this.building;
    if (this.madeAt) {
      const db = createPrisma(this.testUrl.url);
      try {
        await db.$queryRaw`SELECT 1 FROM users LIMIT 1`;
        this.copy = db;
        return db;
      } catch {
        await db.$disconnect();
      }
    }
    return this.rebuild();
  }

  /** A fresh copy of the real data, replacing the old one. */
  rebuild(): Promise<Db> {
    if (this.building) return this.building;
    this.building = this.build().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async build(): Promise<Db> {
    const { url, name } = this.testUrl;
    const old = this.copy;
    this.copy = null;
    await old?.$disconnect();
    try {
      await this.production.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`);
      await this.production.$executeRawUnsafe(`CREATE DATABASE ${q(name)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DomainError(
        'INVALID_STATE',
        /permission denied/i.test(msg)
          ? 'Test mode needs the database user to be allowed to create databases (CREATEDB). Ask whoever set up PostgreSQL to run: ALTER ROLE <user> CREATEDB.'
          : `Could not make the test copy: ${msg}`,
      );
    }
    const copy = createPrisma(url);
    try {
      for (const sql of await migrationStatements()) await copy.$executeRawUnsafe(sql);
      await copyRows(this.production, copy);
    } catch (err) {
      await copy.$disconnect();
      throw new DomainError(
        'INVALID_STATE',
        `Could not make the test copy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.copy = copy;
    this.madeAt = new Date().toISOString();
    await mkdir(this.config.dataDir, { recursive: true });
    await writeFile(this.file, JSON.stringify({ copyMadeAt: this.madeAt }, null, 2));
    this.onChange();
    return copy;
  }

  /** Puts one user on the test copy, or back on the real data. */
  async setUser(actor: ActorRef, userId: string, on: boolean) {
    const user = await this.production.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new DomainError('NOT_FOUND', 'User not found.');
    if (on && user.roles.some((r) => r.role.code === 'SUPER_ADMIN'))
      throw new DomainError(
        'INVALID_STATE',
        'The Super Admin always works on the real data, to look after test mode.',
      );
    if (user.testMode === on) return this.status();
    if (on) {
      // The first person to test starts from today's real data; others join the same copy.
      const others = await this.production.user.count({ where: { testMode: true } });
      if (others === 0) await this.rebuild();
      else await this.ready();
    }
    let summary: { testBills: number; testSales: string } | undefined;
    if (!on && this.copy) {
      const s = await this.copy.sale
        .aggregate({
          // Only bills made in test mode: the copy also holds the real history.
          where: {
            kind: 'INVOICE',
            status: 'COMPLETED',
            cashierId: userId,
            no: { startsWith: 'TEST-' },
          },
          _count: true,
          _sum: { netTotal: true },
        })
        .catch(() => null);
      if (s)
        summary = {
          testBills: s._count,
          testSales: formatMoney(s._sum.netTotal?.toString() ?? '0'),
        };
    }
    await this.production.user.update({ where: { id: userId }, data: { testMode: on } });
    await audit(this.production, actor, {
      action: on ? 'testmode.user_on' : 'testmode.user_off',
      entity: 'user',
      entityId: userId,
      before: { testMode: !on },
      after: { testMode: on, ...summary },
    });
    this.onChange();
    return this.status();
  }

  /** "Refresh the test copy": start testing again from the real data as it is now. */
  async refresh(actor: ActorRef) {
    await this.rebuild();
    await audit(this.production, actor, { action: 'testmode.refresh', entity: 'system' });
    return this.status();
  }

  async close() {
    await this.building?.catch(() => undefined);
    await this.copy?.$disconnect();
  }
}
