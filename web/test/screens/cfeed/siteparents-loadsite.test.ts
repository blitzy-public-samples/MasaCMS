// cFeed.siteParents and cFeed.loadSite against cfeed/siteparents.cfm and cfeed/loadsite.cfm: strategies-content's
// fragment bytes, relayed unchanged under the cfeed `before()` gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGate, type GateDecision } from '@/lib/access-gate';
import { GatewayDenialError, GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { cfeedGate } from '@/screens/cfeed/before';
import { cfeedLoadSiteScreen } from '@/screens/cfeed/loadsite';
import { cfeedSiteParentsScreen } from '@/screens/cfeed/siteparents';
import type { FragmentScreen, RawBody } from '@/screens/registry';
import { SITE_IDS, siteDefault } from '../../fixtures/programs-sites/sites';
import { adminS2Request, editorRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel, type DomTable } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

const SITEPARENTS_PATH = '/v1/raw/cfeed/siteparents';
const LOADSITE_PATH = '/v1/raw/cfeed/loadsite';
const SITEPARENTS_ROUTE = routeKey('GET', 'strategies-content', SITEPARENTS_PATH);
const LOADSITE_ROUTE = routeKey('GET', 'strategies-content', LOADSITE_PATH);
// The views' default content type, as the ACF 2023 oracle sends it.
const VIEW_TYPE = 'text/html;charset=UTF-8';
const HOME_ID = '00000000000000000000000000000000001';
const FEED_SITE: AdminRequestPartial['site'] = { hasFeedManager: siteDefault.feedManager === 1 };

/** siteparents.cfm's search box holding `keywords`, its button searching again under `parentid`. */
const parentSearchBox = (keywords: string, parentid: string): string[] => [
  '',
  '<div id="contentSearch" class="form-inline">',
  '\t<div class="mura-input-set">',
  `\t<input id="parentSearch" name="parentSearch" value="${keywords}" type="text" maxlength="50" placeholder="Search Content" onclick="return false;"> `,
  `\t<input type="button" class="btn" onclick="feedManager.loadSiteParents('default','${parentid}',document.getElementById('parentSearch').value,0);" value="Search">`,
  '\t</div>',
  '</div>',
];

const PARENT_TABLE_HEAD = [
  '',
  ' <table class="mura-table-grid">',
  '    <thead>',
  '    <tr> ',
  '\t  <th class="actions"></th>',
  '    <th class="var-width">Select Section</th>',
  '    </tr>',
  '    </thead>',
  '    ',
];

// The oracle's `default` answers: the edit screen's first load, a search for "home" without a parent, and a miss.
const PARENTS_NEW = [
  ...parentSearchBox('', HOME_ID),
  `<input type="hidden" name="parentid" value="${HOME_ID}" /> `,
].join('\n');
const PARENTS_FOUND = [
  ...parentSearchBox('home', ''),
  ...PARENT_TABLE_HEAD,
  '    <tbody>',
  '\t<tr class="alt">  ',
  '\t  <td class="actions"><input type="radio" name="parentid" value="" checked="checked"></td>',
  '\t\t',
  '\t\t  <td class="var-width">None Selected</td>',
  '\t\t ',
  '\t\t</tr> ',
  '\t\t<tr >  ',
  `\t\t  <td class="actions"><input type="radio" name="parentid" value="${HOME_ID}"></td>`,
  '      <td class="var-width">',
  '\t\t<ul class="navZoom">',
  '\t\t',
  '\t\t<li class="mi-file "> <strong>Home</strong></li>',
  '\t\t</ul></td>',
  '\t\t</tr>',
  '\t ',
  '\t\t</tbody>',
  '  </table>',
  '',
].join('\n');
const PARENTS_NONE = [
  ...parentSearchBox('zzzqqq', HOME_ID),
  ...PARENT_TABLE_HEAD,
  '\t\t<tr class="alt">  ',
  `\t\t  <td class="noResults" colspan="2">Your search returned no results.<input type="hidden" name="parentid" value="${HOME_ID}" /> </td>`,
  '\t\t</tr> ',
  '\t\t</tbody>',
  '  </table>',
  '',
].join('\n');
// The view's answer to a request without `parentid`, abridged.
const PARENTS_ERROR = '<h1>500 Error</h1><h2>Element PARENTID is undefined in RC.<br /></h2>';

/** loadsite.cfm's search box holding `keywords`. */
const filterSearchBox = (keywords: string): string[] => [
  '',
  '\t<div id="contentSearch" class="form-inline">',
  '\t\t',
  '\t\t<div class="mura-input-set">',
  `\t\t\t<input class="form-control" id="parentSearch" name="parentSearch" value="${keywords}" type="text" maxlength="50" placeholder="Search" onclick="return false;">`,
  `\t\t\t<button type="button" class="btn btn-default" onclick="feedManager.loadSiteFilters('default',document.getElementById('parentSearch').value,0,$('#contentPoolID').val());"><i class="mi-search"></i></button>`,
  '\t\t</div>\t',
  '\t</div>',
  '',
];

const FILTER_TABLE_HEAD = [
  '\t\t<div class="mura-control justify">',
  '\t\t\t<table class="mura-table-grid">',
  '\t\t\t\t<thead>',
  '\t\t\t\t\t<tr> ',
  '\t\t\t\t\t\t<th class="actions"></th>',
  '\t\t\t\t\t\t<th class="var-width">',
  `\t\t\t\t\t\t\t${siteDefault.Site}: Select Section`,
  '\t\t\t\t\t\t</th>',
  '\t\t\t\t\t</tr>',
  '\t\t\t\t</thead>',
  '\t\t\t\t<tbody>',
  '\t\t\t\t\t',
];
const FILTER_TABLE_FOOT = ['\t\t\t\t</tbody>', '\t\t\t</table>', '\t\t'];

// The oracle's `default` answers: the edit screen's first load, a search for "home", and a miss.
const FILTERS_NEW = filterSearchBox('').join('\n');
const FILTERS_FOUND = [
  ...filterSearchBox('home'),
  ...FILTER_TABLE_HEAD,
  '\t\t\t\t\t\t\t\t<tr >',
  '\t\t\t\t\t\t\t\t\t<td class="actions">',
  `\t\t\t\t\t\t\t\t\t\t<ul><li class="add"><a title="Add" href="javascript:;" onClick="feedManager.addContentFilter('${HOME_ID}','Page','mura\\x2Dopt\\x2D${HOME_ID}'); return false;"><i class="mi-plus-circle"></i></a></li></ul>`,
  '\t\t\t\t\t\t\t\t\t</td>',
  `\t\t\t\t\t\t\t\t\t<td class="var-width" id="mura-opt-${HOME_ID}">`,
  '\t\t<ul class="navZoom">',
  '\t\t',
  '\t\t<li class="mi-file "> <strong>Home</strong></li>',
  '\t\t</ul></td>',
  '\t\t\t\t\t\t\t\t</tr>',
  '\t\t\t\t\t\t\t',
  ...FILTER_TABLE_FOOT,
].join('\n');
const FILTERS_NONE = [
  ...filterSearchBox('zzzqqq'),
  ...FILTER_TABLE_HEAD,
  '\t\t\t\t\t\t\t<tr class="alt"> ',
  '\t\t\t\t\t\t\t\t<td class="noResults" colspan="2">Your search returned no results.</td>',
  '\t\t\t\t\t\t\t</tr>',
  '\t\t\t\t\t\t',
  ...FILTER_TABLE_FOOT,
].join('\n');

const PARENT_HEADERS = ['', 'Select Section'];
const FILTER_HEADERS = ['', `${siteDefault.Site}: Select Section`];

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** `feed.js`'s request for cFeed `item` carrying `rc`, as S2 on `default`, whose feed manager is on. */
const feedRequest = (item: string, rc: Readonly<Record<string, string>> = {}): AdminRequest =>
  adminS2Request({ circuit: 'cFeed', item, rc, site: FEED_SITE });

/** The owner's answer of `body` under the view content type. */
const viewReply = (body: string, status = 200): FakeReply => ({ status, headers: { 'content-type': VIEW_TYPE }, body });

/** `screen`'s answer to `req` over `gateway`, in the context the admin handlers build. */
const render = async (screen: FragmentScreen, req: AdminRequest, gateway: FakeGatewayClient): Promise<RawBody> =>
  screen.render(makeScreenContext({ req, gateway }), undefined);

/** The relayed body as text, which the screens hand over as bytes. */
function bodyText(raw: RawBody): string {
  if (!(raw.body instanceof Uint8Array)) throw new TypeError('Expected the relayed bytes');
  return Buffer.from(raw.body).toString('utf8');
}

type ControlRow = [name: string, type: string, value: string, checked: boolean];

/** Name, type, value and checked flag of each form control of `html`. */
const controlsOf = (html: string): ControlRow[] =>
  fragmentModel(html).controls.map((control) => [control.name, control.type, control.value, control.checked]);

describe.each<{
  screen: FragmentScreen;
  action: string;
  item: string;
  path: ServicePath;
  route: string;
  view: string;
}>([
  {
    screen: cfeedSiteParentsScreen,
    action: 'siteparents',
    item: 'siteParents',
    path: SITEPARENTS_PATH,
    route: SITEPARENTS_ROUTE,
    view: PARENTS_NEW,
  },
  {
    screen: cfeedLoadSiteScreen,
    action: 'loadsite',
    item: 'loadSite',
    path: LOADSITE_PATH,
    route: LOADSITE_ROUTE,
    view: FILTERS_NEW,
  },
])('cfeed.$action', ({ screen, action, item, path, route, view }) => {
  it('declares a strategies-content fragment under the cfeed gate', () => {
    expect(screen).toMatchObject({
      circuit: 'cfeed',
      action,
      mode: 'fragment',
      owner: 'strategies-content',
      gate: cfeedGate,
    });
    expect(screen.load).toBeUndefined();
    expect(Object.isFrozen(screen)).toBe(true);
  });

  it.each<[string, () => AdminRequest, GateDecision]>([
    ['S2 on a site with the feed manager', () => feedRequest(item), { kind: 'allow' }],
    [
      'qa_editor without collections access',
      () => editorRequest({ circuit: 'cFeed', item, site: FEED_SITE }),
      { kind: 'redirect', location: './' },
    ],
    [
      'S2 on a site without the feed manager',
      () => adminS2Request({ circuit: 'cFeed', item }),
      { kind: 'redirect', location: './' },
    ],
  ])('gates %s', async (_label, request, decision) => {
    expect(await runGate(request(), screen.gate)).toEqual(decision);
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i instead of relaying it', async (status) => {
    const gateway = fakeGatewayClient({ [route]: viewReply('{}', status) });

    const error = await render(screen, feedRequest(item), gateway).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'strategies-content', status, operation: `GET ${path}` });
    expect(gateway.calls).toHaveLength(1);
  });

  it('fails on an answer without a Content-Type', async () => {
    const gateway = fakeGatewayClient({ [route]: { status: 200, body: view } });

    const error = await render(screen, feedRequest(item), gateway).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(`strategies-content answered GET ${path} without a Content-Type`);
  });

  it.each<{ outage: string; status?: number; arrange: (gateway: FakeGatewayClient) => void }>([
    { outage: 'no answer', arrange: (gateway) => gateway.failWith() },
    ...[502, 503, 504].map((status) => ({
      outage: `HTTP ${status}`,
      status,
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(route, { status, body: {} }),
    })),
  ])('raises GatewayUnavailableError on $outage', async ({ status, arrange }) => {
    const gateway = fakeGatewayClient();
    arrange(gateway);

    const error = await render(screen, feedRequest(item), gateway).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ service: 'strategies-content' });
    expect((error as GatewayUnavailableError).status).toBe(status);
  });
});

describe('cfeedSiteParentsScreen', () => {
  it.each<{ name: string; rc: Readonly<Record<string, string>>; query: Readonly<Record<string, string>> }>([
    {
      name: "the edit screen's new-location button",
      rc: {
        compactDisplay: 'true',
        siteid: SITE_IDS.default,
        parentid: HOME_ID,
        keywords: '',
        isNew: '1',
        cacheid: '0.25',
      },
      query: {
        siteid: 'default',
        parentid: HOME_ID,
        keywords: '',
        isNew: '1',
        compactDisplay: 'true',
        cacheid: '0.25',
      },
    },
    {
      name: 'a search on tenant-a, fields in any case',
      rc: { siteid: SITE_IDS.tenantA, PARENTID: '', Keywords: 'a&b c', ISNEW: '0', CacheID: '0.5', startrow: '3' },
      query: {
        siteid: 'tenant-a',
        parentid: '',
        keywords: 'a&b c',
        isNew: '0',
        compactDisplay: 'false',
        cacheid: '0.5',
      },
    },
    {
      name: 'the before() defaults alone',
      rc: {},
      query: { siteid: 'default', keywords: '', compactDisplay: 'false' },
    },
  ])('forwards siteid and the view fields of $name, nothing else', async ({ rc, query }) => {
    const gateway = fakeGatewayClient({ [SITEPARENTS_ROUTE]: viewReply(PARENTS_NEW) });

    await render(cfeedSiteParentsScreen, feedRequest('siteParents', rc), gateway);

    expect(gateway.calls).toEqual([{ service: 'strategies-content', method: 'GET', path: SITEPARENTS_PATH, query }]);
    expect(Object.keys(gateway.calls[0]?.query ?? {})).toEqual(Object.keys(query));
  });

  it.each<{
    name: string;
    rc: Readonly<Record<string, string>>;
    status: number;
    body: string;
    controls: ControlRow[];
    tables: DomTable[];
  }>([
    {
      name: 'the new-location box',
      rc: { parentid: HOME_ID, keywords: '', isNew: '1' },
      status: 200,
      body: PARENTS_NEW,
      controls: [
        ['parentSearch', 'text', '', false],
        ['parentid', 'hidden', HOME_ID, false],
      ],
      tables: [],
    },
    {
      name: 'found sections',
      rc: { parentid: '', keywords: 'home', isNew: '0' },
      status: 200,
      body: PARENTS_FOUND,
      controls: [
        ['parentSearch', 'text', 'home', false],
        ['parentid', 'radio', '', true],
        ['parentid', 'radio', HOME_ID, false],
      ],
      tables: [{ headers: PARENT_HEADERS, rows: [['', 'None Selected'], ['', 'Home']] }],
    },
    {
      name: 'no search results',
      rc: { parentid: HOME_ID, keywords: 'zzzqqq', isNew: '0' },
      status: 200,
      body: PARENTS_NONE,
      controls: [
        ['parentSearch', 'text', 'zzzqqq', false],
        ['parentid', 'hidden', HOME_ID, false],
      ],
      tables: [{ headers: PARENT_HEADERS, rows: [['Your search returned no results.']] }],
    },
    { name: 'the error page', rc: { keywords: 'home' }, status: 500, body: PARENTS_ERROR, controls: [], tables: [] },
  ])('relays $name with its status, content type and bytes unchanged', async (answer) => {
    const { rc, status, body, controls, tables } = answer;
    const gateway = fakeGatewayClient({ [SITEPARENTS_ROUTE]: viewReply(body, status) });

    const raw = await render(cfeedSiteParentsScreen, feedRequest('siteParents', rc), gateway);

    expect(raw).toEqual({ status, contentType: VIEW_TYPE, body: Buffer.from(body) });
    expect(controlsOf(bodyText(raw))).toEqual(controls);
    expect(fragmentModel(bodyText(raw)).tables).toEqual(tables);
  });
});

describe('cfeedLoadSiteScreen', () => {
  it.each<{ name: string; rc: Readonly<Record<string, string>> }>([
    {
      name: "the edit screen's select button",
      rc: {
        compactDisplay: 'true',
        siteid: SITE_IDS.default,
        keywords: '',
        isNew: '1',
        contentPoolID: SITE_IDS.default,
        cacheid: '0.25',
      },
    },
    {
      name: 'a pooled search on tenant-a',
      rc: {
        siteid: SITE_IDS.tenantA,
        keywords: 'a&b c',
        isNew: '0',
        contentPoolID: `${SITE_IDS.tenantA},${SITE_IDS.tenantB}`,
        cacheid: '0.5',
      },
    },
  ])('forwards every rc field of $name under its own name', async ({ rc }) => {
    const gateway = fakeGatewayClient({ [LOADSITE_ROUTE]: viewReply(FILTERS_NEW) });
    const req = feedRequest('loadSite', rc);

    await render(cfeedLoadSiteScreen, req, gateway);

    const query = Object.fromEntries(Object.entries(req.rc));
    expect(gateway.calls).toEqual([{ service: 'strategies-content', method: 'GET', path: LOADSITE_PATH, query }]);
    expect(query).toMatchObject({ ...rc, muraAction: 'core:cfeed.loadsite' });
  });

  it.each<{ name: string; isNew: string; keywords: string; body: string; tables: DomTable[] }>([
    { name: 'the search box', isNew: '1', keywords: '', body: FILTERS_NEW, tables: [] },
    {
      name: 'found content',
      isNew: '0',
      keywords: 'home',
      body: FILTERS_FOUND,
      tables: [{ headers: FILTER_HEADERS, rows: [['', 'Home']] }],
    },
    {
      name: 'no search results',
      isNew: '0',
      keywords: 'zzzqqq',
      body: FILTERS_NONE,
      tables: [{ headers: FILTER_HEADERS, rows: [['Your search returned no results.']] }],
    },
  ])('relays $name with its status, content type and bytes unchanged', async ({ isNew, keywords, body, tables }) => {
    const gateway = fakeGatewayClient({ [LOADSITE_ROUTE]: viewReply(body) });
    const rc = { keywords, isNew, contentPoolID: SITE_IDS.default };

    const raw = await render(cfeedLoadSiteScreen, feedRequest('loadSite', rc), gateway);

    expect(raw).toEqual({ status: 200, contentType: VIEW_TYPE, body: Buffer.from(body) });
    expect(controlsOf(bodyText(raw))).toEqual([['parentSearch', 'text', keywords, false]]);
    expect(fragmentModel(bodyText(raw)).tables).toEqual(tables);
  });
});
