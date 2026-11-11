// Route-level CSRF hook of @opt2/platform/service-kit: identity validates and consumes each token, once.
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
  LegacyApiError,
} from '../legacy-compat/index.js';
import { ServiceUnavailableError } from './client.js';
import { legacyParamsOf } from './create-service.js';

/** Identity route that validates a token for a context and consumes it. */
export const CSRF_CONSUME_PATH = '/internal/v1/csrf/consume';

/** Service that arbitrates CSRF single use across legacy and target. */
export const IDENTITY_SERVICE = 'identity';

/** Body of identity's consume call. */
export interface CsrfConsumeRequest {
  /** Identity session id, the verified user token's `sid`. */
  sessionId: string;
  token: string;
  /** `yyMMddHHnnsslll` expiry sent with the token. */
  expires: string;
  /** The route's legacy `validateCSRFTokens(context=…)` value. */
  context: string;
}

/** Identity's verdict: `valid` is true only when the token was valid and is now consumed. */
export interface CsrfConsumeResponse {
  valid: boolean;
}

/** Options of {@link csrfPreHandler}. */
export interface CsrfPreHandlerOptions {
  /** The route's legacy `validateCSRFTokens(context=…)` value. */
  contextOf: (request: FastifyRequest) => string;
  /**
   * Answers a rejected request, such as an admin form re-render, or leaves the reply unsent so the handler runs, as for
   * actions that only skip their writes; without it the JSON API `invalidTokens` 400 is thrown.
   */
  onReject?: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;
}

/** The merged param under `name` ignoring case, when it is a string. */
function paramString(params: Record<string, unknown>, name: string): string | undefined {
  const key = Object.keys(params).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : params[key];
  return typeof value === 'string' ? value : undefined;
}

/** The first value of the request header `name`. */
function headerString(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** The request's CSRF token and expiry from url, body, then `X-csrf_token*` headers, later winning; empty is absent. */
export function csrfTokenFrom(request: FastifyRequest): { token?: string; expires?: string } {
  // Url and body merge as CFML scopes hold them: a repeated field stays comma-joined, as with
  // sameformfieldsasarray=false, so a duplicated token fails validation exactly as it does in legacy.
  const params = legacyParamsOf(request);
  // A header present but empty still overwrites, as legacy's structKeyExists copy does.
  const token = headerString(request, CSRF_HEADER_TOKEN) ?? paramString(params, CSRF_FIELD_TOKEN);
  const expires = headerString(request, CSRF_HEADER_EXPIRES) ?? paramString(params, CSRF_FIELD_EXPIRES);
  const found: { token?: string; expires?: string } = {};
  if (token) found.token = token;
  if (expires) found.expires = expires;
  return found;
}

/** Opt-in route preHandler: identity validates and consumes the request's CSRF token before the handler runs. */
export function csrfPreHandler(opts: CsrfPreHandlerOptions): preHandlerAsyncHookHandler {
  return async function consumeCsrfToken(request, reply) {
    const sessionId = request.opt2Auth.user?.sid;
    const { token, expires } = csrfTokenFrom(request);
    // Legacy validation fails without a session, a token or an expiry (sessionUserFacade.cfc:206-235).
    if (sessionId && token !== undefined && expires !== undefined) {
      const consume: CsrfConsumeRequest = { sessionId, token, expires, context: opts.contextOf(request) };
      const response = await request.server.opt2.client.request<CsrfConsumeResponse | undefined>({
        service: IDENTITY_SERVICE,
        method: 'POST',
        path: CSRF_CONSUME_PATH,
        json: consume,
      });
      if (response.status < 200 || response.status > 299) {
        const cause = Object.assign(new Error(`${IDENTITY_SERVICE} answered HTTP ${response.status}`), {
          code: `HTTP_${response.status}`,
        });
        throw new ServiceUnavailableError(IDENTITY_SERVICE, cause);
      }
      if (response.body?.valid === true) return;
    }
    if (opts.onReject === undefined) throw new LegacyApiError('invalidTokens');
    await opts.onReject(request, reply);
    // The reply is thenable: returned unsent it would await a response that never comes, so the handler runs instead.
    return reply.sent ? reply : undefined;
  };
}
