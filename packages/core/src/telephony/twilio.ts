import { z } from 'zod';
import type {
  AvailableNumber,
  InboundResponseInput,
  SearchNumbersInput,
  TelephonyProvider,
} from './provider';
import { ProviderError } from './provider';
import { verifyTwilioSignature } from './signature';
import { dialTwiml, emptyTwiml, sayHangupTwiml } from './twiml';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Defaults to https://api.twilio.com. Overridable for tests. */
  apiBase?: string;
  /** Public webhook URLs configured on every purchased number. */
  voiceUrl: string;
  statusUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const availableSchema = z.object({
  available_phone_numbers: z.array(
    z.object({
      phone_number: z.string(),
      region: z.string().nullable().optional(),
      iso_country: z.string().optional(),
    }),
  ),
});

const incomingSchema = z.object({ sid: z.string(), phone_number: z.string() });

const errorSchema = z.object({ message: z.string().optional(), code: z.number().optional() });

/**
 * Twilio Programmable Voice adapter (REST API 2010-04-01).
 * Webhook signatures use the account auth token; see `verifyTwilioSignature`.
 */
export class TwilioProvider implements TelephonyProvider {
  readonly id = 'twilio' as const;
  readonly responseContentType = 'text/xml; charset=utf-8';

  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: TwilioConfig) {
    if (!cfg.accountSid || !cfg.authToken) {
      throw new Error('TwilioProvider requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
    }
    this.base = `${(cfg.apiBase ?? 'https://api.twilio.com').replace(/\/$/, '')}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}`;
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  async searchNumbers(input: SearchNumbersInput): Promise<AvailableNumber[]> {
    const kind = input.type === 'toll_free' ? 'TollFree' : 'Local';
    const qs = new URLSearchParams({
      PageSize: String(Math.min(Math.max(input.limit * 3, 20), 100)),
    });
    qs.set('VoiceEnabled', 'true');
    if (input.prefix && input.type === 'local') qs.set('AreaCode', input.prefix);
    // Twilio "Contains" matches a pattern over the 10-digit national number; "*" is a wildcard.
    if (input.prefix && input.type === 'toll_free') {
      qs.set('Contains', `${input.prefix}${'*'.repeat(10 - input.prefix.length)}`);
    } else if (input.contains) {
      qs.set('Contains', input.contains);
    }
    const body = await this.request(
      'GET',
      `/AvailablePhoneNumbers/${input.country}/${kind}.json?${qs}`,
    );
    const parsed = availableSchema.parse(body);
    return parsed.available_phone_numbers
      .filter((n) => !input.prefix || n.phone_number.slice(2).startsWith(input.prefix))
      .filter((n) => !input.contains || n.phone_number.slice(5).includes(input.contains))
      .slice(0, input.limit)
      .map((n) => ({
        e164: n.phone_number,
        country: 'US' as const,
        numberType: input.type,
        region: n.region ?? null,
      }));
  }

  async purchaseNumber(e164: string): Promise<{ providerRef: string }> {
    const form = new URLSearchParams({
      PhoneNumber: e164,
      VoiceUrl: this.cfg.voiceUrl,
      VoiceMethod: 'POST',
      StatusCallback: this.cfg.statusUrl,
      StatusCallbackMethod: 'POST',
    });
    const body = await this.request('POST', '/IncomingPhoneNumbers.json', form);
    return { providerRef: incomingSchema.parse(body).sid };
  }

  async releaseNumber(providerRef: string): Promise<void> {
    await this.request('DELETE', `/IncomingPhoneNumbers/${encodeURIComponent(providerRef)}.json`);
  }

  async configureNumber(
    providerRef: string,
    cfg: { voiceUrl: string; statusUrl: string },
  ): Promise<void> {
    const form = new URLSearchParams({
      VoiceUrl: cfg.voiceUrl,
      VoiceMethod: 'POST',
      StatusCallback: cfg.statusUrl,
      StatusCallbackMethod: 'POST',
    });
    await this.request(
      'POST',
      `/IncomingPhoneNumbers/${encodeURIComponent(providerRef)}.json`,
      form,
    );
  }

  verifyWebhook(headers: Record<string, string>, rawBody: string, url: string): boolean {
    return verifyTwilioSignature(this.cfg.authToken, url, rawBody, headers['x-twilio-signature']);
  }

  buildInboundResponse(input: InboundResponseInput): string {
    return dialTwiml(input);
  }

  buildMessageAndHangup(message: string): string {
    return sayHangupTwiml(message);
  }

  buildEmptyResponse(): string {
    return emptyTwiml();
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    form?: URLSearchParams,
  ): Promise<unknown> {
    const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
    const headers: Record<string, string> = {
      authorization: `Basic ${auth}`,
      accept: 'application/json',
    };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: form?.toString(),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new ProviderError(`Twilio request failed: ${(err as Error).message}`, 'twilio');
    }
    if (res.status === 204) return null;
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
      const err = errorSchema.safeParse(json);
      throw new ProviderError(
        `Twilio ${method} ${path.split('?')[0]} failed: ${err.success && err.data.message ? err.data.message : res.statusText}`,
        'twilio',
        res.status,
        err.success ? err.data.code : undefined,
      );
    }
    return json;
  }
}
