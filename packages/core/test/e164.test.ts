import { describe, expect, it } from 'vitest';
import { formatPhone, isE164, isUsTollFree, maskE164, normalizeE164 } from '../src/e164';
import { e164Schema } from '../src/schemas';

describe('E.164 validation', () => {
  it.each(['+14155550123', '+442071838750', '+919876543210', '+18335550142'])('accepts %s', (v) => {
    expect(isE164(v)).toBe(true);
    expect(e164Schema.safeParse(v).success).toBe(true);
  });

  it.each([
    '4155550123',
    '+04155550123',
    '+1415555',
    '+1234567890123456',
    '+1 415 555 0123',
    '',
    '+',
  ])('rejects %s', (v) => {
    expect(isE164(v)).toBe(false);
  });

  it('normalises common input shapes', () => {
    expect(normalizeE164('(415) 555-0123')).toBe('+14155550123');
    expect(normalizeE164('1-415-555-0123')).toBe('+14155550123');
    expect(normalizeE164('+44 20 7183 8750')).toBe('+442071838750');
    expect(normalizeE164('anonymous')).toBeNull();
    expect(normalizeE164('12345')).toBeNull();
  });

  it('recognises US toll-free prefixes only', () => {
    for (const p of ['800', '833', '844', '855', '866', '877', '888']) {
      expect(isUsTollFree(`+1${p}5550100`)).toBe(true);
    }
    expect(isUsTollFree('+18995550100')).toBe(false);
    expect(isUsTollFree('+14155550123')).toBe(false);
  });

  it('masks numbers for logs', () => {
    expect(maskE164('+14155550123')).toBe('+1415555****');
    expect(maskE164(null)).toBe('');
  });

  it('formats NANP numbers', () => {
    expect(formatPhone('+18005550100')).toBe('+1 (800) 555-0100');
    expect(formatPhone('+442071838750')).toBe('+442071838750');
  });
});
