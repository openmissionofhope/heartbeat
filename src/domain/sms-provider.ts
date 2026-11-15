import { createHmac } from 'node:crypto';
import type { Config } from '../config.js';
import { safeEqual } from '../lib/crypto.js';

export interface OutboundSms {
  from: string;
  to: string;
  body: string;
}

export interface SmsProvider {
  readonly name: string;
  send(m: OutboundSms): Promise<{ providerId: string }>;
  /** Verifies a webhook signature for the full public URL and form parameters. */
  verifyWebhook(url: string, params: Record<string, string>, signature: string | undefined): boolean;
}

/** Records messages in memory and accepts any webhook (development and tests). */
export class MemorySms implements SmsProvider {
  readonly name = 'memory';
  sent: OutboundSms[] = [];
  fail = false;
  async send(m: OutboundSms) {
    if (this.fail) throw new Error('simulated SMS failure');
    this.sent.push(m);
    return { providerId: `mem-${this.sent.length}` };
  }
  verifyWebhook(): boolean {
    return true;
  }
}

/**
 * Twilio Programmable Messaging over its REST API, without the SDK. Webhook signatures are
 * HMAC-SHA1 of the URL followed by the sorted POST parameters, keyed with the auth token.
 */
export class TwilioSms implements SmsProvider {
  readonly name = 'twilio';
  constructor(private accountSid: string, private authToken: string) {}

  async send(m: OutboundSms) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: m.from, To: m.to, Body: m.body }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok || !json.sid) throw new Error(`Twilio send failed: ${res.status} ${json.message ?? ''}`.trim());
    return { providerId: json.sid };
  }

  verifyWebhook(url: string, params: Record<string, string>, signature: string | undefined): boolean {
    if (!signature) return false;
    return safeEqual(twilioSignature(this.authToken, url, params), signature);
  }
}

export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function createSmsProvider(config: Config): SmsProvider {
  if (config.sms.provider === 'twilio') return new TwilioSms(config.sms.twilioAccountSid!, config.sms.twilioAuthToken!);
  const mem = new MemorySms();
  if (config.env === 'development') {
    const send = mem.send.bind(mem);
    mem.send = async (m) => {
      console.log(`[sms] from=${m.from} to=${m.to}\n${m.body}`);
      return send(m);
    };
  }
  return mem;
}
