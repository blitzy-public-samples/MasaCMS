/** routes/v1/carch page and write routes over the recording pool: declarations, the circuit gate, before() defaults, session effects, screen models, data manager writes and the raw render context. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Roles, collectRouteMatrix, moduleRole, type Role } from '@opt2/platform/auth';
import { LEGACY_ADMIN_SENTINEL_ID, apiUnavailableResponse, isCfUuid } from '@opt2/platform/legacy-compat';
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
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, assertResponseMatchesOpenApi, type InjectResponse } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { circuitRouteConfig, requireCircuitAccess } from '../../src/routes/v1/access.js';
import { CARCH_SITE_SETTINGS_REASON, CARCH_VERSION_PREVIEW_EXCEPTION, carchRawActions, registerCarchRoutes } from '../../src/routes/v1/carch.js';
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
/** UPDATED_AT as the contract's LocalTimestamp: the stored wall clock, without an offset. */
const UPDATED_AT_TEXT = '2026-06-02T14:05:06.007';
/** ENTERED as ColdFusion prints a query timestamp. */
const ENTERED_TEXT = '2026-06-03 09:00:00.0';

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
const RESPONSE_CURSOR = /^DECLARE content_rows_\d+ NO SCROLL CURSOR FOR SELECT r\.\* FROM "content"\."form_response_packet" r /;
const RESPONSE_BATCH = /^FETCH FORWARD \d+ FROM content_rows_\d+$/;
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
/** The errors the routes raised, as the error handler receives them. */
const routeErrors: Error[] = [];
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
      app.addHook('onError', async (_request, _reply, error) => {
        routeErrors.push(error);
      });
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
  routeErrors.length = 0;
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
    expect(rc.rsTop).toEqual([expect.objectContaining({ contentid: NODE, lastupdate: UPDATED_AT_TEXT })]);
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

  /** A getPrivateSearch row of tenant-a. */
  const searchRow = (overrides: Json = {}): Json => ({ ...versionRow(overrides), supersort: 0, priority: 2, haskids: 0 });

  /** `count` search matches, `about-1` first. */
  const matches = (count: number): Json[] => Array.from({ length: count }, (_, i) => searchRow({ filename: `about-${String(i + 1)}` }));

  it.each([
    ['no page', ''],
    ['page 1', '&page=1'],
    ['page 2', '&page=2'],
    ['page x', '&page=x'],
    ['page -4', '&page=-4'],
  ] as const)('halts %s of 65 matches with the legacy 503 after the search and the session.keywords write', async (_name, query) => {
    t.db.respond(SEARCH, matches(65));
    const res = await call('GET', `${SEARCH_URL}?keywords=About${query}`);
    expect([res.statusCode, res.json()], res.body).toEqual([503, JSON.parse(apiUnavailableResponse().body)]);
    expect(saved).toEqual([{ keywords: 'About' }]);
    expect([SEARCH, CRUMBS, WRITE].map((pattern) => ran(pattern))).toEqual([true, false, false]);
    expect(paramsOfFirst(SEARCH)).toContain(SITE);
  });

  it.each([
    ['no match', 0, '', 1],
    ['a page past the last', 65, '&page=4', 91],
  ] as const)('answers %s with no rows, its pager, the clipboard and session.keywords', async (_name, count, query, startRow) => {
    t.db.respond(SEARCH, matches(count));
    identity.state = { mura: { copyContentID: CHILD, copySiteID: SITE } };
    const rc = await rcOf(`${SEARCH_URL}?keywords=About${query}`);
    expect(rc.rslist).toEqual([]);
    expect(rc.nextn).toMatchObject({ totalRecords: count, recordsPerPage: 30, startRow });
    expect(rc).not.toHaveProperty('site');
    expect([rc.copyContentID, rc.copySiteID]).toEqual([CHILD, SITE]);
    expect(saved).toEqual([{ keywords: 'About' }]);
  });
});

describe('carch.draft', () => {
  const DRAFTS_URL = `/v1/sites/${SITE}/content/drafts`;
  const GROUP = 'F1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
  const MEMBERSHIPS = /FROM "content"\."membership_projection"/;
  const GROUPS = /FROM "content"\."group_projection"/;
  const GRANTS = /FROM "content"\."permission_projection"/;
  const EDITOR_ROLES = [Roles.systemUser, m('000')] as const;
  const statementsOf = (pattern: RegExp) => t.db.statements.filter((statement) => pattern.test(statement.sql));

  /** A getDraftList row of the session user. */
  const draftRow = (contentid: string, overrides: Json = {}): Json => ({
    contenthistid: HIST, contentid, siteid: SITE, moduleid: SITE_TREE, parentid: CHILD, type: 'Page', subtype: 'Landing', menutitle: 'About',
    lastupdate: UPDATED_AT, module: 'Site Manager', ...overrides,
  });

  /** The crumb walk's rows: NODE of a custom-icon subtype under its restricted Folder, and a component under its module. */
  const crumbRows = [
    crumb(NODE, { parentid: CHILD, subtype: 'Landing' }),
    crumb(CHILD, { type: 'Folder', menutitle: 'Home', restricted: 1 }),
    crumb(GRANDCHILD, { type: 'Component', moduleid: COMPONENTS, parentid: COMPONENTS, menutitle: 'Footer' }),
  ];
  const crumbIds = (): unknown[] => statementsOf(CRUMBS).map((statement) => (statement.params[0] as string[])[0]);
  const nodeCrumbdata = [
    expect.objectContaining({ contentid: NODE, type: 'Page', subtype: 'Landing', restricted: 0, parentarray: [NODE, CHILD], iconclass: 'mi-star' }),
    expect.objectContaining({ contentid: CHILD, type: 'Folder', menutitle: 'Home', restricted: 1, iconclass: 'mi-folder-open-o' }),
  ];

  /** The crumb reads, the site's Page/Landing icon and the session user's membership of the private-pool group `Editors`. */
  function respondCrumbsAndGroups(grants: ReadonlyArray<readonly [string, string]>): void {
    t.db.respond(CRUMBS, (params) => crumbRows.filter((row) => (params[0] as string[]).includes(String(row.contentid))));
    t.db.respond(SUBTYPES, [{ siteid: SITE, type: 'Page', subtype: 'Landing', iconclass: 'icon-star' }]);
    t.db.respond(MEMBERSHIPS, [{ group_id: GROUP }]);
    t.db.respond(GROUPS, [{ tenant_id: TENANT_A.tenantId, group_id: GROUP, group_name: 'Editors', site_id: SITE, is_public: 0, deleted: false }]);
    t.db.respond(GRANTS, grants.map(([contentId, type]) => ({ tenant_id: TENANT_A.tenantId, group_id: GROUP, site_id: SITE, content_id: contentId, type })));
  }

  it('reads the session user’s drafts of the site, and no crumbs, groups or icons when there are none', async () => {
    const rc = await rcOf(DRAFTS_URL);
    expect(rc.rsList).toEqual([]);
    expect(JSON.stringify(paramsOfFirst(DRAFTS))).toContain(USER_ID);
    expect([ran(CRUMBS), ran(MEMBERSHIPS), ran(SUBTYPES)]).toEqual([false, false, false]);
  });

  it.each([
    ['S2', [Roles.s2], [], 'editor'],
    ['an Author grant of a held group on the node', EDITOR_ROLES, [[NODE, 'Author']], 'author'],
    ['an Editor grant on the restricted parent', EDITOR_ROLES, [[CHILD, 'Editor']], 'editor'],
    ['a Read grant only', EDITOR_ROLES, [[NODE, 'Read']], 'read'],
    ['no grant', EDITOR_ROLES, [], 'none'],
    ['a Deny on the node above an Editor grant on its parent', EDITOR_ROLES, [[NODE, 'Deny'], [CHILD, 'Editor']], 'none'],
  ] as const)('gives a draft its crumbdata with icon classes and its node verdict for %s, read in the token tenant', async (_name, roles, grants, verdict) => {
    t.db.respond(DRAFTS, [draftRow(NODE)]);
    respondCrumbsAndGroups(grants);
    const res = await call('GET', DRAFTS_URL, { roles });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { rc: Json }).rc.rsList).toEqual([{ ...draftRow(NODE), lastupdate: UPDATED_AT_TEXT, verdict, crumbdata: nodeCrumbdata }]);
    expect(statementsOf(CRUMBS).map((statement) => [statement.tenantId, statement.params])).toEqual([
      [TENANT_A.tenantId, [[NODE, NODE.toLowerCase()], SITE]],
      [TENANT_A.tenantId, [[CHILD, CHILD.toLowerCase()], SITE]],
    ]);
  });

  it('keeps every draft and its columns in list order, reading crumbs per draft and memberships and icons once', async () => {
    const component = draftRow(GRANDCHILD, { type: 'Component', subtype: 'Default', moduleid: COMPONENTS, parentid: COMPONENTS, menutitle: 'Footer', module: 'Components' });
    t.db.respond(DRAFTS, [component, draftRow(NODE)]);
    respondCrumbsAndGroups([[NODE, 'Author']]);
    const res = await call('GET', DRAFTS_URL, { roles: EDITOR_ROLES });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { rc: Json }).rc.rsList).toEqual([
      { ...component, lastupdate: UPDATED_AT_TEXT, verdict: 'none', crumbdata: [expect.objectContaining({ contentid: GRANDCHILD, iconclass: 'mi-align-justify' })] },
      { ...draftRow(NODE), lastupdate: UPDATED_AT_TEXT, verdict: 'author', crumbdata: nodeCrumbdata },
    ]);
    expect(crumbIds()).toEqual([GRANDCHILD, COMPONENTS, NODE, CHILD]);
    expect(new Set(statementsOf(CRUMBS).map((statement) => statement.tenantId))).toEqual(new Set([TENANT_A.tenantId]));
    expect(statementsOf(MEMBERSHIPS).map((statement) => statement.tenantId)).toEqual([TENANT_UMBRELLA.tenantId, TENANT_A.tenantId]);
    expect(statementsOf(SUBTYPES).map((statement) => [statement.tenantId, statement.params])).toEqual([[TENANT_A.tenantId, expect.arrayContaining([SITE])]]);
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
    expect(bean).toMatchObject({ isNew: 0, Contentid: NODE, ContentHistID: HIST, type: 'Form', Title: 'Contact Us', LastUpdate: UPDATED_AT_TEXT });
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
  const HISTORY_URL = `/v1/sites/${SITE}/content/${NODE}/history`;
  const auditUrl = (contentId: string, contentHistId: string): string => `/v1/sites/${SITE}/content/${contentId}/versions/${contentHistId}/audit`;
  const VERSION_PARENTS = /^SELECT contenthistid, parentid FROM "content"\."content" WHERE contenthistid = ANY/;
  const CHANGESET_READ = /^SELECT \* FROM "content"\."changeset" WHERE tenant_id = \$1 AND /;
  const CHANGESET = 'F1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
  const OTHER_PARENT = 'A1B2C3D4-0009-4A5B-8C7D9E0F1A2B3C4D';
  /** Each screen's URL for content `contentId`. */
  const SCREENS = [
    ['carch.hist', (contentId: string) => `/v1/sites/${SITE}/content/${contentId}/history`],
    ['carch.audit', (contentId: string) => auditUrl(contentId, HIST)],
  ] as const;
  /** Each screen's URL and a responder listing `rows` as its versions. */
  const VERSION_LISTS = [
    [
      'carch.hist',
      HISTORY_URL,
      (rows: Json[]): void => {
        t.db.respond(HISTORY_TOTAL, [{ total: rows.length }]);
        t.db.respond(HISTORY_ROWS, rows);
      },
    ],
    ['carch.audit', auditUrl(NODE, HIST), (rows: Json[]): void => t.db.respond(VERSION, rows)],
  ] as const;
  /** The rows of `rc.items` carrying a preview URL under any spelling. */
  const withPreviewUrl = (rc: Json): Json[] => (rc.items as Json[]).filter((item) => Object.keys(item).some((key) => key.toLowerCase() === 'previewurl'));

  it('lists the node’s versions with the active bean and its stats, crumbs, verdict, flags and parents, without preview links', async () => {
    t.db.respond(ACTIVE, [versionRow()]);
    t.db.respond(ITEM_COUNT, [{ menutitle: 'About', title: 'About', filename: 'about', lastupdate: UPDATED_AT, type: 'Page' }]);
    t.db.respond(CRUMBS, [crumb(NODE)]);
    t.db.respond(STATS, [{ contentid: NODE, siteid: SITE, views: 3, comments: 0, lockid: '', locktype: '' }]);
    t.db.respond(HISTORY_TOTAL, [{ total: 2 }]);
    t.db.respond(HISTORY_ROWS, [{ contenthistid: HIST, active: 1, type: 'Component' }, { contenthistid: OLDER_HIST, active: 0, type: 'Variation' }]);
    t.db.respond(VERSION_PARENTS, [{ contenthistid: HIST, parentid: OTHER_PARENT }, { contenthistid: OLDER_HIST, parentid: null }]);
    const rc = await rcOf(HISTORY_URL);
    expect(rc).toMatchObject({
      contentid: NODE,
      contentBean: { contenthistid: HIST, isNew: 0, lastupdate: UPDATED_AT_TEXT, stats: { views: 3 } },
      rsCount: [expect.objectContaining({ menutitle: 'About' })],
      crumbdata: [expect.objectContaining({ contentid: NODE })],
      perm: 'editor',
      stats: { views: 3 },
      deletable: true,
      hasLockableNodes: false,
      hasChangesets: true,
      purgeDrafts: true,
      siteLocking: 'none',
      historyTotal: 2,
    });
    expect(rc.items).toEqual([
      { contenthistid: HIST, active: 1, type: 'Component', parentid: OTHER_PARENT },
      { contenthistid: OLDER_HIST, active: 0, type: 'Variation', parentid: '' },
    ]);
    expect(paramsOfFirst(VERSION_PARENTS)).toEqual([[HIST, HIST.toLowerCase(), OLDER_HIST, OLDER_HIST.toLowerCase()]]);
  });

  it('halts a history whose later version alone is a Page with the legacy 503 naming its exceptions entry', async () => {
    t.db.respond(HISTORY_TOTAL, [{ total: 2 }]);
    t.db.respond(HISTORY_ROWS, [versionRow({ type: 'Component' }), versionRow({ contenthistid: OLDER_HIST, type: 'Page' })]);
    const res = await call('GET', HISTORY_URL);
    expect(res.statusCode, res.body).toBe(503);
    expect(routeErrors).toEqual([expect.objectContaining({ reason: CARCH_SITE_SETTINGS_REASON, message: expect.stringContaining(`(${CARCH_VERSION_PREVIEW_EXCEPTION})`) })]);
  });

  describe.each(VERSION_LISTS)('%s preview links', (screen, url, listVersions) => {
    it.each(['Page', 'folder', 'CALENDAR', 'Gallery', 'Link', 'File'])(
      'halts a list holding a %s version with the legacy 503 naming its exceptions entry, emitting no model',
      async (type) => {
        listVersions([versionRow({ type })]);
        const res = await call('GET', url);
        expect(res.statusCode, res.body).toBe(503);
        expect(res.body).not.toContain(HIST);
        expect(routeErrors).toEqual([
          expect.objectContaining({ reason: CARCH_SITE_SETTINGS_REASON, message: `${screen.replace('carch', 'cArch')} prints preview URLs built from site settings this service does not hold (${CARCH_VERSION_PREVIEW_EXCEPTION})` }),
        ]);
        expect([CARCH_VERSION_PREVIEW_EXCEPTION, CARCH_SITE_SETTINGS_REASON]).toEqual(['EX-CARCH-VERSION-PREVIEW', 'carch-site-settings']);
        expect(ran(WRITE)).toBe(false);
      },
    );

    it.each(['Component', 'Form', 'Module', 'Variation', 'variation', ''])('serves a %j version without a preview URL', async (type) => {
      listVersions([versionRow({ type })]);
      const rc = await rcOf(url);
      expect(rc.items).toEqual([expect.objectContaining({ contenthistid: HIST, type })]);
      expect(withPreviewUrl(rc)).toEqual([]);
    });

    it('fails as legacy does on an ajax request, whose rc.deletable parentid read precedes a Page version’s preview', async () => {
      listVersions([versionRow({ type: 'Page' })]);
      expect((await call('GET', `${url}?ajaxrequest=true`)).statusCode).toBe(500);
      expect(routeErrors).toEqual([expect.objectContaining({ message: 'Element PARENTID is undefined in RC.' })]);
    });
  });

  it('reads no parents for a node without versions', async () => {
    const rc = await rcOf(HISTORY_URL);
    expect([rc.items, ran(VERSION_PARENTS)]).toEqual([[], false]);
  });

  describe.each(SCREENS)('%s rc.deletable', (_screen, urlOf) => {
    it.each([
      ['a node under another parent', NODE, `?parentid=${OTHER_PARENT}`, true, {}, true],
      ['a top-level node under site locking none', NODE, `?parentid=${LEGACY_ADMIN_SENTINEL_ID}`, true, {}, true],
      ['the home page', LEGACY_ADMIN_SENTINEL_ID, '', true, {}, false],
      ['a node whose bean isLocked is 1', NODE, '', true, { islocked: 1 }, false],
      ['a node the user holds no editor verdict on', NODE, '', false, {}, false],
    ] as const)('is computed for %s', async (_name, contentId, query, editor, bean, deletable) => {
      t.db.respond(ACTIVE, [versionRow({ contentid: contentId, ...bean })]);
      if (editor) t.db.respond(CRUMBS, [crumb(contentId)]);
      const rc = await rcOf(`${urlOf(contentId)}${query}`);
      expect([rc.perm, rc.deletable]).toEqual([editor ? 'editor' : 'none', deletable]);
    });

    it('fails as legacy does after the screen reads on an ajax request, whose rc has no parentid', async () => {
      expect([(await call('GET', `${urlOf(NODE)}?ajaxrequest=true`)).statusCode, ran(STATS)]).toEqual([500, true]);
    });

    it('takes the flags from the site settings and configBean, never from request parameters', async () => {
      const domain = ctx.domain;
      ctx.domain = { ...domain, config: { ...domain.config, purgeDrafts: false } };
      try {
        t.db.respond(CRUMBS, [crumb(NODE)]);
        const rc = await rcOf(`${urlOf(NODE)}?deletable=0&hasLockableNodes=1&hasChangesets=0&purgeDrafts=1&siteLocking=all`);
        expect(rc).toMatchObject({ deletable: true, hasLockableNodes: false, hasChangesets: true, purgeDrafts: false, siteLocking: 'none' });
      } finally {
        ctx.domain = domain;
      }
    });
  });

  it.each(['UTC', 'America/New_York', 'Asia/Kolkata'])('prints each stored date as its wall clock under TZ=%s', async (zone) => {
    const before = process.env.TZ;
    process.env.TZ = zone;
    try {
      const stored = new Date(2026, 5, 2, 14, 5, 6, 7);
      t.db.respond(ACTIVE, [versionRow({ lastupdate: stored })]);
      t.db.respond(HISTORY_TOTAL, [{ total: 1 }]);
      t.db.respond(HISTORY_ROWS, [{ contenthistid: HIST, active: 1, lastupdate: stored, changesetpublishdate: stored }]);
      const rc = await rcOf(HISTORY_URL);
      expect([(rc.contentBean as Json).lastupdate, rc.items]).toEqual([UPDATED_AT_TEXT, [expect.objectContaining({ lastupdate: UPDATED_AT_TEXT, changesetpublishdate: UPDATED_AT_TEXT })]]);
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('lists one version’s audit trail as copies of the version rows under the new bean', async () => {
    t.db.respond(VERSION, [versionRow({ contenthistid: OLDER_HIST, active: 0, approvalstatus: 'Pending', type: 'Component' })]);
    const rc = await rcOf(auditUrl(NODE, OLDER_HIST));
    expect(rc).toMatchObject({
      contenthistid: OLDER_HIST,
      contentBean: { isNew: 1, active: 1, siteid: SITE, stats: {} },
      perm: 'none',
      stats: {},
      rsCount: [],
      crumbdata: [],
      deletable: false,
      hasLockableNodes: false,
      hasChangesets: true,
      purgeDrafts: true,
      siteLocking: 'none',
    });
    expect(rc.items).toEqual([
      expect.objectContaining({
        contenthistid: OLDER_HIST,
        active: 0,
        approvalstatus: 'Pending',
        changesetname: '',
        changesetpublishdate: '',
      }),
    ]);
    expect(ran(CHANGESET_READ)).toBe(false);
  });

  it.each([
    ['a stored change set', [{ changesetid: CHANGESET, siteid: SITE, name: 'Spring', publishdate: UPDATED_AT }], 'Spring', UPDATED_AT_TEXT],
    ['a change set without a name or publish date', [{ changesetid: CHANGESET, siteid: SITE, name: null, publishdate: null }], '', ''],
    ['a change set no longer stored', [], '', ''],
  ] as const)('names the change set of a trail version in %s', async (_name, changesets, changesetname, changesetpublishdate) => {
    t.db.respond(ACTIVE, [versionRow()]);
    t.db.respond(VERSION, [versionRow({ contenthistid: OLDER_HIST, active: 0, approved: 0, changesetid: CHANGESET, type: 'Component' })]);
    t.db.respond(CHANGESET_READ, changesets);
    const rc = await rcOf(auditUrl(NODE, OLDER_HIST));
    expect(rc.items).toEqual([expect.objectContaining({ contenthistid: OLDER_HIST, changesetid: CHANGESET, changesetname, changesetpublishdate })]);
    expect(paramsOfFirst(CHANGESET_READ)).toEqual([TENANT_A.tenantId, [CHANGESET, CHANGESET.toLowerCase()]]);
  });
});

describe('carch.multiFileUpload, carch.imagedetails and the version summary', () => {
  it.each([
    ['the upload screen of a parent', `/v1/sites/${SITE}/content/${NODE}/multi-file-upload`],
    ['the upload screen of a child', `/v1/sites/${SITE}/content/${NODE}/multi-file-upload?contentid=${CHILD}`],
    ['the details of listed files', `/v1/sites/${SITE}/files/image-details?fileid=${FILE_PNG},${FILE_JPG}`],
    ['the details of a version’s file', `/v1/sites/${SITE}/files/image-details?contenthistid=${HIST}`],
    ['the details of no file', `/v1/sites/${SITE}/files/image-details`],
  ] as const)('halts %s with the legacy 503 after before(), reading and writing no content', async (_name, url) => {
    const res = await call('GET', url);
    expect([res.statusCode, res.json()], res.body).toEqual([503, JSON.parse(apiUnavailableResponse().body)]);
    expect([CRUMBS, PAGE_COUNT, ITEM_COUNT, FILE_COLUMNS, VERSION, WRITE].map((pattern) => ran(pattern))).toEqual([false, false, false, false, false, false]);
    expect(identityCalls('GET', '/v1/sessions/current/admin-state')).toHaveLength(1);
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
      date1: ENTERED_TEXT,
      date2: ENTERED_TEXT,
      crumbData: [expect.objectContaining({ contentid: NODE })],
      perm: 'editor',
      hasLockableNodes: false,
      useLayoutManager: false,
      rsDataInfo: { firstentered: ENTERED_TEXT, lastentered: ENTERED_TEXT, countentered: 1 },
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
      { responseID: RESPONSE, entered: ENTERED_TEXT, data: expect.anything() },
      { responseID: 'R2', entered: ENTERED_TEXT, data: null },
    ]);
  });

  it('reads the full field list for the display view', async () => {
    t.db.respond(FULL_FIELDS, [{ formfield: 'email' }, { formfield: 'name' }]);
    expect((await rcOf(`${RESPONSES_URL}?action=display`)).fieldnames).toBe('email,name');
  });

  it.each([
    ['a stored response', [packet()], [{ responseID: RESPONSE, entered: ENTERED_TEXT, data: expect.anything() }]],
    ['an unreadable packet', [packet({ data: 'x' })], [{ responseID: RESPONSE, entered: ENTERED_TEXT, data: null }]],
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

  it('deletes the filtered responses in their cursor order and stores a new search in session.mura', async () => {
    t.db.respond(RESPONSE_BATCH, [packet(), packet({ responseid: 'R2' })]);
    identity.state = { locale: 'en_US', mura: { nextN: 20 } };
    const body = await writeOf(DELETE_URL, { minute1: '0', hour1: '0', minute2: '59', hour2: '23', delete: 'true', newSearch: '1', keywords: 'Ann', filterBy: 'name' });
    expect(body.data).toMatchObject({ outcome: 'none', filteredDeletions: 2, keywords: 'Ann' });
    expect(body.saved).toBe(false);
    expect(saved).toEqual([{ mura: { nextN: 20, filterBy: 'name', datakeywords: 'Ann' } }]);
    expect(consumed).toEqual([]);
    expect([ran(RESPONSES), ran(RESPONSE_CURSOR)]).toEqual([false, true]);
    const locks = t.db.statements.filter((statement) => RESPONSE_LOCK.test(statement.sql)).map((statement) => statement.params[1]);
    expect(locks).toEqual([[RESPONSE, RESPONSE.toLowerCase()], [RESPONSE, RESPONSE.toLowerCase()], ['R2', 'r2'], ['R2', 'r2']]);
  });
});

describe('selectmedia, selectfields and variationtargeting', () => {
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

  it('offers the feed fields and the site’s content attributes sorted case-sensitively, less the requested fields', async () => {
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
    expect(rc.availableDisplayList).toBe('Date,Image,Summary,Body,ReadMore,Credits,Comments,Tags,Rating,Alpha,zeta');
    expect(rc).not.toHaveProperty('availableList');
    expect(paramsOfFirst(SETS)).toEqual([TENANT_A.tenantId, ['S1', 's1']]);
  });

  it.each<[string, Record<string, string>, string, string]>([
    ['no displayList', {}, 'Date,Title,Image,Summary,Credits,Tags', 'Body,ReadMore,Comments,Rating'],
    ['a differently cased displayList', { displayList: 'title,Custom' }, 'title,Custom', 'Date,Image,Summary,Body,ReadMore,Credits,Comments,Tags,Rating'],
    ['an untrimmed displayList', { displayList: 'Title ,,date,<b>x"y,Summary' }, 'Title ,,date,<b>x"y,Summary', 'Title,Image,Body,ReadMore,Credits,Comments,Tags,Rating'],
    ['a repeated field', { displayList: 'Date,Date,Title' }, 'Date,Date,Title', 'Image,Summary,Body,ReadMore,Credits,Comments,Tags,Rating'],
    ['request inputs of the model names', { displaylist: 'title', AvailableDisplayList: 'bogus' }, 'title', 'Date,Image,Summary,Body,ReadMore,Credits,Comments,Tags,Rating'],
  ])('models the selectfields lists of %s as legacy does', async (_name, query, displayList, availableDisplayList) => {
    const rc = await rcOf(`/v1/sites/${SITE}/feeds/display-fields?${new URLSearchParams(query).toString()}`);
    const valuesOf = (name: string): unknown[] => Object.keys(rc).filter((key) => key.toLowerCase() === name.toLowerCase()).map((key) => rc[key]);
    expect([valuesOf('displayList'), valuesOf('availableDisplayList'), valuesOf('availableList')]).toEqual([[displayList], [availableDisplayList], []]);
  });

  it('halts the selectfields lists of an empty displayList with the legacy 503, reading and writing nothing', async () => {
    const res = await call('GET', `/v1/sites/${SITE}/feeds/display-fields?displayList=`);
    expect(res.statusCode, res.body).toBe(503);
    expect(ran(SUBTYPES)).toBe(false);
    expect(ran(WRITE)).toBe(false);
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
    t.db.respond(BY_REMOTE_ID, [versionRow({ type: 'Variation', remoteid: 'r1', remoteurl: 'http://stored.example/' })]);
    const form = { siteid: SITE, remoteurl: 'http://remote.example/', remoteid: 'r1', title: 'Remote', parentid: VARIATIONS, moduleid: VARIATIONS, type: 'Variation', contentid: NODE, saveTargeting: 'true', initjs: 'start()' };
    const body = await writeOf(`/v1/sites/${SITE}/variation-targeting`, form);
    expect(body).toMatchObject({ saved: true, errors: {}, redirect: null, data: { contentid: NODE, type: 'Variation', remoteurl: 'http://remote.example/', active: 1, isNew: 0 } });
    expect(Object.keys(body.data ?? {}).filter((key) => /^(contentbean|variationtargeting)$/i.test(key))).toEqual([]);
    const targetings = t.db.statements.filter((statement) => /^INSERT INTO "content"\."variation_targeting" \(/.test(statement.sql)).map((statement) => boundRow(statement.sql, statement.params));
    expect(targetings.at(-1)).toMatchObject({ contentid: NODE, siteid: SITE, initjs: 'start()' });
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
    const node = body.data as Json;
    const contentId = String(node.Contentid);
    expect(isCfUuid(contentId)).toBe(true);
    expect(body).toMatchObject({ saved: true, errors: {}, redirect: null });
    expect(node).toMatchObject({ isNew: 0, Title: 'Remote', remoteID: 'r2', type: 'Variation', remoteURL: 'http://remote.example/', Active: 1 });
    expect(Object.keys(node).filter((key) => /^(contentbean|variationtargeting)$/i.test(key))).toEqual([]);
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
