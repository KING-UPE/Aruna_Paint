import { formatQty } from '@aruna/shared';
import { ChevronLeft, ChevronRight, PackagePlus, PaintBucket, Pencil } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { DataTable } from '@/components/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { EmptyState, PageHeader } from '@/components/ui/misc';
import { useValues } from '@/components/values';
import { useHotkeys } from '@/keyboard/keymap';
import { api, qs } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import type { Page, StockListItem, Supplier } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ProductForm } from './ProductForm';
import { ProductNamesDialog } from './ProductNamesDialog';

const baseColumns: ColumnDef<StockListItem, unknown>[] = [
  {
    header: 'Code',
    accessorKey: 'code',
    cell: (c) => <span className="font-medium">{c.row.original.code}</span>,
  },
  {
    header: 'Name',
    accessorKey: 'name',
    cell: (c) => (
      <span>
        {c.row.original.name}
        {c.row.original.type === 'MIX' ? (
          <Badge tone="accent" className="ml-2">
            Mix paint
          </Badge>
        ) : null}
        {!c.row.original.active ? <Badge className="ml-2">Inactive</Badge> : null}
      </span>
    ),
  },
  { header: 'Category', cell: (c) => c.row.original.category?.name ?? '' },
  { header: 'Brand', cell: (c) => c.row.original.brand?.name ?? '' },
  {
    header: 'Stock',
    meta: { num: true },
    cell: (c) => (
      <span>
        {formatQty(c.row.original.stock)} {c.row.original.unit.name}
      </span>
    ),
  },
  {
    header: 'State',
    cell: (c) =>
      c.row.original.outOfStock ? (
        <Badge tone="danger">Out of stock</Badge>
      ) : c.row.original.lowStock ? (
        <Badge tone="warn">Low stock</Badge>
      ) : (
        <Badge tone="ok">In stock</Badge>
      ),
  },
];

/** The stock view: main products with total stock; Enter opens their sub-products. */
export function ProductsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [editingId, setEditingId] = useState<string | null>(null);
  const columns = useMemo<ColumnDef<StockListItem, unknown>[]>(
    () =>
      can('products.edit')
        ? [
            ...baseColumns,
            {
              id: 'actions',
              header: () => <span className="sr-only">Edit</span>,
              cell: (c) => (
                <div className="flex justify-end">
                  <IconButton
                    label={`Edit ${c.row.original.code} · ${c.row.original.name}`}
                    icon={<Pencil size={16} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(c.row.original.id);
                    }}
                  />
                </div>
              ),
            },
          ]
        : baseColumns,
    [can],
  );
  const [q, setQ] = useState('');
  const [f, setF] = useState({
    categoryId: '',
    brandId: '',
    supplierId: '',
    locationId: '',
    lowStock: false,
    outOfStock: false,
    expiring: false,
    includeInactive: false,
  });
  const [page, setPage] = useState(1);
  const [stockTab, setStockTab] = useState<'STANDARD' | 'MIX' | 'ALL'>('STANDARD');
  const [creating, setCreating] = useState(false);
  const term = useDebounced(q, 200);
  const categories = useValues('categories');
  const brands = useValues('brands');
  const locations = useValues('locations');
  const suppliers = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () => api.get<{ items: Supplier[] }>('/api/suppliers'),
    enabled: can('suppliers.view'),
  });
  const list = useQuery({
    queryKey: ['products', term, f, stockTab, page],
    queryFn: () =>
      api.get<Page<StockListItem>>(
        `/api/products${qs({
          q: term,
          categoryId: f.categoryId,
          brandId: f.brandId,
          supplierId: f.supplierId,
          locationId: f.locationId,
          lowStock: f.lowStock,
          outOfStock: f.outOfStock,
          expiringDays: f.expiring ? 60 : undefined,
          includeInactive: f.includeInactive,
          type: stockTab === 'ALL' ? undefined : stockTab,
          page,
          pageSize: 100,
        })}`,
      ),
  });
  useHotkeys('global', { filter: () => document.getElementById('product-search')?.focus() });
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 100));
  const set = (k: keyof typeof f, v: string | boolean) => {
    setF({ ...f, [k]: v });
    setPage(1);
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <PageHeader
        title="Products and stock"
        description="Enter opens an item's sub-products, stock per location and bin card."
      >
        <div className="flex items-center gap-2">
          {can('mix_paint.view') ? (
            <Button
              variant="ghost"
              icon={<PaintBucket size={16} />}
              onClick={() => nav('/stock/mix-paint')}
            >
              Transfer cans to mix
            </Button>
          ) : null}
          {can('products.create') ? (
            <Button
              variant="primary"
              icon={<PackagePlus size={16} />}
              onClick={() => setCreating(true)}
            >
              New product
            </Button>
          ) : null}
        </div>
      </PageHeader>

      <div className="flex items-center justify-between gap-4">
        <div className="flex w-fit items-center rounded-lg border border-border bg-surface-2 p-1">
          <button
            type="button"
            onClick={() => {
              setStockTab('STANDARD');
              setPage(1);
            }}
            className={cn(
              'flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition',
              stockTab === 'STANDARD'
                ? 'bg-surface text-text shadow-sm'
                : 'text-muted hover:text-text',
            )}
          >
            Standard stock
          </button>
          <button
            type="button"
            onClick={() => {
              setStockTab('MIX');
              setPage(1);
            }}
            className={cn(
              'flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition',
              stockTab === 'MIX'
                ? 'bg-surface text-primary shadow-sm'
                : 'text-muted hover:text-text',
            )}
          >
            Mix paint stock
          </button>
          <button
            type="button"
            onClick={() => {
              setStockTab('ALL');
              setPage(1);
            }}
            className={cn(
              'flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition',
              stockTab === 'ALL' ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text',
            )}
          >
            All stock
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="product-search"
          autoFocus
          placeholder="Search code, name or brand (Ctrl+F)"
          value={q}
          onChange={(e) => (setQ(e.target.value), setPage(1))}
          className="w-72"
        />
        <Select
          aria-label="Category"
          value={f.categoryId}
          onChange={(e) => set('categoryId', e.target.value)}
          className="w-40"
        >
          <option value="">All categories</option>
          {categories.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Brand"
          value={f.brandId}
          onChange={(e) => set('brandId', e.target.value)}
          className="w-36"
        >
          <option value="">All brands</option>
          {brands.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {suppliers.data ? (
          <Select
            aria-label="Supplier"
            value={f.supplierId}
            onChange={(e) => set('supplierId', e.target.value)}
            className="w-44"
          >
            <option value="">All suppliers</option>
            {suppliers.data.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Select
          aria-label="Location"
          value={f.locationId}
          onChange={(e) => set('locationId', e.target.value)}
          className="w-36"
        >
          <option value="">All locations</option>
          {locations.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {(
          [
            ['lowStock', 'Low stock'],
            ['outOfStock', 'Out of stock'],
            ['expiring', 'Expiring soon'],
            ['includeInactive', 'Inactive too'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="flex items-center gap-1.5 text-sm">
            <Checkbox checked={f[k]} onChange={(e) => set(k, e.target.checked)} /> {label}
          </label>
        ))}
      </div>
      <DataTable
        className="min-h-0 flex-1"
        data={items}
        columns={columns}
        loading={list.isLoading}
        rowKey={(r) => r.id}
        onOpen={(r) => void nav(`/stock/products/${r.id}`)}
        empty={
          <EmptyState
            title={
              stockTab === 'MIX'
                ? 'No mix paint items match.'
                : stockTab === 'STANDARD'
                  ? 'No standard products match.'
                  : 'No products match.'
            }
            action={
              stockTab === 'MIX' && can('mix_paint.create')
                ? 'Transfer whole cans into mix paint to stock it.'
                : can('products.create')
                  ? 'Add one with New product.'
                  : undefined
            }
          />
        }
      />
      {pages > 1 ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <IconButton
            label="Previous page"
            icon={<ChevronLeft size={18} />}
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          />
          <span>
            Page {page} of {pages}
          </span>
          <IconButton
            label="Next page"
            icon={<ChevronRight size={18} />}
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          />
        </div>
      ) : null}
      <ProductNamesDialog productId={editingId} onClose={() => setEditingId(null)} />
      <ProductForm
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(p) => void nav(`/stock/products/${p.product.id}`)}
      />
    </div>
  );
}
