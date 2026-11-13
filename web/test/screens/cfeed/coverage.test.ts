// cFeed.list, cFeed.import1 and the cFeed.edit screen against admin/core/views/cfeed/{list,import1,edit}.cfm.
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_VERSION } from '@/lib/env';
import { GatewayDenialError, type ServicePath } from '@/lib/gateway-client';
import { isSafeHtml, toString, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { cfeedScreens } from '@/screens/cfeed';
import { CFEED_RC_DEFAULTS } from '@/screens/cfeed/before';
import { feedApiEndpoint } from '@/screens/cfeed/common';
import { cfeedEditScreen } from '@/screens/cfeed/edit';
import { loadCfeedImport1, renderCfeedImport1, type CfeedImport1Data } from '@/screens/cfeed/import1';
import { cfeedListScreen, loadFeedList, renderFeedList, type CfeedListData } from '@/screens/cfeed/list';
import type { PageScreen, ScreenContext } from '@/screens/registry';
import { adminS2Request, editorRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const SITE = 'default';
const LOCAL = 'F1000000-0000-0000-0000000000000001';
const ARCHIVE = 'F1000000-0000-0000-0000000000000002';
const REMOTE = 'F1000000-0000-0000-0000000000000003';
const ENDPOINT = 'http://localhost:8080/_api/feed/v1/default';
const NOACCESS = '/admin/?muraAction=cMessage.noaccess';
const URL_TOKENS = `&${CSRF_FIELD_TOKEN}=${FIXED_CSRF.token}&${CSRF_FIELD_EXPIRES}=${FIXED_CSRF.expires}`;
const LONG_LINK = `https://example.com/${'feeds/'.repeat(12)}wire.xml`;

const LIST_PATH: ServicePath = `/v1/sites/${SITE}/feeds`;
const importPath = (feedid: string): ServicePath => `/v1/sites/${SITE}/feeds/${feedid}/import`;
const editPath = (feedid: string): ServicePath => `/v1/sites/${SITE}/feeds/${feedid}`;

const view = (rc: Readonly<Record<string, unknown>>): FakeReply => ({ status: 200, body: { rc } });

/** The before() params on an admin request: `param` keeps the set-up's own compactDisplay values. */
const BEFORE_RC = { ...CFEED_RC_DEFAULTS, compactDisplay: 'false', closeCompactDisplay: 'false' } as const;

/** The S2 admin on `cfeed.<item>` of `default`, whose site has the feed manager. */
const adminOn = (
  item: string,
  rc: Readonly<Record<string, string>> = {},
  partial: AdminRequestPartial = {},
): AdminRequest =>
  adminS2Request({ circuit: 'cfeed', item, rc, site: { hasFeedManager: true, hasComments: true }, ...partial });

function contextFor(
  req: AdminRequest,
  routes: Readonly<Record<string, FakeReply>> = {},
): ScreenContext & {
  gateway: FakeGatewayClient;
} {
  return makeScreenContext({ req, gateway: fakeGatewayClient(routes) });
}

const caught = (promise: Promise<unknown>): Promise<unknown> => promise.catch((error: unknown) => error);

const identityCalls = (gateway: FakeGatewayClient) => gateway.calls.filter((call) => call.service === 'identity');

function bodyOf(rendered: { readonly body: SafeHtml }): string {
  expect(isSafeHtml(rendered.body)).toBe(true);
  return toString(rendered.body);
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('cFeed.list', () => {
  // `feedManager.getFeeds` rows as strategies-content serves them, column case as the query returns it.
  const LOCAL_ROWS = [
    {
      feedID: LOCAL,
      name: 'News & <Events>',
      lang: 'en-us',
      maxItems: 20,
      isFeaturesOnly: 1,
      restricted: 0,
      isActive: 'true',
      channelLink: null,
    },
    {
      FEEDID: ARCHIVE,
      NAME: 'Archive',
      LANG: null,
      MAXITEMS: '5',
      ISFEATURESONLY: null,
      RESTRICTED: 'yes',
      ISACTIVE: false,
      CHANNELLINK: '',
    },
  ];
  const REMOTE_ROWS = [
    {
      feedID: REMOTE,
      name: 'Wire',
      lang: 'en-us',
      maxItems: 10,
      isFeaturesOnly: 0,
      restricted: 0,
      isActive: 1,
      channelLink: LONG_LINK,
    },
  ];
  const listRoute = (rc: Readonly<Record<string, unknown>>) => ({
    [routeKey('GET', 'strategies-content', LIST_PATH)]: view(rc),
  });

  describe('loadFeedList', () => {
    it('reads both queries on the before() defaults and prefetches every row token in one identity call', async () => {
      const ctx = contextFor(
        adminOn('list'),
        listRoute({ rsLocal: LOCAL_ROWS, rsRemote: REMOTE_ROWS, endpoint: ENDPOINT }),
      );

      const data = await loadFeedList(ctx);

      expect(data).toEqual({
        local: [
          {
            feedId: LOCAL,
            name: 'News & <Events>',
            lang: 'en-us',
            maxItems: '20',
            isFeaturesOnly: 1,
            restricted: 0,
            isActive: 'true',
            channelLink: '',
          },
          {
            feedId: ARCHIVE,
            name: 'Archive',
            lang: '',
            maxItems: '5',
            isFeaturesOnly: null,
            restricted: 'yes',
            isActive: false,
            channelLink: '',
          },
        ],
        remote: [
          {
            feedId: REMOTE,
            name: 'Wire',
            lang: 'en-us',
            maxItems: '10',
            isFeaturesOnly: 0,
            restricted: 0,
            isActive: 1,
            channelLink: LONG_LINK,
          },
        ],
        endpoint: ENDPOINT,
      });
      expect(ctx.req.rc).toMatchObject({ ...BEFORE_RC, siteid: SITE });
      expect(identityCalls(ctx.gateway).map((call) => call.json)).toEqual([{ contexts: [LOCAL, ARCHIVE, REMOTE] }]);
    });

    it("builds the site's feed API endpoint when the service returns none", async () => {
      const ctx = contextFor(adminOn('list'), listRoute({ rsLocal: [], rsRemote: [], endpoint: '' }));

      const data = await loadFeedList(ctx);

      expect(data).toEqual({ local: [], remote: [], endpoint: feedApiEndpoint(ctx.req) });
      expect(data.endpoint).toMatch(/\/_api\/feed\/v1\/default$/);
      expect(identityCalls(ctx.gateway)).toEqual([]);
    });

    it.each<[string, Readonly<Record<string, unknown>>, RegExp]>([
      ['no rsLocal array', { rsRemote: [] }, /listFeeds returned no rc\.rsLocal array/],
      [
        'an rsRemote row that is not a struct',
        { rsLocal: [], rsRemote: [[REMOTE]] },
        /rc\.rsRemote row that is not a struct/,
      ],
      [
        'a complex cell',
        { rsLocal: [{ feedID: LOCAL, name: { text: 'News' } }], rsRemote: [] },
        /feed whose name is not a simple value/,
      ],
    ])('rejects a model with %s before asking for tokens', async (_label, rc, message) => {
      const ctx = contextFor(adminOn('list'), listRoute(rc));

      await expect(loadFeedList(ctx)).rejects.toThrow(message);
      expect(identityCalls(ctx.gateway)).toEqual([]);
    });

    it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i', async (status) => {
      const ctx = contextFor(adminOn('list'), {
        [routeKey('GET', 'strategies-content', LIST_PATH)]: { status, body: {} },
      });

      const error = await caught(loadFeedList(ctx));

      expect(error).toBeInstanceOf(GatewayDenialError);
      expect(error).toMatchObject({ service: 'strategies-content', operation: 'listFeeds', status });
    });
  });

  describe('renderFeedList', () => {
    async function render(data: CfeedListData, rc: Readonly<Record<string, string>> = {}): Promise<string> {
      const ctx = contextFor(adminOn('list', rc));
      await ctx.csrf.prefetch([...data.local, ...data.remote].map(({ feedId }) => feedId));
      return bodyOf(renderFeedList(ctx, data));
    }

    const DATA: CfeedListData = {
      local: [
        {
          feedId: LOCAL,
          name: 'News & <Events>',
          lang: 'en-us',
          maxItems: '20',
          isFeaturesOnly: 1,
          restricted: 0,
          isActive: 'true',
          channelLink: '',
        },
        {
          feedId: ARCHIVE,
          name: 'Archive',
          lang: '',
          maxItems: '5',
          isFeaturesOnly: null,
          restricted: 'yes',
          isActive: false,
          channelLink: '',
        },
      ],
      remote: [
        {
          feedId: REMOTE,
          name: 'Wire',
          lang: 'en-us',
          maxItems: '10',
          isFeaturesOnly: 0,
          restricted: 0,
          isActive: 1,
          channelLink: LONG_LINK,
        },
      ],
      endpoint: ENDPOINT,
    };

    it('renders the Local table with yes/no flag cells and the Remote table with the truncated URL', async () => {
      const model = fragmentModel(await render(DATA));

      expect(model.headings).toEqual(['Collections', 'Local Indexes', 'Remote Feeds']);
      expect(model.tables).toEqual([
        {
          headers: ['', 'Index', 'Language', 'Max Items', 'Features Only', 'Restricted', 'Active'],
          rows: [
            ['Edit View RSS Delete', 'News & <Events>', 'en-us', '20', 'Yes', 'No', 'Yes'],
            ['Edit View RSS Delete', 'Archive', '', '5', 'No', 'Yes', 'No'],
          ],
        },
        {
          headers: ['', 'Feed', 'URL', 'Active'],
          rows: [['Edit View Feed Import Delete', 'Wire', LONG_LINK.slice(0, 70), 'Yes']],
        },
      ]);
    });

    it('links each row to its edit, feed and delete actions with the row token and confirmation', async () => {
      const markup = await render(DATA);

      expect(markup).toContain(`<a href="./?muraAction=cFeed.edit&feedID=${LOCAL}&siteid=${SITE}&type=Local">`);
      expect(markup).toContain(
        `<a href="${ENDPOINT}/?feedID=${LOCAL}" target="_blank"><i class="mi-rss"></i>View RSS</a>`,
      );
      expect(markup).toContain(
        `<a href="./?muraAction=cFeed.update&action=delete&feedID=${ARCHIVE}&siteid=${SITE}${URL_TOKENS}"` +
          ` onclick="return confirmDialog('Delete\\x20Local\\x20Index\\x3F',this.href)">`,
      );
      expect(markup).toContain(`<a href="./?muraAction=cFeed.edit&feedID=${REMOTE}&siteid=${SITE}&type=Remote">`);
      expect(markup).toContain(`<a href="${LONG_LINK}" target="_blank"><i class="mi-rss"></i>View Feed</a>`);
      expect(markup).toContain(
        `<a href="./?muraAction=cFeed.import1&feedID=${REMOTE}&siteid=${SITE}"><i class="mi-sign-in"></i>Import</a>`,
      );
      expect(markup).toContain(`confirmDialog('Delete\\x20Remote\\x20Feed\\x3F',this.href)`);
      expect(markup).toContain('<a title="Edit" href="./?muraAction=cFeed.edit&feedID=' + LOCAL);
      expect(markup).toContain('>News &amp; &lt;Events&gt;</a>');
      expect(markup).toContain('<i class="mi-check" title="Yes"></i>');
      expect(markup).toContain('<i class="mi-ban" title="No"></i>');
    });

    it("URL-encodes rc.siteid into the rows' links", async () => {
      const markup = await render(DATA, { siteid: 'tenant a&b' });

      expect(markup).toContain(`feedID=${LOCAL}&siteid=tenant+a%26b&type=Local`);
    });

    it('shows both empty notices and the list menu without rows', async () => {
      const markup = await render({ local: [], remote: [], endpoint: ENDPOINT });
      const model = fragmentModel(markup);

      expect(markup).toContain('<div class="help-block-empty">There are currently no local indexes.</div>');
      expect(markup).toContain('<div class="help-block-empty">There are currently no remote feeds.</div>');
      expect(model.tables).toEqual([]);
      expect(model.links.map(({ text }) => text)).toEqual(['Add Local Index', 'Add Remote Feed', 'Permissions']);
    });

    it('throws for a row whose token was not prefetched', () => {
      const ctx = contextFor(adminOn('list'));

      expect(() => renderFeedList(ctx, DATA)).toThrow(`CSRF tokens for context "${LOCAL}" have not been fetched`);
    });
  });

  describe('cfeedListScreen', () => {
    it('renders the collections inside the shell for the S2 admin', async () => {
      const ctx = contextFor(adminOn('list'), listRoute({ rsLocal: LOCAL_ROWS, rsRemote: [], endpoint: ENDPOINT }));

      const page = await renderScreenPage(cfeedListScreen, ctx);

      expect(page.kind).toBe('document');
      if (page.kind === 'document') expect(page.html).toContain('<h1>Collections</h1>');
    });

    it.each<[string, () => AdminRequest]>([
      [
        'the S2 admin on a site without the feed manager',
        () => adminOn('list', {}, { site: { hasFeedManager: false } }),
      ],
      [
        'the editor without collections access',
        () => editorRequest({ circuit: 'cfeed', item: 'list', site: { hasFeedManager: true } }),
      ],
    ])('secures %s without reading the collections', async (_who, request) => {
      const ctx = contextFor(request(), listRoute({ rsLocal: [], rsRemote: [] }));

      await expect(renderScreenPage(cfeedListScreen, ctx)).resolves.toEqual({ kind: 'redirect', location: './' });
      expect(ctx.gateway.calls.filter(({ path }) => path === LIST_PATH)).toEqual([]);
    });

    it('answers a strategies-content 403 with cMessage.noaccess', async () => {
      const ctx = contextFor(adminOn('list'), {
        [routeKey('GET', 'strategies-content', LIST_PATH)]: { status: 403, body: {} },
      });

      await expect(renderScreenPage(cfeedListScreen, ctx)).resolves.toEqual({ kind: 'redirect', location: NOACCESS });
    });
  });
});

describe('cFeed.import1', () => {
  // previewFeedImport's items: hashed remote ids, the item fields and whether active content already carries them.
  const ITEMS = [
    {
      remoteID: 'A1B2"C3',
      link: 'https://example.com/a?x=1&y=2',
      title: 'First <story>',
      description: '<p>Lead</p>',
      isNew: true,
    },
    { REMOTEID: 'D4E5F6', LINK: 'https://example.com/b', TITLE: 'Second', DESCRIPTION: null, ISNEW: false },
  ];
  const importRoute = (rc: Readonly<Record<string, unknown>> | FakeReply) => ({
    [routeKey('GET', 'strategies-content', importPath(REMOTE))]: 'status' in rc ? (rc as FakeReply) : view(rc),
  });

  describe('loadCfeedImport1', () => {
    it('reads the feed name, version and items of rc.feedid', async () => {
      const ctx = contextFor(
        adminOn('import1', { feedid: REMOTE }),
        importRoute({ feedBean: { name: 'Wire', version: 'RSS 2.0' }, items: ITEMS }),
      );

      await expect(loadCfeedImport1(ctx)).resolves.toEqual({
        feedName: 'Wire',
        version: 'RSS 2.0',
        items: [
          {
            remoteId: 'A1B2"C3',
            link: 'https://example.com/a?x=1&y=2',
            title: 'First <story>',
            description: '<p>Lead</p>',
            isNew: true,
          },
          { remoteId: 'D4E5F6', link: 'https://example.com/b', title: 'Second', description: '', isNew: false },
        ],
      });
      expect(ctx.gateway.calls).toEqual([{ service: 'strategies-content', method: 'GET', path: importPath(REMOTE) }]);
    });

    it('fails as CFML does on an undefined rc.feedid, without a call', async () => {
      const ctx = contextFor(adminOn('import1'), importRoute({ feedBean: {}, items: [] }));

      await expect(loadCfeedImport1(ctx)).rejects.toThrow('Element FEEDID is undefined in RC');
      expect(ctx.gateway.calls).toEqual([]);
    });

    it.each<[string, Readonly<Record<string, unknown>>, RegExp]>([
      ['no feedBean struct', { feedBean: 'Wire', items: [] }, /rc\.feedBean that is not a struct/],
      ['no items array', { feedBean: { name: 'Wire' }, items: {} }, /no rc\.items array/],
      [
        'an item that is not a struct',
        { feedBean: { name: 'Wire' }, items: ['x'] },
        /rc\.items entry that is not a struct/,
      ],
      [
        'an item whose isNew is not a boolean',
        { feedBean: { name: 'Wire' }, items: [{ ...ITEMS[0], isNew: 1 }] },
        /isNew is not a boolean/,
      ],
      [
        'a complex item title',
        { feedBean: { name: 'Wire' }, items: [{ ...ITEMS[0], title: ['a'] }] },
        /title that is not a simple value/,
      ],
    ])('rejects a preview with %s', async (_label, rc, message) => {
      const ctx = contextFor(adminOn('import1', { feedid: REMOTE }), importRoute(rc));

      await expect(loadCfeedImport1(ctx)).rejects.toThrow(message);
    });

    it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i', async (status) => {
      const ctx = contextFor(adminOn('import1', { feedid: REMOTE }), importRoute({ status, body: {} }));

      const error = await caught(loadCfeedImport1(ctx));

      expect(error).toBeInstanceOf(GatewayDenialError);
      expect(error).toMatchObject({ service: 'strategies-content', operation: 'previewFeedImport', status });
    });

    it('fails the page when the remote fetch fails or the feed is unknown', async () => {
      const ctx = contextFor(adminOn('import1', { feedid: REMOTE }), importRoute({ status: 404, body: {} }));

      await expect(loadCfeedImport1(ctx)).rejects.toThrow('previewFeedImport answered HTTP 404');
    });
  });

  describe('renderCfeedImport1', () => {
    const DATA: CfeedImport1Data = {
      feedName: 'Wire',
      version: 'RSS 2.0',
      items: [
        {
          remoteId: 'A1B2"C3',
          link: 'https://example.com/a?x=1&y=2',
          title: 'First <story>',
          description: '<p>Lead</p>',
          isNew: true,
        },
        { remoteId: 'D4E5F6', link: 'https://example.com/b', title: 'Second', description: '', isNew: false },
      ],
    };

    function render(data: CfeedImport1Data, rc: Readonly<Record<string, string>> = { feedid: REMOTE }) {
      const rendered = renderCfeedImport1(contextFor(adminOn('import1', rc)), data);
      return { markup: bodyOf(rendered), ajax: rendered.ajax === undefined ? '' : toString(rendered.ajax) };
    }

    it.each(['RSS 2.0', 'rss 0.920'])(
      'lists every %s item, checked, with an Update marker on changed ones',
      (version) => {
        const { markup } = render({ ...DATA, version });
        const model = fragmentModel(markup);

        expect(model.headings).toEqual(['Remote Feed Import Selection', 'Wire']);
        expect(model.controls.map(({ name, type, value, checked }) => [name, type, value, checked])).toEqual([
          ['remoteID', 'checkbox', 'A1B2"C3', true],
          ['remoteID', 'checkbox', 'D4E5F6', true],
          ['action', 'hidden', 'import', false],
        ]);
        expect(model.links.filter(({ href }) => href.startsWith('https:'))).toEqual([
          { href: 'https://example.com/a?x=1&y=2', text: 'First <story>' },
          { href: 'https://example.com/b', text: 'Second [Update]' },
        ]);
        expect(model.buttons).toEqual([{ text: 'Import', type: 'submit', hasOnclick: true }]);
        expect(markup).toContain('<div class="mura-12"><p>Lead</p></div>');
        expect(markup).toContain(
          `action="./?muraAction=cFeed.import2&feedid=${REMOTE}&siteid=${SITE}" method="post" name="contentForm"`,
        );
      },
    );

    it('shows the unsupported-format notice for Atom, without items or the import action', () => {
      const { markup } = render({ ...DATA, version: 'Atom' });
      const model = fragmentModel(markup);

      expect(model.controls).toEqual([]);
      expect(model.buttons).toEqual([]);
      expect(markup).toContain('<p>This format is currently not supported.</p>');
    });

    it('keeps only the import action for a version no case names', () => {
      const { markup } = render({ ...DATA, version: 'RSS 1.0' });

      expect(fragmentModel(markup).controls.map(({ name }) => name)).toEqual(['action']);
      expect(markup).not.toContain('This format is currently not supported.');
    });

    it('URL-encodes the feed and site ids into the form action and loads the collection scripts', () => {
      const { markup, ajax } = render(DATA, { feedid: 'a b', siteid: 'tenant a&b' });

      expect(markup).toContain('action="./?muraAction=cFeed.import2&feedid=a+b&siteid=tenant+a%26b"');
      expect(ajax).toContain(`assets/js/feed.min.js?coreversion=${CORE_VERSION}`);
    });
  });

  it('renders inside the shell through the registered screen, on the before() defaults', async () => {
    const def = cfeedScreens.find((candidate) => candidate.action === 'import1') as PageScreen<CfeedImport1Data>;
    const ctx = contextFor(
      adminOn('import1', { feedid: REMOTE }),
      importRoute({ feedBean: { name: 'Wire', version: 'RSS 2.0' }, items: ITEMS }),
    );

    const page = await renderScreenPage(def, ctx);

    expect(page.kind).toBe('document');
    if (page.kind !== 'document') return;
    expect(page.html).toContain('<h1>Remote Feed Import Selection</h1>');
    expect(page.html).toContain(`assets/js/jquery/jquery.collapsibleCheckboxTree.js?coreversion=${CORE_VERSION}`);
    expect(ctx.req.rc).toMatchObject({ ...BEFORE_RC, feedid: REMOTE });
  });
});

describe('cfeedEditScreen', () => {
  /** A saved collection's `getAllValues()` over the feedBean defaults. */
  const savedFeed = (values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
    siteID: SITE,
    parentID: '',
    altName: '',
    lang: 'en-us',
    isActive: 1,
    showNavOnly: 1,
    showExcludeSearch: 0,
    isPublic: 0,
    isDefault: 0,
    description: '',
    contentID: '',
    categoryID: '',
    maxItems: 20,
    allowHTML: 1,
    isFeaturesOnly: 0,
    restricted: 0,
    restrictGroups: '',
    version: 'RSS 2.0',
    channelLink: '',
    authtype: 'DEFAULT',
    sortBy: 'lastUpdate',
    sortDirection: 'desc',
    nextN: 20,
    displayName: 0,
    displayRatings: 0,
    displayComments: 0,
    isNew: 0,
    params: [],
    errors: {},
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
    contentpoolid: SITE,
    ...values,
  });

  /** strategies-content's `getFeed` screen model of `feedBean`. */
  const screenModel = (feedBean: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
    feedBean,
    rsRestrictGroups: [],
    rslist: [],
    rsExtendedAttributes: [],
    hasCategories: 0,
    categories: [],
    imageSizes: [],
    contentPool: [{ siteID: SITE, site: 'Default' }],
    rsUsage: [],
    useLayoutManager: true,
    defaultCollectionDisplayList: 'Date,Title,Image,Summary,Credits',
    endpoint: ENDPOINT,
  });

  it.each<[string, string, string]>([
    ['Local', LOCAL, 'Edit Local Index'],
    ['Remote', REMOTE, 'Edit Remote Feed'],
  ])('loads and renders the %s branch in the shell with the collection scripts', async (type, feedID, heading) => {
    const feed = savedFeed({ feedID, name: `${type} feed`, type, channelLink: type === 'Remote' ? LONG_LINK : '' });
    const ctx = contextFor(adminOn('edit', { feedID, type }), {
      [routeKey('GET', 'strategies-content', editPath(feedID))]: view(screenModel(feed)),
    });

    const page = await renderScreenPage(cfeedEditScreen, ctx);

    expect(page.kind).toBe('document');
    if (page.kind !== 'document') return;
    expect(page.html).toContain(heading);
    expect(page.html).toContain(`assets/js/searchParams.js?coreversion=${CORE_VERSION}`);
    expect(ctx.req.rc).toMatchObject({ ...BEFORE_RC, feedID, type });
    const read = ctx.gateway.calls.find(({ path }) => path === editPath(feedID));
    expect(read?.query).toMatchObject({ type });
    expect(
      identityCalls(ctx.gateway).some((call) => (call.json as { contexts: string[] }).contexts.includes(feedID)),
    ).toBe(true);
  });

  it('answers a strategies-content 403 with cMessage.noaccess', async () => {
    const ctx = contextFor(adminOn('edit', { feedID: LOCAL, type: 'Local' }), {
      [routeKey('GET', 'strategies-content', editPath(LOCAL))]: { status: 403, body: {} },
    });

    await expect(renderScreenPage(cfeedEditScreen, ctx)).resolves.toEqual({ kind: 'redirect', location: NOACCESS });
  });

  it('secures the editor without collections access before reading the collection', async () => {
    const req = editorRequest({
      circuit: 'cfeed',
      item: 'edit',
      rc: { feedID: LOCAL, type: 'Local' },
      site: { hasFeedManager: true },
    });
    const ctx = contextFor(req);

    await expect(renderScreenPage(cfeedEditScreen, ctx)).resolves.toEqual({ kind: 'redirect', location: './' });
    expect(ctx.gateway.calls.filter(({ path }) => path === editPath(LOCAL))).toEqual([]);
  });
});
