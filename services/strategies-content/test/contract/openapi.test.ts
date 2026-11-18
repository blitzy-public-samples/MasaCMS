/** strategies-content against contracts/openapi.yaml: the document, every registered route's declaration, and responses through `app.inject`. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Roles, collectRouteMatrix, moduleRole, transportForPath, type RouteMatrixEntry } from '@opt2/platform/auth';
import { buildPushBody, encodeEnvelope, pushPath, type EventEnvelope } from '@opt2/platform/events';
import { WRITE_POSITION_HEADER_LC } from '@opt2/platform/migration-kit';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  poolTenantExpectation,
  pushTo,
  registryPayloads,
  testEnvelope,
  type InjectResponse,
} from '@opt2/platform/testing';
import {
  CONTENT_SUBSCRIPTIONS,
  GROUP_CHANGED_SUBSCRIPTION,
  GROUP_CHANGED_TOPIC,
  MEMBERSHIP_CHANGED_SUBSCRIPTION,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_SUBSCRIPTION,
  PERMISSION_CHANGED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
} from '../../src/events/consumers.js';
import { FEED_AUTO_IMPORT_PATH, PUBLISH_SCHEDULED_CHANGESETS_PATH } from '../../src/jobs/index.js';
import { mappings } from '../../src/migration/mappings/index.js';
import { CONTENT_FILES_BUCKET } from '../../src/migration/objects.js';
import { RATER_SAVE_PATH } from '../../src/routes/rater.js';
import {
  FAKE_XID,
  SERVICE,
  TEST_CLOCK,
  buildContentApp,
  buildTestApp,
  serviceHeaders,
  userHeaders,
  type ContentTestApp,
  type TestApp,
} from '../helpers/app.js';
import { FILE_BYTES, IDS, feedRow, seedMemoryStorage, seedRecordingDb } from '../helpers/seed.js';
import { contentHeaders, tasksHeaders } from '../helpers/tokens.js';

type Json = Record<string, unknown>;

interface OpenApiDoc {
  openapi: string;
  info: Json;
  paths: Record<string, Record<string, Json>>;
  components: { parameters: Record<string, Json> };
  'x-opt2-entity-access': Json;
}

/** One contract operation and its declaration, keyed `METHOD path`. */
interface ContractOperation {
  key: string;
  method: string;
  path: string;
  operationId: string;
  requires: unknown;
  public: unknown;
  transport: unknown;
  /** Its `x-opt2-route-keys` and `x-opt2-legacy-actions`. */
  legacyNames: string[];
  /** `METHOD path` keys of the routes serving it: each `x-opt2-fastify-path`, one or a list, in contract form, else `key`. */
  served: string[];
}

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;
const TRANSPORTS: readonly unknown[] = ['service', 'pubsub-push', 'cloud-tasks'];

/** Legacy-served, decision-list and halted actions this service must neither declare nor register. */
const NOT_BUILT = ['processAsyncObject', 'swagger', 'declareEntity', 'undeclareEntity', 'checkSchema', 'cropimage', 'rotateimage', 'flipimage', 'upload=image'];
const NOT_BUILT_NAMES = new RegExp(NOT_BUILT.join('|'), 'gi');
const NOT_BUILT_NAME = new RegExp(NOT_BUILT.join('|'), 'i');

const operationAt = (item: Record<string, Json>, verb: string): Json | undefined => item[verb];

const OPERATIONS: readonly ContractOperation[] = Object.entries(OPENAPI.paths).flatMap(([path, item]) =>
  HTTP_METHODS.flatMap((verb) => {
    const op = operationAt(item, verb);
    if (op === undefined) return [];
    const method = verb.toUpperCase();
    const names = [op['x-opt2-route-keys'], op['x-opt2-legacy-actions']].flatMap((list) => (Array.isArray(list) ? list.map(String) : []));
    const fastifyPath = op['x-opt2-fastify-path'] as string | string[] | undefined;
    return [
      {
        key: `${method} ${path}`,
        method,
        path,
        operationId: String(op.operationId),
        requires: op['x-opt2-requires'],
        public: op['x-opt2-public'],
        transport: op['x-opt2-transport'],
        legacyNames: names,
        served: fastifyPath === undefined ? [`${method} ${path}`] : [fastifyPath].flat().map((url) => `${method} ${contractPath(url)}`),
      },
    ];
  }),
);

/** Names of the `x-opt2-wildcard` path parameters of `template`'s path item and operations, `$ref`s resolved. */
function wildcardNames(template: string): Set<string> {
  const item = OPENAPI.paths[template] ?? {};
  const params = [item.parameters, ...HTTP_METHODS.map((verb) => operationAt(item, verb)?.parameters)].flatMap((list) =>
    Array.isArray(list) ? (list as Json[]) : [],
  );
  const resolved = params.map((param) =>
    typeof param.$ref === 'string' ? (OPENAPI.components.parameters[param.$ref.replace('#/components/parameters/', '')] ?? {}) : param,
  );
  return new Set(resolved.filter((param) => param.in === 'path' && param['x-opt2-wildcard'] === true).map((param) => String(param.name)));
}

/** A Fastify url in contract form: escaped `::` as `:`, `:name` as `{name}`, a trailing `*` as the contract's wildcard parameter there. */
function contractPath(url: string): string {
  const path = url.replaceAll('::', '\0').replace(/:(\w+)/g, '{$1}').replaceAll('\0', ':');
  if (!path.endsWith('/*')) return path;
  const prefix = path.slice(0, -1);
  const template = Object.keys(OPENAPI.paths).find((candidate) => {
    const name = /^\{(\w+)\}$/.exec(candidate.slice(prefix.length))?.[1];
    return candidate.startsWith(prefix) && name !== undefined && wildcardNames(candidate).has(name);
  });
  return template ?? path;
}

/** Registered routes of `app` keyed `METHOD path` in contract form, without HEAD twins of GET routes the contract does not declare. */
function registeredRoutes(app: TestApp['app']): Map<string, RouteMatrixEntry> {
  const declared = new Set(OPERATIONS.flatMap((op) => op.served));
  const keyed = new Map<string, RouteMatrixEntry>(collectRouteMatrix(app).routes.map((route) => [`${route.method} ${contractPath(route.url)}`, route]));
  for (const key of [...keyed.keys()]) {
    if (key.startsWith('HEAD ') && keyed.has(key.replace(/^HEAD /, 'GET ')) && !declared.has(key)) keyed.delete(key);
  }
  return keyed;
}

/** Distinct sorted role names of a declaration. */
function roleSet(roles: unknown): string[] {
  return [...new Set(Array.isArray(roles) ? roles.map(String) : [])].sort();
}

const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const USER_ID = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const GROUP_ID = 'A1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const FILE_A = 'B1C2D3E4-0001-4A5B-8C7D9E0F1A2B3C4D';
const FILE_B = 'B1C2D3E4-0002-4A5B-8C7D9E0F1A2B3C4D';
const FILE_MISSING = 'B1C2D3E4-0003-4A5B-8C7D9E0F1A2B3C4D';
const CHANGESET_1 = 'D1E2F3A4-0001-4A5B-8C7D9E0F1A2B3C4D';
const contentId = (n: number): string => `E1F2A3B4-000${n}-4A5B-8C7D9E0F1A2B3C4D`;
const SITE_MANAGER = '00000000000000000000000000000000000';
const CHANGESETS = '00000000000000000000000000000000014';
const OWN_QUEUE = 'content-scheduled-publish';
const JSON_TYPE = { 'content-type': 'application/json' } as const;
const OCTET_TYPE = { 'content-type': 'application/octet-stream' } as const;
const OBJECT_BYTES = Buffer.from('legacy file-store bytes');

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

let t: ContentTestApp;
let full: TestApp;

/** The request a test sends. */
interface Request {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  payload?: Json | Buffer | string;
}

/** Sends `request` and holds the answer to its contract operation; returns the response. */
async function call(request: Request): Promise<InjectResponse> {
  const { method, url, headers = {}, payload } = request;
  const res = await t.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  assertResponseMatchesOpenApi(OPENAPI, {
    method,
    path: url.split('?')[0] ?? url,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return res;
}

/** Parameters of the recorded statements whose SQL matches `pattern`. */
function paramsOf(pattern: RegExp): unknown[][] {
  return t.db.statements.filter((statement) => pattern.test(statement.sql)).map((statement) => [...statement.params]);
}

/** Every value of `params`, array parameters flattened. */
function flat(params: readonly unknown[]): unknown[] {
  return params.flatMap((value) => (Array.isArray(value) ? (value as unknown[]) : [value]));
}

/** identity's admin-session state and CSRF token issue, which the admin raw views call for every render. */
const ADMIN_STATE_PATH = '/v1/sessions/current/admin-state';
const CSRF_TOKENS_PATH = '/v1/csrf/tokens';

beforeAll(async () => {
  t = await buildContentApp();
  full = await buildTestApp();
  seedMemoryStorage(full.storage);
  for (const method of ['GET', 'POST'] as const) {
    full.client.on('identity', method, ADMIN_STATE_PATH, () => ({ status: 200, headers: {}, body: {} }));
  }
  full.client.on('identity', 'POST', CSRF_TOKENS_PATH, (req) => ({
    status: 200,
    headers: {},
    body: { tokens: (req.json as { contexts: string[] }).contexts.map((context) => ({ context, csrf_token: 'T', csrf_token_expires: '260630235959000' })) },
  }));
});

afterAll(async () => {
  await t?.close();
  await full?.close();
});

beforeEach(() => {
  t.db.reset();
  t.publisher.clear();
  full.db.reset();
  seedRecordingDb(full.db);
  full.client.clear();
});

describe('contract document', () => {
  it('is OpenAPI 3.1.0 at version 1.0.0 carrying the pinned source SHA', () => {
    expect({ openapi: OPENAPI.openapi, version: OPENAPI.info.version, sha: OPENAPI.info['x-source-sha'] }).toEqual({
      openapi: '3.1.0',
      version: '1.0.0',
      sha: PIN.sha,
    });
  });

  it('declares on every operation exactly one of a role list or public access, and a known transport', () => {
    const faults = OPERATIONS.filter((op) => {
      const declaresRoles = Array.isArray(op.requires) && op.requires.length > 0;
      const roleFormOk = declaresRoles || op.requires === undefined;
      return declaresRoles === (op.public === true) || !roleFormOk || !TRANSPORTS.includes(op.transport);
    }).map((op) => ({ operation: op.key, requires: op.requires, public: op.public, transport: op.transport }));
    expect(faults).toEqual([]);
  });

  it('declares each operation with the transport its path takes', () => {
    const faults = OPERATIONS.filter((op) => op.transport !== transportForPath(op.path)).map((op) => ({
      operation: op.key,
      declared: op.transport,
      path: transportForPath(op.path),
    }));
    expect(faults).toEqual([]);
  });

  it('declares one Pub/Sub push operation for the Pub/Sub invoker per consumed subscription', () => {
    const pushes = OPERATIONS.filter((op) => op.path.startsWith('/internal/v1/events/'));
    expect(pushes).toHaveLength(4);
    expect(pushes.map((op) => op.path).sort()).toEqual(CONTENT_SUBSCRIPTIONS.map((subscription) => pushPath(subscription)).sort());
    expect(pushes.map((op) => [op.method, op.transport, op.requires])).toEqual(pushes.map(() => ['POST', 'pubsub-push', ['service:pubsub-invoker']]));
  });

  it('declares both site-monitor job steps as Cloud Tasks deliveries for the tasks invoker', () => {
    const jobs = [PUBLISH_SCHEDULED_CHANGESETS_PATH, FEED_AUTO_IMPORT_PATH].map((path) => OPERATIONS.find((op) => op.key === `POST ${path}`));
    expect(jobs.map((op) => ({ transport: op?.transport, invoker: roleSet(op?.requires).includes('service:tasks-invoker') }))).toEqual([
      { transport: 'cloud-tasks', invoker: true },
      { transport: 'cloud-tasks', invoker: true },
    ]);
  });

  it('names none of the legacy-served, decision-list or halted actions in an operation or the entity access table', () => {
    const named = OPERATIONS.flatMap((op) =>
      [op.path, op.operationId, ...op.legacyNames].flatMap((text) => (text.match(NOT_BUILT_NAMES) ?? []).map((hit) => `${op.key}: ${hit}`)),
    );
    const entityAccess = JSON.stringify(OPENAPI['x-opt2-entity-access']).match(NOT_BUILT_NAMES) ?? [];
    expect({ named, entityAccess }).toEqual({ named: [], entityAccess: [] });
  });
});

describe('route parity', () => {
  it('registers exactly the contract operations', () => {
    const registered = registeredRoutes(full.app);
    const declared = new Set(OPERATIONS.flatMap((op) => op.served));
    expect([...registered.keys()].filter((key) => !declared.has(key)).sort(), 'routes registered but not in contract').toEqual([]);
    expect([...declared].filter((key) => !registered.has(key)).sort(), 'contract operations no route registers').toEqual([]);
  });

  it('registers every route with its contract roles, public access and transport', () => {
    const registered = registeredRoutes(full.app);
    const mismatches: Record<'requires' | 'public' | 'transport', Json[]> = { requires: [], public: [], transport: [] };
    for (const op of OPERATIONS) {
      for (const key of op.served) {
        const route = registered.get(key);
        if (route === undefined) continue;
        const [app, contract] = [roleSet(route.requires), roleSet(op.requires)];
        if (app.join() !== contract.join()) mismatches.requires.push({ route: key, app, contract });
        if (Boolean(route.public) !== Boolean(op.public)) mismatches.public.push({ route: key, app: route.public, contract: op.public });
        if (route.transport !== op.transport) mismatches.transport.push({ route: key, app: route.transport, contract: op.transport });
      }
    }
    expect(mismatches.requires, 'x-opt2-requires').toEqual([]);
    expect(mismatches.public, 'x-opt2-public').toEqual([]);
    expect(mismatches.transport, 'x-opt2-transport').toEqual([]);
  });

  it('registers no route for the legacy-served, decision-list or halted actions', () => {
    expect(collectRouteMatrix(full.app).routes.filter((route) => NOT_BUILT_NAME.test(route.url)).map((route) => route.url)).toEqual([]);
  });
});

describe('healthz', () => {
  it.each<[string, number, () => Promise<Record<string, string>>, string]>([
    ['no credential', 200, async () => ({}), ''],
    ['an unverifiable bearer token', 401, async () => ({ authorization: 'Bearer not-a-token' }), ''],
    ['a tenant-a user naming tenant-b', 403, () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.systemUser] }), `?siteid=${SITE_B}`],
  ])('answers %s with the contract %i', async (_label, status, headers, query) => {
    const res = await call({ method: 'GET', url: `/healthz${query}`, headers: await headers() });
    expect(res.statusCode).toBe(status);
  });
});

describe('getHeaderPrompts', () => {
  const url = `/v1/sites/${SITE_A}/header-prompts`;
  /** The groups the membership projection stores for the user, spelled as identity sent them. */
  const projectedGroup = GROUP_ID.toLowerCase();

  /** Answers each count the header reads; the pending sum only for the token site's unpublished change sets. */
  function seedLists(): void {
    t.db.respond(/ AS total FROM \(SELECT \* FROM \(SELECT draft\.contenthistid, module\.title AS module, active\./, [{ total: 2 }]);
    t.db.respond(/ AS total FROM \(SELECT \* FROM \(SELECT DISTINCT draft\.contenthistid/, (_params, sql) => [{ total: sql.includes('tapprovalrequests.userid') ? 1 : 2 }]);
    t.db.respond(/ AS total FROM \(SELECT contentid FROM "content"\."content" WHERE lower\(rtrim\(lastupdatebyid\)\)/, [{ total: 1 }]);
    t.db.respond(/FROM "content"\."membership_projection"/, [{ group_id: projectedGroup }]);
    t.db.respond(/AS pending FROM \(SELECT changesetid, .* FROM "content"\."changeset" WHERE /, (params) => [
      { pending: params[1] === SITE_A && params[2] === 0 ? 3 : 0 },
    ]);
  }

  it('counts a system user’s lists, approvals limited to the groups the membership projection holds', async () => {
    seedLists();
    const res = await call({ method: 'GET', url, headers: await userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.systemUser] }) });
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 200,
      body: { drafts: 2, submissions: 1, approvals: 2, expires: 1, pendingChangesets: 0 },
    });
    expect(paramsOf(/tapprovalrequests\.groupid = ANY/).map(flat)).toEqual([expect.arrayContaining([projectedGroup])]);
  });

  it.each<[string, readonly string[], number]>([
    ['a site admin', [Roles.systemUser, Roles.siteAdmin], 3],
    ['a system user with the Change Sets and Site Manager modules', [Roles.systemUser, moduleRole(CHANGESETS), moduleRole(SITE_MANAGER)], 3],
    ['a system user with the Change Sets module only', [Roles.systemUser, moduleRole(CHANGESETS)], 0],
  ])('sums the versions awaiting approval in unpublished change sets for %s', async (_label, roles, pending) => {
    seedLists();
    const res = await call({ method: 'GET', url, headers: await userHeaders({ sub: USER_ID, site: SITE_A, roles }) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Json).pendingChangesets).toBe(pending);
  });

  it('reads no membership for a site admin, whose approvals cover every group', async () => {
    seedLists();
    await call({ method: 'GET', url, headers: await userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.systemUser, Roles.siteAdmin] }) });
    expect(paramsOf(/membership_projection/)).toEqual([]);
    expect(paramsOf(/tapprovalrequests\.groupid/)).toEqual([]);
  });

  it.each<[string, number, () => Promise<Record<string, string>>, string]>([
    ['no credential', 401, async () => ({}), url],
    ['a public member', 403, () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.member] }), url],
    ['a user of another site', 403, () => userHeaders({ sub: USER_ID, site: SITE_B, roles: [Roles.s2] }), url],
    ['a service without a user token', 401, () => serviceHeaders('people'), url],
  ])('refuses %s with the contract %i', async (_label, status, headers, target) => {
    const res = await call({ method: 'GET', url: target, headers: await headers() });
    expect(res.statusCode).toBe(status);
  });
});

describe('listPrivateInterestGroups', () => {
  const url = `/v1/sites/${SITE_A}/private-interest-groups`;
  const INTEREST_GROUPS = /FROM unnest\(\$\d+::text\[\], \$\d+::text\[\]\) AS s\(siteid, site\) INNER JOIN "content"\."category" c/;
  const systemUser = () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.systemUser] });

  it("answers one level of the token site's private pool in that site's tenant, SQL NULL text as empty", async () => {
    t.db.respond(INTEREST_GROUPS, [{ site: null, categoryid: GROUP_ID, name: null, filename: 'interests', urltitle: null, isopen: null, haskids: 2 }]);
    const res = await call({ method: 'GET', url: `${url}?groupsiteid=${SITE_A.toUpperCase()}&parentid=`, headers: await systemUser() });
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 200,
      body: { items: [{ siteID: SITE_A, categoryID: GROUP_ID, name: '', filename: 'interests', urltitle: '', isOpen: null, hasKids: 2 }] },
    });
    const reads = t.db.statements.filter((statement) => INTEREST_GROUPS.test(statement.sql));
    expect(reads.map((statement) => [statement.tenantId, flat(statement.params), /c\.parentid IS NULL/.test(statement.sql)])).toEqual([
      [TENANT_A.tenantId, [TENANT_A.tenantId, SITE_A, null], true],
    ]);
  });

  it.each<[string, number, () => Promise<Record<string, string>>, string]>([
    ['no credential', 401, async () => ({}), `${url}?groupsiteid=${SITE_A}`],
    ['a site outside the token site’s private pool', 403, systemUser, `${url}?groupsiteid=${SITE_B}`],
    ['a user of another site', 403, () => userHeaders({ sub: USER_ID, site: SITE_B, roles: [Roles.s2] }), `${url}?groupsiteid=${SITE_A}`],
    ['a service without a user token', 401, () => serviceHeaders('people'), `${url}?groupsiteid=${SITE_A}`],
    ['no groupsiteid', 400, systemUser, url],
  ])('refuses %s with the contract %i', async (_label, status, headers, target) => {
    const res = await call({ method: 'GET', url: target, headers: await headers() });
    expect(res.statusCode).toBe(status);
    expect(t.db.statements.filter((statement) => INTEREST_GROUPS.test(statement.sql))).toEqual([]);
  });
});

describe('lookupFileExtensions', () => {
  const url = '/internal/v1/files:lookup';
  const callerFor = (caller: string, site: string) => serviceHeaders(caller, { sub: USER_ID, site, roles: [Roles.systemUser] });
  const peopleFor = (site: string) => callerFor('people', site);

  it.each(['people', 'identity'])('answers %s the listed ids that name a stored file, in listed order and spelling', async (caller) => {
    t.db.respond(/^SELECT fileid, fileext FROM "content"\."file" WHERE fileid = ANY/, [
      { fileid: `${FILE_B} `, fileext: null },
      { fileid: FILE_A, fileext: 'jpg' },
    ]);
    const res = await call({
      method: 'POST',
      url,
      headers: { ...(await callerFor(caller, SITE_A)), ...JSON_TYPE },
      payload: { fileIds: [FILE_B, FILE_MISSING, FILE_A.toLowerCase()] },
    });
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 200,
      body: { items: [{ fileId: FILE_B, fileExt: null }, { fileId: FILE_A.toLowerCase(), fileExt: 'jpg' }] },
    });
  });

  it.each<[string, Json | string]>([
    ['no ids', { fileIds: [] }],
    ['a repeated id', { fileIds: [FILE_A, FILE_A] }],
    ['an id longer than 35 characters', { fileIds: [`${FILE_A}0`] }],
    ['an unknown field', { fileIds: [FILE_A], siteId: SITE_A }],
    ['a body that is not JSON', 'fileIds=x'],
  ])('answers the contract 400 for %s', async (_label, payload) => {
    const res = await call({ method: 'POST', url, headers: { ...(await peopleFor(SITE_A)), ...JSON_TYPE }, payload });
    expect(res.statusCode).toBe(400);
  });

  it.each<[string, number, () => Promise<Record<string, string>>]>([
    ['people without a forwarded user token', 401, () => serviceHeaders('people')],
    ['another service', 403, () => callerFor('programs-sites', SITE_A)],
    ['a browser user', 403, () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.s2] })],
  ])('refuses %s with the contract %i', async (_label, status, headers) => {
    const res = await call({ method: 'POST', url, headers: { ...(await headers()), ...JSON_TYPE }, payload: { fileIds: [FILE_A] } });
    expect(res.statusCode).toBe(status);
  });
});

describe('lookupContentLinks', () => {
  const url = '/internal/v1/content:links';
  const HOME = '00000000000000000000000000000000001';
  const ACTIVE_VERSIONS = /^SELECT .* FROM "content"\."content" tcontent LEFT JOIN .* WHERE tcontent\.contentid = ANY/;
  const links = (payload: Json | string, headers: () => Promise<Record<string, string>> = () => serviceHeaders('people')) =>
    async (): Promise<InjectResponse> => call({ method: 'POST', url, headers: { ...(await headers()), ...JSON_TYPE }, payload });

  it('answers people each listed id’s createHref link in listed order under the settings template’s URL flags: a stored page by its filename behind the index file, the home page and an unknown id at the root', async () => {
    t.db.respond(ACTIVE_VERSIONS, [
      { contentid: contentId(1), filename: 'about-us/team' },
      { contentid: HOME, filename: null },
    ]);
    const res = await links({ siteId: SITE_A.toUpperCase(), contentIds: [contentId(1).toLowerCase(), HOME, 'NO-SUCH-CONTENT'] })();
    expect({ status: res.statusCode, body: res.json<unknown>() }).toEqual({
      status: 200,
      body: {
        items: [
          { contentId: contentId(1).toLowerCase(), href: '/index.cfm/about-us/team/' },
          { contentId: HOME, href: '/' },
          { contentId: 'NO-SUCH-CONTENT', href: '/' },
        ],
      },
    });
    expect(paramsOf(ACTIVE_VERSIONS).map(flat)).toEqual([expect.arrayContaining([contentId(1), HOME, SITE_A])]);
  });

  it.each<[string, Json | string]>([
    ['no ids', { siteId: SITE_A, contentIds: [] }],
    ['a repeated id', { siteId: SITE_A, contentIds: [HOME, HOME] }],
    ['an id longer than a favorite location', { siteId: SITE_A, contentIds: ['x'.repeat(1001)] }],
    ['no site', { contentIds: [HOME] }],
    ['an unknown field', { siteId: SITE_A, contentIds: [HOME], userId: USER_ID }],
    ['a body that is not JSON', 'siteId=x'],
  ])('answers the contract 400 for %s', async (_label, payload) => {
    const res = await links(payload)();
    expect(res.statusCode).toBe(400);
  });

  it('answers the contract 503 for a site the registry does not hold, reading no content', async () => {
    const res = await links({ siteId: 'unregistered-site', contentIds: [HOME] })();
    expect(res.statusCode).toBe(503);
    expect(paramsOf(ACTIVE_VERSIONS)).toEqual([]);
  });

  it.each<[string, number, () => Promise<Record<string, string>>]>([
    ['no credential', 401, () => Promise.resolve({})],
    ['another service', 403, () => serviceHeaders('identity')],
    ['a browser user', 403, () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.s2] })],
  ])('refuses %s with the contract %i', async (_label, status, headers) => {
    const res = await links({ siteId: SITE_A, contentIds: [HOME] }, headers)();
    expect(res.statusCode).toBe(status);
  });
});

describe('comments proxy', () => {
  const url = '/core/modules/v1/comments/ajax/commentsProxy.cfc';
  const FORM_TYPE = { 'content-type': 'application/x-www-form-urlencoded' } as const;
  const visitor = (site = SITE_A) => userHeaders({ sub: '', site, roles: [] });

  it.each<[string, Request['method'], string, string | undefined]>([
    ['get', 'GET', `?method=get&commentID=${contentId(1)}&siteid=${SITE_A}`, undefined],
    ['getContentStats', 'POST', '', `method=getContentStats&contentID=${contentId(1)}&siteid=${SITE_A}`],
    ['flag', 'POST', `?method=flag&commentID=${contentId(1)}`, undefined],
  ])('answers %s with the contract 200 text', async (_label, method, query, form) => {
    const headers = { ...(await visitor()), ...(form === undefined ? {} : FORM_TYPE) };
    const res = await call({ method, url: `${url}${query}`, headers, ...(form === undefined ? {} : { payload: form }) });
    expect({ status: res.statusCode, type: res.headers['content-type'] }).toEqual({ status: 200, type: 'text/html;charset=UTF-8' });
  });

  it.each<[string, number, Request['method'], string, () => Promise<Record<string, string>>]>([
    ['a siteid of another site', 403, 'GET', `?method=get&commentID=${contentId(1)}&siteid=${SITE_B}`, () => visitor()],
    ['a call without a user token', 401, 'POST', `?method=flag&commentID=${contentId(1)}`, () => serviceHeaders('gateway')],
    ['renderCommentsPage, which stays legacy-served', 500, 'GET', `?method=renderCommentsPage&contentID=${contentId(1)}`, () => visitor()],
    ['an argument the method does not declare', 500, 'POST', `?method=get&commentID=${contentId(1)}&foo=1`, () => visitor()],
  ])('answers %s with the contract %i', async (_label, status, method, query, headers) => {
    const res = await call({ method, url: `${url}${query}`, headers: await headers() });
    expect(res.statusCode).toBe(status);
  });
});

describe('rater save', () => {
  const url = '/core/modules/v1/rater/ajax/saveRate.cfm';
  const FORM_TYPE = { 'content-type': 'application/x-www-form-urlencoded' } as const;
  const visitor = (site = SITE_A) => userHeaders({ sub: '', site, roles: [] });
  const fields = (overrides: Record<string, string> = {}, omit?: string): string => {
    const form = new URLSearchParams({ contentID: contentId(1), siteID: SITE_A, userID: USER_ID, rate: '5', ...overrides });
    if (omit !== undefined) form.delete(omit);
    return form.toString();
  };

  // The saved rating, the other site's 403 and a non-numeric rate are cases of the operation table below.
  it.each<[string, number, Request['method'], string, string | undefined, () => Promise<Record<string, string>>]>([
    ['a call without a user token', 401, 'POST', '', fields(), () => serviceHeaders('gateway')],
    ['a missing rate field', 500, 'POST', '', fields({}, 'rate'), () => visitor()],
    ['a GET, which posts no form fields', 500, 'GET', `?${fields()}`, undefined, () => visitor()],
    ['a direct POST without an invocation credential', 401, 'POST', '', fields(), async () => ({})],
    ['a direct GET without an invocation credential', 401, 'GET', `?${fields()}`, undefined, async () => ({})],
  ])('answers %s with the contract %i, writing nothing', async (_label, status, method, query, form, headers) => {
    const res = await call({ method, url: `${url}${query}`, headers: { ...(await headers()), ...(form === undefined ? {} : FORM_TYPE) }, ...(form === undefined ? {} : { payload: form }) });
    expect({ status: res.statusCode, writes: t.db.writes().length }).toEqual({ status, writes: 0 });
  });
});

describe('migration objects', () => {
  const url = '/internal/v1/migration/objects';
  const key = `${TENANT_A.tenantId}/${FILE_A}.png`;
  const putUrl = (overrides: Record<string, string> = {}): string =>
    `${url}?${new URLSearchParams({ tenantId: TENANT_A.tenantId, fileId: FILE_A, variant: '', ext: 'PNG', contentType: 'image/png', sha256: sha256(OBJECT_BYTES), ...overrides }).toString()}`;
  /** The `content.file_object` row of the stored object. */
  const objectRow = (): Json => ({
    tenant_id: TENANT_A.tenantId,
    file_id: FILE_A,
    variant: '',
    ext: 'png',
    object_key: key,
    size: String(OBJECT_BYTES.length),
    sha256: sha256(OBJECT_BYTES),
    content_type: 'image/png',
    orphan: true,
    created_at: new Date('2026-06-30T10:00:00Z'),
  });
  /** The publication's key-lock and intent-ledger statements, in order. */
  const publicationSteps = (): string[] =>
    t.db.statements.flatMap(({ sql }) => {
      if (/^SELECT pg_advisory_xact_lock\(/.test(sql)) return ['lock'];
      if (!/"content"\."staged_object"/.test(sql)) return [];
      if (/ WHERE recorded_at < /.test(sql)) return ['recover'];
      return [/^INSERT/.test(sql) ? 'stage' : /^SELECT/.test(sql) ? 'claim' : /^UPDATE/.test(sql) ? 'commit' : 'settle'];
    });

  it('stores a new object and records it, answering its FileObject and write position', async () => {
    const res = await call({ method: 'POST', url: putUrl(), headers: { ...(await serviceHeaders('migration')), ...OCTET_TYPE }, payload: OBJECT_BYTES });
    expect({ status: res.statusCode, body: res.json(), position: res.headers[WRITE_POSITION_HEADER_LC] }).toEqual({
      status: 200,
      body: { key, size: OBJECT_BYTES.length, sha256: sha256(OBJECT_BYTES), created: true },
      position: `${SERVICE}=${FAKE_XID}`,
    });
    expect(await t.storage.get(CONTENT_FILES_BUCKET, key)).toEqual(OBJECT_BYTES);
    expect(publicationSteps()).toEqual(['recover', 'stage', 'lock', 'claim', 'settle']);
  });

  it('answers created false, writing nothing, when the key already holds the same hash', async () => {
    await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'image/png' });
    t.db.respond(/FROM "content"\."file_object" WHERE "object_key" = \$1/, [objectRow()]);
    const res = await call({ method: 'POST', url: putUrl(), headers: { ...(await serviceHeaders('migration')), ...OCTET_TYPE }, payload: OBJECT_BYTES });
    expect({ status: res.statusCode, created: (res.json() as Json).created }).toEqual({ status: 200, created: false });
    expect(paramsOf(/^INSERT INTO "content"\."(?!staged_object"|changelog")/)).toEqual([]);
    expect(paramsOf(/^INSERT INTO "content"\."changelog"/).map((params) => [params[1], params[2]])).toEqual([
      ['staged_object', 'insert'],
      ['staged_object', 'delete'],
    ]);
    expect(publicationSteps()).toEqual(['recover', 'stage', 'lock', 'claim', 'settle']);
  });

  it.each<[string, string, Buffer | Json]>([
    ['a body whose hash differs', putUrl({ sha256: sha256(Buffer.from('other bytes')) }), OBJECT_BYTES],
    ['a file id that is not a CF UUID', putUrl({ fileId: 'not-a-file-id' }), OBJECT_BYTES],
    ['a variant leaving the key’s directory', putUrl({ variant: '_x/../y' }), OBJECT_BYTES],
    ['an upper-case hash', putUrl({ sha256: sha256(OBJECT_BYTES).toUpperCase() }), OBJECT_BYTES],
  ])('answers the contract 400 for %s', async (_label, target, payload) => {
    const res = await call({ method: 'POST', url: target, headers: { ...(await serviceHeaders('migration')), ...OCTET_TYPE }, payload });
    expect(res.statusCode).toBe(400);
  });

  it('reads the stored bytes back as an octet stream', async () => {
    await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'image/png' });
    t.db.respond(/FROM "content"\."file_object" WHERE "object_key" = \$1/, [objectRow()]);
    const res = await call({ method: 'GET', url: `${url}?key=${encodeURIComponent(key)}`, headers: await serviceHeaders('migration') });
    expect({ status: res.statusCode, type: res.headers['content-type'], bytes: res.rawPayload }).toEqual({
      status: 200,
      type: 'application/octet-stream',
      bytes: OBJECT_BYTES,
    });
  });

  it.each<[string, number, string]>([
    ['a key no row records', 404, `${TENANT_B.tenantId}/${FILE_MISSING}.png`],
    ['a key outside the contract pattern', 400, `${TENANT_A.tenantId}/../${FILE_A}.png`],
  ])('answers %s with the contract %i', async (_label, status, objectKey) => {
    const res = await call({ method: 'GET', url: `${url}?key=${encodeURIComponent(objectKey)}`, headers: await serviceHeaders('migration') });
    expect(res.statusCode).toBe(status);
  });

  it.each<[string, Json[], boolean]>([
    ['a recorded object', [objectRow()], true],
    ['a key no row records', [], false],
  ])('deletes the bytes under %s, answering the contract DeletedFileObject with the position of its logged writes', async (_label, rows, deleted) => {
    await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'image/png' });
    t.db.respond(/^DELETE FROM "content"\."file_object"/, rows);
    const res = await call({ method: 'DELETE', url: `${url}?key=${encodeURIComponent(key)}`, headers: await serviceHeaders('migration') });
    expect({ status: res.statusCode, body: res.json(), position: res.headers[WRITE_POSITION_HEADER_LC] }).toEqual({
      status: 200,
      body: { key, deleted },
      position: `${SERVICE}=${FAKE_XID}`,
    });
    expect(await t.storage.head(CONTENT_FILES_BUCKET, key)).toBeNull();
    expect(publicationSteps()).toEqual(['recover', 'stage', 'lock', 'claim', 'lock', 'claim', 'settle']);
    // The intent's insert and settling delete are logged, with the row deletion between them when a row was recorded.
    expect(paramsOf(/^INSERT INTO "content"\."changelog"/).map((params) => [params[1], params[2]])).toEqual([
      ['staged_object', 'insert'],
      ...(deleted ? [['file_object', 'delete']] : []),
      ['staged_object', 'delete'],
    ]);
  });

  it('answers the contract 400 for a deletion key outside the contract pattern', async () => {
    const res = await call({ method: 'DELETE', url: `${url}?key=${encodeURIComponent(`${TENANT_A.tenantId}/../${FILE_A}.png`)}`, headers: await serviceHeaders('migration') });
    expect(res.statusCode).toBe(400);
  });

  it.each<[string, number, () => Promise<Record<string, string>>]>([
    ['no credential', 401, async () => ({})],
    ['another service', 403, () => serviceHeaders('people')],
  ])('refuses %s with the contract %i', async (_label, status, headers) => {
    const res = await call({ method: 'POST', url: putUrl(), headers: { ...(await headers()), ...OCTET_TYPE }, payload: OBJECT_BYTES });
    expect(res.statusCode).toBe(status);
  });
});

describe('signed file downloads', () => {
  const filePool = poolTenantExpectation(TENANT_A, 'file');
  const key = `${filePool}/${FILE_A}.pdf`;
  const downloadUrl = (fileId: string, query = ''): string => `/v1/sites/${SITE_A}/files/${fileId}/download-url${query}`;
  const admin = () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.systemUser, Roles.siteAdmin] });
  /** Answers the file read of FILE_A with a PDF named `report.pdf`. */
  const seedFile = (): void => {
    t.db.respond(/ FROM "content"\."file" WHERE /, [
      { fileid: FILE_A, siteid: SITE_A, filename: 'report.pdf', contenttype: 'application', contentsubtype: 'pdf', fileext: 'pdf' },
    ]);
  };

  it('issues a 900 s SignedUrl that streams the stored bytes under the signed disposition', async () => {
    seedFile();
    await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'application/pdf' });
    const res = await call({ method: 'GET', url: downloadUrl(FILE_A, '?method=inline'), headers: await admin() });
    const body = res.json() as { url: string; expiresAt: string };
    expect({ status: res.statusCode, expiresAt: body.expiresAt }).toEqual({
      status: 200,
      expiresAt: new Date(TEST_CLOCK.now().getTime() + 900_000).toISOString(),
    });
    expect(body.url.startsWith(`/opt2/files/content-files/${filePool}/${FILE_A}.pdf?expires=`)).toBe(true);

    // The signed URL is path-only; the gateway forwards it with its own invocation credential.
    const file = await call({ method: 'GET', url: body.url, headers: await contentHeaders('anonymous') });
    expect({ status: file.statusCode, type: file.headers['content-type'], disposition: file.headers['content-disposition'], bytes: file.rawPayload }).toEqual({
      status: 200,
      type: 'application/pdf',
      disposition: 'inline;filename="report.pdf"',
      bytes: OBJECT_BYTES,
    });
  });

  it.each<[string, number, () => void, string]>([
    ['a file id no row records', 404, () => undefined, downloadUrl(FILE_MISSING)],
    ['a stored row whose rendition is not stored', 404, seedFile, downloadUrl(FILE_A, '?variant=_small')],
    ['a file id that is not a CF UUID', 404, () => undefined, downloadUrl('not-a-file-id')],
    ['a variant leaving the key’s directory', 400, seedFile, downloadUrl(FILE_A, `?variant=${encodeURIComponent('_x/../y')}`)],
    ['a method outside the enum', 400, seedFile, downloadUrl(FILE_A, '?method=download')],
  ])('answers %s with the contract %i', async (_label, status, seed, url) => {
    seed();
    await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'application/pdf' });
    const res = await call({ method: 'GET', url, headers: await admin() });
    expect(res.statusCode).toBe(status);
  });

  it.each<[string, number, () => Promise<Record<string, string>>, string]>([
    ['no credential', 401, async () => ({}), SITE_A],
    ['a system user without Site Manager access', 403, () => userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.systemUser] }), SITE_A],
    ['a tenant-b site admin naming tenant-a', 403, () => userHeaders({ sub: USER_ID, site: SITE_B, roles: [Roles.siteAdmin] }), SITE_A],
  ])('refuses %s with the contract %i', async (_label, status, headers, site) => {
    const res = await call({ method: 'GET', url: `/v1/sites/${site}/files/${FILE_A}/download-url`, headers: await headers() });
    expect(res.statusCode).toBe(status);
  });

  it.each<[string, number, () => Promise<string>, (() => Promise<Record<string, string>>)?]>([
    ['a tampered signature', 403, async () => (await t.storage.signedUrl(CONTENT_FILES_BUCKET, key)).replace(/sig=[0-9a-f]/, (m) => `sig=${m.endsWith('0') ? '1' : '0'}`)],
    ['an expired signature', 403, () => t.storage.signedUrl(CONTENT_FILES_BUCKET, key, { expiresS: -1 })],
    ['a malformed signature', 403, async () => `/opt2/files/content-files/${key}?expires=1&sig=xyz`],
    ['a signed key that stores nothing', 404, () => t.storage.signedUrl(CONTENT_FILES_BUCKET, `${filePool}/${FILE_MISSING}.pdf`)],
    ['a valid signature called directly without an invocation credential', 401, () => t.storage.signedUrl(CONTENT_FILES_BUCKET, key), async () => ({})],
  ])('answers getLocalContentFile for %s with the contract %i', async (_label, status, signed, headers = () => contentHeaders('anonymous')) => {
    await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'application/pdf' });
    const res = await call({ method: 'GET', url: await signed(), headers: await headers() });
    expect(res.statusCode).toBe(status);
  });
});

describe('migration handlers over the content mappings', () => {
  const migration = (): Promise<Record<string, string>> => serviceHeaders('migration');

  it('answers the position', async () => {
    const res = await call({ method: 'GET', url: '/internal/v1/migration/position', headers: await migration() });
    expect({ status: res.statusCode, owner: (res.json() as Json).owner }).toEqual({ status: 200, owner: SERVICE });
  });

  it('exports the content.file unit with the object manifest of content.file_object', async () => {
    const row = { object_key: `${TENANT_A.tenantId}/${FILE_A}.png`, size: '23', sha256: sha256(OBJECT_BYTES), content_type: 'image/png' };
    for (const key of [row.object_key, `${TENANT_A.tenantId}/${FILE_A}_small.png`]) await t.storage.put(CONTENT_FILES_BUCKET, key, OBJECT_BYTES, { contentType: 'image/png' });
    t.db.respond(/^SELECT "object_key", .* FROM "content"\."file_object" ORDER BY/, [row, { ...row, object_key: `${TENANT_A.tenantId}/${FILE_A}_small.png`, content_type: null }]);
    const res = await call({ method: 'GET', url: `/internal/v1/migration/export?unit=content.file&tenantId=${TENANT_A.tenantId}`, headers: await migration() });
    const body = res.json() as Json;
    expect({ status: res.statusCode, tables: (body.tables as Json[]).map((table) => table.legacyTable), objects: body.objects }).toEqual({
      status: 200,
      tables: ['tfiles'],
      objects: [
        { key: row.object_key, size: 23, sha256: row.sha256, contentType: 'image/png' },
        { key: `${TENANT_A.tenantId}/${FILE_A}_small.png`, size: 23, sha256: row.sha256 },
      ],
    });
  });

  it.each(['content.comment', 'content.commenter', 'content.content_stats', 'content.content_rating'])(
    'exports the %s unit as the tables its content mappings declare',
    async (unit) => {
      const res = await call({ method: 'GET', url: `/internal/v1/migration/export?unit=${unit}&tenantId=${TENANT_A.tenantId}`, headers: await migration() });
      const tables = ((res.json() as Json).tables as Json[]).map((table) => [table.legacyTable, table.targetTable]);
      expect({ status: res.statusCode, tables }).toEqual({
        status: 200,
        tables: mappings.filter((mapping) => mapping.unit === unit).map((mapping) => [mapping.legacyTable, mapping.targetTable]),
      });
    },
  );

  it.each<[string, number, string]>([
    ['the changes after the start', 200, `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}`],
    ['a malformed changes cursor', 400, `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}&after=x`],
    ['an export without a unit', 400, `/internal/v1/migration/export?tenantId=${TENANT_A.tenantId}`],
    ['an export of a unit the service does not own', 400, `/internal/v1/migration/export?unit=people.person&tenantId=${TENANT_A.tenantId}`],
  ])('answers %s with the contract %i', async (_label, status, target) => {
    const res = await call({ method: 'GET', url: target, headers: await migration() });
    expect(res.statusCode).toBe(status);
  });

  it('lists and records feed watermarks', async () => {
    const stored = { legacy_table: 'tcontentcomments', direction: 'forward', snapshot_seq: '3', backup_lsn: null, finished_at: '2026-06-30T11:00:00.000' };
    t.db.respond(/FROM "content"\."migration_watermark"/, [stored]);
    t.db.respond(/^INSERT INTO "content"\."migration_watermark"/, [stored]);
    const listed = await call({ method: 'GET', url: '/internal/v1/migration/watermark', headers: await migration() });
    const recorded = await call({
      method: 'POST',
      url: '/internal/v1/migration/watermark',
      headers: { ...(await migration()), ...JSON_TYPE },
      payload: { legacyTable: 'tcontentcomments', direction: 'forward', snapshotSeq: 3, finishedAt: '2026-06-30 11:00:00' },
    });
    const record = { legacyTable: 'tcontentcomments', direction: 'forward', snapshotSeq: 3, backupLsn: null, finishedAt: '2026-06-30T11:00:00.000' };
    expect([listed.statusCode, listed.json(), recorded.statusCode, recorded.json()]).toEqual([200, [record], 200, record]);
  });

  it('reads the unit gates of this owner', async () => {
    t.db.setGate('content.comment', { state: 'closed', holder_id: 'window-1', phase: 'executing' });
    const res = await call({
      method: 'POST',
      url: '/internal/v1/migration/gate',
      headers: { ...(await migration()), ...JSON_TYPE },
      payload: { op: 'status', units: ['content.comment', 'content.content_stats'] },
    });
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 200,
      body: {
        units: [
          { unit: 'content.comment', state: 'closed', holderId: 'window-1', phase: 'executing' },
          { unit: 'content.content_stats', state: 'open', holderId: null, phase: 'quiet' },
        ],
      },
    });
  });

  it.each<[string, string, Json]>([
    ['an apply batch without rows', '/internal/v1/migration/apply', { batchId: 'b-1', origin: 'backfill', legacyTable: 'tcontentstats', tenantId: TENANT_A.tenantId, columns: [{ name: 'contentID', type: 's' }], rows: [] }],
    ['a watermark without its finish time', '/internal/v1/migration/watermark', { legacyTable: 'tfiles', direction: 'forward' }],
    ['an unknown gate operation', '/internal/v1/migration/gate', { op: 'read' }],
  ])('answers the contract 400 for %s', async (_label, target, payload) => {
    const res = await call({ method: 'POST', url: target, headers: { ...(await migration()), ...JSON_TYPE }, payload });
    expect(res.statusCode).toBe(400);
  });

  it.each<[string, number, () => Promise<Record<string, string>>]>([
    ['no credential', 401, async () => ({})],
    ['the operator', 403, () => serviceHeaders('operator')],
  ])('refuses %s with the contract %i', async (_label, status, headers) => {
    const res = await call({ method: 'GET', url: '/internal/v1/migration/position', headers: await headers() });
    expect(res.statusCode).toBe(status);
  });
});

describe('push subscriptions', () => {
  const site = registryPayloads().find((payload) => payload.siteId === SITE_A);
  /** A contract-valid tenant-a envelope per subscription. */
  const ENVELOPES: Readonly<Record<string, () => EventEnvelope>> = {
    [SITE_CHANGED_SUBSCRIPTION]: () => testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: SITE_A, payload: site }),
    [GROUP_CHANGED_SUBSCRIPTION]: () =>
      testEnvelope({
        topic: GROUP_CHANGED_TOPIC,
        tenantId: TENANT_A.tenantId,
        aggregateId: GROUP_ID,
        payload: { groupId: GROUP_ID, siteId: SITE_A, groupName: 'Editors', type: 1, isPublic: 0, poolTenantId: TENANT_A.tenantId, deleted: false },
      }),
    [PERMISSION_CHANGED_SUBSCRIPTION]: () =>
      testEnvelope({
        topic: PERMISSION_CHANGED_TOPIC,
        tenantId: TENANT_A.tenantId,
        aggregateType: 'group',
        aggregateId: GROUP_ID,
        payload: { groupId: GROUP_ID, siteId: SITE_A, rows: [] },
      }),
    [MEMBERSHIP_CHANGED_SUBSCRIPTION]: () =>
      testEnvelope({
        topic: MEMBERSHIP_CHANGED_TOPIC,
        tenantId: TENANT_A.tenantId,
        aggregateType: 'user',
        aggregateId: USER_ID,
        payload: { userId: USER_ID, siteId: SITE_A, groupIds: [] },
      }),
  };
  const SUBSCRIPTIONS = Object.keys(ENVELOPES);
  const envelopeOf = (subscription: string): EventEnvelope => {
    const build = ENVELOPES[subscription];
    if (build === undefined) throw new TypeError(`No envelope for ${subscription}`);
    return build();
  };
  /** Holds a push answer to the subscription's contract operation. */
  const held = (subscription: string, res: InjectResponse): InjectResponse => {
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'POST',
      path: `/internal/v1/events/${subscription}`,
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
    return res;
  };

  it.each(SUBSCRIPTIONS)('acknowledges an applied, a repeated and a dead-lettered delivery to %s with the contract 204', async (subscription) => {
    const envelope = envelopeOf(subscription);
    const applied = held(subscription, await pushTo(t.app, subscription, envelope));
    const repeated = held(subscription, await pushTo(t.app, subscription, envelope));
    const invalid = held(subscription, await pushTo(t.app, subscription, { ...envelopeOf(subscription), payload: { unexpected: true } }));
    expect([applied.statusCode, repeated.statusCode, invalid.statusCode]).toEqual([204, 204, 204]);
    expect(t.publisher.deadLetters(subscription)).toHaveLength(1);
    // The service declares no event contract of its own, so a delivery publishes nothing but its dead letter.
    expect(t.publisher.published).toEqual([]);
  });

  it.each(SUBSCRIPTIONS)('answers the contract 400 nack for a body that is not a push delivery to %s', async (subscription) => {
    const res = await t.app.inject({ method: 'POST', url: `/internal/v1/events/${subscription}?key=opt2-test-push-key`, headers: JSON_TYPE, payload: { data: 'x' } });
    expect(held(subscription, res).statusCode).toBe(400);
  });

  it.each(SUBSCRIPTIONS)('refuses a delivery to %s without the push key with the contract 401', async (subscription) => {
    const body = buildPushBody({ data: encodeEnvelope(envelopeOf(subscription)), messageId: randomUUID(), subscription });
    const res = await t.app.inject({ method: 'POST', url: `/internal/v1/events/${subscription}`, headers: JSON_TYPE, payload: { ...body } });
    expect(held(subscription, res).statusCode).toBe(401);
  });
});

describe('site-monitor job steps', () => {
  const stepTask = (queue: string, step: string, tenantId: string | null = null): Json => ({
    queue,
    name: `${queue}-1782820800`,
    tenantId,
    payload: { step, theTime: '2026-06-30T12:00:00.000', lastMonitored: '2026-06-30T11:45:00.000' },
  });

  it('publishes the due change sets of every registered tenant, skipping one awaiting approval', async () => {
    t.db.respond(/FROM "content"\."changeset" WHERE tenant_id = \$1 AND published = 0 /, (params) => (params[0] === TENANT_A.tenantId ? [{ changesetid: CHANGESET_1 }] : []));
    t.db.respond(/ AS pending FROM /, [{ pending: 1 }]);
    const res = await call({
      method: 'POST',
      url: PUBLISH_SCHEDULED_CHANGESETS_PATH,
      headers: { ...(await tasksHeaders(PUBLISH_SCHEDULED_CHANGESETS_PATH)), ...JSON_TYPE },
      payload: stepTask('content-scheduled-publish', 'publishScheduledChangesets'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      step: 'publishScheduledChangesets',
      changesets: [{ tenantId: TENANT_A.tenantId, siteId: SITE_A, changesetId: CHANGESET_1, published: false }],
    });
  });

  it('imports the remote feeds of the ?siteid= site', async () => {
    const res = await call({
      method: 'POST',
      url: `${FEED_AUTO_IMPORT_PATH}?siteid=${SITE_A}`,
      headers: { ...(await tasksHeaders(FEED_AUTO_IMPORT_PATH)), ...JSON_TYPE },
      payload: stepTask('content-feed-import', 'feedAutoImport'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ step: 'feedAutoImport', siteId: SITE_A, feeds: 0 });
  });

  it.each<[string, string, Json]>([
    ['a feed step without a site', FEED_AUTO_IMPORT_PATH, stepTask('content-feed-import', 'feedAutoImport')],
    ['a task body carrying a tenant', PUBLISH_SCHEDULED_CHANGESETS_PATH, stepTask('content-scheduled-publish', 'publishScheduledChangesets', TENANT_A.tenantId)],
  ])('answers the contract 400 to %s', async (_label, target, payload) => {
    const res = await call({ method: 'POST', url: target, headers: { ...(await tasksHeaders(target)), ...JSON_TYPE }, payload });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a user token with the contract 401', async () => {
    const res = await call({
      method: 'POST',
      url: PUBLISH_SCHEDULED_CHANGESETS_PATH,
      headers: { ...(await userHeaders({ sub: USER_ID, site: SITE_A, roles: [Roles.s2], s2: true })), ...JSON_TYPE },
      payload: stepTask('content-scheduled-publish', 'publishScheduledChangesets'),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('queue control', () => {
  it.each<[string, string, number, Json | undefined]>([
    ['pauses', `/internal/v1/task-queues/${OWN_QUEUE}/pause`, 200, { queue: OWN_QUEUE, service: SERVICE, paused: true, running: 0 }],
    ['resumes', `/internal/v1/task-queues/${OWN_QUEUE}/resume`, 200, { queue: OWN_QUEUE, service: SERVICE, paused: false }],
    ['refuses to ensure the non-recurring', `/internal/v1/task-queues/${OWN_QUEUE}/ensure`, 400, undefined],
    ['refuses to pause another service’s', '/internal/v1/task-queues/surveys-launch/pause', 400, undefined],
    ['refuses to pause an unknown', '/internal/v1/task-queues/no-such-queue/pause', 400, undefined],
  ])('%s queue with the contract answer', async (_label, target, status, body) => {
    const res = await call({ method: 'POST', url: target, headers: { ...(await serviceHeaders('operator')), ...JSON_TYPE }, payload: {} });
    expect(res.statusCode).toBe(status);
    if (body !== undefined) expect(res.json()).toEqual(body);
  });

  it('refuses a service that is neither migration nor operator with the contract 403', async () => {
    const res = await call({ method: 'POST', url: `/internal/v1/task-queues/${OWN_QUEUE}/pause`, headers: { ...(await serviceHeaders('programs-sites')), ...JSON_TYPE }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe('full app responses', () => {
  const PAGE_ONE = IDS.content.pageOne;
  const contentUrl = (query: string): string => `/_api/json/v1/${SITE_A}/content${query}`;
  const visitor = () => userHeaders({ sub: '', site: SITE_A, roles: [] });
  const FORM_TYPE = { 'content-type': 'application/x-www-form-urlencoded' } as const;
  const pdf = Object.entries(FILE_BYTES).find(([key]) => key.endsWith(`/${IDS.files.pdf}.pdf`))?.[1];
  const errorOf = (res: InjectResponse): unknown => (res.json() as { error: unknown }).error;
  const hasItems = (res: InjectResponse): boolean => Array.isArray((res.json() as { data: { items?: unknown } }).data.items);
  /** programs-sites answering the feed settings lookup with tenant-a's settings, which every stored feed reads before its query. */
  const tenantAFeedSettings = (): void =>
    full.client.on('programs-sites', 'POST', '/internal/v1/sites/feed-settings:lookup', (req) => ({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: {
        items: (req.json as { siteIds: string[] }).siteIds.map(() => ({
          siteID: SITE_A,
          contact: 'webmaster@tenant-a.example',
          javaLocale: 'en_US',
          domain: 'tenant-a.example',
          domainAliases: [],
          enforcePrimaryDomain: false,
          useSSL: false,
          remote: null,
        })),
      },
    }));

  /** One request to the composition root and what its answer must hold beyond the contract. */
  interface FullCase {
    name: string;
    method: 'GET' | 'POST';
    url: string;
    headers: () => Promise<Record<string, string>>;
    payload?: string | Json;
    setup?: () => void;
    status: number;
    // mura.json writes `\'` inside its strings, which JSON.parse rejects; RawLegacyJson declares those bytes as legacy writes them.
    /** Checks the body unparsed against the contract. */
    unparsed?: true;
    verify: (res: InjectResponse) => void;
  }

  const CASES: readonly FullCase[] = [
    {
      name: 'answers a JSON API content findOne with the legacy envelope',
      method: 'GET',
      url: contentUrl(`?id=${PAGE_ONE}`),
      headers: visitor,
      status: 200,
      verify: (res) => expect((res.json() as { data: unknown }).data).toBeTypeOf('object'),
    },
    {
      name: 'answers a JSON API content findMany with the paged envelope',
      method: 'GET',
      url: contentUrl(`?id=${PAGE_ONE},${IDS.content.pageTwo}`),
      headers: visitor,
      status: 200,
      verify: (res) => expect(hasItems(res)).toBe(true),
    },
    {
      name: 'answers a JSON API content findQuery with the paged envelope',
      method: 'GET',
      url: contentUrl('?title=Page'),
      headers: visitor,
      status: 200,
      verify: (res) => expect(hasItems(res)).toBe(true),
    },
    {
      name: 'refuses an anonymous save without CSRF tokens with the legacy 400',
      method: 'POST',
      url: contentUrl(''),
      headers: () => contentHeaders('anonymous'),
      payload: { title: 'Unsaved' },
      status: 400,
      verify: (res) => expect(errorOf(res)).toEqual({ message: 'Invalid CSRF tokens', code: 'invalid_request' }),
    },
    {
      name: 'refuses an unverifiable bearer token with the legacy 401 and its challenge',
      method: 'GET',
      url: contentUrl(''),
      headers: async () => ({ ...(await contentHeaders('anonymous')), authorization: 'Bearer not-a-token' }),
      status: 401,
      verify: (res) => {
        expect(errorOf(res)).toEqual({ message: 'Invalid Access Token', code: 'invalid_token' });
        expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_access_token"');
      },
    },
    {
      name: 'challenges an anonymous REST read with Basic and the legacy 401',
      method: 'GET',
      url: `/_api/rest/v1/${SITE_A}/content`,
      headers: () => contentHeaders('anonymous'),
      status: 401,
      verify: (res) => {
        expect(errorOf(res)).toEqual({ message: 'Insufficient Account Permissions', code: 'invalid_request' });
        expect(res.headers['www-authenticate']).toBe('Basic');
      },
    },
    {
      name: 'refuses a token of another tenant with the legacy 403',
      method: 'GET',
      url: contentUrl(`?id=${PAGE_ONE}`),
      headers: () => contentHeaders('other-tenant'),
      status: 403,
      verify: (res) => expect(errorOf(res)).toEqual({ message: 'Insufficient Account Permissions', code: 'invalid_request' }),
    },
    {
      name: 'answers an unknown entity with the legacy 404',
      method: 'GET',
      url: `/_api/json/v1/${SITE_A}/nosuchentity`,
      headers: visitor,
      status: 404,
      verify: (res) => expect(errorOf(res)).toEqual({ message: 'Invalid method call', code: 'invalid_request' }),
    },
    {
      name: 'answers a failed content read with the legacy 500 server_error',
      method: 'GET',
      url: contentUrl(`?id=${PAGE_ONE}`),
      headers: visitor,
      setup: () =>
        full.db.respond(/"content"\."content"/, () => {
          throw new Error('injected content read failure');
        }),
      status: 500,
      verify: (res) => expect(errorOf(res)).toEqual({ message: 'Unhandled Exception', code: 'server_error' }),
    },
    {
      name: 'streams a stored file through the legacy render route byte for byte',
      method: 'GET',
      url: `/_api/render/file?fileid=${IDS.files.pdf}`,
      headers: visitor,
      status: 200,
      verify: (res) => expect({ type: res.headers['content-type'], bytes: res.rawPayload }).toEqual({ type: 'application/pdf; charset=UTF-8', bytes: pdf?.bytes }),
    },
    {
      name: 'refuses a restricted feed to a visitor with the legacy WDDX 401',
      method: 'GET',
      url: `/_api/feed/v1/${SITE_A}?feedid=${IDS.feeds.local}`,
      headers: visitor,
      setup: () => {
        full.db.respond(/"content"\."feed"/, [feedRow({ feedid: IDS.feeds.local, restricted: 1, restrictgroups: 'Editor' })]);
        tenantAFeedSettings();
      },
      status: 401,
      verify: (res) => {
        expect(res.headers['content-type']).toBe('application/rss+xml; charset=UTF-8');
        expect(res.body).toContain('<string>Insufficient Account Permissions</string>');
      },
    },
    {
      name: 'renders a stored feed as legacy RSS 2.0 with the site settings programs-sites resolves',
      method: 'GET',
      url: `/_api/feed/v1/${SITE_A}?feedid=${IDS.feeds.local}`,
      headers: visitor,
      setup: tenantAFeedSettings,
      status: 200,
      verify: (res) => {
        expect({ type: res.headers['content-type'], language: res.headers['content-language'] }).toEqual({ type: 'text/xml;charset=UTF-8', language: 'en-US' });
        expect(res.body).toContain('<webMaster>webmaster@tenant-a.example</webMaster>');
      },
    },
    {
      name: 'answers the Site Manager tree as the legacy JSON of carch.loadsitemanager',
      method: 'GET',
      url: `/v1/raw/carch/loadsitemanager?siteid=${SITE_A}&topid=${IDS.content.root}&moduleid=${IDS.modules.content}`,
      headers: () => contentHeaders('site-admin'),
      status: 200,
      unparsed: true,
      verify: (res) => expect({ type: res.headers['content-type'], lead: res.body.slice(0, 9) }).toEqual({ type: 'application/json;charset=utf-8', lead: '{"perm":"' }),
    },
    {
      name: 'saves a category behind a validated CSRF token with the AdminWriteResult redirect',
      method: 'POST',
      url: `/v1/sites/${SITE_A}/categories`,
      headers: async () => ({ ...(await contentHeaders('site-admin')), ...FORM_TYPE }),
      payload: `action=update&categoryid=${IDS.categories.pooledChild}&name=Renamed&csrf_token=T&csrf_token_expires=E`,
      setup: () => {
        full.client.csrfValid = true;
      },
      status: 200,
      verify: (res) => {
        expect(res.json()).toEqual({ saved: true, errors: {}, redirect: { circuit: 'cCategory', action: 'list', params: [['siteid', SITE_A]] } });
        expect(full.client.csrfConsumes).toHaveLength(1);
      },
    },
    {
      name: 'saves a rating through the rater and answers the getAvgRating query as Mura.json encodes it, with its write position',
      method: 'POST',
      url: RATER_SAVE_PATH,
      headers: async () => ({ ...(await visitor()), ...FORM_TYPE }),
      payload: `contentID=${PAGE_ONE}&siteID=${SITE_A}&userID=${USER_ID}&rate=4`,
      setup: () => full.db.respond(/ AS theavg, count\(r\.contentid\)/, [{ theavg: 4, thecount: 1, upvotes: null, downvotes: null }]),
      status: 200,
      verify: (res) => {
        // Own oracle, one rating of 4.
        expect({ type: res.headers['content-type'], body: res.body, position: res.headers[WRITE_POSITION_HEADER_LC] }).toEqual({
          type: 'text/html;charset=UTF-8',
          body: '{"recordcount":1,"columnlist":"DOWNVOTES,THEAVG,THECOUNT,UPVOTES","data":{"DOWNVOTES":[""],"THEAVG":[4],"THECOUNT":[1],"UPVOTES":[""]}}',
          position: `${SERVICE}=${FAKE_XID}`,
        });
      },
    },
    {
      name: 'refuses a rater siteID other than the token site with the contract 403, writing nothing',
      method: 'POST',
      url: RATER_SAVE_PATH,
      headers: async () => ({ ...(await visitor()), ...FORM_TYPE }),
      payload: `contentID=${PAGE_ONE}&siteID=${SITE_B}&userID=${USER_ID}&rate=4`,
      status: 403,
      verify: () => expect(full.db.writes()).toEqual([]),
    },
    {
      name: 'answers a non-numeric rater rate with the ColdFusion error page, writing nothing',
      method: 'POST',
      url: RATER_SAVE_PATH,
      headers: async () => ({ ...(await visitor()), ...FORM_TYPE }),
      payload: `contentID=${PAGE_ONE}&siteID=${SITE_A}&userID=${USER_ID}&rate=abc`,
      status: 500,
      verify: (res) => {
        expect({ type: res.headers['content-type'], message: res.statusMessage, writes: full.db.writes() }).toEqual({
          type: 'text/html;charset=UTF-8',
          message: 'An Error Occurred',
          writes: [],
        });
      },
    },
  ];

  it.each(CASES)('$name', async (c) => {
    c.setup?.();
    const res = await full.app.inject({ method: c.method, url: c.url, headers: await c.headers(), ...(c.payload === undefined ? {} : { payload: c.payload }) });
    expect(res.statusCode, res.body).toBe(c.status);
    assertResponseMatchesOpenApi(OPENAPI, {
      method: c.method,
      path: c.url.split('?')[0] ?? c.url,
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: c.unparsed === true ? res.rawPayload : res.body,
    });
    c.verify(res);
  });
});
