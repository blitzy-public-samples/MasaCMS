// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Every reporting route against contracts/openapi.yaml: the pinned document, registered declarations, and the actual responses and task bodies of buildApp through app.inject. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, collectRouteMatrix, type RouteMatrixEntry } from '@opt2/platform/auth';
import { pushPath } from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { MIGRATION_PATH_PREFIX } from '@opt2/platform/migration-kit';
import { OUTBOX_SWEEP_PATH, QUEUES, QUEUE_CONTROL_PREFIX, taskWireBody, type TaskWireBody } from '@opt2/platform/tasks';
import {
  ROLE_SET,
  TENANT_A,
  assertResponseMatchesOpenApi,
  findOperation,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushTo,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { FIXTURE_PREFIX } from '../../src/legacy/index.js';
import { EXPORT_BUCKET, exportObjectKey, type ExportDefinitionRow, type ExportJobRow, type ReportingUnit } from '../../src/repo/tables.js';
import {
  OPENAPI,
  SERVICE,
  TEST_CLOCK,
  buildTestApp,
  headersFor,
  identityOf,
  queueRun,
  scopeUrl,
  seedDefinition,
  seedJob,
  siteChangedEnvelope,
  type TestApp,
} from '../helpers/app.js';

type Json = Record<string, unknown>;

/** The contract document's top-level fields this suite reads. */
interface ContractDocument {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  paths: Record<string, Json>;
}

const CONTRACT = OPENAPI as ContractDocument;
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const;
const SITE_A = TENANT_A.siteId;
const ON_SITE_A = `siteid=${SITE_A}`;
const FIXTURE_EXPORTS = `${FIXTURE_PREFIX}/exports`;
const V1_EXPORTS = '/v1/reporting/exports';
const RUN_QUEUE = QUEUES['reporting-export-run'];
const SITE_CHANGED_PATH = pushPath(SITE_CHANGED_SUBSCRIPTION);
const JOB_UNIT: ReportingUnit = 'reporting.export_job';
const WRITE_POSITION = /^reporting=\d+$/;
/** Headers the legacy envelope sends on every fixture JSON response. */
const LEGACY_HEADERS = ['generator', 'strict-transport-security', 'etag'] as const;

/** One contract operation with its OPT-2 annotations. */
interface ContractOperation {
  key: string;
  template: string;
  method: string;
  operation: Json;
}

/** A request one case sent, with the response it received. */
interface CaseResult {
  method: string;
  url: string;
  res: InjectResponse;
}

/** `METHOD path` with contract `{name}` parameters in Fastify `:name` form, as the route matrix lists routes. */
function keyOf(method: string, template: string): string {
  return `${method.toUpperCase()} ${template.replace(/\{(\w+)\}/g, ':$1')}`;
}

let t: TestApp;
let definition: ExportDefinitionRow;
let financeDefinition: ExportDefinitionRow;
let done: ExportJobRow;
let queued: ExportJobRow;

const contractOperations: ContractOperation[] = Object.entries(CONTRACT.paths).flatMap(([template, item]) =>
  HTTP_METHODS.filter((method) => Object.hasOwn(item, method)).map((method) => ({
    key: keyOf(method, template),
    template,
    method,
    operation: item[method] as Json,
  })),
);

const OPERATION_IDS = contractOperations.map(({ operation }) => operation.operationId);

function subject(name: string): RoleSubject {
  const found = ROLE_SET.find((candidate) => candidate.name === name);
  if (found === undefined) throw new TypeError(`ROLE_SET has no subject ${name}`);
  return found;
}

/** A JSON pointer node of the contract, following `$ref`s. */
function resolve(node: unknown): Json {
  let current = node as Json;
  while (typeof current.$ref === 'string') {
    current = current.$ref
      .slice(2)
      .split('/')
      .reduce<unknown>((parent, segment) => (parent as Json)[segment.replace(/~1/g, '/').replace(/~0/g, '~')], OPENAPI) as Json;
  }
  return current;
}

const valueDocs = new Map<unknown, object>();

/** Validates `value` against `schema`, a schema object of the contract, through the platform's OpenAPI validator. */
function assertMatchesSchema(schema: unknown, value: unknown, label: string): void {
  let doc = valueDocs.get(schema);
  if (doc === undefined) {
    const media = { 'application/json': { schema } };
    doc = { ...(OPENAPI as Json), paths: { [`/${label}`]: { post: { responses: { 200: { description: label, content: media } } } } } };
    valueDocs.set(schema, doc);
  }
  const path = Object.keys((doc as { paths: Json }).paths)[0] ?? '';
  // Serialized, so a string value is validated as itself rather than parsed as JSON text.
  assertResponseMatchesOpenApi(doc, { method: 'POST', path, status: 200, contentType: 'application/json', body: JSON.stringify(value) });
}

/** Validates the status, content and declared headers of `res` against the operation serving `method` `url`, and returns `res`. */
function checked(method: string, url: string, res: InjectResponse): InjectResponse {
  const path = url.split('?')[0] ?? url;
  assertResponseMatchesOpenApi(OPENAPI, { method, path, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  const { operation } = findOperation(OPENAPI, method, path);
  const responses = operation.responses as Json;
  const declared = resolve(responses[String(res.statusCode)]);
  for (const [name, header] of Object.entries((declared.headers ?? {}) as Json)) {
    const value = res.headers[name.toLowerCase()];
    if (value !== undefined) assertMatchesSchema(resolve(header).schema, String(value), `header-${name}`);
  }
  return res;
}

async function send(
  who: string | Record<string, string>,
  method: 'GET' | 'POST',
  url: string,
  options: { payload?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Promise<InjectResponse> {
  const credentials = typeof who === 'string' ? await headersFor(subject(who), SITE_A) : who;
  const res = await t.app.inject({ method, url, headers: { ...options.headers, ...credentials }, ...(options.payload === undefined ? {} : { payload: options.payload }) });
  return checked(method, url, res);
}

/** {@link send}, keeping the request beside its response. */
async function call(
  who: string | Record<string, string>,
  method: 'GET' | 'POST',
  url: string,
  options: { payload?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Promise<CaseResult> {
  return { method, url, res: await send(who, method, url, options) };
}

/** Whether the operation serving `method` `url` declares the write-position header on `status`. */
function declaresWritePosition(method: string, url: string, status: number): boolean {
  const { operation } = findOperation(OPENAPI, method, url.split('?')[0] ?? url);
  const declared = resolve((operation.responses as Json)[String(status)]);
  return Object.hasOwn((declared.headers ?? {}) as Json, 'X-Opt2-Write-Position');
}

/** CSRF headers identity accepts once for the collection context in the exporter's session. */
const csrf = (): Record<string, string> => ({ ...t.client.issueCsrf(identityOf(subject('reporting.exporter')).sid, '') });

async function migrationHeaders(): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'migration', audience: SERVICE, roles: ['platform.migration'] })}` };
}

async function operatorHeaders(): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'operator', audience: SERVICE, roles: ['platform.operator'] })}` };
}

async function tasksHeaders(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` };
}

/** The invocation credential of export source producer `caller`. */
async function producerHeaders(caller: 'finance' | 'timesheets'): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: SERVICE })}` };
}

/** `wire` as an earlier release queued it: the creating session and `who`'s user token of it, here already expired, beside the job. */
async function priorFormOf(wire: TaskWireBody, who: RoleSubject): Promise<TaskWireBody> {
  const { jobId, asOf } = wire.payload as { jobId: string; asOf: string };
  const { sub, sid } = identityOf(who);
  const exp = Math.floor(TEST_CLOCK.now().getTime() / 1000) - 60;
  const userToken = await mintUserToken({ sub, sid, site: SITE_A, roles: who.roles, iat: exp - 300, exp });
  return { ...wire, payload: { jobId, asOf, sessionId: sid, userToken } };
}

/** The service calls since call `before`, each with the user token it carries. */
function callTrail(before: number): string[] {
  return t.client.requests.slice(before).map((call) => `${call.service} ${call.path} with ${call.userToken === null ? 'no user token' : String(call.userToken)}`);
}

const runUrl = (jobId: string): string => RUN_QUEUE.targetPath.replace('{exportId}', jobId);

beforeAll(async () => {
  t = await buildTestApp();
  definition = seedDefinition(t.db, SITE_A);
  financeDefinition = seedDefinition(t.db, SITE_A, 'finance.records');
  done = await seedJob(t, definition, 'done');
  queued = await seedJob(t, definition, 'queued');
  await t.tasks.create({
    queue: RUN_QUEUE.name,
    name: `${RUN_QUEUE.name}-${queued.job_id}`,
    scheduleTime: queued.created,
    url: `http://127.0.0.1:8116${runUrl(queued.job_id)}`,
    deadlineS: RUN_QUEUE.deadlineS,
    tenantId: queued.tenant_id,
  });
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.client.reset();
});

describe('contract document', () => {
  it('is OpenAPI 3.1.0 version 1.0.0 at the pinned source SHA', () => {
    expect({ openapi: CONTRACT.openapi, version: CONTRACT.info.version, sha: CONTRACT.info['x-source-sha'] }).toEqual({
      openapi: '3.1.0',
      version: '1.0.0',
      sha: PIN.sha,
    });
  });

  it('gives every operation a unique operationId', () => {
    const invalid = OPERATION_IDS.filter((id, index) => typeof id !== 'string' || id === '' || OPERATION_IDS.indexOf(id) !== index);
    expect(invalid).toEqual([]);
  });
});

describe('route registrations against the contract', () => {
  /** Every reporting route family, each of which the app registers and the contract declares. */
  const FAMILIES = [
    keyOf('GET', FIXTURE_EXPORTS),
    keyOf('POST', FIXTURE_EXPORTS),
    keyOf('GET', `${FIXTURE_EXPORTS}/{id}`),
    keyOf('GET', `${FIXTURE_EXPORTS}/{id}/download`),
    keyOf('GET', V1_EXPORTS),
    keyOf('POST', V1_EXPORTS),
    keyOf('GET', `${V1_EXPORTS}/{id}`),
    keyOf('GET', `${V1_EXPORTS}/{id}/download-url`),
    keyOf('GET', `/opt2/files/${EXPORT_BUCKET}/{tenantId}/{objectName}`),
    keyOf('GET', '/internal/v1/exports/{exportId}/source-scope'),
    keyOf('POST', RUN_QUEUE.targetPath),
    ...['pause', 'resume', 'ensure'].map((op) => keyOf('POST', `${QUEUE_CONTROL_PREFIX}/{queue}/${op}`)),
    keyOf('POST', SITE_CHANGED_PATH),
    ...(
      [
        ['POST', 'apply'],
        ['GET', 'export'],
        ['GET', 'changes'],
        ['GET', 'position'],
        ['GET', 'watermark'],
        ['POST', 'watermark'],
        ['POST', 'gate'],
      ] as const
    ).map(([method, name]) => keyOf(method, `${MIGRATION_PATH_PREFIX}/${name}`)),
    keyOf('GET', '/healthz'),
  ];

  it('registers and declares every reporting route family, and no outbox sweep', () => {
    const registered = collectRouteMatrix(t.app).routes.map((route) => `${route.method} ${route.url}`);
    const declaredKeys = contractOperations.map((op) => op.key);
    expect(SITE_CHANGED_PATH).toBe('/internal/v1/events/reporting.programs-sites.site.changed.v1');
    expect({ unregistered: FAMILIES.filter((key) => !registered.includes(key)), undeclared: FAMILIES.filter((key) => !declaredKeys.includes(key)) }).toEqual({
      unregistered: [],
      undeclared: [],
    });
    expect([...registered, ...declaredKeys].filter((key) => key.endsWith(` ${OUTBOX_SWEEP_PATH}`))).toEqual([]);
  });

  const comparable = (entry: RouteMatrixEntry): Json => ({
    transport: entry.transport,
    ...(entry.requires === undefined ? { public: true } : { requires: [...entry.requires].sort() }),
    siteCheck: entry.siteCheck,
  });
  const declared = (operation: Json): Json => ({
    transport: operation['x-opt2-transport'],
    ...(operation['x-opt2-public'] === true ? { public: true } : { requires: [...(operation['x-opt2-requires'] as string[])].sort() }),
    siteCheck: operation['x-opt2-site-check'] !== false,
  });

  it('registers exactly the operations the contract declares', () => {
    const registered = collectRouteMatrix(t.app).routes.map((route) => `${route.method} ${route.url}`).sort();
    expect(registered).toEqual(contractOperations.map((op) => op.key).sort());
  });

  it("declares every route's transport, roles, public flag and site check as its operation annotates them", () => {
    const routes = Object.fromEntries(collectRouteMatrix(t.app).routes.map((route) => [`${route.method} ${route.url}`, comparable(route)]));
    expect(routes).toEqual(Object.fromEntries(contractOperations.map((op) => [op.key, declared(op.operation)])));
  });
});

const DEFINITION_UNIT: ReportingUnit = 'reporting.export_definition';
const WATERMARK = { legacyTable: 'synthetic.export_job', direction: 'forward', snapshotSeq: 1, backupLsn: '1', finishedAt: '2026-06-30 12:00:00' } as const;

/** Status of each case that does not answer 200. */
const CASE_STATUS: Readonly<Record<string, number>> = {
  pushSiteChanged: 204,
  // Reporting creates no recurring queue, so ensure always answers the invalidParameters 400 its contract declares.
  ensureTaskQueue: 400,
};

/** One request per contract operation, keyed by operationId, presenting the credential of the operation's transport. */
const cases: Record<string, () => Promise<CaseResult>> = {
  fixtureListExports: () => call('reporting.exporter', 'GET', `${FIXTURE_EXPORTS}?${ON_SITE_A}`),
  fixtureCreateExport: () =>
    call('reporting.exporter', 'POST', `${FIXTURE_EXPORTS}?${ON_SITE_A}`, {
      headers: csrf(),
      payload: { definitionId: definition.definition_id, format: 'csv' },
    }),
  fixtureGetExport: () => call('reporting.exporter', 'GET', `${FIXTURE_EXPORTS}/${done.job_id}?${ON_SITE_A}`),
  fixtureDownloadExport: () => call('reporting.exporter', 'GET', `${FIXTURE_EXPORTS}/${done.job_id}/download?${ON_SITE_A}`),
  listExports: () => call('reporting.exporter', 'GET', `${V1_EXPORTS}?${ON_SITE_A}`),
  createExport: () =>
    call('reporting.exporter', 'POST', `${V1_EXPORTS}?${ON_SITE_A}`, {
      headers: csrf(),
      payload: { definitionId: definition.definition_id, format: 'xlsx' },
    }),
  getExport: () => call('reporting.exporter', 'GET', `${V1_EXPORTS}/${done.job_id}?${ON_SITE_A}`),
  getExportDownloadUrl: () => call('reporting.exporter', 'GET', `${V1_EXPORTS}/${done.job_id}/download-url?${ON_SITE_A}`),
  downloadExportObject: async () => {
    const issued = await send('reporting.exporter', 'GET', `${V1_EXPORTS}/${done.job_id}/download-url?${ON_SITE_A}`);
    const result = await call({}, 'GET', issued.json<{ data: { url: string } }>().data.url);
    expect(String(result.res.headers['content-type']).split(';')[0]).toBe(done.content_type);
    return result;
  },
  getExportSourceScope: async () => call(await producerHeaders('timesheets'), 'GET', scopeUrl(done.job_id, SITE_A)),
  runExportTask: async () => {
    const job = await seedJob(t, definition, 'queued');
    const wire = await queueRun(t, job);
    return call(await tasksHeaders(), 'POST', runUrl(job.job_id), { payload: { ...wire } });
  },
  pauseTaskQueue: async () => call(await operatorHeaders(), 'POST', `${QUEUE_CONTROL_PREFIX}/${RUN_QUEUE.name}/pause`),
  resumeTaskQueue: async () => call(await operatorHeaders(), 'POST', `${QUEUE_CONTROL_PREFIX}/${RUN_QUEUE.name}/resume`),
  ensureTaskQueue: async () => call(await operatorHeaders(), 'POST', `${QUEUE_CONTROL_PREFIX}/${RUN_QUEUE.name}/ensure`),
  pushSiteChanged: async () => {
    const res = await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope(SITE_A, 2));
    return { method: 'POST', url: SITE_CHANGED_PATH, res: checked('POST', SITE_CHANGED_PATH, res) };
  },
  migrationApply: async () => {
    const exported = await send(await migrationHeaders(), 'GET', `${MIGRATION_PATH_PREFIX}/export?unit=${DEFINITION_UNIT}&tenantId=${TENANT_A.tenantId}`);
    const [table] = exported.json<{ tables: { legacyTable: string; columns: unknown[]; rows: { row: string }[] }[] }>().tables;
    if (table === undefined || table.rows.length === 0) throw new Error(`the ${DEFINITION_UNIT} export of tenant-a holds no rows`);
    const batch = {
      batchId: 'reporting-contract-apply-1',
      origin: 'backfill',
      legacyTable: table.legacyTable,
      tenantId: TENANT_A.tenantId,
      columns: table.columns,
      rows: table.rows.map(({ row }) => ({ op: 'upsert', row })),
    };
    return call(await migrationHeaders(), 'POST', `${MIGRATION_PATH_PREFIX}/apply`, { payload: batch });
  },
  migrationExport: async () => call(await migrationHeaders(), 'GET', `${MIGRATION_PATH_PREFIX}/export?unit=${JOB_UNIT}&tenantId=${TENANT_A.tenantId}`),
  migrationChanges: async () => call(await migrationHeaders(), 'GET', `${MIGRATION_PATH_PREFIX}/changes?tenantId=${TENANT_A.tenantId}&after=0:0`),
  migrationPosition: async () => call(await migrationHeaders(), 'GET', `${MIGRATION_PATH_PREFIX}/position`),
  migrationWatermarkGet: async () => call(await migrationHeaders(), 'GET', `${MIGRATION_PATH_PREFIX}/watermark`),
  migrationWatermarkPost: async () => call(await migrationHeaders(), 'POST', `${MIGRATION_PATH_PREFIX}/watermark`, { payload: { ...WATERMARK } }),
  migrationGate: async () => call(await migrationHeaders(), 'POST', `${MIGRATION_PATH_PREFIX}/gate`, { payload: { op: 'status' } }),
  healthz: () => call({}, 'GET', '/healthz'),
};

describe('every contract operation', () => {
  it('has exactly one case per contract operation', () => {
    expect(Object.keys(cases).sort()).toEqual(OPERATION_IDS.map(String).sort());
  });

  it.each(OPERATION_IDS.map(String))('answers %s with its success status in its contract shape', async (operationId) => {
    const run = cases[operationId];
    if (run === undefined) throw new Error(`no case for ${operationId}`);
    const { method, url, res } = await run();
    expect(res.statusCode, res.body).toBe(CASE_STATUS[operationId] ?? 200);
    if (declaresWritePosition(method, url, res.statusCode)) expect(res.headers['x-opt2-write-position']).toMatch(WRITE_POSITION);
  });
});

describe('fixture routes', () => {
  it('answers a page of the site jobs with the legacy headers and body ETag', async () => {
    const res = await send('reporting.exporter', 'GET', `${FIXTURE_EXPORTS}?${ON_SITE_A}&itemsPerPage=1`);
    expect(res.statusCode).toBe(200);
    expect(LEGACY_HEADERS.filter((name) => res.headers[name] === undefined)).toEqual([]);
    expect(res.headers.etag).toBe(createHash('sha256').update(res.rawPayload).digest('hex').toUpperCase());
  });

  it.each<[string, string, number]>([
    ['invalid paging', `${FIXTURE_EXPORTS}?${ON_SITE_A}&pageIndex=0`, 400],
    ['an unknown site', `${FIXTURE_EXPORTS}?siteid=no-such-site`, 400],
    ['another site', `${FIXTURE_EXPORTS}?siteid=tenant-b`, 403],
  ])('answers a list with %s in the fixture error envelope', async (_label, url, status) => {
    expect((await send('reporting.exporter', 'GET', url)).statusCode).toBe(status);
  });

  it.each<[string, string, number]>([
    ['anonymous', 'anonymous', 401],
    ['a member', 'member', 403],
  ])('answers %s in the fixture error envelope', async (_label, name, status) => {
    expect((await send(name, 'GET', `${FIXTURE_EXPORTS}?${ON_SITE_A}`)).statusCode).toBe(status);
  });

  it('answers a create with the queued job and a write position', async () => {
    const res = await send('reporting.exporter', 'POST', `${FIXTURE_EXPORTS}?${ON_SITE_A}`, {
      headers: csrf(),
      payload: { definitionId: definition.definition_id, format: 'xlsx' },
    });
    expect({ status: res.statusCode, state: res.json<{ data: { state: string } }>().data.state }).toEqual({ status: 200, state: 'queued' });
    expect(res.headers['x-opt2-write-position']).toMatch(/^reporting=\d+$/);
  });

  it.each<[string, () => Record<string, string>, () => Record<string, unknown>, number]>([
    ['without a CSRF token', () => ({}), () => ({ definitionId: definition.definition_id, format: 'csv' }), 400],
    ['of an unknown format', csrf, () => ({ definitionId: definition.definition_id, format: 'docx' }), 400],
    ['of an unknown definition', csrf, () => ({ definitionId: cfUuid(), format: 'csv' }), 404],
  ])('answers a create %s in the fixture error envelope', async (_label, headers, payload, status) => {
    const res = await send('reporting.exporter', 'POST', `${FIXTURE_EXPORTS}?${ON_SITE_A}`, { headers: headers(), payload: payload() });
    expect(res.statusCode).toBe(status);
  });

  it.each<[string, () => string, number]>([
    ['a job', () => done.job_id, 200],
    ['an unknown job', () => cfUuid(), 404],
  ])('answers a read of %s', async (_label, id, status) => {
    expect((await send('reporting.exporter', 'GET', `${FIXTURE_EXPORTS}/${id()}?${ON_SITE_A}`)).statusCode).toBe(status);
  });

  it('answers a done job download with its bytes as an attachment', async () => {
    const res = await send('reporting.exporter', 'GET', `${FIXTURE_EXPORTS}/${done.job_id}/download?${ON_SITE_A}`);
    expect({ status: res.statusCode, disposition: res.headers['content-disposition'], sha: createHash('sha256').update(res.rawPayload).digest('hex') }).toEqual({
      status: 200,
      disposition: `attachment; filename="${done.file_name}"`,
      sha: done.output_sha256,
    });
  });

  it.each<[string, () => string, number]>([
    ['a queued job', () => queued.job_id, 409],
    ['an unknown job', () => cfUuid(), 404],
  ])('answers a download of %s in the fixture error envelope', async (_label, id, status) => {
    expect((await send('reporting.exporter', 'GET', `${FIXTURE_EXPORTS}/${id()}/download?${ON_SITE_A}`)).statusCode).toBe(status);
  });
});

describe('/v1 routes', () => {
  it('answers the job list and its total', async () => {
    const res = await send('reporting.exporter', 'GET', `${V1_EXPORTS}?${ON_SITE_A}&page=1&pageSize=2`);
    const body = res.json<{ data: unknown[]; total: number }>();
    expect({ status: res.statusCode, page: body.data.length, totalCovers: body.total >= 2 }).toEqual({ status: 200, page: 2, totalCovers: true });
  });

  it.each<[string, string, string, number]>([
    ['invalid paging', 'reporting.exporter', `${V1_EXPORTS}?${ON_SITE_A}&page=0`, 400],
    ['another site', 'reporting.exporter', `${V1_EXPORTS}?siteid=tenant-b`, 403],
    ['anonymous', 'anonymous', `${V1_EXPORTS}?${ON_SITE_A}`, 401],
    ['a member', 'member', `${V1_EXPORTS}?${ON_SITE_A}`, 403],
  ])('answers a list with %s in the legacy error envelope', async (_label, name, url, status) => {
    expect((await send(name, 'GET', url)).statusCode).toBe(status);
  });

  it('answers a create with the queued job and a write position', async () => {
    const res = await send('reporting.exporter', 'POST', `${V1_EXPORTS}?${ON_SITE_A}`, {
      headers: csrf(),
      payload: { definitionId: definition.definition_id, format: 'pdf', params: { asOf: '2026-06-01' } },
    });
    expect({ status: res.statusCode, state: res.json<{ data: { state: string } }>().data.state }).toEqual({ status: 200, state: 'queued' });
    expect(res.headers['x-opt2-write-position']).toMatch(/^reporting=\d+$/);
  });

  it.each<[string, () => Record<string, string>, () => Record<string, unknown>, number]>([
    ['without a CSRF token', () => ({}), () => ({ definitionId: definition.definition_id, format: 'csv' }), 400],
    ['of an unknown format', csrf, () => ({ definitionId: definition.definition_id, format: 'docx' }), 400],
    ['of an unknown definition', csrf, () => ({ definitionId: cfUuid(), format: 'csv' }), 404],
  ])('answers a create %s in the legacy error envelope', async (_label, headers, payload, status) => {
    const res = await send('reporting.exporter', 'POST', `${V1_EXPORTS}?${ON_SITE_A}`, { headers: headers(), payload: payload() });
    expect(res.statusCode).toBe(status);
  });

  it.each<[string, () => string, number]>([
    ['a job', () => done.job_id, 200],
    ['an unknown job', () => cfUuid(), 404],
  ])('answers a read of %s', async (_label, id, status) => {
    expect((await send('reporting.exporter', 'GET', `${V1_EXPORTS}/${id()}?${ON_SITE_A}`)).statusCode).toBe(status);
  });

  it.each<[string, () => string, number]>([
    ['a done job', () => done.job_id, 200],
    ['a queued job', () => queued.job_id, 409],
    ['an unknown job', () => cfUuid(), 404],
  ])('answers a download URL of %s', async (_label, id, status) => {
    expect((await send('reporting.exporter', 'GET', `${V1_EXPORTS}/${id()}/download-url?${ON_SITE_A}`)).statusCode).toBe(status);
  });
});

describe('export file route', () => {
  it('serves the bytes a /v1 download URL signs, under the signed disposition', async () => {
    const issued = await send('reporting.exporter', 'GET', `${V1_EXPORTS}/${done.job_id}/download-url?${ON_SITE_A}`);
    const { url } = issued.json<{ data: { url: string } }>().data;
    const res = await send({}, 'GET', url);
    expect({ status: res.statusCode, sha: createHash('sha256').update(res.rawPayload).digest('hex'), disposition: res.headers['content-disposition'] }).toEqual({
      status: 200,
      sha: done.output_sha256,
      disposition: `attachment; filename="${done.file_name}"`,
    });
  });

  it.each<[string, () => Promise<string>, number]>([
    ['a tampered signature', async () => (await t.storage.signedUrl(EXPORT_BUCKET, done.object_key ?? '')).replace(/sig=[0-9a-f]{64}/, `sig=${'0'.repeat(64)}`), 403],
    ['no stored object', async () => t.storage.signedUrl(EXPORT_BUCKET, exportObjectKey(TENANT_A.tenantId, cfUuid(), 'csv')), 404],
  ])('answers a URL with %s in the legacy error envelope', async (_label, url, status) => {
    expect((await send({}, 'GET', await url())).statusCode).toBe(status);
  });
});

describe('export run task', () => {
  it.each<[string, (wire: TaskWireBody) => Promise<TaskWireBody>]>([
    ["that task's own wire body", (wire) => Promise.resolve(wire)],
    ['its wire body in the prior form, carrying an expired requester token', (wire) => priorFormOf(wire, subject('reporting.exporter'))],
  ])('runs the task a /v1 create queued, from %s, to done as System, reading its source with no user token', async (_label, form) => {
    const created = await send('reporting.exporter', 'POST', `${V1_EXPORTS}?${ON_SITE_A}`, {
      headers: csrf(),
      payload: { definitionId: definition.definition_id, format: 'csv' },
    });
    const { job_id: jobId } = created.json<{ data: { job_id: string } }>().data;
    const task = t.tasks.live.get(`${RUN_QUEUE.name}/${RUN_QUEUE.name}-${jobId}`);
    if (task === undefined) throw new Error(`the create queued no run task for ${jobId}`);
    const wire = await form(taskWireBody(task));
    const { operation } = findOperation(OPENAPI, 'POST', runUrl(jobId));
    const requestBody = resolve(operation.requestBody);
    assertMatchesSchema(resolve((requestBody.content as Json)['application/json']).schema, wire, 'run-task-body');
    expect(new URL(task.url).pathname).toBe(runUrl(jobId));

    const before = t.client.requests.length;
    const res = await send(await tasksHeaders(), 'POST', runUrl(jobId), { payload: wire as unknown as Record<string, unknown> });
    expect({ status: res.statusCode, body: res.json<unknown>() }).toEqual({ status: 200, body: { jobId, state: 'done' } });
    expect(callTrail(before)).toEqual(['timesheets /internal/v1/timesheets/sheet-status with no user token']);
    expect(res.headers['x-opt2-write-position']).toMatch(/^reporting=\d+$/);
    const job = await send('reporting.exporter', 'GET', `${V1_EXPORTS}/${jobId}?${ON_SITE_A}`);
    expect(job.json<{ data: { state: string } }>().data.state).toBe('done');
  });

  it('answers a done job with its unchanged state, reading nothing', async () => {
    const wire = await queueRun(t, done);
    const before = t.client.requests.length;
    const res = await send(await tasksHeaders(), 'POST', runUrl(done.job_id), { payload: { ...wire } });
    expect({ body: res.json<unknown>(), calls: callTrail(before) }).toEqual({ body: { jobId: done.job_id, state: 'done' }, calls: [] });
  });

  it('answers the failed state when the source producer is unavailable', async () => {
    const job = await seedJob(t, financeDefinition, 'queued');
    const wire = await queueRun(t, job);
    t.client.answer('finance', '/internal/v1/finance/records', () => ({ status: 503, headers: {}, body: undefined }));
    const before = t.client.requests.length;
    const res = await send(await tasksHeaders(), 'POST', runUrl(job.job_id), { payload: { ...wire } });
    expect({ body: res.json<unknown>(), calls: callTrail(before) }).toEqual({
      body: { jobId: job.job_id, state: 'failed' },
      calls: ['finance /internal/v1/finance/records with no user token'],
    });
  });

  it.each<[string, () => Promise<Record<string, unknown>>]>([
    ['a malformed body', () => Promise.resolve({ queue: RUN_QUEUE.name })],
    ['another tenant', async () => ({ ...(await queueRun(t, done)), tenantId: '13ab03ed-8b4b-5174-b787-d32a11dd8793' })],
  ])('answers a task with %s in the legacy error envelope', async (_label, payload) => {
    expect((await send(await tasksHeaders(), 'POST', runUrl(done.job_id), { payload: await payload() })).statusCode).toBe(400);
  });

  it('refuses a run presented with a user token instead of the tasks credential, leaving the job queued', async () => {
    const job = await seedJob(t, definition, 'queued');
    const wire = await queueRun(t, job);
    const res = await send('reporting.exporter', 'POST', runUrl(job.job_id), { payload: { ...wire } });
    expect([401, 403]).toContain(res.statusCode);
    const stored = await send('reporting.exporter', 'GET', `${V1_EXPORTS}/${job.job_id}?${ON_SITE_A}`);
    expect(stored.json<{ data: { state: string } }>().data.state).toBe('queued');
  });
});

describe('unit gates', () => {
  it.each<[string, string]>([
    ['fixture', FIXTURE_EXPORTS],
    ['/v1', V1_EXPORTS],
  ])('answers a %s create with the legacy 503 while the job unit is legacy-authoritative', async (_label, collection) => {
    await t.setGate(JOB_UNIT, 'legacy');
    try {
      const res = await send('reporting.exporter', 'POST', `${collection}?${ON_SITE_A}`, {
        headers: csrf(),
        payload: { definitionId: definition.definition_id, format: 'csv' },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await t.setGate(JOB_UNIT, 'open');
    }
  });
});

describe('export source scope', () => {
  it("answers the timesheets producer a timesheets job's stored scope", async () => {
    const res = await send(await producerHeaders('timesheets'), 'GET', scopeUrl(done.job_id, SITE_A));
    expect({ status: res.statusCode, body: res.json<unknown>() }).toEqual({
      status: 200,
      body: { exportId: done.job_id, tenantId: TENANT_A.tenantId, siteId: SITE_A, source: 'timesheets.sheets', state: 'done', claim: done.row_version },
    });
  });

  it.each<[string, 'finance' | 'timesheets', () => string, string]>([
    ["another producer's job", 'finance', () => done.job_id, SITE_A],
    ['an unknown job', 'timesheets', () => cfUuid(), SITE_A],
    ["a job's id under another site", 'timesheets', () => done.job_id, 'tenant-b'],
    ['an unregistered site', 'timesheets', () => done.job_id, 'no-such-site'],
  ])('answers %s with the legacy 404', async (_label, caller, id, site) => {
    expect((await send(await producerHeaders(caller), 'GET', scopeUrl(id(), site))).statusCode).toBe(404);
  });

  it('answers a malformed export id in the legacy error envelope', async () => {
    expect((await send(await producerHeaders('timesheets'), 'GET', scopeUrl('job-1', SITE_A))).statusCode).toBe(400);
  });

  it.each<[string, string, number]>([
    ['an exporter', 'reporting.exporter', 403],
    ['anonymous', 'anonymous', 401],
  ])('refuses %s in the legacy error envelope', async (_label, name, status) => {
    expect((await send(name, 'GET', scopeUrl(done.job_id, SITE_A))).statusCode).toBe(status);
  });
});

describe('queue control', () => {
  it('answers a queue reporting does not create in the legacy error envelope', async () => {
    expect((await send(await migrationHeaders(), 'POST', `${QUEUE_CONTROL_PREFIX}/surveys-launch/pause`)).statusCode).toBe(400);
  });
});

describe('migration routes', () => {
  it.each<[string, string, Record<string, unknown>]>([
    ['an empty apply', 'apply', {}],
    ['an empty watermark', 'watermark', {}],
    ['a foreign unit gate', 'gate', { op: 'status', units: ['people.person'] }],
  ])('answers %s in the legacy error envelope', async (_label, name, payload) => {
    const res = await send(await migrationHeaders(), 'POST', `${MIGRATION_PATH_PREFIX}/${name}`, { payload });
    expect(res.statusCode).toBe(400);
  });

  it('exports the stored output of a done job in the object manifest', async () => {
    const res = await send(await migrationHeaders(), 'GET', `/internal/v1/migration/export?unit=reporting.export_job&tenantId=${TENANT_A.tenantId}`);
    expect(res.json<{ objects?: unknown[] }>().objects).toContainEqual(
      expect.objectContaining({ key: done.object_key, sha256: done.output_sha256, legacyPath: `synthetic.export_job/${done.job_id}` }),
    );
  });

  it('lists a create among the tenant changes with its legacy projection', async () => {
    await send('reporting.exporter', 'POST', `${V1_EXPORTS}?${ON_SITE_A}`, { headers: csrf(), payload: { definitionId: definition.definition_id, format: 'csv' } });
    const res = await send(await migrationHeaders(), 'GET', `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}`);
    const rows = res.json<{ rows: Array<{ table: string; op: string }> }>().rows;
    expect(rows).toContainEqual(expect.objectContaining({ table: 'export_job', op: 'insert' }));
  });
});
