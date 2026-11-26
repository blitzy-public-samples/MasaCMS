// cEditProfile.update without a photo for the tenant-a system user, against ceditprofile.cfc update(),
// ceditprofile/update.cfm and the edit.cfm form it re-renders.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secure } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { ceditprofileScreens } from '@/screens/ceditprofile';
import { ceditprofileGate, type ProfileData } from '@/screens/ceditprofile/edit';
import { updateProfileAction } from '@/screens/ceditprofile/update';
import { PROFILE_USER_ID, profileData, profileUpdateSuccess } from '../../fixtures/people/profile';
import { invalidEmailResult, missingEmailResult, passwordMismatchResult } from '../../fixtures/people/validation-errors';
import { INTEREST_CATEGORY_IDS, interestCategories } from '../../fixtures/strategies-content/categories';
import { anonymousRequest, makeAdminRequest } from '../../helpers/admin-request';
import { domModel, fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type FakeRoute } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';
import { SUBJECTS } from '../../helpers/tokens';

// The registry pulls in every circuit's screens; the shell reads only its hooks, and cEditProfile has no secondary menu.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type UpdateResult = typeof profileUpdateSuccess;
type Fields = Readonly<Record<string, string>>;
type Context = ReturnType<typeof makeScreenContext>;

const TENANT_A = SUBJECTS.systemUser.site;
const UPDATE_PATH = '/v1/profile:update';
const UPDATE_ROUTE = routeKey('POST', 'people', UPDATE_PATH);
const PROFILE_ROUTE = routeKey('GET', 'people', '/v1/profile');
const INTEREST_GROUPS_PATH = `/v1/sites/${TENANT_A}/private-interest-groups` as const;
const INTEREST_GROUPS_ROUTE = routeKey('GET', 'strategies-content', INTEREST_GROUPS_PATH);
const CSRF_TOKENS_PATH = '/v1/csrf/tokens';
const HOME_ADDRESS_ID = profileData.addresses[0]?.addressID ?? '';

/** form1 as the browser posts it with no interest checked: changed values, hidden fields and the default-context pair. */
const profileFields = Object.freeze({
  fname: 'Casey-Jo',
  lname: 'Taylor-Reed',
  email: 'casey.reed@example.com',
  company: 'Riverton Outreach & Aid',
  jobtitle: 'Outreach Lead',
  mobilePhone: '555-0199',
  usernameNoCache: 'casey_reed',
  passwordNoCache: '',
  password2: '',
  tags: 'mentoring,outreach,training',
  subscribe: '0',
  primaryAddressID: HOME_ADDRESS_ID,
  subtype: 'Volunteer',
  type: '2',
  action: '',
  contact: '0',
  userid: PROFILE_USER_ID,
  siteid: TENANT_A,
  csrf_token: FIXED_CSRF.token,
  csrf_token_expires: FIXED_CSRF.expires,
});

/** The form1 fields people's bean reflects, as text. */
type ProfileForm = { readonly [Name in keyof typeof profileFields]: string };

/** form1 with two interests checked. */
const postedFields = Object.freeze({
  ...profileFields,
  categoryID: `${INTEREST_CATEGORY_IDS.newsletter},${INTEREST_CATEGORY_IDS.training}`,
});

/** The stored profile without interests. */
const storedWithoutInterests: ProfileData = { ...profileData, categoryIds: [] };

/** strategies-content's answer for a private pool without interest groups. */
const NO_INTEREST_GROUPS: FakeReply = { status: 200, body: { items: [] } };

type InterestNode = (typeof interestCategories)[number];

/** strategies-content `listPrivateInterestGroups` over the fixture tree: the level `parentid` names, interest groups only. */
const interestGroupsRoute: FakeRoute = ({ query }) => {
  const parentId = typeof query['parentid'] === 'string' ? query['parentid'] : '';
  const levelOf = (nodes: readonly InterestNode[]): readonly InterestNode[] | undefined => {
    for (const node of nodes) {
      if (node.categoryID === parentId) return node.children;
      const nested = levelOf(node.children);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  const level = parentId === '' ? interestCategories : (levelOf(interestCategories) ?? []);
  const items = level
    .filter((node) => Number(node.isInterestGroup) === 1)
    .map(({ categoryID, name, filename, urltitle, isOpen, hasKids }) => ({ categoryID, name, filename, urltitle, isOpen: Number(isOpen), hasKids }));
  return { status: 200, body: { items } };
};

/** `session.mura.editBean` an earlier failed save left. */
const PRIOR_EDIT_BEAN = Object.freeze({
  userBean: { ...profileData.user, Email: '' },
  errors: missingEmailResult.errors,
});

/** people's `userBean` of a refused save: the session user with the posted values, as userManager.update sets them. */
const erroredBean = (fields: ProfileForm): ProfileData['user'] => ({
  ...profileData.user,
  Fname: fields.fname,
  Lname: fields.lname,
  Email: fields.email,
  Company: fields.company,
  JobTitle: fields.jobtitle,
  mobilePhone: fields.mobilePhone,
  UserName: fields.usernameNoCache,
  tags: fields.tags,
  Subscribe: Number(fields.subscribe),
  subType: fields.subtype,
});

// The validation fixtures carry a new user's bean; people answers a profile save with the session user's instead.
/** people's 200 refusing a save with `result`'s errors over `fields`. */
const refusal = (result: UpdateResult, fields: ProfileForm): FakeReply => ({
  status: 200,
  body: { ...result, userBean: erroredBean(fields) },
});

/** people's 500 for a missing or invalid token, which legacy fails on as its view reads the unset `rc.userBean`. */
const CSRF_REJECTION: FakeReply = {
  status: 500,
  body: {
    apiversion: 'v1',
    method: 'updateProfile',
    error: { message: 'Element USERBEAN is undefined in RC.', code: 'server_error' },
  },
};

/** The tenant-a system user posting `fields`; `muraValues` seeds the session's post-login values. */
const updateRequest = (fields: Fields, muraValues: Readonly<Record<string, unknown>> = {}): AdminRequest =>
  makeAdminRequest(
    { circuit: 'ceditprofile', item: 'update', session: { siteid: TENANT_A, muraValues }, rc: fields },
    SUBJECTS.systemUser,
  );

/** A context whose people answers the save with `reply` and `getProfile` with `stored`, and strategies-content `interestGroups`. */
const updateContext = (
  req: AdminRequest,
  reply: FakeReply,
  stored: ProfileData = profileData,
  interestGroups: FakeRoute = NO_INTEREST_GROUPS,
): Context =>
  makeScreenContext({
    req,
    gateway: fakeGatewayClient({
      [UPDATE_ROUTE]: reply,
      [PROFILE_ROUTE]: { status: 200, body: stored },
      [INTEREST_GROUPS_ROUTE]: interestGroups,
    }),
  });

/** The `editBean` entry the request queued for the session, and whether it queued one. */
function editBeanWrite(req: AdminRequest): { present: boolean; value: unknown } {
  const writes: Readonly<Record<string, unknown>> = req.sessionWrites.muraValues ?? {};
  return { present: Object.hasOwn(writes, 'editBean'), value: writes['editBean'] };
}

/** Calls that are neither reads nor identity's token issue. */
const writeCalls = (ctx: Context): Context['gateway']['calls'] =>
  ctx.gateway.calls.filter(
    ({ service, method, path }) => method !== 'GET' && !(service === 'identity' && path === CSRF_TOKENS_PATH),
  );

/** The one people save call, with the request's rc as its form. */
const saveCall = (req: AdminRequest): Context['gateway']['calls'][number] => ({
  service: 'people',
  method: 'POST',
  path: UPDATE_PATH,
  form: Object.fromEntries(Object.entries(req.rc)),
});

/** `displayErrors`' messages: every value but `siteID`'s, in key order. */
const messagesOf = (errors: UpdateResult['errors']): string[] =>
  Object.entries(errors)
    .filter(([key]) => key.toLowerCase() !== 'siteid')
    .map(([, message]) => message);

/** The texts `selector`'s `<br>` elements separate, trimmed, empty ones dropped. */
function brSeparated($: cheerio.CheerioAPI, selector: string): string[] {
  const parts = [''];
  $(selector)
    .contents()
    .each((_index, node) => {
      if ($(node).is('br')) parts.push('');
      else parts[parts.length - 1] += $(node).text();
    });
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('cEditProfile.update definition and gate', () => {
  it('is the people-owned page action behind the cEditProfile gate, halted outside the barrel', () => {
    expect(ceditprofileScreens).not.toContain(updateProfileAction);
    expect(updateProfileAction).toMatchObject({ circuit: 'ceditprofile', action: 'update', owner: 'people', mode: 'page' });
    expect(updateProfileAction.gate).toBe(ceditprofileGate);
  });

  it("sends an anonymous post to secure()'s cLogin.main without calling people", async () => {
    const req = anonymousRequest({ circuit: 'ceditprofile', item: 'update', rc: postedFields });
    const ctx = updateContext(req, { status: 200, body: profileUpdateSuccess });

    const page = await renderScreenPage(updateProfileAction, ctx);

    expect(page).toEqual(secure(req));
    if (page.kind !== 'redirect') throw new Error('expected a redirect');
    expect(new URLSearchParams(page.location.split('?')[1] ?? '').get('muraAction')).toBe('cLogin.main');
    expect(ctx.gateway.calls.filter(({ service }) => service === 'people')).toEqual([]);
  });
});

describe('cEditProfile.update saved by people', () => {
  let req: AdminRequest;
  let ctx: Context;
  let result: Awaited<ReturnType<NonNullable<typeof updateProfileAction.redirect>>>;

  beforeEach(async () => {
    req = updateRequest(postedFields, { editBean: PRIOR_EDIT_BEAN });
    ctx = updateContext(req, { status: 200, body: profileUpdateSuccess });
    result = await updateProfileAction.redirect?.(ctx);
  });

  it('posts as the profile user', () => {
    expect(req.user?.sub).toBe(PROFILE_USER_ID);
  });

  it('forwards every posted field byte for byte, the CSRF pair included', () => {
    const form = ctx.gateway.calls.find(({ path }) => path === UPDATE_PATH)?.form ?? {};

    expect(Object.fromEntries(Object.keys(postedFields).map((name) => [name, form[name]]))).toEqual(postedFields);
    expect(form).toEqual(Object.fromEntries(Object.entries(req.rc)));
  });

  it('makes the people save its only call', () => {
    expect(ctx.gateway.calls).toEqual([saveCall(req)]);
  });

  it('answers the FW/1 redirect to home.redirect at ./', () => {
    expect(result).toStrictEqual({ kind: 'redirect', action: 'home.redirect', path: './' });
  });

  it('clears the retained editBean', () => {
    expect(editBeanWrite(req)).toEqual({ present: true, value: undefined });
    expect(req.session.muraValues['editBean']).toBeUndefined();
  });
});

const REFUSALS: ReadonlyArray<readonly [string, UpdateResult, Fields]> = [
  ['missingEmailResult', missingEmailResult, { email: '' }],
  ['invalidEmailResult', invalidEmailResult, { email: 'casey.reed.example.com' }],
  ['passwordMismatchResult', passwordMismatchResult, { passwordNoCache: 'typed-once', password2: 'typed-twice' }],
  [
    'every message but siteID',
    {
      ...missingEmailResult,
      errors: { siteID: 'Invalid site.', ...missingEmailResult.errors, ...passwordMismatchResult.errors },
    },
    { email: '', passwordNoCache: 'typed-once', password2: 'typed-twice' },
  ],
];

describe.each(REFUSALS)('cEditProfile.update refused by people with %s', (_name, result, overrides) => {
  const fields = { ...profileFields, ...overrides };
  const reply = refusal(result, fields);
  let req: AdminRequest;
  let ctx: Context;
  let html: string;
  let $: cheerio.CheerioAPI;

  beforeEach(async () => {
    req = updateRequest(fields);
    ctx = updateContext(req, reply, storedWithoutInterests);
    const page = await renderScreenPage(updateProfileAction, ctx);
    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    html = page.html;
    $ = cheerio.load(html);
  });

  it('re-renders in the same response after the one save, retaining the errored bean', () => {
    expect(writeCalls(ctx)).toEqual([saveCall(req)]);
    expect(editBeanWrite(req)).toEqual({ present: true, value: { userBean: erroredBean(fields), errors: result.errors } });
  });

  it('shows the messages in one alert-error, separated as displayErrors separates them', () => {
    const alerts = domModel(html).alerts.filter(({ className }) => className.split(' ').includes('alert-error'));

    expect(alerts).toEqual([{ className: 'alert alert-error', text: messagesOf(result.errors).join(' ') }]);
    expect(brSeparated($, '.alert-error > span')).toEqual(messagesOf(result.errors));
  });

  it('refills form1 with the posted values and leaves the passwords empty', () => {
    const controls = fragmentModel($.html($('form[name="form1"]'))).controls;

    expect(controls.map((c) => [c.name, c.type, c.value, c.checked])).toEqual([
      ['subtype', 'select-one', fields.subtype, false],
      ['fname', 'text', fields.fname, false],
      ['lname', 'text', fields.lname, false],
      ['company', 'text', fields.company, false],
      ['jobtitle', 'text', fields.jobtitle, false],
      ['email', 'text', fields.email, false],
      ['mobilePhone', 'text', fields.mobilePhone, false],
      ['usernameNoCache', 'text', fields.usernameNoCache, false],
      ['passwordNoCache', 'password', '', false],
      ['password2', 'password', '', false],
      ['newFile', 'file', '', false],
      ['primaryAddressID', 'radio', HOME_ADDRESS_ID, true],
      ['subscribe', 'radio', '1', false],
      ['subscribe', 'radio', '0', true],
      ['tags', 'text', fields.tags, false],
      ['type', 'hidden', '2', false],
      ['action', 'hidden', '', false],
      ['contact', 'hidden', '0', false],
      ['userid', 'hidden', PROFILE_USER_ID, false],
      ['siteid', 'hidden', TENANT_A, false],
      ['csrf_token', 'hidden', FIXED_CSRF.token, false],
      ['csrf_token_expires', 'hidden', FIXED_CSRF.expires, false],
    ]);
  });

  it('posts form1 again to cEditProfile.update with a new default-context CSRF pair', () => {
    expect($('form[name="form1"]').attr('action')).toBe('./?muraAction=cEditProfile.update');
    expect(ctx.gateway.calls.filter(({ path }) => path === CSRF_TOKENS_PATH)[0]).toMatchObject({
      service: 'identity',
      method: 'POST',
      json: { contexts: [''] },
    });
  });
});

describe('cEditProfile.update view after a refused save', () => {
  it('sees the before() defaults for the keys form1 does not post', async () => {
    const fields = { ...profileFields, email: '' };
    const ctx = updateContext(updateRequest(fields), refusal(missingEmailResult, fields), storedWithoutInterests);

    await updateProfileAction.redirect?.(ctx);
    const view = await updateProfileAction.load?.(ctx);

    expect(view?.rc).toMatchObject({
      returnurl: '',
      startrow: '1',
      routeid: '',
      categoryID: '',
      fname: fields.fname,
      email: '',
    });
    expect(view?.rc['Type']).toBe('2');
    expect(view?.routeId).toBe('editprofile');
  });

  it('re-renders a save naming interests with the posted selections in place of the stored ones and the errored bean', async () => {
    const fields = { ...profileFields, email: '' };
    const { newsletter, volunteering, training } = INTEREST_CATEGORY_IDS;
    const req = updateRequest({ ...fields, categoryID: training });
    const ctx = updateContext(req, refusal(missingEmailResult, fields), profileData, interestGroupsRoute);
    expect(profileData.categoryIds).toEqual([newsletter]);

    const page = await renderScreenPage(updateProfileAction, ctx);

    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const $ = cheerio.load(page.html);
    const controls = fragmentModel($.html($('form[name="form1"]'))).controls;
    expect(editBeanWrite(req)).toEqual({ present: true, value: { userBean: erroredBean(fields), errors: missingEmailResult.errors } });
    expect($('.alert-error > span').text().trim()).toBe(messagesOf(missingEmailResult.errors).join(' '));
    expect(
      controls.filter(({ name }) => ['fname', 'email', 'tags', 'categoryID'].includes(name)).map((c) => [c.name, c.type, c.value, c.checked]),
    ).toEqual([
      ['fname', 'text', fields.fname, false],
      ['email', 'text', '', false],
      ['categoryID', 'checkbox', newsletter, false],
      ['categoryID', 'checkbox', volunteering, false],
      ['categoryID', 'checkbox', training, true],
      ['tags', 'text', fields.tags, false],
    ]);
    expect(ctx.gateway.calls.filter(({ path }) => path === INTEREST_GROUPS_PATH).map(({ query }) => query)).toEqual([
      { groupsiteid: TENANT_A, parentid: '' },
      { groupsiteid: TENANT_A, parentid: INTEREST_CATEGORY_IDS.interests },
    ]);
  });

  it('fails closed when strategies-content cannot serve the interest groups, the errored bean kept', async () => {
    const req = updateRequest(postedFields);
    const ctx = updateContext(req, refusal(missingEmailResult, postedFields), profileData, { status: 503, body: { error: 'down' } });

    await expect(renderScreenPage(updateProfileAction, ctx)).rejects.toMatchObject({
      name: 'GatewayUnavailableError',
      service: 'strategies-content',
    });
    expect(editBeanWrite(req)).toEqual({
      present: true,
      value: { userBean: erroredBean(postedFields), errors: missingEmailResult.errors },
    });
  });
});

describe('cEditProfile.update with a rejected token', () => {
  // people answers a rejected token with its contract's 500, which the page fails on as legacy's view does.
  it.each<readonly [string, FakeReply, new (...args: never[]) => Error, string]>([
    ["people's 500", CSRF_REJECTION, Error, 'updateProfile answered HTTP 500'],
    [
      'a 200 that wrote nothing and names no error',
      { status: 200, body: { written: false, errors: {} } },
      TypeError,
      'Element USERBEAN is undefined in RC.',
    ],
  ])('fails on %s without redirecting, keeping the retained editBean', async (_case, reply, type, message) => {
    const req = updateRequest(postedFields, { editBean: PRIOR_EDIT_BEAN });
    const ctx = updateContext(req, reply);

    const failure = renderScreenPage(updateProfileAction, ctx);

    await expect(failure).rejects.toBeInstanceOf(type);
    await expect(failure).rejects.toThrow(message);
    expect(ctx.gateway.calls).toEqual([saveCall(req)]);
    expect(editBeanWrite(req).present).toBe(false);
    expect(req.session.muraValues['editBean']).toEqual(PRIOR_EDIT_BEAN);
  });
});
