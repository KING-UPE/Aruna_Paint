import type { AppConfig } from './config';
import type { Db } from './db';
import type { EventBus } from './core/events';
import type { SettingsService } from './core/settings';
import type { PrintService } from './printing/service';
import type { BackupService } from './core/backups';

/** Everything route handlers need, decorated onto the Fastify instance as `app.deps`. */
export interface Deps {
  db: Db;
  config: AppConfig;
  settings: SettingsService;
  events: EventBus;
  printer: PrintService;
  backups: BackupService;
}
