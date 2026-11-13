import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, crossTenantPairs, type TenantFixture } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURES_UNAVAILABLE, type FixtureStatus } from '../../src/golden/catalogue.js';
import { SEED_CONFIG_PATH, SEED_CREDENTIALS_FILE, originBaseUrl } from '../../src/golden/session.js';
import {
  ACTORS,
  DEFAULT_PROBE_SUFFIX,
  MAX_OWNER_RECORDS,
  NOT_RUN,
  ROUTE_FAMILIES,
  SURVEY_GRANT,
  TENANTS_BY_KEY,
  buildCases,
  isLegacyRefusal,
  runGatewayIsolation,
  type ActorRef,
  type CaseResult,
  type FamilyId,
  type GatewayIsolationDeps,
  type GatewayIsolationResult,
  type IsolationCase,
  type RefusalOptions,
  type RouteFamily,
  type TenantKey,
} from '../../src/isolation/gateway-matrix.js';
import { HttpRequestError, type FetchLike } from '../../src/lib/http.js';
import type { EnvLike } from '../../src/lib/paths.js';

type Row = Record<string, unknown>;

const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const SITE_U = TENANT_UMBRELLA.siteId;
const SITES = [SITE_A, SITE_B, SITE_U] as const;
// `.invalid` never resolves; every request goes to the fake gateway's fetch.
const GATEWAY = 'http://gateway.invalid';
const API = '/legacy-fixtures/cfml/api.cfm';
const HOME_ID = '00000000000000000000000000000000001';
const CHECKED_AT = '2026-06-30T12:00:00.000Z';
const AVAILABLE: FixtureStatus = { available: true, reason: null, checkedAt: CHECKED_AT };
const UNAVAILABLE_REASON = 'CREATE SCHEMA permission denied in muradb';
const ALL_KEYS: readonly TenantKey[] = ['a', 'b', 'umbrella'];

function fixtureText(name: string): string {
  return fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

const LOGIN_PAGE = fixtureText('html/admin-login.html');
const UNAUTHORIZED = fixtureText('http/envelope-error-401-insufficient-permissions.json');
const INVALID_TOKEN = fixtureText('http/envelope-error-401-invalid-token.json');
const BAD_REQUEST = fixtureText('http/envelope-error-400-bad-request.json');
const INVALID_CSRF = fixtureText('http/envelope-error-400-invalid-csrf.json');
const SERVER_ERROR = fixtureText('http/envelope-error-500-server-error.json');

interface SuccessEnvelope {
  apiversion: string;
  method: string;
  params: Row;
  data: Row & { items: Row[] };
}

const SUCCESS = JSON.parse(fixtureText('http/envelope-success.json')) as SuccessEnvelope;

const RESERVED = (
  JSON.parse(fs.readFileSync(SEED_CONFIG_PATH, 'utf8')) as {
    reserved: { rehearsal: { persons: string[]; usernames: string[] } };
  }
).reserved.rehearsal;
const RESERVED_PERSON = RESERVED.persons[0] ?? '';
const RESERVED_USERNAME = RESERVED.usernames[0] ?? '';

/** Seeded login of each role per site, as `seed-credentials.json` maps them. */
const ROLE_USERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [SITE_A]: {
    'site-admin': 'a.siteadmin',
    'timesheets.employee': 'a.employee',
    'finance.preparer': 'a.preparer',
    'surveys.manager': 'a.surveys',
  },
  [SITE_B]: {
    'site-admin': 'b.siteadmin',
    'timesheets.employee': 'b.employee',
    'finance.preparer': 'b.preparer',
    'surveys.manager': 'b.surveys',
  },
  [SITE_U]: { member: 'u.member' },
};
const USER_SITES = new Map(
  Object.entries(ROLE_USERS).flatMap(([site, roles]) => Object.values(roles).map((user) => [user, site] as const)),
);

function passwordOf(username: string): string {
  return `fixture-password-${username}`;
}

function loginOf(site: string, role: string): string {
  return ROLE_USERS[site]?.[role] ?? '';
}

/** A CF UUID unique per (group, site, n). */
function cfId(group: number, site: number, n: number): string {
  return `${String(group).padStart(8, '0')}-${String(site).padStart(4, '0')}-4000-${String(n).padStart(16, '0')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Fake gateway

interface Caller {
  site: string;
  username: string;
}

/** One request the fake gateway received, its body decoded. */
interface GatewayCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  fields: Record<string, string>;
  caller?: Caller;
}

/** An answer that replaces the fake's own, or undefined to let the fake answer. */
type Override = (call: GatewayCall) => Response | undefined;

/** Records of the fake's sites, by family; every record names its site in `siteid`. */
interface World {
  rows: Record<FamilyId, Row[]>;
  responses: Map<string, Row[]>;
  lockedOut: Set<string>;
  /** Replaces every refusal and not-found answer. */
  refusal?: () => Response;
  /** Page size of survey response lists, else the requested `itemsPerPage`. */
  responsesPerPage?: number;
  serial: number;
}

interface FakeGateway {
  fetch: FetchLike;
  calls: GatewayCall[];
}

type Op = 'list' | 'byId' | 'write' | 'create' | 'bulk' | 'responses';
type Shape = 'jsonapi' | 'fixture' | 'v1';

interface Target {
  family: FamilyId;
  op: Op;
  shape: Shape;
  site: string;
  id?: string;
}

const ID_KEYS: Readonly<Record<FamilyId, string>> = {
  content: 'contentid',
  user: 'userid',
  timesheets: 'timesheet_id',
  finance: 'record_id',
  surveys: 'survey_id',
};
/** Public user pool of each site in the seeded registry. */
const PUBLIC_USER_POOL: Readonly<Record<string, string>> = { [SITE_A]: SITE_U, [SITE_B]: SITE_B, [SITE_U]: SITE_U };
/** Field names of `/v1/` bodies. */
const V1_KEYS: Readonly<Record<string, string>> = {
  timesheet_id: 'timesheetId',
  person_id: 'personId',
  day_id: 'dayId',
  record_id: 'recordId',
  siteid: 'siteId',
  isblackout: 'isBlackout',
};
const TOKENS = { csrf_token: 'FIXTURECSRFTOKEN0000000000000009', csrf_token_expires: '260630120000000' };

function raw(text: string, status: number, setCookie: readonly string[] = []): Response {
  return new Response(text, {
    status,
    headers: [['content-type', 'application/json; charset=utf-8'], ...setCookie.map((line) => ['set-cookie', line])],
  });
}

function json(body: unknown, status = 200, setCookie: readonly string[] = []): Response {
  return raw(JSON.stringify(body), status, setCookie);
}

function html(markup: string): Response {
  return new Response(markup, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function redirect(location: string, setCookie: readonly string[] = []): Response {
  return new Response(null, {
    status: 302,
    headers: [['location', location], ...setCookie.map((line) => ['set-cookie', line])],
  });
}

function envelope(method: string, data: unknown, params: Row = {}): Row {
  return { apiversion: 'v1', method, params, data };
}

function errorEnvelope(status: number, message: string): Response {
  return json({ apiversion: 'v1', method: 'invalid', error: { code: 'invalid_request', message } }, status);
}

const forbidden = (): Response => errorEnvelope(403, 'Insufficient Account Permissions');
const notFound = (): Response => errorEnvelope(404, 'Not Found');
const conflict = (): Response => errorEnvelope(409, 'Conflict');
const serverError = (): Response => raw(SERVER_ERROR, 500);

function jsonApiList(site: string, entity: string, items: Row[]): Row {
  return {
    ...SUCCESS,
    params: { ...SUCCESS.params, entityname: entity, siteid: site },
    data: {
      ...SUCCESS.data,
      entityname: entity,
      items,
      endindex: items.length,
      totalitems: items.length,
      totalpages: 1,
    },
  };
}

function toV1(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toV1);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [V1_KEYS[key] ?? key, toV1(item)]));
}

function listBody(t: Target, site: string, items: Row[]): unknown {
  if (t.shape === 'jsonapi') return jsonApiList(site, t.family, items);
  if (t.shape === 'v1') return { items: items.map(toV1), total: items.length };
  const data = { items, pageindex: 1, itemsperpage: 50, totalitems: items.length, totalpages: 1 };
  return envelope('list', data, { siteid: site });
}

function recordBody(t: Target, site: string, row: Row): unknown {
  if (t.shape === 'v1') return toV1(row);
  return envelope(t.shape === 'jsonapi' ? 'findOne' : 'detail', row, { entityname: t.family, siteid: site });
}

function without<T>(row: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
}

function targetsOf(survey: Row): string[] {
  const targets = Array.isArray(survey.targets) ? (survey.targets as Row[]) : [];
  return targets.map((target) => String(target.siteID));
}

function daysOf(sheet: Row): Row[] {
  return Array.isArray(sheet.days) ? (sheet.days as Row[]) : [];
}

function responsesOf(world: World, surveyId: string): Row[] {
  const known = world.responses.get(surveyId);
  if (known !== undefined) return known;
  const created: Row[] = [];
  world.responses.set(surveyId, created);
  return created;
}

/** `<fixture api or /v1>/<module>/<collection>[/<id>[/<action>]]`; group 1 is set for `/v1/`. */
const FAMILY_ROUTE = new RegExp(
  '^(?:/legacy-fixtures/cfml/api\\.cfm|(/v1))/(timesheets|finance|surveys)/(?:sheets|days|records|surveys)' +
    '(?:/([^/]+)(?:/(.+))?)?$',
);

/** The family route `call` addresses, or undefined. */
function targetOf(call: GatewayCall): Target | undefined {
  const api = /^\/_api\/(json|rest)\/v1\/([^/]+)\/(content|user)(?:\/([^/]+))?$/.exec(call.url.pathname);
  if (api !== null) {
    const [, kind, site = '', family, id] = api;
    const op: Op = kind === 'rest' ? 'write' : id === undefined ? 'list' : 'byId';
    return { family: family as FamilyId, op, shape: 'jsonapi', site, id };
  }
  const fixture = FAMILY_ROUTE.exec(call.url.pathname);
  if (fixture === null) return undefined;
  const [, v1, family, id, action] = fixture;
  const post = call.method === 'POST';
  let op: Op = 'write';
  if (id === undefined) op = post ? 'create' : 'list';
  else if (action === undefined) op = 'byId';
  else if (action === 'targets/bulk') op = 'bulk';
  else if (action === 'responses' && !post) op = 'responses';
  const site = call.url.searchParams.get('siteid') ?? '';
  return { family: family as FamilyId, op, shape: v1 === undefined ? 'fixture' : 'v1', site, id };
}

/** Answers a family route as an isolating gateway does: own-site rows only, everything else refused. */
function resource(world: World, call: GatewayCall, t: Target): Response {
  // A body `siteid` overrides the route's, as Masa and the fixtures merge form over URL params.
  const site = t.op === 'write' ? (call.fields.siteid ?? t.site) : t.site;
  const refuse = (): Response => world.refusal?.() ?? (t.shape === 'jsonapi' ? raw(UNAUTHORIZED, 401) : forbidden());
  const missing = (): Response => world.refusal?.() ?? notFound();
  const publicRead = t.family === 'content' && (t.op === 'list' || t.op === 'byId');
  if (!publicRead && call.caller?.site !== site) return refuse();
  const rows = world.rows[t.family];
  const key = ID_KEYS[t.family];
  const visible = (row: Row): boolean =>
    row.siteid === site || (t.family === 'user' && row.siteid === PUBLIC_USER_POOL[site]);
  const fields = without(call.fields, 'siteid');
  switch (t.op) {
    case 'list': {
      const pooled = call.url.searchParams.get('isPublic') === '1';
      const items = rows
        .filter((row) => (pooled ? row.ispublic === 1 && visible(row) : row.siteid === site))
        .map((row) => without(row, 'targets'));
      return json(listBody(t, site, items));
    }
    case 'byId': {
      const row = rows.find((candidate) => candidate[key] === t.id && visible(candidate));
      return row === undefined ? missing() : json(recordBody(t, site, row));
    }
    case 'create': {
      world.serial += 1;
      const survey: Row = {
        survey_id: cfId(42, 0, world.serial),
        siteid: site,
        title: fields.title,
        created: CHECKED_AT,
        createdbyid: call.caller?.username,
        targets: [],
      };
      rows.push(survey);
      return json(recordBody(t, site, survey));
    }
    case 'bulk': {
      const survey = rows.find((row) => row.survey_id === t.id && row.siteid === site);
      if (survey === undefined) return missing();
      const added = JSON.parse(fields.targets ?? '[]') as Row[];
      survey.targets = [...(survey.targets as Row[]), ...added.map((target) => ({ siteID: target.siteID }))];
      return json(envelope('bulkTarget', { inserted: added.length, total: targetsOf(survey).length }));
    }
    case 'responses': {
      const survey = rows.find((row) => row.survey_id === t.id && row.siteid === site);
      if (survey === undefined) return missing();
      const all = responsesOf(world, String(survey.survey_id));
      const size = world.responsesPerPage ?? Number(call.url.searchParams.get('itemsPerPage') ?? 50);
      const page = Number(call.url.searchParams.get('pageIndex') ?? 1);
      const items = all.slice((page - 1) * size, page * size);
      const totalpages = Math.max(1, Math.ceil(all.length / size));
      return json(envelope('list', { items, pageindex: page, itemsperpage: size, totalitems: all.length, totalpages }));
    }
    case 'write':
      return write(world, t, site, fields, refuse, missing);
  }
}

function write(
  world: World,
  t: Target,
  site: string,
  fields: Record<string, string>,
  refuse: () => Response,
  missing: () => Response,
): Response {
  if (t.family === 'surveys') {
    const survey = world.rows.surveys.find((row) => row.survey_id === t.id);
    if (survey === undefined) return missing();
    if (survey.siteid !== site && !targetsOf(survey).includes(site)) return refuse();
    return json(envelope('createResponse', addResponse(world, survey, site, fields.answers ?? '')));
  }
  if (t.family === 'timesheets') {
    const day = world.rows.timesheets
      .filter((sheet) => sheet.siteid === site)
      .flatMap(daysOf)
      .find((candidate) => candidate.day_id === t.id);
    if (day === undefined) return missing();
    Object.assign(day, fields);
    return json(recordBody(t, site, day));
  }
  const key = ID_KEYS[t.family];
  const row = world.rows[t.family].find((candidate) => candidate[key] === t.id && candidate.siteid === site);
  if (row === undefined) return missing();
  Object.assign(row, fields);
  return json(recordBody(t, site, row));
}

function addResponse(world: World, survey: Row, respondentSite: string, answers: string): Row {
  world.serial += 1;
  const response: Row = {
    response_id: cfId(50, 0, world.serial),
    survey_id: survey.survey_id,
    siteid: survey.siteid,
    respondentsiteid: respondentSite,
    answers,
  };
  responsesOf(world, String(survey.survey_id)).push(response);
  return response;
}

function decodeFields(headers: Record<string, string>, body: string | undefined): Record<string, string> {
  if (body === undefined) return {};
  if ((headers['content-type'] ?? '').startsWith('application/json')) {
    const parsed = JSON.parse(body) as Row;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
    );
  }
  return Object.fromEntries(new URLSearchParams(body));
}

/** An isolating gateway over `world`; `overrides` answer first, in order. */
function fakeGateway(world: World, ...overrides: Override[]): FakeGateway {
  const sessions = new Map<string, Caller>();
  const calls: GatewayCall[] = [];

  const accepts = (username: string, password: string, site?: string): Caller | undefined => {
    const home = USER_SITES.get(username);
    if (home === undefined || password !== passwordOf(username) || world.lockedOut.has(username)) return undefined;
    return site === undefined || site === home ? { site: home, username } : undefined;
  };

  const open = (caller: Caller): string[] => {
    const sid = `FIXTURE-SESSION-${String(sessions.size + 1)}`;
    sessions.set(sid, caller);
    return [`CFID=${sid}; Path=/; HttpOnly`, `CFTOKEN=${sid}; Path=/; HttpOnly`];
  };

  const callerOf = (headers: Record<string, string>): Caller | undefined => {
    const sid = /(?:^|;\s*)CFID=([^;]+)/.exec(headers.cookie ?? '')?.[1];
    const known = sid === undefined ? undefined : sessions.get(sid);
    if (known !== undefined) return known;
    const basic = /^Basic (.+)$/.exec(headers.authorization ?? '')?.[1];
    if (basic === undefined) return undefined;
    const [username = '', ...rest] = Buffer.from(basic, 'base64').toString('utf8').split(':');
    return accepts(username, rest.join(':'));
  };

  const answer = (call: GatewayCall): Response => {
    const { pathname, searchParams } = call.url;
    // The login form posts to `index.cfm` with `muraAction` in its body (admin/core/views/clogin/main.cfm:175,281).
    if (pathname === '/admin/' || pathname === '/admin/index.cfm') {
      const action = (searchParams.get('muraAction') ?? call.fields.muraAction ?? '').toLowerCase();
      if (call.method === 'POST' && action === 'clogin.login') {
        const caller = accepts(call.fields.username ?? '', call.fields.password ?? '');
        if (caller === undefined) return redirect('./?muraAction=cLogin.main&status=failed');
        return redirect('./', open(caller));
      }
      return html(action === 'clogin.main' ? LOGIN_PAGE : '<!DOCTYPE html><html><body>Site Content</body></html>');
    }
    const session = /^\/_api\/json\/v1\/([^/]+)\/(generateCSRFTokens|login)$/.exec(pathname);
    if (session !== null) {
      if (session[2] === 'generateCSRFTokens') return json(envelope('generateCSRFTokens', TOKENS));
      const caller = accepts(call.fields.username ?? '', call.fields.password ?? '', session[1]);
      if (caller === undefined) return json(envelope('login', { status: 'failed' }));
      return json(envelope('login', { status: 'success' }), 200, open(caller));
    }
    const t = targetOf(call);
    return t === undefined ? notFound() : resource(world, call, t);
  };

  const fetch: FetchLike = async (input, init) => {
    const headers = { ...(init.headers as Record<string, string>) };
    const body = typeof init.body === 'string' ? init.body : undefined;
    const call: GatewayCall = {
      method: init.method ?? 'GET',
      url: new URL(input),
      headers,
      fields: decodeFields(headers, body),
      caller: callerOf(headers),
    };
    calls.push(call);
    for (const override of overrides) {
      const replaced = override(call);
      if (replaced !== undefined) return replaced;
    }
    return answer(call);
  };
  return { fetch, calls };
}

function contentRows(): Row[] {
  return SITES.flatMap((site, s) => [
    ...SUCCESS.data.items.map((item, n) => ({
      ...item,
      siteid: site,
      contentid: s === 0 ? item.contentid : cfId(1, s, n),
      contenthistid: cfId(2, s, n),
      title: `${String(item.title)} ${site}`,
      filename: `${String(item.filename)}-${site}`,
    })),
    { contentid: HOME_ID, contenthistid: cfId(3, s, 0), siteid: site, title: 'Home', filename: '' },
  ]);
}

function person(site: string, s: number, n: number, username: string, ispublic: number): Row {
  const [fname = '', lname = ''] = username.split('-');
  return { userid: cfId(10, s, n), siteid: site, username, email: `${username}@example.test`, fname, lname, ispublic };
}

function day(s: number, n: number, state: string, isblackout = 0): Row {
  return { day_id: cfId(22, s, n), state, isblackout };
}

function sheet(site: string, s: number, n: number, personId: string, days: Row[]): Row {
  return { timesheet_id: cfId(20, s, n), siteid: site, person_id: personId, days };
}

function record(site: string, s: number, n: number): Row {
  return {
    record_id: cfId(30, s, n),
    siteid: site,
    title: `Budget ${site} ${String(n)}`,
    amount: '120.00',
    period: '2026-06',
    createdbyid: cfId(31, s, n),
    created: `2026-06-0${String(n)}T0${String(s)}:00:00`,
  };
}

function survey(site: string, s: number, n: number, targets: readonly string[]): Row {
  return {
    survey_id: cfId(40, s, n),
    siteid: site,
    title: `Survey ${site} ${String(n)}`,
    createdbyid: cfId(41, s, n),
    created: `2026-06-0${String(n)}T1${String(s)}:00:00`,
    targets: targets.map((target) => ({ siteID: target })),
  };
}

/** Seeded records of tenant-a, tenant-b and umbrella, with one reserved person and one reserved username. */
function buildWorld(): World {
  return {
    rows: {
      content: contentRows(),
      user: [
        person(SITE_A, 0, 1, 'ada-staff', 0),
        person(SITE_A, 0, 2, 'alan-member', 1),
        person(SITE_A, 0, 3, RESERVED_USERNAME, 0),
        person(SITE_B, 1, 1, 'bea-staff', 0),
        person(SITE_B, 1, 2, 'bob-member', 1),
        person(SITE_U, 2, 1, 'uma-member', 1),
        person(SITE_U, 2, 2, 'uri-member', 1),
      ],
      timesheets: [
        sheet(SITE_A, 0, 1, cfId(21, 0, 1), [day(0, 1, 'DRAFT')]),
        sheet(SITE_A, 0, 2, RESERVED_PERSON, [day(0, 2, 'DRAFT')]),
        sheet(SITE_B, 1, 1, cfId(21, 1, 1), [day(1, 1, 'DRAFT', 1)]),
        sheet(SITE_B, 1, 2, cfId(21, 1, 2), [day(1, 2, 'SUBMITTED'), day(1, 3, 'DRAFT'), day(1, 4, 'DRAFT', 1)]),
      ],
      finance: [record(SITE_A, 0, 1), record(SITE_B, 1, 1)],
      surveys: [survey(SITE_A, 0, 1, [SITE_B]), survey(SITE_A, 0, 2, []), survey(SITE_B, 1, 1, [])],
    },
    responses: new Map(),
    lockedOut: new Set(),
    serial: 0,
  };
}

function rowsOf(world: World, family: FamilyId, site: string): Row[] {
  return world.rows[family].filter((row) => row.siteid === site);
}

function firstRow(world: World, family: FamilyId, site: string): Row {
  const row = rowsOf(world, family, site)[0];
  if (row === undefined) throw new Error(`no ${family} row of ${site}`);
  return row;
}

/** Site a call addresses: the JSON API path segment, else the `siteid` query parameter. */
function routeSite(call: GatewayCall): string | undefined {
  return (
    /^\/_api\/(?:json|rest)\/v1\/([^/]+)\//.exec(call.url.pathname)?.[1] ??
    call.url.searchParams.get('siteid') ??
    undefined
  );
}

function lastSegment(call: GatewayCall): string {
  return call.url.pathname.split('/').at(-1) ?? '';
}

function isGet(call: GatewayCall, pathname: string, by: string): boolean {
  return call.method === 'GET' && call.url.pathname === pathname && call.caller?.site === by;
}

// ---------------------------------------------------------------------------------------------------------------
// Run helpers

let stateDir: string;
let env: EnvLike;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2-gateway-matrix-'));
  env = { OPT2_STATE_DIR: stateDir, OPT2_GATEWAY_URL: GATEWAY };
  const users = Object.fromEntries(
    Object.entries(ROLE_USERS).map(([site, roles]) => [
      site,
      Object.fromEntries(Object.values(roles).map((username) => [username, passwordOf(username)])),
    ]),
  );
  fs.mkdirSync(path.join(stateDir, 'secrets'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(stateDir, 'secrets', SEED_CREDENTIALS_FILE),
    `${JSON.stringify({ users, roles: ROLE_USERS }, null, 2)}\n`,
    { mode: 0o600 },
  );
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function writeFixtureStatus(available: boolean, reason: string | null): void {
  const status = { available, reason, checkedAt: CHECKED_AT };
  fs.writeFileSync(path.join(stateDir, 'fixtures.json'), `${JSON.stringify(status)}\n`);
}

function familiesOf(...ids: FamilyId[]): RouteFamily[] {
  return ROUTE_FAMILIES.filter((family) => ids.includes(family.id));
}

function run(fake: FakeGateway, deps: GatewayIsolationDeps = {}): Promise<GatewayIsolationResult> {
  return runGatewayIsolation({ env, fetch: fake.fetch, fixtures: AVAILABLE, ...deps });
}

function caseOf(result: GatewayIsolationResult, id: string): IsolationCase {
  const found = result.cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
}

function idsWhere(result: GatewayIsolationResult, outcome: CaseResult): string[] {
  return result.cases.filter((c) => c.result === outcome).map((c) => c.id);
}

/** `<id>: <result> <reason>` of every case that is not `outcome`, for readable failures. */
function notResult(result: GatewayIsolationResult, outcome: CaseResult): string[] {
  return result.cases.filter((c) => c.result !== outcome).map((c) => `${c.id}: ${c.result} ${c.reason ?? ''}`);
}

const TENANT_IDS = [TENANT_A.tenantId, TENANT_B.tenantId, TENANT_UMBRELLA.tenantId];

/** Problems of calls that leave the gateway origin or carry gateway-internal or tenant addressing. */
function disciplineProblems(calls: readonly GatewayCall[], base: string): string[] {
  const origin = new URL(base).origin;
  return calls.flatMap((call) => {
    const where = `${call.method} ${call.url.pathname}`;
    const problems: string[] = [];
    if (call.url.origin !== origin) problems.push(`${where}: origin ${call.url.origin}`);
    for (const name of Object.keys(call.headers)) {
      if (/^x-opt2-|^x-serverless-authorization$|tenant/i.test(name)) problems.push(`${where}: header ${name}`);
    }
    for (const name of [...call.url.searchParams.keys(), ...Object.keys(call.fields)]) {
      if (/^tenant[-_]?id$/i.test(name)) problems.push(`${where}: parameter ${name}`);
    }
    const text = `${call.url.href} ${JSON.stringify(call.fields)}`.toLowerCase();
    for (const tenantId of TENANT_IDS) if (text.includes(tenantId)) problems.push(`${where}: tenant id ${tenantId}`);
    return problems;
  });
}

function keyOf(fixture: TenantFixture): TenantKey {
  const entry = Object.entries(TENANTS_BY_KEY).find(([, candidate]) => candidate === fixture);
  if (entry === undefined) throw new Error(`no tenant key of ${fixture.siteId}`);
  return entry[0] as TenantKey;
}

// ---------------------------------------------------------------------------------------------------------------

describe('TENANTS_BY_KEY and ACTORS', () => {
  it('maps the tenant keys to the seeded sites tenant-a, tenant-b and umbrella', () => {
    expect(Object.fromEntries(Object.entries(TENANTS_BY_KEY).map(([key, fixture]) => [key, fixture.siteId]))).toEqual({
      a: 'tenant-a',
      b: 'tenant-b',
      umbrella: 'umbrella',
    });
  });

  /** Every actor reference with its tenant, the ungranted survey respondent last. */
  function actorRefs(): [TenantKey, ActorRef][] {
    const refs = Object.values(ACTORS).flatMap((byTenant) =>
      ALL_KEYS.flatMap((key): [TenantKey, ActorRef][] => {
        const ref = byTenant[key];
        return ref === undefined ? [] : [[key, ref]];
      }),
    );
    return [...refs, [SURVEY_GRANT.ungranted, SURVEY_GRANT.ungrantedRespondent]];
  }

  it("names every actor's username and password by its own site's seed credentials", () => {
    expect(actorRefs()).toHaveLength(12);
    for (const [tenant, ref] of actorRefs()) {
      const site = TENANTS_BY_KEY[tenant].siteId;
      expect(ref.username).toBe(`\${user:${site}:${ref.role}}`);
      expect(ref.password).toBe(`\${secret:seed:${ref.username}}`);
    }
  });

  it('logs public-pool members in through the JSON API and every other actor through the admin form', () => {
    for (const [tenant, ref] of actorRefs()) {
      expect(ref.login).toBe(tenant === 'umbrella' ? 'jsonapi' : 'admin');
      if (tenant === 'umbrella') expect(ref.role).toBe('member');
    }
  });
});

describe('buildCases', () => {
  const PAIR_KINDS = ['read-list', 'read-by-id', 'write-owner-site', 'write-site-mismatch'] as const;

  it('builds every pair probe of each family, one pooled-read and one survey-grant case, sorted and unique', () => {
    const cases = buildCases(ROUTE_FAMILIES, { fixtures: { available: true } });
    const expected = ROUTE_FAMILIES.flatMap((family) => {
      const owners = family.owners ?? ALL_KEYS;
      const kinds = family.idAddressedWrite ? [...PAIR_KINDS, 'write-foreign-id'] : [...PAIR_KINDS];
      return crossTenantPairs().flatMap(({ reader, writer }) => {
        const [actor, owner] = [keyOf(reader), keyOf(writer)];
        if (ACTORS[family.id][actor] === undefined || !owners.includes(owner)) return [];
        return kinds.map((kind) => `${family.id}:${kind}:${actor}->${owner}`);
      });
    });
    const grant = `surveys:survey-grant:${SURVEY_GRANT.ungranted}->${SURVEY_GRANT.grantor}`;
    const ids = cases.map((c) => c.id);
    expect(ids).toStrictEqual([...expected, 'user:pooled-read:a->umbrella', grant].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(cases).toHaveLength(70);
  });

  it('starts every case inconclusive and not run, GET for reads and POST for writes', () => {
    const cases = buildCases(ROUTE_FAMILIES, { fixtures: { available: true } });
    for (const c of cases) {
      expect(c).toMatchObject({ result: 'inconclusive', reason: NOT_RUN, observed: {} });
      expect(c.method).toBe(/^(?:read-|pooled-read)/.test(c.kind) ? 'GET' : 'POST');
    }
  });

  it.each([
    ['timesheets:read-list:a->b', `${API}/timesheets/sheets?siteid=tenant-b&itemsPerPage=50`, 'no-owner-rows'],
    ['content:read-by-id:b->a', '/_api/json/v1/tenant-b/content/{id}', 'no-owner-record'],
    ['user:write-owner-site:a->umbrella', '/_api/rest/v1/umbrella/user/{id}', 'refused-no-effect'],
    ['user:write-site-mismatch:b->a', '/_api/rest/v1/tenant-b/user/{id}', 'refused-no-effect'],
    ['finance:write-foreign-id:b->a', `${API}/finance/records/{id}/edit?siteid=tenant-b`, 'refused-no-effect'],
    ['user:pooled-read:a->umbrella', '/_api/json/v1/tenant-a/user?itemsPerPage=50&isPublic=1', 'registry-pools-only'],
    ['surveys:survey-grant:umbrella->a', `${API}/surveys/surveys/{id}/responses?siteid=umbrella`, 'granted-sites-only'],
  ])('addresses %s at %s, expecting %s', (id, route, expected) => {
    const found = buildCases(ROUTE_FAMILIES, { fixtures: { available: true } }).find((c) => c.id === id);
    expect(found).toMatchObject({ route, expected });
  });

  it('moves fixture families to their /v1/ routes when fixtures are unavailable and skips those without', () => {
    const available = buildCases(ROUTE_FAMILIES, { fixtures: { available: true } });
    const unavailable = buildCases(ROUTE_FAMILIES, { fixtures: { available: false } });
    expect(unavailable.map((c) => c.id)).toStrictEqual(available.map((c) => c.id));
    for (const c of unavailable) {
      if (c.family === 'surveys') expect(c).toMatchObject({ result: 'skipped', reason: FIXTURES_UNAVAILABLE });
      else expect(c).toMatchObject({ result: 'inconclusive', reason: NOT_RUN });
      if (c.family === 'timesheets' || c.family === 'finance') expect(c.route.startsWith('/v1/')).toBe(true);
    }
    const unchanged = (c: IsolationCase): boolean => c.family === 'content' || c.family === 'user';
    expect(unavailable.filter(unchanged)).toStrictEqual(available.filter(unchanged));
  });

  it('probes only the pairs it is given', () => {
    const cases = buildCases(familiesOf('content', 'user'), {
      fixtures: { available: true },
      pairs: [{ writer: TENANT_B, reader: TENANT_A }],
    });
    expect(cases.map((c) => c.id)).toStrictEqual([
      'content:read-by-id:a->b',
      'content:read-list:a->b',
      'content:write-owner-site:a->b',
      'content:write-site-mismatch:a->b',
      'user:pooled-read:a->umbrella',
      'user:read-by-id:a->b',
      'user:read-list:a->b',
      'user:write-owner-site:a->b',
      'user:write-site-mismatch:a->b',
    ]);
  });

  it('returns fresh cases on every call and leaves the route families untouched', () => {
    const before = JSON.stringify(ROUTE_FAMILIES);
    const first = buildCases(ROUTE_FAMILIES, { fixtures: { available: true } });
    const firstCopy = structuredClone(first);
    for (const c of first) {
      c.result = 'violation';
      c.observed.leakedIds = 9;
    }
    expect(buildCases(ROUTE_FAMILIES, { fixtures: { available: true } })).toStrictEqual(firstCopy);
    expect(JSON.stringify(ROUTE_FAMILIES)).toBe(before);
    expect(Object.isFrozen(ROUTE_FAMILIES)).toBe(true);
  });

  it('addresses tenants only through the site of each route', () => {
    for (const available of [true, false]) {
      for (const c of buildCases(ROUTE_FAMILIES, { fixtures: { available } })) {
        const url = new URL(c.route, GATEWAY);
        expect([...url.searchParams.keys()].filter((name) => /tenant/i.test(name))).toStrictEqual([]);
        expect(TENANT_IDS.filter((tenantId) => c.route.toLowerCase().includes(tenantId))).toStrictEqual([]);
        expect(c.route).not.toMatch(/x-opt2|serverless/i);
      }
    }
  });
});

describe('isLegacyRefusal', () => {
  const body = (status: number, value: unknown) => ({ status, text: JSON.stringify(value) });
  const withError = (status: number, error: unknown, extra: Row = {}) =>
    body(status, { apiversion: 'v1', method: 'save', ...extra, error });
  const saveErrors = (status: number, errors: Row) =>
    body(status, { apiversion: 'v1', method: 'save', data: { errors } });
  const notFoundError = { code: 'invalid_request', message: 'Not Found' };
  const CSRF_MESSAGE = 'Invalid CSRF tokens';

  it.each<[string, { status: number; text: string }, RefusalOptions, boolean]>([
    ['a 401 insufficient-permissions envelope', { status: 401, text: UNAUTHORIZED }, {}, true],
    ['a 401 invalid-token envelope', { status: 401, text: INVALID_TOKEN }, {}, true],
    ['a 403 error envelope', withError(403, notFoundError), {}, true],
    ['a 404 envelope with object params', withError(404, notFoundError, { params: { siteid: SITE_A } }), {}, true],
    ['a 403 envelope carrying save errors', saveErrors(403, { title: 'required' }), {}, true],
    ['a 403 envelope with empty save errors', saveErrors(403, {}), {}, false],
    ['a 404 envelope carrying save errors only', saveErrors(404, { title: 'required' }), {}, false],
    ['a 401 envelope without an error', body(401, envelope('findOne', {})), {}, false],
    ['a 400 bad request on a fixture route', { status: 400, text: BAD_REQUEST }, { fixture: true }, true],
    ['a 400 bad request off a fixture route', { status: 400, text: BAD_REQUEST }, {}, false],
    ['a 400 bad request with fixture false', { status: 400, text: BAD_REQUEST }, { fixture: false }, false],
    ['a 400 CSRF refusal on a fixture route', { status: 400, text: INVALID_CSRF }, { fixture: true }, false],
    ['a 401 carrying the CSRF message', withError(401, { code: 'invalid_request', message: CSRF_MESSAGE }), {}, false],
    ['a 500 server error', { status: 500, text: SERVER_ERROR }, { fixture: true }, false],
    ['a 200 success envelope', { status: 200, text: JSON.stringify(SUCCESS) }, {}, false],
    ['a 302 without a body', { status: 302, text: '' }, {}, false],
    ['a 403 HTML page', { status: 403, text: '<html><body>Forbidden</body></html>' }, {}, false],
    ['a 403 envelope of api v2', body(403, { apiversion: 'v2', method: 'save', error: notFoundError }), {}, false],
    ['a 403 envelope without a method', body(403, { apiversion: 'v1', error: notFoundError }), {}, false],
    ['a 403 envelope whose params is a list', withError(403, notFoundError, { params: [] }), {}, false],
    ['a 403 error without a message', withError(403, { code: 'invalid_request' }), {}, false],
    ['a 403 JSON list', body(403, [notFoundError]), {}, false],
  ])('%s is %s', (_name, result, opts, expected) => {
    expect(isLegacyRefusal(result, opts)).toBe(expected);
  });
});

describe('runGatewayIsolation', () => {
  it('passes every case through the fixture routes when the gateway refuses every cross-tenant probe', async () => {
    writeFixtureStatus(true, null);
    const world = buildWorld();
    const fake = fakeGateway(world);
    const result = await runGatewayIsolation({ env, fetch: fake.fetch });

    expect(notResult(result, 'pass')).toStrictEqual([]);
    expect(result).toMatchObject({ crossTenantReads: 0, crossTenantWrites: 0, surveyGrantOnly: true });
    expect(result.cases.map((c) => c.id)).toStrictEqual(
      buildCases(ROUTE_FAMILIES, { fixtures: { available: true } }).map((c) => c.id),
    );
    expect(disciplineProblems(fake.calls, originBaseUrl('gateway', env))).toStrictEqual([]);

    const reserved = [
      world.rows.user.find((row) => row.username === RESERVED_USERNAME)?.userid,
      world.rows.timesheets.find((row) => row.person_id === RESERVED_PERSON)?.timesheet_id,
    ].map(String);
    expect(reserved).not.toContain('undefined');
    expect(fake.calls.filter((call) => reserved.some((id) => call.url.pathname.includes(id)))).toStrictEqual([]);
    expect(fake.calls.some((call) => call.url.pathname.startsWith(`${API}/`))).toBe(true);
    expect(fake.calls.filter((call) => call.url.pathname.startsWith('/v1/'))).toStrictEqual([]);

    const writes = fake.calls.filter((call) => call.method === 'POST' && targetOf(call)?.op === 'write');
    expect(writes.length).toBeGreaterThan(0);
    const marked = (call: GatewayCall): boolean =>
      Object.values(call.fields).some((value) => value.includes(DEFAULT_PROBE_SUFFIX));
    expect(writes.every(marked)).toBe(true);
    const draftDay = String(daysOf(rowsOf(world, 'timesheets', SITE_B)[1] ?? {})[1]?.day_id);
    const dayWrites = writes.filter(
      (call) => call.caller?.site === SITE_A && call.url.pathname.startsWith(`${API}/timesheets/days/`),
    );
    expect(dayWrites.map((call) => call.url.pathname)).toStrictEqual(
      Array.from({ length: 3 }, () => `${API}/timesheets/days/${draftDay}/submit`),
    );
  });

  it('runs /v1/ routes and skips the surveys family unrequested when fixtures.json is unavailable', async () => {
    writeFixtureStatus(false, UNAVAILABLE_REASON);
    const fake = fakeGateway(buildWorld());
    const result = await runGatewayIsolation({ env, fetch: fake.fetch });

    const surveys = result.cases.filter((c) => c.family === 'surveys');
    expect(surveys).toHaveLength(9);
    for (const c of surveys) expect(c).toMatchObject({ result: 'skipped', reason: FIXTURES_UNAVAILABLE, observed: {} });
    expect(fake.calls.filter((call) => call.url.pathname.startsWith('/legacy-fixtures/'))).toStrictEqual([]);
    expect(fake.calls.filter((call) => call.url.pathname.includes('/surveys/'))).toStrictEqual([]);
    expect(notResult(result, 'pass').filter((line) => !line.startsWith('surveys:'))).toStrictEqual([]);
    for (const family of ['timesheets', 'finance'] as const) {
      expect(fake.calls.some((call) => call.url.pathname.startsWith(`/v1/${family}/`))).toBe(true);
    }
    expect(result).toMatchObject({ crossTenantReads: 0, crossTenantWrites: 0, surveyGrantOnly: false });
    expect(disciplineProblems(fake.calls, GATEWAY)).toStrictEqual([]);
  });

  it('sends each /v1/ write with the CSRF pair issued for the id it writes, as the services consume it', async () => {
    writeFixtureStatus(false, UNAVAILABLE_REASON);
    const fake = fakeGateway(buildWorld());
    await runGatewayIsolation({ env, fetch: fake.fetch });

    const header = (call: GatewayCall, name: string): string | undefined =>
      Object.entries(call.headers).find(([key]) => key.toLowerCase() === name)?.[1];
    const writes = fake.calls.filter((call) => call.method === 'POST' && call.url.pathname.startsWith('/v1/'));
    expect(writes.length).toBeGreaterThan(0);
    expect(
      writes.filter((call) => header(call, 'x-csrf_token') !== TOKENS.csrf_token || header(call, 'x-csrf_token_expires') !== TOKENS.csrf_token_expires),
    ).toStrictEqual([]);
    const contexts = new Set(
      fake.calls.filter((call) => call.url.pathname.endsWith('/generateCSRFTokens')).map((call) => call.url.searchParams.get('context')),
    );
    expect(writes.filter((call) => !contexts.has(call.url.pathname.split('/')[4] ?? null))).toStrictEqual([]);
  });

  it('honours the base URL, reserved identities and probe marker it is given', async () => {
    const world = buildWorld();
    const fake = fakeGateway(world);
    const baseUrl = 'http://gateway-alt.invalid';
    const userIdOf = (username: string): string =>
      String(rowsOf(world, 'user', SITE_A).find((row) => row.username === username)?.userid);
    const requested = (id: string): boolean => fake.calls.some((call) => call.url.pathname.endsWith(`/${id}`));
    const result = await run(fake, {
      families: familiesOf('user'),
      baseUrl,
      reserved: { persons: [], usernames: ['ALAN-MEMBER'] },
      probeSuffix: 'fixture-probe-42',
    });

    expect(notResult(result, 'pass')).toStrictEqual([]);
    expect(disciplineProblems(fake.calls, baseUrl)).toStrictEqual([]);
    expect(requested(userIdOf('alan-member'))).toBe(false);
    expect(requested(userIdOf(RESERVED_USERNAME))).toBe(true);
    const writes = fake.calls.filter((call) => call.method === 'POST' && targetOf(call)?.op === 'write');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((call) => call.fields.jobtitle === 'fixture-probe-42')).toBe(true);
  });

  it('probes at most MAX_OWNER_RECORDS records of an owner', async () => {
    const world = buildWorld();
    for (let n = 10; n < 15; n += 1) {
      world.rows.content.push({ contentid: cfId(1, 1, n), siteid: SITE_B, title: `Extra ${String(n)}`, filename: '' });
    }
    const fake = fakeGateway(world);
    const result = await run(fake, { families: familiesOf('content') });

    const ownerIds = new Set(rowsOf(world, 'content', SITE_B).map((row) => String(row.contentid)));
    const probed = new Set(
      fake.calls
        .filter((call) => call.caller?.site === SITE_A)
        .filter((call) => call.url.pathname.startsWith('/_api/json/v1/tenant-a/content/'))
        .map(lastSegment)
        .filter((id) => ownerIds.has(id) && id !== HOME_ID),
    );
    expect(probed.size).toBe(MAX_OWNER_RECORDS);
    expect(notResult(result, 'pass')).toStrictEqual([]);
  });

  interface ReadRow {
    name: string;
    families: FamilyId[];
    overrides: (world: World) => Override[];
    caseId: string;
    observed: Row;
    reason: string;
  }

  it.each<ReadRow>([
    {
      name: 'a list returning one owner row',
      families: ['user'],
      overrides: (world) => [
        (call) =>
          isGet(call, '/_api/json/v1/tenant-a/user', SITE_B)
            ? json(jsonApiList(SITE_A, 'user', [firstRow(world, 'user', SITE_A)]))
            : undefined,
      ],
      caseId: 'user:read-list:b->a',
      observed: { status: 200, leakedIds: 1 },
      reason: '1 a ids returned to b',
    },
    {
      name: 'a list returning an owner row without its site',
      families: ['user'],
      overrides: (world) => [
        (call) =>
          isGet(call, '/_api/json/v1/tenant-a/user', SITE_B)
            ? json(jsonApiList(SITE_A, 'user', [without(firstRow(world, 'user', SITE_A), 'siteid')]))
            : undefined,
      ],
      caseId: 'user:read-list:b->a',
      observed: { status: 200, leakedIds: 1 },
      reason: '1 a ids returned to b',
    },
    {
      name: "a by-id read returning the owner's record",
      families: ['content'],
      overrides: (world) => {
        const owned = firstRow(world, 'content', SITE_B);
        return [
          (call) =>
            isGet(call, `/_api/json/v1/tenant-a/content/${String(owned.contentid)}`, SITE_A)
              ? json(envelope('findOne', owned))
              : undefined,
        ];
      },
      caseId: 'content:read-by-id:a->b',
      observed: { status: 200, leakedIds: 1 },
      reason: '1 b ids returned to a',
    },
    {
      name: "a by-id read relabelling the owner's record with the actor's site",
      families: ['content'],
      overrides: (world) => {
        const owned = firstRow(world, 'content', SITE_B);
        return [
          (call) =>
            isGet(call, `/_api/json/v1/tenant-a/content/${String(owned.contentid)}`, SITE_A)
              ? json(envelope('findOne', { ...owned, siteid: SITE_A }))
              : undefined,
        ];
      },
      caseId: 'content:read-by-id:a->b',
      observed: { status: 200, leakedIds: 1 },
      reason: '1 b ids returned to a',
    },
    {
      name: 'a pooled list holding a row outside the registry pools',
      families: ['user'],
      overrides: (world) => [
        (call) =>
          isGet(call, '/_api/json/v1/tenant-b/user', SITE_B) && call.url.searchParams.get('isPublic') === '1'
            ? json(jsonApiList(SITE_B, 'user', [...rowsOf(world, 'user', SITE_B), firstRow(world, 'user', SITE_A)]))
            : undefined,
      ],
      caseId: 'user:pooled-read:a->umbrella',
      observed: { leakedIds: 1 },
      reason: '1 rows outside the registry pools',
    },
    {
      name: 'a pooled list holding an unlabelled row only another tenant lists',
      families: ['user'],
      overrides: (world) => [
        (call) =>
          isGet(call, '/_api/json/v1/tenant-b/user', SITE_B) && call.url.searchParams.get('isPublic') === '1'
            ? json(
                jsonApiList(SITE_B, 'user', [
                  ...rowsOf(world, 'user', SITE_B),
                  without(firstRow(world, 'user', SITE_A), 'siteid'),
                ]),
              )
            : undefined,
      ],
      caseId: 'user:pooled-read:a->umbrella',
      observed: { leakedIds: 1 },
      reason: '1 rows outside the registry pools',
    },
    {
      name: 'a pooled list missing its registry pool',
      families: ['user'],
      overrides: (world) => [
        (call) =>
          isGet(call, '/_api/json/v1/tenant-a/user', SITE_A) && call.url.searchParams.get('isPublic') === '1'
            ? json(jsonApiList(SITE_A, 'user', rowsOf(world, 'user', SITE_A)))
            : undefined,
      ],
      caseId: 'user:pooled-read:a->umbrella',
      observed: { leakedIds: 0 },
      reason: 'a saw no umbrella rows (status 200)',
    },
  ])('counts one cross-tenant read for $name', async ({ families, overrides, caseId, observed, reason }) => {
    const world = buildWorld();
    const result = await run(fakeGateway(world, ...overrides(world)), { families: familiesOf(...families) });

    expect(idsWhere(result, 'violation')).toStrictEqual([caseId]);
    expect(caseOf(result, caseId)).toMatchObject({ result: 'violation', observed, reason });
    expect(result).toMatchObject({ crossTenantReads: 1, crossTenantWrites: 0 });
  });

  it.each<[string, () => Response, number]>([
    ['a 401 insufficient-permissions envelope', () => raw(UNAUTHORIZED, 401), 401],
    ['a 401 invalid-token envelope', () => raw(INVALID_TOKEN, 401), 401],
    ['a 403 envelope', forbidden, 403],
    ['a 404 envelope', notFound, 404],
    ['a redirect to cMessage.noaccess', () => redirect('/admin/?muraAction=cMessage.noaccess'), 200],
  ])('passes a cross-tenant list read refused with %s', async (_name, refusal, status) => {
    const refused: Override = (call) => (isGet(call, '/_api/json/v1/tenant-a/user', SITE_B) ? refusal() : undefined);
    const result = await run(fakeGateway(buildWorld(), refused), { families: familiesOf('user') });

    expect(caseOf(result, 'user:read-list:b->a')).toMatchObject({ result: 'pass', observed: { status, leakedIds: 0 } });
    expect(notResult(result, 'pass')).toStrictEqual([]);
  });

  interface WriteRow {
    name: string;
    family: FamilyId;
    answer: (world: World, call: GatewayCall) => Response;
    result: CaseResult;
    reason?: string;
    observed: Row;
    writes: number;
  }

  /** Applies the call's fields to the content record its path names. */
  function apply(world: World, call: GatewayCall): void {
    const row = world.rows.content.find((candidate) => candidate.contentid === lastSegment(call));
    Object.assign(row ?? {}, without(call.fields, 'siteid'));
  }

  it.each<WriteRow>([
    {
      name: 'accepted and applied',
      family: 'content',
      answer: (world, call) => {
        apply(world, call);
        return json(envelope('save', {}));
      },
      result: 'violation',
      reason: "the owner's record changed",
      observed: { status: 200, effect: true },
      writes: 1,
    },
    {
      name: 'accepted without effect',
      family: 'content',
      answer: () => json(envelope('save', {})),
      result: 'violation',
      reason: 'the write was accepted (status 200)',
      observed: { status: 200, effect: false },
      writes: 1,
    },
    {
      name: 'refused yet applied',
      family: 'content',
      answer: (world, call) => {
        apply(world, call);
        return raw(UNAUTHORIZED, 401);
      },
      result: 'violation',
      reason: "the owner's record changed",
      observed: { status: 401, errorCode: 'invalid_request', effect: true },
      writes: 1,
    },
    {
      name: 'refused for CSRF',
      family: 'content',
      answer: () => raw(INVALID_CSRF, 400),
      result: 'inconclusive',
      reason: 'refused for CSRF, not for tenancy',
      observed: { status: 400, effect: false },
      writes: 0,
    },
    {
      name: 'a server error',
      family: 'content',
      answer: serverError,
      result: 'inconclusive',
      reason: 'answered 500',
      observed: { status: 500, errorCode: 'server_error', effect: false },
      writes: 0,
    },
    {
      name: 'neither accepted nor a legacy refusal',
      family: 'content',
      answer: conflict,
      result: 'inconclusive',
      reason: 'answered 409, neither accepted nor a legacy refusal',
      observed: { status: 409, effect: false },
      writes: 0,
    },
    {
      name: 'a bad request off a fixture route',
      family: 'content',
      answer: () => raw(BAD_REQUEST, 400),
      result: 'inconclusive',
      reason: 'answered 400, neither accepted nor a legacy refusal',
      observed: { status: 400, effect: false },
      writes: 0,
    },
    {
      name: 'a bad request on a fixture route',
      family: 'finance',
      answer: () => raw(BAD_REQUEST, 400),
      result: 'pass',
      observed: { status: 400, errorCode: 'invalid_request', effect: false },
      writes: 0,
    },
  ])('settles a write to the owner site answered $name', async (row) => {
    const { family, answer, result, reason, observed, writes } = row;
    const world = buildWorld();
    const ownerSiteWrite: Override = (call) =>
      call.method === 'POST' &&
      call.caller?.site === SITE_A &&
      routeSite(call) === SITE_B &&
      targetOf(call)?.op === 'write'
        ? answer(world, call)
        : undefined;
    const outcome = await run(fakeGateway(world, ownerSiteWrite), { families: familiesOf(family) });

    const probed = caseOf(outcome, `${family}:write-owner-site:a->b`);
    expect(probed).toMatchObject({ result, observed, reason });
    expect(outcome.crossTenantWrites).toBe(writes);
    expect(outcome.crossTenantReads).toBe(0);
    expect(outcome.cases.filter((c) => c !== probed && c.result !== 'pass')).toStrictEqual([]);
  });

  interface GrantRow {
    name: string;
    setup?: (world: World) => void;
    overrides?: (world: World) => Override[];
    result: CaseResult;
    reason?: string;
    writes: number;
  }

  const RESPONSES = /^\/legacy-fixtures\/cfml\/api\.cfm\/surveys\/surveys\/([^/]+)\/responses$/;
  const respondedBy =
    (site: string, answer: (world: World, call: GatewayCall) => Response) =>
    (world: World): Override[] => [
      (call) =>
        call.method === 'POST' &&
        RESPONSES.test(call.url.pathname) &&
        call.caller?.site === site &&
        routeSite(call) === site
          ? answer(world, call)
          : undefined,
    ];
  const storeResponse = (world: World, call: GatewayCall): void => {
    const id = RESPONSES.exec(call.url.pathname)?.[1];
    const target = world.rows.surveys.find((row) => row.survey_id === id);
    if (target !== undefined) addResponse(world, target, SITE_U, call.fields.answers ?? '');
  };
  const ungrantTarget = (world: World): void => {
    for (const row of rowsOf(world, 'surveys', SITE_A)) row.targets = [];
  };
  const failing = (match: (call: GatewayCall) => boolean) => (): Override[] => [
    (call) => (match(call) ? serverError() : undefined),
  ];

  it.each<GrantRow>([
    {
      name: 'the ungranted response is accepted',
      overrides: respondedBy(SITE_U, (world, call) => {
        storeResponse(world, call);
        return json(envelope('createResponse', {}));
      }),
      result: 'violation',
      reason: 'the umbrella response was accepted',
      writes: 1,
    },
    {
      name: 'the ungranted response is refused yet stored',
      overrides: respondedBy(SITE_U, (world, call) => {
        storeResponse(world, call);
        return forbidden();
      }),
      result: 'violation',
      reason: 'the umbrella response was accepted',
      writes: 1,
    },
    {
      name: 'the granted response is refused',
      overrides: respondedBy(SITE_B, () => forbidden()),
      result: 'violation',
      reason: 'no tenant-b response is listed (status 403)',
      writes: 0,
    },
    {
      name: 'the granted response fails',
      overrides: respondedBy(SITE_B, serverError),
      result: 'inconclusive',
      reason: 'the granted response answered 500',
      writes: 0,
    },
    {
      name: 'the granted response is refused for CSRF',
      overrides: respondedBy(SITE_B, () => raw(INVALID_CSRF, 400)),
      result: 'inconclusive',
      reason: 'the granted response answered 400',
      writes: 0,
    },
    {
      name: 'the ungranted response fails',
      overrides: respondedBy(SITE_U, serverError),
      result: 'inconclusive',
      reason: 'the ungranted response answered 500',
      writes: 0,
    },
    {
      name: 'the ungranted response is neither accepted nor refused',
      overrides: respondedBy(SITE_U, conflict),
      result: 'inconclusive',
      reason: 'the ungranted response answered 409, not a legacy refusal',
      writes: 0,
    },
    {
      name: "the grantor's survey list fails",
      overrides: failing(
        (call) => isGet(call, `${API}/surveys/surveys`, SITE_A) && call.url.searchParams.get('itemsPerPage') === '1000',
      ),
      result: 'inconclusive',
      reason: "the grantor's survey list answered 500",
      writes: 0,
    },
    {
      name: 'the survey create fails',
      setup: ungrantTarget,
      overrides: failing((call) => call.method === 'POST' && call.url.pathname === `${API}/surveys/surveys`),
      result: 'inconclusive',
      reason: 'the survey create answered 500',
      writes: 0,
    },
    {
      name: 'bulk targeting fails',
      setup: ungrantTarget,
      overrides: failing((call) => call.url.pathname.endsWith('/targets/bulk')),
      result: 'inconclusive',
      reason: 'bulk targeting answered 500',
      writes: 0,
    },
    {
      name: "the grantor's response list fails",
      overrides: failing((call) => RESPONSES.test(call.url.pathname) && call.url.searchParams.has('pageIndex')),
      result: 'inconclusive',
      reason: "the grantor's response list answered 500",
      writes: 0,
    },
    {
      name: 'the ungranted respondent cannot log in',
      setup: (world) => world.lockedOut.add(loginOf(SITE_U, 'member')),
      result: 'inconclusive',
      reason: 'umbrella survey respondent login failed (status 200)',
      writes: 0,
    },
  ])('settles the survey grant when $name', async ({ setup, overrides, result, reason, writes }) => {
    const world = buildWorld();
    setup?.(world);
    const fake = fakeGateway(world, ...(overrides?.(world) ?? []));
    const outcome = await run(fake, { families: familiesOf('surveys') });

    expect(caseOf(outcome, 'surveys:survey-grant:umbrella->a')).toMatchObject({ result, reason });
    expect(outcome.surveyGrantOnly).toBe(false);
    expect(outcome.crossTenantWrites).toBe(writes);
    expect(outcome.crossTenantReads).toBe(0);
  });

  it('creates the grant survey on the grantor site and targets only the granted site', async () => {
    const world = buildWorld();
    ungrantTarget(world);
    const fake = fakeGateway(world);
    const outcome = await run(fake, { families: familiesOf('surveys') });

    expect(caseOf(outcome, 'surveys:survey-grant:umbrella->a').result).toBe('pass');
    expect(outcome.surveyGrantOnly).toBe(true);
    const created = fake.calls.filter(
      (call) => call.method === 'POST' && call.url.pathname === `${API}/surveys/surveys`,
    );
    expect(created.map((call) => [call.caller?.site, routeSite(call), call.fields.title])).toStrictEqual([
      [SITE_A, SITE_A, `${DEFAULT_PROBE_SUFFIX} survey-grant`],
    ]);
    const bulk = fake.calls.filter((call) => call.url.pathname.endsWith('/targets/bulk'));
    const targets = bulk.map((call) => JSON.parse(call.fields.targets ?? 'null') as unknown);
    expect(targets).toStrictEqual([[{ siteID: SITE_B }]]);
  });

  it('reads every page of the grantor responses', async () => {
    const world = buildWorld();
    world.responsesPerPage = 1;
    addResponse(world, firstRow(world, 'surveys', SITE_A), SITE_B, 'earlier');
    const fake = fakeGateway(world);
    const outcome = await run(fake, { families: familiesOf('surveys') });

    expect(caseOf(outcome, 'surveys:survey-grant:umbrella->a').result).toBe('pass');
    expect(outcome.surveyGrantOnly).toBe(true);
    const pages = fake.calls
      .filter((call) => RESPONSES.test(call.url.pathname) && call.url.searchParams.has('pageIndex'))
      .map((call) => call.url.searchParams.get('pageIndex'));
    expect(pages).toStrictEqual(['1', '2']);
  });

  interface BlockedRow {
    name: string;
    families: FamilyId[];
    setup?: (world: World) => void;
    overrides?: (world: World) => Override[];
    expected: Record<string, string>;
  }

  it.each<BlockedRow>([
    {
      name: 'an actor cannot log in',
      families: ['timesheets'],
      setup: (world) => world.lockedOut.add(loginOf(SITE_A, 'timesheets.employee')),
      expected: {
        'timesheets:read-list:a->b': 'a timesheets login failed (status 200)',
        'timesheets:write-foreign-id:a->b': 'a timesheets login failed (status 200)',
        'timesheets:read-list:b->a': 'a timesheets actor login failed (status 200)',
        'timesheets:write-owner-site:b->a': 'a timesheets actor login failed (status 200)',
      },
    },
    {
      name: "an actor's own-site control list is empty",
      families: ['finance'],
      setup: (world) => {
        world.rows.finance = rowsOf(world, 'finance', SITE_A);
      },
      expected: {
        'finance:read-by-id:b->a': "control: b's own finance list answered 200 with 0 items",
        'finance:read-list:a->b': 'no finance records of b found through tenant-b',
        'finance:write-site-mismatch:a->b': 'no finance records of b found through tenant-b',
      },
    },
    {
      name: "an actor's own-site control list fails",
      families: ['user'],
      overrides: () => [
        (call) =>
          isGet(call, '/_api/json/v1/tenant-b/user', SITE_B) && !call.url.searchParams.has('isPublic')
            ? serverError()
            : undefined,
      ],
      expected: { 'user:read-list:b->a': "control: b's own user list answered 500 with 0 items" },
    },
    {
      name: 'no owner record offers a write target',
      families: ['finance'],
      setup: (world) => {
        for (const row of rowsOf(world, 'finance', SITE_B)) delete row.amount;
      },
      expected: {
        'finance:write-owner-site:a->b': "no finance write target among b's records",
        'finance:write-foreign-id:a->b': "no finance write target among b's records",
      },
    },
    {
      name: "the owner's re-read fails before the write",
      families: ['surveys'],
      overrides: failing(
        (call) =>
          RESPONSES.test(call.url.pathname) &&
          call.caller?.site === SITE_B &&
          call.url.searchParams.get('itemsPerPage') === '1000',
      ),
      expected: {
        'surveys:write-owner-site:a->b': "the owner's re-read answered 500 before the write",
        'surveys:write-site-mismatch:a->b': "the owner's re-read answered 500 before the write",
      },
    },
    {
      name: "the owner's re-read fails after the write",
      families: ['surveys'],
      overrides: () => {
        let reads = 0;
        return [
          (call) => {
            if (!RESPONSES.test(call.url.pathname) || call.method !== 'GET' || call.caller?.site !== SITE_B) {
              return undefined;
            }
            reads += 1;
            return reads % 2 === 0 ? serverError() : undefined;
          },
        ];
      },
      expected: {
        'surveys:write-owner-site:a->b': "the owner's re-read answered 500 after the write",
        'surveys:write-site-mismatch:a->b': "the owner's re-read answered 500 after the write",
      },
    },
    {
      name: 'a pooled-read actor cannot log in',
      families: ['user'],
      setup: (world) => world.lockedOut.add(loginOf(SITE_B, 'site-admin')),
      expected: { 'user:pooled-read:a->umbrella': 'b user login failed (status 200)' },
    },
    {
      name: 'a pooled list fails',
      families: ['user'],
      overrides: failing(
        (call) => isGet(call, '/_api/json/v1/tenant-b/user', SITE_B) && call.url.searchParams.get('isPublic') === '1',
      ),
      expected: { 'user:pooled-read:a->umbrella': 'answered 500' },
    },
  ])('leaves cases inconclusive when $name', async ({ families, setup, overrides, expected }) => {
    const world = buildWorld();
    setup?.(world);
    const outcome = await run(fakeGateway(world, ...(overrides?.(world) ?? [])), { families: familiesOf(...families) });

    const settled = Object.fromEntries(
      Object.keys(expected).map((id) => {
        const c = caseOf(outcome, id);
        return [id, `${c.result}: ${c.reason ?? ''}`];
      }),
    );
    const inconclusive = Object.entries(expected).map(([id, why]) => [id, `inconclusive: ${why}`]);
    expect(settled).toStrictEqual(Object.fromEntries(inconclusive));
    expect(idsWhere(outcome, 'violation')).toStrictEqual([]);
    expect(outcome).toMatchObject({ crossTenantReads: 0, crossTenantWrites: 0 });
  });

  it('never passes a probe the gateway answers with a server error', async () => {
    const world = buildWorld();
    world.refusal = serverError;
    const result = await run(fakeGateway(world));

    expect(idsWhere(result, 'pass')).toStrictEqual([
      'content:read-list:a->b',
      'content:read-list:a->umbrella',
      'content:read-list:b->a',
      'content:read-list:b->umbrella',
      'content:read-list:umbrella->a',
      'content:read-list:umbrella->b',
      'user:pooled-read:a->umbrella',
      'user:read-by-id:a->umbrella',
    ]);
    expect(notResult(result, 'pass').filter((line) => !line.includes(': inconclusive '))).toStrictEqual([]);
    const serverErrors = result.cases.filter((c) => (c.observed.status ?? 0) >= 500);
    expect(serverErrors.length).toBeGreaterThan(0);
    expect(serverErrors.filter((c) => c.result !== 'inconclusive')).toStrictEqual([]);
    expect(result).toMatchObject({ crossTenantReads: 0, crossTenantWrites: 0, surveyGrantOnly: false });
  });

  it('rejects with the HTTP error when the gateway cannot be reached mid-run', async () => {
    const unreachable: Override = (call) => {
      if (call.caller?.site === SITE_A && routeSite(call) === SITE_B) {
        const cause = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
        throw new TypeError('fetch failed', { cause });
      }
      return undefined;
    };
    const failure = run(fakeGateway(buildWorld(), unreachable), { families: familiesOf('content') });

    await expect(failure).rejects.toBeInstanceOf(HttpRequestError);
    await expect(failure).rejects.toThrow(/ECONNREFUSED.*\/_api\/json\/v1\/tenant-b\/content/);
  });
});
