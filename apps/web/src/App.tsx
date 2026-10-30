import type { AppearanceSettings } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import {
  AuthProvider,
  useAuth,
  useIdleLock,
  useMeQuery,
  useSessionErrors,
} from '@/auth/AuthProvider';
import { ChangePasswordPage } from '@/auth/ChangePasswordPage';
import { LockScreen } from '@/auth/LockScreen';
import { LoginPage } from '@/auth/LoginPage';
import { SetupPage } from '@/auth/SetupPage';
import { BillingScreen } from '@/billing/BillingScreen';
import { DayEndPage } from '@/billing/DayEndPage';
import { HistoryPage } from '@/billing/HistoryPage';
import { AskProvider } from '@/components/AskDialog';
import { PinPromptProvider } from '@/components/PinPrompt';
import { TestModeBanner } from '@/components/TestModeBanner';
import { Spinner } from '@/components/ui/misc';
import { CommandPalette } from '@/keyboard/CommandPalette';
import { KeymapProvider } from '@/keyboard/keymap';
import { ShortcutHelp } from '@/keyboard/ShortcutHelp';
import { AppLayout } from '@/layout/AppLayout';
import { MenuPage } from '@/layout/MenuPage';
import { firstAllowed } from '@/layout/nav';
import { api } from '@/lib/api';
import { connectLive } from '@/lib/live';
import { applyAppearance } from '@/lib/theme';
import { StockRoutes } from '@/stock/routes';
import { AdminRoutes } from '@/admin/routes';
import { ProfilePage } from '@/admin/ProfilePage';
import { HrmPage } from '@/hrm/HrmPage';

export function App() {
  useSessionErrors();
  const setup = useQuery({
    queryKey: ['setup-status'],
    queryFn: () =>
      api.get<{ needsSetup: boolean; appearance?: AppearanceSettings }>('/api/setup/status'),
    staleTime: Infinity,
  });
  const me = useMeQuery();
  // The shop's colour theme, from the signed-in answer or (on the login screen) the public one.
  const appearance = me.data?.appearance ?? setup.data?.appearance;
  const appearanceKey = appearance ? JSON.stringify(appearance) : '';
  useEffect(() => {
    if (appearanceKey) applyAppearance(JSON.parse(appearanceKey) as AppearanceSettings);
  }, [appearanceKey]);
  return (
    <Screens setupLoading={setup.isLoading} needsSetup={Boolean(setup.data?.needsSetup)} me={me} />
  );
}

function Screens({
  setupLoading,
  needsSetup,
  me,
}: {
  setupLoading: boolean;
  needsSetup: boolean;
  me: ReturnType<typeof useMeQuery>;
}) {
  if (setupLoading || me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (needsSetup) return <SetupPage />;
  if (!me.data) return <LoginPage />;
  if (me.data.user.mustChangePassword) return <ChangePasswordPage />;
  return (
    <AuthProvider me={me.data}>
      <KeymapProvider overrides={me.data.shortcuts}>
        <PinPromptProvider>
          <AskProvider>
            <Session />
            {me.data.locked ? <LockScreen me={me.data} /> : null}
          </AskProvider>
        </PinPromptProvider>
      </KeymapProvider>
    </AuthProvider>
  );
}

function Session() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  useIdleLock(me.settings.idleLockMinutes, me.locked);
  useEffect(() => connectLive(qc), [qc]);
  const home =
    me.counter && can('billing.view', 'quotations.view')
      ? '/billing'
      : (firstAllowed('Stock', can) ??
        firstAllowed('Admin', can) ??
        firstAllowed('Billing', can) ??
        '/profile');
  return (
    <>
      {me.testMode ? <TestModeBanner /> : null}
      <ShortcutHelp />
      <CommandPalette />
      <Routes>
        {/* Billing runs full screen with no sidebar. */}
        <Route path="/billing" element={<BillingScreen />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<MenuPage />} />
          <Route path="/menu" element={<MenuPage />} />
          <Route path="/billing/history" element={<HistoryPage />} />
          <Route path="/billing/day-end" element={<DayEndPage />} />
          <Route path="/stock/*" element={<StockRoutes />} />
          <Route path="/hrm/*" element={<HrmPage />} />
          <Route path="/admin/*" element={<AdminRoutes />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="*" element={<Navigate to="/menu" replace />} />
        </Route>
      </Routes>
    </>
  );
}
