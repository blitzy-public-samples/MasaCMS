import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogue, scenarioById, type Scenario } from '../../src/golden/catalogue.js';
import { createScenarioContext, type SecretStore, type SeedStore } from '../../src/golden/session.js';
import { runScenarioSteps } from '../../src/golden/steps.js';
import type { FetchLike } from '../../src/lib/http.js';

const SCENARIO_ID = 'GS-CO-19';
const LEGACY_URL = 'http://127.0.0.1:20080';
const CONTENT_ID = 'FC69E644-C958-FD62-58BFD275616AC526';
const TARGETING_ID = 'FC6A14D1-EBAD-BF25-2C3B232194B720DE';
const PERSON_ID = '5E1F0C2A-9B3D-4E7F-8A6B2C4D6E8F0A1B';
const ADMIN_PASSWORD = 'FIXTURE-ADMIN-PASSWORD';
const FORM_PAGE =
  '/admin/?muraAction=carch.variationTargeting&siteid=tenant-a&remoteid=gs-co-19-variation' +
  '&remoteurl=https://tenant-a.seed.opt2.test/gs-co-19&title=GS-CO-19%20Variation&compactDisplay=true';
const ADMIN_ACTION = '/admin/?muraAction=carch.variationTargeting';
const JSON_API = '/_api/json/v1/tenant-a/';
const REST_TARGETING = '/_api/rest/v1/tenant-a/variationtargeting/';

const SECRETS: SecretStore = {
  secret: (name) => {
    if (name !== 'admin') throw new Error(`${SCENARIO_ID} reads only the admin secret, asked for ${name}`);
    return ADMIN_PASSWORD;
  },
  username: (site, role) => {
    throw new Error(`${SCENARIO_ID} reads no username, asked for ${site}:${role}`);
  },
  values: () => [ADMIN_PASSWORD],
};

const SEED: SeedStore = {
  select: (ref) => {
    if (ref.path !== 'masa.users') throw new Error(`unexpected seedRef path ${ref.path}`);
    return { userID: PERSON_ID, siteID: 'tenant-a', isPublic: 0 };
  },
  businessDate: () => '2026-03-02',
};

type Reply = () => Response;

interface Call {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: string;
}

function html(markup: string, status = 200): Reply {
  return () => new Response(markup, { status, headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

function json(body: unknown, status = 200): Reply {
  return () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json;charset=utf-8' } });
}

function tokens(context: string): Reply {
  return json({
    apiversion: 'v1',
    data: { csrf_token: `FIXTURE-TOKEN-${context}`, csrf_token_expires: '261116232657248' },
    method: 'generateCSRFTokens',
  });
}

function refused(method: string): Reply {
  return json(
    { apiversion: 'v1', method, error: { message: 'Insufficient Account Permissions', code: 'invalid_request' } },
    401,
  );
}

/** The debug error page legacy's onRequestStart answers a sessionless REST call carrying `siteid` with. */
const STARTUP_ERROR = html('<h1>500 Error</h1><h2>The requested scope session has not been enabled.</h2>', 500);

/** Legacy's answers to GS-CO-19 on the oracle (variations off, REST 500 on ACF), keyed `<METHOD> <path?query>`. */
const LEGACY: Record<string, Reply[]> = {
  [`GET ${FORM_PAGE}`]: [html(`<form action="./" method="post"><input name="contentid" value="${CONTENT_ID}"></form>`)],
  [`POST ${ADMIN_ACTION}`]: [html('<p>closed</p>')],
  ['GET /_api/json/v1/tenant-a/variationtargeting/new']: [refused('findNew')],
  ['GET /_api/json/v1/tenant-a/generateCSRFTokens?context=new']: [tokens('new')],
  [`GET /_api/json/v1/tenant-a/generateCSRFTokens?context=${TARGETING_ID}`]: [tokens(TARGETING_ID)],
  [`POST ${JSON_API}`]: [
    json({
      apiversion: 'v1',
      data: { contentid: CONTENT_ID, id: TARGETING_ID, targetingid: TARGETING_ID, siteid: 'tenant-a', isnew: 0 },
      method: 'save',
    }),
    json({ apiversion: 'v1', data: '', method: 'delete' }),
  ],
  [`GET /_api/json/v1/tenant-a/variationtargeting/${TARGETING_ID}`]: [refused('findOne')],
  [`POST ${REST_TARGETING}`]: [
    STARTUP_ERROR,
    json({ apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } }, 500),
  ],
  [`DELETE ${REST_TARGETING}${TARGETING_ID}`]: [
    json({ apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } }, 500),
  ],
};

const CSRF_REFUSED = { apiversion: 'v1', method: 'save', error: { message: 'Invalid CSRF tokens', code: 'invalid_request' } };
const DELETED = { apiversion: 'v1', data: '', method: 'delete' };
const UNKNOWN_REFERENCE = {
  apiversion: 'v1',
  method: 'invalid',
  error: { message: 'Invalid reference to persisted entity', code: 'invalid_request' },
};

function serverError(method: string): unknown {
  return { apiversion: 'v1', method, error: { message: 'Unhandled Exception', code: 'server_error' } };
}

/**
 * Legacy's answers to the anonymous session-managed REST calls behind an unmapped `index.cfm` spelling, as a clone
 * oracle's `default` site gave them; the `file` calls answer as `filemetadata`'s, since `default/file` names ColdFusion's
 * `file` scope there (jsonApiUtility.cfc:857) where `tenant-a/file` is the entity.
 */
const SESSION_CALLS: ReadonlyArray<readonly [name: string, method: string, target: string, status: number, body: unknown]> = [
  ['rest-session-targeting', 'POST', '/INDEX.CFM/_api/rest/v1/tenant-a/variationtargeting/', 400, CSRF_REFUSED],
  ['rest-session-targeting-delete', 'DELETE', `/Index.cfm/_api/rest/v1/tenant-a/variationtargeting/${TARGETING_ID}`, 200, DELETED],
  ['rest-session-address-save', 'POST', '/INDEX.CFM/_api/rest/v1/tenant-a/address/', 400, CSRF_REFUSED],
  ['rest-session-category-delete', 'DELETE', '/Index.cfm/_api/rest/v1/tenant-a/category/00000000-0000-0000-0000000000000000', 200, DELETED],
  ['rest-session-category-save', 'POST', '/index.CFM/_api/rest/v1/tenant-a/category/', 400, CSRF_REFUSED],
  ['rest-session-changeset-delete', 'DELETE', '/INDEX.CFM/_api/rest/v1/tenant-a/changeset/00000000-0000-0000-0000000000000000', 200, DELETED],
  ['rest-session-changeset-save', 'POST', '/Index.cfm/_api/rest/v1/tenant-a/changeset/', 400, CSRF_REFUSED],
  ['rest-session-changesetcategoryassignment-delete', 'DELETE', '/index.CFM/_api/rest/v1/tenant-a/changesetCategoryAssignment/00000000-0000-0000-0000000000000000', 200, DELETED],
  ['rest-session-changesetcategoryassignment-save', 'POST', '/INDEX.CFM/_api/rest/v1/tenant-a/changesetCategoryAssignment/', 400, CSRF_REFUSED],
  ['rest-session-comment-delete', 'DELETE', '/Index.cfm/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000', 200, DELETED],
  ['rest-session-comment-save', 'POST', '/index.CFM/_api/rest/v1/tenant-a/comment/', 400, CSRF_REFUSED],
  ['rest-session-comment-fn-delete', 'POST', '/INDEX.CFM/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000/delete', 500, serverError('delete')],
  ['rest-session-comment-fn-flag', 'POST', '/Index.cfm/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000/flag', 500, serverError('invalid')],
  ['rest-session-comment-fn-markasspam', 'POST', '/index.CFM/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000/markAsSpam', 500, serverError('invalid')],
  ['rest-session-comment-fn-undelete', 'POST', '/INDEX.CFM/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000/undelete', 500, serverError('invalid')],
  ['rest-session-comment-fn-unmarkasspam', 'POST', '/Index.cfm/_api/rest/v1/tenant-a/comment/00000000-0000-0000-0000000000000000/unMarkAsSpam', 500, serverError('invalid')],
  ['rest-session-content-delete', 'DELETE', '/index.CFM/_api/rest/v1/tenant-a/content/00000000-0000-0000-0000000000000000', 200, DELETED],
  ['rest-session-content-save', 'POST', '/INDEX.CFM/_api/rest/v1/tenant-a/content/', 400, CSRF_REFUSED],
  ['rest-session-contentcategoryassign-delete', 'POST', '/Index.cfm/_api/rest/v1/tenant-a/?method=delete', 500, serverError('delete')],
  ['rest-session-contentcategoryassign-save', 'POST', '/index.CFM/_api/rest/v1/tenant-a/contentCategoryAssign/', 400, CSRF_REFUSED],
  ['rest-session-contentnav-delete', 'POST', '/INDEX.CFM/_api/rest/v1/tenant-a/', 500, serverError('delete')],
  ['rest-session-contentnav-save', 'POST', '/Index.cfm/_api/rest/v1/tenant-a/', 400, CSRF_REFUSED],
  ['rest-session-feed-delete', 'DELETE', '/index.CFM/_api/rest/v1/tenant-a/feed/00000000-0000-0000-0000000000000000', 200, DELETED],
  ['rest-session-feed-save', 'POST', '/INDEX.CFM/_api/rest/v1/tenant-a/feed/', 400, CSRF_REFUSED],
  ['rest-session-file-delete', 'DELETE', '/Index.cfm/_api/rest/v1/tenant-a/file/00000000-0000-0000-0000000000000000', 200, DELETED],
  ['rest-session-file-save', 'POST', '/index.CFM/_api/rest/v1/tenant-a/file/', 400, CSRF_REFUSED],
  ['rest-session-filemetadata-delete', 'DELETE', '/INDEX.CFM/_api/rest/v1/tenant-a/fileMetaData/00000000-0000-0000-0000000000000000', 200, DELETED],
  ['rest-session-filemetadata-save', 'POST', '/Index.cfm/_api/rest/v1/tenant-a/fileMetaData/', 400, CSRF_REFUSED],
  ['rest-session-group-save', 'POST', '/index.CFM/_api/rest/v1/tenant-a/group/', 400, CSRF_REFUSED],
  ['rest-session-login', 'POST', '/INDEX.CFM/_api/rest/v1/tenant-a/login', 200, { apiversion: 'v1', data: { status: 'Invalid CSFR Tokens' }, method: 'login' }],
  ['rest-session-oauth', 'POST', '/Index.cfm/_api/rest/v1/tenant-a/oauth', 400, UNKNOWN_REFERENCE],
  ['rest-session-oauth2', 'POST', '/index.CFM/_api/rest/v1/tenant-a/oauth2', 400, UNKNOWN_REFERENCE],
  ['rest-session-stats-delete', 'DELETE', '/INDEX.CFM/_api/rest/v1/tenant-a/stats/00000000-0000-0000-0000000000000000', 500, serverError('delete')],
  ['rest-session-stats-save', 'POST', '/Index.cfm/_api/rest/v1/tenant-a/stats/', 400, CSRF_REFUSED],
  ['rest-session-tokeninfo', 'GET', '/index.CFM/_api/rest/v1/tenant-a/tokeninfo?access_token=gs-co-19-session&client_id=gs-co-19-session', 400, UNKNOWN_REFERENCE],
  ['rest-session-user-save', 'POST', '/INDEX.CFM/_api/rest/v1/tenant-a/user/', 400, CSRF_REFUSED],
];
for (const [, method, target, status, body] of SESSION_CALLS) (LEGACY[`${method} ${target}`] ??= []).push(json(body, status));

const NEUTRAL = '00000000-0000-0000-0000000000000000';
const REST = '/_api/rest/v1/tenant-a';
/** The anonymous sessionless REST calls carrying `siteid`, each answered with {@link STARTUP_ERROR}. */
const SITEID_CALLS: ReadonlyArray<readonly [name: string, method: string, target: string]> = [
  ['rest-siteid-targeting-delete', 'DELETE', `${REST}/variationtargeting/${NEUTRAL}?siteid=tenant-a`],
  ['rest-siteid-category-delete', 'DELETE', `${REST}/category/${NEUTRAL}?siteid=tenant-a`],
  ['rest-siteid-changeset-delete', 'DELETE', `${REST}/changeset/${NEUTRAL}?siteid=tenant-a`],
  ['rest-siteid-changesetcategoryassignment-delete', 'DELETE', `${REST}/changesetCategoryAssignment/${NEUTRAL}?siteid=tenant-a`],
  ['rest-siteid-comment-delete', 'DELETE', `${REST}/comment/${NEUTRAL}?siteid=tenant-a`],
  ['rest-siteid-comment-fn-delete', 'POST', `${REST}/comment/${NEUTRAL}/delete`],
  ['rest-siteid-comment-fn-flag', 'POST', `${REST}/comment/${NEUTRAL}/flag`],
  ['rest-siteid-comment-fn-markasspam', 'POST', `${REST}/comment/${NEUTRAL}/markAsSpam`],
  ['rest-siteid-comment-fn-undelete', 'POST', `${REST}/comment/${NEUTRAL}/undelete`],
  ['rest-siteid-comment-fn-unmarkasspam', 'POST', `${REST}/comment/${NEUTRAL}/unMarkAsSpam`],
  ['rest-siteid-content-delete', 'DELETE', `${REST}/content/${NEUTRAL}?siteid=tenant-a`],
  ['rest-siteid-feed-delete', 'DELETE', `${REST}/feed/${NEUTRAL}?siteid=tenant-a`],
  ['rest-siteid-file-delete', 'DELETE', `${REST}/file/${NEUTRAL}?siteid=tenant-a`],
  ['rest-siteid-filemetadata-delete', 'DELETE', `${REST}/fileMetaData/${NEUTRAL}?siteid=tenant-a`],
  ['rest-siteid-login', 'POST', `${REST}/login`],
  ['rest-siteid-oauth', 'POST', `${REST}/oauth`],
  ['rest-siteid-oauth2', 'POST', `${REST}/oauth2`],
  ['rest-siteid-stats-delete', 'DELETE', `${REST}/stats/${NEUTRAL}?siteid=tenant-a`],
  ['rest-siteid-tokeninfo', 'GET', `${REST}/tokeninfo?access_token=gs-co-19-siteid&client_id=gs-co-19-siteid&siteid=tenant-a`],
];
for (const [, method, target] of SITEID_CALLS) LEGACY[`${method} ${target}`] = [STARTUP_ERROR];

/** Fetch answering {@link LEGACY} in order per key, the last reply repeating; any other request fails. */
function legacyFetch(): { fetch: FetchLike; calls: Call[] } {
  const queues = new Map(Object.entries(LEGACY).map(([key, replies]) => [key, [...replies]]));
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const target = `${parsed.pathname}${parsed.search}`;
    const headers = { ...(init.headers as Record<string, string>) };
    calls.push({ method, target, headers, body: String(init.body ?? '') });
    const queue = queues.get(`${method} ${target}`);
    const reply = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0];
    if (reply === undefined) throw new Error(`unscripted request ${method} ${target}`);
    return reply();
  };
  return { fetch, calls };
}

let scenario: Scenario;

beforeAll(async () => {
  scenario = scenarioById(await loadCatalogue(), SCENARIO_ID);
});

describe('GS-CO-19 variation targeting', () => {
  it('captures end to end when legacy refuses findNew and findOne and fails every REST call', async () => {
    const { fetch, calls } = legacyFetch();
    const ctx = createScenarioContext(scenario, {
      origin: 'legacy',
      env: { LEGACY_ORIGIN: LEGACY_URL },
      fetch,
      secrets: SECRETS,
      seed: SEED,
    });
    const records = await runScenarioSteps(ctx, scenario, { mode: 'capture', login: false, fetch });

    expect(records.map((r) => [r.name, r.response.status])).toEqual([
      ['variation-form', 200],
      ['variation-save', 200],
      ['variation-save-notify', 200],
      ['targeting-new', 401],
      ['targeting-save', 200],
      ['targeting-read', 401],
      ['targeting-delete', 200],
      ['rest-targeting', 500],
      ['rest-targeting-path-site', 500],
      ['rest-targeting-delete', 500],
      ...SESSION_CALLS.map(([name, , , status]) => [name, status]),
      ...SITEID_CALLS.map(([name]) => [name, 500]),
    ]);
    expect(new Set(records.map((r) => r.routeKey))).toEqual(new Set(scenario.covers));
    expect(records.find((r) => r.name === 'targeting-save')?.extracted).toEqual({ id: TARGETING_ID });

    const [save, remove] = calls.filter((call) => call.method === 'POST' && call.target === JSON_API);
    const saved = new URLSearchParams(save?.body);
    expect([saved.get('method'), saved.has('id'), saved.has('targetingid')]).toEqual(['save', false, false]);
    expect(save?.headers['x-csrf_token']).toBe('FIXTURE-TOKEN-new');
    expect(new URLSearchParams(remove?.body).get('id')).toBe(TARGETING_ID);
    expect(remove?.headers['x-csrf_token']).toBe(`FIXTURE-TOKEN-${TARGETING_ID}`);
    const rest = calls.find((call) => call.method === 'POST' && call.target === REST_TARGETING);
    expect(new URLSearchParams(rest?.body).get('targetingid')).toBe(TARGETING_ID);
  });

  it('compares only status and auth on the REST steps, whose 500 body legacy varies by run', () => {
    const rest = scenario.steps.filter((step) => step.route.startsWith('/_api/rest/') && step.as === 'rest');
    expect(rest.map((step) => [step.name, step.compare])).toEqual([
      ['rest-targeting', ['status', 'auth']],
      ['rest-targeting-path-site', ['status', 'auth']],
      ['rest-targeting-delete', ['status', 'auth']],
    ]);
  });

  it('declares every REST call carrying siteid halted on EX-REST-SITEID-STARTUP', () => {
    const halted = scenario.steps.filter((step) => step.exceptionId === 'EX-REST-SITEID-STARTUP').map((step) => step.name);
    expect(halted).toEqual(['rest-targeting', ...SITEID_CALLS.map(([name]) => name)]);
    expect(scenario.steps.filter((step) => halted.includes(step.name)).every((step) => step.expected === 'halted')).toBe(true);
  });
});
