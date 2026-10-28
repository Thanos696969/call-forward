import type { ApiErrorBody } from '@relay/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field errors from a 422 response, keyed by field path. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details) {
        if (d && typeof d === 'object' && 'path' in d && 'message' in d) {
          out[String(d.path)] = String(d.message);
        }
      }
    }
    return out;
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

let csrfPromise: Promise<string> | null = null;

async function csrfToken(): Promise<string> {
  const existing = readCookie('relay_csrf');
  if (existing) return existing;
  csrfPromise ??= fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })
    .then((r) => r.json() as Promise<{ data: { csrfToken: string | null } }>)
    .then((b) => readCookie('relay_csrf') ?? b.data.csrfToken ?? '')
    .finally(() => {
      csrfPromise = null;
    });
  return csrfPromise;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export interface Envelope<T> {
  data: T;
  meta?: { nextCursor?: string | null } & Record<string, unknown>;
}

export async function api<T>(
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    query?: Query;
  } = {},
): Promise<Envelope<T>> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = await csrfToken();
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(withQuery(`/api/v1${path}`, init.query), {
    method,
    headers,
    credentials: 'same-origin',
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  return json as Envelope<T>;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
