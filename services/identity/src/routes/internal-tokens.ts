/** Gateway-facing token routes (`mintUserToken`, `authenticateRequest`) and the local signer's key set (`getJwks`). */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import type { Jwks, TokenRequest, TokenService, UserTokenResponse } from '../domain/tokens.js';
import type { components } from '../generated/openapi.js';
import { legacyApiSettings, type LegacyApiSettings } from './legacy-api.js';
import { legacyOriginEcho } from './legacy-origin.js';
import { authenticateRestRequest, type OAuthRouteDeps, type RestAuthInput, type RestAuthOutcome } from './oauth.js';

type Schemas = components['schemas'];
type Struct = Record<string, unknown>;

/** The token service and the REST credential flow the routes delegate to. */
export type TokenRouteDeps = {
  tokens: TokenService;
  rest: OAuthRouteDeps;
  /** The CORS allow-list's admin domains; defaults to `MURA_ADMINDOMAIN` of `process.env`. */
  legacy?: Pick<LegacyApiSettings, 'adminDomain'>;
};

// A minted token carries every role of its session, so only the gateway, which holds the client's session, may mint one.
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

/** Names of the request's params the credential block consumed: those its outcome no longer holds, ignoring case. */
function consumedParams(sent: Readonly<Struct>, remaining: Readonly<Struct>): string[] {
  const kept = new Set(Object.keys(remaining).map((name) => name.toLowerCase()));
  return Object.keys(sent).filter((name) => !kept.has(name.toLowerCase()));
}

/** The contract's `AuthenticateResponse` of a REST credential outcome: the request's session, or legacy's own answer behind its Origin echo. */
async function authenticateResponse(
  input: RestAuthInput,
  outcome: RestAuthOutcome,
  originEcho: () => Promise<Record<string, string>>,
): Promise<Schemas['AuthenticateResponse']> {
  if (outcome.kind === 'session') {
    // Only removals travel: values kept from exchanged Basic credentials stay here, as the client's Authorization never reaches services.
    return { outcome: 'authenticated', sessionId: outcome.sessionId, consumedParams: consumedParams(input.params, outcome.params) };
  }
  const { status, headers, body } = outcome;
  // processRequest echoes an allowed Origin before any credential code runs [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:382-394].
  const answer = { status, headers: { ...(await originEcho()), ...headers }, body };
  return { outcome: status >= FIRST_ERROR_STATUS ? 'denied' : 'answered', sessionId: null, legacyResponse: answer };
}

/** Registers the token mint and REST credential routes, which only the gateway may call, and the public JWKS. */
export async function registerTokenRoutes(app: FastifyInstance, deps: TokenRouteDeps): Promise<void> {
  const { tokens, rest } = deps;
  const { adminDomain } = deps.legacy ?? legacyApiSettings(process.env);

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
    async (request) => {
      const input = restAuthInput(request.body);
      const outcome = await authenticateRestRequest(rest, input);
      return authenticateResponse(input, outcome, () => legacyOriginEcho(rest.login.db, request.body.headers, adminDomain));
    },
  );

  app.get<{ Reply: Jwks }>('/.well-known/jwks.json', { config: { opt2: PUBLIC_AUTH } }, async () => tokens.jwks());
}
