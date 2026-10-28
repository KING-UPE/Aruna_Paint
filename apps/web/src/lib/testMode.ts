import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface TestModeStatus {
  on: boolean;
  since: string | null;
  byName: string | null;
}

/** Test mode for the banner and the Super Admin's switch; the sign-in screen asks too. */
export function useTestMode() {
  return useQuery({
    queryKey: ['test-mode'],
    queryFn: () => api.get<TestModeStatus>('/api/test-mode', { passive: true }),
    refetchInterval: 30_000,
  });
}
