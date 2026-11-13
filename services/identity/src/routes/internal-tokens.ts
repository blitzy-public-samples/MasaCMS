/** Gateway-facing token routes (`mintUserToken`, `authenticateRequest`) and the local signer's key set (`getJwks`). */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import type { Jwks, TokenRequest, TokenService, UserTokenResponse } from '../domain/tokens.js';
import type { components } from '../generated/openapi.js';
import { authenticateRestRequest, type OAuthRouteDeps, type RestAuthInput, type RestAuthOutcome } from './oauth.js';

type Schemas = components['schemas'];
type Struct = Record<string, unknown>;

/** The token service and the REST credential flow the routes delegate to. */
export type TokenRouteDeps = { tokens: TokenService; rest: OAuthRouteDeps };

const GATEWAY_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([serviceRole('gateway')]) });

const PUBLIC_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', public: true });

/** Legacy's `siteid` fallback [legacy: core/mura/content/contentServer.cfc:610-622]. */
const DEFAULT_SITE_ID = 'default';

/** Lowest status of a legacy refusal; below it, legacy's answer is a token or token info. */
const FIRST_ERROR_STATUS = 400;

const TEXT = { type: 'string' } as const;
const SITE_ID = { type: 'string', minLength: 1 } as const;
const SCOPE = { type: 'object', additionalProperties: true } as const;

// TokenRequest and AuthenticateRequest as the contract declares them; Fastify validates bodies once, before the handler.
const TOKEN_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'siteId'],
  properties: { sessionId: { type: 'string', minLength: 1 }, siteId: SITE_ID },
} as const;

const AUTHENTICATE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['method', 'path', 'headers', 'query'],
  properties: {
    method: TEXT,
    path: TEXT,
    siteId: SITE_ID,
    headers: { type: 'object', additionalProperties: { anyOf: [TEXT, { type: 'array', items: TEXT }] } },
    query: SCOPE,
    form: SCOPE,
    body: {},
  },
} as const;

function isStruct(value: unknown): value is Struct {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** CFML `structAppend(target, source)`: a source key replaces the target key equal to it ignoring case. */
function structAppend(target: Struct, source: Struct): Struct {
  for (const [key, value] of Object.entries(source)) {
    const wanted = key.toLowerCase();
    for (const name of Object.keys(target)) if (name.toLowerCase() === wanted) delete target[name];
    target[key] = value;
  }
  return target;
}

/** The request facts `processRequest` reads: params merged from the URL, the form, then a JSON struct body [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:405-412]. */
function restAuthInput(body: Schemas['AuthenticateRequest']): RestAuthInput {
  const params = structAppend(structAppend(structAppend({}, body.query), body.form ?? {}), isStruct(body.body) ? body.body : {});
  return {
    path: body.path,
    httpMethod: body.method,
    // A repeated header reads as one comma-separated value, as Node and the servlet container join it.
    headers: Object.fromEntries(Object.entries(body.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value])),
    // URL scope values are text; a repeated key holds its values comma-joined, as `String` of a list gives them.
    query: Object.fromEntries(Object.entries(body.query).map(([name, value]) => [name, String(value)])),
    params,
    siteId: body.siteId ?? DEFAULT_SITE_ID,
  };
}

/** The contract's `AuthenticateResponse` of a REST credential outcome: the request's session, or legacy's own answer. */
function authenticateResponse(outcome: RestAuthOutcome): Schemas['AuthenticateResponse'] {
  if (outcome.kind === 'session') return { outcome: 'authenticated', sessionId: outcome.sessionId };
  const { status, headers, body } = outcome;
  return { outcome: status >= FIRST_ERROR_STATUS ? 'denied' : 'answered', sessionId: null, legacyResponse: { status, headers, body } };
}

/** Registers the token mint and REST credential routes, which only the gateway may call, and the public JWKS. */
export async function registerTokenRoutes(app: FastifyInstance, deps: TokenRouteDeps): Promise<void> {
  const { tokens, rest } = deps;

  // Claims come from identity's own session state; the body names only the session and the site.
  app.post<{ Body: TokenRequest; Reply: UserTokenResponse }>(
    '/internal/v1/tokens',
    { schema: { body: TOKEN_BODY }, config: { opt2: GATEWAY_AUTH } },
    async (request) => tokens.mint({ sessionId: request.body.sessionId, siteId: request.body.siteId }),
  );

  // The wire is the contract's AuthenticateRequest and AuthenticateResponse, which the gateway's client speaks; the REST flow's input and outcome stay internal.
  app.post<{ Body: Schemas['AuthenticateRequest']; Reply: Schemas['AuthenticateResponse'] }>(
    '/internal/v1/authenticate',
    { schema: { body: AUTHENTICATE_BODY }, config: { opt2: GATEWAY_AUTH } },
    async (request) => authenticateResponse(await authenticateRestRequest(rest, restAuthInput(request.body))),
  );

  app.get<{ Reply: Jwks }>('/.well-known/jwks.json', { config: { opt2: PUBLIC_AUTH } }, async () => tokens.jwks());
}
