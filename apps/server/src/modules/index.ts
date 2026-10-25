import type { FastifyInstance } from 'fastify';
import { supplierRoutes } from './suppliers/routes';
import { productRoutes } from './products/routes';
import { purchaseRoutes } from './purchases/routes';
import { mixPaintRoutes } from './mixpaint/routes';
import { stockRoutes } from './stock/routes';
import { salesRoutes } from './sales/routes';
import { shiftRoutes } from './shifts/routes';
import { systemRoutes } from './system/routes';

/** Stock, billing and system routes. */
export async function registerModuleRoutes(app: FastifyInstance): Promise<void> {
  await app.register(supplierRoutes);
  await app.register(productRoutes);
  await app.register(purchaseRoutes);
  await app.register(mixPaintRoutes);
  await app.register(stockRoutes);
  await app.register(salesRoutes);
  await app.register(shiftRoutes);
  await app.register(systemRoutes);
}
