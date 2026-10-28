'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { passwordSchema } from '@relay/core';
import { Button, Field, Input } from '@relay/ui';
import { api, errorMessage } from '@/lib/api';
import { fieldProps } from '@/components/form-utils';

export function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!token) {
    return (
      <div className="grid gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">This link is incomplete</h1>
        <p className="text-sm text-muted-foreground">
          Open the link from your email again, or request a new one.
        </p>
        <Link
          href="/forgot-password"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const password = String(fd.get('password') ?? '');
    const confirm = String(fd.get('confirm') ?? '');
    const parsed = passwordSchema.safeParse(password);
    const next: Record<string, string> = {};
    if (!parsed.success) next.password = parsed.error.issues[0]?.message ?? 'Invalid password';
    if (password !== confirm) next.confirm = 'Passwords do not match';
    setErrors(next);
    if (Object.keys(next).length) return;
    setPending(true);
    setFormError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, password } });
      toast.success('Password updated. Sign in with your new password.');
      router.replace('/login');
    } catch (err) {
      setFormError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        <Field
          id="password"
          label="New password"
          error={errors.password}
          hint="At least 10 characters"
        >
          <Input type="password" autoComplete="new-password" {...fieldProps('password', errors)} />
        </Field>
        <Field id="confirm" label="Confirm new password" error={errors.confirm}>
          <Input type="password" autoComplete="new-password" {...fieldProps('confirm', errors)} />
        </Field>
        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    </div>
  );
}
