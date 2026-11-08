import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { navItems } from './nav';

/**
 * Each page checks the signed-in user may open it, not just the menu: an address typed in, a
 * bookmark, or a page left open by someone else goes to the Main menu instead. The page's own
 * entry in the menu (`navItems`, the longest matching address) says what it needs. The server
 * refuses the data anyway; this keeps the screen honest.
 */
export function PageGate({ children }: { children: ReactNode }) {
  const { me, can } = useAuth();
  const { pathname } = useLocation();
  const item = navItems
    .filter((n) => n.to !== '/menu' && (pathname === n.to || pathname.startsWith(`${n.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0];
  const allowed =
    !item ||
    ((!item.perms.length || can(...item.perms)) && !(item.shopOnly && me.mode === 'cloud'));
  return allowed ? <>{children}</> : <Navigate to="/menu" replace />;
}
