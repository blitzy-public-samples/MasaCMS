// cperm.main's model and permission grid against admin/core/views/cperm/main.cfm.
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/identity';
import { GatewayDenialError, type ServicePath } from '@/lib/gateway-client';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { cpermScreens } from '@/screens/cperm';
import { cpermMain, loadCpermMain, renderCpermMain, type CpermMainModel } from '@/screens/cperm/main';
import { CONTENT_MODULE_ID, TOP_NODE_ID } from '@/screens/cperm/partials';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import {
  CONTENT_NODE_IDS,
  cpermMainAnswer,
  cpermMainChildAnswer,
  cpermMainSystemGroupsAnswer,
} from '../../fixtures/identity/permissions';
import { adminS2Request, editorRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type ContentPermissions = components['schemas']['ContentPermissions'];

const SITE = 'default';
const ROOT = CONTENT_NODE_IDS.root;
const CHILD = CONTENT_NODE_IDS.child;
/** The Components module, a module root that is not Site Manager. */
const COMPONENTS_MODULE = '00000000000000000000000000000000003';
const CHAINS = [
  { chainID: 'CC000000-0000-0000-0000000000000001', name: 'Legal & Review' },
  { chainID: 'CC000000-0000-0000-0000000000000002', name: 'Board' },
];
const NOACCESS = '/admin/?muraAction=cMessage.noaccess';

const permissionsPath = (contentid: string): ServicePath => `/v1/permissions/content/${contentid}`;
const historyPath = (contentid: string): ServicePath => `/v1/sites/${SITE}/content/${contentid}/history`;
const CHAINS_PATH: ServicePath = `/v1/sites/${SITE}/approval-chains`;

/** A `getCrumbList` struct of carch.hist's `crumbdata`, the node's chain assignment on the active-row crumb. */
const crumb = (values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
  siteid: SITE,
  moduleid: CONTENT_MODULE_ID,
  type: 'Page',
  restricted: 0,
  iconclass: '',
  ...values,
});

const ROOT_CRUMB = crumb({
  contentid: ROOT,
  menutitle: 'Home',
  title: 'Home',
  chainid: CHAINS[1]?.chainID,
  exemptid: GROUP_IDS.defaultEditor.toLowerCase(),
});

interface Answers {
  readonly permissions?: ContentPermissions | FakeReply;
  /** Rows as served, malformed ones included; a reply replaces the whole answer. */
  readonly crumbs?: readonly unknown[] | FakeReply;
  readonly chains?: readonly unknown[] | FakeReply;
}

const isReply = (value: unknown): value is FakeReply =>
  typeof value === 'object' && value !== null && 'status' in value;

/** What `cperm.main` reads: identity's verdicts and groups, strategies-content's crumbs and chains. */
function gatewayFor(
  contentid: string,
  { permissions = cpermMainAnswer, crumbs = [ROOT_CRUMB], chains = CHAINS }: Answers,
): FakeGatewayClient {
  const answer = (value: unknown, body: (v: never) => unknown): FakeReply =>
    isReply(value) ? value : { status: 200, body: body(value as never) };
  return fakeGatewayClient({
    [routeKey('GET', 'identity', permissionsPath(contentid))]: answer(permissions, (v) => v),
    [routeKey('GET', 'strategies-content', historyPath(contentid))]: answer(crumbs, (v) => ({ rc: { crumbdata: v } })),
    [routeKey('GET', 'strategies-content', CHAINS_PATH)]: answer(chains, (v) => ({ rc: { chains: v } })),
    [routeKey('GET', 'identity', '/v1/groups')]: { status: 200, body: cpermMainSystemGroupsAnswer },
  });
}

/** The S2 admin on `cperm.main` of `default` with `rc`. */
const mainRequest = (rc: Readonly<Record<string, string>>, partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ circuit: 'cperm', item: 'main', rc: { siteid: SITE, ...rc }, ...partial });

function contextFor(req: AdminRequest, answers: Answers = {}) {
  const contentid = req.rc.contentid ?? '';
  return makeScreenContext({ req, gateway: gatewayFor(contentid, answers) });
}

/** The page body for `req`, loaded and rendered as the screen does. */
async function renderFor(req: AdminRequest, answers: Answers = {}): Promise<{ markup: string; model: DomModel }> {
  const ctx = contextFor(req, answers);
  const { body } = renderCpermMain(await loadCpermMain(ctx), ctx);
  expect(isSafeHtml(body)).toBe(true);
  const markup = toString(body);
  return { markup, model: fragmentModel(markup) };
}

/** `p<group id without dashes>`, the radio name of a group. */
const radio = (groupId: string): string => `p${groupId.replaceAll('-', '')}`;

/** Each named radio group's checked value, in document order. */
const checkedVerdicts = (model: DomModel): Array<[string, string]> =>
  model.controls.filter((c) => c.type === 'radio' && c.name !== '' && c.checked).map((c) => [c.name, c.value]);

const caught = (promise: Promise<unknown>): Promise<unknown> => promise.catch((error: unknown) => error);

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('loadCpermMain', () => {
  it("reads the verdicts, the node's crumbs, title and chain assignment, the chains and the Admin group", async () => {
    const parent = crumb({ contentid: ROOT, menutitle: 'Home', restricted: '1', iconclass: 'mi-home' });
    // A crumb without `moduleid` reads as Site Manager's; a file crumb without an icon class takes its extension.
    const node = {
      siteid: SITE,
      contentid: CHILD,
      menutitle: 'Report',
      title: 'Annual Report',
      type: 'File',
      fileext: 'PDF',
      restricted: 0,
      iconclass: '',
      chainid: '',
      exemptid: '',
    };
    const ctx = contextFor(mainRequest({ contentid: CHILD, moduleid: CONTENT_MODULE_ID }), {
      permissions: cpermMainChildAnswer,
      crumbs: [node, parent],
    });

    const model = await loadCpermMain(ctx);

    expect(model).toEqual({
      title: 'Annual Report',
      crumbs: [
        { menutitle: 'Report', siteid: SITE, contentid: CHILD, type: 'File', restricted: 0, icon: 'pdf' },
        {
          menutitle: 'Home',
          siteid: SITE,
          contentid: ROOT,
          moduleid: CONTENT_MODULE_ID,
          type: 'Page',
          restricted: 1,
          icon: 'mi-home',
        },
      ],
      privateGroups: cpermMainChildAnswer.groups.map(({ groupId, groupName, perm }) => ({
        userid: groupId,
        groupname: groupName,
        perm,
      })),
      publicGroups: [{ userid: GROUP_IDS.umbrellaMembers, groupname: 'Umbrella Members', perm: 'read' }],
      chains: CHAINS.map(({ chainID, name }) => ({ id: chainID, name })),
      assignment: { chainID: '', exemptID: '' },
      adminGroupId: GROUP_IDS.defaultAdmin,
    });
    expect(ctx.gateway.calls.find(({ path }) => path === permissionsPath(CHILD))?.query).toEqual({ siteid: SITE });
    expect(ctx.gateway.calls.find(({ path }) => path === '/v1/csrf/tokens')?.json).toEqual({ contexts: [CHILD] });
  });

  it('keeps no crumbs outside Site Manager, still reading the title and assignment from the node crumb', async () => {
    const model = await loadCpermMain(contextFor(mainRequest({ contentid: ROOT, moduleid: COMPONENTS_MODULE })));

    expect(model).toMatchObject({
      title: 'Home',
      crumbs: [],
      assignment: { chainID: CHAINS[1]?.chainID, exemptID: GROUP_IDS.defaultEditor.toLowerCase() },
    });
  });

  it('reads a node without an active row as untitled and unassigned when the history read answers 404', async () => {
    const model = await loadCpermMain(
      contextFor(mainRequest({ contentid: ROOT, moduleid: CONTENT_MODULE_ID }), {
        crumbs: { status: 404 },
        chains: [],
      }),
    );

    expect(model).toMatchObject({ title: '', crumbs: [], assignment: { chainID: '', exemptID: '' }, adminGroupId: '' });
  });

  it.each<[string, Answers, RegExp]>([
    [
      'no crumbdata array',
      { crumbs: { status: 200, body: { rc: { crumbdata: {} } } } },
      /getContentHistory returned no rc\.crumbdata array/,
    ],
    [
      'a crumb that is not a struct',
      { crumbs: [[ROOT]] },
      /getContentHistory returned an rc\.crumbdata entry that is not a struct/,
    ],
    [
      'a complex crumb title',
      { crumbs: [crumb({ contentid: ROOT, title: { text: 'Home' } })] },
      /a struct whose title is not a simple value/,
    ],
    [
      'no chains array',
      { chains: { status: 200, body: { rc: {} } } },
      /listApprovalChains returned no rc\.chains array/,
    ],
  ])('rejects a strategies-content model with %s', async (_label, answers, message) => {
    await expect(
      loadCpermMain(contextFor(mainRequest({ contentid: ROOT, moduleid: CONTENT_MODULE_ID }), answers)),
    ).rejects.toThrow(message);
  });

  it.each<[string, Answers, string, string]>([
    ['identity refuses the verdicts', { permissions: { status: 403, body: {} } }, 'identity', 'getContentPermissions'],
    [
      'strategies-content refuses the crumbs',
      { crumbs: { status: 401, body: {} } },
      'strategies-content',
      'getContentHistory',
    ],
    [
      'strategies-content refuses the chains',
      { chains: { status: 403, body: {} } },
      'strategies-content',
      'listApprovalChains',
    ],
  ])('raises GatewayDenialError when %s', async (_when, answers, service, operation) => {
    const error = await caught(loadCpermMain(contextFor(mainRequest({ contentid: ROOT }), answers)));

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service, operation });
  });
});

describe('renderCpermMain', () => {
  it('shows the Site Manager root with its breadcrumb and unset verdicts as Read Only, without Inherit', async () => {
    const { markup, model } = await renderFor(mainRequest({ contentid: ROOT, moduleid: CONTENT_MODULE_ID }), {
      chains: [],
    });

    expect(model.headings).toEqual(['Content Permissions', 'System Groups', 'Member Groups']);
    expect(markup).toContain('<ul class="breadcrumb">');
    expect(markup).toContain('To set permissions for <em>Home</em>');
    expect(model.tables.map(({ headers }) => headers)).toEqual([
      ['Editor', 'Author', 'Read Only', 'Deny', 'Group'],
      ['Editor', 'Author', 'Read Only', 'Deny', 'Group'],
    ]);
    expect(model.tables.map(({ rows }) => rows.map((cells) => cells.at(-1)))).toEqual([
      ['communications.sender', 'Editor', 'finance.approver', 'reporting.exporter'],
      ['Umbrella Members'],
    ]);
    expect(checkedVerdicts(model)).toEqual([
      [radio(GROUP_IDS.communicationsSender), 'read'],
      [radio(GROUP_IDS.defaultEditor), 'editor'],
      [radio(GROUP_IDS.financeApprover), 'author'],
      [radio(GROUP_IDS.reportingExporter), 'deny'],
      [radio(GROUP_IDS.umbrellaMembers), 'editor'],
    ]);
    expect(markup).toContain('<table class="mura-table-grid">');
    expect(markup).toContain('<table class="mura-table-grid no-stripe">');
    expect(model.controls.some(({ name }) => name === 'exemptID' || name === 'chainID')).toBe(false);
  });

  it('shows a child node with Inherit and Read Only columns and its verdicts as stored', async () => {
    const node = crumb({ contentid: CHILD, menutitle: 'Child', title: 'Child' });
    const { model } = await renderFor(mainRequest({ contentid: CHILD, moduleid: CONTENT_MODULE_ID }), {
      permissions: {
        ...cpermMainChildAnswer,
        groups: cpermMainChildAnswer.groups.map((g, i) => (i === 0 ? { ...g, perm: 'none' } : g)),
      },
      crumbs: [node, ROOT_CRUMB],
      chains: [],
    });

    expect(model.tables[0]?.headers).toEqual(['Editor', 'Author', 'Inherit', 'Read Only', 'Deny', 'Group']);
    expect(checkedVerdicts(model)).toEqual([
      [radio(GROUP_IDS.communicationsSender), 'none'],
      [radio(GROUP_IDS.defaultEditor), 'author'],
      [radio(GROUP_IDS.financeApprover), 'read'],
      [radio(GROUP_IDS.reportingExporter), 'editor'],
      [radio(GROUP_IDS.umbrellaMembers), 'read'],
    ]);
  });

  it('shows a non-Site Manager module root with unset verdicts as Deny under the Component heading', async () => {
    const { markup, model } = await renderFor(
      mainRequest({ contentid: COMPONENTS_MODULE, moduleid: COMPONENTS_MODULE, type: 'Component' }),
      { crumbs: { status: 404 }, chains: [] },
    );

    expect(model.headings[0]).toBe('Component Permissions');
    expect(markup).not.toContain('class="breadcrumb"');
    expect(model.tables[0]?.headers).toEqual(['Editor', 'Author', 'Deny', 'Group']);
    expect(checkedVerdicts(model)[0]).toEqual([radio(GROUP_IDS.communicationsSender), 'deny']);
    // An untitled node passes an empty argument list, so MessageFormat leaves the placeholder in place.
    expect(markup).toContain('To set permissions for <em>{1}</em>');
  });

  it('adds the exempt column, the Admin row and the chain select when the site has chains', async () => {
    const { markup, model } = await renderFor(mainRequest({ contentid: ROOT, moduleid: CONTENT_MODULE_ID }));

    expect(model.tables.map(({ headers }) => headers[0])).toEqual(['Approval Chain Exempt', 'Approval Chain Exempt']);
    expect(model.tables[0]?.rows[0]?.at(-1)).toBe('Admin');
    expect(model.headings).toEqual(['Content Permissions', 'System Groups', 'Member Groups', 'Approval Chain']);
    const exempt = model.controls
      .filter(({ name }) => name === 'exemptID')
      .map(({ value, checked }) => [value, checked]);
    expect(exempt).toEqual([
      [GROUP_IDS.defaultAdmin, true],
      [GROUP_IDS.communicationsSender, false],
      [GROUP_IDS.defaultEditor, true],
      [GROUP_IDS.financeApprover, false],
      [GROUP_IDS.reportingExporter, false],
      [GROUP_IDS.umbrellaMembers, false],
    ]);
    // Only an Editor verdict enables the box; the member table compares with legacy's 'editior' and disables every one.
    expect(markup).toContain(`value="${GROUP_IDS.defaultEditor}" checked>`);
    expect(markup).toContain(`value="${GROUP_IDS.financeApprover}" disabled>`);
    expect(markup).toContain(`value="${GROUP_IDS.umbrellaMembers}" disabled>`);
    expect(model.controls.find(({ name }) => name === 'chainID')?.options).toEqual([
      { value: '', label: 'None', selected: false },
      { value: CHAINS[0]?.chainID, label: 'Legal & Review', selected: false },
      { value: CHAINS[1]?.chainID, label: 'Board', selected: true },
    ]);
  });

  it('shows both empty notices when the site has no groups and no chains', async () => {
    const { markup, model } = await renderFor(mainRequest({ contentid: ROOT, moduleid: CONTENT_MODULE_ID }), {
      permissions: { ...cpermMainAnswer, groups: [], publicGroups: [] },
      chains: [],
    });

    expect(model.tables).toEqual([]);
    expect(markup).toContain('<div class="help-block-empty">There are currently no groups available.</div>');
    expect(markup).toContain('<div class="help-block-empty"> There are currently no groups available.</div>');
  });

  it('keeps the system grid for the Admin row when chains exist without system groups', async () => {
    const { model } = await renderFor(mainRequest({ contentid: ROOT, moduleid: CONTENT_MODULE_ID }), {
      permissions: { ...cpermMainAnswer, groups: [] },
    });

    expect(model.tables[0]?.rows.map((cells) => cells.at(-1))).toEqual(['Admin']);
  });

  it('posts to cPerm.update with the encoded ids, the hidden rc values, the referrer and the node token', async () => {
    const req = mainRequest(
      { contentid: ROOT, parentid: 'P 1&2', moduleid: CONTENT_MODULE_ID, startrow: '11', topid: TOP_NODE_ID },
      { headers: new Headers({ referer: 'http://localhost/admin/?muraAction=cArch.list&siteid=default' }) },
    );
    const { markup, model } = await renderFor(req, { chains: [] });

    expect(markup).toContain(`action="./?muraAction=cPerm.update&contentid=${ROOT}&parentid=P+1%262"`);
    expect(model.controls.filter(({ type }) => type === 'hidden').map(({ name, value }) => [name, value])).toEqual([
      ['router', 'http://localhost/admin/?muraAction=cArch.list&siteid=default'],
      ['siteid', SITE],
      ['startrow', '11'],
      ['topid', TOP_NODE_ID],
      ['moduleid', CONTENT_MODULE_ID],
      [CSRF_FIELD_TOKEN, FIXED_CSRF.token],
      [CSRF_FIELD_EXPIRES, FIXED_CSRF.expires],
    ]);
    expect(model.buttons).toEqual([{ text: 'Update', type: 'submit', hasOnclick: true }]);
  });

  it('defaults the hidden rc values as before() params them when the request lacks them', async () => {
    const { model } = await renderFor(mainRequest({ contentid: ROOT }), { chains: [] });

    expect(
      model.controls
        .filter(({ type }) => type === 'hidden')
        .slice(0, 5)
        .map(({ name, value }) => [name, value]),
    ).toEqual([
      ['router', ''],
      ['siteid', SITE],
      ['startrow', '1'],
      ['topid', ''],
      ['moduleid', ''],
    ]);
  });

  const MODEL: CpermMainModel = {
    title: 'Home',
    crumbs: [],
    privateGroups: [],
    publicGroups: [],
    chains: [],
    assignment: { chainID: '', exemptID: '' },
    adminGroupId: '',
  };

  it("fails as legacy's dspZoom does for Site Manager without crumbs", async () => {
    const ctx = contextFor(mainRequest({ contentid: ROOT, moduleid: CONTENT_MODULE_ID }));
    await ctx.csrf.prefetch([ROOT]);

    expect(() => renderCpermMain(MODEL, ctx)).toThrow(RangeError);
  });

  it('throws when the node token was not prefetched', () => {
    const ctx = contextFor(mainRequest({ contentid: ROOT, moduleid: COMPONENTS_MODULE }));

    expect(() => renderCpermMain(MODEL, ctx)).toThrow(`CSRF tokens for context "${ROOT}" have not been fetched`);
  });
});

describe('cperm.main page', () => {
  it('is registered as the identity-owned page', () => {
    expect(cpermScreens).toContain(cpermMain);
    expect(cpermMain).toMatchObject({ circuit: 'cperm', action: 'main', owner: 'identity', mode: 'page' });
  });

  it('renders the grid in the shell for the S2 admin', async () => {
    const ctx = contextFor(mainRequest({ contentid: ROOT, moduleid: CONTENT_MODULE_ID }));

    const page = await renderScreenPage(cpermMain, ctx);

    expect(page.kind).toBe('document');
    if (page.kind === 'document') expect(page.html).toContain('<h1>Content Permissions</h1>');
  });

  it('sends the editor back to its referrer without reading permissions', async () => {
    const req = editorRequest({ circuit: 'cperm', item: 'main', rc: { siteid: SITE, contentid: ROOT } });
    const ctx = contextFor(req);

    await expect(renderScreenPage(cpermMain, ctx)).resolves.toEqual({ kind: 'redirect', location: './' });
    expect(ctx.gateway.calls.filter(({ path }) => path === permissionsPath(ROOT))).toEqual([]);
  });

  it('answers an identity 403 with cMessage.noaccess', async () => {
    const ctx = contextFor(mainRequest({ contentid: ROOT }), { permissions: { status: 403, body: {} } });

    await expect(renderScreenPage(cpermMain, ctx)).resolves.toEqual({ kind: 'redirect', location: NOACCESS });
  });
});
