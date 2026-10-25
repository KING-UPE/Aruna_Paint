import { Prisma } from '@prisma/client';
import { DomainError, type ApiErrorBody, type ErrorCode } from '@aruna/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export { DomainError };

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  PASSWORD_CHANGE_REQUIRED: 403,
  FORBIDDEN: 403,
  APPROVAL_REQUIRED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE: 409,
  IN_USE: 409,
  INVALID_STATE: 409,
  MONTH_CLOSED: 409,
  LOCKED: 423,
  INSUFFICIENT_STOCK: 422,
  BELOW_COST: 422,
  DISCOUNT_ABOVE_LIMIT: 422,
  PRICE_ABOVE_R_PRICE: 422,
  INTERNAL: 500,
};

export function notFound(what: string): DomainError {
  return new DomainError('NOT_FOUND', `${what} not found.`);
}

export function invalid(message: string, field?: string): DomainError {
  return new DomainError('VALIDATION', message, field);
}

function body(
  code: ErrorCode,
  message: string,
  field?: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  return { error: { code, message, ...(field ? { field } : {}), ...(details ? { details } : {}) } };
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof DomainError) {
    return reply.status(STATUS[err.code]).send(body(err.code, err.message, err.field, err.details));
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.join('.') || undefined;
    return reply.status(400).send(
      body('VALIDATION', first?.message ?? 'Check the highlighted fields.', field, {
        issues: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      }),
    );
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | string | undefined) ?? '';
      return reply.status(409).send(body('DUPLICATE', 'That already exists.', String(target)));
    }
    if (err.code === 'P2025') return reply.status(404).send(body('NOT_FOUND', 'Record not found.'));
    if (err.code === 'P2003')
      return reply.status(409).send(body('IN_USE', 'That record is linked to others.'));
  }
  const pgCode = extractPgCode(err);
  if (pgCode === '23514') {
    req.log.warn({ err }, 'check constraint blocked a write');
    return reply
      .status(422)
      .send(body('VALIDATION', 'That change would make a quantity or price invalid.'));
  }
  if (pgCode === '23001') {
    return reply
      .status(409)
      .send(body('INVALID_STATE', 'History records cannot be changed or deleted.'));
  }
  const fe = err as FastifyError;
  if (fe.validation || fe.statusCode === 400) {
    return reply.status(400).send(body('VALIDATION', fe.message));
  }
  if (fe.statusCode && fe.statusCode < 500) {
    return reply.status(fe.statusCode).send(body('VALIDATION', fe.message));
  }
  req.log.error({ err }, 'unhandled error');
  return reply.status(500).send(body('INTERNAL', 'Something went wrong. The error was logged.'));
}

function extractPgCode(err: unknown): string | undefined {
  const anyErr = err as { code?: string; meta?: { code?: string }; message?: string };
  if (anyErr.meta?.code) return anyErr.meta.code;
  const m = /SqlState\(E?(\w{5})\)|code: "(\w{5})"|Code: `(\w{5})`/.exec(anyErr.message ?? '');
  return m?.[1] ?? m?.[2] ?? m?.[3];
}
