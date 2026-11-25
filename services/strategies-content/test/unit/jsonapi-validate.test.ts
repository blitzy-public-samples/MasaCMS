/** JSON API `validate` on every content entity route against the legacy oracle's answers (test/fixtures/legacy/json-api-validate-answers.json). */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { assertResponseMatchesOpenApi, TENANT_A, TENANT_B, TENANT_UMBRELLA, loadOpenApiDocument } from '@opt2/platform/testing';
import { actorFromClaims, CONTENT_CONFIG_DEFAULTS, type ContentConfig } from '../../src/domain/context.js';
import { contentEntities } from '../../src/legacy/jsonapi-entities.js';
import { jsonApiEndpoint } from '../../src/legacy/jsonapi-serializers.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { resolveJsonApiCall, type JsonApiResolveOptions } from '../../src/routes/jsonapi.js';
import { CfStruct, cfUrlDecode, cfValueOf, deserializeCfJson, UNREADABLE_JSON } from '../../src/routes/jsonapi/cfml-values.js';
import { createJsonApiParams, type JsonApiCall } from '../../src/routes/jsonapi/types.js';
import { validate } from '../../src/routes/jsonapi/validate.js';
import { buildTestApp, createMemoryStorage, createRecordingDb, TEST_CLOCK, type RecordingDb, type Responder, type TestApp } from '../helpers/app.js';
import { ADMIN, SITE as SITE_SETTINGS } from '../helpers/content-fixture.js';
import { tenantASeed } from '../helpers/seed.js';
import { contentHeaders, type ContentSubject } from '../helpers/tokens.js';

type Struct = Record<string, unknown>;

/** One recorded oracle answer and the request that drew it. */
interface Answer {
  subject: 'anonymous' | 'admin';
  route: string;
  data?: string;
  validations?: string;
  method?: 'POST' | 'FORM';
  jsonBody?: Struct;
  status: number;
  contentType: string;
  etag?: string;
  text?: string;
  body?: Struct;
  stacktraceRemoved?: boolean;
  refusal?: string;
}

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/legacy/json-api-validate-answers.json', import.meta.url), 'utf8')) as {
  site: string;
  answers: Record<string, Answer>;
};

const OPENAPI = loadOpenApiDocument(new URL('../../contracts/openapi.yaml', import.meta.url), parse) as object;
const SITE = TENANT_A.siteId;
const REGISTERED: ReadonlySet<string> = new Set([TENANT_A, TENANT_B, TENANT_UMBRELLA].map((tenant) => tenant.siteId));
const RESOLVE: JsonApiResolveOptions = { siteExists: (siteId) => REGISTERED.has(siteId.toLowerCase()), appReloadKey: 'appreload', context: '', variations: true };
const ENDPOINTS = { api: `/_api/json/v1/${SITE}`, rest: `/_api/rest/v1/${SITE}` } as const;
const HOME = '00000000000000000000000000000000001';
const RECORDED = new Date('2024-01-02T03:04:05Z');

/** SQL Server text equality: case-insensitive, trailing spaces ignored. */
const sameText = (a: unknown, b: unknown): boolean => String(a ?? '').replace(/ +$/, '').toLowerCase() === String(b ?? '').replace(/ +$/, '').toLowerCase();
/** Whether an id-list parameter names `id`. */
const namesId = (param: unknown, id: unknown): boolean => (Array.isArray(param) ? param : [param]).some((value) => sameText(value, id));

// ---- the rows the oracle held while recording, on tenant-a ----

/** contentDAO's active-version read of the seeded tenant-a content, home node included. */
const ACTIVE_READ = /^SELECT tcontent\.active\b.* FROM "content"\."content" tcontent LEFT JOIN /;
const TENANT_A_CONTENT: readonly Struct[] = tenantASeed()
  .rows.filter(({ table }) => table.table === 'content')
  .map(({ row }) => row);
const NO_JOINED_ROW: Readonly<Struct> = Object.freeze({
  filesize: null,
  contenttype: null,
  contentsubtype: null,
  fileext: null,
  assocfilename: null,
  approvalstatus: null,
  requestid: null,
  approvalgroupid: null,
});
const activeContentOf =
  (rows: readonly Struct[]): Responder =>
  (params, sql, { tenantId }) => {
    if (tenantId?.toLowerCase() !== TENANT_A.tenantId) return [];
    const column = /tcontent\.contentid = ANY\(/.test(sql) ? 'contentid' : 'filename';
    return rows.filter((row) => row.active === 1 && namesId(params[0], row[column])).map((row) => ({ ...row, ...NO_JOINED_ROW }));
  };

/** capture/feeds.sql: `solo` stores no lang; the two `twin` feeds share a name and a remote id. */
const FEED_READ = /FROM "content"\."feed" tcontentfeeds WHERE /;
const STORED_FEED: Readonly<Struct> = Object.freeze({
  siteid: SITE, parentid: null, isactive: 1, ispublic: 0, isdefault: 0, isfeaturesonly: 0, description: '', maxitems: 20, allowhtml: 1,
  lang: null, lastupdateby: 'admin', lastupdate: RECORDED, datecreated: RECORDED, restricted: 0, restrictgroups: '', version: 'RSS 2.0',
  channellink: '', type: 'local', sortby: 'lastUpdate', sortdirection: 'desc', nextn: 20, displayname: 0, displayratings: 0,
  displaycomments: 0, altname: '', remotesourceurl: '', remotepubdate: null, imagesize: 'small', imageheight: 'AUTO', imagewidth: 'AUTO',
  displaylist: 'Date,Title', shownavonly: 1, showexcludesearch: 0, viewalllink: '', viewalllabel: '', cssclass: '', autoimport: 0,
  islocked: 0, contentpoolid: '', usecategoryintersect: 0, authtype: 'DEFAULT',
});
const FEEDS: readonly Struct[] = [
  { ...STORED_FEED, feedid: 'F1EED000-0000-4000-8000000000000001', name: 'solo', remoteid: 'r-solo' },
  { ...STORED_FEED, feedid: 'F1EED000-0000-4000-8000000000000002', name: 'twin', remoteid: 'r-twin' },
  { ...STORED_FEED, feedid: 'F1EED000-0000-4000-8000000000000003', name: 'twin', remoteid: 'r-twin' },
];
const storedFeedsOf =
  (rows: readonly Struct[]): Responder =>
  (params, sql, { tenantId }) => {
    if (tenantId?.toLowerCase() !== TENANT_A.tenantId) return [];
    const [key, siteId] = params;
    const column = /tcontentfeeds\.feedid = ANY\(/.test(sql) ? 'feedid' : /tcontentfeeds\.name\)/.test(sql) ? 'name' : 'remoteid';
    const found = rows.filter((row) => namesId(key, row[column]) && (column === 'feedid' || row.siteid === siteId));
    return /^SELECT count\(\*\)/.test(sql) ? [{ total: found.length }] : found.slice(0, 1);
  };

/** capture/stored.sql: a category without isFeatureable, a change set, a comment and one without its text. */
const STORED_CATEGORY: Readonly<Struct> = Object.freeze({
  tenant_id: TENANT_A.tenantId, categoryid: 'CA7E0000-0000-4000-8000000000000001', siteid: SITE, parentid: null, datecreated: RECORDED,
  lastupdate: RECORDED, lastupdateby: 'admin', name: 'Stored category', notes: '', isinterestgroup: 0, isactive: 1, isopen: 1,
  sortby: 'orderno', sortdirection: 'asc', restrictgroups: '', path: "'CA7E0000-0000-4000-8000000000000001'", remoteid: 'r-cat',
  remotesourceurl: '', remotepubdate: null, urltitle: 'stored-category', filename: 'stored-category', isfeatureable: null,
});
const STORED_CHANGESET: Readonly<Struct> = Object.freeze({
  tenant_id: TENANT_A.tenantId, changesetid: 'C5E70000-0000-4000-8000000000000001', siteid: SITE, name: 'Stored change set',
  description: '', created: RECORDED, publishdate: null, published: 0, lastupdate: RECORDED, lastupdateby: 'admin', lastupdatebyid: null,
  remoteid: 'r-cs', remotepubdate: null, remotesourceurl: '', closedate: null,
});
const STORED_COMMENT: Readonly<Struct> = Object.freeze({
  commentid: 'C0330000-0000-4000-8000000000000001', contentid: HOME, contenthistid: null, url: null, name: 'Stored',
  comments: 'Stored comment', entered: RECORDED, email: 'stored@example.com', siteid: SITE, ip: '127.0.0.1', isapproved: 1, subscribe: 0,
  userid: null, parentid: null, path: 'C0330000-0000-4000-8000000000000001', remoteid: 'r-cm', flagcount: 0, isspam: 0, isdeleted: 0, kids: null,
});
const STORED_COMMENTS: readonly Struct[] = [
  STORED_COMMENT,
  { ...STORED_COMMENT, commentid: 'C0330000-0000-4000-8000000000000002', comments: null, path: 'C0330000-0000-4000-8000000000000002', remoteid: 'r-cm2' },
];
const CATEGORY_READ = /^SELECT \* FROM "content"\."category" WHERE tenant_id = \$1 AND (categoryid = ANY|lower\(rtrim\(name\)\))/;
const storedCategory: Responder = (params, sql) => {
  const row = STORED_CATEGORY;
  if (params[0] !== row.tenant_id) return [];
  const found = /categoryid = ANY/.test(sql) ? namesId(params[1], row.categoryid) : sameText(params[1], row.name) && params[2] === row.siteid;
  return found ? [row] : [];
};
const CHANGESET_READ = /^SELECT \* FROM "content"\."changeset" WHERE tenant_id = \$1 AND changesetid = ANY/;
const storedChangeset: Responder = (params) => (params[0] === STORED_CHANGESET.tenant_id && namesId(params[1], STORED_CHANGESET.changesetid) ? [STORED_CHANGESET] : []);
const COMMENT_READ = /FROM "content"\."comment" c LEFT JOIN .* WHERE c\.tenant_id = \$1 AND .*c\.commentid/;
const storedComment: Responder = (params) => (params[0] === TENANT_A.tenantId ? STORED_COMMENTS.filter((row) => namesId(params.at(-1), row.commentid)) : []);

/** capture/orm.sql: a file, one with a remote URL, a metadata row of the first, and a change set category assignment. */
const STORED_FILE: Readonly<Struct> = Object.freeze({
  fileid: 'F11E0000-0000-4000-8000000000000001', contentid: HOME, siteid: SITE, moduleid: '00000000000000000000000000000000000',
  filename: 'stored.pdf', image: null, imagesmall: null, imagemedium: null, filesize: 1234, contenttype: 'application', contentsubtype: 'pdf',
  fileext: 'pdf', created: RECORDED, deleted: 0, caption: 'Caption', credits: '', alttext: '', remoteid: 'r-file', remoteurl: '',
  remotepubdate: null, remotesource: '', remotesourceurl: '', exif: null,
});
const REMOTE_FILE_ID = 'F11E0000-0000-4000-8000000000000002';
const STORED_FILES: readonly Struct[] = [
  STORED_FILE,
  { ...STORED_FILE, fileid: REMOTE_FILE_ID, filename: 'remote.pdf', filesize: 99, caption: '', remoteid: 'r-file2', remoteurl: 'http://example.com/remote.pdf' },
];
const STORED_META: Readonly<Struct> = Object.freeze({
  alttext: 'Alt', contenthistid: null, fileid: STORED_FILE.fileid, credits: '', siteid: SITE, remoteurl: '', exif: null, remoteid: 'r-meta',
  remotesourceurl: '', remotesource: '', remotepubdate: null, metaid: 'AE7A0000-0000-4000-8000000000000001', contentid: HOME, caption: 'Meta caption',
});
const STORED_ASSIGNMENT: Readonly<Struct> = Object.freeze({
  tenant_id: TENANT_A.tenantId, siteid: SITE, categoryid: 'CA7E0000-0000-4000-8000000000000009', changesetid: 'C5E70000-0000-4000-8000000000000009',
  assignmentid: 'A5510000-0000-4000-8000000000000001',
});
// tenant-a's files live in its file pool, the umbrella tenant.
const FILE_READ = /FROM "content"\."file" WHERE /;
const storedFile: Responder = (params, _sql, { tenantId }) =>
  tenantId?.toLowerCase() === TENANT_UMBRELLA.tenantId ? STORED_FILES.filter((row) => namesId(params[0], row.fileid)) : [];
const META_READ = /FROM "content"\."file_metadata" WHERE /;
const storedMeta: Responder = (params, _sql, { tenantId }) =>
  tenantId?.toLowerCase() === TENANT_A.tenantId && sameText(params[0], STORED_META.siteid) && sameText(params[1], STORED_META.metaid) ? [STORED_META] : [];
const ASSIGNMENT_READ = /FROM "content"\."changeset_category_assign" WHERE tenant_id = \$1 AND siteid = \$2 AND assignmentid = ANY/;
const storedAssignment: Responder = (params) =>
  params[0] === STORED_ASSIGNMENT.tenant_id && params[1] === STORED_ASSIGNMENT.siteid && namesId(params[2], STORED_ASSIGNMENT.assignmentid) ? [STORED_ASSIGNMENT] : [];

/** The recorded rows, so every other bean a validation loads by a fresh id is new, as on the oracle. */
function recordedDb(extra: { content?: readonly Struct[]; feeds?: readonly Struct[] } = {}): RecordingDb {
  const db = createRecordingDb();
  db.respond(ACTIVE_READ, activeContentOf([...TENANT_A_CONTENT, ...(extra.content ?? [])]));
  db.respond(FEED_READ, storedFeedsOf([...FEEDS, ...(extra.feeds ?? [])]));
  db.respond(CATEGORY_READ, storedCategory);
  db.respond(CHANGESET_READ, storedChangeset);
  db.respond(COMMENT_READ, storedComment);
  db.respond(FILE_READ, storedFile);
  db.respond(META_READ, storedMeta);
  db.respond(ASSIGNMENT_READ, storedAssignment);
  return db;
}

// ---- replaying the oracle's requests ----

/** The oracle's site in a recorded request text, as the fixture tenant's site. */
function onFixtureSite(text: string): string {
  return text.replace(new RegExp(`"(${FIXTURE.site})"`, 'gi'), (_match, site: string) => `"${site === site.toUpperCase() ? SITE.toUpperCase() : SITE}"`);
}

/** The recorded request's query or form fields. */
function requestFields(answer: Answer): Array<[string, string]> {
  const fields: Array<[string, string]> = [['method', 'validate'], ['entityname', answer.route]];
  if (answer.data !== undefined) fields.push(['data', onFixtureSite(answer.data)]);
  if (answer.validations !== undefined) fields.push(['validations', onFixtureSite(answer.validations)]);
  return fields;
}

const encoded = (fields: Array<[string, string]>): string => fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');

/** Validates a replayed answer against the contract's `/_api/json/v1/{siteid}` operation. */
function assertContract(answer: Answer, res: { statusCode: number; headers: Record<string, unknown>; body: string }): void {
  const method = answer.method === undefined ? 'GET' : 'POST';
  assertResponseMatchesOpenApi(OPENAPI, { method, path: `/_api/json/v1/${SITE}`, status: res.statusCode, contentType: String(res.headers['content-type']), body: res.body });
}

async function replay(api: TestApp, answer: Answer) {
  const subject: ContentSubject = answer.subject === 'admin' ? 'site-admin' : 'anonymous';
  const headers = await contentHeaders(subject);
  if (answer.method === 'POST') {
    const payload = onFixtureSite(JSON.stringify(answer.jsonBody));
    return api.app.inject({ method: 'POST', url: `${ENDPOINTS.api}/`, headers: { ...headers, 'content-type': 'application/json' }, payload });
  }
  if (answer.method === 'FORM') {
    const headersForm = { ...headers, 'content-type': 'application/x-www-form-urlencoded' };
    return api.app.inject({ method: 'POST', url: `${ENDPOINTS.api}/`, headers: headersForm, payload: encoded(requestFields(answer)) });
  }
  return api.app.inject({ method: 'GET', url: `${ENDPOINTS.api}/?${encoded(requestFields(answer))}`, headers });
}

// ---- calling the handler directly ----

interface Invocation {
  data?: Struct | string;
  validations?: Struct;
  /** A JSON body, whose nulls the front controller leaves out of the handler's params (../../src/routes/jsonapi.ts). */
  body?: Struct;
  admin?: boolean;
  form?: Struct;
  headers?: Record<string, string>;
}

const ANONYMOUS = actorFromClaims(undefined, '');
const EP = jsonApiEndpoint({ adminSSL: false, requestProtocol: 'http', serverName: 'localhost', serverPort: '', context: '', mode: 'json', siteId: SITE });

/** A validate call of the content route as ../jsonapi.ts builds it. */
function callOf(a: Invocation): JsonApiCall {
  const params: Array<[string, unknown]> = [['method', 'validate'], ['entityname', 'content']];
  if (a.data !== undefined) params.push(['data', typeof a.data === 'string' ? a.data : JSON.stringify(a.data)]);
  if (a.validations !== undefined) params.push(['validations', JSON.stringify(a.validations)]);
  for (const [name, value] of Object.entries(a.body ?? {})) if (value !== null) params.push([name, value]);
  const headers = a.body === undefined ? (a.headers ?? {}) : { ...a.headers, 'content-type': 'application/json' };
  const actor = a.admin === true ? ADMIN : ANONYMOUS;
  return {
    mode: 'json',
    family: '/_api/json/v1',
    routeKey: 'api:content.validate',
    method: 'validate',
    entityName: 'content',
    pathInfo: [SITE],
    params: createJsonApiParams(params),
    query: { raw: '', params: createJsonApiParams([]) },
    siteId: SITE,
    tenantId: TENANT_A.tenantId,
    actor,
    site: SITE_SETTINGS,
    apiContext: {
      siteId: SITE,
      mode: 'json',
      endpoint: EP,
      url: {},
      form: a.form ?? {},
      method: 'validate',
      isAggregateQuery: false,
      user: { loggedIn: actor.isLoggedIn, systemUser: actor.isLoggedIn },
      allowAction: () => false,
      site: SITE_SETTINGS.urls,
      customImageSizes: () => Promise.resolve([]),
    },
    httpMethod: a.body === undefined ? 'GET' : 'POST',
    headers,
    validateCsrf: () => Promise.resolve(true),
  };
}

/** The route context validate reads, over `db`. */
function contextOf(db: RecordingDb, config: Partial<ContentConfig> = {}): ContentRouteContext {
  const repository = createContentRepository({ clock: TEST_CLOCK, schema: db.schema });
  const domain = { db, repository, clock: TEST_CLOCK, config: { ...CONTENT_CONFIG_DEFAULTS, ...config } };
  return { domain, storage: createMemoryStorage({ clock: TEST_CLOCK }) } as unknown as ContentRouteContext;
}

/** The halt reason validate rejects with, or the answer it gives. */
async function outcomeOf(ctx: ContentRouteContext, a: Invocation): Promise<{ halted: string } | { data: unknown }> {
  try {
    return { data: (await validate(ctx, callOf(a))).data };
  } catch (err) {
    if (err instanceof LegacyServiceUnavailableError) {
      expect(err.message).toMatch(/\(EX-CONTENT-VALIDATE\)$/);
      return { halted: err.reason ?? '' };
    }
    throw err;
  }
}

let api: TestApp;
let direct: ContentRouteContext;

beforeAll(async () => {
  const db = recordedDb();
  api = await buildTestApp({ db });
  direct = contextOf(db);
});

afterAll(async () => {
  await api?.close();
});

const ANSWERED = Object.entries(FIXTURE.answers).filter(([, answer]) => answer.refusal === undefined);
const REFUSED = Object.entries(FIXTURE.answers).filter(([, answer]) => answer.refusal !== undefined);

describe('validate against the oracle', () => {
  it.each(ANSWERED)('answers %s as legacy does', async (_name, answer) => {
    const res = await replay(api, answer);
    expect(res.statusCode).toBe(answer.status);
    expect(res.headers['content-type']).toBe(answer.contentType);
    if (answer.text !== undefined) {
      expect(res.body).toBe(answer.text);
      expect(res.headers['etag']).toBe(answer.etag);
    } else {
      expect(res.body).toBe(JSON.stringify(answer.body));
    }
    assertContract(answer, res);
  });

  it.each(REFUSED)('halts %s with the legacy 503 of EX-CONTENT-VALIDATE', async (_name, answer) => {
    const res = await replay(api, answer);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'server_error' } });
    assertContract(answer, res);
    const data = answer.data === undefined ? undefined : onFixtureSite(answer.data);
    const validations = answer.validations === undefined ? undefined : (JSON.parse(onFixtureSite(answer.validations)) as Struct);
    const invocation: Invocation = {
      ...(data === undefined ? {} : { data }),
      ...(validations === undefined ? {} : { validations }),
      ...(answer.method === 'POST' ? { body: JSON.parse(onFixtureSite(JSON.stringify(answer.jsonBody))) as Struct } : {}),
      admin: answer.subject === 'admin',
    };
    await expect(outcomeOf(direct, invocation)).resolves.toEqual({ halted: answer.refusal });
  });
});

describe('validate dispatch', () => {
  const KEYS = (['api', 'rest'] as const).flatMap((family) =>
    contentEntities({ variations: true }).map((entity) => [`${family}:${entity.name.toLowerCase()}.validate`, family, entity.name] as const),
  );

  it.each(KEYS)('resolves %s to the shared validate handler', (key, family, entity) => {
    const url = `${ENDPOINTS[family]}/?method=validate&entityname=${entity}`;
    const query = Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? ''));
    const resolved = resolveJsonApiCall({ method: 'GET', url, query, body: undefined, headers: {} }, RESOLVE);
    expect(resolved.key.key).toBe(key);
    expect(resolved.target).toEqual({ kind: 'entity', operation: 'validate', fn: validate });
  });

  it.each(KEYS)('answers %s with the validation of the posted bean', async (_key, family, entity) => {
    const data = encodeURIComponent(JSON.stringify({ entityname: 'comment' }));
    const url = `${ENDPOINTS[family]}/?method=validate&entityname=${entity}&data=${data}`;
    const res = await api.app.inject({ method: 'GET', url, headers: await contentHeaders('site-admin') });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      apiversion: 'v1',
      data: { comments: "The property named 'comments' is not valid", email: "The property named 'email' is not valid" },
      method: 'validate',
    });
  });
});

describe('validate cases the oracle cannot show', () => {
  const CALENDAR = '0000CA1E-0000-4000-8000000000000001';
  const home = TENANT_A_CONTENT.find((row) => row.contentid === HOME && row.active === 1) ?? {};
  const calendar: Struct = {
    ...home, contentid: CALENDAR, contenthistid: '0000CA1E-0000-4000-8000000000000002', parentid: HOME, type: 'Calendar', subtype: 'Default',
    title: 'Calendar', menutitle: 'Calendar', filename: 'calendar', urltitle: 'calendar', path: `${HOME},${CALENDAR}`,
    displayinterval: JSON.stringify({ detectconflicts: true, detectspan: 12 }),
  };
  const EVENT = '0000CA1E-0000-4000-8000000000000003';
  const event: Struct = {
    ...home, contentid: EVENT, contenthistid: '0000CA1E-0000-4000-8000000000000004', parentid: CALENDAR, type: 'Page', subtype: 'Default',
    title: 'Event', menutitle: 'Event', filename: 'calendar/event', urltitle: 'event', path: `${HOME},${CALENDAR},${EVENT}`, display: 2,
    displaystart: RECORDED, displaystop: new Date('2024-01-03T03:04:05Z'),
  };
  const emptyList: Struct = { ...STORED_FEED, feedid: 'F1EED000-0000-4000-8000000000000004', name: 'unlisted', remoteid: 'r-unlisted', displaylist: '' };
  let ctx: ContentRouteContext;

  beforeAll(() => {
    ctx = contextOf(recordedDb({ content: [calendar, event], feeds: [emptyList] }));
  });

  it.each([
    ["another site's content bean", { entityname: 'content', siteid: TENANT_B.siteId }, 'validate-other-site'],
    ["a loadby of another site's bean", { bean: 'content', loadby: 'contentid', contentid: HOME, siteid: TENANT_B.siteId }, 'validate-other-site'],
    ['a scheduled item of a Calendar detecting display conflicts', { entityname: 'content', contentid: EVENT }, 'validate-display-conflicts'],
    ["a category loadby reading the session's site", { bean: 'category', loadby: 'name', name: 'x', siteid: '' }, 'validate-session-site'],
    ["a feed whose display list is the renderer's", { entityname: 'feed', feedid: emptyList.feedid }, 'validate-renderer-setting'],
    ['a content loadby of a read control', { bean: 'content', loadby: 'use404', use404: true }, 'validate-loadby-column'],
    ['a category loadby of its bean argument', { bean: 'category', loadby: 'categorybean', categorybean: 'x' }, 'validate-loadby-column'],
    ['a comment loadby of its remote id', { bean: 'comment', loadby: 'remoteid', remoteid: 'r-cm' }, 'validate-loadby-column'],
    ['a data value that is not UTF-8 once urlDecoded', '{"x":"%C3"}', 'validate-urldecode'],
  ])('halts %s', async (_label, data, reason) => {
    await expect(outcomeOf(ctx, { data })).resolves.toEqual({ halted: reason });
  });

  it.each([
    ['a change set loadby without a site', { bean: 'changeset', loadby: 'changesetid', changesetid: STORED_CHANGESET.changesetid, siteid: '' }, 'validate-other-site'],
    ['a change set loadby of its name', { bean: 'changeset', loadby: 'name', name: 'Stored change set' }, 'validate-loadby-column'],
    ['a contentCategoryAssign loadby', { bean: 'contentCategoryAssign', loadby: 'categoryid', categoryid: 'x' }, 'validate-loadby-column'],
    ['a file loadby of another column', { bean: 'file', loadby: 'filename', filename: 'stored.pdf' }, 'validate-loadby-column'],
    ["a stored file's URL under another site's attributes", { entityname: 'file', fileid: REMOTE_FILE_ID, siteid: TENANT_B.siteId }, 'validate-other-site'],
  ])('halts %s for an admin', async (_label, data, reason) => {
    await expect(outcomeOf(ctx, { data, admin: true })).resolves.toEqual({ halted: reason });
  });

  it("validates a stored file's URL value without an isValid verdict when no File attribute of the site holds it", async () => {
    await expect(outcomeOf(ctx, { data: { entityname: 'file', fileid: REMOTE_FILE_ID, siteid: '' }, admin: true })).resolves.toEqual({ data: {} });
  });

  it('halts a stored URL value under a File attribute of the site, whose isValid verdict decides', async () => {
    const db = recordedDb();
    db.respond(/FROM "content"\."extend_subtype" WHERE/, [{ tenant_id: TENANT_A.tenantId, subtypeid: 'S1', siteid: SITE, type: 'Base', subtype: 'Default' }]);
    db.respond(/FROM "content"\."extend_set" WHERE/, [{ tenant_id: TENANT_A.tenantId, extendsetid: 'X1', subtypeid: 'S1', siteid: SITE, name: 'Files', orderno: 1 }]);
    db.respond(/FROM "content"\."extend_attribute" WHERE/, [
      { tenant_id: TENANT_A.tenantId, attributeid: 1, extendsetid: 'X1', siteid: SITE, name: 'Hero', type: 'TextBox', orderno: 1 },
      { tenant_id: TENANT_A.tenantId, attributeid: 2, extendsetid: 'X1', siteid: SITE, name: 'remoteURL', type: 'File', orderno: 2 },
    ]);
    await expect(outcomeOf(contextOf(db), { data: { entityname: 'file', fileid: REMOTE_FILE_ID }, admin: true })).resolves.toEqual({
      halted: 'validate-isvalid-pattern',
    });
  });

  it.each([
    ['a multipart form field', { 'content-type': 'multipart/form-data; boundary=x' }, { filename: 'stored.pdf' }, 'validate-multipart-form'],
    ['an uploaded temporary file', {}, { filename: '/tmp/upload.tmp' }, 'validate-posted-file'],
    ['an uploaded file among several values', {}, { caption: ['a', 'b.upload'] }, 'validate-posted-file'],
  ])('halts a file bean value read as %s', async (_label, headers, form, reason) => {
    await expect(outcomeOf(ctx, { data: { entityname: 'file' }, admin: true, headers, form })).resolves.toEqual({ halted: reason });
  });

  it('validates a file bean beside a form field that is no posted file', async () => {
    await expect(outcomeOf(ctx, { data: { entityname: 'file' }, admin: true, form: { filename: 'notes.pdf' } })).resolves.toEqual({ data: {} });
  });

  it('skips the restricted-file scan where no extensions are allowed', async () => {
    const open = contextOf(recordedDb(), { fmAllowedExtensions: '' });
    await expect(outcomeOf(open, { data: { entityname: 'file' }, admin: true, form: { filename: '/tmp/upload.tmp' } })).resolves.toEqual({ data: {} });
  });

  it('validates a variation targeting bean while variations are on, stored or new', async () => {
    const db = recordedDb();
    const targetingid = 'A7A60000-0000-4000-8000000000000001';
    db.respond(/FROM "content"\."variation_targeting"/, (params) =>
      params.some((param) => namesId(param, targetingid)) ? [{ tenant_id: TENANT_A.tenantId, targetingid, contentid: HOME, siteid: SITE, initjs: '', targetingjs: '' }] : [],
    );
    const on = contextOf(db, { variations: true });
    await expect(outcomeOf(on, { data: { entityname: 'variationTargeting', targetingid }, admin: true })).resolves.toEqual({ data: {} });
    await expect(outcomeOf(on, { data: { entityname: 'variationTargeting' }, admin: true })).resolves.toEqual({ data: {} });
    await expect(outcomeOf(on, { data: { bean: 'variationTargeting', loadby: 'targetingid', targetingid }, admin: true })).resolves.toEqual({ data: {} });
  });
});

describe('validate CFML values', () => {
  it.each([
    ['a symbol', Symbol('x')],
    ['a function', () => undefined],
  ])('gives %s no CFML form', (_label, value) => {
    expect(() => cfValueOf(value)).toThrow(TypeError);
  });

  it.each([
    ['%41%42', 'AB'],
    ['a+b%20c', 'a b c'],
    ['%ZZ%', '%ZZ%'],
    ['%E2%82%AC', '€'],
  ])('urlDecodes %s', (text, decoded) => {
    expect(cfUrlDecode(text)).toBe(decoded);
  });

  it.each([
    ['{"a":"\\u00e9"}', 'é'],
    ['{"a":"\\ud83d\\ude00"}', '😀'],
  ])('reads the \\u escape of %s', (text, value) => {
    const read = deserializeCfJson(text);
    expect(read instanceof CfStruct ? read.get('a') : read).toBe(value);
  });

  it('marks JSON only isJSON accepts as unreadable', () => {
    expect(deserializeCfJson('{"a":1e}')).toBe(UNREADABLE_JSON);
  });
});
