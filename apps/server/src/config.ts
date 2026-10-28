import { resolve } from 'node:path';

export type AppMode = 'shop' | 'cloud';

export interface AppConfig {
  databaseUrl: string;
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
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    mode,
    pinSecret,
    dataDir: resolve(env.DATA_DIR ?? './data'),
    pgBinDir: env.PG_BIN_DIR ?? '',
    webDistDir: env.WEB_DIST_DIR ?? '',
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    logLevel: env.LOG_LEVEL ?? 'info',
    disableSchedulers: env.DISABLE_SCHEDULERS === '1',
  };
}
