/**
 * Roles are combined per user: the Super Admin ticks Admin, Stock Manager or Cashier (or a role
 * they built) and a user can do everything their ticked roles allow. The server checks these
 * permissions on every request, not just in the screens.
 */

export const ACTIONS = ['view', 'create', 'edit', 'approve', 'export'] as const;
export type Action = (typeof ACTIONS)[number];

export type Section = 'billing' | 'stock' | 'admin';

interface ModuleDef {
  label: string;
  section: Section;
  /** Only the Super Admin may use it; it can't be put in a custom role. */
  superAdminOnly?: boolean;
  /** Which actions make sense on this screen. */
  actions: readonly Action[];
}

const ALL = ACTIONS;

export const MODULES = {
  // Billing
  billing: { label: 'Billing', section: 'billing', actions: ['view', 'create'] },
  quotations: { label: 'Quotations', section: 'billing', actions: ['view', 'create'] },
  bill_history: {
    label: 'Bill history and reprints',
    section: 'billing',
    actions: ['view', 'approve', 'export'],
  },
  returns: { label: 'Returns', section: 'billing', actions: ['view', 'create', 'approve'] },
  day_end: { label: 'Day end', section: 'billing', actions: ['view', 'create', 'approve'] },
  // Stock
  suppliers: { label: 'Suppliers', section: 'stock', actions: ALL },
  supplier_payments: {
    label: 'Supplier payments',
    section: 'stock',
    actions: ['view', 'create', 'export'],
  },
  purchases: { label: 'Purchases (GRN)', section: 'stock', actions: ALL },
  purchase_returns: {
    label: 'Purchase returns',
    section: 'stock',
    actions: ['view', 'create', 'export'],
  },
  products: { label: 'Products', section: 'stock', actions: ALL },
  stock: { label: 'Stock view', section: 'stock', actions: ['view', 'edit', 'export'] },
  transfers: { label: 'Location transfers', section: 'stock', actions: ['view', 'create'] },
  mix_paint: { label: 'Mix paint', section: 'stock', actions: ['view', 'create', 'approve'] },
  adjustments: { label: 'Adjustments', section: 'stock', actions: ['view', 'create', 'approve'] },
  stock_count: { label: 'Stock count', section: 'stock', actions: ['view', 'create', 'approve'] },
  reorder: { label: 'Reorder', section: 'stock', actions: ['view', 'create', 'export'] },
  stock_reports: {
    label: 'Stock and supplier reports',
    section: 'stock',
    actions: ['view', 'export'],
  },
  // Admin
  dashboard: { label: 'Dashboard', section: 'admin', actions: ['view'] },
  reports: { label: 'Reports', section: 'admin', actions: ['view', 'export'] },
  commission: { label: 'Commission', section: 'admin', actions: ['view', 'create', 'export'] },
  values: { label: 'Value manager', section: 'admin', actions: ['view', 'create', 'edit'] },
  audit_log: { label: 'Audit log', section: 'admin', actions: ['view', 'export'] },
  monthly_closing: {
    label: 'Monthly closing',
    section: 'admin',
    superAdminOnly: true,
    actions: ALL,
  },
  users: { label: 'Users and roles', section: 'admin', superAdminOnly: true, actions: ALL },
  settings: {
    label: 'Settings',
    section: 'admin',
    superAdminOnly: true,
    actions: ['view', 'edit'],
  },
  backups: {
    label: 'Backups and restore',
    section: 'admin',
    superAdminOnly: true,
    actions: ['view', 'create', 'approve'],
  },
} as const satisfies Record<string, ModuleDef>;

export type ModuleKey = keyof typeof MODULES;
export type ModulePermission = `${ModuleKey}.${Action}`;

/**
 * Cost privacy: each product's cost, profit and margin (Stock Managers and the Super Admin);
 * totals of cost, profit and margin (Super Admin only).
 */
export const SPECIAL_PERMISSIONS = {
  'cost.item': { label: "Each product's cost, profit and margin", superAdminOnly: false },
  'cost.totals': { label: 'Totals of cost, profit and margin', superAdminOnly: true },
} as const;
export type SpecialPermission = keyof typeof SPECIAL_PERMISSIONS;

export type Permission = ModulePermission | SpecialPermission;

export function modulePermissions(): ModulePermission[] {
  const out: ModulePermission[] = [];
  for (const [key, def] of Object.entries(MODULES) as [ModuleKey, ModuleDef][]) {
    for (const a of def.actions) out.push(`${key}.${a}`);
  }
  return out;
}

export const ALL_PERMISSIONS: Permission[] = [
  ...modulePermissions(),
  ...(Object.keys(SPECIAL_PERMISSIONS) as SpecialPermission[]),
];

/** Permissions a custom role may contain (no Super Admin-only screens or cost totals). */
export function assignablePermissions(): Permission[] {
  return ALL_PERMISSIONS.filter((p) => !isSuperAdminOnly(p));
}

export function isSuperAdminOnly(p: Permission): boolean {
  if (p in SPECIAL_PERMISSIONS) return SPECIAL_PERMISSIONS[p as SpecialPermission].superAdminOnly;
  const mod = p.split('.')[0] as ModuleKey;
  const def = MODULES[mod] as ModuleDef | undefined;
  return def?.superAdminOnly === true;
}

export function isPermission(p: string): p is Permission {
  return (ALL_PERMISSIONS as string[]).includes(p);
}

export const BUILT_IN_ROLES = ['SUPER_ADMIN', 'ADMIN', 'STOCK_MANAGER', 'CASHIER'] as const;
export type BuiltInRole = (typeof BUILT_IN_ROLES)[number];

export const BUILT_IN_ROLE_LABELS: Record<BuiltInRole, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  STOCK_MANAGER: 'Stock Manager',
  CASHIER: 'Cashier',
};

function grant(mods: Partial<Record<ModuleKey, readonly Action[] | 'all'>>): Permission[] {
  const out: Permission[] = [];
  for (const [key, actions] of Object.entries(mods) as [ModuleKey, readonly Action[] | 'all'][]) {
    const def = MODULES[key] as ModuleDef;
    const list = actions === 'all' ? def.actions : actions.filter((a) => def.actions.includes(a));
    for (const a of list) out.push(`${key}.${a}`);
  }
  return out;
}

/** Built-in roles are defined in code so updates reach every shop. */
export const BUILT_IN_ROLE_PERMISSIONS: Record<BuiltInRole, Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  // Dashboard and reports without cost or profit, commission, stock, billing, value manager, approvals.
  ADMIN: grant({
    billing: 'all',
    quotations: 'all',
    bill_history: 'all',
    returns: 'all',
    day_end: 'all',
    suppliers: 'all',
    supplier_payments: 'all',
    purchases: ['view', 'approve', 'export'],
    purchase_returns: 'all',
    products: ['view', 'edit', 'approve', 'export'],
    stock: 'all',
    transfers: 'all',
    mix_paint: 'all',
    adjustments: 'all',
    stock_count: 'all',
    reorder: 'all',
    stock_reports: 'all',
    dashboard: 'all',
    reports: 'all',
    commission: 'all',
    values: 'all',
    audit_log: 'all',
  }),
  // Suppliers, purchases, products with each item's cost, profit and margin, mix-paint transfers,
  // reorder, stock and supplier reports. Write-offs need an Admin.
  STOCK_MANAGER: [
    ...grant({
      suppliers: 'all',
      supplier_payments: 'all',
      purchases: ['view', 'create', 'edit', 'export'],
      purchase_returns: 'all',
      products: ['view', 'create', 'edit', 'export'],
      stock: 'all',
      transfers: 'all',
      mix_paint: ['view', 'create'],
      adjustments: ['view', 'create'],
      stock_count: ['view', 'create'],
      reorder: 'all',
      stock_reports: 'all',
      values: ['view', 'create'],
    }),
    'cost.item',
  ],
  // Billing, quotations, bill history, reprints, returns, loose sales from mix paint, own day end.
  CASHIER: grant({
    billing: 'all',
    quotations: 'all',
    bill_history: ['view'],
    returns: ['view', 'create'],
    day_end: ['view', 'create'],
    values: ['view'],
  }),
};

/** What needs another person's PIN, and which permission that person must hold. */
export const APPROVALS = {
  VOID_BILL: { permission: 'bill_history.approve', label: 'Void a bill' },
  MIX_PRICE_CHANGE: { permission: 'mix_paint.approve', label: 'Change a mix paint price' },
  OPEN_CAN: { permission: 'mix_paint.create', label: 'Open a can into mix paint' },
  WRITE_OFF: { permission: 'adjustments.approve', label: 'Write off stock' },
  OLD_SYSTEM_RETURN: { permission: 'returns.approve', label: 'Return an old-system bill' },
  REVERSE_PURCHASE: { permission: 'purchases.approve', label: 'Reverse a posted purchase' },
  POST_STOCK_COUNT: { permission: 'stock_count.approve', label: 'Post a stock count' },
} as const satisfies Record<string, { permission: Permission; label: string }>;
export type ApprovalKind = keyof typeof APPROVALS;

export class PermissionSet {
  private readonly set: Set<string>;
  constructor(permissions: Iterable<string>) {
    this.set = new Set(permissions);
  }
  has(p: Permission): boolean {
    return this.set.has(p);
  }
  any(...ps: Permission[]): boolean {
    return ps.some((p) => this.set.has(p));
  }
  canSee(section: Section): boolean {
    return (Object.entries(MODULES) as [ModuleKey, ModuleDef][]).some(
      ([k, d]) => d.section === section && this.set.has(`${k}.view`),
    );
  }
  toArray(): Permission[] {
    return [...this.set].filter(isPermission).sort();
  }
}

/** Combine every ticked role's permissions. */
export function resolvePermissions(
  roles: { code: string; permissions?: string[] }[],
): PermissionSet {
  const out = new Set<string>();
  for (const r of roles) {
    const builtIn = BUILT_IN_ROLE_PERMISSIONS[r.code as BuiltInRole] as Permission[] | undefined;
    for (const p of builtIn ?? r.permissions ?? []) out.add(p);
  }
  return new PermissionSet(out);
}
