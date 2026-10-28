export type ProviderId = 'mock' | 'twilio' | 'telnyx';
export type NumberType = 'toll_free' | 'local';

export interface SearchNumbersInput {
  country: 'US';
  type: NumberType;
  /** Area code / toll-free prefix, e.g. "833". */
  prefix?: string;
  /** Digits that must appear somewhere in the subscriber part. */
  contains?: string;
  limit: number;
}

export interface AvailableNumber {
  e164: string;
  country: 'US';
  numberType: NumberType;
  region: string | null;
}

export interface InboundResponseInput {
  callId: string;
  to: string;
  from: string;
  destination: string;
  ringTimeoutSec: number;
  resultUrl: string;
}

export interface TelephonyProvider {
  readonly id: ProviderId;
  searchNumbers(input: SearchNumbersInput): Promise<AvailableNumber[]>;
  purchaseNumber(e164: string): Promise<{ providerRef: string }>;
  releaseNumber(providerRef: string): Promise<void>;
  configureNumber(providerRef: string, cfg: { voiceUrl: string; statusUrl: string }): Promise<void>;
  /** `headers` keys must be lower-case. `url` is the exact public URL the carrier called. */
  verifyWebhook(headers: Record<string, string>, rawBody: string, url: string): boolean;
  buildInboundResponse(input: InboundResponseInput): string;
  /** Speak a short message and hang up (number not in service / not configured). */
  buildMessageAndHangup(message: string): string;
  /** A response that tells the carrier there is nothing more to do. */
  buildEmptyResponse(): string;
  /** Content-Type for the voice responses above. */
  readonly responseContentType: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly status?: number,
    readonly code?: string | number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/**
 * Inbound voice webhook parameters. Twilio, Telnyx TeXML and our mock provider
 * all send the same TwiML-style form field names, so one parser serves all three.
 */
export interface VoiceParams {
  callSid: string;
  from: string;
  to: string;
  callStatus?: string;
  dialCallStatus?: string;
  dialCallDuration?: string;
  dialCallSid?: string;
  callDuration?: string;
  stirVerstat?: string;
  raw: Record<string, string>;
}

export function parseVoiceParams(rawBody: string): VoiceParams | null {
  const params = new URLSearchParams(rawBody);
  const raw: Record<string, string> = {};
  for (const [k, v] of params) raw[k] = v;
  const callSid = raw.CallSid;
  if (!callSid || callSid.length > 128) return null;
  return {
    callSid,
    from: raw.From ?? '',
    to: raw.To ?? '',
    callStatus: raw.CallStatus,
    dialCallStatus: raw.DialCallStatus,
    dialCallDuration: raw.DialCallDuration,
    dialCallSid: raw.DialCallSid,
    callDuration: raw.CallDuration,
    stirVerstat: raw.StirVerstat,
    raw,
  };
}
