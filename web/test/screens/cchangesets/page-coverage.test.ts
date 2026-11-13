// cChangesets list, edit and save against cchangesets.cfc and its views over the strategies-content screen models.
import * as cheerio from 'cheerio';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGate } from '@/lib/access-gate';
import { createCsrfRenderer } from '@/lib/csrf';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError, GatewayUnavailableError, createGatewayClient } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import {
  CCHANGESETS_RC_DEFAULTS,
  applyCchangesetsDefaults,
  cchangesetsGate,
  cchangesetsScreens,
} from '@/screens/cchangesets';
import {
  changesetEditData,
  changesetEditScreen,
  loadChangesetEdit,
  renderChangesetEditView,
  renderDateTimeSelector,
  renderDisplayErrors,
  type DateTimeSelectorSession,
} from '@/screens/cchangesets/edit';
import { changesetListScreen, loadChangesetList, renderChangesetList } from '@/screens/cchangesets/list';
import { changesetSaveScreen } from '@/screens/cchangesets/save';
import type { PageScreen, ScreenContext, ScreenDefinition } from '@/screens/registry';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  fakeServiceClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeServiceClient,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage, shellRoutes } from '../../helpers/screen-context';

// The registry imports every circuit barrel; the shell reads only its hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type Fields = Readonly<Record<string, unknown>>;
type RcFields = Readonly<Record<string, string>>;

const CHANGESET_ID = '7C1A2B3D-4E5F-4A6B-8C9D0E1F2A3B4C5D';
const SECOND_ID = '7C1A2B3D-4E5F-4A6B-8C9D0E1F2A3B4C5E';
const PARENT_ID = '24084683-CDC3-92F3-5638DA2185FAE575';
const CHILD_ID = '24085855-BC9D-74BB-0514207B8DED0B94';
const SIBLING_ID = '24085D49-CACA-CA17-666F018EE47D54C8';
const ORPHAN_ID = '24086971-D103-C12F-3902C281950D3F38';
const PREVIEW_LINK = `http://localhost:8080/default/?changesetID=${CHANGESET_ID}`;
const CSRF_URL = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;
const CSRF_FIELDS: RcFields = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const CHANGESETS_MODULE_ID = '00000000000000000000000000000000014';
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';

const LIST_PATH = '/v1/sites/default/changesets';
const changesetPath = (id: string, siteid = 'default'): `/${string}` => `/v1/sites/${siteid}/changesets/${id}`;
const LIST_ROUTE = routeKey('GET', 'strategies-content', LIST_PATH);
const SAVE_ROUTE = routeKey('POST', 'strategies-content', LIST_PATH);
const EDIT_ROUTE = routeKey('GET', 'strategies-content', changesetPath(CHANGESET_ID));

const ok = (body: unknown): FakeReply => ({ status: 200, body });

/** A registered cChangesets action, behind the circuit gate and `before()` defaults. */
function registered(action: string): ScreenDefinition {
  const def = cchangesetsScreens.find((screen) => screen.action === action);
  if (def === undefined) throw new Error(`cchangesets.${action} is not registered`);
  return def;
}

const registeredPage = (action: string): PageScreen<unknown> => {
  const def = registered(action);
  if (def.mode !== 'page') throw new Error(`cchangesets.${action} is a ${def.mode} screen`);
  return def;
};

/** Clears every `MURA_` variable so legacy settings take their template values. */
function useSettings(): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  resetLegacySettingsForTests();
}

const $of = (markup: string): cheerio.CheerioAPI => cheerio.load(markup, null, false);

/** Every CSRF context identity was asked to issue. */
const csrfContexts = (gateway: FakeGatewayClient): string[] =>
  gateway.calls
    .filter(({ service, path }) => service === 'identity' && path === '/v1/csrf/tokens')
    .flatMap(({ json }) => (json as { contexts: string[] }).contexts);

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

// ---- Screen models, as strategies-content reports the views' rc values ----

/** `changesetManager.read()` values of an unpublished change set; `fields` overrides any key. */
const beanOf = (fields: Fields = {}): Fields => ({
  changesetID: CHANGESET_ID,
  siteID: 'default',
  name: 'Spring "Launch" & <More>',
  description: 'Line 1\n<b>two</b>',
  closeDate: "{ts '2026-07-01 09:30:00'}",
  publishDate: '',
  lastUpdate: "{ts '2026-06-15 14:05:09'}",
  published: 0,
  isNew: 0,
  tags: 'spring,sale & more',
  categoryID: '',
  errors: {},
  ...fields,
});

/** The edit screen model of {@link beanOf}`(bean)` on a site without categories; `fields` overrides any member. */
const editModel = (fields: Fields = {}, bean: Fields = {}): Fields => ({
  changeset: beanOf(bean),
  hasPendingApprovals: false,
  categoryCount: 0,
  categories: [],
  previewLink: PREVIEW_LINK,
  ...fields,
});

/** `tcontentcategories` rows of the site: a parent, its two children (one keyed by a recased padded id), an orphan. */
const CATEGORY_ROWS: readonly Fields[] = [
  { categoryID: PARENT_ID, parentID: null, name: 'Parent & Co', isOpen: 1, permitted: 1 },
  { categoryID: CHILD_ID, parentID: `${PARENT_ID.toLowerCase()}  `, name: 'Child', isOpen: 'yes', permitted: 0 },
  { categoryID: ORPHAN_ID, parentID: 'NO-SUCH-PARENT', name: 'Orphan', isOpen: 1, permitted: 1 },
  { categoryID: SIBLING_ID, parentID: PARENT_ID, name: 'Sibling', isOpen: 0, permitted: 1 },
];

const changesetRequest = (item: string, rc: RcFields = {}, partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ ...partial, circuit: 'cChangesets', item, rc: { changesetID: CHANGESET_ID, ...rc } });

/** A context whose strategies-content answers `routes`. */
const contextFor = (req: AdminRequest, routes: Readonly<Record<string, FakeReply>>) =>
  makeScreenContext({ req, gateway: fakeGatewayClient(routes) });

describe('cChangesets before()', () => {
  const bothModules = [Roles.systemUser, moduleRole(CHANGESETS_MODULE_ID), moduleRole(SITE_MANAGER_MODULE_ID)];
  const editorWithBoth = (rc: RcFields = {}): AdminRequest =>
    editorRequest({ circuit: 'cChangesets', item: 'list', rc, user: { roles: bothModules } });

  it.each<[string, () => AdminRequest, string | undefined]>([
    ['the S2 admin on its site', () => changesetRequest('list'), undefined],
    ['the S2 admin on another site', () => changesetRequest('list', { siteid: 'tenant-b' }), undefined],
    [
      "a site admin on its token's site",
      () => siteAdminRequest('tenant-a', { circuit: 'cChangesets', item: 'list', rc: { siteid: 'tenant-a' } }),
      undefined,
    ],
    [
      'a site admin on another site',
      () => siteAdminRequest('tenant-a', { circuit: 'cChangesets', item: 'list', rc: { siteid: 'tenant-b' } }),
      './',
    ],
    [
      'a site admin whose empty rc.siteid reads as default',
      () => siteAdminRequest('tenant-a', { circuit: 'cChangesets', item: 'list', rc: { siteid: '' } }),
      './',
    ],
    ['an editor with Site Manager access only', () => editorRequest({ circuit: 'cChangesets', item: 'list' }), './'],
    ['an editor with Change Sets and Site Manager access', () => editorWithBoth(), undefined],
    ["that editor on a site its token does not serve", () => editorWithBoth({ siteid: 'tenant-a' }), './'],
    [
      'a refused editor, back to its referrer',
      () =>
        editorRequest({
          circuit: 'cChangesets',
          item: 'list',
          headers: new Headers({ referer: 'http://localhost/admin/?muraAction=cArch.list' }),
        }),
      'http://localhost/admin/?muraAction=cArch.list',
    ],
  ])('admits or secures %s as legacy does', async (_who, req, location) => {
    const decision = await runGate(req(), cchangesetsGate);

    expect(decision).toEqual(location === undefined ? { kind: 'allow' } : { kind: 'redirect', location });
  });

  it('sends an anonymous request to the login form', async () => {
    const decision = await runGate(anonymousRequest({ circuit: 'cChangesets', item: 'list' }), cchangesetsGate);

    const returnUrl = encodeURIComponent('http://localhost/admin/?&muraAction=cChangesets.list');
    expect(decision).toEqual({
      kind: 'redirect',
      location: `./?muraAction=cLogin.main&returnURL=${returnUrl}&compactDisplay=false`,
    });
  });

  it('adds the param defaults in legacy order where no key of the name exists', () => {
    const req = changesetRequest('list', { PAGE: '3', Keywords: 'spring' });

    const rc = applyCchangesetsDefaults(req.rc);

    expect(Object.keys(CCHANGESETS_RC_DEFAULTS)).toEqual(['startrow', 'startdate', 'stopdate', 'page', 'keywords', 'categoryid', 'tags']);
    expect(Object.keys(rc).slice(-4)).toEqual(['startrow', 'startdate', 'stopdate', 'tags']);
    expect({ page: rc.page, keywords: rc.keywords, startrow: rc.startrow, tags: rc.tags }).toEqual({
      page: '3',
      keywords: 'spring',
      startrow: '1',
      tags: '',
    });
    expect(Object.keys(rc).filter((name) => name.toLowerCase() === 'page')).toEqual(['PAGE']);
    expect(Object.keys(rc).filter((name) => name.toLowerCase() === 'categoryid')).toEqual(['categoryID']);
    expect(applyCchangesetsDefaults(rc)).toBe(rc);
  });

  it('registers the carried actions behind the gate, leaving publish on legacy', () => {
    expect(cchangesetsScreens.map(({ action, mode }) => `${action}:${mode}`)).toEqual([
      'list:page',
      'assignments:page',
      'edit:page',
      'save:page',
      'rollback:redirect',
      'removeitem:redirect',
      'delete:redirect',
      'loadtagarray:fragment',
    ]);
    expect(cchangesetsScreens.every((screen) => screen.gate === cchangesetsGate)).toBe(true);
    expect(cchangesetsScreens.some((screen) => screen.action === 'publish')).toBe(false);
  });

  it("runs a page's load and render on the request before() leaves", async () => {
    const req = changesetRequest('list');
    const ctx = contextFor(req, { [LIST_ROUTE]: ok({ rc: listModel() }) });
    const list = registeredPage('list');

    const data = await list.load?.(ctx);
    const view = await list.render(ctx, data);

    expect(ctx.req).not.toBe(req);
    expect(ctx.req.rc.page).toBe('1');
    expect(ctx.gateway.calls[0]?.query).toEqual({ ...CCHANGESETS_RC_DEFAULTS });
    expect(toString(view.body)).toContain('<h1>Content Staging</h1>');
  });

  it("runs a post action's submit on the defaulted request", async () => {
    const route = routeKey('POST', 'strategies-content', `${changesetPath(CHANGESET_ID)}/rollback`);
    const ctx = contextFor(changesetRequest('rollback', CSRF_FIELDS), { [route]: ok({ saved: true, errors: {}, redirect: null }) });
    const rollback = registered('rollback');
    if (rollback.mode !== 'redirect') throw new Error('rollback is a post action');

    await expect(rollback.submit(ctx)).resolves.toMatchObject({ kind: 'redirect', action: 'cChangesets.edit' });
    expect(ctx.gateway.calls[0]?.form).toMatchObject({ page: '1', keywords: '', tags: '', ...CSRF_FIELDS });
  });

  it('runs a fragment render, which has no load, on the defaulted request', async () => {
    const route = routeKey('GET', 'strategies-content', '/v1/raw/cchangesets/loadtagarray');
    const ctx = contextFor(changesetRequest('loadtagarray'), {
      [route]: { status: 200, headers: { 'content-type': 'text/javascript' }, body: "['spring']" },
    });
    const fragment = registered('loadtagarray');
    if (fragment.mode !== 'fragment') throw new Error('loadtagarray is a fragment');

    expect(fragment.load).toBeUndefined();
    const raw = await fragment.render(ctx, undefined);
    expect(raw).toMatchObject({ status: 200, contentType: 'text/javascript' });
    expect(ctx.gateway.calls[0]?.query).toMatchObject({ page: '1', startrow: '1' });
  });
});

describe('cChangesets.edit model', () => {
  it('reads the bean, approvals, categories and preview link as CFML values', () => {
    const data = changesetEditData({
      CHANGESET: {
        CHANGESETID: CHANGESET_ID,
        SiteId: 'default',
        Name: 2026,
        description: null,
        closeDate: '',
        publishDate: '2026-07-03T08:15',
        lastUpdate: "{ts '2026-06-15 14:05:09'}",
        published: 'no',
        isNew: 'true',
        tags: 'a,b',
        categoryID: CHILD_ID,
      },
      hasPendingApprovals: 1,
      categoryCount: '3',
      categories: CATEGORY_ROWS,
    });

    expect(data).toEqual({
      changeset: {
        changesetId: CHANGESET_ID,
        siteId: 'default',
        name: '2026',
        description: '',
        closeDate: null,
        publishDate: new Date(2026, 6, 3, 8, 15),
        lastUpdate: new Date(2026, 5, 15, 14, 5, 9),
        published: false,
        isNew: true,
        hasPendingApprovals: true,
        tags: 'a,b',
        categoryId: CHILD_ID,
        errors: [],
      },
      categoryCount: 3,
      categories: [
        {
          categoryId: PARENT_ID,
          name: 'Parent & Co',
          isOpen: true,
          permitted: true,
          children: [
            { categoryId: CHILD_ID, name: 'Child', isOpen: true, permitted: false, children: [] },
            { categoryId: SIBLING_ID, name: 'Sibling', isOpen: false, permitted: true, children: [] },
          ],
        },
      ],
      previewLink: undefined,
    });
  });

  it('never asks a published change set about approvals, and keeps the error struct in order', () => {
    const data = changesetEditData(
      editModel({ hasPendingApprovals: 'not-a-boolean' }, { published: 1, errors: { name: 'Required.', siteID: 'x' } }),
    );

    expect(data.changeset).toMatchObject({ published: true, hasPendingApprovals: false });
    expect(data.changeset.errors).toEqual([
      ['name', 'Required.'],
      ['siteID', 'x'],
    ]);
    expect(data.previewLink).toBe(PREVIEW_LINK);
  });

  it.each<[string, Fields, string]>([
    ['no changeset', { changeset: undefined }, 'changeset is not a struct'],
    ['a complex name', { changeset: beanOf({ name: { text: 'x' } }) }, 'name is not a simple value'],
    ['an unreadable date', { changeset: beanOf({ closeDate: 'soon' }) }, 'closeDate is not a date: soon'],
    ['an error list instead of a struct', { changeset: beanOf({ errors: ['x'] }) }, 'errors is not a struct'],
    ['categories that are not rows', { categories: [1] }, 'categories is not a list of rows'],
  ])('rejects a model with %s', (_case, fields, message) => {
    expect(() => changesetEditData(editModel(fields))).toThrow(new TypeError(message));
  });
});

describe('cChangesets.edit load', () => {
  it('reads the change set of rc.changesetID and issues its CSRF context', async () => {
    const ctx = contextFor(changesetRequest('edit'), { [EDIT_ROUTE]: ok({ rc: editModel() }) });

    const data = await loadChangesetEdit(ctx);

    expect(ctx.gateway.calls[0]).toEqual({ service: 'strategies-content', method: 'GET', path: changesetPath(CHANGESET_ID) });
    expect(csrfContexts(ctx.gateway)).toEqual([CHANGESET_ID]);
    expect(data.changeset).toMatchObject({ changesetId: CHANGESET_ID, name: 'Spring "Launch" & <More>', isNew: false });
  });

  it('reads a fresh CF UUID for an empty id, so the service answers a new bean, and leaves rc as it is', async () => {
    const requested: string[] = [];
    const relay: FakeServiceClient = fakeServiceClient(shellRoutes(), (_req, request) => {
      const id = /\/changesets\/([^/]+)$/.exec(request.path)?.[1];
      if (request.method !== 'GET' || id === undefined) return;
      requested.push(id);
      relay.setRoute(`GET ${request.path}`, ok({ rc: editModel({}, { changesetID: id, isNew: 1, name: '', tags: '' }) }));
    });
    const gateway = createGatewayClient({ requestId: '', inbound: {} }, relay);
    const req = changesetRequest('edit', { changesetID: '' });
    const ctx: ScreenContext = { ...makeScreenContext({ req }), gateway, csrf: createCsrfRenderer(gateway) };

    const first = await loadChangesetEdit(ctx);
    await loadChangesetEdit(ctx);

    expect(requested).toHaveLength(2);
    expect(requested.every((id) => CF_UUID.test(id))).toBe(true);
    expect(requested[0]).not.toBe(requested[1]);
    expect(first.changeset).toMatchObject({ changesetId: requested[0], isNew: true });
    expect(ctx.req.rc.changesetID).toBe('');
    const $ = $of(toString(renderChangesetEditView(ctx, first)));
    expect($('h1').text()).toBe('Add Change Set');
    expect($('.nav-module-specific a').toArray().map((a) => $(a).text().trim())).toEqual(['Back to Change Sets']);
  });

  it('fails as ACF does without rc.changesetID, before any call', async () => {
    const ctx = contextFor(adminS2Request({ circuit: 'cChangesets', item: 'edit' }), {});

    await expect(loadChangesetEdit(ctx)).rejects.toThrow(
      new TypeError('Element CHANGESETID is undefined in a CFML structure referenced as part of an expression.'),
    );
    expect(ctx.gateway.calls).toEqual([]);
  });

  it.each([401, 403] as const)("raises strategies-content's %i, which the page answers with the access gate's redirect", async (status) => {
    const ctx = contextFor(changesetRequest('edit'), { [EDIT_ROUTE]: { status, body: { error: 'denied' } } });

    await expect(loadChangesetEdit(ctx)).rejects.toMatchObject({ service: 'strategies-content', operation: 'getChangeset', status });
    await expect(renderScreenPage(registered('edit'), ctx)).resolves.toEqual({
      kind: 'redirect',
      location: status === 401 ? '/admin/?muraAction=clogin.logout' : '/admin/?muraAction=cMessage.noaccess',
    });
  });

  it('fails on a 404 for an unknown id', async () => {
    const ctx = contextFor(changesetRequest('edit'), { [EDIT_ROUTE]: { status: 404, body: { error: 'notFound' } } });

    await expect(loadChangesetEdit(ctx)).rejects.toThrow('getChangeset answered HTTP 404');
  });
});

describe('cChangesets.edit view', () => {
  /** The rendered edit body of `model` for `req`. */
  async function rendered(model: Fields = editModel(), req: AdminRequest = changesetRequest('edit')) {
    const ctx = contextFor(req, { [EDIT_ROUTE]: ok({ rc: model }) });
    const data = await loadChangesetEdit(ctx);
    const body = toString((await changesetEditScreen.render(ctx, data)).body);
    return { ctx, data, body, $: $of(body) };
  }

  const buttons = ($: cheerio.CheerioAPI): Array<[string, string]> =>
    $('.form-actions button').toArray().map((b) => [$(b).text().trim(), $(b).attr('onclick') ?? '']);

  const confirmCall = (key: string, action: string): string =>
    `confirmDialog('${key}','./?muraAction=cChangesets.${action}&changesetID=${CHANGESET_ID}&siteid=default${CSRF_URL}')`;

  it('renders an unpublished change set with Delete, Update and Publish Now, its tokens on each URL', async () => {
    const { body, $ } = await rendered();

    expect($('h1').text()).toBe('Edit Change Set');
    expect($('.alert')).toHaveLength(0);
    expect($('form[name="form1"]').attr('action')).toBe('./?muraAction=cChangesets.save&siteid=default');
    expect($('ul.mura-tabs a').toArray().map((a) => [$(a).attr('href'), $(a).text()])).toEqual([
      ['#tabBasic', 'Basic'],
      ['#tabTags', 'Tags'],
    ]);
    expect($('#tabCategorization')).toHaveLength(0);
    expect($('input[name="name"]').val()).toBe('Spring "Launch" & <More>');
    expect($('textarea[name="description"]').text()).toBe('Line 1\n<b>two</b>');
    expect(buttons($)).toEqual([
      ['Delete', confirmCall('Delete\\x20Change\\x20Set\\x3F', 'delete')],
      ['Update', "submitForm(document.forms.form1,'update');"],
      ['Publish Now', confirmCall('Publish\\x20Changeset\\x20Now\\x3F', 'publish')],
    ]);
    expect(fragmentModel(body).controls.filter((c) => c.type === 'hidden' && c.name !== 'tags')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'changesetID', value: CHANGESET_ID }),
        expect.objectContaining({ name: 'action', value: '' }),
        expect.objectContaining({ name: 'csrf_token', value: FIXED_CSRF.token }),
        expect.objectContaining({ name: 'csrf_token_expires', value: FIXED_CSRF.expires }),
      ]),
    );
    expect($('.nav-module-specific a').toArray().map((a) => [$(a).text().trim(), $(a).attr('href')])).toEqual([
      ['Back to Change Sets', './?muraAction=cChangesets.list&siteid=default'],
      ['View Content Assignments List', `./?muraAction=cChangesets.assignments&siteid=default&changesetID=${CHANGESET_ID}`],
      ['Preview Change Set', '#'],
    ]);
  });

  it('writes the close and publish date-time selectors for the session locale', async () => {
    const { $ } = await rendered();
    const selected = (id: string): string | undefined => $(`#${id} option[selected]`).attr('value');

    expect($('#mura-datepicker-closeDate').val()).toBe('07/182/2026');
    expect($('#mura-closeDate').val()).toBe("{ts '2026-07-01 09:30:00'}");
    expect([selected('mura-closeDateHour'), selected('mura-closeDateMinute'), selected('mura-closeDateDayPart')]).toEqual([
      '9',
      '30',
      undefined,
    ]);
    expect($('#mura-datepicker-publishDate').val()).toBe('');
    expect($('#mura-publishDate').val()).toBe('');
    expect([selected('mura-publishDateHour'), selected('mura-publishDateMinute')]).toEqual(['12', '0']);
    expect($('select.mura-datepickercloseDate').toArray().map((s) => $(s).attr('name'))).toEqual(['', '', '']);
  });

  it('defaults an empty close date to 11:59 PM', async () => {
    const { $ } = await rendered(editModel({}, { closeDate: '' }));

    expect($('#mura-closeDateHour option[selected]').attr('value')).toBe('11');
    expect($('#mura-closeDateMinute option[selected]').attr('value')).toBe('59');
    expect($('#mura-closeDateDayPart option[selected]').attr('value')).toBe('PM');
  });

  it('warns of pending approvals and offers no publishing', async () => {
    const { $ } = await rendered(editModel({ hasPendingApprovals: true }));

    expect($('.alert').toArray().map((a) => [$(a).attr('class'), $(a).text()])).toEqual([
      ['alert alert-error', 'This change set contains content that has not been approved.'],
    ]);
    expect(buttons($).map(([text]) => text)).toEqual(['Delete', 'Update']);
  });

  it('prints the dates of a published change set and offers Roll Back', async () => {
    const { $, body } = await rendered(editModel({}, { published: 1, closeDate: '' }));

    expect($('.alert-info').text()).toBe('This change set has been published.');
    expect(buttons($)).toEqual([
      ['Delete', confirmCall('Delete\\x20Change\\x20Set\\x3F', 'delete')],
      ['Update', "submitForm(document.forms.form1,'update');"],
      ['Roll Back', confirmCall('Roll\\x20Back\\x20Change\\x20Set\\x3F', 'rollback')],
    ]);
    expect($('.datepicker')).toHaveLength(0);
    expect(body.match(/06\/166\/2026 2:05:09 PM/g)).toHaveLength(2);
    expect($('.nav-module-specific a').toArray().map((a) => $(a).text().trim())).toEqual([
      'Back to Change Sets',
      'View Content Assignments List',
    ]);
  });

  it('prints the close date of a published change set when it has one, and a blank for no date', async () => {
    const { body } = await rendered(editModel({}, { published: 1, closeDate: "{ts '2026-07-01 09:30:00'}", lastUpdate: '' }));

    expect(body).toContain('\n                07/182/2026 9:30:00 AM\n');
    expect(body).toMatch(/Publish Date <i class="mi-question-circle"><\/i><\/span>\s*<\/label>\s*<\/div>/);
  });

  it('adds the Categorization tab and checks the assigned categories', async () => {
    const { $ } = await rendered(editModel({ categoryCount: 4, categories: CATEGORY_ROWS }, { categoryID: CHILD_ID }));

    expect($('ul.mura-tabs a').toArray().map((a) => $(a).text())).toEqual(['Basic', 'Categories', 'Tags']);
    expect($('#tabCategorization label').text()).toBe('Category Assignments');
    expect(
      $('#tabCategorization input[name="categoryID"]')
        .toArray()
        .map((box) => [$(box).val(), $(box).is('[checked]'), $(box).is('[disabled]')]),
    ).toEqual([
      [PARENT_ID, false, false],
      [CHILD_ID, true, true],
    ]);
    expect($('#tabCategorization li').toArray().map((li) => $(li).contents().filter((_, node) => node.type === 'text').text().trim())).toEqual([
      'Parent & Co',
      'Child',
      'Sibling',
    ]);
  });

  it('lists the tags, encoded', async () => {
    const { $ } = await rendered();

    expect($('#tags span.tag input').toArray().map((input) => $(input).val())).toEqual(['spring', 'sale & more']);
    expect($('#tags span.tag').first().text()).toContain('spring');
  });

  it("shows the bean's errors but siteID's", async () => {
    const { $ } = await rendered(editModel({}, { errors: { name: "The 'Name' field is required.", siteID: 'Bad site.' } }));

    expect($('.alert-error span').html()).toBe(" The 'Name' field is required. <br> ");
  });

  // utility.displayErrors: the `<br>` test counts every key, siteID's included.
  it.each<[string, ReadonlyArray<readonly [string, string]>, string]>([
    ['no error', [], ' '],
    ['one error', [['name', 'A.']], ' A. '],
    ['two errors', [['name', 'A.'], ['description', 'B.']], ' A. <br> B. '],
    ['siteID first', [['siteID', 'S.'], ['name', 'A.']], ' A. '],
    ['siteID last', [['name', 'A.'], ['siteid', 'S.']], ' A. <br> '],
  ])('writes displayErrors for %s', (_case, errors, markup) => {
    expect(toString(renderDisplayErrors(errors))).toBe(markup);
  });

  it('renders Add for an empty rc.changesetID', async () => {
    const req = changesetRequest('edit');
    const ctx = contextFor(req, { [EDIT_ROUTE]: ok({ rc: editModel() }) });
    const data = await loadChangesetEdit(ctx);

    const $ = $of(toString(renderChangesetEditView(ctx, data, { rcChangesetId: '' })));

    expect($('h1').text()).toBe('Add Change Set');
    expect(buttons($)).toEqual([['Add', "submitForm(document.forms.form1,'add');"]]);
    expect($('input[name="changesetID"]').val()).toBe(CHANGESET_ID);
  });

  it('fails as listGetAt does when an empty tab label drops out of the label list', async () => {
    const { ctx, data } = await rendered();
    const rb: RbLookup = {
      locale: 'en',
      rbKey: (key) => (key === 'sitemanager.content.tabs.tags' ? '' : key),
      messageFormat: () => '',
    };

    expect(() => renderChangesetEditView({ ...ctx, rb }, data)).toThrow(
      new RangeError('Invalid list index 2: the tab label list has 1 elements.'),
    );
  });

  it('fails as ACF does when the view runs without rc.changesetID', async () => {
    const { ctx, data } = await rendered();
    const req = adminS2Request({ circuit: 'cChangesets', item: 'edit' });

    expect(() => renderChangesetEditView({ ...ctx, req }, data)).toThrow(
      new TypeError('Element CHANGESETID is undefined in a CFML structure referenced as part of an expression.'),
    );
  });

  it('renders inside the shell for the admin', async () => {
    const ctx = contextFor(changesetRequest('edit'), { [EDIT_ROUTE]: ok({ rc: editModel() }) });

    const page = await renderScreenPage(registered('edit'), ctx);

    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    expect(page.html).toContain('<h1>Edit Change Set</h1>');
  });
});

describe('cf_datetimeselector', () => {
  const now = new Date(2026, 5, 30, 12, 0, 0);
  const dayParts: DateTimeSelectorSession = { dateKeyFormat: 'MM/DD/YYYY', localeHasDayParts: true, now };
  const twentyFourHours: DateTimeSelectorSession = { dateKeyFormat: 'DD.MM.YYYY', localeHasDayParts: false, now };

  it.each<[string, Date | null, DateTimeSelectorSession, string, string]>([
    ['a PM time with day parts', new Date(2026, 6, 1, 13, 5), dayParts, '1', 'PM'],
    ['midnight with day parts', new Date(2026, 6, 1, 0, 5), dayParts, '12', ''],
    ['noon with day parts', new Date(2026, 6, 1, 12, 5), dayParts, '12', 'PM'],
    ['a 24-hour locale', new Date(2026, 6, 1, 13, 5), twentyFourHours, '13', ''],
  ])('selects the hour of %s', (_case, datetime, session, hour, dayPart) => {
    const $ = $of(toString(renderDateTimeSelector({ name: 'when', datetime }, session)));

    expect($('#mura-whenHour option[selected]').attr('value')).toBe(hour);
    expect($('#mura-whenHour option').length).toBe(session.localeHasDayParts ? 12 : 24);
    expect($('#mura-whenDayPart option[selected]').attr('value') ?? '').toBe(dayPart);
    expect($('#mura-whenMinute option[selected]').attr('value')).toBe('5');
  });

  it('blanks a date more than 50 years ahead but keeps its time, as the tag does', () => {
    const $ = $of(toString(renderDateTimeSelector({ name: 'when', datetime: new Date(2078, 0, 1, 8, 45) }, dayParts)));

    expect($('#mura-datepicker-when').val()).toBe('');
    expect($('#mura-when').val()).toBe('');
    expect($('#mura-whenHour option[selected]').attr('value')).toBe('8');
    expect($('#mura-whenMinute option[selected]').attr('value')).toBe('45');
  });

  it('writes the classes, the required flag and its message, and the change script', () => {
    const markup = toString(
      renderDateTimeSelector(
        { name: 'go"live', datetime: new Date(2026, 6, 1), required: true, message: 'Need "it"', dateClass: 'wide', dateSpanClass: '' },
        twentyFourHours,
      ),
    );

    expect(markup).toContain('class="datepicker wide mura-datepickergo&quot;live"');
    expect(markup).toContain('value="182.07.2026"');
    expect(markup).toContain('data-required="true" data-required="Need&#x20;&quot;it&quot;"/>');
    expect(markup).toContain("parseDateTimeSelector('go\\x22live');");
  });
});

describe('cChangesets.save', () => {
  const NEW_ID = '9E8D7C6B-5A49-4382-9170615243342516';
  const saveRequest = (rc: RcFields = {}): AdminRequest =>
    changesetRequest('save', { changesetID: '', name: 'Spring', ...CSRF_FIELDS, ...rc });
  const saveContext = (reply: FakeReply, req: AdminRequest = saveRequest()) => contextFor(req, { [SAVE_ROUTE]: reply });

  const failedSave = (data: Fields | undefined): FakeReply =>
    ok({ saved: false, errors: { name: "The 'Name' field is required.", siteID: 'ignored' }, redirect: null, ...(data === undefined ? {} : { data }) });

  it("posts every rc field and redirects to the list with the owner's redirect values", async () => {
    const req = saveRequest();
    const ctx = saveContext(
      ok({
        saved: true,
        errors: {},
        redirect: { circuit: 'cChangesets', action: 'list', params: [['changesetID', NEW_ID], ['siteID', 'default']] },
      }),
      req,
    );

    await expect(changesetSaveScreen.redirect?.(ctx)).resolves.toEqual({
      kind: 'redirect',
      action: 'cChangesets.list',
      append: 'changesetID,siteID',
      path: './',
      rc: { changesetID: NEW_ID, siteID: 'default' },
    });
    expect(ctx.gateway.calls).toEqual([
      { service: 'strategies-content', method: 'POST', path: LIST_PATH, form: Object.fromEntries(Object.entries(req.rc)) },
    ]);
    expect(ctx.gateway.calls[0]?.form).toMatchObject({ name: 'Spring', changesetID: '', ...CSRF_FIELDS });
  });

  it("passes the owner's Location through", async () => {
    const location = './?muraAction=cLogin.main';

    await expect(changesetSaveScreen.redirect?.(saveContext({ status: 302, headers: { location } }))).resolves.toEqual({
      kind: 'location',
      location,
    });
  });

  it("re-renders the saved bean as an edit with the owner's errors and the saved id's tokens", async () => {
    const ctx = saveContext(failedSave({ rc: editModel({}, { changesetID: NEW_ID, name: '', errors: {} }) }));

    await expect(changesetSaveScreen.redirect?.(ctx)).resolves.toBeUndefined();
    const data = await changesetSaveScreen.load?.(ctx);
    if (data === undefined) throw new Error('save has a load step');
    const $ = $of(toString((await changesetSaveScreen.render(ctx, data)).body));

    expect(csrfContexts(ctx.gateway)).toEqual([NEW_ID]);
    expect(data.changeset.errors).toEqual([
      ['name', "The 'Name' field is required."],
      ['siteID', 'ignored'],
    ]);
    expect($('h1').text()).toBe('Edit Change Set');
    expect($('.alert-error span').html()).toBe(" The 'Name' field is required. <br> ");
    expect($('.nav-module-specific a')).toHaveLength(0);
    expect($('input[name="changesetID"]').val()).toBe(NEW_ID);
  });

  it.each<[string, Fields | undefined]>([
    ['a model without the bean', { rc: { categoryCount: 0, categories: [] } }],
    ['no model', undefined],
    ['a model that is not a struct', { rc: ['changeset'] }],
  ])('fails as legacy does for a rejected token: %s', async (_case, data) => {
    await expect(changesetSaveScreen.redirect?.(saveContext(failedSave(data)))).rejects.toThrow(
      new TypeError('Element CHANGESET is undefined in RC.'),
    );
  });

  it.each([401, 403] as const)("raises strategies-content's %i as a denial", async (status) => {
    await expect(changesetSaveScreen.redirect?.(saveContext({ status, body: { error: 'denied' } }))).rejects.toMatchObject({
      service: 'strategies-content',
      operation: 'saveChangeset',
      status,
    });
  });

  it('fails on a 400 from the owner', async () => {
    await expect(changesetSaveScreen.redirect?.(saveContext({ status: 400, body: { error: 'badRequest' } }))).rejects.toThrow(
      'saveChangeset answered HTTP 400',
    );
  });

  it('refuses to load before its controller step', async () => {
    await expect(changesetSaveScreen.load?.(saveContext(failedSave(undefined)))).rejects.toThrow(
      'cChangesets.save loaded before its controller step ran',
    );
  });

  it('renders a failed save in the shell, and fires the list redirect after a save', async () => {
    const failed = await renderScreenPage(registered('save'), saveContext(failedSave({ rc: editModel() })));
    if (failed.kind !== 'document') throw new Error(`redirected to ${failed.location}`);
    expect(failed.html).toContain("The 'Name' field is required.");

    const saved = ok({ saved: true, errors: {}, redirect: { circuit: 'cChangesets', action: 'list', params: [] } });
    await expect(renderScreenPage(registered('save'), saveContext(saved))).rejects.toThrow('fires (to cChangesets.list)');
  });
});

/** The list screen model: the iterator page, the site's category count and tree; `fields` overrides any member. */
function listModel(fields: Fields = {}, changesets: Fields = {}): Fields {
  return {
    changesets: {
      pageIndex: 1,
      pageCount: 1,
      recordCount: 2,
      firstRecordOnPageIndex: 1,
      lastRecordOnPageIndex: 2,
      items: [
        {
          changesetID: CHANGESET_ID,
          siteID: 'default',
          name: 'Spring <Launch>',
          published: 0,
          publishDate: "{ts '2026-07-01 09:30:00'}",
          lastUpdate: "{ts '2026-06-15 14:05:00'}",
          previewURL: `http://localhost:8080/default/?changesetID=${CHANGESET_ID}`,
        },
        {
          CHANGESETID: SECOND_ID,
          SITEID: 'default',
          NAME: 'Archive',
          PUBLISHED: 'yes',
          PUBLISHDATE: null,
          LASTUPDATE: '2026-06-01T08:00:00',
          PREVIEWURL: '',
        },
      ],
      ...changesets,
    },
    categoryCount: 0,
    categories: [],
    ...fields,
  };
}

describe('cChangesets.list', () => {
  /** `rc` over the `before()` defaults, as the registered list hands it to the screen. */
  const withDefaults = (rc: RcFields): RcFields => ({ ...CCHANGESETS_RC_DEFAULTS, ...rc });
  const listRequest = (rc: RcFields = {}, partial: AdminRequestPartial = {}): AdminRequest =>
    adminS2Request({ ...partial, circuit: 'cChangesets', item: 'list', rc: withDefaults(rc) });

  async function rendered(model: Fields = listModel(), req: AdminRequest = listRequest()) {
    const ctx = contextFor(req, { [LIST_ROUTE]: ok({ rc: model }) });
    const data = await loadChangesetList(ctx);
    const body = toString(renderChangesetList(ctx, data));
    return { ctx, data, body, $: $of(body) };
  }

  const rowLinks = ($: cheerio.CheerioAPI, row: number): Array<[string, string]> =>
    $('table.mura-table-grid tr')
      .eq(row)
      .find('a[href]')
      .toArray()
      .map((a) => [$(a).text().trim(), $(a).attr('href') ?? '']);

  it('sends every filter to strategies-content and issues each row\'s CSRF context', async () => {
    const rc = { keywords: 'spring sale', page: '2', startdate: '2026-06-01', stopdate: '2026-07-01', categoryid: CHILD_ID, tags: 'spring' };
    const { ctx, data } = await rendered(listModel(), listRequest(rc));

    expect(ctx.gateway.calls[0]).toEqual({
      service: 'strategies-content',
      method: 'GET',
      path: LIST_PATH,
      query: { ...rc, startrow: '1' },
    });
    expect(csrfContexts(ctx.gateway)).toEqual([CHANGESET_ID, SECOND_ID]);
    expect(data.rows.map((row) => [row.changesetId, row.published, row.publishDate, row.lastUpdate])).toEqual([
      [CHANGESET_ID, false, "{ts '2026-07-01 09:30:00'}", "{ts '2026-06-15 14:05:00'}"],
      [SECOND_ID, true, null, '2026-06-01T08:00:00'],
    ]);
    expect(data.stopDate).toBe("{ts '2026-07-02 00:00:00'}");
    expect(data.paging).toEqual({ pageIndex: 1, pageCount: 1, recordCount: 2, firstRecordOnPage: 1, lastRecordOnPage: 2 });
  });

  it('lists each change set with its actions, the preview only while unpublished', async () => {
    const { $ } = await rendered();
    const ids = (id: string, rest = '&categoryid=&tags='): string => `changesetID=${id}&siteid=default${rest}`;

    expect($('h1').text()).toBe('Content Staging');
    expect($('table.mura-table-grid th').toArray().map((th) => $(th).text())).toEqual(['', 'Name', 'Date to Publish', 'Last Update']);
    expect(rowLinks($, 1)).toEqual([
      ['', 'javascript:;'],
      ['Edit', `./?muraAction=cChangesets.edit&${ids(CHANGESET_ID)}`],
      ['Preview', '#'],
      ['Assignments', `./?muraAction=cChangesets.assignments&${ids(CHANGESET_ID, '&categoryid=')}`],
      ['Delete', `./?muraAction=cChangesets.delete&${ids(CHANGESET_ID)}${CSRF_URL}`],
      ['Spring <Launch>', `./?muraAction=cChangesets.assignments&${ids(CHANGESET_ID)}`],
    ]);
    expect($('table.mura-table-grid tr').eq(1).find('li.preview a').attr('onclick')).toBe(
      `return preview('http://localhost:8080/default/?changesetID=${CHANGESET_ID}');`,
    );
    expect($('table.mura-table-grid tr').eq(1).find('li.delete a').attr('onclick')).toBe(
      "return confirmDialog('Delete\\x20Change\\x20Set\\x3F',this.href)",
    );
    expect(rowLinks($, 2).map(([text]) => text)).toEqual(['', 'Edit', 'Assignments', 'Delete', 'Archive']);
    expect($('table.mura-table-grid tr').toArray().slice(1).map((tr) => $(tr).children('td').slice(2).toArray().map((td) => $(td).text()))).toEqual([
      ['07/182/2026 9:30 AM', '06/166/2026 2:05 PM'],
      ['NA', '06/152/2026 8:00 AM'],
    ]);
    expect($('.mura-results-wrapper')).toHaveLength(0);
    expect($('button[name="removeFilter"]')).toHaveLength(0);
    expect($('script').text()).not.toContain("toggleNavFilters(jQuery('#navFiltersToggle'))");
  });

  it('offers Permissions only to a request that administers the site', async () => {
    const editor = editorRequest({
      circuit: 'cChangesets',
      item: 'list',
      rc: withDefaults({}),
      user: { roles: [Roles.systemUser, moduleRole(CHANGESETS_MODULE_ID), moduleRole(SITE_MANAGER_MODULE_ID)] },
    });
    const menu = async (req: AdminRequest): Promise<Array<[string, string]>> => {
      const { $ } = await rendered(listModel(), req);
      return $('.nav-module-specific a').toArray().map((a) => [$(a).text().trim(), $(a).attr('href') ?? '']);
    };

    const addLink: [string, string] = ['Add Change Set', './?muraAction=cChangesets.edit&changesetID=&siteid=default'];
    expect(await menu(listRequest())).toEqual([
      addLink,
      ['Permissions', `./?muraAction=cPerm.module&contentid=${CHANGESETS_MODULE_ID}&siteid=default&moduleid=${CHANGESETS_MODULE_ID}`],
    ]);
    expect(await menu(editor)).toEqual([addLink]);
  });

  it('notes an empty page', async () => {
    const { $ } = await rendered(listModel({}, { items: [], recordCount: 0, firstRecordOnPageIndex: 0, lastRecordOnPageIndex: 0 }));

    expect($('table.mura-table-grid')).toHaveLength(0);
    expect($('.help-block-empty').text()).toBe('There are currently no change sets.');
  });

  it('keeps the filters in the form, shows the day after the To date, and opens the filters', async () => {
    const rc = { keywords: 'a "b"', startdate: '2026-06-01', stopdate: '2026-07-01', tags: 'spring,sale', categoryid: CHILD_ID };
    const model = listModel({
      categoryCount: 2,
      categories: [
        {
          categoryID: PARENT_ID,
          name: 'Parent',
          isOpen: 1,
          permitted: 1,
          children: [{ categoryID: CHILD_ID, name: 'Child', isOpen: true, permitted: null, children: [] }],
        },
      ],
    });
    const { $, body } = await rendered(model, listRequest(rc));

    expect($('input[name="keywords"]').val()).toBe('a "b"');
    expect($('input[name="startDate"]').val()).toBe('06/152/2026');
    expect($('input[name="stopDate"]').val()).toBe('07/183/2026');
    expect($('#tags span.tag input').toArray().map((input) => $(input).val())).toEqual(['spring', 'sale']);
    expect(
      $('#category-select-list input[name="categoryID"]')
        .toArray()
        .map((box) => [$(box).val(), $(box).is('[checked]'), $(box).is('[disabled]')]),
    ).toEqual([
      [PARENT_ID, false, false],
      [CHILD_ID, true, true],
    ]);
    expect($('#mura-list-tree > label').text()).toBe('Categories');
    expect($('button[name="removeFilter"]').attr('onclick')).toBe("location.href='./?siteID=default&muraAction=cChangesets.list'");
    expect(body).toContain("\n\t\t\t\t\t\t\t\ttoggleNavFilters(jQuery('#navFiltersToggle'));\n");
  });

  it('pages through the results with every filter, the To date as list() left it', async () => {
    const rc = { keywords: 'k', stopdate: '2026-07-01', tags: 't 1' };
    const model = listModel({}, { pageIndex: 2, pageCount: 3, recordCount: 45, firstRecordOnPageIndex: 21, lastRecordOnPageIndex: 40 });
    const { $, body } = await rendered(model, listRequest(rc));
    const page = (n: number, tags: boolean): string =>
      `./?muraAction=cChangesets.list&page=${n}&siteid=default&keywords=k&startdate=&stopdate=%7Bts+%272026-07-02+00%3A00%3A00%27%7D&categoryid=${tags ? '&tags=t+1' : ''}`;

    expect($('.search-showing').text().trim()).toBe('Showing 21-40 of 45 Results');
    expect($('ul.pagination a').toArray().map((a) => [$(a).text(), $(a).attr('href')])).toEqual([
      ['', page(1, true)],
      ['1', page(1, false)],
      ['2', '#'],
      ['3', page(3, false)],
      ['', page(3, true)],
    ]);
    expect($('ul.pagination li.active a').text()).toBe('2');
    expect(body).toContain(`<a href="${page(1, false)}"&tags=t+1>1</a>`);
  });

  it.each<[string, Fields]>([
    ['the first page', { pageIndex: 1, pageCount: 2 }],
    ['the last page', { pageIndex: 2, pageCount: 2 }],
  ])('leaves out the arrow pointing past %s', async (_case, paging) => {
    const { $ } = await rendered(listModel({}, paging));

    expect($('ul.pagination i').toArray().map((i) => $(i).attr('class'))).toEqual([
      paging['pageIndex'] === 1 ? 'mi-angle-right' : 'mi-angle-left',
    ]);
  });

  it('keeps a To date isDate rejects, and fails formatting it as LSDateFormat does', async () => {
    const ctx = contextFor(listRequest({ stopdate: 'soon' }), { [LIST_ROUTE]: ok({ rc: listModel() }) });

    const data = await loadChangesetList(ctx);

    expect(data.stopDate).toBe('soon');
    expect(() => renderChangesetList(ctx, data)).toThrow();
  });

  it.each<[string, Fields, string]>([
    ['no iterator', listModel({ changesets: 'none' }), 'listChangesets returned no changesets struct'],
    ['items that are not structs', listModel({}, { items: ['x'] }), 'listChangesets returned no items array of structs'],
    ['a category without children', listModel({ categories: [{ categoryID: PARENT_ID, name: 'P', isOpen: 1, permitted: 1 }] }), 'listChangesets returned no children array of structs'],
    ['a complex name', listModel({}, { items: [{ changesetID: CHANGESET_ID, name: ['x'] }] }), 'listChangesets returned a name that is not a simple value'],
  ])('rejects a model with %s', async (_case, model, message) => {
    const ctx = contextFor(listRequest(), { [LIST_ROUTE]: ok({ rc: model }) });

    await expect(loadChangesetList(ctx)).rejects.toThrow(new TypeError(message));
  });

  it.each([401, 403] as const)("raises strategies-content's %i, which the page answers with the access gate's redirect", async (status) => {
    const ctx = contextFor(listRequest(), { [LIST_ROUTE]: { status, body: { error: 'denied' } } });

    await expect(loadChangesetList(ctx)).rejects.toBeInstanceOf(GatewayDenialError);
    await expect(renderScreenPage(registered('list'), ctx)).resolves.toEqual({
      kind: 'redirect',
      location: status === 401 ? '/admin/?muraAction=clogin.logout' : '/admin/?muraAction=cMessage.noaccess',
    });
  });

  it('propagates the unavailability of strategies-content', async () => {
    const ctx = contextFor(listRequest(), { [LIST_ROUTE]: { status: 503, body: { error: 'down' } } });

    await expect(loadChangesetList(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it('renders inside the shell for the admin, and sends a refused editor back without reading', async () => {
    const ctx = contextFor(listRequest(), { [LIST_ROUTE]: ok({ rc: listModel() }) });
    const page = await renderScreenPage(registered('list'), ctx);
    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    expect(page.html).toContain('<h1>Content Staging</h1>');
    expect(changesetListScreen).toMatchObject({ circuit: 'cchangesets', action: 'list', owner: 'strategies-content' });

    const editorCtx = contextFor(editorRequest({ circuit: 'cChangesets', item: 'list' }), { [LIST_ROUTE]: ok({ rc: listModel() }) });
    await expect(renderScreenPage(registered('list'), editorCtx)).resolves.toEqual({ kind: 'redirect', location: './' });
    expect(editorCtx.gateway.calls.filter(({ service }) => service === 'strategies-content')).toEqual([]);
  });
});
