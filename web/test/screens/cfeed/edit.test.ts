// cFeed.edit: model loading, Local/Remote dispatch, both branches, their partials and the shell, over feeds.ts.
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/strategies-content';
import { formatDateField, parseLegacyDate } from '@/lib/dates';
import type { ServicePath } from '@/lib/gateway-client';
import { encodeHtml, toString } from '@/lib/html';
import type { ScreenContext } from '@/screens/registry';
import { applyCfeedDefaults, cfeedGate } from '@/screens/cfeed/before';
import {
  renderFeedCategoriesNest,
  type FeedCategoriesNestInput,
  type FeedCategoryNode,
} from '@/screens/cfeed/categories-nest';
import { cfeedEditScreen, renderFeedEdit } from '@/screens/cfeed/edit';
import { renderFeedEditLocal } from '@/screens/cfeed/edit-local';
import {
  feedEditModelFrom,
  loadFeedEditModel,
  type FeedEditModel,
  type FeedEditSource,
} from '@/screens/cfeed/edit-model';
import { renderRemoteFeedEdit } from '@/screens/cfeed/edit-remote';
import { cfeedAjaxScripts } from '@/screens/cfeed/js';
import { renderFeedUsageTab, type FeedUsageRow } from '@/screens/cfeed/tab-usage';
import { adminS2Request, siteAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { domModel, fragmentModel, normaliseIds, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { LEGACY_SITE_PATHS_KEY, fakeGatewayClient, keptSitePaths, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenModel, renderScreenPage } from '../../helpers/screen-context';
import { CONTENT_HIST_IDS, CONTENT_IDS } from '../../fixtures/strategies-content/carch';
import { CATEGORY_IDS } from '../../fixtures/strategies-content/categories';
import {
  CFEED_PATHS,
  FEED_API_ENDPOINT,
  FEED_IDS,
  cfeedEditLocalData,
  cfeedEditNewData,
  cfeedEditRemoteData,
} from '../../fixtures/strategies-content/feeds';

type AdminViewModel = components['schemas']['AdminViewModel'];
type AdminWriteResult = components['schemas']['AdminWriteResult'];
type AdminReq = ScreenContext['req'];
type Row = Readonly<Record<string, unknown>>;
type Subject = 'siteAdmin' | 's2';
type Context = ScreenContext & { gateway: FakeGatewayClient };

const SITE = 'tenant-a';
const ROOT_ID = '00000000000000000000000000000000001';
const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const ASSIGNMENT_ID = 'A5510000-0000-4000-8000000000000001';
const IMPORT_LOCATION_TITLE = "application.rbFactory.getKeyValue(session.rb,'collections.importlocation')";
const GLOBAL_NOTICE = 'IMPORTANT: Edits will be globally reflected on all pages that use this item.';
const NAME_REQUIRED = 'The Name field is required.';
const MAX_ITEMS_INVALID = 'Max Items must be numeric.';

const LOCAL_BEAN = cfeedEditLocalData.rc['feedBean'] as Row;
const REMOTE_BEAN = cfeedEditRemoteData.rc['feedBean'] as Row;
const LOCAL_ATTRIBUTE = (cfeedEditLocalData.rc['rsExtendedAttributes'] as readonly Row[])[0] as Row;

const LOCAL_RC = { type: 'Local', feedID: FEED_IDS.localIndex } as const;
const REMOTE_RC = { type: 'Remote', feedID: FEED_IDS.remoteRss } as const;
const NEW_LOCAL_RC = { type: 'Local', feedID: '' } as const;

const FIXED_FIELDS = [
  'tcontent.lastupdate^date',
  'tcontent.releaseDate^date',
  'tcontent.created^date',
  'tcontent.menuTitle^varchar',
  'tcontent.title^varchar',
  'tcontent.Credits^varchar',
  'tcontent.summary^varchar',
  'tcontent.body^varchar',
  'tcontent.metaDesc^varchar',
  'tcontent.metaKeywords^varchar',
  'tcontent.type^varchar',
  'tcontent.subType^varchar',
  'tcontenttags.tag^varchar',
  'tcontent.displayStart^timestamp',
  'tcontent.displayStop^timestamp',
  'tcontent.expires^timestamp',
  'tcontent.contentID^varchar',
  'tcontent.parentID^varchar',
  'tcontent.path^varchar',
  'tcontentcategoryassign.categoryID^varchar',
  'tcontentcategories.name^varchar',
  'tcontent.filename^varchar',
] as const;

const CRITERIA = ['Equals', 'GT', 'GTE', 'LT', 'LTE', 'NEQ', 'Begins', 'Contains', 'IN', 'NOT IN'] as const;

const LOCAL_TABS = [
  ['#tabBasic', 'Basic'],
  ['#tabCategorization', 'Categories'],
  ['#tabAdvancedfilters', 'Advanced Filters'],
  ['#tabDisplay', 'Display Defaults'],
  ['#tabRss', 'RSS'],
  ['#tabUsagereport', 'Usage Report'],
] as const;

/** A `cFeed.edit` request on tenant-a, whose site has the feed manager. */
function editRequest(rc: Readonly<Record<string, string>>, subject: Subject = 'siteAdmin'): AdminReq {
  const partial: AdminRequestPartial = { circuit: 'cfeed', item: 'edit', rc, site: { hasFeedManager: true } };
  return subject === 's2' ? adminS2Request({ ...partial, session: { siteid: SITE } }) : siteAdminRequest(SITE, partial);
}

/** The screen context of `req` over a gateway answering `getFeed` at `path` with `data`, and legacy's kept endpoint. */
function contextFor(req: AdminReq, path?: ServicePath, data?: AdminViewModel): Context {
  const routes =
    path === undefined ? {} : { [routeKey('GET', 'strategies-content', path)]: { status: 200, body: data } };
  const gateway = fakeGatewayClient({ ...routes, [LEGACY_SITE_PATHS_KEY]: keptSitePaths({ feedEndpoint: FEED_API_ENDPOINT }) });
  return makeScreenContext({ req, gateway });
}

interface Rendered {
  readonly ctx: Context;
  readonly model: FeedEditModel;
  readonly view: Awaited<ReturnType<typeof renderFeedEdit>>;
  readonly markup: string;
  readonly $: CheerioAPI;
  readonly dom: DomModel;
}

async function rendered(ctx: Context, model: FeedEditModel): Promise<Rendered> {
  const view = await renderFeedEdit(ctx.req, ctx, model, { fuseaction: 'edit' });
  const markup = toString(view.body);
  return { ctx, model, view, markup, $: cheerio.load(markup, null, false), dom: fragmentModel(markup) };
}

/** Loads the collection through the fake gateway, then renders `edit.cfm`. */
async function loadEdit(
  rc: Readonly<Record<string, string>>,
  path: ServicePath,
  data: AdminViewModel,
  subject: Subject = 'siteAdmin',
): Promise<Rendered> {
  const ctx = contextFor(editRequest(rc, subject), path, data);
  return rendered(ctx, await loadFeedEditModel(ctx.req, ctx));
}

/** Maps `source` for the defaulted request, as a rejected or unsaved collection reaches the view, then renders. */
async function mapEdit(
  rc: Readonly<Record<string, string>>,
  source: FeedEditSource,
  subject: Subject = 'siteAdmin',
): Promise<Rendered> {
  const req = editRequest(rc, subject);
  const ctx = contextFor({ ...req, rc: applyCfeedDefaults(req.rc) });
  return rendered(ctx, feedEditModelFrom(source, ctx.req));
}

const localWith = (rc: Row): AdminViewModel => ({ rc: { ...cfeedEditLocalData.rc, ...rc } });
const localBeanWith = (bean: Row): AdminViewModel => localWith({ feedBean: { ...LOCAL_BEAN, ...bean } });

const textOf = ($: CheerioAPI, selector: string): string[] =>
  $(selector)
    .toArray()
    .map((el) => $(el).text().trim());

const tabs = ($: CheerioAPI): Array<[string, string]> =>
  $('ul.mura-tabs.nav-tabs > li > a')
    .toArray()
    .map((el) => [$(el).attr('href') ?? '', $(el).text().trim()]);

const paneIds = ($: CheerioAPI): string[] =>
  $('.tab-content > .tab-pane')
    .toArray()
    .map((el) => $(el).attr('id') ?? '');

const menuLinks = ($: CheerioAPI): Array<[string, string]> =>
  $('div.mura-header .nav-module-specific a')
    .toArray()
    .map((el) => [$(el).text().trim(), $(el).attr('href') ?? '']);

const hiddenFields = ($: CheerioAPI): Array<[string, string]> =>
  $('.mura-actions input[type=hidden]')
    .toArray()
    .map((el) => [$(el).attr('name') ?? '', $(el).attr('value') ?? '']);

const controlsNamed = (dom: DomModel, name: string) => dom.controls.filter((c) => c.name === name);
const checked = (dom: DomModel, name: string): string[] =>
  controlsNamed(dom, name)
    .filter((c) => c.checked)
    .map((c) => c.value);
const optionValues = (dom: DomModel, name: string): string[] =>
  controlsNamed(dom, name)[0]?.options.map((o) => o.value) ?? [];
const selected = (dom: DomModel, name: string): string[] => controlsNamed(dom, name)[0]?.selected ?? [];

const headOf = (view: Rendered['view']): string => (view.htmlHead === undefined ? '' : toString(view.htmlHead));

const identityContexts = (ctx: Context): string[] =>
  ctx.gateway.calls
    .filter((call) => call.service === 'identity' && call.path === '/v1/csrf/tokens')
    .flatMap((call) => (call.json as { contexts: string[] }).contexts);

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('loadFeedEditModel', () => {
  it('reads the collection once from strategies-content and maps the fixture', async () => {
    const ctx = contextFor(editRequest(LOCAL_RC), CFEED_PATHS.editLocal, cfeedEditLocalData);

    const model = await loadFeedEditModel(ctx.req, ctx);

    const reads = ctx.gateway.calls.filter((call) => call.service === 'strategies-content');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ method: 'GET', path: CFEED_PATHS.editLocal, query: { type: 'Local' } });
    expect(ctx.req.rc).toMatchObject({ ...LOCAL_RC, regionID: '0', orderno: '0', instanceParams: '' });
    expect(model.feed).toMatchObject({
      feedID: FEED_IDS.localIndex,
      siteID: SITE,
      name: LOCAL_BEAN['NAME'],
      type: 'Local',
      isNew: false,
      exists: true,
      categoryID: CATEGORY_IDS.topicsNews,
    });
    expect(model.isObjectInstance).toBe(false);
  });

  it('relays the display object instance fields of an instance edit', async () => {
    const rc = { ...LOCAL_RC, assignmentID: ASSIGNMENT_ID, regionID: '2', orderno: '3' };
    const ctx = contextFor(editRequest(rc), CFEED_PATHS.editLocal, cfeedEditLocalData);

    const model = await loadFeedEditModel(ctx.req, ctx);

    expect(ctx.gateway.calls.find((call) => call.path === CFEED_PATHS.editLocal)?.query).toMatchObject({
      type: 'Local',
      assignmentID: ASSIGNMENT_ID,
      regionID: '2',
      orderno: '3',
    });
    expect(model.isObjectInstance).toBe(true);
  });
});

describe('feedEditModelFrom', () => {
  it('maps a rejected save to its errors and the posted values', () => {
    const rejected: AdminWriteResult = {
      saved: false,
      errors: { name: NAME_REQUIRED, maxItems: MAX_ITEMS_INVALID },
      redirect: null,
      data: { ...cfeedEditLocalData.rc, feedBean: { ...LOCAL_BEAN, NAME: '', DESCRIPTION: 'Posted description' } },
    };
    const req = editRequest(LOCAL_RC);

    const model = feedEditModelFrom(rejected, { ...req, rc: applyCfeedDefaults(req.rc) });

    expect(model.errors).toEqual({ name: NAME_REQUIRED, maxItems: MAX_ITEMS_INVALID });
    expect(model.feed).toMatchObject({ feedID: FEED_IDS.localIndex, name: '', description: 'Posted description' });
  });
});

describe('renderFeedEdit dispatch', () => {
  it.each(['Local', 'local', 'LOCAL'])('renders the Local branch for type %s', async (type) => {
    const { $, ctx, model, markup } = await loadEdit({ ...LOCAL_RC, type }, CFEED_PATHS.editLocal, cfeedEditLocalData);

    const branch = await renderFeedEditLocal(ctx.req, ctx, model, { fuseaction: 'edit' });
    expect(markup).toBe(toString(branch.body));
    expect($('form#feedFrm')).toHaveLength(1);
    expect($('div.mura-header > h1').text()).toBe('Edit Local Index');
  });

  it.each(['Remote', 'remote', ''])('renders the Remote branch for type "%s"', async (type) => {
    const rc = { ...REMOTE_RC, type };
    const { $, ctx, model, markup } = await loadEdit(rc, CFEED_PATHS.editRemote, cfeedEditRemoteData);

    const branch = await renderRemoteFeedEdit(ctx.req, ctx, model, { fuseaction: 'edit' });
    expect(markup).toBe(toString(branch.body));
    expect($('form#feedFrm')).toHaveLength(0);
    expect($('form[name=form1]')).toHaveLength(1);
    expect($('form[name=form1]').attr('id')).toBeUndefined();
    expect($('div.mura-header > h1').text()).toBe('Edit Remote Feed');
  });
});

describe('Local branch', () => {
  it('renders the saved index header, menu, form and tab strip', async () => {
    const { $ } = await loadEdit(LOCAL_RC, CFEED_PATHS.editLocal, cfeedEditLocalData);

    expect(textOf($, 'div.mura-header > h1')).toEqual(['Edit Local Index']);
    expect(menuLinks($)).toEqual([
      ['Back to Collections', `./?muraAction=cFeed.list&siteid=${SITE}`],
      ['View Feed', `${FEED_API_ENDPOINT}/?feedID=${FEED_IDS.localIndex}`],
    ]);
    expect($('form').attr()).toEqual({
      novalidate: 'novalidate',
      action: `./?muraAction=cFeed.update&siteid=${SITE}`,
      method: 'post',
      name: 'form1',
      id: 'feedFrm',
      onsubmit: 'return validate(this);',
    });
    expect(tabs($)).toEqual(LOCAL_TABS);
    expect(paneIds($)).toEqual(LOCAL_TABS.map(([href]) => href.slice(1)));
    expect($('ul.mura-tabs > li').first().attr('class')).toBe('active');
    expect($('ul.mura-tabs > li.active')).toHaveLength(1);
    expect(new Set($('ul.mura-tabs > li > a').toArray().map((el) => $(el).attr('onclick')))).toEqual(
      new Set(['return false;']),
    );
    expect($('div.alert')).toHaveLength(0);
  });

  it('renders the Basic tab controls in legacy order', async () => {
    const { $, dom } = await loadEdit(LOCAL_RC, CFEED_PATHS.editLocal, cfeedEditLocalData);

    const name = $('#tabBasic input[name=name]');
    expect(name.attr('maxlength')).toBe('250');
    expect(name.attr('value')).toBe(LOCAL_BEAN['NAME']);
    expect(name.attr('disabled')).toBeUndefined();
    expect(optionValues(dom, 'sortBy')).toEqual([
      'lastUpdate',
      'releaseDate',
      'displayStart',
      'menuTitle',
      'title',
      'rating',
      'created',
      'orderno',
      'random',
      '',
      LOCAL_ATTRIBUTE['attribute'],
    ]);
    expect(selected(dom, 'sortBy')).toEqual(['lastUpdate']);
    expect(optionValues(dom, 'sortDirection')).toEqual(['asc', 'desc']);
    expect(selected(dom, 'sortDirection')).toEqual(['desc']);
    expect(checked(dom, 'isFeaturesOnly')).toEqual(['0']);
    expect(checked(dom, 'showNavOnly')).toEqual(['1']);
    expect(checked(dom, 'showExcludeSearch')).toEqual(['0']);
  });

  it('nests the categories with the feed categories checked', async () => {
    const { $, markup, model } = await loadEdit(LOCAL_RC, CFEED_PATHS.editLocal, cfeedEditLocalData);

    const nest = renderFeedCategoriesNest({
      nodes: model.categories,
      nestLevel: 0,
      feedCategoryIds: model.feed.categoryID,
      categoryIds: '',
    });
    expect(markup).toContain(toString(nest));
    expect($('#tabCategorization #mura-list-tree > ul.categories.checkboxTree')).toHaveLength(1);
    const boxes = $('#tabCategorization input[type=checkbox][name=categoryID]');
    expect(boxes.toArray().map((el) => $(el).attr('value'))).toEqual([
      CATEGORY_IDS.topics,
      CATEGORY_IDS.topicsNews,
      CATEGORY_IDS.topicsEvents,
      CATEGORY_IDS.topicsEventsLocal,
      CATEGORY_IDS.restricted,
    ]);
    expect(boxes.filter('[checked]').toArray().map((el) => $(el).attr('value'))).toEqual([CATEGORY_IDS.topicsNews]);
    expect(boxes.filter('[disabled]').toArray().map((el) => $(el).attr('value'))).toEqual([CATEGORY_IDS.restricted]);
  });

  it('renders the advanced filter choices and selects the stored params', async () => {
    const { dom } = await loadEdit(LOCAL_RC, CFEED_PATHS.editLocal, cfeedEditLocalData);

    const fields = ['', ...FIXED_FIELDS, `${String(LOCAL_ATTRIBUTE['attributeID'])}^varchar`];
    expect(optionValues(dom, 'paramField1')).toEqual(fields);
    expect(optionValues(dom, 'paramField2')).toEqual(fields);
    expect(controlsNamed(dom, 'paramField1')[0]?.options.at(-1)?.label).toBe('Page/Default - programCode');
    expect(optionValues(dom, 'paramCondition1')).toEqual(CRITERIA);
    expect(controlsNamed(dom, 'param').map((c) => c.value)).toEqual(['1', '2']);
    expect([
      selected(dom, 'paramRelationship1'),
      selected(dom, 'paramField1'),
      selected(dom, 'paramCondition1'),
    ]).toEqual([['and'], ['tcontent.title^varchar'], ['Contains']]);
    expect(controlsNamed(dom, 'paramCriteria1')[0]?.value).toBe('news');
    expect([
      selected(dom, 'paramRelationship2'),
      selected(dom, 'paramField2'),
      selected(dom, 'paramCondition2'),
    ]).toEqual([['and'], ['tcontent.releaseDate^date'], ['GTE']]);
    expect(controlsNamed(dom, 'paramCriteria2')[0]?.value).toBe('2026-06-01');
  });

  it('renders the Display, RSS and Usage Report panes from the fixture', async () => {
    const { $, dom, markup, ctx, model } = await loadEdit(LOCAL_RC, CFEED_PATHS.editLocal, cfeedEditLocalData);

    expect($('#tabDisplay.tab-pane')).toHaveLength(1);
    expect($('#tabRss.tab-pane')).toHaveLength(1);
    expect(checked(dom, 'allowHTML')).toEqual(['1']);
    expect(checked(dom, 'isPublic')).toEqual(['1']);
    expect(optionValues(dom, 'version')).toEqual(['RSS 2.0', 'RSS 0.920']);
    expect(selected(dom, 'version')).toEqual(['RSS 2.0']);
    expect($('#tabRss a[target=_blank]').attr('href')).toBe(`${FEED_API_ENDPOINT}/?feedID=${FEED_IDS.localIndex}`);
    const usage = renderFeedUsageTab(ctx.req, ctx.rb, { feedType: 'Local', rows: model.usage });
    expect(markup).toContain(toString(usage.html));
    expect($('#tabUsagereport table#metadata.mura-table-grid')).toHaveLength(1);
  });

  it('ends the form with its hidden fields and the CSRF pair of the collection', async () => {
    const { $, ctx, dom } = await loadEdit(LOCAL_RC, CFEED_PATHS.editLocal, cfeedEditLocalData);

    expect(hiddenFields($)).toEqual([
      ['feedID', FEED_IDS.localIndex],
      ['action', 'update'],
      ['type', 'Local'],
      ['isActive', '1'],
      ['instanceParams', ''],
      ['assignmentID', ''],
      ['orderno', '0'],
      ['regionid', '0'],
      ['instanceid', ''],
      ['closeCompactDisplay', ctx.req.rc.compactDisplay],
      ['csrf_token', FIXED_CSRF.token],
      ['csrf_token_expires', FIXED_CSRF.expires],
    ]);
    expect(identityContexts(ctx)).toContain(FEED_IDS.localIndex);
    expect(dom.buttons.map((b) => b.text)).toEqual(['Delete', 'Update']);
  });

  it.each<[Subject, number]>([
    ['s2', 2],
    ['siteAdmin', 0],
  ])('renders %s with %i islocked radios', async (subject, count) => {
    const { dom } = await loadEdit(LOCAL_RC, CFEED_PATHS.editLocal, cfeedEditLocalData, subject);

    expect(controlsNamed(dom, 'islocked')).toHaveLength(count);
  });

  it('disables the name of a locked collection and checks its islocked radio for S2', async () => {
    const { $, dom } = await mapEdit(LOCAL_RC, localBeanWith({ ISLOCKED: 1 }), 's2');

    expect($('#tabBasic input[name=name]').attr('disabled')).toBe('disabled');
    expect(checked(dom, 'islocked')).toEqual(['1']);
  });

  it('renders a new index with Add and no View Feed or usage tab', async () => {
    const { $, dom } = await mapEdit(NEW_LOCAL_RC, cfeedEditNewData);

    expect(textOf($, 'div.mura-header > h1')).toEqual(['Create Local Index']);
    expect(menuLinks($).map(([text]) => text)).toEqual(['Back to Collections']);
    expect(tabs($).map(([href]) => href)).not.toContain('#tabUsagereport');
    expect($('.mura-actions button').attr('onclick')).toBe("submitForm(document.forms.form1,'add');");
    expect(dom.buttons.map((b) => b.text)).toEqual(['Add']);
    expect(hiddenFields($).slice(0, 2)).toEqual([
      ['feedID', ''],
      ['action', 'add'],
    ]);
  });

  it('renders an instance edit with its title and fixed form width', async () => {
    const rc = { ...LOCAL_RC, assignmentID: ASSIGNMENT_ID };
    const { $ } = await loadEdit(rc, CFEED_PATHS.editLocal, cfeedEditLocalData);

    expect(textOf($, 'div.mura-header > h1')).toEqual(['Edit Local Index Instance']);
    expect($('form#feedFrm').attr('style')).toBe('width: 412px');
    expect($('ul.mura-tabs')).toHaveLength(0);
    expect(hiddenFields($)).toContainEqual(['assignmentID', ASSIGNMENT_ID]);
  });

  it('shows the errors of a rejected save', async () => {
    const rejected: AdminWriteResult = {
      saved: false,
      errors: { name: NAME_REQUIRED, maxItems: MAX_ITEMS_INVALID },
      redirect: null,
      data: { ...cfeedEditLocalData.rc, feedBean: { ...LOCAL_BEAN, NAME: '' } },
    };

    const { $, dom } = await mapEdit(LOCAL_RC, rejected);

    expect(dom.alerts).toEqual([{ text: `${NAME_REQUIRED} ${MAX_ITEMS_INVALID}`, className: 'alert alert-error' }]);
    expect($('div.alert.alert-error > span').html()).toContain('<br>');
    expect($('#tabBasic input[name=name]').attr('value')).toBe('');
  });

  it('renders compact display without the menu or Delete, with the notice and homeID', async () => {
    const rc = { ...LOCAL_RC, compactDisplay: 'true', homeID: ROOT_ID };
    const { $, dom } = await loadEdit(rc, CFEED_PATHS.editLocal, cfeedEditLocalData);

    expect($('.nav-module-specific')).toHaveLength(0);
    expect(dom.alerts).toEqual([{ text: GLOBAL_NOTICE, className: 'alert alert-info' }]);
    expect(hiddenFields($)).toContainEqual(['homeID', ROOT_ID]);
    expect(hiddenFields($)).toContainEqual(['closeCompactDisplay', 'true']);
    expect(dom.buttons.map((b) => b.text)).toEqual(['Update']);
  });

  it.each<[string, Row, string]>([
    ['the layout manager', { useLayoutManager: true }, '#tabDisplay'],
    ['no categories', { hasCategories: 0, categories: [] }, '#tabCategorization'],
  ])('leaves a tab out with %s', async (_case, rc, missing) => {
    const { $ } = await mapEdit(LOCAL_RC, localWith(rc));

    expect(tabs($)).toEqual(LOCAL_TABS.filter(([href]) => href !== missing));
    expect($(missing)).toHaveLength(0);
  });
});


describe('Remote branch', () => {
  it('renders the saved feed for S2 with the Import Location tab', async () => {
    const { $, dom, ctx } = await loadEdit(REMOTE_RC, CFEED_PATHS.editRemote, cfeedEditRemoteData, 's2');

    expect(tabs($)).toEqual([
      ['#tabBasic', 'Basic'],
      ['#tabCategorization', 'Categories'],
      ['#tabImportlocation', 'Import Location'],
      ['#tabUsagereport', 'Usage Report'],
    ]);
    expect($('ul.mura-tabs > li').first().attr('class')).toBe('active');
    expect($('#tabImportlocation h3.block-title').text()).toBe(IMPORT_LOCATION_TITLE);
    expect(dom.labels).toContain('Import Location:');
    expect($('#tabImportlocation input[type=hidden][name=parentid]').attr('value')).toBe(REMOTE_BEAN['PARENTID']);
    expect(controlsNamed(dom, 'autoImport').map((c) => c.value)).toEqual(['1', '0']);
    expect(checked(dom, 'autoImport')).toEqual(['1']);
    expect($('#tabUsagereport .help-block-empty').text()).toBe('This feed is currently not being used.');
    expect(dom.buttons.map((b) => [b.text, b.type])).toEqual([
      ['Delete', 'button'],
      ['Update', 'button'],
    ]);
    expect(hiddenFields($)).toEqual([
      ['feedID', FEED_IDS.remoteRss],
      ['action', 'update'],
      ['instanceid', ''],
      ['closeCompactDisplay', ctx.req.rc.compactDisplay],
      ['type', 'Remote'],
      ['csrf_token', FIXED_CSRF.token],
      ['csrf_token_expires', FIXED_CSRF.expires],
    ]);
    expect(identityContexts(ctx)).toContain(FEED_IDS.remoteRss);
  });

  it('leaves the Import Location tab and pane out for a site admin', async () => {
    const { $ } = await loadEdit(REMOTE_RC, CFEED_PATHS.editRemote, cfeedEditRemoteData);

    expect(tabs($).map(([href]) => href)).toEqual(['#tabBasic', '#tabCategorization', '#tabUsagereport']);
    expect($('#tabImportlocation')).toHaveLength(0);
    expect($('input[name=parentid]')).toHaveLength(0);
  });

  it('links View Feed to the channel link', async () => {
    const { $ } = await loadEdit(REMOTE_RC, CFEED_PATHS.editRemote, cfeedEditRemoteData);

    expect(menuLinks($)).toEqual([
      ['Back to Collections', `./?muraAction=cFeed.list&siteid=${SITE}`],
      ['View Feed', REMOTE_BEAN['CHANNELLINK']],
    ]);
    expect($('div.mura-header a[target=_blank]').attr('href')).toBe(REMOTE_BEAN['CHANNELLINK']);
  });

  it('renders a new feed with a button-type Add and no usage tab', async () => {
    const source: AdminViewModel = {
      rc: { ...cfeedEditNewData.rc, feedBean: { ...(cfeedEditNewData.rc['feedBean'] as Row), TYPE: 'Remote' } },
    };

    const { $, dom } = await mapEdit({ type: 'Remote', feedID: '' }, source);

    expect(textOf($, 'div.mura-header > h1')).toEqual(['Create Remote Feed']);
    expect(dom.buttons.map((b) => [b.text, b.type])).toEqual([['Add', 'button']]);
    expect(hiddenFields($).slice(0, 2)).toEqual([
      ['feedID', ''],
      ['action', 'add'],
    ]);
    expect(tabs($).map(([href]) => href)).toEqual(['#tabBasic', '#tabCategorization']);
  });

  it('renders compact display with the notice, homeID and no Delete', async () => {
    const rc = { ...REMOTE_RC, compactDisplay: 'true', homeID: ROOT_ID };
    const { $, dom, view } = await loadEdit(rc, CFEED_PATHS.editRemote, cfeedEditRemoteData);

    expect($('.nav-module-specific')).toHaveLength(0);
    expect(dom.alerts).toEqual([{ text: GLOBAL_NOTICE, className: 'alert alert-info' }]);
    expect(hiddenFields($)).toContainEqual(['homeID', ROOT_ID]);
    expect(dom.buttons.map((b) => b.text)).toEqual(['Update']);
    expect(headOf(view)).toContain("frontEndProxy.post({cmd:'setWidth',width:'standard'})");
  });
});

describe('renderFeedCategoriesNest', () => {
  const node = (categoryID: string, name: string, extra: Partial<FeedCategoryNode> = {}): FeedCategoryNode => ({
    categoryID,
    name,
    isOpen: 1,
    permitted: true,
    hasKids: 0,
    children: [],
    ...extra,
  });
  const nestInput = (nodes: readonly FeedCategoryNode[], extra: Partial<FeedCategoriesNestInput> = {}) => ({
    nodes,
    nestLevel: 0,
    feedCategoryIds: '',
    categoryIds: '',
    ...extra,
  });
  const nest = (nodes: readonly FeedCategoryNode[], extra: Partial<FeedCategoriesNestInput> = {}) =>
    cheerio.load(toString(renderFeedCategoriesNest(nestInput(nodes, extra))), null, false);

  it('renders nothing for no categories', () => {
    expect(toString(renderFeedCategoriesNest(nestInput([])))).toBe('');
  });

  it.each<[number, string]>([
    [0, 'categories checkboxTree'],
    [1, 'categories'],
  ])('classes the list at nest level %i as "%s"', (nestLevel, className) => {
    const $ = nest([node(CATEGORY_IDS.topics, 'General Topics')], { nestLevel });

    expect($('ul').attr('class')).toBe(className);
    expect($('ul > li')).toHaveLength(1);
  });

  it('renders the checkbox only for an open category', () => {
    const $ = nest([node(CATEGORY_IDS.topics, 'Open'), node(CATEGORY_IDS.restricted, 'Closed', { isOpen: 0 })]);

    const boxes = $('input[type=checkbox][name=categoryID].checkbox');
    expect(boxes.toArray().map((el) => $(el).attr('value'))).toEqual([CATEGORY_IDS.topics]);
    expect(textOf($, 'li')).toEqual(['Open', 'Closed']);
  });

  it.each<[string, { feedCategoryIds?: string; categoryIds?: string }]>([
    ['the feed category ids', { feedCategoryIds: `${CATEGORY_IDS.topics},${CATEGORY_IDS.topicsNews}` }],
    ['the categoryIds attribute', { categoryIds: CATEGORY_IDS.topicsNews }],
  ])('checks a category listed in %s', (_case, lists) => {
    const $ = nest([node(CATEGORY_IDS.topicsNews, 'Agency News'), node(CATEGORY_IDS.topicsEvents, 'Events')], lists);

    expect($('input[checked]').toArray().map((el) => $(el).attr('value'))).toEqual([CATEGORY_IDS.topicsNews]);
  });

  it('disables the checkbox of a category the user may not assign', () => {
    const $ = nest([node(CATEGORY_IDS.restricted, 'Restricted Notices', { permitted: false })]);

    expect($('input[name=categoryID]').attr('disabled')).toBe('disabled');
  });

  it('nests the children of a category with kids', () => {
    const child = node(CATEGORY_IDS.topicsEventsLocal, 'Local Events');
    const parent = node(CATEGORY_IDS.topicsEvents, 'Events', { hasKids: 1, children: [child] });

    const $ = nest([parent], { feedCategoryIds: CATEGORY_IDS.topicsEventsLocal });

    expect($('ul.checkboxTree > li > ul.categories').attr('class')).toBe('categories');
    expect($('ul.checkboxTree > li > ul > li input[checked]').attr('value')).toBe(CATEGORY_IDS.topicsEventsLocal);
  });

  it('encodes the category name', () => {
    const name = '<b>News & Events</b>';
    const markup = toString(renderFeedCategoriesNest(nestInput([node(CATEGORY_IDS.topics, name)])));

    expect(markup).toContain(encodeHtml(name));
    expect(markup).not.toContain(name);
    expect(cheerio.load(markup, null, false)('li').text().trim()).toBe(name);
  });
});

describe('renderFeedUsageTab', () => {
  const HOME_ID = ROOT_ID;
  const ABOUT_ZOOM = '<ul class="navZoom"><li>About Us</li></ul>';
  const usageRow = (extra: Partial<FeedUsageRow> = {}): FeedUsageRow => ({
    contentHistID: CONTENT_HIST_IDS.aboutUs,
    contentID: CONTENT_IDS.aboutUs,
    type: 'Page',
    parentID: ROOT_ID,
    siteID: SITE,
    moduleID: SITE_MANAGER_MODULE,
    display: 1,
    approved: 1,
    displayStart: null,
    displayStop: null,
    lastUpdate: '2026-06-15 10:30:00',
    zoom: ABOUT_ZOOM,
    verdict: 'editor',
    ...extra,
  });
  const usageRequest = () => siteAdminRequest(SITE, { rc: { compactDisplay: 'true', homeID: HOME_ID } });

  /** The tab of `rows`, with the date formatter its cells use. */
  function usageTab(rows: readonly FeedUsageRow[], feedType = 'Local') {
    const req = usageRequest();
    const { rb } = makeScreenContext({ req });
    const tab = renderFeedUsageTab(req, rb, { feedType, rows });
    const markup = toString(tab.html);
    const format = (value: string): string =>
      formatDateField(value, req.session.dateKeyFormat, parseLegacyDate(value) ?? undefined);
    return { tab, markup, $: cheerio.load(markup, null, false), dom: fragmentModel(markup), format };
  }

  it('returns the pane with its tab id and label', () => {
    const { tab, $ } = usageTab([usageRow()]);

    expect(tab.tabId).toBe('tabUsagereport');
    expect(tab.label).toBe('Usage Report');
    expect($('div#tabUsagereport.tab-pane')).toHaveLength(1);
    expect($('h3.block-title').text()).toBe('Usage Report');
  });

  it('lists the usage rows with their actions, crumbs and dates', () => {
    const news = usageRow({
      contentHistID: CONTENT_HIST_IDS.news,
      contentID: CONTENT_IDS.news,
      type: 'Folder',
      verdict: 'none',
    });
    const { $, dom, format } = usageTab([usageRow(), news]);

    expect(dom.labels).toEqual(['This item is used in the following locations:']);
    expect($('table#metadata.mura-table-grid')).toHaveLength(1);
    expect(dom.tables[0]?.headers).toEqual(['', 'Title', 'Display', 'Update']);
    const target =
      `&contentid=${CONTENT_IDS.aboutUs}&type=Page&parentid=${ROOT_ID}&topid=${CONTENT_IDS.aboutUs}` +
      `&siteid=${SITE}&moduleid=${SITE_MANAGER_MODULE}`;
    expect($('li.edit:not(.disabled) a').attr('href')).toBe(
      `./?muraAction=cArch.edit&contenthistid=${CONTENT_HIST_IDS.aboutUs}${target}` +
        `&compactDisplay=true&homeID=${HOME_ID}`,
    );
    expect($('li.version-history:not(.disabled) a').attr('href')).toBe(`./?muraAction=cArch.hist${target}`);
    expect(textOf($, 'li.edit.disabled')).toEqual(['Edit']);
    expect(textOf($, 'li.version-history.disabled')).toEqual(['Version History']);
    expect($('li.disabled a')).toHaveLength(0);
    expect($('td.var-width').first().html()).toBe(ABOUT_ZOOM);
    const updated = format('2026-06-15 10:30:00');
    expect(dom.tables[0]?.rows.map((row) => row[3])).toEqual([updated, updated]);
  });

  it.each<[string, Partial<FeedUsageRow>, (format: (value: string) => string) => string]>([
    ['displayed and approved', { display: 1, approved: 1 }, () => 'Yes'],
    [
      'scheduled and approved',
      { display: 2, approved: 1, displayStart: '2026-06-01 08:00:00', displayStop: '2026-06-30 17:00:00' },
      (format) => `${format('2026-06-01 08:00:00')} - ${format('2026-06-30 17:00:00')}`,
    ],
    ['scheduled and unapproved', { display: 2, approved: 0 }, () => 'No'],
    ['hidden', { display: 0, approved: 1 }, () => 'No'],
  ])('shows the display of a %s row', (_case, extra, expected) => {
    const { dom, format } = usageTab([usageRow(extra)]);

    expect(dom.tables[0]?.rows[0]?.[2]).toBe(expected(format));
  });

  it.each([
    ['Local', 'This index is currently not being used.'],
    ['Remote', 'This feed is currently not being used.'],
  ])('shows the empty-usage notice of a %s collection', (feedType, notice) => {
    const { $ } = usageTab([], feedType);

    expect(textOf($, 'div.help-block-empty')).toEqual([notice]);
    expect($('table')).toHaveLength(0);
  });
});

describe('shell integration', () => {
  it.each<[string, Readonly<Record<string, string>>, ServicePath, AdminViewModel]>([
    ['Local', LOCAL_RC, CFEED_PATHS.editLocal, cfeedEditLocalData],
    ['Remote', REMOTE_RC, CFEED_PATHS.editRemote, cfeedEditRemoteData],
  ])('sets the %s view ajax to the cfeed scripts', async (_type, rc, path, data) => {
    const { view } = await loadEdit(rc, path, data);

    expect(view.ajax).toBeDefined();
    expect(toString(view.ajax ?? cfeedAjaxScripts())).toBe(toString(cfeedAjaxScripts()));
    expect(view.htmlHead).toBeUndefined();
  });

  it.each<[string, Readonly<Record<string, string>>, string]>([
    ['a collection', { compactDisplay: 'true' }, 'standard'],
    ['an instance', { compactDisplay: 'true', assignmentID: ASSIGNMENT_ID }, 'configurator'],
  ])('sizes the compact modal for %s', async (_case, extra, width) => {
    const { view, dom } = await loadEdit({ ...LOCAL_RC, ...extra }, CFEED_PATHS.editLocal, cfeedEditLocalData);

    expect(headOf(view)).toContain(`frontEndProxy.post({cmd:'setWidth',width:'${width}'})`);
    expect(dom.alerts.length).toBe(width === 'standard' ? 1 : 0);
  });

  it('declares cFeed.edit as a strategies-content page behind the cfeed gate', () => {
    expect(cfeedEditScreen).toMatchObject({
      circuit: 'cfeed',
      action: 'edit',
      mode: 'page',
      owner: 'strategies-content',
    });
    expect(cfeedEditScreen.gate).toBe(cfeedGate);
  });

  it('renders the screen in the shell with the collection scripts in the head', async () => {
    const model = await renderScreenModel(
      cfeedEditScreen,
      contextFor(editRequest(LOCAL_RC), CFEED_PATHS.editLocal, cfeedEditLocalData),
    );
    expect(model.headings).toContain('Edit Local Index');

    const page = await renderScreenPage(
      cfeedEditScreen,
      contextFor(editRequest(LOCAL_RC), CFEED_PATHS.editLocal, cfeedEditLocalData),
    );
    expect(page.kind).toBe('document');
    if (page.kind !== 'document') return;
    const head = toString(page.doc.head);
    const scripts = cheerio.load(toString(cfeedAjaxScripts()))('script').toArray();
    expect(scripts).toHaveLength(3);
    for (const script of scripts) expect(head).toContain(script.attribs['src']);
    expect(normaliseIds(domModel(page.html)).headings).toEqual(model.headings);
  });
});

