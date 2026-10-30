/**
 * What Admins and the Super Admin may change on the online panel. Each change is kept as the
 * rows it changed, and the shop applies them when it next syncs. Billing, purchases, payments
 * and stock moves need the counters, so they stay at the shop.
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
  'POST /api/values/:list',
  'PATCH /api/values/:list/:id',
  'DELETE /api/values/:list/:id',
  'POST /api/values/:list/:id/merge',
  'PUT /api/values/:list/order',
  'PUT /api/products/:id',
  'PATCH /api/products/:id/names',
  'POST /api/products/:id/prices',
  'PATCH /api/sub-products/:id',
  'PUT /api/suppliers/:id',
  'POST /api/suppliers/:id/reps',
  'PUT /api/hrm/month-start',
  'PUT /api/hrm/month/:period',
  'POST /api/auth/change-password',
]);
