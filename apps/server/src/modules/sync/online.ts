/**
 * The only changes made on the online panel, all by the Super Admin and all things an Admin
 * can't do: users, passwords, PINs, roles and permissions, test mode, the settings (backup times
 * and folders too) and number formats, the counters and their printers, the HRM month start and
 * each month's figures. Each one reaches the shop when it next connects. Nothing that moves stock
 * or money is here. Everyone else only looks: the shop's data as of its last sync.
 */
export const ONLINE_CHANGES = new Set([
  'POST /api/users',
  'PATCH /api/users/:id',
  'DELETE /api/users/:id',
  'POST /api/users/:id/reset-password',
  'POST /api/users/:id/reset-pin',
  'POST /api/users/:id/test-mode',
  'POST /api/roles',
  'PATCH /api/roles/:id',
  'POST /api/roles/:id/reset',
  'DELETE /api/roles/:id',
  'PUT /api/settings/:key',
  'PUT /api/number-formats/:docType',
  'PUT /api/hrm/month-start',
  'PUT /api/hrm/month/:period',
  'POST /api/counters',
  'PATCH /api/counters/:id',
  'POST /api/auth/change-password',
]);

/**
 * Things only the shop's server can do, asked for online by the Super Admin: the shop does them
 * at its next sync and the panel shows how it went. The audit action names the request.
 */
export const SHOP_REQUESTS: Record<string, string> = {
  'POST /api/backups': 'backup.manual',
  'POST /api/test-mode/refresh': 'testmode.refresh',
};
