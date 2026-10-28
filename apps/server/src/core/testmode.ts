import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError, formatMoney } from '@aruna/shared';
import type { AppConfig } from '../config';
import { createPrisma, type Db } from '../db';
import { audit } from './audit';
import { libpqUrl } from './backups';

export interface TestModeStatus {
  on: boolean;
  since: string | null;
  byUserId: string | null;
  byName: string | null;
}

const OFF: TestModeStatus = { on: false, since: null, byUserId: null, byName: null };

/**
 * The database client every route holds. It forwards to production, or to the test copy while
 * test mode is on, so routes that took `db` once at start-up follow the switch.
 */
export function switchableDb(initial: Db) {
  let current = initial;
  const db = new Proxy({} as Db, {
    get(_target, prop) {
      const v = (current as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
    },
  });
  return {
    db,
    use(next: Db) {
      current = next;
    },
  };
}

// Document numbers in test mode start with TEST-, so a test receipt can never pass for a real one.
let numberPrefix = '';
export function testNumberPrefix(): string {
  return numberPrefix;
}

function run(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 10 * 60_000, windowsHide: true }, (err, _out, stderr) => {
      if (err && typeof err.code !== 'number')
        return reject(new Error(stderr.trim() || err.message));
      resolve({ code: err ? Number(err.code) : 0, stderr: stderr.trim() });
    });
  });
}

/**
 * Test mode (Super Admin): the whole system keeps working on a fresh copy of the shop's data,
 * while the real data waits untouched. Receipts say TEST, numbers start with TEST-, the cash
 * drawer stays shut and backups pause. Turning it off goes back to the real data exactly where it
 * stopped; nothing done in test mode is kept, except the record that it was on.
 */
export class TestModeService {
  private status: TestModeStatus = OFF;
  private testDb: Db | null = null;
  private busy = false;

  constructor(
    /** Always the real database: test mode's own records are written here. */
    private readonly production: Db,
    private readonly sw: { use(db: Db): void },
    private readonly config: AppConfig,
    private readonly onSwitch: (on: boolean) => void,
  ) {}

  get(): TestModeStatus {
    return { ...this.status };
  }

  isOn(): boolean {
    return this.status.on;
  }

  private get file() {
    return join(this.config.dataDir, 'test-mode.json');
  }

  /** The test copy sits next to the real database: aruna_pos → aruna_pos_testmode. */
  private get testUrl() {
    const u = new URL(this.config.databaseUrl);
    const name = decodeURIComponent(u.pathname.slice(1));
    if (!/^[A-Za-z0-9_]+$/.test(name))
      throw new Error(`Test mode needs a plain database name, not "${name}".`);
    u.pathname = `/${name}_testmode`;
    return { url: u.toString(), name: `${name}_testmode` };
  }

  /** An on/off switch: after a restart, test mode stays on until the Super Admin turns it off. */
  async start() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as TestModeStatus;
      if (saved.on) {
        this.status = saved;
        this.testDb = createPrisma(this.testUrl.url);
        await this.testDb.$connect();
        this.activate(this.testDb, true);
      }
    } catch {
      // No file (normal), or the test copy is gone: stay on the real data.
      if (this.status.on) await this.forceOff();
    }
  }

  private activate(db: Db, on: boolean) {
    this.sw.use(db);
    numberPrefix = on ? 'TEST-' : '';
    this.onSwitch(on);
  }

  private async save() {
    await mkdir(this.config.dataDir, { recursive: true });
    await writeFile(this.file, JSON.stringify(this.status, null, 2));
  }

  private bin(name: string) {
    return this.config.pgBinDir ? join(this.config.pgBinDir, name) : name;
  }

  /** A fresh copy of the real data: pg_dump, a new database, pg_restore. */
  private async copyProduction() {
    const { url, name } = this.testUrl;
    const folder = join(this.config.dataDir, 'test-mode');
    const dump = join(folder, 'copy.dump');
    await mkdir(folder, { recursive: true });
    const dumped = await run(this.bin('pg_dump'), [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--file=${dump}`,
      `--dbname=${libpqUrl(this.config.databaseUrl)}`,
    ]);
    if (dumped.code !== 0) throw new Error(dumped.stderr || 'pg_dump failed');
    await this.production.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await this.production.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
    // pg_restore reports harmless warnings (extension comments) with exit code 1; the row
    // counts below are what prove the copy.
    const restored = await run(this.bin('pg_restore'), [
      '--no-owner',
      '--no-privileges',
      `--dbname=${libpqUrl(url)}`,
      dump,
    ]);
    await rm(dump, { force: true });
    const copy = createPrisma(url);
    try {
      const [a, b] = await Promise.all([
        Promise.all([this.production.user.count(), this.production.sale.count()]),
        Promise.all([copy.user.count(), copy.sale.count()]),
      ]);
      if (a[0] !== b[0] || b[1] < a[1])
        throw new Error(restored.stderr || 'The copy is incomplete.');
    } catch (err) {
      await copy.$disconnect();
      throw err;
    }
    return copy;
  }

  async turnOn(actor: { userId: string; name: string }) {
    if (this.status.on) throw new DomainError('INVALID_STATE', 'Test mode is already on.');
    if (this.busy) throw new DomainError('INVALID_STATE', 'Test mode is switching; try again.');
    this.busy = true;
    try {
      let copy: Db;
      try {
        copy = await this.copyProduction();
      } catch (err) {
        throw new DomainError(
          'INVALID_STATE',
          `Could not make the test copy of the data: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.status = {
        on: true,
        since: new Date().toISOString(),
        byUserId: actor.userId,
        byName: actor.name,
      };
      await this.save();
      this.testDb = copy;
      await audit(
        this.production,
        { userId: actor.userId },
        {
          action: 'testmode.on',
          entity: 'system',
          entityId: null,
        },
      );
      this.activate(copy, true);
      return this.get();
    } finally {
      this.busy = false;
    }
  }

  /** Back to the real data, where it stopped. */
  async turnOff(actor: { userId: string }) {
    if (!this.status.on || !this.testDb)
      throw new DomainError('INVALID_STATE', 'Test mode is off.');
    const test = this.testDb;
    const was = this.status;
    // What was done in test mode, for the record in the real data.
    const since = new Date(was.since!);
    const sales = await test.sale
      .aggregate({
        where: { kind: 'INVOICE', status: 'COMPLETED', completedAt: { gte: since } },
        _count: true,
        _sum: { netTotal: true },
      })
      .catch(() => null);
    this.status = OFF;
    this.testDb = null;
    await this.save();
    this.activate(this.production, false);
    // The screens were busy on the copy; their real sessions shouldn't lock at once.
    await this.production.session.updateMany({
      where: { revokedAt: null, lockedAt: null, expiresAt: { gt: new Date() } },
      data: { lastActivityAt: new Date() },
    });
    await audit(
      this.production,
      { userId: actor.userId },
      {
        action: 'testmode.off',
        entity: 'system',
        entityId: null,
        before: { since: was.since, by: was.byName },
        after: {
          testBills: sales?._count ?? 0,
          testSales: formatMoney(sales?._sum.netTotal?.toString() ?? '0'),
        },
      },
    );
    // Let requests already running on the copy finish first.
    setTimeout(() => void test.$disconnect(), 5_000).unref();
    return this.get();
  }

  /** The copy is unusable after a restart: go back to the real data. */
  private async forceOff() {
    this.status = OFF;
    this.testDb = null;
    await this.save().catch(() => undefined);
    this.activate(this.production, false);
  }

  async close() {
    await this.testDb?.$disconnect();
  }
}
