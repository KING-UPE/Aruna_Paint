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
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';

export function MenuDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();

  const handleNavigate = (path: string) => {
    onClose();
    void nav(path);
  };

  const handleLogout = async () => {
    onClose();
    await api.post('/api/auth/logout', {}).finally(() => qc.setQueryData(['me'], null));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)} title="System Menu" className="max-w-4xl">
      <div className="flex flex-col gap-5 py-1">
        <div className="flex items-center justify-between border-b border-border pb-3 text-sm text-muted">
          <div>
            <span className="font-semibold text-text">{me.settings.shopName}</span>
          </div>
          <div>
            User: <span className="font-medium text-text">{me.user.fullName}</span> ({me.roles.join(', ')})
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Billing Section */}
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2/40 p-3">
            <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent-strong">
              <Receipt size={14} /> Billing
            </div>
            {can('bill_history.view') && (
              <button
                type="button"
                onClick={() => handleNavigate('/billing/history')}
                className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
              >
                <History size={16} className="text-muted" />
                <div>
                  <div>Bill History</div>
                  <div className="text-xs text-muted">View sales, reprints, voids</div>
                </div>
              </button>
            )}
            {can('day_end.view') && (
              <button
                type="button"
                onClick={() => handleNavigate('/billing/day-end')}
                className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
              >
                <FileText size={16} className="text-muted" />
                <div>
                  <div>Day End</div>
                  <div className="text-xs text-muted">Close day & cash drawer</div>
                </div>
              </button>
            )}
          </div>

          {/* Stock Section */}
          {(can('products.view', 'stock.view') || can('purchases.view') || can('suppliers.view') || can('mix_paint.view')) && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2/40 p-3">
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent-strong">
                <Package size={14} /> Stock & Products
              </div>
              {can('products.view', 'stock.view') && (
                <button
                  type="button"
                  onClick={() => handleNavigate('/stock/products')}
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
                >
                  <Package size={16} className="text-muted" />
                  <div>
                    <div>Products & Stock</div>
                    <div className="text-xs text-muted">Batches, bin cards, prices</div>
                  </div>
                </button>
              )}
              {can('purchases.view') && (
                <button
                  type="button"
                  onClick={() => handleNavigate('/stock/purchases')}
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
                >
                  <ShoppingBag size={16} className="text-muted" />
                  <div>
                    <div>Purchases (GRN)</div>
                    <div className="text-xs text-muted">Stock receiving & costs</div>
                  </div>
                </button>
              )}
              {can('suppliers.view') && (
                <button
                  type="button"
                  onClick={() => handleNavigate('/stock/suppliers')}
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
                >
                  <Truck size={16} className="text-muted" />
                  <div>
                    <div>Suppliers</div>
                    <div className="text-xs text-muted">Ledger, balances, payments</div>
                  </div>
                </button>
              )}
              {can('mix_paint.view') && (
                <button
                  type="button"
                  onClick={() => handleNavigate('/stock/mix-paint')}
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
                >
                  <Paintbrush size={16} className="text-muted" />
                  <div>
                    <div>Mix Paint</div>
                    <div className="text-xs text-muted">Loose paint transfers</div>
                  </div>
                </button>
              )}
            </div>
          )}

          {/* HRM Section */}
          {can('hrm.view') && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2/40 p-3">
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent-strong">
                <Coins size={14} /> HRM
              </div>
              <button
                type="button"
                onClick={() => handleNavigate('/hrm')}
                className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
              >
                <Coins size={16} className="text-muted" />
                <div>
                  <div>Commission & Salaries</div>
                  <div className="text-xs text-muted">Monthly shares, expenses & staff</div>
                </div>
              </button>
            </div>
          )}

          {/* Admin Section */}
          {(can('dashboard.view') || can('settings.view') || can('users.view') || can('values.edit') || can('audit_log.view')) && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2/40 p-3">
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent-strong">
                <LayoutDashboard size={14} /> Administration
              </div>
              {can('dashboard.view') && (
                <button
                  type="button"
                  onClick={() => handleNavigate('/admin')}
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
                >
                  <LayoutDashboard size={16} className="text-muted" />
                  <div>
                    <div>Dashboard</div>
                    <div className="text-xs text-muted">Metrics & overview</div>
                  </div>
                </button>
              )}
              {can('users.view') && (
                <button
                  type="button"
                  onClick={() => handleNavigate('/admin/users')}
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
                >
                  <Users size={16} className="text-muted" />
                  <div>
                    <div>Users & Roles</div>
                    <div className="text-xs text-muted">Staff accounts, PINs</div>
                  </div>
                </button>
              )}
              {can('settings.view') && (
                <button
                  type="button"
                  onClick={() => handleNavigate('/admin/settings')}
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
                >
                  <Settings size={16} className="text-muted" />
                  <div>
                    <div>Settings</div>
                    <div className="text-xs text-muted">Printers, shop info</div>
                  </div>
                </button>
              )}
              {can('values.edit') && (
                <button
                  type="button"
                  onClick={() => handleNavigate('/admin/values')}
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
                >
                  <Sliders size={16} className="text-muted" />
                  <div>
                    <div>Value Manager</div>
                    <div className="text-xs text-muted">Brands, categories, units</div>
                  </div>
                </button>
              )}
              {can('audit_log.view') && (
                <button
                  type="button"
                  onClick={() => handleNavigate('/admin/audit')}
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm font-medium hover:border-accent hover:bg-accent-soft"
                >
                  <ShieldCheck size={16} className="text-muted" />
                  <div>
                    <div>Audit Log</div>
                    <div className="text-xs text-muted">System security trails</div>
                  </div>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleNavigate('/profile')}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
            >
              <User size={15} /> My Profile
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('/menu')}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:bg-accent/90"
            >
              Open Full Menu Hub
            </button>
          </div>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="flex items-center gap-1.5 rounded-lg border border-warn/30 bg-warn-soft/50 px-3 py-1.5 text-sm font-medium text-warn hover:bg-warn-soft"
          >
            <LogOut size={15} /> Log Out
          </button>
        </div>
      </div>
    </Dialog>
  );
}
