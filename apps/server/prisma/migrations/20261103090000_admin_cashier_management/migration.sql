-- Admins manage cashier accounts (the shop's request). The built-in Admin role gets the new
-- permissions from the code; an Admin role the Super Admin customized keeps its own stored list,
-- so it gets them here.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
  FROM roles r
 CROSS JOIN (VALUES ('cashiers.view'), ('cashiers.create'), ('cashiers.edit')) AS p(permission)
 WHERE r.code = 'ADMIN' AND r.customized
ON CONFLICT DO NOTHING;
