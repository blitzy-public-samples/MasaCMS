// carch editLive and lockFile (admin/core/controllers/carch.cfc 285-302, 578-590) through strategies-content.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { legacySettings, resetLegacySettingsForTests } from '@/lib/env';
import { encodeUrl } from '@/lib/html';
import { editliveScreen } from '@/screens/carch/editlive';
import { lockfileScreen } from '@/screens/carch/lockfile';
import type { CarchPageModel } from '@/screens/carch/service';
import { CONTENT_HIST_IDS, CONTENT_IDS, FILE_IDS } from '../../fixtures/strategies-content/carch';
import { anonymousRequest, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type FakeRouteTable } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

vi.mock('@opt2/platform/legacy-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/legacy-compat')>();
  return { ...actual, cfUuid: vi.fn(actual.cfUuid) };
});

const SITE = 'tenant-a';
const SERVICE = 'strategies-content';
const HTML_TYPE = 'text/html;charset=UTF-8';
const REFERER = `http://localhost/admin/?muraAction=cArch.list&siteid=${SITE}`;
/** Headers of web's `cflocation` answer, beside its `location`. */
const CFLOCATION_HEADERS = { 'cache-control': 'no-cache', pragma: 'no-cache', 'content-type': HTML_TYPE };
/** The `createUUID()` a title lookup's new bean takes as its id. */
const NEW_ID = '5C000000-00FF-4000-8000000000000001';
const HOME_ID = '00000000000000000000000000000000001';
const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const COMPONENTS_MODULE = '00000000000000000000000000000000003';
const FORMS_MODULE = '00000000000000000000000000000000004';
const CSRF_FIELDS = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };
const LOCKFILE_PATH = '/v1/raw/carch/lockfile';
const UNAVAILABLE = { name: 'GatewayUnavailableError', service: SERVICE };

const contentPath = (contentId: string): `/${string}` => `/v1/sites/${SITE}/content/${contentId}`;

const serviceError = (status: number): FakeReply => ({
  status,
  body: { apiversion: 'v1', method: 'carch', error: { message: `HTTP ${status}`, code: String(status) } },
});

/** contentBean `getEditURL(compactDisplay=true)` of a top-level node, as strategies-content builds it. */
function editUrl(contentId: string, contentHistId: string, type: 'Page' | 'Form' | 'Component'): string {
  const moduleId = { Page: SITE_MANAGER_MODULE, Form: FORMS_MODULE, Component: COMPONENTS_MODULE }[type];
  const topId = type === 'Page' ? HOME_ID : moduleId;
  return (
    `/admin/?muraAction=cArch.edit&contenthistid=${contentHistId}&contentid=${contentId}&type=${type}` +
    `&siteid=${SITE}&topid=${topId}&parentid=${topId}&moduleid=${moduleId}&compactdisplay=true`
  );
}

const BANNER_URL = editUrl(CONTENT_IDS.homeBanner, CONTENT_HIST_IDS.homeBanner, 'Component');

const editModel = (rc: CarchPageModel['rc']): FakeReply => ({ status: 200, body: { rc } satisfies CarchPageModel });

interface ContextInput {
  readonly rc: Readonly<Record<string, string>>;
  readonly routes?: FakeRouteTable;
  /** Carries `rc` as the posted form; otherwise the request has no body. */
  readonly post?: boolean;
}

/** The tenant-a site admin on `carch.<action>`, arriving from the Site Manager, over a fake gateway. */
function screenContext(action: 'editlive' | 'lockfile', { rc, routes = {}, post = false }: ContextInput) {
  const headers = new Headers({ referer: REFERER });
  const req = siteAdminRequest(SITE, { circuit: 'carch', item: action, rc, headers });
  const form = new URLSearchParams(rc);
  const body = post
    ? { contentType: 'application/x-www-form-urlencoded', body: new Blob([form.toString()]), form }
    : undefined;
  return makeScreenContext({ req, gateway: fakeGatewayClient(routes), body });
}

type Context = ReturnType<typeof screenContext>;

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  vi.mocked(cfUuid).mockReset();
  restore();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('carch.editlive', () => {
  const answering = (contentId: string, reply: FakeReply): FakeRouteTable => ({
    [routeKey('GET', SERVICE, contentPath(contentId))]: reply,
  });

  beforeEach(() => {
    vi.mocked(cfUuid).mockReturnValue(NEW_ID);
  });

  // Path id, then the lookup query sent, then the found node's edit URL.
  it.each<[string, Readonly<Record<string, string>>, string, Readonly<Record<string, string>>, string]>([
    [
      'a title and the Form type',
      { title: 'Contact Us', type: 'Form' },
      NEW_ID,
      { title: 'Contact Us', type: 'Form', compactDisplay: 'true' },
      editUrl(CONTENT_IDS.contactForm, CONTENT_HIST_IDS.contactForm, 'Form'),
    ],
    [
      'a title and the Component type',
      { title: 'Home Banner', type: 'Component' },
      NEW_ID,
      { title: 'Home Banner', type: 'Component', compactDisplay: 'true' },
      BANNER_URL,
    ],
    // before() has already typed a non-ajax request Page, which the service's title-only lookup does not filter by.
    [
      'a title alone',
      { title: 'About Us' },
      NEW_ID,
      { title: 'About Us', type: 'Page', compactDisplay: 'true' },
      editUrl(CONTENT_IDS.aboutUs, CONTENT_HIST_IDS.aboutUs, 'Page'),
    ],
    [
      'the contentId a display-object configurator sends',
      { contentId: CONTENT_IDS.homeBanner, type: 'Component', compactDisplay: 'true' },
      CONTENT_IDS.homeBanner,
      { type: 'Component', compactDisplay: 'true' },
      BANNER_URL,
    ],
  ])('looks the node up by %s', async (_name, rc, contentId, query, url) => {
    const ctx = screenContext('editlive', {
      rc: { ...rc, instanceid: 'I1' },
      routes: answering(contentId, editModel({ contentBean: { editUrl: url } })),
    });
    await expect(editliveScreen.submit(ctx)).resolves.toEqual({ kind: 'location', location: `${url}&instanceid=I1` });
    expect(ctx.gateway.calls).toEqual([{ service: SERVICE, method: 'GET', path: contentPath(contentId), query }]);
  });

  it('appends rc.instanceid url-encoded as esapiEncode does', async () => {
    const { contactForm } = CONTENT_IDS;
    const url = editUrl(contactForm, CONTENT_HIST_IDS.contactForm, 'Form');
    const ctx = screenContext('editlive', {
      rc: { contentid: contactForm, type: 'Form', instanceid: 'a b&c' },
      routes: answering(contactForm, editModel({ contentBean: { editUrl: url } })),
    });
    const result = await editliveScreen.submit(ctx);
    expect(result).toEqual({ kind: 'location', location: `${url}&instanceid=${encodeUrl('a b&c')}` });
    const location = result.kind === 'location' ? result.location : '';
    expect(new URLSearchParams(location.slice(location.indexOf('?'))).getAll('instanceid')).toEqual(['a b&c']);
  });

  it.each<[string, CarchPageModel['rc'], string]>([
    ['an admin path under a context', { contentBean: { editUrl: `/masa${BANNER_URL}` } }, `/masa${BANNER_URL}`],
    [
      'a relative URL',
      { contentBean: { editUrl: `./?muraAction=cArch.edit&contentid=${CONTENT_IDS.homeBanner}&compactDisplay=true` } },
      `./?muraAction=cArch.edit&contentid=${CONTENT_IDS.homeBanner}&compactDisplay=true`,
    ],
    [
      'a bean keyed as CFML serializes it',
      { CONTENTBEAN: { EDITURL: `http://localhost/admin/?muraAction=cArch.edit&contentid=${CONTENT_IDS.homeBanner}` } },
      `http://localhost/admin/?muraAction=cArch.edit&contentid=${CONTENT_IDS.homeBanner}`,
    ],
  ])('redirects to the edit URL strategies-content built: %s', async (_name, model, url) => {
    const ctx = screenContext('editlive', {
      rc: { contentid: CONTENT_IDS.homeBanner, type: 'Component', instanceid: 'I1' },
      routes: answering(CONTENT_IDS.homeBanner, editModel(model)),
    });
    await expect(editliveScreen.submit(ctx)).resolves.toEqual({ kind: 'location', location: `${url}&instanceid=I1` });
  });

  it.each<[string, FakeReply, Error]>([
    [
      'a rejected read',
      serviceError(404),
      new Error('strategies-content rejected the carch.editlive read with HTTP 404'),
    ],
    [
      'a model without an edit URL',
      editModel({ contentBean: { contentID: CONTENT_IDS.homeBanner, type: 'Component' } }),
      new TypeError('strategies-content getContentEditModel returned no rc.contentBean.editUrl for carch.editlive'),
    ],
  ])('fails on %s rather than building the edit URL itself', async (_name, reply, error) => {
    const ctx = screenContext('editlive', {
      rc: { contentid: CONTENT_IDS.homeBanner, type: 'Component' },
      routes: answering(CONTENT_IDS.homeBanner, reply),
    });
    await expect(editliveScreen.submit(ctx)).rejects.toEqual(error);
  });
});

describe('carch.lockfile', () => {
  const FIELDS = { contentID: CONTENT_IDS.brochurePdf, ...CSRF_FIELDS };
  const route = (method: 'GET' | 'POST', reply: FakeReply): FakeRouteTable => ({
    [routeKey(method, SERVICE, LOCKFILE_PATH)]: reply,
  });
  /** The contract's empty 200: the lock was refused for want of a permission or a valid token. */
  const REFUSED: FakeReply = {
    status: 200,
    headers: {
      'Content-Type': HTML_TYPE,
      Generator: 'Masa CMS 7.6.1',
      'Strict-Transport-Security': 'max-age=1200',
      'X-Opt2-Write-Position': `${SERVICE}=7`,
    },
  };

  it('relays the url fields of the filetools link over GET unchanged', async () => {
    const ctx = screenContext('lockfile', { rc: FIELDS, routes: route('GET', REFUSED) });
    await lockfileScreen.json(ctx, undefined);
    expect(ctx.gateway.calls).toEqual([
      { service: SERVICE, method: 'GET', path: LOCKFILE_PATH, query: { ...ctx.req.rc } },
    ]);
    expect(ctx.gateway.calls[0]?.query).toEqual(expect.objectContaining({ ...FIELDS, siteid: SITE }));
  });

  it('posts contentid and the csrf pair unchanged, with siteid in the query', async () => {
    const ctx = screenContext('lockfile', { rc: FIELDS, post: true, routes: route('POST', REFUSED) });
    await lockfileScreen.json(ctx, undefined);
    expect(ctx.gateway.calls).toEqual([
      { service: SERVICE, method: 'POST', path: LOCKFILE_PATH, query: { siteid: SITE }, form: { ...ctx.req.rc } },
    ]);
    expect(ctx.gateway.calls[0]?.form).toEqual(expect.objectContaining(FIELDS));
  });

  it.each(['', '/masa'])('redirects a set lock to the attachment download under context %j', async (context) => {
    vi.stubEnv('MURA_CONTEXT', context);
    resetLegacySettingsForTests();
    expect(legacySettings().context).toBe(context);
    const location =
      `${legacySettings().context}/index.cfm/_api/render/file/?fileid=${FILE_IDS.brochurePdf}&method=attachment`;
    const locked: FakeReply = { status: 302, headers: { 'Content-Type': HTML_TYPE, Location: location } };
    const ctx = screenContext('lockfile', { rc: FIELDS, post: true, routes: route('POST', locked) });
    await expect(lockfileScreen.json(ctx, undefined)).resolves.toEqual({
      status: 302,
      contentType: HTML_TYPE,
      body: Buffer.alloc(0),
      headers: { ...CFLOCATION_HEADERS, location },
    });
  });

  it('answers a refused lock with the aborted request\'s empty 200', async () => {
    const ctx = screenContext('lockfile', { rc: FIELDS, post: true, routes: route('POST', REFUSED) });
    await expect(lockfileScreen.json(ctx, undefined)).resolves.toEqual({
      status: 200,
      contentType: HTML_TYPE,
      body: Buffer.alloc(0),
    });
  });
});

describe('carch.editlive and carch.lockfile access', () => {
  type Action = 'editlive' | 'lockfile';

  interface ScreenCall {
    readonly rc: Readonly<Record<string, string>>;
    /** The strategies-content route the screen calls. */
    readonly route: string;
    readonly post: boolean;
    /** The screen function its mode's handler calls. */
    run(ctx: Context): Promise<unknown>;
  }

  const CALLS: Readonly<Record<Action, ScreenCall>> = {
    editlive: {
      rc: { contentid: CONTENT_IDS.homeBanner, type: 'Component' },
      route: routeKey('GET', SERVICE, contentPath(CONTENT_IDS.homeBanner)),
      post: false,
      run: (ctx) => editliveScreen.submit(ctx),
    },
    lockfile: {
      rc: { contentid: CONTENT_IDS.brochurePdf, ...CSRF_FIELDS },
      route: routeKey('POST', SERVICE, LOCKFILE_PATH),
      post: true,
      run: async (ctx) => lockfileScreen.json(ctx, undefined),
    },
  };
  const SCREENS = [
    ['editlive', editliveScreen],
    ['lockfile', lockfileScreen],
  ] as const;

  it.each(SCREENS)('sends an anonymous carch.%s request to the controller secure()', async (action, def) => {
    const denied = { kind: 'redirect', location: './?muraAction=cLogin.main&returnURL=' } as const;
    const secure = vi.fn(() => denied);
    expect(await def.gate?.(anonymousRequest({ circuit: 'carch', item: action }), { secure })).toBe(denied);
    expect(await def.gate?.(siteAdminRequest(SITE, { circuit: 'carch', item: action }), { secure })).toEqual({
      kind: 'allow',
    });
    expect(secure).toHaveBeenCalledOnce();
  });

  /** The screen's answer when strategies-content replies `reply`; with none, its connection is refused. */
  function answer(action: Action, reply?: FakeReply): { ctx: Context; result: Promise<unknown> } {
    const { rc, route, post, run } = CALLS[action];
    const ctx = screenContext(action, { rc, post, routes: reply === undefined ? {} : { [route]: reply } });
    if (reply === undefined) ctx.gateway.failWith();
    return { ctx, result: run(ctx) };
  }

  it.each<[Action, unknown]>([
    ['editlive', { kind: 'location', location: REFERER }],
    [
      'lockfile',
      { status: 302, contentType: HTML_TYPE, body: '', headers: { ...CFLOCATION_HEADERS, location: REFERER } },
    ],
  ])('answers a strategies-content denial of carch.%s with the secure() redirect', async (action, redirect) => {
    await expect(answer(action, serviceError(403)).result).resolves.toEqual(redirect);
  });

  it.each<Action>(['editlive', 'lockfile'])('fails closed on carch.%s without strategies-content', async (action) => {
    await expect(answer(action, serviceError(503)).result).rejects.toMatchObject({ ...UNAVAILABLE, status: 503 });
    const refused = answer(action);
    await expect(refused.result).rejects.toMatchObject(UNAVAILABLE);
    expect(refused.ctx.gateway.calls).toHaveLength(1);
  });
});
