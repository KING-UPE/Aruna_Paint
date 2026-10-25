import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt from Node itself: no native module to build on the shop's Windows PC.
// The cost is stored in each hash, so tests can use a cheaper one without breaking old hashes.
const N = Number(process.env.ARUNA_SCRYPT_N ?? 16384);
const R = 8;
const P = 1;
const KEYLEN = 64;

function scryptAsync(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const key = await scryptAsync(
    password,
    salt,
    Number(parts[1]),
    Number(parts[2]),
    Number(parts[3]),
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * PINs are 4–6 digits and unique per user, so a PIN alone tells us who is switching in.
 * An HMAC with the server's secret keeps them unreadable from a database copy while still
 * allowing a unique index and a direct lookup.
 */
export function pinHmac(pin: string, secret: string): string {
  return createHmac('sha256', secret).update(`pin:${pin}`).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Recovery codes like "K7QF-29XM-PL4D", printed once at setup. */
export function newRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) {
    s += alphabet[bytes[i]! % alphabet.length];
    if (i === 3 || i === 7) s += '-';
  }
  return s;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
