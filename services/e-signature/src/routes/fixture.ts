// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture routes `esignature/…` of legacy-fixtures/cfml/api.cfm, answered as legacy-fixtures/cfml/modules/esignature.cfc answers them. */
import { AuthDenial, Roles, type DenialRenderer, type Opt2AuthContext, type UserClaims } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import {
  csrfPreHandler,
  recordOutcomeReason,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  authorizeRequestReader,
  createSignatureRequest,
  listRequests,
  signRequest,
  verifyStored,
  verifySupplied,
  type EsignatureActor,
  type EsignatureDomainDeps,
} from '../domain/signing.js';
import {
  fixtureDenialOverride,
  resolveFixtureSite,
  runFixtureChecks,
  validateCreateInput,
  validateSignInput,
  validateSuppliedChain,
  type FixtureSite,
  type ValidationResult,
} from '../legacy/checks.js';
import {
  FixtureApiError,
  fixtureContext,
  fixtureList,
  fixtureOutcomeReason,
  fixtureSuccess,
  toFixtureError,
  type FixtureContext,
} from '../legacy/envelope.js';
import { auditRow, requestRow, verifyResult } from '../legacy/serialize.js';
import { listAuditEntries, type RequestPaging } from '../repo/queries.js';

/** The e-signature domain's repository, clock and people reader, plus the e-signature tenant database. */
export type FixtureRouteDeps = EsignatureDomainDeps & { db: TenantDb };

/** Fastify path of the e-signature fixture module; every fixture route below is built from it. */
export const FIXTURE_PREFIX = '/legacy-fixtures/cfml/api.cfm/esignature';

// esignature.cfc admits list, create and sign through requireAny(signer), the chain reads through authorizeChainReader(auditor or signer).
const SIGNER_ROLES: readonly string[] = Object.freeze([Roles.esignatureSigner]);
const CHAIN_READER_ROLES: readonly string[] = Object.freeze([Roles.esignatureSigner, Roles.esignatureAuditor]);

/** The collection's CSRF context: api.cfm passes the empty route id. */
const COLLECTION_CONTEXT = '';

const INT_MAX = 2_147_483_647;
const ASCII_INTEGER = /^[+-]?[0-9]+$/;
const ANY_SCRIPT_INTEGER = /^[+-]?\p{Nd}+$/u;
const DECIMAL_DIGIT = /\p{Nd}/u;

/** Path params of the request routes. */
type IdParams = { id: string };

/** One fixture request after api.cfm's site check: its envelope context, site and acting user. */
interface FixtureCall {
  ctx: FixtureContext;
  site: FixtureSite;
  actor: EsignatureActor;
}

/** Answers one fixture operation for a request that passed the site check. */
type FixtureHandler = (call: FixtureCall, request: FastifyRequest, reply: FastifyReply, deps: FixtureRouteDeps) => Promise<FastifyReply>;

/** A check value that cannot fail by itself; a thrown error still fails its step. */
function passed<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

/** Value of a Unicode decimal digit; such digits come in contiguous runs of ten starting at zero. */
function digitValue(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  let start = codePoint;
  while (DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (codePoint - start) % 10;
}

/** ACF isValid('integer', text), which parses as Java Integer.parseInt: an optional sign, digits of any script, 32-bit range. */
function cfInteger(text: string): number | undefined {
  if (!ANY_SCRIPT_INTEGER.test(text)) return undefined;
  let magnitude = 0;
  for (const char of text.replace(/^[+-]/u, '')) magnitude = magnitude * 10 + digitValue(char);
  const value = text.startsWith('-') ? -magnitude : magnitude;
  return value >= -INT_MAX - 1 && value <= INT_MAX ? value : undefined;
}

/** The merged param under `name` ignoring case, as a CFML struct key resolves; undefined when absent. */
function paramNoCase(params: Record<string, unknown>, name: string): unknown {
  const lower = name.toLowerCase();
  const key = Object.keys(params).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : params[key];
}

/** envelope.cfc pageParam: `fallback` when absent or empty, else an integer in [1, max]; throws invalidParameters. */
function pageParam(params: Record<string, unknown>, name: string, fallback: number, max = INT_MAX): number {
  const value = paramNoCase(params, name);
  if (value === undefined || value === '') return fallback;
  const parsed = typeof value === 'string' ? cfInteger(value) : undefined;
  if (typeof value !== 'string' || parsed === undefined) throw new FixtureApiError('invalidParameters');
  if (ASCII_INTEGER.test(value)) {
    if (parsed < 1 || parsed > max) throw new FixtureApiError('invalidParameters');
    return parsed;
  }
  // ACF compares non-ASCII digit text with the bounds as strings, then its int() fails with an expression error.
  if (value < '1' || value > String(max)) throw new FixtureApiError('invalidParameters');
  throw new Error(`The ${name} paging parameter holds non-ASCII digits`);
}

/** envelope.cfc page(): `pageIndex` defaults to 1, `itemsPerPage` to 50 and at most 1000. */
function fixturePaging(params: Record<string, unknown>): RequestPaging {
  const pageIndex = pageParam(params, 'pageIndex', 1);
  return { pageIndex, itemsPerPage: pageParam(params, 'itemsPerPage', 50, 1000) };
}

/** The verified user; every fixture route requires a user role, so the auth hook admits no request without one. */
function userOf(request: FastifyRequest): UserClaims {
  const { user } = request.opt2Auth;
  if (user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return user;
}

/** The request route's `:id` segment as sent; api.cfm passes it as the CSRF context and the request id. */
function idOf(request: FastifyRequest): string {
  return (request.params as IdParams).id;
}

/** auth.cfc requireCsrf of a logged-in write: identity validates and consumes the token for `context`, else invalidTokens. */
async function requireCsrf(request: FastifyRequest, reply: FastifyReply, context: string): Promise<void> {
  await csrfPreHandler({ contextOf: () => context }).call(request.server, request, reply);
}

/** Sends a list page of `rows` with the page parameters it was read with. */
function sendPage<R>(
  reply: FastifyReply,
  ctx: FixtureContext,
  page: { rows: R[]; total: number },
  paging: RequestPaging,
  project: (row: R) => unknown,
): FastifyReply {
  return sendLegacyResponse(reply, fixtureList(ctx, page.rows.map(project), { total: page.total, ...paging }));
}

/** GET `requests`: one page of the site's requests by creation. */
const listRequestsHandler: FixtureHandler = async ({ ctx, site }, _request, reply, { db }) => {
  const paging = fixturePaging(ctx.params);
  const page = await withTenant(db, site.tenantId, (tx) => listRequests(tx, paging));
  return sendPage(reply, ctx, page, paging, requestRow);
};

/** POST `requests`: a PENDING request for one pool signer, with its `created` audit entry. */
const createRequestHandler: FixtureHandler = async ({ ctx, site, actor }, request, reply, deps) => {
  await requireCsrf(request, reply, COLLECTION_CONTEXT);
  const [input] = await runFixtureChecks([{ step: 'validation', check: () => validateCreateInput(ctx.params) }]);
  const created = await withGatedTenant(deps.db, site.tenantId, (tx) => createSignatureRequest(tx, deps, input, actor));
  return sendLegacyResponse(reply, fixtureSuccess(ctx, requestRow(created.request)));
};

/** POST `requests/{id}/sign`: the signer's typed-name signature, with its `signed` audit entry. */
const signRequestHandler: FixtureHandler = async ({ ctx, site, actor }, request, reply, deps) => {
  const id = idOf(request);
  await requireCsrf(request, reply, id);
  // signRequest applies existence, the signer check, the typed-name rule and the state check in esignature.cfc order.
  const [input] = await runFixtureChecks([{ step: 'validation', check: () => validateSignInput(id, ctx.params) }]);
  const signed = await withGatedTenant(deps.db, site.tenantId, (tx) => signRequest(tx, deps, input, actor));
  return sendLegacyResponse(reply, fixtureSuccess(ctx, requestRow(signed.request)));
};

/** GET `requests/{id}/audit`: one page of the request's audit entries by `seq`, for its signer or an auditor. */
const auditHandler: FixtureHandler = async ({ ctx, site, actor }, request, reply, { db }) => {
  const id = idOf(request);
  const { page, paging } = await withTenant(db, site.tenantId, async (tx) => {
    // esignature.cfc loads and authorizes the request before queryPage validates the paging.
    const [stored, checkedPaging] = await runFixtureChecks([
      { step: 'existence', check: async () => passed(await authorizeRequestReader(tx, id, actor)) },
      { step: 'validation', check: () => passed(fixturePaging(ctx.params)) },
    ]);
    return { page: await listAuditEntries(tx, stored.request_id, checkedPaging), paging: checkedPaging };
  });
  return sendPage(reply, ctx, page, paging, auditRow);
};

/** GET `requests/{id}/verify`: the verdict over the request's stored chain. */
const verifyStoredHandler: FixtureHandler = async ({ ctx, site, actor }, request, reply, { db }) => {
  const id = idOf(request);
  const result = await withTenant(db, site.tenantId, (tx) => verifyStored(tx, id, actor));
  return sendLegacyResponse(reply, fixtureSuccess(ctx, verifyResult(result)));
};

/** POST `requests/{id}/verify`: the verdict over a supplied chain copy, hashed against the stored request id; nothing is stored. */
const verifySuppliedHandler: FixtureHandler = async ({ ctx, site, actor }, request, reply, { db }) => {
  const id = idOf(request);
  await requireCsrf(request, reply, id);
  const result = await withTenant(db, site.tenantId, async (tx) => {
    const [stored, entries] = await runFixtureChecks([
      { step: 'existence', check: async () => passed(await authorizeRequestReader(tx, id, actor)) },
      { step: 'validation', check: () => validateSuppliedChain(ctx.params) },
    ]);
    return verifySupplied(stored, entries);
  });
  return sendLegacyResponse(reply, fixtureSuccess(ctx, verifyResult(result)));
};

/** The handler of each fixture operation, by contract `operationId`. */
const HANDLERS = Object.freeze({
  fixtureListRequests: listRequestsHandler,
  fixtureCreateRequest: createRequestHandler,
  fixtureSignRequest: signRequestHandler,
  fixtureGetAudit: auditHandler,
  fixtureVerifyStored: verifyStoredHandler,
  fixtureVerifySupplied: verifySuppliedHandler,
});

/** Contract `operationId` of a fixture operation. */
export type FixtureOperationId = keyof typeof HANDLERS;

/** One fixture operation of the contract: its route, envelope resource and action, and the roles that may call it. */
export interface FixtureOperation {
  readonly operationId: FixtureOperationId;
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly resource: string;
  readonly action?: string;
  readonly requires: readonly string[];
}

/** The six fixture operations of `contracts/openapi.yaml`, which drive both route registration and error contexts. */
export const FIXTURE_OPERATIONS: readonly FixtureOperation[] = Object.freeze([
  { operationId: 'fixtureListRequests', method: 'GET', url: `${FIXTURE_PREFIX}/requests`, resource: 'requests', requires: SIGNER_ROLES },
  { operationId: 'fixtureCreateRequest', method: 'POST', url: `${FIXTURE_PREFIX}/requests`, resource: 'requests', requires: SIGNER_ROLES },
  {
    operationId: 'fixtureSignRequest',
    method: 'POST',
    url: `${FIXTURE_PREFIX}/requests/:id/sign`,
    resource: 'requests',
    action: 'sign',
    requires: SIGNER_ROLES,
  },
  {
    operationId: 'fixtureGetAudit',
    method: 'GET',
    url: `${FIXTURE_PREFIX}/requests/:id/audit`,
    resource: 'requests',
    action: 'audit',
    requires: CHAIN_READER_ROLES,
  },
  {
    operationId: 'fixtureVerifyStored',
    method: 'GET',
    url: `${FIXTURE_PREFIX}/requests/:id/verify`,
    resource: 'requests',
    action: 'verify',
    requires: CHAIN_READER_ROLES,
  },
  {
    operationId: 'fixtureVerifySupplied',
    method: 'POST',
    url: `${FIXTURE_PREFIX}/requests/:id/verify`,
    resource: 'requests',
    action: 'verify',
    requires: CHAIN_READER_ROLES,
  },
]);

/** Key of an operation by HTTP method and registered route URL. */
function routeKey(method: string, url: string): string {
  return `${method} ${url}`;
}

const OPERATION_BY_ROUTE: ReadonlyMap<string, FixtureOperation> = new Map(FIXTURE_OPERATIONS.map((op) => [routeKey(op.method, op.url), op]));

/** Envelope `method` and merged params of a request to `op`. */
function contextOf(request: FastifyRequest, op: FixtureOperation): FixtureContext {
  return fixtureContext(request, op.resource, op.action);
}

/** Context, site and acting user of a request, the site resolved as auth.cfc resolveSite does before esignature.cfc runs. */
async function fixtureCall(request: FastifyRequest, op: FixtureOperation, db: TenantDb): Promise<FixtureCall> {
  const ctx = contextOf(request, op);
  const user = userOf(request);
  const site = await resolveFixtureSite(ctx.params, user, db);
  // The registered site id, not the token's spelling of it: esignature.cfc stores and filters by resolveSite's canonical id.
  return { ctx, site, actor: { userId: user.sub, siteId: site.siteId, roles: user.roles } };
}

/** Renders a platform auth denial of `op` as the fixture answers it, after the site check auth.cfc resolveSite runs first. */
function fixtureDenialRenderer(db: TenantDb, op: FixtureOperation): DenialRenderer {
  return async (denial, request) => {
    const claims = (request.opt2Auth as Opt2AuthContext | null)?.user;
    const answered = await fixtureDenialOverride(denial, { claims, registry: db });
    recordOutcomeReason(request, fixtureOutcomeReason(answered));
    return toFixtureError(answered, contextOf(request, op));
  };
}

/** Registers the six e-signature fixture routes of the contract, answering their errors and auth denials in the fixture envelope. */
export const esignatureFixturePlugin: FastifyPluginAsync<FixtureRouteDeps> = async (app, deps) => {
  app.setErrorHandler((error, request, reply) => {
    const op = OPERATION_BY_ROUTE.get(routeKey(request.method, request.routeOptions.url ?? ''));
    if (op === undefined) throw error;
    // toFixtureError rethrows LegacyServiceUnavailableError, which the service-kit handler answers with the legacy 503.
    const response = toFixtureError(error, contextOf(request, op));
    // Logged as api.cfm writes its exception record; this handler replaces the service-kit one that would log it.
    if (response.status === 500 && !(error instanceof LegacyApiError)) request.log.error({ error }, 'unhandled fixture exception');
    else recordOutcomeReason(request, fixtureOutcomeReason(error));
    return sendLegacyResponse(reply, response);
  });

  for (const op of FIXTURE_OPERATIONS) {
    const handler = HANDLERS[op.operationId];
    app.route({
      method: op.method,
      url: op.url,
      config: { opt2: { transport: 'service', requires: op.requires, renderDenial: fixtureDenialRenderer(deps.db, op) } },
      handler: async (request, reply) => handler(await fixtureCall(request, op, deps.db), request, reply, deps),
    });
  }
};

/** Registers the e-signature fixture routes in their own encapsulated context, so their error handler serves only them. */
export async function registerFixtureRoutes(app: FastifyInstance, deps: FixtureRouteDeps): Promise<void> {
  await app.register(esignatureFixturePlugin, deps);
}
