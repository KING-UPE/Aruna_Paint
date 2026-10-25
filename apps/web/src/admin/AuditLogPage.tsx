import { formatDateTime } from '@aruna/shared';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { DataTable } from '@/components/DataTable';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';
import { api, qs } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import type { Page } from '@/lib/types';

interface AuditRow {
  id: string;
  at: string;
  action: string;
  entity: string;
  entityId: string | null;
  note: string;
  ip: string;
  before: unknown;
  after: unknown;
  user: { fullName: string } | null;
  approver: { fullName: string } | null;
}

const columns: ColumnDef<AuditRow, unknown>[] = [
  { header: 'When', cell: (c) => formatDateTime(c.row.original.at) },
  { header: 'Who', cell: (c) => c.row.original.user?.fullName ?? '—' },
  { header: 'Approved by', cell: (c) => c.row.original.approver?.fullName ?? '' },
  { header: 'Action', cell: (c) => <span className="font-medium">{c.row.original.action}</span> },
  { header: 'Record', cell: (c) => c.row.original.entity },
  { header: 'Note', cell: (c) => <span className="text-muted">{c.row.original.note}</span> },
];

/** Who, when, which record, and the values before and after. Read-only. */
export function AuditLogPage() {
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<AuditRow | null>(null);
  const term = useDebounced(action, 250);
  const q = useQuery({
    queryKey: ['audit', term, from, to, page],
    queryFn: () =>
      api.get<Page<AuditRow>>(
        `/api/audit-log${qs({ action: term, from: from ? `${from}T00:00:00+05:30` : '', to: to ? `${to}T23:59:59+05:30` : '', page, pageSize: 100 })}`,
      ),
  });
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / 100));
  return (
    <div className="flex h-full flex-col gap-3">
      <PageHeader
        title="Audit log"
        description="Every create, edit, price change, override, reprint, void, return and login."
      />
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Action starts with, e.g. sale.void"
          value={action}
          onChange={(e) => (setAction(e.target.value), setPage(1))}
          className="w-72"
        />
        <Input
          type="date"
          aria-label="From"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-40"
        />
        <Input
          type="date"
          aria-label="To"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-40"
        />
      </div>
      <DataTable
        className="min-h-0 flex-1"
        data={q.data?.items ?? []}
        columns={columns}
        loading={q.isLoading}
        rowKey={(r) => r.id}
        onOpen={setOpen}
      />
      <div className="flex items-center justify-end gap-2 text-sm">
        <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </Button>
        <span>
          Page {page} of {pages}
        </span>
        <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Next
        </Button>
      </div>
      <Dialog
        open={Boolean(open)}
        onOpenChange={(o) => (!o ? setOpen(null) : undefined)}
        title={open?.action ?? ''}
        description={open ? `${formatDateTime(open.at)} · ${open.user?.fullName ?? ''}` : ''}
        className="max-w-3xl"
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <div className="mb-1 text-sm font-medium">Before</div>
            <pre className="max-h-96 overflow-auto rounded bg-surface-2 p-2 text-xs">
              {JSON.stringify(open?.before, null, 2)}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-sm font-medium">After</div>
            <pre className="max-h-96 overflow-auto rounded bg-surface-2 p-2 text-xs">
              {JSON.stringify(open?.after, null, 2)}
            </pre>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
