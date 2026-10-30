import { formatDateTime } from '@aruna/shared';
import { useQuery } from '@tanstack/react-query';
import { CloudOff, Cloud } from 'lucide-react';
import { toast } from 'sonner';
import { Select } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';

interface Shops {
  items: { id: string; name: string; signedIn: boolean }[];
  current: string | null;
}

/**
 * The online panel's top bar: which shop you are looking at, how fresh its data is ("as of the
 * last sync"), and a switch to another shop (its own sign-in is kept).
 */
export function CloudBar() {
  const shops = useQuery({
    queryKey: ['cloud-shops'],
    queryFn: () => api.get<Shops>('/api/cloud/shops', { passive: true }),
  });
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: () =>
      api.get<{ sync: { online: boolean; lastSyncedAt: string | null } }>('/api/system/status', {
        passive: true,
      }),
    refetchInterval: 15_000,
  });
  const sync = status.data?.sync;
  const switchTo = async (shopId: string) => {
    try {
      await api.post('/api/cloud/switch', { shopId });
      // Every screen reloads for the other shop (or its sign-in, the first time).
      window.location.assign('/');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-accent-soft px-4 py-1.5 text-sm md:px-6">
      <span className="font-semibold text-accent-strong">Online panel</span>
      {shops.data && shops.data.items.length > 1 ? (
        <span className="w-64">
          <Select
            aria-label="Shop"
            className="h-8 text-sm"
            value={shops.data.current ?? ''}
            onChange={(e) => void switchTo(e.target.value)}
          >
            {shops.data.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </span>
      ) : (
        <span className="font-medium">
          {shops.data?.items.find((s) => s.id === shops.data?.current)?.name}
        </span>
      )}
      {sync ? (
        <span className="flex items-center gap-1.5 text-muted">
          {sync.online ? <Cloud size={14} aria-hidden /> : <CloudOff size={14} aria-hidden />}
          {sync.lastSyncedAt
            ? `Data as of ${formatDateTime(sync.lastSyncedAt)}${sync.online ? '' : ' · the shop is offline'}`
            : 'Waiting for the shop’s first sync'}
        </span>
      ) : null}
    </div>
  );
}
