import { describe, expect, it } from 'vitest';
import { UnsafeUrlError, assertSafeWebhookUrl } from '../src/security/ssrf';

describe('SSRF guard (stub for Phase 4)', () => {
  it('allows public HTTPS URLs', () => {
    expect(assertSafeWebhookUrl('https://hooks.example.com/relay').hostname).toBe(
      'hooks.example.com',
    );
  });
  it.each([
    'http://hooks.example.com',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://169.254.169.254/latest',
    'https://[::1]/x',
    'https://user:pw@example.com',
    'not a url',
  ])('blocks %s', (u) => {
    expect(() => assertSafeWebhookUrl(u)).toThrow(UnsafeUrlError);
  });
});
