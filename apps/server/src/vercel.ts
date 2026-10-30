import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { loadConfig } from './config';

let app: Promise<FastifyInstance> | null = null;

/**
 * The online panel on Vercel: one function answers every /api request with the same Fastify app
 * the shop runs (Vercel serves the screens itself). The app is built once per running instance.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  app ??= buildApp({ ...loadConfig(), webDistDir: '' }).then(async (a) => {
    await a.ready();
    return a;
  });
  (await app).server.emit('request', req, res);
}
