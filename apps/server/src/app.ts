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
import { TestModeService } from './core/testmode';
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
  overrides: Partial<Deps> = {},
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
  };
  await testMode.start();
  app.decorate('deps', deps);
  app.setErrorHandler(errorHandler);

  // Every request starts on the real data; the session hook moves test-mode users to the copy.
  app.addHook('onRequest', (_req, _reply, done) => runInScope(done));
  await app.register(cookie);
  await app.register(websocket);
  registerSessionHook(app);

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

  if (!config.disableSchedulers) deps.backups.startScheduler();

  app.addHook('onClose', async () => {
    await deps.backups.close();
    await testMode.close();
    await production.$disconnect();
  });

  return app;
}
