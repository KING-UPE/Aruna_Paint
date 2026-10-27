import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import * as D from '@radix-ui/react-dialog';
import { useAuth } from '@/auth/AuthProvider';
import { navItems } from '@/layout/nav';
import { api, qs } from '@/lib/api';
import type { Page, SaleListItem, StockListItem, Supplier } from '@/lib/types';
import { useHotkeys } from './keymap';

/** Ctrl+K: jump to any screen, product, supplier or bill. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const nav = useNavigate();
  const { can } = useAuth();
  useHotkeys('global', { palette: () => setOpen((o) => !o) }, { inDialog: true });
  const term = search.trim();
  const canStock = can('products.view', 'stock.view');
  const canSuppliers = can('suppliers.view');
  const canBills = can('bill_history.view');

  const products = useQuery({
    queryKey: ['palette-products', term],
    queryFn: () => api.get<Page<StockListItem>>(`/api/products${qs({ q: term, pageSize: 6 })}`),
    enabled: open && canStock && term.length >= 2,
  });
  const suppliers = useQuery({
    queryKey: ['palette-suppliers', term],
    queryFn: () => api.get<{ items: Supplier[] }>(`/api/suppliers${qs({ q: term, limit: 5 })}`),
    enabled: open && canSuppliers && term.length >= 2,
  });
  const bills = useQuery({
    queryKey: ['palette-bills', term],
    queryFn: () => api.get<Page<SaleListItem>>(`/api/sales${qs({ q: term, pageSize: 5 })}`),
    enabled: open && canBills && /\d/.test(term),
  });

  const go = (to: string) => {
    setOpen(false);
    setSearch('');
    void nav(to);
  };

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <D.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-xl">
          <D.Title className="sr-only">Command palette</D.Title>
          <D.Description className="sr-only">
            Jump to a screen, product, supplier or bill
          </D.Description>
          <Command shouldFilter={false} label="Command palette" className="flex flex-col">
            <Command.Input
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder="Go to a screen, or find a product, supplier or bill…"
              className="h-12 border-b border-border bg-transparent px-4 text-[15px] outline-none"
            />
            <Command.List className="max-h-[50vh] overflow-y-auto p-2">
              <Command.Empty className="p-4 text-sm text-muted">Nothing found.</Command.Empty>
              <Command.Group
                heading="Screens"
                className="text-xs text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {navItems
                  .filter((n) => n.perms.some((p) => can(p)))
                  .filter((n) => !term || n.label.toLowerCase().includes(term.toLowerCase()))
                  .map((n) => (
                    <PaletteItem
                      key={n.to}
                      onSelect={() => go(n.to)}
                      label={n.label}
                      meta={n.section}
                    />
                  ))}
              </Command.Group>
              {products.data?.items.length ? (
                <Command.Group
                  heading="Products"
                  className="text-xs text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
                >
                  {products.data.items.map((p) => (
                    <PaletteItem
                      key={p.id}
                      onSelect={() => go(`/stock/products/${p.id}`)}
                      label={`${p.code} · ${p.name}`}
                      meta={`${p.stock} ${p.unit.name}`}
                    />
                  ))}
                </Command.Group>
              ) : null}
              {suppliers.data?.items.length ? (
                <Command.Group
                  heading="Suppliers"
                  className="text-xs text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
                >
                  {suppliers.data.items.map((s) => (
                    <PaletteItem
                      key={s.id}
                      onSelect={() => go(`/stock/suppliers/${s.id}`)}
                      label={`${s.code} · ${s.name}`}
                      meta={`Rs ${s.balance}`}
                    />
                  ))}
                </Command.Group>
              ) : null}
              {bills.data?.items.length ? (
                <Command.Group
                  heading="Bills"
                  className="text-xs text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
                >
                  {bills.data.items.map((b) => (
                    <PaletteItem
                      key={b.id}
                      onSelect={() => go(`/billing/history?open=${b.id}`)}
                      label={b.no ?? 'Held bill'}
                      meta={`Rs ${b.netTotal}`}
                    />
                  ))}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function PaletteItem({
  label,
  meta,
  onSelect,
}: {
  label: string;
  meta?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[15px] text-text data-[selected=true]:bg-selected"
    >
      <span>{label}</span>
      {meta ? <span className="text-sm text-muted">{meta}</span> : null}
    </Command.Item>
  );
}
