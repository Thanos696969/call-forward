import { US_TOLL_FREE_PREFIXES } from '../e164';
import type {
  AvailableNumber,
  InboundResponseInput,
  SearchNumbersInput,
  TelephonyProvider,
} from './provider';
import { verifyMockSignature } from './signature';
import { dialTwiml, emptyTwiml, sayHangupTwiml } from './twiml';

/**
 * Deterministic in-process carrier for local development and tests.
 *
 * Inventory: +1800555 0100..0199 (100 numbers) plus +1{833,844,855,866,877,888}555 0100..0119
 * (20 each). Webhooks are authenticated with an HMAC shared secret and a
 * timestamp (see `signMockWebhook`), so simulated calls cannot be spoofed.
 */
export class MockProvider implements TelephonyProvider {
  readonly id = 'mock' as const;
  readonly responseContentType = 'text/xml; charset=utf-8';

  private readonly inventory: AvailableNumber[];

  constructor(private readonly opts: { webhookSecret: string; now?: () => number }) {
    if (!opts.webhookSecret) throw new Error('MockProvider requires a webhook secret');
    this.inventory = buildInventory();
  }

  async searchNumbers(input: SearchNumbersInput): Promise<AvailableNumber[]> {
    const prefix = input.prefix ?? '';
    const contains = input.contains ?? '';
    return this.inventory
      .filter((n) => n.numberType === input.type)
      .filter((n) => n.e164.slice(2).startsWith(prefix))
      .filter((n) => n.e164.slice(5).includes(contains))
      .slice(0, input.limit);
  }

  async purchaseNumber(e164: string): Promise<{ providerRef: string }> {
    if (!this.inventory.some((n) => n.e164 === e164)) {
      throw new Error(`Mock inventory does not contain ${e164}`);
    }
    return { providerRef: `MOCK${e164.slice(1)}` };
  }

  async releaseNumber(_providerRef: string): Promise<void> {}

  async configureNumber(
    _providerRef: string,
    _cfg: { voiceUrl: string; statusUrl: string },
  ): Promise<void> {}

  verifyWebhook(headers: Record<string, string>, rawBody: string, url: string): boolean {
    const nowSec = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    return verifyMockSignature(this.opts.webhookSecret, headers, rawBody, url, nowSec);
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
}

function buildInventory(): AvailableNumber[] {
  const out: AvailableNumber[] = [];
  for (const prefix of US_TOLL_FREE_PREFIXES) {
    const count = prefix === '800' ? 100 : 20;
    for (let i = 0; i < count; i++) {
      out.push({
        e164: `+1${prefix}555${String(100 + i).padStart(4, '0')}`,
        country: 'US',
        numberType: 'toll_free',
        region: null,
      });
    }
  }
  return out;
}
