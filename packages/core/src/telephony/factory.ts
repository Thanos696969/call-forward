import { MockProvider } from './mock';
import type { ProviderId, TelephonyProvider } from './provider';
import { TelnyxProvider } from './telnyx';
import { TwilioProvider } from './twilio';

export interface ProviderEnv {
  TELEPHONY_PROVIDER?: string | undefined;
  MOCK_WEBHOOK_SECRET?: string | undefined;
  TWILIO_ACCOUNT_SID?: string | undefined;
  TWILIO_AUTH_TOKEN?: string | undefined;
  TWILIO_API_BASE?: string | undefined;
}

/** Explicit TELEPHONY_PROVIDER wins; otherwise Twilio when its keys are present, else mock. */
export function resolveProviderId(env: ProviderEnv): ProviderId {
  const explicit = env.TELEPHONY_PROVIDER?.trim().toLowerCase();
  if (explicit === 'mock' || explicit === 'twilio' || explicit === 'telnyx') return explicit;
  if (explicit)
    throw new Error(`Unknown TELEPHONY_PROVIDER "${explicit}" (expected mock|twilio|telnyx)`);
  return env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? 'twilio' : 'mock';
}

export function createProvider(
  env: ProviderEnv,
  urls: { voiceUrl: string; statusUrl: string },
): TelephonyProvider {
  const id = resolveProviderId(env);
  switch (id) {
    case 'mock':
      return new MockProvider({ webhookSecret: env.MOCK_WEBHOOK_SECRET ?? '' });
    case 'twilio':
      return new TwilioProvider({
        accountSid: env.TWILIO_ACCOUNT_SID ?? '',
        authToken: env.TWILIO_AUTH_TOKEN ?? '',
        apiBase: env.TWILIO_API_BASE || undefined,
        voiceUrl: urls.voiceUrl,
        statusUrl: urls.statusUrl,
      });
    case 'telnyx':
      return new TelnyxProvider();
  }
}
