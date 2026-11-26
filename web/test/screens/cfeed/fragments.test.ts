// cFeed.loadSite and cFeed.siteParents for the tenant-a site admin: strategies-content's fragment bytes, unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGate } from '@/lib/access-gate';
import type { ServicePath } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { cfeedGate } from '@/screens/cfeed/before';
import { cfeedLoadSiteScreen } from '@/screens/cfeed/loadsite';
import { cfeedSiteParentsScreen } from '@/screens/cfeed/siteparents';
import type { FragmentScreen, RawBody } from '@/screens/registry';
import { CONTENT_IDS } from '../../fixtures/strategies-content/carch';
import { siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

const LOADSITE_PATH = '/v1/raw/cfeed/loadsite';
const SITEPARENTS_PATH = '/v1/raw/cfeed/siteparents';
const VIEW_TYPE = 'text/html;charset=UTF-8';
const NEWS = CONTENT_IDS.news;

// loadsite.cfm searching "news" over the tenant-a and umbrella pool: CRLF, entities, non-ASCII, no trailing newline.
const LOADSITE_BODY = [
  '',
  '',
  '\t<div id="contentSearch" class="form-inline">',
  '\t\t',
  '\t\t<div class="mura-input-set">',
  '\t\t\t<input class="form-control" id="parentSearch" name="parentSearch" value="news" type="text" maxlength="50" placeholder="Search" onclick="return false;">',
  `\t\t\t<button type="button" class="btn btn-default" onclick="feedManager.loadSiteFilters('tenant-a',document.getElementById('parentSearch').value,0,$('#contentPoolID').val());"><i class="mi-search"></i></button>`,
  '\t\t</div>\t',
  '\t</div>',
  '',
  '\t\t<div class="mura-control justify">',
  '\t\t\t<table class="mura-table-grid">',
  '\t\t\t\t<thead>',
  '\t\t\t\t\t<tr> ',
  '\t\t\t\t\t\t<th class="actions"></th>',
  '\t\t\t\t\t\t<th class="var-width">',
  '\t\t\t\t\t\t\tTenant A: Select Section',
  '\t\t\t\t\t\t</th>',
  '\t\t\t\t\t</tr>',
  '\t\t\t\t</thead>',
  '\t\t\t\t<tbody>',
  '\t\t\t\t\t\t\t\t<tr >',
  '\t\t\t\t\t\t\t\t\t<td class="actions">',
  `\t\t\t\t\t\t\t\t\t\t<ul><li class="add"><a title="Add" href="javascript:;" onClick="feedManager.addContentFilter('${NEWS}','Folder','mura-opt-${NEWS}'); return false;"><i class="mi-plus-circle"></i></a></li></ul>`,
  '\t\t\t\t\t\t\t\t\t</td>',
  `\t\t\t\t\t\t\t\t\t<td class="var-width" id="mura-opt-${NEWS}"><ul class="navZoom"><li class="mi-file "> Home &raquo;</li><li class="mi-folder "> <strong>News &amp; Café</strong></li></ul></td>`,
  '\t\t\t\t\t\t\t\t</tr>',
  '\t\t\t\t</tbody>',
  '\t\t\t</table>',
  '\t\t\t\t\t<table class="mura-table-grid">',
  '\t\t\t\t\t\t<thead>',
  '\t\t\t\t\t\t\t<tr> ',
  '\t\t\t\t\t\t\t\t<th class="var-width">',
  '\t\t\t\t\t\t\t\t\tUmbrella: Select Section',
  '\t\t\t\t\t\t\t\t</th>',
  '\t\t\t\t\t\t\t\t<th class="actions">&nbsp;</th>',
  '\t\t\t\t\t\t\t</tr>',
  '\t\t\t\t\t\t</thead>',
  '\t\t\t\t\t\t<tbody>',
  '\t\t\t\t\t\t\t\t\t<tr class="alt"> ',
  '\t\t\t\t\t\t\t\t\t\t<td class="noResults" colspan="2">Your search returned no results.</td>',
  '\t\t\t\t\t\t\t\t\t</tr>',
  '\t\t\t\t\t\t</tbody>',
  '\t\t\t\t\t</table>',
  '\t\t\t\t</div><!-- /.mura-control -->',
].join('\r\n');

// siteparents.cfm's new-location box under the hu bundle ("Keresés"), parent News.
const SITEPARENTS_BODY = [
  '',
  '<div id="contentSearch" class="form-inline">',
  '\t<div class="mura-input-set">',
  '\t<input id="parentSearch" name="parentSearch" value="" type="text" maxlength="50" placeholder="Search Content" onclick="return false;"> ',
  `\t<input type="button" class="btn" onclick="feedManager.loadSiteParents('tenant-a','${NEWS}',document.getElementById('parentSearch').value,0);" value="Keresés">`,
  '\t</div>',
  '</div>',
  `<input type="hidden" name="parentid" value="${NEWS}" />`,
].join('\r\n');

const NOT_FOUND_BODY = '\r\n\t<h1>Not Found</h1>';

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** `feed.js`'s request for cFeed `item` carrying `rc`, as the tenant-a site admin on a feed-manager site. */
const feedRequest = (item: string, rc: Readonly<Record<string, string>>): AdminRequest =>
  siteAdminRequest('tenant-a', { circuit: 'cFeed', item, rc, site: { hasFeedManager: true } });

/** Every rc field of `req` under its own name. */
const rcFields = (req: AdminRequest): Record<string, string> => Object.fromEntries(Object.entries(req.rc));

const viewReply = (body: string, status = 200): FakeReply => ({ status, headers: { 'content-type': VIEW_TYPE }, body });

const render = async (screen: FragmentScreen, req: AdminRequest, gateway: FakeGatewayClient): Promise<RawBody> =>
  screen.render(makeScreenContext({ req, gateway }), undefined);

/** The relayed bytes decoded as UTF-8. */
function bodyText(raw: RawBody): string {
  if (!(raw.body instanceof Uint8Array)) throw new TypeError('Expected the relayed bytes');
  return Buffer.from(raw.body).toString('utf8');
}

describe.each<{
  screen: FragmentScreen;
  action: string;
  item: string;
  path: ServicePath;
  rc: Readonly<Record<string, string>>;
  query: (req: AdminRequest) => Readonly<Record<string, string>>;
  body: string;
}>([
  {
    screen: cfeedLoadSiteScreen,
    action: 'loadsite',
    item: 'loadSite',
    path: LOADSITE_PATH,
    rc: { siteid: 'tenant-a', keywords: 'news', isNew: '0', contentpoolid: 'tenant-a,umbrella' },
    query: rcFields,
    body: LOADSITE_BODY,
  },
  {
    screen: cfeedSiteParentsScreen,
    action: 'siteparents',
    item: 'siteParents',
    path: SITEPARENTS_PATH,
    rc: { siteid: 'tenant-a', parentid: NEWS, keywords: '', isNew: '1' },
    query: () => ({ siteid: 'tenant-a', parentid: NEWS, keywords: '', isNew: '1', compactDisplay: 'false' }),
    body: SITEPARENTS_BODY,
  },
])('cfeed.$action', ({ screen, action, item, path, rc, query, body }) => {
  const route = routeKey('GET', 'strategies-content', path);

  it('is a strategies-content fragment under cfeedGate', () => {
    expect(screen).toMatchObject({
      circuit: 'cfeed',
      action,
      mode: 'fragment',
      owner: 'strategies-content',
      gate: cfeedGate,
    });
  });

  it('admits the tenant-a site admin', async () => {
    expect(await runGate(feedRequest(item, rc), screen.gate)).toEqual({ kind: 'allow' });
  });

  it('forwards the rc in one GET and relays the bytes unchanged', async () => {
    const gateway = fakeGatewayClient({ [route]: viewReply(body) });
    const req = feedRequest(item, rc);

    const raw = await render(screen, req, gateway);

    expect(gateway.calls).toEqual([{ service: 'strategies-content', method: 'GET', path, query: query(req) }]);
    expect(gateway.calls[0]?.query).toMatchObject(rc);
    expect(raw).toEqual({ status: 200, contentType: VIEW_TYPE, body: Buffer.from(body, 'utf8') });
    expect(bodyText(raw)).toBe(body);
    expect(bodyText(raw)).not.toMatch(/<html|mura-admin|<script/i);
  });

  it('passes a 404 and its body through', async () => {
    const gateway = fakeGatewayClient({ [route]: viewReply(NOT_FOUND_BODY, 404) });

    const raw = await render(screen, feedRequest(item, rc), gateway);

    expect(raw).toEqual({ status: 404, contentType: VIEW_TYPE, body: Buffer.from(NOT_FOUND_BODY, 'utf8') });
  });
});

describe('cfeedLoadSiteScreen', () => {
  it('leaves keywords, isNew and contentpoolid to the view defaults', async () => {
    const gateway = fakeGatewayClient({ [routeKey('GET', 'strategies-content', LOADSITE_PATH)]: viewReply('') });
    const req = feedRequest('loadSite', { siteid: 'tenant-a' });

    await render(cfeedLoadSiteScreen, req, gateway);

    expect(gateway.calls).toHaveLength(1);
    const query = gateway.calls[0]?.query ?? {};
    expect(query).toEqual(rcFields(req));
    expect(query).toMatchObject({ siteid: 'tenant-a', muraAction: 'core:cfeed.loadsite' });
    expect(Object.keys(query).filter((name) => /^(keywords|isnew|contentpoolid)$/i.test(name))).toEqual([]);
  });
});
