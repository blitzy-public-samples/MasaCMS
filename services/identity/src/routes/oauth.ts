/** REST-mode credential exchange and OAuth token endpoints of `processRequest`, composed from identity's domain in legacy branch order [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:422-835]. */
import {
  INVALID_ACCESS_TOKEN_HEADER_SEQUENCE,
  LegacyApiError,
  LegacyServiceUnavailableError,
  WWW_AUTHENTICATE,
  cfEq,
  cfIsDateText,
  cfListToArray,
  cfParseDateTimeText,
  cfUuid,
  createApiSerializer,
  effectiveWwwAuthenticate,
  getApiVersion,
  isCfUuid,
  javaTrim,
  legacyErrorResponse,
  serializeResponse,
  type ApiNameContext,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import { tenantForRegisteredSite } from '@opt2/platform/tenancy';
import { loginByUserID, lookupByCredentials, type LoginDeps } from '../domain/login.js';
import {
  attachSessionData,
  deleteToken,
  effectiveGrantType,
  expiresAt,
  expiresIn,
  findOAuthUser,
  findToken,
  findTokenByAccessCode,
  generateToken,
  isExpired,
  isValidRedirectURI,
  loadClient,
  loadSiteClient,
  tokenInfo,
  type OAuthDeps,
  type OAuthToken,
  type OAuthUser,
} from '../domain/oauth.js';
import { adoptLegacySession, ensureSession, sessionSnapshot, type SessionDeps, type SessionMode } from '../domain/sessions.js';
import { parseLegacySessionJson, serializeLegacySessionJson, type AcfStruct } from '../legacy/session-json.js';

/** The identity domain dependencies the REST credential flow composes. */
export type OAuthRouteDeps = { oauth: OAuthDeps; login: LoginDeps; sessions: SessionDeps };

/** A REST request as legacy reads it: path after `/index.cfm` stripping, headers, URL query, merged params (query, form, JSON body) and resolved site. */
export type RestAuthInput = {
  path: string;
  httpMethod: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string>;
  params: Record<string, unknown>;
  siteId: string;
};

/** The request-scoped session the request continues in with its remaining params, or the exact answer legacy gives instead. */
export type RestAuthOutcome =
  | { kind: 'session'; sessionId: string; siteId: string; params: Record<string, unknown> }
  | { kind: 'response'; status: number; headers: Record<string, string>; body: string };

type Struct = Record<string, unknown>;

type OAuthClient = NonNullable<Awaited<ReturnType<typeof loadClient>>>;

/** One request's state as legacy's catch blocks read it: the params struct and the last `WWW-Authenticate` set. */
interface RestRun {
  readonly deps: OAuthRouteDeps;
  readonly input: RestAuthInput;
  readonly pathInfo: readonly string[];
  readonly sessionId: string;
  params: Struct;
  wwwAuthenticate?: string;
  sessionReady: boolean;
}

/** REST sessions never travel in cookies; identity alone holds them. */
const REST_SESSION_MODE: SessionMode = 'target-primary';
/** Path segments `listFind` matches case-sensitively [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:543-550,578-585]. */
const OAUTH_SEGMENTS: ReadonlySet<string> = new Set(['oauth', 'oauth2']);
const OAUTH2_SEGMENTS: ReadonlySet<string> = new Set(['oauth2']);
/** Grant types an access token may carry, matched case-sensitively [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:493]. */
const ACCESS_TOKEN_GRANTS: ReadonlySet<string> = new Set(['client_credentials', 'authorization_code', 'password', 'implicit']);
const TOKEN_INFO_SEGMENT = 'tokeninfo';
const OAUTH_TOKEN_METHOD = 'getOAuthToken';
const NOT_AVAILABLE_METHOD = 'Not Available';
const UNDEFINED_METHOD = 'undefined';
const PARAM_DEFAULT = 'invalid';
const BEARER = 'Bearer';
const UNHANDLED = 'server_error';
/** `getSession()` sets the placeholder's site before any credential code runs [legacy: core/mura/cfobject.cfc:456]. */
const SESSION_SITE = 'default';
/** Credential headers in legacy order; a later one overwrites an earlier [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:424-446]. */
const HEADER_OVERRIDES: readonly (readonly [header: string, param: string])[] = Object.freeze([
  ['X-client_id', 'client_id'],
  ['X-client_secret', 'client_secret'],
  ['X-access_token', 'access_token'],
  ['X-client-id', 'client_id'],
  ['X-client-secret', 'client_secret'],
  ['X-access-token', 'access_token'],
] as const);
/** The padded standard alphabet, the only form ACF `toBinary` accepts. */
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The user entity's date-typed property the API serializer formats inside token info [legacy: core/mura/user/userBean.cfc:85; core/mura/jsonSerializer.cfc:217-219]. */
const TOKEN_INFO_DATE_KEYS: ReadonlySet<string> = new Set(['passwordcreated']);
const TOKEN_SERIALIZER = createApiSerializer([...TOKEN_INFO_DATE_KEYS].map((key) => ({ key, hint: 'date' as const })));

/** Runs legacy's REST credential block for one request: the session it continues in, or the answer legacy gives instead [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:422-835,1318-1402]. */
export async function authenticateRestRequest(deps: OAuthRouteDeps, input: RestAuthInput): Promise<RestAuthOutcome> {
  const run: RestRun = {
    deps,
    input,
    pathInfo: cfListToArray(input.path, '/'),
    sessionId: cfUuid(),
    params: { ...input.params },
    sessionReady: false,
  };
  try {
    const answer = await exchangeCredentials(run);
    if (answer !== undefined) return { kind: 'response', ...answer };
    await ensureRestSession(run);
    return { kind: 'session', sessionId: run.sessionId, siteId: input.siteId, params: run.params };
  } catch (err) {
    if (err instanceof LegacyServiceUnavailableError) throw err;
    return { kind: 'response', ...errorAnswer(run, err) };
  }
}

/** The credential branches in legacy order; undefined lets the request continue in the run's session [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:424-835]. */
async function exchangeCredentials(run: RestRun): Promise<SerializedLegacyResponse | undefined> {
  const { input, params } = run;
  for (const [header, param] of HEADER_OVERRIDES) {
    const value = headerValue(input.headers, header);
    if (value !== undefined) setIn(params, param, value);
  }
  const { isBasicAuth, isBasicAuthDirect } = readAuthorization(run);
  if (isBasicAuthDirect) return basicDirect(run);
  if (isDefinedIn(params, 'access_token')) return accessToken(run);
  if (!(isDefinedIn(params, 'client_id') || isDefinedIn(params, 'refresh_token'))) return missingCredentials(run);
  return clientRequest(run, isBasicAuth);
}

/** Reads `Authorization` into the params: Basic as client id and secret, Bearer as the access token [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:453-469]. */
function readAuthorization(run: RestRun): { isBasicAuth: boolean; isBasicAuthDirect: boolean } {
  const value = headerValue(run.input.headers, 'Authorization');
  const words = value === undefined ? [] : cfListToArray(value, ' ');
  const type = words[0] ?? '';
  const credential = words.at(-1) ?? '';
  if (cfEq(type, 'Basic')) {
    const pair = cfListToArray(base64Text(credential), ':');
    const clientId = pair[0] ?? '';
    setIn(run.params, 'client_id', clientId);
    setIn(run.params, 'client_secret', pair.at(-1) ?? '');
    return { isBasicAuth: true, isBasicAuthDirect: clientId !== '' && !isCfUuid(clientId) };
  }
  if (cfEq(type, 'Bearer')) setIn(run.params, 'access_token', credential);
  return { isBasicAuth: false, isBasicAuthDirect: false };
}

/** Basic credentials of a user account: the lookup, then a login of the account found [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:471-481]. */
async function basicDirect(run: RestRun): Promise<undefined> {
  const { params } = run;
  const user = await restLookup(run, paramText(params, 'client_id'), paramText(params, 'client_secret'));
  deleteIn(params, 'client_id');
  deleteIn(params, 'client_secret');
  if (user === undefined) {
    run.wwwAuthenticate = WWW_AUTHENTICATE.basic;
    throw new LegacyApiError('authorization');
  }
  await restLogin(run, user);
  return undefined;
}

/** An access token from Bearer, a header or a param: the stored session, else a login of the token's user; tokeninfo answers [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:483-533]. */
async function accessToken(run: RestRun): Promise<SerializedLegacyResponse | undefined> {
  const { deps, input, params, pathInfo } = run;
  const tokenInfoRequest =
    isDefinedIn(input.query, 'access_token') &&
    isDefinedIn(input.query, 'client_id') &&
    ((pathInfo.length === 5 && cfEq(segment(pathInfo, 5), TOKEN_INFO_SEGMENT)) || (pathInfo.length === 6 && cfEq(segment(pathInfo, 6), TOKEN_INFO_SEGMENT)));
  const token = await findToken(deps.oauth, { token: paramText(params, 'access_token') });
  if (!tokenInfoRequest) deleteIn(params, 'access_token');
  if (token === null || !ACCESS_TOKEN_GRANTS.has(beanText(token.granttype))) {
    setIn(params, 'method', NOT_AVAILABLE_METHOD);
    run.wwwAuthenticate = effectiveWwwAuthenticate(INVALID_ACCESS_TOKEN_HEADER_SEQUENCE);
    throw new LegacyApiError('invalidAccessToken');
  }
  if (isExpired(token, deps.oauth.clock)) {
    setIn(params, 'method', NOT_AVAILABLE_METHOD);
    run.wwwAuthenticate = WWW_AUTHENTICATE.bearerInvalidAccessToken;
    throw new LegacyApiError('accessTokenExpired');
  }
  if (isJson(token.data)) {
    await restoreSession(run, token.data);
  } else {
    const client = await loadClient(deps.oauth, token.clientid, input.siteId);
    const user = client === null ? null : await findOAuthUser(deps.oauth, token.userid);
    if (user === null) {
      setIn(params, 'method', UNDEFINED_METHOD);
      run.wwwAuthenticate = WWW_AUTHENTICATE.bearerInvalidAccessToken;
      throw new LegacyApiError('invalidAccessToken');
    }
    await loginAndAttach(run, token, user);
  }
  if (!tokenInfoRequest) return undefined;
  setIn(params, 'access_token', valueOf(input.query, 'access_token'));
  return tokenInfoAnswer(run);
}

/** `getOAuthTokenInfo` for `params.access_token`, answered as the bare struct [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:4998-5024]. */
async function tokenInfoAnswer(run: RestRun): Promise<SerializedLegacyResponse> {
  const { oauth } = run.deps;
  const token = await findToken(oauth, { token: paramText(run.params, 'access_token') });
  if (token === null || isExpired(token, oauth.clock)) throw new LegacyApiError('invalidParameters');
  return serializeToken(tokenStruct(run, token));
}

/** No access token, client id or refresh token: refused, naming the scheme the path expects [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:534-556]. */
function missingCredentials(run: RestRun): never {
  const { params } = run;
  setIn(params, 'method', NOT_AVAILABLE_METHOD);
  for (const key of ['client_id', 'client_secret', 'refresh_token']) deleteIn(params, key);
  run.wwwAuthenticate = onOAuthPath(run.pathInfo, OAUTH_SEGMENTS) ? WWW_AUTHENTICATE.bearerInvalidClientCredentials : WWW_AUTHENTICATE.basic;
  throw new LegacyApiError('authorization');
}

/** A client id: the token endpoint on an oauth path, else a Basic client login [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:557-833]. */
async function clientRequest(run: RestRun, isBasicAuth: boolean): Promise<SerializedLegacyResponse | undefined> {
  const { deps, input, pathInfo } = run;
  const client = await loadSiteClient(deps.oauth, paramText(run.params, 'client_id'), input.siteId);
  if (client === null) return refuse(run, WWW_AUTHENTICATE.bearerInvalidClientCredentials);
  if (onOAuthPath(pathInfo, OAUTH_SEGMENTS)) return tokenGrant(run, client, onOAuthPath(pathInfo, OAUTH2_SEGMENTS));
  return basicClient(run, client, isBasicAuth);
}

/** The OAuth token endpoint, by `grant_type` [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:587-807]. */
async function tokenGrant(run: RestRun, client: OAuthClient, oauth2: boolean): Promise<SerializedLegacyResponse> {
  const { params } = run;
  defaultIn(params, 'grant_type', PARAM_DEFAULT);
  setIn(params, 'method', OAUTH_TOKEN_METHOD);
  const grantType = paramText(params, 'grant_type');
  if (cfEq(grantType, 'authorization_code')) return authorizationCodeGrant(run, client);
  if (cfEq(grantType, 'password')) return passwordGrant(run, client, oauth2);
  if (cfEq(grantType, 'client_credentials')) return clientCredentialsGrant(run, client, oauth2);
  if (cfEq(grantType, 'refresh_token')) return refreshTokenGrant(run, client, oauth2);
  return refuse(run, WWW_AUTHENTICATE.bearerInvalidGrantType);
}

/** The `authorization_code` grant, answered bare on either oauth path [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:591-629]. */
async function authorizationCodeGrant(run: RestRun, client: OAuthClient): Promise<SerializedLegacyResponse> {
  const { deps, params } = run;
  if (!cfEq(clientGrantType(client), 'authorization_code') || !cfEq(beanText(client.clientsecret), paramText(params, 'client_secret'))) {
    deleteIn(params, 'client_id');
    deleteIn(params, 'client_secret');
    run.wwwAuthenticate = WWW_AUTHENTICATE.bearerInvalidAuthorizationCode;
    throw new LegacyApiError('authorization');
  }
  defaultIn(params, 'code', PARAM_DEFAULT);
  defaultIn(params, 'redirect_uri', PARAM_DEFAULT);
  const token = await findTokenByAccessCode(deps.oauth, paramText(params, 'code'), paramText(params, 'client_id'));
  const user = token === null ? null : await findOAuthUser(deps.oauth, token.userid);
  if (token === null || isExpired(token, deps.oauth.clock) || user === null || !isValidRedirectURI({ redirecturl: beanText(client.redirecturl) }, paramText(params, 'redirect_uri'))) {
    return refuse(run, WWW_AUTHENTICATE.bearerInvalidAuthorizationCode);
  }
  const issued = await withSessionData(run, token, user);
  const refresh = await generateToken(deps.oauth, client, { grantType: 'refresh_token', userId: user.userId });
  return serializeToken(tokenStruct(run, issued, beanText(refresh.token)));
}

/** The `password` grant of a password client [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:630-686]. */
async function passwordGrant(run: RestRun, client: OAuthClient, oauth2: boolean): Promise<SerializedLegacyResponse> {
  const { deps, params } = run;
  if (!cfEq(clientGrantType(client), 'password')) return refuse(run, WWW_AUTHENTICATE.bearerInvalidClientCredentials);
  defaultIn(params, 'username', '');
  defaultIn(params, 'password', '');
  const user = await restLookup(run, paramText(params, 'username'), paramText(params, 'password'));
  if (user === undefined) return refuse(run, WWW_AUTHENTICATE.bearerInvalidClientCredentials);
  const token = await withSessionData(run, await generateToken(deps.oauth, client, { grantType: 'password', userId: user.userId }), user);
  const refresh = await generateToken(deps.oauth, client, { grantType: 'refresh_token', userId: user.userId });
  return grantAnswer(run, oauth2, token, beanText(refresh.token));
}

/** The `client_credentials` grant, acting for the client's user [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:687-739]. */
async function clientCredentialsGrant(run: RestRun, client: OAuthClient, oauth2: boolean): Promise<SerializedLegacyResponse> {
  const { deps, params } = run;
  if (!cfEq(clientGrantType(client), 'client_credentials') || !cfEq(beanText(client.clientsecret), paramText(params, 'client_secret'))) {
    return refuse(run, WWW_AUTHENTICATE.bearerInvalidClientCredentials);
  }
  const generated = await generateToken(deps.oauth, client, { grantType: 'client_credentials' });
  const user = await findOAuthUser(deps.oauth, generated.userid);
  if (user === null) return refuse(run, WWW_AUTHENTICATE.bearerInvalidClientCredentials);
  const token = await withSessionData(run, generated, user);
  const refresh = await generateToken(deps.oauth, client, { grantType: 'refresh_token', userId: user.userId });
  return grantAnswer(run, oauth2, token, beanText(refresh.token));
}

/** The `refresh_token` grant: a `client_credentials` token for the refresh token's user, answered with the same refresh token [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:740-799]. */
async function refreshTokenGrant(run: RestRun, client: OAuthClient, oauth2: boolean): Promise<SerializedLegacyResponse> {
  const { deps, params } = run;
  const { clock } = deps.oauth;
  if (!isDefinedIn(params, 'refresh_token')) return refuse(run, WWW_AUTHENTICATE.bearerInvalidClientRefreshToken);
  const refresh = await findToken(deps.oauth, { token: paramText(params, 'refresh_token'), grantType: 'refresh_token' });
  const user = refresh === null ? null : await findOAuthUser(deps.oauth, refresh.userid);
  if (user === null || refresh === null || isExpired(refresh, clock)) {
    if (refresh !== null && isExpired(refresh, clock)) await deleteToken(deps.oauth, refresh);
    // `invalid_token` names no catch block, so legacy answers it as an unhandled exception.
    return refuse(run, WWW_AUTHENTICATE.bearerInvalidClientCredentials, 'invalid_token');
  }
  const token = await withSessionData(run, await generateToken(deps.oauth, client, { grantType: 'client_credentials', userId: user.userId }), user);
  return grantAnswer(run, oauth2, token, beanText(refresh.token));
}

/** Client id and secret as Basic credentials of a `basic` client, logging in the client's user [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:808-832]. */
async function basicClient(run: RestRun, client: OAuthClient, isBasicAuth: boolean): Promise<undefined> {
  const { deps, params } = run;
  if (!isBasicAuth) return refuse(run, WWW_AUTHENTICATE.bearerInvalidClientCredentials);
  const accepted = cfEq(clientGrantType(client), 'basic') && cfEq(beanText(client.clientsecret), paramText(params, 'client_secret'));
  deleteIn(params, 'client_id');
  deleteIn(params, 'client_secret');
  if (!accepted) {
    run.wwwAuthenticate = WWW_AUTHENTICATE.basic;
    throw new LegacyApiError('authorization');
  }
  // `getUser()` of a missing user is a new bean without a site, whose login finds nobody and leaves the session anonymous.
  const user = await findOAuthUser(deps.oauth, client.userid);
  if (user !== null) await restLogin(run, user);
  return undefined;
}

/** A grant's token answer: the bare struct on `oauth2` paths, else the envelope [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:659-683]. */
async function grantAnswer(run: RestRun, oauth2: boolean, token: OAuthToken, refreshToken: string): Promise<SerializedLegacyResponse> {
  const data = tokenStruct(run, token, refreshToken);
  if (oauth2) return serializeToken(data);
  // serializeResponse builds `getBean('$').init(siteid)` for a data struct [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:1486-1487].
  await assertSitelessEvent(run, run.input.siteId);
  // ACF's key order for this struct, observed on the legacy wire.
  return serializeToken({ apiversion: getApiVersion(), data, method: OAUTH_TOKEN_METHOD });
}

/** The token struct legacy answers with; `refreshToken` only where legacy sets one [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:619-626,5011-5017]. */
function tokenStruct(run: RestRun, token: OAuthToken, refreshToken?: string): Struct {
  const { clock } = run.deps.oauth;
  // ACF iterates a struct as a Java HashMap over its uppercased keys; this is that order, observed on the legacy wire.
  return {
    access_token: beanText(token.token),
    expires_in: expiresIn(token, clock),
    token_type: BEARER,
    expires_at: expiresAt(token),
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    info: serializableInfo(token),
  };
}

/** `getTokenInfo()` with date text under a date-typed key turned into a date, as the legacy serializer's `isDate` reads it. */
function serializableInfo(token: OAuthToken): AcfStruct {
  const info = tokenInfo(token);
  for (const [key, value] of Object.entries(info)) {
    if (TOKEN_INFO_DATE_KEYS.has(key.toLowerCase()) && typeof value === 'string' && cfIsDateText(value)) info[key] = cfParseDateTimeText(value);
  }
  return info;
}

/** A token answer serialized with the API serializer and the token-info date hint. */
function serializeToken(response: Struct): SerializedLegacyResponse {
  return serializeResponse(response, { serializer: TOKEN_SERIALIZER });
}

/** The token as a grant answers with it: unchanged when its data is session JSON, else after a login whose session it stores [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:612-615]. */
function withSessionData(run: RestRun, token: OAuthToken, user: OAuthUser): Promise<OAuthToken> {
  return isJson(token.data) ? Promise.resolve(token) : loginAndAttach(run, token, user);
}

/** `clientAccount.login()`, then `token.setData(serializeJSON(getSession())).save()` [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:520-521]. */
async function loginAndAttach(run: RestRun, token: OAuthToken, user: OAuthUser): Promise<OAuthToken> {
  await restLogin(run, user);
  return attachSessionData(run.deps.oauth, token, await sessionJson(run));
}

/** `structAppend(getSession(), deserializeJSON(token.getData()), true)`: the stored session, adopted as the run's session [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:503-504]. */
async function restoreSession(run: RestRun, data: string): Promise<void> {
  const stored = parseLegacySessionJson(data);
  // JSON that is not a struct cannot be appended to the session.
  if (stored === undefined) throw runtimeError();
  const mura = stored.mura ?? {};
  const secret = stored.get(mura, 'csrfsecretkey');
  const used = stored.get(mura, 'csrfusedtokens');
  await adoptLegacySession(
    run.deps.sessions,
    {
      legacySessionId: run.sessionId,
      siteId: run.input.siteId,
      describe: {
        user: mura,
        roles: cfListToArray(simpleText(stored.get(mura, 'memberships'))),
        csrfSecretKey: typeof secret === 'string' ? secret : cfUuid(),
        usedTokens: isStruct(used) ? Object.keys(used) : [],
      },
    },
    { mode: REST_SESSION_MODE },
  );
  run.sessionReady = true;
}

/** `serializeJSON(getSession())` of the REST session placeholder the run's session stands for [legacy: core/mura/cfobject.cfc:419-458; core/mura/user/userUtility.cfc:749-801]. */
async function sessionJson(run: RestRun): Promise<string> {
  await ensureRestSession(run);
  const snapshot = await sessionSnapshot(run.deps.sessions, run.sessionId);
  if (snapshot === undefined) throw new Error(`REST session ${run.sessionId} ended while its request ran`);
  const { user } = snapshot;
  const mura: AcfStruct = {
    ...user,
    lastlogin: queryDate(user.lastlogin),
    passwordCreated: queryDate(user.passwordCreated),
    csrfsecretkey: snapshot.csrfSecret,
    csrfusedtokens: Object.fromEntries(snapshot.usedTokens.map(({ token, usedAt }) => [token, usedAt])),
  };
  // setUserStruct params these three, so only a session a login wrote holds them.
  const session: AcfStruct = user.isLoggedIn
    ? { mura, siteid: SESSION_SITE, rememberMe: '0', loginAttempts: '0', blockLoginUntil: '' }
    : { mura, siteid: SESSION_SITE };
  return serializeLegacySessionJson(session);
}

/** Creates the run's session anonymous unless a login or a restored token already wrote it. */
async function ensureRestSession(run: RestRun): Promise<void> {
  if (run.sessionReady) return;
  await ensureSession(run.deps.sessions, { sessionId: run.sessionId, mode: REST_SESSION_MODE });
  run.sessionReady = true;
}

/** `lookupByCredentials(username, password, siteid=<API site>)` in REST mode [legacy: core/mura/user/userUtility.cfc:108-177]. */
async function restLookup(run: RestRun, username: string, password: string): Promise<OAuthUser | undefined> {
  await assertSitelessEvent(run, run.input.siteId);
  const found = await lookupByCredentials(run.deps.login, username, password);
  return found === undefined ? undefined : { userId: found.account.userid, siteId: found.account.siteid ?? '' };
}

/** `userBean.login()`: `loginByUserID(userid, <the user's site>)`, whose refusal leaves the session anonymous [legacy: core/mura/user/userBean.cfc:768-771]. */
async function restLogin(run: RestRun, user: OAuthUser): Promise<void> {
  await assertSitelessEvent(run, user.siteId);
  const result = await loginByUserID(run.deps.login, { sessionId: run.sessionId, mode: REST_SESSION_MODE, siteId: user.siteId, userId: user.userId });
  if (result.ok) run.sessionReady = true;
}

/**
 * Legacy runs REST requests with session management off. On ACF 2023 a `mura.event` built for an existing site then
 * initialises a content renderer whose `isDefined('session.…')` throws, so every REST credential lookup, login and data
 * envelope of a registered site answers 500 [legacy: core/mura/event.cfc:95-99; core/mura/content/contentRenderer.cfc:701].
 * The target answers that same 500 rather than issue a session or token legacy never issues.
 */
async function assertSitelessEvent(run: RestRun, siteId: string): Promise<void> {
  if (siteId !== '' && (await tenantForRegisteredSite(run.deps.login.db, siteId)) !== null) throw runtimeError();
}

/** Replaces the params with `{method: 'getOAuthToken'}`, sets the header and raises `type`, as each token-endpoint refusal does. */
function refuse(run: RestRun, wwwAuthenticate: string, type = 'authorization'): never {
  run.params = { method: OAUTH_TOKEN_METHOD };
  run.wwwAuthenticate = wwwAuthenticate;
  throw new LegacyApiError(type);
}

/** The catch block of the raised type, reading `params.method` and the header as they stand [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:1318-1402]. */
function errorAnswer(run: RestRun, err: unknown): SerializedLegacyResponse {
  return legacyErrorResponse(err instanceof LegacyApiError ? err.type : UNHANDLED, {
    method: methodOf(run.params),
    params: run.params,
    methodCtx: nameContext(run.input),
    wwwAuthenticate: run.wwwAuthenticate,
  });
}

/** The request facts that decide which names `isDefined` resolves in the catch blocks. */
function nameContext(input: RestAuthInput): ApiNameContext {
  return {
    restMode: true,
    hasOrigin: headerValue(input.headers, 'Origin') !== undefined,
    hasAuthorization: headerValue(input.headers, 'Authorization') !== undefined,
  };
}

/** A ColdFusion runtime error inside `processRequest`, which only `catch (Any e)` answers [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:1390-1401]. */
function runtimeError(): LegacyApiError {
  return new LegacyApiError(UNHANDLED);
}

/** `toString(toBinary(value))` as UTF-8 [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:458]. */
function base64Text(value: string): string {
  if (!STRICT_BASE64.test(value)) throw runtimeError();
  return Buffer.from(value, 'base64').toString('utf8');
}

/** A bean property as ORM `setValue` holds it: trimmed, NULL as '' [legacy: core/mura/bean/bean.cfc:427-436]. */
function beanText(value: string | null): string {
  return javaTrim(value ?? '');
}

/** `oauthClient.getGrantType()` over the trimmed stored value [legacy: core/mura/client/api/oauth/oauthClientBean.cfc:73-79]. */
function clientGrantType(client: OAuthClient): string {
  return effectiveGrantType({ granttype: beanText(client.granttype) });
}

/** A request header by name, matched case-insensitively as `getHttpRequestData().headers` keys are. */
function headerValue(headers: RestAuthInput['headers'], name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** The struct key equal to `key` ignoring case, as CFML struct keys resolve. */
function keyOf(struct: Readonly<Struct>, key: string): string | undefined {
  if (Object.hasOwn(struct, key)) return key;
  const wanted = key.toLowerCase();
  return Object.keys(struct).find((name) => name.toLowerCase() === wanted);
}

function valueOf(struct: Readonly<Struct>, key: string): unknown {
  const name = keyOf(struct, key);
  return name === undefined ? undefined : struct[name];
}

/** CFML `isDefined('<struct>.<key>')`: present and not null. */
function isDefinedIn(struct: Readonly<Struct>, key: string): boolean {
  const value = valueOf(struct, key);
  return value !== undefined && value !== null;
}

function setIn(struct: Struct, key: string, value: unknown): void {
  struct[keyOf(struct, key) ?? key] = value;
}

/** CFML `param name="params.<key>" default=…`. */
function defaultIn(struct: Struct, key: string, value: unknown): void {
  if (!isDefinedIn(struct, key)) setIn(struct, key, value);
}

/** CFML `structDelete`. */
function deleteIn(struct: Struct, key: string): void {
  const wanted = key.toLowerCase();
  for (const name of Object.keys(struct)) {
    if (name.toLowerCase() === wanted) delete struct[name];
  }
}

/** `params.<key>` read as a CFML string; an undefined or complex value raises as CFML does. */
function paramText(params: Readonly<Struct>, key: string): string {
  const value = valueOf(params, key);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw runtimeError();
}

/** `params.method` as the catch blocks test it; undefined lets them default it, and a complex value reports `invalid`. */
function methodOf(params: Readonly<Struct>): string | undefined {
  const value = valueOf(params, 'method');
  if (value === undefined || value === null) return undefined;
  return typeof value === 'object' ? '' : String(value);
}

/** A simple value as CFML text, '' for anything else. */
function simpleText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function isStruct(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** CFML `isJSON` of stored token data. */
function isJson(text: string | null): text is string {
  if (text === null || text === '') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** A snapshot timestamp as the `tusers` query value `setUserStruct` copied: a date, or '' for NULL. */
function queryDate(text: string): Date | string {
  return text === '' ? '' : cfParseDateTimeText(text);
}

/** `pathInfo[position]`, 1-based; '' beyond the end. */
function segment(pathInfo: readonly string[], position: number): string {
  return pathInfo[position - 1] ?? '';
}

/** Six segments with the fifth in `names`, or five with the fourth or fifth in it [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:543-550]. */
function onOAuthPath(pathInfo: readonly string[], names: ReadonlySet<string>): boolean {
  return (
    (pathInfo.length === 6 && names.has(segment(pathInfo, 5))) ||
    (pathInfo.length === 5 && (names.has(segment(pathInfo, 4)) || names.has(segment(pathInfo, 5))))
  );
}
