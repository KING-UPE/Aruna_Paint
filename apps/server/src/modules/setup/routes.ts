import type { FastifyInstance } from 'fastify';
import { createSession } from '../../auth/session';
import { needsSetup, runSetup } from './service';

export async function setupRoutes(app: FastifyInstance) {
  const { db, config, settings } = app.deps;

  /** Public: also the shop's colour theme, so the login screen already wears it. */
  app.get('/api/setup/status', { config: { public: true } }, async () => ({
    needsSetup: await needsSetup(db),
    mode: config.mode,
    appearance: await settings.get('appearance'),
  }));

  /** First-run wizard. Works only while no user exists. */
  app.post('/api/setup', { config: { public: true } }, async (req, reply) => {
    const result = await runSetup(db, config, req.body as never);
    const counter = await db.counter.findFirst({ orderBy: { createdAt: 'asc' } });
    await createSession(app, reply, req, result.adminId, counter?.id ?? null);
    return { recoveryCodes: result.recoveryCodes, counterCode: counter?.code ?? null };
  });
}
