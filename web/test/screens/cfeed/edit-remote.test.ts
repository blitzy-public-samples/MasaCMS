// Unit tests for the Remote branch of the cfeed edit view, against bodies captured from the legacy ACF 2023 server.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { applyCfeedDefaults } from '@/screens/cfeed/before';
import type { FeedCategoryNode } from '@/screens/cfeed/categories-nest';
import type { FeedEditModel, FeedView } from '@/screens/cfeed/edit-model';
import type { FeedUsageRow } from '@/screens/cfeed/tab-usage';
import { renderRemoteFeedEdit, type RemoteFeedEditView } from '@/screens/cfeed/edit-remote';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request, siteAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type RecordedRequest } from '../../helpers/fake-gateway';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/strategies-content');

/** The CSRF pair the fixtures carry in place of the captured one. */
const CSRF = { token: 'TESTCSRFTOKEN0000000000000000000', expires: '260630150000000' } as const;

const FEED_ID = '3DA72278-AB15-3395-E0CFC1D4D9451B15';
const HOME_ID = '00000000000000000000000000000000001';
const CATEGORY_ID = 'C4000000-0000-0000-0000000000000001';

/** A captured legacy body: from the view's first byte through `</form>` and its newline. */
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

/** A new remote feed bean as `feedManager.read(feedID='')` returns it. */
const NEW_FEED: FeedView = {
  feedID: '',
  siteID: 'default',
  type: 'Remote',
  isNew: true,
  exists: false,
  isLocked: false,
  name: '',
  contentPoolID: 'default',
  sortBy: 'lastUpdate',
  sortDirection: 'desc',
  maxItems: '20',
  nextN: '20',
  isFeaturesOnly: false,
  showNavOnly: true,
  showExcludeSearch: false,
  categoryID: '',
  useCategoryIntersect: false,
  imageSize: 'small',
  imageWidth: 'AUTO',
  imageHeight: 'AUTO',
  displayName: false,
  altName: '',
  cssClass: '',
  viewAllLink: '',
  viewAllLabel: '',
  displayList: 'Date,Title,Image,Summary,Credits',
  availableDisplayList: 'Body,ReadMore,Comments,Tags,Rating',
  description: '',
  allowHTML: true,
  isPublic: false,
  version: 'RSS 2.0',
  lang: 'en-us',
  restricted: false,
  restrictGroups: '',
  channelLink: '',
  isActive: true,
  isDefault: false,
  authType: 'DEFAULT',
  autoImport: false,
  parentID: '',
  instanceParams: '',
};

/** The saved feed the fixtures were captured from. */
const SAVED_FEED: FeedView = {
  ...NEW_FEED,
  feedID: FEED_ID,
  isNew: false,
  exists: true,
  name: 'My <Remote> "Feed" & Co',
  channelLink: 'https://example.com/feed.xml?a=1&b="2"',
  maxItems: '100000',
  version: 'Atom',
  isPublic: true,
  isActive: false,
  autoImport: true,
  parentID: HOME_ID,
};

/** The edit model of `feed` on a site with no categories and no usage; `fields` overrides any member. */
function model(feed: FeedView, fields: Partial<FeedEditModel> = {}): FeedEditModel {
  return {
    feed,
    errors: {},
    advancedParams: [],
    contentFilters: [],
    restrictGroups: [],
    extendedAttributes: [],
    hasCategories: false,
    categories: [],
    usage: [],
    customImageSizes: [],
    useLayoutManager: false,
    siteHasComments: false,
    siteExtranet: false,
    contentPool: [],
    parentMenuTitle: feed.parentID === '' ? '' : 'Home',
    hasMarketingManager: false,
    proxyServer: '',
    proxyUser: '',
    isObjectInstance: false,
    showUsageTabs: true,
    pluginMessage: '',
    ...fields,
  };
}

/** `cFeed.edit` with `rc` laid over the request and the cfeed defaults applied, as the S2 admin unless `req` is given. */
function request(rc: AdminRequestPartial['rc'], make: (p: AdminRequestPartial) => AdminRequest = adminS2Request): AdminRequest {
  const req = make({ circuit: 'cfeed', item: 'edit', rc: { type: 'Remote', ...rc } });
  return { ...req, rc: applyCfeedDefaults(req.rc) };
}

/** A screen context whose identity issues {@link CSRF} for every context. */
function context(req: AdminRequest, rb: RbLookup = rbFor('en')): ScreenContext {
  const issue = (call: RecordedRequest): FakeReply => {
    const { contexts } = call.json as { readonly contexts: readonly string[] };
    const tokens = contexts.map((c) => ({ context: c, [CSRF_FIELD_TOKEN]: CSRF.token, [CSRF_FIELD_EXPIRES]: CSRF.expires }));
    return { status: 200, body: { tokens } };
  };
  const gateway = fakeGatewayClient({ [routeKey('POST', 'identity', '/v1/csrf/tokens')]: issue });
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb,
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

/** The branch output for `req` and `data`. */
function render(req: AdminRequest, data: FeedEditModel, fuseaction = 'edit', rb?: RbLookup): Promise<RemoteFeedEditView> {
  return renderRemoteFeedEdit(req, context(req, rb), data, { fuseaction });
}

/** Ids and labels of the tab strip, in order. */
function tabs(markup: string): [string, string][] {
  const $ = cheerio.load(markup);
  return $('ul.mura-tabs > li > a')
    .toArray()
    .map((a) => [$(a).attr('href') ?? '', $(a).text()]);
}

describe('renderRemoteFeedEdit', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = useTestEnv();
  });
  afterEach(() => {
    restore();
  });

  it('reproduces a saved feed for S2 byte for byte, with Import Location and Usage Report tabs', async () => {
    const view = await render(request({ feedID: FEED_ID }), model(SAVED_FEED));
    expect(toString(view.body)).toBe(fixture('cfeed-edit-remote-existing.html'));
    expect(view.htmlHead).toBeUndefined();
    const markup = toString(view.body);
    expect(tabs(markup)).toEqual([
      ['#tabBasic', 'Basic'],
      ['#tabCategorization', 'Categories'],
      ['#tabImportlocation', 'Import Location'],
      ['#tabUsagereport', 'Usage Report'],
    ]);
    const $ = cheerio.load(markup);
    expect($('#tabImportlocation h3.block-title').text()).toBe(
      "application.rbFactory.getKeyValue(session.rb,'collections.importlocation')",
    );
    expect($('form[name=form1]').attr('id')).toBeUndefined();
  });

  it('reproduces a saved feed with a usage row under the layout manager byte for byte', async () => {
    const expected = fixture('cfeed-edit-remote-usage.html');
    const zoom = /<td class="var-width">(<ul class="breadcrumb">[^]*?<\/ul>)<\/td>/.exec(expected)?.[1] ?? '';
    const usage: FeedUsageRow = {
      contentHistID: '6300ED69-1320-5CC3-F922E3012E2C6BAE',
      contentID: HOME_ID,
      type: 'Page',
      parentID: '00000000000000000000000000000000END',
      siteID: 'default',
      moduleID: '00000000000000000000000000000000000',
      display: 1,
      approved: 1,
      displayStart: null,
      displayStop: null,
      lastUpdate: '2026-11-13 02:43:17',
      zoom,
      verdict: 'editor',
    };
    const view = await render(request({ feedID: FEED_ID }), model(SAVED_FEED, { useLayoutManager: true, usage: [usage] }));
    expect(zoom).not.toBe('');
    expect(toString(view.body)).toBe(expected);
  });

  it('reproduces compact display: back link, global notice, homeID, no menu or Delete, the setWidth head script', async () => {
    const req = request({ feedID: FEED_ID, compactDisplay: 'true', homeID: HOME_ID, instanceid: 'a"b<' });
    const view = await render(req, model(SAVED_FEED));
    expect(toString(view.body)).toBe(fixture('cfeed-edit-remote-compact.html'));
    const head = view.htmlHead === undefined ? '' : toString(view.htmlHead);
    expect(head.startsWith('\n<script type="text/javascript">\njQuery(document).ready(function(){')).toBe(true);
    expect(head).toContain(`jQuery("#ProxyIFrame").load(`);
    expect(head.match(/frontEndProxy\.post\(\{cmd:'setWidth',width:'standard'\}\);/g)).toHaveLength(2);
  });

  it('reproduces a new feed under the layout manager: Add, no navTask, no usage tab, no view-all or CSS fields', async () => {
    const view = await render(request({ feedID: '' }), model(NEW_FEED, { useLayoutManager: true }));
    expect(toString(view.body)).toBe(fixture('cfeed-edit-remote-new.html'));
    const { controls, buttons } = fragmentModel(toString(view.body));
    expect(controls.find((c) => c.name === 'action')?.value).toBe('add');
    expect(buttons.map(({ text, type }) => [text, type])).toEqual([['Add', 'button']]);
  });

  it('leaves the Import Location tab and pane out for a site admin without S2', async () => {
    const req = request({ feedID: FEED_ID, siteid: 'tenant-a' }, (p) => siteAdminRequest('tenant-a', p));
    const markup = toString((await render(req, model({ ...SAVED_FEED, siteID: 'tenant-a' }))).body);
    expect(tabs(markup)).toEqual([
      ['#tabBasic', 'Basic'],
      ['#tabCategorization', 'Categories'],
      ['#tabUsagereport', 'Usage Report'],
    ]);
    const $ = cheerio.load(markup);
    expect($('#tabImportlocation')).toHaveLength(0);
    expect($('input[name=parentid]')).toHaveLength(0);
    expect($('form[name=form1]').attr('action')).toBe('./?muraAction=cFeed.update&siteid=tenant-a');
  });

  it('renders errors, the category tree, the auth types for both proxies and the selected parent', async () => {
    const tree: FeedCategoryNode[] = [
      { categoryID: CATEGORY_ID, name: 'News & <Events>', isOpen: 1, permitted: true, hasKids: 0, children: [] },
    ];
    const data = model(
      { ...SAVED_FEED, categoryID: CATEGORY_ID, authType: 'ntlm' },
      { errors: { name: 'Bad <name>', siteID: 'ignored' }, categories: tree, proxyServer: 'proxy', proxyUser: 'user' },
    );
    const markup = toString((await render(request({ feedID: FEED_ID }), data, 'update')).body);
    const $ = cheerio.load(markup);
    expect(markup).toContain('-->\n\n\n\t<div class="alert alert-error"><span>Bad <name> <br> </span></div>\n\n\n<span id="msg">');
    expect($('#mura-list-tree ul.categories.checkboxTree input[name=categoryID]').attr('checked')).toBe('checked');
    const auth = $('select[name=authtype] option').toArray().map((o) => [$(o).val(), $(o).attr('selected') !== undefined]);
    expect(auth).toEqual([
      ['DEFAULT', false],
      ['BASIC', false],
      ['PROXY', false],
      ['NTLM', true],
    ]);
    expect($('#move').text()).toContain('"Home"');
  });

  it.each([
    ['proxy server', { proxyServer: 'proxy' }, ['DEFAULT', 'BASIC', 'PROXY']],
    ['proxy user', { proxyUser: 'user' }, ['DEFAULT', 'BASIC', 'NTLM']],
    ['no proxy', {}, []],
  ] as const)('lists the auth types for a %s', async (_case, proxies, expected) => {
    const markup = toString((await render(request({ feedID: FEED_ID }), model(SAVED_FEED, proxies))).body);
    const $ = cheerio.load(markup);
    expect($('select[name=authtype] option').toArray().map((o) => $(o).val())).toEqual(expected);
  });

  it('fails as legacy does when a saved feed stored as Local reaches the menu, and not in compact display', async () => {
    const local = model({ ...SAVED_FEED, type: 'local' });
    await expect(render(request({ feedID: FEED_ID }), local)).rejects.toThrow('Variable ENDPOINT is undefined.');
    const compact = await render(request({ feedID: FEED_ID, compactDisplay: 'true' }), local);
    expect(toString(compact.body)).toContain('<h1>Edit Remote Feed</h1>');
  });

  it('reads tab labels as a comma list, so a label holding a comma shifts the later labels', async () => {
    const en = rbFor('en');
    const rb: RbLookup = { ...en, rbKey: (key) => (key === 'collections.basic' ? 'Basic,Main' : en.rbKey(key)) };
    const markup = toString((await render(request({ feedID: '' }), model(NEW_FEED), 'edit', rb)).body);
    expect(tabs(markup).map(([, text]) => text)).toEqual(['Basic', 'Main', 'Categories']);
  });
});
