/** Provider contract of programs-sites: every registered route against contracts/openapi.yaml, and every response shape per operation. */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { collectRouteMatrix, type RouteMatrixEntry } from '@opt2/platform/auth';
import { SYSTEM_TENANT_ID, tenantIdForSite, type QueryResultRow } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  pushTo,
  testEnvelope,
  withoutTenant,
  type InjectResponse,
  type TenantlessEnvelope,
} from '@opt2/platform/testing';
import { siteChangedPayload } from '../../src/domain/pools.js';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { SITE_COLUMNS } from '../../src/legacy/site-fields.js';
import { buildTestApp, headersFor, type RecordingDb, type TestApp } from '../helpers/app.js';

type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS' | 'PATCH';
type JsonApiFamily = 'json' | 'ajax' | 'rest';
type OperationObject = Record<string, unknown> & { operationId?: string };

interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  paths: Record<string, Record<string, unknown>>;
}

interface ContractOperation {
  method: string;
  path: string;
  operationId: string | undefined;
  op: OperationObject;
}

interface RouteSetDiff {
  undeclared: string[];
  unregistered: string[];
}

/** A response as `sendCase` hands it to a case: the inject response and its body, JSON-parsed when JSON. */
interface Answer {
  res: InjectResponse;
  body: unknown;
}

/** One request against an operation; `as` names the ROLE_SET subject presenting credentials, `push` delivers through `pushTo`. */
interface Case {
  name: string;
  method: HttpMethod;
  url: string;
  as?: string;
  site?: string;
  headers?: Record<string, string>;
  payload?: string | Record<string, unknown>;
  push?: () => TenantlessEnvelope;
  setup?: (ctx: TestApp) => void;
  status: number;
  verify?: (answer: Answer, ctx: TestApp) => void;
}

const DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const TOKEN_FIELDS = 'csrf_token=T&csrf_token_expires=E';

const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const UMBRELLA = TENANT_UMBRELLA.siteId;
const SIZE_ID = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90';
const SWEEP_QUEUE = 'programs-sites-outbox-sweep';
const MONITOR_QUEUE = 'programs-sites-sitemonitor';
const PUSH_PATH = `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`;
const CURSOR = new Date(2026, 5, 30, 11, 45, 0, 0);
const CURSOR_TEXT = '2026-06-30T11:45:00.000';
const WATERMARK_FINISHED_AT = '2026-06-30T12:00:00.000';
const UPDATE_FIELDS = `siteid=${SITE_A}&action=Update&site=Tenant%20A&domain=${SITE_A}.opt2.test`;
const SITE_SAVE_FIELDS = 'domain=saved.opt2.test&tagline=Updated';
const IMAGE_SIZE_COLUMNS = ['sizeID', 'siteID', 'name', 'height', 'width'].map((name) => ({ name, type: 's' }));

// Integer settings of an installed site (core/setup/db/mssql.sql:1043, core/mura/dbUpdates/5.4.3178.cfm:438 and 6.2.cfm:7); other columns are NULL.
const INSTALLED_SITE_SETTINGS: Readonly<Record<string, number>> = {
  pagelimit: 1000,
  emailbroadcaster: 0,
  extranet: 0,
  extranetpublicreg: 0,
  extranetssl: 0,
  cache: 0,
  viewdepth: 1,
  nextn: 20,
  datacollection: 1,
  columncount: 3,
  primarycolumn: 2,
  publicsubmission: 0,
  emailbroadcasterlimit: 0,
  feedmanager: 1,
  commentapprovaldefault: 1,
  deploy: 0,
  usedefaultsmtpserver: 0,
  haschangesets: 1,
  usessl: 0,
};

/** A stored `programs_sites.site` row with the installed site's settings. */
function siteRow(siteId: string, values: Record<string, unknown>): QueryResultRow {
  return {
    ...Object.fromEntries(SITE_COLUMNS.map(({ targetName }) => [targetName, null])),
    ...INSTALLED_SITE_SETTINGS,
    tenant_id: tenantIdForSite(siteId),
    siteid: siteId,
    domain: `${siteId}.opt2.test`,
    row_version: '1',
    ...values,
  };
}

const SITE_ROWS: readonly QueryResultRow[] = [
  siteRow(SITE_A, {
    site: 'Tenant A',
    orderno: 1,
    baseid: '0A000000-0000-0000-0000000000000001',
    publicuserpoolid: UMBRELLA,
    categorypoolid: UMBRELLA,
    filepoolid: UMBRELLA,
    displaypoolid: UMBRELLA,
  }),
  siteRow(SITE_B, { site: 'Tenant B', orderno: 2, baseid: '0B000000-0000-0000-0000000000000002' }),
  siteRow(UMBRELLA, { site: 'Umbrella', orderno: 3, baseid: '0C000000-0000-0000-0000000000000003' }),
];

const IMAGE_SIZE_ROW: QueryResultRow = {
  tenant_id: TENANT_A.tenantId,
  sizeid: SIZE_ID,
  siteid: SITE_A,
  name: 'hero',
  height: '400',
  width: 'AUTO',
};

/** `tenant_registry` pool column prefixes and the site.changed payload fields they store. */
const REGISTRY_POOLS = [
  ['public_user_pool', 'publicUserPoolId'],
  ['private_user_pool', 'privateUserPoolId'],
  ['category_pool', 'categoryPoolId'],
  ['file_pool', 'filePoolId'],
  ['display_pool', 'displayPoolId'],
] as const;

/** The `tenant_registry` row a site's `programs-sites.site.changed.v1` payload stores. */
function registryRow(row: QueryResultRow): QueryResultRow {
  const payload = siteChangedPayload(row);
  const contentPools = [payload.contentPoolIds ?? []].flat();
  const pools = REGISTRY_POOLS.flatMap(([column, field]) => {
    const poolSite = payload[field] ?? payload.siteId;
    return [
      [`${column}_id`, poolSite],
      [`${column}_tenant`, tenantIdForSite(poolSite)],
    ];
  });
  return {
    site_id: payload.siteId,
    tenant_id: tenantIdForSite(payload.siteId),
    ...Object.fromEntries(pools),
    content_pool_ids: contentPools,
    content_pool_tenants: contentPools.map((id) => tenantIdForSite(id)),
    domains: payload.domains,
    aggregate_version: 1,
    updated_at: CURSOR,
  };
}

const REGISTRY_ROWS: readonly QueryResultRow[] = SITE_ROWS.map(registryRow);

/** Rows of the tenant `params[0]`, narrowed to those `params[1]` names in one of `columns` when it is text. */
function keyedRows(rows: readonly QueryResultRow[], columns: readonly string[]): (params: unknown[]) => QueryResultRow[] {
  return (params) => {
    const [tenantId, key] = params;
    const ofTenant = rows.filter((row) => row.tenant_id === tenantId);
    return typeof key === 'string' ? ofTenant.filter((row) => columns.some((column) => row[column] === key)) : ofTenant;
  };
}

/** Registry rows a lookup names: by tenant UUID, by site id ignoring case, else every row. */
function registryRows(params: unknown[]): QueryResultRow[] {
  const [first] = params;
  if (typeof first !== 'string') return [...REGISTRY_ROWS];
  return REGISTRY_ROWS.filter((row) => row.tenant_id === first || String(row.site_id).toLowerCase() === first.toLowerCase());
}

/** `[column, $n]` pairs an `INSERT (…) VALUES (…)` or `UPDATE … SET … WHERE` statement binds. */
function boundColumns(sql: string): Array<[string, string]> {
  const insert = /^INSERT INTO \S+ \(([^)]*)\) VALUES \(([^)]*)\)/i.exec(sql);
  if (insert?.[1] !== undefined && insert[2] !== undefined) {
    const values = insert[2].split(',').map((value) => value.trim());
    return insert[1].split(',').map((column, i): [string, string] => [column.trim().replace(/"/g, ''), values[i] ?? '']);
  }
  const set = /^UPDATE \S+ SET (.+?) WHERE /i.exec(sql)?.[1] ?? '';
  return [...set.matchAll(/"?(\w+)"? = (\$\d+)/g)].map((match): [string, string] => [match[1] ?? '', match[2] ?? '']);
}

/** The one `sitemonitor_state` row held in memory, so the run lease and the cursor persist from statement to statement. */
function cursorTable(): (params: unknown[], sql: string) => QueryResultRow[] {
  const row: QueryResultRow = { tenant_id: SYSTEM_TENANT_ID, id: 1, last_monitored: CURSOR, updated_at: CURSOR, lease_id: null, lease_until: null };
  return (params, sql) => {
    for (const [column, placeholder] of boundColumns(sql)) {
      if (/^\$\d+$/.test(placeholder)) row[column] = params[Number(placeholder.slice(1)) - 1];
    }
    return [{ ...row }];
  };
}

/**
 * Seeds the sites tenant-a (pooled to umbrella), tenant-b and umbrella, their registry, one image size and the
 * site-monitor cursor, plus the PostgreSQL-computed answers (catalog lookups, counts, `to_char`) a fake cannot derive.
 */
function seed(db: RecordingDb): void {
  db.respond(/FROM programs_sites\.tenant_registry/i, registryRows);
  db.respond(/^SELECT \* FROM "programs_sites"\."site" WHERE/i, keyedRows(SITE_ROWS, ['siteid']));
  db.respond(/^SELECT \* FROM "programs_sites"\."image_size" WHERE/i, keyedRows([IMAGE_SIZE_ROW], ['sizeid', 'siteid', 'name']));
  db.respond(/^(?:SELECT|INSERT|UPDATE)\b.*\bprograms_sites"?\."?sitemonitor_state\b/i, cursorTable());
  db.respond(/\bto_regclass\(/i, [{ outbox: true, inbox: true }]);
  db.respond(/^SELECT \(SELECT count\(\*\) FROM/i, [{ unpublished: '0', held: '0' }]);
  db.respond(/^INSERT INTO "programs_sites"\."migration_watermark"/i, (params) => [
    { legacy_table: params[0], direction: params[1], snapshot_seq: String(params[2]), backup_lsn: params[3], finished_at: WATERMARK_FINISHED_AT },
  ]);
}

/** One entry per operation of `doc`, its method upper-cased. */
function contractOperations(doc: OpenApiDoc): ContractOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const op = item[method] as OperationObject | undefined;
      return op === undefined ? [] : [{ method: method.toUpperCase(), path, operationId: op.operationId, op }];
    }),
  );
}

/** A Fastify route pattern in contract form: `:name` as `{name}`; a leading `/index.cfm` and a trailing prefix `*` drop, as the contract serves those forms on one path. */
function toOpenApiPath(fastifyUrl: string): string {
  return fastifyUrl
    .replace(/^\/index\.cfm(?=\/)/i, '')
    .replace(/\*$/, '')
    .replace(/:([A-Za-z_]\w*)/g, '{$1}');
}

/** `METHOD path` key of a registered route. */
function routeKey(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${toOpenApiPath(route.url)}`;
}

/** `METHOD path` keys of the registered routes. */
function routeKeys(routes: readonly RouteMatrixEntry[]): Set<string> {
  return new Set(routes.map(routeKey));
}

/** `METHOD path` key of a contract operation: the Fastify route `x-opt2-fastify-path` names, in contract form, else its template. */
function operationKey({ method, path, op }: ContractOperation): string {
  const fastifyPath = op['x-opt2-fastify-path'];
  return `${method} ${typeof fastifyPath === 'string' ? toOpenApiPath(fastifyPath) : path}`;
}

/** `METHOD path` keys of the contract operations. */
function operationKeys(operations: readonly ContractOperation[]): Set<string> {
  return new Set(operations.map(operationKey));
}

/** Routes the contract does not declare, and operations no route serves, each sorted. */
function diffRouteSets(routes: readonly RouteMatrixEntry[], operations: readonly ContractOperation[]): RouteSetDiff {
  const registered = routeKeys(routes);
  const declared = operationKeys(operations);
  return {
    undeclared: [...registered].filter((key) => !declared.has(key)).sort(),
    unregistered: [...declared].filter((key) => !registered.has(key)).sort(),
  };
}

/** Sends `c` to the app, asserts its status, then validates the response against the operation it addresses. */
async function sendCase(ctx: TestApp, c: Case): Promise<Answer> {
  const res =
    c.push === undefined
      ? await ctx.app.inject({
          method: c.method,
          url: c.url,
          headers: { ...(c.as === undefined ? {} : await headersFor(c.as, { site: c.site })), ...c.headers },
          ...(c.payload === undefined ? {} : { payload: c.payload }),
        })
      : await pushTo(ctx.app, SITE_CHANGED_SUBSCRIPTION, c.push());
  const contentType = res.headers['content-type'];
  const json = typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType) && res.body !== '';
  const body: unknown = json ? JSON.parse(res.body) : res.body;
  expect(res.statusCode, res.body).toBe(c.status);
  assertResponseMatchesOpenApi(DOC, { method: c.method, path: c.url.split('?')[0] ?? c.url, status: res.statusCode, contentType, body });
  return { res, body };
}

/** Wire body of a tenant-less system task on `queue`. */
function systemTask(queue: string): Record<string, unknown> {
  return { queue, name: `${queue}-1782820800`, tenantId: null };
}

/** The `programs-sites.site.changed.v1` delivery of the stored tenant-a site. */
function siteChangedEnvelope() {
  const row = SITE_ROWS[0] as QueryResultRow;
  return testEnvelope({
    topic: 'programs-sites.site.changed.v1',
    tenantId: TENANT_A.tenantId,
    aggregateId: SITE_A,
    payload: siteChangedPayload(row),
  });
}

/** The parsed body as a record, for property checks. */
function record(body: unknown): Record<string, unknown> {
  expect(body).toBeTypeOf('object');
  return body as Record<string, unknown>;
}

/** Asserts the request left no write and published nothing. */
function expectNothingWritten(ctx: TestApp): void {
  expect(ctx.db.writes()).toEqual([]);
  expect(ctx.publisher.published).toEqual([]);
}

/** Asserts the request read no site row, consumed no CSRF token, wrote nothing and published nothing. */
function expectWithheld(ctx: TestApp): void {
  expect(ctx.db.statements().filter(({ sql }) => sql.includes('"programs_sites"."site"'))).toEqual([]);
  expect(ctx.client.requestsTo('identity')).toEqual([]);
  expectNothingWritten(ctx);
}

/** The withheld `site.save` of tenant-a as S2 through `family`; the session-managed families send valid CSRF fields. */
function jsonApiSave(family: JsonApiFamily): Case {
  return {
    name: `refuses the withheld tenant-a site save as s2 through the ${family} family with the legacy 503`,
    method: 'POST',
    url: `/_api/${family}/v1/${SITE_A}/site`,
    as: 's2',
    headers: FORM,
    payload: family === 'rest' ? SITE_SAVE_FIELDS : `${SITE_SAVE_FIELDS}&${TOKEN_FIELDS}`,
    status: 503,
    verify: ({ body }, ctx) => {
      expect(record(body)).toEqual({ apiversion: 'v1', method: 'invalid', error: { code: 'server_error', message: 'Unhandled Exception' } });
      expectWithheld(ctx);
    },
  };
}

/** A path of each JSON API template and the site method its route key resolves under every verb. */
const JSON_API_TEMPLATES = [
  { name: 'Root', url: `?method=findAll&entityname=site&siteid=${SITE_A}`, method: 'findAll' },
  { name: 'Site', url: `/${SITE_A}?method=findPermissions&entityname=site&id=${SITE_A}`, method: 'findPermissions' },
  { name: 'Segment', url: `/${SITE_A}/findNew?entityname=site`, method: 'findNew' },
  { name: 'Item', url: `/${SITE_A}/site/${SITE_A}`, method: 'findOne' },
  { name: 'Suffix', url: `/${SITE_A}/site/${SITE_A}/permissions?method=findProperties&entityname=site`, method: 'findProperties' },
] as const;

const JSON_API_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'];

/** One anonymous call per JSON API family, template and verb: the method's envelope, or for HEAD its headers alone. */
function jsonApiCases(): Record<string, Case[]> {
  const cases: Record<string, Case[]> = {};
  for (const family of ['json', 'ajax', 'rest'] as const) {
    for (const template of JSON_API_TEMPLATES) {
      for (const method of JSON_API_METHODS) {
        const verb = `${method.charAt(0)}${method.slice(1).toLowerCase()}`;
        cases[`${family}Api${template.name}${verb}`] = [
          {
            name: `answers ${template.method} of tenant-a anonymously through the ${family} family`,
            method,
            url: `/_api/${family}/v1${template.url}`,
            status: 200,
            verify: ({ res, body }) => {
              expect(res.headers.etag).toMatch(/^[0-9A-F]{64}$/);
              if (method === 'HEAD') {
                expect(res.body).toBe('');
                expect(res.headers['content-length']).toBeUndefined();
              } else {
                expect(record(body).method).toBe(template.method);
              }
            },
          },
        ];
      }
    }
  }
  return cases;
}

const JSON_API_CASES = jsonApiCases();

/** The generated cases of `operationId` followed by `extra`. */
function jsonApiOperation(operationId: string, ...extra: Case[]): Case[] {
  return [...(JSON_API_CASES[operationId] ?? []), ...extra];
}

/** Anonymous public site-monitor run through `method`; legacy matches the path only. */
function siteMonitorRun(method: HttpMethod): Case {
  return {
    name: `runs the site monitor anonymously on ${method} with the legacy empty body`,
    method,
    url: '/_api/sitemonitor',
    status: 200,
    verify: ({ res }, ctx) => {
      expect(res.body).toBe('');
      expect(ctx.client.requestsTo('migration', '/internal/v1/legacy-steps')).not.toEqual([]);
    },
  };
}

const CASES: Record<string, Case[]> = {
  ...JSON_API_CASES,
  jsonApiSegmentGet: jsonApiOperation('jsonApiSegmentGet', {
    name: 'refuses a token of another tenant on the JSON API site read with the legacy 403',
    method: 'GET',
    url: `/_api/json/v1/${SITE_A}/site`,
    as: 'other-tenant',
    status: 403,
  }),
  jsonApiSegmentPost: jsonApiOperation('jsonApiSegmentPost', jsonApiSave('json')),
  jsonApiSegmentDelete: jsonApiOperation(
    'jsonApiSegmentDelete',
    {
      name: 'refuses an anonymous JSON API site delete with the legacy 401 before any CSRF check',
      method: 'DELETE',
      url: `/_api/json/v1/${SITE_A}/site`,
      status: 401,
      verify: ({ body }, ctx) => {
        expect(record(body).method).toBe('delete');
        expect(ctx.client.requestsTo('identity')).toEqual([]);
        expectNothingWritten(ctx);
      },
    },
    {
      name: 'answers an S2 JSON API site delete with a valid token as the legacy server_error, deleting nothing',
      method: 'DELETE',
      url: `/_api/json/v1/${SITE_A}/site`,
      as: 's2',
      headers: FORM,
      payload: TOKEN_FIELDS,
      status: 500,
      verify: ({ body }, ctx) => {
        expect(record(body)).toMatchObject({ method: 'delete', error: { code: 'server_error' } });
        expectNothingWritten(ctx);
      },
    },
  ),
  ajaxApiSegmentPost: jsonApiOperation('ajaxApiSegmentPost', jsonApiSave('ajax')),
  restApiSegmentPost: jsonApiOperation('restApiSegmentPost', jsonApiSave('rest')),
  sitemonitorRunGet: [
    {
      name: 'runs the site monitor anonymously with the legacy empty body',
      method: 'GET',
      url: '/_api/sitemonitor',
      status: 200,
      verify: ({ res }, ctx) => {
        expect(res.body).toBe('');
        expect(ctx.client.requestsTo('migration', '/internal/v1/legacy-steps')).not.toEqual([]);
      },
    },
  ],
  sitemonitorRunPost: [
    {
      name: 'runs the site monitor anonymously on POST with the legacy empty body',
      method: 'POST',
      url: '/_api/sitemonitor',
      status: 200,
      verify: ({ res }, ctx) => {
        expect(res.body).toBe('');
        expect(ctx.client.requestsTo('migration', '/internal/v1/legacy-steps')).not.toEqual([]);
      },
    },
  ],
  sitemonitorRunHead: [siteMonitorRun('HEAD')],
  sitemonitorRunPut: [siteMonitorRun('PUT')],
  sitemonitorRunDelete: [siteMonitorRun('DELETE')],
  sitemonitorRunPatch: [siteMonitorRun('PATCH')],
  sitemonitorRunOptions: [siteMonitorRun('OPTIONS')],
  listSites: [
    {
      name: 'lists every registered site for s2',
      method: 'GET',
      url: '/v1/sites?sortBy=orderno',
      as: 's2',
      status: 200,
      verify: ({ body }) => {
        expect((body as Array<{ siteid: string }>).map((site) => site.siteid)).toEqual([SITE_A, SITE_B, UMBRELLA]);
      },
    },
    {
      name: 'rejects anonymous listSites with the legacy 401 envelope',
      method: 'GET',
      url: '/v1/sites',
      status: 401,
      verify: ({ body }) => {
        expect(record(body).error).toMatchObject({ code: 'invalid_request', message: 'Insufficient Account Permissions' });
      },
    },
    {
      name: 'refuses listSites to a site admin, which only s2 may call',
      method: 'GET',
      url: '/v1/sites',
      as: 'site-admin',
      status: 403,
    },
  ],
  saveSiteOrder: [
    {
      name: 'saves the bind order and deploy flags as s2',
      method: 'POST',
      url: '/v1/sites/order',
      as: 's2',
      headers: FORM,
      payload: `orderID=${SITE_A},${SITE_B}&orderno=2,1&deploy=1,0&${TOKEN_FIELDS}`,
      status: 200,
      verify: ({ body }, ctx) => {
        expect(record(body).written).toBe(true);
        expect(ctx.db.writesTo('programs_sites.site')).not.toEqual([]);
      },
    },
  ],
  getSite: [
    {
      name: 'reads the Edit Site data of tenant-a as its site admin',
      method: 'GET',
      url: `/v1/sites/${SITE_A}`,
      as: 'site-admin',
      status: 200,
      verify: ({ body }) => {
        const detail = record(body);
        expect(detail).toMatchObject({ isNew: 0, site: { SiteID: SITE_A, publicUserPoolID: UMBRELLA } });
        expect(detail.imageSizes).toEqual([expect.objectContaining({ sizeID: SIZE_ID })]);
      },
    },
    {
      name: 'refuses the tenant-a Edit Site data to a site admin of another tenant',
      method: 'GET',
      url: `/v1/sites/${SITE_A}`,
      as: 'other-tenant',
      status: 403,
    },
  ],
  getShellSite: [
    {
      name: 'reads the admin layout settings of tenant-a as a system user',
      method: 'GET',
      url: `/v1/sites/${SITE_A}/shell`,
      as: 'system-user',
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ isNew: 0, site: { SiteID: SITE_A } }),
    },
  ],
  getUserPoolSites: [
    {
      name: 'reads the tenant-a private and umbrella public user pool sites as a system user',
      method: 'GET',
      url: `/v1/sites/${SITE_A}/user-pool-sites`,
      as: 'system-user',
      status: 200,
      verify: ({ body }) => {
        expect((record(body).sites as Array<{ SiteID: string }>).map((site) => site.SiteID)).toEqual([SITE_A, UMBRELLA]);
      },
    },
    {
      name: 'refuses the tenant-a user pool sites to a token of another tenant',
      method: 'GET',
      url: `/v1/sites/${SITE_A}/user-pool-sites`,
      as: 'other-tenant',
      status: 403,
    },
  ],
  updateSite: [
    ...(['site-admin', 's2'] as const).map(
      (as): Case => ({
        name: `refuses the withheld Update of tenant-a by its ${as} with a valid CSRF token with the legacy 503`,
        method: 'POST',
        url: `/v1/sites/${SITE_A}/update`,
        as,
        headers: FORM,
        payload: `${UPDATE_FIELDS}&tagline=Updated&${TOKEN_FIELDS}`,
        status: 503,
        verify: ({ body }, ctx) => {
          expect(record(body)).toMatchObject({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
          expectWithheld(ctx);
        },
      }),
    ),
    {
      name: 'answers invalidParameters for an action other than Update before any CSRF consume, read or write',
      method: 'POST',
      url: `/v1/sites/${SITE_A}/update`,
      as: 'site-admin',
      headers: FORM,
      payload: `siteid=${SITE_A}&action=Add&${TOKEN_FIELDS}`,
      status: 400,
      verify: (_answer, ctx) => expectWithheld(ctx),
    },
  ],
  listImageSizes: [
    {
      name: 'lists the tenant-a custom image sizes as its site admin',
      method: 'GET',
      url: `/v1/sites/${SITE_A}/image-sizes`,
      as: 'site-admin',
      status: 200,
      verify: ({ body }) => expect(body).toEqual([expect.objectContaining({ sizeID: SIZE_ID, siteID: SITE_A, isNew: 0 })]),
    },
  ],
  getImageSize: [
    {
      name: 'reads one stored image size as the site admin',
      method: 'GET',
      url: `/v1/sites/${SITE_A}/image-sizes/${SIZE_ID}`,
      as: 'site-admin',
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ sizeID: SIZE_ID, name: 'hero', height: '400', isNew: 0 }),
    },
  ],
  saveImageSize: [
    {
      name: 'saves an image size as the site admin and returns the site sizes',
      method: 'PUT',
      url: `/v1/sites/${SITE_A}/image-sizes/${SIZE_ID}`,
      as: 'site-admin',
      headers: FORM,
      payload: 'name=Hero&height=480&width=AUTO',
      status: 200,
      verify: (_answer, ctx) => expect(ctx.db.writesTo('programs_sites.image_size')).not.toEqual([]),
    },
  ],
  deleteImageSize: [
    {
      name: 'deletes an image size as the site admin and returns the site sizes',
      method: 'DELETE',
      url: `/v1/sites/${SITE_A}/image-sizes/${SIZE_ID}`,
      as: 'site-admin',
      status: 200,
      verify: (_answer, ctx) => expect(ctx.db.writesTo('programs_sites.image_size')).not.toEqual([]),
    },
  ],
  getHrefDomains: [
    {
      name: 'reads the registered href domains for the gateway',
      method: 'GET',
      url: `/v1/href-domains?siteid=${SITE_A}`,
      as: 'service:gateway',
      status: 200,
      verify: ({ body }) => expect(record(body).siteDomain).toBe(`${SITE_A}.opt2.test`),
    },
  ],
  listUserSites: [
    {
      name: 'lists every registered site an s2 user administers',
      method: 'GET',
      url: '/v1/user-sites',
      as: 's2',
      status: 200,
      verify: ({ body }) => {
        expect((record(body).sites as Array<{ siteid: string }>).map((site) => site.siteid).sort()).toEqual([SITE_A, SITE_B, UMBRELLA]);
      },
    },
  ],
  migrationApply: [
    {
      name: 'applies a zero-row timagesizes batch for the migration service',
      method: 'POST',
      url: '/internal/v1/migration/apply',
      as: 'service:migration',
      payload: { batchId: 'batch-1', origin: 'backfill', legacyTable: 'timagesizes', siteId: SITE_A, columns: IMAGE_SIZE_COLUMNS, rows: [] },
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ batchId: 'batch-1', duplicate: false, applied: 0, skipped: 0 }),
    },
    {
      name: 'rejects a batch whose columns omit an owned column as invalidParameters',
      method: 'POST',
      url: '/internal/v1/migration/apply',
      as: 'service:migration',
      payload: { batchId: 'batch-2', origin: 'backfill', legacyTable: 'timagesizes', siteId: SITE_A, columns: IMAGE_SIZE_COLUMNS.slice(0, 1), rows: [] },
      status: 400,
    },
    {
      name: 'refuses the migration apply route to an s2 user',
      method: 'POST',
      url: '/internal/v1/migration/apply',
      as: 's2',
      payload: { batchId: 'batch-3', origin: 'backfill', legacyTable: 'timagesizes', siteId: SITE_A, columns: IMAGE_SIZE_COLUMNS, rows: [] },
      status: 403,
    },
  ],
  migrationExport: [
    {
      name: 'exports the tenant-a image sizes in canonical legacy form',
      method: 'GET',
      url: `/internal/v1/migration/export?unit=programs_sites.image_size&siteId=${SITE_A}`,
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ unit: 'programs_sites.image_size', tenantId: TENANT_A.tenantId }),
    },
  ],
  migrationChanges: [
    {
      name: 'reads an empty changelog page of tenant-a',
      method: 'GET',
      url: `/internal/v1/migration/changes?siteId=${SITE_A}`,
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ rows: [], complete: true }),
    },
  ],
  migrationPosition: [
    {
      name: 'reports the write position and drain counts',
      method: 'GET',
      url: '/internal/v1/migration/position',
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(record(body).owner).toBe('programs-sites'),
    },
  ],
  migrationWatermarkGet: [
    {
      name: 'lists the timagesizes watermarks',
      method: 'GET',
      url: '/internal/v1/migration/watermark?legacyTable=timagesizes&direction=forward',
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(body).toEqual([]),
    },
  ],
  migrationWatermarkPost: [
    {
      name: 'records a forward timagesizes watermark',
      method: 'POST',
      url: '/internal/v1/migration/watermark',
      as: 'service:migration',
      payload: { legacyTable: 'timagesizes', direction: 'forward', snapshotSeq: 1, backupLsn: '42', finishedAt: '2026-06-30 12:00:00' },
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ legacyTable: 'timagesizes', direction: 'forward' }),
    },
  ],
  migrationGate: [
    {
      name: 'reads the unit gates of programs-sites',
      method: 'POST',
      url: '/internal/v1/migration/gate',
      as: 'service:migration',
      payload: { op: 'status', units: ['programs_sites.site'] },
      status: 200,
      verify: ({ body }) => {
        expect(record(body).units).toEqual([{ unit: 'programs_sites.site', state: 'open', holderId: null, phase: 'quiet' }]);
      },
    },
  ],
  pushSiteChanged: [
    {
      name: 'applies a site.changed delivery to the tenant registry and acks it',
      method: 'POST',
      url: PUSH_PATH,
      push: siteChangedEnvelope,
      status: 204,
      verify: (_answer, ctx) => {
        expect(ctx.db.writesTo('programs_sites.tenant_registry')).not.toEqual([]);
        expect(ctx.publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toEqual([]);
      },
    },
    {
      name: 'dead-letters and acks a delivery without a tenant',
      method: 'POST',
      url: PUSH_PATH,
      push: () => withoutTenant(siteChangedEnvelope()),
      status: 204,
      verify: (_answer, ctx) => {
        expect(ctx.publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toHaveLength(1);
        expect(ctx.db.writesTo('programs_sites.tenant_registry')).toEqual([]);
      },
    },
  ],
  outboxSweep: [
    {
      name: 'creates the next sweep task, then sweeps every registered tenant',
      method: 'POST',
      url: '/internal/v1/outbox/sweep',
      as: 'service:tasks-invoker',
      payload: systemTask(SWEEP_QUEUE),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ failed: 0, tenants: REGISTRY_ROWS.length }),
    },
    {
      name: 'refuses a user token on the cloud-tasks sweep route before the handler',
      method: 'POST',
      url: '/internal/v1/outbox/sweep',
      as: 's2',
      payload: systemTask(SWEEP_QUEUE),
      setup: (ctx) => ctx.taskPort.calls.splice(0),
      status: 401,
      verify: (_answer, ctx) => expect(ctx.taskPort.calls).toEqual([]),
    },
  ],
  jobSitemonitor: [
    {
      name: 'creates the next site-monitor task, then runs the orchestrator from the stored cursor',
      method: 'POST',
      url: '/internal/v1/jobs/sitemonitor',
      as: 'service:tasks-invoker',
      payload: systemTask(MONITOR_QUEUE),
      status: 200,
      verify: ({ body }, ctx) => {
        expect(record(body).lastMonitored).toBe(CURSOR_TEXT);
        expect(ctx.taskPort.tasks(MONITOR_QUEUE)).not.toEqual([]);
      },
    },
  ],
  pauseTaskQueue: [
    {
      name: 'pauses the site-monitor queue for the operator',
      method: 'POST',
      url: `/internal/v1/task-queues/${MONITOR_QUEUE}/pause`,
      as: 'service:operator',
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ queue: MONITOR_QUEUE, service: 'programs-sites', paused: true, running: 0 }),
    },
  ],
  resumeTaskQueue: [
    {
      name: 'resumes the site-monitor queue for the migration service',
      method: 'POST',
      url: `/internal/v1/task-queues/${MONITOR_QUEUE}/resume`,
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ queue: MONITOR_QUEUE, service: 'programs-sites', paused: false }),
    },
  ],
  ensureTaskQueue: [
    {
      name: 'finds the live outbox-sweep chain task for the operator',
      method: 'POST',
      url: `/internal/v1/task-queues/${SWEEP_QUEUE}/ensure`,
      as: 'service:operator',
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ queue: SWEEP_QUEUE, ensured: { created: false, reason: 'live' } }),
    },
    {
      name: 'rejects ensure on a queue that is not a recurring chain as invalidParameters',
      method: 'POST',
      url: '/internal/v1/task-queues/content-feed-import/ensure',
      as: 'service:operator',
      status: 400,
    },
  ],
  getSitemonitorState: [
    {
      name: 'reads the stored site-monitor cursor',
      method: 'GET',
      url: '/internal/v1/sitemonitor/state',
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ lastMonitored: CURSOR_TEXT, updatedAt: CURSOR_TEXT }),
    },
  ],
  putSitemonitorState: [
    {
      name: 'seeds the site-monitor cursor at a scheduler hand-off',
      method: 'PUT',
      url: '/internal/v1/sitemonitor/state',
      as: 'service:migration',
      payload: { lastMonitored: CURSOR_TEXT },
      status: 200,
      verify: ({ body }) => expect(record(body).lastMonitored).toBe(CURSOR_TEXT),
    },
    {
      name: 'rejects a cursor with an offset as badRequest',
      method: 'PUT',
      url: '/internal/v1/sitemonitor/state',
      as: 'service:migration',
      payload: { lastMonitored: '2026-06-30T11:45:00.000Z' },
      status: 400,
    },
  ],
  healthz: [
    {
      name: 'answers the liveness probe anonymously',
      method: 'GET',
      url: '/healthz',
      status: 200,
      verify: ({ body }) => expect(body).toEqual({ status: 'ok' }),
    },
  ],
};

describe('contract document', () => {
  it('is OpenAPI 3.1.0 version 1.0.0 at the pinned source SHA', () => {
    expect(DOC.openapi).toBe('3.1.0');
    expect(DOC.info.version).toBe('1.0.0');
    expect(DOC.info['x-source-sha']).toBe(PIN.sha);
  });

  it('gives every operation a unique operationId', () => {
    const ids = contractOperations(DOC).map(({ operationId }) => operationId);
    expect(ids.filter((id) => typeof id !== 'string' || id === '')).toEqual([]);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('lists the withheld site.save route key of each JSON API operation only as an exclusion', () => {
    const reason = 'Withheld and served by legacy; every site save also writes trazunasettings, a decision-list table.';
    const keyed = contractOperations(DOC).filter(({ op }) => op['x-opt2-route-keys'] !== undefined);
    expect(keyed).toHaveLength(105);
    for (const { path, op } of keyed) {
      const saveKey = path.startsWith('/_api/rest/') ? 'rest:site.save' : 'api:site.save';
      const served = (op['x-opt2-route-keys'] as string[]).filter((key) => key.endsWith(':site.save'));
      expect(served, `${path} serves site.save`).toEqual([]);
      expect(op['x-opt2-route-keys-excluded'], path).toEqual([{ key: saveKey, reason }]);
    }
    const excludedElsewhere = contractOperations(DOC).filter(({ op }) => op['x-opt2-route-keys'] === undefined && op['x-opt2-route-keys-excluded'] !== undefined);
    expect(excludedElsewhere).toEqual([]);
  });
});

describe('route declarations', () => {
  let ctx: TestApp;
  let routes: RouteMatrixEntry[];

  beforeAll(async () => {
    ctx = await buildTestApp();
    routes = collectRouteMatrix(ctx.app).routes;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('registers exactly the contract operations', () => {
    const { undeclared, unregistered } = diffRouteSets(routes, contractOperations(DOC));
    expect(undeclared).toEqual([]);
    expect(unregistered).toEqual([]);
  });

  it('declares each route with the contract roles, public flag and transport', () => {
    const operations = new Map(contractOperations(DOC).map((operation) => [operationKey(operation), operation.op]));
    const declared = routes.map((route) => ({
      route: routeKey(route),
      requires: [...(route.requires ?? [])].sort(),
      public: Boolean(route.public),
      transport: route.transport,
    }));
    const contracted = routes.map((route) => {
      const op = operations.get(routeKey(route));
      return {
        route: routeKey(route),
        requires: [...((op?.['x-opt2-requires'] as string[] | undefined) ?? [])].sort(),
        public: op?.['x-opt2-public'] === true,
        transport: op?.['x-opt2-transport'],
      };
    });
    expect(declared).toEqual(contracted);
  });

  it('reports a removed operation, a missing route and an extra route', () => {
    const trimmed = structuredClone(DOC);
    delete (trimmed.paths['/healthz'] as Record<string, unknown>).get;
    expect(diffRouteSets(routes, contractOperations(trimmed))).toEqual({ undeclared: ['GET /healthz'], unregistered: [] });

    const withoutHealth = routes.filter((route) => route.url !== '/healthz');
    expect(diffRouteSets(withoutHealth, contractOperations(DOC))).toEqual({ undeclared: [], unregistered: ['GET /healthz'] });

    const extra: RouteMatrixEntry = { method: 'GET', url: '/v1/sites/:siteId/extra', transport: 'service', requires: ['s2'], siteCheck: true };
    expect(diffRouteSets([...routes, extra], contractOperations(DOC))).toEqual({
      undeclared: ['GET /v1/sites/{siteId}/extra'],
      unregistered: [],
    });
  });
});

describe('responses', () => {
  it('cover every contract operation with at least one case, and with a 2xx answer where the contract declares one', () => {
    const operations = contractOperations(DOC);
    expect(Object.keys(CASES).sort()).toEqual(operations.map(({ operationId }) => operationId ?? '').sort());
    const declaresSuccess = new Set(
      operations
        .filter(({ op }) => Object.keys((op.responses as Record<string, unknown> | undefined) ?? {}).some((status) => status.startsWith('2')))
        .map(({ operationId }) => operationId),
    );
    const withoutSuccess = Object.entries(CASES).filter(
      ([id, cases]) => declaresSuccess.has(id) && !cases.some(({ status }) => status >= 200 && status < 300),
    );
    expect(withoutSuccess.map(([id]) => id)).toEqual([]);
    expect(operations.filter(({ operationId }) => !declaresSuccess.has(operationId)).map(({ operationId }) => operationId)).toEqual(['updateSite']);
  });

  let ctx: TestApp | undefined;

  afterEach(async () => {
    await ctx?.app.close();
    ctx = undefined;
  });

  const rows = Object.entries(CASES).flatMap(([operationId, cases]) => cases.map((c) => ({ operationId, title: c.name, c })));

  it.each(rows)('$operationId $title', async ({ c }) => {
    const built = await buildTestApp();
    ctx = built;
    seed(built.db);
    c.setup?.(built);
    const answer = await sendCase(built, c);
    c.verify?.(answer, built);
  });
});
