// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture routes `reporting/exports…` of legacy-fixtures/cfml/api.cfm, answered as legacy-fixtures/cfml/modules/reporting.cfc answers them. */
import { AuthDenial, Roles, type DenialRenderer, type Opt2AuthContext, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import {
  csrfPreHandler,
  recordOutcomeReason,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import type { ReportingDeps } from '../domain/deps.js';
import { createExportJob, getExportJob, listExportJobs, openExportOutput } from '../domain/jobs.js';
import type { JobPaging } from '../repo/queries.js';
import {
  createExportFields,
  fixtureDenialOverride,
  requireExportJob,
  requireReadyOutput,
  resolveFixtureSite,
  type FixtureSite,
} from './checks.js';
import {
  FIXTURE_MODULE,
  FixtureApiError,
  fixtureContext,
  fixtureFile,
  fixtureList,
  fixtureOutcomeReason,
  fixtureSuccess,
  toFixtureError,
  type FixtureContext,
} from './envelope.js';
import { jobRow } from './serialize.js';

/** Fastify path of the reporting fixture module; every fixture route below is built from it. */
export const FIXTURE_PREFIX = `/legacy-fixtures/cfml/api.cfm/${FIXTURE_MODULE}`;

/** Resource segment of every reporting fixture route. */
const EXPORTS = 'exports';

/** The collection's CSRF context: api.cfm passes the empty route id. */
const COLLECTION_CONTEXT = '';

const INT_MAX = 2_147_483_647;
const DEFAULT_PAGE_INDEX = 1;
const DEFAULT_ITEMS_PER_PAGE = 50;
const MAX_ITEMS_PER_PAGE = 1000;
const ASCII_INTEGER = /^[+-]?[0-9]+$/;
const ANY_SCRIPT_INTEGER = /^[+-]?\p{Nd}+$/u;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const JSON_MEDIA_TYPE = /^application\/json/i;

/** Methods the reporting fixture paths answer. */
type FixtureHttpMethod = 'GET' | 'POST';

/** Request methods every fixture path accepts; `effectiveMethod` picks the operation it answers as. */
const TRANSPORT_METHODS: readonly FixtureHttpMethod[] = Object.freeze(['GET', 'POST']);

/** Path params of the fixture routes. */
type RouteParams = { id?: string };

/** Resource and action segments of a fixture route, which build its envelope `method`. */
interface FixtureRoute {
  resource: string;
  action?: string;
}

/** Route config of a reporting fixture route: its auth declaration and its fixture segments. */
interface FixtureRouteConfig {
  opt2: Opt2RouteConfig;
  fixture: FixtureRoute;
}

/** One fixture request once api.cfm has resolved its site. */
interface FixtureCall {
  request: FastifyRequest;
  reply: FastifyReply;
  ctx: FixtureContext;
  site: FixtureSite;
  /** The path's id segment, '' on the collection. */
  id: string;
}

/** One reporting.cfc operation of a path and method. */
type FixtureOperation = (deps: ReportingDeps, call: FixtureCall) => Promise<FastifyReply>;

/** One fixture path with the operation of each method reporting.cfc `handle` dispatches there. */
interface FixturePath {
  url: string;
  fixture: FixtureRoute;
  methods: ReadonlyArray<readonly [FixtureHttpMethod, FixtureOperation]>;
}

/** Envelope context of a request to one of this plugin's routes, from the fixture segments its route config declares. */
function contextOf(request: FastifyRequest): FixtureContext {
  const { fixture } = request.routeOptions.config as FastifyRequest['routeOptions']['config'] & FixtureRouteConfig;
  return fixtureContext(request, fixture.resource, fixture.action);
}

/** The method api.cfm dispatches on: a non-empty X-HTTP-Method-Override, else the request method, upper-cased. */
function effectiveMethod(request: FastifyRequest): string {
  const override = request.headers['x-http-method-override'];
  const value = Array.isArray(override) ? override[0] : override;
  return (value === undefined || value === '' ? request.method : value).toUpperCase();
}

/** The verified requester's Masa UserID; the route's role requirement admits no request without it. */
function requester(request: FastifyRequest): { userId: string } {
  const { user } = request.opt2Auth;
  if (user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return { userId: user.sub };
}

/** A path id as SQL Server matches it against the stored upper-case char(35) CF UUIDs: ignoring case and trailing spaces. */
function storedId(segment: string): string {
  return segment.replace(/ +$/u, '').toUpperCase();
}

/** The merged param under `name` ignoring case, as a CFML struct key resolves; undefined when absent. */
function paramNoCase(params: Record<string, unknown>, name: string): unknown {
  const lower = name.toLowerCase();
  const key = Object.keys(params).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : params[key];
}

/** Value of a Unicode decimal digit; Unicode assigns such digits in contiguous runs of ten starting at zero. */
function digitValue(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  let start = codePoint;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
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
function fixturePaging(params: Record<string, unknown>): JobPaging {
  const pageIndex = pageParam(params, 'pageIndex', DEFAULT_PAGE_INDEX);
  return { pageIndex, itemsPerPage: pageParam(params, 'itemsPerPage', DEFAULT_ITEMS_PER_PAGE, MAX_ITEMS_PER_PAGE) };
}

/**
 * Merged params with a JSON-body `asOf` of null kept null, which reporting.cfc asOfParam reads as today; the platform merge
 * hands a JSON null over as ''.
 */
function createParams(request: FastifyRequest, params: Record<string, unknown>): Record<string, unknown> {
  const { body } = request;
  const json = JSON_MEDIA_TYPE.test(request.headers['content-type'] ?? '');
  if (!json || typeof body !== 'object' || body === null || Array.isArray(body)) return params;
  const fields = body as Record<string, unknown>;
  // The last spelling is the one the merge kept, as a later key of a CFML struct overwrites an earlier one.
  const key = Object.keys(fields).findLast((candidate) => candidate.toLowerCase() === 'asof');
  return key !== undefined && fields[key] === null ? { ...params, [key]: null } : params;
}

/** auth.cfc requireCsrf of a logged-in write: identity validates and consumes the token for `context`, else invalidTokens. */
async function requireCsrf(request: FastifyRequest, reply: FastifyReply, context: string): Promise<void> {
  await csrfPreHandler({ contextOf: () => context }).call(request.server, request, reply);
}

/** reporting.cfc createExport: the CSRF check, then a queued job of the site's definition, answered as the queued job. */
async function createExport(deps: ReportingDeps, { request, reply, ctx, site }: FixtureCall): Promise<FastifyReply> {
  const { userId } = requester(request);
  await requireCsrf(request, reply, COLLECTION_CONTEXT);
  const job = await createExportJob(deps, {
    tenantId: site.tenantId,
    siteId: site.siteId,
    requestedById: userId,
    ...createExportFields(createParams(request, ctx.params)),
  });
  return sendLegacyResponse(reply, fixtureSuccess(ctx, jobRow(job)));
}

/** reporting.cfc listExports: one page of the site's jobs by creation time, then id. */
async function listExports(deps: ReportingDeps, { reply, ctx, site }: FixtureCall): Promise<FastifyReply> {
  const paging = fixturePaging(ctx.params);
  const page = await listExportJobs(deps, { tenantId: site.tenantId, paging });
  return sendLegacyResponse(reply, fixtureList(ctx, page.rows.map(jobRow), page));
}

/** reporting.cfc exportDetail: one job of the site, else notFound. */
async function exportDetail(deps: ReportingDeps, { reply, ctx, site, id }: FixtureCall): Promise<FastifyReply> {
  const job = requireExportJob(await getExportJob(deps, { tenantId: site.tenantId, jobId: storedId(id) }));
  return sendLegacyResponse(reply, fixtureSuccess(ctx, jobRow(job)));
}

/** reporting.cfc download: a done job's output bytes as an attachment; notFound without the job, the not-ready conflict before done. */
async function downloadExport(deps: ReportingDeps, { reply, site, id }: FixtureCall): Promise<FastifyReply> {
  const ready = requireReadyOutput(await openExportOutput(deps, { tenantId: site.tenantId, jobId: storedId(id) }));
  // One open, not head then stream, so the length sent is that of the stored version whose bytes are streamed.
  const opened = await deps.storage.open(ready.bucket, ready.objectKey);
  let file: ReturnType<typeof fixtureFile>;
  try {
    file = fixtureFile({ fileName: ready.fileName, contentType: ready.contentType, size: opened.head.size });
  } catch (err) {
    opened.body.destroy();
    throw err;
  }
  return reply.code(file.status).headers(file.headers).send(opened.body);
}

/** The reporting fixture paths of the contract, each with the methods reporting.cfc `handle` dispatches there. */
const FIXTURE_PATHS: readonly FixturePath[] = Object.freeze([
  {
    url: `${FIXTURE_PREFIX}/${EXPORTS}`,
    fixture: { resource: EXPORTS },
    methods: [
      ['GET', listExports],
      ['POST', createExport],
    ],
  },
  { url: `${FIXTURE_PREFIX}/${EXPORTS}/:id`, fixture: { resource: EXPORTS }, methods: [['GET', exportDetail]] },
  { url: `${FIXTURE_PREFIX}/${EXPORTS}/:id/download`, fixture: { resource: EXPORTS, action: 'download' }, methods: [['GET', downloadExport]] },
]);

/** Renders a platform auth denial in the fixture error envelope of the denied route, as the fixture answers it after resolveSite and requireLogin. */
function fixtureDenialRenderer(deps: ReportingDeps): DenialRenderer {
  return async (denial, request) => {
    const ctx = contextOf(request);
    const claims = (request.opt2Auth as Opt2AuthContext | null)?.user;
    const answered = await fixtureDenialOverride(denial, { claims, params: ctx.params }, deps);
    recordOutcomeReason(request, fixtureOutcomeReason(answered));
    return toFixtureError(answered, ctx);
  };
}

/** The auth declaration of every reporting fixture route; `resolveFixtureSite` checks the site against the token. */
function fixtureAuth(deps: ReportingDeps): Opt2RouteConfig {
  return Object.freeze({
    requires: Object.freeze([Roles.reportingExporter]),
    transport: 'service',
    siteCheck: false,
    renderDenial: fixtureDenialRenderer(deps),
  });
}

/** Registers one fixture path for every transport method; as api.cfm does, the site resolves first, then the effective method picks the operation or answers notFound. */
function registerPath(scope: FastifyInstance, deps: ReportingDeps, auth: Opt2RouteConfig, path: FixturePath): void {
  scope.route<{ Params: RouteParams }, FixtureRouteConfig>({
    method: [...TRANSPORT_METHODS],
    url: path.url,
    config: { opt2: auth, fixture: path.fixture },
    handler: async (request, reply) => {
      const ctx = contextOf(request);
      const site = await resolveFixtureSite(ctx.params, request, deps);
      const method = effectiveMethod(request);
      const operation = path.methods.find(([candidate]) => candidate === method)?.[1];
      if (operation === undefined) throw new FixtureApiError('notFound');
      return operation(deps, { request, reply, ctx, site, id: request.params.id ?? '' });
    },
  });
}

/** Registers the three reporting fixture paths for GET and POST in their own encapsulated context, so their error handler serves only them. */
export async function registerFixtureRoutes(app: FastifyInstance, deps: ReportingDeps): Promise<void> {
  const auth = fixtureAuth(deps);
  await app.register(async (scope) => {
    scope.setErrorHandler((error, request, reply) => {
      // Rethrows a LegacyServiceUnavailableError, which the service-kit handler answers as the legacy 503.
      const response = toFixtureError(error, contextOf(request));
      if (response.status === 500 && !(error instanceof LegacyApiError)) request.log.error({ error: serializeError(error) }, 'unhandled fixture exception');
      else recordOutcomeReason(request, fixtureOutcomeReason(error));
      return sendLegacyResponse(reply, response);
    });
    for (const path of FIXTURE_PATHS) registerPath(scope, deps, auth, path);
  });
}
