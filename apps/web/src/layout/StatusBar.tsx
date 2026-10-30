import { formatDate, formatDateTime, formatRs, formatTime } from '@aruna/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { api } from '@/lib/api';
import type { BillingStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

interface SystemStatus {
  version: string;
  sync: {
    linked: boolean;
    online: boolean;
    pending: number;
    lastSyncedAt: string | null;
    lastError: string;
  };
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

/** "10 s ago", "5 min ago", "3 h ago", or the date and time. */
function ago(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(1, s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return formatDateTime(iso);
}

/**
 * At the shop: "Online · synced 10 s ago" or "Offline · 128 changes waiting · last sync 3 h ago".
 * Online: when the shop last synced.
 */
export function SyncStatus({
  sync,
  cloud,
}: {
  sync: SystemStatus['sync'] | undefined;
  cloud: boolean;
}) {
  if (!sync) return null;
  const last = sync.lastSyncedAt ? ago(sync.lastSyncedAt) : 'never';
  const text = cloud
    ? sync.online
      ? `Shop online · synced ${last}`
      : `Shop offline · last sync ${last}`
    : !sync.linked
      ? `Cloud not linked · ${sync.pending} changes waiting`
      : sync.online
        ? `Online · synced ${last}`
        : `Offline · ${sync.pending} changes waiting · last sync ${last}`;
  return (
    <span className="flex items-center gap-1.5" title={sync.lastError || undefined}>
      <span
        className={cn('h-2 w-2 rounded-full', sync.linked && sync.online ? 'bg-ok' : 'bg-warn')}
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
        <SyncStatus sync={system.data?.sync} cloud={me.mode === 'cloud'} />
        <span>{me.user.fullName}</span>
        <span>v{system.data?.version ?? ''}</span>
      </span>
    </footer>
  );
}
