'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { US_TOLL_FREE_PREFIXES, type AvailableNumberDto, type NumberDto } from '@relay/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  NativeSelect,
  Skeleton,
} from '@relay/ui';
import { api, errorMessage } from '@/lib/api';
import { formatPhone } from '@/lib/format';
import { qk } from '@/lib/queries';

export function BuyNumberDialog() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [prefix, setPrefix] = useState('');
  const [contains, setContains] = useState('');
  const [search, setSearch] = useState({ prefix: '', contains: '' });
  const [buying, setBuying] = useState<string | null>(null);

  const containsError =
    contains && !/^\d{1,7}$/.test(contains) ? 'Digits only, up to 7' : undefined;

  const available = useQuery({
    queryKey: qk.available(search.prefix, search.contains),
    queryFn: async () =>
      (
        await api<AvailableNumberDto[]>('/numbers/available', {
          query: { type: 'toll_free', prefix: search.prefix, contains: search.contains, limit: 12 },
        })
      ).data,
    enabled: open,
    staleTime: 0,
  });

  const purchase = useMutation({
    mutationFn: async (e164: string) =>
      (await api<NumberDto>('/numbers', { method: 'POST', body: { e164 } })).data,
    onMutate: (e164) => setBuying(e164),
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: qk.numbers });
      toast.success(`Bought ${formatPhone(n.e164)}. Now choose where it rings.`);
      setOpen(false);
      router.push(`/app/numbers/${n.id}`);
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      qc.invalidateQueries({ queryKey: ['numbers', 'available'] });
    },
    onSettled: () => setBuying(null),
  });

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    if (containsError) return;
    setSearch({ prefix, contains });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden /> Buy number
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Buy a toll-free number</DialogTitle>
          <DialogDescription>
            Pick a prefix or digits you want to see in the number.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSearch} className="grid gap-3 sm:grid-cols-[9rem_1fr_auto] sm:items-end">
          <Field id="prefix" label="Prefix">
            <NativeSelect id="prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)}>
              <option value="">Any</option>
              {US_TOLL_FREE_PREFIXES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="contains" label="Contains digits" error={containsError}>
            <Input
              id="contains"
              inputMode="numeric"
              placeholder="e.g. 2024"
              value={contains}
              onChange={(e) => setContains(e.target.value.trim())}
              aria-invalid={containsError ? true : undefined}
            />
          </Field>
          <Button
            type="submit"
            variant="outline"
            disabled={Boolean(containsError) || available.isFetching}
          >
            Search
          </Button>
        </form>

        <div className="min-h-48" aria-live="polite">
          {available.isPending || available.isFetching ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : available.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(available.error)}
            </p>
          ) : available.data.length === 0 ? (
            <p className="py-8 text-sm text-muted-foreground">
              No numbers match. Try a different prefix or fewer digits.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {available.data.map((n) => (
                <li key={n.e164}>
                  <button
                    type="button"
                    disabled={purchase.isPending}
                    onClick={() => purchase.mutate(n.e164)}
                    className="tnum flex w-full items-center justify-between rounded-md border px-3 py-3 text-left font-medium transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <span>{formatPhone(n.e164)}</span>
                    <span className="text-xs font-normal text-primary">
                      {buying === n.e164 ? 'Buying…' : 'Buy'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
