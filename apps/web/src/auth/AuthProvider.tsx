import type { Permission } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { api, ApiError, onSessionError } from '@/lib/api';
import type { Me } from '@/lib/types';

interface AuthValue {
  me: Me;
  can: (...perms: Permission[]) => boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** Loads the signed-in user; null means "show the login screen". */
export function useMeQuery() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/api/auth/me', { passive: true });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

export function AuthProvider({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const set = useMemo(() => new Set(me.permissions), [me.permissions]);
  const can = useCallback((...perms: Permission[]) => perms.some((p) => set.has(p)), [set]);
  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
  }, [qc]);
  const value = useMemo(() => ({ me, can, refresh }), [me, can, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Logged out, locked or a password change: the server says so on any request. */
export function useSessionErrors() {
  const qc = useQueryClient();
  useEffect(
    () =>
      onSessionError((err) => {
        if (err.code === 'UNAUTHENTICATED') qc.setQueryData(['me'], null);
        else if (err.code === 'LOCKED')
          qc.setQueryData<Me | null>(['me'], (m) => (m ? { ...m, locked: true } : m));
        else void qc.invalidateQueries({ queryKey: ['me'] });
      }),
    [qc],
  );
}

/**
 * The screen locks after the set idle time; the server enforces it too. Any key or click
 * counts as activity.
 */
export function useIdleLock(minutes: number, locked: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (locked) return;
    let last = Date.now();
    const bump = () => {
      last = Date.now();
    };
    window.addEventListener('keydown', bump, true);
    window.addEventListener('pointerdown', bump, true);
    const t = window.setInterval(() => {
      if (Date.now() - last > minutes * 60_000) {
        void api
          .post('/api/auth/lock', {})
          .finally(() =>
            qc.setQueryData<Me | null>(['me'], (m) => (m ? { ...m, locked: true } : m)),
          );
      }
    }, 10_000);
    return () => {
      window.removeEventListener('keydown', bump, true);
      window.removeEventListener('pointerdown', bump, true);
      window.clearInterval(t);
    };
  }, [minutes, locked, qc]);
}
