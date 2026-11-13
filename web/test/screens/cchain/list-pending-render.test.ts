// cchain.list and cchain.pending loaders and markup against cchain/list.cfm, cchain/pending.cfm and dspZoom.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { CORE_VERSION, resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError, type ServicePath } from '@/lib/gateway-client';
import { isSafeHtml, toString, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { loadCchainList, renderCchainList, type CchainListItem } from '@/screens/cchain/list';
import {
  loadCchainPending,
  renderCchainPending,
  type CchainPendingCrumb,
  type CchainPendingData,
  type CchainPendingMember,
  type CchainPendingRequest,
} from '@/screens/cchain/pending';
import { siteAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

type Ctx = Parameters<typeof loadCchainList>[0];

const SITE = 'tenant-a';
const CHAIN_A = 'C1000000-0000-0000-0000000000000001';
const CHAIN_B = 'C1000000-0000-0000-0000000000000002';
const CONTENT_MODULE = '00000000000000000000000000000000000';
const HOME_ID = '00000000000000000000000000000000001';
const EXPIRES = '260630150000000';
const LIST_PATH: ServicePath = `/v1/sites/${SITE}/approval-chains`;
const PENDING_PATH: ServicePath = `/v1/sites/${SITE}/approval-chains/${CHAIN_A}/pending`;
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');

/** Identity issuing `T-<context>` / EXPIRES per context; strategies-content answering `reply` on GET `path`. */
function gatewayFor(path: ServicePath, reply: FakeReply): FakeGatewayClient {
  return fakeGatewayClient({
    [routeKey('GET', 'strategies-content', path)]: reply,
    [CSRF_ROUTE]: (request) => ({
      status: 200,
      body: {
        tokens: (request.json as { contexts: string[] }).contexts.map((context) => ({
          context,
          csrf_token: `T-${context}`,
          csrf_token_expires: EXPIRES,
        })),
      },
    }),
  });
}

function contextFor(req: AdminRequest, gateway: FakeGatewayClient): Ctx {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

const listRequest = (partial: AdminRequestPartial = {}): AdminRequest =>
  siteAdminRequest(SITE, { ...partial, circuit: 'cchain', item: 'list' });

const pendingRequest = (rc: Readonly<Record<string, string>> = {}, site: string = SITE): AdminRequest =>
  siteAdminRequest(site, { circuit: 'cchain', item: 'pending', rc: { chainID: CHAIN_A, ...rc } });

/** Markup with whitespace runs collapsed and whitespace between tags dropped. */
const squash = (markup: string): string => markup.replace(/\s+/g, ' ').replace(/> </g, '><').trim();

function bodyOf(view: { readonly body: SafeHtml }): string {
  expect(isSafeHtml(view.body)).toBe(true);
  return squash(toString(view.body));
}

const ok = (rc: Readonly<Record<string, unknown>>): FakeReply => ({ status: 200, body: { rc } });

const caught = (promise: Promise<unknown>): Promise<unknown> => promise.catch((error: unknown) => error);

beforeEach(() => {
  vi.stubEnv('MURA_CONTEXT', undefined);
  vi.stubEnv('MURA_ADMINDIR', undefined);
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('loadCchainList', () => {
  it('reads the site chains and prefetches one token per chain', async () => {
    const gateway = gatewayFor(
      LIST_PATH,
      ok({
        CHAINS: [
          { CHAINID: CHAIN_A, NAME: 'Legal', SITEID: SITE, LASTUPDATE: '2026-06-30T10:15:00' },
          { chainID: CHAIN_B, name: 'Marketing', siteID: SITE, lastupdate: null },
        ],
      }),
    );

    await expect(loadCchainList(contextFor(listRequest(), gateway))).resolves.toEqual({
      chains: [
        { chainId: CHAIN_A, name: 'Legal', siteId: SITE, lastUpdate: '2026-06-30T10:15:00' },
        { chainId: CHAIN_B, name: 'Marketing', siteId: SITE, lastUpdate: null },
      ],
    });
    expect(gateway.calls).toEqual([
      { service: 'strategies-content', method: 'GET', path: LIST_PATH },
      { service: 'identity', method: 'POST', path: '/v1/csrf/tokens', json: { contexts: [CHAIN_A, CHAIN_B] } },
    ]);
  });

  it('asks identity for nothing without chains', async () => {
    const gateway = gatewayFor(LIST_PATH, ok({ chains: [] }));

    await expect(loadCchainList(contextFor(listRequest(), gateway))).resolves.toEqual({ chains: [] });
    expect(gateway.calls.map(({ service }) => service)).toEqual(['strategies-content']);
  });

  it('refuses an empty site id without a call', async () => {
    const gateway = gatewayFor(LIST_PATH, ok({ chains: [] }));

    await expect(loadCchainList(contextFor(listRequest({ rc: { siteid: '' } }), gateway))).rejects.toThrow(TypeError);
    expect(gateway.calls).toEqual([]);
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i', async (status) => {
    const gateway = gatewayFor(LIST_PATH, { status, body: {} });

    const error = await caught(loadCchainList(contextFor(listRequest(), gateway)));

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'strategies-content', operation: 'listApprovalChains', status });
    expect(gateway.calls).toHaveLength(1);
  });

  it.each<[string, Readonly<Record<string, unknown>>, RegExp]>([
    ['no chains array', { chains: 'none' }, /no rc\.chains array/],
    ['a non-struct entry', { chains: [[CHAIN_A]] }, /not a struct/],
    ['a complex value', { chains: [{ chainID: CHAIN_A, name: { text: 'Legal' } }] }, /name is not a simple value/],
  ])('rejects %s', async (_label, rc, message) => {
    const gateway = gatewayFor(LIST_PATH, ok(rc));

    await expect(loadCchainList(contextFor(listRequest(), gateway))).rejects.toThrow(message);
  });
});

describe('renderCchainList', () => {
  const header =
    `<script src="assets/js/approvalchain.js?coreversion=${CORE_VERSION}" type="text/javascript" ></script>` +
    '<div class="mura-header"><h1>Approval Chains</h1><div class="nav-module-specific btn-group">' +
    `<a class="btn" title="Add Approval Chain" href="./?muraAction=cchain.edit&chainID=&siteid=${SITE}">` +
    '<i class="mi-plus-circle"></i> Add Approval Chain</a></div></div><!-- /.mura-header -->' +
    '<div class="block block-constrain"><div class="block block-bordered"><div class="block-content">';
  const footer = '</div><!-- /.block-content --></div><!-- /.block-bordered --></div><!-- /.block-constrain -->';

  async function render(chains: readonly CchainListItem[]): Promise<string> {
    const gateway = gatewayFor(LIST_PATH, ok({}));
    const ctx = contextFor(listRequest(), gateway);
    await ctx.csrf.prefetch(chains.map(({ chainId }) => chainId));
    return bodyOf(renderCchainList(ctx, { chains }));
  }

  const row = (chainId: string, pendingSite: string, name: string, lastUpdate: string): string =>
    '<tr><td class="actions"><a class="show-actions" href="javascript:;" onclick="showTableControls(this);">' +
    '<i class="mi-ellipsis-v"></i></a><div class="actions-menu hide"><ul class="actions-list"><li class="edit">' +
    `<a href="./?muraAction=cchain.edit&chainID=${chainId}&siteid=${SITE}"><i class="mi-pencil"></i>Edit</a></li>` +
    `<li class="change-sets"><a href="./?muraAction=cchain.pending&chainID=${chainId}&siteid=${pendingSite}">` +
    '<i class="mi-reorder"></i>Pending Requests</a></li><li class="delete">' +
    `<a href="./?muraAction=cchain.delete&chainID=${chainId}&siteid=${SITE}` +
    `&csrf_token=T-${chainId}&csrf_token_expires=${EXPIRES}" ` +
    `onClick="return confirmDialog('Delete\\x20Approval\\x20Chain\\x3F',this.href)">` +
    '<i class="mi-trash"></i>Delete</a></li></ul></div></td><td class="var-width">' +
    `<a title="Edit" href="./?muraAction=cchain.pending&chainID=${chainId}&siteid=${SITE}">${name}</a></td>` +
    `<td>${lastUpdate}</td></tr>`;

  it('renders the populated list', async () => {
    const markup = await render([
      { chainId: CHAIN_A, name: 'Legal & <Review> "1"', siteId: 'tenant a&b', lastUpdate: '2026-06-30T10:15:00' },
      { chainId: CHAIN_B, name: 'Marketing', siteId: SITE, lastUpdate: null },
    ]);

    expect(markup).toBe(
      header +
        '<table class="mura-table-grid"><thead><tr><th class="actions"></th><th class="var-width">Name</th>' +
        '<th>Last Update</th></tr></thead><tbody class="nest">' +
        row(CHAIN_A, 'tenant+a%26b', 'Legal &amp; &lt;Review&gt; &quot;1&quot;', ' 06/181/2026 10:15:00 AM ') +
        row(CHAIN_B, SITE, 'Marketing', '') +
        '</tbody></table>' +
        footer,
    );
  });

  it('leaves an unparsable last update blank', async () => {
    const markup = await render([{ chainId: CHAIN_A, name: 'Legal', siteId: SITE, lastUpdate: 'soon' }]);

    expect(markup).toContain('Legal</a></td><td></td></tr>');
  });

  it('renders the empty notice', async () => {
    expect(await render([])).toBe(
      `${header}<div class="help-block-empty">There are currently no approval chains</div>${footer}`,
    );
  });
});

const crumb = (contentid: string, menutitle: string, extra: Partial<CchainPendingCrumb> = {}): CchainPendingCrumb => ({
  menutitle,
  siteid: SITE,
  contentid,
  type: 'Page',
  restricted: false,
  icon: 'mi-file',
  ...extra,
});

const CRUMBS: readonly CchainPendingCrumb[] = [
  crumb('P1', 'About & Us'),
  crumb('F1', 'Members', { type: 'Folder', restricted: true, icon: 'mi-folder-open', moduleid: CONTENT_MODULE }),
  crumb(HOME_ID, 'Home', { icon: 'mi-home' }),
];

const request = (extra: Partial<CchainPendingRequest> = {}): CchainPendingRequest => ({
  contentHistId: 'H1',
  contentId: 'P1',
  type: 'Page',
  parentId: 'F1',
  siteId: SITE,
  moduleId: CONTENT_MODULE,
  changesetId: 'CS1',
  changesetName: 'Summer & <Launch>',
  changesetPublishDate: '2026-07-15T09:00:00',
  lastUpdateBy: 'Tessa <Admin>',
  created: '2026-06-30T10:15:00',
  previewUrl: 'http://tenant-a.localhost/about/?previewid=H1',
  crumbs: CRUMBS,
  ...extra,
});

const pendingData = (
  members: readonly CchainPendingMember[],
  hasChangesets = true,
  description = 'Two & <steps>',
): CchainPendingData => ({
  chain: { chainId: CHAIN_A, name: 'Legal & <Review>', description, isNew: false },
  hasChangesets,
  members,
});

describe('loadCchainPending', () => {
  const wireRequest = {
    contentHistID: 'H1',
    contentID: 'P1',
    type: 'Page',
    parentID: 'F1',
    siteID: SITE,
    moduleID: CONTENT_MODULE,
    changesetID: 'CS1',
    changesetName: 'Summer & <Launch>',
    changesetPublishDate: '2026-07-15T09:00:00',
    lastUpdateBy: 'Tessa <Admin>',
    created: '2026-06-30T10:15:00',
    previewURL: 'http://tenant-a.localhost/about/?previewid=H1',
    crumbArray: [
      {
        menutitle: 'About & Us',
        siteid: SITE,
        contentid: 'P1',
        moduleid: null,
        type: 'Page',
        restricted: 0,
        icon: 'mi-file',
      },
      {
        MENUTITLE: 'Members',
        SITEID: SITE,
        CONTENTID: 'F1',
        MODULEID: CONTENT_MODULE,
        TYPE: 'Folder',
        RESTRICTED: '1',
        ICON: 'mi-folder-open',
      },
      { menutitle: 'Home', siteid: SITE, contentid: HOME_ID, type: 'Page', restricted: false, icon: 'mi-home' },
    ],
  };
  const wire = (extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
    chain: { chainID: CHAIN_A, name: 'Legal & <Review>', description: 'Two & <steps>', isNew: 0 },
    hasChangesets: 1,
    members: [
      { groupName: 'Editors & Co', requests: [wireRequest] },
      { GROUPNAME: 'Publishers', REQUESTS: [] },
    ],
    ...extra,
  });
  const loaded = pendingData([
    { groupName: 'Editors & Co', requests: [request()] },
    { groupName: 'Publishers', requests: [] },
  ]);

  it('reads the chain, its members and their requests in one call', async () => {
    const gateway = gatewayFor(PENDING_PATH, ok(wire()));

    await expect(loadCchainPending(contextFor(pendingRequest(), gateway))).resolves.toEqual(loaded);
    expect(gateway.calls).toEqual([{ service: 'strategies-content', method: 'GET', path: PENDING_PATH }]);
  });

  it.each<[string, unknown, boolean]>([
    ['true', true, true],
    ['"false"', 'false', false],
  ])('reads hasChangesets %s from the model', async (_label, value, expected) => {
    const gateway = gatewayFor(PENDING_PATH, ok(wire({ hasChangesets: value })));

    const data = await loadCchainPending(contextFor(pendingRequest(), gateway));

    expect(data.hasChangesets).toBe(expected);
  });

  it('falls back to the site hasChangesets and a saved chain', async () => {
    const { hasChangesets: _omitted, ...rc } = wire({ chain: { chainID: CHAIN_A, name: 'Legal', description: null } });
    const gateway = gatewayFor(PENDING_PATH, ok(rc));
    const req = siteAdminRequest(SITE, {
      circuit: 'cchain',
      item: 'pending',
      rc: { chainID: CHAIN_A },
      site: { hasChangesets: true },
    });

    const data = await loadCchainPending(contextFor(req, gateway));

    expect(data.hasChangesets).toBe(true);
    expect(data.chain).toEqual({ chainId: CHAIN_A, name: 'Legal', description: '', isNew: false });
  });

  it('needs the site when the model has no hasChangesets', async () => {
    const { hasChangesets: _omitted, ...rc } = wire();
    const path: ServicePath = `/v1/sites/tenant-b/approval-chains/${CHAIN_A}/pending`;
    const req = pendingRequest({}, 'tenant-b');
    expect(req.site).toBeUndefined();

    await expect(loadCchainPending(contextFor(req, gatewayFor(path, ok(rc))))).rejects.toThrow(
      'cchain.pending needs the site hasChangesets setting',
    );
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i', async (status) => {
    const gateway = gatewayFor(PENDING_PATH, { status, body: {} });

    const error = await caught(loadCchainPending(contextFor(pendingRequest(), gateway)));

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'strategies-content', operation: 'listPendingApprovals', status });
  });

  it.each<[string, Readonly<Record<string, unknown>>, string]>([
    ['no chain', { chain: null }, 'chain is not a struct'],
    ['members that are not structs', { members: ['Editors'] }, 'members is not an array of structs'],
    ['a complex value', { chain: { chainID: CHAIN_A, name: ['Legal'] } }, 'name is not a simple value'],
  ])('rejects %s', async (_label, extra, message) => {
    const gateway = gatewayFor(PENDING_PATH, ok(wire(extra)));

    await expect(loadCchainPending(contextFor(pendingRequest(), gateway))).rejects.toThrow(message);
  });
});

describe('renderCchainPending', () => {
  const render = (data: CchainPendingData, rc: Readonly<Record<string, string>> = {}): string =>
    bodyOf(renderCchainPending(contextFor(pendingRequest(rc), gatewayFor(PENDING_PATH, ok({}))), data));

  const header =
    '<div class="mura-header"><h1>Approval Chains</h1><div class="nav-module-specific btn-group">' +
    `<a class="btn" title="Back to Approval Chains" href="./?muraAction=cchain.list&siteid=${SITE}">` +
    '<i class="mi-arrow-circle-left"></i> Back to Approval Chains</a>' +
    `<a class="btn" title="View Edit Form" href="./?muraAction=cchain.edit&siteid=${SITE}&chainID=${CHAIN_A}">` +
    '<i class="mi-pencil"></i> View Edit Form</a></div></div><!-- /.mura-header -->' +
    '<div class="block block-constrain"><div class="block block-bordered"><div class="block-content">' +
    '<h2>Pending Requests</h2><h3>Legal &amp; &lt;Review&gt;</h3>';
  const footer = '</div><!-- /.block-content --></div><!-- /.block-bordered --></div><!-- /.block-constrain -->';
  const listHref = (topid: string): string =>
    `/admin/?muraAction=cArch.list&siteid=${SITE}&topid=${topid}&moduleid=${CONTENT_MODULE}&activeTab=0`;
  const target = `&contentid=P1&type=Page&parentid=F1&siteid=${SITE}&moduleid=${CONTENT_MODULE}`;
  const zoom =
    `<ul class="breadcrumb"><li class=""><a href="${listHref(HOME_ID)}" ><i class="mi-home"></i>Home</a></li>` +
    `<li class="locked"><a href="${listHref('F1')}" ><i class="mi-folder-open"></i>Members</a></li>` +
    `<li class="locked"><strong><a href="${listHref('P1')}" ><i class="mi-file"></i>About &amp; Us</a></strong></li>` +
    '</ul>';
  const previewItem =
    '<li class="preview"><a href="#" ' +
    'onclick="return preview(\'http://tenant-a.localhost/about/?previewid=H1\',\'\');">' +
    '<i class="mi-globe"></i> Preview</a></li>';
  const assignments =
    `<a href="./?muraAction=cChangesets.assignments&siteID=${SITE}&changesetID=CS1">Summer &amp; &lt;Launch&gt;</a>`;
  const changesetCell =
    `<td><a href="#" rel="tooltip" title="&#x20;09ort"><i class="mi-calendar"></i></a>${assignments}</td>`;
  const row =
    '<tr><td class="actions"><a class="show-actions" href="javascript:;" onclick="showTableControls(this);">' +
    '<i class="mi-ellipsis-v"></i></a><div class="actions-menu hide"><ul class="actions-list"><li class="edit">' +
    `<a href="./?muraAction=cArch.edit&contenthistid=H1${target}&return=chain">` +
    '<i class="mi-pencil"></i> Edit </a></li>' +
    previewItem +
    `<li class="version-history"><a href="./?muraAction=cArch.hist${target}">` +
    '<i class="mi-history"></i> Version History</a></li></ul></div></td>' +
    `<td class="title var-width">${zoom}</td>${changesetCell}` +
    '<td>Tessa &lt;Admin&gt;</td><td>06/181/2026 10:15:00 AM</td></tr>';

  it('renders members with and without pending requests', () => {
    const markup = render(
      pendingData([
        { groupName: 'Editors & Co', requests: [request()] },
        { groupName: 'Publishers', requests: [] },
      ]),
    );

    expect(markup).toBe(
      `${header}<p>Two &amp; &lt;steps&gt;</p><hr /><h4>1. Editors &amp; Co</h4>` +
        '<table class="mura-table-grid"><tr><th class="actions"></th><th class="var-width">Title</th>' +
        '<th>Change Set</th><th> Request By</th><th> Request Date</th></tr>' +
        row +
        '</table><h4>2. Publishers</h4>' +
        '<div class="help-block-empty">No pending requests exist for this group in the approval chain.</div>' +
        footer,
    );
  });

  it('renders the no-groups notice without a description', () => {
    expect(render(pendingData([], true, ''))).toBe(
      `${header}<div class="help-block-empty">No groups have been assigned to this approval chain yet.</div>${footer}`,
    );
  });

  it('omits the change-set column without change sets', () => {
    const markup = render(pendingData([{ groupName: 'Editors', requests: [request()] }], false));

    expect(markup).not.toContain('Change Set');
    expect(markup).not.toContain('cChangesets.assignments');
    expect(markup).toContain(`<th class="var-width">Title</th><th> Request By</th>`);
    expect(markup).toContain(`${zoom}</td><td>Tessa &lt;Admin&gt;</td>`);
  });

  it.each<[string, Partial<CchainPendingRequest>, string]>([
    ['NA without a change set', { changesetId: '' }, '<td> NA </td>'],
    ['no tooltip without a publish date', { changesetPublishDate: '' }, `<td>${assignments}</td>`],
  ])('renders %s', (_label, extra, cell) => {
    const markup = render(pendingData([{ groupName: 'Editors', requests: [request(extra)] }]));

    expect(markup).toContain(`${zoom}</td>${cell}<td>Tessa &lt;Admin&gt;</td>`);
  });

  it.each(['Page', 'folder', 'Calendar', 'Gallery', 'Link', 'File'])('offers a preview for %s', (type) => {
    const markup = render(pendingData([{ groupName: 'Editors', requests: [request({ type })] }]));

    expect(markup).toContain(`<li class="preview"><a href="#" onclick="return preview(`);
  });

  it.each(['Component', 'Form', 'Variation'])('offers no preview for %s', (type) => {
    const markup = render(pendingData([{ groupName: 'Editors', requests: [request({ type })] }]));

    expect(markup).not.toContain('class="preview"');
    expect(markup).toContain(`&type=${type}&parentid=F1`);
  });

  it('posts the JS-encoded preview URL in compact display', () => {
    const markup = render(pendingData([{ groupName: 'Editors', requests: [request()] }]), { compactDisplay: 'true' });

    expect(markup).toContain(
      '<li class="preview"><a href="#" onclick="frontEndProxy.post({cmd:\'setLocation\',location:encodeURIComponent(' +
        "'http\\x3A\\x2F\\x2Ftenant\\x2Da.localhost\\x2Fabout\\x2F\\x3Fpreviewid\\x3DH1')});return false;\">" +
        '<i class="mi-globe"></i> Preview</a></li>',
    );
  });

  // Values and outcomes measured against ACF's `rc.compactDisplay eq 'true'` in legacy pending.cfm; the padded and NUL
  // values through the admin layout choice, which reads the same scanned `rc.compactDisplay`.
  it.each<[string | undefined, boolean]>([
    ['true', true],
    ['TRUE', true],
    ['True', true],
    ['1', true],
    ['yes', true],
    ['YES', true],
    [' yes', true],
    ['1.0', true],
    ['1e0', true],
    [' TRUE', true],
    ['TRUE ', true],
    [' True', true],
    ['tr\u0000ue', true],
    ['TRUE\u0001', true],
    ['\u0001true', false],
    ['true\u0001', false],
    [' FALSE', false],
    [undefined, false],
    ['false', false],
    ['0', false],
    ['no', false],
    [' true', false],
    ['true ', false],
    ['2', false],
    ['1.', false],
    ['', false],
  ])('chooses the compact preview for compactDisplay %j: %s', (compactDisplay, compact) => {
    const rc: Readonly<Record<string, string>> = compactDisplay === undefined ? {} : { compactDisplay };
    const markup = render(pendingData([{ groupName: 'Editors', requests: [request()] }]), rc);

    expect(markup).toContain(
      `<li class="preview"><a href="#" onclick="${compact ? 'frontEndProxy.post(' : 'return preview('}`,
    );
  });

  it('URL-encodes the type and site of the row links', () => {
    const markup = render(
      pendingData([{ groupName: 'Editors', requests: [request({ type: 'Page Draft', siteId: 'tenant a&b' })] }]),
    );

    expect(markup).toContain('&type=Page+Draft&parentid=F1&siteid=tenant+a%26b&moduleid=');
    expect(markup).toContain('&siteID=tenant a&b&changesetID=CS1');
    expect(markup).not.toContain('class="preview"');
  });

  it('marks a file crumb with its type and a node under no restriction unlocked', () => {
    const file = crumb('D1', 'Guide.pdf', { type: 'File', icon: 'pdf-file' });
    const markup = render(
      pendingData([{ groupName: 'Editors', requests: [request({ crumbs: [file, crumb(HOME_ID, 'Home')] })] }]),
    );

    expect(markup).toContain(
      `<li class=""><a href="${listHref(HOME_ID)}" ><i class="mi-file"></i>Home</a></li>` +
        `<li class=" file" data-filetype="pdf-"><strong><a href="${listHref('D1')}" >` +
        '<i class="pdf-file"></i>Guide.pdf</a></strong></li>',
    );
  });

  it('prints an empty request date blank', () => {
    const markup = render(pendingData([{ groupName: 'Editors', requests: [request({ created: '' })] }]));

    expect(markup).toContain('<td>Tessa &lt;Admin&gt;</td><td></td></tr>');
  });

  it.each<[string, Partial<CchainPendingRequest>]>([
    ['an unparsable request date', { created: 'yesterday' }],
    ['an empty crumb array', { crumbs: [] }],
  ])('fails on %s', (_label, extra) => {
    expect(() => render(pendingData([{ groupName: 'Editors', requests: [request(extra)] }]))).toThrow(RangeError);
  });
});
