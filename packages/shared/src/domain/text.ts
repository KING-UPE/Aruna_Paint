import { DomainError } from '../errors';

/** Names are unique ignoring capital letters and extra spaces. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Codes are unique ignoring capital letters and spaces. */
export function codeKey(code: string): string {
  return code.replace(/\s+/g, '').toUpperCase();
}

/** Trims and collapses inner spaces for display names. */
export function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * Phone numbers are 10 digits starting with 0, or +94; stored in one format (0XXXXXXXXX).
 * Returns null when the number is not valid.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, '');
  let local: string;
  if (/^\+94\d{9}$/.test(digits)) local = `0${digits.slice(3)}`;
  else if (/^94\d{9}$/.test(digits)) local = `0${digits.slice(2)}`;
  else if (/^0\d{9}$/.test(digits)) local = digits;
  else return null;
  return local;
}

export function requirePhone(input: string, field = 'phone'): string {
  const p = normalizePhone(input);
  if (!p)
    throw new DomainError(
      'VALIDATION',
      'Phone numbers are 10 digits starting with 0, or +94.',
      field,
    );
  return p;
}

/** Search text for codes and names: "thin 4" finds "Thinner 4L" regardless of word order. */
export function searchTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}
