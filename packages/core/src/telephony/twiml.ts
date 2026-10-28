import { isE164 } from '../e164';
import type { InboundResponseInput } from './provider';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * <Dial> to a single phone destination. TwiML and Telnyx TeXML share this
 * syntax. The dialled number is presented as caller ID on the forwarded leg
 * (carriers only allow caller IDs you own or verified), and answerOnBridge
 * keeps the caller hearing ringback until the destination actually answers.
 */
export function dialTwiml(input: InboundResponseInput): string {
  if (!isE164(input.destination)) throw new RangeError('destination must be E.164');
  if (!isE164(input.to)) throw new RangeError('to must be E.164');
  const timeout = Math.min(Math.max(Math.trunc(input.ringTimeoutSec), 5), 120);
  return (
    `${XML_DECL}<Response>` +
    `<Dial timeout="${timeout}" answerOnBridge="true" callerId="${escapeXml(input.to)}" ` +
    `action="${escapeXml(input.resultUrl)}" method="POST">` +
    `<Number>${escapeXml(input.destination)}</Number>` +
    `</Dial></Response>`
  );
}

export function sayHangupTwiml(message: string): string {
  return `${XML_DECL}<Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`;
}

export function emptyTwiml(): string {
  return `${XML_DECL}<Response/>`;
}
