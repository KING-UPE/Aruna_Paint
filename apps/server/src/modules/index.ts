import type { FastifyInstance } from 'fastify';
import { supplierRoutes } from './suppliers/routes';
import { productRoutes } from './products/routes';
import { purchaseRoutes } from './purchases/routes';
import { mixPaintRoutes } from './mixpaint/routes';
import { stockRoutes } from './stock/routes';

/** Stock, billing and system routes. */
export async function registerModuleRoutes(app: FastifyInstance): Promise<void> {
  await app.register(supplierRoutes);
  await app.register(productRoutes);
  await app.register(purchaseRoutes);
  await app.register(mixPaintRoutes);
  await app.register(stockRoutes);
}
