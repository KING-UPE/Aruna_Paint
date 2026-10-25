import type { ApiErrorBody, ErrorCode } from '@aruna/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly field?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** A warning the user can confirm and resend (similar name, duplicate invoice, advance). */
  get isWarning(): boolean {
    return this.details?.warning === true;
  }
}

type Listener = (err: ApiError) => void;
const listeners = new Set<Listener>();

/** Session-level errors (logged out, locked, password change) are handled in one place. */
export function onSessionError(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export interface RequestOptions {
  /** Background polls don't count as activity, so the idle lock still works. */
  passive?: boolean;
  signal?: AbortSignal;
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.passive ? { 'x-passive': '1' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const e = (data as ApiErrorBody | null)?.error;
    const err = new ApiError(
      res.status,
      e?.code ?? 'INTERNAL',
      e?.message ?? `Request failed (${res.status})`,
      e?.field,
      e?.details,
    );
    if (
      err.code === 'UNAUTHENTICATED' ||
      err.code === 'LOCKED' ||
      err.code === 'PASSWORD_CHANGE_REQUIRED'
    ) {
      if (
        !url.startsWith('/api/auth/login') &&
        !url.startsWith('/api/auth/pin') &&
        !url.startsWith('/api/auth/unlock')
      ) {
        for (const fn of listeners) fn(err);
      }
    }
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(url: string, opts?: RequestOptions) => request<T>('GET', url, undefined, opts),
  post: <T>(url: string, body: unknown = {}, opts?: RequestOptions) =>
    request<T>('POST', url, body, opts),
  put: <T>(url: string, body: unknown = {}, opts?: RequestOptions) =>
    request<T>('PUT', url, body, opts),
  patch: <T>(url: string, body: unknown = {}, opts?: RequestOptions) =>
    request<T>('PATCH', url, body, opts),
  delete: <T>(url: string, opts?: RequestOptions) => request<T>('DELETE', url, undefined, opts),
};

/** Builds "?a=1&b=2", skipping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Message for a toast or a form: the server already writes plain words. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
