import { DEFAULT_SETTINGS, SETTINGS_SCHEMAS, type Settings, type SettingsKey } from '@aruna/shared';
import type { Prisma } from '@prisma/client';
import type { Db, Tx } from '../db';
import { inTestData } from './dbscope';

/** Shop settings with an in-memory cache; one server process owns the database. */
export class SettingsService {
  // One cache for the real data and one for the test copy, which a test user may change.
  private caches: { real: Partial<Settings>; test: Partial<Settings> } = { real: {}, test: {} };
  private get cache(): Partial<Settings> {
    return inTestData() ? this.caches.test : this.caches.real;
  }

  constructor(private readonly db: Db) {}

  async get<K extends SettingsKey>(key: K): Promise<Settings[K]> {
    const cached = this.cache[key];
    if (cached) return cached;
    const row = await this.db.setting.findUnique({ where: { key } });
    const value = SETTINGS_SCHEMAS[key].parse({
      ...DEFAULT_SETTINGS[key],
      ...((row?.value as object) ?? {}),
    }) as Settings[K];
    this.cache[key] = value;
    return value;
  }

  async getAll(): Promise<Settings> {
    const out = {} as Record<SettingsKey, unknown>;
    for (const key of Object.keys(SETTINGS_SCHEMAS) as SettingsKey[])
      out[key] = await this.get(key);
    return out as Settings;
  }

  /** Validates and saves; the caller writes the audit entry in the same transaction. */
  async set<K extends SettingsKey>(tx: Tx, key: K, value: unknown): Promise<Settings[K]> {
    const parsed = SETTINGS_SCHEMAS[key].parse(value) as Settings[K];
    await tx.setting.upsert({
      where: { key },
      create: { key, value: parsed as Prisma.InputJsonValue },
      update: { value: parsed as Prisma.InputJsonValue },
    });
    delete this.cache[key];
    return parsed;
  }

  invalidate(): void {
    this.caches = { real: {}, test: {} };
  }
}
