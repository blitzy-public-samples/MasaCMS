// carch strategies-content calls over the tenant-a fixtures: write outcomes, relayed bytes, denials, session effects
// and trust.
import { readFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secure } from '@/lib/access-gate';
import { GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import {
  carchPageData,
  carchWrite,
  relayCarchRaw,
  toSubmitResult,
  type CarchCallContext,
  type CarchDenied,
  type CarchRawAction,
  type CarchWriteResult,
} from '@/screens/carch/service';
import type { RawBody, ScreenContext, SubmitResult } from '@/screens/registry';
import { CARCH_PATHS, CONTENT_IDS, FORM_RESPONSE_IDS, carchListData } from '../../fixtures/strategies-content/carch';
import { DOWNLOADDATA_FILENAME, downloaddataRelay, loaddiffRelay } from '../../fixtures/strategies-content/raw';
import {
  writeResultReRender,
  writeResultRedirectAppend,
  writeResultRedirectPreserve,
} from '../../fixtures/strategies-content/write-results';
import { editorRequest, siteAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRoute,
  type FakeRouteTable,
  type RecordedRequest,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

const SITE = 'tenant-a';
const ROOT_ID = '00000000000000000000000000000000001';
const SITE_MANAGER = '00000000000000000000000000000000000';
const FORMS_MODULE = '00000000000000000000000000000000004';
const HTML = 'text/html;charset=UTF-8';
const JSON_TYPE = 'application/json;charset=utf-8';
const EFFECTS_HEADER = 'x-opt2-session-effects';
const REFERER = `http://localhost/admin/?muraAction=cArch.list&siteid=${SITE}`;
// Legacy `cflocation` headers beneath a relayed `Location`.
const REDIRECT_HEADERS = { 'cache-control': 'no-cache', pragma: 'no-cache', 'content-type': HTML };
const WRITTEN: CarchWriteResult = { saved: true, errors: {}, redirect: null };
const DENIED = legacyError('Insufficient Account Permissions', 'invalid_request');
const UNAVAILABLE = legacyError('Service Unavailable', 'server_error');
const DIFF_BYTES = readFileSync(new URL('../../fixtures/strategies-content/loaddiff.html', import.meta.url));
const CSV_BYTES = readFileSync(new URL('../../fixtures/strategies-content/downloaddata.csv', import.meta.url));
const DELETE_RESPONSES: ServicePath = `/v1/sites/${SITE}/forms/${CONTENT_IDS.contactForm}/responses/delete`;

type AdminRequest = ScreenContext['req'];
type Ctx = ReturnType<typeof makeScreenContext>;

const svc = (method: 'GET' | 'POST', path: ServicePath): string => routeKey(method, 'strategies-content', path);
const rawPath = (action: CarchRawAction): ServicePath => `/v1/raw/carch/${action}`;

/** The tenant-a site admin on `cArch.<item>`. */
const tenantRequest = (item: string, partial: AdminRequestPartial = {}): AdminRequest =>
  siteAdminRequest(SITE, { circuit: 'cArch', item, ...partial });

/** A screen context for `req` over a gateway answering `routes` with `userToken`. */
function carchContext(routes: FakeRouteTable, req: AdminRequest = tenantRequest('list'), userToken?: string): Ctx {
  return makeScreenContext({ req, gateway: fakeGatewayClient(routes, { userToken }) });
}

/** A route answering `reply` that keeps every request it receives. */
function recording(reply: FakeReply): { route: FakeRoute; received: RecordedRequest[] } {
  const received: RecordedRequest[] = [];
  const route: FakeRoute = (request) => {
    received.push(request);
    return reply;
  };
  return { route, received };
}

/** A recorded gateway answer as the fake gateway sends it. */
function replyOf(relay: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly setCookies: readonly string[];
}): FakeReply {
  return { status: relay.status, headers: relay.headers, body: relay.body, setCookies: relay.setCookies };
}

/** A legacy JSON API error envelope. */
function legacyError(message: string, code: string) {
  return { apiversion: 'v1', method: 'invalid', error: { message, code } };
}

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe('write outcomes', () => {
  // The contract's redirect is `adminUrl` parts without a preserve key: no FW/1 `./` path and no `fw1pk`.
  it.each<[string, CarchWriteResult, string]>([
    [
      'append',
      writeResultRedirectAppend,
      `/admin/?muraAction=cArch.list&topid=${ROOT_ID}&siteid=${SITE}&startrow=1&moduleid=${SITE_MANAGER}`,
    ],
    ['preserve', writeResultRedirectPreserve, '/admin/?muraAction=cComments.default'],
  ])('emits the %s redirect as its legacy admin URL', async (_name, result, location) => {
    const render = vi.fn<(result: CarchWriteResult) => SubmitResult>();
    await expect(toSubmitResult({ kind: 'ok', data: result }, render)).resolves.toEqual({ kind: 'location', location });
    expect(render).not.toHaveBeenCalled();
  });

  it('re-renders a rejected save with its errors in fixture order', async () => {
    const rendered: SubmitResult = { kind: 'raw', response: { contentType: HTML, body: '' } };
    const seen: Array<[string, string]> = [];
    const render = vi.fn((result: CarchWriteResult): SubmitResult => {
      seen.push(...Object.entries(result.errors));
      return rendered;
    });
    await expect(toSubmitResult({ kind: 'ok', data: writeResultReRender }, render)).resolves.toBe(rendered);
    expect(render.mock.calls).toHaveLength(1);
    expect(render.mock.calls[0]?.[0]).toBe(writeResultReRender);
    expect(seen).toEqual([['title', "The 'Title' field is required"]]);
  });
});

describe('carchWrite', () => {
  const posted = {
    contentid: CONTENT_IDS.contactForm,
    responseid: FORM_RESPONSE_IDS.first,
    action: 'Delete',
    moduleid: FORMS_MODULE,
    keywords: 'Zoë & co+1 %',
    csrf_token: FIXED_CSRF.token,
    csrf_token_expires: FIXED_CSRF.expires,
  };

  it('posts every request field unchanged and in order, csrf fields included, without tokens of its own', async () => {
    const { route, received } = recording({ status: 200, body: WRITTEN });
    const ctx = carchContext({ [svc('POST', DELETE_RESPONSES)]: route }, tenantRequest('datamanager', { rc: posted }));
    const tokens = vi.spyOn(ctx.csrf, 'tokens');
    await expect(carchWrite(ctx, 'datamanager')).resolves.toEqual({ kind: 'ok', data: WRITTEN });
    expect(ctx.gateway.calls).toEqual([
      { service: 'strategies-content', method: 'POST', path: DELETE_RESPONSES, form: { ...ctx.req.rc } },
    ]);
    expect(ctx.gateway.calls[0]?.form).toEqual(expect.objectContaining({ ...posted, siteid: SITE }));
    const encoded = new URLSearchParams(Object.entries(ctx.req.rc)).toString();
    expect(received.map((request) => request.body)).toEqual([encoded]);
    expect(tokens).not.toHaveBeenCalled();
  });
});

describe('carchPageData', () => {
  it('reads the Site Manager tree for the given params', async () => {
    const rc = { siteid: SITE, topid: ROOT_ID, moduleid: SITE_MANAGER };
    const ctx = carchContext({ [svc('GET', CARCH_PATHS.list)]: { status: 200, body: carchListData } });
    await expect(carchPageData(ctx, 'list', rc)).resolves.toEqual({ kind: 'ok', data: carchListData });
    expect(ctx.gateway.calls).toEqual([
      { service: 'strategies-content', method: 'GET', path: CARCH_PATHS.list, query: { ...rc } },
    ]);
  });
});

describe('relayCarchRaw', () => {
  const notFound = JSON.stringify(legacyError('Not Found', 'invalid_request'));
  const badRequest = JSON.stringify(legacyError('Bad Request', 'invalid_request'));

  it.each<[string, CarchRawAction, FakeReply, RawBody]>([
    ['the loaddiff fragment', 'loaddiff', replyOf(loaddiffRelay), { status: 200, contentType: HTML, body: DIFF_BYTES }],
    [
      'the downloaddata file',
      'downloaddata',
      replyOf(downloaddataRelay),
      {
        status: 200,
        contentType: 'application/msexcel',
        body: CSV_BYTES,
        headers: { 'content-disposition': `attachment;filename=${DOWNLOADDATA_FILENAME}`, expires: '0' },
      },
    ],
    [
      'a 404',
      'loadsitesection',
      { status: 404, headers: { 'content-type': JSON_TYPE }, body: notFound },
      { status: 404, contentType: JSON_TYPE, body: Buffer.from(notFound) },
    ],
    [
      'a 400',
      'loadquickedit',
      { status: 400, headers: { 'content-type': JSON_TYPE }, body: badRequest },
      { status: 400, contentType: JSON_TYPE, body: Buffer.from(badRequest) },
    ],
  ])('relays %s byte for byte', async (_name, action, reply, expected) => {
    const ctx = carchContext({ [svc('GET', rawPath(action))]: reply });
    await expect(relayCarchRaw(ctx, action, 'GET')).resolves.toEqual(expected);
    expect(ctx.gateway.calls.map(({ method, path }) => [method, path])).toEqual([['GET', rawPath(action)]]);
    expect(ctx.req.sessionWrites).toEqual({});
  });

  it.each<[string, 'GET' | 'POST', FakeReply, RawBody, typeof Readable | typeof Buffer]>([
    ...(['GET', 'POST'] as const).map((method): [string, 'GET' | 'POST', FakeReply, RawBody, typeof Readable] => [
      `a ${method} 2xx download as a stream`,
      method,
      replyOf(downloaddataRelay),
      {
        status: 200,
        contentType: 'application/msexcel',
        body: CSV_BYTES,
        headers: { 'content-disposition': `attachment;filename=${DOWNLOADDATA_FILENAME}`, expires: '0' },
      },
      Readable,
    ]),
    [
      'a streamed 404 as its bytes',
      'GET',
      { status: 404, headers: { 'content-type': JSON_TYPE }, body: notFound },
      { status: 404, contentType: JSON_TYPE, body: Buffer.from(notFound) },
      Buffer,
    ],
  ])('relays %s when asked to stream', async (_name, method, reply, expected, bodyType) => {
    const ctx = carchContext({ [svc(method, rawPath('downloaddata'))]: reply });

    const raw = await relayCarchRaw(ctx, 'downloaddata', method, { stream: true });

    expect(raw).toEqual({ ...expected, body: expect.any(bodyType) });
    expect(raw.body instanceof Readable ? await buffer(raw.body) : raw.body).toEqual(expected.body);
  });
});

type Run = (ctx: CarchCallContext) => Promise<unknown>;

/** Each call, the operation it reaches, and how its answer carries the controller `secure()` redirect. */
const CALLS: Array<[string, 'GET' | 'POST', ServicePath, Run, (denied: CarchDenied) => unknown]> = [
  ['carchPageData', 'GET', CARCH_PATHS.draft, (ctx) => carchPageData(ctx, 'draft'), (denied) => denied],
  [
    'carchWrite',
    'POST',
    DELETE_RESPONSES,
    (ctx) => carchWrite(ctx, 'datamanager', { rc: { siteid: SITE, contentid: CONTENT_IDS.contactForm } }),
    (denied) => denied,
  ],
  [
    'relayCarchRaw',
    'GET',
    rawPath('loaddiff'),
    (ctx) => relayCarchRaw(ctx, 'loaddiff', 'GET'),
    ({ location }) => ({ status: 302, contentType: HTML, body: '', headers: { ...REDIRECT_HEADERS, location } }),
  ],
];

describe('denial and unavailability', () => {
  it.each(CALLS)('%s answers a 403 with the decision secure() returns', async (_name, method, path, run, carried) => {
    const req = tenantRequest('draft', { headers: new Headers({ referer: REFERER }) });
    const denial: FakeReply = { status: 403, headers: { 'content-type': JSON_TYPE }, body: DENIED };
    const ctx = carchContext({ [svc(method, path)]: denial }, req);
    const decision = secure(req);
    if (decision.kind !== 'redirect') throw new TypeError('secure() let a logged-in denial through');
    expect(decision.location).toBe(REFERER);
    await expect(run(ctx)).resolves.toEqual(carried(decision));
  });

  const outages: Array<[string, (gateway: FakeGatewayClient, key: string) => void]> = [
    ['the gateway refuses', (gateway) => gateway.failWith()],
    ['strategies-content answers 503', (gateway, key) => gateway.setRoute(key, { status: 503, body: UNAVAILABLE })],
  ];
  const outageCases = CALLS.flatMap(([name, method, path, run]) =>
    outages.map(([outage, apply]) => [name, outage, method, path, run, apply] as const),
  );

  it.each(outageCases)(
    '%s fails closed without a retry when %s',
    async (_name, _outage, method, path, run, apply) => {
      const ctx = carchContext({});
      apply(ctx.gateway, svc(method, path));
      await expect(run(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
      expect(ctx.gateway.calls.map((call) => [call.method, call.path])).toEqual([[method, path]]);
    },
  );
});

describe('relayed session effects', () => {
  it('opens the section the service reports', async () => {
    const effects = JSON.stringify({ openSectionList: CONTENT_IDS.news });
    const reply = {
      status: 200,
      headers: { 'content-type': HTML, [EFFECTS_HEADER]: effects },
      body: '<ul class="section"></ul>',
    };
    const ctx = carchContext({ [svc('GET', rawPath('loadsitesection'))]: reply }, tenantRequest('loadsitesection'));
    await expect(relayCarchRaw(ctx, 'loadsitesection', 'GET')).resolves.toEqual({
      status: 200,
      contentType: HTML,
      body: Buffer.from(reply.body),
    });
    expect(ctx.req.session.openSectionList).toBe(CONTENT_IDS.news);
    expect(ctx.req.sessionWrites).toEqual({ openSectionList: CONTENT_IDS.news });
  });

  it('drops the edit bean the service reports deleted, keeping the other session values', async () => {
    const editBean = { contentid: CONTENT_IDS.aboutUs, title: 'About Us' };
    const req = tenantRequest('loadextendedattributes', { session: { muraValues: { editBean } } });
    const reply = {
      status: 200,
      headers: { 'content-type': JSON_TYPE, [EFFECTS_HEADER]: JSON.stringify({ mura: { editBean: null } }) },
      body: '{}',
    };
    const ctx = carchContext({ [svc('GET', rawPath('loadextendedattributes'))]: reply }, req);

    await expect(relayCarchRaw(ctx, 'loadextendedattributes', 'GET')).resolves.toEqual({
      status: 200,
      contentType: JSON_TYPE,
      body: Buffer.from('{}'),
    });
    expect(req.sessionWrites).toStrictEqual({ muraValues: { editBean: undefined } });
    expect(req.session.muraValues).toStrictEqual({ editBean: undefined });
    expect(req.session.mura).toMatchObject({ editBean: undefined });
    expect(req.session.openSectionList).toBe('');
  });

  it.each<[string, string, new (message?: string) => Error]>([
    [
      'a value the contract does not name',
      JSON.stringify({ openSectionList: CONTENT_IDS.news, topid: ROOT_ID }),
      TypeError,
    ],
    ['an openSectionList that is not a string', JSON.stringify({ openSectionList: 1 }), TypeError],
    ['mura values that are not a struct', JSON.stringify({ mura: 'editBean' }), TypeError],
    ['a list', '[]', TypeError],
    ['text that is not JSON', `openSectionList=${CONTENT_IDS.news}`, SyntaxError],
  ])('refuses %s and applies nothing', async (_name, header, error) => {
    const reply = { status: 200, headers: { 'content-type': HTML, [EFFECTS_HEADER]: header }, body: '' };
    const ctx = carchContext({ [svc('GET', rawPath('loadsitesection'))]: reply }, tenantRequest('loadsitesection'));
    await expect(relayCarchRaw(ctx, 'loadsitesection', 'GET')).rejects.toBeInstanceOf(error);
    expect(ctx.req.session.openSectionList).toBe('');
    expect(ctx.req.sessionWrites).toEqual({});
  });

  it('destroys a streamed answer whose session values it refuses', async () => {
    const producer = new PassThrough();
    producer.write('"a"\r\n');
    const reply = { status: 200, headers: { 'content-type': 'application/msexcel', [EFFECTS_HEADER]: '[]' }, body: producer };
    const ctx = carchContext({ [svc('GET', rawPath('downloaddata'))]: reply });

    await expect(relayCarchRaw(ctx, 'downloaddata', 'GET', { stream: true })).rejects.toBeInstanceOf(TypeError);
    expect(producer.destroyed).toBe(true);
  });
});

describe('trust', () => {
  it('takes roles from the verified claims and sends the request token, never rc roles', async () => {
    const userToken = 'qa-editor.user-token';
    const path: ServicePath = `/v1/sites/default/forms/${CONTENT_IDS.contactForm}/responses/delete`;
    const fields = { contentid: CONTENT_IDS.contactForm, responseid: FORM_RESPONSE_IDS.first, action: 'Delete' };

    const send = async (rc: Readonly<Record<string, string>>) => {
      const { route, received } = recording({ status: 200, body: WRITTEN });
      const req = editorRequest({ circuit: 'cArch', item: 'datamanager', rc });
      const ctx = carchContext({ [svc('POST', path)]: route }, req, userToken);
      await carchWrite(ctx, 'datamanager');
      return { req, sent: received[0] };
    };
    const plain = await send(fields);
    const claimed = await send({ ...fields, roles: 's2' });

    expect([claimed.req.roles, claimed.req.isS2]).toEqual([plain.req.roles, false]);
    expect(claimed.sent?.headers).toEqual(plain.sent?.headers);
    expect(claimed.sent?.headers.authorization).toBe(`Bearer ${userToken}`);
    const { roles, ...rest } = claimed.sent?.form ?? {};
    expect(roles).toBe('s2');
    expect(rest).toEqual(plain.sent?.form);
  });
});
