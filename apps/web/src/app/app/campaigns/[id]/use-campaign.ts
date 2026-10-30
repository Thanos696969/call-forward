'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CampaignDto } from '@relay/core';
import { api, ApiError, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';

export function useCampaign(id: string) {
  return useQuery({
    queryKey: qk.campaign(id),
    queryFn: async () => (await api<CampaignDto>(`/campaigns/${id}`)).data,
    // Live usage counters on the targets tab.
    refetchInterval: 5000,
  });
}

type Method = 'POST' | 'PATCH' | 'DELETE' | 'PUT';

/**
 * Every campaign write returns the updated campaign, so the cache is replaced
 * in place. Field errors (422) are handed back to the form.
 */
export function useCampaignWrite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      path?: string;
      method: Method;
      body?: unknown;
      success?: string;
      onFieldErrors?: (e: Record<string, string>) => void;
      onDone?: () => void;
    }) =>
      (
        await api<CampaignDto>(`/campaigns/${id}${v.path ?? ''}`, {
          method: v.method,
          body: v.body,
        })
      ).data,
    onSuccess: (c, v) => {
      qc.setQueryData(qk.campaign(id), c);
      qc.invalidateQueries({ queryKey: qk.campaigns, exact: true });
      qc.invalidateQueries({ queryKey: qk.numbers });
      if (v.success) toast.success(v.success);
      v.onDone?.();
    },
    onError: (err, v) => {
      if (err instanceof ApiError && err.status === 422 && v.onFieldErrors) {
        v.onFieldErrors(err.fieldErrors());
        toast.error(err.message);
      } else toast.error(errorMessage(err));
    },
  });
}
