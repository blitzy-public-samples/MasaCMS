// Stand-in for identity's internal session, token and CSRF-claim operations; success answers are checked against identity's contract.
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { INVOCATION_HEADER, createLocalInvocationVerifier, type InvocationVerifier } from '@opt2/platform/auth';
import { apiUnavailableResponse, legacyErrorResponse, type SerializedLegacyResponse } from '@opt2/platform/legacy-compat';
import { assertResponseMatchesOpenApi, mintUserToken, testJwks, testSigningKeys, testVerifier } from '@opt2/platform/testing';
import { parse } from 'yaml';
import type { components } from '../../src/generated/clients/identity.js';
import { IDENTITY_OPERATIONS } from '../../src/session/identity-client.js';
import { DEFAULT_SITE_ID } from '../../src/session/token-cache.js';
import { sendBytes, sendJson, startHttpDouble, type HttpDouble, type RecordedRequest } from './http-double.js';

type Schemas = components['schemas'];

/** The identity contract, the producer schema every answer of the double must satisfy. */
const IDENTITY_CONTRACT = parse(
  readFileSync(new URL('../../../services/identity/contracts/openapi.yaml', import.meta.url), 'utf8'),
) as object;

const GATEWAY_CALLER = 'gateway';
const CLAIM_KEY_SEPARATOR = '\u0000';

/** Legacy error types of injected statuses; any other status carries the `server_error` envelope. */
const FAILURE_TYPES: Readonly<Partial<Record<number, string>>> = Object.freeze({
  400: 'badRequest',
  401: 'authorization',
  404: 'invalidMethodCall',
});

/** Session mode identity records for a session; no answer carries it. */
export type IdentitySessionMode = 'legacy-primary' | 'target-primary';

/** Roles minted into a session's tokens: fixed, or per requested site. */
export type SessionRoles = string[] | ((siteId: string) => string[]);

/** A session a suite programs into the double. */
export interface IdentitySessionSpec {
  sessionId: string;
  userId: string;
  /** Site the session was adopted at; defaults to `default`. */
  siteId?: string;
  epoch: number;
  state: 'active' | 'ended';
  mode: IdentitySessionMode;
  roles?: SessionRoles;
  /** Defaults to whether the minted roles hold `s2`. */
  s2?: boolean;
  /** Hydration snapshot; its `usedTokens` become `used` claims. */
  snapshot?: Schemas['SessionSnapshot'];
  /** Legacy session id `adoptSession` resolves to this session. */
  legacySessionId?: string;
  /** `session.siteid`, the admin site the session selected; defaults to `''`. */
  adminSite?: string;
}

/** One identity session the double holds. */
export interface IdentitySession {
  sessionId: string;
  state: 'active' | 'ended';
  epoch: number;
  userId: string;
  /** Site the session was adopted at. */
  siteId: string;
  /** `session.siteid`, the admin site the session selected; `''` when none. */
  adminSite: string;
  /** Roles minted into every token of the session. */
  roles: SessionRoles;
  mode: IdentitySessionMode;
  s2?: boolean;
  /** Stored snapshot; `getSessionSnapshot` answers it with the session's current epoch and used tokens. */
  snapshot?: Schemas['SessionSnapshot'];
  legacySessionId?: string;
}

/** One `mintUserToken` call and the token it answered. */
export interface MintedToken {
  request: Schemas['TokenRequest'];
  token: string;
}

/** State of one CSRF claim, as `identity.csrf_claim` holds it. */
export type ClaimState = 'pending-legacy' | 'used';

/** One `claimCsrfToken` call; `taken` when this call inserted the `pending-legacy` claim. */
export interface ClaimAttempt {
  sessionId: string;
  token: string;
  taken: boolean;
  state: ClaimState;
}

/** Ids `calls` and `failNext` use: the identity client's operations plus `jwks`. */
export type IdentityOperationId = keyof typeof IDENTITY_OPERATIONS | 'jwks';

/** An injected failure: an error status, a connection reset without a response, or no answer until `close()`. */
export type IdentityFailure = { status: number } | 'refuse' | 'hang';

/** Answers `authenticateRequest` in place of the default credential map. */
export type AuthenticateHandler = (
  input: Schemas['AuthenticateRequest'],
) => Schemas['AuthenticateResponse'] | Promise<Schemas['AuthenticateResponse']>;

/** Answers `adoptSession` in place of the default adoption. */
export type AdoptHandler = (
  input: Schemas['AdoptSessionRequest'],
) => Schemas['AdoptSessionResponse'] | Promise<Schemas['AdoptSessionResponse']>;

/** Options of {@link startIdentityDouble}. */
export interface IdentityDoubleOptions {
  sessions?: IdentitySessionSpec[];
  /** Refuse with 401 any call but `jwks` without the gateway's local invocation credential addressed to identity; defaults to true. */
  requireInvocation?: boolean;
}

/** The identity double. */
export interface IdentityDouble extends HttpDouble {
  readonly sessions: Map<string, IdentitySession>;
  readonly minted: MintedToken[];
  /** `authenticateRequest` bodies, in order. */
  readonly authentications: Schemas['AuthenticateRequest'][];
  /** Calls per operation that passed the invocation check, injected failures included. */
  readonly calls: Record<IdentityOperationId, number>;
  /** `claimCsrfToken` calls, in arrival order. */
  readonly claimAttempts: ClaimAttempt[];
  /** Maps an `Authorization` value of a REST request to the session identity authenticates it into. */
  restSession(authorization: string, session: Omit<IdentitySessionSpec, 'state' | 'epoch' | 'mode'>): void;
  /** Admin site of every session adopted from now on. */
  setAdminSite(siteId: string): void;
  /** Requests whose invocation credential was not the gateway's, which the double refused. */
  refused(): RecordedRequest[];
  /** Creates or replaces a session. */
  setSession(spec: IdentitySessionSpec): void;
  /** Bumps a known session's epoch; returns the new epoch. */
  bumpEpoch(sessionId: string): number;
  /** Ends a session as `endSession` does; returns its epoch afterwards. */
  endSession(sessionId: string): number;
  /** Sets or, with `undefined`, deletes the claim on `token`. */
  setClaim(sessionId: string, token: string, state: ClaimState | undefined): void;
  /** The claim state of `token`, undefined when unclaimed. */
  claimState(sessionId: string, token: string): ClaimState | undefined;
  /** Makes the next call of `operation` fail as `failure` says; repeated calls queue. */
  failNext(operation: IdentityOperationId, failure: IdentityFailure): void;
  /** Replaces, or with `undefined` restores, the default `authenticateRequest` answer. */
  onAuthenticate(handler: AuthenticateHandler | undefined): void;
  /** Replaces, or with `undefined` restores, the default `adoptSession` answer. */
  onAdopt(handler: AdoptHandler | undefined): void;
}

interface Route {
  id: IdentityOperationId;
  method: string;
  pattern: RegExp;
}

interface StoredClaim {
  token: string;
  state: ClaimState;
}

/** Path pattern of a contract template; `{sid}` captures one segment. */
function templatePattern(template: string): RegExp {
  const parts = template.split('{sid}').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('([^/]+)')}$`);
}

/** The operations the double serves, paths taken from the client so the two never drift. */
const ROUTES: readonly Route[] = Object.freeze([
  ...Object.entries(IDENTITY_OPERATIONS).map(([id, op]) => ({
    id: id as keyof typeof IDENTITY_OPERATIONS,
    method: op.method,
    pattern: templatePattern(op.path),
  })),
  { id: 'jwks', method: 'GET', pattern: templatePattern('/.well-known/jwks.json') },
]);

function json<T>(req: RecordedRequest): T {
  return JSON.parse(req.body.toString('utf8')) as T;
}

/** The operation `req` addresses and its decoded `{sid}`, or undefined. */
function routeOf(req: RecordedRequest): { id: IdentityOperationId; sid: string } | undefined {
  for (const route of ROUTES) {
    const match = req.method === route.method ? route.pattern.exec(req.path) : null;
    if (match !== null) return { id: route.id, sid: decodeURIComponent(match[1] ?? '') };
  }
  return undefined;
}

/** The legacy-shaped answer of an injected status. */
function failureResponse(status: number): SerializedLegacyResponse {
  if (status === 503) return apiUnavailableResponse();
  return { ...legacyErrorResponse(FAILURE_TYPES[status] ?? 'server_error', { mura404: status === 404 }), status };
}

/** Ledger key of a token; legacy struct keys match case-insensitively. */
function claimKey(sessionId: string, token: string): string {
  return `${sessionId}${CLAIM_KEY_SEPARATOR}${token.toUpperCase()}`;
}

function rolesOn(session: IdentitySession, siteId: string): string[] {
  return typeof session.roles === 'function' ? session.roles(siteId) : session.roles;
}

/** Starts the identity double holding `opts.sessions`; by default only the gateway's invocation credential is accepted. */
export async function startIdentityDouble(opts: IdentityDoubleOptions = {}): Promise<IdentityDouble> {
  const requireInvocation = opts.requireInvocation ?? true;
  const sessions = new Map<string, IdentitySession>();
  const claims = new Map<string, StoredClaim>();
  const minted: MintedToken[] = [];
  const authentications: Schemas['AuthenticateRequest'][] = [];
  const claimAttempts: ClaimAttempt[] = [];
  const calls = Object.fromEntries(ROUTES.map((route) => [route.id, 0])) as Record<IdentityOperationId, number>;
  const failures = new Map<IdentityOperationId, IdentityFailure[]>();
  const restSessions = new Map<string, string>();
  const refusedRequests: RecordedRequest[] = [];
  const userVerifier = testVerifier().userVerifier;
  let adminSite = '';
  let invocation: InvocationVerifier | undefined;
  let authenticateHandler: AuthenticateHandler | undefined;
  let adoptHandler: AdoptHandler | undefined;

  const callerOf = async (req: RecordedRequest): Promise<string | undefined> => {
    invocation ??= createLocalInvocationVerifier({ publicKey: (await testSigningKeys()).publicKey, callee: 'identity' });
    const header = req.headers[INVOCATION_HEADER];
    if (typeof header !== 'string') return undefined;
    return (await invocation.verify(header).catch(() => undefined))?.name;
  };

  /** Sends `body` once it satisfies identity's contract for `req`. */
  const answer = (req: RecordedRequest, res: ServerResponse, body: unknown): void => {
    assertResponseMatchesOpenApi(IDENTITY_CONTRACT, {
      method: req.method,
      path: req.path,
      status: 200,
      contentType: 'application/json',
      body,
    });
    sendJson(res, 200, body);
  };

  /** Sends a legacy-shaped error once it satisfies identity's contract for `req`. */
  const answerLegacy = (req: RecordedRequest, res: ServerResponse, response: SerializedLegacyResponse): void => {
    const contentType = response.headers['Content-Type'] ?? 'application/json';
    assertResponseMatchesOpenApi(IDENTITY_CONTRACT, {
      method: req.method,
      path: req.path,
      status: response.status,
      contentType,
      body: JSON.parse(response.body) as unknown,
    });
    sendBytes(res, response.status, response.body, response.headers);
  };

  const inject = (res: ServerResponse, failure: IdentityFailure): void => {
    // A hung response stays open until close() destroys its socket.
    if (failure === 'hang') return;
    if (failure === 'refuse') {
      res.destroy();
      return;
    }
    const { status, headers, body } = failureResponse(failure.status);
    sendBytes(res, status, body, headers);
  };

  const sessionFor = (sessionId: string): IdentitySession => {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new TypeError(`identity double holds no session ${sessionId}`);
    return session;
  };

  const usedTokensOf = (sessionId: string): string[] => {
    const prefix = `${sessionId}${CLAIM_KEY_SEPARATOR}`;
    return [...claims].filter(([key, claim]) => key.startsWith(prefix) && claim.state === 'used').map(([, claim]) => claim.token);
  };

  const clearClaims = (sessionId: string): void => {
    const prefix = `${sessionId}${CLAIM_KEY_SEPARATOR}`;
    for (const key of [...claims.keys()]) if (key.startsWith(prefix)) claims.delete(key);
  };

  const markUsed = (sessionId: string, tokens: readonly string[]): void => {
    for (const token of tokens) claims.set(claimKey(sessionId, token), { token, state: 'used' });
  };

  const setSession = (spec: IdentitySessionSpec): void => {
    sessions.set(spec.sessionId, {
      sessionId: spec.sessionId,
      state: spec.state,
      epoch: spec.epoch,
      userId: spec.userId,
      siteId: spec.siteId ?? DEFAULT_SITE_ID,
      adminSite: spec.adminSite ?? '',
      roles: spec.roles ?? [],
      mode: spec.mode,
      s2: spec.s2,
      snapshot: spec.snapshot,
      legacySessionId: spec.legacySessionId,
    });
    if (spec.snapshot !== undefined) markUsed(spec.sessionId, spec.snapshot.usedTokens);
  };

  /** Ends the session as identity does: user, snapshot and claims go and the epoch moves on; an ended or unknown one is unchanged. */
  const end = (sessionId: string): number => {
    const session = sessions.get(sessionId);
    if (session === undefined) return 0;
    if (session.state === 'ended') return session.epoch;
    clearClaims(sessionId);
    session.state = 'ended';
    session.epoch += 1;
    session.userId = '';
    session.roles = [];
    session.snapshot = undefined;
    return session.epoch;
  };

  const sessionState = (session: IdentitySession | undefined): Schemas['SessionState'] =>
    session === undefined
      ? { state: 'ended', epoch: 0, userId: '', siteId: '' }
      : { state: session.state, epoch: session.epoch, userId: session.userId, siteId: session.siteId };

  const sessionSnapshot = (session: IdentitySession | undefined): Schemas['SessionSnapshot'] | undefined =>
    session?.state === 'active' && session.snapshot !== undefined
      ? { ...session.snapshot, sessionId: session.sessionId, epoch: session.epoch, usedTokens: usedTokensOf(session.sessionId) }
      : undefined;

  const mint = async (request: Schemas['TokenRequest']): Promise<Schemas['UserTokenResponse']> => {
    const session = sessions.get(request.sessionId);
    // Identity mints an unknown or ended session's token anonymous, as legacy serves a request without a live session.
    const active = session?.state === 'active';
    const token = await mintUserToken({
      sub: active ? session.userId : '',
      sid: request.sessionId,
      site: request.siteId,
      roles: active ? rolesOn(session, request.siteId) : [],
      s2: active ? session.s2 : false,
      epoch: session?.epoch ?? 0,
    });
    minted.push({ request, token });
    const claims = await userVerifier.verify(token);
    return { token, expiresAt: claims.exp, epoch: claims.epoch, claims: { ...claims } };
  };

  const authenticate = (body: Schemas['AuthenticateRequest']): Schemas['AuthenticateResponse'] => {
    const authorization = body.headers.authorization;
    const sessionId = typeof authorization === 'string' ? restSessions.get(authorization) : undefined;
    return sessionId === undefined ? { outcome: 'anonymous', sessionId: null } : { outcome: 'session', sessionId };
  };

  /** Adopts as identity does: an active session with the described secret keeps its epoch, any other is rebuilt from the describe. */
  const adopt = (body: Schemas['AdoptSessionRequest']): Schemas['AdoptSessionResponse'] => {
    const { describe, legacySessionId } = body;
    const adoptedId = `ids-${legacySessionId}`;
    const previous =
      [...sessions.values()].find((session) => session.legacySessionId === legacySessionId) ?? sessions.get(adoptedId);
    const sessionId = previous?.sessionId ?? adoptedId;
    if (previous?.state === 'active' && previous.snapshot?.csrfSecretKey === describe.csrfSecretKey) {
      markUsed(sessionId, describe.usedTokens);
      return { sessionId, epoch: previous.epoch, setCookie: [] };
    }
    // A described visitor who has not logged in: identity mints its tokens anonymous, without roles.
    const loggedIn = describe.user.isLoggedIn === true;
    const userId = loggedIn && typeof describe.user.userID === 'string' ? describe.user.userID : '';
    const epoch = previous === undefined ? 1 : previous.epoch + 1;
    clearClaims(sessionId);
    setSession({
      sessionId,
      userId,
      siteId: body.siteId,
      epoch,
      state: 'active',
      mode: 'legacy-primary',
      roles: loggedIn ? [...describe.roles] : [],
      snapshot: {
        sessionId,
        epoch,
        loginSnapshot: { user: { ...describe.user }, roles: [...describe.roles] },
        csrfSecretKey: describe.csrfSecretKey,
        usedTokens: [...describe.usedTokens],
      },
      legacySessionId,
      adminSite: previous?.adminSite ?? adminSite,
    });
    return { sessionId, epoch, setCookie: [] };
  };

  /** Takes a `pending-legacy` claim when the token is unclaimed; a known session's held claim answers its state. */
  const claim = ({ sessionId, token }: Schemas['CsrfClaimRequest']): Schemas['CsrfClaimResponse'] => {
    const key = claimKey(sessionId, token);
    // Without an identity session nothing is arbitrated, and legacy alone decides.
    const known = sessions.has(sessionId);
    const held = known ? claims.get(key) : undefined;
    const taken = known && held === undefined;
    if (taken) claims.set(key, { token, state: 'pending-legacy' });
    const state = held?.state ?? 'pending-legacy';
    claimAttempts.push({ sessionId, token, taken, state });
    return { state };
  };

  /** Marks consumed tokens used and deletes released tokens still pending; an unknown session changes nothing. */
  const settle = ({ sessionId, consumed, released }: Schemas['CsrfSettleRequest']): Schemas['CsrfSettleResponse'] => {
    const result = { used: 0, released: 0 };
    if (!sessions.has(sessionId)) return result;
    const consumedKeys = new Set(consumed.map((token) => claimKey(sessionId, token)));
    for (const token of consumed) {
      const key = claimKey(sessionId, token);
      if (claims.get(key)?.state === 'used') continue;
      claims.set(key, { token, state: 'used' });
      result.used += 1;
    }
    for (const token of released) {
      const key = claimKey(sessionId, token);
      if (consumedKeys.has(key) || claims.get(key)?.state !== 'pending-legacy') continue;
      claims.delete(key);
      result.released += 1;
    }
    return result;
  };

  const serve = async (id: IdentityOperationId, sid: string, req: RecordedRequest, res: ServerResponse): Promise<void> => {
    switch (id) {
      case 'mintToken':
        answer(req, res, await mint(json<Schemas['TokenRequest']>(req)));
        return;
      case 'authenticate': {
        const body = json<Schemas['AuthenticateRequest']>(req);
        authentications.push(body);
        answer(req, res, authenticateHandler === undefined ? authenticate(body) : await authenticateHandler(body));
        return;
      }
      case 'adopt': {
        const body = json<Schemas['AdoptSessionRequest']>(req);
        answer(req, res, adoptHandler === undefined ? adopt(body) : await adoptHandler(body));
        return;
      }
      case 'state':
        answer(req, res, sessionState(sessions.get(sid)));
        return;
      case 'adminSite': {
        const session = sessions.get(sid);
        answer(req, res, { siteId: session?.state === 'active' ? session.adminSite : '' } satisfies Schemas['SessionAdminSite']);
        return;
      }
      case 'snapshot': {
        const snapshot = sessionSnapshot(sessions.get(sid));
        // Identity's not-found handler answers the legacy 404 envelope.
        if (snapshot === undefined) answerLegacy(req, res, legacyErrorResponse('invalidMethodCall', { mura404: true }));
        else answer(req, res, snapshot);
        return;
      }
      case 'end':
        // Logout and expiry end a session alike, so the body's reason is not read.
        answer(req, res, { ended: true, epoch: end(sid) } satisfies Schemas['EndSessionResponse']);
        return;
      case 'claim':
        answer(req, res, claim(json<Schemas['CsrfClaimRequest']>(req)));
        return;
      case 'settle':
        answer(req, res, settle(json<Schemas['CsrfSettleRequest']>(req)));
        return;
      case 'jwks':
        answer(req, res, await testJwks());
        return;
    }
  };

  const base = await startHttpDouble(async (req, res) => {
    const route = routeOf(req);
    // The key set is public, so its route alone takes no invocation credential.
    if (requireInvocation && route?.id !== 'jwks' && (await callerOf(req)) !== GATEWAY_CALLER) {
      refusedRequests.push(req);
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (route === undefined) {
      sendJson(res, 404, { error: 'notFound', message: `identity double has no ${req.method} ${req.path}` });
      return;
    }
    calls[route.id] += 1;
    const failure = failures.get(route.id)?.shift();
    if (failure !== undefined) inject(res, failure);
    else await serve(route.id, route.sid, req, res);
  });

  for (const spec of opts.sessions ?? []) setSession(spec);

  return {
    ...base,
    sessions,
    minted,
    authentications,
    calls,
    claimAttempts,
    restSession(authorization, session) {
      restSessions.set(authorization, session.sessionId);
      setSession({ ...session, state: 'active', epoch: 1, mode: 'target-primary' });
    },
    setAdminSite(siteId) {
      adminSite = siteId;
    },
    refused: () => [...refusedRequests],
    setSession,
    bumpEpoch(sessionId) {
      const session = sessionFor(sessionId);
      session.epoch += 1;
      return session.epoch;
    },
    endSession: end,
    setClaim(sessionId, token, state) {
      const key = claimKey(sessionId, token);
      if (state === undefined) claims.delete(key);
      else claims.set(key, { token, state });
    },
    claimState: (sessionId, token) => claims.get(claimKey(sessionId, token))?.state,
    failNext(operation, failure) {
      const queue = failures.get(operation) ?? [];
      queue.push(failure);
      failures.set(operation, queue);
    },
    onAuthenticate(handler) {
      authenticateHandler = handler;
    },
    onAdopt(handler) {
      adoptHandler = handler;
    },
  };
}
