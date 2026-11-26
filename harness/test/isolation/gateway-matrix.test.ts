import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adminUnavailableResponse, apiUnavailableResponse, type RouteKeyOptions } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, crossTenantPairs, type TenantFixture } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NEUTRAL_ID, defaultRouteKeyOptions } from '../../src/golden/coverage.js';
import { SEED_CONFIG_PATH, SEED_CREDENTIALS_FILE, originBaseUrl } from '../../src/golden/session.js';
import {
  ACTORS,
  DEFAULT_PROBE_SUFFIX,
  LEGACY_SERVED,
  MAX_OWNER_RECORDS,
  NOT_RUN,
  ROUTE_FAMILIES,
  TENANT_GRANT,
  TENANTS_BY_KEY,
  buildCases,
  isLegacyRefusal,
  runGatewayIsolation,
  versionRouting,
  type ActorRef,
  type CaseKind,
  type CaseResult,
  type FamilyId,
  type GatewayIsolationDeps,
  type GatewayIsolationResult,
  type IsolationCase,
  type ProbeRequest,
  type ProbeRoute,
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
const NOTES = '/opt2/stub/notes';
const ALL_KEYS: readonly TenantKey[] = ['a', 'b', 'umbrella'];
const CASE_RESULTS: readonly CaseResult[] = ['pass', 'violation', 'inconclusive', 'skipped'];

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
  [SITE_A]: { 'site-admin': 'a.siteadmin', 'system-user': 'a.system' },
  [SITE_B]: { 'site-admin': 'b.siteadmin', 'system-user': 'b.system' },
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

/** Records of the fake's sites, by family; every record names its site in `siteid`, which notes never answer with. */
interface World {
  rows: Record<FamilyId, Row[]>;
  comments: Map<string, Row[]>;
  /** `<noteid>:<grantee site>` of every stored note grant. */
  grants: Set<string>;
  lockedOut: Set<string>;
  /** Replaces every refusal and not-found answer. */
  refusal?: () => Response;
  /** Page size of note comment lists, else the requested `limit`. */
  commentsPerPage?: number;
  serial: number;
}

interface FakeGateway {
  fetch: FetchLike;
  calls: GatewayCall[];
}

type Op = 'list' | 'byId' | 'write' | 'grant' | 'comment' | 'comments';
type Shape = 'jsonapi' | 'stub';

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
  notes: 'noteid',
};
/** Public user pool of each site in the seeded registry. */
const PUBLIC_USER_POOL: Readonly<Record<string, string>> = { [SITE_A]: SITE_U, [SITE_B]: SITE_B, [SITE_U]: SITE_U };
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
const unavailable = (): Response => {
  const { status, headers, body } = apiUnavailableResponse();
  return new Response(body, { status, headers });
};

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

function listBody(t: Target, site: string, items: Row[]): unknown {
  return jsonApiList(site, t.family, items);
}

function recordBody(t: Target, site: string, row: Row): unknown {
  return envelope('findOne', row, { entityname: t.family, siteid: site });
}

function without<T>(row: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
}

/** A note as the stub answers it: without the site the fake keeps it under. */
function noteBody(note: Row): Row {
  return without(note, 'siteid');
}

function commentsOf(world: World, noteId: string): Row[] {
  const known = world.comments.get(noteId);
  if (known !== undefined) return known;
  const created: Row[] = [];
  world.comments.set(noteId, created);
  return created;
}

/** `/opt2/stub/notes[/<id>[/grants|/comments]]`. */
const NOTE_ROUTE = /^\/opt2\/stub\/notes(?:\/([^/]+)(?:\/(grants|comments))?)?$/;

/** The family route `call` addresses, or undefined. */
function targetOf(call: GatewayCall): Target | undefined {
  const api = /^\/_api\/json\/v1\/([^/]+)\/(content|user)(?:\/([^/]+))?$/.exec(call.url.pathname);
  if (api !== null) {
    const [, site = '', family, id] = api;
    const op: Op = call.method === 'POST' ? 'write' : id === undefined ? 'list' : 'byId';
    return { family: family as FamilyId, op, shape: 'jsonapi', site, id };
  }
  const note = NOTE_ROUTE.exec(call.url.pathname);
  if (note === null) return undefined;
  const [, id, action] = note;
  const post = call.method === 'POST';
  let op: Op = post ? 'write' : 'list';
  if (action === 'grants') op = 'grant';
  else if (action === 'comments') op = post ? 'comment' : 'comments';
  else if (id !== undefined) op = 'byId';
  return { family: 'notes', op, shape: 'stub', site: call.url.searchParams.get('siteid') ?? '', id };
}

/** Answers a family route as an isolating gateway does: own-site rows only, everything else refused. */
function resource(world: World, call: GatewayCall, t: Target): Response {
  if (t.shape === 'stub') return stub(world, call, t);
  // A body `siteid` overrides the route's, as Masa merges form over URL params.
  const site = t.op === 'write' ? (call.fields.siteid ?? t.site) : t.site;
  const refuse = (): Response => world.refusal?.() ?? raw(UNAUTHORIZED, 401);
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
      const items = rows.filter((row) => (pooled ? row.ispublic === 1 && visible(row) : row.siteid === site));
      return json(listBody(t, site, items));
    }
    case 'byId': {
      const row = rows.find((candidate) => candidate[key] === t.id && visible(candidate));
      return row === undefined ? missing() : json(recordBody(t, site, row));
    }
    default: {
      const row = rows.find((candidate) => candidate[key] === t.id && candidate.siteid === site);
      if (row === undefined) return missing();
      Object.assign(row, fields);
      return json(recordBody(t, site, row));
    }
  }
}

/**
 * Answers a stub note route as the stub does: the tenant is the caller's, any `siteid` naming another site is refused,
 * another tenant's note is not found, and a comment is stored only by its grantor's site or a site it granted.
 */
function stub(world: World, call: GatewayCall, t: Target): Response {
  const refuse = (): Response => world.refusal?.() ?? forbidden();
  const missing = (): Response => world.refusal?.() ?? notFound();
  const site = call.caller?.site;
  const supplied = [call.url.searchParams.get('siteid'), call.fields.siteid ?? null];
  if (site === undefined || supplied.some((value) => value !== null && value !== site)) return refuse();
  const notes = world.rows.notes;
  const own = notes.find((row) => row.noteid === t.id && row.siteid === site);
  switch (t.op) {
    case 'list':
      return json(envelope('findMany', { items: notes.filter((row) => row.siteid === site).map(noteBody), next: null }));
    case 'byId':
      return own === undefined ? missing() : json(envelope('findOne', noteBody(own)));
    case 'write': {
      world.serial += 1;
      const created = note(site, 9, world.serial, call.fields.title ?? '');
      notes.push(created);
      return json(envelope('save', noteBody(created)));
    }
    case 'grant': {
      if (own === undefined) return missing();
      world.grants.add(`${String(own.noteid)}:${call.fields.granteesiteid ?? ''}`);
      return json(envelope('save', { noteid: own.noteid, granteesiteid: call.fields.granteesiteid }));
    }
    case 'comment': {
      const grantor = call.fields.grantorsiteid ?? '';
      const target = notes.find((row) => row.noteid === t.id && row.siteid === grantor);
      if (target === undefined || (grantor !== site && !world.grants.has(`${String(target.noteid)}:${site}`))) {
        return missing();
      }
      return json(envelope('save', addComment(world, target, site, call.fields.body ?? '')));
    }
    case 'comments': {
      if (own === undefined) return missing();
      const all = commentsOf(world, String(own.noteid));
      const size = world.commentsPerPage ?? Number(call.url.searchParams.get('limit') ?? 50);
      const from = Number(call.url.searchParams.get('after') ?? 0);
      const end = from + size;
      return json(envelope('findMany', { items: all.slice(from, end), next: end < all.length ? String(end) : null }));
    }
  }
}

function addComment(world: World, target: Row, authorSite: string, body: string): Row {
  world.serial += 1;
  const comment: Row = { commentid: cfId(62, 0, world.serial), noteid: target.noteid, authorsiteid: authorSite, body };
  commentsOf(world, String(target.noteid)).push(comment);
  return comment;
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
    return sid === undefined ? undefined : sessions.get(sid);
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

function note(site: string, s: number, n: number, title = `Note ${site} ${String(n)}`): Row {
  return {
    noteid: cfId(60, s, n),
    siteid: site,
    title,
    body: '',
    created: `2026-06-30 1${String(s)}:00:00.00${String(n % 10)}`,
    rowversion: 1,
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
        { ...person(SITE_B, 1, 3, 'pat-staff', 0), userid: RESERVED_PERSON },
        person(SITE_U, 2, 1, 'uma-member', 1),
        person(SITE_U, 2, 2, 'uri-member', 1),
      ],
      notes: [note(SITE_A, 0, 1)],
    },
    comments: new Map(),
    grants: new Set(),
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

/** Whether `call` is `by`'s read of its own site's note list. */
function isOwnNoteList(call: GatewayCall, by: string): boolean {
  return isGet(call, NOTES, by) && routeSite(call) === by;
}

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

function familiesOf(...ids: FamilyId[]): RouteFamily[] {
  return ROUTE_FAMILIES.filter((family) => ids.includes(family.id));
}

/** Runs the matrix over `fake` and checks what every run keeps: the built case list and gateway-only requests. */
async function run(fake: FakeGateway, deps: GatewayIsolationDeps = {}): Promise<GatewayIsolationResult> {
  const full: GatewayIsolationDeps = { env, fetch: fake.fetch, ...deps };
  const result = await runGatewayIsolation(full);
  const built = buildCases(full.families ?? ROUTE_FAMILIES);
  expect(result.cases.map((c) => c.id)).toStrictEqual(built.map((c) => c.id));
  expect(result.cases.filter((c) => !CASE_RESULTS.includes(c.result))).toStrictEqual([]);
  expect(disciplineProblems(fake.calls, full.baseUrl ?? originBaseUrl('gateway', env))).toStrictEqual([]);
  return result;
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

describe('TENANTS_BY_KEY and ACTORS', () => {
  it('maps the tenant keys to the seeded sites tenant-a, tenant-b and umbrella', () => {
    expect(Object.fromEntries(Object.entries(TENANTS_BY_KEY).map(([key, fixture]) => [key, fixture.siteId]))).toEqual({
      a: 'tenant-a',
      b: 'tenant-b',
      umbrella: 'umbrella',
    });
  });

  /** Every actor reference with its tenant, the ungranted commenter last. */
  function actorRefs(): [TenantKey, ActorRef][] {
    const refs = Object.values(ACTORS).flatMap((byTenant) =>
      ALL_KEYS.flatMap((key): [TenantKey, ActorRef][] => {
        const ref = byTenant[key];
        return ref === undefined ? [] : [[key, ref]];
      }),
    );
    return [...refs, [TENANT_GRANT.ungranted, TENANT_GRANT.ungrantedCommenter]];
  }

  it("names every actor's username and password by its own site's seed credentials", () => {
    expect(actorRefs()).toHaveLength(8);
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

  it('builds every pair probe of each family, one pooled-read and one tenant-grant case, sorted and unique', () => {
    const cases = buildCases(ROUTE_FAMILIES);
    const expected = ROUTE_FAMILIES.flatMap((family) => {
      const owners = family.owners ?? ALL_KEYS;
      const kinds = family.idAddressedWrite ? [...PAIR_KINDS, 'write-foreign-id'] : [...PAIR_KINDS];
      return crossTenantPairs().flatMap(({ reader, writer }) => {
        const [actor, owner] = [keyOf(reader), keyOf(writer)];
        if (ACTORS[family.id][actor] === undefined || !owners.includes(owner)) return [];
        return kinds.map((kind) => `${family.id}:${kind}:${actor}->${owner}`);
      });
    });
    const grant = `notes:tenant-grant:${TENANT_GRANT.ungranted}->${TENANT_GRANT.grantor}`;
    const ids = cases.map((c) => c.id);
    expect(ids).toStrictEqual([...expected, 'user:pooled-read:a->umbrella', grant].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(cases).toHaveLength(50);
  });

  it('names its family, acting tenant and a different owning tenant in every case', () => {
    for (const c of buildCases(ROUTE_FAMILIES)) {
      expect(c.id).toBe(`${c.family}:${c.kind}:${c.actor}->${c.owner}`);
      expect(c.actor).not.toBe(c.owner);
    }
  });

  it('starts every case inconclusive and not run, GET for reads and POST for writes', () => {
    const cases = buildCases(ROUTE_FAMILIES);
    for (const c of cases) {
      expect(c).toMatchObject({ result: 'inconclusive', reason: NOT_RUN, observed: {} });
      expect(c.method).toBe(/^(?:read-|pooled-read)/.test(c.kind) ? 'GET' : 'POST');
    }
  });

  it.each([
    ['notes:read-list:a->b', `${NOTES}?siteid=tenant-b&limit=1000`, 'no-owner-rows'],
    ['content:read-by-id:b->a', '/_api/json/v1/tenant-b/content/{id}', 'no-owner-record'],
    ['user:write-owner-site:a->umbrella', '/_api/json/v1/umbrella/user/{id}', 'refused-no-effect'],
    ['user:write-site-mismatch:b->a', '/_api/json/v1/tenant-b/user/{id}', 'refused-no-effect'],
    ['content:write-owner-site:umbrella->b', '/_api/json/v1/tenant-b/content/{id}', 'refused-no-effect'],
    ['notes:write-site-mismatch:b->a', `${NOTES}?siteid=tenant-b`, 'refused-no-effect'],
    ['user:pooled-read:a->umbrella', '/_api/json/v1/tenant-a/user?itemsPerPage=50&isPublic=1', 'registry-pools-only'],
    ['notes:tenant-grant:umbrella->a', `${NOTES}/{id}/comments?siteid=umbrella`, 'granted-sites-only'],
  ])('addresses %s at %s, expecting %s', (id, route, expected) => {
    const found = buildCases(ROUTE_FAMILIES).find((c) => c.id === id);
    expect(found).toMatchObject({ route, expected });
  });

  it('probes only the pairs it is given', () => {
    const cases = buildCases(familiesOf('content', 'user'), { pairs: [{ writer: TENANT_B, reader: TENANT_A }] });
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
    const first = buildCases(ROUTE_FAMILIES);
    const firstCopy = structuredClone(first);
    for (const c of first) {
      c.result = 'violation';
      c.observed.leakedIds = 9;
    }
    expect(buildCases(ROUTE_FAMILIES)).toStrictEqual(firstCopy);
    expect(JSON.stringify(ROUTE_FAMILIES)).toBe(before);
    expect(Object.isFrozen(ROUTE_FAMILIES)).toBe(true);
  });

  it('addresses tenants only through the site of each route', () => {
    for (const c of buildCases(ROUTE_FAMILIES)) {
      const url = new URL(c.route, GATEWAY);
      expect([...url.searchParams.keys()].filter((name) => /tenant/i.test(name))).toStrictEqual([]);
      expect(TENANT_IDS.filter((tenantId) => c.route.toLowerCase().includes(tenantId))).toStrictEqual([]);
      expect(c.route).not.toMatch(/x-opt2|serverless/i);
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

  const rows: [string, { status: number; text: string }, boolean][] = [
    ['a 401 insufficient-permissions envelope', { status: 401, text: UNAUTHORIZED }, true],
    ['a 401 invalid-token envelope', { status: 401, text: INVALID_TOKEN }, true],
    ['a 403 error envelope', withError(403, notFoundError), true],
    ['a 404 envelope with object params', withError(404, notFoundError, { params: { siteid: SITE_A } }), true],
    ['a 403 envelope carrying save errors', saveErrors(403, { title: 'required' }), true],
    ['a 403 envelope with empty save errors', saveErrors(403, {}), false],
    ['a 404 envelope carrying save errors only', saveErrors(404, { title: 'required' }), false],
    ['a 401 envelope without an error', body(401, envelope('findOne', {})), false],
    ['a 400 bad request', { status: 400, text: BAD_REQUEST }, false],
    ['a 400 CSRF refusal', { status: 400, text: INVALID_CSRF }, false],
    ['a 401 carrying the CSRF message', withError(401, { code: 'invalid_request', message: CSRF_MESSAGE }), false],
    ['a 500 server error', { status: 500, text: SERVER_ERROR }, false],
    ['a 503 legacy unavailable envelope', { status: 503, text: apiUnavailableResponse().body }, false],
    ['a 503 legacy unavailable page', { status: 503, text: adminUnavailableResponse().body }, false],
    ['a 401 plain-text body', { status: 401, text: 'Unauthorized' }, false],
    ['a 200 success envelope', { status: 200, text: JSON.stringify(SUCCESS) }, false],
    ['a 302 without a body', { status: 302, text: '' }, false],
    ['a 403 HTML page', { status: 403, text: '<html><body>Forbidden</body></html>' }, false],
    ['a 403 envelope of api v2', body(403, { apiversion: 'v2', method: 'save', error: notFoundError }), false],
    ['a 403 envelope without a method', body(403, { apiversion: 'v1', error: notFoundError }), false],
    ['a 403 envelope whose params is a list', withError(403, notFoundError, { params: [] }), false],
    ['a 403 error without a message', withError(403, { code: 'invalid_request' }), false],
    ['a 403 JSON list', body(403, [notFoundError]), false],
  ];

  it.each(rows.map(([name, result, refusal]) => ({ name, result, refusal })))(
    'treats $name as a legacy refusal: $refusal',
    ({ result, refusal }) => {
      expect(isLegacyRefusal(result)).toBe(refusal);
    },
  );
});

const VERSION = 'v9001';
const WRITE_CASE = /^write-/;
/** Route keys the content and user families' probes resolve to, by case kind. */
const FAMILY_KEYS: Readonly<Record<'content' | 'user', Readonly<Partial<Record<CaseKind, string>>>>> = {
  content: {
    'read-list': 'api:content.findquery',
    'read-by-id': 'api:content.findone',
    'write-owner-site': 'api:content.save',
    'write-site-mismatch': 'api:content.save',
  },
  user: {
    'read-list': 'api:user.findquery',
    'pooled-read': 'api:user.findquery',
    'read-by-id': 'api:user.findone',
    'write-owner-site': 'api:user.save',
    'write-site-mismatch': 'api:user.save',
  },
};

/** Routing of a version holding every content and user family key and `extra`, `legacy` ones legacy, others target. */
function routingWith(legacy: readonly string[], extra: readonly string[] = [], opts?: RouteKeyOptions) {
  const keys = new Set([...Object.values(FAMILY_KEYS).flatMap((byKind) => Object.values(byKind)), ...extra]);
  const entries = [...keys].map((route) => ({ route, state: legacy.includes(route) ? ('legacy' as const) : ('target' as const) }));
  return versionRouting({ tableVersion: VERSION, entries }, opts);
}

describe('versionRouting', () => {
  const ARCHIVE = `${API}/people/persons/${NEUTRAL_ID}/archive`;
  const routing = versionRouting({
    tableVersion: VERSION,
    entries: [
      { route: 'api:user.findone', state: 'legacy' },
      { route: 'fixture:people/persons/{id}/archive@post', state: 'target' },
      { route: 'rest:content.save', state: 'target' },
      { route: 'rest:content.save{approved=1}', state: 'legacy' },
    ],
  });

  it.each<[string, ProbeRequest, ProbeRoute]>([
    [
      'a JSON API by-id read on its legacy entry',
      { method: 'GET', route: `/_api/json/v1/tenant-a/user/${NEUTRAL_ID}` },
      { routeKey: 'api:user.findone', entry: 'api:user.findone', state: 'legacy' },
    ],
    [
      'a fixture write on its target entry',
      { method: 'POST', route: `${ARCHIVE}?siteid=tenant-a`, form: { effectivefrom: '2026-06-30' } },
      { routeKey: 'fixture:people/persons/{id}/archive@post', entry: 'fixture:people/persons/{id}/archive@post', state: 'target' },
    ],
    [
      'a fixture write whose JSON body holds a NUL, under its halt variant',
      { method: 'POST', route: `${ARCHIVE}?siteid=tenant-a`, body: { effectivefrom: 'a\u0000b' } },
      { routeKey: 'fixture:people/persons/{id}/archive@post{text=nul}', state: 'legacy' },
    ],
    [
      'a REST save on its target entry',
      { method: 'POST', route: `/_api/rest/v1/tenant-a/content/${NEUTRAL_ID}`, form: { title: 'x' } },
      { routeKey: 'rest:content.save', entry: 'rest:content.save', state: 'target' },
    ],
    [
      'a REST save whose body keys a committed legacy variant',
      { method: 'POST', route: `/_api/rest/v1/tenant-a/content/${NEUTRAL_ID}`, form: { title: 'x', approved: '1' } },
      { routeKey: 'rest:content.save{approved=1}', entry: 'rest:content.save{approved=1}', state: 'legacy' },
    ],
    [
      'a path no entry matches',
      { method: 'GET', route: `${NOTES}?siteid=tenant-a&limit=1000` },
      { routeKey: 'opt2:/opt2/stub/notes', state: 'legacy' },
    ],
  ])('routes %s', (_name, probe, expected) => {
    expect(routing.route(probe)).toStrictEqual(expected);
    expect(routing.tableVersion).toBe(VERSION);
  });
});

describe('runGatewayIsolation', () => {
  it('passes every case when the gateway refuses every cross-tenant probe', async () => {
    const world = buildWorld();
    const fake = fakeGateway(world);
    const result = await run(fake);

    expect(notResult(result, 'pass')).toStrictEqual([]);
    expect(result).toMatchObject({ crossTenantReads: 0, crossTenantWrites: 0, grantOnly: true });

    const reserved = [
      world.rows.user.find((row) => row.username === RESERVED_USERNAME)?.userid,
      world.rows.user.find((row) => row.userid === RESERVED_PERSON)?.userid,
    ].map(String);
    expect(reserved).not.toContain('undefined');
    expect(fake.calls.filter((call) => reserved.some((id) => call.url.pathname.includes(id)))).toStrictEqual([]);

    const writes = fake.calls.filter((call) => call.method === 'POST' && targetOf(call)?.op === 'write');
    expect(writes.length).toBeGreaterThan(0);
    const marked = (call: GatewayCall): boolean =>
      Object.values(call.fields).some((value) => value.includes(DEFAULT_PROBE_SUFFIX));
    expect(writes.every(marked)).toBe(true);
    const noteWrites = writes.filter((call) => targetOf(call)?.family === 'notes');
    const header = (call: GatewayCall, pattern: RegExp): boolean =>
      Object.keys(call.headers).some((key) => pattern.test(key));
    expect(noteWrites.filter((call) => header(call, /csrf|^authorization$/i))).toStrictEqual([]);
    const seeds = noteWrites.filter((call) => call.fields.title === `${DEFAULT_PROBE_SUFFIX} owner record`);
    expect(seeds.map((call) => [call.caller?.site, routeSite(call)])).toStrictEqual([
      [SITE_A, SITE_A],
      [SITE_B, SITE_B],
    ]);
  });

  it.each<[Shape, (call: GatewayCall) => string | undefined]>([
    ['jsonapi', lastSegment],
  ])('sends each %s write in its session with the CSRF pair issued for the id it writes', async (shape, idOf) => {
    const fake = fakeGateway(buildWorld());
    await run(fake);

    const header = (call: GatewayCall, name: string): string | undefined =>
      Object.entries(call.headers).find(([key]) => key.toLowerCase() === name)?.[1];
    const writes = fake.calls.filter((call) => targetOf(call)?.op === 'write' && targetOf(call)?.shape === shape);
    expect(writes.length).toBeGreaterThan(0);
    expect(
      writes.filter((call) => header(call, 'x-csrf_token') !== TOKENS.csrf_token || header(call, 'x-csrf_token_expires') !== TOKENS.csrf_token_expires),
    ).toStrictEqual([]);
    expect(writes.filter((call) => call.caller === undefined || header(call, 'authorization') !== undefined)).toStrictEqual([]);
    const contexts = new Set(
      fake.calls.filter((call) => call.url.pathname.endsWith('/generateCSRFTokens')).map((call) => call.url.searchParams.get('context')),
    );
    expect(writes.filter((call) => !contexts.has(idOf(call) ?? null))).toStrictEqual([]);
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
      name: 'a bad request',
      family: 'content',
      answer: () => raw(BAD_REQUEST, 400),
      result: 'inconclusive',
      reason: 'answered 400, neither accepted nor a legacy refusal',
      observed: { status: 400, effect: false },
      writes: 0,
    },
    {
      name: 'a note create refused yet stored in the owner tenant',
      family: 'notes',
      answer: (world, call) => {
        world.rows.notes.push(note(SITE_B, 8, 1, call.fields.title));
        return forbidden();
      },
      result: 'violation',
      reason: "the owner's record changed",
      observed: { status: 403, errorCode: 'invalid_request', effect: true },
      writes: 1,
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

  const COMMENTS = /^\/opt2\/stub\/notes\/([^/]+)\/comments$/;
  const commentedBy =
    (site: string, answer: (world: World, call: GatewayCall) => Response) =>
    (world: World): Override[] => [
      (call) =>
        call.method === 'POST' &&
        COMMENTS.test(call.url.pathname) &&
        call.caller?.site === site &&
        routeSite(call) === site
          ? answer(world, call)
          : undefined,
    ];
  const storeComment = (world: World, call: GatewayCall): void => {
    const id = COMMENTS.exec(call.url.pathname)?.[1];
    const target = world.rows.notes.find((row) => row.noteid === id);
    if (target !== undefined) addComment(world, target, SITE_U, call.fields.body ?? '');
  };
  const failing = (match: (call: GatewayCall) => boolean) => (): Override[] => [
    (call) => (match(call) ? serverError() : undefined),
  ];
  const isGrantCreate = (call: GatewayCall): boolean =>
    call.method === 'POST' && call.url.pathname === NOTES && call.fields.title === `${DEFAULT_PROBE_SUFFIX} tenant-grant`;

  it.each<GrantRow>([
    {
      name: 'the ungranted comment is accepted',
      overrides: commentedBy(SITE_U, (world, call) => {
        storeComment(world, call);
        return json(envelope('save', {}));
      }),
      result: 'violation',
      reason: 'the umbrella comment was accepted',
      writes: 1,
    },
    {
      name: 'the ungranted comment is refused yet stored',
      overrides: commentedBy(SITE_U, (world, call) => {
        storeComment(world, call);
        return forbidden();
      }),
      result: 'violation',
      reason: 'the umbrella comment was accepted',
      writes: 1,
    },
    {
      name: 'the granted comment is refused',
      overrides: commentedBy(SITE_B, () => forbidden()),
      result: 'violation',
      reason: 'no tenant-b comment is listed (status 403)',
      writes: 0,
    },
    {
      name: 'the granted comment fails',
      overrides: commentedBy(SITE_B, serverError),
      result: 'inconclusive',
      reason: 'the granted comment answered 500',
      writes: 0,
    },
    {
      name: 'the ungranted comment fails',
      overrides: commentedBy(SITE_U, serverError),
      result: 'inconclusive',
      reason: 'the ungranted comment answered 500',
      writes: 0,
    },
    {
      name: 'the ungranted comment is neither accepted nor refused',
      overrides: commentedBy(SITE_U, conflict),
      result: 'inconclusive',
      reason: 'the ungranted comment answered 409, not a legacy refusal',
      writes: 0,
    },
    {
      name: 'the grant note create fails',
      overrides: failing(isGrantCreate),
      result: 'inconclusive',
      reason: 'the grant note create answered 500',
      writes: 0,
    },
    {
      name: 'the grant fails',
      overrides: failing((call) => call.url.pathname.endsWith('/grants')),
      result: 'inconclusive',
      reason: 'the grant to tenant-b answered 500',
      writes: 0,
    },
    {
      name: "the grantor's comment list fails",
      overrides: failing((call) => call.method === 'GET' && COMMENTS.test(call.url.pathname)),
      result: 'inconclusive',
      reason: "the grantor's comment list answered 500",
      writes: 0,
    },
    {
      name: 'the ungranted commenter cannot log in',
      setup: (world) => world.lockedOut.add(loginOf(SITE_U, 'member')),
      result: 'inconclusive',
      reason: 'umbrella note commenter login failed (status 200)',
      writes: 0,
    },
  ])('settles the tenant grant when $name', async ({ setup, overrides, result, reason, writes }) => {
    const world = buildWorld();
    setup?.(world);
    const fake = fakeGateway(world, ...(overrides?.(world) ?? []));
    const outcome = await run(fake, { families: familiesOf('notes') });

    expect(caseOf(outcome, 'notes:tenant-grant:umbrella->a')).toMatchObject({ result, reason });
    expect(outcome.grantOnly).toBe(false);
    expect(outcome.crossTenantWrites).toBe(writes);
    expect(outcome.crossTenantReads).toBe(0);
  });

  it('creates the grant note on the grantor site and grants only the granted site', async () => {
    const world = buildWorld();
    const fake = fakeGateway(world);
    const outcome = await run(fake, { families: familiesOf('notes') });

    expect(caseOf(outcome, 'notes:tenant-grant:umbrella->a').result).toBe('pass');
    expect(outcome.grantOnly).toBe(true);
    const created = fake.calls.filter(isGrantCreate);
    expect(created.map((call) => [call.caller?.site, routeSite(call)])).toStrictEqual([[SITE_A, SITE_A]]);
    const grants = fake.calls.filter((call) => call.url.pathname.endsWith('/grants'));
    expect(grants.map((call) => [call.caller?.site, routeSite(call), call.fields.granteesiteid])).toStrictEqual([
      [SITE_A, SITE_A, SITE_B],
    ]);
    const comments = fake.calls.filter((call) => call.method === 'POST' && COMMENTS.test(call.url.pathname));
    expect(comments.map((call) => [call.caller?.site, routeSite(call), call.fields.grantorsiteid])).toStrictEqual([
      [SITE_B, SITE_B, SITE_A],
      [SITE_U, SITE_U, SITE_A],
    ]);
  });

  it('reads every page of the grantor comments', async () => {
    const world = buildWorld();
    world.commentsPerPage = 1;
    const fake = fakeGateway(world, (call) => {
      if (!isGrantCreate(call)) return undefined;
      world.serial += 1;
      const created = note(SITE_A, 7, world.serial, call.fields.title);
      world.rows.notes.push(created);
      addComment(world, created, SITE_A, 'earlier');
      return json(envelope('save', noteBody(created)));
    });
    const outcome = await run(fake, { families: familiesOf('notes') });

    expect(caseOf(outcome, 'notes:tenant-grant:umbrella->a').result).toBe('pass');
    expect(outcome.grantOnly).toBe(true);
    const pages = fake.calls
      .filter((call) => call.method === 'GET' && COMMENTS.test(call.url.pathname))
      .map((call) => call.url.searchParams.get('after'));
    expect(pages).toStrictEqual([null, '1']);
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
      families: ['notes'],
      setup: (world) => world.lockedOut.add(loginOf(SITE_A, 'system-user')),
      expected: {
        'notes:read-list:a->b': 'a notes login failed (status 200)',
        'notes:write-owner-site:a->b': 'a notes login failed (status 200)',
        'notes:read-list:b->a': 'a notes actor login failed (status 200)',
        'notes:write-owner-site:b->a': 'a notes actor login failed (status 200)',
      },
    },
    {
      name: "an actor's own-site control list is empty",
      families: ['notes'],
      overrides: () => [
        (call) => (isOwnNoteList(call, SITE_B) ? json(envelope('findMany', { items: [], next: null })) : undefined),
      ],
      expected: {
        'notes:read-by-id:b->a': "control: b's own notes list answered 200 with 0 items",
        'notes:read-list:a->b': 'no notes records of b found through tenant-b',
        'notes:write-site-mismatch:a->b': 'no notes records of b found through tenant-b',
      },
    },
    {
      name: "an owner's seed create is refused",
      families: ['notes'],
      overrides: () => [
        (call) => (call.method === 'POST' && call.url.pathname === NOTES && call.caller?.site === SITE_B ? forbidden() : undefined),
      ],
      expected: {
        'notes:read-by-id:b->a': "control: b's own notes list answered 200 with 0 items",
        'notes:read-list:a->b': 'no notes records of b found through tenant-b (seed create answered 403)',
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
      name: "the owner's re-read fails before the write",
      families: ['notes'],
      overrides: () => {
        let reads = 0;
        // The first read of b's list is its own-site control; every later one is an owner re-read.
        return [
          (call) => {
            if (!isOwnNoteList(call, SITE_B)) return undefined;
            reads += 1;
            return reads > 1 ? serverError() : undefined;
          },
        ];
      },
      expected: {
        'notes:write-owner-site:a->b': "the owner's re-read answered 500 before the write",
        'notes:write-site-mismatch:a->b': "the owner's re-read answered 500 before the write",
      },
    },
    {
      name: "the owner's re-read fails after the write",
      families: ['notes'],
      overrides: () => {
        let reads = 0;
        // After the own-site control, b's list is read before and after each write in turn.
        return [
          (call) => {
            if (!isOwnNoteList(call, SITE_B)) return undefined;
            reads += 1;
            return reads > 1 && reads % 2 === 1 ? serverError() : undefined;
          },
        ];
      },
      expected: {
        'notes:write-owner-site:a->b': "the owner's re-read answered 500 after the write",
        'notes:write-site-mismatch:a->b': "the owner's re-read answered 500 after the write",
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

  it.each([
    ['a 500 server error', serverError],
    ['a 503 legacy unavailable envelope', unavailable],
  ])('never passes a probe the gateway answers with %s', async (_name, answer) => {
    const world = buildWorld();
    world.refusal = answer;
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
    expect(result).toMatchObject({ crossTenantReads: 0, crossTenantWrites: 0, grantOnly: false });
  });

  it('rejects with the HTTP error when the gateway cannot be reached mid-run', async () => {
    const unreachable: Override = (call) => {
      if (call.caller?.site === SITE_A && routeSite(call) === SITE_B) {
        const cause = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
        throw new TypeError('fetch failed', { cause });
      }
      return undefined;
    };
    const fake = fakeGateway(buildWorld(), unreachable);
    const failure = run(fake, { families: familiesOf('content') });

    await expect(failure).rejects.toBeInstanceOf(HttpRequestError);
    await expect(failure).rejects.toThrow(/ECONNREFUSED.*\/_api\/json\/v1\/tenant-b\/content/);
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(disciplineProblems(fake.calls, GATEWAY)).toStrictEqual([]);
  });

  /** Answers every user by-id read with the record, whatever site the caller or the path names. */
  function leakingUserReads(world: World): Override {
    return (call) => {
      const t = targetOf(call);
      if (t?.family !== 'user' || t.op !== 'byId') return undefined;
      const row = world.rows.user.find((candidate) => candidate.userid === t.id);
      return row === undefined ? undefined : json(recordBody(t, t.site, row));
    };
  }

  it('skips every case of a legacy-served family unsent and uncounted, and still probes the target-served one', async () => {
    const leakyWorld = buildWorld();
    const leaked = await run(fakeGateway(leakyWorld, leakingUserReads(leakyWorld)), { families: familiesOf('content', 'user') });
    expect(leaked.crossTenantReads).toBeGreaterThan(0);

    const world = buildWorld();
    const fake = fakeGateway(world, leakingUserReads(world));
    const routing = routingWith(Object.values(FAMILY_KEYS.user));
    const result = await run(fake, { families: familiesOf('content', 'user'), routing });

    const user = result.cases.filter((c) => c.family === 'user');
    expect(user.length).toBeGreaterThan(0);
    expect(user.filter((c) => FAMILY_KEYS.user[c.kind] === undefined)).toStrictEqual([]);
    expect(user.map((c) => [c.id, c.result, c.reason, c.observed])).toStrictEqual(
      user.map((c) => [c.id, 'skipped', `${LEGACY_SERVED} ${FAMILY_KEYS.user[c.kind] ?? ''} in ${VERSION}`, {}]),
    );
    expect(fake.calls.filter((call) => targetOf(call)?.family === 'user')).toStrictEqual([]);
    expect(fake.calls.some((call) => targetOf(call)?.family === 'content')).toBe(true);
    expect(notResult(result, 'pass').filter((line) => !line.startsWith('user:'))).toStrictEqual([]);
    expect(result).toMatchObject({ crossTenantReads: 0, crossTenantWrites: 0 });
  });

  it('sends nothing, not even a login, when every case is legacy-served', async () => {
    const fake = fakeGateway(buildWorld());
    const result = await run(fake, { families: familiesOf('content'), routing: routingWith(Object.values(FAMILY_KEYS.content)) });

    expect(fake.calls).toStrictEqual([]);
    expect(result.cases.length).toBeGreaterThan(0);
    expect(result.cases.filter((c) => c.result !== 'skipped' || !c.reason?.startsWith(`${LEGACY_SERVED} `))).toStrictEqual([]);
    expect(result).toMatchObject({ crossTenantReads: 0, crossTenantWrites: 0, grantOnly: false });
  });

  it('routes each write again with the fields it sends, skipping one whose body keys a legacy variant', async () => {
    const opts: RouteKeyOptions = {
      ...defaultRouteKeyOptions(),
      variants: [{ route: 'api:content.save', variant: 'probe', when: [{ param: 'title', nonEmpty: true }] }],
    };
    const fake = fakeGateway(buildWorld());
    const routing = routingWith(['api:content.save{probe}'], ['api:content.save{probe}'], opts);
    const result = await run(fake, { families: familiesOf('content'), routing });

    const writes = result.cases.filter((c) => WRITE_CASE.test(c.kind));
    expect(writes.length).toBeGreaterThan(0);
    for (const c of writes) {
      expect(c).toMatchObject({ result: 'skipped', reason: `${LEGACY_SERVED} api:content.save{probe} in ${VERSION}`, observed: {} });
    }
    expect(fake.calls.filter((call) => targetOf(call)?.op === 'write')).toStrictEqual([]);
    expect(notResult(result, 'pass').filter((line) => !WRITE_CASE.test(line.split(':')[1] ?? ''))).toStrictEqual([]);
  });
});
