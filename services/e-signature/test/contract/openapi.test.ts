// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Provider contract of e-signature: the app and contracts/openapi.yaml agree on metadata, routes, declarations, every response shape and the legacy headers. */
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Roles, collectRouteMatrix, type RouteMatrixEntry } from '@opt2/platform/auth';
import { etag, legacyHeaders } from '@opt2/platform/legacy-compat';
import { WRITE_POSITION_HEADER } from '@opt2/platform/migration-kit';
import { SITE_CHANGED_TOPIC } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  findOperation,
  pushTo,
  registryPayloads,
  testEnvelope,
  type InjectResponse,
  type OpenApiOperation,
  type PushTarget,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { UNITS } from '../../src/repo/tables.js';
import { CSRF_HEADERS, buildTestApp, type TestApp } from '../helpers/app.js';
import { AUDITOR_USER_ID, OTHER_USER_ID, SIGNER_USER_ID, migrationHeaders, userHeaders } from '../helpers/tokens.js';

interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  paths: Record<string, Record<string, unknown>>;
  'x-opt2-calls'?: unknown;
}

interface ContractOperation {
  key: string;
  path: string;
  operation: OpenApiOperation;
}

/** A response header the contract declares: whether it is required and its schema. */
interface DeclaredHeader {
  required: boolean;
  schema: Record<string, unknown>;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

interface CaseResult {
  method: HttpMethod;
  url: string;
  response: InjectResponse;
}

interface RequestOptions {
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
}

/** One table of a migration export page, as far as the apply case reads it. */
interface ExportedTable {
  legacyTable: string;
  columns: unknown[];
  rows: { row: string }[];
}

type AuditItem = Record<string, unknown>;

const DOC = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;
const TRANSPORTS: readonly unknown[] = ['service', 'pubsub-push', 'cloud-tasks'];
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const WRITE_POSITION = /^e-signature=\d+$/;
const WRITE_POSITION_KEY = WRITE_POSITION_HEADER.toLowerCase();
const LEGACY_HEADERS = legacyHeaders();

const FIXTURE_PATH_PREFIX = '/legacy-fixtures/cfml/api.cfm/esignature/';
const FX = `${FIXTURE_PATH_PREFIX}requests`;
const V1 = '/v1/esignature/requests';
const MIGRATION = '/internal/v1/migration';
const PUSH_PATH = `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`;
const SITE = TENANT_A.siteId;
const TENANT = TENANT_A.tenantId;
const SIGNER = Roles.esignatureSigner;
const AUDITOR = Roles.esignatureAuditor;
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const DOCUMENT = Buffer.from('%PDF-1.7 e-signature contract document\n');
const NEW_REQUEST = { documentName: 'contract.pdf', documentBase64: DOCUMENT.toString('base64'), signerUserId: SIGNER_USER_ID } as const;
const TYPED_NAME = 'Contract Signer';
const GATE_HOLDER = 'esignature-contract-window';
const WATERMARK = {
  legacyTable: 'synthetic.signature_request',
  direction: 'forward',
  snapshotSeq: 1,
  backupLsn: '1',
  finishedAt: '2026-06-30 12:00:00',
} as const;

/** Operations whose 2xx case commits a write, so the answer carries the write position of that transaction. */
const WRITES: ReadonlySet<string> = new Set([
  'fixtureCreateRequest',
  'fixtureRequestsByPut',
  'fixtureSignRequest',
  'fixtureSignRequestByGet',
  'fixtureSignRequestByPut',
  'fixtureSignRequestByPatch',
  'fixtureSignRequestByDelete',
  'fixtureSignRequestByOptions',
  'fixtureSignRequestByHead',
  'createSignatureRequest',
  'signRequest',
  'migrationApply',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every operation of `doc`, keyed `METHOD template`. */
function contractOperations(doc: OpenApiDoc): ContractOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = item[method];
      return isRecord(operation) ? [{ key: `${method.toUpperCase()} ${path}`, path, operation: operation as OpenApiOperation }] : [];
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

/** `url` without its query string. */
function pathOf(url: string): string {
  return url.split('?')[0] ?? url;
}

/** Headers the operation serving `method path` declares on `status`, keyed lower-case, each `$ref` resolved. */
function declaredHeaders(method: string, path: string, status: number): Map<string, DeclaredHeader> {
  const { operation } = findOperation(DOC, method, path);
  const response = resolved(operation.responses?.[String(status)]);
  const headers = isRecord(response) && isRecord(response.headers) ? response.headers : {};
  return new Map(
    Object.entries(headers).map(([name, header]): [string, DeclaredHeader] => {
      const node = resolved(header);
      const schema = isRecord(node) ? resolved(node.schema) : undefined;
      return [name.toLowerCase(), { required: isRecord(node) && node.required === true, schema: isRecord(schema) ? schema : {} }];
    }),
  );
}

/** Validates `response` against the operation of `method url`: JSON bodies parsed, others as text, an empty answer as no content. */
function assertContract(method: string, url: string, response: InjectResponse): void {
  const path = pathOf(url);
  const contentType = response.headers['content-type'];
  // app.inject keeps the body of a HEAD answer, which Node never sends.
  if (response.payload === '' || method === 'HEAD') {
    assertResponseMatchesOpenApi(DOC, { method, path, status: response.statusCode, contentType, body: undefined });
    return;
  }
  const json = typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType);
  const body: unknown = json ? JSON.parse(response.payload) : response.body;
  assertResponseMatchesOpenApi(DOC, { method, path, status: response.statusCode, contentType, body });
}

/** Asserts each declared header: present when required, within const, enum and pattern; Generator and HSTS as legacy sends them; ETag over the body inject returns. */
function assertDeclaredHeaders(method: string, url: string, response: InjectResponse): void {
  const declared = declaredHeaders(method, pathOf(url), response.statusCode);
  for (const [name, { required, schema }] of declared) {
    const value = response.headers[name];
    if (required) expect(value, name).toBeDefined();
    if (value === undefined) continue;
    const text = String(value);
    if ('const' in schema) expect(text, name).toBe(schema.const);
    if (Array.isArray(schema.enum)) expect(schema.enum, name).toContain(text);
    if (typeof schema.pattern === 'string') expect(text, name).toMatch(new RegExp(schema.pattern, 'u'));
  }
  if (declared.has('generator')) expect(response.headers.generator).toBe(LEGACY_HEADERS.Generator);
  if (declared.has('strict-transport-security')) {
    expect(response.headers['strict-transport-security']).toBe(LEGACY_HEADERS['Strict-Transport-Security']);
  }
  if (declared.has('etag') && response.payload !== '') expect(response.headers.etag).toBe(etag(response.payload));
  const position = response.headers[WRITE_POSITION_KEY];
  if (position !== undefined) {
    expect(declared.has(WRITE_POSITION_KEY), WRITE_POSITION_HEADER).toBe(true);
    expect(String(position)).toMatch(WRITE_POSITION);
  }
}

/** Injects one request into the app under test. */
async function send(ctx: TestApp, method: HttpMethod, url: string, { headers = {}, payload }: RequestOptions = {}): Promise<CaseResult> {
  const response = await ctx.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  return { method, url, response };
}

/** `options` presenting tenant-a user `sub` holding `role`. */
async function asUser(sub: string, role: string, options: RequestOptions = {}): Promise<RequestOptions> {
  return { ...options, headers: { ...(await userHeaders({ sub, site: SITE, roles: [role] })), ...options.headers } };
}

/** `options` presenting the designated signer of the requests the cases create. */
function asSigner(options: RequestOptions = {}): Promise<RequestOptions> {
  return asUser(SIGNER_USER_ID, SIGNER, options);
}

/** `options` presenting a tenant-a auditor. */
function asAuditor(options: RequestOptions = {}): Promise<RequestOptions> {
  return asUser(AUDITOR_USER_ID, AUDITOR, options);
}

/** `options` presenting the migration service's invocation credential. */
async function asMigration(options: RequestOptions = {}): Promise<RequestOptions> {
  return { ...options, headers: { ...(await migrationHeaders()), ...options.headers } };
}

/** `options` with the CSRF headers a fixture write sends. */
function withCsrf(options: RequestOptions = {}): RequestOptions {
  return { ...options, headers: { ...CSRF_HEADERS, ...options.headers } };
}

/** `options` dispatched by the fixture as `method` through `X-HTTP-Method-Override`. */
function overridden(method: 'GET' | 'POST', options: RequestOptions = {}): RequestOptions {
  return { ...options, headers: { 'x-http-method-override': method, ...options.headers } };
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

/** Creates a PENDING tenant-a request for {@link SIGNER_USER_ID} through `/v1` and returns its id, with the write log cleared. */
async function createRequest(ctx: TestApp): Promise<string> {
  const { response } = await send(ctx, 'POST', V1, await asSigner({ payload: { ...NEW_REQUEST } }));
  const id = jsonOf<{ request_id: string }>(response).request_id;
  ctx.db.clear();
  return id;
}

/** Creates a request and signs it through `/v1`; returns its id, with the write log cleared. */
async function signedRequest(ctx: TestApp): Promise<string> {
  const id = await createRequest(ctx);
  jsonOf((await send(ctx, 'POST', `${V1}/${id}/sign`, await asSigner({ payload: { typedName: TYPED_NAME } }))).response);
  ctx.db.clear();
  return id;
}

/** The stored audit items of request `id`, as `/v1` lists them for an auditor. */
async function auditItems(ctx: TestApp, id: string): Promise<AuditItem[]> {
  const { response } = await send(ctx, 'GET', `${V1}/${id}/audit`, await asAuditor());
  return jsonOf<{ items: AuditItem[] }>(response).items;
}

/** The `data` of a 200 fixture envelope. */
function dataOf<T>(result: CaseResult): T {
  return jsonOf<{ data: T }>(result.response).data;
}

/** The tenant-a payload of `programs-sites.site.changed.v1` the platform registry fixtures publish. */
function siteChangedPayload(): ReturnType<typeof registryPayloads>[number] {
  const payload = registryPayloads().find((entry) => entry.siteId === SITE);
  if (payload === undefined) throw new Error(`registryPayloads has no ${SITE} entry`);
  return payload;
}

/** A push target that delivers pushTo's request without the push key in its query. */
function keylessPushTarget(app: TestApp['app']): PushTarget {
  const inject = (opts: { method: HttpMethod; url: string; payload: object }): Promise<InjectResponse> => {
    expect(pathOf(opts.url)).toBe(PUSH_PATH);
    return app.inject({ method: opts.method, url: pathOf(opts.url), payload: opts.payload });
  };
  return { inject: inject as unknown as PushTarget['inject'] };
}

const EXPORT_URL = `${MIGRATION}/export?unit=${UNITS[0]}&tenantId=${TENANT}`;

/** One 2xx request per contract operation, keyed by `operationId`. */
const cases: Record<string, (ctx: TestApp) => Promise<CaseResult>> = {
  fixtureListRequests: async (ctx) => {
    await createRequest(ctx);
    const result = await send(ctx, 'GET', inSite(FX), await asSigner());
    expect(dataOf<{ totalitems: number }>(result).totalitems).toBe(1);
    return result;
  },
  fixtureCreateRequest: async (ctx) => {
    const result = await send(ctx, 'POST', FX, await asSigner(withCsrf({ payload: { ...NEW_REQUEST } })));
    expect(dataOf<{ state: string }>(result).state).toBe('PENDING');
    return result;
  },
  fixtureRequestsByPut: async (ctx) => send(ctx, 'PUT', FX, await asSigner(withCsrf(overridden('POST', { payload: { ...NEW_REQUEST } })))),
  fixtureRequestsByPatch: async (ctx) => send(ctx, 'PATCH', inSite(FX), await asSigner(overridden('GET'))),
  fixtureRequestsByDelete: async (ctx) => send(ctx, 'DELETE', inSite(FX), await asSigner(overridden('GET'))),
  fixtureRequestsByOptions: async (ctx) => send(ctx, 'OPTIONS', inSite(FX), await asSigner(overridden('GET'))),
  fixtureRequestsByHead: async (ctx) => send(ctx, 'HEAD', inSite(FX), await asSigner(overridden('GET'))),
  fixtureSignRequest: async (ctx) => {
    const id = await createRequest(ctx);
    const result = await send(ctx, 'POST', `${FX}/${id}/sign`, await asSigner(withCsrf({ payload: { typedName: TYPED_NAME } })));
    expect(dataOf<{ state: string }>(result).state).toBe('SIGNED');
    return result;
  },
  fixtureSignRequestByGet: async (ctx) => {
    const id = await createRequest(ctx);
    const url = `${FX}/${id}/sign?typedName=${encodeURIComponent(TYPED_NAME)}`;
    return send(ctx, 'GET', url, await asSigner(withCsrf(overridden('POST'))));
  },
  fixtureSignRequestByPut: async (ctx) => {
    const id = await createRequest(ctx);
    return send(ctx, 'PUT', `${FX}/${id}/sign`, await asSigner(withCsrf(overridden('POST', { payload: { typedName: TYPED_NAME } }))));
  },
  fixtureSignRequestByPatch: async (ctx) => {
    const id = await createRequest(ctx);
    return send(ctx, 'PATCH', `${FX}/${id}/sign`, await asSigner(withCsrf(overridden('POST', { payload: { typedName: TYPED_NAME } }))));
  },
  fixtureSignRequestByDelete: async (ctx) => {
    const id = await createRequest(ctx);
    return send(ctx, 'DELETE', `${FX}/${id}/sign`, await asSigner(withCsrf(overridden('POST', { payload: { typedName: TYPED_NAME } }))));
  },
  fixtureSignRequestByOptions: async (ctx) => {
    const id = await createRequest(ctx);
    const url = `${FX}/${id}/sign?typedName=${encodeURIComponent(TYPED_NAME)}`;
    return send(ctx, 'OPTIONS', url, await asSigner(withCsrf(overridden('POST'))));
  },
  fixtureSignRequestByHead: async (ctx) => {
    const id = await createRequest(ctx);
    const url = `${FX}/${id}/sign?typedName=${encodeURIComponent(TYPED_NAME)}`;
    return send(ctx, 'HEAD', url, await asSigner(withCsrf(overridden('POST'))));
  },
  fixtureGetAudit: async (ctx) => {
    const id = await signedRequest(ctx);
    const result = await send(ctx, 'GET', inSite(`${FX}/${id}/audit`), await asAuditor());
    expect(dataOf<{ items: AuditItem[] }>(result).items.map((item) => item.action)).toEqual(['created', 'signed']);
    return result;
  },
  fixtureGetAuditByPost: async (ctx) => send(ctx, 'POST', inSite(`${FX}/${await createRequest(ctx)}/audit`), await asSigner(overridden('GET'))),
  fixtureGetAuditByPut: async (ctx) => send(ctx, 'PUT', inSite(`${FX}/${await createRequest(ctx)}/audit`), await asAuditor(overridden('GET'))),
  fixtureGetAuditByPatch: async (ctx) => send(ctx, 'PATCH', inSite(`${FX}/${await createRequest(ctx)}/audit`), await asSigner(overridden('GET'))),
  fixtureGetAuditByDelete: async (ctx) => send(ctx, 'DELETE', inSite(`${FX}/${await createRequest(ctx)}/audit`), await asAuditor(overridden('GET'))),
  fixtureGetAuditByOptions: async (ctx) => send(ctx, 'OPTIONS', inSite(`${FX}/${await createRequest(ctx)}/audit`), await asSigner(overridden('GET'))),
  fixtureGetAuditByHead: async (ctx) => send(ctx, 'HEAD', inSite(`${FX}/${await createRequest(ctx)}/audit`), await asAuditor(overridden('GET'))),
  fixtureVerifyStored: async (ctx) => {
    const id = await signedRequest(ctx);
    const result = await send(ctx, 'GET', inSite(`${FX}/${id}/verify`), await asAuditor());
    expect(dataOf(result)).toEqual({ valid: true, entries: 2, brokenat: 0 });
    return result;
  },
  fixtureVerifySupplied: async (ctx) => {
    const id = await signedRequest(ctx);
    const entries = await auditItems(ctx, id);
    const result = await send(ctx, 'POST', `${FX}/${id}/verify`, await asSigner(withCsrf({ payload: { entries } })));
    expect(dataOf(result)).toEqual({ valid: true, entries: 2, brokenat: 0 });
    return result;
  },
  fixtureVerifyByPut: async (ctx) => {
    const id = await createRequest(ctx);
    const entries = await auditItems(ctx, id);
    return send(ctx, 'PUT', `${FX}/${id}/verify`, await asAuditor(withCsrf(overridden('POST', { payload: { entries } }))));
  },
  fixtureVerifyByPatch: async (ctx) => send(ctx, 'PATCH', inSite(`${FX}/${await createRequest(ctx)}/verify`), await asSigner(overridden('GET'))),
  fixtureVerifyByDelete: async (ctx) => send(ctx, 'DELETE', inSite(`${FX}/${await createRequest(ctx)}/verify`), await asAuditor(overridden('GET'))),
  fixtureVerifyByOptions: async (ctx) => send(ctx, 'OPTIONS', inSite(`${FX}/${await createRequest(ctx)}/verify`), await asSigner(overridden('GET'))),
  fixtureVerifyByHead: async (ctx) => send(ctx, 'HEAD', inSite(`${FX}/${await createRequest(ctx)}/verify`), await asAuditor(overridden('GET'))),
  listSignatureRequests: async (ctx) => {
    await createRequest(ctx);
    const result = await send(ctx, 'GET', `${V1}?pageIndex=1&itemsPerPage=10`, await asSigner());
    expect(jsonOf<{ totalitems: number }>(result.response).totalitems).toBe(1);
    return result;
  },
  createSignatureRequest: async (ctx) => send(ctx, 'POST', V1, await asSigner({ payload: { ...NEW_REQUEST, siteid: SITE } })),
  getSignatureRequest: async (ctx) => {
    const id = await signedRequest(ctx);
    const result = await send(ctx, 'GET', `${V1}/${id}`, await asAuditor());
    expect(jsonOf<{ signature: { typed_name: string } }>(result.response).signature.typed_name).toBe(TYPED_NAME);
    return result;
  },
  signRequest: async (ctx) => send(ctx, 'POST', `${V1}/${await createRequest(ctx)}/sign`, await asSigner({ payload: { typedName: TYPED_NAME } })),
  getAuditChain: async (ctx) => send(ctx, 'GET', `${V1}/${await signedRequest(ctx)}/audit`, await asAuditor()),
  verifyChain: async (ctx) => {
    const result = await send(ctx, 'GET', `${V1}/${await signedRequest(ctx)}/verify`, await asSigner());
    expect(jsonOf(result.response)).toEqual({ valid: true, entries: 2, brokenat: 0 });
    return result;
  },
  verifySuppliedChain: async (ctx) => {
    const id = await signedRequest(ctx);
    const entries = await auditItems(ctx, id);
    const result = await send(ctx, 'POST', `${V1}/${id}/verify`, await asAuditor({ payload: { entries } }));
    expect(jsonOf(result.response)).toEqual({ valid: true, entries: 2, brokenat: 0 });
    return result;
  },
  pushSiteChanged: async (ctx) => {
    const envelope = testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT, aggregateId: SITE, aggregateVersion: 1, payload: siteChangedPayload() });
    return { method: 'POST', url: PUSH_PATH, response: await pushTo(ctx.app, SITE_CHANGED_SUBSCRIPTION, envelope) };
  },
  migrationApply: async (ctx) => {
    await createRequest(ctx);
    const table = jsonOf<{ tables: ExportedTable[] }>((await send(ctx, 'GET', EXPORT_URL, await asMigration())).response).tables[0];
    if (table === undefined) throw new Error(`the export of ${UNITS[0]} holds no table`);
    expect(table.rows).toHaveLength(1);
    const batch = {
      batchId: 'esignature-contract-apply-1',
      origin: 'backfill',
      legacyTable: table.legacyTable,
      tenantId: TENANT,
      columns: table.columns,
      rows: table.rows.map(({ row }) => ({ op: 'upsert', row })),
    };
    return send(ctx, 'POST', `${MIGRATION}/apply`, await asMigration({ payload: batch }));
  },
  migrationExport: async (ctx) => {
    await createRequest(ctx);
    return send(ctx, 'GET', EXPORT_URL, await asMigration());
  },
  migrationChanges: async (ctx) => {
    await createRequest(ctx);
    return send(ctx, 'GET', `${MIGRATION}/changes?tenantId=${TENANT}&after=0:0`, await asMigration());
  },
  migrationPosition: async (ctx) => send(ctx, 'GET', `${MIGRATION}/position`, await asMigration()),
  migrationWatermarkGet: async (ctx) => {
    jsonOf((await send(ctx, 'POST', `${MIGRATION}/watermark`, await asMigration({ payload: { ...WATERMARK } }))).response);
    const query = `legacyTable=${WATERMARK.legacyTable}&direction=${WATERMARK.direction}`;
    const result = await send(ctx, 'GET', `${MIGRATION}/watermark?${query}`, await asMigration());
    expect(jsonOf<unknown[]>(result.response)).toHaveLength(1);
    return result;
  },
  migrationWatermarkPost: async (ctx) => send(ctx, 'POST', `${MIGRATION}/watermark`, await asMigration({ payload: { ...WATERMARK } })),
  migrationGate: async (ctx) => {
    const url = `${MIGRATION}/gate`;
    const units = [UNITS[0]];
    const closed = await send(ctx, 'POST', url, await asMigration({ payload: { op: 'close', units, holderId: GATE_HOLDER } }));
    expect(jsonOf<{ units: unknown[] }>(closed.response).units).toEqual([expect.objectContaining({ unit: UNITS[0], state: 'closed', holderId: GATE_HOLDER })]);
    assertContract(closed.method, url, closed.response);
    const opened = await send(ctx, 'POST', url, await asMigration({ payload: { op: 'open', units, holderId: GATE_HOLDER } }));
    expect(jsonOf<{ units: unknown[] }>(opened.response).units).toEqual([expect.objectContaining({ unit: UNITS[0], state: 'open', holderId: null })]);
    return opened;
  },
  healthz: async (ctx) => send(ctx, 'GET', '/healthz'),
};

const OPERATION_IDS = contractOperations(DOC).map(({ operation }) => operation.operationId ?? '');


/** Operations whose 2xx case passed, filled by the case runner. */
const exercised = new Set<string>();

/** One documented error answer, with the status and error message it must carry. */
type ErrorCase = readonly [title: string, status: number, message: string, run: (ctx: TestApp) => Promise<CaseResult>];

const FORBIDDEN = 'Insufficient Account Permissions';

const errorCases: readonly ErrorCase[] = [
  ['fixture authorization: an anonymous list', 401, FORBIDDEN, async (ctx) => send(ctx, 'GET', inSite(FX))],
  [
    'fixture forbidden: a create by a role the action does not admit',
    403,
    FORBIDDEN,
    async (ctx) => send(ctx, 'POST', FX, await asAuditor(withCsrf({ payload: { ...NEW_REQUEST } }))),
  ],
  [
    'fixture forbidden: a siteid other than the token site',
    403,
    FORBIDDEN,
    async (ctx) => send(ctx, 'GET', `${FX}?siteid=${TENANT_B.siteId}`, await asSigner()),
  ],
  [
    'fixture forbidden: a sign by a signer the request does not name',
    403,
    FORBIDDEN,
    async (ctx) => {
      const id = await createRequest(ctx);
      return send(ctx, 'POST', `${FX}/${id}/sign`, await asUser(OTHER_USER_ID, SIGNER, withCsrf({ payload: { typedName: TYPED_NAME } })));
    },
  ],
  ['fixture notFound: the audit of an unknown request', 404, 'Not Found', async (ctx) => send(ctx, 'GET', inSite(`${FX}/${UNKNOWN_ID}/audit`), await asAuditor())],
  ['fixture notFound: an effective method the path does not dispatch on', 404, 'Not Found', async (ctx) => send(ctx, 'PUT', inSite(FX), await asSigner())],
  [
    'fixture invalidParameters: a create without a document name',
    400,
    'Invalid parameters',
    async (ctx) => send(ctx, 'POST', FX, await asSigner(withCsrf({ payload: { ...NEW_REQUEST, documentName: '' } }))),
  ],
  [
    'fixture invalidParameters: a sign with a blank typed name',
    400,
    'Invalid parameters',
    async (ctx) => send(ctx, 'POST', `${FX}/${await createRequest(ctx)}/sign`, await asSigner(withCsrf({ payload: { typedName: '   ' } }))),
  ],
  [
    'fixture conflict: signing a SIGNED request',
    409,
    'already-signed',
    async (ctx) => send(ctx, 'POST', `${FX}/${await signedRequest(ctx)}/sign`, await asSigner(withCsrf({ payload: { typedName: TYPED_NAME } }))),
  ],
  ['v1 authorization: an anonymous list', 401, FORBIDDEN, async (ctx) => send(ctx, 'GET', V1)],
  ['v1 forbidden: a create by an auditor', 403, FORBIDDEN, async (ctx) => send(ctx, 'POST', V1, await asAuditor({ payload: { ...NEW_REQUEST } }))],
  ['v1 forbidden: a siteid other than the token site', 403, FORBIDDEN, async (ctx) => send(ctx, 'GET', `${V1}?siteid=${TENANT_B.siteId}`, await asSigner())],
  ['v1 notFound: an unknown request', 404, 'Not Found', async (ctx) => send(ctx, 'GET', `${V1}/${UNKNOWN_ID}`, await asAuditor())],
  ['v1 invalidParameters: a create without its fields', 400, 'Invalid parameters', async (ctx) => send(ctx, 'POST', V1, await asSigner({ payload: {} }))],
  [
    'v1 conflict: signing a SIGNED request',
    409,
    'already-signed',
    async (ctx) => send(ctx, 'POST', `${V1}/${await signedRequest(ctx)}/sign`, await asSigner({ payload: { typedName: TYPED_NAME } })),
  ],
  [
    'a fixture create while its unit is legacy-authoritative',
    503,
    'Unhandled Exception',
    async (ctx) => {
      ctx.db.setGate(UNITS[0], 'legacy');
      return send(ctx, 'POST', FX, await asSigner(withCsrf({ payload: { ...NEW_REQUEST } })));
    },
  ],
  [
    'a v1 sign while its unit is legacy-authoritative',
    503,
    'Unhandled Exception',
    async (ctx) => {
      const id = await createRequest(ctx);
      ctx.db.setGate(UNITS[0], 'legacy');
      return send(ctx, 'POST', `${V1}/${id}/sign`, await asSigner({ payload: { typedName: TYPED_NAME } }));
    },
  ],
  ['a migration call by a user without platform.migration', 403, FORBIDDEN, async (ctx) => send(ctx, 'GET', `${MIGRATION}/position`, await asSigner())],
  [
    'a push delivery without the push key',
    401,
    FORBIDDEN,
    async (ctx) => {
      const envelope = testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT, aggregateId: SITE, aggregateVersion: 2, payload: siteChangedPayload() });
      return { method: 'POST', url: PUSH_PATH, response: await pushTo(keylessPushTarget(ctx.app), SITE_CHANGED_SUBSCRIPTION, envelope) };
    },
  ],
];

describe('contract document', () => {
  it('is OpenAPI 3.1.0 version 1.0.0 at the pinned source SHA', () => {
    expect(DOC.openapi).toBe('3.1.0');
    expect(DOC.info.version).toBe('1.0.0');
    expect(DOC.info['x-source-sha']).toBe(PIN.sha);
  });

  it('declares the services e-signature calls', () => {
    // identity answers the CSRF consume of every fixture write; people the signer's pool-user read.
    expect(DOC['x-opt2-calls']).toEqual(['identity', 'people']);
  });

  it('gives every operation a unique operationId, exactly one of x-opt2-requires and x-opt2-public, and a transport', () => {
    expect(OPERATION_IDS.filter((id, index) => id === '' || OPERATION_IDS.indexOf(id) !== index)).toEqual([]);
    const malformed = contractOperations(DOC).filter(({ operation }) => {
      const requires = operation['x-opt2-requires'];
      const validRoles = Array.isArray(requires) && requires.length > 0 && requires.every((role) => typeof role === 'string');
      const declaresOne = 'x-opt2-requires' in operation ? validRoles && !('x-opt2-public' in operation) : operation['x-opt2-public'] === true;
      return !declaresOne || !TRANSPORTS.includes(operation['x-opt2-transport']);
    });
    expect(malformed.map(({ key }) => key)).toEqual([]);
  });

  it('names fixture operations fixture*, carries seven migration operations on six paths and the site push at its subscription', () => {
    const operations = contractOperations(DOC);
    const fixture = operations.filter(({ path }) => path.startsWith(FIXTURE_PATH_PREFIX));
    expect(fixture.length).toBeGreaterThan(0);
    expect(fixture.filter(({ operation }) => !operation.operationId?.startsWith('fixture')).map(({ key }) => key)).toEqual([]);
    const migration = operations.filter(({ path }) => path.startsWith(`${MIGRATION}/`));
    expect(new Set(migration.map(({ path }) => path)).size).toBe(6);
    expect(migration).toHaveLength(7);
    expect(operations.filter(({ operation }) => operation.operationId === 'pushSiteChanged').map(({ key }) => key)).toEqual([`POST ${PUSH_PATH}`]);
  });
});

describe('e-signature app against the contract', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await buildTestApp();
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
        return [`${route.method} ${template}`, declaration(operation['x-opt2-requires'], operation['x-opt2-public'], operation['x-opt2-transport'])];
      }),
    );
    expect(actual).toEqual(contracted);

    const migration = Object.entries(actual).filter(([key]) => key.split(' ')[1]?.startsWith(`${MIGRATION}/`));
    expect(migration).toHaveLength(7);
    for (const [, declared] of migration) expect(declared).toEqual(declaration([Roles.platformMigration], undefined, 'service'));
    expect(actual[`POST ${PUSH_PATH}`]).toEqual(declaration(['service:pubsub-invoker'], undefined, 'pubsub-push'));
    expect(actual[`POST ${templateOf(`${FX}/:id/sign`)}`]).toEqual(declaration(undefined, true, 'service'));
    expect(actual[`POST ${V1}`]).toEqual(declaration([SIGNER], undefined, 'service'));
    expect(actual['GET /healthz']).toEqual(declaration(undefined, true, 'service'));
  });

  it('has exactly one response case per contract operation', () => {
    expect(Object.keys(cases).sort()).toEqual([...OPERATION_IDS].sort());
  });

  it.each(OPERATION_IDS)('%s answers 2xx in its contract shape', async (operationId) => {
    const run = cases[operationId];
    if (run === undefined) throw new Error(`no response case for ${operationId}`);
    const { method, url, response } = await run(ctx);
    expect(findOperation(DOC, method, pathOf(url)).operation.operationId).toBe(operationId);
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200);
    expect(response.statusCode, response.body).toBeLessThan(300);
    assertContract(method, url, response);
    assertDeclaredHeaders(method, url, response);
    if (WRITES.has(operationId)) expect(response.headers[WRITE_POSITION_KEY]).toBe(`e-signature=${ctx.db.lastXid() ?? ''}`);
    exercised.add(operationId);
  });

  it.each(errorCases)('answers %s with %i in its contract shape', async (_title, status, message, run) => {
    const { method, url, response } = await run(ctx);
    expect(response.statusCode, response.body).toBe(status);
    assertContract(method, url, response);
    assertDeclaredHeaders(method, url, response);
    expect(JSON.parse(response.payload)).toMatchObject({ apiversion: 'v1', error: { message } });
    expect(response.headers[WRITE_POSITION_KEY]).toBeUndefined();
    expect(ctx.db.writes()).toEqual([]);
  });
});

describe('case coverage', () => {
  it('exercised every contract operation with a passing 2xx case', () => {
    expect([...exercised].sort()).toEqual([...OPERATION_IDS].sort());
  });
});

