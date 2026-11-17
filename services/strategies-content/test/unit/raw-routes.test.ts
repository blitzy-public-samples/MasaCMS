/** routes/v1/raw.ts: the contract's `/v1/raw/**` operations registered, gated, CSRF-checked and answered with the legacy bytes. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TENANT_A, assertResponseMatchesOpenApi, type InjectResponse } from '@opt2/platform/testing';
import { CONTENT } from '../../src/repo/tables.js';
import { adminDenial, type AdminDenial } from '../../src/routes/v1/access.js';
import { carchRawActions } from '../../src/routes/v1/carch.js';
import { cchangesetsRawActions } from '../../src/routes/v1/cchangesets.js';
import { ccommentsRawActions } from '../../src/routes/v1/ccomments.js';
import { cfeedRawActions } from '../../src/routes/v1/cfeed.js';
import { cformRawActions } from '../../src/routes/v1/cform.js';
import { cnavRawActions } from '../../src/routes/v1/cnav.js';
import { RAW_OPERATIONS, registerRawRoutes, type RawActionSpec, type RawMethod } from '../../src/routes/v1/raw.js';
import {
  buildContentApp,
  buildTestApp,
  createRecordingDb,
  userHeaders,
  type ClientHandlers,
  type ContentTestApp,
  type RecordingDb,
  type TestApp,
} from '../helpers/app.js';
import { IDS, contentRow, contentSeed, formResponsePacketRow, seedRecordingDb } from '../helpers/seed.js';
import { contentHeaders, subjectSessionId } from '../helpers/tokens.js';

type Json = Record<string, unknown>;
type App = TestApp['app'];

/** The parts of a contract operation or response this suite reads. */
interface ContractResponse {
  $ref?: string;
  content?: Record<string, unknown>;
}
interface ContractOperation {
  operationId: string;
  'x-opt2-transport'?: string;
  'x-opt2-requires'?: string[];
  'x-opt2-public'?: boolean;
  'x-opt2-csrf'?: { validation: string; context?: string };
  responses: Record<string, ContractResponse>;
}

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
  components: { responses: Record<string, ContractResponse> };
};

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
const RAW_PREFIX = '/v1/raw/';

/** One contract operation under `/v1/raw/<circuit>/<action>`. */
interface RawContractOperation {
  key: string;
  circuit: string;
  method: RawMethod;
  path: string;
  op: ContractOperation;
}

const CONTRACT: readonly RawContractOperation[] = Object.entries(OPENAPI.paths)
  .filter(([path]) => path.startsWith(RAW_PREFIX))
  .flatMap(([path, item]) => {
    const [circuit = '', action = ''] = path.slice(RAW_PREFIX.length).split('/');
    return Object.entries(item)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, op]) => ({ key: `${circuit}/${action}`, circuit, method: method.toUpperCase() as RawMethod, path, op }));
  });
const CONTRACT_KEYS = [...new Set(CONTRACT.map(({ key }) => key))];
const GATED = CONTRACT.filter(({ op }) => op['x-opt2-public'] !== true);
const CCOMMENTS = CONTRACT.filter(({ circuit }) => circuit === 'ccomments');

/** Each circuit's raw entries, as `./raw.ts` registers them. */
const RAW_ACTIONS: Readonly<Record<string, Readonly<Record<string, RawActionSpec>>>> = {
  carch: carchRawActions,
  cchangesets: cchangesetsRawActions,
  ccomments: ccommentsRawActions,
  cfeed: cfeedRawActions,
  cform: cformRawActions,
  cnav: cnavRawActions,
};

const SITE = TENANT_A.siteId;
const { content: c, hist: h } = IDS;
const FORM_ID = 'F0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const STRANGER = 'C0000000-0000-0000-0000000000000099';
const REFERER = 'http://localhost/admin/?muraAction=cComments.default';
const TOKEN = { 'x-csrf_token': 'T0KEN', 'x-csrf_token_expires': '260630235959000' } as const;
const SEEDS = contentSeed();
const VERSION_READ = /AS approvalgroupid FROM "content"\."content" tcontent .* WHERE tcontent\.contenthistid = ANY/;
const ACTIVE_READ = /AS approvalgroupid FROM "content"\."content" tcontent .* WHERE tcontent\.contentid = ANY/;
const CRUMB_READ = /tfiles\.fileext, tapprovalassignments\.chainid, tapprovalassignments\.exemptid FROM "content"\."content" tcontent/;

/** A seeded request of one raw action and what legacy answers it. */
interface RawCase {
  params: Readonly<Record<string, string>>;
  /** Legacy's status, 200 when absent: 302 for a cflocation, 503 where the action is halted on this service. */
  status?: 302 | 503;
  /** Legacy prints nothing. */
  empty?: true;
  /** The `validateCSRFTokens` context the sent token is consumed under. */
  csrf?: string;
}

const CASES: Readonly<Record<string, RawCase>> = {
  'carch/approvalaction': { params: { requestID: IDS.approval.request, action: 'approve', comment: 'Looks good' } },
  'carch/assocfiles': { params: { type: 'file', property: 'fileid' } },
  'carch/availablechangesets': { params: { changesetID: IDS.changesets.scheduledFuture } },
  'carch/downloaddata': { params: { contentid: c.formNode, columns: 'fixed', sortby: '', keywords: '', date1: '', date2: '' } },
  'carch/draftpromptdata': { params: { contentid: c.pageOne } },
  'carch/getaudittrail': { params: { contenthistid: h.pageOneDraft } },
  'carch/getimagesizeurl': { params: { fileid: IDS.files.image, size: 'small' } },
  'carch/loadcategoryassignment': {
    params: { categoryAssignment: '1', cattrim: 'news', featurestart: '', featureStop: '', startHour: '', startMinute: '', startDayPart: '', stopHour: '', stopMinute: '', stopDayPart: '' },
  },
  'carch/loadcategoryfeaturestartstop': { params: { categoryAssignment: '1', cattrim: 'news' } },
  'carch/loadclass': { params: { classid: 'component' } },
  'carch/loadclassconfigurator': { params: { classid: 'component' }, status: 503 },
  'carch/loaddiff': { params: { contenthistid1: h.pageOneActive, contenthistid2: h.pageOneDraft } },
  'carch/loadexpirenotify': { params: { contentid: c.pageOne }, status: 503 },
  'carch/loadextendedattributes': { params: { contentHistID: h.pageOneActive, type: 'Page', subtype: 'Default' } },
  'carch/loadfilemetadata': { params: { fileid: IDS.files.pdf, contenthistid: h.fileNodeActive } },
  'carch/loadnewcontentmenu': { params: { contentid: c.section } },
  'carch/loadnotify': { params: { contentid: c.pageOne }, status: 503 },
  'carch/loadquickedit': { params: { contentID: c.pageOne, attribute: 'isnav' } },
  'carch/loadrelatedcontent': { params: { contenthistid: h.pageOneActive } },
  'carch/loadselectedrelatedcontent': { params: { contenthistid: h.pageOneActive, type: 'Page', subtype: 'Default' } },
  'carch/loadsiteflat': { params: {} },
  'carch/loadsitemanager': { params: { topid: c.root, moduleid: IDS.modules.content } },
  'carch/loadsitesection': { params: { contentid: c.section, sortby: 'orderno', sortdirection: 'asc' } },
  'carch/loadtagarray': { params: { taggroup: '' } },
  'carch/lockfile': { params: { contentid: c.fileNode }, status: 302, csrf: `${c.fileNode}lockfile` },
  'carch/refreshsitesection': { params: { contentid: c.section, sortby: 'orderno', sortdirection: 'asc' } },
  'carch/savecopyinfo': { params: { contentID: c.pageOne, copyAll: 'false', moduleid: IDS.modules.content }, empty: true },
  'carch/savequickedit': { params: { contentid: c.pageOne, attribute: 'isnav', isnav: '1' }, empty: true, csrf: `${c.pageOne}quickedit` },
  'carch/sitemanagertab': { params: { tab: '0' }, empty: true },
  'carch/siteparents': { params: { parentid: c.section, contentid: c.pageOne } },
  'carch/statusmodal': { params: { contenthistid: h.pageOneActive } },
  'carch/unlockfile': { params: { contentid: c.fileNode }, empty: true, csrf: `${c.fileNode}unlockfile` },
  'carch/unlocknode': { params: { contentid: c.pageOne }, empty: true, csrf: `${c.pageOne}unlocknode` },
  'carch/update': {
    params: { contentid: c.pageOne, contenthistid: h.pageOneDraft, parentid: c.section, action: 'delete', murakeepediting: 'true' },
    status: 302,
    csrf: `${h.pageOneDraft}delete`,
  },
  'cchangesets/loadtagarray': { params: {} },
  'ccomments/ajax': { params: {}, empty: true },
  'ccomments/loadcomments': { params: {} },
  'ccomments/loadcommentspage': { params: {} },
  'cfeed/loadsite': { params: {}, status: 503 },
  'cfeed/siteparents': { params: {}, status: 503 },
  'cfeed/update': { params: { feedid: IDS.feeds.local, action: 'delete' }, status: 302, csrf: IDS.feeds.local },
  'cform/export': { params: { contentid: c.formNode } },
  'cform/getdataset': { params: { datasetID: '', fieldID: FORM_ID } },
  'cform/getdialog': { params: { dialog: 'textfield' } },
  'cform/getfield': { params: { formID: FORM_ID } },
  'cform/getfieldtemplate': { params: { fieldType: 'textfield' } },
  'cform/getfieldtype': { params: { fieldType: 'field-textfield' } },
  'cform/getform': { params: { formID: FORM_ID } },
  'cnav/searchsitedata': { params: { searchString: 'Ten' } },
};

/** identity's admin session store, CSRF token issue and session site list, as the raw entries read them. */
const IDENTITY: ClientHandlers = {
  identity: {
    'GET /v1/sessions/current/admin-state': () => ({ status: 200, headers: {}, body: {} }),
    'POST /v1/sessions/current/admin-state': () => ({ status: 200, headers: {}, body: {} }),
    'POST /v1/csrf/tokens': (req) => ({
      status: 200,
      headers: {},
      body: { tokens: (req.json as { contexts: string[] }).contexts.map((context) => ({ context, csrf_token: `TOK-${context}`, csrf_token_expires: TOKEN['x-csrf_token_expires'] })) },
    }),
    'GET /v1/sessions/current/sites': () => ({ status: 200, headers: {}, body: { sites: [{ siteID: SITE, site: 'Tenant A' }] } }),
  },
};

/** The seeded pool, plus the reads its catch-all answers in another query's shape. */
function seed(db: RecordingDb): void {
  seedRecordingDb(db, SEEDS);
  db.respond(/ AS thecount FROM /, [{ thecount: 0 }]);
  db.respond(/^SELECT min\(tcontenttags\.tag\) AS tag/, [
    { tag: 'alpha', tagcount: 2 },
    { tag: "o'brien", tagcount: 1 },
  ]);
  db.respond(/AS tagcount FROM "?content"?\."?changeset_tag_assign/, [
    { tag: 'Launch', tagcount: 2 },
    { tag: 'Q3', tagcount: 1 },
  ]);
  db.respond(/^SELECT tchangesets\.changesetid, tcontent\.contentid, tcontent\.contenthistid/, []);
  db.respond(/^SELECT tcontent\.siteid AS siteid, tcontent\.title AS title/, []);
  // A crumb read of several walks keeps the rows of the ids it binds, which the table-wide seed answers ignore.
  db.respond(CRUMB_READ, (params, _sql, { tenantId }) => boundRows(seededContent(tenantId), 'contentid')(params));
}

/** The seeded content versions of `tenantId` with the crumb select's joined columns. */
function seededContent(tenantId: string | null): Json[] {
  return SEEDS.filter((seed) => seed.tenant.tenantId.toLowerCase() === tenantId?.toLowerCase()).flatMap((seed) =>
    seed.rows.filter((entry) => entry.table.table === CONTENT.table).map((entry) => ({ fileext: null, chainid: null, exemptid: null, ...entry.row })),
  );
}

/** Rows whose `column` is one of the statement's bound ids, compared ignoring case. */
function boundRows(rows: readonly Json[], column: string): (params: readonly unknown[]) => Json[] {
  return (params) => {
    const bound = new Set(params.flat().flatMap((value) => (typeof value === 'string' ? [value.toLowerCase()] : [])));
    return rows.filter((row) => bound.has(String(row[column]).toLowerCase()));
  };
}

/** `fields` as url fields of a GET or a form body of a POST; `siteid` and `query` always travel in the url. */
function rawRequest(
  app: App,
  method: RawMethod,
  path: string,
  fields: Readonly<Record<string, string>>,
  headers: Record<string, string>,
  query: Readonly<Record<string, string>> = {},
): Promise<InjectResponse> {
  const url = (extra: Readonly<Record<string, string>>): string => `${path}?${new URLSearchParams({ siteid: SITE, ...query, ...extra }).toString()}`;
  if (method === 'GET') return app.inject({ method, url: url(fields), headers });
  return app.inject({
    method,
    url: url({}),
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
}

/**
 * The body as the contract helper reads it. JSON-typed legacy bytes that strict JSON rejects (mura.json's `\'` escapes,
 * a JavaScript literal) are checked as the text itself, which is what the contract's legacy schemas describe.
 */
function contractBody(body: string, contentType: string): string {
  if (!/json/i.test(contentType)) return body;
  try {
    JSON.parse(body);
    return body;
  } catch {
    return JSON.stringify(body);
  }
}

/** mura.json output as a browser script reads it: its `\'` escapes are a JavaScript string's `'`. */
function muraJsonValue(body: string): Json {
  return JSON.parse(body.replaceAll("\\'", "'")) as Json;
}

/** The media types the operation's `status` response declares, through a shared response `$ref`. */
function declaredMediaTypes(op: ContractOperation, status: number): string[] {
  const declared = op.responses[String(status)];
  const shared = declared?.$ref?.replace('#/components/responses/', '');
  return Object.keys((shared === undefined ? declared : OPENAPI.components.responses[shared])?.content ?? {});
}

/** Whether `header` is `declared`'s media type with every parameter `declared` states, compared ignoring case and spaces. */
function carriesMediaType(header: string, declared: string): boolean {
  const parts = (value: string): string[] => value.toLowerCase().replace(/\s+/g, '').split(';');
  const [type, ...params] = parts(declared);
  const [actualType, ...actualParams] = parts(header);
  return actualType === type && params.every((param) => actualParams.includes(param));
}

/** Each route `printRoutes` lists by full path, with its sorted methods; a nested line continues its parent's path. */
function printedRawRoutes(app: App): Map<string, string[]> {
  const routes = new Map<string, string[]>();
  const parents: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = /^([│ ]*)[├└]── (\S+)(?: \(([^)]*)\))?$/.exec(line);
    if (match === null) continue;
    const depth = (match[1] ?? '').length / 4;
    const path = `${parents[depth - 1] ?? ''}${match[2] ?? ''}`;
    parents.length = depth;
    parents.push(path);
    if (match[3] !== undefined && path.startsWith(RAW_PREFIX)) routes.set(path, match[3].split(', ').sort());
  }
  return routes;
}

/** The contract's raw paths with their sorted methods. */
function contractRoutes(): Map<string, string[]> {
  const routes = new Map<string, string[]>();
  for (const { path, method } of CONTRACT) routes.set(path, [...(routes.get(path) ?? []), method].sort());
  return routes;
}

describe('registration', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await buildTestApp({ env: { LOG_LEVEL: 'error' } });
  });

  afterAll(async () => {
    await t?.close();
  });

  it('mirrors every contract raw operation in RAW_OPERATIONS, in contract order, with its operationId and declared access', () => {
    expect(CONTRACT).toHaveLength(98);
    const expected = CONTRACT.map(({ method, path, op }) => ({
      method,
      url: path,
      operationId: op.operationId,
      opt2: op['x-opt2-public'] === true ? { public: true, transport: op['x-opt2-transport'] } : { requires: op['x-opt2-requires'], transport: op['x-opt2-transport'] },
    }));
    expect(RAW_OPERATIONS.map(({ method, url, operationId, config }) => ({ method, url, operationId, opt2: config.opt2 }))).toEqual(expected);
  });

  it('draws its entries from the circuit RawActions, whose union is exactly the contract raw actions', () => {
    const entries = Object.entries(RAW_ACTIONS).flatMap(([circuit, actions]) => Object.keys(actions).map((action) => `${circuit}/${action}`));
    expect(entries.sort()).toEqual([...CONTRACT_KEYS].sort());
  });

  it('serves every contract raw operation from the service app with the contract methods and no other raw route', () => {
    expect(CONTRACT.filter(({ method, path }) => !t.app.hasRoute({ method, url: path }))).toEqual([]);
    expect(CONTRACT.filter(({ path }) => t.app.hasRoute({ method: 'DELETE', url: path }) || t.app.hasRoute({ method: 'PUT', url: path }))).toEqual([]);
    expect(printedRawRoutes(t.app)).toEqual(contractRoutes());
  });
});

describe('legacy answers', () => {
  let t: TestApp;

  beforeAll(async () => {
    const db = createRecordingDb();
    seed(db);
    t = await buildTestApp({ db, env: { LOG_LEVEL: 'error' }, clientHandlers: IDENTITY });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    t.db.reset();
    seed(t.db);
    t.client.clear();
    t.client.csrfValid = true;
  });

  /** `key`'s seeded request as the site's S2 administrator, carrying a CSRF token. */
  async function asAdmin(method: RawMethod, key: string, fields: Readonly<Record<string, string>> = CASES[key]?.params ?? {}): Promise<InjectResponse> {
    return rawRequest(t.app, method, `${RAW_PREFIX}${key}`, fields, { ...(await contentHeaders('s2', { site: SITE })), ...TOKEN });
  }

  it('has one seeded request per contract raw action', () => {
    expect(Object.keys(CASES).sort()).toEqual([...CONTRACT_KEYS].sort());
  });

  it.each(CONTRACT.map((entry) => ({ ...entry, name: `${entry.method} ${entry.path}` })))(
    '$name answers with the legacy status, declared content type, legacy body and headers, consuming a token only where legacy validates one',
    async ({ key, method, path, op }) => {
      const spec = CASES[key];
      if (spec === undefined) throw new TypeError(`no seeded request for ${key}`);
      const status = spec.status ?? 200;
      const res = await asAdmin(method, key);
      expect(res.statusCode, res.body).toBe(status);
      const contentType = String(res.headers['content-type'] ?? '');
      assertResponseMatchesOpenApi(OPENAPI, { method, path, status, contentType, body: contractBody(res.body, contentType) });
      const declared = declaredMediaTypes(op, status);
      if (declared.length > 0) expect(declared.some((type) => carriesMediaType(contentType, type)), `${contentType} of ${declared.join(', ')}`).toBe(true);
      if (status === 302) expect(res.headers.location).toMatch(/\S/);
      expect(res.body === '').toBe(spec.empty === true || status === 302);
      expect([res.headers.generator, res.headers['strict-transport-security']]).toEqual(['Masa CMS 7.6.1', 'max-age=1200']);
      expect(spec.csrf !== undefined).toBe(op['x-opt2-csrf']?.validation === 'validates');
      const consumed = spec.csrf === undefined ? [] : [{ sessionId: subjectSessionId('s2'), token: TOKEN['x-csrf_token'], expires: TOKEN['x-csrf_token_expires'], context: spec.csrf }];
      expect(t.client.csrfConsumes).toEqual(consumed);
    },
  );

  it('carch/loadsitemanager answers JSON of the tree markup, node verdict and sort', async () => {
    const res = await asAdmin('GET', 'carch/loadsitemanager');
    expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
    const json = muraJsonValue(res.body);
    expect(Object.keys(json).sort()).toEqual(['html', 'perm', 'sortby']);
    expect(json).toMatchObject({ perm: 'editor', sortby: 'orderno' });
    expect(json.html).toEqual(expect.stringContaining('name="viewUpdate"'));
  });

  it('carch/loaddiff answers the bare diff fragment of the older version against the newer, without the admin shell', async () => {
    const at = (day: number): Date => new Date(2026, 5, day, 9, 0, 0, 0);
    const versions = [
      contentRow({ contentid: c.pageOne, contenthistid: h.pageOneActive, title: 'Page One', lastupdate: at(1) }),
      contentRow({ contentid: c.pageOne, contenthistid: h.pageOneDraft, title: 'Page One Revised', lastupdate: at(2) }),
    ];
    t.db.respond(VERSION_READ, boundRows(versions, 'contenthistid'));
    const res = await asAdmin('POST', 'carch/loaddiff');
    expect(res.headers['content-type']).toBe('text/html;charset=UTF-8');
    expect(res.body).toContain('<h3>TITLE</h3>');
    expect(res.body).toContain('Revised');
    expect(res.body).not.toMatch(/<html|<body|<head/i);
  });

  it('carch/downloaddata streams the CSV with the legacy attachment and expiry headers', async () => {
    t.db.respond(ACTIVE_READ, [contentRow({ contentid: c.formNode, moduleid: IDS.modules.forms, type: 'Form', title: 'Contact Us' })]);
    t.db.respond(/^SELECT DISTINCT formfield/, [
      { formfield: 'email', sortkey: 'email' },
      { formfield: 'name', sortkey: 'name' },
    ]);
    let fetched = false;
    t.db.respond(/^FETCH FORWARD \d+ FROM content_rows_\d+$/, () => (fetched ? [] : ((fetched = true), [formResponsePacketRow({ responseid: IDS.forms.responseOne })])));
    const res = await asAdmin('GET', 'carch/downloaddata');
    expect([res.statusCode, res.headers['content-type'], res.headers['content-disposition'], res.headers.expires]).toEqual([
      200,
      'application/msexcel',
      'attachment;filename=Contact-Us_063026.csv',
      '0',
    ]);
    expect(res.body).toBe('DATE/TIME ENTERED,email,name,\r\n2026-06-28 14:00:00.0,"ada@example.org","Ada Lovelace",\r\n');
  });

  it('carch/approvalaction answers the approved version and its preview URL as the legacy JSON bytes', async () => {
    const res = await asAdmin('POST', 'carch/approvalaction');
    expect(carriesMediaType(String(res.headers['content-type']), 'application/json')).toBe(true);
    expect(Object.keys(res.json<Json>()).sort()).toEqual(['contenthistid', 'previewurl']);
    expect(res.json<Json>()).toEqual({ contenthistid: h.sectionDraft, previewurl: expect.stringMatching(new RegExp(`[?&]previewid=${h.sectionDraft}$`)) });
    expect(res.body.endsWith('} ')).toBe(true);
  });

  it('ccomments/ajax answers ajax.cfm`s reset buffer: an empty text/html; charset=utf-8 body', async () => {
    const res = await asAdmin('GET', 'ccomments/ajax');
    expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, 'text/html;charset=utf-8', '']);
  });

  it('cform/getform answers the form bean as application/json; charset=utf-8', async () => {
    const res = await asAdmin('POST', 'cform/getform');
    expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
    expect(res.json<Json>()).toMatchObject({ formid: FORM_ID, fields: {}, pages: [] });
  });

  it('cnav/searchsitedata answers the session sites as an application/json [{id, value}] list', async () => {
    const res = await asAdmin('GET', 'cnav/searchsitedata');
    expect(carriesMediaType(String(res.headers['content-type']), 'application/json')).toBe(true);
    expect(res.body).toBe('[{"id":"tenant-a","value":"Tenant A"}] ');
  });

  it.each([
    { key: 'cchangesets/loadtagarray', contentType: 'text/html;charset=UTF-8', tags: ['Launch', 'Q3'] },
    { key: 'carch/loadtagarray', contentType: 'application/json;charset=utf-8', tags: ['alpha', 'o\\x27brien'] },
  ])('$key answers the tag cloud as a JavaScript array literal', async ({ key, contentType, tags }) => {
    const res = await asAdmin('GET', key);
    const literal = `[${tags.map((tag) => `{id: '${tag}', toString: function() { return '${tag}'; } }`).join(',')}]`;
    expect([res.headers['content-type'], res.body]).toEqual([contentType, literal]);
  });

  it('cform/export answers the zip download bytes unchanged', async () => {
    const res = await asAdmin('GET', 'cform/export');
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/^attachment;filename=\S+\.zip$/);
    expect(res.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('runs a token-validating entry after identity refuses the token, which then skips its write', async () => {
    const valid = await asAdmin('POST', 'carch/lockfile');
    expect(valid.statusCode).toBe(302);
    expect(t.db.writes()).not.toEqual([]);
    t.db.clear();
    t.client.clear();
    t.client.csrfValid = false;
    const refused = await asAdmin('POST', 'carch/lockfile');
    expect([refused.statusCode, refused.body]).toEqual([200, '']);
    expect(t.client.csrfConsumes.map(({ context }) => context)).toEqual([`${c.fileNode}lockfile`]);
    expect(t.db.writes()).toEqual([]);
  });

  it('declares a csrfContext exactly on the entries whose contract validation has one fixed context', () => {
    const declaring = CONTRACT_KEYS.filter((key) => {
      const [circuit = '', action = ''] = key.split('/');
      return RAW_ACTIONS[circuit]?.[action]?.csrfContext !== undefined;
    });
    const fixed = CONTRACT_KEYS.filter((key) => {
      const csrf = CONTRACT.find((entry) => entry.key === key)?.op['x-opt2-csrf'];
      return csrf?.validation === 'validates' && csrf.context !== undefined && !csrf.context.includes(' | ');
    });
    expect(declaring).toEqual(fixed);
  });

  it.each(CCOMMENTS.map((entry) => ({ ...entry, name: `${entry.method} ${entry.path}` })))(
    '$name refuses an editor without the comments module role before any read',
    async ({ method, path }) => {
      const res = await rawRequest(t.app, method, path, {}, await contentHeaders('editor', { site: SITE }));
      expect(res.statusCode).toBe(403);
      assertResponseMatchesOpenApi(OPENAPI, { method, path, status: 403, contentType: res.headers['content-type'], body: res.body });
      expect([t.db.statements, t.client.requests]).toEqual([[], []]);
    },
  );

  it.each(CCOMMENTS.map((entry) => ({ ...entry, name: `${entry.method} ${entry.path}` })))(
    '$name refuses the comments module role without Site Manager at the circuit gate',
    async ({ method, path }) => {
      const headers = await userHeaders({ sub: STRANGER, site: SITE, roles: ['system-user', 'm:015'] });
      const res = await rawRequest(t.app, method, path, {}, { ...headers, ...TOKEN });
      expect(res.statusCode).toBe(403);
      assertResponseMatchesOpenApi(OPENAPI, { method, path, status: 403, contentType: res.headers['content-type'], body: res.body });
      expect(t.client.requests.map(({ method: verb, path: called }) => `${verb} ${called}`)).toEqual(['GET /v1/sessions/current']);
      expect([t.db.statements, t.client.csrfConsumes]).toEqual([[], []]);
    },
  );

  it('admits an anonymous caller to cnav, which has no gate, with an empty site list', async () => {
    const res = await rawRequest(t.app, 'GET', `${RAW_PREFIX}cnav/searchsitedata`, { searchString: '' }, await contentHeaders('anonymous'));
    expect([res.statusCode, res.body]).toEqual([200, '[] ']);
    expect(t.client.requests).toEqual([]);
  });
});

describe('registerRawRoutes alone and secure() redirects', () => {
  let t: ContentTestApp;
  const denials: AdminDenial[] = [];

  beforeAll(async () => {
    // Every request here is refused by the route's declared roles before the handler resolves an actor.
    const ctx = { actorFor: () => Promise.reject(new Error('the route hook refuses before the actor is read')) } as unknown as Parameters<typeof registerRawRoutes>[1];
    t = await buildContentApp({
      declare: (app) => {
        app.addHook('onSend', async (request, reply, payload) => {
          if (reply.statusCode === 401 || reply.statusCode === 403) denials.push(adminDenial(request));
          return payload;
        });
        return registerRawRoutes(app, ctx);
      },
    });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    denials.length = 0;
  });

  it('registers exactly the contract raw operations on an app that has no other raw route', () => {
    expect(printedRawRoutes(t.app)).toEqual(contractRoutes());
  });

  it.each(GATED.map((entry) => ({ ...entry, name: `${entry.method} ${entry.path}` })))(
    '$name answers an anonymous caller 401, which secure() sends to cLogin.main with compactDisplay',
    async ({ method, path }) => {
      // The route hook refuses before the body is parsed, so the compactDisplay secure() reads is the url field.
      const res = await rawRequest(t.app, method, path, {}, await contentHeaders('anonymous'), { compactDisplay: 'true' });
      expect(res.statusCode).toBe(401);
      assertResponseMatchesOpenApi(OPENAPI, { method, path, status: 401, contentType: res.headers['content-type'], body: res.body });
      expect(denials.map(({ redirect }) => redirect)).toEqual([{ kind: 'login', redirect: { circuit: 'cLogin', action: 'main', params: [['compactDisplay', 'true']] } }]);
    },
  );

  it.each(CCOMMENTS.map((entry) => ({ ...entry, name: `${entry.method} ${entry.path}` })))(
    '$name answers an editor without the comments module role 403, which secure() sends back to the referrer',
    async ({ method, path }) => {
      const res = await rawRequest(t.app, method, path, {}, { ...(await contentHeaders('editor', { site: SITE })), referer: REFERER });
      expect(res.statusCode).toBe(403);
      expect(denials.map(({ statusCode, redirect }) => ({ statusCode, redirect }))).toEqual([{ statusCode: 403, redirect: { kind: 'back', location: REFERER } }]);
    },
  );
});
