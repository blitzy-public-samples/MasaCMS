// Stand-in for identity's internal session, adoption and token operations; every answer is checked against identity's contract.
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { INVOCATION_HEADER, createLocalInvocationVerifier, type InvocationVerifier } from '@opt2/platform/auth';
import { assertResponseMatchesOpenApi, mintUserToken, testSigningKeys, testVerifier } from '@opt2/platform/testing';
import { parse } from 'yaml';
import type { components } from '../../src/generated/clients/identity.js';
import { sendJson, startHttpDouble, type HttpDouble, type RecordedRequest } from './http-double.js';

type Schemas = components['schemas'];

/** The identity contract, the producer schema every answer of the double must satisfy. */
const IDENTITY_CONTRACT = parse(
  readFileSync(new URL('../../../services/identity/contracts/openapi.yaml', import.meta.url), 'utf8'),
) as object;

const GATEWAY_CALLER = 'gateway';
const SESSION_PATH = /^\/internal\/v1\/sessions\/([^/]+)\/(state|admin-site)$/;

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
  roles: string[];
}

/** One `mintUserToken` call and the token it answered. */
export interface MintedToken {
  request: Schemas['TokenRequest'];
  token: string;
}

/** The identity double. */
export interface IdentityDouble extends HttpDouble {
  readonly sessions: Map<string, IdentitySession>;
  readonly minted: MintedToken[];
  /** `authenticateRequest` bodies, in order. */
  readonly authentications: Schemas['AuthenticateRequest'][];
  /** Maps an `Authorization` value of a REST request to the session identity authenticates it into. */
  restSession(authorization: string, session: Omit<IdentitySession, 'state' | 'epoch'>): void;
  /** Admin site of every session adopted from now on. */
  setAdminSite(siteId: string): void;
  /** Requests whose invocation credential was not the gateway's, which the double refused. */
  refused(): RecordedRequest[];
}

function json<T>(req: RecordedRequest): T {
  return JSON.parse(req.body.toString('utf8')) as T;
}

/** Starts the identity double; only the gateway's local invocation credential addressed to identity is accepted. */
export async function startIdentityDouble(): Promise<IdentityDouble> {
  const sessions = new Map<string, IdentitySession>();
  const minted: MintedToken[] = [];
  const authentications: Schemas['AuthenticateRequest'][] = [];
  const restSessions = new Map<string, string>();
  const refusedRequests: RecordedRequest[] = [];
  const userVerifier = testVerifier().userVerifier;
  let adminSite = '';
  let invocation: InvocationVerifier | undefined;

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

  const sessionState = (session: IdentitySession | undefined): Schemas['SessionState'] =>
    session === undefined
      ? { state: 'ended', epoch: 0, userId: '', siteId: '' }
      : { state: session.state, epoch: session.epoch, userId: session.userId, siteId: session.siteId };

  const mint = async (request: Schemas['TokenRequest']): Promise<Schemas['UserTokenResponse']> => {
    const session = sessions.get(request.sessionId);
    const active = session?.state === 'active';
    const token = await mintUserToken({
      sub: active ? session.userId : '',
      sid: request.sessionId,
      site: request.siteId,
      roles: active ? session.roles : [],
      epoch: session?.epoch ?? 0,
    });
    minted.push({ request, token });
    const claims = await userVerifier.verify(token);
    return { token, expiresAt: claims.exp, epoch: claims.epoch, claims: { ...claims } };
  };

  const base = await startHttpDouble(async (req, res) => {
    if ((await callerOf(req)) !== GATEWAY_CALLER) {
      refusedRequests.push(req);
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method === 'POST' && req.path === '/internal/v1/authenticate') {
      const body = json<Schemas['AuthenticateRequest']>(req);
      authentications.push(body);
      const authorization = body.headers.authorization;
      const sessionId = typeof authorization === 'string' ? restSessions.get(authorization) : undefined;
      answer(req, res, sessionId === undefined ? { outcome: 'anonymous', sessionId: null } : { outcome: 'session', sessionId });
      return;
    }
    if (req.method === 'POST' && req.path === '/internal/v1/sessions:adopt') {
      const body = json<Schemas['AdoptSessionRequest']>(req);
      const sessionId = `ids-${body.legacySessionId}`;
      const previous = sessions.get(sessionId);
      // A described visitor who has not logged in: identity mints its tokens anonymous, without roles.
      const session: IdentitySession = previous ?? {
        sessionId,
        state: 'active',
        epoch: 1,
        userId: '',
        siteId: body.siteId,
        adminSite,
        roles: [],
      };
      sessions.set(sessionId, session);
      answer(req, res, { sessionId, epoch: session.epoch, setCookie: [] } satisfies Schemas['AdoptSessionResponse']);
      return;
    }
    if (req.method === 'POST' && req.path === '/internal/v1/tokens') {
      answer(req, res, await mint(json<Schemas['TokenRequest']>(req)));
      return;
    }
    const sessionOp = req.method === 'GET' ? SESSION_PATH.exec(req.path) : null;
    if (sessionOp !== null) {
      const session = sessions.get(decodeURIComponent(sessionOp[1] ?? ''));
      if (sessionOp[2] === 'state') answer(req, res, sessionState(session));
      else answer(req, res, { siteId: session?.state === 'active' ? session.adminSite : '' } satisfies Schemas['SessionAdminSite']);
      return;
    }
    sendJson(res, 404, { error: 'notFound', message: `identity double has no ${req.method} ${req.path}` });
  });

  return {
    ...base,
    sessions,
    minted,
    authentications,
    restSession(authorization, session) {
      restSessions.set(authorization, session.sessionId);
      sessions.set(session.sessionId, { ...session, state: 'active', epoch: 1 });
    },
    setAdminSite(siteId) {
      adminSite = siteId;
    },
    refused: () => [...refusedRequests],
  };
}
