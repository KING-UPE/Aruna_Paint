import { DomainError } from '../errors';

/** The shop's time zone; bill dates, day ends and number formats use it. */
export const SHOP_TIME_ZONE = 'Asia/Colombo';

export const DOC_TYPES = [
  'SUPPLIER',
  'PURCHASE',
  'INVOICE',
  'QUOTATION',
  'SALES_RETURN',
  'PURCHASE_RETURN',
  'SUPPLIER_PAYMENT',
  'TRANSFER',
  'MP_TRANSFER',
  'ADJUSTMENT',
  'STOCK_COUNT',
  'REORDER',
  'DAY_END',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/**
 * Starting formats. Tokens are in braces so letters stay literal:
 * {NNNN} sequence padded to the number of N, {YYYY} {YY} {MM} {DD} date, {COUNTER} counter code,
 * {LOC} location code. The Super Admin can change every format, letters included.
 */
export const DEFAULT_NUMBER_FORMATS: Record<DocType, string> = {
  SUPPLIER: 'SUP-{NNNN}',
  PURCHASE: 'GRN-{YYYY}-{NNNNN}',
  INVOICE: 'INV-{NNNNNN}',
  QUOTATION: 'QT-{NNNNNN}',
  SALES_RETURN: 'SR-{NNNNNN}',
  PURCHASE_RETURN: 'PR-{NNNNNN}',
  SUPPLIER_PAYMENT: 'SP-{NNNNNN}',
  TRANSFER: 'TR-{NNNNNN}',
  MP_TRANSFER: 'MPT-{NNNNNN}',
  ADJUSTMENT: 'ADJ-{NNNNNN}',
  STOCK_COUNT: 'SC-{NNNNNN}',
  REORDER: 'RO-{NNNNNN}',
  DAY_END: 'DE-{YYYY}{MM}{DD}-{COUNTER}',
};

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  SUPPLIER: 'Supplier',
  PURCHASE: 'Purchase (GRN)',
  INVOICE: 'Invoice',
  QUOTATION: 'Quotation',
  SALES_RETURN: 'Sales return',
  PURCHASE_RETURN: 'Purchase return',
  SUPPLIER_PAYMENT: 'Supplier payment',
  TRANSFER: 'Transfer',
  MP_TRANSFER: 'Mix-paint transfer',
  ADJUSTMENT: 'Adjustment',
  STOCK_COUNT: 'Stock count',
  REORDER: 'Reorder list',
  DAY_END: 'Day end',
};

const TOKEN = /\{([A-Z]+)\}/g;
const SEQ = /^N+$/;

export interface NumberContext {
  date: Date;
  counter?: string;
  location?: string;
}

/** Date parts in the shop's time zone. */
export function shopDateParts(date: Date): { yyyy: string; mm: string; dd: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHOP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { yyyy: get('year'), mm: get('month'), dd: get('day') };
}

/** The shop's business date as YYYY-MM-DD. */
export function shopDate(date: Date = new Date()): string {
  const p = shopDateParts(date);
  return `${p.yyyy}-${p.mm}-${p.dd}`;
}

export function formatHasSequence(format: string): boolean {
  for (const m of format.matchAll(TOKEN)) if (m[1] && SEQ.test(m[1])) return true;
  return false;
}

/** Problems with a format the Super Admin typed; empty means it can be saved. */
export function validateNumberFormat(docType: DocType, format: string): string[] {
  const problems: string[] = [];
  if (!format.trim()) problems.push('Format cannot be empty.');
  const outside = format.replace(TOKEN, '');
  if (/[{}]/.test(outside)) problems.push('Every { needs a matching }.');
  if (!/^[A-Za-z0-9\-/_.]*$/.test(outside))
    problems.push('Use letters, digits, - / _ . and tokens only.');
  let seqCount = 0;
  for (const m of format.matchAll(TOKEN)) {
    const t = m[1] ?? '';
    if (SEQ.test(t)) {
      seqCount++;
      if (t.length > 10) problems.push('A number can have at most 10 digits.');
    } else if (!['YYYY', 'YY', 'MM', 'DD', 'COUNTER', 'LOC'].includes(t)) {
      problems.push(`Unknown token {${t}}.`);
    }
  }
  if (docType === 'DAY_END') {
    if (!format.includes('{COUNTER}')) problems.push('A day end number needs {COUNTER}.');
    if (!(format.includes('{DD}') && format.includes('{MM}')))
      problems.push('A day end number needs the date.');
  } else if (seqCount !== 1) {
    problems.push('The format needs exactly one number token, such as {NNNNNN}.');
  }
  return problems;
}

function renderTokens(format: string, ctx: NumberContext, seq: (width: number) => string): string {
  const { yyyy, mm, dd } = shopDateParts(ctx.date);
  return format.replace(TOKEN, (_all, token: string) => {
    if (SEQ.test(token)) return seq(token.length);
    switch (token) {
      case 'YYYY':
        return yyyy;
      case 'YY':
        return yyyy.slice(2);
      case 'MM':
        return mm;
      case 'DD':
        return dd;
      case 'COUNTER':
        return ctx.counter ?? '';
      case 'LOC':
        return ctx.location ?? '';
      default:
        throw new DomainError('VALIDATION', `Unknown token {${token}} in number format.`);
    }
  });
}

/**
 * Each distinct rendering of the non-sequence parts has its own counter, so a format with
 * {YYYY} starts again every year and one with {LOC} counts per location.
 */
export function sequenceScope(format: string, ctx: NumberContext): string {
  return renderTokens(format, ctx, () => '#');
}

export function renderNumber(format: string, ctx: NumberContext & { seq?: number }): string {
  return renderTokens(format, ctx, (width) => String(ctx.seq ?? 0).padStart(width, '0'));
}

// ---------------------------------------------------------------------------
// Product codes
// ---------------------------------------------------------------------------

export const FIRST_MAIN_CODE = 10001;

/** New items get the next free 5-digit code; old codes from the import are kept as they are. */
export function nextMainCode(existingCodes: Iterable<string>): string {
  let max = FIRST_MAIN_CODE - 1;
  for (const c of existingCodes) {
    if (/^\d{5}$/.test(c)) max = Math.max(max, Number(c));
  }
  const next = max + 1;
  if (next > 99999)
    throw new DomainError('CONFLICT', 'All 5-digit codes are used; type a code instead.');
  return String(next);
}

/** 10001 + 2 → "10001-02". */
export function subProductCode(mainCode: string, seq: number): string {
  return `${mainCode}-${String(seq).padStart(2, '0')}`;
}

/** 20001 → "MP-20001". */
export function mixPaintCode(mainCode: string): string {
  return `MP-${mainCode}`;
}

/** "10001-02" → { main: "10001", seq: 2 }; null when the text is not a sub code. */
export function parseSubProductCode(code: string): { main: string; seq: number } | null {
  const m = /^(.+)-(\d{2,})$/.exec(code.trim());
  if (!m?.[1] || !m[2]) return null;
  return { main: m[1], seq: Number(m[2]) };
}
