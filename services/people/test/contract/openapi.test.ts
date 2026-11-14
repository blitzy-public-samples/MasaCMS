import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, collectRouteMatrix, type RouteMatrixEntry } from '@opt2/platform/auth';
import { normaliseRouteKey, routeKeyForRequest, type RouteKeyRequest } from '@opt2/platform/legacy-compat';
import {
  TENANT_A,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  findOperation,
  fixtureForSite,
  mintServiceToken,
  mintTasksInvokerToken,
  pushTo,
  registryPayloads,
  testEnvelope,
  type InjectResponse,
  type TenantlessEnvelope,
} from '@opt2/platform/testing';
import { GROUP_NAME_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { FAVORITE } from '../../src/repo/tables.js';
import { TEST_CLOCK, buildTestApp, userHeaders, type RecordingDb, type TestApp, type UserHeadersInput } from '../helpers/app.js';
import {
  ARCHIVE_EFFECTIVE_FROM,
  ARCHIVE_PERSON,
  ARCHIVED_PERSON_B,
  DEFAULT_PEOPLE_SEED,
  EDITOR,
  MEMBER_B,
  MODULE_USER_A_PERSON,
  OTHER_TENANT,
  POOLED_MEMBER_PERSON,
  SITE_ADMIN_A,
  SYSTEM_USER_A,
  SYSTEM_USER_A_PERSON,
  TENANT_A_SYSTEM_USERS,
  accountsForSeed,
  type TenantPeopleSeed,
} from '../helpers/fixtures.js';

type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
type Row = Record<string, unknown>;
type Headers = Record<string, string>;
type Operation = Record<string, unknown> & { operationId?: string };

interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  'x-opt2-calls'?: unknown;
  paths: Record<string, Record<string, unknown>>;
}

interface ContractOperation {
  method: HttpMethod;
  path: string;
  operationId: string;
  op: Operation;
}

interface Request {
  method: HttpMethod;
  url: string;
  headers?: Headers;
  payload?: string | Record<string, unknown>;
}

interface Answer {
  res: InjectResponse;
  body: unknown;
}

/** One request against an operation and the status it must answer. */
interface Case {
  name: string;
  inject?: () => Promise<Request>;
  push?: { subscription: string; envelope: () => TenantlessEnvelope };
  setup?: (ctx: TestApp) => void;
  status: number;
  verify?: (answer: Answer, ctx: TestApp) => void;
}

const DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const SERVICE = 'people';
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const;
const TRANSPORTS: readonly string[] = ['service', 'pubsub-push', 'cloud-tasks'];
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const FORM: Headers = { 'content-type': 'application/x-www-form-urlencoded' };
const TOKEN_FIELDS = 'csrf_token=CONTRACT-TOKEN&csrf_token_expires=260630130000000';
const UPPERCASE_HEX = /^[0-9A-F]+$/;
const SWEEP_QUEUE = 'people-outbox-sweep';
const LEGACY_FAMILIES = ['json', 'ajax', 'rest'] as const;
const JSON_API_VERBS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

// Favorites operations document legacy wire shapes only (checked by legacy-wire-types.test.ts); people registers no route,
// as their link needs a content href no strategies-content operation offers, so they must be exactly the unregistered ones.
const UNSERVED_TAG = 'favorites';

const SITE_A = TENANT_A.siteId;
const TENANT_A_SEED = DEFAULT_PEOPLE_SEED[TENANT_A.tenantId] as TenantPeopleSeed;
const SYSTEM_USER = SYSTEM_USER_A_PERSON.userid;
const MODULE_USER = MODULE_USER_A_PERSON.userid;
const HOME_ADDRESS = String(
  (TENANT_A_SEED.addresses ?? []).find((address) => address.userid === SYSTEM_USER && address.isprimary === 1)?.addressid,
);
const USERNAME_TAKEN = 'The username module_user_a is already taken.';
const ARCHIVE_UNIQUE_CONSTRAINT = 'person_archive_tenant_id_person_id_effective_from_key';
const WATERMARK_FINISHED_AT = '2026-06-30T12:00:00.000';
const ANONYMOUS_SESSION: UserHeadersInput = { sub: '', site: SITE_A, roles: [] };

const SEED_TABLES: Readonly<Record<string, keyof TenantPeopleSeed>> = {
  person: 'persons',
  user_address: 'addresses',
  user_interest: 'interests',
  user_tag: 'tags',
  user_favorite: 'favorites',
  extend_subtype: 'extendSubtypes',
  extend_set: 'extendSets',
  extend_attribute: 'extendAttributes',
  extend_data_user_activity: 'extendData',
  person_archive: 'archives',
  group_name: 'groupNames',
};
const STORE_ONLY_TABLES = ['roster_operation', 'person_tombstone'] as const;
const SERIAL_COLUMNS: Readonly<Record<string, string>> = { user_tag: 'tagid', extend_data_user_activity: 'dataid', extend_attribute: 'attributeid' };
const STORE_TABLE = /^(?:SELECT .*? FROM|INSERT INTO|UPDATE|DELETE FROM) "people"\."(\w+)"/;

function storeKey(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '').replace(/ +$/, '').toLowerCase();
}

function bound(values: readonly unknown[], placeholder: string | undefined): unknown {
  return placeholder === undefined ? undefined : values[Number(placeholder) - 1];
}

function matching(rows: readonly Row[], where: string, values: readonly unknown[]): Row[] {
  let found = [...rows];
  for (const m of where.matchAll(/(?:\b\w+\.)?"?(\w+)"?(?:::\w+)?(?: COLLATE "\w+"\."\w+")? = (?:ANY ?\()?\$(\d+)/g)) {
    const value = bound(values, m[2]);
    const column = m[1] ?? '';
    if (value === null || value === undefined) continue;
    const wanted = new Set((Array.isArray(value) ? value : [value]).map(storeKey));
    found = found.filter((row) => !(column in row) || wanted.has(storeKey(row[column])));
  }
  return found;
}

function createMemoryStore(seed: Readonly<Record<string, readonly Row[]>>) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]));
  let serial = 2_000_000;
  const rowsOf = (table: string): Row[] => tables.get(table) ?? [];
  return {
    answers: (text: string): boolean => tables.has(STORE_TABLE.exec(text)?.[1] ?? ''),
    run(text: string, values: readonly unknown[]): Row[] {
      const table = STORE_TABLE.exec(text)?.[1] ?? '';
      const rows = rowsOf(table);
      const where = /\bWHERE (.*?)(?: ORDER BY | LIMIT | FOR UPDATE| FOR SHARE| RETURNING |$)/.exec(text)?.[1] ?? '';
      if (text.startsWith('SELECT')) {
        const found = matching(rows, where, values);
        return /^SELECT count\(\*\)::int AS count /.test(text) ? [{ count: found.length }] : found;
      }
      if (text.startsWith('INSERT')) {
        const columns = (/^INSERT INTO \S+ \(([^)]*)\)/.exec(text)?.[1] ?? '').split(',').map((column) => column.trim().replace(/"/g, ''));
        const tuples = [...(/ VALUES (.*?)(?: ON CONFLICT| RETURNING|$)/.exec(text)?.[1] ?? '').matchAll(/\(([^()]*)\)/g)];
        return tuples.map((tuple) => {
          const placeholders = (tuple[1] ?? '').split(',');
          const row: Row = Object.fromEntries(columns.map((column, i) => [column, bound(values, /\$(\d+)/.exec(placeholders[i] ?? '')?.[1]) ?? null]));
          const serialColumn = SERIAL_COLUMNS[table];
          if (serialColumn !== undefined && !(serialColumn in row)) row[serialColumn] = (serial += 1);
          rows.push(row);
          return { ...row };
        });
      }
      const affected = matching(rows, where, values);
      if (text.startsWith('UPDATE')) {
        const set = /\bSET (.*?) WHERE /.exec(text)?.[1] ?? '';
        for (const row of affected) {
          for (const m of set.matchAll(/"?(\w+)"? = \$(\d+)/g)) row[m[1] ?? ''] = bound(values, m[2]) ?? null;
        }
      } else {
        tables.set(table, rows.filter((row) => !affected.includes(row)));
      }
      return affected.map((row) => ({ ...row }));
    },
  };
}

const POOL_COLUMNS = [
  ['public_user_pool', 'publicUserPoolId'],
  ['private_user_pool', 'privateUserPoolId'],
  ['category_pool', 'categoryPoolId'],
  ['file_pool', 'filePoolId'],
  ['display_pool', 'displayPoolId'],
] as const;

function tenantOf(siteId: string): string {
  const fixture = fixtureForSite(siteId);
  if (fixture === undefined) throw new TypeError(`No tenant fixture for site ${siteId}`);
  return fixture.tenantId;
}

const REGISTRY_ROWS: readonly Row[] = registryPayloads().map((payload) => {
  const contentPools = [payload.contentPoolIds ?? []].flat();
  const pools = POOL_COLUMNS.flatMap(([column, field]) => {
    const poolSite = payload[field] ?? payload.siteId;
    return [
      [`${column}_id`, poolSite],
      [`${column}_tenant`, tenantOf(poolSite)],
    ];
  });
  return {
    site_id: payload.siteId,
    tenant_id: tenantOf(payload.siteId),
    ...Object.fromEntries(pools),
    content_pool_ids: contentPools,
    content_pool_tenants: contentPools.map(tenantOf),
    domains: payload.domains,
    aggregate_version: '1',
    updated_at: TEST_CLOCK.now(),
  };
});

function registryAnswer(text: string, values: readonly unknown[]): Row[] {
  const [first] = values;
  const rows =
    typeof first === 'string'
      ? REGISTRY_ROWS.filter((row) => row.tenant_id === first || String(row.site_id).toLowerCase() === first.toLowerCase())
      : REGISTRY_ROWS;
  const aliases = [...(/^SELECT (.*?) FROM/.exec(text)?.[1] ?? '').matchAll(/(\w+) AS (\w+)/g)];
  return rows.map((row) => ({ ...row, ...Object.fromEntries(aliases.map((m) => [m[2], row[m[1] ?? '']])) }));
}

function seedApp({ db, identity }: TestApp): void {
  identity.seedAccounts(...accountsForSeed(DEFAULT_PEOPLE_SEED));
  const tenants = Object.values(DEFAULT_PEOPLE_SEED);
  identity.seedGroups(
    ...tenants.flatMap((tenant) =>
      (tenant.groupNames ?? []).map((group) => ({
        UserID: group.group_id,
        GroupName: group.group_name,
        SiteID: group.site_id ?? '',
        isPublic: group.is_public === 1 ? (1 as const) : (0 as const),
        Perm: 0,
      })),
    ),
  );
  const seed: Record<string, Row[]> = Object.fromEntries(STORE_ONLY_TABLES.map((table) => [table, []]));
  for (const [table, field] of Object.entries(SEED_TABLES)) seed[table] = tenants.flatMap((tenant) => [...((tenant[field] ?? []) as readonly Row[])]);
  const store = createMemoryStore(seed);
  respondComputed(db);
  db.respond(/tenant_registry/, registryAnswer);
  db.respond((text) => store.answers(text), (text, values) => store.run(text, values));
}

function respondComputed(db: RecordingDb): void {
  db.respond(/pg_snapshot_xm(?:in|ax)\(/, [{ value: '1001' }]);
  db.respond(/\bto_regclass\(/, [{ outbox: true, inbox: true }]);
  db.respond(/^SELECT \(SELECT count\(\*\) FROM/, [{ unpublished: '0', held: '0' }]);
  db.respond(/^INSERT INTO people\.inbox /, [{}]);
  db.respond(/^INSERT INTO "people"\."migration_batch" /, (_text, values) => [{ batch_id: values[1] }]);
  db.respond(/^INSERT INTO "people"\."migration_watermark" /, (_text, values) => [
    { legacy_table: values[0], direction: values[1], snapshot_seq: String(values[2]), backup_lsn: values[3], finished_at: WATERMARK_FINISHED_AT },
  ]);
}

function asUser(actor: UserHeadersInput): () => Promise<Headers> {
  return () => userHeaders(actor);
}

function asService(caller: string, roles?: string[]): () => Promise<Headers> {
  return async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: SERVICE, ...(roles === undefined ? {} : { roles }) })}` });
}

async function asTasksInvoker(): Promise<Headers> {
  return { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` };
}

const MIGRATION = asService('migration', ['platform.migration']);
const OPERATOR = asService('operator', ['platform.operator']);

function send(method: HttpMethod, url: string, credentials?: () => Promise<Headers>, body?: string | Record<string, unknown>): () => Promise<Request> {
  return async () => ({
    method,
    url,
    headers: { ...(credentials === undefined ? {} : await credentials()), ...(typeof body === 'string' ? FORM : {}) },
    ...(body === undefined ? {} : { payload: body }),
  });
}

function record(body: unknown): Record<string, unknown> {
  expect(body).toBeTypeOf('object');
  return body as Record<string, unknown>;
}

function contractOperations(doc: OpenApiDoc): ContractOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const op = item[method] as Operation | undefined;
      return op === undefined ? [] : [{ method: method.toUpperCase() as HttpMethod, path, operationId: op.operationId ?? '', op }];
    }),
  );
}

const OPERATIONS = contractOperations(DOC);
const isUnserved = ({ op }: ContractOperation): boolean => Array.isArray(op.tags) && op.tags.includes(UNSERVED_TAG);
const SERVED_OPERATIONS = OPERATIONS.filter((operation) => !isUnserved(operation));

/** A Fastify url as an OpenAPI template: `::` to `:`, `:name` to `{name}`, a trailing `*` to `{path}`. */
function toTemplate(url: string): string {
  const literalColon = '\u0000';
  return url
    .replaceAll('::', literalColon)
    .replace(/:([A-Za-z_]\w*)(?:\([^)]*\))?/g, '{$1}')
    .replace(/\*$/, '{path}')
    .replaceAll(literalColon, ':');
}

function routeKey(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${toTemplate(route.url)}`;
}

function operationKey({ method, path, op }: ContractOperation): string {
  const fastifyPath = op['x-opt2-fastify-path'];
  return `${method} ${typeof fastifyPath === 'string' ? toTemplate(fastifyPath) : path}`;
}

function servedRoutes(routes: readonly RouteMatrixEntry[]): RouteMatrixEntry[] {
  const gets = new Set(routes.filter((route) => route.method === 'GET').map((route) => route.url));
  return routes.filter((route) => route.method !== 'HEAD' || !gets.has(route.url));
}

function diffRouteSets(routes: readonly RouteMatrixEntry[], operations: readonly ContractOperation[]): { missingInContract: string[]; missingInApp: string[] } {
  const registered = new Set(routes.map(routeKey));
  const declared = new Set(operations.map(operationKey));
  return {
    missingInContract: [...registered].filter((key) => !declared.has(key)).sort(),
    missingInApp: operations
      .filter((operation) => !registered.has(operationKey(operation)))
      .map((operation) => `${operation.operationId} (${operationKey(operation)})`)
      .sort(),
  };
}

function declarationMismatches(routes: readonly RouteMatrixEntry[], operations: readonly ContractOperation[]): string[] {
  return routes.flatMap((route) =>
    operations
      .filter((operation) => operationKey(operation) === routeKey(route))
      .filter(({ op }) => {
        const contracted = declaration(op['x-opt2-transport'], op['x-opt2-requires'], op['x-opt2-public']);
        return JSON.stringify(contracted) !== JSON.stringify(declaration(route.transport, route.requires, route.public));
      })
      .map((operation) => `${operation.operationId} ${routeKey(route)}`),
  );
}

function declaration(transport: unknown, requires: unknown, isPublic: unknown): Record<string, unknown> {
  return {
    transport,
    requires: Array.isArray(requires) ? [...(requires as string[])].sort() : null,
    public: isPublic === true,
  };
}

const SA = asUser(SITE_ADMIN_A);
const jsonApi = (family: (typeof LEGACY_FAMILIES)[number], rest: string): string => `/_api/${family}/v1${rest}`;

function legacyOk(method: string, check?: (data: Record<string, unknown>) => void): (answer: Answer) => void {
  return ({ res, body }) => {
    const envelope = record(body);
    expect(envelope).toMatchObject({ apiversion: 'v1', method });
    expect(res.headers.etag).toMatch(UPPERCASE_HEX);
    check?.(record(envelope.data));
  };
}

function legacyError(error: Record<string, string>): (answer: Answer) => void {
  return ({ body }) => expect(record(body).error).toMatchObject(error);
}

const SERVER_ERROR = legacyError({ code: 'server_error', message: 'Unhandled Exception' });
const NO_PERMISSION = legacyError({ code: 'invalid_request', message: 'Insufficient Account Permissions' });

const SHAPES = {
  SitelessRoot: { rest: `?method=findProperties&entityname=user&siteid=${SITE_A}`, method: 'findProperties' },
  Root: { rest: `/${SITE_A}?method=findNew&entityname=user`, method: 'findNew' },
  Segment: { rest: `/${SITE_A}/findNew?entityname=user`, method: 'findNew' },
  Item: { rest: `/${SITE_A}/user/properties`, method: 'findProperties' },
  Suffix: { rest: `/${SITE_A}/user/${SYSTEM_USER}/permissions?method=findProperties&entityname=user`, method: 'findProperties' },
} as const;

function jsonApiCases(): Record<string, Case[]> {
  const cases: Record<string, Case[]> = {};
  for (const family of LEGACY_FAMILIES) {
    for (const [shape, { rest, method }] of Object.entries(SHAPES)) {
      for (const verb of JSON_API_VERBS) {
        const id = `${family}${shape}${verb.charAt(0)}${verb.slice(1).toLowerCase()}`;
        cases[id] = [
          family === 'rest'
            ? { name: `answers ${verb} ${method} of a registered site with REST's sessionless server_error`, inject: send(verb, jsonApi(family, rest), SA), status: 500, verify: SERVER_ERROR }
            : { name: `answers ${verb} ${method} through the ${family} family`, inject: send(verb, jsonApi(family, rest), SA), status: 200, verify: legacyOk(method) },
        ];
      }
    }
  }
  return cases;
}

const USER_SAVE = `userid=${MODULE_USER}&fname=Morgan&lname=Modular&username=module_user_a&${TOKEN_FIELDS}`;
const ADVANCED_CRITERIA = 'param=1&paramField1=tusers.lname%5Evarchar&paramRelationship1=and&paramCriteria1=System&paramCondition1=Contains';
const ADMIN_UPDATE = `userid=${MODULE_USER}&siteid=${SITE_A}&type=2&action=Update&fname=Morgan&lname=Modular&username=module_user_a&email=module_user_a@tenant-a.opt2.test&ispublic=0&${TOKEN_FIELDS}`;
const ARCHIVE_FIELDS = `effectiveFrom=${ARCHIVE_EFFECTIVE_FROM}&${TOKEN_FIELDS}`;
const archivePath = (userId: string, siteId: string): string => `/legacy-fixtures/cfml/api.cfm/people/persons/${userId}/archive?siteid=${siteId}`;
const POOL_STRANGER = 'A0000000-0000-0000-00000000000000FF';
const CURRENT_USER_QUERY = `siteid=${SITE_A}&endpoint=${encodeURIComponent(`http://localhost/index.cfm/_api/json/v1/${SITE_A}`)}&adminpath=${encodeURIComponent('http://localhost/admin')}`;
const FAVORITE_COLUMNS = FAVORITE.columns.filter(({ name }) => name !== 'tenant_id').map(({ name, type }) => ({ name, type }));
const UMBRELLA_MEMBERS = (DEFAULT_PEOPLE_SEED[TENANT_UMBRELLA.tenantId]?.groupNames ?? [])[0];

const rejectedUsername = (ctx: TestApp): void => ctx.identity.setPrepareErrors(MODULE_USER, { username: USERNAME_TAKEN });
const unreachableIdentity = (ctx: TestApp): void => ctx.identity.setUnreachable(true);

function csvDownload(content: string): (answer: Answer) => void {
  return ({ res, body }) => {
    expect(String(res.headers['content-type'])).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment;filename=users.csv');
    expect(String(body)).toContain(content);
  };
}

function listsUser(userId: string): (answer: Answer) => void {
  return ({ body }) => expect((record(body).items as Array<{ UserID: string }>).map((row) => row.UserID)).toContain(userId);
}

function siteChangedEnvelope(): TenantlessEnvelope {
  const payload = registryPayloads().find((site) => site.siteId === SITE_A);
  return testEnvelope({ topic: 'programs-sites.site.changed.v1', tenantId: TENANT_A.tenantId, aggregateId: SITE_A, aggregateVersion: 1, payload });
}

function groupChangedEnvelope(): TenantlessEnvelope {
  const groupId = String(UMBRELLA_MEMBERS?.group_id);
  return testEnvelope({
    topic: 'identity.group.changed.v1',
    tenantId: TENANT_UMBRELLA.tenantId,
    aggregateId: groupId,
    aggregateVersion: 2,
    payload: { groupId, siteId: TENANT_UMBRELLA.siteId, groupName: 'Members', type: 1, isPublic: 1, poolTenantId: TENANT_UMBRELLA.tenantId, deleted: false },
  });
}

function writesTo(ctx: TestApp, table: string): number {
  return ctx.db.writes().filter(({ text }) => text.includes(`"people"."${table}"`) || text.includes(`people.${table}`)).length;
}

const JSON_API_CASES = jsonApiCases();

function jsonApiOperation(operationId: string, ...extra: Case[]): Case[] {
  return [...(JSON_API_CASES[operationId] ?? []), ...extra];
}

const CASES: Record<string, Case[]> = {
  ...JSON_API_CASES,
  jsonItemGet: jsonApiOperation(
    'jsonItemGet',
    {
      name: 'reads a tenant-a user as findOne, with its identity account',
      inject: send('GET', jsonApi('json', `/${SITE_A}/user/${SYSTEM_USER}`), SA),
      status: 200,
      verify: legacyOk('findOne', (data) => expect(data).toMatchObject({ userid: SYSTEM_USER, username: 'system_user_a', siteid: SITE_A })),
    },
    {
      name: 'reads a tenant-a address as findOne',
      inject: send('GET', jsonApi('json', `/${SITE_A}/address/${HOME_ADDRESS}`), SA),
      status: 200,
      verify: legacyOk('findOne', (data) => expect(data).toMatchObject({ addressid: HOME_ADDRESS, userid: SYSTEM_USER, isprimary: 1 })),
    },
    {
      name: 'answers an entity people does not own with the legacy 404 envelope',
      inject: send('GET', jsonApi('json', `/${SITE_A}/content/${SYSTEM_USER}`), SA),
      status: 404,
      verify: legacyError({ code: 'invalid_request', message: 'Invalid method call' }),
    },
    {
      name: 'refuses a siteid other than the token site with the legacy 403',
      inject: send('GET', jsonApi('json', `/${SITE_A}/user/${SYSTEM_USER}?siteid=tenant-b`), SA),
      status: 403,
      verify: NO_PERMISSION,
    },
    {
      name: 'answers the legacy 503 for a user read while identity is unreachable',
      inject: send('GET', jsonApi('json', `/${SITE_A}/user/${SYSTEM_USER}`), SA),
      setup: unreachableIdentity,
      status: 503,
      verify: SERVER_ERROR,
    },
  ),
  ajaxItemGet: jsonApiOperation('ajaxItemGet', {
    name: 'reads a tenant-a user as findOne through the ajax family',
    inject: send('GET', jsonApi('ajax', `/${SITE_A}/user/${SYSTEM_USER}`), SA),
    status: 200,
    verify: legacyOk('findOne', (data) => expect(data.userid).toBe(SYSTEM_USER)),
  }),
  restItemGet: jsonApiOperation(
    'restItemGet',
    {
      name: 'answers a REST user read of a registered site with the sessionless server_error',
      inject: send('GET', jsonApi('rest', `/${SITE_A}/user/${SYSTEM_USER}`), SA),
      status: 500,
      verify: SERVER_ERROR,
    },
    {
      name: 'refuses an anonymous REST user read with 401 and its challenge',
      inject: send('GET', jsonApi('rest', `/${SITE_A}/user/${SYSTEM_USER}`)),
      status: 401,
      verify: (answer) => {
        NO_PERMISSION(answer);
        expect(answer.res.headers['www-authenticate']).toBeDefined();
      },
    },
  ),
  jsonSegmentGet: jsonApiOperation(
    'jsonSegmentGet',
    {
      name: 'lists the tenant-a users as findAll',
      inject: send('GET', jsonApi('json', `/${SITE_A}/user`), SA),
      status: 200,
      verify: legacyOk('findAll', (data) => expect((data.items as unknown[]).length).toBeGreaterThan(0)),
    },
    {
      name: "reads two of tenant-a's pooled members as findMany",
      inject: send('GET', jsonApi('json', `/${SITE_A}/user?id=${POOLED_MEMBER_PERSON.userid},${ARCHIVE_PERSON.userid}`), SA),
      status: 200,
      verify: legacyOk('findMany', (data) =>
        expect((data.items as Array<{ userid: string }>).map((item) => item.userid).sort()).toEqual([ARCHIVE_PERSON.userid, POOLED_MEMBER_PERSON.userid].sort()),
      ),
    },
  ),
  jsonSegmentPost: jsonApiOperation(
    'jsonSegmentPost',
    {
      name: 'saves a tenant-a user without a photo once identity accepts the CSRF token',
      inject: send('POST', jsonApi('json', `/${SITE_A}/user`), SA, USER_SAVE),
      status: 200,
      verify: legacyOk('save', (data) => expect(data).toMatchObject({ userid: MODULE_USER, lname: 'Modular', errors: {} })),
    },
    {
      name: 'answers a save identity rejects with the legacy 403 carrying the errors',
      inject: send('POST', jsonApi('json', `/${SITE_A}/user`), SA, USER_SAVE),
      setup: rejectedUsername,
      status: 403,
      verify: ({ body }, ctx) => {
        expect(record(record(body).data).errors).toMatchObject({ username: USERNAME_TAKEN });
        expect(writesTo(ctx, 'person')).toBe(0);
      },
    },
    {
      name: 'refuses an anonymous session save with the legacy 401 authorization error',
      inject: send('POST', jsonApi('json', `/${SITE_A}/user`), asUser(ANONYMOUS_SESSION), `userid=${SYSTEM_USER}&fname=Anon&${TOKEN_FIELDS}`),
      status: 401,
      verify: NO_PERMISSION,
    },
    {
      name: 'rejects a save whose CSRF token identity refuses as invalidTokens, writing nothing',
      inject: send('POST', jsonApi('json', `/${SITE_A}/user`), SA, USER_SAVE),
      setup: (ctx) => ctx.identity.csrf.rejectAll(),
      status: 400,
      verify: (answer, ctx) => {
        legacyError({ code: 'invalid_request', message: 'Invalid CSRF tokens' })(answer);
        expect(writesTo(ctx, 'person')).toBe(0);
      },
    },
    {
      name: 'saves a tenant-a address',
      inject: send('POST', jsonApi('json', `/${SITE_A}/address`), SA, `addressid=${HOME_ADDRESS}&userid=${SYSTEM_USER}&addressname=Home&city=Lakeview&${TOKEN_FIELDS}`),
      status: 200,
      verify: legacyOk('save', (data) => expect(data).toMatchObject({ addressid: HOME_ADDRESS, city: 'Lakeview' })),
    },
  ),
  jsonItemDelete: jsonApiOperation(
    'jsonItemDelete',
    {
      name: 'withholds an address delete with the legacy 503, as legacy serves it',
      inject: send('DELETE', jsonApi('json', `/${SITE_A}/address/${HOME_ADDRESS}`), SA, TOKEN_FIELDS),
      status: 503,
      verify: (answer, ctx) => {
        SERVER_ERROR(answer);
        expect(writesTo(ctx, 'user_address')).toBe(0);
      },
    },
    {
      name: 'withholds a user delete with the legacy 503, as legacy serves it',
      inject: send('DELETE', jsonApi('json', `/${SITE_A}/user/${SYSTEM_USER}`), SA, TOKEN_FIELDS),
      status: 503,
      verify: (answer, ctx) => {
        SERVER_ERROR(answer);
        expect(writesTo(ctx, 'person')).toBe(0);
      },
    },
  ),
  restSegmentPost: jsonApiOperation('restSegmentPost', {
    name: 'refuses an anonymous REST save with the legacy 401',
    inject: send('POST', jsonApi('rest', `/${SITE_A}/user`), undefined, 'fname=Anon'),
    status: 401,
    verify: NO_PERMISSION,
  }),
  getPersonArchive: [
    {
      name: "reads tenant-b's stored archive record of a former user",
      inject: send('GET', archivePath(ARCHIVED_PERSON_B.userid, 'tenant-b'), asUser(OTHER_TENANT)),
      status: 200,
      verify: legacyOk('people.persons.archive', (data) => expect(data).toMatchObject({ personid: ARCHIVED_PERSON_B.userid, siteid: 'tenant-b' })),
    },
  ],
  archivePerson: [
    {
      name: 'archives a pooled tenant-a member from the effective day',
      inject: send('POST', archivePath(ARCHIVE_PERSON.userid, SITE_A), SA, ARCHIVE_FIELDS),
      status: 200,
      verify: legacyOk('people.persons.archive', (data) => {
        expect(Object.keys(data).sort()).toEqual(['archivedat', 'archiveid', 'effectivefrom', 'personid', 'siteid']);
        expect(data).toMatchObject({ personid: ARCHIVE_PERSON.userid, siteid: TENANT_UMBRELLA.siteId, effectivefrom: `${ARCHIVE_EFFECTIVE_FROM}T00:00:00` });
      }),
    },
    {
      name: 'answers badRequest for a person already archived',
      inject: send('POST', archivePath(ARCHIVED_PERSON_B.userid, 'tenant-b'), asUser(OTHER_TENANT), ARCHIVE_FIELDS),
      status: 400,
      verify: legacyError({ code: 'invalid_request', message: 'Bad Request' }),
    },
    {
      name: 'answers badRequest when a concurrent archive wins the unique constraint',
      inject: send('POST', archivePath(ARCHIVE_PERSON.userid, SITE_A), SA, ARCHIVE_FIELDS),
      setup: (ctx) =>
        ctx.db.respond(/^INSERT INTO "people"\."person_archive" /, () => {
          throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint: ARCHIVE_UNIQUE_CONSTRAINT });
        }),
      status: 400,
      verify: legacyError({ code: 'invalid_request', message: 'Bad Request' }),
    },
  ],
  listUserGroups: [
    {
      name: "lists tenant-a's private-pool groups for its site admin",
      inject: send('GET', `/v1/users/groups?siteid=${SITE_A}&ispublic=0`, SA),
      status: 200,
      verify: ({ body }) => expect((record(body).items as Array<{ GroupName: string }>).map((group) => group.GroupName)).toContain('Admin'),
    },
  ],
  listUsers: [
    {
      name: "lists tenant-a's system users",
      inject: send('GET', `/v1/users?siteid=${SITE_A}&ispublic=0`, SA),
      status: 200,
      verify: ({ body }) => expect((record(body).items as unknown[]).length).toBe(TENANT_A_SYSTEM_USERS.length),
    },
    { name: 'refuses an anonymous caller with the legacy 401', inject: send('GET', `/v1/users?siteid=${SITE_A}`), status: 401, verify: NO_PERMISSION },
    { name: 'refuses an editor without the Users module with the legacy 403', inject: send('GET', `/v1/users?siteid=${SITE_A}`, asUser(EDITOR)), status: 403, verify: NO_PERMISSION },
  ],
  searchUsers: [{ name: 'finds the tenant-a user named Sydney', inject: send('GET', `/v1/users/search?siteid=${SITE_A}&ispublic=0&search=Sydney`, SA), status: 200, verify: listsUser(SYSTEM_USER) }],
  getAdvancedSearch: [{ name: 'runs the stored advanced search', inject: send('GET', `/v1/users/advanced-search?siteid=${SITE_A}&ispublic=0`, SA), status: 200, verify: listsUser(SYSTEM_USER) }],
  setAdvancedSearch: [
    {
      name: 'stores and runs an advanced search on last name',
      inject: send('POST', `/v1/users/advanced-search?siteid=${SITE_A}&ispublic=0`, SA, ADVANCED_CRITERIA),
      status: 200,
      verify: listsUser(SYSTEM_USER),
    },
  ],
  downloadAdvancedSearchCsv: [
    { name: 'downloads the advanced search as users.csv', inject: send('GET', `/v1/users/advanced-search.csv?siteid=${SITE_A}&ispublic=0`, SA), status: 200, verify: csvDownload('system_user_a') },
  ],
  downloadUsersCsv: [{ name: 'downloads the user list as users.csv', inject: send('GET', `/v1/users/download?siteid=${SITE_A}&ispublic=0`, SA), status: 200, verify: csvDownload('system_user_a') }],
  getUserEdit: [
    {
      name: 'reads the Edit User data of a tenant-a user',
      inject: send('GET', `/v1/users/edit?siteid=${SITE_A}&userid=${SYSTEM_USER}`, SA),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ isNew: false, user: { UserID: SYSTEM_USER, UserName: 'system_user_a' } }),
    },
    { name: 'refuses a public member with the legacy 403', inject: send('GET', `/v1/users/edit?siteid=tenant-b&userid=${SYSTEM_USER}`, asUser(MEMBER_B)), status: 403, verify: NO_PERMISSION },
    {
      name: 'answers the legacy 503 while identity is unreachable',
      inject: send('GET', `/v1/users/edit?siteid=${SITE_A}&userid=${SYSTEM_USER}`, SA),
      setup: unreachableIdentity,
      status: 503,
      verify: SERVER_ERROR,
    },
  ],
  updateUser: [
    {
      name: 'updates a tenant-a user and answers the legacy redirect',
      inject: send('POST', `/v1/users:update?userid=${MODULE_USER}`, SA, ADMIN_UPDATE),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ written: true, errors: {}, redirect: { action: 'cUsers.listusers' } }),
    },
    {
      name: 'answers the errored values without a redirect when identity rejects the user name',
      inject: send('POST', `/v1/users:update?userid=${MODULE_USER}`, SA, ADMIN_UPDATE),
      setup: rejectedUsername,
      status: 200,
      verify: ({ body }) => {
        expect(record(body)).toMatchObject({ written: false, errors: { username: USERNAME_TAKEN }, userBean: { Lname: 'Modular' } });
        expect(record(body).redirect).toBeUndefined();
      },
    },
  ],
  getAddressEdit: [
    {
      name: 'reads the Edit Address data of a stored address',
      inject: send('GET', `/v1/users/address?siteid=${SITE_A}&userid=${SYSTEM_USER}&addressid=${HOME_ADDRESS}`, SA),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ isNew: false, user: { UserID: SYSTEM_USER } }),
    },
  ],
  updateAddress: [
    {
      name: 'updates an address and redirects to the user',
      inject: send(
        'POST',
        `/v1/users/addresses:update?userid=${SYSTEM_USER}&siteid=${SITE_A}`,
        SA,
        `userid=${SYSTEM_USER}&siteid=${SITE_A}&addressid=${HOME_ADDRESS}&action=Update&addressname=Home&city=Lakeview&${TOKEN_FIELDS}`,
      ),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ written: true, redirect: { action: 'cUsers.edituser', params: { userid: SYSTEM_USER } } }),
    },
  ],
  routeUser: [
    {
      name: 'answers the user list redirect',
      inject: send('GET', `/v1/users/route?siteid=${SITE_A}&ispublic=0&userid=${SYSTEM_USER}`, SA),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ redirect: { action: 'cUsers.listusers' } }),
    },
  ],
  getProfile: [
    {
      name: "reads the signed-in user's profile",
      inject: send('GET', '/v1/profile', asUser(SYSTEM_USER_A)),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ user: { UserID: SYSTEM_USER, UserName: 'system_user_a' } }),
    },
  ],
  updateProfile: [
    {
      name: "updates the signed-in user's profile and redirects home",
      inject: send('POST', '/v1/profile:update', asUser(SYSTEM_USER_A), `fname=Sydney&lname=Systems&email=system_user_a@tenant-a.opt2.test&username=system_user_a&${TOKEN_FIELDS}`),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ written: true, errors: {}, redirect: { action: 'home.redirect' } }),
    },
  ],
  listUsersV2: [{ name: "pages tenant-a's system users", inject: send('GET', `/v2/users?siteid=${SITE_A}&ispublic=0`, SA), status: 200, verify: listsUser(SYSTEM_USER) }],
  searchUsersV2: [{ name: 'pages the search for Sydney', inject: send('GET', `/v2/users/search?siteid=${SITE_A}&ispublic=0&search=Sydney`, SA), status: 200, verify: listsUser(SYSTEM_USER) }],
  getAdvancedSearchV2: [{ name: 'pages the stored advanced search', inject: send('GET', `/v2/users/advanced-search?siteid=${SITE_A}&ispublic=0`, SA), status: 200, verify: listsUser(SYSTEM_USER) }],
  setAdvancedSearchV2: [
    {
      name: 'stores and pages an advanced search on last name',
      inject: send('POST', `/v2/users/advanced-search?siteid=${SITE_A}&ispublic=0`, SA, ADVANCED_CRITERIA),
      status: 200,
      verify: listsUser(SYSTEM_USER),
    },
  ],
  readCurrentUser: [
    {
      name: "reads the session user for identity's findCurrentUser",
      inject: send('GET', `/internal/v1/users/current?${CURRENT_USER_QUERY}`, async () => ({ ...(await userHeaders(SYSTEM_USER_A)), ...(await asService('identity')()) })),
      status: 200,
      verify: ({ body }) => expect(record(record(body).data).userid).toBe(SYSTEM_USER),
    },
  ],
  readPoolUser: [
    {
      name: "reads a tenant-a pool user for e-signature's signer check",
      inject: send('GET', `/internal/v1/users/pool-user?siteid=${SITE_A}&userid=${SYSTEM_USER}`, async () => ({ ...(await userHeaders(SYSTEM_USER_A)), ...(await asService('e-signature')()) })),
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ userid: SYSTEM_USER, siteid: SITE_A, type: 2 }),
    },
    {
      name: 'answers the legacy 404 for an id no pool person holds',
      inject: send('GET', `/internal/v1/users/pool-user?siteid=${SITE_A}&userid=${POOL_STRANGER}`, async () => ({ ...(await userHeaders(SYSTEM_USER_A)), ...(await asService('e-signature')()) })),
      status: 404,
    },
  ],
  migrationApply: [
    {
      name: 'applies an empty tusersfavorites batch',
      inject: send('POST', '/internal/v1/migration/apply', MIGRATION, {
        batchId: 'contract-batch-1',
        origin: 'backfill',
        legacyTable: 'tusersfavorites',
        siteId: SITE_A,
        columns: FAVORITE_COLUMNS,
        rows: [],
      }),
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ batchId: 'contract-batch-1', duplicate: false, applied: 0, skipped: 0 }),
    },
  ],
  migrationExport: [
    {
      name: "exports tenant-a's persons in canonical legacy form",
      inject: send('GET', `/internal/v1/migration/export?unit=people.person&siteId=${SITE_A}`, MIGRATION),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ unit: 'people.person', tenantId: TENANT_A.tenantId }),
    },
  ],
  migrationChanges: [
    {
      name: "reads tenant-a's changelog page",
      inject: send('GET', `/internal/v1/migration/changes?siteId=${SITE_A}`, MIGRATION),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ rows: [], complete: true }),
    },
  ],
  migrationPosition: [
    {
      name: 'reports the write position and the drain counts',
      inject: send('GET', '/internal/v1/migration/position', MIGRATION),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ owner: SERVICE, outbox: { unpublished: 0 } }),
    },
  ],
  migrationWatermarkGet: [
    {
      name: 'lists the forward tusers watermark',
      inject: send('GET', '/internal/v1/migration/watermark?legacyTable=tusers&direction=forward', MIGRATION),
      setup: (ctx) =>
        ctx.db.respond(/FROM "people"\."migration_watermark"/, [
          { legacy_table: 'tusers', direction: 'forward', snapshot_seq: '3', backup_lsn: '42', finished_at: WATERMARK_FINISHED_AT },
        ]),
      status: 200,
      verify: ({ body }) => expect(body).toEqual([expect.objectContaining({ legacyTable: 'tusers', direction: 'forward' })]),
    },
  ],
  migrationWatermarkPost: [
    {
      name: 'records a forward tusers watermark',
      inject: send('POST', '/internal/v1/migration/watermark', MIGRATION, { legacyTable: 'tusers', direction: 'forward', snapshotSeq: 3, backupLsn: '42', finishedAt: '2026-06-30 12:00:00' }),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ legacyTable: 'tusers', direction: 'forward' }),
    },
  ],
  migrationGate: [
    {
      name: "reads the person unit's gate",
      inject: send('POST', '/internal/v1/migration/gate', MIGRATION, { op: 'status', units: ['people.person'] }),
      status: 200,
      verify: ({ body }) => expect(record(body).units).toEqual([{ unit: 'people.person', state: 'open', holderId: null, phase: 'quiet' }]),
    },
  ],
  pushSiteChanged: [
    {
      name: "applies tenant-a's site.changed delivery to the registry and acks it",
      push: { subscription: SITE_CHANGED_SUBSCRIPTION, envelope: siteChangedEnvelope },
      status: 204,
      verify: (_answer, ctx) => {
        expect(writesTo(ctx, 'tenant_registry')).toBeGreaterThan(0);
        expect(ctx.publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toEqual([]);
      },
    },
  ],
  pushGroupChanged: [
    {
      name: "stores umbrella's Members group name and acks the delivery",
      push: { subscription: GROUP_NAME_SUBSCRIPTION, envelope: groupChangedEnvelope },
      status: 204,
      verify: (_answer, ctx) => {
        expect(writesTo(ctx, 'group_name')).toBeGreaterThan(0);
        expect(ctx.publisher.deadLetters(GROUP_NAME_SUBSCRIPTION)).toEqual([]);
      },
    },
  ],
  outboxSweep: [
    {
      name: 'creates the next sweep task, then sweeps every registered tenant',
      inject: send('POST', '/internal/v1/outbox/sweep', asTasksInvoker, {
        queue: SWEEP_QUEUE,
        name: `${SWEEP_QUEUE}-${String(Math.floor(TEST_CLOCK.now().getTime() / 1000))}`,
        tenantId: null,
      }),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ failed: 0, tenants: REGISTRY_ROWS.length }),
    },
  ],
  queuePause: [
    {
      name: 'pauses the outbox-sweep queue for the operator',
      inject: send('POST', `/internal/v1/task-queues/${SWEEP_QUEUE}/pause`, OPERATOR),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ queue: SWEEP_QUEUE, service: SERVICE, paused: true }),
    },
  ],
  queueResume: [
    {
      name: 'resumes the outbox-sweep queue for the migration service',
      inject: send('POST', `/internal/v1/task-queues/${SWEEP_QUEUE}/resume`, MIGRATION),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ queue: SWEEP_QUEUE, service: SERVICE, paused: false }),
    },
  ],
  queueEnsure: [
    {
      name: 'finds the live outbox-sweep chain task',
      inject: send('POST', `/internal/v1/task-queues/${SWEEP_QUEUE}/ensure`, OPERATOR),
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ queue: SWEEP_QUEUE, ensured: { created: false, reason: 'live' } }),
    },
  ],
  healthz: [{ name: 'answers the liveness probe anonymously', inject: send('GET', '/healthz'), status: 200, verify: ({ body }) => expect(body).toEqual({ status: 'ok' }) }],
};

async function addressed(c: Case): Promise<{ request?: Request; method: HttpMethod; path: string }> {
  if (c.push !== undefined) return { method: 'POST', path: `/internal/v1/events/${c.push.subscription}` };
  if (c.inject === undefined) throw new TypeError(`Case ${c.name} sends nothing`);
  const request = await c.inject();
  return { request, method: request.method, path: request.url.split('?')[0] ?? request.url };
}

async function sendCase(ctx: TestApp, c: Case): Promise<Answer> {
  const { request, method, path } = await addressed(c);
  const res = c.push === undefined ? await ctx.app.inject(request as Request) : await pushTo(ctx.app, c.push.subscription, c.push.envelope());
  const contentType = res.headers['content-type'];
  const json = typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType) && res.body !== '';
  const body: unknown = json ? JSON.parse(res.body) : res.body === '' ? undefined : res.body;
  expect(res.statusCode, res.body.slice(0, 400)).toBe(c.status);
  assertResponseMatchesOpenApi(DOC, { method, path, status: res.statusCode, contentType, body });
  return { res, body };
}

const WIRE_OPERATIONS = OPERATIONS.filter(({ path }) => path.startsWith('/_api/'));
const routeKeysOf = ({ op }: ContractOperation): string[] => (op['x-opt2-route-keys'] as string[] | undefined) ?? [];
const familyOf = ({ path }: ContractOperation): (typeof LEGACY_FAMILIES)[number] => path.split('/')[2] as (typeof LEGACY_FAMILIES)[number];
const READ_OPERATIONS = /^(?:find[a-z]+|validate|~[a-z0-9_]+|http-get)$/;
const WRITE_KEYS: readonly string[] = ['user.save', 'address.save', 'address.delete'];

function foreignKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const match = /^(?:api|rest):(user|address)\.([a-z0-9_~-]+)$/.exec(key);
    if (match === null) return true;
    return !READ_OPERATIONS.test(match[2] ?? '') && !WRITE_KEYS.includes(`${match[1]}.${match[2]}`);
  });
}

const FIND_ONE_IDS: Readonly<Record<string, string>> = { user: SYSTEM_USER, address: HOME_ADDRESS };
const FIND_QUERY: Readonly<Record<string, Record<string, string>>> = { user: { lname: 'System' }, address: { city: 'Springfield' } };

function keyedRequest(base: string, body: string): RouteKeyRequest {
  const [entity = '', operation = ''] = body.split('.');
  const path = `${base}/${entity}`;
  const id = FIND_ONE_IDS[entity] ?? '';
  const get = (at: string, query: Record<string, string> = {}): RouteKeyRequest => ({ method: 'GET', path: at, query, headers: {} });
  switch (operation) {
    case 'findall':
      return get(path);
    case 'findmany':
      return get(path, { id: `${id},${id}` });
    case 'findnew':
      return get(`${path}/new`);
    case 'findone':
      return get(`${path}/${id}`);
    case 'findpermissions':
      return get(`${path}/${id}/permissions`);
    case 'findproperties':
      return get(`${path}/properties`);
    case 'findquery':
      return get(path, FIND_QUERY[entity] ?? {});
    case 'save':
      return { method: 'POST', path, query: {}, headers: {} };
    case 'validate':
      return get(`${base}/validate`, { entityname: entity, data: '{}' });
    case '~pollstate':
      return get(`${path}/pollState`);
    default:
      throw new TypeError(`No request form keys ${body}`);
  }
}

const ROUTE_KEY_OPTIONS = {
  siteExists: (siteId: string) => siteId.toLowerCase() === SITE_A,
  entityRemoteFunctions: { user: ['pollState'] },
  entityRelationships: { address: ['user', 'site'] },
  entityPrimaryKeys: { address: 'addressid' },
};

const SERVED_KEY_ROWS = [
  ...new Map(
    WIRE_OPERATIONS.flatMap((operation) => {
      const base = `/_api/${familyOf(operation)}/v1/${SITE_A}`;
      return routeKeysOf(operation).map((key): [string, { key: string; base: string }] => [`${key} ${base}`, { key, base }]);
    }),
  ).values(),
];

function isUnservedAnswer(res: InjectResponse): boolean {
  if (res.statusCode !== 404) return false;
  return (JSON.parse(res.body) as { error?: { message?: string } }).error?.message === 'Invalid method call';
}

describe('contract document', () => {
  it('is OpenAPI 3.1.0 version 1.0.0 at the pinned source SHA', () => {
    expect([DOC.openapi, DOC.info.version, DOC.info['x-source-sha']]).toEqual(['3.1.0', '1.0.0', PIN.sha]);
  });

  it('names identity and strategies-content as the services people calls', () => {
    expect(DOC['x-opt2-calls']).toEqual(['identity', 'strategies-content']);
  });

  it('gives every operation a unique operationId, a known transport and exactly one of x-opt2-requires and x-opt2-public', () => {
    const ids = OPERATIONS.map(({ operationId }) => operationId);
    expect(ids.filter((id) => id === '')).toEqual([]);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    const problems = OPERATIONS.flatMap(({ method, path, op }) => {
      const requires = op['x-opt2-requires'];
      const isPublic = op['x-opt2-public'] === true;
      const found: string[] = [];
      if (!TRANSPORTS.includes(String(op['x-opt2-transport']))) found.push(`${method} ${path}: transport ${String(op['x-opt2-transport'])}`);
      if ((requires === undefined) === !isPublic) found.push(`${method} ${path}: requires and public`);
      if (requires !== undefined && !(Array.isArray(requires) && requires.length > 0)) found.push(`${method} ${path}: empty requires`);
      return found;
    });
    expect(problems).toEqual([]);
  });
});

describe('registered routes', () => {
  let shared: TestApp;
  let routes: RouteMatrixEntry[];

  beforeAll(async () => {
    shared = await buildTestApp();
    await shared.app.ready();
    seedApp(shared);
    routes = servedRoutes(collectRouteMatrix(shared.app).routes);
  });

  afterAll(async () => {
    await shared?.close();
  });

  it('are exactly the contract operations, the unregistered favorites templates aside', () => {
    const { missingInContract, missingInApp } = diffRouteSets(routes, OPERATIONS);
    expect({ missingInContract, missingInApp }).toEqual({
      missingInContract: [],
      missingInApp: OPERATIONS.filter(isUnserved)
        .map((operation) => `${operation.operationId} (${operationKey(operation)})`)
        .sort(),
    });
    expect(OPERATIONS.filter(isUnserved)).toHaveLength(18);
  });

  it('each declare the roles, public flag and transport of every operation they serve', () => {
    expect(declarationMismatches(routes, SERVED_OPERATIONS)).toEqual([]);
  });

  it('take the managed transport and roles on the push, sweep, task and migration paths', () => {
    const managed = routes
      .filter(({ url }) => /^\/internal\/v1\/(?:events|outbox|tasks|migration)\//.test(url))
      .map(({ method, url, transport, requires }) => ({ route: `${method} ${url}`, transport, requires }));
    const expected = managed.map(({ route }) => {
      if (route.includes('/internal/v1/events/')) return { route, transport: 'pubsub-push', requires: ['service:pubsub-invoker'] };
      if (route.includes('/internal/v1/migration/')) return { route, transport: 'service', requires: ['platform.migration'] };
      return { route, transport: 'cloud-tasks', requires: ['service:tasks-invoker'] };
    });
    expect(managed).toEqual(expected);
    expect(managed.map(({ route }) => route).filter((route) => route.includes('/events/')).sort()).toEqual(
      [`POST /internal/v1/events/${GROUP_NAME_SUBSCRIPTION}`, `POST /internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`].sort(),
    );
    expect(managed.some(({ route }) => route === 'POST /internal/v1/outbox/sweep')).toBe(true);
  });

  it('report an extra route, a removed operation and a changed role', () => {
    const extra: RouteMatrixEntry = { method: 'GET', url: '/v1/users/:userId/extra', transport: 'service', requires: ['s2'], siteCheck: true };
    expect(diffRouteSets([...routes, extra], SERVED_OPERATIONS).missingInContract).toEqual(['GET /v1/users/{userId}/extra']);

    const trimmed = structuredClone(DOC);
    delete trimmed.paths['/healthz']?.get;
    expect(diffRouteSets(routes, contractOperations(trimmed)).missingInContract).toEqual(['GET /healthz']);
    expect(diffRouteSets(routes.filter(({ url }) => url !== '/healthz'), SERVED_OPERATIONS).missingInApp).toEqual(['healthz (GET /healthz)']);

    const widened = routes.map((route) => (routeKey(route) === 'GET /v1/users' ? { ...route, requires: [...(route.requires ?? []), 'system-user'] } : route));
    expect(declarationMismatches(widened, SERVED_OPERATIONS)).toEqual(['listUsers GET /v1/users']);
  });

  it('include every expected operation family', () => {
    const ids = new Set(OPERATIONS.map(({ operationId }) => operationId));
    const shapes = ['SitelessRoot', 'Root', 'Segment', 'Item', 'Suffix'];
    const expected = [
      ...LEGACY_FAMILIES.flatMap((family) => shapes.flatMap((shape) => ['Get', 'Post', 'Put', 'Delete'].map((verb) => `${family}${shape}${verb}`))),
      ...['archivePerson', 'getPersonArchive'],
      ...['listUserGroups', 'listUsers', 'searchUsers', 'getAdvancedSearch', 'setAdvancedSearch', 'downloadAdvancedSearchCsv', 'downloadUsersCsv'],
      ...['getUserEdit', 'updateUser', 'getAddressEdit', 'updateAddress', 'routeUser', 'getProfile', 'updateProfile'],
      ...['listUsersV2', 'searchUsersV2', 'getAdvancedSearchV2', 'setAdvancedSearchV2', 'readCurrentUser', 'readPoolUser'],
      ...['Apply', 'Export', 'Changes', 'Position', 'WatermarkGet', 'WatermarkPost', 'Gate'].map((name) => `migration${name}`),
      ...['pushSiteChanged', 'pushGroupChanged', 'outboxSweep', 'queuePause', 'queueResume', 'queueEnsure', 'healthz'],
    ];
    expect(expected.filter((id) => !ids.has(id))).toEqual([]);
  });
});

describe('JSON API route keys', () => {
  let keyed: TestApp;

  beforeAll(async () => {
    keyed = await buildTestApp();
    seedApp(keyed);
  });

  afterAll(async () => {
    await keyed?.close();
  });

  it('are declared on every /_api/ operation, canonical, and on no other operation but the favorites and fixture ones', () => {
    expect(WIRE_OPERATIONS.filter((operation) => routeKeysOf(operation).length === 0).map(({ operationId }) => operationId)).toEqual([]);
    const keys = WIRE_OPERATIONS.flatMap(routeKeysOf);
    expect(keys.filter((key) => key !== normaliseRouteKey(key))).toEqual([]);
    const elsewhere = OPERATIONS.filter((operation) => !WIRE_OPERATIONS.includes(operation) && routeKeysOf(operation).length > 0);
    expect(elsewhere.filter((operation) => !isUnserved(operation) && !operation.path.startsWith('/legacy-fixtures/')).map(({ operationId }) => operationId)).toEqual([]);
  });

  it('take the family the shared route key gives each JSON API path', () => {
    const familyKeys = Object.fromEntries(
      LEGACY_FAMILIES.map((family) => [family, routeKeyForRequest({ method: 'GET', path: `/_api/${family}/v1/${SITE_A}/user/new`, query: {}, headers: {} }, ROUTE_KEY_OPTIONS).family]),
    );
    expect(familyKeys).toEqual({ json: 'api', ajax: 'api', rest: 'rest' });
    const misfiled = WIRE_OPERATIONS.flatMap((operation) =>
      routeKeysOf(operation)
        .filter((key) => !key.startsWith(`${familyKeys[familyOf(operation)] ?? ''}:`))
        .map((key) => `${operation.operationId} ${key}`),
    );
    expect(misfiled).toEqual([]);
  });

  it('address only user and address, carry no variant, and write only by user.save and address.save', () => {
    const keys = [...new Set(WIRE_OPERATIONS.flatMap(routeKeysOf))];
    expect(foreignKeys(keys)).toEqual([]);
    expect(keys.filter((key) => /:(?:user\.(?:delete|http-delete)|group\.)/.test(key) || key.includes('{photo}'))).toEqual([]);
    expect(foreignKeys([...keys, 'api:group.save', 'rest:user.delete', 'api:user.save{photo}'])).toEqual(['api:group.save', 'rest:user.delete', 'api:user.save{photo}']);
  });

  it('list the withheld keys as excluded, never as served', () => {
    const problems = WIRE_OPERATIONS.flatMap((operation) => {
      const excluded = ((operation.op['x-opt2-route-keys-excluded'] as Array<{ key: string }> | undefined) ?? []).map(({ key }) => key);
      const prefix = routeKeysOf(operation)[0]?.split(':')[0] ?? '';
      const missing = ['user.delete', 'user.save{photo}', 'address.delete'].map((body) => `${prefix}:${body}`).filter((key) => !excluded.includes(key));
      const served = excluded.filter((key) => routeKeysOf(operation).includes(key));
      return [...missing, ...served].map((key) => `${operation.operationId} ${key}`);
    });
    expect(problems).toEqual([]);
  });

  it.each(SERVED_KEY_ROWS)('serves $key under $base', async ({ key, base }) => {
    const request = keyedRequest(base, key.slice(key.indexOf(':') + 1));
    expect(routeKeyForRequest(request, ROUTE_KEY_OPTIONS).key).toBe(key);
    const search = new URLSearchParams(request.query as Record<string, string>).toString();
    const res = await keyed.app.inject({
      method: request.method as HttpMethod,
      url: search === '' ? request.path : `${request.path}?${search}`,
      headers: await userHeaders(SITE_ADMIN_A),
    });
    expect(isUnservedAnswer(res), `${String(res.statusCode)} ${res.body.slice(0, 300)}`).toBe(false);
  });
});

describe('responses', () => {
  const rows = Object.entries(CASES).flatMap(([operationId, cases]) => cases.map((c) => ({ operationId, title: c.name, c })));

  it('cover every served contract operation and no other', () => {
    expect(Object.keys(CASES).sort()).toEqual(SERVED_OPERATIONS.map(({ operationId }) => operationId).sort());
  });

  it('give every operation a success but the REST family, whose registered sites answer server_error', () => {
    const withoutSuccess = Object.entries(CASES)
      .filter(([operationId]) => !operationId.startsWith('rest'))
      .filter(([, cases]) => !cases.some(({ status }) => status >= 200 && status < 300))
      .map(([operationId]) => operationId);
    expect(withoutSuccess).toEqual([]);
  });

  it('file each case under the operation its request resolves to', async () => {
    const misfiled: string[] = [];
    for (const { operationId, c } of rows) {
      const { method, path } = await addressed(c);
      const resolved = findOperation(DOC, method, path).operation.operationId;
      if (resolved !== operationId) misfiled.push(`${operationId}: ${c.name} resolves to ${String(resolved)}`);
    }
    expect(misfiled).toEqual([]);
  });

  let ctx: TestApp | undefined;

  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  it.each(rows)('$operationId $title', async ({ c }) => {
    const built = await buildTestApp();
    ctx = built;
    seedApp(built);
    c.setup?.(built);
    const answer = await sendCase(built, c);
    c.verify?.(answer, built);
  });
});
