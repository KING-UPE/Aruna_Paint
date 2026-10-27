import { formatDate } from '@aruna/shared';
import { FilePlus2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { DataTable } from '@/components/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Money, PageHeader } from '@/components/ui/misc';
import { api, qs } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import type { Page } from '@/lib/types';

interface PurchaseRow {
  id: string;
  no: string;
  status: 'DRAFT' | 'POSTED' | 'REVERSED';
  date: string;
  supplier: { code: string; name: string };
  supplierInvoiceNo: string;
  lines: number;
  netTotal: string;
  due: string;
}

const columns: ColumnDef<PurchaseRow, unknown>[] = [
  { header: 'GRN', cell: (c) => <span className="font-medium">{c.row.original.no}</span> },
  { header: 'Date', cell: (c) => formatDate(c.row.original.date) },
  { header: 'Supplier', cell: (c) => c.row.original.supplier.name },
  { header: 'Invoice', accessorKey: 'supplierInvoiceNo' },
  {
    header: 'Status',
    cell: (c) => {
      const s = c.row.original.status;
      return (
        <Badge tone={s === 'POSTED' ? 'ok' : s === 'DRAFT' ? 'warn' : 'danger'}>
          {s.toLowerCase()}
        </Badge>
      );
    },
  },
  { header: 'Lines', meta: { num: true }, accessorKey: 'lines' },
  {
    header: 'Net total',
    meta: { num: true },
    cell: (c) => <Money value={c.row.original.netTotal} />,
  },
  { header: 'Due', meta: { num: true }, cell: (c) => <Money value={c.row.original.due} /> },
];

export function PurchasesPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const term = useDebounced(q, 200);
  const list = useQuery({
    queryKey: ['purchases', term, status],
    queryFn: () =>
      api.get<Page<PurchaseRow>>(`/api/purchases${qs({ q: term, status, pageSize: 200 })}`),
  });
  return (
    <div className="flex h-full flex-col gap-3">
      <PageHeader
        title="Purchases (GRN)"
        description="Drafts change nothing; posting adds stock and the supplier balance."
      >
        {can('purchases.create') ? (
          <Button
            variant="primary"
            icon={<FilePlus2 size={16} />}
            onClick={() => void nav('/stock/purchases/new')}
          >
            New GRN
          </Button>
        ) : null}
      </PageHeader>
      <div className="flex gap-2">
        <Input
          autoFocus
          placeholder="GRN or supplier invoice no"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-72"
        />
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-40"
        >
          <option value="">All</option>
          <option value="DRAFT">Drafts</option>
          <option value="POSTED">Posted</option>
          <option value="REVERSED">Reversed</option>
        </Select>
      </div>
      <DataTable
        className="min-h-0 flex-1"
        data={list.data?.items ?? []}
        columns={columns}
        loading={list.isLoading}
        rowKey={(r) => r.id}
        onOpen={(r) => void nav(`/stock/purchases/${r.id}`)}
      />
    </div>
  );
}
