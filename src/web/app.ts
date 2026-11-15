import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { fileURLToPath } from 'node:url';
import { type Actor, type Ctx, DomainError } from '../domain/core.js';
import { getOrg } from '../domain/orgs.js';
import { loadActor, loadSession } from '../domain/staff.js';
import { hmac, newToken, safeEqual } from '../lib/crypto.js';
import { html } from '../lib/html.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { caseRoutes } from './routes/cases.js';
import { hookRoutes } from './routes/hooks.js';
import { homeRoutes } from './routes/home.js';
import { operatorRoutes } from './routes/operator.js';
import { participantRoutes } from './routes/participants.js';
import { partnerRoutes } from './routes/partner.js';
import { printRoutes } from './routes/prints.js';
import { publicRoutes } from './routes/public.js';
import { errorPage, render, setDemoMode } from './ui.js';

export const SESSION_COOKIE = 'hb_session';
const CSRF_COOKIE = 'hb_csrf';

/** Paths reachable without a fully signed-in (MFA-verified) staff session. */
const OPEN_PATHS = [/^\/static\//, /^\/livez$/, /^\/login$/, /^\/logout$/, /^\/mfa(\/|$)/, /^\/hooks\//, /^\/me(\/|$)/, /^\/healthz$/, /^\/offline(\.html)?$/, /^\/sw\.js$/];

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  setDemoMode(ctx.config.demo);
  const app = Fastify({
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 3 * 1024 * 1024,
    logger: ctx.config.env === 'test' ? false : {
      level: ctx.config.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      // No query strings (search terms), no IP addresses, no participant ids beyond the route pattern.
      serializers: { req: (req: { method: string; routeOptions?: { url?: string } }) => ({ method: req.method, route: req.routeOptions?.url }) },
    },
  });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], workerSrc: ["'self'"],
        manifestSrc: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"], baseUri: ["'none'"], objectSrc: ["'none'"],
        upgradeInsecureRequests: ctx.config.production ? [] : null,
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: ctx.config.production ? { maxAge: 31536000, includeSubDomains: false } : false,
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', allowList: (req) => req.url.startsWith('/static/') });
  await app.register(fastifyStatic, { root: fileURLToPath(new URL('../../public/', import.meta.url)), prefix: '/static/', index: false, maxAge: ctx.config.production ? '1h' : 0 });

  app.decorateRequest('actor', null);
  app.decorateRequest('org', null);
  app.decorateRequest('sessionHash', null);
  app.decorateRequest('mfaOk', false);
  app.decorateRequest('csrf', '');

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    if (req.url.startsWith('/static/')) return;
    let csrfCookie = req.cookies[CSRF_COOKIE];
    if (!csrfCookie || csrfCookie.length < 20 || csrfCookie.length > 100) {
      csrfCookie = newToken();
      reply.setCookie(CSRF_COOKIE, csrfCookie, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.config.secureCookies });
      req.cookies[CSRF_COOKIE] = '';
    }
    req.csrf = hmac(ctx.config.secret, 'csrf', csrfCookie);
    const session = await loadSession(ctx, req.cookies[SESSION_COOKIE]);
    if (session) {
      const actor = await loadActor(ctx.db, session.staffId, session.sessionHash);
      if (actor) {
        req.actor = actor;
        req.sessionHash = session.sessionHash;
        req.mfaOk = session.mfaOk;
        req.org = await getOrg(ctx.db, actor.orgId);
      } else {
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
      }
    }
    const path = req.url.split('?')[0]!;
    if (OPEN_PATHS.some((r) => r.test(path))) return;
    if (!req.actor) return reply.redirect(`/login`, 303);
    if (!req.mfaOk) return reply.redirect('/mfa', 303);
  });

  // Cross-site request forgery: same-origin check plus a token bound to a per-browser cookie.
  // Provider webhooks are authenticated by signature instead.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.url.startsWith('/hooks/')) return;
    const origin = req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : undefined;
    const site = req.headers['sec-fetch-site'];
    if ((origin && !ctx.config.allowedOrigins.has(origin)) || site === 'cross-site' || site === 'same-site') return forbidden(req, reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sent = typeof body._csrf === 'string' ? body._csrf : typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : '';
    if (!req.cookies[CSRF_COOKIE] || !safeEqual(sent, req.csrf)) return forbidden(req, reply);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      if (req.headers.accept?.includes('application/json')) return reply.code(err.status).send({ error: err.message });
      return render(req, reply, { title: 'Something needs attention', body: errorPage(err.message) }, err.status);
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err: { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined } }, 'unhandled error');
    const message = status === 429 ? 'Too many requests. Please wait a minute.' : status === 413 ? 'That was too large.' : status < 500 ? 'The request could not be understood.' : 'Something went wrong on our side. It has been logged.';
    return render(req, reply, { title: 'Error', body: errorPage(message) }, status);
  });
  app.setNotFoundHandler((req, reply) => render(req, reply, { title: 'Not found', body: html`<h1>Not found</h1><p><a href="/">Home</a></p>` }, 404));

  const deps = { ctx };
  for (const r of [publicRoutes, authRoutes, homeRoutes, participantRoutes, caseRoutes, printRoutes, adminRoutes, operatorRoutes, partnerRoutes, hookRoutes]) {
    await app.register(async (s) => r(s, deps));
  }
  return app;
}

export type RouteDeps = { ctx: Ctx };

function forbidden(req: FastifyRequest, reply: FastifyReply) {
  return render(req, reply, { title: 'Please try again', body: html`<h1>Please try again</h1><p class="lead">This form expired or came from another site, so nothing was saved. Go back, reload the page and submit it again.</p><p><a href="/">Home</a></p>` }, 403);
}

/** The signed-in staff actor (the onRequest hook guarantees one on protected routes). */
export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new DomainError('Please sign in.', 401);
  return req.actor;
}

export function body(req: FastifyRequest): Record<string, string> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(b)) out[k] = Array.isArray(v) ? String(v[v.length - 1] ?? '') : v === undefined || v === null ? '' : String(v);
  return out;
}

export function bodyAll(req: FastifyRequest, key: string): string[] {
  const v = ((req.body ?? {}) as Record<string, unknown>)[key];
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

export function query(req: FastifyRequest): Record<string, string> {
  return (req.query ?? {}) as Record<string, string>;
}
