import { formatDateTime, formatMoney } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Check, CloudOff, Cloud, RefreshCw, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { useConfirm } from '@/components/AskDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import { EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

interface Conflict {
  table: string;
  field: string;
  was: unknown;
  online: unknown;
  shop: unknown;
}

interface Command {
  id: string;
  createdAt: string;
  createdByName: string;
  route: string;
  summary: string;
  status: 'PENDING' | 'APPLIED' | 'CONFLICT' | 'FAILED' | 'DISCARDED';
  decision: 'APPLY' | 'DISCARD' | null;
  decidedByName: string;
  message: string;
  conflicts: Conflict[] | null;
  processedAt: string | null;
}

interface Machine {
  id: string;
  name: string;
  /** The shop this panel is looking at now. */
  current: boolean;
  today: { bills: number; total: string };
  lastSeenAt: string | null;
  lastPushAt: string | null;
  waiting: number;
  version: string;
  counters: { code: string; name: string; lastBillAt: string | null }[];
}

type Status =
  | {
      mode: 'shop';
      agent: {
        linked: boolean;
        url: string;
        online: boolean;
        lastSyncAt: string | null;
        lastError: string;
        waiting: number;
      };
      commands: Command[];
    }
  | { mode: 'cloud'; nodes: Machine[]; commands: Command[] };

/** What an online change did, in words (from its audit entries). */
const ACTIONS: Record<string, string> = {
  'user.create': 'New user',
  'user.update': 'User changed',
  'user.delete': 'User removed',
  'user.reset_password': 'Password reset',
  'user.reset_pin': 'PIN reset',
  'user.clear_pin': 'PIN cleared',
  'password.change': 'Own password changed',
  'testmode.user_on': 'Put in test mode',
  'testmode.user_off': 'Back to real data',
  'role.create': 'New role',
  'role.update': 'Role changed',
  'role.reset': 'Role set back to default',
  'role.delete': 'Role removed',
  'settings.update': 'Settings changed',
  'number_format.update': 'Number format changed',
  'value.create': 'Value added',
  'value.update': 'Value changed',
  'value.delete': 'Value removed',
  'value.merge': 'Values merged',
  'product.update': 'Product changed',
  'product.rename': 'Product renamed',
  'price.change': 'Prices changed',
  'sub_product.update': 'Sub-product changed',
  'supplier.update': 'Supplier changed',
  'supplier.rep_add': 'Sales rep added',
  'hrm.update': 'HRM changed',
  'counter.create': 'New counter',
  'counter.update': 'Counter changed',
  'backup.manual': 'Backup asked for',
  'testmode.refresh': 'Fresh test copy asked for',
};

const what = (c: Command) => {
  const words = [
    ...new Set(
      c.summary
        .split(', ')
        .filter(Boolean)
        .map((a) => ACTIONS[a] ?? a),
    ),
  ];
  return words.join(', ') || c.route;
};

const STATUS: Record<
  Command['status'],
  { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' }
> = {
  PENDING: { label: 'Waiting for the shop', tone: 'neutral' },
  APPLIED: { label: 'Applied at the shop', tone: 'ok' },
  CONFLICT: { label: 'Conflict', tone: 'warn' },
  FAILED: { label: 'Not applied', tone: 'danger' },
  DISCARDED: { label: 'Shop version kept', tone: 'neutral' },
};

/** "10 s ago", "5 min ago", or the date and time. */
function ago(iso: string | null) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(1, s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return formatDateTime(iso);
}

const show = (v: unknown) =>
  v === null || v === undefined || v === ''
    ? '—'
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v);
const fieldName = (f: string) => (f ? f.replace(/_/g, ' ') : 'the whole row');
const TABLES: Record<string, string> = {
  users: 'User',
  roles: 'Role',
  suppliers: 'Supplier',
  supplier_reps: 'Sales rep',
  products: 'Product',
  sub_products: 'Sub-product',
  settings: 'Settings',
  categories: 'Category',
  brands: 'Brand',
  units: 'Unit',
  number_formats: 'Number format',
};
const tableName = (t: string) => TABLES[t] ?? t.replace(/_/g, ' ');

/**
 * Cloud sync. At the shop: is this server linked and online, when it last synced, what waits.
 * Online: each shop server and its counters with their last sync. At both: the changes made
 * online and what the shop did with them; a conflict waits for the Super Admin.
 */
export function SyncPage() {
  const { me } = useAuth();
  const superAdmin = me.roles.includes('SUPER_ADMIN');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => api.get<Status>('/api/sync/status', { passive: true }),
    refetchInterval: 15_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['sync-status'] });
  // Look at another shop: its own sign-in, the first time.
  const openShop = async (shopId: string) => {
    try {
      await api.post('/api/cloud/switch', { shopId });
      window.location.assign('/admin/sync');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const s = await api.post<{ online: boolean; lastError: string }>('/api/sync/now', {});
      if (s.online) toast.success('Synced with the cloud.');
      else toast.error(s.lastError || 'The cloud could not be reached.');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (c: Command, action: 'APPLY' | 'DISCARD') => {
    const ok = await confirm(
      action === 'APPLY'
        ? {
            title: 'Use the online change?',
            message: 'The online value replaces what was changed at the shop.',
            confirmLabel: 'Use online change',
          }
        : {
            title: 'Keep the shop version?',
            message: 'The online change is dropped, and the online panel shows the shop again.',
            confirmLabel: 'Keep shop version',
          },
    );
    if (!ok) return;
    try {
      await api.post(`/api/sync/commands/${c.id}/resolve`, { action });
      toast.success(me.mode === 'cloud' ? 'Saved. The shop follows at its next sync.' : 'Done.');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (q.isLoading) return <Spinner />;
  const s = q.data;
  if (!s) return null;
  const conflicts = s.commands.filter((c) => c.status === 'CONFLICT');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Cloud sync"
        description={
          s.mode === 'shop'
            ? 'The shop works fully offline. Its changes go up to the cloud when the internet is on, and changes made online come down.'
            : 'Everything here is the shop as of its last sync. Only the Super Admin changes things online (users, permissions, settings, counters, backups, HRM figures), and they reach the shop when it next connects.'
        }
      >
        {s.mode === 'shop' && s.agent.linked ? (
          <Button icon={<RefreshCw size={16} />} disabled={busy} onClick={() => void syncNow()}>
            {busy ? 'Syncing…' : 'Sync now'}
          </Button>
        ) : null}
      </PageHeader>

      {s.mode === 'shop' ? (
        <Card>
          <CardHeader>
            <CardTitle>This shop server</CardTitle>
          </CardHeader>
          <CardBody className="grid gap-3 text-[15px] md:grid-cols-4">
            {!s.agent.linked ? (
              <p className="text-muted md:col-span-4">
                Not linked to a cloud yet. Enter the cloud address and shop key in{' '}
                <Link to="/admin/settings" className="font-medium text-accent-strong underline">
                  Settings → Cloud mirror
                </Link>
                .
              </p>
            ) : (
              <>
                <Stat label="Now">
                  {s.agent.online ? (
                    <Badge tone="ok">
                      <Cloud size={13} className="mr-1 inline" /> Online
                    </Badge>
                  ) : (
                    <Badge tone="warn">
                      <CloudOff size={13} className="mr-1 inline" /> Offline
                    </Badge>
                  )}
                </Stat>
                <Stat label="Last sync">
                  {ago(s.agent.lastSyncAt)}
                  {s.agent.lastSyncAt ? (
                    <div className="text-xs text-muted">{formatDateTime(s.agent.lastSyncAt)}</div>
                  ) : null}
                </Stat>
                <Stat label="Changes waiting to go up">{s.agent.waiting}</Stat>
                <Stat label="Cloud">{s.agent.url}</Stat>
                {s.agent.lastError ? (
                  <p className="text-sm text-danger md:col-span-4">{s.agent.lastError}</p>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Shops</CardTitle>
            <span className="text-sm text-muted">Each shop as of its last sync</span>
          </CardHeader>
          {s.nodes.length ? (
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Shop</th>
                  <th className="px-4 py-2.5 font-medium">Now</th>
                  <th className="px-4 py-2.5 font-medium">Last sync</th>
                  <th className="px-4 py-2.5 font-medium">Today</th>
                  <th className="px-4 py-2.5 font-medium">Waiting at the shop</th>
                  <th className="px-4 py-2.5 font-medium">Counters (last bill)</th>
                  <th className="px-4 py-2.5 font-medium">Version</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {s.nodes.map((n) => {
                  const live =
                    n.lastSeenAt && Date.now() - new Date(n.lastSeenAt).getTime() < 60_000;
                  return (
                    <tr key={n.id} className="border-t border-border align-top">
                      <td className="px-4 py-2.5 font-medium">
                        {n.name}
                        {n.current ? (
                          <Badge tone="accent" className="ml-2">
                            Looking at
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        {live ? (
                          <Badge tone="ok">Online</Badge>
                        ) : (
                          <Badge tone="warn">Offline · seen {ago(n.lastSeenAt)}</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {ago(n.lastPushAt)}
                        {n.lastPushAt ? (
                          <div className="text-xs text-muted">{formatDateTime(n.lastPushAt)}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        {n.today.bills} bills · Rs {formatMoney(n.today.total)}
                      </td>
                      <td className="num px-4 py-2.5">{n.waiting}</td>
                      <td className="px-4 py-2.5">
                        {n.counters.map((c) => (
                          <div key={c.code}>
                            {c.code} · {c.name}:{' '}
                            <span className="text-muted">
                              {c.lastBillAt ? formatDateTime(c.lastBillAt) : 'no bills yet'}
                            </span>
                          </div>
                        ))}
                      </td>
                      <td className="px-4 py-2.5 text-muted">v{n.version}</td>
                      <td className="px-4 py-2.5 text-right">
                        {!n.current ? (
                          <IconButton
                            label={`Open ${n.name}`}
                            icon={<ArrowRightLeft size={16} />}
                            onClick={() => void openShop(n.id)}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <CardBody>
              <EmptyState title="No shop has synced yet." />
            </CardBody>
          )}
        </Card>
      )}

      {conflicts.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Conflicts to decide ({conflicts.length})</CardTitle>
            <span className="text-sm text-muted">
              The same thing was changed online and at the shop while they weren&apos;t talking.
            </span>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            {conflicts.map((c) => (
              <div key={c.id} className="rounded-[10px] border border-warn/40 bg-warn-soft/40 p-3">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {what(c)} · online by {c.createdByName || 'someone'},{' '}
                    {formatDateTime(c.createdAt)}
                  </span>
                  {c.decision ? (
                    <Badge>
                      {c.decision === 'APPLY' ? 'Use online change' : 'Keep shop version'} chosen by{' '}
                      {c.decidedByName}; the shop follows at its next sync
                    </Badge>
                  ) : null}
                </div>
                <table className="mb-3 w-full text-sm">
                  <thead className="text-left text-muted">
                    <tr>
                      <th className="py-1 pr-3 font-medium">What</th>
                      <th className="py-1 pr-3 font-medium">Before</th>
                      <th className="py-1 pr-3 font-medium">Online</th>
                      <th className="py-1 font-medium">At the shop</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(c.conflicts ?? []).map((x, i) => (
                      <tr key={i} className="border-t border-border/60">
                        <td className="py-1 pr-3">
                          {tableName(x.table)}: {fieldName(x.field)}
                        </td>
                        <td className="py-1 pr-3 text-muted">{show(x.was)}</td>
                        <td className="py-1 pr-3 font-medium">{show(x.online)}</td>
                        <td className="py-1 font-medium">{show(x.shop)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {superAdmin && !c.decision ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Check size={15} />}
                      onClick={() => void resolve(c, 'APPLY')}
                    >
                      Use online change
                    </Button>
                    <Button
                      size="sm"
                      icon={<Undo2 size={15} />}
                      onClick={() => void resolve(c, 'DISCARD')}
                    >
                      Keep shop version
                    </Button>
                  </div>
                ) : !superAdmin ? (
                  <p className="text-sm text-muted">The Super Admin decides which one to keep.</p>
                ) : null}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Changes made online</CardTitle>
          <span className="text-sm text-muted">The last 50</span>
        </CardHeader>
        {s.commands.length ? (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">By</th>
                <th className="px-4 py-2.5 font-medium">What</th>
                <th className="px-4 py-2.5 font-medium">At the shop</th>
              </tr>
            </thead>
            <tbody>
              {s.commands.map((c) => (
                <tr key={c.id} className="border-t border-border align-top">
                  <td className="px-4 py-2.5 whitespace-nowrap">{formatDateTime(c.createdAt)}</td>
                  <td className="px-4 py-2.5">{c.createdByName || '—'}</td>
                  <td className="px-4 py-2.5">{what(c)}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                    {c.processedAt && c.status !== 'PENDING' ? (
                      <span className="ml-2 text-xs text-muted">
                        {formatDateTime(c.processedAt)}
                      </span>
                    ) : null}
                    {c.message ? <div className="mt-1 text-xs text-muted">{c.message}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <CardBody>
            <EmptyState title="Nothing has been changed online yet." />
          </CardBody>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-0.5 font-medium">{children}</div>
    </div>
  );
}
