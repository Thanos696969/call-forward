'use client';

import Link from 'next/link';
import { useState } from 'react';
import { forgotPasswordBodySchema } from '@relay/core';
import { Button, Field, Input } from '@relay/ui';
import { api, errorMessage } from '@/lib/api';
import { fieldProps, zodFieldErrors } from '@/components/form-utils';

export default function ForgotPasswordPage() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = forgotPasswordBodySchema.safeParse({
      email: new FormData(e.currentTarget).get('email'),
    });
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    setErrors({});
    setPending(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: parsed.data });
      setSentTo(parsed.data.email);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (sentTo) {
    return (
      <div className="grid gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Check your inbox</h1>
        <p className="text-sm text-muted-foreground">
          If an account exists for {sentTo}, it will get a reset link in a minute. The link works
          for one hour.
        </p>
        <Link
          href="/login"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
        <p className="text-sm text-muted-foreground">
          We will email you a link to choose a new one.
        </p>
      </div>
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        <Field id="email" label="Email" error={errors.email}>
          <Input type="email" autoComplete="email" required {...fieldProps('email', errors)} />
        </Field>
        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send reset link'}
        </Button>
        <Link
          href="/login"
          className="text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      </form>
    </div>
  );
}
