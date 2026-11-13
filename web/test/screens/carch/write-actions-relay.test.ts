// carch inline writes, raw relays, editLive and lockFile against admin/core/controllers/carch.cfc and the contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { runGate, secure } from '@/lib/access-gate';
import { GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import { REDIRECT_HEADERS } from '@/lib/responses';
import { carchGate } from '@/screens/carch/controller';
import { editliveScreen } from '@/screens/carch/editlive';
import { inlineWriteScreens } from '@/screens/carch/inline-writes';
import { lockfileScreen } from '@/screens/carch/lockfile';
import { CONTENT_MODULE_ID, FORM_MODULE_ID } from '@/screens/carch/model';
import { rawActionScreens } from '@/screens/carch/raw-actions';
import type {
  RawBody,
  Rc,
  ScreenContext,
  ScreenDefinition,
  ScreenMode,
  ScreenRequestBody,
  SubmitResult,
} from '@/screens/registry';
import { anonymousRequest, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

// registry.ts imports circuit barrels this suite does not load; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

vi.mock('@opt2/platform/legacy-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/legacy-compat')>();
  return { ...actual, cfUuid: vi.fn(actual.cfUuid) };
});

const SITE = 'tenant-a';
const SERVICE = 'strategies-content';
const CONTENT_ID = 'C0000000-0000-0000-0000000000000001';
const HIST_ID = 'D0000000-0000-0000-0000000000000002';
const FILE_ID = 'F0000000-0000-0000-0000000000000003';
const NEW_ID = 'E0000000-0000-0000-0000000000000004';
const HTML_TYPE = 'text/html;charset=UTF-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const CSV_TYPE = 'application/msexcel';
const DISPOSITION = 'attachment;filename=Contact-Us_011526.csv';
const REFERER = `http://localhost/admin/?muraAction=cArch.list&siteid=${SITE}`;
const CSRF_HEADERS = { 'X-csrf_token': FIXED_CSRF.token, 'X-csrf_token_expires': FIXED_CSRF.expires };
const SENT_CSRF = { 'x-csrf_token': FIXED_CSRF.token, 'x-csrf_token_expires': FIXED_CSRF.expires };
const CSRF_FIELDS = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };
const FIELDS = { contentid: CONTENT_ID, contenthistid: HIST_ID, ...CSRF_FIELDS };
const ABORTED: RawBody = { status: 200, contentType: HTML_TYPE, body: '' };
const SERVICE_ERROR = { apiversion: 'v1', method: 'carch', error: { message: 'Denied', code: 'denied' } };

// Inventoried response mode of each carried action (opt2/inventory/legacy-inventory.json).
const MODES: Readonly<Record<string, ScreenMode>> = {
  approvalaction: 'json',
  assocfiles: 'fragment',
  availablechangesets: 'fragment',
  downloaddata: 'download',
  draftpromptdata: 'json',
  getaudittrail: 'json',
  getimagesizeurl: 'json',
  loadcategoryassignment: 'fragment',
  loadcategoryfeaturestartstop: 'fragment',
  loadclass: 'fragment',
  loadclassconfigurator: 'fragment',
  loaddiff: 'fragment',
  loadexpirenotify: 'fragment',
  loadextendedattributes: 'json',
  loadfilemetadata: 'fragment',
  loadnewcontentmenu: 'fragment',
  loadnotify: 'fragment',
  loadquickedit: 'fragment',
  loadrelatedcontent: 'fragment',
  loadselectedrelatedcontent: 'fragment',
  loadsiteflat: 'fragment',
  loadsitemanager: 'json',
  loadsitesection: 'json',
  loadtagarray: 'json',
  refreshsitesection: 'fragment',
  sitemanagertab: 'json',
  siteparents: 'fragment',
  statusmodal: 'fragment',
  savequickedit: 'json',
  savecopyinfo: 'json',
  unlockfile: 'json',
  unlocknode: 'json',
  updateobjectparams: 'json',
  lockfile: 'json',
  editlive: 'redirect',
};
const ACTIONS = Object.keys(MODES);

/** Actions whose legacy controller writes, then aborts with an empty body. */
const ABORTING = new Set(['savequickedit', 'savecopyinfo', 'unlockfile', 'unlocknode', 'lockfile']);

/** Actions relayed through `/v1/raw/carch/<action>`. */
const RELAYED = ACTIONS.filter((action) => action !== 'editlive' && action !== 'updateobjectparams');

type RelayKind = 'fragment' | 'json' | 'download' | 'aborted';

/** The service's answer of each kind, and the bare body web emits for it. */
const RELAYS: Readonly<Record<RelayKind, { readonly reply: FakeReply; readonly answer: RawBody }>> = {
  fragment: {
    reply: { status: 200, headers: { 'Content-Type': HTML_TYPE }, body: '<div class="mura-grid"></div>' },
    answer: { status: 200, contentType: HTML_TYPE, body: Buffer.from('<div class="mura-grid"></div>') },
  },
  json: {
    reply: { status: 200, headers: { 'Content-Type': JSON_TYPE }, body: '{"html":"<ul></ul>","perm":"editor"}' },
    answer: { status: 200, contentType: JSON_TYPE, body: Buffer.from('{"html":"<ul></ul>","perm":"editor"}') },
  },
  download: {
    reply: {
      status: 200,
      headers: { 'Content-Type': CSV_TYPE, 'Content-Disposition': DISPOSITION },
      body: 'Date,Name\r\n',
    },
    answer: {
      status: 200,
      contentType: CSV_TYPE,
      body: Buffer.from('Date,Name\r\n'),
      headers: { 'content-disposition': DISPOSITION },
    },
  },
  aborted: {
    reply: { status: 200, headers: { 'Content-Type': HTML_TYPE } },
    answer: { status: 200, contentType: HTML_TYPE, body: Buffer.alloc(0) },
  },
};

const DEFINITIONS: readonly ScreenDefinition[] = [
  ...inlineWriteScreens,
  ...rawActionScreens,
  editliveScreen,
  lockfileScreen,
];

const rawPath = (action: string): ServicePath => `/v1/raw/carch/${action}`;
const contentPath = (contentId: string): ServicePath => `/v1/sites/${SITE}/content/${contentId}`;
const OBJECT_PARAMS_PATH: ServicePath = `/v1/sites/${SITE}/content/versions/${HIST_ID}/object-params`;
const svc = (method: 'GET' | 'POST', path: ServicePath): string => routeKey(method, SERVICE, path);

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  vi.mocked(cfUuid).mockReset();
  restore();
});

function definition(action: string): ScreenDefinition {
  const def = DEFINITIONS.find((candidate) => candidate.action === action);
  if (def === undefined) throw new Error(`No carch.${action} definition`);
  return def;
}

const relayKind = (action: string): RelayKind => (ABORTING.has(action) ? 'aborted' : (MODES[action] as RelayKind));

/** The strategies-content route `action` calls for a GET carrying {@link FIELDS}. */
function routeOf(action: string): string {
  if (action === 'editlive') return svc('GET', contentPath(CONTENT_ID));
  if (action === 'updateobjectparams') return svc('POST', OBJECT_PARAMS_PATH);
  return svc('GET', rawPath(action));
}

/** `fields` as the URL-encoded body web received. */
function formBody(fields: Readonly<Record<string, string>>): ScreenRequestBody {
  const form = new URLSearchParams(fields);
  return { contentType: 'application/x-www-form-urlencoded', body: new Blob([form.toString()]), form };
}

interface CallInput {
  readonly rc?: Readonly<Record<string, string>>;
  readonly routes?: FakeRouteTable;
  /** Carries `rc` as a posted body; otherwise the request has none. */
  readonly post?: boolean;
}

/** The tenant-a site admin on `carch.<action>` with the csrf headers and a referrer, over a fake gateway. */
function screenContext(
  action: string,
  { rc = {}, routes = {}, post = false }: CallInput = {},
): ScreenContext & { gateway: FakeGatewayClient } {
  const headers = new Headers({ ...CSRF_HEADERS, referer: REFERER });
  const req = siteAdminRequest(SITE, { circuit: 'carch', item: action, rc, headers });
  return makeScreenContext({ req, gateway: fakeGatewayClient(routes), body: post ? formBody(rc) : undefined });
}

/** The definition's answer, called as its mode's handler calls it. */
async function invoke(def: ScreenDefinition, ctx: ScreenContext): Promise<RawBody | SubmitResult> {
  switch (def.mode) {
    case 'fragment':
      return def.render(ctx, undefined);
    case 'json':
      return def.json(ctx, undefined);
    case 'download':
      return def.download(ctx, undefined);
    case 'redirect':
      return def.submit(ctx);
    case 'page':
      throw new Error(`carch.${def.action} renders in the shell`);
  }
}

describe('carch write and relay definitions', () => {
  it('registers each carried action once', () => {
    expect(DEFINITIONS.map((def) => def.action).sort()).toEqual([...ACTIONS].sort());
  });

  it.each(Object.entries(MODES))('declares carch.%s in %s mode under strategies-content', (action, mode) => {
    expect(definition(action)).toEqual(
      expect.objectContaining({ circuit: 'carch', action, mode, owner: SERVICE, gate: carchGate }),
    );
  });

  it.each(ACTIONS)('gates carch.%s on the Site Manager module', async (action) => {
    const { gate } = definition(action);
    const anonymous = anonymousRequest({ circuit: 'carch', item: action });
    const refused = await runGate(anonymous, gate);
    expect(refused).toEqual(secure(anonymous));
    expect(refused).toEqual({
      kind: 'redirect',
      location: expect.stringMatching(/^\.\/\?muraAction=cLogin\.main&returnURL=/),
    });
    await expect(runGate(siteAdminRequest(SITE, { circuit: 'carch', item: action }), gate)).resolves.toEqual({
      kind: 'allow',
    });
  });

  it.each(ACTIONS)('fails closed on carch.%s when strategies-content is unavailable', async (action) => {
    const routes = { [routeOf(action)]: { status: 503, body: SERVICE_ERROR } };
    const down = screenContext(action, { rc: FIELDS, routes });
    await expect(invoke(definition(action), down)).rejects.toBeInstanceOf(GatewayUnavailableError);
    const refused = screenContext(action, { rc: FIELDS });
    refused.gateway.failWith();
    await expect(invoke(definition(action), refused)).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(refused.gateway.calls).toHaveLength(1);
  });
});

describe('relayed carch actions', () => {
  it.each(RELAYED)('relays carch.%s over GET with every rc field and the csrf headers', async (action) => {
    const { reply, answer } = RELAYS[relayKind(action)];
    const ctx = screenContext(action, { rc: FIELDS, routes: { [svc('GET', rawPath(action))]: reply } });
    await expect(invoke(definition(action), ctx)).resolves.toEqual(answer);
    expect(ctx.gateway.calls).toEqual([
      { service: SERVICE, method: 'GET', path: rawPath(action), query: { ...ctx.req.rc }, headers: SENT_CSRF },
    ]);
    expect(ctx.gateway.calls[0]?.query).toEqual(expect.objectContaining({ ...FIELDS, siteid: SITE }));
  });

  it.each(RELAYED)('relays a posted carch.%s with siteid in the query and the rc as the form', async (action) => {
    const { reply, answer } = RELAYS[relayKind(action)];
    const ctx = screenContext(action, { rc: FIELDS, post: true, routes: { [svc('POST', rawPath(action))]: reply } });
    await expect(invoke(definition(action), ctx)).resolves.toEqual(answer);
    expect(ctx.gateway.calls).toEqual([
      {
        service: SERVICE,
        method: 'POST',
        path: rawPath(action),
        query: { siteid: SITE },
        form: { ...ctx.req.rc },
        headers: SENT_CSRF,
      },
    ]);
    expect(ctx.gateway.calls[0]?.form).toEqual(expect.objectContaining(FIELDS));
  });

  it.each(RELAYED)('relays carch.%s with the carch before() defaults and session writes', async (action) => {
    const routes = { [svc('GET', rawPath(action))]: RELAYS[relayKind(action)].reply };
    const ctx = screenContext(action, { rc: { moduleid: FORM_MODULE_ID }, routes });
    await invoke(definition(action), ctx);
    expect(ctx.gateway.calls[0]?.query).toEqual(
      expect.objectContaining({ moduleid: FORM_MODULE_ID, topid: FORM_MODULE_ID, type: 'Page', startrow: '1' }),
    );
    expect(ctx.req.sessionWrites).toEqual(expect.objectContaining({ moduleid: FORM_MODULE_ID }));
  });

  it.each<[string, Readonly<Record<string, string>>]>([
    ['isnav', { isnav: '1' }],
    ['display', { display: '2', displayStart: '01/15/2026', displayStop: '02/15/2026', displayInterval: '' }],
    ['template', { template: 'two_column.cfm', childTemplate: 'one_column.cfm' }],
    ['inheritObjects', { inheritObjects: 'Reject' }],
  ])('posts savequickedit of %s with its fields and the csrf pair unchanged', async (attribute, values) => {
    const rc = { contentid: CONTENT_ID, attribute, ...values, ...CSRF_FIELDS };
    const routes = { [svc('POST', rawPath('savequickedit'))]: RELAYS.aborted.reply };
    const ctx = screenContext('savequickedit', { rc, post: true, routes });
    await expect(invoke(definition('savequickedit'), ctx)).resolves.toEqual(RELAYS.aborted.answer);
    expect(ctx.gateway.calls).toEqual([
      {
        service: SERVICE,
        method: 'POST',
        path: rawPath('savequickedit'),
        query: { siteid: SITE },
        form: { ...ctx.req.rc },
        headers: SENT_CSRF,
      },
    ]);
    expect(ctx.gateway.calls[0]?.form).toEqual(expect.objectContaining(rc));
  });

  it.each([401, 403])('answers a %i with a 302 to the secure() target', async (status) => {
    const routes = { [svc('GET', rawPath('unlocknode'))]: { status, body: SERVICE_ERROR } };
    const ctx = screenContext('unlocknode', { rc: FIELDS, routes });
    await expect(invoke(definition('unlocknode'), ctx)).resolves.toEqual({
      status: 302,
      contentType: HTML_TYPE,
      body: '',
      headers: { ...REDIRECT_HEADERS, location: REFERER },
    });
  });

  // Framing and internal headers a service answer may carry; none reaches the bare body.
  const UNRELAYED = { 'Content-Length': '0', 'Transfer-Encoding': 'chunked', 'X-Opt2-Write-Position': '7' };
  const LOCATION = `./?muraAction=cArch.list&siteid=${SITE}`;
  const CACHED = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
  const HEADER_CASES: ReadonlyArray<readonly [string, FakeReply, Readonly<Record<string, string>>]> = [
    [
      'a 302',
      { status: 302, headers: { Location: LOCATION, ...UNRELAYED } },
      { ...REDIRECT_HEADERS, location: LOCATION },
    ],
    [
      'a 302 with its own cache headers',
      { status: 302, headers: { Location: LOCATION, ...CACHED, ...UNRELAYED } },
      { ...REDIRECT_HEADERS, 'cache-control': 'no-store', location: LOCATION },
    ],
    [
      'a 200 with cache headers',
      { status: 200, headers: { 'Content-Type': HTML_TYPE, ...CACHED, ...UNRELAYED } },
      { 'cache-control': 'no-store', pragma: 'no-cache' },
    ],
  ];
  const HEADER_RELAYS = RELAYED.flatMap((action) =>
    HEADER_CASES.map(([name, reply, headers]) => [action, name, reply, headers] as const),
  );

  it.each(HEADER_RELAYS)(
    'relays carch.%s answering %s with its end-to-end headers and the cflocation headers of a redirect',
    async (action, _name, reply, headers) => {
      const ctx = screenContext(action, { rc: FIELDS, routes: { [svc('GET', rawPath(action))]: reply } });
      await expect(invoke(definition(action), ctx)).resolves.toEqual({
        status: reply.status,
        contentType: HTML_TYPE,
        body: Buffer.alloc(0),
        headers,
      });
    },
  );
});

describe('carch.updateobjectparams', () => {
  const RC = {
    contenthistid: HIST_ID,
    regionid: '2',
    object: 'feed',
    objectid: 'O1',
    name: 'Latest News',
    params: '{"displaylist":"Title,Date"}',
    approved: '0',
    ...CSRF_FIELDS,
  };
  const written = (data?: Readonly<Record<string, unknown>>): FakeReply => ({
    status: 200,
    body: { saved: true, errors: {}, redirect: null, ...(data === undefined ? {} : { data }) },
  });
  const posted = (reply: FakeReply, rc: Readonly<Record<string, string>> = RC) =>
    screenContext('updateobjectparams', { rc, post: true, routes: { [svc('POST', OBJECT_PARAMS_PATH)]: reply } });
  const run = (ctx: ScreenContext) => invoke(definition('updateobjectparams'), ctx);

  it('posts every rc field and the csrf headers, then writes the version literal', async () => {
    const ctx = posted(written({ contentID: CONTENT_ID, contentHistID: HIST_ID }));
    await expect(run(ctx)).resolves.toEqual({
      status: 200,
      contentType: HTML_TYPE,
      body: `{contentid:'${CONTENT_ID}',contenthistid:'${HIST_ID}'} `,
    });
    expect(ctx.gateway.calls).toEqual([
      { service: SERVICE, method: 'POST', path: OBJECT_PARAMS_PATH, form: { ...ctx.req.rc }, headers: SENT_CSRF },
    ]);
    expect(ctx.gateway.calls[0]?.form).toEqual(expect.objectContaining({ ...RC, siteid: SITE }));
  });

  it.each<[string, Readonly<Record<string, unknown>> | undefined]>([
    ['no data', undefined],
    ['no contenthistid', { contentid: CONTENT_ID }],
    ['a non-string contentid', { contentid: 7, contenthistid: HIST_ID }],
  ])('aborts empty when the result carries %s', async (_name, data) => {
    await expect(run(posted(written(data)))).resolves.toEqual(ABORTED);
  });

  it('aborts on an empty contenthistid without a call', async () => {
    const ctx = posted(written(), { ...RC, contenthistid: '' });
    await expect(run(ctx)).resolves.toEqual(ABORTED);
    expect(ctx.gateway.calls).toEqual([]);
  });

  it('aborts on an unknown version', async () => {
    await expect(run(posted({ status: 404, body: SERVICE_ERROR }))).resolves.toEqual(ABORTED);
  });

  it('fails on any other rejection', async () => {
    await expect(run(posted({ status: 400, body: SERVICE_ERROR }))).rejects.toEqual(
      new Error('strategies-content rejected carch.updateobjectparams with HTTP 400'),
    );
  });

  it.each([401, 403])('answers a %i with a 302 to the secure() target', async (status) => {
    await expect(run(posted({ status, body: SERVICE_ERROR }))).resolves.toEqual({
      status: 302,
      contentType: HTML_TYPE,
      body: '',
      headers: { ...REDIRECT_HEADERS, location: REFERER },
    });
  });
});

describe('carch.editlive', () => {
  const EDIT_URL =
    `/admin/?muraAction=cArch.edit&contenthistid=${HIST_ID}&contentid=${CONTENT_ID}&type=Form&siteid=${SITE}` +
    `&topid=${FORM_MODULE_ID}&parentid=${FORM_MODULE_ID}&moduleid=${FORM_MODULE_ID}&compactdisplay=true`;
  const MODEL = { rc: { contentBean: { contentid: CONTENT_ID, type: 'Form', editUrl: EDIT_URL } } };
  const reading = (rc: Readonly<Record<string, string>>, reply: FakeReply, contentId = CONTENT_ID) =>
    screenContext('editlive', { rc, routes: { [svc('GET', contentPath(contentId))]: reply } });

  it.each([
    ['', '&instanceid='],
    ['I 1&x', '&instanceid=I+1%26x'],
  ])('redirects to the compact edit URL with instanceid %j url-encoded', async (instanceid, suffix) => {
    const ctx = reading({ contentid: CONTENT_ID, type: 'Form', instanceid }, { status: 200, body: MODEL });
    await expect(invoke(editliveScreen, ctx)).resolves.toEqual({ kind: 'location', location: `${EDIT_URL}${suffix}` });
    expect(ctx.gateway.calls).toEqual([
      {
        service: SERVICE,
        method: 'GET',
        path: contentPath(CONTENT_ID),
        query: { type: 'Form', compactDisplay: 'true' },
      },
    ]);
  });

  it('finds a node by title under a new CF UUID', async () => {
    vi.mocked(cfUuid).mockReturnValue(NEW_ID);
    const ctx = reading({ title: 'Contact Us', type: 'Form', instanceid: 'I1' }, { status: 200, body: MODEL }, NEW_ID);
    await expect(invoke(editliveScreen, ctx)).resolves.toEqual({
      kind: 'location',
      location: `${EDIT_URL}&instanceid=I1`,
    });
    expect(ctx.gateway.calls).toEqual([
      {
        service: SERVICE,
        method: 'GET',
        path: contentPath(NEW_ID),
        query: { type: 'Form', compactDisplay: 'true', title: 'Contact Us' },
      },
    ]);
  });

  it.each<[string, Rc, string]>([
    ['a page request', {}, 'Page'],
    ['an ajax request', { ajaxrequest: 'true' }, ''],
    ['a named type', { type: 'Component', moduleid: CONTENT_MODULE_ID }, 'Component'],
  ])('reads %s with type %j', async (_name, rc, type) => {
    const ctx = reading({ contentid: CONTENT_ID, ...rc }, { status: 200, body: MODEL });
    await invoke(editliveScreen, ctx);
    expect(ctx.gateway.calls[0]?.query).toEqual({ type, compactDisplay: 'true' });
  });

  it('reads contentBean.editUrl case-insensitively', async () => {
    const model = { rc: { CONTENTBEAN: { EDITURL: EDIT_URL } } };
    const ctx = reading({ contentid: CONTENT_ID }, { status: 200, body: model });
    await expect(invoke(editliveScreen, ctx)).resolves.toEqual({
      kind: 'location',
      location: `${EDIT_URL}&instanceid=`,
    });
  });

  it.each<[string, unknown]>([
    ['no contentBean', {}],
    ['a null contentBean', { contentBean: null }],
    ['a scalar contentBean', { contentBean: 'About Us' }],
    ['an empty editUrl', { contentBean: { editUrl: '' } }],
    ['a non-string editUrl', { contentBean: { editUrl: 7 } }],
  ])('fails on a model with %s', async (_name, rc) => {
    const ctx = reading({ contentid: CONTENT_ID }, { status: 200, body: { rc } });
    await expect(invoke(editliveScreen, ctx)).rejects.toEqual(
      new TypeError('strategies-content getContentEditModel returned no rc.contentBean.editUrl for carch.editlive'),
    );
  });

  it.each([401, 403])('follows the secure() redirect on a %i', async (status) => {
    const ctx = reading({ contentid: CONTENT_ID }, { status, body: SERVICE_ERROR });
    await expect(invoke(editliveScreen, ctx)).resolves.toEqual({ kind: 'location', location: REFERER });
  });

  it('fails on a rejected read', async () => {
    const ctx = reading({ contentid: CONTENT_ID }, { status: 404, body: SERVICE_ERROR });
    await expect(invoke(editliveScreen, ctx)).rejects.toEqual(
      new Error('strategies-content rejected the carch.editlive read with HTTP 404'),
    );
  });
});

describe('carch.lockfile', () => {
  const ATTACHMENT = `/index.cfm/_api/render/file/?fileid=${FILE_ID}&method=attachment`;

  it.each<[string, FakeReply, RawBody]>([
    [
      'the lock redirect to the attachment',
      { status: 302, headers: { 'Content-Type': HTML_TYPE, Location: ATTACHMENT } },
      {
        status: 302,
        contentType: HTML_TYPE,
        body: Buffer.alloc(0),
        headers: { ...REDIRECT_HEADERS, location: ATTACHMENT },
      },
    ],
    ['the empty abort of a refused lock', RELAYS.aborted.reply, RELAYS.aborted.answer],
  ])('relays %s', async (_name, reply, answer) => {
    const rc = { contentid: CONTENT_ID, ...CSRF_FIELDS };
    const ctx = screenContext('lockfile', { rc, post: true, routes: { [svc('POST', rawPath('lockfile'))]: reply } });
    await expect(invoke(lockfileScreen, ctx)).resolves.toEqual(answer);
    expect(ctx.gateway.calls[0]?.form).toEqual(expect.objectContaining({ ...rc, siteid: SITE }));
  });
});
