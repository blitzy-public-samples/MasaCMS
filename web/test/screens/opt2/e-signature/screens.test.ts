// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
// The e-signature screens over the contract's v1 reads: DOM snapshots, service calls, roles and refusals.
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, type Role } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/e-signature';
import { secure } from '@/lib/access-gate';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { esignatureScreens } from '@/screens/opt2/e-signature';
import { CREATE_REQUEST_FIELDS, renderRequestsView } from '@/screens/opt2/e-signature/requests';
import { alertBox, GUARDED_SUBMIT } from '@/screens/opt2/shared';
import type { Opt2ScreenDefinition, ScreenContext } from '@/screens/registry';
import { adminS2Request, anonymousRequest, makeAdminRequest, opt2RoleRequest } from '../../../helpers/admin-request';
import { fragmentModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
  type RecordedRequest,
} from '../../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../../helpers/screen-context';
import { SUBJECTS } from '../../../helpers/tokens';
import {
  ESIGNATURE_IDS,
  auditChain,
  eSignatureAnswers,
  pendingRequest,
  signatureRequestList,
  signedRequestDetail,
  verifyTampered,
} from '../../../fixtures/opt2/e-signature';

// The registry module loads every circuit; these suites stand in for it with the shell hooks the pages render with.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const SIGNER = Roles.esignatureSigner;
const AUDITOR = Roles.esignatureAuditor;
const SIGNED_ID = ESIGNATURE_IDS.signedRequest;
const PENDING_ID = ESIGNATURE_IDS.pendingRequest;
const SITE = SUBJECTS[SIGNER].site;
const REQUESTS_PATH = '/v1/esignature/requests';
const CREATE_ACTION_URL = `/opt2/admin-actions/e-signature/create-request?siteid=${SITE}`;
const ADMIN_CSS = readFileSync(new URL('../../../../../admin/assets/css/admin.css', import.meta.url), 'utf8');
const FR = rbFor('fr');
const FIRST_OF_TWO_PAGES = {
  ...auditChain,
  items: auditChain.items?.slice(0, 1),
  endindex: 1,
  itemsperpage: 1,
  totalpages: 2,
};

/** A request list answer of three full pages, page 1 or the one `pageindex` names. */
const threePages = (pageindex = 1) => ({ ...signatureRequestList, pageindex, totalitems: 150, totalpages: 3 });

/** The DOM text of French admin-bundle label `key`, which the screens write unencoded. */
function fr(key: string): string {
  return cheerio.load(FR.rbKey(key), null, false).text();
}

type Rc = Readonly<Record<string, string>>;
type VerifyResult = components['schemas']['VerifyResult'];

/** The registered e-signature screen `slug`. */
function screenOf(slug: string): Opt2ScreenDefinition {
  const def = esignatureScreens.find((candidate) => candidate.screen === slug);
  if (def === undefined) throw new TypeError(`e-signature/${slug} is not registered`);
  return def;
}

/** A screen context for `req` over the fixture answers, with `routes` laid over them. */
function contextOf(req: AdminRequest, routes: FakeRouteTable = {}): ScreenContext & {
  gateway: FakeGatewayClient;
} {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ ...eSignatureAnswers, ...routes }) });
}

/** A screen context for the tenant-a holder of `roles` with `rc`, whose token user is `sub`: by default the fixture signer. */
function contextFor(
  roles: readonly Role[],
  rc: Rc = {},
  routes: FakeRouteTable = {},
  sub: string = ESIGNATURE_IDS.signer,
) {
  const [first = SIGNER] = roles;
  return contextOf(opt2RoleRequest(first, { rc, user: { sub, roles: [Roles.systemUser, ...roles] } }), routes);
}

/** The screen body markup `slug` renders for `ctx`, after checking the view marks the module. */
async function bodyOf(slug: string, ctx: ScreenContext): Promise<string> {
  const def = screenOf(slug);
  const view = await def.render(ctx, await def.load(ctx));
  expect(view.opt2Module).toBe('e-signature');
  return toString(view.body);
}

/** The calls made to e-signature, without the shell's and identity's. */
function eSignatureCalls(gateway: FakeGatewayClient) {
  return gateway.calls.filter((call) => call.service === 'e-signature');
}

/** Contexts identity was asked to issue CSRF pairs for. */
function csrfContexts(gateway: FakeGatewayClient): unknown[] {
  return gateway.calls
    .filter((call) => call.service === 'identity' && call.path === '/v1/csrf/tokens')
    .flatMap((call) => (call.json as { contexts: unknown[] }).contexts);
}

/** A Masa JSON API error envelope answered with `status`. */
function refusal(status: number, message: string): FakeReply {
  return { status, body: { apiversion: 'v1', method: 'esignature.requests', error: { code: 'invalid_request', message } } };
}

/** Each class token in `markup`, once. */
function classesOf(markup: string): string[] {
  const $ = cheerio.load(markup, null, false);
  const tokens = $('[class]')
    .toArray()
    .flatMap((el) => ($(el).attr('class') ?? '').split(/\s+/).filter((token) => token !== ''));
  return [...new Set(tokens)];
}

const key = (method: 'GET' | 'POST', path: string): string => routeKey(method, 'e-signature', path as `/${string}`);

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

const SNAPSHOT_CASES: ReadonlyArray<readonly [string, string, readonly Role[], Rc]> = [
  ['requests', 'the request list', [SIGNER], {}],
  ['requests', 'the request lookup for an auditor', [AUDITOR], {}],
  ['request', 'a pending request with the typed-name form', [SIGNER], { id: PENDING_ID }],
  ['request', 'a signed request with its signature', [AUDITOR], { id: SIGNED_ID }],
  ['audit', 'the audit chain', [AUDITOR], { id: SIGNED_ID }],
  ['verify', 'the stored verdict and the copy form', [AUDITOR], { id: SIGNED_ID }],
];

describe('e-signature screen markup', () => {
  it.each(SNAPSHOT_CASES)('%s renders %s', async (slug, _case, roles, rc) => {
    expect(fragmentModel(await bodyOf(slug, contextFor(roles, rc)))).toMatchSnapshot();
  });

  it.each(SNAPSHOT_CASES)('%s (%s) uses only classes of the legacy admin stylesheet', async (slug, _case, roles, rc) => {
    const classes = classesOf(await bodyOf(slug, contextFor(roles, rc)));
    expect(classes).toEqual(expect.arrayContaining(['mura-header', 'block-content']));
    for (const name of classes) expect(ADMIN_CSS, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
  });

  it('renders inside the legacy shell with e-signature active in the OPT-2 nav', async () => {
    const page = await renderScreenPage(screenOf('requests'), contextFor([SIGNER]));
    if (page.kind !== 'document') throw new TypeError(`Redirected to ${page.location}`);
    const $ = cheerio.load(page.html);
    expect($('#admin-nav-opt2 ul a.active').attr('href')).toBe(`/opt2/admin/e-signature/requests?siteid=${SITE}`);
    expect($('div.mura-header h1').toArray().map((el) => $(el).text())).toContain('Signature Requests');
  });

  it('lands an auditor in the shell with e-signature active and the request lookup', async () => {
    const page = await renderScreenPage(screenOf('requests'), contextFor([AUDITOR]));
    if (page.kind !== 'document') throw new TypeError(`Redirected to ${page.location}`);
    const $ = cheerio.load(page.html);
    expect($('#admin-nav-opt2 ul a.active').attr('href')).toBe(`/opt2/admin/e-signature/requests?siteid=${SITE}`);
    expect($('div.mura-header h1').toArray().map((el) => $(el).text())).toContain('Signature Requests');
    expect($('form input[name="id"]')).toHaveLength(1);
  });

  it('encodes service text into markup and attributes', async () => {
    const hostile = '"><script>alert(1)</script>';
    const list = { ...signatureRequestList, items: [{ ...pendingRequest, document_name: hostile, signer_user_id: hostile }] };
    const markup = await bodyOf('requests', contextFor([SIGNER], {}, { [key('GET', REQUESTS_PATH)]: { status: 200, body: list } }));
    const $ = cheerio.load(markup, null, false);
    expect($('script')).toHaveLength(0);
    expect($('table.mura-table-grid tbody tr td').first().text()).toBe(hostile);
    expect(markup).toContain('&lt;script&gt;');
  });

  it('keeps every hash as the service returned it and computes none', async () => {
    const $ = cheerio.load(await bodyOf('audit', contextFor([AUDITOR], { id: SIGNED_ID })), null, false);
    const values = $('dl > dd').toArray().map((el) => $(el).text());
    for (const entry of auditChain.items ?? []) {
      expect(values).toEqual(expect.arrayContaining([entry.prev_hash, entry.entry_hash, entry.detail, entry.at]));
    }
  });

  it('shows the audit entries as label and value rows in one block, a rule between each, no grid', async () => {
    const $ = cheerio.load(await bodyOf('audit', contextFor([AUDITOR], { id: SIGNED_ID })), null, false);
    const content = $('div.block-content');
    expect(content).toHaveLength(1);
    expect($('div.block-constrain')).toHaveLength(1);
    expect(content.find('.block')).toHaveLength(0);
    const entries: string[][] = [[]];
    for (const child of content.children('dl, hr').toArray()) {
      if ($(child).is('hr')) entries.push([]);
      else entries.at(-1)?.push($(child).children('dt').text());
    }
    expect(entries).toEqual(
      (auditChain.items ?? []).map(() => ['Sequence', 'Action', 'Actor', 'Detail', 'At', 'Previous Hash', 'Hash']),
    );
    expect($('table')).toHaveLength(0);
    expect($('label')).toHaveLength(0);
  });

  it.each<[string, readonly Role[], Rc, Readonly<Record<string, FakeReply>>, string[]]>([
    [
      'requests',
      [SIGNER],
      {},
      {},
      ['Document', fr('params.state'), 'Signer', fr('params.created'), fr('sitemanager.content.actions'),
        'Document Name', 'Document (Base64)', 'Signer User ID'],
    ],
    [
      'request',
      [AUDITOR],
      { id: SIGNED_ID },
      {},
      ['Document', fr('params.state'), 'Signer', fr('params.created'), fr('sitemanager.content.createdby'),
        'Document SHA-256', 'Typed Name', 'Signed By', 'Signed At'],
    ],
    [
      'audit',
      [AUDITOR],
      { id: SIGNED_ID },
      { [key('GET', `${REQUESTS_PATH}/${SIGNED_ID}/audit`)]: { status: 200, body: FIRST_OF_TWO_PAGES } },
      ['Sequence', fr('approvalchains.action'), 'Actor', 'Detail', 'At', 'Previous Hash', 'Hash', 'Affichage des résultats 1-1 sur 2'],
    ],
  ])('%s takes its catalogued labels from the French admin bundle', async (slug, roles, rc, routes, expected) => {
    const req = opt2RoleRequest(roles[0] ?? SIGNER, { rc, user: { roles: [Roles.systemUser, ...roles] } });
    const ctx = makeScreenContext({ req, gateway: fakeGatewayClient({ ...eSignatureAnswers, ...routes }), rb: FR });
    const $ = cheerio.load(await bodyOf(slug, ctx), null, false);
    expect($('dt, label, th, p.search-showing').toArray().map((el) => $(el).text())).toEqual(expected);
  });

  it('shows an empty audit chain with the empty-list message', async () => {
    const empty = { ...auditChain, items: [], startindex: 1, endindex: 0, totalitems: 0, totalpages: 0 };
    const routes = { [key('GET', `${REQUESTS_PATH}/${SIGNED_ID}/audit`)]: { status: 200, body: empty } };
    const $ = cheerio.load(await bodyOf('audit', contextFor([AUDITOR], { id: SIGNED_ID }, routes)), null, false);
    expect($('div.help-block-empty').text()).toBe('There are no audit entries for this request.');
    expect($('dl')).toHaveLength(0);
  });
});

describe('e-signature service calls', () => {
  it.each<[string, Rc, string]>([
    ['no page', {}, '1'],
    ['page 2', { pageIndex: '2' }, '2'],
    ['a page that is not a whole number from 1', { pageIndex: 'x' }, '1'],
  ])('lists requests for %s', async (_case, rc, pageIndex) => {
    const ctx = contextFor([SIGNER], rc, { [key('GET', REQUESTS_PATH)]: { status: 200, body: threePages() } });
    await bodyOf('requests', ctx);
    expect(eSignatureCalls(ctx.gateway)).toEqual([
      { service: 'e-signature', method: 'GET', path: REQUESTS_PATH, query: { pageIndex } },
    ]);
  });

  it('reads a pending request and issues the sign form a CSRF pair of its id', async () => {
    const ctx = contextFor([SIGNER], { id: PENDING_ID });
    const markup = await bodyOf('request', ctx);
    expect(eSignatureCalls(ctx.gateway)).toEqual([
      { service: 'e-signature', method: 'GET', path: `${REQUESTS_PATH}/${PENDING_ID}` },
    ]);
    expect(csrfContexts(ctx.gateway)).toEqual([PENDING_ID]);
    const form = cheerio.load(markup, null, false)('form');
    expect(form.attr('action')).toBe(`/opt2/admin-actions/e-signature/sign?siteid=${SITE}&id=${PENDING_ID}`);
    expect(form.find('input[name="csrf_token"]').attr('value')).toBe(FIXED_CSRF.token);
  });

  it('pages the audit chain of request rc.id', async () => {
    const chain = { ...auditChain, pageindex: 3, totalitems: 150, totalpages: 3 };
    const routes = { [key('GET', `${REQUESTS_PATH}/${SIGNED_ID}/audit`)]: { status: 200, body: chain } };
    const ctx = contextFor([AUDITOR], { id: SIGNED_ID, pageIndex: '3' }, routes);
    const $ = cheerio.load(await bodyOf('audit', ctx), null, false);
    expect(eSignatureCalls(ctx.gateway)).toEqual([
      { service: 'e-signature', method: 'GET', path: `${REQUESTS_PATH}/${SIGNED_ID}/audit`, query: { pageIndex: '3' } },
    ]);
    expect($('ul.pagination a').first().attr('href')).toBe(
      `/opt2/admin/e-signature/audit?siteid=${SITE}&id=${SIGNED_ID}&pageIndex=2`,
    );
  });

  it('shows page 1 of the audit chain for a page past the last', async () => {
    const audit = `${REQUESTS_PATH}/${SIGNED_ID}/audit`;
    const routes = {
      [key('GET', audit)]: (request: RecordedRequest) =>
        request.query['pageIndex'] === '1'
          ? { status: 200, body: { ...auditChain, itemsperpage: 1, totalpages: 2 } }
          : { status: 200, body: { ...auditChain, items: [], pageindex: 9, itemsperpage: 1, totalpages: 2 } },
    };
    const ctx = contextFor([AUDITOR], { id: SIGNED_ID, pageIndex: '9' }, routes);
    const markup = await bodyOf('audit', ctx);
    const $ = cheerio.load(markup, null, false);
    expect(eSignatureCalls(ctx.gateway).map(({ query }) => query)).toEqual([{ pageIndex: '9' }, { pageIndex: '1' }]);
    for (const entry of auditChain.items ?? []) expect(markup).toContain(entry.entry_hash);
    expect($('div.help-block-empty')).toHaveLength(0);
    expect($('ul.pagination li.active').text()).toBe('1');
  });

  it('verifies the stored chain and starts the copy form from the stored entries', async () => {
    const ctx = contextFor([AUDITOR], { id: SIGNED_ID });
    const markup = await bodyOf('verify', ctx);
    expect(eSignatureCalls(ctx.gateway)).toEqual([
      { service: 'e-signature', method: 'GET', path: `${REQUESTS_PATH}/${SIGNED_ID}/verify` },
      { service: 'e-signature', method: 'GET', path: `${REQUESTS_PATH}/${SIGNED_ID}/audit` },
    ]);
    expect(csrfContexts(ctx.gateway)).toEqual([SIGNED_ID]);
    const $ = cheerio.load(markup, null, false);
    expect(JSON.parse($('textarea[name="entries"]').text())).toEqual(auditChain.items);
    expect($('form').attr('action')).toBe(`/opt2/admin-actions/e-signature/verify?siteid=${SITE}&id=${SIGNED_ID}`);
  });

  it.each<[string, VerifyResult, string, string]>([
    ['an intact one-entry chain', { valid: true, entries: 1, brokenat: 0 }, 'The stored audit chain is intact (1 entry).', 'alert alert-info'],
    ['a broken chain', verifyTampered, 'The stored audit chain is broken at entry 2 (2 entries).', 'alert alert-error'],
  ])('shows the service verdict on %s as given', async (_case, verdict, text, className) => {
    const routes = { [key('GET', `${REQUESTS_PATH}/${SIGNED_ID}/verify`)]: { status: 200, body: verdict } };
    const model = fragmentModel(await bodyOf('verify', contextFor([AUDITOR], { id: SIGNED_ID }, routes)));
    expect(model.alerts).toEqual([{ text, className }]);
  });

  it('leads an auditor by request id to the request, audit and verify reads without listing requests', async () => {
    const ctx = contextFor([AUDITOR]);
    const form = cheerio.load(await bodyOf('requests', ctx), null, false)('form');
    expect(ctx.gateway.calls).toEqual([]);
    // A read: the lookup submits natively, without the write forms' legacy submitForm guard.
    expect([form.attr('method'), form.attr('action'), form.attr('onsubmit')]).toEqual([
      'get',
      '/opt2/admin/e-signature/request',
      undefined,
    ]);
    expect(form.find('input[type="hidden"]').toArray().map((el) => [el.attribs.name, el.attribs.value])).toEqual([
      ['siteid', SITE],
    ]);
    const buttons = form.find('button[type="submit"]').toArray();
    expect(buttons.map((el) => [cheerio.load(el).text(), el.attribs.formaction])).toEqual([
      ['Signature Request', '/opt2/admin/e-signature/request'],
      ['Audit Chain', '/opt2/admin/e-signature/audit'],
      ['Verify', '/opt2/admin/e-signature/verify'],
    ]);
  });

  it('lists requests for a holder of both roles', async () => {
    const ctx = contextFor([AUDITOR, SIGNER]);
    const $ = cheerio.load(await bodyOf('requests', ctx), null, false);
    expect(eSignatureCalls(ctx.gateway)).toEqual([
      { service: 'e-signature', method: 'GET', path: REQUESTS_PATH, query: { pageIndex: '1' } },
    ]);
    expect($('input[name="id"]')).toHaveLength(0);
    expect($('form').toArray().map((el) => el.attribs.action)).toEqual([CREATE_ACTION_URL]);
  });

  it('offers a signer the new-request form of the contract fields with the CSRF pair of the list', async () => {
    const ctx = contextFor([SIGNER]);
    const $ = cheerio.load(await bodyOf('requests', ctx), null, false);
    expect(csrfContexts(ctx.gateway)).toEqual(['']);
    const form = $('form');
    expect([form.attr('method'), form.attr('action')]).toEqual(['post', CREATE_ACTION_URL]);
    expect(`<form onsubmit="${form.attr('onsubmit')}">`).toBe(`<form${GUARDED_SUBMIT.value}>`);
    const inputs = form.find('input:not([type="hidden"])').toArray();
    // data-label holds markup, which legacy validateForm writes into its alert.
    const dataLabel = (el: (typeof inputs)[number]) => cheerio.load(el.attribs['data-label'] ?? '', null, false).text();
    expect(inputs.map((el) => [el.attribs.name, el.attribs.type, el.attribs.required, dataLabel(el)])).toEqual([
      ['documentName', 'text', 'true', 'Document Name'],
      ['documentBase64', 'text', 'true', 'Document (Base64)'],
      ['signerUserId', 'text', 'true', 'Signer User ID'],
    ]);
    expect(inputs.map((el) => el.attribs.name)).toEqual(CREATE_REQUEST_FIELDS);
    expect(form.find('input[type="hidden"]').toArray().map((el) => [el.attribs.name, el.attribs.value])).toEqual([
      ['csrf_token', FIXED_CSRF.token],
      ['csrf_token_expires', FIXED_CSRF.expires],
    ]);
    expect(form.find('button[type="submit"]').text()).toBe('Create');
    expect(form.find('[autofocus]')).toHaveLength(0);
  });

  it('re-renders the list with the create alert just before the new-request form holding the posted values', async () => {
    const ctx = contextFor([SIGNER]);
    const values = { documentName: 'tenant-a-nda.pdf', documentBase64: 'JVBERi0=', signerUserId: ESIGNATURE_IDS.signer };
    const view = await renderRequestsView(ctx, alertBox('Invalid parameters'), values);
    expect(view.opt2Module).toBe('e-signature');
    const markup = toString(view.body);
    const model = fragmentModel(markup);
    expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
    expect(model.tables).toHaveLength(1);
    const $ = cheerio.load(markup, null, false);
    expect($('form[name="form1"]').prev().is('div.alert.alert-error')).toBe(true);
    expect($('table.mura-table-grid').closest('.block-constrain').next().find('form[name="form1"]')).toHaveLength(1);
    for (const [name, value] of Object.entries(values)) expect($(`input[name="${name}"]`).attr('value')).toBe(value);
    expect(eSignatureCalls(ctx.gateway)).toHaveLength(1);
  });

  it('keeps the create alert under the header for a reader without the new-request form', async () => {
    const ctx = contextFor([AUDITOR]);
    const $ = cheerio.load(toString((await renderRequestsView(ctx, alertBox('Invalid parameters'))).body), null, false);
    expect($('div.mura-header').next().is('div.alert.alert-error')).toBe(true);
  });

  it('lists no requests with the empty-list message', async () => {
    const empty = { ...signatureRequestList, items: [], startindex: 1, endindex: 0, totalitems: 0, totalpages: 0 };
    const ctx = contextFor([SIGNER], {}, { [key('GET', REQUESTS_PATH)]: { status: 200, body: empty } });
    const $ = cheerio.load(await bodyOf('requests', ctx), null, false);
    expect($('table.mura-table-grid')).toHaveLength(0);
    expect($('div.help-block-empty').text()).toBe('There are no signature requests.');
    expect($('form').attr('action')).toBe(CREATE_ACTION_URL);
  });

  it.each(['request', 'audit', 'verify'])('%s without an id asks nothing of e-signature', async (slug) => {
    const ctx = contextFor([AUDITOR]);
    const model = fragmentModel(await bodyOf(slug, ctx));
    expect(eSignatureCalls(ctx.gateway)).toEqual([]);
    expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
    expect(model.links.map((link) => link.text)).toEqual(['Signature Requests']);
  });

  it.each(['request', 'audit', 'verify'].flatMap((slug) => ['..', '../x', '../../x', 'abc'].map((id) => [slug, id])))(
    '%s for the malformed id %j answers as e-signature does, asking it nothing',
    async (slug, id) => {
      const ctx = contextFor([AUDITOR], { id });
      const model = fragmentModel(await bodyOf(slug, ctx));
      expect(eSignatureCalls(ctx.gateway)).toEqual([]);
      expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
      expect(model.links.map((link) => link.text)).toEqual(['Signature Requests']);
    },
  );

  it('pages the request list with the numbered legacy pager', async () => {
    const ctx = contextFor([SIGNER], { pageIndex: '2' }, { [key('GET', REQUESTS_PATH)]: { status: 200, body: threePages(2) } });
    const $ = cheerio.load(await bodyOf('requests', ctx), null, false);
    const page = (index: number): string => `/opt2/admin/e-signature/requests?siteid=${SITE}&pageIndex=${index}`;
    expect($('ul.pagination.pull-right a').toArray().map((el) => [el.attribs.href, $(el).text()])).toEqual([
      [page(1), ''],
      [page(1), '1'],
      ['#', '2'],
      [page(3), '3'],
      [page(3), ''],
    ]);
    expect($('p.search-showing').text()).toBe('Showing 51-100 of 150 Results');
  });

  it('shows page 1 of the request list for a page past the last', async () => {
    const routes = {
      [key('GET', REQUESTS_PATH)]: (request: RecordedRequest) => ({
        status: 200,
        body: request.query['pageIndex'] === '1' ? threePages() : { ...threePages(9999), items: [] },
      }),
    };
    const ctx = contextFor([SIGNER], { pageIndex: '9999' }, routes);
    const $ = cheerio.load(await bodyOf('requests', ctx), null, false);
    expect(eSignatureCalls(ctx.gateway).map(({ query }) => query)).toEqual([{ pageIndex: '9999' }, { pageIndex: '1' }]);
    expect($('table.mura-table-grid tbody tr')).toHaveLength(signatureRequestList.items?.length ?? 0);
    expect($('ul.pagination li.active').text()).toBe('1');
  });
});

describe('e-signature roles', () => {
  const systemUser = (): AdminRequest => makeAdminRequest({}, SUBJECTS.systemUser);

  it.each<[string, string, 'allow' | 'noaccess' | 'login', () => AdminRequest]>([
    ['requests', 'a signer', 'allow', () => opt2RoleRequest(SIGNER)],
    ['requests', 'an auditor', 'allow', () => opt2RoleRequest(AUDITOR)],
    ['requests', 'a system user without an e-signature role', 'noaccess', systemUser],
    ['requests', 'the S2 admin without an e-signature role', 'noaccess', () => adminS2Request()],
    ['request', 'an auditor', 'allow', () => opt2RoleRequest(AUDITOR)],
    ['audit', 'a signer', 'allow', () => opt2RoleRequest(SIGNER)],
    ['verify', 'an auditor', 'allow', () => opt2RoleRequest(AUDITOR)],
    ['verify', 'a system user without an e-signature role', 'noaccess', systemUser],
    ['request', 'an anonymous user', 'login', () => anonymousRequest()],
  ])('%s gate answers %s with %s', async (slug, _who, expected, build) => {
    const req = build();
    const decision = await screenOf(slug).gate?.(req, { secure: () => secure(req) });
    if (expected === 'allow') expect(decision).toEqual({ kind: 'allow' });
    else if (expected === 'noaccess') expect(decision).toEqual({ kind: 'redirect', location: '/admin/?muraAction=cMessage.noaccess' });
    else expect(decision).toMatchObject({ kind: 'redirect', location: expect.stringContaining('muraAction=cLogin.main') });
  });

  it.each<[string, readonly Role[], string]>([
    ['its signer on a pending request', [SIGNER], ESIGNATURE_IDS.signer],
    ['its signer holding the auditor role too', [SIGNER, AUDITOR], ESIGNATURE_IDS.signer],
    ['its signer, whose token id differs only in case', [SIGNER], ESIGNATURE_IDS.signer.toLowerCase()],
  ])('offers the typed-name form to %s', async (_case, roles, sub) => {
    const ctx = contextFor(roles, { id: PENDING_ID }, {}, sub);
    const $ = cheerio.load(await bodyOf('request', ctx), null, false);
    expect($('input[name="typedName"]')).toHaveLength(1);
    expect($('button[type="submit"]').text()).toBe('Sign');
    expect(csrfContexts(ctx.gateway)).toEqual([PENDING_ID]);
  });

  it.each<[string, readonly Role[], string, string]>([
    ['an auditor on a pending request', [AUDITOR], PENDING_ID, ESIGNATURE_IDS.signer],
    ['a signer on a signed request', [SIGNER], SIGNED_ID, ESIGNATURE_IDS.signer],
    ['a signer and auditor reading a pending request of another signer', [SIGNER, AUDITOR], PENDING_ID, SUBJECTS[AUDITOR].sub],
  ])('offers no typed-name form to %s', async (_case, roles, id, sub) => {
    const ctx = contextFor(roles, { id }, {}, sub);
    const $ = cheerio.load(await bodyOf('request', ctx), null, false);
    expect($('form')).toHaveLength(0);
    expect(csrfContexts(ctx.gateway)).toEqual([]);
  });

  it('shows a signed request its typed name and signer', async () => {
    const tables = fragmentModel(await bodyOf('request', contextFor([AUDITOR], { id: SIGNED_ID }))).tables;
    const { signature } = signedRequestDetail;
    expect(tables).toEqual([
      {
        headers: ['Typed Name', 'Signed By', 'Signed At'],
        rows: [[signature?.typed_name, signature?.signer_user_id, signature?.signed_at]],
      },
    ]);
  });

  it('shows the request fields as read-only label and value rows', async () => {
    const $ = cheerio.load(await bodyOf('request', contextFor([AUDITOR], { id: SIGNED_ID })), null, false);
    const rows = $('dl')
      .toArray()
      .map((el) => [$(el).children('dt').text(), $(el).children('dd').text()]);
    expect(rows).toEqual([
      ['Document', signedRequestDetail.document_name],
      ['State', 'Signed'],
      ['Signer', signedRequestDetail.signer_user_id],
      ['Created', signedRequestDetail.created],
      ['Created By', signedRequestDetail.createdbyid],
      ['Document SHA-256', signedRequestDetail.document_sha256],
    ]);
    expect($('dd .label').attr('class')).toBe('label label-success');
    expect($('label')).toHaveLength(0);
  });

  it.each<[401 | 403, string]>([
    [401, '/admin/?muraAction=clogin.logout'],
    [403, '/admin/?muraAction=cMessage.noaccess'],
  ])('answers the service refusing a read with %i by the access gate redirect', async (status, location) => {
    const ctx = contextFor([SIGNER], { id: PENDING_ID }, { [key('GET', `${REQUESTS_PATH}/${PENDING_ID}`)]: refusal(status, 'x') });
    await expect(screenOf('request').load(ctx)).rejects.toMatchObject({ name: 'GatewayDenialError', status });
    expect(await renderScreenPage(screenOf('request'), ctx)).toEqual({ kind: 'redirect', location });
  });
});

describe('e-signature refusals', () => {
  it.each<[string, string, number, string, Rc]>([
    ['request', `${REQUESTS_PATH}/${SIGNED_ID}`, 404, 'Not Found', { id: SIGNED_ID }],
    ['request', `${REQUESTS_PATH}/${SIGNED_ID}`, 400, 'Invalid parameters', { id: SIGNED_ID }],
    ['audit', `${REQUESTS_PATH}/${SIGNED_ID}/audit`, 404, 'Not Found', { id: SIGNED_ID }],
    ['verify', `${REQUESTS_PATH}/${SIGNED_ID}/verify`, 404, 'Not Found', { id: SIGNED_ID }],
    ['verify', `${REQUESTS_PATH}/${SIGNED_ID}/audit`, 404, 'Not Found', { id: SIGNED_ID }],
    ['requests', REQUESTS_PATH, 400, 'Invalid parameters', {}],
  ])('%s renders the envelope message of GET %s answering %i (%s)', async (slug, path, status, message, rc) => {
    const ctx = contextFor([SIGNER, AUDITOR], rc, { [key('GET', path)]: refusal(status, message) });
    const model = fragmentModel(await bodyOf(slug, ctx));
    expect(model.alerts).toEqual([{ text: message, className: 'alert alert-error' }]);
    expect(model.tables).toEqual([]);
    expect(model.controls).toEqual([]);
  });

  it('answers an unavailable e-signature with the legacy 503 error', async () => {
    const ctx = contextFor([SIGNER], {}, { [key('GET', REQUESTS_PATH)]: { status: 503 } });
    await expect(screenOf('requests').load(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it('fails on any other refusal of a read', async () => {
    const ctx = contextFor([AUDITOR], { id: SIGNED_ID }, { [key('GET', `${REQUESTS_PATH}/${SIGNED_ID}/audit`)]: refusal(500, 'x') });
    const failure = screenOf('audit').load(ctx);
    await expect(failure).rejects.toThrow('getAuditChain answered HTTP 500');
    await expect(failure).rejects.not.toBeInstanceOf(GatewayDenialError);
  });
});
