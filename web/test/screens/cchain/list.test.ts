// cchain.list: the Approval Chains list of cchain/list.cfm and js.cfm over strategies-content's listApprovalChains.
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { cfLsTimeFormat } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toString } from '@/lib/html';
import { cchainScreens, withCchainDefaults } from '@/screens/cchain';
import { renderCchainJs } from '@/screens/cchain/js';
import { loadCchainList, renderCchainList, type CchainListItem } from '@/screens/cchain/list';
import { findScreen, type ScreenDefinition } from '@/screens/registry';
import { siteAdminRequest } from '../../helpers/admin-request';
import { domModel, fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';
import { APPROVAL_CHAIN_IDS, CCHAIN_PATHS, cchainListData } from '../../fixtures/strategies-content/approval-chains';

type ListModel = typeof cchainListData;
type ChainStruct = Readonly<Record<string, unknown>>;

const SITE = 'tenant-a';
const LIST_ROUTE = routeKey('GET', 'strategies-content', CCHAIN_PATHS.list);
const SCRIPT_SRC = 'assets/js/approvalchain.js?coreversion=7.6.1';
const HEADERS = ['', 'Name', 'Last Update'];
const ACTIONS_TEXT = 'Edit Pending Requests Delete';
const STANDARD_LAST_UPDATE = '06/181/2026 10:15:00 AM';
// esapiEncode('javascript') of approvalchains.deleteconfirm, as legacy prints it into the handler.
const DELETE_ONCLICK = "return confirmDialog('Delete\\x20Approval\\x20Chain\\x3F',this.href)";
const UMBRELLA_CHAIN_ID = '5C000000-0007-4000-8000000000000011';
const ESCAPED_CHAIN_ID = '5C000000-0007-4000-8000000000000012';

const FIXTURE_CHAINS = cchainListData.rc.chains as readonly ChainStruct[];

/** The fixture's first chain with `overrides` laid over it. */
const chainWith = (overrides: ChainStruct): ChainStruct => ({ ...FIXTURE_CHAINS[0], ...overrides });

const UMBRELLA_CHAIN = chainWith({ chainID: UMBRELLA_CHAIN_ID, siteID: 'umbrella', name: 'Umbrella Review' });

/** The fixture model with `chains` in place of its own. */
const modelWith = (chains: readonly ChainStruct[]): ListModel => ({ rc: { ...cchainListData.rc, chains } });

/** The list item the loader builds from a chain struct. */
const itemOf = (chain: ChainStruct): CchainListItem => ({
  chainId: String(chain.chainID),
  name: String(chain.name),
  siteId: String(chain.siteID),
  lastUpdate: typeof chain.lastupdate === 'string' ? chain.lastupdate : null,
});

/** The tenant-a site admin on cchain.list, with the cchain `before()` defaults on `rc`. */
function listRequest(): ReturnType<typeof siteAdminRequest> {
  const req = siteAdminRequest(SITE, { circuit: 'cchain', item: 'list' });
  return { ...req, rc: withCchainDefaults(req.rc) };
}

/** A screen context whose strategies-content answers listApprovalChains with `model`. */
function contextFor(model: ListModel = cchainListData): ReturnType<typeof makeScreenContext> {
  const gateway = fakeGatewayClient({ [LIST_ROUTE]: { status: 200, body: model } });
  return makeScreenContext({ req: listRequest(), gateway });
}

/** Loads and renders the list of `model`, spying on the CSRF renderer. */
async function rendered(model: ListModel = cchainListData) {
  const ctx = contextFor(model);
  const csrfRender = vi.spyOn(ctx.csrf, 'render');
  const data = await loadCchainList(ctx);
  const body = toString(renderCchainList(ctx, data).body);
  return { ctx, body, csrfRender, $: cheerio.load(body, null, false) };
}

/** Href, trimmed text and icon class of the first link `selector` finds in row `index`. */
function linkAt($: CheerioAPI, index: number, selector: string) {
  const link = $('tbody.nest > tr').eq(index).find(selector).first();
  return { href: link.attr('href'), text: link.text().trim(), icon: link.children('i').attr('class') };
}

/** The legacy actions and name link of one row. */
function rowAt($: CheerioAPI, index: number) {
  const row = $('tbody.nest > tr').eq(index);
  return {
    toggle: row.find('td.actions > a.show-actions').attr('onclick'),
    menu: row
      .find('td.actions > div.actions-menu.hide > ul.actions-list > li')
      .toArray()
      .map((li) => $(li).attr('class')),
    edit: linkAt($, index, 'li.edit > a'),
    pending: linkAt($, index, 'li.change-sets > a'),
    remove: { ...linkAt($, index, 'li.delete > a'), onclick: row.find('li.delete > a').attr('onclick') },
    name: { ...linkAt($, index, 'td.var-width > a'), title: row.find('td.var-width > a').attr('title') },
  };
}

/** What `rowAt` reads for a chain listed under `rc.siteid` = tenant-a. */
function expectedRow(chain: ChainStruct) {
  const chainId = String(chain.chainID);
  const csrf = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;
  return {
    toggle: 'showTableControls(this);',
    menu: ['edit', 'change-sets', 'delete'],
    edit: { href: `./?muraAction=cchain.edit&chainID=${chainId}&siteid=${SITE}`, text: 'Edit', icon: 'mi-pencil' },
    pending: {
      href: `./?muraAction=cchain.pending&chainID=${chainId}&siteid=${String(chain.siteID)}`,
      text: 'Pending Requests',
      icon: 'mi-reorder',
    },
    remove: {
      href: `./?muraAction=cchain.delete&chainID=${chainId}&siteid=${SITE}${csrf}`,
      text: 'Delete',
      icon: 'mi-trash',
      onclick: DELETE_ONCLICK,
    },
    name: {
      href: `./?muraAction=cchain.pending&chainID=${chainId}&siteid=${SITE}`,
      text: String(chain.name),
      icon: undefined,
      title: 'Edit',
    },
  };
}

/** cchainScreens' `list` entry. */
function listScreen(): ScreenDefinition {
  const def = cchainScreens.find((candidate) => candidate.action === 'list');
  if (def === undefined) throw new Error('cchain.list is not registered');
  return def;
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('loadCchainList', () => {
  it('reads the site chains in service order with one strategies-content call', async () => {
    const chains = [...FIXTURE_CHAINS, UMBRELLA_CHAIN];
    const ctx = contextFor(modelWith(chains));

    await expect(loadCchainList(ctx)).resolves.toEqual({ chains: chains.map(itemOf) });
    expect(ctx.gateway.calls.filter(({ service }) => service === 'strategies-content')).toEqual([
      { service: 'strategies-content', method: 'GET', path: CCHAIN_PATHS.list },
    ]);
  });

  it('returns the fixture chains as listed', async () => {
    const { chains } = await loadCchainList(contextFor());

    expect(chains).toEqual([
      { chainId: APPROVAL_CHAIN_IDS.standard, name: 'Standard Publishing', siteId: SITE, lastUpdate: '2026-06-30T10:15:00.000' },
    ]);
  });

  it('prefetches one delete token per chain in a single identity call', async () => {
    const ctx = contextFor(modelWith([...FIXTURE_CHAINS, UMBRELLA_CHAIN]));

    await loadCchainList(ctx);

    expect(ctx.gateway.calls.filter(({ service }) => service === 'identity')).toEqual([
      {
        service: 'identity',
        method: 'POST',
        path: '/v1/csrf/tokens',
        json: { contexts: [APPROVAL_CHAIN_IDS.standard, UMBRELLA_CHAIN_ID] },
      },
    ]);
  });
});

describe('renderCchainJs', () => {
  it('emits the approval-chain script element', () => {
    expect(toString(renderCchainJs())).toBe(
      '<script src="assets/js/approvalchain.js?coreversion=7.6.1" type="text/javascript" ></script>',
    );
  });
});

describe('renderCchainList', () => {
  it('includes the approval-chain script before the header', async () => {
    const { $ } = await rendered();

    expect($(`script[src="${SCRIPT_SRC}"]`).attr('type')).toBe('text/javascript');
    expect(
      $(`script[src="${SCRIPT_SRC}"], div.mura-header`)
        .toArray()
        .map((el) => el.tagName),
    ).toEqual(['script', 'div']);
  });

  it('heads the list with its title and the add link', async () => {
    const { $, body } = await rendered();

    expect($('.mura-header > h1').text()).toBe('Approval Chains');
    expect(
      $('.mura-header .nav-module-specific.btn-group a')
        .toArray()
        .map((a) => [$(a).attr('href'), $(a).text().trim()]),
    ).toEqual([[`./?muraAction=cchain.edit&chainID=&siteid=${SITE}`, 'Add Approval Chain']]);
    expect(fragmentModel(body).headings).toEqual(['Approval Chains']);
  });

  it('lists one row per chain in the legacy grid', async () => {
    const { $, body } = await rendered();

    expect(fragmentModel(body).tables).toEqual([
      { headers: HEADERS, rows: [[ACTIONS_TEXT, 'Standard Publishing', STANDARD_LAST_UPDATE]] },
    ]);
    expect($('table').attr('class')).toBe('mura-table-grid');
    expect($('table > tbody').attr('class')).toBe('nest');
    expect(
      $('table > thead th')
        .toArray()
        .map((th) => $(th).attr('class')),
    ).toEqual(['actions', 'var-width', undefined]);
  });

  it('links each row under rc.siteid except the pending menu link, which takes the chain site', async () => {
    const chains = [...FIXTURE_CHAINS, UMBRELLA_CHAIN];
    const { $, csrfRender } = await rendered(modelWith(chains));

    expect(chains.map((_chain, index) => rowAt($, index))).toEqual(chains.map(expectedRow));
    expect(rowAt($, 1).pending.href).toBe(`./?muraAction=cchain.pending&chainID=${UMBRELLA_CHAIN_ID}&siteid=umbrella`);
    expect(csrfRender.mock.calls).toEqual(chains.map((chain) => [chain.chainID, 'url']));
  });

  it('renders a chain name as text', async () => {
    const { $, body } = await rendered(modelWith([chainWith({ chainID: ESCAPED_CHAIN_ID, name: 'Legal <b>& Review' })]));

    expect($('b')).toHaveLength(0);
    expect(rowAt($, 0).name.text).toBe('Legal <b>& Review');
    expect(body).toContain('>Legal &lt;b&gt;&amp; Review</a>');
  });

  it('formats a dated last update with the session date key and the medium time', async () => {
    const { ctx, body } = await rendered(modelWith([chainWith({ lastupdate: '2026-10-29T14:05:00.000' })]));
    const time = cfLsTimeFormat(new Date(2026, 9, 29, 14, 5, 0), 'medium', ctx.req.session.locale);

    const [cell] = fragmentModel(body).tables.flatMap((table) => table.rows.map((row) => row[2]));

    expect(cell).toBe(`10/302/2026 ${time}`);
  });

  it.each<[string, ChainStruct]>([
    ['null', chainWith({ lastupdate: null })],
    ['absent', Object.fromEntries(Object.entries(chainWith({})).filter(([key]) => key !== 'lastupdate'))],
  ])('leaves the last update cell empty when it is %s', async (_label, chain) => {
    const { $, body } = await rendered(modelWith([chain]));

    expect(fragmentModel(body).tables[0]?.rows).toEqual([[ACTIONS_TEXT, 'Standard Publishing', '']]);
    expect($('tbody.nest > tr > td').last().text().trim()).toBe('');
  });

  it('shows the empty notice instead of a table without chains', async () => {
    const { $, body } = await rendered(modelWith([]));

    expect($('div.help-block-empty').text()).toBe('There are currently no approval chains');
    expect($('table')).toHaveLength(0);
    expect(fragmentModel(body).tables).toEqual([]);
    expect($(`script[src="${SCRIPT_SRC}"]`)).toHaveLength(1);
    expect($('.mura-header > h1').text()).toBe('Approval Chains');
  });
});

describe('cchain.list page', () => {
  it('is the registered list screen', () => {
    expect(findScreen('core:cchain', 'list', listRequest().rc)).toBe(listScreen());
  });

  it('renders the list inside the shell', async () => {
    const ctx = contextFor();

    const page = await renderScreenPage(listScreen(), ctx);

    expect(page.kind).toBe('document');
    const html = page.kind === 'document' ? page.html : '';
    const model = domModel(html);
    expect(model.tables).toContainEqual({
      headers: HEADERS,
      rows: [[ACTIONS_TEXT, 'Standard Publishing', STANDARD_LAST_UPDATE]],
    });
    expect(model.headings).toContain('Approval Chains');
    expect(html).toContain(`<script src="${SCRIPT_SRC}" type="text/javascript" ></script>`);
    expect(ctx.gateway.calls.filter(({ path }) => path === CCHAIN_PATHS.list)).toHaveLength(1);
  });
});
