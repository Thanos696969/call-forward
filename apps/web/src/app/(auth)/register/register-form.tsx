'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { registerBodySchema, type MeDto } from '@relay/core';
import { Button, Field, Input } from '@relay/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { fieldProps, zodFieldErrors } from '@/components/form-utils';

export function RegisterForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const parsed = registerBodySchema.safeParse({
      orgName: fd.get('orgName'),
      email: fd.get('email'),
      password: fd.get('password'),
    });
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    setErrors({});
    setFormError(null);
    setPending(true);
    try {
      const res = await api<MeDto>('/auth/register', { method: 'POST', body: parsed.data });
      qc.clear();
      qc.setQueryData(qk.me, res.data);
      router.replace('/app/numbers');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'email_taken') setErrors({ email: err.message });
      else if (err instanceof ApiError && err.status === 422) setErrors(err.fieldErrors());
      else setFormError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Create your Relay account</h1>
        <p className="text-sm text-muted-foreground">
          Already have one?{' '}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        <Field id="orgName" label="Business name" error={errors.orgName}>
          <Input autoComplete="organization" required {...fieldProps('orgName', errors)} />
        </Field>
        <Field id="email" label="Work email" error={errors.email}>
          <Input type="email" autoComplete="email" required {...fieldProps('email', errors)} />
        </Field>
        <Field id="password" label="Password" error={errors.password} hint="At least 10 characters">
          <Input
            type="password"
            autoComplete="new-password"
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
          {pending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </div>
  );
}
