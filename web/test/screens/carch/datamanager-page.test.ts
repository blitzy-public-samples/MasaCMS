// carch.datamanager against datamanager.cfm: in-view writes, the page model read and the legacy-captured view bodies.
import { readFileSync } from 'node:fs';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { datamanagerScreen, type DataManagerData } from '@/screens/carch/datamanager';
import { carchJs } from '@/screens/carch/partials/js';
import type { PageControllerRedirect, ScreenContext } from '@/screens/registry';
import type { ShellView } from '@/shell/document';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeCall,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
  type RecordedRequest,
} from '../../helpers/fake-gateway';

// The view bodies of `cArch.datamanager` on Home with two seeded responses, and (`noform`) without a contentid, captured
// from the legacy ACF 2023 server between the layout's `<div id="mura-content">` and its close; CSRF token values are
// `<token>`.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/datamanager-page-${name}.html`, import.meta.url), 'utf8');

const HOME = '00000000000000000000000000000000001';
const FORMS = '00000000000000000000000000000000004';
const ANN = 'A1B2C3D4-E5F6-1A2B-3C4D5E6F7A8B9C0D';
const BOB = 'D1B2C3D4-E5F6-1A2B-3C4D5E6F7A8B9C0D';
const CSRF_PAIR = { csrf_token: 'ABC123', csrf_token_expires: '261113043456389' };
const READ = routeKey('GET', 'strategies-content', `/v1/sites/default/forms/${HOME}/responses`);
const WRITE = routeKey('POST', 'strategies-content', `/v1/sites/default/forms/${HOME}/responses/delete`);
const WRITTEN: FakeReply = { status: 200, body: { saved: true, errors: {}, redirect: null } };
const VIEW_RC = { contentid: HOME, siteid: 'default', moduleid: FORMS, topid: FORMS, parentid: FORMS, type: 'Form' };
const RANGE = { date1: '', hour1: '0', minute1: '0', date2: '', hour2: '23', minute2: '59' };
const CF_UUID = '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}';

const BEAN = {
  contentID: HOME,
  contentHistID: '6300ED69-1320-5CC3-F922E3012E2C6BAE',
  title: 'Home',
  body: '',
  responseDisplayFields: '',
  sortBy: 'orderno',
  sortDirection: 'asc',
  nextN: 10,
  type: 'Page',
  subType: 'Default',
  active: 1,
  filename: '',
  parentID: '00000000000000000000000000000000END',
  menuTitle: 'Home',
  remoteURL: '',
  fileID: '',
  isNew: 0,
  stats: { lockID: '', lockType: '' },
};

/** A `getData` row as the model carries it: query timestamp text and the deserialised packet. */
const row = (responseID: string, entered: string, name: string, email: string, message: string) => ({
  responseID,
  entered,
  data: { RESPONSEID: responseID, FIELDNAMES: 'NAME,EMAIL,MESSAGE', NAME: name, EMAIL: email, MESSAGE: message },
});
const ROW_ANN = row(ANN, '2026-06-01 13:05:00.0', 'Ann <b>', 'a@b.com', 'line one');
const ROW_BOB = row(BOB, '2026-06-30 09:41:00.0', 'Bob', 'bob@b.com', 'hello');

/** The listFormResponses model of the captured Home, with `rc` overrides. */
const model = (rc: Record<string, unknown> = {}): FakeReply => ({
  status: 200,
  body: {
    rc: {
      contentBean: BEAN,
      perm: 'editor',
      hasLockableNodes: 0,
      useLayoutManager: true,
      rsDataInfo: { firstentered: ROW_ANN.entered, lastentered: ROW_BOB.entered, countentered: 2 },
      fieldnames: 'EMAIL,MESSAGE,NAME',
      rsData: [],
      scheme: 'http',
      domain: 'localhost',
      serverPort: ':23580',
      context: '',
      ...rc,
    },
  },
});

/** The listFormResponses model of an unknown form id: strategies-content's new bean, no crumbs and no responses. */
const NO_FORM = model({
  contentBean: {
    Contentid: '',
    ContentHistID: '',
    Title: '',
    Body: '',
    type: 'Page',
    subType: 'Default',
    Active: 1,
    Filename: '',
    ParentID: '',
    MenuTitle: '',
    remoteURL: '',
    FileID: '',
    ResponseDisplayFields: '',
    nextN: 10,
    sortBy: 'orderno',
    sortDirection: 'asc',
    isNew: 1,
    stats: {},
  },
  crumbData: [],
  perm: 'none',
  hasLockableNodes: false,
  useLayoutManager: false,
  rsDataInfo: { firstentered: null, lastentered: null, countentered: 0 },
  fieldnames: '',
});

/** identity `issueCsrfTokens`, one pair per requested context. */
function issueTokens(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => ({ context, [CSRF_FIELD_TOKEN]: 'F00D', [CSRF_FIELD_EXPIRES]: '261113' }));
  return { status: 200, body: { tokens } };
}

/** The S2 admin's screen context on the captured URL's `base` rc plus `rc`, over a gateway answering `routes`. */
function contextFor(
  rc: Record<string, string>,
  routes: FakeRouteTable,
  base: Record<string, string> = VIEW_RC,
): { ctx: ScreenContext; gateway: FakeGatewayClient } {
  const gateway = fakeGatewayClient({ [routeKey('POST', 'identity', '/v1/csrf/tokens')]: issueTokens, ...routes });
  const req = adminS2Request({ circuit: 'carch', item: 'datamanager', rc: { ...base, ...rc } });
  const ctx: ScreenContext = {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor(req.session.rb),
    hooks: { secondaryMenus: {} },
    now: new Date(2026, 6, 1),
  };
  return { ctx, gateway };
}

/** `gateway` answering the form read and write at whichever form id a strategies-content call addresses. */
function anyForm(gateway: FakeGatewayClient, read: FakeReply): FakeGatewayClient {
  const facade = gateway.strategiesContent;
  const forward = facade.call as (...args: readonly unknown[]) => ReturnType<typeof facade.call>;
  const call = (...args: readonly unknown[]): ReturnType<typeof facade.call> => {
    const id = (args[2] as { readonly params?: { readonly contentid?: string } } | undefined)?.params?.contentid;
    if (id !== undefined) {
      gateway.setRoute(routeKey('GET', 'strategies-content', `/v1/sites/default/forms/${id}/responses`), read);
      gateway.setRoute(routeKey('POST', 'strategies-content', `/v1/sites/default/forms/${id}/responses/delete`), WRITTEN);
    }
    return forward(...args);
  };
  return { ...gateway, strategiesContent: { ...facade, call: call as unknown as typeof facade.call } };
}

/** The handler's page sequence: the controller step, then load and render when it does not redirect. */
async function run(ctx: ScreenContext): Promise<{ redirect?: PageControllerRedirect; view?: ShellView }> {
  const redirect = await datamanagerScreen.redirect?.(ctx);
  if (redirect !== undefined) return { redirect };
  const data: DataManagerData = await (datamanagerScreen.load as (c: ScreenContext) => Promise<DataManagerData>)(ctx);
  return { view: await datamanagerScreen.render(ctx, data) };
}

async function bodyOf(ctx: ScreenContext): Promise<string> {
  const { view } = await run(ctx);
  if (view === undefined) throw new Error('the page redirected');
  return toString(view.body);
}

/** Token values as the fixtures record them. */
const masked = (markup: string): string =>
  markup
    .replace(/(csrf_token(?:_expires)?=)[^&"]*/g, '$1<token>')
    .replace(/(name="csrf_token(?:_expires)?" value=")[^"]*/g, '$1<token>');

const strategiesCalls = (gateway: FakeGatewayClient): FakeCall[] =>
  gateway.calls.filter((call) => call.service === 'strategies-content');

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe('carch.datamanager view', () => {
  it.each([
    ['default', {}, {}],
    [
      'filtered',
      { ...RANGE, sortBy: 'Entered', sortDirection: 'asc', filterBy: 'NAME', keywords: 'Bob', newSearch: '1' },
      { rsData: [ROW_BOB] },
    ],
    ['display', { action: 'display' }, {}],
    [
      'edit',
      { ...RANGE, action: 'edit', responseid: ANN, sortBy: 'Entered', sortDirection: 'asc' },
      { rsData: [ROW_ANN] },
    ],
  ])('renders the %s body byte for byte', async (name, rc, view) => {
    const { ctx, gateway } = contextFor(rc, { [READ]: model(view) });
    expect(masked(await bodyOf(ctx))).toBe(fixture(name));
    expect(strategiesCalls(gateway).map((call) => call.method)).toEqual(['GET']);
  });

  it.each([
    ['no contentid', {}, ['GET']],
    ['an empty contentid', { contentid: '' }, ['GET']],
    [
      'setDisplay on an empty contentid',
      { contentid: '', action: 'setDisplay', detailList2: 'NAME', summaryList2: 'EMAIL', nextN: '20', sortBy: 'NAME' },
      ['POST', 'GET'],
    ],
  ])('renders the empty form page for %s, addressing one fresh CF UUID', async (_name, rc, methods) => {
    const { ctx, gateway } = contextFor(rc, {}, { siteid: 'default', moduleid: FORMS });
    ctx.gateway = anyForm(gateway, NO_FORM);
    expect(masked(await bodyOf(ctx))).toBe(fixture('noform'));
    const calls = strategiesCalls(gateway);
    expect(calls.map((call) => call.method)).toEqual(methods);
    const ids = calls.map((call) => new RegExp(`^/v1/sites/default/forms/(${CF_UUID})/responses`).exec(call.path)?.[1]);
    expect(ids.every((id) => id !== undefined && id === ids[0])).toBe(true);
    expect(ctx.req.rc.contentid).toBe('');
  });

  it('reads with every rc field after the carch and view defaults', async () => {
    const { ctx, gateway } = contextFor({}, { [READ]: model() });
    await run(ctx);
    expect(strategiesCalls(gateway)[0]?.query).toMatchObject({ ...VIEW_RC, action: '', keywords: '', filterBy: '' });
    expect(ctx.req.rc.sortBy).toBe('orderno');
  });

  it('heads the page with the session date key, then the display script on the display panel', async () => {
    const plain = contextFor({}, { [READ]: model() }).ctx;
    const display = contextFor({ action: 'display' }, { [READ]: model() }).ctx;
    const dateKey = toString(plain.req.session.dateKey.script);
    const [plainView, displayView] = [(await run(plain)).view, (await run(display)).view];
    expect(String(plainView?.htmlHead)).toBe(dateKey);
    expect(String(displayView?.htmlHead)).toBe(
      `${dateKey}<script src="assets/js/manageData.js?coreversion=7.6.1" type="text/javascript"></script>`,
    );
    expect(String(plainView?.ajax)).toBe(toString(carchJs(plain, 'datamanager')));
  });
});

describe('carch.datamanager in-view writes', () => {
  it.each([
    ['Update', { action: 'Update', responseid: ANN, NAME: 'Ann', ...CSRF_PAIR }],
    ['Delete', { action: 'Delete', responseid: ANN, ...CSRF_PAIR }],
    ['setDisplay', { action: 'setDisplay', detailList2: 'NAME', summaryList2: 'EMAIL', nextN: '20', sortBy: 'NAME' }],
  ])('posts %s with every field unchanged before the read', async (_action, rc) => {
    const { ctx, gateway } = contextFor(rc, { [READ]: model(), [WRITE]: WRITTEN });
    await run(ctx);
    const [write, read] = strategiesCalls(gateway);
    expect(strategiesCalls(gateway).map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(write?.form).toMatchObject(rc);
    expect(read?.query).toMatchObject({ action: rc.action === 'setDisplay' ? '' : rc.action });
  });

  it('clears rc.action after setDisplay, so the response panel renders', async () => {
    const { ctx } = contextFor({ action: 'setDisplay' }, { [READ]: model(), [WRITE]: WRITTEN });
    const body = await bodyOf(ctx);
    expect(ctx.req.rc.action).toBe('');
    expect(body).toContain('<div id="manage-data">');
  });

  it.each<Record<string, string>>([{ action: 'Update' }, { action: 'Delete' }, { responseid: ANN, action: 'edit' }])(
    'writes nothing for %o',
    async (rc) => {
      const { ctx, gateway } = contextFor(rc, { [READ]: model({ rsData: [ROW_ANN] }) });
      await run(ctx).catch(() => undefined);
      expect(strategiesCalls(gateway).map((call) => call.method)).toEqual(['GET']);
    },
  );

  it('deletes the filtered responses after the read and reports their count', async () => {
    const rc = { ...RANGE, newSearch: '1', delete: '1' };
    const { ctx, gateway } = contextFor(rc, { [READ]: model({ rsData: [ROW_ANN, ROW_BOB] }), [WRITE]: WRITTEN });
    const body = await bodyOf(ctx);
    expect(strategiesCalls(gateway).map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(strategiesCalls(gateway)[1]?.form).toMatchObject(rc);
    expect(body).toContain('Total Records Available: <strong>2</strong>');
    expect(body).toContain('2 responses were deleted.');
  });

  it('posts no bulk delete when the filter matched nothing', async () => {
    const { ctx, gateway } = contextFor({ ...RANGE, delete: 'true' }, { [READ]: model() });
    await run(ctx);
    expect(strategiesCalls(gateway).map((call) => call.method)).toEqual(['GET']);
  });

  it.each([
    ['write', { action: 'Delete', responseid: ANN }, { [WRITE]: { status: 403, body: {} } }],
    ['read', {}, { [READ]: { status: 401, body: {} } }],
  ])('answers a denied %s with the secure() redirect', async (_step, rc, routes) => {
    const { ctx } = contextFor(rc, routes);
    expect((await run(ctx)).redirect).toEqual({ kind: 'location', location: './' });
  });

  it('fails as legacy errors on a rejected read', async () => {
    const { ctx } = contextFor({}, { [READ]: { status: 404, body: {} } });
    await expect(run(ctx)).rejects.toThrow('rejected the carch.datamanager read with HTTP 404');
  });
});

describe('carch.datamanager forms legacy cannot render', () => {
  it.each([
    ['an ORM-entity form', { form: { muraormentities: true, formattributes: { muraormentities: 'true' } } }],
    ['JSON without a form struct', 123],
    ['a form flag without attributes', { form: { muraormentities: true } }],
  ])('answers unavailable for %s', async (_name, body) => {
    const { ctx } = contextFor({}, { [READ]: model({ contentBean: { ...BEAN, body: JSON.stringify(body) } }) });
    await expect(run(ctx)).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
  });

  it.each([
    ['a form-builder form', { form: { formattributes: {} } }],
    ['an unflagged ORM form', { form: { muraormentities: true, formattributes: { muraormentities: false } } }],
  ])('renders %s', async (_name, body) => {
    const { ctx } = contextFor({}, { [READ]: model({ contentBean: { ...BEAN, body: JSON.stringify(body) } }) });
    await expect(bodyOf(ctx)).resolves.toContain('<div id="manage-data">');
  });

  it('needs its controller step before load', async () => {
    const { ctx } = contextFor({}, {});
    await expect(datamanagerScreen.load?.(ctx)).rejects.toThrow('loaded before its controller step ran');
  });
});
