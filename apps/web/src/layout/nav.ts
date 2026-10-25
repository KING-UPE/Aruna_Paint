import type { Permission } from '@aruna/shared';

export interface NavItem {
  to: string;
  label: string;
  section: 'Billing' | 'Stock' | 'Admin';
  perms: Permission[];
}

/** Only the sections and screens the user's roles allow appear. */
export const navItems: NavItem[] = [
  {
    to: '/menu',
    label: 'Main menu',
    section: 'Billing',
    perms: [],
  },
  {
    to: '/billing',
    label: 'Billing',
    section: 'Billing',
    perms: ['billing.view', 'quotations.view'],
  },
  {
    to: '/billing/history',
    label: 'Bill history',
    section: 'Billing',
    perms: ['bill_history.view'],
  },
  { to: '/billing/day-end', label: 'Day end', section: 'Billing', perms: ['day_end.view'] },
  {
    to: '/stock/products',
    label: 'Products and stock',
    section: 'Stock',
    perms: ['products.view', 'stock.view'],
  },
  { to: '/stock/purchases', label: 'Purchases (GRN)', section: 'Stock', perms: ['purchases.view'] },
  { to: '/stock/suppliers', label: 'Suppliers', section: 'Stock', perms: ['suppliers.view'] },
  { to: '/stock/mix-paint', label: 'Mix paint', section: 'Stock', perms: ['mix_paint.view'] },
  { to: '/admin', label: 'Dashboard', section: 'Admin', perms: ['dashboard.view'] },
  { to: '/admin/values', label: 'Value manager', section: 'Admin', perms: ['values.edit'] },
  { to: '/admin/users', label: 'Users and roles', section: 'Admin', perms: ['users.view'] },
  { to: '/admin/settings', label: 'Settings', section: 'Admin', perms: ['settings.view'] },
  { to: '/admin/audit', label: 'Audit log', section: 'Admin', perms: ['audit_log.view'] },
];

export function firstAllowed(
  section: NavItem['section'],
  can: (...p: Permission[]) => boolean,
): string | null {
  return navItems.find((n) => n.section === section && (!n.perms.length || can(...n.perms)))?.to ?? null;
}
