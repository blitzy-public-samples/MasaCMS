/** Gateway-facing session routes: `adoptSession`, `getSessionState`, `getSessionAdminSite`, `getSessionSnapshot` and `endSession`. */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import {
  adoptLegacySession,
  endSession,
  newSessionTokens,
  sessionAdminSite,
  sessionCookies,
  sessionSnapshot,
  sessionState,
  type SessionDeps,
  type SessionMode,
  type SessionSnapshot,
} from '../domain/sessions.js';
import type { components, operations } from '../generated/openapi.js';

type Schemas = components['schemas'];
type SessionParams = operations['getSessionState']['parameters']['path'];

/** The session operations the routes delegate to. */
export type SessionRouteDeps = { sessions: SessionDeps };

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([serviceRole('gateway')]) });

// The router ends a parameter name only at `(`, `-`, `.` or `/`, so `:sid::end` would declare `sid::end`;
// the `(.+)` pattern ends the name at `sid`, and `::` is the literal colon of the contract's `{sid}:end`.
const END_URL = '/internal/v1/sessions/:sid(.+)::end';

// The adopt body carries no mode, which the gateway keeps; an adopted session is described from, and keyed by, a legacy session.
const ADOPTED_MODE: SessionMode = 'legacy-primary';

// SessionId, AdoptSessionRequest and EndSessionRequest as the contract declares them; Fastify validates them once, before the handler.
const SESSION_PARAMS = {
  type: 'object',
  required: ['sid'],
  properties: { sid: { type: 'string', minLength: 1 } },
} as const;

const STRING_LIST = { type: 'array', items: { type: 'string' } } as const;

const ADOPT_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['legacySessionId', 'siteId', 'describe'],
  properties: {
    legacySessionId: { type: 'string', minLength: 1 },
    siteId: { type: 'string', minLength: 1 },
    describe: {
      type: 'object',
      additionalProperties: false,
      required: ['user', 'roles', 'csrfSecretKey', 'usedTokens'],
      properties: {
        user: { type: 'object', additionalProperties: true },
        roles: STRING_LIST,
        csrfSecretKey: { type: 'string' },
        usedTokens: STRING_LIST,
      },
    },
  },
} as const;

const END_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: { reason: { type: 'string', enum: ['logout', 'legacy-logout', 'expired'] } },
} as const;

/** `Set-Cookie` values handing the browser the adopted session: `JSESSIONID` names it, `CFID` and `CFTOKEN` are fresh. */
function adoptedSessionCookies(sessionId: string, now: Date): string[] {
  // Masa's default cookie settings; the gateway re-emits each value under the attributes legacy gave that cookie.
  return sessionCookies(newSessionTokens(sessionId), {}, now);
}

/** The contract's `SessionSnapshot` of a domain snapshot: `session.mura` and its role items as `op=hydrate` installs them. */
function snapshotBody(snapshot: SessionSnapshot): Schemas['SessionSnapshot'] {
  return {
    sessionId: snapshot.sessionId,
    epoch: snapshot.epoch,
    loginSnapshot: { user: { ...snapshot.user }, roles: snapshot.roles },
    csrfSecretKey: snapshot.csrfSecret,
    usedTokens: snapshot.usedTokens.map((entry) => entry.token),
  };
}

/** Registers the five session routes; only the gateway's invocation credential is accepted. */
export async function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): Promise<void> {
  const { sessions } = deps;

  app.post<{ Body: Schemas['AdoptSessionRequest']; Reply: Schemas['AdoptSessionResponse'] }>(
    '/internal/v1/sessions::adopt',
    { schema: { body: ADOPT_BODY }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const adopted = await adoptLegacySession(sessions, request.body, { mode: ADOPTED_MODE });
      return {
        sessionId: adopted.sessionId,
        epoch: adopted.epoch,
        setCookie: adoptedSessionCookies(adopted.sessionId, sessions.clock.now()),
      };
    },
  );

  app.get<{ Params: SessionParams; Reply: Schemas['SessionState'] }>(
    '/internal/v1/sessions/:sid/state',
    { schema: { params: SESSION_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const { state, epoch, userId, siteId } = await sessionState(sessions, request.params.sid);
      return { state, epoch, userId, siteId };
    },
  );

  app.get<{ Params: SessionParams; Reply: Schemas['SessionAdminSite'] }>(
    '/internal/v1/sessions/:sid/admin-site',
    { schema: { params: SESSION_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request) => ({ siteId: await sessionAdminSite(sessions, request.params.sid) }),
  );

  app.get<{ Params: SessionParams }>(
    '/internal/v1/sessions/:sid/snapshot',
    { schema: { params: SESSION_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request, reply) => {
      const snapshot = await sessionSnapshot(sessions, request.params.sid);
      if (snapshot !== undefined) return snapshotBody(snapshot);
      // The service's not-found handler answers the legacy 404 envelope.
      reply.callNotFound();
      return reply;
    },
  );

  // Logout on either side and expiry end the session alike, so `reason` only has to be one the contract names.
  app.post<{ Params: SessionParams; Body: Schemas['EndSessionRequest']; Reply: Schemas['EndSessionResponse'] }>(
    END_URL,
    { schema: { params: SESSION_PARAMS, body: END_BODY }, config: { opt2: ROUTE_AUTH } },
    async (request) => ({ ended: true, epoch: (await endSession(sessions, request.params.sid)).epoch }),
  );
}
