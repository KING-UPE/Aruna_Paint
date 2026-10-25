import {
  DEFAULT_NUMBER_FORMATS,
  formatHasSequence,
  renderNumber,
  sequenceScope,
  type DocType,
} from '@aruna/shared';
import type { Tx } from '../db';
import { uuidv7 } from '../lib/ids';

export interface NumberingContext {
  date?: Date;
  counterCode?: string;
  locationCode?: string;
}

export async function getFormat(tx: Tx, docType: DocType): Promise<string> {
  const row = await tx.numberFormat.findUnique({ where: { docType } });
  return row?.format ?? DEFAULT_NUMBER_FORMATS[docType];
}

/**
 * Takes the next readable number for a document. The counter row is updated inside the caller's
 * transaction, so a rolled-back bill gives its number back and numbers stay gap-free.
 * `exists` lets the caller skip numbers already used (old codes kept on import, or a format change).
 */
export async function nextNumber(
  tx: Tx,
  docType: DocType,
  ctx: NumberingContext = {},
  exists?: (no: string) => Promise<boolean>,
): Promise<string> {
  const format = await getFormat(tx, docType);
  const nctx = {
    date: ctx.date ?? new Date(),
    counter: ctx.counterCode,
    location: ctx.locationCode,
  };
  if (!formatHasSequence(format)) return renderNumber(format, nctx);
  const scope = sequenceScope(format, nctx);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const rows = await tx.$queryRaw<{ last_value: number }[]>`
      INSERT INTO number_sequences (id, doc_type, scope_key, last_value, updated_at)
      VALUES (${uuidv7()}::uuid, ${docType}, ${scope}, 1, now())
      ON CONFLICT (doc_type, scope_key)
      DO UPDATE SET last_value = number_sequences.last_value + 1, updated_at = now()
      RETURNING last_value`;
    const seq = rows[0]!.last_value;
    const no = renderNumber(format, { ...nctx, seq });
    if (!exists || !(await exists(no))) return no;
  }
  throw new Error(`Could not find a free ${docType} number`);
}

/** What the next number will probably be, without taking it (for the billing screen's top bar). */
export async function peekNumber(
  tx: Tx,
  docType: DocType,
  ctx: NumberingContext = {},
): Promise<string> {
  const format = await getFormat(tx, docType);
  const nctx = {
    date: ctx.date ?? new Date(),
    counter: ctx.counterCode,
    location: ctx.locationCode,
  };
  if (!formatHasSequence(format)) return renderNumber(format, nctx);
  const scope = sequenceScope(format, nctx);
  const row = await tx.numberSequence.findUnique({
    where: { docType_scopeKey: { docType, scopeKey: scope } },
  });
  return renderNumber(format, { ...nctx, seq: (row?.lastValue ?? 0) + 1 });
}
