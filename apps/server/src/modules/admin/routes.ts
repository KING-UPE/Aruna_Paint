import {
  DEFAULT_NUMBER_FORMATS,
  DOC_TYPE_LABELS,
  DOC_TYPES,
  DomainError,
  SETTINGS_SCHEMAS,
  codeKey,
  idSchema,
  paginationSchema,
  renderNumber,
  validateNumberFormat,
  type DocType,
  type SettingsKey,
} from '@aruna/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { perm, shopOnly } from '../../auth/guard';
import { audit } from '../../core/audit';
import { actorOf } from '../../core/context';
import { TX_OPTIONS } from '../../db';

const printerSchema = z.discriminatedUnion('driver', [
  z.object({ driver: z.literal('none') }),
  z.object({
    driver: z.literal('network'),
    host: z.string().min(1),
    port: z.number().int().default(9100),
  }),
  z.object({ driver: z.literal('file'), path: z.string().default('') }),
  z.object({ driver: z.literal('windows-share'), share: z.string().min(1) }),
]);

const counterSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Za-z0-9]+$/),
  name: z.string().min(1).max(60),
  locationId: idSchema,
  printer: printerSchema.default({ driver: 'none' }),
  active: z.boolean().default(true),
});

export async function adminRoutes(app: FastifyInstance) {
  const { db, settings, events } = app.deps;

  // ---- Settings (Super Admin) ----
  app.get('/api/settings', { preHandler: perm('settings.view') }, async () => settings.getAll());

  app.put(
    '/api/settings/:key',
    { preHandler: [shopOnly(), perm('settings.edit')] },
    async (req) => {
      const { key } = req.params as { key: string };
      if (!(key in SETTINGS_SCHEMAS)) throw new DomainError('NOT_FOUND', 'Unknown settings group.');
      const k = key as SettingsKey;
      const before = await settings.get(k);
      const saved = await db.$transaction(async (tx) => {
        const value = await settings.set(tx, k, req.body);
        await audit(tx, actorOf(req.ctx), {
          action: 'settings.update',
          entity: 'settings',
          entityId: k,
          before,
          after: value,
        });
        return value;
      }, TX_OPTIONS);
      events.publish({ type: 'settings' });
      return saved;
    },
  );

  // ---- Number formats (letters allowed) ----
  app.get('/api/number-formats', { preHandler: perm('settings.view') }, async () => {
    const rows = await db.numberFormat.findMany();
    const byType = new Map(rows.map((r) => [r.docType, r.format]));
    return {
      items: DOC_TYPES.map((docType) => {
        const format = byType.get(docType) ?? DEFAULT_NUMBER_FORMATS[docType];
        return {
          docType,
          label: DOC_TYPE_LABELS[docType],
          format,
          example: renderNumber(format, {
            date: new Date(),
            seq: 1,
            counter: 'C1',
            location: 'SHOP',
          }),
        };
      }),
    };
  });

  app.put(
    '/api/number-formats/:docType',
    { preHandler: [shopOnly(), perm('settings.edit')] },
    async (req) => {
      const { docType } = req.params as { docType: string };
      if (!(DOC_TYPES as readonly string[]).includes(docType))
        throw new DomainError('NOT_FOUND', 'Unknown document type.');
      const { format } = z.object({ format: z.string().min(1).max(60) }).parse(req.body);
      const problems = validateNumberFormat(docType as DocType, format);
      if (problems.length) throw new DomainError('VALIDATION', problems.join(' '), 'format');
      await db.$transaction(async (tx) => {
        const before = await tx.numberFormat.findUnique({ where: { docType } });
        await tx.numberFormat.upsert({
          where: { docType },
          create: { docType, format },
          update: { format },
        });
        await audit(tx, actorOf(req.ctx), {
          action: 'number_format.update',
          entity: 'number_format',
          entityId: docType,
          before: before?.format ?? null,
          after: format,
        });
      }, TX_OPTIONS);
      return { ok: true };
    },
  );

  // ---- Counters ----
  // Signed-in users need the list to pick a counter on a billing PC.
  app.get('/api/counters', async () => ({
    items: await db.counter.findMany({ include: { location: true }, orderBy: { code: 'asc' } }),
  }));

  app.post('/api/counters', { preHandler: [shopOnly(), perm('settings.edit')] }, async (req) => {
    const input = counterSchema.parse(req.body);
    return db.$transaction(async (tx) => {
      const c = await tx.counter.create({
        data: {
          ...input,
          code: codeKey(input.code),
          printer: input.printer as Prisma.InputJsonValue,
        },
      });
      await audit(tx, actorOf(req.ctx), {
        action: 'counter.create',
        entity: 'counter',
        entityId: c.id,
        after: c,
      });
      return c;
    }, TX_OPTIONS);
  });

  app.patch(
    '/api/counters/:id',
    { preHandler: [shopOnly(), perm('settings.edit')] },
    async (req) => {
      const id = idSchema.parse((req.params as { id: string }).id);
      const input = counterSchema.partial().parse(req.body);
      return db.$transaction(async (tx) => {
        const before = await tx.counter.findUniqueOrThrow({ where: { id } });
        const c = await tx.counter.update({
          where: { id },
          data: {
            ...input,
            code: input.code ? codeKey(input.code) : undefined,
            printer: input.printer ? (input.printer as Prisma.InputJsonValue) : undefined,
          },
        });
        await audit(tx, actorOf(req.ctx), {
          action: 'counter.update',
          entity: 'counter',
          entityId: id,
          before,
          after: c,
        });
        return c;
      }, TX_OPTIONS);
    },
  );

  // ---- Audit log: read-only, filterable and exportable ----
  app.get('/api/audit-log', { preHandler: perm('audit_log.view') }, async (req) => {
    const q = paginationSchema
      .extend({
        userId: idSchema.optional(),
        entity: z.string().optional(),
        entityId: z.string().optional(),
        action: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(req.query);
    const where: Prisma.AuditLogWhereInput = {
      ...(q.userId ? { OR: [{ userId: q.userId }, { approverId: q.userId }] } : {}),
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.from || q.to
        ? {
            at: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        include: { user: { select: { fullName: true } }, approver: { select: { fullName: true } } },
        orderBy: { at: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      db.auditLog.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  });
}
