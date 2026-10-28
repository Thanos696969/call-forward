import { isIP } from 'node:net';

/**
 * SSRF guard for customer-supplied URLs (outbound webhooks arrive in Phase 4).
 * Phase 1 checks syntax: HTTPS only, no credentials, no localhost, no private or
 * link-local IP literals. Phase 4 must additionally resolve DNS and re-check the
 * resolved addresses at connect time (see DECISIONS.md, "Deferred: SSRF DNS").
 */
export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(`Unsafe URL: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  return mapped?.[1] ? isPrivateIPv4(mapped[1]) : false;
}

export function assertSafeWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('not a valid URL');
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('HTTPS is required');
  if (url.username || url.password) throw new UnsafeUrlError('credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new UnsafeUrlError('host is not allowed');
  }
  const family = isIP(host);
  if ((family === 4 && isPrivateIPv4(host)) || (family === 6 && isPrivateIPv6(host))) {
    throw new UnsafeUrlError('private address');
  }
  return url;
}
