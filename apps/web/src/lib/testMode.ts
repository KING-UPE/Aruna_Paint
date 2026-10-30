import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface TestModeStatus {
  /** When the test copy was last made from the real data. */
  copyMadeAt: string | null;
  users: { id: string; username: string; fullName: string }[];
}

/** Who is in test mode and how fresh the copy is (Super Admin). */
export function useTestMode() {
  return useQuery({
    queryKey: ['test-mode'],
    queryFn: () => api.get<TestModeStatus>('/api/test-mode', { passive: true }),
  });
}
