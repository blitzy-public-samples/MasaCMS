// cEditProfile.edit and cEditProfile.update against ceditprofile.cfc and ceditprofile/edit.cfm over the people contract.
import * as cheerio from 'cheerio';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components as PeopleComponents } from '@/generated/clients/people';
import { runGate } from '@/lib/access-gate';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString, type SafeHtml } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { ceditprofileScreens } from '@/screens/ceditprofile';
import type { ProfileInterestCategoryRow } from '@/screens/ceditprofile/dsp_categories_nest';
import {
  PROFILE_SOURCES,
  buildEditProfileView,
  ceditprofileGate,
  editProfileRc,
  editProfileScreen,
  loadEditProfileView,
  renderEditProfile,
  type EditProfileSources,
  type EditProfileView,
  type ProfileData,
} from '@/screens/ceditprofile/edit';
import { updateProfileAction } from '@/screens/ceditprofile/update';
import type { ScreenContext } from '@/screens/registry';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  noSitesRequest,
  siteAdminRequest,
  siteRecordFor,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';
import { SUBJECTS } from '../../helpers/tokens';

// The registry imports every circuit barrel; the shell reads only its hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type PersonRecord = PeopleComponents['schemas']['PersonRecord'];
type AddressRecord = PeopleComponents['schemas']['AddressRecord'];
type UpdateResult = PeopleComponents['schemas']['UpdateResult'];
type Fields = Readonly<Record<string, string>>;

const USER_ID = SUBJECTS.admin.sub;
const PROFILE_ROUTE = routeKey('GET', 'people', '/v1/profile');
const UPDATE_ROUTE = routeKey('POST', 'people', '/v1/profile:update');
const shellSiteRoute = (siteId: string): string => routeKey('GET', 'programs-sites', `/v1/sites/${siteId}/shell`);
const CSRF_FIELDS: Fields = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };
/** controller `secure()`'s login redirect, with the return URL and the defaulted `compactDisplay`. */
const loginLocation = (action: string): string =>
  `./?muraAction=cLogin.main&returnURL=${encodeURIComponent(`http://localhost/admin/?&muraAction=ceditprofile.${action}`)}&compactDisplay=false`;
const USER_JS = '<script type="text/javascript" src="assets/js/user.js"></script>';

/** The installed admin as people's `getProfile` reads it. */
const PERSON: PersonRecord = {
  UserID: USER_ID,
  Type: 2,
  SiteID: 'default',
  Fname: 'Ada & "Countess"',
  Lname: 'Love<lace>',
  Company: 'Analytical Engines',
  JobTitle: 'Engineer',
  Email: 'ada@example.test',
  mobilePhone: '+1 555 0100',
  UserName: 'admin',
  subType: 'Default',
  Subscribe: 1,
  tags: 'math,poetry',
  photoFileID: null,
  isPublic: 0,
  S2: 1,
};

const profileOf = (fields: Partial<ProfileData> = {}, user: Partial<PersonRecord> = {}): ProfileData => ({
  user: { ...PERSON, ...user },
  addresses: [],
  categoryIds: [],
  subTypes: [],
  extendedAttributes: {},
  errors: {},
  retained: false,
  ...fields,
});

const addressOf = (n: number, fields: Partial<AddressRecord> = {}): AddressRecord => ({
  addressID: `AD000000-0000-0000-00000000000000${String(n).padStart(2, '0')}`,
  userID: USER_ID,
  siteID: 'default',
  ...fields,
});

const ok = (body: unknown): FakeReply => ({ status: 200, body });

const editRequest = (rc: Fields = {}, partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ ...partial, circuit: 'ceditprofile', item: 'edit', rc });

/** A context whose people answers `getProfile` with `profile`; `routes` add or replace answers. */
function contextFor(
  req: AdminRequest,
  profile: ProfileData = profileOf(),
  routes: Readonly<Record<string, FakeReply>> = {},
): ScreenContext & { gateway: FakeGatewayClient } {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [PROFILE_ROUTE]: ok(profile), ...routes }) });
}

/** Clears every `MURA_` variable, then sets `vars`, so settings come from `vars` alone. */
function useSettings(vars: Fields = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

/** Message and reason of the LegacyServiceUnavailableError `run` rejects with. */
async function unavailable(run: () => Promise<unknown>): Promise<{ message: string; reason?: string }> {
  const error: unknown = await run().then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!(error instanceof LegacyServiceUnavailableError)) throw new Error(`Expected LegacyServiceUnavailableError, got ${String(error)}`);
  return { message: error.message, reason: error.reason };
}

/** The rendered view body of `view`, with its CSRF pair fetched through `ctx`. */
async function bodyOf(ctx: ScreenContext, view: EditProfileView): Promise<string> {
  return toString((await renderEditProfile(ctx, view)).body);
}

const $of = (markup: string): cheerio.CheerioAPI => cheerio.load(markup, null, false);

const textOf = (markup: SafeHtml | undefined): string => (markup === undefined ? '' : toString(markup));

/** `[name, type, value, checked]` of every form control, in document order. */
const controlsOf = (markup: string): Array<[string, string, string, boolean]> =>
  fragmentModel(markup).controls.map((c) => [c.name, c.type, c.value, c.checked]);

let restoreEnv: () => void;

beforeEach(() => {
  useSettings();
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('cEditProfile before()', () => {
  it("adds each param default where no key of its name exists, keeping the request's value and casing", () => {
    const rc = editProfileRc(editRequest({ RouteID: 'roster', CATEGORYID: 'C1', Email: 'x@example.test' }));

    expect(rc.routeid).toBe('roster');
    expect(rc.categoryID).toBe('C1');
    expect(rc['EMAIL']).toBe('x@example.test');
    expect(rc.returnurl).toBe('');
    expect(rc.error).toEqual({});
    expect(rc['startrow']).toBe('1');
    expect(rc['rsGrouplist']).toBeUndefined();
    const names = Object.keys(rc);
    expect(names).toEqual(expect.arrayContaining(['RouteID', 'CATEGORYID', 'Email', 'Type', 'ContactForm', 'returnurl']));
    expect(names.filter((name) => name.toLowerCase() === 'routeid')).toEqual(['RouteID']);
    expect(names.filter((name) => name.toLowerCase() === 'inactive')).toEqual(['inActive']);
    expect(names.indexOf('Type')).toBeLessThan(names.indexOf('returnurl'));
    expect('SITEID' in rc).toBe(true);
    expect('missing' in rc).toBe(false);
    expect(Object.getOwnPropertyDescriptor(rc, 'missing')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(rc, 'email')).toMatchObject({ value: 'x@example.test', writable: false });
    expect((rc as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
  });

  it('is read-only', () => {
    const rc = editProfileRc(editRequest());

    expect(Reflect.set(rc, 'routeid', 'x')).toBe(false);
    expect(Reflect.defineProperty(rc, 'routeid', { value: 'x' })).toBe(false);
    expect(Reflect.deleteProperty(rc, 'routeid')).toBe(false);
    expect(rc.routeid).toBe('');
  });

  it.each<[string, () => AdminRequest, string | undefined]>([
    ['the S2 admin', () => editRequest(), undefined],
    ['the Site Manager editor', () => editorRequest({ circuit: 'ceditprofile', item: 'edit' }), undefined],
    [
      'a system user administering no site',
      () => noSitesRequest({ s2IsPrivate: true }, { circuit: 'ceditprofile', item: 'edit' }),
      undefined,
    ],
    [
      'a site member administering no site',
      () => noSitesRequest({ s2IsPrivate: false }, { circuit: 'ceditprofile', item: 'edit' }),
      '/admin/?muraAction=clogin.logout',
    ],
  ])('lets %s through, or sends it where legacy does', async (_who, req, location) => {
    const decision = await runGate(req(), ceditprofileGate);

    expect(decision).toEqual(location === undefined ? { kind: 'allow' } : { kind: 'redirect', location });
  });

  it('sends an anonymous request to the login form with its return URL', async () => {
    const decision = await runGate(anonymousRequest({ circuit: 'ceditprofile', item: 'edit' }), ceditprofileGate);

    expect(decision).toEqual({ kind: 'redirect', location: loginLocation('edit') });
  });

  it('registers edit and update behind the same gate, owned by identity and people', () => {
    expect(ceditprofileScreens).toEqual([editProfileScreen, updateProfileAction]);
    expect(editProfileScreen).toMatchObject({ circuit: 'ceditprofile', action: 'edit', mode: 'page', owner: 'identity' });
    expect(updateProfileAction).toMatchObject({ circuit: 'ceditprofile', action: 'update', mode: 'page', owner: 'people' });
    expect(editProfileScreen.gate).toBe(ceditprofileGate);
    expect(updateProfileAction.gate).toBe(ceditprofileGate);
    expect(updateProfileAction.render).toBe(renderEditProfile);
    expect(PROFILE_SOURCES).toEqual({});
  });
});

describe('cEditProfile.edit load', () => {
  it("reads the session user from people and the request's own site without asking programs-sites", async () => {
    const ctx = contextFor(editRequest());

    const view = await loadEditProfileView(ctx);

    expect(ctx.gateway.calls).toEqual([{ service: 'people', method: 'GET', path: '/v1/profile' }]);
    expect(view).toMatchObject({
      profile: profileOf(),
      routeId: 'editprofile',
      userSite: {
        siteId: 'default',
        name: 'Default',
        settings: { publicUserPoolID: 'default', privateUserPoolID: 'default', themeAssetPath: '/themes/' },
      },
      sessionUserId: USER_ID,
      queryString: 'muraAction=ceditprofile.edit',
      strongPasswords: false,
    });
    expect(view.poolSite).toBeUndefined();
    await expect(view.interestRows('default', '')).resolves.toEqual([]);
  });

  it.each<[string, string | undefined, string]>([
    ['the forwarded query', '/admin/?muraAction=cEditProfile.edit&routeid=a%20b', 'muraAction=cEditProfile.edit&routeid=a%20b'],
    ['an empty query for a target without one', '/admin/', ''],
    ['the rc pairs without a forwarded target', undefined, 'muraAction=ceditprofile.edit'],
  ])('reads cgi.query_string from %s', async (_case, target, queryString) => {
    const headers = new Headers(target === undefined ? {} : { [ORIGINAL_URL_HEADER]: target });
    const view = await loadEditProfileView(contextFor(editRequest({ routeid: 'roster' }, { headers })));

    expect(view.queryString).toBe(queryString);
    expect(view.routeId).toBe('roster');
  });

  it.each<[string | undefined, boolean]>([
    ['true', true],
    ['yes', true],
    ['1', true],
    ['false', false],
    ['sometimes', false],
    [undefined, false],
  ])('tests MURA_STRONGPASSWORDS=%s as CFML isBoolean and value (%s)', async (value, strong) => {
    useSettings(value === undefined ? {} : { MURA_STRONGPASSWORDS: value });
    const view = await loadEditProfileView(contextFor(editRequest()));

    expect(view.strongPasswords).toBe(strong);
  });

  it.each<[string, Fields, AdminRequestPartial, string]>([
    ['a local theme under the context', { MURA_CONTEXT: '/ctx' }, { site: { record: { theme: 'Masa' } } }, '/ctx/themes/Masa'],
    [
      'a remote site without a resource domain',
      { MURA_CONTEXT: '/ctx' },
      { site: { record: { theme: 'Masa', isremote: 1, remotecontext: '/remote' } } },
      '/remote/themes/Masa',
    ],
    [
      'a remote resource domain over SSL',
      { MURA_PORT: '8080' },
      { site: { record: { theme: 'Masa', isremote: 1, resourceDomain: 'cdn.example.test', useSSL: 1 } } },
      'https://cdn.example.test:8080/themes/Masa',
    ],
    [
      'a remote resource domain falling back to ExtranetSSL',
      {},
      { site: { record: { theme: 'Masa', isremote: 1, resourceDomain: 'cdn.example.test', useSSL: null, ExtranetSSL: 0 } } },
      'http://cdn.example.test/themes/Masa',
    ],
    [
      'a remote resource domain on an https request',
      {},
      { https: true, site: { record: { theme: 'Masa', isremote: 1, resourceDomain: 'cdn.example.test', resourceSSL: 0 } } },
      'https://cdn.example.test/themes/Masa',
    ],
  ])('prints the theme asset path of %s', async (_case, vars, partial, path) => {
    useSettings(vars);
    const view = await loadEditProfileView(contextFor(editRequest({}, partial)));

    expect(view.userSite.settings?.themeAssetPath).toBe(path);
  });

  it("asks programs-sites for the user's site when the session is on another site the token does not serve", async () => {
    // A pool id the service omits is the site's own, as the bean defaults it.
    const record = { ...siteRecordFor('default'), theme: 'Masa', publicUserPoolID: undefined, privateUserPoolID: 'pool-x' };
    const req = editRequest({ siteid: 'default' }, { session: { siteid: 'tenant-a' } });
    const ctx = contextFor(req, profileOf(), { [shellSiteRoute('default')]: ok({ site: record, isNew: 0 }) });
    expect(req.site).toBeUndefined();

    const view = await buildEditProfileView(ctx, profileOf(), {
      rcSiteId: 'default',
      rc: editProfileRc(req),
      sources: { privatePoolSites: (poolId) => Promise.resolve([{ siteId: poolId, name: 'Pool X' }]) },
    });

    expect(ctx.gateway.calls).toEqual([{ service: 'programs-sites', method: 'GET', path: '/v1/sites/default/shell' }]);
    expect(view.userSite.settings).toEqual({ publicUserPoolID: 'default', privateUserPoolID: 'pool-x', themeAssetPath: '/themes/Masa' });
    expect(view.poolSite).toEqual({ siteId: 'pool-x', name: 'Pool X' });
  });

  it('fails closed when programs-sites answers the defaulted new site for the user', async () => {
    const req = editRequest({ siteid: 'default' }, { session: { siteid: 'tenant-a' } });
    const ctx = contextFor(req, profileOf(), { [shellSiteRoute('default')]: ok({ site: siteRecordFor('default'), isNew: 1 }) });

    expect(await unavailable(() => loadEditProfileView(ctx))).toEqual({
      message: "cEditProfile.edit needs the settings of the user's site default, which no owner contract serves",
      reason: 'profile-site',
    });
  });

  it.each([401, 403] as const)("raises programs-sites' %i for the access gate", async (status) => {
    const req = editRequest({ siteid: 'default' }, { session: { siteid: 'tenant-a' } });
    const ctx = contextFor(req, profileOf(), { [shellSiteRoute('default')]: { status, body: { error: 'denied' } } });

    await expect(loadEditProfileView(ctx)).rejects.toMatchObject({ service: 'programs-sites', operation: 'getShellSite', status });
  });

  describe("a user whose site the token does not serve, under a pool site's request", () => {
    const poolRequest = (): AdminRequest =>
      siteAdminRequest('tenant-a', { circuit: 'ceditprofile', item: 'edit', session: { siteArray: ['tenant-a', 'default'] } });
    const poolSites = vi.fn((poolId: string) => Promise.resolve([{ siteId: poolId, name: 'Tenant A' }]));

    it("names the user's site from identity's site list and adds the pool site's tree", async () => {
      poolSites.mockClear();
      const ctx = contextFor(poolRequest());

      const view = await loadEditProfileView(ctx, { privatePoolSites: poolSites });

      expect(ctx.gateway.calls).toEqual([{ service: 'people', method: 'GET', path: '/v1/profile' }]);
      expect(view.userSite).toEqual({ siteId: 'default', name: 'Default' });
      expect(view.poolSite).toEqual({ siteId: 'tenant-a', name: 'Tenant A' });
      expect(poolSites).toHaveBeenCalledWith('tenant-a');
    });

    it('adds no tree when no site shares the pool', async () => {
      const view = await loadEditProfileView(contextFor(poolRequest()), { privatePoolSites: () => Promise.resolve([]) });

      expect(view.poolSite).toBeUndefined();
    });

    it.each<[string, ProfileData, EditProfileSources, string, string]>([
      [
        'its subtypes need site settings',
        profileOf({ subTypes: [{ subTypeID: 'ST000000-0000-0000-0000000000000001', subType: 'Gold' }] }),
        { privatePoolSites: () => Promise.resolve([]) },
        "the settings of the user's site default",
        'profile-site',
      ],
      ['no source lists the pool sites', profileOf(), {}, 'the sites of private user pool tenant-a', 'profile-pool-sites'],
    ])('fails closed when %s', async (_case, profile, sources, what, reason) => {
      const failure = await unavailable(() => loadEditProfileView(contextFor(poolRequest(), profile), sources));

      expect(failure).toEqual({ message: `cEditProfile.edit needs ${what}, which no owner contract serves`, reason });
    });
  });

  it('fails closed for an rc.siteid whose settings no source serves', async () => {
    const failure = await unavailable(() => loadEditProfileView(contextFor(editRequest({ siteid: 'tenant-b' }))));

    expect(failure).toEqual({
      message: 'cEditProfile.edit needs the private user pool of site tenant-b, which no owner contract serves',
      reason: 'profile-site',
    });
  });

  it.each<[string, ProfileData, Fields]>([
    ['the profile holds interests', profileOf({ categoryIds: ['CA000000-0000-0000-0000000000000001'] }), {}],
    ['the request names interests', profileOf(), { categoryID: 'CA000000-0000-0000-0000000000000001' }],
  ])('fails closed without an interest-group source when %s', async (_case, profile, rc) => {
    const failure = await unavailable(() => loadEditProfileView(contextFor(editRequest(rc), profile)));

    expect(failure).toEqual({
      message: 'cEditProfile.edit needs the interest groups, which no owner contract serves',
      reason: 'profile-interests',
    });
  });

  it.each([401, 403] as const)("raises people's %i, which the page answers with the access gate's redirect", async (status) => {
    const ctx = contextFor(editRequest(), profileOf(), { [PROFILE_ROUTE]: { status, body: { error: 'denied' } } });

    await expect(loadEditProfileView(ctx)).rejects.toBeInstanceOf(GatewayDenialError);
    const page = await renderScreenPage(editProfileScreen, ctx);
    expect(page).toEqual({
      kind: 'redirect',
      location: status === 401 ? '/admin/?muraAction=clogin.logout' : '/admin/?muraAction=cMessage.noaccess',
    });
  });

  it('fails on a 500 from people', async () => {
    const ctx = contextFor(editRequest(), profileOf(), { [PROFILE_ROUTE]: { status: 500, body: { error: 'boom' } } });

    await expect(loadEditProfileView(ctx)).rejects.toThrow('getProfile answered HTTP 500');
  });

  it('propagates the unavailability of people', async () => {
    const ctx = contextFor(editRequest(), profileOf(), { [PROFILE_ROUTE]: { status: 503, body: { error: 'down' } } });

    await expect(loadEditProfileView(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('cEditProfile.edit view', () => {
  const view = async (
    profile: ProfileData = profileOf(),
    req: AdminRequest = editRequest(),
    sources?: EditProfileSources,
  ): Promise<{ ctx: ScreenContext & { gateway: FakeGatewayClient }; view: EditProfileView }> => {
    const ctx = contextFor(req, profile);
    return { ctx, view: await loadEditProfileView(ctx, sources) };
  };

  it('renders the Basic, Address Information, Interests and Advanced tabs with the default CSRF pair', async () => {
    const { ctx, view: loaded } = await view();

    const shell = await renderEditProfile(ctx, loaded);
    const body = toString(shell.body);
    const $ = $of(body);

    expect(ctx.gateway.calls.at(-1)).toEqual({ service: 'identity', method: 'POST', path: '/v1/csrf/tokens', json: { contexts: [''] } });
    expect($('h1').text()).toBe('Edit Profile');
    expect($('.alert')).toHaveLength(0);
    expect($('form').attr()).toMatchObject({
      action: './?muraAction=cEditProfile.update',
      method: 'post',
      enctype: 'multipart/form-data',
      name: 'form1',
      onsubmit: 'return userManager.submitForm(this);',
    });
    expect($('ul.mura-tabs a').toArray().map((a) => [$(a).attr('href'), $(a).text()])).toEqual([
      ['#tabBasic', 'Basic'],
      ['#tabAddressinformation', 'Address Information'],
      ['#tabInterests', 'Interests'],
      ['#tabAdvanced', 'Advanced'],
    ]);
    expect($('ul.mura-tabs li.active a').attr('href')).toBe('#tabBasic');
    expect(controlsOf(body)).toEqual([
      ['subtype', 'hidden', 'Default', false],
      ['fname', 'text', 'Ada & "Countess"', false],
      ['lname', 'text', 'Love<lace>', false],
      ['company', 'text', 'Analytical Engines', false],
      ['jobtitle', 'text', 'Engineer', false],
      ['email', 'text', 'ada@example.test', false],
      ['mobilePhone', 'text', '+1 555 0100', false],
      ['usernameNoCache', 'text', 'admin', false],
      ['passwordNoCache', 'password', '', false],
      ['password2', 'password', '', false],
      ['newFile', 'file', '', false],
      ['subscribe', 'radio', '1', true],
      ['subscribe', 'radio', '0', false],
      ['tags', 'text', 'math,poetry', false],
      ['type', 'hidden', '2', false],
      ['action', 'hidden', '', false],
      ['contact', 'hidden', '0', false],
      ['userid', 'hidden', USER_ID, false],
      ['siteid', 'hidden', 'default', false],
      ['csrf_token', 'hidden', FIXED_CSRF.token, false],
      ['csrf_token_expires', 'hidden', FIXED_CSRF.expires, false],
    ]);
    expect(body).toContain('<div class="help-block-inline">*Required, **Required to log in to Site</div>');
    expect(body).not.toContain('passwordstrengthhelptext');
    expect(body).not.toContain('Passwords cannot be the same as the username');
    expect($('#tabExtendedattributes')).toHaveLength(0);
    expect($('#assocImage')).toHaveLength(0);
    expect(fragmentModel(body).buttons).toEqual([{ text: 'Update', type: 'button', hasOnclick: true }]);
    expect(textOf(shell.htmlHead)).toBe(`${toString(ctx.req.session.dateKey.script)}${USER_JS}`);
    expect(textOf(shell.ajax)).toMatch(/^<script src="[^"]*js\/searchParams\.js[^"]*" type="text\/javascript" ><\/script>$/);
  });

  it('renders the shell page for the admin', async () => {
    const ctx = contextFor(editRequest());

    const page = await renderScreenPage(editProfileScreen, ctx);

    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    expect(page.html).toContain('<h1>Edit Profile</h1>');
    expect(page.html).toContain('action="./?muraAction=cEditProfile.update"');
  });

  it("lists people's errors but siteID's, as displayErrors does", async () => {
    const errors = { email: 'Please enter a valid email address.', siteID: 'hidden', fname: 'First name is required.' };
    const { ctx, view: loaded } = await view(profileOf({ errors, retained: true }));

    expect(await bodyOf(ctx, loaded)).toContain(
      '\n\t<div class="alert alert-error"><span> Please enter a valid email address. <br> First name is required. </span></div>\n',
    );
  });

  it('shows the password strength help when strong passwords are on', async () => {
    useSettings({ MURA_STRONGPASSWORDS: 'true' });
    const { ctx, view: loaded } = await view();

    expect(await bodyOf(ctx, loaded)).toContain(
      '<div class="help-block-inline">Passwords cannot be the same as the username, must be at least 7 characters long, and must contain 1 upper case, 1 lower case and 1 numeric character.</div>',
    );
  });

  it('offers the active subtypes, selecting the user\'s by CFML eq, and loads the extended attributes', async () => {
    useSettings({ MURA_CONTEXT: '/ctx' });
    const subTypes = [
      { subTypeID: 'ST000000-0000-0000-0000000000000001', subType: 'Default' },
      { subTypeID: 'ST000000-0000-0000-0000000000000002', subType: 'Gold' },
      { subTypeID: 'ST000000-0000-0000-0000000000000003', subType: 'default' },
    ];
    const req = editRequest({}, { site: { record: { theme: 'Masa', publicUserPoolID: 'pub' } } });
    const { ctx, view: loaded } = await view(profileOf({ subTypes }, { subType: 'gold' }), req);

    const body = await bodyOf(ctx, loaded);
    const $ = $of(body);

    expect($('ul.mura-tabs a').toArray().map((a) => $(a).attr('href'))).toEqual([
      '#tabBasic',
      '#tabAddressinformation',
      '#tabInterests',
      '#tabExtendedattributes',
      '#tabAdvanced',
    ]);
    expect($('ul.mura-tabs a').eq(3).text()).toBe('Extended Attributes');
    const select = fragmentModel(body).controls.find((c) => c.name === 'subtype');
    expect(select?.options).toEqual([
      { value: 'Default', label: 'Default', selected: false },
      { value: 'Gold', label: 'Gold', selected: true },
      { value: 'default', label: 'default', selected: false },
    ]);
    expect($('select[name="subtype"]').attr('onchange')).toBe(
      `resetExtendedAttributes('${USER_ID}','2',this.value,'pub','/ctx','/ctx/themes/Masa');`,
    );
    expect($('#tabExtendedattributes script').text().trim()).toBe(
      `userManager.loadExtendedAttributes('${USER_ID}','2','gold','default','/ctx','/ctx/themes/Masa');`,
    );
  });

  it.each<[string, ProfileData['subTypes'], string]>([
    ['an active non-default subtype', [{ subTypeID: 'ST000000-0000-0000-0000000000000002', subType: 'Gold' }], "The subtype select needs the user's site settings"],
    ['only the Default subtype', [{ subTypeID: 'ST000000-0000-0000-0000000000000001', subType: 'Default' }], "The extended attribute loader needs the user's site settings"],
  ])('refuses to render %s without site settings', async (_case, subTypes, message) => {
    const ctx = contextFor(editRequest());
    const loaded = await loadEditProfileView(ctx);
    const unsettled: EditProfileView = {
      ...loaded,
      profile: profileOf({ subTypes }),
      userSite: { siteId: 'default', name: 'Default' },
    };

    await expect(renderEditProfile(ctx, unsettled)).rejects.toThrow(new TypeError(message));
  });

  it('links the profile image and offers its removal', async () => {
    const photo = 'F1000000-0000-0000-0000000000000001';
    const { ctx, view: loaded } = await view(profileOf({}, { photoFileID: photo }));

    const body = await bodyOf(ctx, loaded);
    const $ = $of(body);

    expect($('#assocImage').parent('a').attr('href')).toBe(
      `./index.cfm?muraAction=cArch.imagedetails&userid=${USER_ID}&siteid=default&fileid=${photo}`,
    );
    expect($('#assocImage').attr('src')).toMatch(
      new RegExp(`^/index\\.cfm/_api/render/medium/\\?fileid=${photo}&cacheID=[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$`),
    );
    expect(body).toContain('<input type="checkbox" name="removePhotoFile" value="true"> Delete ');
  });

  it('notes a user without addresses', async () => {
    const { ctx, view: loaded } = await view();

    const $ = $of(await bodyOf(ctx, loaded));

    expect($('#tabAddressinformation .help-block-empty').text()).toBe('This user currently has no address information');
    expect($('#tabAddressinformation .navTask a').attr('href')).toBe(
      `./?muraAction=cusers.editAddress&userID=${USER_ID}&siteid=default&routeID=editprofile&addressID=&returnURL=muraAction%3Dceditprofile.edit`,
    );
  });

  it('lists the addresses, checking the primary one and offering deletion of the others', async () => {
    const primary = addressOf(1, { addressName: 'Home', isPrimary: 1, city: 'London' });
    const other = addressOf(2, { addressName: 'Office', isPrimary: 0, city: 'Paris' });
    const req = editRequest({ routeid: 'a b' });
    const { ctx, view: loaded } = await view(profileOf({ addresses: [primary, other] }), req);

    const $ = $of(await bodyOf(ctx, loaded));
    const rows = $('#tabAddressinformation table tr').toArray().slice(1);
    const returnUrl = 'returnURL=muraAction%3Dceditprofile.edit';

    expect($('#tabAddressinformation table th').toArray().map((th) => $(th).text())).toEqual(['Primary', 'Address', '']);
    expect(rows.map((tr) => [$(tr).find('input').attr('value'), $(tr).find('input').is('[checked]')])).toEqual([
      [primary.addressID, true],
      [other.addressID, false],
    ]);
    expect($(rows[0]).find('li.delete')).toHaveLength(0);
    expect($(rows[0]).find('td.actions > ul > i.mi-trash')).toHaveLength(1);
    expect($(rows[1]).find('li.edit a').attr('href')).toBe(
      `./?muraAction=cusers.editAddress&userID=${USER_ID}&siteid=default&routeID=a+b&addressID=${other.addressID}&${returnUrl}`,
    );
    expect($(rows[1]).find('li.delete a').attr()).toMatchObject({
      href: `./?muraAction=cusers.updateAddress&userID=${USER_ID}&action=delete&siteid=default&routeID=a+b&addressID=${other.addressID}&${returnUrl}`,
      onclick: "return confirmDialog('Delete\\x20Address\\x3F',this.href);",
    });
  });

  it('checks a sole address even when it is not primary', async () => {
    const { ctx, view: loaded } = await view(profileOf({ addresses: [addressOf(1, { isPrimary: 0 })] }));

    expect($of(await bodyOf(ctx, loaded))('input[name="primaryAddressID"]').is('[checked]')).toBe(true);
  });

  it.each<[string, Partial<AddressRecord>, string]>([
    [
      'every part',
      {
        addressName: 'HQ',
        address1: '1 Main St',
        address2: 'Suite 2',
        city: 'Springfield',
        state: 'IL',
        zip: '62701',
        phone: '555-0100',
        fax: '555-0101',
        addressURL: 'https://example.test',
        addressEmail: 'hq@example.test',
      },
      '<strong>HQ</strong><br/> 1 Main St<br/> Suite 2<br/> Springfield , IL 62701<br/> Phone: 555-0100<br/> Fax: 555-0101<br/> ' +
        'Website: <a href="https://example.test" target="_blank">https://example.test</a><br/> ' +
        'Email: <a href="mailto:hq@example.test">hq@example.test</a>',
    ],
    ['a city alone', { city: 'Springfield' }, 'Springfield <br/> '],
    ['a state and zip without a city', { state: 'IL', zip: '62701' }, 'IL 62701<br/> '],
    ['a zip alone', { zip: '62701' }, '62701<br/> '],
    ['no part', { addressName: null, city: '' }, ''],
  ])('writes %s of an address with the gaps ACF leaves', async (_case, fields, cell) => {
    const { ctx, view: loaded } = await view(profileOf({ addresses: [addressOf(1, fields)] }));

    expect(await bodyOf(ctx, loaded)).toContain(`<td class="var-width">\n\t\t\t\t\t\t\t\t\t\t${cell}\n\t\t\t\t\t\t\t\t\t\t</td>`);
  });

  it("shows the user's site tree, then the pool site's, from the interest-group source", async () => {
    const interest = (categoryID: string, name: string): ProfileInterestCategoryRow => ({
      categoryID,
      name,
      site: 'Default',
      isOpen: 1,
      hasKids: 0,
    });
    const chess = interest('CA000000-0000-0000-0000000000000001', 'Chess');
    const go = interest('CA000000-0000-0000-0000000000000002', 'Go');
    const loads: Array<[string, string]> = [];
    const sources: EditProfileSources = {
      interestRows: (siteId, parentId) => {
        loads.push([siteId, parentId]);
        return Promise.resolve(siteId === 'default' ? [chess, go] : []);
      },
      privatePoolSites: (poolId) => Promise.resolve([{ siteId: poolId, name: 'Tenant A' }]),
    };
    const req = siteAdminRequest('tenant-a', {
      circuit: 'ceditprofile',
      item: 'edit',
      rc: { categoryID: go.categoryID },
      session: { siteArray: ['tenant-a', 'default'] },
    });
    const { ctx, view: loaded } = await view(profileOf({ categoryIds: [chess.categoryID] }), req, sources);

    const body = await bodyOf(ctx, loaded);
    const $ = $of(body);

    expect(loads).toEqual([
      ['default', ''],
      ['tenant-a', ''],
    ]);
    expect($('#mura-list-tree > label').toArray().map((label) => $(label).text())).toEqual(['Default', 'Tenant A']);
    expect($('#mura-list-tree input[name="categoryID"]').toArray().map((box) => [$(box).val(), $(box).is('[checked]')])).toEqual([
      [chess.categoryID, true],
      [go.categoryID, true],
    ]);
    expect(body).toContain(
      '<label>Tenant A</label> <div class="help-block-empty">There are currently no interest groups.</div> ',
    );
  });

  it('checks the email broadcaster radio by CFML eq of Subscribe', async () => {
    const { ctx, view: loaded } = await view(profileOf({}, { Subscribe: null }));

    expect(controlsOf(await bodyOf(ctx, loaded)).filter(([name]) => name === 'subscribe')).toEqual([
      ['subscribe', 'radio', '1', false],
      ['subscribe', 'radio', '0', false],
    ]);
  });

  it('prints unencoded labels, as rbKey writes them', async () => {
    const { ctx, view: loaded } = await view();
    const rb: RbLookup = { locale: 'en', rbKey: (key) => `<b>[${key}]</b>`, messageFormat: () => '' };

    const body = await bodyOf({ ...ctx, rb }, loaded);

    expect(body).toContain('<h1><b>[user.editprofile]</b></h1>');
    expect(body).toContain('<label><b>[user.fname]</b>*</label>');
    expect(body).toContain('<span><b>[user.addressinformation]</b></span>');
  });

  it('fails as listGetAt does when an empty tab label drops out of the label list', async () => {
    const { ctx, view: loaded } = await view();
    const rb: RbLookup = { locale: 'en', rbKey: (key) => (key === 'user.advanced' ? '' : key), messageFormat: () => '' };

    await expect(renderEditProfile({ ...ctx, rb }, loaded)).rejects.toThrow(
      new RangeError('listGetAt: no tab label at position 4'),
    );
  });

  it('refuses a bean value that is not simple', async () => {
    const { ctx, view: loaded } = await view(profileOf({}, { Fname: { first: 'Ada' } as unknown as string }));

    await expect(renderEditProfile(ctx, loaded)).rejects.toThrow(new TypeError('userBean.Fname is not a simple value'));
  });
});

describe('cEditProfile.update', () => {
  const POSTED: Fields = { fname: 'Ada', lname: 'Lovelace', email: 'not-an-email', userid: USER_ID, siteid: 'default' };

  const updateRequest = (rc: Fields = { ...POSTED, ...CSRF_FIELDS }, partial: AdminRequestPartial = {}): AdminRequest =>
    adminS2Request({ ...partial, circuit: 'ceditprofile', item: 'update', rc });

  const updateContext = (result: FakeReply, req: AdminRequest = updateRequest()) =>
    contextFor(req, profileOf({ addresses: [addressOf(1, { isPrimary: 1 })] }), { [UPDATE_ROUTE]: result });

  const saved: UpdateResult = { written: true, redirect: { action: 'home.redirect', params: {} }, errors: {} };
  const rejected: UpdateResult = {
    written: false,
    errors: { email: 'Please enter a valid email address.' },
    userBean: { ...PERSON, Fname: 'Ada', Lname: 'Lovelace', Email: 'not-an-email' },
  };

  const editBeanWrite = (req: AdminRequest): { present: boolean; value: unknown } => {
    const writes: Readonly<Record<string, unknown>> = req.sessionWrites.muraValues ?? {};
    return { present: Object.hasOwn(writes, 'editBean'), value: writes['editBean'] };
  };

  it.each<[string, UpdateResult['redirect']]>([
    ['the admin redirect', { action: 'home.redirect', params: {} }],
    ['a return URL', { url: './?muraAction=cArch.list' }],
  ])("posts every rc field and answers home.redirect after people's save with %s", async (_case, redirect) => {
    const req = updateRequest(undefined, { session: { muraValues: { editBean: { errors: { email: 'old' } } } } });
    const ctx = updateContext(ok({ ...saved, redirect }), req);

    await expect(updateProfileAction.redirect?.(ctx)).resolves.toEqual({ kind: 'redirect', action: 'home.redirect', path: './' });
    expect(ctx.gateway.calls).toEqual([
      { service: 'people', method: 'POST', path: '/v1/profile:update', form: Object.fromEntries(Object.entries(req.rc)) },
    ]);
    expect(ctx.gateway.calls[0]?.form).toMatchObject({ ...POSTED, ...CSRF_FIELDS });
    expect(editBeanWrite(req)).toEqual({ present: true, value: undefined });
  });

  it('keeps the failed save in the session and re-renders the form with its values and errors', async () => {
    const req = updateRequest();
    const ctx = updateContext(ok(rejected), req);

    await expect(updateProfileAction.redirect?.(ctx)).resolves.toBeUndefined();
    expect(editBeanWrite(req)).toEqual({ present: true, value: { userBean: rejected.userBean, errors: rejected.errors } });
    const view = await updateProfileAction.load?.(ctx);
    if (view === undefined) throw new Error('update has a load step');

    expect(view.profile).toMatchObject({ user: rejected.userBean, errors: rejected.errors, retained: true });
    expect(view.profile.addresses).toHaveLength(1);
    expect(view.userSite.siteId).toBe('default');
    const body = toString((await updateProfileAction.render(ctx, view)).body);
    expect(body).toContain('<div class="alert alert-error"><span> Please enter a valid email address. </span></div>');
    expect(controlsOf(body).filter(([name]) => ['fname', 'lname', 'email'].includes(name))).toEqual([
      ['fname', 'text', 'Ada', false],
      ['lname', 'text', 'Lovelace', false],
      ['email', 'text', 'not-an-email', false],
    ]);
  });

  it('falls back to the stored user when people returns errors without a bean', async () => {
    const ctx = updateContext(ok({ written: false, errors: { fname: 'Required.' } }));

    await updateProfileAction.redirect?.(ctx);
    const view = await updateProfileAction.load?.(ctx);

    expect(view?.profile).toMatchObject({ user: PERSON, errors: { fname: 'Required.' }, retained: true });
  });

  it.each<[string, FakeReply, unknown, string]>([
    ['a 200 without errors or redirect', ok({ written: false, errors: {} }), TypeError, 'Element USERBEAN is undefined in RC.'],
    ['a 500 for a rejected token', { status: 500, body: { error: 'csrf' } }, Error, 'updateProfile answered HTTP 500'],
  ])('fails as legacy does on %s', async (_case, reply, type, message) => {
    const req = updateRequest(POSTED);
    const ctx = updateContext(reply, req);

    const failure = updateProfileAction.redirect?.(ctx);

    await expect(failure).rejects.toBeInstanceOf(type);
    await expect(failure).rejects.toThrow(message);
    expect(editBeanWrite(req).present).toBe(false);
  });

  it.each([401, 403] as const)("raises people's %i as a denial", async (status) => {
    const failure = updateProfileAction.redirect?.(updateContext({ status, body: { error: 'denied' } }));

    await expect(failure).rejects.toMatchObject({ service: 'people', operation: 'updateProfile', status });
  });

  it('propagates the 503 of a withheld branch', async () => {
    const failure = updateProfileAction.redirect?.(updateContext({ status: 503, body: { error: 'withheld' } }));

    await expect(failure).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it('refuses to load before its controller step', async () => {
    await expect(updateProfileAction.load?.(updateContext(ok(rejected)))).rejects.toThrow(
      'cEditProfile.update loaded before its controller step ran',
    );
  });

  it('renders the failed save in the shell, and fires the home redirect after a save', async () => {
    const failedPage = await renderScreenPage(updateProfileAction, updateContext(ok(rejected)));
    if (failedPage.kind !== 'document') throw new Error(`redirected to ${failedPage.location}`);
    expect(failedPage.html).toContain('Please enter a valid email address.');

    await expect(renderScreenPage(updateProfileAction, updateContext(ok(saved)))).rejects.toThrow('fires (to home.redirect)');
  });

  it('sends an anonymous post to the login form without calling people', async () => {
    const req = anonymousRequest({ circuit: 'ceditprofile', item: 'update', rc: { ...POSTED, ...CSRF_FIELDS } });
    const ctx = updateContext(ok(saved), req);

    const page = await renderScreenPage(updateProfileAction, ctx);

    expect(page).toEqual({ kind: 'redirect', location: loginLocation('update') });
    expect(ctx.gateway.calls.filter(({ service }) => service === 'people')).toEqual([]);
  });
});
