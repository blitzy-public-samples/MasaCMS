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
import { esignatureScreens } from '@/screens/opt2/e-signature';
import type { Opt2ScreenDefinition, ScreenContext } from '@/screens/registry';
import { adminS2Request, anonymousRequest, makeAdminRequest, opt2RoleRequest } from '../../../helpers/admin-request';
import { fragmentModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../../helpers/fake-gateway';
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
const ADMIN_CSS = readFileSync(new URL('../../../../../admin/assets/css/admin.css', import.meta.url), 'utf8');

type Rc = Readonly<Record<string, string>>;
type VerifyResult = components['schemas']['VerifyResult'];

/** The registered e-signature screen `slug`. */
function screenOf(slug: string): Opt2ScreenDefinition {
  const def = esignatureScreens.find((candidate) => candidate.screen === slug);
  if (def === undefined) throw new TypeError(`e-signature/${slug} is not registered`);
  return def;
}

/** A screen context for `req` over the fixture answers, with `routes` laid over them. */
function contextOf(req: AdminRequest, routes: Readonly<Record<string, FakeReply>> = {}): ScreenContext & {
  gateway: FakeGatewayClient;
} {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ ...eSignatureAnswers, ...routes }) });
}

/** A screen context for the tenant-a holder of `roles` with `rc`. */
function contextFor(roles: readonly Role[], rc: Rc = {}, routes: Readonly<Record<string, FakeReply>> = {}) {
  const [first = SIGNER] = roles;
  return contextOf(opt2RoleRequest(first, { rc, user: { roles: [Roles.systemUser, ...roles] } }), routes);
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
    const markup = await bodyOf('audit', contextFor([AUDITOR], { id: SIGNED_ID }));
    const cells = fragmentModel(markup).tables[0]?.rows.flat() ?? [];
    for (const entry of auditChain.items ?? []) {
      expect(cells).toEqual(expect.arrayContaining([entry.prev_hash, entry.entry_hash, entry.detail, entry.at]));
    }
  });
});

describe('e-signature service calls', () => {
  it.each<[string, Rc, string]>([
    ['no page', {}, '1'],
    ['page 2', { pageIndex: '2' }, '2'],
    ['a page that is not a whole number from 1', { pageIndex: 'x' }, '1'],
  ])('lists requests for %s', async (_case, rc, pageIndex) => {
    const ctx = contextFor([SIGNER], rc);
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
    const ctx = contextFor([AUDITOR], { id: SIGNED_ID, pageIndex: '3' });
    await bodyOf('audit', ctx);
    expect(eSignatureCalls(ctx.gateway)).toEqual([
      { service: 'e-signature', method: 'GET', path: `${REQUESTS_PATH}/${SIGNED_ID}/audit`, query: { pageIndex: '3' } },
    ]);
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
    expect([form.attr('method'), form.attr('action')]).toEqual(['get', '/opt2/admin/e-signature/request']);
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
    expect($('form')).toHaveLength(0);
  });

  it.each(['request', 'audit', 'verify'])('%s without an id asks nothing of e-signature', async (slug) => {
    const ctx = contextFor([AUDITOR]);
    const model = fragmentModel(await bodyOf(slug, ctx));
    expect(eSignatureCalls(ctx.gateway)).toEqual([]);
    expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
    expect(model.links.map((link) => link.text)).toEqual(['Signature Requests']);
  });

  it('pages the request list with Previous and Next', async () => {
    const list = { ...signatureRequestList, pageindex: 2, totalpages: 3 };
    const ctx = contextFor([SIGNER], { pageIndex: '2' }, { [key('GET', REQUESTS_PATH)]: { status: 200, body: list } });
    const links = cheerio.load(await bodyOf('requests', ctx), null, false)('ul.pagination a');
    expect(links.toArray().map((el) => [el.attribs.href, cheerio.load(el).text()])).toEqual([
      [`/opt2/admin/e-signature/requests?siteid=${SITE}&pageIndex=1`, 'Previous'],
      [`/opt2/admin/e-signature/requests?siteid=${SITE}&pageIndex=3`, 'Next'],
    ]);
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
    ['a signer on a pending request', [SIGNER], PENDING_ID],
    ['a signer and auditor on a pending request', [SIGNER, AUDITOR], PENDING_ID],
  ])('offers the typed-name form to %s', async (_case, roles, id) => {
    const $ = cheerio.load(await bodyOf('request', contextFor(roles, { id })), null, false);
    expect($('input[name="typedName"]')).toHaveLength(1);
    expect($('button[type="submit"]').text()).toBe('Sign');
  });

  it.each<[string, readonly Role[], string]>([
    ['an auditor on a pending request', [AUDITOR], PENDING_ID],
    ['a signer on a signed request', [SIGNER], SIGNED_ID],
  ])('offers no typed-name form to %s', async (_case, roles, id) => {
    const ctx = contextFor(roles, { id });
    const $ = cheerio.load(await bodyOf('request', ctx), null, false);
    expect($('form')).toHaveLength(0);
    expect(csrfContexts(ctx.gateway)).toEqual([]);
  });

  it('shows a signed request its typed name and signer', async () => {
    const tables = fragmentModel(await bodyOf('request', contextFor([AUDITOR], { id: SIGNED_ID }))).tables;
    const { signature } = signedRequestDetail;
    expect(tables[1]).toEqual({
      headers: ['Typed Name', 'Signed By', 'Signed At'],
      rows: [[signature?.typed_name, signature?.signer_user_id, signature?.signed_at]],
    });
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
