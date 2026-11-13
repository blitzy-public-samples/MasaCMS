// cCategory.update against ccategory.cfc update() and update.cfm: the save, then the list redirect or the form.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayDenialError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { renderCcategoryEdit } from '@/screens/ccategory/edit';
import { loadUpdatedCategory, updateCategory } from '@/screens/ccategory/update';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import type { FakeReply } from '../../helpers/fake-gateway';
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

  it('fails without writing when rc.action is undefined', async () => {
    const form = Object.fromEntries(Object.entries(ADD_FORM).filter(([name]) => name !== 'action'));
    const gateway = categoryGateway({ [SAVE_ROUTE]: written({ redirect: listRedirectResult }) });
    const ctx = contextFor(updateRequest(form), gateway);
    await expect(updateCategory(ctx)).rejects.toThrow('Element RC.action is undefined in ARGUMENTS.');
    expect(ctx.gateway.calls).toEqual([]);
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
