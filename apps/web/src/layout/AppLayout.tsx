import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Menu, Search, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { Kbd } from '@/components/ui/kbd';
import { useHotkeys, useKeyLabel } from '@/keyboard/keymap';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { firstAllowed, navItems } from './nav';
import { StatusBar } from './StatusBar';
import { CloudBar } from './CloudBar';

const SECTIONS = ['Billing', 'Stock', 'HRM', 'Admin'] as const;

/** A left sidebar with only the user's sections, a top bar with the page title and Ctrl+K search. */
export function AppLayout() {
  const { me, can } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const paletteKey = useKeyLabel('global', 'palette');
  const [mobileOpen, setMobileOpen] = useState(false);
  useGlobalNavKeys();
  const current =
    navItems.find((n) => n.to === loc.pathname) ??
    navItems.find((n) => n.to !== '/admin' && loc.pathname.startsWith(n.to));
  const title =
    current?.label ?? (loc.pathname.startsWith('/profile') ? 'My profile' : 'Aruna POS');

  const navContent = (
    <>
      <div className="flex items-center justify-between px-4 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-accent font-bold text-accent-text">
            A
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">{me.settings.shopName}</div>
            <div className="text-xs text-muted">{me.location?.name ?? ''}</div>
          </div>
        </div>
        <button
          type="button"
          className="rounded p-1 text-muted hover:bg-surface-2 md:hidden"
          onClick={() => setMobileOpen(false)}
        >
          <X size={20} />
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="Main">
        {SECTIONS.map((section) => {
          const items = navItems.filter(
            (n) =>
              n.section === section &&
              (!n.perms.length || can(...n.perms)) &&
              !(n.shopOnly && me.mode === 'cloud'),
          );
          if (!items.length) return null;
          return (
            <div key={section} className="mt-3">
              <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                {section}
              </div>
              {items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === '/admin' || n.to === '/billing' || n.to === '/menu'}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      'block rounded-[8px] px-3 py-2 text-[15px]',
                      isActive
                        ? 'bg-accent-soft font-medium text-accent-strong'
                        : 'hover:bg-surface-2',
                    )
                  }
                >
                  {n.label}
                </NavLink>
              ))}
            </div>
          );
        })}
        <div className="mt-3 border-t border-border pt-3">
          <NavLink
            to="/profile"
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              cn(
                'block rounded-[8px] px-3 py-2 text-[15px]',
                isActive ? 'bg-accent-soft font-medium' : 'hover:bg-surface-2',
              )
            }
          >
            My profile
          </NavLink>
          <button
            className="flex w-full items-center gap-2 rounded-[8px] px-3 py-2 text-left text-[15px] hover:bg-surface-2"
            onClick={() =>
              void api.post('/api/auth/logout', {}).finally(() => qc.setQueryData(['me'], null))
            }
          >
            <LogOut size={16} /> Log out
          </button>
        </div>
      </nav>
    </>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Desktop Sidebar */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface md:flex">
          {navContent}
        </aside>

        {/* Mobile Slide-Out Drawer */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-50 flex bg-black/40 md:hidden"
            onClick={() => setMobileOpen(false)}
          >
            <aside
              className="flex w-64 max-w-[80vw] flex-col bg-surface shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {navContent}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {me.mode === 'cloud' ? <CloudBar /> : null}
          <header className="flex items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2.5 md:px-6">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-sm font-medium hover:bg-surface-2 md:hidden"
                onClick={() => setMobileOpen(true)}
              >
                <Menu size={18} />
                <span>Menu</span>
              </button>
              <span className="text-[15px] font-semibold">{title}</span>
            </div>
            <button
              className="flex items-center gap-2 rounded-[8px] border border-border px-3 py-1.5 text-sm text-muted hover:bg-surface-2"
              onClick={() =>
                window.dispatchEvent(
                  new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }),
                )
              }
            >
              <Search size={15} /> Search <Kbd>{paletteKey}</Kbd>
            </button>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
            <Outlet />
          </main>
        </div>
      </div>
      <StatusBar />
    </div>
  );
}

/** Alt+1 / Alt+2 / Alt+3: Billing, Stock, Admin. */
export function useGlobalNavKeys() {
  const { can } = useAuth();
  const nav = useNavigate();
  const go = (section: 'Billing' | 'Stock' | 'Admin') => {
    const to = firstAllowed(section, can);
    if (to) void nav(to);
  };
  useHotkeys('global', {
    goBilling: () => go('Billing'),
    goStock: () => go('Stock'),
    goAdmin: () => go('Admin'),
    lock: () => void api.post('/api/auth/lock', {}).finally(() => window.location.reload()),
  });
}
