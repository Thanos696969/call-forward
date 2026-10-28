/** E.164: a plus sign, a non-zero country code digit, then 7–14 more digits. */
export const E164_REGEX = /^\+[1-9]\d{7,14}$/;

/** US toll-free area codes we sell (NANP). */
export const US_TOLL_FREE_PREFIXES = ['800', '833', '844', '855', '866', '877', '888'] as const;
export type UsTollFreePrefix = (typeof US_TOLL_FREE_PREFIXES)[number];

const US_TOLL_FREE_REGEX = new RegExp(`^\\+1(${US_TOLL_FREE_PREFIXES.join('|')})\\d{7}$`);

export function isE164(value: string): boolean {
  return E164_REGEX.test(value);
}

export function isUsTollFree(value: string): boolean {
  return US_TOLL_FREE_REGEX.test(value);
}

/**
 * Normalise carrier or user input to E.164.
 * Accepts formatting characters, bare 10-digit NANP numbers and 11-digit numbers
 * starting with 1. Returns null when the input cannot be an E.164 number.
 */
export function normalizeE164(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  let candidate: string;
  if (hasPlus) {
    candidate = `+${digits}`;
  } else if (digits.length === 10) {
    candidate = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    candidate = `+${digits}`;
  } else {
    return null;
  }
  return isE164(candidate) ? candidate : null;
}

/** Mask a number for logs: +1833555****. Never log full numbers. */
export function maskE164(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 6) return '****';
  return `${value.slice(0, -4)}****`;
}

/** Human formatting for NANP numbers; other numbers are returned unchanged. */
export function formatPhone(value: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value);
  if (!m) return value;
  return `+1 (${m[1]}) ${m[2]}-${m[3]}`;
}
