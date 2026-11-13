// cchain.update (edit.cfm), save and delete against admin/core/controllers/cchain.cfc and cchain/edit.cfm.
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_HTML_CONTENT_TYPE,
  cfUuid,
} from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_VERSION } from '@/lib/env';
import { GatewayDenialError, GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { CCHAIN_RC_DEFAULTS, cchainScreens, withCchainDefaults } from '@/screens/cchain';
import { submitCchainDelete } from '@/screens/cchain/delete';
import { loadCchainEdit, renderCchainEdit, type CchainEditData } from '@/screens/cchain/edit';
import { submitCchainSave } from '@/screens/cchain/save';
import type { PageScreen, RedirectScreen, ScreenContext } from '@/screens/registry';
import {
  anonymousRequest,
  editorRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

// A fresh chain id is a random CF UUID; the spy lets a test pin the one the loader draws.
vi.mock('@opt2/platform/legacy-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/legacy-compat')>();
  return { ...actual, cfUuid: vi.fn(actual.cfUuid) };
});

const SITE = 'tenant-a';
const CHAIN = 'C1000000-0000-0000-0000000000000001';
const NEW_CHAIN = 'C1000000-0000-0000-00000000000000FF';
const LEGAL = '6A000000-0000-0000-0000000000000001';
const BOARD = '6A000000-0000-0000-0000000000000002';
const EDITORS = '6A000000-0000-0000-0000000000000003';
const NOACCESS = '/admin/?muraAction=cMessage.noaccess';
const LOGOUT = '/admin/?muraAction=clogin.logout';
const URL_TOKENS = `&${CSRF_FIELD_TOKEN}=${FIXED_CSRF.token}&${CSRF_FIELD_EXPIRES}=${FIXED_CSRF.expires}`;

const chainPath = (chainid: string): ServicePath => `/v1/sites/${SITE}/approval-chains/${chainid}`;
const SAVE_PATH: ServicePath = `/v1/sites/${SITE}/approval-chains`;
const DELETE_PATH: ServicePath = `/v1/sites/${SITE}/approval-chains/${CHAIN}/delete`;

/** strategies-content's `getApprovalChain` model: the chain bean's values and both group iterators. */
function chainModel(chain: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    chain: {
      chainID: CHAIN,
      name: 'Legal & "Review"',
      description: '<b>Two</b> steps',
      siteID: SITE,
      isNew: 0,
      errors: {},
      lastUpdate: '2026-06-30T10:15:00',
      ...chain,
    },
    availableGroups: [{ userID: EDITORS, groupName: 'Editors <A>' }],
    memberships: [
      { groupID: LEGAL, groupName: 'Legal' },
      { groupID: BOARD, groupName: 'Board' },
    ],
  };
}

const view = (rc: Readonly<Record<string, unknown>>): FakeReply => ({ status: 200, body: { rc } });

/** `saveApprovalChain`/`deleteApprovalChain`'s write outcome with legacy's redirect, or null for bean errors. */
function written(redirect: { circuit: string; action: string; params: Array<[string, string]> } | null): FakeReply {
  return {
    status: 200,
    body: { saved: redirect !== null, errors: redirect === null ? { name: 'Required' } : {}, redirect },
  };
}

/** The tenant-a site admin on `cchain.<item>` with `rc`. */
const adminOn = (item: string, rc: Readonly<Record<string, string>> = {}): AdminRequest =>
  siteAdminRequest(SITE, { circuit: 'cchain', item, rc });

function contextFor(
  req: AdminRequest,
  routes: Readonly<Record<string, FakeReply>> = {},
): ScreenContext & {
  gateway: FakeGatewayClient;
} {
  return makeScreenContext({ req, gateway: fakeGatewayClient(routes) });
}

function screenOf<T extends PageScreen<CchainEditData> | RedirectScreen>(action: string): T {
  const def = cchainScreens.find((candidate) => candidate.action === action);
  if (def === undefined) throw new Error(`cchain.${action} is not registered`);
  return def as T;
}

const callsTo = (gateway: FakeGatewayClient, service: string) =>
  gateway.calls.filter((call) => call.service === service);

const caught = (promise: Promise<unknown>): Promise<unknown> => promise.catch((error: unknown) => error);

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('withCchainDefaults', () => {
  it('adds each before() param the rc lacks, matching names in any case and keeping present values', () => {
    const rc = withCchainDefaults({ siteid: SITE, chainID: CHAIN, NAME: '', groupid: 'G' });

    expect(rc).toMatchObject({ ...CCHAIN_RC_DEFAULTS, siteid: SITE, chainid: CHAIN, name: '', groupid: 'G' });
    expect(Object.keys(rc).filter((key) => key.toLowerCase() === 'chainid')).toEqual(['chainID']);
    expect(Object.keys(rc).filter((key) => key.toLowerCase() === 'name')).toEqual(['NAME']);
  });
});

describe('loadCchainEdit', () => {
  it('reads the chain of rc.chainID with its groups and prefetches the chain token', async () => {
    const ctx = contextFor(adminOn('update', { chainID: CHAIN }), {
      [routeKey('GET', 'strategies-content', chainPath(CHAIN))]: view(chainModel()),
    });

    await expect(loadCchainEdit(ctx)).resolves.toEqual({
      chain: {
        chainId: CHAIN,
        name: 'Legal & "Review"',
        description: '<b>Two</b> steps',
        siteId: SITE,
        isNew: false,
        errors: {},
      },
      availableGroups: [{ userId: EDITORS, groupName: 'Editors <A>' }],
      memberships: [
        { groupId: LEGAL, groupName: 'Legal' },
        { groupId: BOARD, groupName: 'Board' },
      ],
    });
    expect(ctx.gateway.calls.map(({ service, method, path }) => `${service} ${method} ${path}`)).toEqual([
      `strategies-content GET ${chainPath(CHAIN)}`,
      'identity POST /v1/csrf/tokens',
    ]);
    expect(callsTo(ctx.gateway, 'identity')[0]?.json).toEqual({ contexts: [CHAIN] });
  });

  it('gives an empty chain id a fresh CF UUID in rc before reading it, as the view sets rc.chainID', async () => {
    vi.mocked(cfUuid).mockReturnValueOnce(NEW_CHAIN);
    const model = chainModel({ chainID: NEW_CHAIN, name: '', description: '', isNew: 'true', errors: undefined });
    const ctx = contextFor(adminOn('update', { chainid: '' }), {
      [routeKey('GET', 'strategies-content', chainPath(NEW_CHAIN))]: view({ ...model, memberships: [] }),
    });

    const data = await loadCchainEdit(ctx);

    expect(data.chain).toEqual({
      chainId: NEW_CHAIN,
      name: '',
      description: '',
      siteId: SITE,
      isNew: true,
      errors: {},
    });
    expect(data.memberships).toEqual([]);
    expect(ctx.req.rc.chainid).toBe(NEW_CHAIN);
    expect(ctx.req.rc.siteid).toBe(SITE);
  });

  it('reads the model keys case-insensitively and SQL NULL as an empty string', async () => {
    const rc = {
      CHAIN: {
        CHAINID: CHAIN,
        NAME: null,
        DESCRIPTION: 7,
        SITEID: SITE,
        ISNEW: false,
        ERRORS: { NAME: 'Required', siteID: 'x' },
      },
      AVAILABLEGROUPS: [],
      MEMBERSHIPS: [{ GROUPID: LEGAL, GROUPNAME: true }],
    };
    const ctx = contextFor(adminOn('update', { chainID: CHAIN }), {
      [routeKey('GET', 'strategies-content', chainPath(CHAIN))]: view(rc),
    });

    await expect(loadCchainEdit(ctx)).resolves.toEqual({
      chain: {
        chainId: CHAIN,
        name: '',
        description: '7',
        siteId: SITE,
        isNew: false,
        errors: { NAME: 'Required', siteID: 'x' },
      },
      availableGroups: [],
      memberships: [{ groupId: LEGAL, groupName: 'true' }],
    });
  });

  it.each<[string, Readonly<Record<string, unknown>>, RegExp]>([
    ['no chain struct', { ...chainModel(), chain: [CHAIN] }, /chain is not a struct/],
    ['a complex chain name', chainModel({ name: { text: 'Legal' } }), /name is not a simple value/],
    ['an errors member that is not a struct', chainModel({ errors: 'none' }), /errors is not a struct/],
    ['no boolean isNew', chainModel({ isNew: 'maybe' }), /Cannot convert maybe to a boolean/],
    [
      'available groups that are not rows',
      { ...chainModel(), availableGroups: 'none' },
      /availableGroups is not a list of rows/,
    ],
    [
      'membership rows that are not structs',
      { ...chainModel(), memberships: [[LEGAL]] },
      /memberships is not a list of rows/,
    ],
  ])('rejects a model with %s before asking for tokens', async (_label, rc, message) => {
    const ctx = contextFor(adminOn('update', { chainID: CHAIN }), {
      [routeKey('GET', 'strategies-content', chainPath(CHAIN))]: view(rc),
    });

    await expect(loadCchainEdit(ctx)).rejects.toThrow(message);
    expect(callsTo(ctx.gateway, 'identity')).toEqual([]);
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i', async (status) => {
    const ctx = contextFor(adminOn('update', { chainID: CHAIN }), {
      [routeKey('GET', 'strategies-content', chainPath(CHAIN))]: { status, body: {} },
    });

    const error = await caught(loadCchainEdit(ctx));

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'strategies-content', operation: 'getApprovalChain', status });
  });

  it('fails on a chain the service does not find', async () => {
    const ctx = contextFor(adminOn('update', { chainID: CHAIN }));

    await expect(loadCchainEdit(ctx)).rejects.toThrow('getApprovalChain answered HTTP 404');
  });

  it('fails closed when strategies-content is unavailable', async () => {
    const ctx = contextFor(adminOn('update', { chainID: CHAIN }), {
      [routeKey('GET', 'strategies-content', chainPath(CHAIN))]: { status: 503, body: {} },
    });

    await expect(loadCchainEdit(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('renderCchainEdit', () => {
  const DATA: CchainEditData = {
    chain: {
      chainId: CHAIN,
      name: 'Legal & "Review"',
      description: '<b>Two</b> steps',
      siteId: 'tenant a&b',
      isNew: false,
      errors: {},
    },
    availableGroups: [{ userId: EDITORS, groupName: 'Editors <A>' }],
    memberships: [
      { groupId: LEGAL, groupName: 'Legal' },
      { groupId: BOARD, groupName: 'Board' },
    ],
  };

  async function render(item: string, data: CchainEditData = DATA): Promise<string> {
    const ctx = contextFor(adminOn(item, { chainID: data.chain.chainId }));
    await ctx.csrf.prefetch([data.chain.chainId]);
    const { body } = renderCchainEdit(ctx, data);
    expect(isSafeHtml(body)).toBe(true);
    return toString(body);
  }

  it('renders the form with encoded values, both group lists in order and the chain-bound CSRF fields', async () => {
    const markup = await render('update');
    const model = fragmentModel(markup);

    expect(model.headings).toEqual(['Edit Approval Chain']);
    expect(model.labels).toEqual(['Name', 'Description', 'Available Groups Groups in this Approval Chain']);
    expect(model.controls.map(({ name, type, value }) => [name, type, value])).toEqual([
      ['name', 'text', 'Legal & "Review"'],
      ['description', 'textarea', '<b>Two</b> steps'],
      ['availableID', 'hidden', EDITORS],
      ['groupID', 'hidden', LEGAL],
      ['groupID', 'hidden', BOARD],
      ['siteid', 'hidden', 'tenant a&b'],
      ['chainID', 'hidden', CHAIN],
      [CSRF_FIELD_TOKEN, 'hidden', FIXED_CSRF.token],
      [CSRF_FIELD_EXPIRES, 'hidden', FIXED_CSRF.expires],
    ]);
    expect(model.buttons).toEqual([
      { text: 'Delete', type: 'button', hasOnclick: true },
      { text: 'Update', type: 'button', hasOnclick: true },
    ]);
    expect(model.alerts).toEqual([]);
    // esapiEncode('html_attr') encodes spaces and esapiEncode('html') the slash, as legacy's view encodes them.
    expect(markup).toContain('value="Legal&#x20;&amp;&#x20;&quot;Review&quot;" maxlength="50">');
    expect(markup).toContain('<textarea name="description" rows="6">&lt;b&gt;Two&lt;&#x2f;b&gt; steps</textarea>');
    expect(markup).toContain(
      `Editors &lt;A&gt;\n                <input name="availableID" type="hidden" value="${EDITORS}">`,
    );
    expect(markup).toContain(
      `onclick="confirmDialog('Delete\\x20Approval\\x20Chain\\x3F','./?muraAction=cchain.delete&chainID=${CHAIN}` +
        `&siteid=tenant+a%26b ${URL_TOKENS}');"`,
    );
    expect(markup).toContain(
      '<form novalidate="novalidate" action="./?muraAction=cchain.save" method="post" name="form1"',
    );
    expect(markup).toContain(
      `<script src="assets/js/approvalchain.js?coreversion=${CORE_VERSION}" type="text/javascript" ></script>`,
    );
  });

  it('gives cchain.update an empty secondary menu', async () => {
    expect(await render('update')).toContain('<div class="nav-module-specific btn-group"></div>');
  });

  it.each<[string, boolean, string[]]>([
    ['a saved chain links back and to its pending requests', false, ['Back to Approval Chains', 'Pending Requests']],
    ['a new chain links back only', true, ['Back to Approval Chains']],
  ])('on cchain.edit, %s', async (_label, isNew, links) => {
    const markup = await render('edit', { ...DATA, chain: { ...DATA.chain, isNew } });

    expect(fragmentModel(markup).links.map(({ text }) => text)).toEqual(links);
  });

  it("lists the bean's errors unencoded, skipping siteID while counting it for the <br> separators", async () => {
    const errors = { name: "The 'Name' field is required.", siteID: 'Site <b>id</b>', description: 'Too <i>long</i>' };
    const markup = await render('update', { ...DATA, chain: { ...DATA.chain, errors } });

    expect(markup).toContain(
      `<div class="alert alert-error"><span>The 'Name' field is required. <br> Too <i>long</i> </span></div>`,
    );
    expect(markup).not.toContain('Site <b>id</b>');
  });

  it('renders empty group lists without items', async () => {
    const markup = await render('update', { ...DATA, availableGroups: [], memberships: [] });

    expect(fragmentModel(markup).controls.map(({ name }) => name)).toEqual([
      'name',
      'description',
      'siteid',
      'chainID',
      CSRF_FIELD_TOKEN,
      CSRF_FIELD_EXPIRES,
    ]);
  });

  it('throws when the chain token was not prefetched', () => {
    const ctx = contextFor(adminOn('update', { chainID: CHAIN }));

    expect(() => renderCchainEdit(ctx, DATA)).toThrow(`CSRF tokens for context "${CHAIN}" have not been fetched`);
  });
});

describe('cchain.update page', () => {
  const updateRoute = { [routeKey('GET', 'strategies-content', chainPath(CHAIN))]: view(chainModel()) };

  it('renders the edit form in the shell for the site admin, on the before() defaults', async () => {
    const ctx = contextFor(adminOn('update', { chainID: CHAIN }), updateRoute);

    const page = await renderScreenPage(screenOf('update'), ctx);

    expect(page.kind).toBe('document');
    if (page.kind !== 'document') return;
    expect(page.html).toContain('<h1>Edit Approval Chain</h1>');
    expect(page.html).toContain(`<input type=hidden name="chainID" value="${CHAIN}">`);
    expect(ctx.req.rc).toMatchObject({ ...CCHAIN_RC_DEFAULTS, chainid: CHAIN, siteid: SITE });
  });

  it.each<[string, () => AdminRequest, (location: string) => void]>([
    [
      'the editor back to its referrer',
      () => editorRequest({ circuit: 'cchain', item: 'update', rc: { chainID: CHAIN } }),
      (l) => expect(l).toBe('./'),
    ],
    [
      'an anonymous user to the login form',
      () => anonymousRequest({ circuit: 'cchain', item: 'update', rc: { chainID: CHAIN } }),
      (l) => expect(l).toMatch(/^\.\/\?muraAction=cLogin\.main&returnURL=/),
    ],
    [
      'the tenant-a site admin on another site',
      () => siteAdminRequest(SITE, { circuit: 'cchain', item: 'update', rc: { chainID: CHAIN, siteid: 'tenant-b' } }),
      (l) => expect(l).toBe('./'),
    ],
  ])('sends %s without reading the chain', async (_who, request, expectLocation) => {
    const ctx = contextFor(request(), updateRoute);

    const page = await renderScreenPage(screenOf('update'), ctx);

    expect(page.kind).toBe('redirect');
    if (page.kind === 'redirect') expectLocation(page.location);
    expect(callsTo(ctx.gateway, 'strategies-content').filter(({ path }) => path.includes('approval-chains'))).toEqual(
      [],
    );
  });

  it.each<[401 | 403, string]>([
    [401, LOGOUT],
    [403, NOACCESS],
  ])('answers a strategies-content %i with the access gate redirect', async (status, location) => {
    const ctx = contextFor(adminOn('update', { chainID: CHAIN }), {
      [routeKey('GET', 'strategies-content', chainPath(CHAIN))]: { status, body: {} },
    });

    await expect(renderScreenPage(screenOf('update'), ctx)).resolves.toEqual({ kind: 'redirect', location });
  });
});

describe('cchain.save', () => {
  const LIST = { kind: 'redirect', action: 'cchain.list', append: 'siteid', path: './' } as const;
  const FORM = {
    chainID: CHAIN,
    name: 'Legal',
    description: '',
    groupID: `${LEGAL},${BOARD}`,
    [CSRF_FIELD_TOKEN]: 'T',
    [CSRF_FIELD_EXPIRES]: 'E',
  };

  const saveContext = (reply: FakeReply, partial: AdminRequestPartial = {}) =>
    makeScreenContext({
      req: siteAdminRequest(SITE, { circuit: 'cchain', item: 'save', rc: FORM, ...partial }),
      gateway: fakeGatewayClient({ [routeKey('POST', 'strategies-content', SAVE_PATH)]: reply }),
    });

  it('relays every rc field, before() defaults and CSRF pair included, then redirects to the list', async () => {
    const ctx = saveContext(written({ circuit: 'cchain', action: 'list', params: [['siteid', SITE]] }));

    await expect(screenOf<RedirectScreen>('save').submit(ctx)).resolves.toEqual(LIST);
    const [call] = ctx.gateway.calls;
    expect(call).toMatchObject({ service: 'strategies-content', method: 'POST', path: SAVE_PATH });
    expect(call?.form).toMatchObject({
      ...FORM,
      siteid: SITE,
      userid: '',
      requestid: '',
      actionid: '',
      actiontype: '',
    });
    expect(ctx.gateway.calls).toHaveLength(1);
  });

  it("answers legacy's 500 page when bean errors leave no redirect, since cchain has no save view", async () => {
    const ctx = saveContext(written(null));

    await expect(submitCchainSave(ctx)).resolves.toEqual({
      kind: 'raw',
      response: { status: 500, contentType: LEGACY_HTML_CONTENT_TYPE, body: LEGACY_ERROR_PAGE_HTML },
    });
  });

  it('passes a service Location through', async () => {
    const ctx = saveContext({ status: 302, headers: { location: '/admin/?muraAction=cLogin.main' } });

    await expect(submitCchainSave(ctx)).resolves.toEqual({
      kind: 'location',
      location: '/admin/?muraAction=cLogin.main',
    });
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i', async (status) => {
    const error = await caught(submitCchainSave(saveContext({ status, body: {} })));

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'strategies-content', operation: 'saveApprovalChain', status });
  });

  it('fails on a rejected request', async () => {
    await expect(submitCchainSave(saveContext({ status: 400, body: {} }))).rejects.toThrow(
      'saveApprovalChain answered HTTP 400',
    );
  });
});

describe('cchain.delete', () => {
  const LIST = { kind: 'redirect', action: 'cchain.list', append: 'siteid', path: './' } as const;

  const deleteContext = (reply: FakeReply) =>
    makeScreenContext({
      req: siteAdminRequest(SITE, {
        circuit: 'cchain',
        item: 'delete',
        rc: { chainID: CHAIN, [CSRF_FIELD_TOKEN]: 'T' },
      }),
      gateway: fakeGatewayClient({ [routeKey('POST', 'strategies-content', DELETE_PATH)]: reply }),
    });

  it("relays rc to the chain's delete and follows the service's list redirect to ./", async () => {
    const ctx = deleteContext(written({ circuit: 'cchain', action: 'list', params: [['siteid', 'tenant a&b']] }));

    await expect(screenOf<RedirectScreen>('delete').submit(ctx)).resolves.toEqual({
      kind: 'redirect',
      action: 'cchain.list',
      path: './',
      queryString: 'siteid=tenant+a%26b',
    });
    expect(ctx.gateway.calls[0]).toMatchObject({ method: 'POST', path: DELETE_PATH });
    expect(ctx.gateway.calls[0]?.form).toMatchObject({
      chainID: CHAIN,
      [CSRF_FIELD_TOKEN]: 'T',
      siteid: SITE,
      name: '',
    });
  });

  it.each<[string, FakeReply]>([
    ['a written answer without a redirect', written(null)],
    ['a rejected token (400)', { status: 400, body: {} }],
    ['an unknown chain (404)', { status: 404, body: {} }],
  ])('redirects to the list on %s, as legacy redirects whatever the outcome', async (_label, reply) => {
    await expect(submitCchainDelete(deleteContext(reply))).resolves.toEqual(LIST);
  });

  it('passes a service Location through', async () => {
    const ctx = deleteContext({ status: 302, headers: { location: '/admin/?muraAction=cLogin.main' } });

    await expect(submitCchainDelete(ctx)).resolves.toEqual({
      kind: 'location',
      location: '/admin/?muraAction=cLogin.main',
    });
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i', async (status) => {
    const error = await caught(submitCchainDelete(deleteContext({ status, body: {} })));

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'strategies-content', operation: 'deleteApprovalChain', status });
  });

  it('fails on a service error instead of redirecting', async () => {
    await expect(submitCchainDelete(deleteContext({ status: 500, body: {} }))).rejects.toThrow(
      'deleteApprovalChain answered HTTP 500',
    );
  });

  it('fails closed when strategies-content is unavailable', async () => {
    await expect(submitCchainDelete(deleteContext({ status: 503, body: {} }))).rejects.toBeInstanceOf(
      GatewayUnavailableError,
    );
  });
});
