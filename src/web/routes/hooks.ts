import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { handleInboundSms, voiceAfterId, voiceAfterPin, voiceGreeting } from '../../domain/sms.js';
import type { RouteDeps } from '../app.js';

/**
 * Provider webhooks (Twilio-compatible). Authenticated by request signature, not session or CSRF.
 * Responses never reveal whether a number or code belongs to a participant.
 */
export async function hookRoutes(app: FastifyInstance, { ctx }: RouteDeps) {
  const verify = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!ctx.config.verifyWebhooks) return true;
    const url = `${ctx.config.publicUrl}${req.url}`;
    const params = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    const sig = req.headers['x-twilio-signature'];
    if (!ctx.sms.verifyWebhook(url, params, typeof sig === 'string' ? sig : undefined)) {
      void reply.code(403).send('forbidden');
      return false;
    }
    return true;
  };
  const xml = (reply: FastifyReply, s: string) => reply.type('text/xml; charset=utf-8').send(s);
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

  app.post('/hooks/sms', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!verify(req, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, string>;
    const out = await handleInboundSms(ctx, { from: b.From ?? '', to: b.To ?? '', body: b.Body ?? '', providerId: b.MessageSid });
    return xml(reply, `<?xml version="1.0" encoding="UTF-8"?><Response>${out ? `<Message>${esc(out)}</Message>` : ''}</Response>`);
  });

  app.post('/hooks/voice', async (req, reply) => {
    if (!verify(req, reply)) return reply;
    return xml(reply, await voiceGreeting(ctx, ((req.body ?? {}) as Record<string, string>).To ?? ''));
  });
  app.post('/hooks/voice/id', async (req, reply) => {
    if (!verify(req, reply)) return reply;
    return xml(reply, voiceAfterId(ctx, ((req.body ?? {}) as Record<string, string>).Digits ?? ''));
  });
  app.post('/hooks/voice/pin', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!verify(req, reply)) return reply;
    const s = ((req.query ?? {}) as Record<string, string>).s ?? '';
    return xml(reply, await voiceAfterPin(ctx, s, ((req.body ?? {}) as Record<string, string>).Digits ?? ''));
  });
}
