// cCategory.update against ccategory.cfc update() and update.cfm: the save, then the list redirect or the form.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/strategies-content';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { fw1RedirectTarget, relativeAdminUrl } from '@/lib/urls';
import { renderCcategoryEdit, type CcategoryEditData } from '@/screens/ccategory/edit';
import { loadUpdatedCategory, updateCategory } from '@/screens/ccategory/update';
import { findScreen, type PageScreen, type ScreenContext } from '@/screens/registry';
import type { ShellView } from '@/shell/document';
import {
  CATEGORY_IDS,
  CCATEGORY_PATHS,
  ccategoryEditData,
  ccategoryEditNewData,
} from '../../fixtures/strategies-content/categories';
import { adminS2Request, siteAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { domModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type RecordedRequest,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';
import { BETA_ID, CSRF_PAIR, SAVE_ROUTE, categoryGateway, contextFor } from './support';

const LIST_REDIRECT = { kind: 'redirect', action: 'cCategory.list', append: 'siteid', path: './' };

/** The bean `create(rc)` leaves when validation fails: a fresh id, the posted values. */
const REJECTED_BEAN = Object.freeze({
  categoryID: BETA_ID,
  name: '',
  URLTitle: '',
  isInterestGroup: 0,
  isOpen: 1,
  isfeatureable: 0,
  isActive: 1,
  restrictGroups: '',
  notes: '',
  errors: { name: 'stale bean message' },
});

/** The posted Add form of a category without a name. */
const ADD_FORM = Object.freeze({
  categoryID: '',
  parentID: '',
  action: 'add',
  name: '',
  isInterestGroup: '0',
  csrf_token: CSRF_PAIR.token,
  csrf_token_expires: CSRF_PAIR.expires,
});

/** The S2 admin on `default` posting `rc` to `cCategory.update`. */
const updateRequest = (rc: Record<string, string>) => adminS2Request({ circuit: 'cCategory', item: 'update', rc });

/** A `saveCategory` write result. */
const written = (fields: Record<string, unknown>): FakeReply => ({
  status: 200,
  body: { saved: false, errors: {}, redirect: null, ...fields },
});

const listRedirectResult = { circuit: 'cCategory', action: 'list', params: [['siteid', 'default']] };

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => {
  restoreEnv();
});

describe('updateCategory', () => {
  it.each([
    { action: 'add', saved: true, errors: {} },
    { action: 'update', saved: true, errors: {} },
    { action: 'delete', saved: false, errors: {} },
    { action: 'delete', saved: false, errors: { csrf: 'rejected' } },
  ])("relays every rc field and answers the owner's $action redirect with the list", async (result) => {
    const ctx = contextFor(
      updateRequest({ ...ADD_FORM, action: result.action, categoryID: BETA_ID }),
      categoryGateway({ [SAVE_ROUTE]: written({ ...result, redirect: listRedirectResult }) }),
    );

    expect(await updateCategory(ctx)).toEqual(LIST_REDIRECT);
    const [call] = ctx.gateway.calls;
    expect([call?.method, call?.service, call?.path]).toEqual([
      'POST',
      'strategies-content',
      '/v1/sites/default/categories',
    ]);
    expect(call?.form).toMatchObject({
      muraAction: 'core:ccategory.update',
      siteid: 'default',
      categoryID: BETA_ID,
      action: result.action,
      csrf_token: CSRF_PAIR.token,
      csrf_token_expires: CSRF_PAIR.expires,
    });
    expect(Object.keys(call?.form ?? {}).filter((name) => /tenant|pool/i.test(name))).toEqual([]);
    expect(ctx.gateway.calls).toHaveLength(1);
  });

  it("keeps a rejected save's model, with the result's errors, for the form the view renders", async () => {
    const ctx = contextFor(
      updateRequest(ADD_FORM),
      categoryGateway({
        [SAVE_ROUTE]: written({
          errors: { name: "The 'Name' field is required." },
          data: { rc: { categoryBean: REJECTED_BEAN, rsRestrictGroups: [], categories: [] } },
        }),
      }),
    );

    expect(await updateCategory(ctx)).toBeUndefined();
    const data = await loadUpdatedCategory(ctx);
    expect(data.errors).toEqual([['name', "The 'Name' field is required."]]);
    expect(ctx.gateway.calls.at(-1)?.json).toEqual({ contexts: [BETA_ID] });

    const body = toString(renderCcategoryEdit(ctx, data).body);
    const $ = cheerio.load(body);
    // rc.categoryID stays empty after a failed add, so the form still adds, under the bean's new id.
    expect($('h1').text()).toBe('Add Content Category');
    expect($('.alert-error span').html()).toBe("The 'Name' field is required. ");
    expect($('input[name=action]').val()).toBe('add');
    expect($('input[name=categoryID]').val()).toBe(BETA_ID);
    expect(body).toContain('<label>CategoryID</label>\n    Not Available \n  </div>');
    const back = $('.nav-module-specific a').attr('href');
    expect(back).toBe('./?muraAction=cCategory.list&categoryID=&parentID=&siteid=default');
  });

  it.each([
    { label: 'no data', fields: {} },
    { label: 'a model without categoryBean', fields: { data: { rc: { rsRestrictGroups: [], categories: [] } } } },
  ])('fails as legacy does for a rejected token, whose result carries $label', async ({ fields }) => {
    const ctx = contextFor(
      updateRequest({ ...ADD_FORM, action: 'update', categoryID: BETA_ID }),
      categoryGateway({ [SAVE_ROUTE]: written(fields) }),
    );
    await expect(updateCategory(ctx)).rejects.toThrow('Element RC.categoryBean is undefined in ARGUMENTS.');
  });

  it('relays a request without rc.action, so the owner checks its token before failing it', async () => {
    const form = Object.fromEntries(Object.entries(ADD_FORM).filter(([name]) => name !== 'action'));
    const ctx = contextFor(updateRequest(form), categoryGateway({ [SAVE_ROUTE]: { status: 500 } }));
    await expect(updateCategory(ctx)).rejects.toThrow('saveCategory answered HTTP 500');
    expect(ctx.gateway.calls).toHaveLength(1);
    expect(ctx.gateway.calls[0]?.form).toMatchObject({
      csrf_token: CSRF_PAIR.token,
      csrf_token_expires: CSRF_PAIR.expires,
    });
    expect(ctx.gateway.calls[0]?.form).not.toHaveProperty('action');
  });

  it.each([{ status: 401 as const }, { status: 403 as const }])(
    'turns a $status answer into a GatewayDenialError',
    async ({ status }) => {
      const ctx = contextFor(updateRequest(ADD_FORM), categoryGateway({ [SAVE_ROUTE]: { status } }));
      await expect(updateCategory(ctx)).rejects.toThrow(GatewayDenialError);
    },
  );
});

describe('loadUpdatedCategory', () => {
  it('fails when the controller step has not run for the request', async () => {
    const ctx = contextFor(updateRequest(ADD_FORM), categoryGateway());
    await expect(loadUpdatedCategory(ctx)).rejects.toThrow('cCategory.update loaded before its controller step ran');
  });
});

type AdminWriteResult = components['schemas']['AdminWriteResult'];

const SITE = 'tenant-a';
const TENANT_SAVE_ROUTE = routeKey('POST', 'strategies-content', CCATEGORY_PATHS.list);
const NAME_REQUIRED = Object.freeze({ name: "The 'Name' field is required." });
const TENANT_LIST_LOCATION = './?muraAction=cCategory.list&siteid=tenant-a';

/** Every field the Update form of Events posts, the multi-select's comma list included. */
const UPDATE_FORM = Object.freeze({
  action: 'update',
  categoryID: CATEGORY_IDS.topicsEvents,
  name: 'Events & Programs',
  urltitle: 'events-programs',
  parentID: CATEGORY_IDS.topics,
  isInterestGroup: '1',
  isOpen: '0',
  isfeatureable: '1',
  isActive: '1',
  notes: 'Program "events" <listed>.',
  restrictgroups: 'Group A,Group B',
  csrf_token: FIXED_CSRF.token,
  csrf_token_expires: FIXED_CSRF.expires,
});

/** The Add form of a category without a name. */
const TENANT_ADD_FORM = Object.freeze({ ...UPDATE_FORM, action: 'add', categoryID: '', name: '' });

/** The query of the tree's delete link of Events (`dsp_nest.cfm`). */
const DELETE_LINK_QUERY = Object.freeze(
  Object.fromEntries(
    new URLSearchParams(
      `action=delete&categoryID=${CATEGORY_IDS.topicsEvents}&siteid=${SITE}` +
        `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`,
    ),
  ),
);

/** strategies-content's answer to a save it ran: the tenant-a list. */
const LIST_RESULT: AdminWriteResult = {
  saved: true,
  errors: {},
  redirect: { circuit: 'cCategory', action: 'list', params: [['siteid', SITE]] },
};

const answered = (result: AdminWriteResult): FakeReply => ({ status: 200, body: result });

/** A rejected save: `errors`, and the posted bean with the restrict groups and tree for the form. */
function rejected(bean: Readonly<Record<string, unknown>>, rc: Readonly<Record<string, unknown>>): AdminWriteResult {
  return {
    saved: false,
    errors: { ...NAME_REQUIRED },
    redirect: null,
    data: { rc: { ...rc, categoryBean: { ...bean, errors: { ...NAME_REQUIRED } } } },
  };
}

/** The tenant-a site admin on `cCategory.update` with `rc`, the save answering `reply`, and the requests it got. */
function tenantSave(
  rc: Readonly<Record<string, string>>,
  reply: FakeReply,
  partial: AdminRequestPartial = {},
): { ctx: ScreenContext & { gateway: FakeGatewayClient }; received: RecordedRequest[] } {
  const received: RecordedRequest[] = [];
  const gateway = fakeGatewayClient({
    [TENANT_SAVE_ROUTE]: (request) => {
      received.push(request);
      return reply;
    },
  });
  const req = siteAdminRequest(SITE, { ...partial, circuit: 'cCategory', item: 'update', rc });
  return { ctx: makeScreenContext({ req, gateway }), received };
}

/** The registered `cCategory.update` page: the save step, the kept model and the edit view. */
function updatePage(ctx: ScreenContext): PageScreen<CcategoryEditData> {
  const def = findScreen('ccategory', 'update', ctx.req.rc);
  if (def?.mode !== 'page') throw new Error('cCategory.update is not a registered page');
  return def;
}

/** The view the registered page renders after a save that redirects to nothing. */
async function rerendered(ctx: ScreenContext): Promise<ShellView> {
  const page = updatePage(ctx);
  expect(await page.redirect?.(ctx)).toBeUndefined();
  const data = await page.load?.(ctx);
  if (data === undefined) throw new Error('cCategory.update loaded no form model');
  return page.render(ctx, data);
}

describe('cCategory.update for the tenant-a site admin', () => {
  it('relays every posted Update field unchanged and adds none', async () => {
    const { ctx, received } = tenantSave(UPDATE_FORM, answered(LIST_RESULT));
    expect(ctx.req.action).toBe('core:ccategory.update');

    await updateCategory(ctx);

    expect(received.map(({ method, path }) => `${method} ${path}`)).toEqual([TENANT_SAVE_ROUTE]);
    const form = received[0]?.form;
    expect(form).toMatchObject(UPDATE_FORM);
    expect(form).toEqual(Object.fromEntries(Object.entries(ctx.req.rc)));
    expect(Object.keys(form ?? {}).filter((name) => /tenant|pool/i.test(name))).toEqual([]);
    expect(ctx.gateway.calls).toHaveLength(1);
  });

  it('forwards the GET delete link unchanged, as the same POST', async () => {
    const link = tenantSave(DELETE_LINK_QUERY, answered(LIST_RESULT), { formScope: {} });
    const posted = tenantSave(DELETE_LINK_QUERY, answered(LIST_RESULT));
    expect(Object.keys(link.ctx.req.formScope)).toEqual([]);

    await updateCategory(link.ctx);
    await updateCategory(posted.ctx);

    expect(link.received.map(({ method, path }) => `${method} ${path}`)).toEqual([TENANT_SAVE_ROUTE]);
    expect(link.received[0]?.form).toMatchObject(DELETE_LINK_QUERY);
    expect(link.received[0]?.form).toEqual(posted.received[0]?.form);
    expect(link.ctx.gateway.calls).toHaveLength(1);
  });

  it('forwards an Add with its empty categoryID', async () => {
    const { ctx, received } = tenantSave(TENANT_ADD_FORM, answered(LIST_RESULT));
    await updateCategory(ctx);
    expect(received).toHaveLength(1);
    expect(received[0]?.form).toMatchObject({ action: 'add', categoryID: '', name: '' });
  });

  it.each([
    { action: 'update', rc: UPDATE_FORM },
    { action: 'delete', rc: DELETE_LINK_QUERY },
    { action: 'add', rc: { ...TENANT_ADD_FORM, name: 'Workshops' } },
  ])("answers the owner's $action redirect with the tenant-a list", async ({ rc }) => {
    const { ctx } = tenantSave(rc, answered(LIST_RESULT));

    expect(await updateCategory(ctx)).toEqual(LIST_REDIRECT);
    const location = fw1RedirectTarget({
      action: LIST_REDIRECT.action,
      path: LIST_REDIRECT.path,
      append: [[LIST_REDIRECT.append, ctx.req.rc.siteid ?? '']],
    });
    expect(location).toBe(TENANT_LIST_LOCATION);
    const { circuit, action, params } = LIST_RESULT.redirect ?? { circuit: '', action: '', params: [] };
    expect(relativeAdminUrl(circuit, action, params)).toBe(location);
  });

  it('re-renders a rejected Add with the error, the posted values and the Add form', async () => {
    const newBean = ccategoryEditNewData.rc['categoryBean'] as Readonly<Record<string, unknown>>;
    const posted = { categoryid: '', name: '', urltitle: 'events-programs', notes: 'Posted notes', isopen: 0 };
    const bean = { ...newBean, ...posted };
    const { ctx } = tenantSave(TENANT_ADD_FORM, answered(rejected(bean, ccategoryEditNewData.rc)));

    const view = await rerendered(ctx);
    const body = toString(view.body);
    const page = domModel(body);
    const $ = cheerio.load(body);

    expect(ctx.gateway.calls.map(({ service, method, path, json }) => [service, method, path, json])).toEqual([
      ['strategies-content', 'POST', CCATEGORY_PATHS.list, undefined],
      ['identity', 'POST', '/v1/csrf/tokens', { contexts: [''] }],
    ]);
    expect($('div.alert.alert-error').text().trim()).toBe(NAME_REQUIRED.name);
    expect(page.alerts.map(({ className }) => className)).toEqual(['alert alert-error']);
    expect(page.headings).toEqual(['Add Content Category']);
    expect($('input[name=name]').val()).toBe('');
    expect($('input[name=urltitle]').val()).toBe('events-programs');
    expect($('textarea[name=notes]').text()).toBe('Posted notes');
    expect($('input[name=isOpen][checked]').val()).toBe('0');
    expect(page.buttons).toEqual([{ text: 'Add', type: 'button', hasOnclick: true }]);
    expect($('input[name=action]').val()).toBe('add');
    expect($('input[name=csrf_token]').val()).toBe(FIXED_CSRF.token);

    // The js.cfm block is checked by its markers; this suite does not depend on the js.ts renderer.
    const ajax = view.ajax === undefined ? '' : toString(view.ajax);
    expect(ajax).toContain('<script src="assets/js/category.min.js?coreversion=');
    expect(ajax).toContain('<div id="newContentMenu" class="addNew hide">');
    expect(ajax).toContain(`<i class="mi-plus"></i> ${ctx.rb.rbKey('categorymanager.addsubcategory')}</a>`);
  });

  it('re-renders a rejected Update as the Edit form with its Delete and Update buttons', async () => {
    const savedBean = ccategoryEditData.rc['categoryBean'] as Readonly<Record<string, unknown>>;
    const bean = { ...savedBean, name: '' };
    const { ctx } = tenantSave({ ...UPDATE_FORM, name: '' }, answered(rejected(bean, ccategoryEditData.rc)));

    const body = toString((await rerendered(ctx)).body);
    const page = domModel(body);
    const $ = cheerio.load(body);

    expect(page.headings).toEqual(['Edit Content Category']);
    expect($('div.alert.alert-error').text().trim()).toBe(NAME_REQUIRED.name);
    expect(page.buttons.map(({ text }) => text)).toEqual(['Delete', 'Update']);
    expect($('input[name=action]').val()).toBe('update');
    expect($('input[name=categoryID]').val()).toBe(CATEGORY_IDS.topicsEvents);
    expect(ctx.gateway.calls.at(-1)?.json).toEqual({ contexts: [CATEGORY_IDS.topicsEvents] });
  });

  it('passes a denial through as the GatewayDenialError of saveCategory', async () => {
    const { ctx } = tenantSave(UPDATE_FORM, { status: 403 });
    await expect(updateCategory(ctx)).rejects.toMatchObject({
      name: 'GatewayDenialError',
      service: 'strategies-content',
      operation: 'saveCategory',
      status: 403,
    });
  });

  it('rejects with GatewayUnavailableError when strategies-content does not answer', async () => {
    const { ctx, received } = tenantSave(UPDATE_FORM, answered(LIST_RESULT));
    ctx.gateway.failWith();

    const failure = updateCategory(ctx);
    await expect(failure).rejects.toBeInstanceOf(GatewayUnavailableError);
    await expect(failure).rejects.toMatchObject({ service: 'strategies-content', status: undefined });
    expect(received).toEqual([]);
  });

  it.each([502, 503, 504])('rejects with GatewayUnavailableError on a gateway %i', async (status) => {
    const { ctx } = tenantSave(UPDATE_FORM, { status });
    await expect(updateCategory(ctx)).rejects.toSatisfy(
      (error) => error instanceof GatewayUnavailableError && error.status === status,
    );
  });
});
