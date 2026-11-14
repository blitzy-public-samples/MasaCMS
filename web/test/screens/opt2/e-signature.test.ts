// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
// Only what e-signature/*.test.ts and umbrella.test.ts leave open: nav per screen, trust, unposted CSRF, chain order.
import { load } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, type Role } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { secure, type ScreenGate } from '@/lib/access-gate';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { esignatureActions, esignatureScreens } from '@/screens/opt2/e-signature';
import { noAccessUrl } from '@/screens/opt2/shared';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext } from '@/screens/registry';
import { anonymousRequest, opt2RoleRequest } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';
import { SUBJECTS } from '../../helpers/tokens';
import { ESIGNATURE_IDS, auditChain, eSignatureAnswers } from '../../fixtures/opt2/e-signature';

// The registry module loads every circuit; these pages need only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const SIGNER = Roles.esignatureSigner;
const AUDITOR = Roles.esignatureAuditor;
const SIGNED_ID = ESIGNATURE_IDS.signedRequest;
const PENDING_ID = ESIGNATURE_IDS.pendingRequest;
const SITE = SUBJECTS[SIGNER].site;
const REQUESTS = '/v1/esignature/requests';

/** Request parameters naming roles and an identity the token does not hold. */
const CLAIMED_IN_RC = Object.freeze({
  roles: `${SIGNER},${AUDITOR}`,
  role: SIGNER,
  s2: '1',
  isS2: 'true',
  memberships: `S2,${SIGNER},${AUDITOR}`,
  userid: SUBJECTS.admin.sub,
});

type Rc = Readonly<Record<string, string>>;
type Routes = Readonly<Record<string, FakeReply>>;

/** A screen context for `req` over the fixture answers, `routes` laid over them. */
function ctxFor(req: AdminRequest, routes: Routes = {}): ScreenContext & { gateway: FakeGatewayClient } {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ ...eSignatureAnswers, ...routes }) });
}

const key = (method: 'GET' | 'POST', path: string): string => routeKey(method, 'e-signature', path as `/${string}`);

function screenOf(slug: string): Opt2ScreenDefinition {
  const def = esignatureScreens.find((candidate) => candidate.screen === slug);
  if (def === undefined) throw new TypeError(`e-signature screen ${slug} is not registered`);
  return def;
}

function actionOf(slug: string): Opt2ActionDefinition {
  const def = esignatureActions.find((candidate) => candidate.action === slug);
  if (def === undefined) throw new TypeError(`e-signature action ${slug} is not registered`);
  return def;
}

/** The screen body `slug` renders for `ctx`. */
async function bodyOf(slug: string, ctx: ScreenContext): Promise<string> {
  const def = screenOf(slug);
  return toString((await def.render(ctx, await def.load(ctx))).body);
}

function eSignatureCalls(gateway: FakeGatewayClient) {
  return gateway.calls.filter((call) => call.service === 'e-signature');
}

/** `gate`'s decision for `req`, with the `secure()` of that request. */
async function decide(gate: ScreenGate | undefined, req: AdminRequest) {
  if (gate === undefined) throw new TypeError('Every e-signature definition declares a gate');
  return gate(req, { secure: () => secure(req) });
}

const GATED = [
  ...esignatureScreens.map((def) => ({ key: `screen ${def.screen}`, gate: def.gate })),
  ...esignatureActions.map((def) => ({ key: `action ${def.action}`, gate: def.gate })),
];

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('e-signature shell', () => {
  it.each<[string, string, Role, Rc]>([
    ['requests', 'Signature Requests', SIGNER, {}],
    ['request', 'Signature Request', SIGNER, { id: PENDING_ID }],
    ['audit', 'Audit Chain', AUDITOR, { id: SIGNED_ID }],
    ['verify', 'Verify Audit Chain', AUDITOR, { id: SIGNED_ID }],
  ])('%s renders %j with the OPT-2 group open on e-signature', async (slug, title, role, rc) => {
    const page = await renderScreenPage(screenOf(slug), ctxFor(opt2RoleRequest(role, { rc })));
    if (page.kind !== 'document') throw new TypeError(`Redirected to ${page.location}`);
    const $ = load(page.html);
    const group = $('li#admin-nav-opt2');
    expect(group.hasClass('open')).toBe(true);
    expect(group.children('a.nav-submenu').hasClass('active')).toBe(true);
    expect(group.find('ul a.active').toArray().map((el) => el.attribs.href)).toEqual([
      `/opt2/admin/e-signature/requests?siteid=${SITE}`,
    ]);
    expect($('div.mura-header h1').toArray().map((el) => $(el).text())).toContain(title);
  });
});

describe('e-signature trust', () => {
  it.each(GATED)('$key sends an anonymous user to the login secure() builds', async ({ gate }) => {
    const req = anonymousRequest();
    expect(await decide(gate, req)).toEqual(secure(req));
  });

  it.each(GATED)('$key grants nothing to roles claimed in request parameters', async ({ gate }) => {
    const req = opt2RoleRequest(Roles.financePreparer, { rc: CLAIMED_IN_RC });
    expect(await decide(gate, req)).toEqual({ kind: 'redirect', location: noAccessUrl() });
  });

  it('offers an auditor claiming the signer role in rc no typed-name form', async () => {
    const ctx = ctxFor(opt2RoleRequest(AUDITOR, { rc: { ...CLAIMED_IN_RC, id: PENDING_ID } }));
    const $ = load(await bodyOf('request', ctx), null, false);
    expect($('form')).toHaveLength(0);
    expect(ctx.gateway.calls.map((call) => `${call.service} ${call.method} ${call.path}`)).toEqual([
      `e-signature GET ${REQUESTS}/${PENDING_ID}`,
    ]);
  });

  it('gives an auditor claiming the signer role in rc the lookup, not the list', async () => {
    const ctx = ctxFor(opt2RoleRequest(AUDITOR, { rc: CLAIMED_IN_RC }));
    const $ = load(await bodyOf('requests', ctx), null, false);
    expect(ctx.gateway.calls).toEqual([]);
    expect($('form').toArray().map((el) => [el.attribs.method, el.attribs.action])).toEqual([
      ['get', '/opt2/admin/e-signature/request'],
    ]);
  });

  it('signs with the typed name alone whatever signer or user id is posted', async () => {
    const typedName = 'Jordan Ellis';
    const rc = {
      ...CLAIMED_IN_RC,
      id: PENDING_ID,
      typedName,
      signerUserId: SUBJECTS.admin.sub,
      signer_user_id: SUBJECTS.admin.sub,
      actor_user_id: SUBJECTS.admin.sub,
    };
    const ctx = ctxFor(opt2RoleRequest(SIGNER, { mode: 'opt2', rc }));
    await actionOf('sign').submit(ctx);
    expect(eSignatureCalls(ctx.gateway).map((call) => call.json)).toEqual([{ typedName }]);
  });
});

describe('e-signature posts without a CSRF pair', () => {
  const posts = [
    { action: 'create-request', rc: {}, path: REQUESTS, json: {} },
    { action: 'sign', rc: { id: PENDING_ID }, path: `${REQUESTS}/${PENDING_ID}/sign`, json: { typedName: '' } },
    { action: 'verify', rc: { id: SIGNED_ID }, path: `${REQUESTS}/${SIGNED_ID}/verify`, json: { entries: '' } },
  ];
  const unposted = [
    { csrf: 'no pair', fields: {} },
    { csrf: 'an empty token', fields: { [CSRF_FIELD_TOKEN]: '', [CSRF_FIELD_EXPIRES]: '260630160000000' } },
  ];

  it.each(posts.flatMap((post) => unposted.map((csrf) => ({ ...post, ...csrf }))))(
    '$action with $csrf sends no CSRF headers and its unposted fields empty',
    async ({ action, rc, path, json, fields }) => {
      const ctx = ctxFor(opt2RoleRequest(SIGNER, { mode: 'opt2', rc: { ...rc, ...fields } }));
      await actionOf(action).submit(ctx);
      expect(eSignatureCalls(ctx.gateway)[0]).toStrictEqual({ service: 'e-signature', method: 'POST', path, json });
    },
  );
});

describe('e-signature chain order', () => {
  const answered = [...(auditChain.items ?? [])].reverse();
  const routes = { [key('GET', `${REQUESTS}/${SIGNED_ID}/audit`)]: { status: 200, body: { ...auditChain, items: answered } } };
  const auditorOn = (id: string) => ctxFor(opt2RoleRequest(AUDITOR, { rc: { id } }), routes);

  it('lists audit entries in the order e-signature answers, hashes verbatim', async () => {
    const [table] = fragmentModel(await bodyOf('audit', auditorOn(SIGNED_ID))).tables;
    expect(table?.rows).toEqual(
      answered.map((entry) => [
        String(entry.seq),
        entry.action,
        entry.actor_user_id,
        entry.detail,
        entry.at,
        entry.prev_hash,
        entry.entry_hash,
      ]),
    );
    expect(table?.rows.flatMap((row) => row.slice(5)).every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });

  it('starts the copy form from the chain in the order e-signature answers', async () => {
    const copy = fragmentModel(await bodyOf('verify', auditorOn(SIGNED_ID))).controls.find(
      (control) => control.name === 'entries',
    );
    expect(copy?.value).toBe(JSON.stringify(answered, null, 2));
  });
});
