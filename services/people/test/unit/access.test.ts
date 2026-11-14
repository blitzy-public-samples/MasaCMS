/** The cUsers and cEditProfile gates of people: roles, `before()` defaults and scrubbing, and `secure()` denials, directly and through the app. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AuthDenial, Roles, moduleRole, renderAuthDenial, type UserClaims } from '@opt2/platform/auth';
import {
  ADMIN_LOGIN_REDIRECT_ACTION as COMPAT_LOGIN_REDIRECT_ACTION,
  ADMIN_NOACCESS_ACTION as COMPAT_NOACCESS_ACTION,
} from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import {
  ADMIN_LOGIN_REDIRECT_ACTION,
  ADMIN_NOACCESS_ACTION,
  AdminDenial,
  CUSERS_ROUTE_REQUIRES,
  PROFILE_ROUTE_REQUIRES,
  cusersAccess,
  isAdminViewer,
  isSuperViewer,
  normaliseCusersParams,
  normaliseProfileParams,
  requireCusersAccess,
  requireLoggedIn,
  sendAdminDenial,
  viewerScopeFor,
} from '../../src/routes/access.js';
import { buildTestApp, headersFor, userHeaders, type TestApp } from '../helpers/app.js';
import {
  ADMIN_S2,
  EDITOR,
  MEMBER_POOLED,
  MODULE_008_ONLY,
  MODULE_USER_A,
  OTHER_TENANT,
  SITE_ADMIN_A,
  SYSTEM_USER_A,
  type TestActor,
} from '../helpers/fixtures.js';

interface ContractOperation {
  operationId?: string;
  'x-opt2-requires'?: string[];
}

const CONTRACT = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};

/** Method, path and declaration of the contract operation `operationId`. */
function operation(operationId: string): { method: 'GET' | 'POST'; path: string; declared: ContractOperation } {
  for (const [path, methods] of Object.entries(CONTRACT.paths)) {
    for (const [method, declared] of Object.entries(methods)) {
      if (declared.operationId === operationId) return { method: method.toUpperCase() as 'GET' | 'POST', path, declared };
    }
  }
  throw new Error(`The contract declares no operation ${operationId}`);
}

const SITE_MANAGER_MODULE = moduleRole('00000000000000000000000000000000000');

/** Verified claims of `actor`'s user token. */
function claimsOf(actor: TestActor): UserClaims {
  return {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: actor.sub,
    sid: 'S-1',
    tid: '00000000-0000-0000-0000-000000000000',
    site: actor.site,
    roles: [...actor.roles],
    s2: actor.s2,
    epoch: 1,
    iat: 0,
    exp: 0,
  };
}

const SITE_ADMIN = claimsOf(SITE_ADMIN_A);
const NON_ADMIN = claimsOf(SYSTEM_USER_A);
const SUPER_USER = claimsOf(ADMIN_S2);
/** A session token identity mints before login: verified, but `sub` is ''. */
const ANONYMOUS_PRINCIPAL: UserClaims = { ...SITE_ADMIN, sub: '' };

type GateRequest = Parameters<typeof requireCusersAccess>[0];
type DenialReply = Parameters<typeof sendAdminDenial>[0];

interface RequestInput {
  user?: UserClaims;
  query?: Record<string, unknown>;
  referer?: string;
  config?: Record<string, unknown>;
}

/** The fields of a Fastify request the gates and the denial renderers read. */
function requestOf({ user, query = {}, referer, config = {} }: RequestInput = {}): GateRequest {
  return {
    opt2Auth: { user, roles: user?.roles ?? [], transport: 'service' },
    query,
    body: undefined,
    headers: referer === undefined ? {} : { referer },
    routeOptions: { config },
  } as unknown as GateRequest;
}

interface Sent {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A reply over `request` that records what is sent on it. */
function replyOf(request: GateRequest): { reply: DenialReply; sent: Sent } {
  const sent: Sent = {};
  const reply = {
    request,
    raw: {},
    code(status: number): unknown {
      sent.status = status;
      return reply;
    },
    headers(headers: Record<string, string>): unknown {
      sent.headers = headers;
      return reply;
    },
    send(body: unknown): unknown {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as DenialReply, sent };
}

/** `result` as the denial a gate answered, failing the test for admitted claims. */
function asDenial(result: UserClaims | AdminDenial): AdminDenial {
  expect(result).toBeInstanceOf(AdminDenial);
  return result as AdminDenial;
}

/** The error `fn` throws, failing the test when it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('the gate roles', () => {
  it('declares s2, site-admin and the Users module as the coarse cUsers route gate', () => {
    expect(CUSERS_ROUTE_REQUIRES).toEqual([Roles.s2, Roles.siteAdmin, moduleRole('00000000000000000000000000000000008')]);
  });

  it.each<[operationId: string, requires: readonly string[]]>([
    ['listUsers', CUSERS_ROUTE_REQUIRES],
    ['getUserEdit', CUSERS_ROUTE_REQUIRES],
    ['getProfile', PROFILE_ROUTE_REQUIRES],
    ['updateProfile', PROFILE_ROUTE_REQUIRES],
  ])('requires on %s exactly the roles the contract declares', (operationId, requires) => {
    expect(operation(operationId).declared['x-opt2-requires']).toEqual([...requires]);
  });

  it.each<[label: string, claims: Pick<UserClaims, 'roles'>, expected: { cusers: boolean; admin: boolean; superUser: boolean }]>([
    ['S2', ADMIN_S2, { cusers: true, admin: true, superUser: true }],
    ['a site admin', SITE_ADMIN_A, { cusers: true, admin: true, superUser: false }],
    ["another tenant's site admin", OTHER_TENANT, { cusers: true, admin: true, superUser: false }],
    ['the Users and Site Manager module grants', MODULE_USER_A, { cusers: true, admin: false, superUser: false }],
    ['the Users module grant alone', MODULE_008_ONLY, { cusers: false, admin: false, superUser: false }],
    ['the Site Manager module grant alone', { roles: [Roles.systemUser, SITE_MANAGER_MODULE] }, { cusers: false, admin: false, superUser: false }],
    ['an editor', EDITOR, { cusers: false, admin: false, superUser: false }],
    ['a system user', SYSTEM_USER_A, { cusers: false, admin: false, superUser: false }],
    ['a pooled member', MEMBER_POOLED, { cusers: false, admin: false, superUser: false }],
  ])('rates %s for cUsers access, rc.isAdmin and isSuperUser', (_label, claims, expected) => {
    expect({ cusers: cusersAccess(claims), admin: isAdminViewer(claims), superUser: isSuperViewer(claims) }).toEqual(expected);
  });

  it("scopes the domain reads to the token's tenant, site and s2 claim only", () => {
    expect(viewerScopeFor({ ...SUPER_USER, roles: [Roles.systemUser] })).toStrictEqual({ tid: SUPER_USER.tid, site: 'default', isS2: true });
  });

  it('re-exports the admin site-access gate actions of legacy-compat', () => {
    expect([ADMIN_NOACCESS_ACTION, ADMIN_LOGIN_REDIRECT_ACTION]).toEqual([COMPAT_NOACCESS_ACTION, COMPAT_LOGIN_REDIRECT_ACTION]);
    expect([ADMIN_NOACCESS_ACTION, ADMIN_LOGIN_REDIRECT_ACTION]).toEqual(['cMessage.noaccess', 'clogin.logout']);
  });
});

// Oracle: cUsers.listUsers on legacy echoes the scrubbed rc.ispublic in its search form and lists that pool.
describe('normaliseCusersParams scrubbing', () => {
  it.each<[sent: string, kept: string]>([
    ['no', 'no'],
    ['false', 'false'],
    ['YES', 'YES'],
    [' no', 'no'],
    ['\tFALSE\n', 'FALSE'],
    [' fALSE', 'fALSE'],
    [' True', 'True'],
    ['TRUE\u0001', 'TRUE'],
    ['no\u0000', 'no'],
    ['fa\u0000lse', 'false'],
    [' 0 ', '0'],
    [' 1.0', '1.0'],
    ['1.', '1.'],
    [' -0', '-0'],
    ['+0', '+0'],
    ['.0', '.0'],
    ['0e5', '0e5'],
    // The scan re-serializes these as JSON, padded lowercase literals as "YES" or "NO", and none is then a boolean.
    [' true', '1'],
    [' false', '1'],
    ['false\u0001', '1'],
    ['\u0001false', '1'],
    ['"0"', '1'],
    ['[0]', '1'],
    [' null', '1'],
    ['0x', '1'],
    ['\u007fno', '1'],
    ['\u00a0no', '1'],
    ['abc', '1'],
    ['', '1'],
  ])('keeps ispublic %j of an admin as %j', (sent, kept) => {
    const ctx = normaliseCusersParams({ ispublic: sent }, SITE_ADMIN);
    expect(ctx.ispublic).toBe(kept);
    expect(ctx.params.ispublic).toBe(kept);
  });

  it.each([' FALSE ', '0', ' no'])('scrubs ispublic %j of a non-admin to 1', (sent) => {
    expect(normaliseCusersParams({ ispublic: sent }, NON_ADMIN).ispublic).toBe('1');
  });

  it.each<[sent: string, kept: string, link: 0 | 1]>([
    [' yes', 'yes', 0],
    [' TRUE', 'TRUE', 0],
    [' FALSE ', 'FALSE', 1],
    [' 1 ', '1', 0],
    ['no', 'no', 1],
    [' true', '0', 1],
    [' false', '0', 1],
    ['"1"', '0', 1],
    ['abc', '0', 1],
  ])('keeps unassigned %j as %j with unassignedlink %d', (sent, kept, link) => {
    const ctx = normaliseCusersParams({ unassigned: sent }, NON_ADMIN);
    expect([ctx.unassigned, ctx.unassignedlink]).toEqual([kept, link]);
  });
});

describe('normaliseCusersParams site, defaults and paging', () => {
  it.each<[label: string, params: Record<string, unknown>, claims: UserClaims, allowAllSites: boolean, siteid: string]>([
    ['the token site for a missing siteid', {}, SITE_ADMIN, false, TENANT_A.siteId],
    ['default for a missing siteid and a token without a site', {}, { ...SITE_ADMIN, site: '' }, false, 'default'],
    ['the supplied spelling of the token site', { SiteID: 'TENANT-A' }, SITE_ADMIN, true, 'TENANT-A'],
    ['all for S2 on a read listing every site', { siteid: 'ALL' }, SUPER_USER, true, 'ALL'],
  ])('reads siteid as %s', (_label, params, claims, allowAllSites, siteid) => {
    expect(normaliseCusersParams(params, claims, { allowAllSites }).siteid).toBe(siteid);
  });

  it.each<[label: string, siteid: string, claims: UserClaims, allowAllSites: boolean]>([
    ['another site', TENANT_B.siteId, SITE_ADMIN, false],
    ['another site on a read listing every site', TENANT_B.siteId, SITE_ADMIN, true],
    ['all from a site admin', 'all', SITE_ADMIN, true],
    ['all from S2 on a read that lists one site', 'all', SUPER_USER, false],
  ])('refuses %s with the 403 site mismatch', (_label, siteid, claims, allowAllSites) => {
    const err = thrownBy(() => normaliseCusersParams({ siteid }, claims, { allowAllSites }));
    expect(err).toBeInstanceOf(AuthDenial);
    expect(err).toMatchObject({ statusCode: 403, reason: 'site-mismatch' });
  });

  it.each<[label: string, claims: UserClaims, kept: boolean]>([
    ['a site admin', SITE_ADMIN, false],
    ['S2', SUPER_USER, true],
  ])('keeps a posted S2 only for S2: %s', (_label, claims, kept) => {
    expect(Object.hasOwn(normaliseCusersParams({ S2: '1' }, claims).params, 'S2')).toBe(kept);
  });

  it('sets every cUsers param default in its legacy spelling, with isAdmin and unassignedlink', () => {
    const ctx = normaliseCusersParams({ userid: undefined }, SITE_ADMIN);
    expect(ctx.params).toStrictEqual({
      siteid: TENANT_A.siteId,
      isAdmin: true,
      error: {},
      startrow: 1,
      recordsperpage: 25,
      userid: '',
      routeid: '',
      categoryid: '',
      Type: '0',
      ContactForm: '0',
      isPublic: '1',
      email: '',
      jobtitle: '',
      lastupdate: '',
      lastupdateby: '',
      lastupdatebyid: '0',
      groupname: '',
      fname: '',
      lname: '',
      address: '',
      city: '',
      state: '',
      zip: '',
      phone1: '',
      phone2: '',
      fax: '',
      perm: '0',
      groupid: '',
      InActive: '0',
      returnurl: '',
      search: '',
      newsearch: false,
      unassigned: '0',
      unassignedlink: 1,
    });
    expect(ctx).toMatchObject({
      siteid: TENANT_A.siteId,
      isAdmin: true,
      ispublic: '1',
      unassigned: '0',
      unassignedlink: 1,
      startrow: 1,
      recordsperpage: 25,
      userid: '',
      routeid: '',
      categoryid: '',
      groupid: '',
      type: '0',
      returnurl: '',
      search: '',
      newsearch: 'false',
    });
  });

  it('keeps request values over the defaults in the spelling they arrived with, a posted __proto__ as data', () => {
    const params = JSON.parse('{"USERID":"U-1","StartRow":"3","type":"2","NewSearch":"true","__proto__":"kept"}') as Record<string, unknown>;
    const ctx = normaliseCusersParams(params, NON_ADMIN);
    expect(ctx).toMatchObject({ isAdmin: false, userid: 'U-1', startrow: 3, type: '2', newsearch: 'true' });
    expect(ctx.params).toMatchObject({ isAdmin: false, USERID: 'U-1', StartRow: 3, type: '2', NewSearch: 'true' });
    expect(Object.keys(ctx.params).filter((key) => ['userid', 'startrow', 'Type', 'newsearch'].includes(key))).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(ctx.params, '__proto__')?.value).toBe('kept');
    expect(Object.getPrototypeOf(ctx.params)).toBe(Object.prototype);
  });

  it.each<[sent: unknown, startrow: number]>([
    ['0', 1],
    ['-3', 1],
    ['abc', 1],
    ['', 1],
    ['7', 7],
    ['12abc', 12],
    [7, 7],
  ])('reads startrow %j as CFML Val, at least 1: %d', (sent, startrow) => {
    const ctx = normaliseCusersParams({ startrow: sent }, SITE_ADMIN);
    expect([ctx.startrow, ctx.params.startrow]).toEqual([startrow, startrow]);
  });

  it.each<[sent: unknown, recordsperpage: number]>([
    ['0', 25],
    ['x', 25],
    ['-1', 25],
    ['50', 50],
    ['12abc', 12],
  ])('reads recordsperpage %j as CFML Val, 25 below 1: %d', (sent, recordsperpage) => {
    const ctx = normaliseCusersParams({ recordsperpage: sent }, SITE_ADMIN);
    expect([ctx.recordsperpage, ctx.params.recordsperpage]).toEqual([recordsperpage, recordsperpage]);
  });
});

describe('normaliseProfileParams', () => {
  it('sets every cEditProfile param default with its legacy type', () => {
    expect(normaliseProfileParams({})).toStrictEqual({
      Type: 0,
      ContactForm: 0,
      isPublic: 0,
      email: '',
      jobtitle: '',
      lastupdate: '',
      lastupdateby: '',
      lastupdatebyid: 0,
      groupname: '',
      fname: '',
      lname: '',
      address: '',
      city: '',
      state: '',
      zip: '',
      phone1: '',
      phone2: '',
      fax: '',
      perm: 0,
      groupid: '',
      routeid: '',
      InActive: 0,
      startrow: 1,
      categoryID: '',
      error: {},
      returnurl: '',
    });
  });

  it('keeps request values over the defaults in the spelling they arrived with', () => {
    const params = normaliseProfileParams({ ISPUBLIC: '1', FName: 'Ann', routeID: 'R-1' });
    expect(params).toMatchObject({ ISPUBLIC: '1', FName: 'Ann', routeID: 'R-1', Type: 0 });
    expect(Object.keys(params).filter((key) => ['isPublic', 'fname', 'routeid'].includes(key))).toEqual([]);
  });
});

// cUsers and cEditProfile refuse through secure() (controller.cfc:83-92): cLogin.main when logged out, utility.backUp()
// when logged in. cMessage.noaccess and clogin.logout belong to admin/Application.cfc's site-access gate, not to these gates.
describe('secure() denials', () => {
  it.each<[label: string, user: UserClaims | undefined]>([
    ['a request without a user', undefined],
    ['the anonymous principal', ANONYMOUS_PRINCIPAL],
  ])('sends %s to cLogin.main with a 401 from both gates', (_label, user) => {
    for (const gate of [requireCusersAccess, requireLoggedIn]) {
      const denial = asDenial(gate(requestOf({ user })));
      expect([denial.statusCode, denial.auth.reason]).toEqual([401, 'missing-credential']);
      expect(denial.redirect).toStrictEqual({ action: 'cLogin.main', params: {} });
    }
  });

  it.each<[sent: unknown, params: Record<string, string>]>([
    ['true', { compactDisplay: 'true' }],
    [0, { compactDisplay: '0' }],
    [false, { compactDisplay: 'false' }],
    [{ nested: 'x' }, {}],
  ])('appends compactDisplay %j to cLogin.main only as a simple value', (sent, params) => {
    const denial = asDenial(requireLoggedIn(requestOf({ query: { CompactDisplay: sent } })));
    expect(denial.redirect).toStrictEqual({ action: 'cLogin.main', params });
  });

  it.each<[referer: string | undefined, url: string]>([
    [undefined, './'],
    ['', './'],
    ['https://a.example.test/admin/?muraAction=cDashboard.main', 'https://a.example.test/admin/?muraAction=cDashboard.main'],
  ])('backs a viewer holding m:008 without m:000 up to referer %j with a 403', (referer, url) => {
    const denial = asDenial(requireCusersAccess(requestOf({ user: claimsOf(MODULE_008_ONLY), referer })));
    expect([denial.statusCode, denial.auth.reason]).toEqual([403, 'forbidden']);
    expect(denial.redirect).toStrictEqual({ url });
  });

  it.each<[label: string, actor: TestActor]>([
    ['S2', ADMIN_S2],
    ['a site admin', SITE_ADMIN_A],
    ['the Users and Site Manager module grants', MODULE_USER_A],
  ])('admits %s to cUsers with its verified claims', (_label, actor) => {
    const user = claimsOf(actor);
    expect(requireCusersAccess(requestOf({ user }))).toBe(user);
  });

  it('admits a pooled member to cEditProfile, not to cUsers', () => {
    const user = claimsOf(MEMBER_POOLED);
    expect(requireLoggedIn(requestOf({ user }))).toBe(user);
    expect(asDenial(requireCusersAccess(requestOf({ user }))).statusCode).toBe(403);
  });

  it.each<[label: string, config: Record<string, unknown>]>([
    ['a route without an opt2 declaration', {}],
    ['a route without renderDenial', { opt2: { requires: CUSERS_ROUTE_REQUIRES } }],
  ])('answers the legacy JSON API error the auth hooks give on %s', async (_label, config) => {
    const request = requestOf({ query: { method: 'findMany', siteid: TENANT_A.siteId }, config });
    const denial = asDenial(requireLoggedIn(request));
    const { reply, sent } = replyOf(request);
    await sendAdminDenial(reply, denial);
    const expected = renderAuthDenial(denial.auth, request);
    expect(sent).toStrictEqual({ status: 401, headers: expected.headers, body: expected.body });
    expect(expected.status).toBe(401);
  });

  it("answers with the route's renderDenial", async () => {
    const renderDenial = (denial: AuthDenial) => ({
      status: denial.statusCode,
      headers: { 'content-type': 'text/plain' },
      body: `denied: ${denial.reason}`,
    });
    const request = requestOf({ user: claimsOf(MODULE_008_ONLY), config: { opt2: { requires: CUSERS_ROUTE_REQUIRES, renderDenial } } });
    const { reply, sent } = replyOf(request);
    await sendAdminDenial(reply, asDenial(requireCusersAccess(request)));
    expect(sent).toStrictEqual({ status: 403, headers: { 'content-type': 'text/plain' }, body: 'denied: forbidden' });
  });
});


/** `tenant_registry` row of a fixture site that owns every one of its user pools. */
function registryRowOf(site: { siteId: string; tenantId: string }) {
  return {
    site_id: site.siteId,
    tenant_id: site.tenantId,
    public_user_pool_id: site.siteId,
    private_user_pool_id: site.siteId,
    category_pool_id: null,
    file_pool_id: null,
    display_pool_id: null,
    content_pool_ids: [],
    public_user_pool_tenant: site.tenantId,
    private_user_pool_tenant: site.tenantId,
    category_pool_tenant: null,
    file_pool_tenant: null,
    display_pool_tenant: null,
    content_pool_tenants: [],
    domains: [`${site.siteId}.example.test`],
    aggregate_version: '1',
    updated_at: new Date(2026, 5, 30, 12, 0, 0, 0),
  };
}

/** Identity hints a caller may forge; roles, site and tenant come only from the verified token. */
const FORGED_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-opt2-roles': Roles.s2,
  'x-opt2-user': ADMIN_S2.sub,
  'x-opt2-site': TENANT_A.siteId,
  'x-opt2-tenant-id': TENANT_A.tenantId,
});

/** The body the auth hooks answer `denial` with for a request carrying `query`. */
function hookDenialBody(denial: AuthDenial, query: Record<string, string>): string {
  return renderAuthDenial(denial, requestOf({ query })).body;
}

describe('the gates through the app', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  /** Injects the contract operation `operationId`, a form post for a POST, and checks the answer against the contract. */
  async function inject(operationId: string, headers: Record<string, string>, query: Record<string, string> = {}) {
    const { method, path } = operation(operationId);
    const search = new URLSearchParams(query).toString();
    const res = await t.app.inject({
      method,
      url: search === '' ? path : `${path}?${search}`,
      headers: method === 'POST' ? { ...headers, 'content-type': 'application/x-www-form-urlencoded' } : headers,
      payload: method === 'POST' ? 'fname=Changed' : undefined,
    });
    assertResponseMatchesOpenApi(CONTRACT, { method, path, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  it.each<[label: string, actor: TestActor, operationId: string, query: Record<string, string>, forged: Readonly<Record<string, string>>]>([
    ['a viewer holding m:008 without m:000 on listUsers', MODULE_008_ONLY, 'listUsers', {}, {}],
    ['a viewer holding m:008 without m:000 on getUserEdit', MODULE_008_ONLY, 'getUserEdit', { userid: SYSTEM_USER_A.sub }, {}],
    ['a site admin naming another site on listUsers', SITE_ADMIN_A, 'listUsers', { siteid: TENANT_B.siteId, ispublic: '0' }, {}],
    ['a forged role, user, site and tenant on listUsers', MODULE_008_ONLY, 'listUsers', { roles: Roles.s2, s2: '1', isAdmin: 'true' }, FORGED_HEADERS],
  ])('refuses %s with 403 before any statement or identity call', async (_label, actor, operationId, query, forged) => {
    t.db.clear();
    const res = await inject(operationId, { ...(await userHeaders(actor)), ...forged }, query);
    expect([res.statusCode, res.body]).toEqual([403, hookDenialBody(AuthDenial.forbidden(), query)]);
    expect(t.db.statements()).toEqual([]);
    expect(t.identity.requests).toEqual([]);
  });

  it.each<[operationId: string, caller: string, headers: () => Promise<Record<string, string>>]>([
    ['getProfile', 'a gateway request without a user token', () => headersFor('service:gateway')],
    ['getProfile', 'the anonymous principal', () => userHeaders({ sub: '', site: TENANT_A.siteId, roles: [Roles.member] })],
    ['updateProfile', 'a gateway request without a user token', () => headersFor('service:gateway')],
    ['updateProfile', 'the anonymous principal', () => userHeaders({ sub: '', site: TENANT_A.siteId, roles: [Roles.member] })],
  ])('answers %s from %s with the 401 of the auth hooks, before any effect', async (operationId, _caller, headers) => {
    t.db.clear();
    const res = await inject(operationId, await headers());
    expect([res.statusCode, res.body]).toEqual([401, hookDenialBody(AuthDenial.unauthenticated('missing-credential'), {})]);
    expect(t.db.statements()).toEqual([]);
    expect(t.identity.requests).toEqual([]);
    expect(t.identity.csrf.consumed()).toEqual([]);
  });

  it("reads a tenant-a user id for tenant-b's site admin only in tenant-b, whatever the request claims", async () => {
    t.db.respond(/\btenant_registry WHERE tenant_id = \$1/, (_text, values) => (values[0] === TENANT_B.tenantId ? [registryRowOf(TENANT_B)] : []));
    const query = { userid: SYSTEM_USER_A.sub, tid: TENANT_A.tenantId, roles: Roles.s2 };
    const res = await inject('getUserEdit', { ...(await userHeaders(OTHER_TENANT)), ...FORGED_HEADERS }, query);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { isNew: boolean; user: { UserID: string } };
    expect(body.isNew).toBe(true);
    expect(body.user.UserID).not.toBe(SYSTEM_USER_A.sub);
    const statements = t.db.statements();
    const personReads = statements.filter(({ text }) => /^SELECT \* FROM \S*\bperson\b/.test(text));
    expect(personReads.length).toBeGreaterThan(0);
    expect(personReads.map(({ values }) => values[0])).toEqual(personReads.map(() => TENANT_B.tenantId));
    // Registry reads run in metadata transactions, which set no tenant.
    const tenants = statements.filter(({ text }) => text.includes("set_config('app.tenant_id'")).map(({ values }) => values[0]);
    expect(new Set(tenants.filter((tenant) => tenant !== ''))).toEqual(new Set([TENANT_B.tenantId]));
  });
});

