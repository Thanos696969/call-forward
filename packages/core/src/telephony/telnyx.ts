import type {
  AvailableNumber,
  InboundResponseInput,
  SearchNumbersInput,
  TelephonyProvider,
} from './provider';
import { NotImplementedError } from './provider';

/**
 * Telnyx adapter: interface-complete, not implemented in Phase 1.
 *
 * Mapping for the implementation (TeXML keeps the voice path identical to Twilio):
 * - searchNumbers   → GET  /v2/available_phone_numbers?filter[country_code]=US
 *                      &filter[number_type]=toll_free&filter[national_destination_code]={prefix}
 *                      &filter[phone_number][contains]={contains}&filter[limit]={limit}
 * - purchaseNumber  → POST /v2/number_orders { phone_numbers: [{ phone_number }],
 *                      connection_id: <TeXML application id> }; providerRef = phone number id
 * - releaseNumber   → DELETE /v2/phone_numbers/{id}
 * - configureNumber → PATCH /v2/texml_applications/{app_id} { voice_url, status_callback }
 *                      (the TeXML application carries the webhook URLs for all its numbers)
 * - verifyWebhook   → Ed25519: verify `telnyx-signature-ed25519` over
 *                      `${telnyx-timestamp}|${rawBody}` with the account public key,
 *                      rejecting timestamps outside a 5-minute window.
 * - responses       → TeXML is TwiML-compatible: reuse dialTwiml / sayHangupTwiml / emptyTwiml.
 * - webhook fields  → TeXML posts CallSid/From/To/DialCallStatus, so parseVoiceParams applies.
 */
export class TelnyxProvider implements TelephonyProvider {
  readonly id = 'telnyx' as const;
  readonly responseContentType = 'text/xml; charset=utf-8';

  async searchNumbers(_input: SearchNumbersInput): Promise<AvailableNumber[]> {
    throw new NotImplementedError('TelnyxProvider.searchNumbers');
  }
  async purchaseNumber(_e164: string): Promise<{ providerRef: string }> {
    throw new NotImplementedError('TelnyxProvider.purchaseNumber');
  }
  async releaseNumber(_providerRef: string): Promise<void> {
    throw new NotImplementedError('TelnyxProvider.releaseNumber');
  }
  async configureNumber(
    _providerRef: string,
    _cfg: { voiceUrl: string; statusUrl: string },
  ): Promise<void> {
    throw new NotImplementedError('TelnyxProvider.configureNumber');
  }
  verifyWebhook(_headers: Record<string, string>, _rawBody: string, _url: string): boolean {
    throw new NotImplementedError('TelnyxProvider.verifyWebhook');
  }
  buildInboundResponse(_input: InboundResponseInput): string {
    throw new NotImplementedError('TelnyxProvider.buildInboundResponse');
  }
  buildMessageAndHangup(_message: string): string {
    throw new NotImplementedError('TelnyxProvider.buildMessageAndHangup');
  }
  buildEmptyResponse(): string {
    throw new NotImplementedError('TelnyxProvider.buildEmptyResponse');
  }
}
