// Unit tests for the Local branch of `cfeed/edit.cfm`: the collection edit form and its instance variant.
import * as cheerio from 'cheerio';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { toString, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import type { ScreenContext } from '@/screens/registry';
import { applyCfeedDefaults } from '@/screens/cfeed/before';
import { feedEditModelFrom } from '@/screens/cfeed/edit-model';
import { renderFeedEditLocal, type FeedEditBranchView } from '@/screens/cfeed/edit-local';
import { cfeedAjaxScripts } from '@/screens/cfeed/js';
import { loadShellData, renderAdminDocument, serializeAdminDocument } from '@/shell/document';
import { makeAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel, type DomControl } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type RecordedRequest } from '../../helpers/fake-gateway';
import type { WebTestSubjectKey } from '../../helpers/tokens';

const FEED_ID = 'F1000000-0000-0000-0000000000000001';
const CONTENT_ID = 'C1000000-0000-0000-0000000000000001';
const CATEGORY_ID = 'K1000000-0000-0000-0000000000000001';
const GROUP_MEMBERS = 'G1000000-0000-0000-0000000000000001';
const GROUP_EDITORS = 'G2000000-0000-0000-0000000000000002';
const ENDPOINT = 'http://localhost/_api/feed/v1/default';
const ZOOM = '<ul class="navZoom"><li>Home &raquo; News</li></ul>';

const CSRF = { token: 'TESTCSRFTOKEN0000000000000000000', expires: '260630150000000' } as const;

type Row = Record<string, unknown>;

/** A new feed bean's `getAllValues()`, as feedBean `init()` leaves it. */
const NEW_BEAN: Row = {
  feedID: FEED_ID,
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
  type: 'Local',
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
  displayList: 'Date,Title,Image,Summary,Credits',
  viewalllink: '',
  viewalllabel: '',
  autoimport: 0,
  isLocked: 0,
  cssClass: '',
  useCategoryIntersect: 0,
  contentpoolid: '',
};

/** One active content attribute of the site. */
const ATTRIBUTE: Row = { attributeID: 'A1', type: 'Page', subType: 'Default', attribute: 'teaser', isActive: 1 };

/** A saved collection with section filters, advanced filters, categories, usage and restrict groups. */
const SAVED_BEAN: Row = {
  ...NEW_BEAN,
  isNew: 0,
  name: 'News "Top" <Feed>',
  description: 'Latest & greatest',
  sortBy: 'comments',
  categoryID: CATEGORY_ID,
  restricted: 1,
  restrictGroups: GROUP_MEMBERS,
  params: [
    { relationship: 'and', field: 'tcontent.title', dataType: 'varchar', condition: 'Contains', criteria: 'Masa' },
    { relationship: 'or', field: 'A1', dataType: 'varchar', condition: 'GT', criteria: '5' },
    { relationship: 'or', field: 'tcontent.body', dataType: 'varchar', condition: 'LT', criteria: '' },
  ],
};

const SAVED_RC: Row = {
  feedBean: SAVED_BEAN,
  rslist: [{ contentID: CONTENT_ID, type: 'Folder', siteid: 'default', zoom: ZOOM }],
  rsRestrictGroups: [
    { groupname: 'Members', userid: GROUP_MEMBERS, isPublic: 1 },
    { groupname: 'Editors', userid: GROUP_EDITORS, isPublic: 0 },
  ],
  rsExtendedAttributes: [ATTRIBUTE],
  hasCategories: 1,
  categories: [{ categoryID: CATEGORY_ID, parentID: null, name: 'Topics', isOpen: 1, permitted: true }],
  rsUsage: [
    {
      contentHistID: 'H1000000-0000-0000-0000000000000001',
      contentID: CONTENT_ID,
      type: 'Page',
      parentID: '00000000000000000000000000000000001',
      siteID: 'default',
      moduleID: '00000000000000000000000000000000000',
      display: 1,
      approved: 1,
      displayStart: null,
      displayStop: null,
      lastUpdate: '2026-01-15 09:30:00',
      zoom: ZOOM,
      verdict: 'editor',
    },
  ],
  imageSizes: [{ name: 'Hero' }],
  endpoint: ENDPOINT,
};

/** A screen model `rc` for a new collection; `rc` members replace the defaults. */
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
    useLayoutManager: false,
    defaultCollectionDisplayList: 'Date,Title,Image,Summary,Credits',
    ...rc,
  };
}

/** A `cfeed.edit` request as the view reads it: the cfeed `before()` defaults over `rc`. */
function request(
  rc: Record<string, string>,
  partial: AdminRequestPartial = {},
  subject: WebTestSubjectKey = 'admin',
): AdminRequest {
  const req = makeAdminRequest(
    { ...partial, circuit: 'cfeed', item: 'edit', rc, site: { hasFeedManager: true, ...partial.site } },
    subject,
  );
  return { ...req, rc: applyCfeedDefaults(req.rc) };
}

const NEW_LOCAL = { type: 'Local', feedID: '' } as const;
const SAVED_LOCAL = { type: 'Local', feedID: FEED_ID } as const;
const COMPACT = { ...SAVED_LOCAL, compactDisplay: 'true', homeID: 'HOME1' } as const;
const INSTANCE = { ...COMPACT, assignmentID: 'ASSIGN1', regionID: '2', orderno: '3', instanceid: 'INST1' } as const;

/** A screen context whose identity issues {@link CSRF} for every requested context. */
function context(req: AdminRequest, rb: RbLookup = rbFor(req.session.rb)): ScreenContext {
  const gateway = fakeGatewayClient({
    [routeKey('POST', 'identity', '/v1/csrf/tokens')]: (sent: RecordedRequest) => ({
      status: 200,
      body: {
        tokens: (sent.json as { contexts: string[] }).contexts.map((ctx) => ({
          context: ctx,
          [CSRF_FIELD_TOKEN]: CSRF.token,
          [CSRF_FIELD_EXPIRES]: CSRF.expires,
        })),
      },
    }),
  });
  return { req, gateway, csrf: createCsrfRenderer(gateway), rb, hooks: { secondaryMenus: {} }, now: new Date() };
}

/** The branch view of `rc` over the screen model `modelValues`. */
async function render(
  req: AdminRequest,
  modelValues: Row = {},
  { rb }: { rb?: RbLookup } = {},
): Promise<{ view: FeedEditBranchView; $: cheerio.CheerioAPI; markup: string; rb: RbLookup }> {
  const ctx = context(req, rb);
  const model = feedEditModelFrom({ rc: modelRc(modelValues) }, req);
  const view = await renderFeedEditLocal(req, ctx, model, { fuseaction: 'edit' });
  const markup = toString(view.body);
  return { view, $: cheerio.load(markup, null, false), markup, rb: ctx.rb };
}

const ids = ($: cheerio.CheerioAPI, selector: string): string[] => $(selector).map((_i, el) => $(el).attr('id')).get();
const tabHrefs = ($: cheerio.CheerioAPI): string[] => $('ul.mura-tabs a').map((_i, el) => $(el).attr('href')).get();
const control = (controls: readonly DomControl[], name: string): DomControl | undefined =>
  controls.find((c) => c.name === name);

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('renderFeedEditLocal', () => {
  it('renders a new Local index with Add, the default filter row and no usage tab or feed URL', async () => {
    const req = request(NEW_LOCAL);
    const { view, $, markup, rb } = await render(req, { rsExtendedAttributes: [ATTRIBUTE] });
    const model = fragmentModel(markup);

    expect(markup).not.toContain('_missing');
    expect(model.headings[0]).toBe(rb.rbKey('collections.createlocalindex'));
    expect($('div.mura-header .nav-module-specific a').map((_i, el) => $(el).text().trim()).get()).toEqual([
      rb.rbKey('collections.backtocollections'),
    ]);
    expect(tabHrefs($)).toEqual(['#tabBasic', '#tabAdvancedfilters', '#tabDisplay', '#tabRss']);
    expect($('ul.mura-tabs li.active a').attr('href')).toBe('#tabBasic');
    expect(ids($, 'div.tab-content > div.tab-pane')).toEqual(['tabBasic', 'tabAdvancedfilters', 'tabDisplay', 'tabRss']);
    expect($('#tabRss a[target="_blank"]')).toHaveLength(0);
    expect($('#noFilters').text()).toBe(rb.rbKey('collections.nocontentfilters'));

    const form = $('form#feedFrm');
    expect(form.attr('action')).toBe('./?muraAction=cFeed.update&siteid=default');
    expect(form.attr('style')).toBeUndefined();
    expect(model.buttons.map((b) => b.text)).toEqual([rb.rbKey('collections.add')]);
    expect(control(model.controls, 'action')?.value).toBe('add');
    expect(control(model.controls, 'feedID')?.value).toBe('');
    expect(control(model.controls, 'type')?.value).toBe('Local');
    expect(control(model.controls, 'csrf_token')?.value).toBe(CSRF.token);
    expect(control(model.controls, 'csrf_token_expires')?.value).toBe(CSRF.expires);

    // 22 fixed fields plus the extended attribute, after the "select field" option.
    const fields = control(model.controls, 'paramField1')?.options ?? [];
    expect(fields).toHaveLength(24);
    expect(fields[1]).toMatchObject({ value: 'tcontent.lastupdate^date', label: rb.rbKey('params.lastupdate') });
    expect(fields[22]).toMatchObject({ value: 'tcontent.filename^varchar', label: 'Filename' });
    expect(fields[23]).toMatchObject({ value: 'A1^varchar', label: 'Page/Default - teaser' });
    expect(control(model.controls, 'paramCondition1')?.options.map((o) => o.value)).toEqual([
      'Equals', 'GT', 'GTE', 'LT', 'LTE', 'NEQ', 'Begins', 'Contains', 'IN', 'NOT IN',
    ]);
    expect($('select[name="paramRelationship1"]').attr('style')).toBe('display:none;');
    expect(view.htmlHead).toBeUndefined();
  });

  it('renders a saved index with its filters, params, categories, groups, feed URL and usage tab', async () => {
    const req = request(SAVED_LOCAL, { site: { hasComments: true, extranet: true } });
    const { $, markup, rb } = await render(req, SAVED_RC);
    const model = fragmentModel(markup);

    expect(model.headings[0]).toBe(rb.rbKey('collections.editlocalindex'));
    expect($('.nav-module-specific a[target="_blank"]').attr('href')).toBe(`${ENDPOINT}/?feedID=${FEED_ID}`);
    expect(tabHrefs($)).toEqual([
      '#tabBasic', '#tabCategorization', '#tabAdvancedfilters', '#tabDisplay', '#tabRss', '#tabUsagereport',
    ]);
    expect($('ul.mura-tabs a').last().text()).toBe(rb.rbKey('collections.usagereport'));
    expect($('#tabUsagereport table#metadata')).toHaveLength(1);

    expect($('input[name="name"]').attr('value')).toBe('News "Top" <Feed>');
    expect(markup).toContain('value="News&#x20;&quot;Top&quot;&#x20;&lt;Feed&gt;"');
    expect($(`tbody#ContentFilters tr#c${CONTENT_ID} input[name="contentID"]`).attr('value')).toBe(CONTENT_ID);
    expect(markup).toContain(`<td class="var-width">${ZOOM}</td>`);
    expect($('#noFilters')).toHaveLength(0);
    expect(control(model.controls, 'sortBy')?.selected).toEqual(['comments']);
    expect(control(model.controls, 'sortBy')?.options.at(-1)).toMatchObject({ value: 'teaser', label: 'Page/Default - teaser' });
    expect($(`#tabCategorization input[name="categoryID"][value="${CATEGORY_ID}"]`).is('[checked]')).toBe(true);

    expect(control(model.controls, 'paramField1')?.selected).toEqual(['tcontent.title^varchar']);
    expect(control(model.controls, 'paramCondition1')?.selected).toEqual(['Contains']);
    expect(control(model.controls, 'paramField2')?.selected).toEqual(['A1^varchar']);
    expect(control(model.controls, 'paramRelationship2')?.selected).toEqual(['or']);
    // A filter without criteria keeps And and selects neither field nor condition, as legacy does.
    expect($('select[name="paramRelationship3"] option[selected]').attr('value')).toBe('and');
    expect($('select[name="paramField3"] option[selected]')).toHaveLength(0);
    expect($('select[name="paramCondition3"] option[selected]')).toHaveLength(0);

    expect($('#tabRss a[target="_blank"]').attr('href')).toBe(`${ENDPOINT}/?feedID=${FEED_ID}`);
    expect($('textarea[name="description"]').text()).toBe('Latest & greatest');
    expect($('#rg').attr('style')).toBeUndefined();
    expect($('#restrictGroups optgroup').map((_i, el) => $(el).attr('label')).get()).toEqual([
      rb.rbKey('sitemanager.content.fields.globalsettings'),
      rb.rbKey('user.membergroups'),
      rb.rbKey('user.adminusergroups'),
    ]);
    expect(control(model.controls, 'restrictgroups')?.selected).toEqual([GROUP_MEMBERS]);

    expect(model.buttons.map((b) => b.text)).toEqual([rb.rbKey('collections.delete'), rb.rbKey('collections.update')]);
    expect($('button.mura-primary').text()).toBe(rb.rbKey('collections.update'));
    expect($('input[name="feedID"]').attr('value')).toBe(FEED_ID);
    expect(control(model.controls, 'action')?.value).toBe('update');
    expect(control(model.controls, 'homeID')).toBeUndefined();
    expect($('input[name="islocked"]')).toHaveLength(2);
  });

  it('renders compact display without the secondary menu or Delete, with the notice and the standard width script', async () => {
    const req = request(COMPACT);
    const { view, $, markup, rb } = await render(req, { feedBean: { ...NEW_BEAN, isNew: 0, name: 'News' }, rsUsage: [] });
    const model = fragmentModel(markup);

    expect($('.nav-module-specific')).toHaveLength(0);
    expect(model.alerts).toEqual([{ text: rb.rbKey('sitemanager.content.globallyappliednotice'), className: 'alert alert-info' }]);
    expect(model.buttons.map((b) => b.text)).toEqual([rb.rbKey('collections.update')]);
    expect(control(model.controls, 'homeID')?.value).toBe('HOME1');
    expect(control(model.controls, 'closeCompactDisplay')?.value).toBe('true');
    const head = toString(view.htmlHead as SafeHtml);
    expect(head.match(/frontEndProxy\.post\(\{cmd:'setWidth',width:'standard'\}\);/g)).toHaveLength(2);
    expect(head).toContain('jQuery("#ProxyIFrame").load(');
  });

  it('renders a display object instance as its Display pane only, with the defaults link and configurator script', async () => {
    const req = request(INSTANCE);
    const params = JSON.stringify({ imageSize: 'custom', imageWidth: '200', imageHeight: '100', displayName: 1 });
    const { view, $, markup, rb } = await render(req, {
      feedBean: { ...NEW_BEAN, isNew: 0, name: 'News & Views' },
      rsUsage: [],
      rsDisplayObject: [{ object: 'feed', params }],
    });
    const model = fragmentModel(markup);

    expect(model.headings).toEqual([
      rb.rbKey('collections.editlocalindexinstance'),
      rb.rbKey('collections.displaydefaults'),
      'News & Views',
    ]);
    expect($('ul.mura-tabs')).toHaveLength(0);
    expect(ids($, 'div.tab-pane')).toEqual(['tabDisplay']);
    expect($('form#feedFrm').attr('style')).toBe('width: 412px');
    expect($('ul.navTask a').attr('href')).toBe(
      `?muraAction=cFeed.edit&siteid=default&feedid=${FEED_ID}&type=Local&homeID=HOME1&compactDisplay=true`,
    );
    expect(model.alerts).toEqual([]);
    expect(control(model.controls, 'instanceimageSize')?.selected).toEqual(['custom']);
    expect($('#feedCustomImageOptions').attr('style')).toBeUndefined();
    expect(control(model.controls, 'instanceimageWidth')?.value).toBe('200');
    expect($('input[name="instancedisplayName"][value="1"]').is('[checked]')).toBe(true);
    expect($('#altNameContainer').attr('style')).toBeUndefined();
    expect(control(model.controls, 'instancemaxItems')?.selected).toEqual(['20']);
    expect(control(model.controls, 'instanceParams')?.value).toBe(params);
    expect(markup).toContain(`value='${params}'`);
    expect($('button').attr('onclick')).toBe("updateInstanceObject();submitForm(document.forms.form1,'update');return false;");
    expect(control(model.controls, 'assignmentID')?.value).toBe('ASSIGN1');
    expect(control(model.controls, 'regionid')?.value).toBe('2');
    expect(control(model.controls, 'orderno')?.value).toBe('3');
    expect(control(model.controls, 'instanceid')?.value).toBe('INST1');
    expect(toString(view.htmlHead as SafeHtml)).toContain("width:'configurator'");
  });

  it('moves maxItems and nextN into the Basic tab and drops the Display tab under the layout manager', async () => {
    const req = request(SAVED_LOCAL);
    const { $, markup } = await render(req, {
      feedBean: { ...NEW_BEAN, isNew: 0, MaxItems: 100000 },
      rsUsage: [],
      useLayoutManager: true,
    });

    expect(tabHrefs($)).toEqual(['#tabBasic', '#tabAdvancedfilters', '#tabRss', '#tabUsagereport']);
    expect($('#tabDisplay')).toHaveLength(0);
    const maxItems = $('#tabBasic select[name="maxItems"]');
    expect(maxItems.attr('data-displayobjectparam')).toBe('maxItems');
    expect(maxItems.find('option').last().text()).toBe('All');
    expect(maxItems.find('option[selected]').attr('value')).toBe('100000');
    expect($('#tabBasic select[name="nextN"] option[selected]').attr('value')).toBe('20');
    expect(fragmentModel(markup).controls.filter((c) => c.name === 'maxItems')).toHaveLength(1);
  });

  it('reports errors, locks the name for a non-S2 user and offers the site content pool', async () => {
    const req = request(SAVED_LOCAL, { site: { contentPoolID: 'default,umbrella' } }, 'siteAdmin');
    const { $, markup } = await render(req, {
      feedBean: { ...NEW_BEAN, isNew: 0, isLocked: 1, contentpoolid: 'umbrella', errors: { name: 'Name & more' } },
      rsUsage: [],
      contentPool: [
        { siteID: 'default', site: 'Default' },
        { siteID: 'umbrella', site: 'Umbrella <Pool>' },
      ],
    });

    expect($('div.alert.alert-error span').text()).toBe('Name & more ');
    expect($('input[name="name"]').attr('disabled')).toBe('disabled');
    expect($('input[name="islocked"]')).toHaveLength(0);
    const pool = $('select#contentPoolID option');
    expect(pool.map((_i, el) => [[$(el).attr('value'), $(el).text(), $(el).is('[selected]')]]).get()).toEqual([
      ['default', 'This site', false],
      ['umbrella', 'Umbrella <Pool>', true],
    ]);
    expect(markup).toContain('>Umbrella &lt;Pool&gt;</option>');
    expect($('input[type="hidden"]#contentPoolID')).toHaveLength(0);
  });

  it.each([
    ['a label with a comma shifts the later labels', 'Ba,sic', ['Ba', 'sic']],
    ['an empty label leaves the last tab without one', '', undefined],
  ])('splits the tab labels as a comma list: %s', async (_name, basic, expected) => {
    const base = rbFor('en_US');
    const rb: RbLookup = { ...base, rbKey: (key) => (key === 'collections.basic' ? basic : base.rbKey(key)) };
    const rendering = render(request(NEW_LOCAL), {}, { rb });
    if (expected === undefined) {
      await expect(rendering).rejects.toThrow(RangeError);
      return;
    }
    const { $ } = await rendering;
    expect($('ul.mura-tabs span').slice(0, 2).map((_i, el) => $(el).text()).get()).toEqual(expected);
  });

  it('carries the compact head script into the shell document', async () => {
    const req = request(COMPACT);
    const ctx = context(req);
    const model = feedEditModelFrom({ rc: modelRc({ feedBean: { ...NEW_BEAN, isNew: 0 }, rsUsage: [] }) }, req);
    const view = await renderFeedEditLocal(req, ctx, model, { fuseaction: 'edit' });
    const shell = await loadShellData(req, { gateway: ctx.gateway, csrf: ctx.csrf, rb: ctx.rb, now: ctx.now });
    const page = serializeAdminDocument(renderAdminDocument(req, { ...view, ajax: cfeedAjaxScripts() }, ctx.hooks, shell));
    const $ = cheerio.load(page);
    expect($('head').html()).toContain("width:'standard'");
    expect($('form#feedFrm')).toHaveLength(1);
  });
});
