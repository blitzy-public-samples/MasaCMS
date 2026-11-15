// cFeed.list over the strategies-content feeds fixture for the tenant-a site admin (cfeed/list.cfm, cfeed.cfc list()).
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { cfeedGate } from '@/screens/cfeed/before';
import { feedApiEndpoint } from '@/screens/cfeed/common';
import { cfeedListScreen, loadFeedList, renderFeedList } from '@/screens/cfeed/list';
import type { ScreenContext } from '@/screens/registry';
import type { ShellView } from '@/shell/document';
import { CFEED_PATHS, FEED_IDS, cfeedListData } from '../../fixtures/strategies-content/feeds';
import { siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, normaliseIds, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenModel } from '../../helpers/screen-context';

// The registry module loads every circuit; screen suites stand in for it with the shell hooks this page renders with.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type Row = Readonly<Record<string, unknown>>;
type ListContext = ScreenContext & { gateway: FakeGatewayClient };
/** cheerio's element selection, derived so `domhandler` need not be a direct dependency. */
type Selection = ReturnType<ReturnType<CheerioAPI['root']>['find']>;

const SITE = 'tenant-a';
const LIST_ROUTE = routeKey('GET', 'strategies-content', CFEED_PATHS.list);
const URL_TOKENS = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;
const COLLECTIONS_MODULE = '00000000000000000000000000000000011';
const LOCAL_ID = FEED_IDS.localIndex;
const REMOTE_ID = FEED_IDS.remoteRss;
const LOCAL_HEADERS = ['', 'Index', 'Language', 'Max Items', 'Features Only', 'Restricted', 'Active'];
const REMOTE_HEADERS = ['', 'Feed', 'URL', 'Active'];
const LONG_LINK = `https://feeds.example.test/partner/${'archive/'.repeat(8)}updates.rss`;

/** The first row of the fixture query `rc[query]`. */
function fixtureRow(query: string): Row {
  const rows: unknown = cfeedListData.rc[query];
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError(`cfeedListData has no rc.${query} row`);
  return rows[0] as Row;
}

const LOCAL_ROW = fixtureRow('rsLocal');
const REMOTE_ROW = fixtureRow('rsRemote');
const CHANNEL_LINK = String(REMOTE_ROW.channellink);

/** The site admin on `cfeed.list` of tenant-a, whose site has the feed manager, with listFeeds answering `rc`. */
function listContext(rc: Row = cfeedListData.rc): ListContext {
  const req = siteAdminRequest(SITE, { circuit: 'cfeed', item: 'list', site: { hasFeedManager: true } });
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [LIST_ROUTE]: { status: 200, body: { rc } } }) });
}

interface RenderedList {
  readonly ctx: ListContext;
  readonly view: ShellView;
  readonly markup: string;
  readonly $: CheerioAPI;
}

/** Loads and renders the list body for `rc`. */
async function renderList(rc?: Row): Promise<RenderedList> {
  const ctx = listContext(rc);
  const view = renderFeedList(ctx, await loadFeedList(ctx));
  expect(isSafeHtml(view.body)).toBe(true);
  const markup = toString(view.body);
  return { ctx, view, markup, $: cheerio.load(markup, null, false) };
}

/** The first data row of the `index`th list table. */
const dataRow = ($: CheerioAPI, index: number): Selection => $('table.mura-table-grid').eq(index).find('tr').eq(1);

/** The `li.<item>` link of a row's actions menu. */
function itemLink(row: Selection, item: string): Record<string, string | undefined> {
  const link = row.find(`ul.actions-list > li.${item} > a`);
  return { href: link.attr('href'), target: link.attr('target'), onclick: link.attr('onclick'), text: link.text() };
}

/** The text of each `td` of `row`. */
const cellTexts = ($: CheerioAPI, row: Selection): string[] =>
  row
    .children('td')
    .toArray()
    .map((td) => $(td).text().trim());

const identityCalls = (ctx: ListContext) => ctx.gateway.calls.filter(({ service }) => service === 'identity');

/** The normalised delete hrefs of a DOM model, in document order. */
const deleteHrefs = (model: DomModel): string[] =>
  model.links.filter(({ href }) => href.startsWith('./?muraAction=cfeed.update')).map(({ href }) => href);

/** A delete href's tail once `normaliseIds` has masked its tokens and feed id. */
const MASKED_DELETE_TAIL = /&csrf_token=<token>&csrf_token_expires=<token>&feedID=<id:\d+>&siteid=tenant-a$/;

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('cfeedListScreen', () => {
  it('is the strategies-content page behind the cfeed gate', () => {
    expect(cfeedListScreen).toMatchObject({
      circuit: 'cfeed',
      action: 'list',
      mode: 'page',
      owner: 'strategies-content',
      secondaryMenu: 'cfeed',
    });
    expect(cfeedListScreen.gate).toBe(cfeedGate);
    expect(cfeedListScreen.load).toBe(loadFeedList);
    expect(cfeedListScreen.render).toBe(renderFeedList);
  });

  it('renders the collections inside the shell', async () => {
    const ctx = listContext();

    const model = await renderScreenModel(cfeedListScreen, ctx);

    expect(model.headings).toEqual(expect.arrayContaining(['Collections', 'Local Indexes', 'Remote Feeds']));
    expect(model.tables.map(({ headers }) => headers)).toEqual(
      expect.arrayContaining([LOCAL_HEADERS, REMOTE_HEADERS]),
    );
    expect(ctx.gateway.calls.filter(({ path }) => path === CFEED_PATHS.list)).toHaveLength(1);
    expect(deleteHrefs(model)).toEqual([
      expect.stringMatching(MASKED_DELETE_TAIL),
      expect.stringMatching(MASKED_DELETE_TAIL),
    ]);
  });
});

describe('loadFeedList', () => {
  it('reads the site collections once and issues every row token in one identity call', async () => {
    const ctx = listContext();

    const data = await loadFeedList(ctx);

    expect(ctx.gateway.calls.map(({ service, method, path }) => `${method} ${service} ${path}`)).toEqual([
      `GET strategies-content ${CFEED_PATHS.list}`,
      'POST identity /v1/csrf/tokens',
    ]);
    expect(identityCalls(ctx).map(({ json }) => json)).toEqual([{ contexts: [LOCAL_ID, REMOTE_ID] }]);
    expect(data).toEqual({
      local: [
        {
          feedId: LOCAL_ID,
          name: 'Latest News',
          lang: 'en-us',
          maxItems: '20',
          isFeaturesOnly: 0,
          restricted: 0,
          isActive: 1,
          channelLink: '',
        },
      ],
      remote: [
        {
          feedId: REMOTE_ID,
          name: 'Partner Updates',
          lang: 'en-us',
          maxItems: '10',
          isFeaturesOnly: 0,
          restricted: 0,
          isActive: 1,
          channelLink: CHANNEL_LINK,
        },
      ],
      endpoint: feedApiEndpoint(ctx.req),
    });
    expect(data.endpoint).toMatch(/\/_api\/feed\/v1\/tenant-a$/);
  });
});

describe('renderFeedList', () => {
  it('renders the header with the list menu and both panels', async () => {
    const { $, markup, view } = await renderList();

    expect(Object.keys(view)).toEqual(['body']);
    expect(fragmentModel(markup).headings).toEqual(['Collections', 'Local Indexes', 'Remote Feeds']);
    expect($('div.mura-header > h1').text()).toBe('Collections');
    const menu = $('div.mura-header > div.nav-module-specific.btn-group > a')
      .toArray()
      .map((el) => ({ href: $(el).attr('href'), text: $(el).text().trim() }));
    expect(menu).toEqual([
      { href: `./?muraAction=cFeed.edit&feedID=&siteid=${SITE}&type=Local`, text: 'Add Local Index' },
      { href: `./?muraAction=cFeed.edit&feedID=&siteid=${SITE}&type=Remote`, text: 'Add Remote Feed' },
      {
        href: `./?muraAction=cPerm.module&contentid=${COLLECTIONS_MODULE}&siteid=${SITE}` +
          `&moduleid=${COLLECTIONS_MODULE}`,
        text: 'Permissions',
      },
    ]);
    expect(
      $('div.block-constrain > div.block-bordered > div.block-content > h2')
        .toArray()
        .map((el) => $(el).text()),
    ).toEqual(['Local Indexes', 'Remote Feeds']);
  });

  it('heads the Local and Remote tables as legacy does', async () => {
    const { $, markup } = await renderList();

    expect($('table.mura-table-grid')).toHaveLength(2);
    expect(fragmentModel(markup).tables.map(({ headers }) => headers)).toEqual([LOCAL_HEADERS, REMOTE_HEADERS]);
    const headerClasses = (index: number): string[] =>
      $('table.mura-table-grid')
        .eq(index)
        .find('th')
        .toArray()
        .map((th) => $(th).attr('class') ?? '');
    expect(headerClasses(0)).toEqual(['actions', 'var-width', 'hidden-xs', 'hidden-xs', '', '', '']);
    expect(headerClasses(1)).toEqual(['actions', 'var-width', 'url var-width', '']);
  });

  it('links a Local row to its edit, RSS and delete actions', async () => {
    const { $, ctx } = await renderList();
    const row = dataRow($, 0);
    const editHref = `./?muraAction=cFeed.edit&feedID=${LOCAL_ID}&siteid=${SITE}&type=Local`;

    expect(
      row
        .find('ul.actions-list > li')
        .toArray()
        .map((li) => $(li).attr('class')),
    ).toEqual(['edit', 'rss', 'delete']);
    expect(itemLink(row, 'edit')).toEqual({ href: editHref, text: 'Edit' });
    expect(itemLink(row, 'rss')).toEqual({
      href: `${feedApiEndpoint(ctx.req)}/?feedID=${LOCAL_ID}`,
      target: '_blank',
      text: 'View RSS',
    });
    expect(itemLink(row, 'delete')).toEqual({
      href: `./?muraAction=cFeed.update&action=delete&feedID=${LOCAL_ID}&siteid=${SITE}${URL_TOKENS}`,
      onclick: "return confirmDialog('Delete\\x20Local\\x20Index\\x3F',this.href)",
      text: 'Delete',
    });
    expect(row.find('td.var-width > a[title="Edit"]').attr('href')).toBe(editHref);
    expect(cellTexts($, row).slice(1, 4)).toEqual(['Latest News', 'en-us', '20']);
  });

  it.each<[string, Row, readonly string[]]>([
    ['the fixture flags', LOCAL_ROW, ['No', 'No', 'Yes']],
    ['inverted flags', { ...LOCAL_ROW, isfeaturesonly: 1, restricted: 1, isactive: 0 }, ['Yes', 'Yes', 'No']],
  ])('shows %s as icons titled and labelled Yes/No', async (_case, localRow, labels) => {
    const { $ } = await renderList({ ...cfeedListData.rc, rsLocal: [localRow] });

    const flags = dataRow($, 0)
      .children('td')
      .slice(4)
      .toArray()
      .map((td) => {
        const icon = $(td).find('i');
        return { icon: icon.attr('class'), title: icon.attr('title'), label: $(td).find('span').text() };
      });
    expect(flags).toEqual(
      labels.map((label) => ({ icon: label === 'Yes' ? 'mi-check' : 'mi-ban', title: label, label })),
    );
  });

  it('links a Remote row to its edit, feed, import and delete actions', async () => {
    const { $ } = await renderList();
    const row = dataRow($, 1);
    const editHref = `./?muraAction=cFeed.edit&feedID=${REMOTE_ID}&siteid=${SITE}&type=Remote`;

    expect(
      row
        .find('ul.actions-list > li')
        .toArray()
        .map((li) => $(li).attr('class')),
    ).toEqual(['edit', 'rss', 'import', 'delete']);
    expect(itemLink(row, 'edit')).toEqual({ href: editHref, text: 'Edit' });
    expect(itemLink(row, 'rss')).toEqual({ href: CHANNEL_LINK, target: '_blank', text: 'View Feed' });
    expect(itemLink(row, 'import')).toEqual({
      href: `./?muraAction=cFeed.import1&feedID=${REMOTE_ID}&siteid=${SITE}`,
      text: 'Import',
    });
    expect(itemLink(row, 'delete')).toEqual({
      href: `./?muraAction=cFeed.update&action=delete&feedID=${REMOTE_ID}&siteid=${SITE}${URL_TOKENS}`,
      onclick: "return confirmDialog('Delete\\x20Remote\\x20Feed\\x3F',this.href)",
      text: 'Delete',
    });
    expect(row.find('td.var-width > a[title="Edit"]').attr('href')).toBe(editHref);
    expect(cellTexts($, row).slice(1)).toEqual(['Partner Updates', CHANNEL_LINK, 'Yes']);
  });

  it.each<[string, Row, string, string]>([
    ['the fixture feed', REMOTE_ROW, CHANNEL_LINK, 'Yes'],
    ['a long inactive feed', { ...REMOTE_ROW, channellink: LONG_LINK, isactive: 0 }, LONG_LINK.slice(0, 70), 'No'],
  ])('shows %s with its URL cut to 70 characters and a bare Yes/No', async (_case, remoteRow, url, active) => {
    const { $ } = await renderList({ ...cfeedListData.rc, rsRemote: [remoteRow] });
    const row = dataRow($, 1);
    const link = String(remoteRow.channellink);

    expect(row.find('td.url.var-width').text()).toBe(url);
    expect(itemLink(row, 'rss').href).toBe(link);
    expect(row.children('td').last().text()).toBe(active);
    expect(row.children('td').last().find('i')).toHaveLength(0);
  });

  it('HTML-encodes the feed names', async () => {
    const { $, markup } = await renderList({
      ...cfeedListData.rc,
      rsLocal: [{ ...LOCAL_ROW, name: 'News & <Events>' }],
      rsRemote: [{ ...REMOTE_ROW, name: 'Partner <Wire> & Co' }],
    });

    expect(markup).toContain('>News &amp; &lt;Events&gt;</a>');
    expect(markup).toContain('>Partner &lt;Wire&gt; &amp; Co</a>');
    expect(dataRow($, 0).find('td.var-width > a').text()).toBe('News & <Events>');
    expect(dataRow($, 1).find('td.var-width > a').text()).toBe('Partner <Wire> & Co');
  });

  it('asks for each delete token by its feed id and masks it in the model', async () => {
    const { ctx, markup } = await renderList();

    expect(identityCalls(ctx).map(({ json }) => json)).toEqual([{ contexts: [LOCAL_ID, REMOTE_ID] }]);
    const model = normaliseIds(fragmentModel(markup));
    const masked = (id: number): string =>
      `./?muraAction=cfeed.update&action=delete&csrf_token=<token>&csrf_token_expires=<token>&feedID=<id:${id}>` +
      `&siteid=${SITE}`;
    expect(deleteHrefs(model)).toEqual([masked(1), masked(2)]);
    expect(JSON.stringify(model)).not.toContain(FIXED_CSRF.token);
  });

  it('shows both empty notices and no table without rows', async () => {
    const { $, ctx, markup } = await renderList({ ...cfeedListData.rc, rsLocal: [], rsRemote: [] });

    expect(
      $('div.block-content > div.help-block-empty')
        .toArray()
        .map((el) => $(el).text()),
    ).toEqual(['There are currently no local indexes.', 'There are currently no remote feeds.']);
    expect($('table')).toHaveLength(0);
    expect(fragmentModel(markup).headings).toEqual(['Collections', 'Local Indexes', 'Remote Feeds']);
    expect(identityCalls(ctx)).toEqual([]);
  });
});
