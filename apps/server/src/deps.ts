import type { AppConfig } from './config';
import type { Db } from './db';
import type { EventBus } from './core/events';
import type { SettingsService } from './core/settings';
import type { PrintService } from './printing/service';
import type { BackupService } from './core/backups';
import type { CloudShops } from './core/shops';
import type { SyncAgent } from './core/syncagent';
import type { TestModeService } from './core/testmode';

/** Everything route handlers need, decorated onto the Fastify instance as `app.deps`. */
export interface Deps {
  db: Db;
  config: AppConfig;
  settings: SettingsService;
  events: EventBus;
  printer: PrintService;
  backups: BackupService;
  testMode: TestModeService;
  /** Shop mode: the agent that syncs with the cloud. Null in the cloud. */
  sync: SyncAgent | null;
  /** Cloud mode: the shops it serves, each with its own copy. Null at a shop. */
  shops: CloudShops | null;
}
