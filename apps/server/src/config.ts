import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type AppMode = 'shop' | 'cloud';

export interface AppConfig {
  databaseUrl: string;
  /**
   * A direct (not pooled) address of the same database server, for making databases and running
   * migrations (Neon on Vercel gives DATABASE_URL_UNPOOLED). Defaults to databaseUrl.
   */
  directDatabaseUrl: string;
  port: number;
  host: string;
  /** "shop" runs billing and stock; "cloud" is the view-only mirror for admins. */
  mode: AppMode;
  /** HMAC key for PINs. */
  pinSecret: string;
  dataDir: string;
  /** Folder with PostgreSQL's pg_dump and pg_restore; empty looks in PATH, then the usual install folders. */
  pgBinDir: string;
  /** Built web app to serve; empty in development (Vite serves it). */
  webDistDir: string;
  sessionDays: number;
  logLevel: string;
  /** Set in tests to skip timers (nightly backup, alerts). */
  disableSchedulers: boolean;
  /** Cloud only: the key shop servers sync with (their Settings → Cloud "shop key"). */
  syncKey: string;
  /**
   * The Windows install folder, set by the installer in config.env. Only an installed shop server
   * installs software updates itself; empty everywhere else.
   */
  installDir: string;
  /** GitHub repository whose releases carry the shop installer ("owner/name"). */
  updateRepo: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error('DATABASE_URL is not set. Copy apps/server/.env.example to .env.');
  const pinSecret = env.PIN_SECRET ?? '';
  if (pinSecret.length < 16) throw new Error('PIN_SECRET must be at least 16 characters.');
  const mode = (env.APP_MODE ?? 'shop') as AppMode;
  if (mode !== 'shop' && mode !== 'cloud') throw new Error('APP_MODE must be "shop" or "cloud".');
  return {
    databaseUrl,
    directDatabaseUrl: env.DIRECT_DATABASE_URL || env.DATABASE_URL_UNPOOLED || databaseUrl,
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    mode,
    pinSecret,
    dataDir: resolve(env.DATA_DIR ?? './data'),
    pgBinDir: env.PG_BIN_DIR ?? '',
    webDistDir: env.WEB_DIST_DIR ?? builtScreens(),
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    logLevel: env.LOG_LEVEL ?? 'info',
    disableSchedulers: env.DISABLE_SCHEDULERS === '1',
    syncKey: env.SYNC_KEY ?? '',
    installDir: env.ARUNA_INSTALL_DIR ?? '',
    updateRepo: env.UPDATE_REPO || 'KING-UPE/Aruna_Paint',
  };
}

/**
 * The built screens (apps/web/dist) next to the server in this folder, so a shop server started
 * with `pnpm start` serves them to every PC without WEB_DIST_DIR. Empty when they aren't built.
 */
function builtScreens(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const found = [resolve('../web/dist'), resolve(here, '../../web/dist')].find((d) =>
    existsSync(join(d, 'index.html')),
  );
  return found ?? '';
}
