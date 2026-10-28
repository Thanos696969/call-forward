'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { loginBodySchema, type MeDto } from '@relay/core';
import { Button, Field, Input } from '@relay/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { fieldProps, zodFieldErrors } from '@/components/form-utils';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const parsed = loginBodySchema.safeParse({
      email: fd.get('email'),
      password: fd.get('password'),
    });
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    setErrors({});
    setFormError(null);
    setPending(true);
    try {
      const res = await api<MeDto>('/auth/login', { method: 'POST', body: parsed.data });
      qc.clear();
      qc.setQueryData(qk.me, res.data);
      const next = params.get('next');
      router.replace(next && next.startsWith('/app') ? next : '/app');
    } catch (err) {
      setFormError(err instanceof ApiError && err.status === 429 ? err.message : errorMessage(err));
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to Relay</h1>
        <p className="text-sm text-muted-foreground">
          New here?{' '}
          <Link
            href="/register"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Create an account
          </Link>
        </p>
      </div>
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        <Field id="email" label="Email" error={errors.email}>
          <Input type="email" autoComplete="email" required {...fieldProps('email', errors)} />
        </Field>
        <Field id="password" label="Password" error={errors.password}>
          <Input
            type="password"
            autoComplete="current-password"
            required
            {...fieldProps('password', errors)}
          />
        </Field>
        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
        <Link
          href="/forgot-password"
          className="text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Forgot your password?
        </Link>
      </form>
    </div>
  );
}
