import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import type { AppConfig } from './config';
import { createPrisma } from './db';
import type { Deps } from './deps';
import { BackupService } from './core/backups';
import { EventBus } from './core/events';
import { SettingsService } from './core/settings';
import { inTestData, runInScope, scopedDb } from './core/dbscope';
import { SyncAgent, type SyncTransport } from './core/syncagent';
import type { RowChange } from './core/syncapply';
import { TestModeService } from './core/testmode';
import { registerCloudCapture } from './modules/sync/cloud';
import { APP_VERSION } from './modules/system/routes';
import { errorHandler } from './lib/errors';
import { PrintService } from './printing/service';
import { registerSessionHook, resetLocationCache } from './auth/session';
import { authRoutes } from './auth/routes';
import { setupRoutes } from './modules/setup/routes';
import { valueRoutes } from './modules/values/routes';
import { userRoutes } from './modules/users/routes';
import { adminRoutes } from './modules/admin/routes';
import { registerModuleRoutes } from './modules';

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
  }
}

export async function buildApp(
  config: AppConfig,
  overrides: Partial<Deps> & { syncTransport?: SyncTransport } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  const production = overrides.db ?? createPrisma(config.databaseUrl);
  const events = overrides.events ?? new EventBus();
  // Set just below; the callback only runs later, when a copy is made or a user switched.
  let settings: SettingsService;
  const testMode = new TestModeService(production, config, () => {
    settings.invalidate();
    resetLocationCache();
    events.publish({ type: 'testmode' });
  });
  // Routes keep this one client; per request it is the real data, or the test copy for a user
  // in test mode (core/dbscope.ts).
  const db = scopedDb(production, () => testMode.current());
  settings = overrides.settings ?? new SettingsService(db);
  const deps: Deps = {
    db,
    config,
    settings,
    events,
    printer: overrides.printer ?? new PrintService(db, config, inTestData),
    backups: overrides.backups ?? new BackupService(db, config, settings, inTestData),
    testMode,
    // The shop server syncs with the cloud; the cloud only answers.
    sync:
      config.mode === 'shop'
        ? new SyncAgent(
            production,
            settings,
            APP_VERSION,
            (changes) => void afterOnlineChange(changes),
            overrides.syncTransport,
          )
        : null,
  };
  /** Online changes reached the shop: fresh settings, screens reload, a first test user gets a copy. */
  async function afterOnlineChange(changes: RowChange[]) {
    settings.invalidate();
    resetLocationCache();
    events.publish({ type: 'testmode' });
    const switchedOn = changes.filter(
      (c) => c.table === 'users' && c.data?.test_mode === true && c.old?.test_mode !== true,
    ).length;
    if (switchedOn && (await production.user.count({ where: { testMode: true } })) === switchedOn)
      await testMode.rebuild().catch(() => undefined);
  }
  await testMode.start();
  app.decorate('deps', deps);
  app.setErrorHandler(errorHandler);

  // Every request starts on the real data; the session hook moves test-mode users to the copy.
  app.addHook('onRequest', (_req, _reply, done) => runInScope(done));
  await app.register(cookie);
  await app.register(websocket);
  registerSessionHook(app);
  if (config.mode === 'cloud') registerCloudCapture(app);

  app.get('/api/health', { config: { public: true } }, async () => ({
    ok: true,
    mode: config.mode,
    time: new Date(),
  }));

  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(valueRoutes);
  await app.register(userRoutes);
  await app.register(adminRoutes);
  await registerModuleRoutes(app);

  // In production the shop server also serves the built screens to every PC on the LAN.
  if (config.webDistDir && existsSync(config.webDistDir)) {
    // Wildcard serving picks up files from a new build without a restart; unknown paths fall
    // through to index.html so the screens' own routes work on reload.
    await app.register(fastifyStatic, { root: config.webDistDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      }
      return reply.sendFile('index.html');
    });
  }

  if (!config.disableSchedulers && config.mode === 'shop') {
    deps.backups.startScheduler();
    deps.sync?.start();
  }

  app.addHook('onClose', async () => {
    await deps.sync?.close();
    await deps.backups.close();
    await testMode.close();
    await production.$disconnect();
  });

  return app;
}
