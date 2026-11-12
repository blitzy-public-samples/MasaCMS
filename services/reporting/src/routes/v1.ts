// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/reporting` routes of the OPT-2 reporting screen: the export job list, queueing a job, one job and a done job's download URL. */
import { AuthDenial, Roles, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import { sendLegacyResponse, type FastifyInstance, type FastifyPluginAsync, type FastifyRequest } from '@opt2/platform/service-kit';
import type { ReportingDeps } from '../domain/deps.js';
import { ReportingDomainError, createExportJob, getExportJob, listExportJobs, openExportOutput, signedExportUrl } from '../domain/jobs.js';
import type { components, operations } from '../generated/openapi.js';
import { createExportFields, requireExportJob, requireReadyOutput } from '../legacy/checks.js';
import { FixtureApiError, fixtureMethod, fixtureParams, toFixtureError } from '../legacy/envelope.js';
import { jobRow } from '../legacy/serialize.js';
import type { JobPaging } from '../repo/queries.js';
import type { ExportJobRow } from '../repo/tables.js';

/** The `application/json` body of an operation's 200 response. */
type OkBody<O> = O extends { responses: { 200: { content: { 'application/json': infer B } } } } ? B : never;

type ExportJob = components['schemas']['ExportJob'];
type ExportListBody = OkBody<operations['listExports']>;
type CreatedExportBody = OkBody<operations['createExport']>;
type ExportJobBody = OkBody<operations['getExport']>;
type DownloadUrlBody = OkBody<operations['getExportDownloadUrl']>;
type ExportPathParams = operations['getExport']['parameters']['path'];

/** `listExports` query; the schema defaults fill both. */
interface ExportListQuery {
  page: number;
  pageSize: number;
}

/** Verified user claims and bearer token of a request. */
interface VerifiedCaller {
  user: UserClaims;
  userToken: string;
}

const EXPORTS_PATH = '/v1/reporting/exports';
const EXPORT_PATH = `${EXPORTS_PATH}/:id`;
const DOWNLOAD_URL_PATH = `${EXPORT_PATH}/download-url`;

const EXPORTS_METHOD = fixtureMethod('exports');
const DOWNLOAD_METHOD = fixtureMethod('exports', 'download');

const EXPORTER_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.reportingExporter]),
});

// The fixture's paging defaults, envelope.cfc page().
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;

const LIST_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    pageSize: { type: 'integer', minimum: 1, default: DEFAULT_PAGE_SIZE },
  },
} as const;

const EXPORT_PARAMS_SCHEMA = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } } as const;

const LIST_OPTIONS = { config: { opt2: EXPORTER_AUTH }, schema: { querystring: LIST_QUERY_SCHEMA } };
// No body schema: createExportJob checks the definition, then format and asOf, in the fixture's order.
const CREATE_OPTIONS = { config: { opt2: EXPORTER_AUTH } };
const EXPORT_OPTIONS = { config: { opt2: EXPORTER_AUTH }, schema: { params: EXPORT_PARAMS_SCHEMA } };

/** The contract's `ExportJob` of a stored job: the fixture row projection, so `/v1` and the fixture routes answer one shape. */
export function toV1ExportJob(row: ExportJobRow): ExportJob {
  return jobRow(row);
}

/** The verified user and token; every route requires a user role, so a request without them is unauthenticated. */
function callerOf(request: FastifyRequest): VerifiedCaller {
  const { user, userToken } = request.opt2Auth;
  if (user === undefined || userToken === undefined) {
    throw AuthDenial.unauthenticated('missing-credential');
  }
  return { user, userToken };
}

/** Envelope `method` the fixture reports for the same operation. */
function envelopeMethod(request: FastifyRequest): string {
  return request.routeOptions.url === DOWNLOAD_URL_PATH ? DOWNLOAD_METHOD : EXPORTS_METHOD;
}

/**
 * The contract's `/v1/reporting` operations. Domain and existence or state failures answer in the fixture error envelope of the
 * same operation; every other error reaches service-kit's handler.
 */
export const reportingV1Plugin: FastifyPluginAsync<ReportingDeps> = async (instance, deps) => {
  instance.setErrorHandler((error, request, reply) => {
    if (!(error instanceof ReportingDomainError || error instanceof FixtureApiError)) {
      throw error;
    }
    return sendLegacyResponse(reply, toFixtureError(error, { method: envelopeMethod(request), params: fixtureParams(request) }));
  });

  instance.get<{ Querystring: ExportListQuery }>(EXPORTS_PATH, LIST_OPTIONS, async (request): Promise<ExportListBody> => {
    const paging: JobPaging = { pageIndex: request.query.page, itemsPerPage: request.query.pageSize };
    const page = await listExportJobs(deps, { tenantId: callerOf(request).user.tid, paging });
    return { data: page.rows.map(toV1ExportJob), total: page.total };
  });

  instance.post(EXPORTS_PATH, CREATE_OPTIONS, async (request): Promise<CreatedExportBody> => {
    const { user, userToken } = callerOf(request);
    const job = await createExportJob(deps, {
      ...createExportFields(fixtureParams(request)),
      tenantId: user.tid,
      siteId: user.site,
      requestedById: user.sub,
      userToken,
    });
    return { data: toV1ExportJob(job) };
  });

  instance.get<{ Params: ExportPathParams }>(EXPORT_PATH, EXPORT_OPTIONS, async (request): Promise<ExportJobBody> => {
    const job = await getExportJob(deps, { tenantId: callerOf(request).user.tid, jobId: request.params.id });
    return { data: toV1ExportJob(requireExportJob(job)) };
  });

  instance.get<{ Params: ExportPathParams }>(DOWNLOAD_URL_PATH, EXPORT_OPTIONS, async (request): Promise<DownloadUrlBody> => {
    const output = await openExportOutput(deps, { tenantId: callerOf(request).user.tid, jobId: request.params.id });
    return { data: await signedExportUrl(deps, requireReadyOutput(output)) };
  });
};

/** Registers `reportingV1Plugin` without `fastify-plugin`, so its error handler stays encapsulated to the `/v1/reporting` routes. */
export async function registerV1Routes(app: FastifyInstance, deps: ReportingDeps): Promise<void> {
  await app.register(reportingV1Plugin, deps);
}
