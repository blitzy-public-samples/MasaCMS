// The people fixture's archive route (legacy-fixtures/cfml/modules/people.cfc), answered in the fixture envelope; seam 1's producer.
import {
  AuthDenial,
  Roles,
  assertSiteMatches,
  hasAnyRole,
  type DenialRenderer,
  type Opt2RouteConfig,
  type UserClaims,
} from '@opt2/platform/auth';
import {
  LEGACY_ERROR_MAP,
  LegacyApiError,
  LegacyServiceUnavailableError,
  buildEnvelope,
  javaTrim,
  serializeResponse,
  type LegacyApiErrorType,
  type LegacyErrorSpec,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import {
  csrfPreHandler,
  isUnstorableTextError,
  legacyParamsOf,
  recordOutcomeReason,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { poolTenantFor, tenantForRegisteredSite, type PoolKind, type TenantDb } from '@opt2/platform/tenancy';
import { archivePerson, getPersonArchive, parseArchiveInput, type ArchiveDeps } from '../domain/archive.js';
import type { RosterDeps } from '../domain/roster-protocol.js';
import type { components } from '../generated/openapi.js';
import type { AuditActor } from '../repo/repository.js';

type Schemas = components['schemas'];
type ArchiveRequest = Schemas['ArchiveRequest'];
/** The contract's `data` of `people.persons.archive`. */
type ArchiveData = NonNullable<Schemas['ArchiveEnvelope']['data']>;
type FixtureErrorCode = Schemas['LegacyError']['error']['code'];
type ArchiveRoute = { Params: { userId: string }; Body: ArchiveRequest };
/** Merged request params keyed by lower-cased name, as a CFML struct resolves them. */
type FixtureParams = ReadonlyMap<string, unknown>;

/** Collaborators of the archive route: the archive domain, and identity's session user, whose name `archived_by` records. */
export interface FixtureArchiveRouteDeps {
  archive: ArchiveDeps;
  identity: Pick<RosterDeps['identity'], 'actingUser'>;
}

/** Fastify path of the fixture archive route; api.cfm reads module, resource and action in any case. */
export const FIXTURE_ARCHIVE_PATH = '/legacy-fixtures/cfml/api.cfm/people/persons/:userId/archive';

/** api.cfm's envelope `method`: `<module>.<resource>.<action>`. */
const ARCHIVE_METHOD = 'people.persons.archive';

/** auth.cfc resolveSite's last fallback. */
const DEFAULT_SITE_ID = 'default';

/** people.cfc requirePerson: the user pools of the request site, in its comparison order. */
const USER_POOLS: readonly PoolKind[] = Object.freeze(['publicUser', 'privateUser']);

/** auth.cfc isSiteAdmin: `isSuperUser()` or the site's private-pool `Admin` group. */
const SITE_ADMIN_ROLES: readonly string[] = Object.freeze([Roles.s2, Roles.siteAdmin]);

/** The rows envelope.cfc adds to the JSON API error map; its other rows equal LEGACY_ERROR_MAP's. */
const FIXTURE_ONLY_ERRORS = Object.freeze({
  forbidden: Object.freeze({ status: 403, code: 'invalid_request', message: 'Insufficient Account Permissions' }),
  notFound: Object.freeze({ status: 404, code: 'invalid_request', message: 'Not Found' }),
}) satisfies Readonly<Record<string, LegacyErrorSpec & { code: FixtureErrorCode }>>;

/** JSON API error types envelope.cfc's map also holds; any other type answers server_error, as its fail() does. */
const FIXTURE_SHARED_TYPES: readonly LegacyApiErrorType[] = Object.freeze([
  'authorization',
  'invalidParameters',
  'invalidMethodCall',
  'badRequest',
  'invalidTokens',
  'server_error',
]);

/** Keys of a JSON object body; Masa's request-start scan leaves their values as sent. */
function jsonBodyKeys(request: FastifyRequest): ReadonlySet<string> {
  const contentType = request.headers['content-type'];
  const body: unknown = request.body;
  const json = typeof contentType === 'string' && contentType.slice(0, 16).toLowerCase() === 'application/json';
  if (!json || typeof body !== 'object' || body === null || Array.isArray(body)) return new Set();
  return new Set(Object.keys(body).map((key) => key.toLowerCase()));
}

/** api.cfm's merged url, form and JSON params; url and form strings trimmed as the Portcullis scan in Masa's onRequestStart trims them. */
function fixtureParams(request: FastifyRequest): FixtureParams {
  const fromJson = jsonBodyKeys(request);
  return new Map(
    Object.entries(legacyParamsOf(request)).map(([name, value]): [string, unknown] => {
      const key = name.toLowerCase();
      return [key, typeof value === 'string' && !fromJson.has(key) ? javaTrim(value) : value];
    }),
  );
}

/** The method api.cfm dispatches on: a non-empty X-HTTP-Method-Override, else the request method, upper-cased. */
function effectiveMethod(request: FastifyRequest): string {
  const override = request.headers['x-http-method-override'];
  const value = Array.isArray(override) ? override[0] : override;
  return (value === undefined || value === '' ? request.method : value).toUpperCase();
}

/**
 * auth.cfc resolveSite: `siteid`, else the token's site standing for the session's, else `default`; invalidParameters for a
 * non-simple or unregistered site. A verified token must then be for that site (403 otherwise).
 */
async function resolveSite(db: TenantDb, params: FixtureParams, user: UserClaims | undefined): Promise<void> {
  const supplied = params.get('siteid') ?? '';
  const siteId = supplied === '' ? user?.site || DEFAULT_SITE_ID : supplied;
  // An unknown site is refused, not replaced by `default` as the JSON API's fallbackSiteId does: auth.cfc and the contract refuse it.
  if (typeof siteId !== 'string' || (await tenantForRegisteredSite(db, siteId)) === null) {
    throw new LegacyApiError('invalidParameters');
  }
  if (user !== undefined) assertSiteMatches(siteId, user);
}

/** auth.cfc requireLogin: the verified session user; the anonymous principal (`sub` '') is not logged in. */
function requireLogin(request: FastifyRequest): UserClaims {
  const user = request.opt2Auth.user;
  if (user === undefined || user.sub === '') throw new LegacyApiError('authorization');
  return user;
}

/** people.cfc gate: forbidden unless auth.cfc isSiteAdmin holds. */
function requireSiteAdmin(user: UserClaims): void {
  if (!(user.s2 || hasAnyRole(user.roles, SITE_ADMIN_ROLES))) throw new LegacyApiError('forbidden');
}

/** auth.cfc requireCsrf of a logged-in write: identity validates and consumes the token for the raw route id, else invalidTokens. */
async function requireCsrf(request: FastifyRequest, reply: FastifyReply, context: string): Promise<void> {
  await csrfPreHandler({ contextOf: () => context }).call(request.server, request, reply);
}

/**
 * people.cfc requirePerson: the tenant of the site's public or private user pool, from registry data only, that holds the person;
 * a pooled person's tenant is the pool site's. Throws notFound when neither pool holds them.
 */
async function personTenant(archive: ArchiveDeps, siteTenant: string, userId: string): Promise<string> {
  const pools = await Promise.all(USER_POOLS.map((kind) => poolTenantFor(archive.db, siteTenant, kind)));
  for (const tenantId of new Set(pools.filter((pool): pool is string => pool !== null))) {
    const found = await archive.fence.withPersonsOpen(
      archive.db,
      tenantId,
      async (tx) => {
        await archive.fence.fencePersons(tx, [userId]);
        return (await archive.repo.findPerson(tx, userId)) !== null;
      },
      { clock: archive.clock },
    );
    if (found) return tenantId;
  }
  throw new LegacyApiError('notFound');
}

/** The archive's audit actor: the session user, named as identity's login-time session holds them. */
async function sessionActor(deps: FixtureArchiveRouteDeps, user: UserClaims): Promise<AuditActor> {
  const acting = await deps.identity.actingUser(user.sid);
  return { userId: user.sub, fname: acting?.fname, lname: acting?.lname, isLoggedIn: true };
}

/** api.cfm with people.cfc handle(): the checks in their order, then the archive (POST) or its read (GET). */
async function serveArchive(
  deps: FixtureArchiveRouteDeps,
  request: FastifyRequest<ArchiveRoute>,
  reply: FastifyReply,
  params: FixtureParams,
): Promise<ArchiveData> {
  await resolveSite(deps.archive.db, params, request.opt2Auth.user);
  const method = effectiveMethod(request);
  if (method !== 'POST' && method !== 'GET') throw new LegacyApiError('notFound');
  const user = requireLogin(request);
  requireSiteAdmin(user);
  // api.cfm keeps the id segment as sent and checks no shape: it is the CSRF context and the stored person_id, and an id that
  // names no person answers notFound after the gate.
  const { userId } = request.params;
  if (method === 'POST') await requireCsrf(request, reply, userId);
  const tenantId = await personTenant(deps.archive, user.tid, userId);
  if (method === 'GET') return getPersonArchive(deps.archive, { tenantId, userId });
  const input = parseArchiveInput(userId, params);
  return archivePerson(deps.archive, { tenantId, input, actor: await sessionActor(deps, user) });
}

/** The envelope.cfc error-map row answering `error`; anything else is server_error, as api.cfm's catch-all answers it. */
function fixtureErrorRow(error: unknown): LegacyErrorSpec {
  if (error instanceof AuthDenial) return error.statusCode === 403 ? FIXTURE_ONLY_ERRORS.forbidden : LEGACY_ERROR_MAP.authorization;
  if (isUnstorableTextError(error)) return LEGACY_ERROR_MAP.invalidParameters;
  if (!(error instanceof LegacyApiError)) return LEGACY_ERROR_MAP.server_error;
  if (Object.hasOwn(FIXTURE_ONLY_ERRORS, error.type)) return FIXTURE_ONLY_ERRORS[error.type as keyof typeof FIXTURE_ONLY_ERRORS];
  const shared = FIXTURE_SHARED_TYPES.find((type) => type === error.type);
  return shared === undefined ? LEGACY_ERROR_MAP.server_error : LEGACY_ERROR_MAP[shared];
}

/** envelope.cfc fail(): the error envelope at the row's status. */
function errorResponse(row: LegacyErrorSpec): SerializedLegacyResponse {
  // Not legacyErrorResponse: envelope.cfc keeps api.cfm's method, adds forbidden and notFound, and orders code before message.
  const envelope = buildEnvelope({ method: ARCHIVE_METHOD, error: { code: row.code, message: row.message } });
  return serializeResponse(envelope, { statusCode: row.status });
}

/** envelope.cfc success(): the record as `data`, flattened when `useDataNamespace` is false. */
function successResponse(data: ArchiveData, params: FixtureParams): SerializedLegacyResponse {
  return serializeResponse(buildEnvelope({ method: ARCHIVE_METHOD, data }), { useDataNamespace: params.get('usedatanamespace') });
}

/** The fixture error response of a thrown value, recording its outcome reason or logging an unexpected failure. */
function failureResponse(request: FastifyRequest, error: unknown): SerializedLegacyResponse {
  if (error instanceof AuthDenial) recordOutcomeReason(request, error.reason);
  else if (error instanceof LegacyApiError) recordOutcomeReason(request, error.type);
  else if (isUnstorableTextError(error)) recordOutcomeReason(request, error.code);
  else request.log.error({ error }, 'unhandled fixture exception');
  return errorResponse(fixtureErrorRow(error));
}

/** Renders a denial of the auth hooks, such as a presented invalid token, as the fixture answers a refused session. */
const renderFixtureDenial: DenialRenderer = (denial) => errorResponse(fixtureErrorRow(denial));

/**
 * Registers `archivePerson` (POST) and `getPersonArchive` (GET) on the fixture archive path. The effective method selects the
 * operation, as it selects the route key; site, login and role checks run in the handler in the fixture's order, so the
 * route is public and makes its own site check.
 */
export async function registerFixtureArchiveRoutes(app: FastifyInstance, deps: FixtureArchiveRouteDeps): Promise<void> {
  const opt2: Opt2RouteConfig = { transport: 'service', public: true, siteCheck: false, renderDenial: renderFixtureDenial };
  app.route<ArchiveRoute>({
    method: ['GET', 'POST'],
    url: FIXTURE_ARCHIVE_PATH,
    config: { opt2 },
    handler: async (request, reply) => {
      const params = fixtureParams(request);
      try {
        return sendLegacyResponse(reply, successResponse(await serveArchive(deps, request, reply, params), params));
      } catch (error) {
        // Gate, user-closure and service waits answer service-kit's legacy 503.
        if (error instanceof LegacyServiceUnavailableError) throw error;
        return sendLegacyResponse(reply, failureResponse(request, error));
      }
    },
  });
}
