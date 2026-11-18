// cchain.pending loader, markup and registry entry against cchain/pending.cfm (77-192) and dspZoom.
import { cfLsDateFormat, cfLsTimeFormat, cfUuid } from '@opt2/platform/legacy-compat';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLegacyDate } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import type { ServicePath } from '@/lib/gateway-client';
import { encodeJs, encodeUrl, toString } from '@/lib/html';
import { cchainScreens, withCchainDefaults } from '@/screens/cchain';
import {
  loadCchainPending,
  renderCchainPending,
  type CchainPendingData,
  type CchainPendingRequest,
} from '@/screens/cchain/pending';
import { APPROVAL_CHAIN_IDS, cchainPendingData } from '../../fixtures/strategies-content/approval-chains';
import { CONTENT_HIST_IDS, CONTENT_IDS } from '../../fixtures/strategies-content/carch';
import { siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

// A spy over the real generator: strategies-content is routed by chain id, so a drawn id is routed as it is drawn.
vi.mock('@opt2/platform/legacy-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/legacy-compat')>();
  return { ...actual, cfUuid: vi.fn(actual.cfUuid) };
});

const { cfUuid: drawCfUuid } =
  await vi.importActual<typeof import('@opt2/platform/legacy-compat')>('@opt2/platform/legacy-compat');

type PendingModel = typeof cchainPendingData;
type Wire = Readonly<Record<string, unknown>>;
type Ctx = ReturnType<typeof makeScreenContext>;
type Rc = Readonly<Record<string, string>>;

const SITE = 'tenant-a';
const CHAIN_ID = APPROVAL_CHAIN_IDS.standard;
const SITE_MANAGER = '00000000000000000000000000000000000';
const ROOT_ID = '00000000000000000000000000000000001';
const REVIEW_CHANGESET_ID = '5C000000-0003-4000-8000000000000010';
const PREVIEW_URL = `http://${SITE}.localhost:8100/about-us/?previewid=${CONTENT_HIST_IDS.aboutUsDraft}`;
// strategies-content `listPendingApprovals`: the chain id travels in the path, not as a query field.
const PENDING_PATH: ServicePath = `/v1/sites/${SITE}/approval-chains/${CHAIN_ID}/pending`;
const ASSIGNMENTS_HREF = `./?muraAction=cChangesets.assignments&siteID=${SITE}&changesetID=${REVIEW_CHANGESET_ID}`;

const WIRE: Wire = cchainPendingData.rc;
const CHAIN = WIRE.chain as Wire;
const [EDITORS, PUBLISHERS] = WIRE.members as readonly [Wire, Wire];
const [ABOUT_US] = EDITORS.requests as readonly [Wire];

const LOADED: CchainPendingData = {
  chain: {
    chainId: CHAIN_ID,
    name: 'Standard Publishing',
    description: 'Two-step review for public pages: content editors first, then content publishers.',
    isNew: false,
  },
  hasChangesets: true,
  members: [
    {
      groupName: 'Content Editors',
      requests: [
        {
          contentHistId: CONTENT_HIST_IDS.aboutUsDraft,
          contentId: CONTENT_IDS.aboutUs,
          type: 'Page',
          parentId: ROOT_ID,
          siteId: SITE,
          moduleId: SITE_MANAGER,
          changesetId: REVIEW_CHANGESET_ID,
          changesetName: 'Q3 Content Review',
          changesetPublishDate: '2026-07-15T09:00:00.000',
          lastUpdateBy: 'Quinn Editor',
          created: '2026-06-30T09:45:00.000',
          previewUrl: PREVIEW_URL,
          crumbs: [
            {
              menutitle: 'About Us',
              siteid: SITE,
              contentid: CONTENT_IDS.aboutUs,
              moduleid: SITE_MANAGER,
              type: 'Page',
              restricted: false,
              icon: 'mi-file',
            },
            {
              menutitle: 'Home',
              siteid: SITE,
              contentid: ROOT_ID,
              moduleid: SITE_MANAGER,
              type: 'Page',
              restricted: false,
              icon: 'mi-file',
            },
          ],
        },
      ],
    },
    { groupName: 'Content Publishers', requests: [] },
  ],
};

/** The fixture screen model with `rc` members replaced. */
const model = (rc: Wire): PendingModel => ({ rc: { ...WIRE, ...rc } });

/** The fixture model whose Content Editors request carries `request`'s values. */
const withEditorsRequest = (request: Wire): PendingModel =>
  model({ members: [{ ...EDITORS, requests: [{ ...ABOUT_US, ...request }] }, PUBLISHERS] });

const pendingRequest = (rc: Rc) =>
  siteAdminRequest(SITE, {
    circuit: 'cchain',
    item: 'pending',
    rc: withCchainDefaults({ chainid: CHAIN_ID, ...rc }),
  });

/** A site-admin context whose strategies-content answers `pending` on the chain's pending path. */
function contextFor(pending: PendingModel = cchainPendingData, rc: Rc = {}): Ctx {
  const gateway = fakeGatewayClient({
    [routeKey('GET', 'strategies-content', PENDING_PATH)]: { status: 200, body: pending },
  });
  return makeScreenContext({ req: pendingRequest(rc), gateway });
}

interface RenderedPending {
  readonly ctx: Ctx;
  readonly data: CchainPendingData;
  readonly $: CheerioAPI;
  readonly dom: DomModel;
}

/** Loads `pending` through the fake gateway and renders the view body. */
async function renderPending(pending?: PendingModel, rc?: Rc): Promise<RenderedPending> {
  const ctx = contextFor(pending, rc);
  const data = await loadCchainPending(ctx);
  const markup = toString(renderCchainPending(ctx, data).body);
  return { ctx, data, $: cheerio.load(markup, null, false), dom: fragmentModel(markup) };
}

const requestsOf = (data: CchainPendingData): readonly CchainPendingRequest[] =>
  data.members.flatMap((member) => member.requests);

const requestRows = ($: CheerioAPI) =>
  $('table.mura-table-grid tr').filter((_, tr) => $(tr).children('td').length > 0);

const cellOf = ($: CheerioAPI, row: number, cell: number) => requestRows($).eq(row).children('td').eq(cell);

const trimmed = ($: CheerioAPI, selector: string): string[] =>
  $(selector)
    .toArray()
    .map((el) => $(el).text().trim());

const target = (request: CchainPendingRequest): string =>
  `&contentid=${request.contentId}&type=${encodeUrl(request.type)}&parentid=${request.parentId}` +
  `&siteid=${encodeUrl(request.siteId)}&moduleid=${request.moduleId}`;

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  vi.mocked(cfUuid).mockReset();
  restore();
});

describe('loadCchainPending', () => {
  it('reads the chain pending requests in one strategies-content call', async () => {
    const ctx = contextFor();

    await expect(loadCchainPending(ctx)).resolves.toEqual(LOADED);
    expect(ctx.req.action).toBe('core:cchain.pending');
    expect(ctx.gateway.calls).toEqual([{ service: 'strategies-content', method: 'GET', path: PENDING_PATH }]);
  });

  it('reads an empty chain id as a fresh CF UUID and links that new chain to its edit form', async () => {
    const gateway = fakeGatewayClient({});
    const drawn: string[] = [];
    vi.mocked(cfUuid).mockImplementation(() => {
      const id = drawCfUuid();
      drawn.push(id);
      // strategies-content answers the new bean `loadBy` leaves for an unknown id, without members.
      const chain = { chainID: id, siteID: '', name: '', description: '', isNew: true, errors: {} };
      gateway.setRoute(routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/approval-chains/${id}/pending`), {
        status: 200,
        body: model({ chainid: id, chain, members: [] }),
      });
      return id;
    });
    const ctx = makeScreenContext({ req: pendingRequest({ chainid: '' }), gateway });

    const data = await loadCchainPending(ctx);
    const $ = cheerio.load(toString(renderCchainPending(ctx, data).body), null, false);

    expect(drawn).toHaveLength(1);
    const id = drawn[0] ?? '';
    expect(id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/);
    expect(ctx.gateway.calls).toEqual([
      { service: 'strategies-content', method: 'GET', path: `/v1/sites/${SITE}/approval-chains/${id}/pending` },
    ]);
    expect(ctx.req.rc.chainid).toBe('');
    expect($('div.mura-header .nav-module-specific a.btn[title="View Edit Form"]').attr('href')).toBe(
      `./?muraAction=cchain.edit&siteid=${SITE}&chainID=${id}`,
    );
  });
});

describe('renderCchainPending', () => {
  it('renders the pending toolbar', async () => {
    const { $ } = await renderPending();

    expect($('div.mura-header > h1').text()).toBe('Approval Chains');
    const links = $('div.mura-header .nav-module-specific a.btn')
      .toArray()
      .map((a) => ({ href: $(a).attr('href'), text: $(a).text().trim() }));
    expect(links).toEqual([
      { href: `./?muraAction=cchain.list&siteid=${SITE}`, text: 'Back to Approval Chains' },
      { href: `./?muraAction=cchain.edit&siteid=${SITE}&chainID=${CHAIN_ID}`, text: 'View Edit Form' },
    ]);
  });

  it('renders the headings and description', async () => {
    const { $, dom, data } = await renderPending();

    expect(dom.headings).toEqual([
      'Approval Chains',
      'Pending Requests',
      'Standard Publishing',
      '1. Content Editors',
      '2. Content Publishers',
    ]);
    expect($('h3').next().is('p')).toBe(true);
    expect(trimmed($, 'p')).toEqual([data.chain.description]);
  });

  it('omits an empty description', async () => {
    const { $, dom } = await renderPending(model({ chain: { ...CHAIN, description: '' } }));

    expect($('p')).toHaveLength(0);
    expect(dom.headings.slice(0, 3)).toEqual(['Approval Chains', 'Pending Requests', 'Standard Publishing']);
  });

  it('opens the members with one rule and numbers them', async () => {
    const { $, data } = await renderPending();

    expect($('hr')).toHaveLength(1);
    expect($('hr').next().is('h4')).toBe(true);
    expect($('h4').first().prevAll('hr')).toHaveLength(1);
    expect(trimmed($, 'h4')).toEqual(data.members.map((member, index) => `${index + 1}. ${member.groupName}`));
  });

  it('renders the request table with a change-set column', async () => {
    const { dom } = await renderPending();

    expect(dom.tables).toEqual([
      {
        headers: ['', 'Title', 'Change Set', 'Request By', 'Request Date'],
        rows: [
          ['Edit Preview Version History', 'Home About Us', 'Q3 Content Review', 'Quinn Editor', '06/181/2026 9:45:00 AM'],
        ],
      },
    ]);
  });

  it('omits the change-set column without change sets', async () => {
    const { $, dom } = await renderPending(model({ hasChangesets: false }));

    expect(dom.tables.map((table) => table.headers)).toEqual([['', 'Title', 'Request By', 'Request Date']]);
    expect(dom.tables[0]?.rows).toEqual([
      ['Edit Preview Version History', 'Home About Us', 'Quinn Editor', '06/181/2026 9:45:00 AM'],
    ]);
    expect($('a[href*="cChangesets.assignments"], i.mi-calendar')).toHaveLength(0);
  });

  it('links each request to its edit and version-history views', async () => {
    const { $, data } = await renderPending();
    const requests = requestsOf(data);

    expect(requestRows($)).toHaveLength(requests.length);
    for (const [index, request] of requests.entries()) {
      const actions = requestRows($).eq(index).children('td.actions');
      expect(actions.children('a.show-actions').attr('onclick')).toBe('showTableControls(this);');
      const list = actions.children('div.actions-menu.hide').children('ul.actions-list');
      const edit = list.children('li.edit').children('a');
      const history = list.children('li.version-history').children('a');
      expect(edit.attr('href')).toBe(
        `./?muraAction=cArch.edit&contenthistid=${request.contentHistId}${target(request)}&return=chain`,
      );
      expect(history.attr('href')).toBe(`./?muraAction=cArch.hist${target(request)}`);
      expect(edit.children('i.mi-pencil')).toHaveLength(1);
      expect(history.children('i.mi-history')).toHaveLength(1);
      expect([edit.text().trim(), history.text().trim()]).toEqual(['Edit', 'Version History']);
    }
  });

  it('previews a page in the admin preview popup', async () => {
    const { $ } = await renderPending();

    const preview = $('li.preview > a');
    expect(preview.attr('href')).toBe('#');
    expect(preview.attr('onclick')).toBe(`return preview('${PREVIEW_URL}','');`);
    expect(preview.children('i.mi-globe')).toHaveLength(1);
    expect(preview.text().trim()).toBe('Preview');
  });

  it('offers no preview for a component', async () => {
    const { $ } = await renderPending(withEditorsRequest({ type: 'Component' }));

    expect($('li.preview')).toHaveLength(0);
    expect($('li.edit > a').attr('href')).toContain('&type=Component&');
  });

  it('posts the JS-encoded preview URL in compact display', async () => {
    const { $ } = await renderPending(cchainPendingData, { compactDisplay: 'true' });

    const preview = $('li.preview > a');
    expect(preview.attr('href')).toBe('#');
    expect(preview.attr('onclick')).toBe(
      `frontEndProxy.post({cmd:'setLocation',location:encodeURIComponent('${encodeJs(PREVIEW_URL)}')});return false;`,
    );
    expect(preview.children('i.mi-globe')).toHaveLength(1);
    expect(preview.text().trim()).toBe('Preview');
  });

  it('zooms from the site root down to the request', async () => {
    const { $, data } = await renderPending();
    const { context, adminDir } = legacySettings();

    for (const [index, request] of requestsOf(data).entries()) {
      const zoom = requestRows($).eq(index).children('td.title.var-width').children('ul.breadcrumb');
      expect(zoom).toHaveLength(1);
      expect(zoom.children('li')).toHaveLength(request.crumbs.length);
      expect(zoom.children('li').last().children('strong').children('a')).toHaveLength(1);
      const links = zoom
        .find('a')
        .toArray()
        .map((a) => ({ href: $(a).attr('href'), text: $(a).text(), icon: $(a).children('i').attr('class') }));
      expect(links).toEqual(
        [...request.crumbs].reverse().map((crumb) => ({
          href:
            `${context}${adminDir}/?muraAction=cArch.list&siteid=${crumb.siteid}&topid=${crumb.contentid}` +
            `&moduleid=${crumb.moduleid ?? SITE_MANAGER}&activeTab=0`,
          text: crumb.menutitle,
          icon: crumb.icon,
        })),
      );
    }
  });

  it('links the change set with its publish-date tooltip', async () => {
    const { $ } = await renderPending();

    const cell = cellOf($, 0, 2);
    expect(cell.children(`a[href="${ASSIGNMENTS_HREF}"]`).text()).toBe('Q3 Content Review');
    expect(cell.children('a[rel=tooltip]').children('i.mi-calendar')).toHaveLength(1);
  });

  it('omits the tooltip of an unscheduled change set', async () => {
    const { $ } = await renderPending(withEditorsRequest({ changesetPublishDate: '' }));

    const cell = cellOf($, 0, 2);
    expect(cell.children('a[rel=tooltip]')).toHaveLength(0);
    expect(cell.children('a').attr('href')).toBe(ASSIGNMENTS_HREF);
  });

  it('prints NA without a change set', async () => {
    const { $ } = await renderPending(withEditorsRequest({ changesetID: '' }));

    const cell = cellOf($, 0, 2);
    expect(cell.text().trim()).toBe('NA');
    expect(cell.children()).toHaveLength(0);
  });

  it('prints the requester', async () => {
    const { $, data } = await renderPending();

    expect(cellOf($, 0, 3).text()).toBe(requestsOf(data)[0]?.lastUpdateBy);
  });

  it('prints the request date in the session date mask and medium time', async () => {
    const created = '2026-10-29T14:05:00.000';
    const { $, ctx } = await renderPending(withEditorsRequest({ created }));
    const { dateKeyFormat, locale } = ctx.req.session;
    const date = parseLegacyDate(created) ?? expect.unreachable(`${created} is not a legacy date`);

    expect(cfLsDateFormat(date, dateKeyFormat, locale)).toBe('10/302/2026');
    expect(cellOf($, 0, 4).text()).toBe(`10/302/2026 ${cfLsTimeFormat(date, 'medium', locale)}`);
  });

  it('encodes group names and requesters', async () => {
    const { $ } = await renderPending(
      model({
        members: [
          { ...EDITORS, groupName: 'Editors <i>A</i>', requests: [{ ...ABOUT_US, lastUpdateBy: 'Quinn <i>Q</i>' }] },
          PUBLISHERS,
        ],
      }),
    );

    expect($('h4').first().text()).toBe('1. Editors <i>A</i>');
    expect($('h4').first().children()).toHaveLength(0);
    expect(cellOf($, 0, 3).text()).toBe('Quinn <i>Q</i>');
    expect(cellOf($, 0, 3).children()).toHaveLength(0);
  });
});

describe('renderCchainPending empty states', () => {
  const NO_REQUESTS = 'No pending requests exist for this group in the approval chain.';

  it('notes a member without pending requests', async () => {
    const { $ } = await renderPending();

    const publishers = $('h4').eq(1);
    expect(publishers.text()).toBe('2. Content Publishers');
    expect(publishers.next().is('div.help-block-empty')).toBe(true);
    expect(publishers.next().text()).toBe(NO_REQUESTS);
    expect($('table')).toHaveLength(1);
  });

  it('notes every member without pending requests and renders no table', async () => {
    const { $ } = await renderPending(model({ members: [{ ...EDITORS, requests: [] }, PUBLISHERS] }));

    const notes = $('h4')
      .toArray()
      .map((h4) => {
        const next = $(h4).next();
        return { isNote: next.is('div.help-block-empty'), text: next.text() };
      });
    expect(notes).toEqual([
      { isNote: true, text: NO_REQUESTS },
      { isNote: true, text: NO_REQUESTS },
    ]);
    expect($('table')).toHaveLength(0);
  });

  it('notes a chain without members', async () => {
    const { $ } = await renderPending(model({ members: [] }));

    expect($('div.help-block-empty')).toHaveLength(1);
    expect($('div.help-block-empty').text()).toBe('No groups have been assigned to this approval chain yet.');
    expect($('hr, h4, table')).toHaveLength(0);
  });
});

describe('cchain.pending registry entry', () => {
  it('renders inside the shell', async () => {
    const screen =
      cchainScreens.find((candidate) => candidate.action === 'pending') ??
      expect.unreachable('cchain.pending is not registered');

    await expect(renderScreenPage(screen, contextFor())).resolves.toMatchObject({
      kind: 'document',
      html: expect.stringContaining('<h2>Pending Requests</h2>'),
    });
  });
});
