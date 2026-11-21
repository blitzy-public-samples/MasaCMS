// cchain.edit loader and form markup against admin/core/views/cchain/edit.cfm (GS-CO-09).
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServicePath } from '@/lib/gateway-client';
import { isSafeHtml, toString } from '@/lib/html';
import { withCchainDefaults } from '@/screens/cchain';
import { loadCchainEdit, renderCchainEdit, type CchainEditData } from '@/screens/cchain/edit';
import { APPROVAL_CHAIN_IDS, cchainEditData, cchainEditNewData } from '../../fixtures/strategies-content/approval-chains';
import { siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type RecordedRequest,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

// A spy over the real generator: strategies-content is routed by chain id, so a drawn id is routed as it is drawn.
vi.mock('@opt2/platform/legacy-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/legacy-compat')>();
  return { ...actual, cfUuid: vi.fn(actual.cfUuid) };
});

const { cfUuid: drawCfUuid } =
  await vi.importActual<typeof import('@opt2/platform/legacy-compat')>('@opt2/platform/legacy-compat');

type Model = Readonly<Record<string, unknown>>;
type EditContext = ReturnType<typeof makeScreenContext>;

/** The `getApprovalChain` fixture models, as approval-chains.ts declares them. */
interface ChainModel {
  readonly chain: Model & {
    readonly chainID: string;
    readonly siteID: string;
    readonly name: string;
    readonly description: string;
  };
  readonly availableGroups: readonly { readonly userID: string; readonly groupName: string }[];
  readonly memberships: readonly { readonly groupID: string; readonly groupName: string; readonly orderNo: number }[];
}

const SITE = 'tenant-a';
const SAVED_ID = APPROVAL_CHAIN_IDS.standard;
const SAVED = cchainEditData.rc as unknown as ChainModel;
const FRESH = cchainEditNewData.rc as unknown as ChainModel;
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const NAME_REQUIRED = "The 'Name' field is required.";
const BACK_LINK = ['Back to Approval Chains', `./?muraAction=cchain.list&siteid=${SITE}`];

const chainPath = (chainId: string): ServicePath => `/v1/sites/${SITE}/approval-chains/${chainId}`;

const inOrder = (memberships: ChainModel['memberships']): ChainModel['memberships'] =>
  [...memberships].sort((a, b) => a.orderNo - b.orderNo);

/** strategies-content `getApprovalChain`: `saved` for the saved chain, the new-chain model under any other id. */
function chainRoute(saved: object): (request: RecordedRequest) => FakeReply {
  return (request) => {
    const chainId = decodeURIComponent(request.path.split('/').at(-1) ?? '');
    if (chainId === SAVED_ID) return { status: 200, body: { rc: saved } };
    const rc = { ...FRESH, chainid: chainId, chain: { ...FRESH.chain, chainID: chainId } };
    return { status: 200, body: { rc } };
  };
}

/** The tenant-a site admin on `cchain.edit` with `rc.chainid`, and the chain ids its loader draws. */
function editContext(chainid: string, saved: object = cchainEditData.rc): { ctx: EditContext; drawn: string[] } {
  const route = chainRoute(saved);
  const gateway: FakeGatewayClient = fakeGatewayClient({
    [routeKey('GET', 'strategies-content', chainPath(SAVED_ID))]: route,
  });
  const drawn: string[] = [];
  vi.mocked(cfUuid).mockImplementation(() => {
    const id = drawCfUuid();
    drawn.push(id);
    gateway.setRoute(routeKey('GET', 'strategies-content', chainPath(id)), route);
    return id;
  });
  const req = siteAdminRequest(SITE, { circuit: 'cchain', item: 'edit', rc: withCchainDefaults({ chainid }) });
  return { ctx: makeScreenContext({ req, gateway }), drawn };
}

interface Rendered {
  readonly ctx: EditContext;
  readonly drawn: readonly string[];
  readonly data: CchainEditData;
  readonly markup: string;
  readonly $: CheerioAPI;
  readonly model: DomModel;
}

async function renderEdit(chainid: string, saved?: object): Promise<Rendered> {
  const { ctx, drawn } = editContext(chainid, saved);
  const data = await loadCchainEdit(ctx);
  const { body } = renderCchainEdit(ctx, data);
  expect(isSafeHtml(body)).toBe(true);
  const markup = toString(body);
  return { ctx, drawn, data, markup, $: cheerio.load(markup, null, false), model: fragmentModel(markup) };
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

const textsOf = ($: CheerioAPI, selector: string): string[] =>
  $(selector)
    .toArray()
    .map((el) => squash($(el).text()));

const valuesOf = ($: CheerioAPI, selector: string): string[] =>
  $(selector)
    .toArray()
    .map((el) => $(el).attr('value') ?? '');

const toolbarOf = ($: CheerioAPI): string[][] =>
  $('div.mura-header > div.nav-module-specific.btn-group > a')
    .toArray()
    .map((el) => [squash($(el).text()), $(el).attr('href') ?? '']);

const strategiesCalls = (ctx: EditContext) =>
  ctx.gateway.calls
    .filter((call) => call.service === 'strategies-content')
    .map(({ method, path }) => ({ method, path }));

const csrfContexts = (ctx: EditContext): unknown[] =>
  ctx.gateway.calls
    .filter((call) => call.service === 'identity' && call.path === '/v1/csrf/tokens')
    .map((call) => call.json);

const deleteOnclick = (chainId: string, siteId: string): string =>
  `confirmDialog('Delete\\x20Approval\\x20Chain\\x3F','./?muraAction=cchain.delete&chainID=${chainId}` +
  `&siteid=${siteId} &csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}');`;

const ACTIONS = 'form[name="form1"] div.mura-actions > div.form-actions';

/** The one drawn chain id. */
function drawnId(drawn: readonly string[]): string {
  expect(drawn).toHaveLength(1);
  return drawn[0] ?? '';
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  vi.mocked(cfUuid).mockReset();
  restore();
});

describe('cchain.edit saved chain', () => {
  it('reads the requested chain id unchanged', async () => {
    const { ctx, drawn } = editContext(SAVED_ID);
    expect(ctx.req.action).toBe('core:cchain.edit');

    const data = await loadCchainEdit(ctx);

    expect(drawn).toEqual([]);
    expect(strategiesCalls(ctx)).toEqual([{ method: 'GET', path: chainPath(SAVED_ID) }]);
    expect(data).toEqual({
      chain: {
        chainId: SAVED_ID,
        name: SAVED.chain.name,
        description: SAVED.chain.description,
        siteId: SITE,
        isNew: false,
        errors: {},
      },
      availableGroups: SAVED.availableGroups.map(({ userID, groupName }) => ({ userId: userID, groupName })),
      memberships: inOrder(SAVED.memberships).map(({ groupID, groupName }) => ({ groupId: groupID, groupName })),
    });
  });

  it('renders the heading and the edit toolbar', async () => {
    const { $, model } = await renderEdit(SAVED_ID);

    expect(textsOf($, 'div.mura-header > h1')).toEqual(['Edit Approval Chain']);
    expect(model.headings).toEqual(['Edit Approval Chain']);
    expect(toolbarOf($)).toEqual([
      BACK_LINK,
      ['Pending Requests', `./?muraAction=cchain.pending&siteid=${SITE}&chainID=${SAVED_ID}`],
    ]);
  });

  it('renders the form and its fields with legacy attributes', async () => {
    const { $, markup, model } = await renderEdit(SAVED_ID);

    expect($('form').toArray()).toHaveLength(1);
    expect($('form').attr()).toEqual({
      novalidate: 'novalidate',
      action: './?muraAction=cchain.save',
      method: 'post',
      name: 'form1',
      onsubmit: 'return validateForm(this);',
    });
    expect($('form input[name="name"]').attr()).toEqual({
      name: 'name',
      type: 'text',
      required: 'true',
      message: NAME_REQUIRED,
      value: SAVED.chain.name,
      maxlength: '50',
    });
    expect(markup).toContain('value="Standard&#x20;Publishing" maxlength="50">');
    expect($('form textarea[name="description"]').attr('rows')).toBe('6');
    expect($('form textarea[name="description"]').text()).toBe(SAVED.chain.description);
    expect(model.labels).toEqual(['Name', 'Description', 'Available Groups Groups in this Approval Chain']);
    expect(textsOf($, '#availableGroups > label > span.half')).toEqual([
      'Available Groups',
      'Groups in this Approval Chain',
    ]);
    expect(squash($('#availableGroups > .help-block').text())).toMatch(
      /^The first group in the chain will be the first group required to make the decision/,
    );
    expect(textsOf($, '#sortableGroups > p.dragMsg > span')).toEqual([
      'Drag from here…',
      '…then drop and set the order here.',
    ]);
  });

  it('lists the available groups as served', async () => {
    const { $ } = await renderEdit(SAVED_ID);
    const items = '#sortableGroups > ul#groupAvailableListSort.groupDisplayListSortOptions > li.ui-state-default';

    expect(textsOf($, items)).toEqual(SAVED.availableGroups.map((group) => group.groupName));
    expect(valuesOf($, `${items} > input[type="hidden"][name="availableID"]`)).toEqual(
      SAVED.availableGroups.map((group) => group.userID),
    );
  });

  it('lists the chain groups in orderno order', async () => {
    const { $ } = await renderEdit(SAVED_ID);
    const items = '#sortableGroups > ol#groupAssignmentListSort.groupDisplayListSortOptions > li.ui-state-highlight';

    expect(textsOf($, items)).toEqual(inOrder(SAVED.memberships).map((member) => member.groupName));
    expect(valuesOf($, `${items} > input[type="hidden"][name="groupID"]`)).toEqual(
      inOrder(SAVED.memberships).map((member) => member.groupID),
    );
  });

  it('posts the site, the chain and CSRF fields issued for the chain', async () => {
    const { ctx, $ } = await renderEdit(SAVED_ID);

    expect(
      $(`${ACTIONS} > input[type="hidden"]`)
        .toArray()
        .map((el) => [$(el).attr('name'), $(el).attr('value')]),
    ).toEqual([
      ['siteid', SAVED.chain.siteID],
      ['chainID', SAVED.chain.chainID],
      ['csrf_token', FIXED_CSRF.token],
      ['csrf_token_expires', FIXED_CSRF.expires],
    ]);
    expect(csrfContexts(ctx)).toEqual([{ contexts: [SAVED_ID] }]);
  });

  it('renders Delete then Update with the legacy handlers', async () => {
    const { $, model } = await renderEdit(SAVED_ID);
    const buttons = $(`${ACTIONS} > button`);
    const remove = buttons.eq(0);
    const update = buttons.eq(1);

    expect(model.buttons).toEqual([
      { text: 'Delete', type: 'button', hasOnclick: true },
      { text: 'Update', type: 'button', hasOnclick: true },
    ]);
    expect(remove.attr('class')).toBe('btn');
    expect(remove.children('i.mi-trash').toArray()).toHaveLength(1);
    expect(remove.attr('onclick')).toBe(deleteOnclick(SAVED_ID, SITE));
    expect(update.attr('class')).toBe('btn mura-primary');
    expect(update.attr('type')).toBe('button');
    expect(update.attr('onclick')).toBe("submitForm(document.forms.form1,'save');");
  });

  it('starts the group sort and loads approvalchain.js after the form', async () => {
    const { $ } = await renderEdit(SAVED_ID);

    expect($('#sortableGroups > script').text()).toContain('chainManager.setGroupMembershipSort();');
    expect($('script[src]').toArray()).toHaveLength(1);
    expect($('form[name="form1"] ~ script[src]').attr()).toEqual({
      src: 'assets/js/approvalchain.js?coreversion=7.6.1',
      type: 'text/javascript',
    });
  });

  it('encodes markup in group names', async () => {
    const marked = (name: string): string => `R&D <${name}>`;
    const saved: ChainModel = {
      ...SAVED,
      availableGroups: SAVED.availableGroups.map((group) => ({ ...group, groupName: marked(group.groupName) })),
      memberships: SAVED.memberships.map((member) => ({ ...member, groupName: marked(member.groupName) })),
    };

    const { $, markup } = await renderEdit(SAVED_ID, saved);

    expect(textsOf($, '#groupAvailableListSort > li')).toEqual(saved.availableGroups.map((g) => g.groupName));
    expect(textsOf($, '#groupAssignmentListSort > li')).toEqual(inOrder(saved.memberships).map((m) => m.groupName));
    expect(
      $('#sortableGroups li > *')
        .toArray()
        .map((el) => el.tagName),
    ).toEqual(['input', 'input', 'input']);
    expect(markup).toContain('R&amp;D &lt;Marketing Reviewers&gt;');
    expect(markup).toContain('R&amp;D &lt;Content Editors&gt;');
  });
});

describe('cchain.edit new chain', () => {
  it('draws a fresh CF UUID for each load', async () => {
    const first = editContext('');
    await loadCchainEdit(first.ctx);
    const second = editContext('');
    await loadCchainEdit(second.ctx);
    const firstId = drawnId(first.drawn);
    const secondId = drawnId(second.drawn);

    expect(firstId).toMatch(CF_UUID);
    expect(secondId).toMatch(CF_UUID);
    expect(firstId).not.toBe(secondId);
    expect(strategiesCalls(first.ctx)).toEqual([{ method: 'GET', path: chainPath(firstId) }]);
    expect(strategiesCalls(second.ctx)).toEqual([{ method: 'GET', path: chainPath(secondId) }]);
    expect(first.ctx.req.rc.chainid).toBe(firstId);
  });

  it('still renders the edit heading with Delete and Update', async () => {
    const { $, model } = await renderEdit('');

    expect(textsOf($, 'div.mura-header > h1')).toEqual(['Edit Approval Chain']);
    expect(model.buttons.map((button) => button.text)).toEqual(['Delete', 'Update']);
  });

  it('binds the chain field and CSRF context to the drawn id', async () => {
    const { ctx, drawn, data, $ } = await renderEdit('');
    const id = drawnId(drawn);

    expect(data.chain).toMatchObject({ chainId: id, isNew: true });
    expect(valuesOf($, `${ACTIONS} > input[type="hidden"][name="chainID"]`)).toEqual([id]);
    expect(csrfContexts(ctx)).toEqual([{ contexts: [id] }]);
  });

  it.each<[string, string, ChainModel, string]>([
    ["the request's site for a new bean the service leaves without one", '', FRESH, SITE],
    ["a stored chain's own site", SAVED_ID, { ...SAVED, chain: { ...SAVED.chain, siteID: 'umbrella' } }, 'umbrella'],
  ])('posts and deletes under %s', async (_, chainid, saved, site) => {
    const { data, $ } = await renderEdit(chainid, saved);

    expect(data.chain.siteId).toBe(site);
    expect(valuesOf($, `${ACTIONS} > input[type="hidden"][name="siteid"]`)).toEqual([site]);
    expect($(`${ACTIONS} > button`).eq(0).attr('onclick')).toBe(deleteOnclick(data.chain.chainId, site));
  });

  it('shows only the back link', async () => {
    const { $ } = await renderEdit('');

    expect(toolbarOf($)).toEqual([BACK_LINK]);
  });

  it('lists every available group and no chain groups', async () => {
    const { $ } = await renderEdit('');

    expect(textsOf($, '#groupAvailableListSort > li.ui-state-default')).toEqual(
      FRESH.availableGroups.map((group) => group.groupName),
    );
    expect(valuesOf($, '#groupAvailableListSort input[name="availableID"]')).toEqual(
      FRESH.availableGroups.map((group) => group.userID),
    );
    expect(FRESH.memberships).toEqual([]);
    expect($('#groupAssignmentListSort > li').toArray()).toEqual([]);
    expect(valuesOf($, 'input[name="groupID"]')).toEqual([]);
  });
});

describe('cchain.edit errors', () => {
  it('shows bean errors in an alert', async () => {
    const saved: ChainModel = { ...SAVED, chain: { ...SAVED.chain, errors: { name: NAME_REQUIRED } } };

    const { $, model } = await renderEdit(SAVED_ID, saved);

    expect(squash($('div.block-content > div.alert.alert-error > span').text())).toContain(NAME_REQUIRED);
    expect(model.alerts).toHaveLength(1);
    expect(model.alerts[0]?.className).toBe('alert alert-error');
  });

  it('shows no alert without errors', async () => {
    const { $, model } = await renderEdit(SAVED_ID);

    expect($('.alert-error').toArray()).toEqual([]);
    expect(model.alerts).toEqual([]);
  });
});
