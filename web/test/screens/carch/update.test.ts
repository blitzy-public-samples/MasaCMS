// cArch.update against admin/core/controllers/carch.cfc update() and carch/update.cfm over strategies-content's raw
// update: the relayed redirects and aborted bodies, the rejected save's editor inside the layout, the close document,
// the session values the service reports, and the action served through the real raw handler and registry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secure } from '@/lib/access-gate';
import { setServiceClientForTests } from '@/lib/gateway-client';
import { handleAdminRaw } from '@/lib/handlers';
import { encodeJs, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { NO_CACHE_HEADERS, REDIRECT_HEADERS } from '@/lib/responses';
import { carchScreens } from '@/screens/carch';
import { carchGate } from '@/screens/carch/controller';
import { renderEditView } from '@/screens/carch/edit';
import { CONTENT_MODULE_ID, ROOT_CONTENT_ID } from '@/screens/carch/model';
import { updateScreen } from '@/screens/carch/update';
import { findScreen, type RawBody, type ScreenContext, type ScreenRequestBody } from '@/screens/registry';
import { promptCountsZero } from '../../fixtures/strategies-content/prompts';
import { adminS2Request, siteRecordFor } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  startFakeGateway,
  type FakeGateway,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../helpers/fake-gateway';
import { adminRequest } from '../../helpers/requests';
import { makeScreenContext } from '../../helpers/screen-context';
import { SUBJECTS } from '../../helpers/tokens';

// The spans stay in-process: the SDK, and with it the OTLP exporter, is never started.
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  ensureTracing: vi.fn(() => Promise.resolve(undefined)),
  logRequest: vi.fn(),
}));

const SITE = 'default';
const PATH = '/v1/raw/carch/update';
const GET_ROUTE = routeKey('GET', 'strategies-content', PATH);
const POST_ROUTE = routeKey('POST', 'strategies-content', PATH);
const HTML_TYPE = 'text/html;charset=UTF-8';
const JSON_TYPE = 'application/json;charset=utf-8';
const EFFECTS = 'X-Opt2-Session-Effects';
const HOME_HIST_ID = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const END_ID = '00000000000000000000000000000000END';
const NODE_ID = 'D1000000-0000-0000-0000000000000001';
const NODE_HIST_ID = 'D2000000-0000-0000-0000000000000001';
const PARENT_HIST_ID = 'D2000000-0000-0000-0000000000000002';
const CSRF_FIELDS = { csrf_token: 'POSTEDTOKEN', csrf_token_expires: '261231235959000' } as const;
const SERVICE_COOKIE = 'CFTOKEN=0;Path=/;HttpOnly';
// fw.redirect(action="cArch.list",append="topid,siteid,startrow,moduleid",path="./") after an add under Home.
const LIST_LOCATION =
  `./?muraAction=cArch.list&topid=${ROOT_CONTENT_ID}&siteid=${SITE}&startrow=1&moduleid=${CONTENT_MODULE_ID}`;
const HIST_LOCATION = `./?muraAction=cArch.hist&contentid=${NODE_ID}&siteid=${SITE}&startrow=1`;
const BOUNDARY = '----opt2carchupdate';
const MULTIPART = [
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="siteid"',
  '',
  SITE,
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="action"',
  '',
  'add',
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="newfile"; filename="brochure.pdf"',
  'Content-Type: application/pdf',
  '',
  '%PDF-1.4 synthetic',
  `--${BOUNDARY}--`,
  '',
].join('\r\n');

type Struct = Readonly<Record<string, unknown>>;

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

/** The S2 admin on `cArch.update` of `default` with `rc` posted, the session holding `muraValues` in `session.mura`. */
function updateRequest(rc: Readonly<Record<string, string>>, muraValues: Struct = {}): AdminRequest {
  return adminS2Request({
    circuit: 'cArch',
    item: 'update',
    site: { hasChangesets: true, record: { theme: 'default' } },
    rc: { siteid: SITE, ...rc },
    session: { muraValues },
  });
}

/** `fields` as the URL-encoded body web received. */
function formBody(fields: Readonly<Record<string, string>>): ScreenRequestBody {
  const form = new URLSearchParams(fields);
  return { contentType: 'application/x-www-form-urlencoded', body: new Blob([form.toString()]), form };
}

/** {@link MULTIPART} as web received it: the bytes, and its fields with the PDF as a zero-byte file part. */
function multipartBody(): ScreenRequestBody {
  const form = new FormData();
  form.append('siteid', SITE);
  form.append('action', 'add');
  form.append('newfile', new File([], 'brochure.pdf', { type: 'application/pdf' }));
  return { contentType: `multipart/form-data; boundary=${BOUNDARY}`, body: new Blob([MULTIPART]), form };
}

/** The screen context of `req` over a gateway answering `routes` beside the shell's, posting `body` when given. */
function contextOf(
  req: AdminRequest,
  routes: FakeRouteTable,
  body?: ScreenRequestBody,
): ScreenContext & { gateway: FakeGatewayClient } {
  return makeScreenContext({ req, gateway: fakeGatewayClient(routes), ...(body === undefined ? {} : { body }) });
}

/** The service calls to the raw update operation. */
const updateCalls = (gateway: FakeGatewayClient) => gateway.calls.filter((call) => call.path === PATH);

/** strategies-content's JSON answer to a save the view renders. */
const unaborted = (errors: Struct, data: Struct, headers: Readonly<Record<string, string>> = {}): FakeReply => ({
  status: 200,
  headers: { 'Content-Type': JSON_TYPE, ...headers },
  body: { saved: Object.keys(errors).length === 0, errors, redirect: null, data },
  setCookies: [SERVICE_COOKIE],
});

describe('carch.update registration', () => {
  it('serves the base action in fragment mode behind the carch before() gate, from the carch barrel', () => {
    expect(updateScreen).toMatchObject({ circuit: 'carch', action: 'update', mode: 'fragment' });
    expect(updateScreen.owner).toBe('strategies-content');
    expect(updateScreen.gate).toBe(carchGate);
    expect(carchScreens).toContain(updateScreen);
    expect(findScreen('cArch', 'update', { action: 'add', siteid: SITE }, [])).toBe(updateScreen);
    expect(findScreen('core:carch', 'UPDATE', { action: 'add' }, [{ field: 'newfile', filename: 'guide.pdf' }])).toBe(
      updateScreen,
    );
  });

  it.each([
    ['an image upload', { action: 'multiFileUpload' }, [{ field: 'files', filename: 'photo.JPG' }]],
    ['an approval', { action: 'add', approved: '1' }, []],
    ['a notification', { action: 'add', notify: 'user@example.com' }, []],
  ])('leaves %s to legacy', (_label, rc, uploads) => {
    expect(findScreen('carch', 'update', rc, uploads)).toBeUndefined();
  });
});

describe('carch.update relayed answers', () => {
  it('sends a GET delete link as url fields after the before() defaults, answering legacy’s 302', async () => {
    const req = updateRequest({ contentid: NODE_ID, contenthistid: NODE_HIST_ID, action: 'delete', ...CSRF_FIELDS });
    const ctx = contextOf(req, {
      [GET_ROUTE]: { status: 302, headers: { Location: HIST_LOCATION }, setCookies: [SERVICE_COOKIE] },
    });

    await expect(updateScreen.render(ctx, undefined)).resolves.toEqual({
      status: 302,
      contentType: HTML_TYPE,
      body: '',
      headers: { ...REDIRECT_HEADERS, location: HIST_LOCATION },
      setCookies: [SERVICE_COOKIE],
    });
    const [call] = updateCalls(ctx.gateway);
    expect(call).toMatchObject({ method: 'GET' });
    expect(call?.query).toMatchObject({
      siteid: SITE,
      contentid: NODE_ID,
      action: 'delete',
      ...CSRF_FIELDS,
      startrow: '1',
      returnURL: '',
      moduleid: CONTENT_MODULE_ID,
    });
  });

  it('posts the url-encoded rc with its CSRF pair and relays the multi-file upload body byte for byte', async () => {
    const fields = { action: 'multiFileUpload', parentid: ROOT_CONTENT_ID, ...CSRF_FIELDS };
    const req = updateRequest(fields);
    const ctx = contextOf(
      req,
      { [POST_ROUTE]: { status: 200, headers: { 'Content-Type': HTML_TYPE }, body: 'success' } },
      formBody({ siteid: SITE, ...fields }),
    );

    await expect(updateScreen.render(ctx, undefined)).resolves.toEqual({
      status: 200,
      contentType: HTML_TYPE,
      body: Buffer.from('success'),
    });
    const [call] = updateCalls(ctx.gateway);
    expect(call).toMatchObject({ method: 'POST', query: { siteid: SITE } });
    expect(call?.form).toMatchObject({ siteid: SITE, ...fields, ommitPublishingTab: 'false' });
  });

  it('posts a non-image multipart body unchanged and relays the ajax answer', async () => {
    const answer = "{success:true,location:'http:\\/\\/localhost\\/brochure\\/'}";
    const req = updateRequest({ action: 'add', ajaxrequest: 'true' });
    let received: Buffer | undefined;
    const ctx = contextOf(
      req,
      {
        [POST_ROUTE]: (request) => {
          received = request.bytes;
          return { status: 200, headers: { 'Content-Type': HTML_TYPE }, body: answer };
        },
      },
      multipartBody(),
    );

    await expect(updateScreen.render(ctx, undefined)).resolves.toEqual({
      status: 200,
      contentType: HTML_TYPE,
      body: Buffer.from(answer),
    });
    expect(received?.toString('utf8')).toBe(MULTIPART);
    const [call] = updateCalls(ctx.gateway);
    expect(call).toMatchObject({ method: 'POST', query: { siteid: SITE } });
    expect(call?.headers?.['content-type']).toBe(`multipart/form-data; boundary=${BOUNDARY}`);
  });

  it('relays an error answer as received', async () => {
    const page = '<html><body>Error</body></html>';
    const ctx = contextOf(updateRequest({ action: 'add' }), {
      [GET_ROUTE]: { status: 500, headers: { 'Content-Type': HTML_TYPE }, body: page },
    });
    await expect(updateScreen.render(ctx, undefined)).resolves.toEqual({
      status: 500,
      contentType: HTML_TYPE,
      body: Buffer.from(page),
    });
  });

  it.each([401, 403])('answers a %i with the controller secure() redirect', async (status) => {
    const req = updateRequest({ action: 'add' });
    const denied = secure(req);
    const ctx = contextOf(req, { [GET_ROUTE]: { status } });
    await expect(updateScreen.render(ctx, undefined)).resolves.toEqual({
      status: 302,
      contentType: HTML_TYPE,
      body: '',
      headers: { ...REDIRECT_HEADERS, location: denied.kind === 'redirect' ? denied.location : 'none' },
    });
  });

  it('fails on a redirect without a Location', async () => {
    const ctx = contextOf(updateRequest({ action: 'add' }), { [GET_ROUTE]: { status: 302 } });
    await expect(updateScreen.render(ctx, undefined)).rejects.toThrow(/HTTP 302 but no Location/);
  });
});

describe('carch.update session effects', () => {
  it('applies the openSectionList and session.mura values the controller set, without relaying them', async () => {
    const before = { editBean: { contentID: NODE_ID }, multifileupload: false };
    const req = updateRequest({ action: 'add' }, before);
    const effects = JSON.stringify({
      openSectionList: ROOT_CONTENT_ID,
      mura: { editBean: null, multifileupload: true },
    });
    const redirect = { status: 302, headers: { Location: LIST_LOCATION, [EFFECTS]: effects } };
    const ctx = contextOf(req, { [GET_ROUTE]: redirect });

    const answer = await updateScreen.render(ctx, undefined);

    expect(answer.headers).toEqual({ ...REDIRECT_HEADERS, location: LIST_LOCATION });
    expect(ctx.req.session.openSectionList).toBe(ROOT_CONTENT_ID);
    expect(ctx.req.sessionWrites.openSectionList).toBe(ROOT_CONTENT_ID);
    expect(ctx.req.session.mura.multifileupload).toBe(true);
    expect(ctx.req.session.mura.editBean).toBeUndefined();
    expect(ctx.req.sessionWrites.muraValues).toEqual({ editBean: undefined, multifileupload: true });
  });

  it.each([
    ['not JSON', 'openSectionList=x', SyntaxError],
    ['an array', '[]', TypeError],
    ['a key the contract does not name', '{"moduleid":"x"}', TypeError],
    ['a list that is no string', '{"openSectionList":1}', TypeError],
    ['a mura that is no struct', '{"mura":[]}', TypeError],
  ])('fails on session effects that are %s', async (_label, header, error) => {
    const ctx = contextOf(updateRequest({ action: 'add' }), {
      [GET_ROUTE]: { status: 200, headers: { 'Content-Type': HTML_TYPE, [EFFECTS]: header }, body: 'success' },
    });
    await expect(updateScreen.render(ctx, undefined)).rejects.toThrow(error);
  });
});

/** Home as installed, as `getcontentVersion` loads it and the failed save left it: its values and `errors`. */
function homeBean(errors: Struct): Struct {
  return {
    contentID: ROOT_CONTENT_ID,
    contentHistID: HOME_HIST_ID,
    parentID: END_ID,
    siteID: SITE,
    moduleID: CONTENT_MODULE_ID,
    type: 'Page',
    subType: 'Default',
    isNew: 0,
    isLocked: 0,
    active: 1,
    approved: 1,
    approvalStatus: '',
    changesetID: '',
    title: '',
    menuTitle: 'Home',
    urlTitle: '',
    htmlTitle: '',
    filename: '',
    moduleAssign: '',
    body: '',
    summary: '',
    credits: '',
    metaDesc: '',
    metaKeywords: '',
    notes: '',
    tags: '',
    responseChart: 0,
    responseMessage: '',
    responseSendTo: '',
    responseDisplayFields: '',
    fileID: '',
    fileExt: '',
    majorVersion: 0,
    minorVersion: 0,
    lastUpdate: '2026-11-13T04:22:00.000',
    display: 1,
    displayStart: '',
    displayStop: '',
    displayInterval: 'Daily',
    displayIntervalValues: {
      type: 'Daily',
      every: 1,
      repeats: 1,
      allday: '1',
      end: 'never',
      endon: '',
      endafter: '1',
      daysofweek: '',
      detectconflicts: '0',
      detectspan: '12',
      timezone: 'Etc/UTC',
    },
    displayStartInTimezone: '',
    displayStopInTimezone: '',
    parent: { type: 'Page' },
    isFeature: 0,
    featureStart: '',
    featureStop: '',
    releaseDate: '',
    isNav: 1,
    target: '_self',
    searchExclude: 0,
    restricted: 0,
    restrictGroups: '',
    forceSSL: 0,
    doCache: 1,
    template: '',
    childTemplate: '',
    inheritObjects: 'Inherit',
    targetParams: '',
    nextN: 10,
    imageSize: 'small',
    imageWidth: 'AUTO',
    imageHeight: 'AUTO',
    displayList: 'Date,Title,Image,Summary,Credits',
    availableDisplayList: 'Date,Title,Image,Summary,Body,ReadMore,Credits,Comments,Tags,Rating',
    urlStem: '/',
    mobileExclude: 0,
    expires: '',
    remoteID: '',
    remoteURL: '',
    remotePubDate: '',
    remoteSource: '',
    remoteSourceURL: '',
    orderNo: 1,
    errors,
    stats: { lockID: '', lockType: '' },
    previewURL: `http://localhost:8080/?previewid=${HOME_HIST_ID}`,
  };
}

/** The `getContentEditModel` `rc` keys of the rejected Home save, as update.cfm leaves them. */
function rejectedModel(bean: Struct): Struct {
  return {
    contentBean: bean,
    parentBean: { type: 'Page' },
    crumbData: [
      { siteid: SITE, contentid: ROOT_CONTENT_ID, moduleid: CONTENT_MODULE_ID, type: 'Page', menutitle: 'Home' },
    ],
    perm: 'editor',
    site: {
      locking: 'none',
      dataCollection: 1,
      emailBroadcaster: 0,
      columnCount: 3,
      columnNames: 'Left Column^Main Content^Right Column',
      hasFeedManager: 1,
      webPath: 'http://localhost:8080',
      templateList: '',
      customTagGroups: '',
      assetPath: '/sites/default',
      customImageSizes: [],
      displayObjectLookup: [],
    },
    siteConfig: { customTagGroups: '' },
    rsTemplates: [{ name: 'default.cfm' }],
    useLayoutManager: true,
    templateArray: [],
    notifyCount: 0,
    rsUsage: [],
    categories: [],
    rsCategoryAssign: [],
    rsRelatedContent: [],
    categoryCount: 0,
    extendSets: [],
    hasLockableNodes: 0,
    purgeDrafts: 1,
    confirmSaveAsDraft: 1,
    showExtensionsInDefault: 0,
    enforceChangesets: 0,
    pageLimit: 50000,
    rsPageCount: [{ counter: 7 }],
    rsCount: 1,
    hasDrafts: 0,
    requiresApproval: 0,
    showApprovalStatus: 0,
    currentChangeset: { isNew: 1, name: '' },
    pendingChangesets: [],
    draftcheck: { showdialog: 'false', historyid: '' },
    hasSummary: 1,
    hasBody: 1,
    tabAssignments: '',
    subtypeFilter: '',
    rsSubTypes: [],
  };
}

describe('carch.update rejected save', () => {
  const ERRORS = { title: 'The Title is required.' };
  const HOME_RC = {
    action: 'add',
    contentid: ROOT_CONTENT_ID,
    contenthistid: 'D9000000-0000-0000-0000000000000009',
    parentid: END_ID,
    type: 'Page',
    topid: ROOT_CONTENT_ID,
    moduleid: CONTENT_MODULE_ID,
    ...CSRF_FIELDS,
  };

  it.each([
    ['in the full layout', '', 'false', { headers: { ...NO_CACHE_HEADERS } }],
    ['in the compact layout a compact-display save closes', 'true', 'true', {}],
  ])('re-renders the editor %s, keeping the bean as session.mura.editBean', async (_label, close, compact, extra) => {
    const bean = homeBean(ERRORS);
    const data = rejectedModel(bean);
    const ctx = contextOf(updateRequest({ ...HOME_RC, closeCompactDisplay: close }), {
      [POST_ROUTE]: unaborted(ERRORS, data),
    }, formBody({ siteid: SITE, ...HOME_RC, closeCompactDisplay: close }));

    const answer = await updateScreen.render(ctx, undefined);

    const { rc } = ctx.req;
    expect({ compactDisplay: rc.compactDisplay, contentHistID: rc.contentHistID, contentID: rc.contentID }).toEqual({
      compactDisplay: compact,
      contentHistID: HOME_HIST_ID,
      contentID: ROOT_CONTENT_ID,
    });
    expect(ctx.req.session.mura.editBean).toEqual(bean);
    expect(ctx.req.sessionWrites.muraValues).toEqual({ editBean: bean });
    // The same editor the edit view renders for the request the update left, inside the layout's document.
    const view = await renderEditView(makeScreenContext({ req: ctx.req, gateway: fakeGatewayClient() }), { rc: data });
    const { body, ...answered } = answer;
    expect(answered).toEqual({ contentType: HTML_TYPE, setCookies: [SERVICE_COOKIE], ...extra });
    if (typeof body !== 'string') throw new TypeError('the re-render is no document text');
    expect(body).toMatch(/^<!DOCTYPE html>/);
    expect(body).toContain(toString(view.body));
    expect(body).toContain('The Title is required.');
    expect(body).toContain(`name="contenthistid" value="${HOME_HIST_ID}"`);
  });

  it('fails when the rejected save carries no content bean', async () => {
    const ctx = contextOf(updateRequest({ ...HOME_RC }), { [GET_ROUTE]: unaborted(ERRORS, {}) });
    await expect(updateScreen.render(ctx, undefined)).rejects.toThrow(/contentBean is not a struct/);
  });

  it.each([
    ['a redirect', { saved: true, errors: {}, redirect: { circuit: 'cArch', action: 'list', params: [] }, data: {} }],
    ['no data', { saved: false, errors: {}, redirect: null }],
    ['errors that are no struct', { saved: false, errors: 'title', redirect: null, data: {} }],
  ])('fails on JSON with %s', async (_label, body) => {
    const ctx = contextOf(updateRequest({ action: 'add' }), {
      [GET_ROUTE]: { status: 200, headers: { 'Content-Type': JSON_TYPE }, body },
    });
    await expect(updateScreen.render(ctx, undefined)).rejects.toThrow(/not an unaborted save/);
  });
});

/** A content bean of the close data: active and on display unless `values` say otherwise. */
const closeBean = (url: string, values: Struct = {}): Struct => ({
  active: 1,
  isOnDisplay: 1,
  type: 'Page',
  contentID: NODE_ID,
  contentHistID: NODE_HIST_ID,
  url,
  previewURL: `${url}?previewid=${NODE_HIST_ID}`,
  ...values,
});

const SAVED_PAGE = { type: 'Page', contentID: NODE_ID, remoteURL: '', active: 1 };

describe('carch.update close document', () => {
  it.each<[string, Readonly<Record<string, string>>, Struct, string]>([
    [
      'an added page on display',
      { action: 'add' },
      { currentBean: { ...closeBean('/about/'), editedPreviewURL: `/about/?previewID=${NODE_HIST_ID}` } },
      '/about/',
    ],
    [
      'a previewed add',
      { action: 'add', preview: '1' },
      { currentBean: { ...closeBean('/about/'), editedPreviewURL: `/about/?previewID=${NODE_HIST_ID}` } },
      `/about/?previewID=${NODE_HIST_ID}`,
    ],
    [
      'a file added under another version of its parent',
      { action: 'add', type: 'File', parenthistid: PARENT_HIST_ID },
      {
        contentBean: { ...SAVED_PAGE, type: 'File' },
        parentBean: {
          ...closeBean('/'),
          parentHistPreviewURL: `/?previewid=${PARENT_HIST_ID}`,
          parentHistExists: true,
        },
      },
      `/?previewid=${PARENT_HIST_ID}`,
    ],
    [
      'a link added under its live parent',
      { action: 'add', type: 'Link' },
      { contentBean: { ...SAVED_PAGE, type: 'Link' }, parentBean: closeBean('/') },
      '/',
    ],
    [
      'a deleted version under a parent not on display',
      { action: 'delete' },
      { parentContentBean: closeBean('/news/', { isOnDisplay: 0 }) },
      `/news/?previewid=${NODE_HIST_ID}`,
    ],
    ['a save that returns home', { action: 'add', homeID: ROOT_CONTENT_ID }, { homeURL: '/' }, '/'],
    [
      'a variation',
      { action: 'add' },
      { contentBean: { ...SAVED_PAGE, type: 'Variation', remoteURL: 'http://remote.example/page' } },
      'http://remote.example/page',
    ],
  ])('answers %s with the close document', async (_label, rc, data, href) => {
    const req = updateRequest(
      { closeCompactDisplay: 'true', compactDisplay: 'true', ...rc },
      { editBean: { contentID: NODE_ID }, objectInstanceId: '' },
    );
    const saved = unaborted({}, { contentBean: SAVED_PAGE, useLayoutManager: 0, ...data });
    const ctx = contextOf(req, { [GET_ROUTE]: saved });

    const answer: RawBody = await updateScreen.render(ctx, undefined);

    const { body, ...answered } = answer;
    expect(answered).toEqual({ contentType: HTML_TYPE, setCookies: [SERVICE_COOKIE] });
    if (typeof body !== 'string') throw new TypeError('the close document is no text');
    expect(body).toMatch(/^\n<!DOCTYPE html PUBLIC/);
    expect(body).toContain(`var cmd={cmd:'setLocation',location:encodeURIComponent("${encodeJs(href)}")};`);
    expect(body).toContain(`location.href="${encodeJs(href)}";`);
    expect(ctx.req.session.mura.editBean).toBeUndefined();
    expect(ctx.req.sessionWrites.muraValues).toEqual({ editBean: undefined, objectInstanceId: '' });
  });

  it('asks the front end to reload the object instance before() recorded, then clears it', async () => {
    const req = updateRequest({ closeCompactDisplay: 'true', action: 'add', instanceid: 'INSTANCE-1' });
    const current = { ...closeBean('/about/'), editedPreviewURL: '/about/' };
    const ctx = contextOf(req, {
      [GET_ROUTE]: unaborted({}, { contentBean: SAVED_PAGE, useLayoutManager: 'true', currentBean: current }),
    });

    const body = String((await updateScreen.render(ctx, undefined)).body);

    expect(body).toContain("var cmd={cmd:'setObjectParams',reinit:true,instanceid:'INSTANCE-1',params:{}};");
    expect(ctx.req.session.mura.objectInstanceId).toBe('');
  });

  it.each([
    ['a home save without its URL', { action: 'add', homeID: ROOT_CONTENT_ID }, {}, /no homeURL/],
    ['an added page without its current bean', { action: 'add' }, {}, /model\.current is required/],
    ['a bean without its URL', { action: 'delete' }, { parentContentBean: { active: 1, isOnDisplay: 1 } }, /no type/],
    ['a layout manager flag that is no boolean', { action: 'delete' }, { useLayoutManager: 'maybe' }, /boolean/],
  ])('fails on %s', async (_label, rc, data, message) => {
    const ctx = contextOf(updateRequest({ closeCompactDisplay: 'true', ...rc }), {
      [GET_ROUTE]: unaborted({}, { contentBean: SAVED_PAGE, useLayoutManager: 0, ...data }),
    });
    await expect(updateScreen.render(ctx, undefined)).rejects.toThrow(message);
  });
});

describe('carch.update through the raw handler', () => {
  const ADMIN_STATE = routeKey('GET', 'identity', '/v1/sessions/current/admin-state');
  const SAVE_ADMIN_STATE = routeKey('POST', 'identity', '/v1/sessions/current/admin-state');
  const admin = SUBJECTS.admin;
  let fake: FakeGateway;
  let restoreClient: () => void;

  beforeEach(async () => {
    fake = await startFakeGateway({
      [routeKey('GET', 'identity', '/v1/sessions/current')]: {
        status: 200,
        body: {
          sessionId: admin.sid,
          epoch: 0,
          user: {
            isLoggedIn: true,
            userID: admin.sub,
            siteID: admin.site,
            memberships: 'S2IsPrivate;default,S2IsPrivate,S2',
            fname: 'Admin',
            lname: 'User',
          },
          roles: [...admin.roles],
          mfaPending: false,
          blockLoginUntil: null,
        },
      },
      [routeKey('GET', 'identity', '/v1/sessions/current/sites')]: {
        status: 200,
        body: { sites: [{ siteID: SITE, site: 'Default' }] },
      },
      [ADMIN_STATE]: { status: 200, body: { siteid: SITE, mura: { editBean: { contentID: NODE_ID } } } },
      [SAVE_ADMIN_STATE]: (request) => ({ status: 200, body: request.json ?? {} }),
      [routeKey('GET', 'programs-sites', `/v1/sites/${SITE}/shell`)]: {
        status: 200,
        body: { site: siteRecordFor(SITE), isNew: 0 },
      },
      [routeKey('GET', 'programs-sites', '/v1/href-domains')]: {
        status: 200,
        body: { allowedDomains: ['localhost'], siteDomain: 'localhost' },
      },
      [routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/header-prompts`)]: {
        status: 200,
        body: promptCountsZero,
      },
      [POST_ROUTE]: {
        status: 302,
        headers: {
          Location: LIST_LOCATION,
          [EFFECTS]: JSON.stringify({ openSectionList: ROOT_CONTENT_ID, mura: { editBean: null } }),
        },
      },
    });
    restoreEnv();
    restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: fake.url });
    restoreClient = setServiceClientForTests(undefined);
  });

  afterEach(async () => {
    restoreClient();
    await fake.close();
  });

  const savedStates = () =>
    fake.requests.filter((request) => `${request.method} ${request.path}` === SAVE_ADMIN_STATE);
  const updatePosts = () => fake.requests.filter((request) => request.path.endsWith(PATH));

  it('relays the save and persists the session values the service reports', async () => {
    const form = { siteid: SITE, action: 'add', contentid: '', parentid: ROOT_CONTENT_ID, ...CSRF_FIELDS };
    const request = await adminRequest('/admin-raw/carch/update', { user: 'admin', form });

    const response = await handleAdminRaw(request, { circuit: 'carch', action: 'update' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(LIST_LOCATION);
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.has(EFFECTS)).toBe(false);
    const [post] = updatePosts();
    expect(post?.form).toMatchObject(form);
    const saved = savedStates().map((state) => state.json as Struct);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ openSectionList: ROOT_CONTENT_ID });
    expect(saved[0]?.mura).not.toHaveProperty('editBean');
  });

  it('answers 404 for an approval, which stays on legacy, without calling the service', async () => {
    const form = { siteid: SITE, action: 'add', approved: '1', ...CSRF_FIELDS };
    const request = await adminRequest('/admin-raw/carch/update', { user: 'admin', form });

    const response = await handleAdminRaw(request, { circuit: 'carch', action: 'update' });

    expect(response.status).toBe(404);
    expect(updatePosts()).toEqual([]);
  });
});
