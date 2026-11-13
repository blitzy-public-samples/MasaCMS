// Unit tests for the cfeed edit model: the strategies-content screen model read as `cfeed/edit.cfm` reads it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { ScreenContext } from '@/screens/registry';
import {
  feedEditModelFrom,
  loadFeedEditModel,
  type FeedEditSource,
  type FeedEditModel,
} from '@/screens/cfeed/edit-model';
import { makeAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';

const NEW_ID = 'NEWID000-0000-0000-0000000000000000';

vi.mock(import('@opt2/platform/legacy-compat'), async (importOriginal) => ({
  ...(await importOriginal()),
  cfUuid: () => NEW_ID,
}));

const FEED_ID = 'F1000000-0000-0000-0000000000000001';
const CONTENT_ID = 'C1000000-0000-0000-0000000000000001';
/** The core content renderer's `defaultCollectionDisplayList`. */
const DEFAULT_FIELDS = 'Date,Title,Image,Summary,Credits';
const ZOOM = '<ul class="navZoom"><li>Home &raquo; News</li></ul>';

type Row = Record<string, unknown>;

/** A new feed bean's `getAllValues()`, as feedBean `init()` leaves it. */
const NEW_BEAN: Row = {
  feedID: '',
  siteID: '',
  name: '',
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
  MaxItems: 20,
  allowHTML: 1,
  isFeaturesOnly: 0,
  restricted: 0,
  restrictGroups: '',
  Version: 'RSS 2.0',
  ChannelLink: '',
  authtype: 'DEFAULT',
  type: 'local',
  sortBy: 'lastUpdate',
  sortDirection: 'desc',
  parentID: '',
  nextN: 20,
  displayName: 0,
  isNew: 1,
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
  contentpoolid: '',
};

/** Two subtypes' content attributes; the `Folder/Archive` subtype is inactive. */
const ATTRIBUTES: Row[] = [
  { attributeID: 'A1', type: 'Page', subType: 'Default', attribute: 'teaser', isActive: 1 },
  { attributeID: 'A2', type: 'Page', subType: 'Default', attribute: 'Byline', isActive: 1 },
  { attributeID: 'A3', type: 'Folder', subType: 'Archive', attribute: 'teaser', isActive: 0 },
];

/** A screen model's `rc` for a new collection; `rc` members replace the defaults. */
function modelRc(rc: Row = {}): Row {
  return {
    feedBean: NEW_BEAN,
    rsRestrictGroups: [],
    rslist: [],
    rsExtendedAttributes: [],
    hasCategories: 0,
    categories: [],
    imageSizes: [],
    contentPool: [{ siteID: 'default', site: 'Default' }],
    ...rc,
  };
}

const screenModel = (rc: Row = {}): FeedEditSource => ({ rc: modelRc(rc) });

/** `feedBean` with `values` laid over the new bean. */
const bean = (values: Row): Row => ({ ...NEW_BEAN, ...values });

/** A `cfeed.edit` request for the admin user on site `default`; `rc` adds to the FW/1 context. */
function request(rc: Record<string, string> = {}, partial: AdminRequestPartial = {}): AdminRequest {
  return makeAdminRequest(
    { ...partial, circuit: 'cfeed', item: 'edit', rc, site: { hasFeedManager: true, ...partial.site } },
    'admin',
  );
}

const LOCAL = { type: 'Local', feedID: '' } as const;
const SAVED_LOCAL = { type: 'Local', feedID: FEED_ID } as const;

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('feedEditModelFrom', () => {
  it('maps a new Local collection through the bean getters and the legacy defaults', () => {
    const model = feedEditModelFrom(screenModel({ rsExtendedAttributes: ATTRIBUTES }), request(LOCAL));
    expect(model.feed).toMatchObject({
      feedID: '',
      siteID: 'default',
      type: 'local',
      isNew: true,
      exists: false,
      isLocked: false,
      contentPoolID: 'default',
      maxItems: '20',
      nextN: '20',
      showNavOnly: true,
      isActive: true,
      allowHTML: true,
      restricted: false,
      imageSize: 'small',
      imageWidth: 'AUTO',
      imageHeight: 'AUTO',
      version: 'RSS 2.0',
      channelLink: '',
      authType: 'DEFAULT',
      displayList: 'Date,Title,Image,Summary,Credits,Tags',
      // Every distinct attribute name, inactive subtypes included, sorted by code unit.
      availableDisplayList: 'Body,ReadMore,Comments,Rating,Byline,teaser',
      instanceParams: '',
    });
    expect(model).toMatchObject({
      errors: {},
      advancedParams: [],
      contentFilters: [],
      restrictGroups: [],
      hasCategories: false,
      categories: [],
      usage: [],
      customImageSizes: [],
      useLayoutManager: false,
      siteHasComments: false,
      siteExtranet: false,
      contentPool: [{ siteID: 'default', site: 'Default' }],
      parentMenuTitle: '',
      hasMarketingManager: false,
      proxyServer: '',
      proxyUser: '',
      isObjectInstance: false,
      showUsageTabs: true,
      endpoint: undefined,
      pluginMessage: '',
    } satisfies Partial<FeedEditModel>);
    expect(model.extendedAttributes).toEqual([
      { attributeID: 'A1', type: 'Page', subType: 'Default', attribute: 'teaser' },
      { attributeID: 'A2', type: 'Page', subType: 'Default', attribute: 'Byline' },
    ]);
  });

  it('maps a saved Local collection with its filters, params, groups, categories, usage and site flags', () => {
    const source = screenModel({
      feedBean: bean({
        feedID: FEED_ID,
        siteID: 'other',
        isNew: 0,
        name: 'News',
        contentID: CONTENT_ID,
        categoryID: 'K1,K2',
        contentpoolid: 'default,umbrella',
        displayList: '',
        displayComments: 1,
        restricted: '1',
        restrictGroups: 'G1',
        errors: { name: 'The name is required.', siteid: 'x' },
        params: [
          {
            feedID: FEED_ID,
            param: 1,
            relationship: 'and',
            field: 'tcontent.title',
            condition: 'Contains',
            criteria: 'Masa',
            dataType: 'varchar',
          },
        ],
      }),
      rslist: [
        { contentID: CONTENT_ID, menutitle: 'News', type: 'Folder', siteid: 'default', zoom: ZOOM },
        { contentID: 'GONE', menutitle: 'Gone', type: 'Page', siteid: 'default', zoom: '', exists: false },
      ],
      rsRestrictGroups: [
        { groupname: 'Members', userid: 'G1', isPublic: 1 },
        { groupname: 'Editors', userid: 'G2', isPublic: 0 },
      ],
      hasCategories: 3,
      categories: [
        { categoryID: 'K1', parentID: null, name: 'Topics', isOpen: 1, permitted: true },
        { categoryID: 'K2', parentID: 'K1', name: 'Local', isOpen: '0', permitted: 0 },
      ],
      rsUsage: [
        {
          contentHistID: 'H1',
          contentID: CONTENT_ID,
          type: 'Page',
          parentID: '00000000000000000000000000000000001',
          siteID: 'default',
          moduleID: '00000000000000000000000000000000000',
          display: 2,
          approved: 1,
          displayStart: '2026-01-01 00:00:00',
          displayStop: null,
          lastUpdate: '2026-01-15 09:30:00',
          zoom: ZOOM,
          verdict: 'editor',
        },
      ],
      imageSizes: [{ name: 'Hero' }, { name: 'thumb' }],
      contentPool: [
        { siteID: 'default', site: 'Default' },
        { siteID: 'umbrella', site: 'Umbrella' },
      ],
      endpoint: 'http://localhost/_api/feed/v1/default',
    });
    const req = request(SAVED_LOCAL, { site: { hasComments: true, extranet: true } });
    const model = feedEditModelFrom(source, req);

    expect(model.feed).toMatchObject({
      feedID: FEED_ID,
      // A Local edit takes the request's site, as the view's setSiteID does.
      siteID: 'default',
      isNew: false,
      exists: true,
      contentPoolID: 'default,umbrella',
      categoryID: 'K1,K2',
      displayList: 'Date,Title,Image,Summary,Credits',
      restricted: true,
      restrictGroups: 'G1',
    });
    expect(model.errors).toEqual({ name: 'The name is required.', siteid: 'x' });
    expect(Object.keys(model.errors)).toEqual(['name', 'siteid']);
    expect(model.advancedParams).toEqual([
      { relationship: 'and', field: 'tcontent.title', dataType: 'varchar', condition: 'Contains', criteria: 'Masa' },
    ]);
    expect(model.contentFilters).toEqual([{ contentID: CONTENT_ID, siteID: 'default', type: 'Folder', zoom: ZOOM }]);
    expect(model.restrictGroups).toEqual([
      { userID: 'G1', groupName: 'Members', isPublic: true },
      { userID: 'G2', groupName: 'Editors', isPublic: false },
    ]);
    expect(model.hasCategories).toBe(true);
    expect(model.categories).toEqual([
      {
        categoryID: 'K1',
        name: 'Topics',
        isOpen: 1,
        permitted: true,
        hasKids: 1,
        children: [{ categoryID: 'K2', name: 'Local', isOpen: 0, permitted: false, hasKids: 0, children: [] }],
      },
    ]);
    expect(model.usage).toEqual([
      {
        contentHistID: 'H1',
        contentID: CONTENT_ID,
        type: 'Page',
        parentID: '00000000000000000000000000000000001',
        siteID: 'default',
        moduleID: '00000000000000000000000000000000000',
        display: 2,
        approved: 1,
        displayStart: '2026-01-01 00:00:00',
        displayStop: null,
        lastUpdate: '2026-01-15 09:30:00',
        zoom: ZOOM,
        verdict: 'editor',
      },
    ]);
    expect(model).toMatchObject({
      customImageSizes: ['Hero', 'thumb'],
      siteHasComments: true,
      siteExtranet: true,
      contentPool: [
        { siteID: 'default', site: 'Default' },
        { siteID: 'umbrella', site: 'Umbrella' },
      ],
      endpoint: 'http://localhost/_api/feed/v1/default',
    });
  });

  it.each([
    { imageSize: 'Custom', imageHeight: 'AUTO', imageWidth: 'AUTO', expected: ['small', 'AUTO', 'AUTO'] },
    { imageSize: 'custom', imageHeight: '200', imageWidth: 'AUTO', expected: ['custom', 'AUTO', '200'] },
    { imageSize: 'Custom', imageHeight: 150, imageWidth: 300, expected: ['Custom', '300', '150'] },
    { imageSize: 'medium', imageHeight: '200', imageWidth: '300', expected: ['medium', 'AUTO', 'AUTO'] },
  ])('reads image size $imageSize at $imageWidth x $imageHeight through the getters', (values) => {
    const { expected, ...stored } = values;
    const { feed } = feedEditModelFrom(screenModel({ feedBean: bean(stored) }), request(LOCAL));
    expect([feed.imageSize, feed.imageWidth, feed.imageHeight]).toEqual(expected);
  });

  it.each([
    { pool: '', site: undefined, expected: 'default' },
    { pool: '*', site: { contentPoolID: 'default,umbrella' }, expected: 'default,umbrella' },
  ])('reads contentPoolID $pool as getContentPoolID does', ({ pool, site, expected }) => {
    const source = screenModel({ feedBean: bean({ contentpoolid: pool }) });
    const { feed } = feedEditModelFrom(source, request(LOCAL, { site }));
    expect(feed.contentPoolID).toBe(expected);
  });

  it('refuses a `*` content pool of a site the request did not load', () => {
    const source = screenModel({ feedBean: bean({ siteID: 'elsewhere', contentpoolid: '*' }) });
    expect(() => feedEditModelFrom(source, request({ type: 'Remote', feedID: '' }))).toThrow(/elsewhere/);
  });

  it('maps a saved Remote collection with its stored site and import location', () => {
    const source = screenModel({
      feedBean: bean({
        feedID: FEED_ID,
        siteID: 'umbrella',
        type: 'Remote',
        isNew: 0,
        name: 'Wire',
        ChannelLink: 'https://example.com/rss',
        authtype: 'BASIC',
        parentID: CONTENT_ID,
        autoimport: 1,
        isActive: 0,
      }),
      rsUsage: [],
      parentMenuTitle: 'News & Events',
    });
    const req = request({ type: 'Remote', feedID: FEED_ID, assignmentID: 'ignored' });
    const model = feedEditModelFrom(source, req);
    expect(model.feed).toMatchObject({
      siteID: 'umbrella',
      type: 'Remote',
      channelLink: 'https://example.com/rss',
      authType: 'BASIC',
      parentID: CONTENT_ID,
      autoImport: true,
      isActive: false,
    });
    expect(model.parentMenuTitle).toBe('News & Events');
    // Only the Local branch handles display object instances.
    expect(model.isObjectInstance).toBe(false);

    const { parentMenuTitle: _omitted, ...withoutTitle } = (source as { rc: Row }).rc;
    expect(() => feedEditModelFrom({ rc: withoutTitle }, req)).toThrow(TypeError);
  });

  it('maps a rejected save from its write result: submitted values, the result errors, no usage for an add', () => {
    const result: FeedEditSource = {
      saved: false,
      errors: { name: 'Please enter a name.' },
      redirect: null,
      data: {
        ...modelRc(),
        feedBean: bean({ name: '', displayList: 'Title,Summary', errors: { stale: 'replaced' } }),
      },
    };
    const model = feedEditModelFrom(result, request({ ...LOCAL, action: 'add' }));
    expect(model.errors).toEqual({ name: 'Please enter a name.' });
    expect(model.feed).toMatchObject({ name: '', displayList: 'Title,Summary', isNew: true });
    expect(model.usage).toEqual([]);
    expect(() => feedEditModelFrom({ saved: false, errors: {}, redirect: null }, request(LOCAL))).toThrow(TypeError);
  });

  it.each([
    ['feedBean', { feedBean: undefined }, LOCAL],
    ['feedBean.params', { feedBean: bean({ params: undefined }) }, LOCAL],
    ['rslist', { rslist: undefined }, LOCAL],
    ['rsUsage of a saved collection', { feedBean: bean({ feedID: FEED_ID, isNew: 0 }) }, SAVED_LOCAL],
    ['a complex simple value', { feedBean: bean({ name: { a: 1 } }) }, LOCAL],
  ])('throws when the model lacks %s', (_name, rc, rcValues) => {
    expect(() => feedEditModelFrom(screenModel(rc), request(rcValues))).toThrow(TypeError);
  });

  describe('display object instance', () => {
    const INSTANCE = { ...SAVED_LOCAL, assignmentID: 'ASSIGN1', regionID: '2', orderno: '1' } as const;
    const instanceModel = (rsDisplayObject: Row[] | undefined, values: Row = {}): FeedEditSource =>
      screenModel({
        feedBean: bean({ feedID: FEED_ID, isNew: 0, name: 'News', ...values }),
        rsUsage: [],
        rsDisplayObject,
      });

    it('lays JSON params over the feed with the bean setters, keys matched case-insensitively', () => {
      const params = JSON.stringify({
        DISPLAYNAME: 'true',
        maxitems: 'all',
        nextN: '5',
        imageSize: 'custom',
        imageheight: 120,
        IMAGEWIDTH: 'wide',
        cssclass: '  card ',
        altname: 'Latest',
        displaylist: 'Title,Image',
        sortDirection: 'up',
        categoryID: ' K9 ',
        errors: { altName: 'Too long' },
        params: { param: '1' },
      });
      const model = feedEditModelFrom(instanceModel([{ object: 'feed', params: ` ${params} ` }]), request(INSTANCE));
      expect(model.isObjectInstance).toBe(true);
      expect(model.feed).toMatchObject({
        instanceParams: params,
        displayName: true,
        maxItems: '20',
        nextN: '5',
        imageSize: 'custom',
        imageHeight: '120',
        imageWidth: 'AUTO',
        cssClass: 'card',
        altName: 'Latest',
        displayList: 'Title,Image',
        sortDirection: 'desc',
        categoryID: 'K9',
        availableDisplayList: 'Date,Summary,Body,ReadMore,Credits,Comments,Tags,Rating',
      });
      expect(model.errors).toEqual({ altName: 'Too long' });
      expect(model.advancedParams).toEqual([]);
    });

    it.each([
      { object: 'feed_slideshow', displayList: '', images: ['medium', 'AUTO', 'AUTO'], fields: DEFAULT_FIELDS },
      {
        object: 'feed_slideshow_no_summary',
        displayList: ' Title,Image ',
        images: ['medium', 'AUTO', 'AUTO'],
        fields: 'Title,Image',
      },
      { object: 'feed', displayList: '', images: ['Custom', '300', '200'], fields: DEFAULT_FIELDS },
    ])('keeps the display list of non-JSON params and adjusts $object images', (row) => {
      const { object, displayList, images, fields } = row;
      const source = instanceModel([{ object, params: 'legacy' }], {
        displayList,
        imageSize: 'Custom',
        imageWidth: '300',
        imageHeight: '200',
      });
      const { feed } = feedEditModelFrom(source, request(INSTANCE));
      expect([feed.imageSize, feed.imageWidth, feed.imageHeight]).toEqual(images);
      expect(feed).toMatchObject({ displayList: fields, instanceParams: 'legacy' });
    });

    it.each(['feed_no_summary', 'FEED_SLIDESHOW_NO_SUMMARY'])(
      'fails as legacy does for %s when the display list holds Summary',
      (object) => {
        const source = instanceModel([{ object, params: '' }], { displayList: 'Title,summary' });
        expect(() => feedEditModelFrom(source, request(INSTANCE))).toThrow(
          'Element HASSUMMARY is undefined in ARGUMENTS.',
        );
      },
    );

    it('reads an empty display object query as empty params, and a missing one as an already merged feed', () => {
      const empty = feedEditModelFrom(instanceModel([], { instanceParams: '{"x":1}' }), request(INSTANCE));
      expect(empty.feed.instanceParams).toBe('');
      const merged = feedEditModelFrom(instanceModel(undefined, { instanceParams: '{"x":1}' }), request(INSTANCE));
      expect(merged.feed.instanceParams).toBe('{"x":1}');
      expect(merged.isObjectInstance).toBe(true);
    });

    it('sets a simple JSON value as an empty property', () => {
      const source = instanceModel([{ object: 'feed', params: '"altName"' }], { altName: 'x' });
      const { feed } = feedEditModelFrom(source, request(INSTANCE));
      expect(feed.altName).toBe('');
    });
  });
});

describe('loadFeedEditModel', () => {
  const PATH = `/v1/sites/default/feeds/${FEED_ID}` as const;

  /** A screen context over `gateway` for `req`. */
  function context(req: AdminRequest, gateway: FakeGatewayClient): ScreenContext {
    return {
      req,
      gateway,
      csrf: createCsrfRenderer(gateway),
      rb: rbFor('en'),
      hooks: { secondaryMenus: {} },
      now: new Date('2026-06-30T12:00:00Z'),
    };
  }

  it('applies the cfeed defaults, reads the model with the rc values and maps it', async () => {
    const gateway = fakeGatewayClient({
      [routeKey('GET', 'strategies-content', PATH)]: {
        status: 200,
        body: screenModel({ feedBean: bean({ feedID: FEED_ID, isNew: 0, name: 'News' }), rsUsage: [] }),
      },
    });
    const req = request({ ...SAVED_LOCAL, homeID: 'HOME' });
    const ctx = context(req, gateway);
    const model = await loadFeedEditModel(req, ctx);

    expect(model.feed).toMatchObject({ feedID: FEED_ID, name: 'News', siteID: 'default' });
    expect(gateway.calls).toEqual([
      {
        service: 'strategies-content',
        method: 'GET',
        path: PATH,
        query: {
          type: 'Local',
          assignmentID: '',
          regionID: '0',
          orderno: '0',
          instanceid: '',
          homeID: 'HOME',
          // The admin set-up defaults compactDisplay before the cfeed defaults run.
          compactDisplay: 'false',
        },
      },
    ]);
    expect(ctx.req).not.toBe(req);
    expect(req.rc.restricted).toBeUndefined();
    expect([ctx.req.rc.restricted, ctx.req.rc.startrow, ctx.req.rc.instanceParams]).toEqual(['0', '1', '']);
  });

  it('reads a new collection under a fresh id and sends only the rc values present', async () => {
    const gateway = fakeGatewayClient({
      [routeKey('GET', 'strategies-content', `/v1/sites/default/feeds/${NEW_ID}`)]: {
        status: 200,
        body: screenModel(),
      },
    });
    const req = request({ feedID: '' });
    const model = await loadFeedEditModel(req, context(req, gateway));
    expect(model.feed.isNew).toBe(true);
    expect(gateway.calls[0]?.query).not.toHaveProperty('type');
  });

  it('refuses an empty site and relays a denial', async () => {
    const empty = request({ ...LOCAL, siteid: '' });
    await expect(loadFeedEditModel(empty, context(empty, fakeGatewayClient()))).rejects.toThrow(TypeError);

    const gateway = fakeGatewayClient({ [routeKey('GET', 'strategies-content', PATH)]: { status: 403, body: {} } });
    const req = request(SAVED_LOCAL);
    await expect(loadFeedEditModel(req, context(req, gateway))).rejects.toBeInstanceOf(GatewayDenialError);
  });
});
