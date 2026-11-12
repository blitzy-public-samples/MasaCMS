// JSON API data values against bodies recorded from Masa 7.6.1 on ACF 2023.0.26 (test/fixtures), serialized through
// legacy-compat serializeResponse. Default collection URLs follow ACF struct order, so their query params are sorted.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildEnvelope, serializeResponse } from '@opt2/platform/legacy-compat';
import { contentUrl, type LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';
import { CONTENT_ENTITIES, type ContentEntityName } from '../../src/legacy/jsonapi-entities.js';
import {
  contentApiSerializer,
  contentEntityLinks,
  contentImages,
  iteratorPage,
  jsonApiEndpoint,
  paramUrl,
  selectFields,
  serializeCollection,
  serializeContentEntity,
  serializeCrumbs,
  serializeEntityList,
  serializeRelatedContent,
  serializeVersionHistory,
  urlParam,
  type ApiEntityView,
  type ExpansionResolver,
  type JsonApiRequestContext,
} from '../../src/legacy/jsonapi-serializers.js';

type Struct = Record<string, unknown>;
interface Recorded {
  method: string;
  data: Struct;
}
interface Fixtures {
  rows: Record<'home' | 'alpha' | 'beta' | 'comment', Struct>;
  oracle: Record<string, Recorded>;
  own: Record<string, Recorded>;
}

const FX = JSON.parse(
  readFileSync(new URL('../fixtures/legacy-jsonapi-recorded.json', import.meta.url), 'utf8'),
) as Fixtures;

const HOME = '00000000000000000000000000000000001';
const ALPHA = '159FCDA6-F4C2-D86E-D29FF3A01CA0A0E9';
const BETA = '159FDB77-AA07-7CD9-C94A0F7AB878EF87';
const ORACLE = 8080;
const OWN = 23980;
const HOME_EDIT_URL =
  '/admin/?muraAction=cArch.edit&contenthistid=6300ED69-1320-5CC3-F922E3012E2C6BAE&contentid=00000000000000000000000000000000001&type=Page&siteid=default&topid=00000000000000000000000000000000001&parentid=00000000000000000000000000000000END&moduleid=00000000000000000000000000000000000&compactdisplay=false';
// What comment.allowQueryParams writes into url.fields for a caller without comment module access.
const COMMENT_PUBLIC_FIELDS =
  'comments,links,entered,isspam,flagcount,parentid,name,isapproved,kids,isdeleted,userid,subscribe,isnew,contentid,path,siteid,id,remoteid,contenthistid';

function site(port: number, overrides: Partial<LegacySiteUrlConfig> = {}): LegacySiteUrlConfig {
  return {
    siteId: 'default',
    scheme: 'http',
    domain: 'localhost',
    requestDomain: 'localhost',
    previewDomain: '',
    serverPort: `:${port}`,
    context: '',
    siteIdInUrls: false,
    indexFileInUrls: false,
    hashUrls: false,
    useSSL: false,
    filePoolId: 'default',
    configFileAssetPath: '',
    assetPath: '/sites',
    siteAssetPath: '/sites',
    fileStore: 'fileDir',
    legacyIndexFileLocation: false,
    urlTitleDelim: '-',
    allowUnicodeInFilenames: false,
    placeholderImgId: '',
    placeholderImgExt: '',
    directImages: true,
    ...overrides,
  };
}

function context(port: number, url: Struct, overrides: Partial<JsonApiRequestContext> = {}): JsonApiRequestContext {
  return {
    siteId: 'default',
    mode: 'json',
    endpoint: jsonApiEndpoint({
      adminSSL: false,
      requestProtocol: 'http',
      serverName: 'localhost',
      serverPort: `:${port}`,
      context: '',
      mode: 'json',
      siteId: 'default',
    }),
    url,
    form: {},
    method: 'findOne',
    isAggregateQuery: false,
    user: { loggedIn: false, systemUser: false },
    allowAction: () => true,
    site: site(port),
    customImageSizes: [],
    ...overrides,
  };
}

const ADMIN = { user: { loggedIn: true, systemUser: true } };

function entityView(
  entity: ContentEntityName,
  allValues: Struct,
  overrides: Partial<ApiEntityView> = {},
): ApiEntityView {
  const config = CONTENT_ENTITIES[entity];
  return {
    entityName: entity === 'contentnav' ? 'content' : entity,
    configName: entity,
    primaryKey: config.primaryKey,
    allValues,
    hasMany: config.hasMany,
    hasOne: config.hasOne,
    ...overrides,
  };
}

/** A content bean view whose getAssocURL value is its complete URL, as for a Page. */
function contentView(row: Struct, port: number, overrides: Partial<ApiEntityView> = {}): ApiEntityView {
  const assocurl = contentUrl(site(port), { filename: typeof row['filename'] === 'string' ? row['filename'] : '' }, { complete: true });
  return entityView('content', row, { values: { assocurl }, ...overrides });
}

function wire(method: string, data: unknown, entity = 'content'): unknown {
  const { body } = serializeResponse(buildEnvelope({ method, data }), { serializer: contentApiSerializer(entity) });
  return JSON.parse(body) as unknown;
}

function normalise(v: unknown): unknown {
  if (typeof v === 'string' && v.includes('/?&')) {
    const [head, query = ''] = v.split('?');
    return `${head}?${query.split('&').filter(Boolean).sort().join('&')}`;
  }
  if (Array.isArray(v)) return v.map(normalise);
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalise(x)]));
  return v;
}

function expectRecorded(actual: unknown, recorded: Recorded | undefined): void {
  expect(recorded).toBeDefined();
  expect(normalise(actual)).toEqual(normalise({ apiversion: 'v1', ...recorded }));
}

function resolver(overrides: Partial<ExpansionResolver> = {}): ExpansionResolver {
  return {
    hasMany: vi.fn(() => Promise.reject(new Error('unexpected hasMany'))),
    hasOne: vi.fn(() => Promise.reject(new Error('unexpected hasOne'))),
    crumbs: vi.fn(() => Promise.reject(new Error('unexpected crumbs'))),
    relatedContent: vi.fn(() => Promise.reject(new Error('unexpected relatedContent'))),
    ...overrides,
  };
}

const page = (recordCount: number, maxRecordsPerPage: number, entityName = 'content', pageIndex?: number) =>
  iteratorPage({ recordCount, maxRecordsPerPage, entityName, pageIndex });

describe('recorded GS-CO-05 content reads', () => {
  const home = () => contentView(FX.rows.home, ORACLE, { editUrl: HOME_EDIT_URL });
  const findOne = { pk: 'contentid', editableCheck: true };

  it('findOne serializes the default content field list', async () => {
    const ctx = context(ORACLE, { id: HOME, siteid: 'default', entityname: 'content' });
    const data = await serializeContentEntity(home(), ctx, resolver(), findOne);
    expectRecorded(wire('findOne', data), FX.oracle['home']);
    expect(urlParam(ctx, 'EXPANDDEPTH')).toBe(1);
  });

  it('findOne with fields=title,links,images,url adds contentid, siteid and isnew and an edit link for a system user', async () => {
    const ctx = context(ORACLE, { fields: 'title,links,images,url', id: HOME, siteid: 'default', entityname: 'content' }, ADMIN);
    const data = await serializeContentEntity(home(), ctx, resolver(), findOne);
    expectRecorded(wire('findOne', data), FX.oracle['homeAdminFields']);
  });

  it('findOne with fields=* copies every value', async () => {
    const ctx = context(ORACLE, { fields: '*', id: HOME, siteid: 'default', entityname: 'content' }, ADMIN);
    const data = await serializeContentEntity(home(), ctx, resolver(), findOne);
    expectRecorded(wire('findOne', data), FX.oracle['homeAdminStar']);
  });

  it('findOne with expand=crumbs&fields=title adds links and path and expands the crumbs', async () => {
    const ctx = context(ORACLE, { fields: 'title', expand: 'crumbs', id: HOME, siteid: 'default', entityname: 'content' });
    const crumbs = vi.fn(() => Promise.resolve({ items: [home()], page: page(1, 1) }));
    const data = await serializeContentEntity(home(), ctx, resolver({ crumbs }), { ...findOne, expandLinks: 'crumbs' });
    expectRecorded(wire('findOne', data), FX.oracle['oneCrumbs']);
    expect(crumbs).toHaveBeenCalledOnce();
  });

  it('findOne with expand=kids,parent resolves the relations with legacy expansion params', async () => {
    const ctx = context(ORACLE, { fields: 'title', expand: 'kids,parent', id: HOME, siteid: 'default', entityname: 'content' });
    const newParent = contentView({ contentid: '15465ECE-C897-567A-5F75A3A9E96C6704', siteid: 'default', title: '', isnew: 1 }, ORACLE);
    const relations = resolver({
      hasMany: vi.fn<ExpansionResolver['hasMany']>((_prop, _params, opts) =>
        Promise.resolve(
          serializeCollection([], page(0, 20), ctx, { method: 'findQuery', expanded: opts.expanded, baseUrl: `${ctx.endpoint}/content/?parentid=${HOME}` }),
        ),
      ),
      hasOne: vi.fn<ExpansionResolver['hasOne']>((_prop, _id, opts) =>
        serializeContentEntity(newParent, ctx, relations, { ...findOne, expanded: opts.expanded, expandLinks: opts.expand }),
      ),
    });
    const data = await serializeContentEntity(home(), ctx, relations, { ...findOne, expandLinks: 'kids,parent' });
    expectRecorded(wire('findOne', data), FX.oracle['kids']);
    expect(relations.hasMany).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'kids' }),
      { parentid: HOME, sortBy: 'orderno', sortDirection: 'asc' },
      { expand: 'kids,parent', expanded: 1 },
    );
    expect(relations.hasOne).toHaveBeenCalledWith(expect.objectContaining({ name: 'parent' }), '00000000000000000000000000000000END', {
      expand: 'kids,parent',
      expanded: 1,
    });
  });

  it('findOne with expand=kids serializes the kids collection under the contentnav fields', async () => {
    const ctx = context(OWN, { expand: 'kids', id: ALPHA, siteid: 'default', entityname: 'content' });
    const kids = vi.fn<ExpansionResolver['hasMany']>((_prop, _params, opts) =>
      serializeEntityList([contentView(FX.rows.beta, OWN)], ctx, { entityName: 'content', ...opts }).then((items) =>
        serializeCollection(items, page(1, 20), ctx, { method: 'findQuery', expanded: opts.expanded, baseUrl: `${ctx.endpoint}/content/?parentid=${ALPHA}` }),
      ),
    );
    const data = await serializeContentEntity(contentView(FX.rows.alpha, OWN), ctx, resolver({ hasMany: kids }), {
      ...findOne,
      expandLinks: 'kids',
    });
    expectRecorded(wire('findOne', data), FX.own['alphaKids']);
  });

  it('a crumb expansion over three levels uses the caller field list without links', async () => {
    const ctx = context(OWN, { expand: 'crumbs', fields: 'title', id: BETA, siteid: 'default', entityname: 'content' });
    const trail = [FX.rows.beta, FX.rows.alpha, { ...FX.rows.home }].map((row) => contentView(row, OWN));
    const crumbs = vi.fn(() => Promise.resolve({ items: trail, page: page(3, 3) }));
    const data = await serializeContentEntity(contentView(FX.rows.beta, OWN), ctx, resolver({ crumbs }), {
      ...findOne,
      expandLinks: 'crumbs',
    });
    expectRecorded(wire('findOne', data), FX.own['betaCrumbs']);
  });

  it('findCrumbArray packages the crumb iterator with the default base URL', async () => {
    const ctx = context(ORACLE, { id: HOME, siteid: 'default', entityname: 'content' }, { method: 'findCrumbArray' });
    const data = await serializeCrumbs({ items: [home()], page: page(1, 1) }, ctx, { entityName: 'contentnav' });
    expectRecorded(wire('findCrumbArray', data), FX.oracle['crumbsRoute']);
  });

  it('findVersionHistory appends ?contenthistid= to each version self link', async () => {
    const ctx = context(ORACLE, { id: HOME, entityname: 'content' }, { ...ADMIN, method: 'findVersionHistory' });
    const data = await serializeVersionHistory({ items: [home()], page: page(1, 1) }, ctx);
    expectRecorded(wire('findVersionHistory', data), FX.oracle['history']);
  });

  it('findAll of an empty iterator lower-cases its method in the default base URL', () => {
    const ctx = context(ORACLE, { siteid: 'default', entityname: 'content' }, { method: 'findAll' });
    expectRecorded(wire('findAll', serializeCollection([], page(0, 20), ctx)), FX.oracle['findAll']);
  });

  it('findQuery on the second page links first, previous and last', async () => {
    const ctx = context(OWN, { type: 'Page', itemsPerPage: '1', pageIndex: '2', entityname: 'content' }, { method: 'findQuery' });
    const items = await serializeEntityList([contentView(FX.rows.alpha, OWN)], ctx, { entityName: 'content' });
    const data = serializeCollection(items, page(2, 1, 'content', 2), ctx, { baseUrl: `${ctx.endpoint}/content/?type=Page&itemsPerPage=1` });
    expectRecorded(wire('findQuery', data), FX.own['queryPage2']);
  });

  it('contentnav findQuery items report entityname content', async () => {
    const ctx = context(OWN, { parentid: ALPHA, entityname: 'contentnav' }, { method: 'findQuery' });
    const items = await serializeEntityList([contentView(FX.rows.beta, OWN, { configName: 'contentnav' })], ctx, { entityName: 'content' });
    const data = serializeCollection(items, page(1, 20), ctx, { baseUrl: `${ctx.endpoint}/content/?parentid=${ALPHA}` });
    expectRecorded(wire('findQuery', data), FX.own['navQuery']);
  });

  it('findRelatedContent packages every set without links', async () => {
    const ctx = context(ORACLE, { id: HOME, siteid: 'default', entityname: 'content' }, { method: 'findRelatedContent' });
    const data = await serializeRelatedContent(
      {
        kind: 'sets',
        sets: [{ name: 'Default', entityType: 'content', relatedContentSetId: '00000000000000000000000000000000000', items: [], page: page(0, 0) }],
      },
      ctx,
    );
    expectRecorded(wire('findRelatedContent', data), FX.oracle['related']);
  });
});

describe('recorded GS-CO-11 comment entity', () => {
  it('findQuery serializes comments under the field list allowQueryParams writes into url.fields', async () => {
    const ctx = context(OWN, { contentid: BETA, fields: COMMENT_PUBLIC_FIELDS, isspam: 0, isdeleted: 0, entityname: 'comment' }, { method: 'findQuery' });
    const comment = entityView('comment', FX.rows.comment, { primaryKey: 'commentID' });
    const items = await serializeEntityList([comment], ctx, { entityName: 'comment' });
    const data = serializeCollection(items, page(1, 1000, 'comment'), ctx, { baseUrl: `${ctx.endpoint}/comment/?contentid=${BETA}` });
    expectRecorded(wire('findQuery', data, 'comment'), FX.own['commentQuery']);
  });
});

describe('selectFields', () => {
  const content = () => contentView(FX.rows.home, ORACLE);

  it.each([
    ['title', '', ['title', 'contentid', 'siteid', 'isnew']],
    ['title', 'crumbs', ['title', 'contentid', 'siteid', 'links', 'path', 'isnew']],
    ['title', 'ALL', ['title', 'contentid', 'siteid', 'links', 'path', 'isnew']],
    ['title,CONTENTID,SiteID,isNew', 'kids', ['title', 'CONTENTID', 'SiteID', 'isNew']],
  ])('fields=%s with expand=%j', (fields, expandLinks, expected) => {
    const ctx = context(ORACLE, { fields });
    expect(selectFields(content(), ctx, { expandLinks })).toEqual({ fields: expected, allFields: false });
  });

  it('appends the bean primary key for other entities, and nothing for an aggregate query', () => {
    const comment = entityView('comment', {}, { primaryKey: 'commentID' });
    expect(selectFields(comment, context(OWN, { fields: 'name' })).fields).toEqual(['name', 'commentID', 'siteid', 'isnew']);
    expect(selectFields(comment, context(OWN, { fields: 'name' }, { isAggregateQuery: true }), { expanded: 2 }).fields).toEqual([
      'name',
      'isnew',
    ]);
    const assign = entityView('contentCategoryAssign', {});
    expect(selectFields(assign, context(OWN, { fields: 'categoryid' })).fields).toEqual(['categoryid', 'siteid', 'isnew']);
  });

  it('applies url.fields to expanded items only when url.entityname names the entity', () => {
    const matching = context(ORACLE, { fields: 'title', entityname: 'Content' });
    expect(selectFields(content(), matching, { expanded: 1 }).fields).toEqual(['title', 'contentid', 'siteid', 'isnew']);
    expect(selectFields(content(), matching, { expanded: true, expandedProp: 'crumbs' }).fields).toEqual(
      CONTENT_ENTITIES.content.fields,
    );
    const other = context(ORACLE, { fields: 'title', entityname: 'comment' });
    expect(selectFields(content(), other, { expanded: 1 }).fields).toEqual(CONTENT_ENTITIES.content.fields);
  });

  it('falls back to every value without a config field list and matches * and all case-sensitively', () => {
    const category = entityView('category', {});
    expect(selectFields(category, context(OWN, {}))).toEqual({ fields: [], allFields: true });
    expect(selectFields(content(), context(OWN, { fields: 'all' })).allFields).toBe(true);
    expect(selectFields(content(), context(OWN, { fields: 'ALL' })).allFields).toBe(false);
  });
});

describe('serializeContentEntity values', () => {
  const row = { contentid: HOME, siteid: 'default', title: 'Home', isnew: 0, filename: '', type: 'Page' };

  it('fields=* strips bean bookkeeping and secrets case-insensitively', async () => {
    const view = contentView(
      {
        ...row,
        AddObjects: [],
        removeObjects: [],
        sourceIterator: {},
        frommuracache: false,
        Errors: {},
        instanceid: 'x',
        primarykey: 'contentid',
        extenddatatable: 'tclassextenddata',
        extendData: {},
        extendautocomplete: true,
        saveerrors: false,
        PASSWORD: 'hash',
        body: 'kept',
      },
      ORACLE,
    );
    const data = await serializeContentEntity(view, context(ORACLE, { fields: '*' }));
    expect(Object.keys(data).sort()).toEqual(
      ['body', 'contentid', 'entityname', 'filename', 'images', 'isnew', 'links', 'siteid', 'title', 'type', 'url'].sort(),
    );
  });

  it('merges extended data, strips display-interval bookkeeping, reads dotted fields by their last segment and drops password', async () => {
    const view = contentView({ ...row, password: 'hash' }, ORACLE, {
      extendSetData: { color: 'red', Title: 'Extended' },
      displayInterval: { every: 1, isNew: 1, errors: {}, primaryKey: 'x', type: 'daily' },
      values: { menutitle: 'From getter' },
    });
    const data = await serializeContentEntity(view, context(ORACLE, { fields: 'title,extendeddata,displayInterval,a.menutitle,password' }));
    expect(data).toEqual({
      title: 'Extended',
      color: 'red',
      displayInterval: { every: 1, type: 'daily' },
      'a.menutitle': 'From getter',
      contentid: HOME,
      siteid: 'default',
      isnew: 0,
      entityname: 'content',
    });
  });

  it('fails as legacy does for a display interval the bean lacks and for url.id without an id', async () => {
    const comment = entityView('comment', { commentid: 'C' });
    await expect(serializeContentEntity(comment, context(OWN, { fields: 'displayInterval' }))).rejects.toThrow(TypeError);
    const assign = entityView('contentCategoryAssign', { categoryid: 'K' });
    await expect(serializeContentEntity(assign, context(OWN, { id: 'K' }))).rejects.toThrow('Element ID is undefined in VALS.');
  });

  it('marks links editable when url.id equals the id, and asks allowAction only then', async () => {
    const allowAction = vi.fn(() => Promise.resolve(true));
    const view = contentView(row, ORACLE, { editUrl: '/admin/?muraAction=cArch.edit' });
    const same = context(ORACLE, { id: HOME }, { ...ADMIN, allowAction });
    const editable = await serializeContentEntity(view, same, undefined, { pk: 'contentid' });
    expect((editable['links'] as Struct)['edit']).toBe('/admin/?muraAction=cArch.edit');
    const other = context(ORACLE, { id: ALPHA }, { ...ADMIN, allowAction });
    const plain = await serializeContentEntity(view, other, undefined, { pk: 'contentid' });
    expect((plain['links'] as Struct)['edit']).toBeUndefined();
    expect(allowAction).toHaveBeenCalledOnce();
  });

  it('expanddepth limits recursion and a non-numeric value is replaced by 1', async () => {
    const parentOf = (ctx: JsonApiRequestContext): ExpansionResolver => {
      const relations: ExpansionResolver = resolver({
        hasOne: vi.fn<ExpansionResolver['hasOne']>((_prop, _id, opts) =>
          serializeContentEntity(contentView(row, ORACLE), ctx, relations, { pk: 'contentid', expandLinks: opts.expand, expanded: opts.expanded }),
        ),
      });
      return relations;
    };
    const deep = context(ORACLE, { fields: 'title', expanddepth: '2', entityname: 'content' });
    const deepResolver = parentOf(deep);
    const data = await serializeContentEntity(contentView(row, ORACLE), deep, deepResolver, { pk: 'contentid', expandLinks: 'parent' });
    expect(deepResolver.hasOne).toHaveBeenCalledTimes(2);
    expect(((data['parent'] as Struct)['parent'] as Struct)['title']).toBe('Home');

    const invalid = context(ORACLE, { fields: 'title', EXPANDDEPTH: 'deep', entityname: 'content' });
    const shallow = parentOf(invalid);
    await serializeContentEntity(contentView(row, ORACLE), invalid, shallow, { pk: 'contentid', expandLinks: 'parent' });
    expect(shallow.hasOne).toHaveBeenCalledOnce();
    expect(invalid.url).toEqual({ fields: 'title', EXPANDDEPTH: 1, entityname: 'content' });
  });

  it('restarts the depth at 0 for an aggregate query and requires a resolver for a requested relation', async () => {
    const relations = resolver({ hasMany: vi.fn(() => Promise.resolve('kids')) });
    await serializeContentEntity(contentView(row, ORACLE), context(ORACLE, { expanddepth: '2' }), relations, { expanded: 3, expandLinks: 'kids' });
    expect(relations.hasMany).not.toHaveBeenCalled();
    const aggregate = context(ORACLE, { expanddepth: '2' }, { isAggregateQuery: true });
    await serializeContentEntity(contentView(row, ORACLE), aggregate, relations, { expanded: 3, expandLinks: 'kids' });
    expect(relations.hasMany).toHaveBeenCalledWith(expect.objectContaining({ name: 'kids' }), expect.anything(), { expand: 'kids', expanded: 1 });
    await expect(serializeContentEntity(contentView(row, ORACLE), context(ORACLE, {}), undefined, { expandLinks: 'kids' })).rejects.toThrow(
      'needs an expansion resolver',
    );
    const unmatched = await serializeContentEntity(contentView(row, ORACLE), context(ORACLE, {}), undefined, { expandLinks: 'nothing' });
    expect(unmatched['nothing']).toBeUndefined();
  });

  it('expand=all passes URL params to content relations, a fresh id for a missing column, and related content', async () => {
    const ctx = context(ORACLE, {
      fields: 'title',
      showexcludesearch: '1',
      INCLUDEHOMEPAGE: '1',
      shownavonly: '0',
      maxItems: '5',
      cachedwithin: '0',
      itemsperpage: '3',
    });
    const view = contentView({ contentid: HOME, siteid: 'default', title: 'Home', sortBy: 'title', sortDirection: 'desc', path: HOME }, ORACLE);
    const related = vi.fn(() =>
      Promise.resolve([{ name: 'Set', entityType: 'content', relatedContentSetId: 'S', items: [contentView(row, ORACLE)], page: page(1, 1) }]),
    );
    const relations = resolver({
      hasMany: vi.fn(() => Promise.resolve('many')),
      hasOne: vi.fn(() => Promise.resolve('one')),
      crumbs: vi.fn(() => Promise.resolve({ items: [], page: page(0, 0) })),
      relatedContent: related,
    });
    const data = await serializeContentEntity(view, ctx, relations, { pk: 'contentid', expandLinks: '*' });
    expect(relations.hasMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: 'kids' }),
      {
        parentid: HOME,
        showexcludesearch: '1',
        includeHomePage: '1',
        shownavonly: '0',
        sortBy: 'title',
        sortDirection: 'desc',
        maxitems: '5',
        cachedWithin: '0',
        itemsPerPage: '3',
      },
      { expand: '*', expanded: 1 },
    );
    const commentParams = vi.mocked(relations.hasMany).mock.calls[2]?.[1];
    expect(commentParams).toEqual({ contentid: HOME, maxitems: '5', cachedWithin: '0', itemsPerPage: '3' });
    expect(relations.hasOne).toHaveBeenCalledTimes(4);
    expect(data['crumbs']).toMatchObject({ totalItems: 0, items: [] });
    const relatedSets = data['relatedcontent'] as Struct;
    expect(relatedSets).toMatchObject({ totalItems: 1, entityname: 'relatedcontentset' });
    expect((relatedSets['items'] as Struct[])[0]).toMatchObject({ name: 'Set', relatedcontentsetid: 'S', siteid: 'default' });

    const missing = contentView({ siteid: 'default', title: 'x' }, ORACLE, { values: {} });
    await serializeContentEntity({ ...missing, hasOne: [] }, context(ORACLE, {}), relations, { expandLinks: 'comments' });
    expect(vi.mocked(relations.hasMany).mock.calls.at(-1)?.[1]).toEqual({ contentid: expect.stringMatching(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/) as string });
  });

  it('skips crumbs when the links lack a crumbs link', async () => {
    const relations = resolver();
    const view = contentView({ ...row, type: 'Variation', path: HOME }, ORACLE);
    const data = await serializeContentEntity(view, context(ORACLE, {}), relations, { expandLinks: 'crumbs' });
    expect(data['crumbs']).toBeUndefined();
    expect(relations.crumbs).not.toHaveBeenCalled();
  });
});

describe('contentEntityLinks', () => {
  const ctx = () => context(OWN, {}, ADMIN);
  const base = `http://localhost:${OWN}/index.cfm/_api/json/v1/default`;

  it('a Variation links self to its rendered path and has no crumbs', async () => {
    const view = contentView({ contentid: 'V', filename: 'v-path', type: 'Variation', parentid: '', changesetid: '', siteid: 'default' }, OWN);
    const links = await contentEntityLinks(view, ctx());
    expect(links['self']).toBe(`${base}/content/_path/v-path`);
    expect(links['crumbs']).toBeUndefined();
    expect(links['parent']).toBeUndefined();
    expect(links['site']).toBe(`${base}/site`);
  });

  it('categories link crumbs and self by categoryid', async () => {
    const view = entityView('category', { categoryid: 'K1', parentid: 'K0', siteid: 'default' });
    expect(await contentEntityLinks(view, ctx())).toEqual({
      entities: base,
      all: `${base}/category`,
      properties: `${base}/category/properties`,
      crumbs: `${base}/category/K1/crumbs`,
      self: `${base}/category/K1`,
      permissions: `${base}/category/K1/permissions`,
      kids: `${base}/category?parentid=K1`,
      contentAssignments: `${base}/contentCategoryAssign?categoryid=K1`,
      parent: `${base}/category/K0`,
      site: `${base}/site`,
    });
  });

  it('a feed bean reports the content proxy name, so it links as content without a feed link', async () => {
    const view = entityView('feed', { feedid: 'F1', siteid: 'default' }, { entityName: 'content', primaryKey: 'feedID' });
    const links = await contentEntityLinks(view, ctx());
    expect(links['self']).toBe(`${base}/content/`);
    expect(links['feed']).toBeUndefined();
    const contentFeed = entityView('feed', { feedid: 'F1' }, { entityName: 'contentFeed', primaryKey: 'feedID', hasOne: [] });
    expect((await contentEntityLinks(contentFeed, ctx()))['feed']).toBe(`${base}/content/?feedid=F1`);
  });

  it('site, bean and key-less entities', async () => {
    const siteView = entityView('stats', { siteid: 'default' }, { entityName: 'site', primaryKey: 'siteid', hasMany: [], hasOne: [] });
    expect((await contentEntityLinks(siteView, ctx()))['self']).toBe(`${base}/site`);
    const bean = entityView('stats', {}, { entityName: 'bean' });
    expect(await contentEntityLinks(bean, ctx())).toEqual({ entities: base });
    const assign = entityView('contentCategoryAssign', { contenthistid: 'H1', contentid: 'C1', categoryid: 'K1', siteid: 'default' });
    const links = await contentEntityLinks(assign, ctx());
    expect(links['permissions']).toBeUndefined();
    expect(links['content']).toBe(`${base}/content/?contenthistid=H1`);
    expect(links['activeContent']).toBe(`${base}/content/C1`);
    expect(links['parent']).toBeUndefined();
  });

  it.each([
    ['not editable', false, ADMIN.user, true, '/edit'],
    ['anonymous', true, { loggedIn: false, systemUser: false }, true, '/edit'],
    ['not a system user', true, { loggedIn: true, systemUser: false }, true, '/edit'],
    ['action refused', true, ADMIN.user, false, '/edit'],
    ['no edit URL', true, ADMIN.user, true, ''],
  ])('omits the edit link when %s', async (_case, editable, user, allowed, editUrl) => {
    const view = contentView({ contentid: HOME, siteid: 'default' }, OWN, { editUrl });
    const links = await contentEntityLinks(view, context(OWN, {}, { user, allowAction: () => allowed }), editable);
    expect(links['edit']).toBeUndefined();
  });
});

describe('contentImages', () => {
  const imageSite = (overrides: Partial<LegacySiteUrlConfig> = {}) => site(OWN, overrides);

  it('lists the renditions and custom sizes of an image file', () => {
    const view = contentView({}, OWN, { fileId: 'F1', fileExt: 'jpg', type: 'Page' });
    const ctx = context(OWN, {}, { customImageSizes: [{ name: 'Hero' }], site: imageSite({ useSSL: true }) });
    const cache = `https://localhost:${OWN}/sites/default/cache/file`;
    expect(contentImages(view, ctx)).toEqual({
      small: `${cache}/F1_small.jpg`,
      medium: `${cache}/F1_medium.jpg`,
      large: `${cache}/F1.jpg`,
      source: `${cache}/F1_source.jpg`,
      Hero: `${cache}/F1_hero.jpg`,
    });
  });

  it('uses the render route without direct images, the placeholder for non-image files, and {} without an image', () => {
    const ctx = context(OWN, {}, { site: imageSite({ directImages: false, placeholderImgId: 'P1', placeholderImgExt: 'png' }) });
    const file = contentView({ fileid: 'F2', fileext: 'pdf', type: 'File' }, OWN);
    expect(contentImages(file, ctx)['small']).toBe(`http://localhost:${OWN}/index.cfm/_api/render/small/?fileID=P1&fileEXT=png`);
    expect(contentImages(contentView({}, OWN), context(OWN, {}))).toEqual({});
  });

  it('images and url follow the bean site over the request site', async () => {
    const view = contentView({ contentid: 'C', siteid: 'other', filename: 'page', fileid: 'F', fileext: 'png' }, OWN, {
      site: site(OWN, { siteId: 'other', domain: 'other.test', requestDomain: 'other.test', serverPort: '', filePoolId: 'other' }),
    });
    const data = await serializeContentEntity(view, context(OWN, { fields: 'images,url' }));
    expect(data['url']).toBe('http://other.test/page/');
    expect((data['images'] as Struct)['large']).toBe('http://other.test/sites/other/cache/file/F.png');
  });
});

describe('serializeCollection', () => {
  const base = `http://localhost:${OWN}/index.cfm/_api/json/v1/default`;

  it('links first, previous, last and next and wraps next past the last page', () => {
    const ctx = context(OWN, {}, { method: 'findQuery' });
    const middle = serializeCollection(['b'], page(3, 1, 'content', 2), ctx, { baseUrl: `${base}/content/?` });
    expect(middle).toMatchObject({ totalItems: 3, totalPages: 3, pageIndex: 2, startindex: 2, endindex: 2, itemsperpage: 1, entityname: 'content' });
    expect(middle['links']).toEqual({
      self: `${base}/content/?&pageIndex=2`,
      entities: base,
      properties: `${base}/content/properties`,
      permissions: `${base}/content/permissions`,
      first: `${base}/content/?&pageIndex=1`,
      previous: `${base}/content/?&pageIndex=1`,
      last: `${base}/content/?&pageIndex=3`,
      next: `${base}/content/?&pageIndex=3`,
    });
  });

  it('builds the default base URL from url then form, without pageIndex, with the method rules', () => {
    const ctx = context(OWN, { PageIndex: '1', Method: 'undefined', a: '1' }, { form: { a: '2', b: 'x/y' }, method: 'findMany' });
    expect((serializeCollection([], page(0, 5), ctx)['links'] as Struct)['self']).toBe(`${base}/?&method=findmany&a=2&b=x/y&pageIndex=0`);
    const kept = context(OWN, { method: 'findQuery' }, { method: 'findMany' });
    expect((serializeCollection([], page(0, 5), kept)['links'] as Struct)['self']).toBe(`${base}/?&method=findQuery&pageIndex=0`);
    const dotted = context(OWN, { method: 'findQuery' });
    expect((serializeCollection([], page(0, 5), dotted, { method: 'content.findAll', baseUrl: '' })['links'] as Struct)['self']).toBe(
      `${base}/?&method=content.findAll&pageIndex=0`,
    );
  });

  it('renders booleans in URLs and refuses complex values as CFML does', async () => {
    const flagged = context(OWN, { flag: true }, { method: 'findAll' });
    expect((serializeCollection([], page(0, 5), flagged)['links'] as Struct)['self']).toBe(`${base}/?&flag=true&method=findall&pageIndex=0`);
    const complex = contentView({ contentid: { nested: true } }, OWN);
    await expect(contentEntityLinks(complex, context(OWN, {}))).rejects.toThrow('Complex object types');
  });

  it('reports aggregate collections as bean, omits bean entity links and refuses an expanded call without a base URL', () => {
    const aggregate = serializeCollection([{}], page(1, 1, 'content'), context(OWN, {}, { isAggregateQuery: true }), { baseUrl: 'u?' });
    expect(aggregate['entityname']).toBe('bean');
    expect(aggregate['links']).toHaveProperty('properties');
    const bean = serializeCollection([], page(0, 0, 'bean'), context(OWN, {}), { baseUrl: 'u?' });
    expect(bean['links']).toEqual({ self: 'u?&pageIndex=0', entities: base });
    expect(() => serializeCollection([], page(0, 0), context(OWN, {}), { expanded: 1 })).toThrow('BASEURL');
  });
});

describe('iterator serializers', () => {
  it('iteratorPage follows queryIterator paging', () => {
    expect(page(25, 10, 'content', 3)).toEqual({ recordCount: 25, pageCount: 3, pageIndex: 3, firstOnPage: 21, lastOnPage: 25, nextN: 10, entityName: 'content' });
    expect(page(5, 10, 'content', 4).pageIndex).toBe(1);
    expect(page(0, 0)).toMatchObject({ pageCount: 0, firstOnPage: 1, lastOnPage: 0 });
  });

  it('serializeEntityList uses the iterator entity for the config and primary key', async () => {
    const ctx = context(OWN, { fields: 'name' });
    const feed = entityView('feed', { feedid: 'F1', name: 'Feed', siteid: 'default' }, { entityName: 'content', primaryKey: 'feedID' });
    const [feedItem] = await serializeEntityList([feed], ctx, { entityName: 'feed' });
    expect(feedItem).toMatchObject({ id: 'F1', entityname: 'feed', name: 'Feed' });
    const [stats] = await serializeEntityList([entityView('stats', { contentid: 'C', siteid: 'default', views: 3 })], context(OWN, {}), { entityName: 'stats' });
    expect(stats).toMatchObject({ id: 'C', entityname: 'stats', views: 3 });
    const [unknown] = await serializeEntityList([entityView('stats', { a: 1 }, { configName: 'x' })], context(OWN, {}), { entityName: 'plugin' });
    expect(unknown).not.toHaveProperty('id');
  });

  it('serializeCrumbs keys comments by their own primary key', async () => {
    const comment = entityView('comment', { commentid: 'C1', siteid: 'default' }, { primaryKey: 'commentID' });
    const data = await serializeCrumbs({ items: [comment], page: page(1, 1, 'comment') }, context(OWN, { fields: 'name' }), { entityName: 'comment' });
    expect((data['items'] as Struct[])[0]).toMatchObject({ id: 'C1', entityname: 'comment' });
  });

  it('serializeVersionHistory fails as legacy does when a field list drops links', async () => {
    const ctx = context(OWN, { fields: 'title' });
    await expect(serializeVersionHistory({ items: [contentView({ contentid: 'C' }, OWN)], page: page(1, 1) }, ctx)).rejects.toThrow('LINKS.SELF');
  });

  it('serializeRelatedContent names a single set by its id', async () => {
    const data = await serializeRelatedContent(
      { kind: 'set', relatedContentSetId: 'SET-1', items: [contentView({ contentid: 'C', siteid: 'default' }, OWN)], page: page(1, 10) },
      context(OWN, { fields: 'title' }),
    );
    expect(data).toMatchObject({ name: 'SET-1', totalItems: 1, entityname: 'content' });
    expect(data).not.toHaveProperty('links');
  });
});

describe('request helpers', () => {
  it('jsonApiEndpoint always carries index.cfm and the request mode', () => {
    const endpoint = { requestProtocol: 'http', serverName: 'cms.test', serverPort: ':8443', context: '/ctx', siteId: 'tenant-a' };
    expect(jsonApiEndpoint({ ...endpoint, adminSSL: true, mode: 'rest' })).toBe('https://cms.test:8443/ctx/index.cfm/_api/rest/v1/tenant-a');
    expect(jsonApiEndpoint({ ...endpoint, adminSSL: false, mode: 'ajax' })).toBe('http://cms.test:8443/ctx/index.cfm/_api/ajax/v1/tenant-a');
  });

  it('paramUrl sets only an absent key, matched ignoring case', () => {
    const ctx = context(OWN, { EntityName: 'content' });
    paramUrl(ctx, 'entityname', 'comment');
    paramUrl(ctx, 'expanddepth', 1);
    expect(ctx.url).toEqual({ EntityName: 'content', expanddepth: 1 });
    expect(urlParam(ctx, 'ENTITYNAME')).toBe('content');
  });

  it('contentApiSerializer applies the content entity hints, and only the API hints elsewhere', () => {
    const value = { isapproved: '1', isnew: '1', title: 2 };
    expect(contentApiSerializer('comment').serialize(value)).toBe('{"isapproved":1,"isnew":1,"title":"2"}');
    expect(contentApiSerializer('site').serialize(value)).toBe('{"isapproved":"1","isnew":1,"title":"2"}');
  });
});
