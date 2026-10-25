import { formatDate, formatRs, formatTime } from '@aruna/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { api } from '@/lib/api';
import type { BillingStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

interface SystemStatus {
  version: string;
  sync: { linked: boolean; pending: number; lastSyncedAt: string | null };
  serverTime: string;
}

export function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** "Online · synced 10 s ago" or "Offline · 128 changes waiting". */
export function SyncStatus({ sync }: { sync: SystemStatus['sync'] | undefined }) {
  if (!sync) return null;
  const text = !sync.linked
    ? `Cloud not linked · ${sync.pending} changes waiting`
    : sync.lastSyncedAt
      ? `Online · synced ${Math.max(1, Math.round((Date.now() - new Date(sync.lastSyncedAt).getTime()) / 1000))} s ago`
      : `Offline · ${sync.pending} changes waiting`;
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          sync.linked && sync.lastSyncedAt ? 'bg-ok' : 'bg-warn',
        )}
        aria-hidden
      />
      {text}
    </span>
  );
}

/** Bottom bar: date, live time, this counter's sales today, sync status, counter and version. */
export function StatusBar({ billing }: { billing?: BillingStatus | undefined }) {
  const { me } = useAuth();
  const now = useClock();
  const system = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<SystemStatus>('/api/system/status', { passive: true }),
    refetchInterval: 15_000,
  });
  // A wrong PC clock changes bill dates: warn when it is more than 2 minutes off the server.
  const skew = system.data ? Math.abs(new Date(system.data.serverTime).getTime() - Date.now()) : 0;
  const hour12 = me.settings.timeFormat === '12h';
  return (
    <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-border bg-surface px-4 py-2 text-sm text-muted">
      <span className="num">
        {new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Asia/Colombo' }).format(
          now,
        )}{' '}
        {formatDate(now)} · {formatTime(now, hour12)}
      </span>
      {billing ? (
        <span className="font-medium text-text">
          Today: {formatRs(billing.today.total)} · {billing.today.bills} bills
        </span>
      ) : null}
      {skew > 120_000 ? (
        <span className="font-medium text-warn">
          PC clock is {Math.round(skew / 60_000)} min off the server
        </span>
      ) : null}
      <span className="flex items-center gap-4">
        <SyncStatus sync={system.data?.sync} />
        <span>{me.user.fullName}</span>
        <span>v{system.data?.version ?? ''}</span>
      </span>
    </footer>
  );
}
