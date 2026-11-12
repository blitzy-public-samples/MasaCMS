// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/finance` routes of the OPT-2 finance screens: records with versions and attachments, lifecycle transitions, download URLs and rollups. */
import { AuthDenial, Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import {
  LEGACY_ERROR_MAP,
  LegacyApiError,
  buildEnvelope,
  errorSpec,
  serializeResponse,
  type LegacyErrorSpec,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { multipartFilesOf, sendLegacyResponse, type FastifyInstance, type FastifyPluginAsync, type FastifyRequest } from '@opt2/platform/service-kit';
import { TransitionRejectedError } from '@opt2/platform/state-machine';
import { withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { getAttachment, listAttachments, signedDownloadUrl, uploadAttachment, type AttachmentDownloadUrl } from '../domain/attachments.js';
import { FINANCE_ACTIONS, FINANCE_STATES, type FinanceAction, type FinanceState } from '../domain/lifecycle.transitions.js';
import {
  FinanceDomainError,
  getRecord,
  listRecords,
  listVersions,
  transitionRecord,
  type FinanceActor,
  type FinanceDomainDeps,
  type FinanceDomainErrorType,
  type RecordEdit,
} from '../domain/records.js';
import { getRollups, rebuildRollups } from '../domain/rollup.js';
import { requireProgram, validateRecordInput } from '../legacy/checks.js';
import {
  attachmentRow,
  recordDetail,
  recordRow,
  rollupRow,
  versionRow,
  type FixtureAttachment,
  type FixtureRecord,
  type FixtureRecordDetail,
  type FixtureRollup,
  type FixtureVersion,
} from '../legacy/serialize.js';
import type { Page, RecordPaging } from '../repo/queries.js';
import type { FinanceRecordRow } from '../repo/tables.js';

/** Collaborators of the `/v1/finance` routes: the finance domain deps and the finance tenant database. */
export type FinanceV1Deps = FinanceDomainDeps & { db: TenantDb };

/** Tenant, actor and token roles of a request, from the verified user token only. */
interface VerifiedCaller {
  tenantId: string;
  actor: FinanceActor;
  roles: readonly string[];
}

interface RecordParams {
  id: string;
}

interface TransitionParams extends RecordParams {
  action: FinanceAction;
}

interface AttachmentParams extends RecordParams {
  aid: string;
}

/** `listRecords` query; the schema defaults fill `page` and `pageSize`. */
interface RecordListQuery {
  state?: FinanceState;
  period?: string;
  page: number;
  pageSize: number;
}

const RECORDS_PATH = '/v1/finance/records';
const RECORD_PATH = `${RECORDS_PATH}/:id`;
const VERSIONS_PATH = `${RECORD_PATH}/versions`;
const TRANSITION_PATH = `${RECORD_PATH}/transitions/:action`;
const ATTACHMENTS_PATH = `${RECORD_PATH}/attachments`;
const DOWNLOAD_URL_PATH = `${ATTACHMENTS_PATH}/:aid/download-url`;
const ROLLUPS_PATH = '/v1/finance/rollups';

const READER_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.financePreparer, Roles.financeApprover]),
});

const PREPARER_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.financePreparer]),
});

// The fixture's paging defaults; the contract leaves `page` and `pageSize` optional without one.
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;

/** Rows per query while a route reads every row: the largest page the fixture paging admits. */
const SCAN_PAGE_SIZE = 1000;

/** Multipart field of the uploaded file, as finance.cfc reads it. */
const FILE_FIELD = 'file';

const CF_ID_SCHEMA = { type: 'string', pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$' } as const;

const RECORD_PARAMS_SCHEMA = { type: 'object', required: ['id'], properties: { id: CF_ID_SCHEMA } } as const;

const TRANSITION_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id', 'action'],
  properties: { id: CF_ID_SCHEMA, action: { type: 'string', enum: FINANCE_ACTIONS } },
} as const;

const ATTACHMENT_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id', 'aid'],
  properties: { id: CF_ID_SCHEMA, aid: CF_ID_SCHEMA },
} as const;

const RECORD_LIST_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: FINANCE_STATES },
    period: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    pageSize: { type: 'integer', minimum: 1, default: DEFAULT_PAGE_SIZE },
  },
} as const;

const ROLLUP_QUERY_SCHEMA = {
  type: 'object',
  properties: { asOf: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' } },
} as const;

const RECORD_LIST_OPTIONS = { config: { opt2: READER_AUTH }, schema: { querystring: RECORD_LIST_QUERY_SCHEMA } };
const RECORD_OPTIONS = { config: { opt2: READER_AUTH }, schema: { params: RECORD_PARAMS_SCHEMA } };
const TRANSITION_OPTIONS = { config: { opt2: READER_AUTH }, schema: { params: TRANSITION_PARAMS_SCHEMA } };
const UPLOAD_OPTIONS = { config: { opt2: PREPARER_AUTH }, schema: { params: RECORD_PARAMS_SCHEMA } };
const DOWNLOAD_URL_OPTIONS = { config: { opt2: READER_AUTH }, schema: { params: ATTACHMENT_PARAMS_SCHEMA } };
const ROLLUP_OPTIONS = { config: { opt2: READER_AUTH }, schema: { querystring: ROLLUP_QUERY_SCHEMA } };

/** Status of each domain error type in the fixture error map; both answer the `invalid_request` code. */
const DOMAIN_ERROR_STATUS: Readonly<Record<FinanceDomainErrorType, number>> = Object.freeze({
  notFound: 404,
  invalidParameters: LEGACY_ERROR_MAP.invalidParameters.status,
});

const DOMAIN_ERROR_CODE = LEGACY_ERROR_MAP.invalidParameters.code;

/** The verified tenant, actor and roles; every route requires a user role, so a request without them is unauthenticated. */
function callerOf(request: FastifyRequest): VerifiedCaller {
  const { user } = request.opt2Auth;
  const { tenantId, site } = request.opt2;
  if (user === undefined || tenantId === undefined || site === undefined) {
    throw AuthDenial.unauthenticated('missing-credential');
  }
  return { tenantId, actor: { userId: user.sub, siteId: site }, roles: user.roles };
}

/** Runs `read` in a transaction of the verified tenant once its program binding is confirmed, as every fixture route first does. */
function readInProgram<T>(deps: FinanceV1Deps, tenantId: string, read: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(deps.db, tenantId, async (tx) => {
    await requireProgram(tx, tenantId);
    return read(tx);
  });
}

/** As `readInProgram`, in a gated transaction, so every write goes through the repository's unit gates. */
function writeInProgram<T>(deps: FinanceV1Deps, tenantId: string, write: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withGatedTenant(deps.db, tenantId, async (tx) => {
    await requireProgram(tx, tenantId);
    return write(tx);
  });
}

/** Every row `read` returns, page after page, in its order. */
async function everyRow<R>(read: (paging: RecordPaging) => Promise<Page<R>>): Promise<R[]> {
  const rows: R[] = [];
  for (let pageIndex = 1; ; pageIndex += 1) {
    const page = await read({ pageIndex, itemsPerPage: SCAN_PAGE_SIZE });
    rows.push(...page.rows);
    if (page.rows.length < SCAN_PAGE_SIZE) return rows;
  }
}

/** One page of the tenant's records in fixture order, of those matching `state` and `period` when given, with the count of all matches. */
async function recordPage(tx: TenantTx, { state, period, page, pageSize }: RecordListQuery): Promise<Page<FinanceRecordRow>> {
  if (state === undefined && period === undefined) return listRecords(tx, { pageIndex: page, itemsPerPage: pageSize });
  // The record query takes no filters, so a filtered list is paged in memory over every record, in the same order.
  const matching = (await everyRow((paging) => listRecords(tx, paging))).filter(
    (row) => (state === undefined || row.state === state) && (period === undefined || row.period === period),
  );
  const offset = (page - 1) * pageSize;
  return { rows: matching.slice(offset, offset + pageSize), total: matching.length };
}

/** The fields an `edit` sets, validated once as finance.cfc validates them; throws `invalidParameters` for the first invalid one. */
function editInput(body: unknown): RecordEdit {
  const result = validateRecordInput(typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}, 'edit');
  if (!result.ok) throw new FinanceDomainError(result.type);
  return result.value;
}

/** The multipart `file` part, which must carry a file name; throws `invalidParameters` otherwise, as finance.cfc does. */
function uploadedFile(request: FastifyRequest): ReturnType<typeof multipartFilesOf>[number] {
  const file = multipartFilesOf(request).find((part) => part.field === FILE_FIELD && part.filename !== '');
  if (file === undefined) throw new FinanceDomainError('invalidParameters');
  return file;
}

/** Envelope `method` the fixture reports for the same operation, `finance.<resource>[.<action>]`. */
function envelopeMethod(request: FastifyRequest): string {
  switch (request.routeOptions.url) {
    case VERSIONS_PATH:
      return 'finance.records.versions';
    case TRANSITION_PATH:
      return `finance.records.${(request.params as TransitionParams).action}`;
    case ATTACHMENTS_PATH:
    case DOWNLOAD_URL_PATH:
      return 'finance.records.attachments';
    case ROLLUPS_PATH:
      return 'finance.rollups';
    default:
      return 'finance.records';
  }
}

/** Error envelope of `method` with `code` before `message`, as envelope.cfc `fail` orders them, at the spec's status. */
function errorEnvelope(method: string, { status, code, message }: LegacyErrorSpec): SerializedLegacyResponse {
  return serializeResponse(buildEnvelope({ method, error: { code, message } }), { statusCode: status });
}

/** The fixture error answer to a domain, lifecycle or check failure; undefined for an error the service-kit handler renders. */
function errorResponse(error: unknown, method: () => string): SerializedLegacyResponse | undefined {
  if (error instanceof TransitionRejectedError) {
    return serializeResponse(error.toEnvelope({ method: method() }), { statusCode: error.statusCode });
  }
  if (error instanceof FinanceDomainError) {
    return errorEnvelope(method(), { status: DOMAIN_ERROR_STATUS[error.type], code: DOMAIN_ERROR_CODE, message: error.message });
  }
  // A tenant without a program, or a signed URL refused for its file name, answers with this route's fixture method rather than
  // the service-kit handler's 'invalid'; denials keep the platform's renderer.
  if (error instanceof LegacyApiError && !(error instanceof AuthDenial)) {
    return errorEnvelope(method(), errorSpec(error.type));
  }
  return undefined;
}

/** The contract's `/v1/finance` operations with an error handler encapsulated to them; other errors reach the service-kit handler. */
export const financeV1Plugin: FastifyPluginAsync<FinanceV1Deps> = async (instance, deps) => {
  instance.setErrorHandler((error, request, reply) => {
    const response = errorResponse(error, () => envelopeMethod(request));
    if (response === undefined) throw error;
    return sendLegacyResponse(reply, response);
  });

  instance.get<{ Querystring: RecordListQuery }>(
    RECORDS_PATH,
    RECORD_LIST_OPTIONS,
    async (request): Promise<{ data: FixtureRecord[]; total: number }> => {
      const page = await readInProgram(deps, callerOf(request).tenantId, (tx) => recordPage(tx, request.query));
      return { data: page.rows.map(recordRow), total: page.total };
    },
  );

  instance.get<{ Params: RecordParams }>(RECORD_PATH, RECORD_OPTIONS, async (request): Promise<{ data: FixtureRecordDetail }> => {
    const { id } = request.params;
    const detail = await readInProgram(deps, callerOf(request).tenantId, async (tx) => {
      const record = await getRecord(tx, id);
      const versions = await everyRow((paging) => listVersions(tx, id, paging));
      const attachments = await everyRow((paging) => listAttachments(tx, id, paging));
      return recordDetail(record, versions, attachments);
    });
    return { data: detail };
  });

  instance.get<{ Params: RecordParams }>(VERSIONS_PATH, RECORD_OPTIONS, async (request): Promise<{ data: FixtureVersion[] }> => {
    const { id } = request.params;
    const versions = await readInProgram(deps, callerOf(request).tenantId, (tx) => everyRow((paging) => listVersions(tx, id, paging)));
    return { data: versions.map(versionRow) };
  });

  instance.post<{ Params: TransitionParams }>(TRANSITION_PATH, TRANSITION_OPTIONS, async (request): Promise<{ data: FixtureRecord }> => {
    const { tenantId, actor, roles } = callerOf(request);
    const { id, action } = request.params;
    const record = await writeInProgram(deps, tenantId, async (tx) => {
      // finance.cfc checks the record exists before it validates an edit's fields, and both before the lifecycle decides.
      await getRecord(tx, id);
      const input = action === 'edit' ? editInput(request.body) : undefined;
      const { record: written, version } = await transitionRecord(tx, deps, { id, action, roles, input }, actor);
      // The fixture rebuilds the program rollup in the transition's transaction, stamped with the transition's time.
      await rebuildRollups(tx, deps, { now: version.created, ctx: { actorUserId: actor.userId } });
      return written;
    });
    return { data: recordRow(record) };
  });

  instance.get<{ Params: RecordParams }>(ATTACHMENTS_PATH, RECORD_OPTIONS, async (request): Promise<{ data: FixtureAttachment[] }> => {
    const { id } = request.params;
    const attachments = await readInProgram(deps, callerOf(request).tenantId, (tx) =>
      everyRow((paging) => listAttachments(tx, id, paging)),
    );
    return { data: attachments.map(attachmentRow) };
  });

  instance.post<{ Params: RecordParams }>(ATTACHMENTS_PATH, UPLOAD_OPTIONS, async (request): Promise<{ data: FixtureAttachment }> => {
    const { tenantId, actor } = callerOf(request);
    const { id } = request.params;
    const attachment = await writeInProgram(deps, tenantId, async (tx) => {
      // finance.cfc answers a missing record before a missing file.
      await getRecord(tx, id);
      const file = uploadedFile(request);
      return uploadAttachment(tx, deps, { recordId: id, fileName: file.filename, contentType: file.mimetype, bytes: file.data }, actor);
    });
    return { data: attachmentRow(attachment) };
  });

  instance.get<{ Params: AttachmentParams }>(
    DOWNLOAD_URL_PATH,
    DOWNLOAD_URL_OPTIONS,
    async (request): Promise<{ data: AttachmentDownloadUrl }> => {
      const { id, aid } = request.params;
      const attachment = await readInProgram(deps, callerOf(request).tenantId, (tx) => getAttachment(tx, id, aid));
      return { data: await signedDownloadUrl(deps, attachment) };
    },
  );

  instance.get(ROLLUPS_PATH, ROLLUP_OPTIONS, async (request): Promise<{ data: FixtureRollup[] }> => {
    // `asOf` is accepted as the contract declares it; stored rollups change only at record writes, so the read takes no date.
    const page = await readInProgram(deps, callerOf(request).tenantId, (tx) => getRollups(tx));
    return { data: page.rows.map(rollupRow) };
  });
};

/** Registers `financeV1Plugin` without `fastify-plugin`, so its error handler stays encapsulated to the `/v1/finance` routes. */
export async function registerV1Routes(app: FastifyInstance, deps: FinanceV1Deps): Promise<void> {
  await app.register(financeV1Plugin, deps);
}

