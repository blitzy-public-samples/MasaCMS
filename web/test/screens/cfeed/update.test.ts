// cFeed.update against admin/core/controllers/cfeed.cfc update() and cfeed/update.cfm: the list redirect, the
// compact-display close document and the rejected save re-rendered inside the layout, over strategies-content.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { CFEED_RC_DEFAULTS, cfeedGate } from '@/screens/cfeed/before';
import { cfeedUpdateScreen } from '@/screens/cfeed/update';
import type { RawBody, ScreenContext, ScreenRequestBody } from '@/screens/registry';
import { makeAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

const PATH = '/v1/raw/cfeed/update';
const GET_ROUTE = routeKey('GET', 'strategies-content', PATH);
const POST_ROUTE = routeKey('POST', 'strategies-content', PATH);
const HTML_TYPE = 'text/html;charset=UTF-8';
const FEED_ID = 'F1000000-0000-0000-0000000000000001';
const LIST_LOCATION = './?muraAction=cFeed.list&siteid=default';
const CSRF_FIELDS = { csrf_token: 'POSTEDTOKEN', csrf_token_expires: '261231235959000' } as const;
const SERVICE_COOKIE = 'CFTOKEN=0;Path=/;HttpOnly';
// beanValidator's message for a `required` property that has no message or bundle key of its own.
const LANG_ERROR = "The property named 'lang' is not valid";
const REDIRECT_HEADERS = {
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'content-type': HTML_TYPE,
  location: LIST_LOCATION,
} as const;
const NO_CACHE = { 'cache-control': 'no-cache, no-store, must-revalidate', expires: '06 Nov 1994 08:37:34 GMT' };

type Row = Record<string, unknown>;

/** A new Local feed bean's `getAllValues()` after `set(rc)` of an add posted without a language. */
const SUBMITTED_BEAN: Row = {
  feedID: '',
  siteID: 'default',
  name: 'News',
  altName: '',
  lang: '',
  isActive: 1,
  showNavOnly: 1,
  showExcludeSearch: 0,
  isPublic: 0,
  isDefault: 0,
  description: '',
  contentID: '',
  categoryID: '',
  MaxItems: 20,
  allowHTML: 1,
  isFeaturesOnly: 0,
  restricted: 0,
  restrictGroups: '',
  Version: 'RSS 2.0',
  ChannelLink: '',
  authtype: 'DEFAULT',
  type: 'Local',
  sortBy: 'lastUpdate',
  sortDirection: 'desc',
  parentID: '',
  nextN: 20,
  displayName: 0,
  isNew: 1,
  params: [],
  errors: { lang: LANG_ERROR },
  imageSize: 'small',
  imageHeight: 'AUTO',
  imageWidth: 'AUTO',
  displayList: 'Date,Title,Image,Summary,Credits,Tags',
  viewalllink: '',
  viewalllabel: '',
  autoimport: 0,
  isLocked: 0,
  cssClass: '',
  useCategoryIntersect: 0,
  contentpoolid: '',
};

/** The core content renderer's `defaultCollectionDisplayList`, which the installed theme inherits. */
const CORE_LIST = 'Date,Title,Image,Summary,Credits';

/**
 * strategies-content's answer to a rejected save: the bean errors and the `getFeed` keys of the submitted feed, on
 * the installed theme's renderer (layout manager on); `data` members replace those keys.
 */
function rejected(data: Row = {}): FakeReply {
  return {
    status: 200,
    body: {
      saved: false,
      errors: { lang: LANG_ERROR },
      redirect: null,
      data: {
        feedBean: SUBMITTED_BEAN,
        rsRestrictGroups: [],
        rslist: [],
        rsExtendedAttributes: [],
        hasCategories: 0,
        categories: [],
        imageSizes: [],
        contentPool: [{ siteID: 'default', site: 'Default' }],
        useLayoutManager: true,
        defaultCollectionDisplayList: CORE_LIST,
        ...data,
      },
    },
    setCookies: [SERVICE_COOKIE],
  };
}

const REJECTED = rejected();

/** update.cfm's close document for a saved Local index without the layout manager, as the service renders it. */
const CLOSE_DOCUMENT = [
  '',
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
  '<html xmlns="http://www.w3.org/1999/xhtml">',
  '<head>',
  '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1" />',
  '<title>Close</title>',
  '<script src="/admin/assets/js/jquery/jquery.js?coreversion=7.6.1" type="text/javascript"></script>',
  '<script src="/admin/assets/js/porthole/porthole.min.js?coreversion=7.6.1" type="text/javascript"></script>',
  '<script>',
  '\tfunction reload(){',
  '\t\tif (top.location != self.location) {',
  '\t\t\t\tvar cmd={cmd:\'setLocation\',location:encodeURIComponent("\\/index.cfm\\/")};',
  '\t\t\tfrontEndProxy = new Porthole.WindowProxy("/admin/assets/js/porthole/proxy.html");',
  '\t\t} else {',
  '\t\t\tlocation.href="\\/index.cfm\\/";',
  '\t\t}',
  '\t}',
  '</script>',
  '</head>',
  '<body onload="reload()">',
  '</body>',
  '</html>',
].join('\n');

/** `fields` as the URL-encoded body web received. */
function formBody(fields: Readonly<Record<string, string>>): ScreenRequestBody {
  const form = new URLSearchParams(fields);
  return { contentType: 'application/x-www-form-urlencoded', body: new Blob([form.toString()]), form };
}

/** The admin on `cfeed.update` of site `default`, the feed manager on. */
function updateRequest(rc: Record<string, string>): AdminRequest {
  return makeAdminRequest({ circuit: 'cfeed', item: 'update', rc, site: { hasFeedManager: true } }, 'admin');
}

/** A context for `rc` whose strategies-content `method` route answers `reply`; a POST carries `rc` as its body. */
function context(
  rc: Record<string, string>,
  method: 'GET' | 'POST',
  reply: FakeReply,
): ScreenContext & { gateway: FakeGatewayClient } {
  const gateway = fakeGatewayClient({ [method === 'GET' ? GET_ROUTE : POST_ROUTE]: reply });
  const body = method === 'POST' ? formBody(rc) : undefined;
  return makeScreenContext({ req: updateRequest(rc), gateway, body });
}

/** The one strategies-content call the screen made. */
function serviceCall(gateway: FakeGatewayClient): FakeGatewayClient['calls'][number] {
  const calls = gateway.calls.filter((call) => call.service === 'strategies-content' && call.path === PATH);
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (call === undefined) throw new Error(`No ${PATH} call was made`);
  return call;
}

const render = async (ctx: ScreenContext): Promise<RawBody> => cfeedUpdateScreen.render(ctx, undefined);

/** The serialized document of a re-render, which is always text. */
function markupOf(raw: RawBody): string {
  if (typeof raw.body !== 'string') throw new TypeError('The re-render answered no document text');
  return raw.body;
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('cfeed.update', () => {
  it('is the inventoried fragment action of strategies-content behind the cfeed before() gate', () => {
    expect(cfeedUpdateScreen).toMatchObject({
      circuit: 'cfeed',
      action: 'update',
      mode: 'fragment',
      owner: 'strategies-content',
    });
    expect(cfeedUpdateScreen.gate).toBe(cfeedGate);
  });

  it.each([
    ['a saved update', 'POST', { type: 'Local', feedID: FEED_ID, action: 'update', name: 'News', ...CSRF_FIELDS }],
    ['a saved add', 'POST', { type: 'Remote', feedID: '', action: 'add', name: 'Wire', ...CSRF_FIELDS }],
    ['a refused token', 'POST', { type: 'Local', feedID: FEED_ID, action: 'update', csrf_token: 'USED' }],
    ['the list delete link', 'GET', { action: 'delete', feedID: FEED_ID, ...CSRF_FIELDS }],
  ] as const)('answers %s with the FW/1 302 to cFeed.list the service names', async (_case, method, rc) => {
    const reply: FakeReply = { status: 302, headers: { Location: LIST_LOCATION }, setCookies: [SERVICE_COOKIE] };
    await expect(render(context(rc, method, reply))).resolves.toEqual({
      status: 302,
      contentType: HTML_TYPE,
      body: '',
      headers: REDIRECT_HEADERS,
      setCookies: [SERVICE_COOKIE],
    });
  });

  it('posts every rc field after the before() defaults, with siteid in the query', async () => {
    const rc = { type: 'Local', feedID: FEED_ID, action: 'update', name: 'News', ...CSRF_FIELDS };
    const ctx = context(rc, 'POST', { status: 302, headers: { Location: LIST_LOCATION } });
    // before() adds only the keys the request, after the admin set-up, lacks.
    const expected = { ...CFEED_RC_DEFAULTS, ...ctx.req.rc };
    await render(ctx);
    const call = serviceCall(ctx.gateway);
    expect(call.method).toBe('POST');
    expect(call.query).toEqual({ siteid: 'default' });
    expect(call.form).toEqual(expected);
    expect(call.form).toMatchObject({ ...rc, siteid: 'default', startrow: '1', regionID: '0', instanceParams: '' });
    // The request the shell and the handler read afterwards is the defaulted one.
    expect({ ...ctx.req.rc }).toEqual(expected);
  });

  it('sends a bodiless request as url fields', async () => {
    const rc = { action: 'delete', feedID: FEED_ID, ...CSRF_FIELDS };
    const ctx = context(rc, 'GET', { status: 302, headers: { Location: LIST_LOCATION } });
    const expected = { ...CFEED_RC_DEFAULTS, ...ctx.req.rc };
    await render(ctx);
    const call = serviceCall(ctx.gateway);
    expect(call.method).toBe('GET');
    expect(call.form).toBeUndefined();
    expect(call.query).toEqual(expected);
    expect(call.query).toMatchObject({ ...rc, siteid: 'default', restricted: '0', orderno: '0' });
  });

  it('relays the compact-display close document byte for byte', async () => {
    const rc = { type: 'Local', feedID: FEED_ID, action: 'update', closeCompactDisplay: 'true', ...CSRF_FIELDS };
    const ctx = context({ ...rc, homeID: '00000000000000000000000000000000001' }, 'POST', {
      status: 200,
      headers: { 'Content-Type': HTML_TYPE },
      body: CLOSE_DOCUMENT,
      setCookies: [SERVICE_COOKIE],
    });
    const answer = await render(ctx);
    expect(answer).toEqual({
      status: 200,
      contentType: HTML_TYPE,
      body: Buffer.from(CLOSE_DOCUMENT),
      setCookies: [SERVICE_COOKIE],
    });
    expect(answer.headers).toBeUndefined();
  });

  it.each([
    ['a ColdFusion error page', 500, '<h1>500 Error</h1>'],
    ['an empty fragment', 200, ''],
  ])('relays %s with its status', async (_case, status, body) => {
    const ctx = context({ action: '', feedID: FEED_ID, ...CSRF_FIELDS }, 'POST', {
      status,
      headers: { 'Content-Type': HTML_TYPE },
      body,
    });
    await expect(render(ctx)).resolves.toEqual({ status, contentType: HTML_TYPE, body: Buffer.from(body) });
  });

  describe('rejected save', () => {
    const ADD = { type: 'Local', feedID: '', action: 'add', name: 'News', lang: '', ...CSRF_FIELDS } as const;

    it('re-renders edit.cfm with the bean errors inside the uncached full layout, with the service cookie', async () => {
      const ctx = context(ADD, 'POST', REJECTED);
      const answer = await render(ctx);
      expect(answer).toMatchObject({ contentType: HTML_TYPE, headers: NO_CACHE, setCookies: [SERVICE_COOKIE] });
      expect(answer.status).toBeUndefined();
      const $ = cheerio.load(markupOf(answer));
      // template.cfm, not the compact layout.
      expect($('#page-container').length).toBe(1);
      expect($('#frontEndToolsModalClose').length).toBe(0);
      expect($('.alert-error span').text()).toBe(`${LANG_ERROR} `);
      const form = $('form[name=form1]');
      expect(form.attr('action')).toBe('./?muraAction=cFeed.update&siteid=default');
      expect(form.find('input[name=action]').val()).toBe('add');
      expect(form.find('input[name=type]').val()).toBe('Local');
      expect(form.find('input[name=name]').val()).toBe('News');
      expect(form.find('input[name=lang]').val()).toBe('');
      // `dsp_secondary_menu.cfm` takes its default case for `update`: back to the list, no feed link for a new index.
      const menu = $('.nav-module-specific a');
      expect(menu.map((_i, el) => $(el).attr('href')).get()).toEqual([LIST_LOCATION]);
      // The CSRF pair is a fresh one for the feed, not the posted one.
      expect(form.find('input[name=csrf_token]').val()).not.toBe(CSRF_FIELDS.csrf_token);
    });

    it('re-renders in the compact layout without the cache headers when rc.compactDisplay is true', async () => {
      const ctx = context({ ...ADD, compactDisplay: 'true' }, 'POST', { ...REJECTED, setCookies: [] });
      const answer = await render(ctx);
      expect(answer.headers).toBeUndefined();
      expect(answer.setCookies).toBeUndefined();
      const $ = cheerio.load(markupOf(answer));
      expect($('#frontEndToolsModalClose').length).toBe(1);
      expect($('.alert-error span').text()).toBe(`${LANG_ERROR} `);
      // The compact edit header carries no secondary menu.
      expect($('.nav-module-specific').length).toBe(0);
    });

    it('keeps the request session writes on the request the handler persists', async () => {
      const ctx = context(ADD, 'POST', REJECTED);
      const writes = ctx.req.sessionWrites;
      await render(ctx);
      expect(ctx.req.sessionWrites).toBe(writes);
      expect(ctx.req.rc.startrow).toBe('1');
    });

    /** A rejected Local add on a site renderer: the fields it posts and the re-rendered tabs and display list. */
    interface RendererCase {
      readonly name: string;
      readonly renderer: Row;
      readonly posted: Readonly<Record<string, string>>;
      readonly tabs: readonly string[];
      readonly countsPane: string;
      readonly displayList: readonly string[];
    }

    // Under the layout manager edit.cfm posts no display list, so the bean keeps its init list; without it, this add
    // posts an emptied list, for which getDisplayList() answers the renderer's own.
    it.each<RendererCase>([
      {
        name: "the installed theme's layout manager",
        renderer: { useLayoutManager: true, defaultCollectionDisplayList: CORE_LIST },
        posted: {},
        tabs: ['#tabBasic', '#tabAdvancedfilters', '#tabRss'],
        countsPane: '#tabBasic',
        displayList: [],
      },
      {
        name: 'a theme renderer with its own list and no layout manager',
        renderer: { useLayoutManager: false, defaultCollectionDisplayList: 'Title,Summary,Date' },
        posted: { displayList: '' },
        tabs: ['#tabBasic', '#tabAdvancedfilters', '#tabDisplay', '#tabRss'],
        countsPane: '#tabDisplay',
        displayList: ['Title', 'Summary', 'Date'],
      },
    ])('re-renders the Local form for $name', async ({ renderer, posted, tabs, countsPane, displayList }) => {
      const feedBean = { ...SUBMITTED_BEAN, ...posted };
      const answer = await render(context({ ...ADD, ...posted }, 'POST', rejected({ feedBean, ...renderer })));
      const $ = cheerio.load(markupOf(answer));
      expect($('.alert-error span').text()).toBe(`${LANG_ERROR} `);
      expect($('ul.mura-tabs a').map((_i, el) => $(el).attr('href')).get()).toEqual(tabs);
      expect($('select[name=maxItems]').closest('.tab-pane').attr('id')).toBe(countsPane.slice(1));
      expect($(`${countsPane} select[name=nextN]`)).toHaveLength(1);
      expect($('#displayListSort li').map((_i, el) => $(el).text()).get()).toEqual(displayList);
      expect($('input#displayList').val()).toBe(displayList.length === 0 ? undefined : displayList.join(','));
    });

    it.each([
      [true, 0],
      [false, 1],
    ])('re-renders the Remote form for useLayoutManager %s with %i view-all and CSS class fields', async (lm, n) => {
      const channelLink = 'https://example.com/rss.xml';
      const remote = { type: 'Remote', feedID: '', action: 'add', name: 'Wire', lang: '', channelLink, ...CSRF_FIELDS };
      const feedBean = { ...SUBMITTED_BEAN, type: 'Remote', name: 'Wire', ChannelLink: channelLink };
      const answer = await render(context(remote, 'POST', rejected({ feedBean, useLayoutManager: lm })));
      const $ = cheerio.load(markupOf(answer));
      expect($('.alert-error span').text()).toBe(`${LANG_ERROR} `);
      expect($('form[name=form1] input[name=channelLink]').val()).toBe(channelLink);
      for (const field of ['viewalllink', 'viewalllabel', 'cssclass']) {
        expect($(`input[name=${field}]`)).toHaveLength(n);
      }
    });

    it.each(['useLayoutManager', 'defaultCollectionDisplayList'])(
      'fails on a rejected save without %s',
      async (key) => {
        const ctx = context(ADD, 'POST', rejected({ [key]: undefined }));
        await expect(render(ctx)).rejects.toThrow(new TypeError(`${key} is missing from the collection edit model`));
      },
    );
  });

  const LIST_REDIRECT = { circuit: 'cFeed', action: 'list', params: [['siteid', 'default']] };
  it.each([
    ['a redirect without Location', { status: 302 }],
    ['a body without Content-Type', { status: 200, body: 'bytes' }],
    ['a write result naming a redirect', { status: 200, body: { saved: true, errors: {}, redirect: LIST_REDIRECT } }],
    ['a JSON array', { status: 200, body: [] }],
    ['a rejected save without re-render data', { status: 200, body: { saved: false, errors: {}, redirect: null } }],
  ])('fails on %s, which the contract rules out', async (_case, reply: FakeReply) => {
    const rc = { type: 'Local', feedID: '', action: 'add', ...CSRF_FIELDS };
    await expect(render(context(rc, 'POST', reply))).rejects.toThrow(TypeError);
  });

  it.each([401, 403] as const)('answers a service %i with the access-gate denial', async (status) => {
    const ctx = context({ action: 'update', feedID: FEED_ID }, 'POST', { status, body: {} });
    await expect(render(ctx)).rejects.toBeInstanceOf(GatewayDenialError);
  });

  it('propagates an unavailable service as the legacy 503', async () => {
    const ctx = context({ action: 'update', feedID: FEED_ID }, 'POST', { status: 503, body: {} });
    await expect(render(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
