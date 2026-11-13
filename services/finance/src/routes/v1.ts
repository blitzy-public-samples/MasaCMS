// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/finance` routes of the OPT-2 finance screens, and the `/v2/finance` paged reads of record detail, versions, attachments and rollups. */
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
import {
  csrfPreHandler,
  multipartFilesOf,
  recordOutcomeReason,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
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
import { fixtureOutcomeReason } from '../legacy/envelope.js';
import {
  attachmentRow,
  recordDetail,
  recordDetailPage,
  recordRow,
  rollupRow,
  versionRow,
  type FixtureAttachment,
  type FixtureRecord,
  type FixtureRecordDetail,
  type FixtureRecordDetailPage,
  type FixtureRollup,
  type FixtureVersion,
} from '../legacy/serialize.js';
import type { Page, RecordPaging } from '../repo/queries.js';

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

/** Page of a `/v2` list; the schema defaults fill both. */
interface PageQuery {
  page: number;
  pageSize: number;
}

/** `listRollupsV2` query. */
interface RollupPageQuery extends PageQuery {
  asOf?: string;
}

const RECORDS_PATH = '/v1/finance/records';
const RECORD_PATH = `${RECORDS_PATH}/:id`;
const VERSIONS_PATH = `${RECORD_PATH}/versions`;
const TRANSITION_PATH = `${RECORD_PATH}/transitions/:action`;
const ATTACHMENTS_PATH = `${RECORD_PATH}/attachments`;
const DOWNLOAD_URL_PATH = `${ATTACHMENTS_PATH}/:aid/download-url`;
const ROLLUPS_PATH = '/v1/finance/rollups';
const V2_RECORD_PATH = '/v2/finance/records/:id';
const V2_VERSIONS_PATH = `${V2_RECORD_PATH}/versions`;
const V2_ATTACHMENTS_PATH = `${V2_RECORD_PATH}/attachments`;
const V2_ROLLUPS_PATH = '/v2/finance/rollups';

const READER_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.financePreparer, Roles.financeApprover]),
});

/** Exporters read the record list beside the preparers and approvers. */
const RECORD_LIST_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.financePreparer, Roles.financeApprover, Roles.reportingExporter]),
});

const PREPARER_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.financePreparer]),
});

// The fixture's paging defaults and bounds, envelope.cfc page().
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 1000;

/** Rows per query while a route reads every row: the largest page the fixture paging admits. */
const SCAN_PAGE_SIZE = MAX_PAGE_SIZE;

/** The page the `/v2` record detail embeds of its versions and of its attachments. */
const DETAIL_PAGING: RecordPaging = Object.freeze({ pageIndex: DEFAULT_PAGE, itemsPerPage: DEFAULT_PAGE_SIZE });

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

const PAGE_QUERY_PROPERTIES = {
  page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
  pageSize: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
} as const;

const PAGE_QUERY_SCHEMA = { type: 'object', properties: PAGE_QUERY_PROPERTIES } as const;

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

const V2_ROLLUP_QUERY_SCHEMA = { type: 'object', properties: { ...ROLLUP_QUERY_SCHEMA.properties, ...PAGE_QUERY_PROPERTIES } } as const;

const RECORD_LIST_OPTIONS = { config: { opt2: RECORD_LIST_AUTH }, schema: { querystring: RECORD_LIST_QUERY_SCHEMA } };
const RECORD_OPTIONS = { config: { opt2: READER_AUTH }, schema: { params: RECORD_PARAMS_SCHEMA } };
const RECORD_PAGE_OPTIONS = { config: { opt2: READER_AUTH }, schema: { params: RECORD_PARAMS_SCHEMA, querystring: PAGE_QUERY_SCHEMA } };
// As finance.cfc's writes do, identity consumes the write's token for the record id as sent before the record is read.
const RECORD_CSRF = csrfPreHandler({ contextOf: (request) => (request.params as RecordParams).id });
const TRANSITION_OPTIONS = { config: { opt2: READER_AUTH }, schema: { params: TRANSITION_PARAMS_SCHEMA }, preHandler: RECORD_CSRF };
const UPLOAD_OPTIONS = { config: { opt2: PREPARER_AUTH }, schema: { params: RECORD_PARAMS_SCHEMA }, preHandler: RECORD_CSRF };
const DOWNLOAD_URL_OPTIONS = { config: { opt2: READER_AUTH }, schema: { params: ATTACHMENT_PARAMS_SCHEMA } };
const ROLLUP_OPTIONS = { config: { opt2: READER_AUTH }, schema: { querystring: ROLLUP_QUERY_SCHEMA } };
const V2_ROLLUP_OPTIONS = { config: { opt2: READER_AUTH }, schema: { querystring: V2_ROLLUP_QUERY_SCHEMA } };

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

/** The repository paging of a list's `page` and `pageSize`. */
function pagingOf({ page, pageSize }: PageQuery): RecordPaging {
  return { pageIndex: page, itemsPerPage: pageSize };
}

/** A path id as the stored upper-case CF UUID it names, as SQL Server matches ids ignoring case; the params schema admits either case. */
function storedId(id: string): string {
  return id.toUpperCase();
}

/** One answered list page: its rows projected by `project`, with the count of all rows. */
function listAnswer<R, T>(page: Page<R>, project: (row: R) => T): { data: T[]; total: number } {
  return { data: page.rows.map(project), total: page.total };
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
    case V2_VERSIONS_PATH:
      return 'finance.records.versions';
    case TRANSITION_PATH:
      return `finance.records.${(request.params as TransitionParams).action}`;
    case ATTACHMENTS_PATH:
    case V2_ATTACHMENTS_PATH:
    case DOWNLOAD_URL_PATH:
      return 'finance.records.attachments';
    case ROLLUPS_PATH:
    case V2_ROLLUPS_PATH:
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

/**
 * The contract's `/v1/finance` and `/v2/finance` operations, with an error handler encapsulated to them that records each answered
 * error's fixed outcome reason; other errors reach service-kit's.
 */
export const financeV1Plugin: FastifyPluginAsync<FinanceV1Deps> = async (instance, deps) => {
  instance.setErrorHandler((error, request, reply) => {
    const response = errorResponse(error, () => envelopeMethod(request));
    if (response === undefined) throw error;
    recordOutcomeReason(request, fixtureOutcomeReason(error));
    return sendLegacyResponse(reply, response);
  });

  instance.get<{ Querystring: RecordListQuery }>(
    RECORDS_PATH,
    RECORD_LIST_OPTIONS,
    async (request): Promise<{ data: FixtureRecord[]; total: number }> => {
      const { state, period } = request.query;
      const page = await readInProgram(deps, callerOf(request).tenantId, (tx) =>
        listRecords(tx, pagingOf(request.query), { state, period }),
      );
      return listAnswer(page, recordRow);
    },
  );

  instance.get<{ Params: RecordParams }>(RECORD_PATH, RECORD_OPTIONS, async (request): Promise<{ data: FixtureRecordDetail }> => {
    const id = storedId(request.params.id);
    const detail = await readInProgram(deps, callerOf(request).tenantId, async (tx) => {
      const record = await getRecord(tx, id);
      const versions = await everyRow((paging) => listVersions(tx, id, paging));
      const attachments = await everyRow((paging) => listAttachments(tx, id, paging));
      return recordDetail(record, versions, attachments);
    });
    return { data: detail };
  });

  instance.get<{ Params: RecordParams }>(VERSIONS_PATH, RECORD_OPTIONS, async (request): Promise<{ data: FixtureVersion[] }> => {
    const id = storedId(request.params.id);
    const versions = await readInProgram(deps, callerOf(request).tenantId, (tx) => everyRow((paging) => listVersions(tx, id, paging)));
    return { data: versions.map(versionRow) };
  });

  instance.post<{ Params: TransitionParams }>(TRANSITION_PATH, TRANSITION_OPTIONS, async (request): Promise<{ data: FixtureRecord }> => {
    const { tenantId, actor, roles } = callerOf(request);
    const { action } = request.params;
    const id = storedId(request.params.id);
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
    const id = storedId(request.params.id);
    const attachments = await readInProgram(deps, callerOf(request).tenantId, (tx) =>
      everyRow((paging) => listAttachments(tx, id, paging)),
    );
    return { data: attachments.map(attachmentRow) };
  });

  instance.post<{ Params: RecordParams }>(ATTACHMENTS_PATH, UPLOAD_OPTIONS, async (request): Promise<{ data: FixtureAttachment }> => {
    const { tenantId, actor } = callerOf(request);
    const id = storedId(request.params.id);
    const attachment = await writeInProgram(deps, tenantId, async (tx) => {
      // finance.cfc answers a missing record before a missing file.
      await getRecord(tx, id);
      const { filename, mimetype, size, sha256, stream } = uploadedFile(request);
      return uploadAttachment(tx, deps, { recordId: id, fileName: filename, contentType: mimetype, size, sha256, body: stream }, actor);
    });
    return { data: attachmentRow(attachment) };
  });

  instance.get<{ Params: AttachmentParams }>(
    DOWNLOAD_URL_PATH,
    DOWNLOAD_URL_OPTIONS,
    async (request): Promise<{ data: AttachmentDownloadUrl }> => {
      const id = storedId(request.params.id);
      const aid = storedId(request.params.aid);
      const attachment = await readInProgram(deps, callerOf(request).tenantId, (tx) => getAttachment(tx, id, aid));
      return { data: await signedDownloadUrl(deps, attachment) };
    },
  );

  instance.get(ROLLUPS_PATH, ROLLUP_OPTIONS, async (request): Promise<{ data: FixtureRollup[] }> => {
    // `asOf` is accepted as the contract declares it; stored rollups change only at record writes, so the read takes no date.
    const rollups = await readInProgram(deps, callerOf(request).tenantId, (tx) => everyRow((paging) => getRollups(tx, { paging })));
    return { data: rollups.map(rollupRow) };
  });

  instance.get<{ Params: RecordParams }>(V2_RECORD_PATH, RECORD_OPTIONS, async (request): Promise<{ data: FixtureRecordDetailPage }> => {
    const id = storedId(request.params.id);
    const detail = await readInProgram(deps, callerOf(request).tenantId, async (tx) => {
      const record = await getRecord(tx, id);
      const versions = await listVersions(tx, id, DETAIL_PAGING);
      const attachments = await listAttachments(tx, id, DETAIL_PAGING);
      return recordDetailPage(record, versions, attachments);
    });
    return { data: detail };
  });

  instance.get<{ Params: RecordParams; Querystring: PageQuery }>(
    V2_VERSIONS_PATH,
    RECORD_PAGE_OPTIONS,
    async (request): Promise<{ data: FixtureVersion[]; total: number }> => {
      const id = storedId(request.params.id);
      const page = await readInProgram(deps, callerOf(request).tenantId, (tx) => listVersions(tx, id, pagingOf(request.query)));
      return listAnswer(page, versionRow);
    },
  );

  instance.get<{ Params: RecordParams; Querystring: PageQuery }>(
    V2_ATTACHMENTS_PATH,
    RECORD_PAGE_OPTIONS,
    async (request): Promise<{ data: FixtureAttachment[]; total: number }> => {
      const id = storedId(request.params.id);
      const page = await readInProgram(deps, callerOf(request).tenantId, (tx) => listAttachments(tx, id, pagingOf(request.query)));
      return listAnswer(page, attachmentRow);
    },
  );

  instance.get<{ Querystring: RollupPageQuery }>(
    V2_ROLLUPS_PATH,
    V2_ROLLUP_OPTIONS,
    async (request): Promise<{ data: FixtureRollup[]; total: number }> => {
      // `asOf` is accepted and unused, as on `/v1`.
      const page = await readInProgram(deps, callerOf(request).tenantId, (tx) => getRollups(tx, { paging: pagingOf(request.query) }));
      return listAnswer(page, rollupRow);
    },
  );
};

/** Registers `financeV1Plugin` without `fastify-plugin`, so its error handler stays encapsulated to its `/v1` and `/v2` finance routes. */
export async function registerV1Routes(app: FastifyInstance, deps: FinanceV1Deps): Promise<void> {
  await app.register(financeV1Plugin, deps);
}

