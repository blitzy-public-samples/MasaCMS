// Tests of the legacy admin request set-up: FW/1 context, admin session, site data, cookies and request flags.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthDenial, INVOCATION_HEADER, Roles, assertSiteMatches, moduleRole } from '@opt2/platform/auth';
import type { MintUserTokenInput } from '@opt2/platform/testing';
import { secure } from '@/lib/access-gate';
import { authenticateRequest, type WebAuth } from '@/lib/auth';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError, GatewayUnavailableError, type WebServiceName } from '@/lib/gateway-client';
import {
  ORIGINAL_URL_HEADER,
  applyDefaults,
  buildAdminRequest,
  dashboardSpanFor,
  mergeFw1Context,
  nextSessionSite,
  resolveAction,
  restoreFlashContext,
  saveSessionWrites,
  setSessionMuraValue,
  withSessionMuraValue,
  type AdminMode,
  type AdminRequest,
  type AdminRequestInput,
  type AdminSessionState,
  type SiteData,
} from '@/lib/request-context';
import { SITE_IDS, siteById } from '../fixtures/programs-sites/sites';
import { sessionPresets } from '../fixtures/session';
import { useTestEnv } from '../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRoute,
  type FakeRouteTable,
} from '../helpers/fake-gateway';
import {
  SUBJECTS,
  gatewayInvocation,
  userTokenFor,
  type WebTestSubject,
  type WebTestSubjectKey,
} from '../helpers/tokens';

type SessionUser = AdminSessionState['mura'];
type SiteRecord = SiteData['record'];

const HOME_ID = '00000000000000000000000000000000001';
const CONTENT_MODULE = '00000000000000000000000000000000000';
const USERS_MODULE = '00000000000000000000000000000000008';
const PLUGIN_MODULE = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';

const CURRENT_SESSION = routeKey('GET', 'identity', '/v1/sessions/current');
const SESSION_SITES = routeKey('GET', 'identity', '/v1/sessions/current/sites');
const ADMIN_STATE = routeKey('GET', 'identity', '/v1/sessions/current/admin-state');
const SAVE_ADMIN_STATE = routeKey('POST', 'identity', '/v1/sessions/current/admin-state');
const REVERSE_LOOKUP = routeKey('GET', 'identity', '/v1/permissions/reverse-lookup');
const siteRoute = (siteId: string): string => routeKey('GET', 'programs-sites', `/v1/sites/${siteId}/shell`);
const HREF_DOMAINS = routeKey('GET', 'programs-sites', '/v1/href-domains');

const SITE_NAMES: Readonly<Record<string, string>> = { default: 'Default', 'tenant-a': 'Tenant A' };

const DEFAULT_RECORD: SiteRecord = {
  SiteID: 'default',
  Site: 'Default',
  Domain: 'localhost',
  siteLocale: '',
  hasChangesets: 0,
  hasComments: null,
  feedManager: 1,
  EmailBroadcaster: 0,
  Extranet: 1,
  Cache: 0,
  enableLockdown: null,
};

const TENANT_A_RECORD: SiteRecord = {
  SiteID: 'tenant-a',
  Site: 'Tenant A',
  Domain: 'tenant-a.example.test',
  siteLocale: 'German (Standard)',
  publicUserPoolID: 'umbrella',
  privateUserPoolID: 'umbrella',
  displayPoolID: 'tenant-a',
  contentPoolID: 'tenant-a',
  categoryPoolID: 'umbrella',
  filePoolID: 'tenant-a',
  hasChangesets: 1,
  hasComments: 1,
  feedManager: 0,
  EmailBroadcaster: 1,
  Extranet: 0,
  Cache: 1,
  enableLockdown: 'development',
  lastDeployment: '2026-01-02 03:04:05',
};

const siteReply = (record: SiteRecord, isNew: 0 | 1 = 0): FakeReply => ({ status: 200, body: { site: record, isNew } });

/** `reply` behind programs-sites' site check: with a user token, a path or query `siteid` other than `site` gets 403. */
function siteChecked(site: string, reply: FakeReply): FakeRoute {
  return (request) => {
    if (request.headers.authorization === undefined) return reply;
    const shellSiteId = /\/v1\/sites\/([^/]+)\/shell$/.exec(request.path)?.[1];
    const supplied = [shellSiteId === undefined ? [] : decodeURIComponent(shellSiteId), request.query['siteid'] ?? []];
    try {
      for (const siteid of supplied.flat()) assertSiteMatches(siteid, { site });
    } catch (error) {
      if (error instanceof AuthDenial) return { status: error.statusCode };
      throw error;
    }
    return reply;
  };
}

function sessionReply(subject: WebTestSubject, user: Partial<SessionUser>): FakeReply {
  return {
    status: 200,
    body: {
      sessionId: subject.sid,
      epoch: 0,
      user: { isLoggedIn: true, userID: subject.sub, siteID: subject.site, memberships: '', ...user },
      roles: [...subject.roles],
      mfaPending: false,
      blockLoginUntil: null,
    },
  };
}

/** Identity and programs-sites answers for `subject`: S2 users administer every site, others their own; no admin state is stored. */
function routesFor(subject: WebTestSubject, user: Partial<SessionUser> = {}): FakeRouteTable {
  const siteIds = subject.s2 ? Object.keys(SITE_NAMES) : [subject.site];
  return {
    [CURRENT_SESSION]: sessionReply(subject, user),
    [SESSION_SITES]: { status: 200, body: { sites: siteIds.map((siteID) => ({ siteID, site: SITE_NAMES[siteID] })) } },
    [ADMIN_STATE]: { status: 200, body: {} },
    [siteRoute('default')]: siteReply(DEFAULT_RECORD),
    [siteRoute('tenant-a')]: siteReply(TENANT_A_RECORD),
    [HREF_DOMAINS]: { status: 200, body: { allowedDomains: ['localhost'], siteDomain: 'localhost' } },
  };
}

/** Verified identities of a gateway request carrying `subject`'s user token. */
async function authFor(subject: WebTestSubject, claims: Partial<MintUserTokenInput> = {}): Promise<WebAuth> {
  const headers = new Headers({ [INVOCATION_HEADER]: `Bearer ${await gatewayInvocation()}` });
  const token = await userTokenFor(subject, claims);
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  return authenticateRequest(headers, '/admin/');
}

interface Call {
  readonly subject?: WebTestSubjectKey;
  readonly claims?: Partial<MintUserTokenInput>;
  readonly user?: Partial<SessionUser>;
  /** The browser's request target, sent as the gateway's original-URL header. */
  readonly target?: string;
  /** The query web received; defaults to the target's query. */
  readonly received?: AdminRequestInput['searchParams'];
  readonly headers?: Readonly<Record<string, string>>;
  readonly form?: FormData | URLSearchParams;
  readonly mode?: AdminMode;
  readonly routes?: FakeRouteTable;
}

/** `buildAdminRequest` over an in-memory gateway, with the gateway's recorded calls. */
async function build(call: Call = {}): Promise<{ request: AdminRequest; gateway: FakeGatewayClient }> {
  const subject = SUBJECTS[call.subject ?? 'admin'];
  const auth = await authFor(subject, call.claims);
  const gateway = fakeGatewayClient(
    { ...routesFor(subject, call.user), ...call.routes },
    { userToken: auth.userToken },
  );
  const headers = new Headers(call.headers);
  if (call.target !== undefined) headers.set(ORIGINAL_URL_HEADER, call.target);
  const query = call.target?.split('?')[1] ?? '';
  const request = await buildAdminRequest({
    params: { circuit: 'cusers', action: 'list' },
    searchParams: call.received ?? new URLSearchParams(query),
    headers,
    form: call.form,
    auth,
    gateway,
    mode: call.mode ?? 'page',
  });
  return { request, gateway };
}

const callsOf = (gateway: FakeGatewayClient): string[] =>
  gateway.calls.map(({ service, path }) => `${service} ${path}`);

/** A `Set-Cookie` value as `setCookieLegacy` writes it with `expires=never`, then `flags`. */
const setCookie = (pair: string, flags: string): RegExp =>
  new RegExp(`^${pair};expires=\\w{3}, \\d{2}-\\w{3}-\\d{4} \\d{2}:\\d{2}:\\d{2} GMT;path=/;${flags}$`);

/** Replaces every `MURA_` variable with `vars`. */
function useSettings(vars: Readonly<Record<string, string>> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
  useSettings();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('mergeFw1Context', () => {
  it.each<[string[], Record<string, string>]>([
    [[], {}],
    [['cusers'], { muraAction: 'cusers' }],
    [['cusers', 'list'], { muraAction: 'cusers.list' }],
    [['cusers', 'list', 'siteid', 'default'], { muraAction: 'cusers.list', siteid: 'default' }],
    [
      ['cusers', 'edituser', 'userid', 'U1', 'flag'],
      { muraAction: 'cusers.edituser', userid: 'U1', flag: '' },
    ],
  ])('reads path %j', (pathInfo, expected) => {
    expect({ ...mergeFw1Context(pathInfo, {}, {}) }).toEqual(expected);
  });

  it('lets the URL override the path and the form the URL', () => {
    const rc = mergeFw1Context(['carch', 'list', 'siteid', 'a'], { SITEID: 'b', topid: 't' }, { SiteID: 'c' });

    expect({ ...rc }).toEqual({ muraAction: 'carch.list', siteid: 'c', topid: 't' });
  });

  it.each<[string, string[], Record<string, string>, Record<string, string>, Record<string, string>]>([
    ['a URL value over a path pair', ['carch', 'list', 'siteid', 'a'], { siteid: 'b' }, {}, { siteid: 'b' }],
    [
      'a URL muraAction over the path action',
      ['cusers', 'list'],
      { muraAction: 'cSettings.list' },
      {},
      { muraAction: 'cSettings.list' },
    ],
    [
      'form values over path pairs',
      ['cusers', 'update', 'type', '1', 'action', 'Update'],
      {},
      { type: '2', action: 'Add' },
      { muraAction: 'cusers.update', type: '2', action: 'Add' },
    ],
  ])('takes %s', (_label, pathInfo, url, form, expected) => {
    expect(mergeFw1Context(pathInfo, url, form)).toMatchObject(expected);
  });

  it.each<[string, string[], Record<string, string>, Record<string, string>, string]>([
    ['URL', [], { muraAction: 'carch.list', fuseaction: 'cusers.list' }, {}, 'cusers.list'],
    ['form', [], { muraAction: 'carch.list' }, { fuseaction: 'cusers.list' }, 'cusers.list'],
    ['URL under a form muraAction', [], { fuseaction: 'cusers.list' }, { muraAction: 'carch.list' }, 'carch.list'],
    ['URL over the path', ['carch', 'list'], { fuseaction: 'cusers.list' }, {}, 'cusers.list'],
  ])('applies a %s fuseaction', (_label, pathInfo, url, form, action) => {
    expect(mergeFw1Context(pathInfo, url, form).muraAction).toBe(action);
  });

  it('joins repeated names and drops unnamed pairs', () => {
    const rc = mergeFw1Context(
      [],
      [
        ['groupid', 'a'],
        ['GroupID', 'b'],
        ['', 'x'],
      ],
      new URLSearchParams('fname=Ann&FName=Bo&=y'),
    );

    expect({ ...rc }).toEqual({ groupid: 'a,b', fname: 'Ann,Bo' });
  });

  it('reads names case-insensitively and refuses writes', () => {
    const rc = mergeFw1Context([], { muraAction: 'cusers.list' }, {});

    expect(rc.MURAACTION).toBe('cusers.list');
    expect('muraaction' in rc).toBe(true);
    expect('siteid' in rc).toBe(false);
    expect(Symbol.iterator in rc).toBe(false);
    expect(Reflect.get(rc, Symbol.toStringTag)).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(rc, 'siteid')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(rc, Symbol.iterator)).toBeUndefined();
    expect(Reflect.set(rc, 'siteid', 'x')).toBe(false);
    expect(Reflect.defineProperty(rc, 'siteid', { value: 'x' })).toBe(false);
    expect(Reflect.deleteProperty(rc, 'muraAction')).toBe(false);
    expect(Object.keys(rc)).toEqual(['muraAction']);
  });
});

describe('resolveAction', () => {
  it.each<[Record<string, string>, string]>([
    [{}, 'core:home.redirect'],
    [{ muraAction: 'cUsers.List' }, 'core:cusers.list'],
    [{ muraAction: 'core:cusers.list' }, 'core:cusers.list'],
    [{ MURAACTION: 'carch.list' }, 'core:carch.list'],
    [{ muraAction: 'cusers' }, 'core:cusers.default'],
    [{ muraAction: '.list' }, 'core:main.list'],
    [{ muraAction: '' }, 'core:main.default'],
    [{ muraAction: 'a.b.c' }, 'core:a.c'],
    [{ muraAction: 'Plugin:cusers.list' }, 'plugin:cusers.list'],
    [{ muraAction: 'plugin:' }, 'plugin:main.default'],
    [{ muraAction: 'x:y:cusers.list' }, 'x:cusers.list'],
  ])('resolves %j as %s', (rc, action) => {
    expect(resolveAction(rc)).toBe(action);
  });

  it.each(['cusers/list', 'cUsers\\List'])('rejects %s', (muraAction) => {
    expect(() => resolveAction({ muraAction })).toThrow(RangeError);
    expect(() => resolveAction({ muraAction })).toThrow(
      /^Found a slash in the action: 'core:cusers[/\\]list\.default'\.$/,
    );
  });
});

describe('restoreFlashContext', () => {
  const rc = { muraAction: 'core:cusers.list', siteid: 'default' };

  it('adds the preserved context without overwriting', () => {
    const restored = restoreFlashContext(rc, { FW1PK: '2' }, { '2': { SiteID: 'tenant-a', msg: 'Saved' } });

    expect({ ...restored }).toEqual({ ...rc, msg: 'Saved' });
    expect(rc).toEqual({ muraAction: 'core:cusers.list', siteid: 'default' });
  });

  it.each<[string, Record<string, string>]>([
    ['no preserve key', {}],
    ['an unknown preserve key', { fw1pk: '3' }],
  ])('leaves the context with %s', (_label, url) => {
    expect({ ...restoreFlashContext(rc, url, { '2': { msg: 'Saved' } }) }).toEqual(rc);
  });
});

describe('applyDefaults', () => {
  it('adds the cfparam defaults where a key is absent', () => {
    expect({ ...applyDefaults({ SiteID: 'tenant-a', COMPACTDISPLAY: 'true' }) }).toEqual({
      SiteID: 'tenant-a',
      COMPACTDISPLAY: 'true',
      moduleid: '',
      muraAction: '',
      layout: '',
      activetab: '0',
      activepanel: '0',
      rb: '',
      closeCompactDisplay: 'false',
      param: '',
      inActive: '0',
      categoryID: '',
      groupID: '',
      membersOnly: 'false',
      visitorStatus: 'All',
    });
  });
});

describe('dashboardSpanFor', () => {
  it.each([
    [0, 30],
    [1, 1],
    [179, 179],
    [180, 30],
    [365, 30],
  ])('spans %i history days as %i', (history, span) => {
    expect(dashboardSpanFor(history)).toBe(span);
  });
});

describe('nextSessionSite', () => {
  const switched = (siteid: string, assetPath = '/sites') => ({
    siteid,
    userFilesPath: `${assetPath}/${siteid}/assets/`,
    topID: HOME_ID,
    openSectionList: '',
  });

  it.each<[string, string, string, boolean, ReturnType<typeof switched> | undefined]>([
    ['a known site', 'tenant-a', 'default', true, switched('tenant-a')],
    ['an unknown site', 'tenant-a', 'default', false, undefined],
    ['an unknown site on an empty session', 'tenant-a', '', false, undefined],
    ['the session site in another case', 'DEFAULT', 'default', true, undefined],
    ['no site on an empty session', '', '', false, switched('default')],
    ['no site', '', 'tenant-a', true, undefined],
  ])('moves the session for %s', (_label, rcSiteId, sessionSiteId, exists, expected) => {
    expect(nextSessionSite(rcSiteId, sessionSiteId, () => exists, '/sites')).toEqual(expected);
  });

  it('builds userFilesPath from the configured asset path', () => {
    useSettings({ MURA_ASSETPATH: '/files/' });

    expect(nextSessionSite('tenant-a', 'default', (siteId) => siteId === 'tenant-a')).toEqual(
      switched('tenant-a', '/files'),
    );
  });
});

describe('buildAdminRequest', () => {
  describe('request context', () => {
    it('resolves a page request from the original URL', async () => {
      const { request } = await build({ target: '/admin/?muraAction=cUsers.list&siteid=default' });

      expect(request).toMatchObject({
        mode: 'page',
        route: { circuit: 'cusers', action: 'list' },
        action: 'core:cusers.list',
        circuit: 'cusers',
        item: 'list',
        ses: false,
        currentUrl: './?&muraAction=cUsers.list&siteid=default',
      });
      expect({ ...request.rc }).toEqual({
        muraAction: 'core:cusers.list',
        siteid: 'default',
        moduleid: '',
        layout: '',
        activetab: '0',
        activepanel: '0',
        rb: '',
        closeCompactDisplay: 'false',
        compactDisplay: 'false',
        param: '',
        inActive: '0',
        categoryID: '',
        groupID: '',
        membersOnly: 'false',
        visitorStatus: 'All',
      });
    });

    it.each<[string, string, Record<string, string>, boolean, string]>([
      [
        '/admin/index.cfm/cusers/edituser/userid/U1/flag?siteid=default',
        'core:cusers.edituser',
        { userid: 'U1', flag: '' },
        true,
        './?&siteid=default',
      ],
      ['/admin/cusers/list/keywords/a%20b', 'core:cusers.list', { keywords: 'a b' }, true, './'],
      ['/admin/cusers/list/keywords/%E0%A4%A', 'core:cusers.list', { keywords: '%E0%A4%A' }, true, './'],
      ['/ADMIN/carch/list//', 'core:carch.list', {}, true, './'],
      ['/admin/', 'core:home.redirect', {}, false, './'],
      ['/admin/?muraAction=cusers.list', 'core:cusers.list', {}, false, './?&muraAction=cusers.list'],
      ['/admin', 'core:home.redirect', {}, false, './'],
      ['/administrator/cusers/list', 'core:home.redirect', {}, false, './'],
    ])('splits path %s', async (target, action, values, ses, currentUrl) => {
      const { request } = await build({ target });

      expect(request.action).toBe(action);
      expect(request.rc).toMatchObject(values);
      expect(request.ses).toBe(ses);
      expect(request.currentUrl).toBe(currentUrl);
    });

    it('strips the configured context from the path', async () => {
      useSettings({ MURA_CONTEXT: '/masa/' });

      const { request } = await build({ target: '/masa/admin/carch/list?siteid=default' });

      expect(request.action).toBe('core:carch.list');
      expect(request.currentUrl).toBe('./?&siteid=default');
    });

    it('keeps the rc values the request supplies over the cfparam defaults', async () => {
      const supplied = {
        moduleid: USERS_MODULE,
        layout: 'compact',
        activetab: '2',
        activepanel: '1',
        compactDisplay: 'true',
        closeCompactDisplay: 'true',
        inActive: '1',
        membersOnly: 'true',
        visitorStatus: 'Members',
      };

      const { request } = await build({ target: `/admin/?${new URLSearchParams(supplied).toString()}` });

      expect(request.rc).toMatchObject({ ...supplied, param: '', categoryID: '', groupID: '' });
    });

    it('applies a URL fuseaction', async () => {
      const { request } = await build({ target: '/admin/?muraAction=carch.list&fuseaction=cUsers.list' });

      expect(request.action).toBe('core:cusers.list');
      expect(request.rc.fuseaction).toBe('cUsers.list');
    });

    it('takes the posted fields of a page-mode POST from the received query', async () => {
      const { request } = await build({
        target: '/admin/?muraAction=cusers.update&userid=U1',
        received: new URLSearchParams('muraAction=cusers.update&userid=U1&fname=Ann&userid=U2'),
      });

      expect(request.rc).toMatchObject({ muraAction: 'core:cusers.update', userid: 'U2', fname: 'Ann' });
      expect(request.currentUrl).toBe('./?&muraAction=cusers.update&userid=U1');
    });

    it('reads the body of a redirect request, a file part as its file name', async () => {
      const form = new FormData();
      form.append('fname', 'Ann');
      form.append('photo', new File(['x'], 'photo.png', { type: 'image/png' }));

      const { request } = await build({
        mode: 'redirect',
        received: { muraAction: 'cusers.update', tag: ['a', 'b'], skip: undefined },
        form,
      });

      expect(request.mode).toBe('redirect');
      expect(request.rc).toMatchObject({
        muraAction: 'core:cusers.update',
        tag: 'a,b',
        fname: 'Ann',
        photo: 'photo.png',
      });
      expect(request.rc.skip).toBeUndefined();
      expect(request.currentUrl).toBe('./?&muraAction=cusers.update&tag=a,b');
    });

    it('takes the URL scope from the original URL when a body is given', async () => {
      const { request } = await build({
        mode: 'raw',
        target: '/admin/?muraAction=carch.loaddiff&contentid=C1',
        received: new URLSearchParams('muraAction=carch.loaddiff&contentid=C1&extra=1'),
        form: new URLSearchParams('contentid=C2'),
      });

      expect(request.rc).toMatchObject({ muraAction: 'core:carch.loaddiff', contentid: 'C2' });
      expect(request.rc.extra).toBeUndefined();
    });

    it.each([
      ['carch.list', 'default'],
      ['csettings.editSite', ''],
    ])('fills rc.siteid from the session on %s as %j', async (muraAction, siteid) => {
      const { request } = await build({ subject: 'qaEditor', target: `/admin/?muraAction=${muraAction}` });

      expect(request.rc.siteid).toBe(siteid);
      expect(request.session.siteid).toBe('default');
    });
  });

  describe('identity session', () => {
    it('loads the session of an S2 user', async () => {
      const alerts = { default: { a1: { type: 'warning', text: 'Check' } } };
      const { request, gateway } = await build({
        target: '/admin/?muraAction=cusers.list&siteid=default',
        user: { memberships: 'S2,S2IsPrivate', alerts },
      });

      expect(callsOf(gateway).sort()).toEqual([
        'identity /v1/sessions/current',
        'identity /v1/sessions/current/admin-state',
        'identity /v1/sessions/current/sites',
        'programs-sites /v1/sites/default/shell',
      ]);
      expect(request.session).toMatchObject({
        siteid: 'default',
        userFilesPath: '/sites/default/assets/',
        topID: HOME_ID,
        siteArray: ['default', 'tenant-a'],
        s2IsPrivate: true,
        alerts,
        dashboardSpan: 30,
        mura: { isLoggedIn: true, userID: SUBJECTS.admin.sub, memberships: 'S2,S2IsPrivate' },
        flash: {},
        nextPreserveKey: 1,
      });
      expect(request.adminSites).toEqual([
        { siteID: 'default', site: 'Default' },
        { siteID: 'tenant-a', site: 'Tenant A' },
      ]);
      expect(request).toMatchObject({
        user: { sub: SUBJECTS.admin.sub, site: 'default' },
        roles: SUBJECTS.admin.roles,
        isLoggedIn: true,
        isS2: true,
        isSiteAdmin: false,
        isPrivateUser: true,
      });
      expect(request.modulePerm(PLUGIN_MODULE)).toBe(true);
    });

    const SESSION_READS = ['identity /v1/sessions/current', 'identity /v1/sessions/current/admin-state'];

    it.each<[string, WebTestSubjectKey, Partial<MintUserTokenInput>, string[], boolean]>([
      ['anonymous', 'anonymous', {}, ['programs-sites /v1/href-domains'], false],
      [
        'an anonymous-session token',
        'member',
        { sub: '' },
        [...SESSION_READS, 'programs-sites /v1/href-domains'],
        false,
      ],
      ['a member', 'member', {}, SESSION_READS, true],
    ])('loads no site list for %s', async (_label, subject, claims, calls, isLoggedIn) => {
      const { request, gateway } = await build({ subject, claims, target: '/admin/' });

      expect(callsOf(gateway)).toEqual(calls);
      expect(request.session.siteArray).toEqual([]);
      expect(request.adminSites).toEqual([]);
      expect(request.isLoggedIn).toBe(isLoggedIn);
      expect(request.isPrivateUser).toBe(false);
      expect(request.modulePerm(CONTENT_MODULE)).toBe(false);
    });

    it('starts an anonymous request from the anonymous user struct', async () => {
      const { request } = await build({ subject: 'anonymous', target: '/admin/' });

      expect(request.user).toBeUndefined();
      expect(request.roles).toEqual([]);
      expect(request.session).toMatchObject({
        siteid: 'default',
        mura: { isLoggedIn: false, userID: '' },
        alerts: { default: {} },
        s2IsPrivate: false,
      });
      expect(request.site).toBeUndefined();
    });

    it.each<[keyof typeof sessionPresets, WebTestSubjectKey]>([
      ['admin', 'admin'],
      ['qaEditor', 'qaEditor'],
      ['tenantASiteAdmin', 'siteAdmin'],
      ['noSites', 'member'],
    ])('reads the private-pool flags of the %s session', async (preset, subject) => {
      const { mura, s2IsPrivate } = sessionPresets[preset];

      const { request } = await build({ subject, user: mura, target: '/admin/' });

      expect(request.session.mura).toMatchObject(mura);
      expect(request.session.s2IsPrivate).toBe(s2IsPrivate);
      expect(request.isPrivateUser).toBe(s2IsPrivate);
    });

    it.each<[string, WebTestSubjectKey, Partial<MintUserTokenInput>, boolean]>([
      ['the m:008 role', 'qaEditor', { roles: [Roles.systemUser, moduleRole(USERS_MODULE)] }, true],
      ['S2', 'admin', {}, true],
      ['a system user without it', 'systemUser', {}, false],
    ])('reads the Users module permission of %s', async (_label, subject, claims, granted) => {
      const { request } = await build({ subject, claims, target: '/admin/' });

      expect(request.modulePerm(USERS_MODULE)).toBe(granted);
    });

    it('reads alerts as type and text strings', async () => {
      const { request } = await build({
        subject: 'qaEditor',
        target: '/admin/',
        user: { alerts: { Default: { a1: { type: 'info', text: 'Hi' }, a2: null, a3: { type: 5 } }, junk: 'x' } },
      });

      expect(request.session.alerts).toEqual({
        Default: { a1: { type: 'info', text: 'Hi' }, a2: { type: '', text: '' }, a3: { type: '5', text: '' } },
        junk: {},
      });
      expect(request.sessionWrites.alerts).toBeUndefined();
    });

    it.each<[string, FakeRouteTable, WebTestSubjectKey, WebServiceName, string, 401 | 403]>([
      ['a refused session', { [CURRENT_SESSION]: { status: 401 } }, 'admin', 'identity', 'getCurrentSession', 401],
      [
        'a refused site list',
        { [SESSION_SITES]: { status: 403 } },
        'qaEditor',
        'identity',
        'listCurrentSessionSites',
        403,
      ],
      ['a refused admin state', { [ADMIN_STATE]: { status: 401 } }, 'member', 'identity', 'getAdminSessionState', 401],
      [
        'an unauthenticated site read',
        { [siteRoute('default')]: { status: 401 } },
        'admin',
        'programs-sites',
        'getShellSite',
        401,
      ],
      [
        'a forbidden site read',
        { [siteRoute('default')]: { status: 403 } },
        'admin',
        'programs-sites',
        'getShellSite',
        403,
      ],
    ])('raises a GatewayDenialError on %s', async (_label, routes, subject, service, operation, status) => {
      const built = build({ subject, routes, target: '/admin/?siteid=default' });

      await expect(built).rejects.toBeInstanceOf(GatewayDenialError);
      await expect(built).rejects.toMatchObject({
        name: 'GatewayDenialError',
        service,
        operation,
        status,
        message: `${operation} answered HTTP ${status}`,
      });
    });

    it('fails on a failing site read', async () => {
      const built = build({ routes: { [siteRoute('default')]: { status: 500 } }, target: '/admin/?siteid=default' });

      await expect(built).rejects.toThrow('getShellSite answered HTTP 500');
      await expect(built).rejects.not.toBeInstanceOf(GatewayDenialError);
    });

    it('fails closed when the gateway is unavailable', async () => {
      const auth = await authFor(SUBJECTS.admin);
      const gateway = fakeGatewayClient({}, { userToken: auth.userToken });
      gateway.failWith();

      await expect(
        buildAdminRequest({
          params: {},
          searchParams: {},
          headers: new Headers({ [ORIGINAL_URL_HEADER]: '/admin/' }),
          auth,
          gateway,
          mode: 'page',
        }),
      ).rejects.toBeInstanceOf(GatewayUnavailableError);
    });
  });

  describe('session site', () => {
    it('names the site data programs-sites serves', async () => {
      const { request, gateway } = await build({ subject: 'siteAdmin', target: '/admin/?siteid=tenant-a' });

      expect(callsOf(gateway).filter((call) => call.startsWith('programs-sites'))).toEqual([
        'programs-sites /v1/sites/tenant-a/shell',
      ]);
      expect(request.site).toEqual({
        siteid: 'tenant-a',
        site: 'Tenant A',
        domain: 'tenant-a.example.test',
        siteLocale: 'German (Standard)',
        javaLocale: 'de_DE',
        publicUserPoolID: 'umbrella',
        privateUserPoolID: 'umbrella',
        displayPoolID: 'tenant-a',
        contentPoolID: 'tenant-a',
        categoryPoolID: 'umbrella',
        filePoolID: 'tenant-a',
        hasChangesets: true,
        hasComments: true,
        hasFeedManager: false,
        emailBroadcaster: true,
        extranet: false,
        cache: true,
        enableLockdown: 'development',
        lastDeployment: '2026-01-02 03:04:05',
        record: TENANT_A_RECORD,
      });
      expect(request.isSiteAdmin).toBe(true);
      expect(request.modulePerm(USERS_MODULE)).toBe(true);
      expect(request.session).toMatchObject({
        siteid: 'tenant-a',
        locale: 'de_DE',
        dateKeyFormat: 'DD.MM.YYYY',
        localeHasDayParts: false,
      });
    });

    it('names the served default fixture site', async () => {
      const record = siteById[SITE_IDS.default];

      const { request } = await build({
        target: `/admin/?muraAction=cusers.list&siteid=${SITE_IDS.default}`,
        routes: { [siteRoute(SITE_IDS.default)]: siteReply(record) },
      });

      expect(request.site).toMatchObject({
        siteid: SITE_IDS.default,
        site: record.Site,
        domain: record.Domain,
        publicUserPoolID: record.publicUserPoolID,
        privateUserPoolID: record.privateUserPoolID,
        hasFeedManager: true,
        emailBroadcaster: false,
        extranet: false,
        record,
      });
    });

    it('defaults unset pools to the site and unset values to empty', async () => {
      const { request } = await build({ target: '/admin/?siteid=default' });

      expect(request.site).toMatchObject({
        site: 'Default',
        siteLocale: '',
        javaLocale: 'en_US',
        publicUserPoolID: 'default',
        privateUserPoolID: 'default',
        displayPoolID: 'default',
        contentPoolID: 'default',
        categoryPoolID: 'default',
        filePoolID: 'default',
        hasChangesets: false,
        hasComments: false,
        hasFeedManager: true,
        extranet: true,
        enableLockdown: '',
        lastDeployment: null,
      });
    });

    it.each(
      (['qaEditor', 'systemUser', 'siteAdmin', 'admin'] as const).flatMap((subject) =>
        ([0, 1] as const).map((on) => [subject, on] as const),
      ),
    )('serves %s the flags of its site with every flag %i', async (subject, on) => {
      const siteId = SUBJECTS[subject].site;
      const record: SiteRecord = {
        SiteID: siteId,
        hasChangesets: on,
        hasComments: on,
        feedManager: on,
        EmailBroadcaster: on,
        Extranet: on,
        Cache: on,
        showDashboard: on,
      };
      const { request, gateway } = await build({
        subject,
        target: `/admin/?siteid=${siteId}`,
        routes: { [siteRoute(siteId)]: siteReply(record) },
      });

      const served = on === 1;
      expect(callsOf(gateway).filter((call) => call.startsWith('programs-sites'))).toEqual([
        `programs-sites /v1/sites/${siteId}/shell`,
      ]);
      expect(request.site).toMatchObject({
        siteid: siteId,
        hasChangesets: served,
        hasComments: served,
        hasFeedManager: served,
        emailBroadcaster: served,
        extranet: served,
        cache: served,
        record,
      });
    });

    it.each<WebTestSubjectKey>(['member', 'anonymous'])('reads no site data for %s', async (subject) => {
      const { request, gateway } = await build({ subject, target: `/admin/?siteid=${SUBJECTS[subject].site}` });

      expect(callsOf(gateway).filter((call) => call.startsWith('programs-sites /v1/sites'))).toEqual([]);
      expect(request.site).toBeUndefined();
    });

    it('serves an editor its pooled site under the site locale', async () => {
      const pool = 'umbrella';
      const record: SiteRecord = {
        SiteID: 'default',
        siteLocale: 'German (Standard)',
        theme: 'clean',
        publicUserPoolID: pool,
        privateUserPoolID: pool,
        displayPoolID: pool,
        contentPoolID: pool,
        categoryPoolID: pool,
        filePoolID: pool,
      };
      const { request } = await build({
        subject: 'qaEditor',
        target: '/admin/?siteid=default',
        routes: { [siteRoute('default')]: siteReply(record) },
      });

      expect(request.site).toMatchObject({
        siteid: 'default',
        siteLocale: 'German (Standard)',
        javaLocale: 'de_DE',
        publicUserPoolID: pool,
        privateUserPoolID: pool,
        displayPoolID: pool,
        contentPoolID: pool,
        categoryPoolID: pool,
        filePoolID: pool,
        record,
      });
      expect(request.session).toMatchObject({ siteid: 'default', locale: 'de_DE', dateKeyFormat: 'DD.MM.YYYY' });
      expect(request).toMatchObject({ isS2: false, isSiteAdmin: false, isPrivateUser: true });
      expect(request.modulePerm(CONTENT_MODULE)).toBe(true);
      expect(request.modulePerm(USERS_MODULE)).toBe(false);
      expect(request.modulePerm(PLUGIN_MODULE)).toBe(false);
    });

    it("takes a site other than the token's from the identity site list without reading it", async () => {
      const { request, gateway } = await build({
        subject: 'qaEditor',
        claims: { site: 'tenant-a' },
        target: '/admin/?siteid=default',
      });

      expect(callsOf(gateway).filter((call) => call.startsWith('programs-sites'))).toEqual([]);
      expect(request.site).toBeUndefined();
      expect(request.session).toMatchObject({ siteid: 'default', locale: 'en_US', dateKeyFormat: 'MM/DD/YYYY' });
    });

    it.each<[string, string, FakeRouteTable]>([
      ['a requested spelling', '/admin/?siteid=TENANT-A', {}],
      ['a stored spelling', '/admin/', { [ADMIN_STATE]: { status: 200, body: { siteid: 'TENANT-A' } } }],
    ])("reads the token's site under %s in another case", async (_label, target, routes) => {
      const { request, gateway } = await build({
        subject: 'qaEditor',
        claims: { site: 'tenant-a' },
        target,
        routes: { ...routes, [siteRoute('TENANT-A')]: siteChecked('tenant-a', siteReply(TENANT_A_RECORD)) },
      });

      expect(callsOf(gateway).filter((call) => call.startsWith('programs-sites'))).toEqual([
        'programs-sites /v1/sites/TENANT-A/shell',
      ]);
      expect(request.site).toMatchObject({ siteid: 'tenant-a', javaLocale: 'de_DE', record: TENANT_A_RECORD });
      expect(request.session).toMatchObject({ siteid: 'TENANT-A', locale: 'de_DE', dateKeyFormat: 'DD.MM.YYYY' });
    });

    it.each<[string, FakeReply, string]>([
      ['a new site', siteReply({ SiteID: 'default' }, 1), ''],
      ['a rejected id', { status: 400 }, ''],
    ])('reads existence of %s', async (_label, reply, siteid) => {
      const { request, gateway } = await build({
        target: '/admin/?siteid=default',
        routes: { [siteRoute('default')]: reply },
      });

      expect(request.session.siteid).toBe(siteid);
      expect(request.site).toBeUndefined();
      expect(callsOf(gateway).filter((call) => call.startsWith('programs-sites'))).toEqual([
        'programs-sites /v1/sites/default/shell',
      ]);
    });

    it('keeps the session site off an unknown site and reads the default site', async () => {
      const { request, gateway } = await build({ target: '/admin/?siteid=nosuch' });

      expect(callsOf(gateway).filter((call) => call.startsWith('programs-sites'))).toEqual([
        'programs-sites /v1/sites/default/shell',
      ]);
      expect(request.session.siteid).toBe('');
      expect(request.rc.siteid).toBe('nosuch');
      expect(request.site?.siteid).toBe('default');
      expect(request.session.alerts).toEqual({ '': {} });
    });

    it('records only the session values the request changed', async () => {
      const { request } = await build({
        target: `/admin/?siteid=default&moduleid=${USERS_MODULE}&frontEndProxyLoc=https://www.example.test`,
      });

      expect(request.sessionWrites).toEqual({
        siteid: 'default',
        userFilesPath: '/sites/default/assets/',
        topID: HOME_ID,
        locale: 'en_US',
        rb: 'en_US',
        dateKeyFormat: 'MM/DD/YYYY',
        alerts: { default: {} },
        moduleid: USERS_MODULE,
        frontEndProxyLoc: 'https://www.example.test',
      });
      expect(request.session).toMatchObject({ moduleid: USERS_MODULE, frontEndProxyLoc: 'https://www.example.test' });
    });
  });

  describe('registry domains of an anonymous-session token', () => {
    it.each<[string, string, string]>([
      ['a requested site the stored session site differs from', 'default', 'tenant-a'],
      ['a stored session site the requested site differs from', 'tenant-a', 'default'],
    ])("asks programs-sites for the token's site over %s", async (_label, storedSiteId, tokenSiteId) => {
      const domains = { allowedDomains: ['localhost', `${tokenSiteId}.example`], siteDomain: `${tokenSiteId}.example` };
      const { request, gateway } = await build({
        subject: 'member',
        claims: { sub: '', site: tokenSiteId },
        user: { isLoggedIn: false, userID: '' },
        target: `/admin/?muraAction=cusers.list&siteid=${tokenSiteId}`,
        headers: { 'x-forwarded-host': 'evil.example' },
        routes: {
          [ADMIN_STATE]: { status: 200, body: { siteid: storedSiteId } },
          [HREF_DOMAINS]: siteChecked(tokenSiteId, { status: 200, body: domains }),
        },
      });

      expect(request.isLoggedIn).toBe(false);
      expect(request.session.siteid).toBe(storedSiteId);
      expect(gateway.calls.filter(({ path }) => path === '/v1/href-domains')).toEqual([
        expect.objectContaining({ query: { siteid: tokenSiteId } }),
      ]);
      expect(request.hrefDomains).toEqual(domains);
      expect(secure(request)).toEqual({
        kind: 'redirect',
        location: expect.stringMatching(
          new RegExp(`^\\./\\?muraAction=cLogin\\.main&returnURL=http%3A%2F%2F${tokenSiteId}\\.example%2Fadmin%2F`),
        ),
      });
    });
  });

  describe('advanced search', () => {
    it('keeps each complete criterion of param', async () => {
      const { request } = await build({
        subject: 'qaEditor',
        mode: 'redirect',
        received: { muraAction: 'cusers.advancedsearch' },
        form: new URLSearchParams({
          param: '1,2,3',
          paramField1: 'tusers.lname',
          paramRelationship1: 'and',
          paramCriteria1: 'Smith',
          paramCondition1: 'Contains',
          paramField2: 'select field',
          paramField3: 'tusers.fname',
          paramCriteria3: '',
          inActive: '1',
          categoryID: 'C1',
          groupID: 'G1',
          membersOnly: 'true',
        }),
      });

      expect(request.session).toMatchObject({
        paramArray: [{ Field: 'tusers.lname', Relationship: 'and', Criteria: 'Smith', Condition: 'Contains' }],
        paramCount: 1,
        paramCircuit: 'cusers',
        inActive: '1',
        paramCategories: 'C1',
        paramGroups: 'G1',
        membersOnly: 'true',
        visitorStatus: 'All',
      });
      expect(request.sessionWrites).not.toHaveProperty('visitorStatus');
    });

    it('fails as CFML on an undefined criterion element', async () => {
      const error = await build({
        subject: 'qaEditor',
        target: '/admin/?muraAction=cusers.search&param=1&paramField1=tusers.lname&paramCriteria1=x',
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toMatch(/^Element PARAMRELATIONSHIP1 is undefined in a CFML structure/);
    });
  });

  describe('locale and resource bundle', () => {
    it.each<[string, Record<string, string>, Partial<AdminSessionState>]>([
      [
        'the default settings',
        {},
        { rb: 'en_US', locale: 'en_US', dateKeyFormat: 'MM/DD/YYYY', localeHasDayParts: true, dashboardSpan: 30 },
      ],
      [
        'configured settings',
        { MURA_LOCALE: 'en_GB', MURA_SESSIONHISTORY: '7' },
        { rb: 'en_GB', locale: 'en_GB', dateKeyFormat: 'DD/MM/YYYY', localeHasDayParts: false, dashboardSpan: 7 },
      ],
    ])('sets the session locale and span from %s', async (_label, vars, expected) => {
      useSettings(vars);

      const { request } = await build({ subject: 'qaEditor', target: '/admin/' });

      expect(request.session).toMatchObject(expected);
      expect(request.session.dateKey.dateKeyFormat).toBe(expected.dateKeyFormat);
    });

    it('takes session.rb from the client under the Client locale', async () => {
      useSettings({ MURA_LOCALE: 'Client' });

      const { request } = await build({
        subject: 'siteAdmin',
        target: '/admin/?siteid=tenant-a',
        headers: { 'accept-language': 'fr-FR,fr;q=0.9' },
      });

      expect(request.session).toMatchObject({ rb: 'fr-FR,fr', locale: 'de_DE' });
    });

    it('takes session.rb from rc.rb', async () => {
      const { request } = await build({ subject: 'qaEditor', target: '/admin/?rb=pt_BR' });

      expect(request.session.rb).toBe('pt_BR');
      expect(request.sessionWrites.rb).toBe('pt_BR');
      expect(request.pendingSetCookies).toEqual([
        expect.stringMatching(setCookie('rb=', 'HttpOnly;SameSite=Lax;')),
        expect.stringMatching(setCookie('RB=pt%5FBR', 'HttpOnly;SameSite=Lax;')),
        expect.stringMatching(setCookie('ADMINCONTROLWIDTH=300', '')),
        expect.stringMatching(setCookie('ADMINSIDEBAR=off', '')),
      ]);
      expect(request.cookies.get('RB')).toBe('pt%5FBR');
    });
  });

  describe('cookies', () => {
    it.each<[string, string | undefined, string[], Record<string, string>]>([
      [
        'no cookie',
        undefined,
        ['rb=', 'ADMINCONTROLWIDTH=300', 'ADMINSIDEBAR=off'],
        { rb: '', ADMINCONTROLWIDTH: '300', ADMINSIDEBAR: 'off' },
      ],
      ['an rb cookie', 'rb=fr', ['ADMINCONTROLWIDTH=300', 'ADMINSIDEBAR=off'], { rb: 'fr' }],
      ['a width cookie', 'rb=fr; ADMINCONTROLWIDTH=250', ['ADMINSIDEBAR=off'], { ADMINCONTROLWIDTH: '250' }],
      ['every cookie in another case', 'RB=fr; adminsidebar=on; AdminControlWidth=250', [], { adminsidebar: 'on' }],
    ])('queues the admin cookies under %s', async (_label, cookie, pairs, values) => {
      const { request } = await build({
        subject: 'qaEditor',
        target: '/admin/',
        headers: cookie === undefined ? {} : { cookie },
      });

      expect(request.pendingSetCookies).toEqual(
        pairs.map((pair) => expect.stringMatching(setCookie(pair, pair === 'rb=' ? 'HttpOnly;SameSite=Lax;' : ''))),
      );
      for (const [name, value] of Object.entries(values)) expect(request.cookies.get(name)).toBe(value);
    });

    it('marks them secure under secureCookies', async () => {
      useSettings({ MURA_SECURECOOKIES: 'true' });

      const { request } = await build({ subject: 'qaEditor', target: '/admin/' });

      expect(request.pendingSetCookies).toEqual([
        expect.stringMatching(setCookie('rb=', 'secure;HttpOnly;SameSite=Lax;')),
        expect.stringMatching(setCookie('ADMINCONTROLWIDTH=300', 'secure;')),
        expect.stringMatching(setCookie('ADMINSIDEBAR=off', 'secure;')),
      ]);
    });
  });

  describe('request flags', () => {
    it.each<[string, Record<string, string>, Partial<AdminRequest>]>([
      [
        'a forwarded HTTPS host',
        {
          'x-forwarded-host': 'admin.example.test:8443',
          'x-forwarded-proto': 'https',
          'user-agent': 'Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1)',
        },
        { serverName: 'admin.example.test', httpHost: 'admin.example.test:8443', https: true, isMSIE: true },
      ],
      [
        'a forwarded IPv6 host list',
        { 'x-forwarded-host': '[::1]:20101, proxy.example.test', 'x-forwarded-proto': 'HTTPS, http' },
        { serverName: '[::1]', httpHost: '[::1]:20101', https: true, isMSIE: false },
      ],
      ['no forwarding headers', {}, { serverName: '', httpHost: '', https: false, isMSIE: false, userAgent: '' }],
    ])('reads %s', async (_label, headers, expected) => {
      const { request } = await build({ subject: 'qaEditor', target: '/admin/', headers });

      expect(request).toMatchObject(expected);
      expect(request.headers.get(ORIGINAL_URL_HEADER)).toBe('/admin/');
    });

    // Legacy layouts test `cgi.http_user_agent contains 'msie'`, so IE 11's Trident-only agent is not MSIE.
    it.each<[string, string, boolean]>([
      ['MSIE 10.0', 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.1; Trident/6.0)', true],
      ['Trident/7.0', 'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko', false],
      [
        'Chrome',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        false,
      ],
    ])('reads isMSIE of a %s user agent', async (_label, userAgent, isMSIE) => {
      const { request } = await build({ subject: 'qaEditor', target: '/admin/', headers: { 'user-agent': userAgent } });

      expect(request).toMatchObject({ userAgent, isMSIE });
    });
  });

  describe('reverse permission lookup', () => {
    const lookupReply = (granted: boolean): FakeRouteTable => ({
      [REVERSE_LOOKUP]: { status: 200, body: { granted } },
    });

    it.each<[string, WebTestSubjectKey, Partial<MintUserTokenInput>, boolean]>([
      ['anonymous', 'anonymous', {}, false],
      ['an anonymous-session token', 'member', { sub: '' }, false],
      ['Users module access', 'qaEditor', { roles: [Roles.systemUser, moduleRole(USERS_MODULE)] }, true],
      ['S2', 'admin', {}, true],
      ['the site admin', 'siteAdmin', {}, true],
    ])('answers %s without asking identity', async (_label, subject, claims, granted) => {
      const { request, gateway } = await build({ subject, claims, target: '/admin/', routes: lookupReply(!granted) });
      gateway.reset();

      await expect(request.reversePermLookUp()).resolves.toBe(granted);
      expect(gateway.calls).toEqual([]);
    });

    it.each([true, false])('reads identity once per request for any other user, answering %s', async (granted) => {
      const { request, gateway } = await build({
        subject: 'qaEditor',
        target: '/admin/',
        routes: lookupReply(granted),
      });
      expect(callsOf(gateway)).not.toContain('identity /v1/permissions/reverse-lookup');
      gateway.reset();

      expect(await Promise.all([request.reversePermLookUp(), request.reversePermLookUp()])).toEqual([granted, granted]);
      await expect(request.reversePermLookUp()).resolves.toBe(granted);
      expect(gateway.calls).toEqual([
        { service: 'identity', method: 'GET', path: '/v1/permissions/reverse-lookup', userToken: expect.any(String) },
      ]);
    });

    it.each<[string, number, typeof GatewayDenialError | typeof GatewayUnavailableError, Record<string, unknown>]>([
      [
        'a refused lookup',
        401,
        GatewayDenialError,
        { operation: 'getReversePermLookUp', message: 'getReversePermLookUp answered HTTP 401' },
      ],
      ['an unavailable identity', 503, GatewayUnavailableError, {}],
    ])('propagates %s', async (_label, status, type, fields) => {
      const { request } = await build({
        subject: 'qaEditor',
        target: '/admin/',
        routes: { [REVERSE_LOOKUP]: { status } },
      });
      const lookedUp = request.reversePermLookUp();

      await expect(lookedUp).rejects.toBeInstanceOf(type);
      await expect(lookedUp).rejects.toMatchObject({ service: 'identity', status, ...fields });
    });
  });
});

describe('admin session state', () => {
  type StoredState = Record<string, unknown>;

  /** Identity's admin-state routes over one session: reads answer the stored state, saves lay their keys over it. */
  function identityStore(initial: StoredState = {}): { readonly routes: FakeRouteTable; state(): StoredState } {
    let stored: StoredState = { ...initial };
    return {
      routes: {
        [ADMIN_STATE]: () => ({ status: 200, body: stored }),
        [SAVE_ADMIN_STATE]: (request) => {
          stored = { ...stored, ...(request.json as StoredState) };
          return { status: 200, body: stored };
        },
      },
      state: () => stored,
    };
  }

  /** One request over `store`, its session writes then persisted as the request pipeline persists them. */
  async function roundTrip(
    store: ReturnType<typeof identityStore>,
    call: Call,
  ): Promise<{ request: AdminRequest; gateway: FakeGatewayClient }> {
    const built = await build({ ...call, routes: { ...call.routes, ...store.routes } });
    const auth = await authFor(SUBJECTS[call.subject ?? 'admin'], call.claims);
    await saveSessionWrites(built.gateway, auth, built.request.sessionWrites);
    return built;
  }

  const saves = (gateway: FakeGatewayClient): unknown[] =>
    gateway.calls.filter((call) => call.method === 'POST').map((call) => call.json);

  it('keeps the site a request switched to on the next request without a siteid', async () => {
    const store = identityStore();

    const first = await roundTrip(store, { target: '/admin/?muraAction=cusers.list&siteid=tenant-a' });
    const second = await roundTrip(store, { target: '/admin/?muraAction=cusers.list' });

    const switched = { siteid: 'tenant-a', userFilesPath: '/sites/tenant-a/assets/', topID: HOME_ID };
    expect(saves(first.gateway)).toEqual([expect.objectContaining(switched)]);
    expect(saves(first.gateway)[0]).not.toHaveProperty('alerts');
    expect(second.request.session).toMatchObject(switched);
    expect(second.request.rc.siteid).toBe('tenant-a');
    expect(second.request.sessionWrites).toEqual({ alerts: { 'tenant-a': {} } });
    expect(saves(second.gateway)).toEqual([]);
  });

  it.each<[string, string, 'rb' | 'moduleid' | 'frontEndProxyLoc', string]>([
    ['the resource bundle', 'rb=pt_BR', 'rb', 'pt_BR'],
    ['the module', `moduleid=${USERS_MODULE}`, 'moduleid', USERS_MODULE],
    [
      'the compact proxy location',
      'frontEndProxyLoc=https://www.example.test',
      'frontEndProxyLoc',
      'https://www.example.test',
    ],
  ])('keeps %s a request set on the next request', async (_label, query, key, value) => {
    const store = identityStore();

    await roundTrip(store, { subject: 'qaEditor', target: `/admin/?muraAction=cusers.list&${query}` });
    const { request } = await roundTrip(store, { subject: 'qaEditor', target: '/admin/?muraAction=cusers.list' });

    expect(store.state()[key]).toBe(value);
    expect(request.session[key]).toBe(value);
    expect(request.sessionWrites).not.toHaveProperty(key);
  });

  it('restores the advanced search on the next request', async () => {
    const store = identityStore();
    const search = {
      paramArray: [{ Field: 'tusers.lname', Relationship: 'and', Criteria: 'Smith', Condition: 'Contains' }],
      paramCount: 1,
      paramCircuit: 'cusers',
      inActive: '1',
      paramCategories: 'C1',
      paramGroups: 'G1',
      membersOnly: 'true',
    };

    await roundTrip(store, {
      subject: 'qaEditor',
      mode: 'redirect',
      received: { muraAction: 'cusers.advancedsearch' },
      form: new URLSearchParams({
        param: '1',
        paramField1: 'tusers.lname',
        paramRelationship1: 'and',
        paramCriteria1: 'Smith',
        paramCondition1: 'Contains',
        inActive: '1',
        categoryID: 'C1',
        groupID: 'G1',
        membersOnly: 'true',
      }),
    });
    const { request } = await roundTrip(store, {
      subject: 'qaEditor',
      target: '/admin/?muraAction=cusers.advancedsearch',
    });

    expect(store.state()).toMatchObject(search);
    expect(request.session).toMatchObject({ ...search, visitorStatus: 'All' });
    expect(Object.keys(request.sessionWrites).filter((key) => key in search)).toEqual([]);
  });

  it.each<[string, string, Record<string, string | undefined>]>([
    ['the stored flash context fw1pk names, without overwriting rc', '&fw1pk=3', { msg: 'Saved', siteid: 'default' }],
    ['no stored flash context without fw1pk', '', { msg: undefined, siteid: 'default' }],
  ])('restores %s', async (_label, query, rc) => {
    const flash = { '3': { msg: 'Saved', siteid: 'tenant-a' } };
    const store = identityStore({ flash, nextPreserveKey: 4 });

    const { request } = await roundTrip(store, {
      subject: 'qaEditor',
      target: `/admin/?muraAction=cusers.list&siteid=default${query}`,
    });

    expect({ msg: request.rc.msg, siteid: request.rc.siteid }).toEqual(rc);
    expect(request.session).toMatchObject({ flash, nextPreserveKey: 4 });
    expect(request.sessionWrites).not.toHaveProperty('flash');
    expect(request.sessionWrites).not.toHaveProperty('nextPreserveKey');
  });

  it('starts every value the set-up leaves alone from the stored state', async () => {
    const stored = {
      siteid: 'default',
      userFilesPath: '/sites/default/assets/',
      topID: 'C0000000-0000-0000-0000000000000001',
      openSectionList: 'S1,S2',
      moduleid: USERS_MODULE,
      keywords: 'smith',
      rb: 'fr_FR',
      paramArray: [],
      paramCount: 0,
      paramCircuit: 'cusers',
      paramCategories: '',
      paramGroups: '',
      inActive: '0',
      membersOnly: 'false',
      visitorStatus: 'Members',
      frontEndProxyLoc: 'https://www.example.test',
      flash: {},
      nextPreserveKey: 7,
    };

    const { request } = await build({ subject: 'qaEditor', target: '/admin/', routes: identityStore(stored).routes });

    expect(request.session).toMatchObject(stored);
    expect(Object.keys(request.sessionWrites).filter((key) => key in stored)).toEqual([]);
  });

  it('replaces a stored dashboard span with the configured one, as every request does', async () => {
    useSettings({ MURA_SESSIONHISTORY: '7' });

    const { request } = await build({
      subject: 'qaEditor',
      target: '/admin/',
      routes: identityStore({ dashboardSpan: 30 }).routes,
    });

    expect(request.session.dashboardSpan).toBe(7);
    expect(request.sessionWrites.dashboardSpan).toBe(7);
  });

  it.each<[string, StoredState, boolean]>([
    ['a stored true', { hasdefaultpassword: true }, true],
    ['a stored false', { hasdefaultpassword: false }, true],
    ['no stored key', {}, false],
  ])('reads session.hasdefaultpassword as defined for %s', async (_label, stored, defined) => {
    const { request } = await build({ subject: 'admin', target: '/admin/', routes: identityStore(stored).routes });

    expect(request.session.hasDefaultPassword).toBe(defined);
  });

  it("lays the stored post-login values over identity's user struct by case-insensitive name", async () => {
    const moduleTopIds = { m00000000000000000000000000000000000: 'C1', m00000000000000000000000000000000003: 'C3' };
    const mura = { FNAME: 'Adele', errors: '', objectInstanceId: 'I1' };

    const { request } = await build({
      subject: 'qaEditor',
      target: '/admin/',
      user: { fname: 'Ada', Errors: { name: 'Bad' } },
      routes: identityStore({ moduleTopIds, mura }).routes,
    });

    expect(request.session.mura).toMatchObject({ fname: 'Adele', Errors: '', objectInstanceId: 'I1' });
    expect(request.session.mura).not.toHaveProperty('FNAME');
    expect(request.session.muraValues).toEqual(mura);
    expect(request.session.moduleTopIds).toEqual(moduleTopIds);
    expect(Object.keys(request.sessionWrites).filter((key) => ['muraValues', 'moduleTopIds'].includes(key))).toEqual([]);
  });

  describe('setSessionMuraValue', () => {
    it('sets the value on the request and queues the post-login values, which the next request restores', async () => {
      const store = identityStore({ mura: { objectInstanceId: 'I1' } });
      const first = await build({
        subject: 'qaEditor',
        target: '/admin/',
        user: { Errors: { name: 'Bad' } },
        routes: store.routes,
      });

      setSessionMuraValue(first.request, 'errors', '');
      const auth = await authFor(SUBJECTS.qaEditor);
      await saveSessionWrites(first.gateway, auth, first.request.sessionWrites);
      const second = await build({ subject: 'qaEditor', target: '/admin/', user: { Errors: { name: 'Bad' } }, routes: store.routes });

      expect(first.request.session.mura).toMatchObject({ Errors: '', objectInstanceId: 'I1' });
      expect(first.request.session.muraValues).toEqual({ objectInstanceId: 'I1', errors: '' });
      expect(first.request.sessionWrites.muraValues).toBe(first.request.session.muraValues);
      expect(store.state()['mura']).toEqual({ objectInstanceId: 'I1', errors: '' });
      expect(second.request.session.mura).toMatchObject({ Errors: '', objectInstanceId: 'I1' });
    });

    it.each<[string, Partial<SessionUser>, StoredState]>([
      ['the user struct', { errors: '' }, {}],
      ['the stored post-login values', {}, { mura: { ERRORS: '' } }],
    ])('queues nothing when %s already holds the value', async (_label, user, stored) => {
      const { request } = await build({ subject: 'qaEditor', target: '/admin/', user, routes: identityStore(stored).routes });
      const { mura, muraValues } = request.session;

      setSessionMuraValue(request, 'errors', '');

      expect(request.session.mura).toBe(mura);
      expect(request.session.muraValues).toBe(muraValues);
      expect(request.sessionWrites).not.toHaveProperty('muraValues');
    });

    it('leaves the session it is given unchanged in its pure form', () => {
      const session = { mura: { isLoggedIn: true, userID: 'U1', Errors: { a: 'A' } }, muraValues: {} };

      const next = withSessionMuraValue(session, 'errors', '');

      expect(next).toEqual({ mura: { isLoggedIn: true, userID: 'U1', Errors: '' }, muraValues: { errors: '' } });
      expect(session).toEqual({ mura: { isLoggedIn: true, userID: 'U1', Errors: { a: 'A' } }, muraValues: {} });
    });
  });

  describe('saveSessionWrites', () => {
    it("sends the post-login values as identity's mura and never the login-set default-password flag", async () => {
      const store = identityStore({ hasdefaultpassword: true });
      const { request, gateway } = await build({ subject: 'admin', target: '/admin/', routes: store.routes });
      const auth = await authFor(SUBJECTS.admin);
      setSessionMuraValue(request, 'objectInstanceId', 'I2');

      await saveSessionWrites(gateway, auth, request.sessionWrites);

      const [saved] = saves(gateway) as Array<Record<string, unknown>>;
      expect(saved?.['mura']).toEqual({ objectInstanceId: 'I2' });
      expect(saved?.['mura']).not.toBe(request.session.muraValues);
      expect(Object.keys(saved ?? {}).filter((key) => /muraValues|hasdefaultpassword/i.test(key))).toEqual([]);
      expect(store.state()).toMatchObject({ hasdefaultpassword: true, mura: { objectInstanceId: 'I2' } });
    });

    it('sends the writes but alerts in one save', async () => {
      const auth = await authFor(SUBJECTS.qaEditor);
      const gateway = fakeGatewayClient(identityStore().routes, { userToken: auth.userToken });
      const paramArray = [{ Field: 'tusers.fname', Relationship: 'or', Criteria: 'Ann', Condition: 'Equals' }];

      await saveSessionWrites(gateway, auth, { alerts: { default: {} }, siteid: 'default', paramArray });

      expect(gateway.calls).toEqual([
        expect.objectContaining({
          service: 'identity',
          method: 'POST',
          path: '/v1/sessions/current/admin-state',
          json: { siteid: 'default', paramArray },
        }),
      ]);
    });

    it.each<[string, WebTestSubjectKey, Parameters<typeof saveSessionWrites>[2]]>([
      ['no writes', 'qaEditor', {}],
      ['only alerts', 'qaEditor', { alerts: { default: {} } }],
      ['no user token', 'anonymous', { siteid: 'default' }],
    ])('sends nothing for %s', async (_label, subject, writes) => {
      const auth = await authFor(SUBJECTS[subject]);
      const gateway = fakeGatewayClient(identityStore().routes, { userToken: auth.userToken });

      await saveSessionWrites(gateway, auth, writes);

      expect(gateway.calls).toEqual([]);
    });

    it.each<[number, string | typeof GatewayUnavailableError]>([
      [400, 'saveAdminSessionState answered HTTP 400'],
      [500, 'saveAdminSessionState answered HTTP 500'],
      [503, GatewayUnavailableError],
    ])('fails on an HTTP %i answer', async (status, error) => {
      const auth = await authFor(SUBJECTS.qaEditor);
      const gateway = fakeGatewayClient({ [SAVE_ADMIN_STATE]: { status } }, { userToken: auth.userToken });
      const saved = saveSessionWrites(gateway, auth, { siteid: 'default' });

      await expect(saved).rejects.toThrow(error);
      await expect(saved).rejects.not.toBeInstanceOf(GatewayDenialError);
    });

    it.each<401 | 403>([401, 403])('raises a GatewayDenialError on an HTTP %i answer', async (status) => {
      const auth = await authFor(SUBJECTS.qaEditor);
      const gateway = fakeGatewayClient({ [SAVE_ADMIN_STATE]: { status } }, { userToken: auth.userToken });
      const saved = saveSessionWrites(gateway, auth, { siteid: 'default' });

      await expect(saved).rejects.toBeInstanceOf(GatewayDenialError);
      await expect(saved).rejects.toMatchObject({
        service: 'identity',
        operation: 'saveAdminSessionState',
        status,
        message: `saveAdminSessionState answered HTTP ${status}`,
      });
    });
  });
});
