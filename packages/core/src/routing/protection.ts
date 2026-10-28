import type { AttestationPolicy } from './types';

export type Attestation = 'A' | 'B' | 'C' | 'failed' | 'none';

/**
 * Normalise a STIR/SHAKEN verification result. Twilio sends `StirVerstat`
 * values such as "TN-Validation-Passed-A", "TN-Validation-Failed-B" or
 * "No-TN-Validation"; anything unrecognised counts as no attestation.
 */
export function parseAttestation(verstat: string | null | undefined): Attestation {
  const v = (verstat ?? '').trim().toLowerCase();
  if (!v) return 'none';
  if (v.includes('failed')) return 'failed';
  const passed = /passed-([abc])$/.exec(v);
  if (passed?.[1]) return passed[1].toUpperCase() as 'A' | 'B' | 'C';
  return 'none';
}

export function attestationAllows(policy: AttestationPolicy, attestation: Attestation): boolean {
  switch (policy) {
    case 'allow_all':
      return true;
    case 'block_failed':
      return attestation !== 'failed';
    case 'require_a_or_b':
      return attestation === 'A' || attestation === 'B';
    case 'require_a':
      return attestation === 'A';
  }
}

export const DEFAULT_IVR_PROMPT = 'Thanks for calling. To be connected, press {digit}.';
export const IVR_NO_INPUT = "We didn't get your response. Goodbye.";
export const IVR_WRONG_DIGIT = 'That was not the right key. Goodbye.';
export const DEFAULT_UNAVAILABLE =
  'Sorry, nobody is available to take your call right now. Please try again later.';

/** A digit 1–9 (0 is avoided: some keypads and IVR habits treat it as "operator"). */
export function randomIvrDigit(random: number): string {
  return String(1 + Math.min(8, Math.floor(Math.max(0, random) * 9)));
}

/** Insert the digit into the prompt; append an instruction if the template forgot `{digit}`. */
export function renderIvrPrompt(template: string | null | undefined, digit: string): string {
  const base = (template ?? '').trim() || DEFAULT_IVR_PROMPT;
  return base.includes('{digit}')
    ? base.replaceAll('{digit}', digit)
    : `${base} Press ${digit} to continue.`;
}
