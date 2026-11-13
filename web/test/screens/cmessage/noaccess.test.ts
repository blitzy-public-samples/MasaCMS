// cMessage.noaccess against admin/core/views/cmessage/noaccess.cfm and the admin/core/controllers/cmessage.cfc gate.
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secure, type GateDecision } from '@/lib/access-gate';
import { legacySettings, resetLegacySettingsForTests } from '@/lib/env';
import { encodeUrl, isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { cmessageScreens } from '@/screens/cmessage';
import { noaccessAdminEmail, noaccessGate, renderNoaccess, renderNoaccessBody } from '@/screens/cmessage/noaccess';
import type { PageScreen } from '@/screens/registry';
import { templateTitleText } from '@/shell/module-title';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  noSitesRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { domModel, fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The registry module loads every circuit; screen suites stand in for it with the shell hooks this page renders with.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const LEGACY_VIEW = readFileSync(
  new URL('../../../../admin/core/views/cmessage/noaccess.cfm', import.meta.url),
  'utf8',
);
const ADMIN_EMAIL_EXPRESSION = "#esapiEncode('url',application.configBean.getAdminEmail())#";
const MESSAGE =
  'You have successfully logged in. However, your user account has not been granted permission to access any sites. ' +
  'If you believe this is an error, contact the system administrator for assistance.';
const NOACCESS: AdminRequestPartial = { circuit: 'cmessage', item: 'noaccess' };

/** The legacy `<cfoutput>` markup with the admin-email expression evaluated for `email`. */
function expectedBody(email: string): string {
  const start = LEGACY_VIEW.indexOf('<cfoutput>');
  const end = LEGACY_VIEW.indexOf('</cfoutput>');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const parts = LEGACY_VIEW.slice(start + '<cfoutput>'.length, end).split(ADMIN_EMAIL_EXPRESSION);
  expect(parts).toHaveLength(2);
  return parts.join(encodeUrl(email));
}

/** Each element of `markup` as `tag[attribute names]`, in document order. */
function elementShapes(markup: string): string[] {
  const $ = cheerio.load(markup, null, false);
  return $('*')
    .toArray()
    .map((el) => `${$(el).prop('tagName') ?? ''}[${Object.keys($(el).attr() ?? {}).join(',')}]`);
}

/** The registered page definition of `cMessage.noaccess`. */
function noaccessScreen(): PageScreen<undefined> {
  const def = cmessageScreens.find((candidate) => candidate.action === 'noaccess');
  if (def?.mode !== 'page') throw new TypeError('cmessage.noaccess is not a registered page screen');
  return def;
}

/** The gate's decision for `req`, with the controller's `secure()` as a spy. */
async function gateFor(req: AdminRequest): Promise<{ decision: GateDecision; secureSpy: ReturnType<typeof vi.fn> }> {
  const secureSpy = vi.fn((): GateDecision => secure(req));
  const decision = await noaccessGate(req, { secure: secureSpy });
  return { decision, secureSpy };
}

/** Lays `vars` over `process.env` and drops the cached legacy settings. */
function stubSettings(vars: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  resetLegacySettingsForTests();
}

let restoreEnv: () => void;

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('renderNoaccessBody', () => {
  it.each(['admin@example.com', '', 'a"b<c>@x.com'])('reproduces the legacy view for %j', (email) => {
    const body = renderNoaccessBody(email);
    expect(isSafeHtml(body)).toBe(true);
    expect(toString(body).trim()).toBe(expectedBody(email).trim());
  });

  it('URL-encodes the address into the mailto link', () => {
    expect(toString(renderNoaccessBody('admin@example.com'))).toContain('href="mailto:admin%40example.com"');
  });

  it('models the heading, contact link and message', () => {
    const markup = toString(renderNoaccessBody('admin@example.com'));
    const model = fragmentModel(markup);
    expect(model.headings).toEqual(['Access Denied']);
    expect(model.links).toEqual([{ href: 'mailto:admin%40example.com', text: 'administrator' }]);
    expect(cheerio.load(markup, null, false)('p').text().replace(/\s+/g, ' ').trim()).toBe(MESSAGE);
  });

  it('links a bare mailto: for an empty address', () => {
    expect(fragmentModel(toString(renderNoaccessBody(''))).links).toEqual([{ href: 'mailto:', text: 'administrator' }]);
  });

  it('never injects markup from the address', () => {
    const email = 'a"b<c>@x.com';
    const markup = toString(renderNoaccessBody(email));
    expect(encodeUrl(email)).toBe('a%22b%3Cc%3E%40x.com');
    expect(cheerio.load(markup, null, false)('a').attr('href')).toBe(`mailto:${encodeUrl(email)}`);
    expect(elementShapes(markup)).toEqual(elementShapes(toString(renderNoaccessBody('admin@example.com'))));
  });
});

describe('renderNoaccess', () => {
  it('returns only the view body', () => {
    const view = renderNoaccess('admin@example.com');
    expect(Object.keys(view)).toEqual(['body']);
    expect(toString(view.body)).toBe(toString(renderNoaccessBody('admin@example.com')));
  });

  it('defaults to noaccessAdminEmail()', () => {
    stubSettings({ MURA_ADMINEMAIL: 'ops@example.com' });
    expect(toString(renderNoaccess().body)).toBe(toString(renderNoaccessBody(noaccessAdminEmail())));
  });

  it.each<[string | undefined, string]>([
    [undefined, 'mailto:'],
    ['ops@example.test', 'mailto:ops%40example.test'],
    // A CFML expression resolves to '', as for every MURA_* setting.
    ['${application.adminEmail}', 'mailto:'],
  ])('links MURA_ADMINEMAIL=%j as href %j', (adminEmail, href) => {
    vi.stubEnv('MURA_ADMINEMAIL', adminEmail);
    resetLegacySettingsForTests();
    expect(toString(renderNoaccess().body)).toContain(`<a href="${href}">administrator</a>`);
  });
});

describe('cMessage.noaccess page', () => {
  it.each<[string, () => AdminRequest]>([
    ['a site-less private user', () => noSitesRequest({ s2IsPrivate: true }, NOACCESS)],
    ['the S2 admin', () => adminS2Request(NOACCESS)],
  ])('renders inside the full layout for %s', async (_, build) => {
    const req = build();
    expect(req.action).toBe('core:cmessage.noaccess');
    const page = await renderScreenPage(noaccessScreen(), makeScreenContext({ req }));
    if (page.kind !== 'document') throw new TypeError(`Redirected to ${page.location}`);

    expect(domModel(page.html).title).toBe(templateTitleText(legacySettings().title, 'Message'));
    expect(domModel(page.html).title).toBe('Masa CMS - Message');
    const $ = cheerio.load(page.html);
    expect($('body').attr('id')).toBe('cmessage');
    expect(($('body').attr('class') ?? '').split(/\s+/)).toContain('mura-admin');
    expect($('div.mura-header h1').toArray().map((el) => $(el).text())).toContain('Access Denied');
    expect($('a[href="mailto:"]').text()).toBe('administrator');
  });

  it('redirects anonymous users to the context root', async () => {
    const page = await renderScreenPage(noaccessScreen(), makeScreenContext({ req: anonymousRequest(NOACCESS) }));
    expect(page).toEqual({ kind: 'redirect', location: `${legacySettings().context}/` });
  });
});

describe('noaccessGate', () => {
  it.each<[string, () => AdminRequest]>([
    ['anonymous users', () => anonymousRequest(NOACCESS)],
    ['public members', () => noSitesRequest({ s2IsPrivate: false }, NOACCESS)],
    [
      'private users whose memberships lack S2IsPrivate',
      () => editorRequest({ ...NOACCESS, session: { mura: { memberships: '' } } }),
    ],
    [
      'anonymous users whose rc claims a login',
      () =>
        anonymousRequest({ ...NOACCESS, rc: { isLoggedIn: 'true', memberships: 'S2IsPrivate', s2IsPrivate: 'true' } }),
    ],
  ])('redirects %s to the context root', async (_, build) => {
    const { decision, secureSpy } = await gateFor(build());
    expect(decision).toEqual({ kind: 'redirect', location: `${legacySettings().context}/` });
    expect(decision).toEqual({ kind: 'redirect', location: '/' });
    expect(secureSpy).not.toHaveBeenCalled();
  });

  it.each<[string, () => AdminRequest]>([
    ['the editor', () => editorRequest(NOACCESS)],
    ['the S2 admin', () => adminS2Request(NOACCESS)],
    ['a site-less private user', () => noSitesRequest({ s2IsPrivate: true }, NOACCESS)],
  ])('allows %s', async (_, build) => {
    const { decision, secureSpy } = await gateFor(build());
    expect(decision).toEqual({ kind: 'allow' });
    expect(secureSpy).not.toHaveBeenCalled();
  });

  it('redirects under a non-empty context', async () => {
    stubSettings({ MURA_CONTEXT: '/masa' });
    expect(legacySettings().context).toBe('/masa');
    const { decision, secureSpy } = await gateFor(anonymousRequest(NOACCESS));
    expect(decision).toEqual({ kind: 'redirect', location: '/masa/' });
    expect(secureSpy).not.toHaveBeenCalled();
  });
});

describe('noaccessAdminEmail', () => {
  it('is empty by default, as the settings template', () => {
    expect(noaccessAdminEmail()).toBe(legacySettings().adminEmail);
    expect(noaccessAdminEmail()).toBe('');
  });

  it('reads MURA_ADMINEMAIL through the legacy settings', () => {
    stubSettings({ MURA_ADMINEMAIL: 'ops@example.com' });
    expect(legacySettings().adminEmail).toBe('ops@example.com');
    expect(noaccessAdminEmail()).toBe('ops@example.com');
    expect(toString(renderNoaccess().body)).toContain('href="mailto:ops%40example.com"');
  });

  it('returns to empty once the variable is unset', () => {
    stubSettings({ MURA_ADMINEMAIL: 'ops@example.com' });
    expect(noaccessAdminEmail()).toBe('ops@example.com');
    stubSettings({ MURA_ADMINEMAIL: undefined });
    expect(noaccessAdminEmail()).toBe('');
  });
});

describe('cmessageScreens', () => {
  it('registers the one identity-owned page', () => {
    expect(cmessageScreens).toHaveLength(1);
    const entry = noaccessScreen();
    expect(entry).toBe(cmessageScreens[0]);
    expect(entry).toMatchObject({ circuit: 'cmessage', action: 'noaccess', owner: 'identity', mode: 'page' });
    expect(entry).not.toHaveProperty('routeKey');
    expect(entry).not.toHaveProperty('variant');
    expect(entry.gate).toBe(noaccessGate);
  });

  it('matches the inventoried action', () => {
    const inventory = JSON.parse(
      readFileSync(new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url), 'utf8'),
    ) as {
      controllers: Array<{
        actions: Array<{
          variants: Array<{
            id: string;
            routeKey: string;
            owningService: string;
            disposition: string;
            responseMode: string;
          }>;
        }>;
      }>;
    };
    const variant = inventory.controllers
      .flatMap((controller) => controller.actions.flatMap((action) => action.variants))
      .find((candidate) => candidate.id === 'ctl:cmessage.noaccess');
    const entry = noaccessScreen();
    expect(variant?.routeKey).toBe('admin:cmessage.noaccess');
    expect(variant).toMatchObject({
      routeKey: `admin:${entry.circuit}.${entry.action}`,
      owningService: entry.owner,
      disposition: 'carry',
      responseMode: entry.mode,
    });
  });

  it('renders renderNoaccess() whatever the context', async () => {
    stubSettings({ MURA_ADMINEMAIL: 'ops@example.com' });
    const view = await noaccessScreen().render(makeScreenContext({ req: adminS2Request(NOACCESS) }), undefined);
    expect(Object.keys(view)).toEqual(['body']);
    expect(toString(view.body)).toBe(toString(renderNoaccess().body));
    expect(toString(view.body)).toContain('href="mailto:ops%40example.com"');
  });
});
