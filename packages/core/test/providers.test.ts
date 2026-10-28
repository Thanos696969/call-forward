import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/telephony/mock';
import { ProviderError, parseVoiceParams } from '../src/telephony/provider';
import { TelnyxProvider } from '../src/telephony/telnyx';
import { TwilioProvider } from '../src/telephony/twilio';
import { createProvider, resolveProviderId } from '../src/telephony/factory';
import { dialTwiml } from '../src/telephony/twiml';

describe('TwiML', () => {
  it('builds a dial with caller ID, answerOnBridge and action', () => {
    const xml = dialTwiml({
      callId: 'c1',
      to: '+18005550100',
      from: '+15551230000',
      destination: '+14155550123',
      ringTimeoutSec: 25,
      resultUrl: 'https://api.example.com/voice/result',
    });
    expect(xml).toContain(
      '<Dial timeout="25" answerOnBridge="true" callerId="+18005550100" action="https://api.example.com/voice/result" method="POST"><Number>+14155550123</Number></Dial>',
    );
  });

  it('refuses non-E.164 destinations (no XML injection)', () => {
    expect(() =>
      dialTwiml({
        callId: 'c',
        to: '+18005550100',
        from: '',
        destination: '+1</Number><Play>x',
        ringTimeoutSec: 25,
        resultUrl: 'u',
      }),
    ).toThrow();
  });

  it('escapes spoken text', () => {
    const p = new MockProvider({ webhookSecret: 's' });
    expect(p.buildMessageAndHangup('a < b & "c"')).toContain(
      '<Say>a &lt; b &amp; &quot;c&quot;</Say><Hangup/>',
    );
  });
});

describe('MockProvider', () => {
  const p = new MockProvider({ webhookSecret: 's' });
  it('has a deterministic toll-free inventory', async () => {
    const all = await p.searchNumbers({ country: 'US', type: 'toll_free', limit: 500 });
    expect(all).toHaveLength(100 + 6 * 20);
    expect(all[0]?.e164).toBe('+18005550100');
  });
  it('filters by prefix and contains', async () => {
    const r = await p.searchNumbers({
      country: 'US',
      type: 'toll_free',
      prefix: '833',
      contains: '0105',
      limit: 5,
    });
    expect(r.map((n) => n.e164)).toEqual(['+18335550105']);
    expect(await p.searchNumbers({ country: 'US', type: 'local', limit: 5 })).toEqual([]);
  });
  it('only sells numbers it has', async () => {
    await expect(p.purchaseNumber('+18005550100')).resolves.toEqual({
      providerRef: 'MOCK18005550100',
    });
    await expect(p.purchaseNumber('+18009999999')).rejects.toThrow();
  });
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

describe('TwilioProvider (recorded fixtures)', () => {
  const base = {
    accountSid: 'AC123',
    authToken: 'tok',
    voiceUrl: 'https://api.example.com/voice/inbound',
    statusUrl: 'https://api.example.com/voice/status',
  };

  it('searches toll-free inventory with a prefix pattern', async () => {
    const f = fakeFetch(() =>
      Response.json({
        available_phone_numbers: [
          { phone_number: '+18335550142', region: null },
          { phone_number: '+18445550100', region: null },
        ],
      }),
    );
    const p = new TwilioProvider({ ...base, fetch: f.fn });
    const r = await p.searchNumbers({ country: 'US', type: 'toll_free', prefix: '833', limit: 10 });
    expect(r.map((n) => n.e164)).toEqual(['+18335550142']);
    const url = new URL(f.calls[0]!.url);
    expect(url.pathname).toBe('/2010-04-01/Accounts/AC123/AvailablePhoneNumbers/US/TollFree.json');
    expect(url.searchParams.get('Contains')).toBe('833*******');
    expect(f.calls[0]!.init.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('AC123:tok').toString('base64')}`,
    });
  });

  it('passes Contains when searching by digits', async () => {
    const f = fakeFetch(() => Response.json({ available_phone_numbers: [] }));
    const p = new TwilioProvider({ ...base, fetch: f.fn });
    await p.searchNumbers({ country: 'US', type: 'toll_free', contains: '2024', limit: 10 });
    expect(new URL(f.calls[0]!.url).searchParams.get('Contains')).toBe('2024');
  });

  it('purchases with webhook configuration', async () => {
    const f = fakeFetch(() =>
      Response.json({ sid: 'PN999', phone_number: '+18335550142' }, { status: 201 }),
    );
    const p = new TwilioProvider({ ...base, fetch: f.fn });
    await expect(p.purchaseNumber('+18335550142')).resolves.toEqual({ providerRef: 'PN999' });
    const form = new URLSearchParams(String(f.calls[0]!.init.body));
    expect(f.calls[0]!.url).toMatch(/\/IncomingPhoneNumbers\.json$/);
    expect(Object.fromEntries(form)).toEqual({
      PhoneNumber: '+18335550142',
      VoiceUrl: base.voiceUrl,
      VoiceMethod: 'POST',
      StatusCallback: base.statusUrl,
      StatusCallbackMethod: 'POST',
    });
  });

  it('maps API errors to ProviderError', async () => {
    const f = fakeFetch(() =>
      Response.json({ code: 21422, message: 'PhoneNumber is not available' }, { status: 400 }),
    );
    const p = new TwilioProvider({ ...base, fetch: f.fn });
    const err = await p.purchaseNumber('+18335550142').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ status: 400, code: 21422 });
  });

  it('releases with DELETE and handles 204', async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    const p = new TwilioProvider({ ...base, fetch: f.fn });
    await p.releaseNumber('PN999');
    expect(f.calls[0]!.init.method).toBe('DELETE');
    expect(f.calls[0]!.url).toMatch(/\/IncomingPhoneNumbers\/PN999\.json$/);
  });
});

describe('provider selection', () => {
  it('prefers explicit TELEPHONY_PROVIDER, else Twilio when keys exist, else mock', () => {
    expect(resolveProviderId({ TELEPHONY_PROVIDER: 'telnyx' })).toBe('telnyx');
    expect(resolveProviderId({ TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b' })).toBe('twilio');
    expect(resolveProviderId({})).toBe('mock');
    expect(() => resolveProviderId({ TELEPHONY_PROVIDER: 'nope' })).toThrow();
  });
  it('Telnyx is a stub that fails loudly', async () => {
    const t = createProvider({ TELEPHONY_PROVIDER: 'telnyx' }, { voiceUrl: 'v', statusUrl: 's' });
    expect(t).toBeInstanceOf(TelnyxProvider);
    await expect(t.searchNumbers({ country: 'US', type: 'toll_free', limit: 1 })).rejects.toThrow(
      /not implemented/,
    );
  });
});

describe('parseVoiceParams', () => {
  it('reads TwiML-style fields', () => {
    const p = parseVoiceParams(
      'CallSid=CA1&From=%2B1555&To=%2B1800&DialCallStatus=completed&DialCallDuration=7',
    );
    expect(p).toMatchObject({
      callSid: 'CA1',
      from: '+1555',
      to: '+1800',
      dialCallStatus: 'completed',
      dialCallDuration: '7',
    });
    expect(parseVoiceParams('From=x')).toBeNull();
  });
});
