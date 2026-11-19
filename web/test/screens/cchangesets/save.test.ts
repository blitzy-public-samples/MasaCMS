// cChangesets.save against cchangesets.cfc save(), save.cfm's include of edit.cfm and FW/1 redirect().
import * as cheerio from 'cheerio';
import { LegacyFaultError } from '@opt2/platform/legacy-compat';
import { TENANT_A } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/strategies-content';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { fw1RedirectTarget } from '@/lib/urls';
import { cchangesetsGate, cchangesetsScreens } from '@/screens/cchangesets';
import { renderChangesetEditView, type ChangesetEditData } from '@/screens/cchangesets/edit';
import { changesetSaveScreen } from '@/screens/cchangesets/save';
import type { PageControllerRedirect, ScreenContext } from '@/screens/registry';
import {
  CCHANGESETS_PATHS,
  CHANGESET_IDS,
  cchangesetsEditScheduled,
} from '../../fixtures/strategies-content/changesets';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeRoute,
  type RecordedRequest,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

type AdminWriteResult = components['schemas']['AdminWriteResult'];
type RcFields = Readonly<Record<string, string>>;
type SaveContext = ScreenContext & { gateway: FakeGatewayClient };

const SITE = TENANT_A.siteId;
// strategies-content serves the save on the change-set list path; its contract has no `/cchangesets/save` path.
const SAVE_ROUTE = routeKey('POST', 'strategies-content', CCHANGESETS_PATHS.save);
const TITLE_REQUIRED = "The 'Title' field is required.";
const STALE_TOKEN = 'STALECSRFTOKEN000000000000000000';
const EMPTY_MENU = '<div class="nav-module-specific btn-group">\n\t\t\n\t</div>';

const SCHEDULED_MODEL = cchangesetsEditScheduled.rc;
const [CATEGORY_A = '', CATEGORY_B = ''] = String(
  (SCHEDULED_MODEL.changeset as Readonly<Record<string, unknown>>).categoryID,
).split(',');

/** The posted form of the edit view; CFML's form scope holds each repeated field as one comma list. */
const postedRc = (fields: RcFields = {}): RcFields => ({
  siteid: SITE,
  changesetID: CHANGESET_IDS.scheduled,
  name: 'Autumn Launch "Phase 2" & <more>',
  description: 'Launch pages,\r\nbanner & form',
  publishDate: '07/15/2026',
  closeDate: '',
  categoryID: `${CATEGORY_A},${CATEGORY_B}`,
  tags: 'autumn,launch & more',
  action: 'update',
  csrf_token: FIXED_CSRF.token,
  csrf_token_expires: FIXED_CSRF.expires,
  ...fields,
});

/** The owner's answer for a saved change set: FW/1's list redirect with the post-save id. */
const savedResult = (changesetId: string): AdminWriteResult => ({
  saved: true,
  errors: {},
  redirect: {
    circuit: 'cChangesets',
    action: 'list',
    params: [
      ['changesetID', changesetId],
      ['siteID', SITE],
    ],
  },
});

/** The owner's answer for a failed save: the bean after `set(rc)` under its post-save id, with its errors. */
const failedResult = (changesetId: string, rc: RcFields, isNew: boolean): AdminWriteResult => ({
  saved: false,
  errors: { name: TITLE_REQUIRED },
  redirect: null,
  data: {
    rc: {
      changeset: {
        changesetID: changesetId,
        siteID: SITE,
        name: rc.name,
        description: rc.description,
        publishDate: '2026-07-15T00:00:00.000',
        closeDate: '',
        lastUpdate: '2026-06-30T10:45:00.000',
        published: 0,
        isNew: isNew ? 1 : 0,
        categoryID: rc.categoryID,
        tags: rc.tags,
        errors: { name: TITLE_REQUIRED },
      },
      hasPendingApprovals: 0,
      categoryCount: SCHEDULED_MODEL.categoryCount,
      categories: SCHEDULED_MODEL.categories,
    },
  },
});

/** The owner's answer when the token does not validate: legacy leaves `rc.changeset` undefined. */
const REJECTED: AdminWriteResult = { saved: false, errors: {}, redirect: null, data: { rc: {} } };

/** A cChangesets.save context whose strategies-content records each save and decides on the token it receives. */
function saveContext(rc: RcFields, result: AdminWriteResult): { ctx: SaveContext; received: RecordedRequest[] } {
  const received: RecordedRequest[] = [];
  const save: FakeRoute = (request) => {
    received.push(request);
    return { status: 200, body: request.form?.csrf_token === FIXED_CSRF.token ? result : REJECTED };
  };
  const req: AdminRequest = adminS2Request({ circuit: 'cChangesets', item: 'save', rc });
  return { ctx: makeScreenContext({ req, gateway: fakeGatewayClient({ [SAVE_ROUTE]: save }) }), received };
}

const saveStep = (ctx: ScreenContext): Promise<PageControllerRedirect | undefined> =>
  Promise.resolve(changesetSaveScreen.redirect?.(ctx));

/** The view the controller step left: its loaded data and the body markup. */
async function rerender(ctx: ScreenContext): Promise<{ data: ChangesetEditData; markup: string }> {
  const data = await changesetSaveScreen.load?.(ctx);
  if (data === undefined) throw new Error('cChangesets.save has no load step');
  return { data, markup: toString((await changesetSaveScreen.render(ctx, data)).body) };
}

/** The `Location` FW/1 builds for `result`, appending the listed keys its `rc` holds, in list order. */
function locationOf(result: PageControllerRedirect | undefined): string {
  if (result?.kind !== 'redirect') throw new Error(`expected an FW/1 redirect, got ${String(result?.kind)}`);
  const rc = result.rc ?? {};
  const append = (result.append ?? '').split(',').flatMap((key) => {
    const value = rc[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  return fw1RedirectTarget({ action: result.action, path: result.path, append });
}

/** Every CSRF context identity was asked to issue. */
const csrfContexts = (gateway: FakeGatewayClient): string[] =>
  gateway.calls
    .filter(({ service, path }) => service === 'identity' && path === '/v1/csrf/tokens')
    .flatMap(({ json }) => (json as { contexts: string[] }).contexts);

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('cChangesets.save forwarding', () => {
  it('posts every rc field once, byte for byte and in order, to the owner', async () => {
    const { ctx, received } = saveContext(postedRc(), savedResult(CHANGESET_IDS.scheduled));

    await saveStep(ctx);

    expect(ctx.req.action).toBe('core:cchangesets.save');
    expect(ctx.gateway.calls).toEqual([
      { service: 'strategies-content', method: 'POST', path: CCHANGESETS_PATHS.save, form: { ...ctx.req.rc } },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe(new URLSearchParams(Object.entries(ctx.req.rc)).toString());
    expect(Object.entries(received[0]?.form ?? {})).toEqual(Object.entries(ctx.req.rc));
    expect(received[0]?.form).toMatchObject(postedRc());
  });

  it('relays a stale token unchanged and leaves the verdict to the owner', async () => {
    const rc = postedRc({ csrf_token: STALE_TOKEN });
    const { ctx, received } = saveContext(rc, savedResult(CHANGESET_IDS.scheduled));

    // Own oracle: cchangesets-save-used-token and -missing-token.
    await expect(saveStep(ctx)).rejects.toEqual(new LegacyFaultError('Element CHANGESET is undefined in RC.'));
    expect(received).toHaveLength(1);
    expect(received[0]?.form).toMatchObject({ csrf_token: STALE_TOKEN, csrf_token_expires: FIXED_CSRF.expires });
    expect(received[0]?.body).toBe(new URLSearchParams(Object.entries(ctx.req.rc)).toString());
    expect(csrfContexts(ctx.gateway)).toEqual([]);
  });
});

describe('cChangesets.save outcomes', () => {
  it.each([
    { save: 'an edit', posted: CHANGESET_IDS.scheduled, saved: CHANGESET_IDS.scheduled },
    { save: 'an add', posted: '', saved: CHANGESET_IDS.newSet },
  ])('redirects $save to the list with the post-save id', async ({ posted, saved }) => {
    const { ctx } = saveContext(postedRc({ changesetID: posted }), savedResult(saved));

    const result = await saveStep(ctx);

    expect(result).toEqual({
      kind: 'redirect',
      action: 'cChangesets.list',
      append: 'changesetID,siteID',
      path: './',
      rc: { changesetID: saved, siteID: SITE },
    });
    expect(locationOf(result)).toBe(`./?muraAction=cChangesets.list&changesetID=${saved}&siteID=${SITE}`);
    expect(csrfContexts(ctx.gateway)).toEqual([]);
  });

  it.each([
    { save: 'a failed edit', posted: CHANGESET_IDS.scheduled, saved: CHANGESET_IDS.scheduled, isNew: false },
    { save: 'a failed add', posted: '', saved: CHANGESET_IDS.newSet, isNew: true },
  ])('re-renders $save as an edit of the post-save id', async ({ posted, saved, isNew }) => {
    const rc = postedRc({ changesetID: posted, name: '' });
    const { ctx } = saveContext(rc, failedResult(saved, rc, isNew));

    await expect(saveStep(ctx)).resolves.toBeUndefined();
    const { data, markup } = await rerender(ctx);
    const $ = cheerio.load(markup, null, false);
    const model = fragmentModel(markup);

    expect(markup).toBe(toString(renderChangesetEditView(ctx, data, { rcChangesetId: saved })));
    expect($('div.alert.alert-error > span').text()).toContain(TITLE_REQUIRED);
    expect($('h1').text()).toBe('Edit Change Set');
    expect(model.buttons.map(({ text }) => text)).toEqual(expect.arrayContaining(['Delete', 'Update']));
    expect(model.buttons.map(({ text }) => text)).not.toContain('Add');
    expect(markup).toContain(EMPTY_MENU);
    expect($('input[name="name"]').val()).toBe(rc.name);
    expect($('textarea[name="description"]').text()).toBe(rc.description);
    expect($('input[name="changesetID"]').val()).toBe(saved);
    expect(csrfContexts(ctx.gateway)).toEqual([saved]);
    expect($('input[name="csrf_token"]').val()).toBe(FIXED_CSRF.token);
    expect($('input[name="csrf_token_expires"]').val()).toBe(FIXED_CSRF.expires);
    expect(ctx.req.rc.changesetID).toBe(posted);
  });

  it.each<[string, (gateway: FakeGatewayClient) => void]>([
    ['an unreachable gateway', (gateway) => gateway.failWith()],
    ['a gateway 503', (gateway) => gateway.setRoute(SAVE_ROUTE, { status: 503, body: { error: 'unavailable' } })],
  ])('fails closed on %s', async (_case, fail) => {
    const { ctx } = saveContext(postedRc(), savedResult(CHANGESET_IDS.scheduled));
    fail(ctx.gateway);

    const failure = saveStep(ctx);

    await expect(failure).rejects.toBeInstanceOf(GatewayUnavailableError);
    await expect(failure).rejects.toMatchObject({ service: 'strategies-content' });
    await expect(changesetSaveScreen.load?.(ctx)).rejects.toThrow(
      'cChangesets.save loaded before its controller step ran',
    );
  });
});

describe('cChangesets.save definition', () => {
  // The inventory records save as a page: its controller step writes, then redirects or falls through to edit.cfm.
  it('is the inventoried strategies-content page with a controller step, registered behind the gate', () => {
    expect(changesetSaveScreen).toMatchObject({
      circuit: 'cchangesets',
      action: 'save',
      owner: 'strategies-content',
      mode: 'page',
    });
    expect(changesetSaveScreen.redirect).toBeTypeOf('function');
    expect(changesetSaveScreen.load).toBeTypeOf('function');
    expect(cchangesetsScreens.find(({ action }) => action === 'save')).toMatchObject({
      mode: 'page',
      owner: 'strategies-content',
      gate: cchangesetsGate,
    });
  });
});
