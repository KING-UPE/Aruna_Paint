import { formatDateTime, formatMoney, formatRs } from '@aruna/shared';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, PageHeader } from '@/components/ui/misc';
import { api, qs } from '@/lib/api';
import type { Page, ShiftSummary, StockListItem, Supplier } from '@/lib/types';

interface SystemStatus {
  version: string;
  sync: { linked: boolean; pending: number };
  lastBackup: { at: string; kind: string; status: string } | null;
}

/** Today's numbers from the day ends, alerts, supplier dues, low stock, last sync, last backup. */
export function DashboardPage() {
  const { can } = useAuth();
  const shifts = useQuery({
    queryKey: ['shifts-today'],
    queryFn: () => api.get<{ items: ShiftSummary[] }>('/api/shifts'),
    enabled: can('day_end.view'),
  });
  const system = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<SystemStatus>('/api/system/status', { passive: true }),
  });
  const alerts = useQuery({
    queryKey: ['alerts'],
    queryFn: () =>
      api.get<{
        items: { id: string; kind: string; message: string; createdAt: string; severity: string }[];
      }>('/api/alerts'),
  });
  const low = useQuery({
    queryKey: ['products', 'low'],
    queryFn: () =>
      api.get<Page<StockListItem>>(`/api/products${qs({ lowStock: true, pageSize: 10 })}`),
    enabled: can('stock.view', 'products.view'),
  });
  const suppliers = useQuery({
    queryKey: ['suppliers', 'dues'],
    queryFn: () => api.get<{ items: Supplier[] }>('/api/suppliers'),
    enabled: can('suppliers.view'),
  });
  const s = shifts.data?.items ?? [];
  const sales = s.reduce((a, x) => a + Number(x.cashSales), 0);
  const bills = s.reduce((a, x) => a + x.billCount, 0);
  const returns = s.reduce((a, x) => a + Number(x.cashRefunds), 0);
  const drawers = s
    .filter((x) => x.status === 'OPEN')
    .reduce((a, x) => a + Number(x.expectedCash), 0);
  const dues = (suppliers.data?.items ?? []).reduce(
    (a, x) => a + Math.max(0, Number(x.balance)),
    0,
  );
  const cards = [
    { label: "Today's sales", value: formatRs(sales) },
    { label: 'Bills today', value: String(bills) },
    { label: 'Average bill', value: formatRs(bills ? sales / bills : 0) },
    { label: 'Expected cash in drawers', value: formatRs(drawers) },
    { label: 'Returns today', value: formatRs(returns) },
    { label: 'Supplier dues', value: formatRs(dues) },
  ];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Dashboard" description="Charts and full reports arrive in phase 2." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardBody className="p-4">
              <div className="text-sm text-muted">{c.label}</div>
              <div className="num mt-1 text-left text-xl font-bold">{c.value}</div>
            </CardBody>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Alerts</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2 text-sm">
            {(alerts.data?.items ?? []).length === 0 ? (
              <p className="text-muted">No alerts.</p>
            ) : null}
            {(alerts.data?.items ?? []).map((a) => (
              <div key={a.id}>
                <Badge tone={a.severity === 'error' ? 'danger' : 'warn'}>
                  {a.kind.replace(/_/g, ' ').toLowerCase()}
                </Badge>{' '}
                {a.message}
                <div className="text-xs text-muted">{formatDateTime(a.createdAt)}</div>
              </div>
            ))}
            {(low.data?.items ?? []).map((p) => (
              <div key={p.id}>
                <Badge tone="warn">low stock</Badge> {p.code} · {p.name} ({p.stock} {p.unit.name})
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Counters today</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {s.length === 0 ? (
              <EmptyState title="No counter has started the day." />
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {s.map((x) => (
                    <tr key={x.id} className="border-t border-border first:border-t-0">
                      <td className="px-4 py-2">{x.counter.name}</td>
                      <td className="px-4 py-2">
                        {x.status === 'OPEN' ? (
                          <Badge tone="ok">Open</Badge>
                        ) : (
                          <Badge>Closed</Badge>
                        )}
                      </td>
                      <td className="num px-4 py-2">{x.billCount} bills</td>
                      <td className="num px-4 py-2">Rs {formatMoney(x.cashSales)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>System</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-1 text-sm">
            <div>Version {system.data?.version}</div>
            <div>
              Sync: {system.data?.sync.linked ? 'linked' : 'cloud not linked yet'} ·{' '}
              {system.data?.sync.pending ?? 0} changes waiting
            </div>
            <div>
              Last backup:{' '}
              {system.data?.lastBackup ? (
                <>
                  {formatDateTime(system.data.lastBackup.at)} (
                  {system.data.lastBackup.kind.toLowerCase()}){' '}
                  <Badge tone={system.data.lastBackup.status === 'OK' ? 'ok' : 'danger'}>
                    {system.data.lastBackup.status}
                  </Badge>
                </>
              ) : (
                'none yet'
              )}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
