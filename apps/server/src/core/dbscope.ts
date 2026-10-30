import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../db';

/**
 * Which data one request works on: the real data, or the test copy for a user in test mode. On
 * the online panel: which shop's copy.
 */
interface Scope {
  test: boolean;
  shop: string | null;
}

const scopes = new AsyncLocalStorage<Scope>();

/** Starts a request on the real data; everything the request does later (printing too) inherits it. */
export function runInScope(fn: () => void): void {
  scopes.run({ test: false, shop: null }, fn);
}

/** The session hook calls this for a user in test mode: the rest of the request uses the copy. */
export function useTestData(): void {
  const s = scopes.getStore();
  if (!s) throw new Error('useTestData outside a request scope');
  s.test = true;
}

/** True while the current request belongs to a user in test mode. Jobs without a request: false. */
export function inTestData(): boolean {
  return scopes.getStore()?.test ?? false;
}

/** Runs `fn` on the test copy, for tests and tools that work outside a request. */
export function withTestData<T>(fn: () => Promise<T>): Promise<T> {
  return scopes.run({ test: true, shop: null }, fn);
}

/** Online panel: the rest of the request works on this shop's copy. */
export function useShopData(shopId: string): void {
  const s = scopes.getStore();
  if (!s) throw new Error('useShopData outside a request scope');
  s.shop = shopId;
}

/** The shop this request is about (online panel), or null. */
export function scopeShop(): string | null {
  return scopes.getStore()?.shop ?? null;
}

/** Runs `fn` on one shop's copy (online panel), outside a request. */
export function withShopData<T>(shopId: string, fn: () => Promise<T>): Promise<T> {
  return scopes.run({ test: false, shop: shopId }, fn);
}

/**
 * The database client every route holds. Each call goes to the real database, or to the test copy
 * when the request belongs to a user in test mode, so two counters can work on different data at
 * the same time and routes need no change.
 */
export function scopedDb(
  production: Db,
  testCopy: () => Db | null,
  shopCopy: (id: string) => Db | null = () => null,
): Db {
  return new Proxy({} as Db, {
    get(_target, prop) {
      let target = production;
      const shop = scopeShop();
      if (shop) {
        const copy = shopCopy(shop);
        if (!copy) throw new Error('That shop is not ready.');
        target = copy;
      } else if (inTestData()) {
        const copy = testCopy();
        // Never fall back to the real data: a test bill must not land there.
        if (!copy) throw new Error('The test copy is not ready.');
        target = copy;
      }
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
