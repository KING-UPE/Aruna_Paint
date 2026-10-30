import { Navigate, Route, Routes } from 'react-router';
import { AuditLogPage } from './AuditLogPage';
import { DashboardPage } from './DashboardPage';
import { SettingsPage } from './SettingsPage';
import { SyncPage } from './SyncPage';
import { UsersPage } from './UsersPage';
import { ValueManagerPage } from './ValueManagerPage';

export function AdminRoutes() {
  return (
    <Routes>
      <Route index element={<DashboardPage />} />
      <Route path="values" element={<ValueManagerPage />} />
      <Route path="users" element={<UsersPage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="sync" element={<SyncPage />} />
      <Route path="audit" element={<AuditLogPage />} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}
