// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Provider contract of finance: the app and contracts/openapi.yaml agree on metadata, routes, declarations and every response shape. */
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix, type RouteMatrixEntry } from '@opt2/platform/auth';
import { SITE_CHANGED_TOPIC, type SiteChangedPayload } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TEST_PUSH_KEY,
  assertResponseMatchesOpenApi,
  findOperation,
  mintServiceToken,
  pushTo,
  testEnvelope,
  type InjectResponse,
  type OpenApiOperation,
  type PushTarget,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { ATTACHMENT_BUCKET, UNITS, type FinanceAttachmentRow, type FinanceRecordRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { attachmentRow, programBindingRow, recordRow, versionRow } from '../helpers/records.js';

interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  paths: Record<string, Record<string, unknown>>;
}

interface ContractOperation {
  key: string;
  operation: OpenApiOperation;
}

/** The seeded tenant-a record, its stored attachment row and the attachment's bytes. */
interface Seeded {
  record: FinanceRecordRow;
  attachment: FinanceAttachmentRow;
  bytes: Buffer;
}

type Ctx = TestApp & { seeded: Seeded };

type HttpMethod = 'GET' | 'POST';

interface CaseResult {
  method: HttpMethod;
  url: string;
  response: InjectResponse;
}

interface RequestOptions {
  headers?: Record<string, string>;
  payload?: string | Buffer | Record<string, unknown>;
}

const DOC = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;
const TRANSPORTS: readonly unknown[] = ['service', 'pubsub-push', 'cloud-tasks'];
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const WRITE_POSITION = /^finance=\d+$/;
const WRITE_POSITION_HEADER = 'X-Opt2-Write-Position';

const FX = '/legacy-fixtures/cfml/api.cfm/finance';
const V1 = '/v1/finance';
const V2 = '/v2/finance';
const MIGRATION = '/internal/v1/migration';
const PUSH_PATH = `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`;
const SITE = TENANT_A.siteId;
const TENANT = TENANT_A.tenantId;
const PREPARER = Roles.financePreparer;
const APPROVER = Roles.financeApprover;
const ACTOR = 'F1A2B3C4-0000-4000-8000000000000001';
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const EXPORT_ID = 'E0A1B2C3-0000-4000-8000000000000001';
const EXPORT_CLAIM = '2';
const BUSINESS_DATE = '2026-06-30';
const BOUNDARY = 'opt2financecontract';
const ATTACHMENT = { fileName: 'receipt.pdf', contentType: 'application/pdf', bytes: '%PDF-1.4 finance contract attachment\n' } as const;
const UPLOAD = { fileName: 'invoice.txt', contentType: 'text/plain', bytes: 'finance contract upload\n' } as const;
const NEW_RECORD = { title: 'Contract record', amount: '12.5', period: '2026-06' } as const;
const WATERMARK = {
  legacyTable: 'Program_1.finance_record',
  direction: 'forward',
  snapshotSeq: 1,
  backupLsn: '1',
  finishedAt: '2026-06-30 12:00:00',
} as const;

const SITE_CHANGED: SiteChangedPayload = {
  siteId: SITE,
  publicUserPoolId: 'umbrella',
  privateUserPoolId: SITE,
  categoryPoolId: 'umbrella',
  filePoolId: 'umbrella',
  displayPoolId: 'umbrella',
  contentPoolIds: [SITE],
  domains: [`${SITE}.local`],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every operation of `doc`, keyed `METHOD template`. */
function contractOperations(doc: OpenApiDoc): ContractOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = item[method];
      return isRecord(operation) ? [{ key: `${method.toUpperCase()} ${path}`, operation: operation as OpenApiOperation }] : [];
    }),
  );
}

/** A Fastify route pattern in contract form, `:name` as `{name}`. */
function templateOf(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Registered routes without the HEAD mirrors Fastify exposes for GET routes the contract declares no HEAD for. */
function declaredRoutes(routes: readonly RouteMatrixEntry[], doc: OpenApiDoc): RouteMatrixEntry[] {
  const contractKeys = new Set(contractOperations(doc).map(({ key }) => key));
  return routes.filter(
    (route) =>
      !(
        route.method === 'HEAD' &&
        routes.some((other) => other.method === 'GET' && other.url === route.url) &&
        !contractKeys.has(`HEAD ${templateOf(route.url)}`)
      ),
  );
}

/** An auth declaration in comparable form: roles sorted, the public flag a boolean. */
function declaration(requires: unknown, isPublic: unknown, transport: unknown): Record<string, unknown> {
  return { requires: Array.isArray(requires) ? [...(requires as string[])].sort() : [], public: isPublic === true, transport };
}

/** Sorted `METHOD template` keys of the registered routes. */
function routeKeys(routes: readonly RouteMatrixEntry[], doc: OpenApiDoc): string[] {
  return declaredRoutes(routes, doc)
    .map((route) => `${route.method} ${templateOf(route.url)}`)
    .sort();
}

/** Sorted `METHOD template` keys of the contract operations. */
function operationKeys(doc: OpenApiDoc): string[] {
  return contractOperations(doc)
    .map(({ key }) => key)
    .sort();
}

/** The node a local `$ref` chain ends at. */
function resolved(node: unknown): unknown {
  let current = node;
  while (isRecord(current) && typeof current.$ref === 'string') {
    current = current.$ref
      .slice(2)
      .split('/')
      .reduce<unknown>((parent, segment) => (isRecord(parent) ? parent[segment] : undefined), DOC);
  }
  return current;
}

/** Whether the operation serving `method path` declares the write-position header on `status`. */
function declaresWritePosition(method: string, path: string, status: number): boolean {
  const { operation } = findOperation(DOC, method, path);
  const response = resolved(operation.responses?.[String(status)]);
  return isRecord(response) && isRecord(response.headers) && WRITE_POSITION_HEADER in response.headers;
}

/** Validates `response` against the operation of `method url`: JSON bodies parsed, others as text, a 204 as no content. */
function assertContract(method: string, url: string, response: InjectResponse): void {
  const path = url.split('?')[0] ?? url;
  if (response.statusCode === 204) {
    expect(response.body).toBe('');
    assertResponseMatchesOpenApi(DOC, { method, path, status: 204, contentType: undefined, body: undefined });
    return;
  }
  const contentType = response.headers['content-type'];
  const json = typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType);
  const body: unknown = json ? JSON.parse(response.payload) : response.body;
  assertResponseMatchesOpenApi(DOC, { method, path, status: response.statusCode, contentType, body });
}

/** User headers for tenant-a holding `role`, acting as {@link ACTOR}. */
function userHeaders(role: string): Promise<Record<string, string>> {
  return headersFor({ roles: [role] }, { site: SITE, sub: ACTOR });
}

/** `options` presenting a tenant-a user holding `role`. */
async function asUser(role: string, options: RequestOptions = {}): Promise<RequestOptions> {
  return { ...options, headers: { ...(await userHeaders(role)), ...options.headers } };
}

/** `options` presenting the invocation credential of service `caller`, addressed to finance. */
async function asService(caller: string, options: RequestOptions = {}): Promise<RequestOptions> {
  const token = await mintServiceToken({ caller, audience: 'finance' });
  return { ...options, headers: { [INVOCATION_HEADER]: `Bearer ${token}`, ...options.headers } };
}

/** A multipart/form-data body holding one `file` part. */
function multipart({ fileName, contentType, bytes }: { fileName: string; contentType: string; bytes: string }): RequestOptions {
  const disposition = `form-data; name="file"; filename="${fileName}"`;
  const body = `--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${contentType}\r\n\r\n${bytes}\r\n--${BOUNDARY}--\r\n`;
  return { headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, payload: Buffer.from(body) };
}

/** Injects one request into the app under test. */
async function send(ctx: TestApp, method: HttpMethod, url: string, { headers = {}, payload }: RequestOptions = {}): Promise<CaseResult> {
  const response = await ctx.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  return { method, url, response };
}

/** `<prefix>/records/<seeded record id><suffix>`. */
function recordUrl(ctx: Ctx, prefix: string, suffix = ''): string {
  return `${prefix}/records/${ctx.seeded.record.record_id}${suffix}`;
}

/** `url` scoped to tenant-a by the fixture's `siteid` parameter. */
function inSite(url: string): string {
  return `${url}?siteid=${SITE}`;
}

/** The parsed JSON body of a 200 answer. */
function jsonOf<T>(response: InjectResponse): T {
  expect(response.statusCode, response.body).toBe(200);
  return JSON.parse(response.payload) as T;
}

/** Path and query of the local signed URL `getAttachmentDownloadUrl` issues for the seeded attachment. */
async function signedAttachmentUrl(ctx: Ctx): Promise<string> {
  const url = recordUrl(ctx, V1, `/attachments/${ctx.seeded.attachment.attachment_id}/download-url`);
  const issued = await send(ctx, 'GET', url, await asUser(APPROVER));
  const { pathname, search } = new URL(jsonOf<{ data: { url: string } }>(issued.response).data.url, 'http://finance.test');
  return `${pathname}${search}`;
}

/** A push target that delivers pushTo's request without its push key, presenting `headers` instead. */
function keylessPushTarget(app: TestApp['app'], headers: Record<string, string>): PushTarget {
  const inject = (opts: { method: HttpMethod; url: string; payload: object }): Promise<InjectResponse> => {
    const url = opts.url.replace(`?key=${encodeURIComponent(TEST_PUSH_KEY)}`, '');
    expect(url).toBe(PUSH_PATH);
    return app.inject({ method: opts.method, url, headers, payload: opts.payload });
  };
  return { inject: inject as unknown as PushTarget['inject'] };
}

/** Seeds an IN-PROGRESS tenant-a record with its version, one stored attachment and its rollup row. */
async function seedFinance(t: TestApp): Promise<Seeded> {
  // recordRow's default creator is the legacy admin sentinel, which the contract's CfId pattern for createdbyid rejects.
  const record: FinanceRecordRow = { ...recordRow({ siteid: SITE }), createdbyid: ACTOR };
  const { row: attachment, bytes } = attachmentRow(record, ATTACHMENT);
  t.db.seed('record', [record]);
  t.db.seed('record_version', [versionRow(record, { action: 'create', version: 1 })]);
  t.db.seed('attachment', [attachment]);
  t.db.seed('rollup', [
    {
      tenant_id: record.tenant_id,
      period: record.period,
      state: record.state,
      record_count: 1,
      total_amount: record.amount,
      computed_at: TEST_CLOCK.now(),
      legacy_program_id: record.legacy_program_id,
    },
  ]);
  await t.storage.put(ATTACHMENT_BUCKET, attachment.object_key, bytes, { contentType: attachment.content_type });
  return { record, attachment, bytes };
}

/** One 2xx request per contract operation, keyed by `operationId`. */
const cases: Record<string, (ctx: Ctx) => Promise<CaseResult>> = {
  fixtureListRecords: async (ctx) => send(ctx, 'GET', inSite(`${FX}/records`), await asUser(APPROVER)),
  fixtureCreateRecord: async (ctx) => send(ctx, 'POST', `${FX}/records`, await asUser(PREPARER, { payload: { ...NEW_RECORD } })),
  fixtureGetRecord: async (ctx) => send(ctx, 'GET', inSite(recordUrl(ctx, FX)), await asUser(PREPARER)),
  fixtureTransitionRecord: async (ctx) => send(ctx, 'POST', recordUrl(ctx, FX, '/submit'), await asUser(PREPARER)),
  fixtureListVersions: async (ctx) => send(ctx, 'GET', inSite(recordUrl(ctx, FX, '/versions')), await asUser(APPROVER)),
  fixtureListAttachments: async (ctx) => send(ctx, 'GET', inSite(recordUrl(ctx, FX, '/attachments')), await asUser(APPROVER)),
  fixtureUploadAttachment: async (ctx) => send(ctx, 'POST', recordUrl(ctx, FX, '/attachments'), await asUser(PREPARER, multipart(UPLOAD))),
  fixtureDownloadAttachment: async (ctx) => {
    const url = inSite(recordUrl(ctx, FX, `/attachments/${ctx.seeded.attachment.attachment_id}`));
    const result = await send(ctx, 'GET', url, await asUser(APPROVER));
    expect(result.response.rawPayload.equals(ctx.seeded.bytes)).toBe(true);
    return result;
  },
  fixtureListRollups: async (ctx) => send(ctx, 'GET', inSite(`${FX}/rollups`), await asUser(PREPARER)),
  listRecords: async (ctx) => send(ctx, 'GET', `${V1}/records?state=IN-PROGRESS`, await asUser(Roles.reportingExporter)),
  getRecord: async (ctx) => send(ctx, 'GET', recordUrl(ctx, V1), await asUser(APPROVER)),
  listRecordVersions: async (ctx) => send(ctx, 'GET', recordUrl(ctx, V1, '/versions'), await asUser(PREPARER)),
  transitionRecord: async (ctx) => send(ctx, 'POST', recordUrl(ctx, V1, '/transitions/submit'), await asUser(PREPARER)),
  listRecordAttachments: async (ctx) => send(ctx, 'GET', recordUrl(ctx, V1, '/attachments'), await asUser(APPROVER)),
  uploadRecordAttachment: async (ctx) => send(ctx, 'POST', recordUrl(ctx, V1, '/attachments'), await asUser(PREPARER, multipart(UPLOAD))),
  getAttachmentDownloadUrl: async (ctx) =>
    send(ctx, 'GET', recordUrl(ctx, V1, `/attachments/${ctx.seeded.attachment.attachment_id}/download-url`), await asUser(PREPARER)),
  listRollups: async (ctx) => send(ctx, 'GET', `${V1}/rollups?asOf=${BUSINESS_DATE}`, await asUser(APPROVER)),
  getRecordV2: async (ctx) => send(ctx, 'GET', recordUrl(ctx, V2), await asUser(PREPARER)),
  listRecordVersionsV2: async (ctx) => send(ctx, 'GET', recordUrl(ctx, V2, '/versions?page=1&pageSize=50'), await asUser(APPROVER)),
  listRecordAttachmentsV2: async (ctx) => send(ctx, 'GET', recordUrl(ctx, V2, '/attachments?page=1&pageSize=50'), await asUser(PREPARER)),
  listRollupsV2: async (ctx) => send(ctx, 'GET', `${V2}/rollups?asOf=${BUSINESS_DATE}&page=1&pageSize=50`, await asUser(APPROVER)),
  listExportRecords: async (ctx) => {
    ctx.reporting.answer({
      status: 200,
      body: { exportId: EXPORT_ID, tenantId: TENANT, siteId: SITE, source: 'finance.records', state: 'running', claim: EXPORT_CLAIM },
    });
    const query = `exportId=${EXPORT_ID}&siteId=${SITE}&claim=${EXPORT_CLAIM}&page=1&pageSize=50`;
    return send(ctx, 'GET', `/internal/v1/finance/records?${query}`, await asService('reporting'));
  },
  getLocalAttachmentObject: async (ctx) => {
    const url = await signedAttachmentUrl(ctx);
    expect(url.split('/')[4]).toBe(TENANT);
    const result = await send(ctx, 'GET', url);
    expect(result.response.headers['content-type']).toBe(ctx.seeded.attachment.content_type);
    expect(result.response.rawPayload.equals(ctx.seeded.bytes)).toBe(true);
    return result;
  },
  pushProgramsSitesSiteChanged: async (ctx) => {
    const envelope = testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT, aggregateId: SITE, aggregateVersion: 1, payload: SITE_CHANGED });
    return { method: 'POST', url: PUSH_PATH, response: await pushTo(ctx.app, SITE_CHANGED_SUBSCRIPTION, envelope) };
  },
  migrationApply: async (ctx) => {
    const exported = await send(ctx, 'GET', `${MIGRATION}/export?unit=${UNITS[0]}&tenantId=${TENANT}`, await asService('migration'));
    const [table] = jsonOf<{ tables: { columns: unknown[]; rows: { row: string }[] }[] }>(exported.response).tables;
    expect(table?.rows).toHaveLength(1);
    const batch = {
      batchId: 'finance-contract-apply-1',
      origin: 'backfill',
      legacyTable: WATERMARK.legacyTable,
      tenantId: TENANT,
      columns: table?.columns ?? [],
      rows: (table?.rows ?? []).map(({ row }) => ({ op: 'upsert', row })),
    };
    return send(ctx, 'POST', `${MIGRATION}/apply`, await asService('migration', { payload: batch }));
  },
  migrationExport: async (ctx) => send(ctx, 'GET', `${MIGRATION}/export?unit=${UNITS[0]}&tenantId=${TENANT}`, await asService('migration')),
  migrationChanges: async (ctx) => send(ctx, 'GET', `${MIGRATION}/changes?tenantId=${TENANT}&after=0:0`, await asService('migration')),
  migrationPosition: async (ctx) => send(ctx, 'GET', `${MIGRATION}/position`, await asService('migration')),
  migrationWatermarkGet: async (ctx) => {
    jsonOf((await send(ctx, 'POST', `${MIGRATION}/watermark`, await asService('migration', { payload: { ...WATERMARK } }))).response);
    const query = `legacyTable=${WATERMARK.legacyTable}&direction=${WATERMARK.direction}`;
    const result = await send(ctx, 'GET', `${MIGRATION}/watermark?${query}`, await asService('migration'));
    expect(jsonOf<unknown[]>(result.response)).toHaveLength(1);
    return result;
  },
  migrationWatermarkPost: async (ctx) => send(ctx, 'POST', `${MIGRATION}/watermark`, await asService('migration', { payload: { ...WATERMARK } })),
  migrationGate: async (ctx) => {
    const result = await send(ctx, 'POST', `${MIGRATION}/gate`, await asService('migration', { payload: { op: 'status', units: [UNITS[0]] } }));
    expect(jsonOf<{ units: unknown[] }>(result.response).units).toEqual([expect.objectContaining({ unit: UNITS[0], state: 'open' })]);
    return result;
  },
  migrationGetAttachmentObject: async (ctx) => {
    const query = `tenantId=${TENANT}&attachmentId=${ctx.seeded.attachment.attachment_id}`;
    const result = await send(ctx, 'GET', `${MIGRATION}/objects?${query}`, await asService('migration'));
    expect(result.response.rawPayload.equals(ctx.seeded.bytes)).toBe(true);
    return result;
  },
  healthz: async (ctx) => send(ctx, 'GET', '/healthz'),
};

const OPERATION_IDS = contractOperations(DOC).map(({ operation }) => operation.operationId ?? '');

/** `url` with the last hex digit of its `sig` changed. */
function tamperedSignature(url: string): string {
  return url.replace(/sig=([0-9a-f]{64})/, (_match, sig: string) => `sig=${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`);
}

/** One documented error answer per family, with the status it must carry. */
const errorCases: readonly (readonly [string, number, (ctx: Ctx) => Promise<CaseResult>])[] = [
  ['fixture conflict: approve on an IN-PROGRESS record', 409, async (ctx) => send(ctx, 'POST', recordUrl(ctx, FX, '/approve'), await asUser(APPROVER))],
  ['fixture forbidden: submit by a role the action does not admit', 403, async (ctx) => send(ctx, 'POST', recordUrl(ctx, FX, '/submit'), await asUser(APPROVER))],
  ['fixture notFound: an unknown record', 404, async (ctx) => send(ctx, 'GET', inSite(`${FX}/records/${UNKNOWN_ID}`), await asUser(PREPARER))],
  ['v1 conflict: approve on an IN-PROGRESS record', 409, async (ctx) => send(ctx, 'POST', recordUrl(ctx, V1, '/transitions/approve'), await asUser(APPROVER))],
  ['v1 notFound: an unknown record', 404, async (ctx) => send(ctx, 'GET', `${V1}/records/${UNKNOWN_ID}`, await asUser(APPROVER))],
  [
    'a fixture write while its unit is legacy-authoritative',
    503,
    async (ctx) => {
      ctx.db.setGate(UNITS[0], 'legacy');
      return send(ctx, 'POST', `${FX}/records`, await asUser(PREPARER, { payload: { ...NEW_RECORD } }));
    },
  ],
  [
    'a v1 write while its unit is legacy-authoritative',
    503,
    async (ctx) => {
      ctx.db.setGate(UNITS[0], 'legacy');
      return send(ctx, 'POST', recordUrl(ctx, V1, '/transitions/submit'), await asUser(PREPARER));
    },
  ],
  ['the file route with a tampered signature', 403, async (ctx) => send(ctx, 'GET', tamperedSignature(await signedAttachmentUrl(ctx)))],
];

describe('contract document', () => {
  it('is OpenAPI 3.1.0 version 1.0.0 at the pinned source SHA', () => {
    expect(DOC.openapi).toBe('3.1.0');
    expect(DOC.info.version).toBe('1.0.0');
    expect(DOC.info['x-source-sha']).toBe(PIN.sha);
  });

  it('gives every operation a unique operationId, exactly one of x-opt2-requires and x-opt2-public, and a transport', () => {
    expect(OPERATION_IDS.filter((id, index) => id === '' || OPERATION_IDS.indexOf(id) !== index)).toEqual([]);
    const malformed = contractOperations(DOC).filter(({ operation }) => {
      const requires = operation['x-opt2-requires'];
      const validRoles = Array.isArray(requires) && requires.length > 0 && requires.every((role) => typeof role === 'string');
      const declaresOne = 'x-opt2-requires' in operation
        ? validRoles && !('x-opt2-public' in operation)
        : operation['x-opt2-public'] === true;
      return !declaresOne || !TRANSPORTS.includes(operation['x-opt2-transport']);
    });
    expect(malformed.map(({ key }) => key)).toEqual([]);
  });
});

describe('finance app against the contract', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    const t = await buildTestApp({ seed: { program_binding: [programBindingRow(SITE)] } });
    ctx = Object.assign(t, { seeded: await seedFinance(t) });
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it('registers exactly the contract operations', () => {
    expect(routeKeys(collectRouteMatrix(ctx.app).routes, DOC)).toEqual(operationKeys(DOC));
  });

  it('notices a route missing from the app and an operation missing from the contract', () => {
    const { routes } = collectRouteMatrix(ctx.app);
    const withoutHealth = structuredClone(DOC);
    delete withoutHealth.paths['/healthz']?.get;
    expect(routeKeys(routes, withoutHealth)).not.toEqual(operationKeys(withoutHealth));
    expect(routeKeys(routes.filter((route) => route.url !== '/healthz'), DOC)).not.toEqual(operationKeys(DOC));
  });

  it('declares each route with the contract roles, public flag and transport', () => {
    const routes = declaredRoutes(collectRouteMatrix(ctx.app).routes, DOC);
    const actual = Object.fromEntries(
      routes.map((route) => [`${route.method} ${templateOf(route.url)}`, declaration(route.requires, route.public, route.transport)]),
    );
    const contracted = Object.fromEntries(
      routes.map((route) => {
        const { template, operation } = findOperation(DOC, route.method, templateOf(route.url));
        expect(template).toBe(templateOf(route.url));
        return [
          `${route.method} ${template}`,
          declaration(operation['x-opt2-requires'], operation['x-opt2-public'], operation['x-opt2-transport']),
        ];
      }),
    );
    expect(actual).toEqual(contracted);

    const migration = Object.entries(actual).filter(([key]) => key.split(' ')[1]?.startsWith(`${MIGRATION}/`));
    expect(migration.length).toBeGreaterThan(0);
    for (const [, declared] of migration) expect(declared).toEqual(declaration(['platform.migration'], undefined, 'service'));
    expect(actual[`POST ${PUSH_PATH}`]).toEqual(declaration(['service:pubsub-invoker'], undefined, 'pubsub-push'));
    expect(actual[`GET /opt2/files/${ATTACHMENT_BUCKET}/{tenantId}/{objectName}`]).toEqual(declaration(undefined, true, 'service'));
    expect(actual['GET /healthz']).toEqual(declaration(undefined, true, 'service'));
  });

  it('has exactly one response case per contract operation', () => {
    expect(Object.keys(cases).sort()).toEqual([...OPERATION_IDS].sort());
  });

  it.each(OPERATION_IDS)('%s answers 2xx in its contract shape', async (operationId) => {
    const run = cases[operationId];
    if (run === undefined) throw new Error(`no response case for ${operationId}`);
    const { method, url, response } = await run(ctx);
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200);
    expect(response.statusCode, response.body).toBeLessThan(300);
    assertContract(method, url, response);
    if (declaresWritePosition(method, url.split('?')[0] ?? url, response.statusCode)) {
      expect(response.headers['x-opt2-write-position']).toMatch(WRITE_POSITION);
    }
  });

  it.each(errorCases)('answers %s with %i in its contract shape', async (_title, status, run) => {
    const { method, url, response } = await run(ctx);
    expect(response.statusCode, response.body).toBe(status);
    assertContract(method, url, response);
    expect(ctx.db.writes()).toEqual([]);
  });

  it('refuses a push delivery that presents a user token instead of the push key', async () => {
    const target = keylessPushTarget(ctx.app, await userHeaders(PREPARER));
    const envelope = testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT, aggregateId: SITE, aggregateVersion: 2, payload: SITE_CHANGED });
    const response = await pushTo(target, SITE_CHANGED_SUBSCRIPTION, envelope);
    expect([401, 403]).toContain(response.statusCode);
    assertContract('POST', PUSH_PATH, response);
    expect(ctx.db.queries()).toEqual([]);
  });

  it('refuses a migration call that presents only a user token', async () => {
    const { authorization } = await userHeaders(PREPARER);
    const result = await send(ctx, 'GET', `${MIGRATION}/position`, { headers: { authorization: authorization ?? '' } });
    expect([401, 403]).toContain(result.response.statusCode);
    assertContract(result.method, result.url, result.response);
    expect(ctx.db.queries()).toEqual([]);
  });
});
