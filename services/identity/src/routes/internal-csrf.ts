/** Identity's CSRF arbitration routes (`consumeCsrfToken`, `claimCsrfToken`, `settleCsrfClaims`) and the in-process token check of identity's own carried routes. */
import { AuthDenial, serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import {
  csrfTokenFrom,
  type CsrfConsumeRequest,
  type CsrfConsumeResponse,
  type FastifyInstance,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { claimForLegacy, consumeToken, settleLegacy, type CsrfDeps } from '../domain/csrf.js';
import type { components } from '../generated/openapi.js';

type Schemas = components['schemas'];

/** The CSRF operations the routes and `validateCsrfForRoute` delegate to. */
export interface CsrfRouteDeps {
  csrf: CsrfDeps;
}

const CONSUME_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze(['people', 'programs-sites', 'strategies-content', 'identity', 'gateway'].map((name) => serviceRole(name))),
});

const GATEWAY_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([serviceRole('gateway')]) });

const TEXT = { type: 'string' } as const;

// CsrfConsumeRequest and CsrfClaimRequest share this shape in the contract; Fastify validates bodies once, before the handler.
const TOKEN_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'token', 'expires', 'context'],
  properties: { sessionId: TEXT, token: TEXT, expires: TEXT, context: TEXT },
} as const;

const SETTLE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'consumed', 'released'],
  properties: { sessionId: TEXT, consumed: { type: 'array', items: TEXT }, released: { type: 'array', items: TEXT } },
} as const;

/**
 * Validates and consumes the request's CSRF token for `context` in the caller's own identity session; false without a
 * session, token or expiry [legacy: core/mura/user/sessionUserFacade.cfc:206-235].
 */
export async function validateCsrfForRoute(deps: CsrfRouteDeps, request: FastifyRequest, context: string): Promise<boolean> {
  // The session comes from the verified user token only, never from a request parameter.
  const sessionId = request.opt2Auth.user?.sid;
  const { token, expires } = csrfTokenFrom(request);
  if (!sessionId || token === undefined || expires === undefined) return false;
  return (await consumeToken(deps.csrf, { sessionId, token, expires, context })).valid;
}

/** Registers the consume, legacy claim and legacy settle routes; every verdict answers 200 and the caller reacts as legacy does. */
export async function registerCsrfRoutes(app: FastifyInstance, deps: CsrfRouteDeps): Promise<void> {
  const { csrf } = deps;

  app.post<{ Body: CsrfConsumeRequest; Reply: CsrfConsumeResponse }>(
    '/internal/v1/csrf/consume',
    { schema: { body: TOKEN_BODY }, config: { opt2: CONSUME_AUTH } },
    async (request) => {
      // The caller relays the forwarded user token's session: no token is a missing credential, another session a refusal.
      const { user } = request.opt2Auth;
      if (user === undefined) throw AuthDenial.unauthenticated('missing-credential');
      if (request.body.sessionId !== user.sid) throw AuthDenial.forbidden();
      return consumeToken(csrf, request.body);
    },
  );

  app.post<{ Body: Schemas['CsrfClaimRequest']; Reply: Schemas['CsrfClaimResponse'] }>(
    '/internal/v1/csrf/claims',
    { schema: { body: TOKEN_BODY }, config: { opt2: GATEWAY_AUTH } },
    async (request) => claimForLegacy(csrf, request.body),
  );

  // `::` is Fastify's escape for a literal `:`, so the path is `/internal/v1/csrf/claims:settle`.
  app.post<{ Body: Schemas['CsrfSettleRequest']; Reply: Schemas['CsrfSettleResponse'] }>(
    '/internal/v1/csrf/claims::settle',
    { schema: { body: SETTLE_BODY }, config: { opt2: GATEWAY_AUTH } },
    async (request) => settleLegacy(csrf, request.body),
  );
}
