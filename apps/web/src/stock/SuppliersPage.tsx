import { formatRs } from '@aruna/shared';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { DataTable } from '@/components/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/input';
import { Money, PageHeader } from '@/components/ui/misc';
import { api, qs } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import type { Supplier } from '@/lib/types';
import { SupplierForm } from './SupplierForm';

const columns: ColumnDef<Supplier, unknown>[] = [
  {
    header: 'Code',
    accessorKey: 'code',
    cell: (c) => <span className="font-medium">{c.row.original.code}</span>,
  },
  {
    header: 'Name',
    cell: (c) => (
      <span>
        {c.row.original.name} {!c.row.original.active ? <Badge>Inactive</Badge> : null}
      </span>
    ),
  },
  { header: 'Phones', cell: (c) => c.row.original.phones.join(', ') },
  { header: 'Credit days', meta: { num: true }, accessorKey: 'creditDays' },
  { header: 'Balance', meta: { num: true }, cell: (c) => <Money value={c.row.original.balance} /> },
];

export function SuppliersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [inactive, setInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const term = useDebounced(q, 200);
  const list = useQuery({
    queryKey: ['suppliers', term, inactive],
    queryFn: () =>
      api.get<{ items: Supplier[] }>(`/api/suppliers${qs({ q: term, includeInactive: inactive })}`),
  });
  const items = list.data?.items ?? [];
  const owed = items.reduce((s, x) => s + Number(x.balance), 0);
  return (
    <div className="flex h-full flex-col gap-3">
      <PageHeader
        title="Suppliers"
        description={`The shop owes ${formatRs(owed)} in total. Enter opens the activity log.`}
      >
        {can('suppliers.create') ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            New supplier
          </Button>
        ) : null}
      </PageHeader>
      <div className="flex items-center gap-3">
        <Input
          autoFocus
          placeholder="Search code, name or phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-80"
        />
        <label className="flex items-center gap-1.5 text-sm">
          <Checkbox checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Inactive
          too
        </label>
      </div>
      <DataTable
        className="min-h-0 flex-1"
        data={items}
        columns={columns}
        loading={list.isLoading}
        rowKey={(r) => r.id}
        onOpen={(r) => void nav(`/stock/suppliers/${r.id}`)}
      />
      <SupplierForm open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
