// Typed client of identity's internal session, token and CSRF-claim operations: the gateway's only route to session state.
import { IDENTITY_SERVICE, ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import type { components, paths } from '../generated/clients/identity.js';

type Schemas = components['schemas'];

/** Body of `mintUserToken`. */
export type TokenRequest = Schemas['TokenRequest'];
/** A site-scoped user token with its expiry (epoch seconds), session epoch and claims. */
export type UserTokenResponse = Schemas['UserTokenResponse'];
/** The client request as the gateway received it, for `authenticateRequest`. */
export type RestAuthInput = Schemas['AuthenticateRequest'];
/** The session a request acts in; `legacyResponse` is legacy's exact answer when credential handling answers itself. */
export type RestAuthOutcome = Schemas['AuthenticateResponse'];
/** The legacy session description in `adoptSession`'s body. */
export type LegacySessionDescription = Schemas['LegacySessionDescription'];
/** The adopted identity session and the `Set-Cookie` values the gateway re-emits. */
export type AdoptedSession = Schemas['AdoptSessionResponse'];
/** Whether a session is active, with its epoch, user and site. */
export type SessionState = Schemas['SessionState'];
/** Login-time snapshot, CSRF secret and used-token keys of a session. */
export type SessionSnapshot = Schemas['SessionSnapshot'];
/** Why a session ends. */
export type EndReason = Schemas['EndSessionRequest']['reason'];
/** The ended session's new epoch. */
export type EndedSession = Schemas['EndSessionResponse'];
/** Body of `claimCsrfToken`. */
export type ClaimInput = Schemas['CsrfClaimRequest'];
/** `pending-legacy` when the claim was taken, `used` when the token was already consumed. */
export type ClaimResult = Schemas['CsrfClaimResponse'];
/** Body of `settleCsrfClaims`: tokens legacy consumed, and pending tokens it left usable. */
export type SettleInput = Schemas['CsrfSettleRequest'];
/** Counts of claims marked used and released. */
export type SettleResult = Schemas['CsrfSettleResponse'];

/** One entry of a legacy session's CSRF used-token ledger; `usedAt` is a legacy wire time. */
export interface LegacyUsedToken {
  token: string;
  usedAt: string;
}

/** The `session.mura` user keys the bridge's describe reports; logged-out values are `""`, `subtype` `Default`. */
export interface LegacyDescribeUser {
  userID: string;
  username: string;
  siteID: string;
  subtype: string;
  password: string;
  fname: string;
  lname: string;
  email: string;
  remoteID: string;
  company: string;
  lastlogin: string;
  passwordCreated: string;
}

/** The bridge's `session.cfm?op=describe` answer for the attached ColdFusion session. */
export interface LegacyDescribe {
  sessionId: string;
  isLoggedIn: boolean;
  user: LegacyDescribeUser;
  /** `loginByQuery` role list, comma-delimited. */
  memberships: string;
  /** Group ids plus the user id, comma-delimited. */
  membershipIds: string;
  csrfSecretKey: string;
  usedTokens: LegacyUsedToken[];
  /** `session.siteid`, or `""`. */
  siteId: string;
  serverTime: string;
}

// Identity's adopt body has no session mode or jar reference: the jar mapping and the mode stay in the gateway.
/** Input of {@link IdentityClient.adopt}. */
export interface AdoptInput {
  describe: LegacyDescribe;
  /** The requested legacy site id. */
  siteId: string;
}

/** Contract method and path template of one identity operation. */
export interface IdentityOperation {
  readonly method: 'GET' | 'POST';
  readonly path: keyof paths;
}

// `/internal/v1/csrf/consume` is called by target service routes through the service-kit CSRF hook, never by the gateway.
/** The identity operations this client calls; `satisfies` checks every path against the identity contract. */
export const IDENTITY_OPERATIONS = Object.freeze({
  mintToken: { method: 'POST', path: '/internal/v1/tokens' },
  authenticate: { method: 'POST', path: '/internal/v1/authenticate' },
  adopt: { method: 'POST', path: '/internal/v1/sessions:adopt' },
  state: { method: 'GET', path: '/internal/v1/sessions/{sid}/state' },
  snapshot: { method: 'GET', path: '/internal/v1/sessions/{sid}/snapshot' },
  end: { method: 'POST', path: '/internal/v1/sessions/{sid}:end' },
  claim: { method: 'POST', path: '/internal/v1/csrf/claims' },
  settle: { method: 'POST', path: '/internal/v1/csrf/claims:settle' },
} as const satisfies Record<string, IdentityOperation>);

/** The gateway's calls into identity's session state. */
export interface IdentityClient {
  /** `mintUserToken`: the session's user token for one site. */
  mintToken(input: TokenRequest): Promise<UserTokenResponse>;
  /** `authenticateRequest`: the session a request acts in, or legacy's own answer in `legacyResponse`. */
  authenticate(input: RestAuthInput): Promise<RestAuthOutcome>;
  /** `adoptSession`: creates or updates the identity session of a described legacy session. */
  adopt(input: AdoptInput): Promise<AdoptedSession>;
  /** `getSessionState`: the session's state and epoch; identity reports an unknown session as ended. */
  state(sessionId: string): Promise<SessionState>;
  /** `getSessionSnapshot`: the hydration snapshot; undefined when the session is missing or ended. */
  snapshot(sessionId: string): Promise<SessionSnapshot | undefined>;
  /** `endSession`: ends the session and bumps its epoch; ending an ended session changes nothing. */
  end(sessionId: string, reason: EndReason): Promise<EndedSession>;
  /** `claimCsrfToken`: a `pending-legacy` claim before a validating legacy request, or `used`. */
  claim(input: ClaimInput): Promise<ClaimResult>;
  /** `settleCsrfClaims`: marks the tokens legacy consumed as used and releases the listed pending claims. */
  settle(input: SettleInput): Promise<SettleResult>;
}

const HTTP_NOT_FOUND = 404;

function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

/** The legacy-shaped 503 for an identity answer outside the operation's success statuses. */
function unavailable(status: number): ServiceUnavailableError {
  const cause = Object.assign(new Error(`${IDENTITY_SERVICE} answered HTTP ${status}`), { code: `HTTP_${status}` });
  return new ServiceUnavailableError(IDENTITY_SERVICE, cause);
}

/** Items of a CFML comma list; empty elements are skipped, as `listToArray` skips them. */
function listItems(list: string): string[] {
  return list.split(',').filter((item) => item !== '');
}

/** The contract's description of a described legacy session. */
function sessionDescription(describe: LegacyDescribe): LegacySessionDescription {
  return {
    // `user` is `session.mura` as setUserStruct sets it, so a later hydrate can restore `membershipIds` from it.
    user: { ...describe.user, isLoggedIn: describe.isLoggedIn, membershipIds: describe.membershipIds },
    roles: listItems(describe.memberships),
    csrfSecretKey: describe.csrfSecretKey,
    usedTokens: describe.usedTokens.map((entry) => entry.token),
  };
}

/** An operation path with its `{sid}` segment filled. */
function sessionPath(operation: IdentityOperation, sessionId: string): string {
  return operation.path.replace('{sid}', encodeURIComponent(sessionId));
}

/** Creates the identity client over the gateway's service client. */
export function createIdentityClient(client: ServiceClient): IdentityClient {
  const ops = IDENTITY_OPERATIONS;

  function send<T>(operation: IdentityOperation, path: string, json?: unknown) {
    // Identity sees only the gateway's invocation credential, never a user token from the request context.
    return client.request<T>({ service: IDENTITY_SERVICE, method: operation.method, path, json, userToken: null });
  }

  async function call<T>(operation: IdentityOperation, path: string, json?: unknown): Promise<T> {
    const response = await send<T>(operation, path, json);
    if (!isSuccess(response.status)) throw unavailable(response.status);
    return response.body;
  }

  return {
    mintToken: (input) => call<UserTokenResponse>(ops.mintToken, ops.mintToken.path, input),

    authenticate: (input) => call<RestAuthOutcome>(ops.authenticate, ops.authenticate.path, input),

    adopt: ({ describe, siteId }) =>
      call<AdoptedSession>(ops.adopt, ops.adopt.path, {
        legacySessionId: describe.sessionId,
        siteId,
        describe: sessionDescription(describe),
      } satisfies Schemas['AdoptSessionRequest']),

    state: (sessionId) => call<SessionState>(ops.state, sessionPath(ops.state, sessionId)),

    async snapshot(sessionId) {
      const response = await send<SessionSnapshot>(ops.snapshot, sessionPath(ops.snapshot, sessionId));
      if (response.status === HTTP_NOT_FOUND) return undefined;
      if (!isSuccess(response.status)) throw unavailable(response.status);
      return response.body;
    },

    end: (sessionId, reason) =>
      call<EndedSession>(ops.end, sessionPath(ops.end, sessionId), { reason } satisfies Schemas['EndSessionRequest']),

    claim: (input) => call<ClaimResult>(ops.claim, ops.claim.path, input),

    settle: (input) => call<SettleResult>(ops.settle, ops.settle.path, input),
  };
}
