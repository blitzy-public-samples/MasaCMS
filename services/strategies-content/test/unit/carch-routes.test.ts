/** routes/v1/carch page and write routes over the recording pool: declarations, the circuit gate, before() defaults, session effects, screen models, data manager writes and the raw render context. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Roles, collectRouteMatrix, moduleRole, type Role } from '@opt2/platform/auth';
import { LEGACY_ADMIN_SENTINEL_ID, isCfUuid } from '@opt2/platform/legacy-compat';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  legacyParamsOf,
  sendLegacyResponse,
  type CsrfConsumeRequest,
  type FastifyRequest,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, type InjectResponse } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { circuitRouteConfig, requireCircuitAccess } from '../../src/routes/v1/access.js';
import { carchRawActions, registerCarchRoutes } from '../../src/routes/v1/carch.js';
import { TEST_CLOCK, buildContentApp, userHeaders, type ContentTestApp } from '../helpers/app.js';

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Json>>;
};

const SITE = TENANT_A.siteId;
const USER_ID = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const NODE = 'A1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const CHILD = 'A1B2C3D4-0002-4A5B-8C7D9E0F1A2B3C4D';
const GRANDCHILD = 'A1B2C3D4-0003-4A5B-8C7D9E0F1A2B3C4D';
const HIST = 'B1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const OLDER_HIST = 'B1B2C3D4-0002-4A5B-8C7D9E0F1A2B3C4D';
const RESPONSE = 'D1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const FILE_PNG = 'E1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const FILE_JPG = 'E1B2C3D4-0002-4A5B-8C7D9E0F1A2B3C4D';
const FILE_PDF = 'E1B2C3D4-0003-4A5B-8C7D9E0F1A2B3C4D';
const SITE_TREE = '00000000000000000000000000000000000';
const COMPONENTS = '00000000000000000000000000000000003';
const FORMS = '00000000000000000000000000000000004';
const VARIATIONS = '00000000000000000000000000000000099';
/** before()'s whitelisted 36-character module id, for which legacy keeps no default top. */
const LONG_VARIATIONS = '000000000000000000000000000000000099';
const ROOT_PARENT = '00000000000000000000000000000000END';
const m = (digits: string): Role => moduleRole(`00000000000000000000000000000000${digits}`);
const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const TOKEN = { 'x-csrf_token': 'T0KEN', 'x-csrf_token_expires': '260630235959000' } as const;
const UPDATED_AT = new Date(2026, 5, 2, 14, 5, 6, 7);
const ENTERED = new Date(2026, 5, 3, 9, 0, 0, 0);

const TOP = /^SELECT tcontent\.contenthistid, tcontent\.contentid, tcontent\.moduleid, .* WHERE tcontent\.siteid = \$1 AND tcontent\.active = 1 AND tcontent\.contentid = ANY/;
const CRUMBS = /LEFT JOIN "content"\."approval_assignment" tapprovalassignments/;
const VERSION = /AS approvalgroupid FROM "content"\."content" tcontent .* WHERE tcontent\.contenthistid = ANY/;
const ACTIVE = /AS approvalgroupid FROM "content"\."content" tcontent .* WHERE tcontent\.contentid = ANY/;
const BY_TITLE = /AS approvalgroupid FROM "content"\."content" tcontent .* WHERE lower\(rtrim\(tcontent\.title\)\)/;
const BY_REMOTE_ID = /AS approvalgroupid FROM "content"\."content" tcontent .* WHERE lower\(rtrim\(tcontent\.remoteid\)\)/;
const NEST = /AND tcontent\.parentid = ANY\(\$2::bpchar\[\]\) AND tcontent\.active = 1/;
const STATS = /FROM "content"\."content_stats" s WHERE/;
const DRAFTS = /^SELECT \* FROM \(SELECT draft\.contenthistid/;
const SEARCH = /AS supersort FROM "content"\."content" tcontent/;
const ITEM_COUNT = /^SELECT tcontent\.menutitle, tcontent\.title, tcontent\.filename, tcontent\.lastupdate, tcontent\.type FROM/;
const PAGE_COUNT = /AS counter FROM "content"\."content"/;
const HISTORY_TOTAL = /^SELECT count\(\*\)::integer AS total FROM "content"\."content" tcontent LEFT JOIN "content"\."changeset"/;
const HISTORY_ROWS = /FROM "content"\."content" tcontent LEFT JOIN "content"\."changeset" .* LIMIT \$\d+ OFFSET/;
const DOWNLOAD_SELECT = /AS countentered FROM "content"\."form_response_packet"/;
const DISPLAY_FIELDS = /^SELECT responsedisplayfields FROM/;
const FULL_FIELDS = /^SELECT DISTINCT formfield/;
const READ_RESPONSE = /^SELECT \* FROM "content"\."form_response_packet" WHERE tenant_id = \$1 AND .* LIMIT 1$/;
const RESPONSES = /^SELECT r\.\* FROM "content"\."form_response_packet" r/;
const RESPONSE_LOCK = /^SELECT \* FROM "content"\."form_response_(packet|question)" WHERE tenant_id = \$1 AND \(responseid = ANY.* FOR UPDATE$/;
const FORM_VERSIONS_LOCK = /^SELECT \* FROM "content"\."content" WHERE tenant_id = \$1 AND \(siteid = \$2 AND contentid = ANY.* FOR UPDATE$/;
const FILE_COLUMNS = /^SELECT fileid, fileext, filesize, filename AS assocfilename/;
const SUBTYPES = /FROM "content"\."extend_subtype"/;
const SETS = /FROM "content"\."extend_set" WHERE/;
const ATTRIBUTES = /FROM "content"\."extend_attribute" WHERE/;
const TARGETING = /FROM "content"\."variation_targeting" WHERE/;
const WRITE = /^(INSERT|UPDATE|DELETE)\b/;

/** A wddxPacket of one struct of string fields. */
const wddx = (fields: Record<string, string>): string =>
  `<wddxPacket version='1.0'><header/><data><struct>${Object.entries(fields)
    .map(([name, value]) => `<var name='${name}'><string>${value}</string></var>`)
    .join('')}</struct></data></wddxPacket>`;

let t: ContentTestApp;
let ctx: ContentRouteContext;
const calls: ServiceRequest[] = [];
const saved: Json[] = [];
const consumed: CsrfConsumeRequest[] = [];
const identity = { state: {} as Json | undefined, status: 200, saveStatus: 200, csrfValid: true, user: { userID: USER_ID } as Json };

/** identity's admin session store, CSRF consume and session struct; any other service call fails the test. */
function identityDouble<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
  calls.push(req);
  const answer = (status: number, body: unknown): Promise<ServiceResponse<T>> => Promise.resolve({ status, headers: {}, body: body as T });
  if (req.service === IDENTITY_SERVICE && req.path === '/v1/sessions/current/admin-state' && req.method === 'GET') return answer(identity.status, identity.state);
  if (req.service === IDENTITY_SERVICE && req.path === '/v1/sessions/current/admin-state' && req.method === 'POST') {
    saved.push(req.json as Json);
    return answer(identity.saveStatus, {});
  }
  if (req.service === IDENTITY_SERVICE && req.path === CSRF_CONSUME_PATH && req.method === 'POST') {
    consumed.push(req.json as CsrfConsumeRequest);
    return answer(200, { valid: identity.csrfValid });
  }
  if (req.service === IDENTITY_SERVICE && req.path === '/v1/sessions/current' && req.method === 'GET') return answer(200, { user: identity.user });
  return Promise.reject(new Error(`unexpected service call ${req.service} ${req.method} ${req.path}`));
}

/** The route's answer, checked against the contract unless it is the undeclared legacy 500 or a test-only raw entry. */
async function call(
  method: Method,
  url: string,
  opts: { roles?: readonly Role[] | null; site?: string; payload?: string | Buffer; headers?: Record<string, string> } = {},
): Promise<InjectResponse> {
  const { roles = [Roles.s2], site = SITE, payload, headers = {} } = opts;
  const auth = roles === null ? {} : await userHeaders({ sub: USER_ID, site, roles });
  const res = await t.app.inject({
    method,
    url,
    headers: { ...auth, ...(payload === undefined ? {} : FORM), ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
  if (res.statusCode !== 500 && !url.startsWith('/v1/raw/')) {
    assertResponseMatchesOpenApi(OPENAPI, { method, path: url.split('?')[0] ?? url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  }
  return res;
}

/** The `rc` of a 200 page answer. */
async function rcOf(url: string): Promise<Json> {
  const res = await call('GET', url);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { rc: Json }).rc;
}

/** A write answer's body after a 200. */
async function writeOf(url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<{ saved: boolean; errors: Json; redirect: unknown; data?: Json }> {
  const res = await call('POST', url, { payload: new URLSearchParams(form).toString(), headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { saved: boolean; errors: Json; redirect: unknown; data?: Json };
}

/** A stored `content.content` version of tenant-a as the contentDAO reads select it. */
function versionRow(overrides: Json = {}): Json {
  return {
    contenthistid: HIST,
    contentid: NODE,
    siteid: SITE,
    moduleid: SITE_TREE,
    parentid: LEGACY_ADMIN_SENTINEL_ID,
    path: `${LEGACY_ADMIN_SENTINEL_ID},${NODE}`,
    type: 'Page',
    subtype: 'Default',
    title: 'About',
    menutitle: 'About',
    filename: 'about',
    active: 1,
    approved: 1,
    display: 1,
    body: '<p>About</p>',
    lastupdate: UPDATED_AT,
    lastupdateby: 'Admin User',
    lastupdatebyid: USER_ID,
    fileid: null,
    fileext: null,
    filesize: null,
    ...overrides,
  };
}

/** A crumb of `getCrumbList` directly under the site root, so the walk ends with it. */
function crumb(contentid: string, overrides: Json = {}): Json {
  return { contentid, contenthistid: HIST, siteid: SITE, type: 'Page', subtype: 'Default', menutitle: 'About', parentid: ROOT_PARENT, restricted: 0, moduleid: SITE_TREE, ...overrides };
}

/** The row a single-row `INSERT INTO <table> (columns) VALUES ($1, …)` binds, by column. */
function boundRow(sql: string, params: readonly unknown[]): Json {
  const columns = (/^INSERT INTO \S+ \(([^)]*)\)/.exec(sql)?.[1] ?? '').split(', ').map((column) => column.replace(/"/g, ''));
  return Object.fromEntries(columns.map((column, i) => [column, params[i]]));
}

/** A multipart/form-data payload of text fields and one file part. */
function multipart(fields: Record<string, string>, file: { name: string; filename: string; type: string; data: Buffer }): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----opt2-carch-test';
  const chunks = [
    ...Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Whether any recorded statement matches `pattern`. */
const ran = (pattern: RegExp): boolean => t.db.statements.some((statement) => pattern.test(statement.sql));

/** The parameters of the first recorded statement matching `pattern`. */
const paramsOfFirst = (pattern: RegExp): readonly unknown[] | undefined => t.db.statements.find((statement) => pattern.test(statement.sql))?.params;

/** identity calls of `method` to `path`. */
const identityCalls = (method: Method, path: string): ServiceRequest[] => calls.filter((req) => req.method === method && req.path === path);

beforeAll(async () => {
  t = await buildContentApp({
    declare: async (app) => {
      const db = app.opt2.db;
      if (db === undefined) throw new TypeError('the test app has no pool');
      ctx = {
        domain: { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS },
        clock: TEST_CLOCK,
        actorFor: async (request: FastifyRequest) => actorFromClaims(request.opt2Auth.user, 'Admin User'),
      } as Pick<ContentRouteContext, 'domain' | 'clock' | 'actorFor'> as ContentRouteContext;
      // ./raw.ts's flow for the entries whose render context these tests read: the gate on the request's siteid, then the entry.
      for (const action of ['loaddiff', 'draftpromptdata'] as const) {
        app.route({
          method: ['GET', 'POST'],
          url: `/v1/raw/carch/${action}`,
          config: circuitRouteConfig('carch'),
          handler: async (request, reply) => {
            const actor = await requireCircuitAccess(request, ctx, 'carch', String(legacyParamsOf(request).siteid ?? ''));
            const out = await carchRawActions[action].run(request, ctx, actor);
            return sendLegacyResponse(reply, { status: out.status, headers: { 'content-type': out.contentType, ...out.headers }, body: out.body });
          },
        });
      }
      await registerCarchRoutes(app, ctx);
    },
  });
  Object.defineProperty(t.app.opt2.client, 'request', { value: identityDouble, writable: true, configurable: true, enumerable: true });
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.db.reset();
  calls.length = 0;
  saved.length = 0;
  consumed.length = 0;
  Object.assign(identity, { state: {}, status: 200, saveStatus: 200, csrfValid: true, user: { userID: USER_ID } });
});

/** Every carch page and write route with a request its handler accepts. */
const ROUTES: ReadonlyArray<readonly [string, Method, string]> = [
  ['list', 'GET', `/v1/sites/${SITE}/content/tree`],
  ['search', 'GET', `/v1/sites/${SITE}/content?keywords=about`],
  ['draft', 'GET', `/v1/sites/${SITE}/content/drafts`],
  ['edit', 'GET', `/v1/sites/${SITE}/content/${NODE}`],
  ['hist', 'GET', `/v1/sites/${SITE}/content/${NODE}/history`],
  ['audit', 'GET', `/v1/sites/${SITE}/content/${NODE}/versions/${HIST}/audit`],
  ['multiFileUpload', 'GET', `/v1/sites/${SITE}/content/${NODE}/multi-file-upload`],
  ['summary', 'GET', `/v1/sites/${SITE}/content/versions/${HIST}/summary`],
  ['updateObjectParams', 'POST', `/v1/sites/${SITE}/content/versions/${HIST}/object-params`],
  ['datamanager', 'GET', `/v1/sites/${SITE}/forms/${NODE}/responses`],
  ['datamanager writes', 'POST', `/v1/sites/${SITE}/forms/${NODE}/responses/delete`],
  ['selectmedia', 'GET', `/v1/sites/${SITE}/content/images?contentid=${NODE}`],
  ['imagedetails', 'GET', `/v1/sites/${SITE}/files/image-details`],
  ['selectfields', 'GET', `/v1/sites/${SITE}/feeds/display-fields`],
  ['variationtargeting', 'GET', `/v1/sites/${SITE}/variation-targeting?remoteid=r1`],
  ['variationtargeting save', 'POST', `/v1/sites/${SITE}/variation-targeting`],
];

describe('route declarations', () => {
  const contract = Object.entries(OPENAPI.paths)
    .filter(([path]) => path.startsWith('/v1/sites/'))
    .flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, op]) => ((op['x-opt2-legacy-actions'] as string[] | undefined) ?? [])[0]?.startsWith('carch.') === true)
        .map(([method, op]) => ({
          method: method.toUpperCase(),
          url: path.replace(/\{(\w+)\}/g, ':$1'),
          transport: op['x-opt2-transport'],
          requires: [...(op['x-opt2-requires'] as string[])].sort(),
        })),
    );
  const byKey = (a: Json, b: Json): number => (`${String(a.url)} ${String(a.method)}` < `${String(b.url)} ${String(b.method)}` ? -1 : 1);
  /** The contract operation of a registered method and Fastify url, if any. */
  const operationOf = (method: string, url: string): Json | undefined => OPENAPI.paths[url.replace(/:(\w+)/g, '{$1}')]?.[method.toLowerCase()];

  it('registers exactly the contract carch operations, each with the carch roles on the service transport', () => {
    const registered = collectRouteMatrix(t.app)
      .routes.filter((route) => route.url.startsWith('/v1/sites/'))
      .filter((route) => {
        const op = operationOf(route.method, route.url);
        return op === undefined || ((op['x-opt2-legacy-actions'] as string[] | undefined) ?? [])[0]?.startsWith('carch.') === true;
      })
      .map((route) => ({ method: route.method, url: route.url, transport: route.transport, requires: [...(route.requires ?? [])].sort() }));
    expect(contract).toHaveLength(16);
    expect(registered.sort(byKey)).toEqual([...contract].sort(byKey));
    const { opt2 } = circuitRouteConfig('carch');
    for (const route of registered) expect({ requires: route.requires, transport: route.transport }).toEqual({ requires: [...(opt2.requires ?? [])].sort(), transport: opt2.transport });
  });

  it('exercises every contract carch operation in the gate tests', () => {
    const pattern = (url: string): string =>
      (url.split('?')[0] ?? url).replace(`/sites/${SITE}/`, '/sites/:siteid/').replace(NODE, ':contentid').replace(HIST, ':contenthistid');
    expect(ROUTES.map(([, method, url]) => `${method} ${pattern(url)}`).sort()).toEqual(contract.map(({ method, url }) => `${method} ${url}`).sort());
  });
});

describe('circuit gate', () => {
  it.each(ROUTES)('%s refuses an editor without the Site Manager module role before reading data or the session', async (_action, method, url) => {
    const res = await call(method, url, { roles: [Roles.systemUser, m('003'), m('004')], ...(method === 'POST' ? { payload: 'a=1' } : {}) });
    expect(res.statusCode).toBe(403);
    expect([t.db.statements, calls]).toEqual([[], []]);
  });

  it.each(ROUTES)('%s admits the Site Manager module role into the handler', async (_action, method, url) => {
    const res = await call(method, url, { roles: [Roles.systemUser, m('000')], ...(method === 'POST' ? { payload: 'a=1' } : {}) });
    expect([401, 403]).not.toContain(res.statusCode);
    expect(identityCalls('GET', '/v1/sessions/current/admin-state')).toHaveLength(1);
  });

  it.each(ROUTES)('%s refuses a token of another site before reading data or the session', async (_action, method, url) => {
    const res = await call(method, url, { site: TENANT_B.siteId, ...(method === 'POST' ? { payload: 'a=1' } : {}) });
    expect(res.statusCode).toBe(403);
    expect([t.db.statements, calls]).toEqual([[], []]);
  });

  it.each([
    ['s2', 200, [Roles.systemUser, Roles.s2]],
    ['a site admin', 200, [Roles.systemUser, Roles.siteAdmin]],
    ['m:000', 200, [Roles.systemUser, m('000')]],
    ['a member', 403, [Roles.member]],
    ['no credential', 401, null],
  ] as const)('drafts answers %s with %i', async (_name, status, roles) => {
    expect((await call('GET', `/v1/sites/${SITE}/content/drafts`, { roles })).statusCode).toBe(status);
  });

  it('refuses a request siteid of another site before reading data or the session', async () => {
    const res = await call('POST', `/v1/sites/${SITE}/forms/${NODE}/responses/delete`, { payload: `siteid=${TENANT_B.siteId}&action=Delete&responseid=${RESPONSE}`, headers: TOKEN });
    expect(res.statusCode).toBe(403);
    expect([t.db.statements, calls]).toEqual([[], []]);
  });
});

describe('carch before()', () => {
  const DRAFTS_URL = `/v1/sites/${SITE}/content/drafts`;

  it('sets the page defaults in legacy order, a new contentHistID and the token site under the name siteid', async () => {
    const rc = await rcOf(`${DRAFTS_URL}?SITEID=${SITE}&startrow=3`);
    expect(Object.keys(rc)).toEqual([
      'startrow', 'siteid', 'ajaxrequest', 'moduleid', 'instanceid', 'return', 'contentid', 'ptype', 'type', 'contentHistID', 'parenthistid',
      'notify', 'preview', 'size', 'action', 'closeCompactDisplay', 'compactDisplay', 'returnURL', 'homeID', 'objectid', 'locking',
      'moduleAssign', 'orderno', 'cancelPendingApproval', 'date1', 'date2', 'ommitPublishingTab', 'ommitRelatedContentTab',
      'ommitAdvancedTab', 'murakeepediting', 'locknode', 'frontend', 'isNav', 'target', 'searchExclude', 'restricted', 'mobileExclude',
      'isLocked', 'forceSSL', 'doCache', 'displayTitle', 'relatedContentSetData', 'responseChart', 'parentid', 'topid', 'rsList',
    ]);
    expect(rc).toMatchObject({
      startrow: '3',
      siteid: SITE,
      ajaxrequest: false,
      moduleid: SITE_TREE,
      instanceid: '',
      ptype: 'Page',
      type: 'Page',
      preview: 0,
      size: 20,
      locking: false,
      orderno: 0,
      target: '_self',
      doCache: 1,
      responseChart: 0,
      topid: LEGACY_ADMIN_SENTINEL_ID,
      rsList: [],
    });
    expect(isCfUuid(String(rc.contentHistID))).toBe(true);
  });

  it('keeps only the ajax defaults for an ajax request, which reads no session', async () => {
    const rc = await rcOf(`${DRAFTS_URL}?ajaxrequest=true`);
    expect(rc).toEqual({ ajaxrequest: 'true', siteid: SITE, moduleid: SITE_TREE, instanceid: '', rsList: [] });
    expect(calls).toEqual([]);
  });

  it.each([
    ['ommitPublishingTab', ['isNav', 'target', 'searchExclude', 'restricted', 'mobileExclude']],
    ['ommitAdvancedTab', ['isLocked', 'forceSSL', 'doCache', 'displayTitle']],
    ['ommitRelatedContentTab', ['relatedContentSetData']],
  ] as const)('leaves out the tab defaults %s omits', async (flag, omitted) => {
    const rc = await rcOf(`${DRAFTS_URL}?${flag}=true`);
    for (const key of omitted) expect(rc).not.toHaveProperty(key);
    expect(rc).toHaveProperty('responseChart', 0);
  });

  it('reads no session for a whitelisted module id with a topid, keeping the request spelling of the keys', async () => {
    const rc = await rcOf(`${DRAFTS_URL}?ModuleID=${COMPONENTS}&TopID=${NODE}`);
    expect(rc).toMatchObject({ ModuleID: COMPONENTS, TopID: NODE });
    expect(rc).not.toHaveProperty('moduleid');
    expect(rc).not.toHaveProperty('topid');
    expect(calls).toEqual([]);
  });

  it('replaces a module id outside the whitelist with the session module and takes its top from the session', async () => {
    identity.state = { moduleid: FORMS, moduleTopIds: { [`m${FORMS}`]: CHILD } };
    const rc = await rcOf(`${DRAFTS_URL}?moduleid=00000000000000000000000000000000010`);
    expect([rc.moduleid, rc.topid]).toEqual([FORMS, CHILD]);
    expect(identityCalls('GET', '/v1/sessions/current/admin-state')).toHaveLength(1);
  });

  it('falls back to the Site Manager module for a session module outside the whitelist and an empty module id', async () => {
    identity.state = { moduleid: '00000000000000000000000000000000010' };
    const rc = await rcOf(`${DRAFTS_URL}?moduleid=`);
    expect([rc.moduleid, rc.topid]).toEqual([SITE_TREE, LEGACY_ADMIN_SENTINEL_ID]);
  });

  it.each([
    [COMPONENTS, COMPONENTS],
    [FORMS, FORMS],
    [VARIATIONS, VARIATIONS],
  ])('defaults the top of module %s to %s', async (moduleId, topId) => {
    expect((await rcOf(`${DRAFTS_URL}?moduleid=${moduleId}`)).topid).toBe(topId);
  });

  it('fails as ACF does for the 36-character module id, whose session top legacy never sets', async () => {
    const res = await call('GET', `${DRAFTS_URL}?moduleid=${LONG_VARIATIONS}`);
    expect(res.statusCode).toBe(500);
    expect(ran(DRAFTS)).toBe(false);
  });

  it('reads an empty session store as no session values', async () => {
    identity.state = undefined;
    expect((await rcOf(DRAFTS_URL)).topid).toBe(LEGACY_ADMIN_SENTINEL_ID);
  });

  it('fails closed with the legacy 503 when identity cannot answer for the session', async () => {
    identity.status = 500;
    const res = await call('GET', DRAFTS_URL);
    expect(res.statusCode).toBe(503);
    expect(ran(DRAFTS)).toBe(false);
  });
});

describe('carch.list', () => {
  const TREE_URL = `/v1/sites/${SITE}/content/tree`;
  const topRow = (overrides: Json = {}): Json => ({ ...versionRow(), sortby: 'orderno', sortdirection: 'asc', lockid: null, locktype: null, ...overrides });

  it('lists the level under topid with the view model, saving only the new flat view arguments in identity', async () => {
    t.db.respond(TOP, [topRow()]);
    t.db.respond(CRUMBS, [crumb(NODE)]);
    const res = await call('GET', `${TREE_URL}?topid=${NODE}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['x-opt2-session-effects']).toBeUndefined();
    const { rc } = res.json() as { rc: Json };
    expect(rc.topid).toBe(NODE);
    expect(rc.rsTop).toEqual([expect.objectContaining({ contentid: NODE, lastupdate: UPDATED_AT.toISOString() })]);
    expect(paramsOfFirst(TOP)).toEqual([SITE, [NODE, NODE.toLowerCase()]]);
    expect(rc).toMatchObject({
      siteConfig: { customTagGroups: '', scaffolding: false, dataCollection: true, hasLockableNodes: false },
      crumbdata: [expect.objectContaining({ contentid: NODE })],
      sortBy: 'orderno',
      sortDirection: 'asc',
      copyContentID: '',
      copySiteID: '',
      copyAll: false,
      modulePerms: { [COMPONENTS]: 'editor', [FORMS]: 'editor' },
      variations: false,
      activeTab: 0,
    });
    expect(rc).not.toHaveProperty('copyModuleID');
    expect(rc).not.toHaveProperty('nextN');
    const flatViewArgs = {
      moduleid: SITE_TREE, sortby: 'lastupdate', sortdirection: 'desc', lockid: '', assignments: false, categoryid: '', tags: '', page: 1,
      type: '', subtype: '', report: '', keywords: '', tab: 0, filtered: false,
    };
    expect(rc.flatViewArgs).toEqual(flatViewArgs);
    expect(saved).toEqual([{ mura: { flatViewArgs: { [SITE]: flatViewArgs } } }]);
    expect(identityCalls('GET', '/v1/sessions/current/admin-state')).toHaveLength(1);
  });

  it('resets an empty level to the Site Manager top and stores it under the module id', async () => {
    t.db.respond(TOP, (params) => (JSON.stringify(params).includes(LEGACY_ADMIN_SENTINEL_ID) ? [topRow({ contentid: LEGACY_ADMIN_SENTINEL_ID })] : []));
    const rc = await rcOf(`${TREE_URL}?topid=${NODE}`);
    expect(rc.topid).toBe(LEGACY_ADMIN_SENTINEL_ID);
    expect(saved[0]).toEqual({ moduleTopIds: { [SITE_TREE]: LEGACY_ADMIN_SENTINEL_ID } });
  });

  it('resets an empty component level to the module itself', async () => {
    identity.state = { moduleTopIds: { [`m${COMPONENTS}`]: NODE } };
    const rc = await rcOf(`${TREE_URL}?moduleid=${COMPONENTS}`);
    expect([rc.topid, saved[0]]).toEqual([COMPONENTS, { moduleTopIds: { [`m${COMPONENTS}`]: NODE, [COMPONENTS]: COMPONENTS } }]);
  });

  it('pages a module outside the content modules with getNextN and no content-module reads', async () => {
    t.db.respond(TOP, [topRow(), topRow({ contentid: CHILD })]);
    const rc = await rcOf(`${TREE_URL}?moduleid=${LONG_VARIATIONS}&topid=${NODE}&startrow=x`);
    expect(rc.nextN).toMatchObject({ totalRecords: 2, recordsPerPage: 30, numberOfPages: 1, currentPageNumber: 1, through: 2, startRow: 1 });
    expect(rc).not.toHaveProperty('crumbdata');
    expect([ran(CRUMBS), saved]).toEqual([false, []]);
  });

  it('keeps the session state, the posted sort and the requested tab, saving nextN, keywords and the refreshed report', async () => {
    t.db.respond(TOP, [topRow()]);
    identity.state = {
      siteid: SITE,
      mura: {
        copyContentID: CHILD,
        copySiteID: SITE,
        copyAll: 'true',
        copyModuleID: COMPONENTS,
        flatViewArgs: { [SITE]: { keywords: 'old', page: 4, tab: 2, filtered: 'maybe' }, other: 'not a struct' },
      },
    };
    const rc = await rcOf(
      `${TREE_URL}?topid=${NODE}&nextN=50&startrow=7&saveSort=1&sortBy=title&sortDirection=desc&keywords=new&refreshFlatview=1&report=mydrafts&reportSortBy=title&reportSortDirection=asc&activeTab=1`,
    );
    expect(rc).toMatchObject({ startrow: 1, sortBy: 'title', sortDirection: 'desc', activeTab: '1', copyContentID: CHILD, copySiteID: SITE, copyAll: true, copyModuleID: COMPONENTS });
    expect(rc.flatViewArgs).toMatchObject({ keywords: 'new', page: 1, tab: 2, report: '', sortby: 'title', direction: 'asc', filtered: false });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ keywords: 'new', mura: { nextN: '50', copyContentID: CHILD, flatViewArgs: { other: {}, [SITE]: expect.objectContaining({ keywords: 'new' }) } } });
  });

  it.each([
    ['number', 4, '4'],
    ['boolean', true, 'true'],
  ] as const)('compares stored %s keywords as CFML prints them, keeping the page for the same url keywords', async (_kind, stored, keywords) => {
    t.db.respond(TOP, [topRow()]);
    identity.state = { mura: { flatViewArgs: { [SITE]: { keywords: stored, page: 3 } } } };
    const rc = await rcOf(`${TREE_URL}?topid=${NODE}&keywords=${keywords}`);
    expect(rc.flatViewArgs).toMatchObject({ keywords, page: 3 });
    expect(saved[0]).toMatchObject({ keywords });
  });

  it('saves nothing when the flat view arguments are unchanged', async () => {
    t.db.respond(TOP, [topRow()]);
    const flatViewArgs = {
      moduleid: SITE_TREE, sortby: 'lastupdate', sortdirection: 'desc', lockid: '', assignments: false, categoryid: '', tags: '', page: 1,
      type: '', subtype: '', report: '', keywords: 'same', tab: 3, filtered: true,
    };
    identity.state = { mura: { flatViewArgs: { [SITE]: flatViewArgs } } };
    const rc = await rcOf(`${TREE_URL}?topid=${NODE}`);
    expect([rc.activeTab, rc.flatViewArgs, saved]).toEqual([3, flatViewArgs, []]);
  });

  it('fails closed when identity refuses a session write', async () => {
    t.db.respond(TOP, [topRow()]);
    identity.saveStatus = 409;
    expect((await call('GET', `${TREE_URL}?topid=${NODE}`)).statusCode).toBe(503);
  });
});

describe('carch.search', () => {
  const SEARCH_URL = `/v1/sites/${SITE}/content`;

  it('fails as legacy does without keywords, before searching or touching the session', async () => {
    const res = await call('GET', SEARCH_URL);
    expect(res.statusCode).toBe(500);
    expect([ran(SEARCH), saved]).toEqual([false, []]);
  });

  it('searches the site, pages by 30 from startrow, stores session.keywords and reads the clipboard', async () => {
    t.db.respond(SEARCH, [{ ...versionRow(), supersort: 0, priority: 2, haskids: 0 }]);
    identity.state = { mura: { copyContentID: CHILD, copySiteID: SITE } };
    const rc = await rcOf(`${SEARCH_URL}?keywords=About&startrow=31`);
    expect(rc.rslist).toEqual([expect.objectContaining({ contentid: NODE, title: 'About' })]);
    expect(rc.nextn).toMatchObject({ totalRecords: 1, recordsPerPage: 30, startRow: 31 });
    expect([rc.copyContentID, rc.copySiteID]).toEqual([CHILD, SITE]);
    expect(saved).toEqual([{ keywords: 'About' }]);
    expect(paramsOfFirst(SEARCH)).toContain(SITE);
  });

  it('reads a startrow that is no positive number as the first row', async () => {
    expect(((await rcOf(`${SEARCH_URL}?keywords=x&startrow=-4`)).nextn as Json).startRow).toBe(1);
  });
});

describe('carch.draft', () => {
  it('lists the session user’s drafts of the site', async () => {
    t.db.respond(DRAFTS, [{ contenthistid: HIST, contentid: NODE, siteid: SITE, menutitle: 'About', lastupdate: UPDATED_AT, module: 'Site Manager' }]);
    const rc = await rcOf(`/v1/sites/${SITE}/content/drafts`);
    expect(rc.rsList).toEqual([expect.objectContaining({ contenthistid: HIST, lastupdate: UPDATED_AT.toISOString() })]);
    expect(JSON.stringify(paramsOfFirst(DRAFTS))).toContain(USER_ID);
  });
});

describe('carch.edit and carch.editLive', () => {
  const EDIT_URL = `/v1/sites/${SITE}/content/${NODE}`;

  /** The compact cArch.edit URL contentBean.getEditURL builds from these values. */
  const editUrl = (v: { hist: string; id: string; type: string; topid: string; parentid: string; moduleid: string }): string =>
    `/admin/?muraAction=cArch.edit&contenthistid=${v.hist}&contentid=${v.id}&type=${v.type}&siteid=${SITE}&topid=${v.topid}&parentid=${v.parentid}&moduleid=${v.moduleid}&compactdisplay=true`;

  it.each([
    ['before()’s Page default', '', { type: 'Page', topid: LEGACY_ADMIN_SENTINEL_ID, parentid: '', moduleid: SITE_TREE }],
    ['Component', '&type=Component', { type: 'Component', topid: COMPONENTS, parentid: COMPONENTS, moduleid: COMPONENTS }],
    ['Form', '&type=Form', { type: 'Form', topid: FORMS, parentid: FORMS, moduleid: FORMS }],
    ['an unlisted type, which setType ignores', '&type=Widget', { type: 'Page', topid: LEGACY_ADMIN_SENTINEL_ID, parentid: '', moduleid: SITE_TREE }],
  ] as const)('opens a node unknown to editLive as a new bean of %s with minted ids, as legacy redirects', async (_name, query, expected) => {
    const bean = (await rcOf(`${EDIT_URL}?instanceid=I1${query}`)).contentBean as Json;
    expect(bean).toMatchObject({ isNew: 1, Active: 1, siteiD: SITE, type: expected.type, ModuleID: expected.moduleid, ParentID: expected.parentid });
    const [hist, id] = [String(bean.ContentHistID), String(bean.Contentid)];
    expect([isCfUuid(hist), isCfUuid(id), id === NODE]).toEqual([true, true, false]);
    expect(bean.editUrl).toBe(editUrl({ hist, id, ...expected }));
  });

  it('opens a form by title and type, its edit URL topped by its module', async () => {
    t.db.respond(BY_TITLE, [versionRow({ type: 'Form', moduleid: FORMS, parentid: FORMS, title: 'Contact Us' })]);
    const rc = await rcOf(`${EDIT_URL}?title=${encodeURIComponent('Contact Us')}&type=Form`);
    const bean = rc.contentBean as Json;
    expect(bean).toMatchObject({ isNew: 0, Contentid: NODE, ContentHistID: HIST, type: 'Form', Title: 'Contact Us', LastUpdate: UPDATED_AT.toISOString() });
    expect(bean.editUrl).toBe(editUrl({ hist: HIST, id: NODE, type: 'Form', topid: FORMS, parentid: FORMS, moduleid: FORMS }));
    expect(paramsOfFirst(BY_TITLE)).toEqual(expect.arrayContaining(['Contact Us', 'Form']));
  });

  it('opens a page by title without narrowing the type', async () => {
    t.db.respond(BY_TITLE, [versionRow()]);
    const bean = (await rcOf(`${EDIT_URL}?title=About&type=Page`)).contentBean as Json;
    expect(bean).toMatchObject({ isNew: 0, type: 'Page' });
    expect(paramsOfFirst(BY_TITLE)).not.toContain('Page');
  });

  it('keeps a stored component’s type for an ajax editLive, which before() gives no type', async () => {
    t.db.respond(ACTIVE, [versionRow({ type: 'Component', moduleid: COMPONENTS, parentid: COMPONENTS })]);
    const bean = (await rcOf(`${EDIT_URL}?ajaxrequest=true`)).contentBean as Json;
    expect(bean.editUrl).toBe(editUrl({ hist: HIST, id: NODE, type: 'Component', topid: COMPONENTS, parentid: COMPONENTS, moduleid: COMPONENTS }));
  });

  it('answers the new bean web redirects to cArch.hist for a version that does not exist', async () => {
    const rc = await rcOf(`${EDIT_URL}?contenthistid=${HIST}`);
    expect(rc.contentBean).toEqual({ active: 1, siteid: SITE, isNew: 1 });
    expect(paramsOfFirst(VERSION)).toEqual([[HIST, HIST.toLowerCase()]]);
    expect(ran(WRITE)).toBe(false);
  });

  it.each([
    ['a stored version', `?contenthistid=${HIST}`, true],
    ['a missing Variation version', `?contenthistid=${HIST}&type=Variation`, false],
    ['a missing version opened for an object instance', `?contenthistid=${HIST}&instanceid=I1`, false],
    ['an empty contenthistid', '?contenthistid=', false],
  ] as const)('halts the edit form with the legacy 503 for %s, writing nothing', async (_name, query, stored) => {
    if (stored) t.db.respond(VERSION, [versionRow()]);
    const res = await call('GET', `${EDIT_URL}${query}`);
    expect(res.statusCode, res.body).toBe(503);
    expect(ran(WRITE)).toBe(false);
  });
});

describe('carch.hist and carch.audit', () => {
  it('lists the node’s versions with the active bean, crumbs, verdict and stats', async () => {
    t.db.respond(ACTIVE, [versionRow()]);
    t.db.respond(ITEM_COUNT, [{ menutitle: 'About', title: 'About', filename: 'about', lastupdate: UPDATED_AT, type: 'Page' }]);
    t.db.respond(CRUMBS, [crumb(NODE)]);
    t.db.respond(STATS, [{ contentid: NODE, siteid: SITE, views: 3, comments: 0, lockid: '', locktype: '' }]);
    t.db.respond(HISTORY_TOTAL, [{ total: 2 }]);
    t.db.respond(HISTORY_ROWS, [{ contenthistid: HIST, active: 1 }, { contenthistid: OLDER_HIST, active: 0 }]);
    const rc = await rcOf(`/v1/sites/${SITE}/content/${NODE}/history`);
    expect(rc).toMatchObject({
      contentid: NODE,
      contentBean: { contenthistid: HIST, isNew: 0, lastupdate: UPDATED_AT.toISOString() },
      rsCount: [expect.objectContaining({ menutitle: 'About' })],
      crumbdata: [expect.objectContaining({ contentid: NODE })],
      perm: 'editor',
      stats: { views: 3 },
      items: [{ contenthistid: HIST, active: 1 }, { contenthistid: OLDER_HIST, active: 0 }],
      historyTotal: 2,
    });
  });

  it('lists one version’s audit trail as copies of the version rows', async () => {
    t.db.respond(VERSION, [versionRow({ contenthistid: OLDER_HIST, active: 0 })]);
    const rc = await rcOf(`/v1/sites/${SITE}/content/${NODE}/versions/${OLDER_HIST}/audit`);
    expect(rc).toMatchObject({ contenthistid: OLDER_HIST, contentBean: { isNew: 1, active: 1, siteid: SITE }, perm: 'none', stats: {}, rsCount: [], crumbdata: [] });
    expect(rc.items).toEqual([expect.objectContaining({ contenthistid: OLDER_HIST, active: 0 })]);
  });
});

describe('carch.multiFileUpload and the version summary', () => {
  it('reads the upload screen of the parent named by the path', async () => {
    t.db.respond(CRUMBS, [crumb(NODE)]);
    t.db.respond(PAGE_COUNT, [{ counter: 7 }]);
    const rc = await rcOf(`/v1/sites/${SITE}/content/${NODE}/multi-file-upload?contentid=${CHILD}`);
    expect(rc).toMatchObject({ parentid: NODE, contentid: CHILD, crumbdata: [expect.objectContaining({ contentid: NODE })], perm: 'editor', rsCount: [], rsPageCount: [{ counter: 7 }], rsRestrictGroups: [] });
    expect(paramsOfFirst(CRUMBS)).toEqual([[NODE, NODE.toLowerCase()], SITE]);
    expect(paramsOfFirst(ITEM_COUNT)).toEqual([[CHILD, CHILD.toLowerCase()], SITE]);
  });

  it('summarises a stored version with its node stats', async () => {
    t.db.respond(VERSION, [versionRow()]);
    t.db.respond(STATS, [{ contentid: NODE, siteid: SITE, views: 9, lockid: USER_ID, locktype: 'node' }]);
    const rc = await rcOf(`/v1/sites/${SITE}/content/versions/${HIST}/summary`);
    expect(rc.contentBean).toMatchObject({ contenthistid: HIST, isNew: 0, stats: { views: 9, lockid: USER_ID } });
    expect(rc.stats).toMatchObject({ locktype: 'node' });
    expect(paramsOfFirst(STATS)).toEqual([[NODE, NODE.toLowerCase()], SITE]);
  });

  it('summarises an unknown version as a new node of the site with empty stats', async () => {
    const rc = await rcOf(`/v1/sites/${SITE}/content/versions/${HIST}/summary`);
    expect([rc.contentBean, rc.stats]).toEqual([{ active: 1, siteid: SITE, isNew: 1, stats: {} }, {}]);
    expect(paramsOfFirst(STATS)).toEqual([[''], SITE]);
  });
});

describe('carch.updateObjectParams', () => {
  const URL = `/v1/sites/${SITE}/content/versions/${HIST}/object-params`;

  it('answers an unsaved result where legacy aborts on an unknown version, consuming no token', async () => {
    expect(await writeOf(URL, { params: '{}' }, TOKEN)).toEqual({ saved: false, errors: {}, redirect: null });
    expect([consumed, ran(WRITE)]).toEqual([[], false]);
  });

  it('answers an unsaved result where the actor holds no verdict on the version', async () => {
    t.db.respond(VERSION, [versionRow()]);
    expect(await writeOf(URL, { params: '{}' })).toEqual({ saved: false, errors: {}, redirect: null });
  });

  it('answers the editor’s version with the posted approval and change set when params is no JSON, writing nothing', async () => {
    t.db.respond(VERSION, [versionRow({ approved: 0 })]);
    t.db.respond(CRUMBS, [crumb(NODE)]);
    const body = await writeOf(URL, { params: 'not json', approved: '1', changesetid: 'CS1', removePreviousChangeset: 'true' }, TOKEN);
    expect(body).toMatchObject({ saved: true, errors: {}, redirect: null });
    expect(body.data?.versionBean).toMatchObject({ ContentHistID: HIST, Approved: '1', changesetID: 'CS1', removePreviousChangeset: 'true', isNew: 0 });
    expect([consumed, ran(WRITE)]).toEqual([[], false]);
  });
});

describe('carch.datamanager', () => {
  const RESPONSES_URL = `/v1/sites/${SITE}/forms/${NODE}/responses`;
  const DELETE_URL = `${RESPONSES_URL}/delete`;
  const formRow = (overrides: Json = {}): Json => versionRow({ type: 'Form', moduleid: FORMS, body: '', sortby: 'Entered', sortdirection: 'desc', responsedisplayfields: '', ...overrides });
  const packet = (overrides: Json = {}): Json => ({ responseid: RESPONSE, formid: NODE, siteid: SITE, entered: ENTERED, fieldlist: 'name', data: wddx({ name: 'Ann' }), ...overrides });

  it('lists the form’s screen data with the form sort, stats and attachment link of the site', async () => {
    t.db.respond(ACTIVE, [formRow()]);
    t.db.respond(CRUMBS, [crumb(NODE, { type: 'Form' })]);
    t.db.respond(DOWNLOAD_SELECT, [{ firstentered: ENTERED, lastentered: ENTERED, countentered: 1 }]);
    t.db.respond(STATS, [{ contentid: NODE, siteid: SITE, views: 1 }]);
    const rc = await rcOf(RESPONSES_URL);
    expect(rc).toMatchObject({
      keywords: '',
      filterBy: '',
      sortBy: 'Entered',
      sortDirection: 'desc',
      date1: ENTERED.toISOString(),
      date2: ENTERED.toISOString(),
      crumbData: [expect.objectContaining({ contentid: NODE })],
      perm: 'editor',
      hasLockableNodes: false,
      useLayoutManager: false,
      rsDataInfo: { firstentered: ENTERED.toISOString(), lastentered: ENTERED.toISOString(), countentered: 1 },
      rsData: [],
      scheme: 'http',
      domain: `${SITE}.opt2.test`,
      serverPort: '',
      context: '',
    });
    expect(rc.contentBean).toMatchObject({ Contentid: NODE, type: 'Form', stats: { views: 1 } });
  });

  it.each([
    ['the summary fields the form stores', 'name^email~email^name', 'email,name', false],
    ['the current field list without stored fields', '', 'name', true],
  ] as const)('lists the columns of %s', async (_name, responsedisplayfields, fieldnames, read) => {
    t.db.respond(ACTIVE, [formRow({ responsedisplayfields })]);
    t.db.respond(FULL_FIELDS, [{ formfield: 'name' }]);
    expect((await rcOf(RESPONSES_URL)).fieldnames).toBe(fieldnames);
    expect(ran(DISPLAY_FIELDS)).toBe(read);
  });

  it('lists the filtered responses, a packet legacy cannot read as null data', async () => {
    t.db.respond(RESPONSES, [packet(), packet({ responseid: 'R2', data: '<not wddx' })]);
    const rc = await rcOf(`${RESPONSES_URL}?minute1=0&hour1=0&minute2=59&hour2=23&date1=bad&date2=bad`);
    expect(rc.rsData).toEqual([
      { responseID: RESPONSE, entered: ENTERED.toISOString(), data: expect.anything() },
      { responseID: 'R2', entered: ENTERED.toISOString(), data: null },
    ]);
  });

  it('reads the full field list for the display view', async () => {
    t.db.respond(FULL_FIELDS, [{ formfield: 'email' }, { formfield: 'name' }]);
    expect((await rcOf(`${RESPONSES_URL}?action=display`)).fieldnames).toBe('email,name');
  });

  it.each([
    ['a stored response', [packet()], [{ responseID: RESPONSE, entered: ENTERED.toISOString(), data: expect.anything() }]],
    ['an unreadable packet', [packet({ data: 'x' })], [{ responseID: RESPONSE, entered: ENTERED.toISOString(), data: null }]],
    ['a missing response', [], []],
  ] as const)('edits %s', async (_name, rows, rsData) => {
    t.db.respond(READ_RESPONSE, rows);
    const rc = await rcOf(`${RESPONSES_URL}?action=edit&responseid=${RESPONSE}`);
    expect(rc.rsData).toEqual(rsData);
  });

  it.each([
    ['Delete', true, 'deleted'],
    ['delete', false, 'none'],
    ['Update', false, 'none'],
  ] as const)('validates the token of %s with a responseid (valid: %s) once, before any write', async (action, valid, outcome) => {
    identity.csrfValid = valid;
    const body = await writeOf(DELETE_URL, { action, responseid: RESPONSE }, TOKEN);
    expect([body.saved, body.data?.outcome]).toEqual([outcome !== 'none', outcome]);
    expect(consumed).toEqual([expect.objectContaining({ context: RESPONSE, token: TOKEN['x-csrf_token'] })]);
    const locks = t.db.statements.filter((statement) => RESPONSE_LOCK.test(statement.sql));
    expect(locks.map((statement) => statement.params)).toEqual(outcome === 'deleted' ? [0, 1].map(() => [TENANT_A.tenantId, [RESPONSE, RESPONSE.toLowerCase()]]) : []);
  });

  it.each([
    ['Delete without a responseid', { action: 'Delete' }],
    ['Update without a responseid', { action: 'Update' }],
    ['no action', { responseid: RESPONSE }],
  ] as const)('consumes no token for %s', async (_name, form) => {
    const body = await writeOf(DELETE_URL, form, TOKEN);
    expect([body.saved, body.data?.outcome, consumed]).toEqual([false, 'none', []]);
    expect(ran(WRITE)).toBe(false);
  });

  it('reads a multipart write, spooling its file part, and consumes the token of its responseid', async () => {
    const body = multipart({ action: 'Delete', responseid: RESPONSE }, { name: 'attachment', filename: 'a.txt', type: 'text/plain', data: Buffer.from('bytes') });
    const res = await call('POST', DELETE_URL, { payload: body.payload, headers: { ...TOKEN, ...body.headers } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ saved: true, data: { outcome: 'deleted', responseid: RESPONSE } });
    expect(consumed.map(({ context }) => context)).toEqual([RESPONSE]);
  });

  it('sets the display fields without a token and clears the action', async () => {
    t.db.respond(ACTIVE, [formRow()]);
    const body = await writeOf(DELETE_URL, { action: 'setDisplay', detailList2: 'name', summaryList2: 'email', nextn: '25', sortBy: 'name', sortDirection: 'asc' });
    expect(body.data).toMatchObject({ outcome: 'display-set', action: '', view: 'responses', filteredDeletions: null });
    expect(consumed).toEqual([]);
    expect(paramsOfFirst(FORM_VERSIONS_LOCK)).toEqual([TENANT_A.tenantId, SITE, [NODE, NODE.toLowerCase()], ['Form']]);
  });

  it('deletes the filtered responses and stores a new search in session.mura', async () => {
    t.db.respond(RESPONSES, [packet(), packet({ responseid: 'R2' })]);
    identity.state = { locale: 'en_US', mura: { nextN: 20 } };
    const body = await writeOf(DELETE_URL, { minute1: '0', hour1: '0', minute2: '59', hour2: '23', delete: 'true', newSearch: '1', keywords: 'Ann', filterBy: 'name' });
    expect(body.data).toMatchObject({ outcome: 'none', filteredDeletions: 2, keywords: 'Ann' });
    expect(body.saved).toBe(false);
    expect(saved).toEqual([{ mura: { nextN: 20, filterBy: 'name', datakeywords: 'Ann' } }]);
    expect(consumed).toEqual([]);
  });
});

describe('selectmedia, imagedetails, selectfields and variationtargeting', () => {
  it('lists the png, jpg, jpeg and svg files of a node, its children and grandchildren once each', async () => {
    t.db.respond(ACTIVE, [versionRow({ fileid: FILE_PNG, fileext: 'PNG' })]);
    t.db.respond(NEST, (params) =>
      JSON.stringify(params).includes(NODE)
        ? [versionRow({ contentid: CHILD, title: 'Child', fileid: FILE_JPG, fileext: 'jpg', filesize: 1 }), versionRow({ contentid: CHILD, title: 'Child', fileid: FILE_JPG, fileext: 'jpg', filesize: 1 })]
        : JSON.stringify(params).includes(CHILD)
          ? [versionRow({ contentid: GRANDCHILD, fileid: FILE_PDF, fileext: 'pdf', filesize: 1 }), versionRow({ contentid: GRANDCHILD, fileid: null, fileext: 'png', filesize: 1 })]
          : [],
    );
    const rc = await rcOf(`/v1/sites/${SITE}/content/images?contentid=${NODE}`);
    expect(rc.fileid).toBe('');
    expect(rc.rsImages).toEqual([
      { fileid: FILE_PNG, title: 'About', contentid: NODE, imageURL: expect.stringContaining(FILE_PNG) },
      { fileid: FILE_JPG, title: 'Child', contentid: CHILD, imageURL: expect.stringContaining(FILE_JPG) },
    ]);
  });

  it('details the listed files with their renditions, a missing file without metadata', async () => {
    t.db.respond(FILE_COLUMNS, [{ fileid: FILE_PNG, fileext: 'png', filesize: 10, assocfilename: 'a.png', contenttype: 'image', contentsubtype: 'png' }]);
    const rc = await rcOf(`/v1/sites/${SITE}/files/image-details?fileid=${FILE_PNG},${FILE_JPG}`);
    const images = rc.images as Json[];
    expect(images.map((image) => [image.fileid, (image.rsMeta as Json | null)?.assocfilename ?? null])).toEqual([[FILE_PNG, 'a.png'], [FILE_JPG, null]]);
    expect(Object.keys(images[0] ?? {})).toEqual(['fileid', 'rsMeta', 'sourceImage', 'small', 'medium', 'large']);
    expect(images[0]?.medium).toEqual(expect.stringContaining(FILE_PNG));
    expect(rc).not.toHaveProperty('contentBean');
  });

  it('details the file of a version when no fileid is given', async () => {
    t.db.respond(VERSION, [versionRow({ fileid: FILE_PNG, fileext: 'png', filesize: 10 })]);
    const rc = await rcOf(`/v1/sites/${SITE}/files/image-details?contenthistid=${HIST}`);
    expect(rc.fileid).toBe(FILE_PNG);
    expect(rc.contentBean).toMatchObject({ contenthistid: HIST, isNew: 0 });
    expect((rc.images as Json[]).map((image) => image.fileid)).toEqual([FILE_PNG]);
  });

  it('offers the feed fields, the site’s content attributes sorted case-sensitively, and any requested field not among them', async () => {
    t.db.respond(SUBTYPES, [
      { subtypeid: 'S1', siteid: SITE, type: 'Page', subtype: 'Default', basetable: 'tcontent', adminonly: 0, isactive: 1 },
      { subtypeid: 'S2', siteid: SITE, type: 'Page', subtype: 'Admin', basetable: 'tcontent', adminonly: 1, isactive: 1 },
      { subtypeid: 'S3', siteid: SITE, type: 'User', subtype: 'Default', basetable: 'tusers', adminonly: 0, isactive: 1 },
    ]);
    t.db.respond(SETS, [{ extendsetid: 'E1', subtypeid: 'S1' }]);
    t.db.respond(ATTRIBUTES, [
      { attributeid: 'A1', extendsetid: 'E1', name: 'zeta', adminonly: 0 },
      { attributeid: 'A2', extendsetid: 'E1', name: 'Alpha', adminonly: 0 },
      { attributeid: 'A3', extendsetid: 'E1', name: 'hidden', adminonly: 1 },
      { attributeid: 'A4', extendsetid: 'E1', name: 'zeta', adminonly: 0 },
    ]);
    const rc = await rcOf(`/v1/sites/${SITE}/feeds/display-fields?displayList=${encodeURIComponent('title,Custom')}`);
    expect(rc.displayList).toBe('title,Custom');
    expect(rc.availableList).toBe('Date,Title,Image,Summary,Body,ReadMore,Credits,Comments,Tags,Rating,Alpha,zeta,Custom');
    expect(paramsOfFirst(SETS)).toEqual([TENANT_A.tenantId, ['S1', 's1']]);
  });

  it('reads the variation node of remoteid with the request values set over it, then the targeting of the posted contentid', async () => {
    t.db.respond(BY_REMOTE_ID, [versionRow({ type: 'Variation', remoteid: 'r1' })]);
    t.db.respond(TARGETING, [{ targetingid: 'T1', contentid: NODE, siteid: SITE, initjs: 'init()', targetingjs: '' }]);
    const rc = await rcOf(`/v1/sites/${SITE}/variation-targeting?remoteid=r1&contentid=${NODE}&title=Requested`);
    expect(rc.contentBean).toMatchObject({ contentid: NODE, contenthistid: HIST, title: 'Requested', type: 'Page', isNew: 0, variationTargeting: { targetingid: 'T1', initjs: 'init()' } });
    expect(paramsOfFirst(BY_REMOTE_ID)).toEqual(expect.arrayContaining(['r1', SITE]));
    expect(paramsOfFirst(TARGETING)).toEqual([TENANT_A.tenantId, [NODE, NODE.toLowerCase()], SITE]);
  });

  it('lets before()’s empty contentid replace the stored one, as contentBean.set(rc) does', async () => {
    t.db.respond(BY_REMOTE_ID, [versionRow({ type: 'Variation', remoteid: 'r1' })]);
    const rc = await rcOf(`/v1/sites/${SITE}/variation-targeting?remoteid=r1`);
    expect(rc.contentBean).toMatchObject({ contentid: '', isNew: 0, variationTargeting: { contentid: '', initjs: '' } });
  });

  it('saves the initialization JS of a stored variation node without saving the node', async () => {
    t.db.respond(BY_REMOTE_ID, [versionRow({ type: 'Variation', remoteid: 'r1' })]);
    const body = await writeOf(`/v1/sites/${SITE}/variation-targeting`, { remoteid: 'r1', contentid: NODE, initjs: 'start()' });
    expect(body).toMatchObject({ saved: true, errors: {}, redirect: null, data: { useLayoutManager: false, contentBean: { contentid: NODE, isNew: 0 }, variationTargeting: { contentid: NODE, initjs: 'start()' } } });
    expect(ran(/^INSERT INTO "content"\."variation_targeting"/)).toBe(true);
    expect(ran(/^INSERT INTO "content"\."content" /)).toBe(false);
    expect(consumed).toEqual([]);
  });

  it('saves a new variation node of remoteid, then the initialization JS of its new content id', async () => {
    const rows: Json[] = [];
    t.db.respond(/^INSERT INTO "content"\."content" \(/, (params, sql) => {
      rows.push({ ...boundRow(sql, params), tcontent_id: rows.length + 1 });
      return rows.slice(-1);
    });
    t.db.respond(VERSION, (params) => rows.filter((row) => JSON.stringify(params).includes(String(row.contenthistid))));
    const form = { remoteid: 'r2', title: 'Remote', parentid: VARIATIONS, moduleid: VARIATIONS, type: 'Variation', remoteurl: 'http://remote.example/', initjs: 'go()' };
    const body = await writeOf(`/v1/sites/${SITE}/variation-targeting`, form);
    const node = body.data?.contentBean as Json;
    const contentId = String(node.Contentid);
    expect(isCfUuid(contentId)).toBe(true);
    expect(body).toMatchObject({ saved: true, errors: {}, redirect: null, data: { useLayoutManager: false, variationTargeting: { contentid: contentId, initjs: 'go()' } } });
    expect(node).toMatchObject({ isNew: 0, Title: 'Remote', remoteID: 'r2', type: 'Variation' });
    expect(rows).toEqual([expect.objectContaining({ contentid: contentId, type: 'Variation', remoteid: 'r2', siteid: SITE })]);
    const targetings = t.db.statements.filter((statement) => /^INSERT INTO "content"\."variation_targeting" \(/.test(statement.sql)).map((statement) => boundRow(statement.sql, statement.params));
    expect(targetings.at(-1)).toMatchObject({ contentid: contentId, siteid: SITE, initjs: 'go()' });
  });

  it.each([
    ['reading the form without remoteid', 'GET', undefined],
    ['saving without remoteid', 'POST', 'initjs=x'],
    ['saving a stored node without initjs', 'POST', 'remoteid=r1'],
  ] as const)('fails as legacy does %s, writing nothing', async (_name, method, payload) => {
    t.db.respond(BY_REMOTE_ID, [versionRow({ type: 'Variation', remoteid: 'r1' })]);
    const res = await call(method, `/v1/sites/${SITE}/variation-targeting`, payload === undefined ? {} : { payload });
    expect(res.statusCode).toBe(500);
    expect(ran(WRITE)).toBe(false);
  });
});

describe('raw render context', () => {
  const diffUrl = `/v1/raw/carch/loaddiff?siteid=${SITE}&contenthistid1=${HIST}&contenthistid2=${OLDER_HIST}`;

  it.each([
    ['en', undefined, 'There are no differences between the content versions'],
    ['ru_RU', 'ru_RU', 'Между версиями содержимого нет различий'],
    ['de', 'de_DE', 'There are no differences between the content versions'],
    ['../ru', undefined, 'There are no differences between the content versions'],
  ] as const)('labels the empty diff from bundle %s, decoding escapes and falling back to en', async (rb, locale, text) => {
    identity.state = { rb, ...(locale === undefined ? {} : { locale }) };
    const res = await call('GET', diffUrl);
    expect([res.statusCode, res.body]).toEqual([200, text]);
    expect(identityCalls('GET', '/v1/sessions/current')).toHaveLength(1);
  });

  it('builds the session memberships from the projections when identity holds none', async () => {
    t.db.respond(VERSION, [versionRow()]);
    const res = await call('GET', diffUrl, { roles: [Roles.systemUser, m('000')] });
    expect([res.statusCode, res.body]).toEqual([200, 'There are no differences between the content versions']);
    expect(ran(/FROM "content"\."membership_projection"/)).toBe(true);
  });

  it('renders the draft prompt without asking identity for tokens it does not print', async () => {
    identity.user = { userID: USER_ID, memberships: 'S2IsPrivate,S2' };
    const res = await call('GET', `/v1/raw/carch/draftpromptdata?siteid=${SITE}&contentid=${NODE}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(identityCalls('POST', '/v1/csrf/tokens')).toEqual([]);
  });
});
