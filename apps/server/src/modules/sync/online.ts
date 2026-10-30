/**
 * The only changes made on the online panel, all by the Super Admin and all things an Admin
 * can't do: users, passwords, PINs, roles and permissions, test mode, the settings and number
 * formats, the HRM month start. Each one reaches the shop when it next connects. Everyone else
 * only looks: the shop's data as of its last sync.
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
  'POST /api/auth/change-password',
]);
