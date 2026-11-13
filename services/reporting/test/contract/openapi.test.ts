// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Every reporting route against contracts/openapi.yaml: registered declarations, and the actual responses and task bodies of buildApp through app.inject. */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectRouteMatrix, type RouteMatrixEntry } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { QUEUES, taskWireBody, type TaskWireBody } from '@opt2/platform/tasks';
import {
  ROLE_SET,
  TENANT_A,
  assertResponseMatchesOpenApi,
  findOperation,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { FIXTURE_PREFIX } from '../../src/legacy/index.js';
import { EXPORT_BUCKET, exportObjectKey, type ExportDefinitionRow, type ExportJobRow } from '../../src/repo/tables.js';
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
  type TestApp,
} from '../helpers/app.js';

type Json = Record<string, unknown>;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
const SITE_A = TENANT_A.siteId;
const ON_SITE_A = `siteid=${SITE_A}`;
const FIXTURE_EXPORTS = `${FIXTURE_PREFIX}/exports`;
const V1_EXPORTS = '/v1/reporting/exports';
const RUN_QUEUE = QUEUES['reporting-export-run'];
/** Headers the legacy envelope sends on every fixture JSON response. */
const LEGACY_HEADERS = ['generator', 'strict-transport-security', 'etag'] as const;

/** One contract operation with its OPT-2 annotations. */
interface ContractOperation {
  key: string;
  template: string;
  method: string;
  operation: Json;
}

let t: TestApp;
let definition: ExportDefinitionRow;
let financeDefinition: ExportDefinitionRow;
let done: ExportJobRow;
let queued: ExportJobRow;

const contractOperations: ContractOperation[] = Object.entries((OPENAPI as { paths: Record<string, Json> }).paths).flatMap(([template, item]) =>
  HTTP_METHODS.filter((method) => Object.hasOwn(item, method)).map((method) => ({
    key: `${method.toUpperCase()} ${template.replace(/\{(\w+)\}/g, ':$1')}`,
    template,
    method,
    operation: item[method] as Json,
  })),
);

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

/** CSRF headers identity accepts once for the collection context in the exporter's session. */
const csrf = (): Record<string, string> => ({ ...t.client.issueCsrf(identityOf(subject('reporting.exporter')).sid, '') });

async function migrationHeaders(): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'migration', audience: SERVICE, roles: ['platform.migration'] })}` };
}

async function tasksHeaders(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` };
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

describe('route registrations against the contract', () => {
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

  it('answers a job past queued with its unchanged state, reading nothing', async () => {
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
});

describe('export source scope', () => {
  /** The invocation credential of export source producer `caller`. */
  async function producerHeaders(caller: 'finance' | 'timesheets'): Promise<Record<string, string>> {
    return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: SERVICE })}` };
  }

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
  it.each<[string, number]>([
    ['pause', 200],
    ['resume', 200],
    ['ensure', 400],
  ])('answers %s of the export-run queue', async (op, status) => {
    expect((await send(await migrationHeaders(), 'POST', `/internal/v1/task-queues/${RUN_QUEUE.name}/${op}`)).statusCode).toBe(status);
  });

  it('answers a queue reporting does not create in the legacy error envelope', async () => {
    expect((await send(await migrationHeaders(), 'POST', '/internal/v1/task-queues/surveys-launch/pause')).statusCode).toBe(400);
  });
});

describe('migration routes', () => {
  it.each<[string, 'GET' | 'POST', () => string, Record<string, unknown> | undefined, number]>([
    ['the position', 'GET', () => '/internal/v1/migration/position', undefined, 200],
    ['the watermarks', 'GET', () => '/internal/v1/migration/watermark', undefined, 200],
    ['the gate status', 'POST', () => '/internal/v1/migration/gate', { op: 'status' }, 200],
    ['the changes', 'GET', () => `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}`, undefined, 200],
    ['the export_job export', 'GET', () => `/internal/v1/migration/export?unit=reporting.export_job&tenantId=${TENANT_A.tenantId}`, undefined, 200],
    ['an empty apply', 'POST', () => '/internal/v1/migration/apply', {}, 400],
    ['an empty watermark', 'POST', () => '/internal/v1/migration/watermark', {}, 400],
    ['a foreign unit gate', 'POST', () => '/internal/v1/migration/gate', { op: 'status', units: ['people.person'] }, 400],
  ])('answers %s', async (_label, method, url, payload, status) => {
    const res = await send(await migrationHeaders(), method, url(), payload === undefined ? {} : { payload });
    expect(res.statusCode).toBe(status);
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

describe('platform routes', () => {
  it('answers the health probe', async () => {
    expect((await send({}, 'GET', '/healthz')).statusCode).toBe(200);
  });
});
