import { isE164 } from '../e164';
import type { DialInput, GatherInput } from './provider';

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
 * <Dial> to one destination (sequential) or several at once (simultaneous: the
 * first to answer wins and the carrier cancels the rest). TwiML and Telnyx TeXML
 * share this syntax. The dialled number is presented as caller ID on forwarded
 * legs, and answerOnBridge keeps the caller hearing ringback until a destination
 * actually answers. Each <Number> can report its own leg status.
 */
export function dialTwiml(input: DialInput): string {
  if (input.numbers.length === 0) throw new RangeError('at least one destination is required');
  if (!isE164(input.callerId)) throw new RangeError('callerId must be E.164');
  const timeout = Math.min(Math.max(Math.trunc(input.ringTimeoutSec), 5), 120);
  const numbers = input.numbers
    .map((n) => {
      if (!isE164(n.destination)) throw new RangeError('destination must be E.164');
      const cb = n.statusCallbackUrl
        ? ` statusCallbackEvent="initiated ringing answered completed" statusCallback="${escapeXml(n.statusCallbackUrl)}" statusCallbackMethod="POST"`
        : '';
      return `<Number${cb}>${escapeXml(n.destination)}</Number>`;
    })
    .join('');
  return (
    `${XML_DECL}<Response>` +
    `<Dial timeout="${timeout}" answerOnBridge="true" callerId="${escapeXml(input.callerId)}" ` +
    `action="${escapeXml(input.actionUrl)}" method="POST">${numbers}</Dial></Response>`
  );
}

/** Press-a-digit gate: one digit, then the carrier posts `Digits` to `actionUrl`. */
export function gatherTwiml(input: GatherInput): string {
  const timeout = Math.min(Math.max(Math.trunc(input.timeoutSec), 3), 30);
  return (
    `${XML_DECL}<Response>` +
    `<Gather numDigits="1" timeout="${timeout}" action="${escapeXml(input.actionUrl)}" method="POST" actionOnEmptyResult="true">` +
    `<Say>${escapeXml(input.prompt)}</Say></Gather>` +
    `<Say>${escapeXml(input.noInputMessage)}</Say><Hangup/></Response>`
  );
}

/** Decline without answering (no billable connection for blocked callers). */
export function rejectTwiml(): string {
  return `${XML_DECL}<Response><Reject reason="busy"/></Response>`;
}

export function sayHangupTwiml(message: string): string {
  return `${XML_DECL}<Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`;
}

export function emptyTwiml(): string {
  return `${XML_DECL}<Response/>`;
}
