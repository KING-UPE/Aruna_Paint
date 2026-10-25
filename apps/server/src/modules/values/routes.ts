import { DomainError, idSchema } from '@aruna/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { perm, shopOnly } from '../../auth/guard';
import { resetLocationCache } from '../../auth/session';
import { actorOf } from '../../core/context';
import { TX_OPTIONS } from '../../db';
import {
  createValue,
  deleteValue,
  isValueList,
  listValues,
  mergeValues,
  updateValue,
  type ValueList,
} from './service';

function listParam(req: FastifyRequest): ValueList {
  const { list } = req.params as { list: string };
  if (!isValueList(list)) throw new DomainError('NOT_FOUND', 'Unknown list.');
  return list;
}

/** Only the Super Admin adds or changes shops and warehouses. */
function assertLocationsAllowed(req: FastifyRequest, list: ValueList) {
  if (list === 'locations' && !req.ctx.permissions.has('settings.edit')) {
    throw new DomainError('FORBIDDEN', 'Only the Super Admin manages shops and warehouses.');
  }
}

export async function valueRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  // Every signed-in user needs the lists to fill dropdowns.
  app.get('/api/values/:list', async (req) => {
    const list = listParam(req);
    const { includeInactive } = z
      .object({ includeInactive: z.coerce.boolean().default(false) })
      .parse(req.query);
    return { items: await listValues(db, list, includeInactive) };
  });

  app.post(
    '/api/values/:list',
    { preHandler: [shopOnly(), perm('values.create')] },
    async (req) => {
      const list = listParam(req);
      assertLocationsAllowed(req, list);
      const row = await db.$transaction(
        (tx) => createValue(tx, actorOf(req.ctx), list, req.body),
        TX_OPTIONS,
      );
      if (list === 'locations') resetLocationCache();
      return row;
    },
  );

  app.patch(
    '/api/values/:list/:id',
    { preHandler: [shopOnly(), perm('values.edit')] },
    async (req) => {
      const list = listParam(req);
      assertLocationsAllowed(req, list);
      const id = idSchema.parse((req.params as { id: string }).id);
      const row = await db.$transaction(
        (tx) => updateValue(tx, actorOf(req.ctx), list, id, req.body),
        TX_OPTIONS,
      );
      if (list === 'locations') resetLocationCache();
      return row;
    },
  );

  app.delete(
    '/api/values/:list/:id',
    { preHandler: [shopOnly(), perm('values.edit')] },
    async (req) => {
      const list = listParam(req);
      assertLocationsAllowed(req, list);
      const id = idSchema.parse((req.params as { id: string }).id);
      await db.$transaction((tx) => deleteValue(tx, actorOf(req.ctx), list, id), TX_OPTIONS);
      return { ok: true };
    },
  );

  app.post(
    '/api/values/:list/:id/merge',
    { preHandler: [shopOnly(), perm('values.edit')] },
    async (req) => {
      const list = listParam(req);
      const id = idSchema.parse((req.params as { id: string }).id);
      const { intoId } = z.object({ intoId: idSchema }).parse(req.body);
      return db.$transaction(
        (tx) => mergeValues(tx, actorOf(req.ctx), list, id, intoId),
        TX_OPTIONS,
      );
    },
  );

  /** Each list has its own order. */
  app.put(
    '/api/values/:list/order',
    { preHandler: [shopOnly(), perm('values.edit')] },
    async (req) => {
      const list = listParam(req);
      assertLocationsAllowed(req, list);
      const { ids } = z.object({ ids: z.array(idSchema).min(1) }).parse(req.body);
      await db.$transaction(async (tx) => {
        for (const [i, id] of ids.entries())
          await updateValue(tx, actorOf(req.ctx), list, id, { sortOrder: i + 1 });
      }, TX_OPTIONS);
      return { ok: true };
    },
  );
}
