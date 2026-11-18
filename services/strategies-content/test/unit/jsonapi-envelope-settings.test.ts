/** configBean `suppressAPIParams` and `useDataNamespaceForAPI` of the JSON API front controller, read from `MURA_<KEY>`. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_ERROR_MAP,
  LEGACY_JSON_CONTENT_TYPE,
  REST_CONSUMED_PARAMS_HEADER,
  WWW_AUTHENTICATE,
  acfKeyOrder,
  etag,
  type LegacyApiErrorType,
} from '@opt2/platform/legacy-compat';
import { EnvValidationError } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { jsonApiLegacySettings } from '../../src/routes/jsonapi.js';
import { buildTestApp, createRecordingDb, type RecordingDb, type Responder, type TestApp } from '../helpers/app.js';
import { IDS, seedRecordingDb, tenantASeed } from '../helpers/seed.js';
import { contentHeaders, type ContentSubject, type TokenSubject } from '../helpers/tokens.js';

type Struct = Record<string, unknown>;

const SITE = TENANT_A.siteId;
const PAGE_ONE = IDS.content.pageOne;
const FIND_ONE_URL = `/_api/json/v1/${SITE}/content/${PAGE_ONE}`;

/** contentDAO's active-version read, answered with the tenant-a seed's active rows by contentid or filename. */
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
const activeContent: Responder = (params, sql, { tenantId }) => {
  if (tenantId?.toLowerCase() !== TENANT_A.tenantId) return [];
  const [key] = params;
  const wanted = (Array.isArray(key) ? key : [key]).map((value) => String(value).toLowerCase());
  const column = /tcontent\.contentid = ANY\(/.test(sql) ? 'contentid' : 'filename';
  return TENANT_A_CONTENT.filter((row) => {
    const value = row[column];
    return row.active === 1 && typeof value === 'string' && wanted.includes(value.toLowerCase());
  }).map((row) => ({ ...row, ...NO_JOINED_ROW }));
};

/** strategies-content over the content seed, registered while `env` stands in `process.env`, where the front controller reads it. */
async function contentApi(env: Readonly<Record<string, string>> = {}): Promise<TestApp> {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  try {
    const db = createRecordingDb();
    seedRecordingDb(db);
    db.respond(ACTIVE_READ, activeContent);
    return await buildTestApp({ db });
  } finally {
    vi.unstubAllEnvs();
  }
}

/** Who a request is sent as: a subject, or a site admin whose user token no longer verifies. */
type Sender = ContentSubject | 'tampered';

async function headersOf(sender: Sender): Promise<Record<string, string>> {
  if (sender !== 'tampered') return contentHeaders(sender);
  const headers = await contentHeaders('site-admin');
  const bearer = headers.authorization ?? '';
  return { ...headers, authorization: `${bearer.slice(0, -4)}${bearer.endsWith('AAAA') ? 'BBBB' : 'AAAA'}` };
}

async function send(api: TestApp, url: string, sender: Sender = 'anonymous') {
  return api.app.inject({ method: 'GET', url, headers: await headersOf(sender) });
}

function bodyOf(res: { body: string }): Struct {
  return JSON.parse(res.body) as Struct;
}

function errorOf(type: LegacyApiErrorType): { message: string; code: string } {
  const { message, code } = LEGACY_ERROR_MAP[type];
  return { message, code };
}

describe('jsonApiLegacySettings', () => {
  it.each<[Record<string, string>, boolean, boolean]>([
    [{}, true, true],
    [{ MURA_SUPPRESSAPIPARAMS: 'false' }, false, true],
    [{ MURA_USEDATANAMESPACEFORAPI: 'false' }, true, false],
    [{ MURA_SUPPRESSAPIPARAMS: 'No', MURA_USEDATANAMESPACEFORAPI: '0' }, false, false],
    [{ MURA_SUPPRESSAPIPARAMS: 'YES', MURA_USEDATANAMESPACEFORAPI: '2' }, true, true],
    [{ MURA_SUPPRESSAPIPARAMS: '${application.x}', MURA_USEDATANAMESPACEFORAPI: '{{application.y}}' }, true, true],
  ])('reads %j as suppressAPIParams %s and useDataNamespaceForAPI %s', (env, suppressAPIParams, useDataNamespaceForAPI) => {
    expect(jsonApiLegacySettings(env)).toMatchObject({ suppressAPIParams, useDataNamespaceForAPI });
  });

  it.each([
    ['MURA_SUPPRESSAPIPARAMS', ''],
    ['MURA_SUPPRESSAPIPARAMS', 'maybe'],
    ['MURA_USEDATANAMESPACEFORAPI', ' '],
    ['MURA_USEDATANAMESPACEFORAPI', 'on'],
  ])('refuses %s=%j, which serializeResponse cannot evaluate as a boolean', (name, value) => {
    expect(() => jsonApiLegacySettings({ [name]: value })).toThrow(EnvValidationError);
    expect(() => jsonApiLegacySettings({ [name]: value })).toThrow(new RegExp(`${name}: must be a CFML boolean`));
  });

  it('refuses a malformed value at start-up', async () => {
    const failure: unknown = await contentApi({ MURA_SUPPRESSAPIPARAMS: 'maybe' }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(EnvValidationError);
    expect((failure as Error).message).toMatch(/MURA_SUPPRESSAPIPARAMS: must be a CFML boolean/);
  });
});

describe('configured envelope settings', () => {
  const apis: Partial<Record<'defaults' | 'unsuppressed' | 'unnamespaced', TestApp>> = {};

  /** The app built under the named settings. */
  function api(name: keyof typeof apis): TestApp {
    const built = apis[name];
    if (built === undefined) throw new TypeError(`${name} was not built`);
    return built;
  }

  beforeAll(async () => {
    // One at a time: each build reads the stubbed process.env.
    apis.defaults = await contentApi();
    apis.unsuppressed = await contentApi({ MURA_SUPPRESSAPIPARAMS: 'false' });
    apis.unnamespaced = await contentApi({ MURA_USEDATANAMESPACEFORAPI: 'false' });
  });

  afterAll(async () => {
    await Promise.all(Object.values(apis).map((built) => built.close()));
  });

  interface ParamsCase {
    url: string;
    sender: Sender;
    status: number;
    error?: LegacyApiErrorType;
    params: Struct;
    wwwAuthenticate?: string;
  }

  it.each<[string, ParamsCase]>([
    [
      'a served findOne',
      { url: `${FIND_ONE_URL}?probe=1`, sender: 'anonymous', status: 200, params: { id: PAGE_ONE, siteid: SITE, probe: '1', entityname: 'content' } },
    ],
    ['a route-key error', { url: '/_api/json/v1?probe=1', sender: 'anonymous', status: 400, error: 'invalidParameters', params: { probe: '1' } }],
    [
      'the 404 of a key of another owner',
      {
        url: `/_api/json/v1/${SITE}/user?probe=1`,
        sender: 'anonymous',
        status: 404,
        error: 'invalidMethodCall',
        params: { siteid: SITE, probe: '1', type: '2', entityname: 'user' },
      },
    ],
    [
      "the REST credential block's 401, less the credentials it deletes and with onRequestStart's mobileFormat",
      {
        url: `/_api/rest/v1/${SITE}/content/${PAGE_ONE}?probe=1&client_secret=x`,
        sender: 'anonymous',
        status: 401,
        error: 'authorization',
        params: { mobileformat: 'false', probe: '1' },
        wwwAuthenticate: WWW_AUTHENTICATE.basic,
      },
    ],
    [
      'an auth-hook denial',
      {
        url: `${FIND_ONE_URL}?probe=1`,
        sender: 'tampered',
        status: 401,
        error: 'invalidAccessToken',
        params: { probe: '1' },
        wwwAuthenticate: WWW_AUTHENTICATE.bearerInvalidAccessToken,
      },
    ],
    [
      'a site-binding denial of the handler',
      { url: `/_api/json/v1/${TENANT_B.siteId}/content?probe=1`, sender: 'site-admin', status: 403, error: 'authorization', params: { probe: '1' } },
    ],
  ])('echoes params on %s only when MURA_SUPPRESSAPIPARAMS is false', async (_label, c) => {
    const [suppressed, echoed] = await Promise.all([send(api('defaults'), c.url, c.sender), send(api('unsuppressed'), c.url, c.sender)]);
    for (const res of [suppressed, echoed]) {
      expect(res.statusCode).toBe(c.status);
      expect(res.headers.etag).toBe(etag(res.body));
      expect(res.headers['www-authenticate']).toBe(c.wwwAuthenticate);
    }
    const { params, ...rest } = bodyOf(echoed);
    expect(params).toEqual(c.params);
    expect(Object.keys(params as Struct)).toEqual(acfKeyOrder(Object.keys(c.params).map((name) => ['set', name])));
    expect(bodyOf(suppressed)).toEqual(rest);
    if (c.error !== undefined) expect(rest.error).toEqual(errorOf(c.error));
  });

  it('keeps ignoring a request suppressAPIParams, which is no configBean source', async () => {
    expect(bodyOf(await send(api('defaults'), `${FIND_ONE_URL}?suppressAPIParams=false`))).not.toHaveProperty('params');
  });

  it.each<['defaults' | 'unnamespaced', string, boolean]>([
    ['defaults', '', false],
    ['unnamespaced', '', true],
    ['unnamespaced', '?useDataNamespace=true', false],
    ['unnamespaced', '?useDataNamespace=0', true],
    ['unnamespaced', '?useDataNamespace=maybe', true],
  ])('under the %s settings, a findOne%s answers its data flattened: %s', async (name, query, flattened) => {
    const [res, reference] = await Promise.all([send(api(name), `${FIND_ONE_URL}${query}`), send(api('defaults'), FIND_ONE_URL)]);
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(etag(res.body));
    const { data, ...envelope } = bodyOf(reference);
    expect(bodyOf(res)).toEqual(flattened ? { ...envelope, ...(data as Struct) } : { ...envelope, data });
  });
});

// ---- the oracle's answers under each settings combination (test/fixtures/legacy/json-api-envelope-settings-answers.json) ----

/** One recorded answer. */
interface RecordedAnswer {
  status: number;
  statusText?: string;
  contentType: string;
  headers?: Record<string, string>;
  wwwAuthenticate?: string;
  etag?: string;
  text?: string;
  body?: Struct;
  stacktraceRemoved?: boolean;
}

/** One recorded request, its answer under each settings combination, and the halt reason strategies-content answers instead. */
interface RecordedCase {
  request: { method: 'GET' | 'POST' | 'DELETE'; url: string; headers?: Record<string, string>; body?: string };
  answers: Record<string, RecordedAnswer>;
  refusal?: string;
}

const RECORDED = JSON.parse(readFileSync(new URL('../fixtures/legacy/json-api-envelope-settings-answers.json', import.meta.url), 'utf8')) as {
  site: string;
  host: string;
  settings: Record<string, Record<string, string>>;
  cases: Record<string, RecordedCase>;
};
const RECORDED_TENANT = tenantIdForSite(RECORDED.site);
const HOME = '00000000000000000000000000000000001';

/** A 35-character ColdFusion UUID, which createUUID mints anew on every run. */
const CF_UUID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}/;

/** `text` with each distinct CF UUID numbered by first appearance, so freshly minted ids compare by position. */
function numberedUuids(text: string): string {
  const seen = new Map<string, number>();
  return text.replace(new RegExp(CF_UUID.source, 'g'), (uuid) => {
    if (!seen.has(uuid)) seen.set(uuid, seen.size + 1);
    return `<uuid:${seen.get(uuid)}>`;
  });
}

/** The tenant-a content seed as the recorded site's rows, Home included. */
const RECORDED_CONTENT: readonly Struct[] = TENANT_A_CONTENT.map((row) => ({ ...row, siteid: RECORDED.site, tenant_id: RECORDED_TENANT }));
const recordedContent: Responder = (params, sql, { tenantId }) => {
  if (tenantId?.toLowerCase() !== RECORDED_TENANT) return [];
  const [key] = params;
  const wanted = (Array.isArray(key) ? key : [key]).map((value) => String(value).toLowerCase());
  const column = /tcontent\.contentid = ANY\(/.test(sql) ? 'contentid' : 'filename';
  return RECORDED_CONTENT.filter((row) => row.active === 1 && wanted.includes(String(row[column]).toLowerCase())).map((row) => ({ ...row, ...NO_JOINED_ROW }));
};

/** The errors the recorded-site apps' routes raised, as the error handler receives them. */
const routeErrors: Error[] = [];

/** strategies-content with the recorded site registered on the oracle's host name, its own pools, and Home, built under `env` and the service settings `build`. */
async function recordedSiteApi(env: Readonly<Record<string, string>>, build: Readonly<Record<string, string>> = {}): Promise<TestApp> {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  try {
    const db = createRecordingDb();
    seedRecordingDb(db);
    const { rows } = await db.withMetadata((tx) => tx.query(`SELECT * FROM ${db.schema}.tenant_registry WHERE site_id = $1`, [SITE]));
    const site = RECORDED.site;
    const row: Struct = {
      ...(rows as Struct[])[0],
      site_id: site,
      tenant_id: RECORDED_TENANT,
      ...Object.fromEntries(['public_user', 'private_user', 'category', 'file', 'display'].flatMap((pool) => [[`${pool}_pool_id`, site], [`${pool}_pool_tenant`, RECORDED_TENANT]])),
      content_pool_ids: [site],
      content_pool_tenants: [RECORDED_TENANT],
      domains: [RECORDED.host.split(':')[0]],
    };
    const columns = Object.keys(row);
    await db.withMetadata((tx) =>
      tx.query(`INSERT INTO ${db.schema}.tenant_registry (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, columns.map((name) => row[name])),
    );
    db.respond(ACTIVE_READ, recordedContent);
    return await buildTestApp({
      db,
      env: build,
      declare: (app) =>
        app.addHook('onError', async (_request, _reply, error) => {
          routeErrors.push(error);
        }),
    });
  } finally {
    vi.unstubAllEnvs();
  }
}

/** The recorded request, sent anonymously through the gateway on the oracle's host. */
async function sendRecorded(api: TestApp, request: RecordedCase['request'], extra: Record<string, string> = {}) {
  const headers = { ...(await contentHeaders('anonymous')), host: RECORDED.host, ...request.headers, ...extra };
  return api.app.inject({ method: request.method, url: request.url, headers, ...(request.body === undefined ? {} : { payload: request.body }) });
}

const REPLAYS = Object.entries(RECORDED.cases).flatMap(([name, recorded]) =>
  Object.entries(recorded.answers).map(([setting, answer]) => [name, setting, recorded, answer] as const),
);
/** Whether legacy answered `recorded` from the content or contentnav save, which strategies-content withholds. */
function withheldSave(recorded: RecordedCase, answer: RecordedAnswer): boolean {
  const entity = /^\/_api\/\w+\/v1\/[^/?]+\/(\w+)/.exec(recorded.request.url)?.[1];
  if (recorded.request.method !== 'POST' || (entity !== 'content' && entity !== 'contentnav')) return false;
  const body = answer.body ?? (answer.text?.startsWith('{') ? (JSON.parse(answer.text) as Struct) : undefined);
  return body?.method === 'save';
}

const SERVED = REPLAYS.filter(([, , recorded, answer]) => recorded.refusal === undefined && !withheldSave(recorded, answer));
const REFUSED = REPLAYS.filter(([, , recorded]) => recorded.refusal !== undefined);
const WITHHELD = REPLAYS.filter(([, , recorded, answer]) => withheldSave(recorded, answer));

describe('the oracle under each envelope setting', () => {
  const apis = new Map<string, TestApp>();

  /** The app built under the recorded settings combination `name`. */
  function recordedApi(name: string): TestApp {
    const built = apis.get(name);
    if (built === undefined) throw new TypeError(`${name} was not built`);
    return built;
  }

  beforeAll(async () => {
    // One at a time: each build reads the stubbed process.env.
    for (const [name, env] of Object.entries(RECORDED.settings)) apis.set(name, await recordedSiteApi(env));
  });

  afterAll(async () => {
    await Promise.all([...apis.values()].map((built) => built.close()));
  });

  beforeEach(() => {
    routeErrors.length = 0;
  });

  it.each(SERVED)('answers %s under the %s settings as legacy does', async (_name, setting, recorded, answer) => {
    const res = await sendRecorded(recordedApi(setting), recorded.request);
    expect(res.statusCode).toBe(answer.status);
    if (answer.statusText !== undefined) expect(res.statusMessage).toBe(answer.statusText);
    expect(res.headers['content-type']).toBe(answer.contentType);
    expect(res.headers['www-authenticate']).toBe(answer.wwwAuthenticate);
    for (const [name, value] of Object.entries(answer.headers ?? {})) expect(res.headers[name.toLowerCase()]).toBe(value);
    // A recorded text without an ETag went out without one.
    expect(res.headers.etag).toBe(answer.text !== undefined && answer.etag === undefined ? undefined : etag(res.body));
    if (answer.text === undefined) {
      expect(res.body).toBe(JSON.stringify(answer.body));
      return;
    }
    expect(numberedUuids(res.body)).toBe(numberedUuids(answer.text));
    if (!CF_UUID.test(answer.text)) expect(res.headers.etag).toBe(answer.etag);
  });

  it.each(REFUSED)('halts %s under the %s settings, whose answer a credential lookup decides, naming EX-JSONAPI-REST-CREDENTIALS', async (_name, setting, recorded) => {
    const res = await sendRecorded(recordedApi(setting), recorded.request);
    expect(res.statusCode).toBe(503);
    expect(bodyOf(res)).toMatchObject({ error: { code: 'server_error' } });
    expect(routeErrors).toEqual([expect.objectContaining({ reason: recorded.refusal })]);
    expect(routeErrors[0]?.message).toMatch(/^REST credentials of an? [\w ]+ are verified by identity \(EX-JSONAPI-REST-CREDENTIALS\)$/);
  });

  it.each(WITHHELD)('answers the withheld content save %s under the %s settings with the legacy 503, writing nothing', async (_name, setting, recorded) => {
    const api = recordedApi(setting);
    const db = api.db as RecordingDb;
    const written = db.writes().length;
    const res = await sendRecorded(api, recorded.request);
    expect(res.statusCode).toBe(503);
    expect(bodyOf(res)).toMatchObject({ error: { code: 'server_error' } });
    expect(routeErrors).toEqual([expect.objectContaining({ reason: 'jsonapi-content-save-not-ported' })]);
    expect(db.writes().slice(written)).toEqual([]);
  });

  it('halts a tokenless REST call whose exchanged credentials the gateway reports, naming EX-JSONAPI-REST-CREDENTIALS', async () => {
    const request: RecordedCase['request'] = { method: 'GET', url: `/_api/rest/v1/${RECORDED.site}/content/${HOME}?probe=1` };
    const res = await sendRecorded(recordedApi('default'), request, { [REST_CONSUMED_PARAMS_HEADER]: 'access_token' });
    expect(res.statusCode).toBe(503);
    expect(routeErrors).toEqual([
      expect.objectContaining({
        reason: 'jsonapi-rest-credentials',
        message: 'REST credentials of a session that ended after the exchange are verified by identity (EX-JSONAPI-REST-CREDENTIALS)',
      }),
    ]);
  });

  it("echoes the data struct as validate's param and key writes leave it", async () => {
    // The answer the stock settings give this request; with params echoed, legacy's data echo of the same struct posted
    // to the site's validate method carried a minted contentid, `fields` '' and the API site.
    const { request, answers } = RECORDED.cases['validate-content-json-struct'] ?? {};
    if (request === undefined || answers?.default?.text === undefined) throw new TypeError('validate-content-json-struct is not recorded');
    const res = await sendRecorded(recordedApi('nosuppress'), request);
    expect(res.statusCode).toBe(200);
    const { params, ...rest } = bodyOf(res);
    expect(rest).toEqual(JSON.parse(answers.default.text));
    const echoed = (params as Struct).data as Struct;
    expect(Object.keys(echoed)).toEqual(['contentid', 'fields', 'siteid', 'entityname']);
    const { contentid, ...written } = echoed;
    expect(contentid).toMatch(new RegExp(`^${CF_UUID.source}$`));
    expect(written).toEqual({ fields: '', siteid: RECORDED.site, entityname: 'content' });
  });

  describe("onError's page for an echoed JSON null under a serializer-hinted key", () => {
    const JSON_BODY = { 'content-type': 'application/json' };
    const TARGETING = `/v1/${RECORDED.site}/variationTargeting`;
    const ABSENT_TARGETING = 'AAAAAAAA-AAAA-AAAA-AAAAAAAAAAAAAAAA';
    /** The recorded save's answer (debuggingEnabled=false): core/templates/error.html at 500, without an ETag. */
    const PAGE = RECORDED.cases['save-variationtargeting-hinted-null']?.answers['nosuppress-nodebug'];

    function expectPage(res: Awaited<ReturnType<typeof sendRecorded>>, wwwAuthenticate?: string): void {
      if (PAGE?.text === undefined) throw new TypeError('save-variationtargeting-hinted-null is not recorded');
      expect(res.statusCode).toBe(PAGE.status);
      expect(res.statusMessage).toBe(PAGE.statusText);
      expect(res.headers['content-type']).toBe(PAGE.contentType);
      for (const [name, value] of Object.entries(PAGE.headers ?? {})) expect(res.headers[name.toLowerCase()]).toBe(value);
      expect(res.headers['www-authenticate']).toBe(wwwAuthenticate);
      expect(res.headers.etag).toBeUndefined();
      expect(res.body).toBe(PAGE.text);
    }

    // The serializer raises in the answer and again in processRequest's catch block, whatever the call decided, so
    // every family answers the page; a challenge the REST credential block set before throwing stays (jsonApiUtility.cfc:553).
    it.each<[string, 'POST' | 'DELETE', string, string, TokenSubject | undefined, string | undefined]>([
      ['an ajax variationTargeting save', 'POST', `/_api/ajax${TARGETING}`, '{"title":null}', undefined, undefined],
      ['an ajax variationTargeting delete', 'DELETE', `/_api/ajax${TARGETING}/${ABSENT_TARGETING}`, '{"title":null}', undefined, undefined],
      ['a tokenless REST variationTargeting save', 'POST', `/_api/rest${TARGETING}`, '{"title":null}', undefined, WWW_AUTHENTICATE.basic],
      ['a tokenless REST variationTargeting delete', 'DELETE', `/_api/rest${TARGETING}/${ABSENT_TARGETING}`, '{"title":null}', undefined, WWW_AUTHENTICATE.basic],
      ['a signed-in REST variationTargeting save', 'POST', `/_api/rest${TARGETING}`, '{"title":null}', 's2', undefined],
      ['a signed-in REST variationTargeting delete', 'DELETE', `/_api/rest${TARGETING}/${ABSENT_TARGETING}`, '{"title":null}', 's2', undefined],
      ['a findOne param', 'POST', `/_api/json/v1/${RECORDED.site}/?method=findOne&entityname=content&id=${HOME}`, '{"title":null}', undefined, undefined],
      ['a validate data member', 'POST', `/_api/json/v1/${RECORDED.site}/`, '{"method":"validate","entityname":"content","data":{"entityname":"content","title":null}}', undefined, undefined],
    ])('answers %s with the page', async (_label, method, url, body, subject, wwwAuthenticate) => {
      const signedIn = subject === undefined ? {} : await contentHeaders(subject, { site: RECORDED.site });
      expectPage(await sendRecorded(recordedApi('nosuppress-nodebug'), { method, url, headers: JSON_BODY, body }, signedIn), wwwAuthenticate);
      expect(routeErrors).toEqual([]);
    });

    describe('with variations on', () => {
      let api: TestApp;
      let db: RecordingDb;

      beforeAll(async () => {
        api = await recordedSiteApi({ MURA_SUPPRESSAPIPARAMS: 'false' }, { MURA_VARIATIONS: 'true' });
        db = api.db as RecordingDb;
      });

      afterAll(async () => {
        await api.close();
      });

      beforeEach(() => {
        db.clear();
      });

      it.each([
        ['{"initjs":"x"}', false],
        ['{"title":null,"initjs":"x"}', true],
      ])('writes a signed-in REST save of %s before answering, the page when the echo holds the null: %s', async (body, page) => {
        const request: RecordedCase['request'] = { method: 'POST', url: `/_api/rest${TARGETING}`, headers: JSON_BODY, body };
        const res = await sendRecorded(api, request, await contentHeaders('s2', { site: RECORDED.site }));
        if (page) expectPage(res);
        else expect(bodyOf(res)).toMatchObject({ method: 'save', data: { initjs: 'x', entityname: 'variationTargeting' } });
        expect(db.writes().map(({ sql }) => sql)).toContainEqual(expect.stringMatching(/^INSERT INTO \S+\."variation_targeting" /));
      });

      it('writes nothing for the recorded save, whose CSRF check fails first', async () => {
        const recorded = RECORDED.cases['save-variationtargeting-hinted-null'];
        if (recorded === undefined) throw new TypeError('save-variationtargeting-hinted-null is not recorded');
        expectPage(await sendRecorded(api, recorded.request));
        expect(db.writes()).toEqual([]);
      });

      // The oracle's answer (variations off): save validates CSRF before the variations-dependent AllowAction (jsonApiUtility.cfc:1980,2026).
      it('answers an unhinted JSON null with the CSRF envelope echoing it, as legacy does', async () => {
        const text = '{"apiversion":"v1","method":"save","error":{"message":"Invalid CSRF tokens","code":"invalid_request"},"params":{"x":null,"siteid":"default","entityname":"variationTargeting"}}';
        const res = await sendRecorded(api, { method: 'POST', url: `/_api/json${TARGETING}`, headers: JSON_BODY, body: '{"x":null}' });
        expect(res.statusCode).toBe(400);
        expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
        expect(res.headers.etag).toBe('187211AF7ED8B9F2DEABCF4F727C3170E755BBE67726B9A724B0FDBF8BEDA738');
        expect(res.body).toBe(text);
        expect(db.writes()).toEqual([]);
      });
    });
  });
});
