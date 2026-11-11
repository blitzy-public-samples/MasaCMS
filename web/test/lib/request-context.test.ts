// Tests of the legacy admin request set-up: FW/1 context, admin session, site data, cookies and request flags.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import type { MintUserTokenInput } from '@opt2/platform/testing';
import { authenticateRequest, type WebAuth } from '@/lib/auth';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import {
  ORIGINAL_URL_HEADER,
  applyDefaults,
  buildAdminRequest,
  dashboardSpanFor,
  mergeFw1Context,
  nextSessionSite,
  resolveAction,
  restoreFlashContext,
  type AdminMode,
  type AdminRequest,
  type AdminRequestInput,
  type AdminSessionState,
  type SiteData,
} from '@/lib/request-context';
import { useTestEnv } from '../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
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
const siteRoute = (siteId: string): string => routeKey('GET', 'programs-sites', `/v1/sites/${siteId}`);

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

const siteReply = (record: SiteRecord, isNew: 0 | 1 = 0): FakeReply => ({
  status: 200,
  body: { site: record, isNew, extendSets: [], imageSizes: [] },
});

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

/** Identity and programs-sites answers for `subject`: S2 users administer every site, others their own. */
function routesFor(subject: WebTestSubject, user: Partial<SessionUser> = {}): FakeRouteTable {
  const siteIds = subject.s2 ? Object.keys(SITE_NAMES) : [subject.site];
  return {
    [CURRENT_SESSION]: sessionReply(subject, user),
    [SESSION_SITES]: { status: 200, body: { sites: siteIds.map((siteID) => ({ siteID, site: SITE_NAMES[siteID] })) } },
    [siteRoute('default')]: siteReply(DEFAULT_RECORD),
    [siteRoute('tenant-a')]: siteReply(TENANT_A_RECORD),
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
    [['cusers'], { muraAction: 'cusers' }],
    [['cusers', 'list'], { muraAction: 'cusers.list' }],
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
        'identity /v1/sessions/current/sites',
        'programs-sites /v1/sites/default',
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

    it.each<[string, WebTestSubjectKey, Partial<MintUserTokenInput>, string[], boolean]>([
      ['anonymous', 'anonymous', {}, [], false],
      ['an anonymous-session token', 'member', { sub: '' }, ['identity /v1/sessions/current'], false],
      ['a member', 'member', {}, ['identity /v1/sessions/current'], true],
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

    it.each<[string, FakeRouteTable, WebTestSubjectKey, string]>([
      ['a refused session', { [CURRENT_SESSION]: { status: 401 } }, 'admin', 'getCurrentSession answered HTTP 401'],
      [
        'a refused site list',
        { [SESSION_SITES]: { status: 403 } },
        'qaEditor',
        'listCurrentSessionSites answered HTTP 403',
      ],
      ['a failing site read', { [siteRoute('default')]: { status: 500 } }, 'admin', 'getSite answered HTTP 500'],
    ])('fails on %s', async (_label, routes, subject, message) => {
      await expect(build({ subject, routes, target: '/admin/?siteid=default' })).rejects.toThrow(message);
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
        'programs-sites /v1/sites/tenant-a',
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

    it('takes an editor site from the identity site list without reading it', async () => {
      const { request, gateway } = await build({ subject: 'qaEditor', target: '/admin/?siteid=default' });

      expect(callsOf(gateway)).toEqual(['identity /v1/sessions/current', 'identity /v1/sessions/current/sites']);
      expect(request.site).toBeUndefined();
      expect(request.session).toMatchObject({ siteid: 'default', locale: 'en_US', dateKeyFormat: 'MM/DD/YYYY' });
      expect(request).toMatchObject({ isS2: false, isSiteAdmin: false, isPrivateUser: true });
      expect(request.modulePerm(CONTENT_MODULE)).toBe(true);
      expect(request.modulePerm(USERS_MODULE)).toBe(false);
      expect(request.modulePerm(PLUGIN_MODULE)).toBe(false);
    });

    it.each<[string, FakeReply, string]>([
      ['a new site', siteReply({ SiteID: 'default' }, 1), ''],
      ['a rejected id', { status: 400 }, ''],
      ['an unauthenticated read', { status: 401 }, 'default'],
      ['a forbidden read', { status: 403 }, 'default'],
    ])('reads existence of %s', async (_label, reply, siteid) => {
      const { request, gateway } = await build({
        target: '/admin/?siteid=default',
        routes: { [siteRoute('default')]: reply },
      });

      expect(request.session.siteid).toBe(siteid);
      expect(request.site).toBeUndefined();
      expect(callsOf(gateway).filter((call) => call.startsWith('programs-sites'))).toEqual([
        'programs-sites /v1/sites/default',
      ]);
    });

    it('keeps the session site off an unknown site and reads the default site', async () => {
      const { request, gateway } = await build({ target: '/admin/?siteid=nosuch' });

      expect(callsOf(gateway).filter((call) => call.startsWith('programs-sites'))).toEqual([
        'programs-sites /v1/sites/default',
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
  });
});
