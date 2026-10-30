/**
 * Every API path (`/api/v1/*`, `/voice/*`, health checks, cron) arrives here.
 *
 * - Embedded (Vercel, or EMBED_API=true): the Fastify API runs inside this function.
 * - Otherwise (local `pnpm dev`, E2E): requests are proxied to the standalone API at API_URL.
 */
export function apiIsEmbedded(): boolean {
  if (process.env.API_URL) return false;
  return Boolean(process.env.VERCEL) || process.env.EMBED_API === 'true';
}

const DROP_REQUEST = ['host', 'connection', 'content-length', 'transfer-encoding'];
const DROP_RESPONSE = ['content-encoding', 'content-length', 'transfer-encoding', 'connection'];

async function proxy(request: Request, apiUrl: string): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, apiUrl);
  const headers = new Headers(request.headers);
  for (const h of DROP_REQUEST) headers.delete(h);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
    cache: 'no-store',
  });
  const out = new Headers(res.headers);
  for (const h of DROP_RESPONSE) out.delete(h);
  return new Response(res.body, { status: res.status, headers: out });
}

export async function forwardToApi(request: Request): Promise<Response> {
  if (apiIsEmbedded()) {
    const { handleApiRequest } = await import('@relay/api/embedded');
    return handleApiRequest(request);
  }
  return proxy(request, (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, ''));
}
