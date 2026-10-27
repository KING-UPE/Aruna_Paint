import {
  Coins,
  FileText,
  History,
  LayoutDashboard,
  LogOut,
  Package,
  Paintbrush,
  Receipt,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sliders,
  Truck,
  User,
  Users,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { arrowNav } from '@/lib/arrowNav';
import { useQueryClient } from '@tanstack/react-query';

export function MenuPage() {
  const { me, can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();

  const handleLogout = async () => {
    await api.post('/api/auth/logout', {}).finally(() => qc.setQueryData(['me'], null));
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 py-2" onKeyDown={arrowNav}>
      {/* Welcome Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-xl font-bold text-accent-text">
            A
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-text">{me.settings.shopName}</h1>
            <p className="text-sm text-muted">{me.location?.name ?? 'Main Shop'}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-sm font-semibold">{me.user.fullName}</div>
            <div className="text-xs text-muted">{me.roles.join(', ')}</div>
          </div>
          <Button variant="ghost" onClick={() => void handleLogout()} title="Log Out">
            <LogOut size={16} />
          </Button>
        </div>
      </div>

      {/* Main Billing Counter Banner if allowed */}
      {can('billing.view', 'quotations.view') && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border-2 border-accent bg-accent-soft/40 p-5">
          <div className="flex items-center gap-3.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-text">
              <Receipt size={22} />
            </div>
            <div>
              <div className="text-base font-bold text-accent-strong">Billing & Point of Sale</div>
              <div className="text-sm text-muted">
                Fast keyboard-driven cash billing, quotations, barcodes and receipts
              </div>
            </div>
          </div>
          <Button variant="primary" onClick={() => void nav('/billing')} className="px-5 font-bold">
            Open Billing Screen →
          </Button>
        </div>
      )}

      {/* Navigation Sections Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Billing Group */}
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-bold uppercase tracking-wider text-accent-strong">
            <Receipt size={16} /> Billing Operations
          </div>
          <div className="flex flex-col gap-2">
            {can('billing.view', 'quotations.view') && (
              <Link
                to="/billing"
                className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
              >
                <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                  <Receipt size={18} />
                </div>
                <div>
                  <div className="font-semibold text-text group-hover:text-accent-strong">
                    Point of Sale (Billing)
                  </div>
                  <div className="text-xs text-muted">
                    Full-screen register for cash sales & quotes
                  </div>
                </div>
              </Link>
            )}

            {can('bill_history.view') && (
              <Link
                to="/billing/history"
                className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
              >
                <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                  <History size={18} />
                </div>
                <div>
                  <div className="font-semibold text-text group-hover:text-accent-strong">
                    Bill History
                  </div>
                  <div className="text-xs text-muted">
                    Lookup past invoices, quotations, reprints & voids
                  </div>
                </div>
              </Link>
            )}

            {can('day_end.view') && (
              <Link
                to="/billing/day-end"
                className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
              >
                <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                  <FileText size={18} />
                </div>
                <div>
                  <div className="font-semibold text-text group-hover:text-accent-strong">
                    Day End Register
                  </div>
                  <div className="text-xs text-muted">
                    Daily closing, cash count & day-end reports
                  </div>
                </div>
              </Link>
            )}
          </div>
        </div>

        {/* Stock Group */}
        {(can('products.view', 'stock.view') ||
          can('purchases.view') ||
          can('suppliers.view') ||
          can('mix_paint.view')) && (
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
            <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-bold uppercase tracking-wider text-accent-strong">
              <Package size={16} /> Stock & Inventory
            </div>
            <div className="flex flex-col gap-2">
              {can('products.view', 'stock.view') && (
                <Link
                  to="/stock/products"
                  className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
                >
                  <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                    <Package size={18} />
                  </div>
                  <div>
                    <div className="font-semibold text-text group-hover:text-accent-strong">
                      Products & Stock
                    </div>
                    <div className="text-xs text-muted">
                      Catalog, batch pricing, bin cards & ledger
                    </div>
                  </div>
                </Link>
              )}

              {can('purchases.view') && (
                <Link
                  to="/stock/purchases"
                  className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
                >
                  <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                    <ShoppingBag size={18} />
                  </div>
                  <div>
                    <div className="font-semibold text-text group-hover:text-accent-strong">
                      Purchases (GRN)
                    </div>
                    <div className="text-xs text-muted">
                      Goods received notes & supplier invoices
                    </div>
                  </div>
                </Link>
              )}

              {can('suppliers.view') && (
                <Link
                  to="/stock/suppliers"
                  className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
                >
                  <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                    <Truck size={18} />
                  </div>
                  <div>
                    <div className="font-semibold text-text group-hover:text-accent-strong">
                      Suppliers
                    </div>
                    <div className="text-xs text-muted">
                      Supplier ledger, balances & cheque payments
                    </div>
                  </div>
                </Link>
              )}

              {can('mix_paint.view') && (
                <Link
                  to="/stock/mix-paint"
                  className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
                >
                  <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                    <Paintbrush size={18} />
                  </div>
                  <div>
                    <div className="font-semibold text-text group-hover:text-accent-strong">
                      Mix Paint
                    </div>
                    <div className="text-xs text-muted">
                      Loose paint transfer & open-can pricing
                    </div>
                  </div>
                </Link>
              )}
            </div>
          </div>
        )}

        {/* HRM Group */}
        {can('hrm.view') && (
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
            <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-bold uppercase tracking-wider text-accent-strong">
              <Coins size={16} /> HRM & Commission
            </div>
            <div className="flex flex-col gap-2">
              <Link
                to="/hrm"
                className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
              >
                <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                  <Coins size={18} />
                </div>
                <div>
                  <div className="font-semibold text-text group-hover:text-accent-strong">
                    Monthly Commission & Salaries
                  </div>
                  <div className="text-xs text-muted">
                    Commission sharing (Aruna 3%, Owner 3%, Savings 4%), fixed expenses & staff
                    salaries
                  </div>
                </div>
              </Link>
            </div>
          </div>
        )}

        {/* Administration Group */}
        {(can('dashboard.view') ||
          can('settings.view') ||
          can('users.view') ||
          can('values.edit') ||
          can('audit_log.view')) && (
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
            <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-bold uppercase tracking-wider text-accent-strong">
              <LayoutDashboard size={16} /> Administration
            </div>
            <div className="flex flex-col gap-2">
              {can('dashboard.view') && (
                <Link
                  to="/admin"
                  className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
                >
                  <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                    <LayoutDashboard size={18} />
                  </div>
                  <div>
                    <div className="font-semibold text-text group-hover:text-accent-strong">
                      Dashboard
                    </div>
                    <div className="text-xs text-muted">
                      Sales figures, fast movers & low stock alerts
                    </div>
                  </div>
                </Link>
              )}

              {can('users.view') && (
                <Link
                  to="/admin/users"
                  className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
                >
                  <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                    <Users size={18} />
                  </div>
                  <div>
                    <div className="font-semibold text-text group-hover:text-accent-strong">
                      Users & Roles
                    </div>
                    <div className="text-xs text-muted">
                      Staff logins, permissions & approval PINs
                    </div>
                  </div>
                </Link>
              )}

              {can('settings.view') && (
                <Link
                  to="/admin/settings"
                  className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
                >
                  <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                    <Settings size={18} />
                  </div>
                  <div>
                    <div className="font-semibold text-text group-hover:text-accent-strong">
                      System Settings
                    </div>
                    <div className="text-xs text-muted">
                      Shop name, receipt layout, printers & cloud
                    </div>
                  </div>
                </Link>
              )}

              {can('values.edit') && (
                <Link
                  to="/admin/values"
                  className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
                >
                  <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                    <Sliders size={18} />
                  </div>
                  <div>
                    <div className="font-semibold text-text group-hover:text-accent-strong">
                      Value Manager
                    </div>
                    <div className="text-xs text-muted">Categories, brands, units & reasons</div>
                  </div>
                </Link>
              )}

              {can('audit_log.view') && (
                <Link
                  to="/admin/audit"
                  className="group flex items-start gap-3 rounded-xl border border-border/70 p-3 transition hover:border-accent hover:bg-accent-soft/30"
                >
                  <div className="mt-0.5 rounded-lg bg-surface-2 p-2 group-hover:bg-accent group-hover:text-accent-text">
                    <ShieldCheck size={18} />
                  </div>
                  <div>
                    <div className="font-semibold text-text group-hover:text-accent-strong">
                      Audit Log
                    </div>
                    <div className="text-xs text-muted">Append-only log of modifications</div>
                  </div>
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
