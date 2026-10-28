'use client';

import { useQuery } from '@tanstack/react-query';
import type { MeDto } from '@relay/core';
import { api } from './api';

export const qk = {
  me: ['me'] as const,
  org: ['org'] as const,
  members: ['org', 'members'] as const,
  audit: ['audit-logs'] as const,
  numbers: ['numbers'] as const,
  number: (id: string) => ['numbers', id] as const,
  available: (prefix: string, contains: string) =>
    ['numbers', 'available', prefix, contains] as const,
  calls: (filters: Record<string, string>) => ['calls', filters] as const,
  call: (id: string) => ['calls', 'detail', id] as const,
  dashboard: (days: number) => ['dashboard', days] as const,
};

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async () => (await api<MeDto>('/me')).data,
    staleTime: 60_000,
  });
}
