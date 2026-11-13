// Unit tests for the admin alert block against admin/common/layouts/template.cfm 260-311.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { businessClock } from '@opt2/platform/testing';
import { resetLegacySettingsForTests } from '@/lib/env';
import { html, isSafeHtml, toString } from '@/lib/html';
import type { AdminAlert, AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { renderAlerts } from '@/shell/alerts';
import type { ShellContext, ShellUser } from '@/shell/types';
import { SITE_IDS } from '../fixtures/programs-sites/sites';
import { adminS2Session } from '../fixtures/session';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../helpers/admin-request';
import { fragmentModel, type DomAlert } from '../helpers/dom-model';
import { SESSION_SITE_CASES } from '../helpers/requested-site';

type SiteAlerts = Readonly<Record<string, AdminAlert>>;

const rb = rbFor('en_US');

/** The en labels of the three notices, whitespace collapsed as the DOM model reads them. */
const LABELS = {
  passwordexpirednotice:
    'The password associated with the account you have logged in with has expired. Please update your profile as soon as possible.',
  defaultpasswordnotice:
    "You are currently logged in with Masa CMS's default super account credentials (u:admin / p:admin). It is highly recommended that you change this account's password.",
  cachenotice:
    'Caching for this site is currently not enabled. It is strongly recommended to turn caching on for production sites.',
} as const;

const { feedimportfailed, maintenanceinfo } = adminS2Session.alerts.default;
const SESSION_ALERTS: SiteAlerts = { feedimportfailed, maintenanceinfo };
const SESSION_IDS = ['feedimportfailed', 'maintenanceinfo'];

/** Dismissal as the session holds it once read through identity. */
const DISMISSED: AdminAlert = { type: '', text: '' };

/** Site flags that keep the cache notice off. */
const CACHED: AdminRequestPartial['site'] = { cache: true };

/** Every notice condition met for the user. */
const NOTICE_USER: Partial<ShellUser> = { passwordExpired: true, hasDefaultPassword: true };

/** The block's shell context over `ctx`, with `user` members replacing the defaults. */
function shellFor(ctx: AdminRequest, user: Partial<ShellUser> = {}): ShellContext {
  return {
    ctx,
    view: { body: html`` },
    hooks: { secondaryMenus: {} },
    data: {
      rb,
      user: { fname: 'Admin', lname: 'User', passwordExpired: false, hasDefaultPassword: false, ...user },
      userSites: [{ siteId: SITE_IDS.default, site: 'Default', showDashboard: false }],
      prompts: { drafts: 0, submissions: 0, approvals: 0, expires: 0, pendingChangesets: 0 },
      sitePlugins: [],
      server: null,
      updateCoreCsrfQuery: '',
      exportLocationExists: false,
      now: businessClock().now(),
    },
    layout: 'template',
    originalCircuit: ctx.circuit,
    originalFuseaction: ctx.item,
    moduleTitle: '',
    bodyclass: '',
    siteId: ctx.rc.siteid || ctx.session.siteid || 'default',
  };
}

function render(ctx: AdminRequest, user?: Partial<ShellUser>): string {
  const markup = renderAlerts(shellFor(ctx, user));
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** `ctx` with its session alert map replaced whole. */
function withAlerts(ctx: AdminRequest, alerts: AdminRequest['session']['alerts']): AdminRequest {
  return { ...ctx, session: { ...ctx.session, alerts } };
}

const load = (markup: string) => cheerio.load(markup, null, false);

/** Dismiss ids of the rendered alerts, in document order. */
function idsOf(markup: string): string[] {
  const $ = load(markup);
  return $('div.alert')
    .toArray()
    .map((el) => $(el).find('a.alert-dismiss').attr('data-alertid') ?? '');
}

/** Dismiss ids as a set: the loop follows struct order, which CFML leaves unspecified. */
const idSetOf = (markup: string): Set<string> => new Set(idsOf(markup));

/** Each rendered alert's model keyed by its dismiss id. */
function alertsById(markup: string): Record<string, DomAlert> {
  const ids = idsOf(markup);
  const { alerts } = fragmentModel(markup);
  expect(alerts).toHaveLength(ids.length);
  return Object.fromEntries(alerts.map((alert, i) => [ids[i] ?? '', alert]));
}

/** Installs `vars` as the only `MURA_` variables. */
function useSettings(vars: Readonly<Partial<Record<string, string>>> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

beforeEach(() => useSettings());

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('renderAlerts audience', () => {
  it.each([
    {
      name: 'tenant-a site admin',
      ctx: () =>
        siteAdminRequest(SITE_IDS.tenantA, { site: CACHED, session: { alerts: { [SITE_IDS.tenantA]: SESSION_ALERTS } } }),
    },
    { name: 'S2 admin', ctx: () => adminS2Request({ site: CACHED, session: { alerts: { default: SESSION_ALERTS } } }) },
  ])('renders session alerts for the $name', ({ ctx }) => {
    expect(idSetOf(render(ctx()))).toEqual(new Set(SESSION_IDS));
  });

  it.each([
    { name: 'editor', ctx: () => editorRequest({ session: { alerts: { default: SESSION_ALERTS } } }) },
    { name: 'anonymous user', ctx: () => anonymousRequest({ session: { alerts: { default: SESSION_ALERTS } } }) },
    {
      name: 'S2 admin on the login page',
      ctx: () => adminS2Request({ circuit: 'cLogin', item: 'main', session: { alerts: { default: SESSION_ALERTS } } }),
    },
  ])('renders nothing for the $name', ({ ctx }) => {
    useSettings({ MURA_EXPIREPASSWORDS: '30' });
    expect(render(ctx(), NOTICE_USER)).toBe('');
  });

  it.each(SESSION_SITE_CASES)('renders session alerts for $who only when it administers that site', (testCase) => {
    const ctx = testCase.request({ site: CACHED, session: { alerts: { [testCase.siteid]: SESSION_ALERTS } } });
    expect(idSetOf(render(ctx))).toEqual(testCase.administers ? new Set(SESSION_IDS) : new Set());
  });

  it.each([
    ['a default site admin', { site: 'default', tid: tenantIdForSite('default') }, true],
    ['a tenant-a site admin', {}, false],
  ])('reads an empty session site as default, as getSite does, for %s', (_who, user, shown) => {
    const ctx = siteAdminRequest('', { user, site: CACHED, session: { alerts: { '': SESSION_ALERTS } } });
    expect(ctx.session.siteid).toBe('');
    expect(idSetOf(render(ctx))).toEqual(shown ? new Set(SESSION_IDS) : new Set());
  });

  it('renders nothing when no alert or notice is due', () => {
    expect(render(adminS2Request({ site: CACHED }))).toBe('');
  });

  it('reads only the session site bucket', () => {
    const ctx = siteAdminRequest(SITE_IDS.tenantA, {
      site: CACHED,
      session: {
        alerts: {
          [SITE_IDS.tenantA]: { mine: { type: 'info', text: 'Mine' } },
          [SITE_IDS.tenantB]: { theirs: { type: 'info', text: 'Theirs' } },
          [SITE_IDS.default]: SESSION_ALERTS,
        },
      },
    });
    expect(idsOf(render(ctx))).toEqual(['mine']);
  });

  it('finds the session site bucket in any case, the exact key first', () => {
    const ctx = siteAdminRequest(SITE_IDS.tenantA, { site: CACHED });
    const upper = { mine: { type: 'info', text: 'Mine' } };
    expect(idsOf(render(withAlerts(ctx, { 'TENANT-A': upper })))).toEqual(['mine']);
    const both = { 'TENANT-A': { theirs: { type: 'info', text: 'Theirs' } }, [SITE_IDS.tenantA]: upper };
    expect(idsOf(render(withAlerts(ctx, both)))).toEqual(['mine']);
  });

  it('treats a missing session site bucket as nothing dismissed', () => {
    const ctx = withAlerts(siteAdminRequest(SITE_IDS.tenantA), { [SITE_IDS.tenantB]: { cachenotice: DISMISSED } });
    expect(idsOf(render(ctx))).toEqual(['cachenotice']);
  });
});

describe('renderAlerts session loop', () => {
  it('renders each alert with its dismiss link and unencoded text', () => {
    const markup = render(adminS2Request({ site: CACHED, session: { alerts: { default: SESSION_ALERTS } } }));
    expect(alertsById(markup)).toEqual({
      feedimportfailed: { className: 'alert alert-error', text: 'The synthetic feed import did not finish.' },
      maintenanceinfo: { className: 'alert alert-info', text: 'Maintenance is planned for July 1. Details' },
    });
    const $ = load(markup);
    expect($('div.alert > span > a.close.alert-dismiss[data-dismiss="alert"] > i.mi-close').length).toBe(2);
    expect($('div.alert-info strong').text()).toBe('July 1');
    expect($('div.alert-info > a').attr('href')).toBe('./?muraAction=cDashboard.main');
  });

  it('places the text after the dismiss span', () => {
    const markup = render(adminS2Request({ site: CACHED, session: { alerts: { default: { maintenanceinfo } } } }));
    expect(markup).toBe(
      '<div class="alert alert-info">\n' +
        '\t<span>\n' +
        '\t\t<a data-alertid="maintenanceinfo" class="close alert-dismiss" data-dismiss="alert"><i class="mi-close"></i></a>\n' +
        '\t</span>\n' +
        `\t${maintenanceinfo.text}\n` +
        '</div>\n',
    );
  });

  it('HTML-encodes the type but not the id', () => {
    const alerts = { 'note&1': { type: 'warn"ing', text: 'Typed' } };
    const markup = render(adminS2Request({ site: CACHED, session: { alerts: { default: alerts } } }));
    expect(markup).toContain('<div class="alert alert-warn&quot;ing">');
    expect(markup).toContain('data-alertid="note&1"');
  });

  it('skips defaultpasswordnotice and cachenotice in any case', () => {
    const alerts = { DefaultPasswordNotice: { type: 'info', text: 'Stored' }, CACHENOTICE: DISMISSED, kept: maintenanceinfo };
    const ctx = adminS2Request({ rc: { renderMuraAlerts: 'false' }, session: { alerts: { default: alerts } } });
    expect(idsOf(render(ctx))).toEqual(['kept']);
  });

  it('renders a stored passwordexpirednotice and suppresses the notice', () => {
    useSettings({ MURA_EXPIREPASSWORDS: '30' });
    const alerts = { PasswordExpiredNotice: { type: '', text: 'Stored' } };
    const markup = render(adminS2Request({ site: CACHED, session: { alerts: { default: alerts } } }), NOTICE_USER);
    expect(alertsById(markup)).toEqual({
      PasswordExpiredNotice: { className: 'alert alert-error', text: 'Stored' },
      defaultpasswordnotice: { className: 'alert alert-error', text: LABELS.defaultpasswordnotice },
    });
  });
});

describe('renderAlerts Masa notices', () => {
  it.each([
    { name: 'shows when passwords expire and this one has', vars: { MURA_EXPIREPASSWORDS: '30' }, expired: true, shown: true },
    { name: 'hides when expirePasswords is 0', vars: { MURA_EXPIREPASSWORDS: '0' }, expired: true, shown: false },
    { name: 'hides when expirePasswords is unset', vars: {}, expired: true, shown: false },
    { name: 'hides when expirePasswords is not numeric', vars: { MURA_EXPIREPASSWORDS: 'thirty' }, expired: true, shown: false },
    { name: 'hides when the password has not expired', vars: { MURA_EXPIREPASSWORDS: '30' }, expired: false, shown: false },
  ])('password-expired notice $name', ({ vars, expired, shown }) => {
    useSettings(vars);
    const markup = render(adminS2Request({ site: CACHED }), { passwordExpired: expired });
    expect(alertsById(markup)).toEqual(
      shown ? { passwordexpirednotice: { className: 'alert alert-error', text: LABELS.passwordexpirednotice } } : {},
    );
  });

  it.each([
    { name: 'shows when the login flagged a default password', flagged: true, alerts: {}, shown: true },
    { name: 'hides without the flag', flagged: false, alerts: {}, shown: false },
    { name: 'hides once dismissed', flagged: true, alerts: { DEFAULTPASSWORDNOTICE: DISMISSED }, shown: false },
  ])('default-password notice $name', ({ flagged, alerts, shown }) => {
    const ctx = adminS2Request({ site: CACHED, session: { alerts: { default: alerts } } });
    expect(alertsById(render(ctx, { hasDefaultPassword: flagged }))).toEqual(
      shown ? { defaultpasswordnotice: { className: 'alert alert-error', text: LABELS.defaultpasswordnotice } } : {},
    );
  });

  it.each([
    { name: 'shows when caching is off and the site is not locked down', site: {}, alerts: {}, shown: true },
    { name: 'hides when caching is on', site: { cache: true }, alerts: {}, shown: false },
    { name: 'hides when the site is locked down', site: { enableLockdown: 'development' }, alerts: {}, shown: false },
    { name: 'hides once dismissed', site: {}, alerts: { CacheNotice: DISMISSED }, shown: false },
  ])('cache notice $name', ({ site, alerts, shown }) => {
    const ctx = adminS2Request({ site, session: { alerts: { default: alerts } } });
    expect(alertsById(render(ctx))).toEqual(
      shown ? { cachenotice: { className: 'alert alert-warning', text: LABELS.cachenotice } } : {},
    );
  });

  it('omits the cache notice without site data', () => {
    expect(render({ ...adminS2Request(), site: undefined })).toBe('');
  });

  it('renders the notices after the session alerts, in legacy order', () => {
    useSettings({ MURA_EXPIREPASSWORDS: '30' });
    const markup = render(adminS2Request({ session: { alerts: { default: SESSION_ALERTS } } }), NOTICE_USER);
    const ids = idsOf(markup);
    expect(new Set(ids.slice(0, 2))).toEqual(new Set(SESSION_IDS));
    expect(ids.slice(2)).toEqual(['passwordexpirednotice', 'defaultpasswordnotice', 'cachenotice']);
    expect(fragmentModel(markup).alerts.slice(2)).toEqual([
      { className: 'alert alert-error', text: LABELS.passwordexpirednotice },
      { className: 'alert alert-error', text: LABELS.defaultpasswordnotice },
      { className: 'alert alert-warning', text: LABELS.cachenotice },
    ]);
  });

  it('places the label inside the dismiss span', () => {
    expect(render(adminS2Request())).toBe(
      '<div class="alert alert-warning">\n' +
        '\t<span>\n' +
        '\t\t<a data-alertid="cachenotice" class="close alert-dismiss" data-dismiss="alert"><i class="mi-close"></i></a>\n' +
        `\t\t\t${rb.rbKey('layout.cachenotice')}\n` +
        '\t</span>\n' +
        '</div>\n',
    );
  });

  it.each([
    { name: 'the setting is off', vars: { MURA_RENDERMURAALERTS: 'false' }, rc: {} },
    { name: 'the request turns them off', vars: {}, rc: { renderMuraAlerts: 'no' } },
  ])('renders only session alerts when $name', ({ vars, rc }) => {
    useSettings({ ...vars, MURA_EXPIREPASSWORDS: '30' });
    const ctx = adminS2Request({ rc, session: { alerts: { default: SESSION_ALERTS } } });
    expect(idSetOf(render(ctx, NOTICE_USER))).toEqual(new Set(SESSION_IDS));
  });

  it('renders the notices when the request turns them on over the setting', () => {
    useSettings({ MURA_RENDERMURAALERTS: 'false' });
    const ctx = adminS2Request({ rc: { renderMuraAlerts: 'true' } });
    expect(idsOf(render(ctx, { hasDefaultPassword: true }))).toEqual(['defaultpasswordnotice', 'cachenotice']);
  });
});

