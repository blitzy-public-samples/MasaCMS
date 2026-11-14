// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/esignature` routes of the OPT-2 e-signature screens: plain JSON over the domain functions the fixture routes share. */
import { AuthDenial, Roles, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import {
  recordOutcomeReason,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  EsignatureDomainError,
  authorizeRequestReader,
  createSignatureRequest,
  getAuditChain,
  getRequest,
  listRequests,
  signRequest,
  verifyStored,
  verifySupplied,
  type EsignatureActor,
  type EsignatureDomainDeps,
} from '../domain/signing.js';
import { validateCreateInput, validateSignInput, validateSuppliedChain, type ValidationResult } from '../legacy/checks.js';
import { FixtureApiError, fixtureError, fixtureMethod, fixtureOutcomeReason, fixturePage, type FixturePage } from '../legacy/envelope.js';
import { PeopleReadDeniedError } from '../legacy/people-client.js';
import {
  auditRow,
  requestRow,
  signatureRow,
  verifyResult,
  type FixtureAuditEntry,
  type FixtureRequest,
  type FixtureSignature,
  type FixtureVerifyResult,
} from '../legacy/serialize.js';
import type { RequestPaging } from '../repo/queries.js';

/** Path prefix of every `/v1` e-signature operation. */
export const V1_PREFIX = '/v1/esignature';

/** Collaborators of the `/v1/esignature` routes: the e-signature domain deps and the e-signature tenant database. */
export type EsignatureV1Deps = EsignatureDomainDeps & { db: TenantDb };

/** Tenant and actor of a request, from the verified user token only. */
interface VerifiedCaller {
  tenantId: string;
  actor: EsignatureActor;
}

interface RequestParams {
  id: string;
}

/** `pageIndex` and `itemsPerPage`; the schema defaults fill both. */
type PageQuery = RequestPaging;

/** `SignatureRequestDetail`: the request fields with its signature, null while PENDING. */
type SignatureRequestDetail = FixtureRequest & { signature: FixtureSignature | null };

const REQUESTS_PATH = `${V1_PREFIX}/requests`;
const REQUEST_PATH = `${REQUESTS_PATH}/:id`;
const SIGN_PATH = `${REQUEST_PATH}/sign`;
const AUDIT_PATH = `${REQUEST_PATH}/audit`;
const VERIFY_PATH = `${REQUEST_PATH}/verify`;

const SIGNER_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.esignatureSigner]),
});

/** Auditors read any request of the tenant beside the signers, whom the domain limits to their own requests. */
const READER_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.esignatureSigner, Roles.esignatureAuditor]),
});

// The contract's PageIndex and ItemsPerPage parameters, the fixture's paging defaults and bounds.
const PAGE_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    pageIndex: { type: 'integer', minimum: 1, default: 1 },
    itemsPerPage: { type: 'integer', minimum: 1, maximum: 1000, default: 50 },
  },
} as const;

const SIGNER_OPTIONS = { config: { opt2: SIGNER_AUTH } };
const SIGNER_PAGE_OPTIONS = { config: { opt2: SIGNER_AUTH }, schema: { querystring: PAGE_QUERY_SCHEMA } };
const READER_OPTIONS = { config: { opt2: READER_AUTH } };
const READER_PAGE_OPTIONS = { config: { opt2: READER_AUTH }, schema: { querystring: PAGE_QUERY_SCHEMA } };

/** Error envelope `method` of each route: the fixture's method for the same operation. */
const ENVELOPE_METHODS: ReadonlyMap<string, string> = new Map([
  [REQUESTS_PATH, fixtureMethod('requests')],
  [REQUEST_PATH, fixtureMethod('requests')],
  [SIGN_PATH, fixtureMethod('requests', 'sign')],
  [AUDIT_PATH, fixtureMethod('requests', 'audit')],
  [VERIFY_PATH, fixtureMethod('requests', 'verify')],
]);

/** The verified tenant and actor; every route requires a user role, so a request without a user token is unauthenticated. */
function callerOf(request: FastifyRequest): VerifiedCaller {
  const claims: UserClaims | undefined = request.opt2Auth.user;
  if (claims === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return { tenantId: claims.tid, actor: { userId: claims.sub, siteId: claims.site, roles: claims.roles } };
}

/** The path `:id`; throws `invalidParameters` before any query unless it is a CF UUID. */
function requestIdOf(request: FastifyRequest<{ Params: RequestParams }>): string {
  const { id } = request.params;
  if (!isCfUuid(id)) throw new FixtureApiError('invalidParameters');
  return id;
}

/** The request body as the validators read it; a body that is not an object reads as no fields. */
function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const { body } = request;
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** The value of a passed validation; throws the fixture error a failed one answers. */
function validated<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new FixtureApiError(result.type, result.message);
  return result.value;
}

/** One answered page of `total` rows, projected `items` in Masa's paged-list shape. */
function pageOf<T>(items: readonly T[], total: number, paging: RequestPaging): FixturePage<T> {
  return fixturePage(items, { total, pageIndex: paging.pageIndex, itemsPerPage: paging.itemsPerPage });
}

/** The fixture error a `/v1` failure answers; undefined for an error service-kit renders, such as a denial or the legacy 503. */
function answeredError(error: unknown): EsignatureDomainError | FixtureApiError | undefined {
  if (error instanceof EsignatureDomainError || error instanceof FixtureApiError) return error;
  // People refuses some cross-user reads the fixture's userManager.read allows; the fixture answers those forbidden too.
  if (error instanceof PeopleReadDeniedError) return new FixtureApiError('forbidden');
  // A paging parameter the querystring schema refuses, as the fixture's page() refuses it.
  if (error instanceof Error && (error as { validation?: unknown }).validation !== undefined) return new FixtureApiError('invalidParameters');
  return undefined;
}

/** The contract's `/v1/esignature` operations, with an error handler encapsulated to them; other errors reach service-kit's. */
export const esignatureV1Plugin: FastifyPluginAsync<EsignatureV1Deps> = async (instance, deps) => {
  instance.setErrorHandler((error, request, reply) => {
    const answered = answeredError(error);
    if (answered === undefined) throw error;
    recordOutcomeReason(request, fixtureOutcomeReason(answered));
    const method = ENVELOPE_METHODS.get(request.routeOptions.url ?? '') ?? fixtureMethod('requests');
    return sendLegacyResponse(reply, fixtureError(answered.type, { method, params: {} }, answered.message));
  });

  /** `listSignatureRequests`: one page of the tenant's requests in creation order. */
  instance.get<{ Querystring: PageQuery }>(REQUESTS_PATH, SIGNER_PAGE_OPTIONS, async (request, reply) => {
    const { tenantId } = callerOf(request);
    const paging: RequestPaging = { pageIndex: request.query.pageIndex, itemsPerPage: request.query.itemsPerPage };
    const page = await withTenant(deps.db, tenantId, (tx) => listRequests(tx, paging));
    const body: FixturePage<FixtureRequest> = pageOf(page.rows.map(requestRow), page.total, paging);
    return reply.code(200).send(body);
  });

  /** `createSignatureRequest`: a PENDING request for one signer, with its `created` audit entry. */
  instance.post(REQUESTS_PATH, SIGNER_OPTIONS, async (request, reply) => {
    const { tenantId, actor } = callerOf(request);
    const input = validated(validateCreateInput(bodyOf(request)));
    const created = await withGatedTenant(deps.db, tenantId, (tx) => createSignatureRequest(tx, deps, input, actor));
    const body: FixtureRequest = requestRow(created.request);
    return reply.code(200).send(body);
  });

  /** `getSignatureRequest`: one request with its signature. */
  instance.get<{ Params: RequestParams }>(REQUEST_PATH, READER_OPTIONS, async (request, reply) => {
    const { tenantId, actor } = callerOf(request);
    const id = requestIdOf(request);
    const detail = await withTenant(deps.db, tenantId, (tx) => getRequest(tx, id, actor));
    const body: SignatureRequestDetail = {
      ...requestRow(detail.request),
      signature: detail.signature === null ? null : signatureRow(detail.signature),
    };
    return reply.code(200).send(body);
  });

  /** `signRequest`: the signer's typed-name signature, with its `signed` audit entry. */
  instance.post<{ Params: RequestParams }>(SIGN_PATH, SIGNER_OPTIONS, async (request, reply) => {
    const { tenantId, actor } = callerOf(request);
    const input = validated(validateSignInput(requestIdOf(request), bodyOf(request)));
    const signed = await withGatedTenant(deps.db, tenantId, (tx) => signRequest(tx, deps, input, actor));
    const body: FixtureRequest = requestRow(signed.request);
    return reply.code(200).send(body);
  });

  /** `getAuditChain`: one page of the request's audit entries in `seq` order. */
  instance.get<{ Params: RequestParams; Querystring: PageQuery }>(AUDIT_PATH, READER_PAGE_OPTIONS, async (request, reply) => {
    const { tenantId, actor } = callerOf(request);
    const id = requestIdOf(request);
    const paging: RequestPaging = { pageIndex: request.query.pageIndex, itemsPerPage: request.query.itemsPerPage };
    const page = await withTenant(deps.db, tenantId, (tx) => getAuditChain(tx, id, paging, actor));
    const body: FixturePage<FixtureAuditEntry> = pageOf(page.rows.map(auditRow), page.total, paging);
    return reply.code(200).send(body);
  });

  /** `verifyChain`: the verdict on the request's stored audit chain. */
  instance.get<{ Params: RequestParams }>(VERIFY_PATH, READER_OPTIONS, async (request, reply) => {
    const { tenantId, actor } = callerOf(request);
    const id = requestIdOf(request);
    const result = await withTenant(deps.db, tenantId, (tx) => verifyStored(tx, id, actor));
    const body: FixtureVerifyResult = verifyResult(result);
    return reply.code(200).send(body);
  });

  /** `verifySuppliedChain`: the verdict on a supplied copy of the request's chain; nothing is stored. */
  instance.post<{ Params: RequestParams }>(VERIFY_PATH, READER_OPTIONS, async (request, reply) => {
    const { tenantId, actor } = callerOf(request);
    const id = requestIdOf(request);
    const result = await withTenant(deps.db, tenantId, async (tx) => {
      // The request is found and its reader admitted before the copy is read, as the fixture checks existence first.
      const stored = await authorizeRequestReader(tx, id, actor);
      return verifySupplied(stored, validated(validateSuppliedChain(bodyOf(request))));
    });
    const body: FixtureVerifyResult = verifyResult(result);
    return reply.code(200).send(body);
  });
};

/** Registers `esignatureV1Plugin` without `fastify-plugin`, so its error handler stays encapsulated to the `/v1/esignature` routes. */
export async function registerV1Routes(app: FastifyInstance, deps: EsignatureV1Deps): Promise<void> {
  await app.register(esignatureV1Plugin, deps);
}
