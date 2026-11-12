// carch strategies-content calls against carch.cfc, the carch views and the service contract: models, writes, relays.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secure } from '@/lib/access-gate';
import { GatewayUnavailableError, type MultipartBody, type ServicePath } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import {
  applySessionEffects,
  carchPageData,
  carchWrite,
  rawSubmitResult,
  relayCarchRaw,
  toSubmitResult,
  type CarchCallContext,
  type CarchPageAction,
  type CarchWriteAction,
  type CarchWriteResult,
} from '@/screens/carch/service';
import type { RawBody, Rc, SubmitResult } from '@/screens/registry';
import { adminS2Request, anonymousRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeRouteTable,
  type RecordedRequest,
} from '../../helpers/fake-gateway';

const SITE = 'default';
const HOME_ID = '00000000000000000000000000000000001';
const CONTENT_MODULE_ID = '00000000000000000000000000000000000';
const CONTENT_ID = 'C0000000-0000-0000-0000000000000001';
const HIST_ID = 'D0000000-0000-0000-0000000000000002';
const FILE_ID = 'F0000000-0000-0000-0000000000000003';
const USER_ID = 'E0000000-0000-0000-0000000000000004';
const RESPONSE_ID = 'A0000000-0000-0000-0000000000000005';
const HTML_TYPE = 'text/html;charset=UTF-8';
const REFERER = 'http://localhost/admin/?muraAction=cArch.list&siteid=default';
const CSRF = { 'X-csrf_token': 'T1', 'X-csrf_token_expires': '991231235959000' };
const SENT_CSRF = { 'x-csrf_token': 'T1', 'x-csrf_token_expires': '991231235959000' };
const MODEL = { rc: { contentBean: { contentid: CONTENT_ID, title: 'About Us' } } };
const WRITTEN: CarchWriteResult = { saved: true, errors: {}, redirect: null };
const SERVER_ERROR = { apiversion: 'v1', method: 'carch', error: { message: 'Unexpected', code: 'server_error' } };
// carch.update: fw.redirect(action="cArch.list",append="topid,siteid,startrow,moduleid",path="./").
const LIST_LOCATION =
  `./?muraAction=cArch.list&topid=${HOME_ID}&siteid=${SITE}&startrow=1&moduleid=${CONTENT_MODULE_ID}`;
const CSV = readFileSync(new URL('../../fixtures/strategies-content/downloaddata.csv', import.meta.url));
const DIFF = readFileSync(new URL('../../fixtures/strategies-content/loaddiff.html', import.meta.url));
const BOUNDARY = '----opt2carch7';
const MULTIPART_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
const MULTIPART = [
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="siteid"',
  '',
  SITE,
  `--${BOUNDARY}`,
  'Content-Disposition: form-data; name="newfile"; filename="brochure.pdf"',
  'Content-Type: application/pdf',
  '',
  '%PDF-1.4 synthetic',
  `--${BOUNDARY}--`,
  '',
].join('\r\n');

const sitePath = (rest: string): ServicePath => `/v1/sites/${SITE}${rest}`;
const svc = (method: 'GET' | 'POST', path: ServicePath): string => routeKey(method, 'strategies-content', path);

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

/** A carch call context for `req` (default: the S2 admin) over a gateway answering `routes`. */
function context(
  routes: FakeRouteTable,
  req: AdminRequest = adminS2Request({ circuit: 'carch', item: 'list' }),
): { gateway: FakeGatewayClient; ctx: CarchCallContext } {
  const gateway = fakeGatewayClient(routes);
  return { gateway, ctx: { req, gateway } };
}

/** The S2 admin on `carch.<item>` carrying `headers`. */
const adminWith = (item: string, headers: HeadersInit): AdminRequest =>
  adminS2Request({ circuit: 'carch', item, headers: new Headers(headers) });

type PageCase = [CarchPageAction, string, Rc, ServicePath, Readonly<Record<string, string>> | undefined];

// Operation, path and declared query of each page action, per the strategies-content contract.
const PAGE_CASES: PageCase[] = [
  [
    'list',
    'getSiteManagerTree',
    {
      siteid: SITE,
      topid: HOME_ID,
      moduleid: CONTENT_MODULE_ID,
      sortby: 'title',
      sortdirection: 'asc',
      page: '2',
      startrow: '1',
    },
    sitePath('/content/tree'),
    { topid: HOME_ID, moduleid: CONTENT_MODULE_ID, sortBy: 'title', sortDirection: 'asc', page: '2' },
  ],
  [
    'search',
    'listContent',
    { siteid: SITE, keywords: 'tenant news', type: 'Page', moduleid: CONTENT_MODULE_ID, page: '1', topid: HOME_ID },
    sitePath('/content'),
    { keywords: 'tenant news', type: 'Page', moduleid: CONTENT_MODULE_ID, page: '1' },
  ],
  ['draft', 'listDrafts', { siteid: SITE, moduleid: CONTENT_MODULE_ID }, sitePath('/content/drafts'), undefined],
  [
    'selectmedia',
    'getSelectMediaModel',
    { siteid: SITE, contentid: CONTENT_ID, fileid: '' },
    sitePath('/content/images'),
    { contentid: CONTENT_ID },
  ],
  [
    'edit',
    'getContentEditModel',
    {
      siteid: SITE,
      contentid: CONTENT_ID,
      contenthistid: HIST_ID,
      parentid: HOME_ID,
      type: 'Page',
      moduleid: CONTENT_MODULE_ID,
      compactDisplay: 'true',
      topid: HOME_ID,
    },
    sitePath(`/content/${CONTENT_ID}`),
    { contenthistid: HIST_ID, parentid: HOME_ID, type: 'Page', moduleid: CONTENT_MODULE_ID, compactDisplay: 'true' },
  ],
  [
    'editlive',
    'getContentEditModel',
    { siteid: SITE, contentid: CONTENT_ID, type: 'Form', title: 'Contact Us', instanceid: 'I1' },
    sitePath(`/content/${CONTENT_ID}`),
    { type: 'Form', title: 'Contact Us' },
  ],
  [
    'hist',
    'getContentHistory',
    { siteid: SITE, contentid: CONTENT_ID, startrow: '31' },
    sitePath(`/content/${CONTENT_ID}/history`),
    { startrow: '31' },
  ],
  [
    'audit',
    'getContentVersionAudit',
    { siteid: SITE, contentid: CONTENT_ID, contenthistid: HIST_ID },
    sitePath(`/content/${CONTENT_ID}/versions/${HIST_ID}/audit`),
    undefined,
  ],
  [
    'multifileupload',
    'getMultiFileUploadModel',
    { siteid: SITE, contentid: '', parentid: HOME_ID },
    sitePath(`/content/${HOME_ID}/multi-file-upload`),
    undefined,
  ],
  [
    'lockcheck',
    'getContentVersionModel',
    { siteid: SITE, contenthistid: HIST_ID },
    sitePath(`/content/versions/${HIST_ID}/summary`),
    undefined,
  ],
  [
    'relatedcontent',
    'getContentVersionModel',
    { siteid: SITE, contenthistid: HIST_ID, contentid: CONTENT_ID },
    sitePath(`/content/versions/${HIST_ID}/summary`),
    undefined,
  ],
  [
    'datamanager',
    'listFormResponses',
    {
      siteid: SITE,
      contentid: CONTENT_ID,
      startrow: '1',
      date1: '01/01/2026',
      date2: '',
      keywords: 'quinn',
      sortBy: 'entered',
    },
    sitePath(`/forms/${CONTENT_ID}/responses`),
    { startrow: '1', date1: '01/01/2026', date2: '', keywords: 'quinn' },
  ],
  [
    'imagedetails',
    'getImageDetailsModel',
    {
      siteID: SITE,
      fileID: FILE_ID,
      contentHistID: HIST_ID,
      userID: USER_ID,
      imagesize: 'medium',
      compactDisplay: 'false',
    },
    sitePath('/files/image-details'),
    { fileid: FILE_ID, contenthistid: HIST_ID, userid: USER_ID, imagesize: 'medium', compactDisplay: 'false' },
  ],
  [
    'selectfields',
    'getSelectFieldsModel',
    { siteid: SITE, displayList: 'Date,Title', instanceid: 'I1', feedid: '' },
    sitePath('/feeds/display-fields'),
    { siteid: SITE, displayList: 'Date,Title', instanceid: 'I1', feedid: '' },
  ],
  [
    'variationtargeting',
    'getVariationTargetingModel',
    { siteid: SITE, remoteid: 'remote-7', remoteurl: 'http://localhost/about/', title: 'About' },
    sitePath('/variation-targeting'),
    { remoteid: 'remote-7', siteid: SITE, remoteurl: 'http://localhost/about/', title: 'About' },
  ],
];

describe('carchPageData', () => {
  it.each(PAGE_CASES)('reads %s through %s', async (action, _operation, rc, path, query) => {
    const { gateway, ctx } = context({ [svc('GET', path)]: { status: 200, body: MODEL } });
    await expect(carchPageData(ctx, action, rc)).resolves.toEqual({ kind: 'ok', data: MODEL });
    expect(gateway.calls).toEqual([{ service: 'strategies-content', method: 'GET', path, query }]);
  });

  it.each(PAGE_CASES)('names %s as %s on an unexpected status', async (action, operation, rc, path) => {
    const { ctx } = context({ [svc('GET', path)]: { status: 500, body: SERVER_ERROR } });
    await expect(carchPageData(ctx, action, rc)).rejects.toEqual(new Error(`${operation} answered HTTP 500`));
  });

  it('reads the request rc by default, names matched case-insensitively', async () => {
    const req = adminS2Request({ circuit: 'carch', item: 'hist', rc: { ContentID: CONTENT_ID, startRow: '31' } });
    const path = sitePath(`/content/${CONTENT_ID}/history`);
    const { gateway, ctx } = context({ [svc('GET', path)]: { status: 200, body: MODEL } }, req);
    await expect(carchPageData(ctx, 'hist')).resolves.toEqual({ kind: 'ok', data: MODEL });
    expect(gateway.calls).toEqual([
      { service: 'strategies-content', method: 'GET', path, query: { startrow: '31' } },
    ]);
  });

  it.each([401, 403])('answers a %i with the secure() redirect back', async (status) => {
    const routes = { [svc('GET', sitePath('/content/drafts'))]: { status, body: SERVER_ERROR } };
    const { ctx } = context(routes, adminWith('draft', { referer: REFERER }));
    await expect(carchPageData(ctx, 'draft', { siteid: SITE })).resolves.toEqual({
      kind: 'redirect',
      location: REFERER,
    });
  });

  it('sends an anonymous denial to cLogin.main', async () => {
    const req = anonymousRequest({ circuit: 'carch', item: 'draft' });
    const { ctx } = context({ [svc('GET', sitePath('/content/drafts'))]: { status: 401, body: SERVER_ERROR } }, req);
    const outcome = await carchPageData(ctx, 'draft');
    expect(outcome).toEqual(secure(req));
    expect(outcome).toEqual({
      kind: 'redirect',
      location: expect.stringMatching(/^\.\/\?muraAction=cLogin\.main&returnURL=/),
    });
  });

  it.each<[number, CarchPageAction, Rc, ServicePath]>([
    [400, 'variationtargeting', { siteid: SITE, remoteid: '' }, sitePath('/variation-targeting')],
    [
      404,
      'audit',
      { siteid: SITE, contentid: CONTENT_ID, contenthistid: HIST_ID },
      sitePath(`/content/${CONTENT_ID}/versions/${HIST_ID}/audit`),
    ],
  ])('relays a %i on %s as rejected', async (status, action, rc, path) => {
    const body = { apiversion: 'v1', method: action, error: { message: 'Invalid request', code: 'invalid_request' } };
    const { ctx } = context({ [svc('GET', path)]: { status, body } });
    await expect(carchPageData(ctx, action, rc)).resolves.toEqual({ kind: 'rejected', status, body });
  });

  it('fails as CFML on an undefined remoteid', async () => {
    const { gateway, ctx } = context({});
    await expect(carchPageData(ctx, 'variationtargeting', { siteid: SITE })).rejects.toEqual(
      new TypeError('Element REMOTEID is undefined in a CFML structure.'),
    );
    expect(gateway.calls).toEqual([]);
  });
});

type WriteCase = [CarchWriteAction, string, Rc, ServicePath];

// Operation and path of each write action, per the strategies-content contract.
const WRITE_CASES: WriteCase[] = [
  [
    'updateobjectparams',
    'updateObjectParams',
    {
      siteid: SITE,
      contenthistid: HIST_ID,
      regionid: '2',
      object: 'feed',
      objectid: 'O1',
      params: '{"displaylist":"Title"}',
      approved: '1',
    },
    sitePath(`/content/versions/${HIST_ID}/object-params`),
  ],
  [
    'datamanager',
    'deleteFormResponses',
    { siteid: SITE, contentid: CONTENT_ID, responseid: RESPONSE_ID, action: 'Delete', moduleid: CONTENT_MODULE_ID },
    sitePath(`/forms/${CONTENT_ID}/responses/delete`),
  ],
  [
    'variationtargeting',
    'saveVariationTargeting',
    {
      siteid: SITE,
      remoteid: 'remote-7',
      remoteurl: 'http://localhost/about/',
      title: 'About',
      initjs: 'mura.init();',
      saveTargeting: 'true',
    },
    sitePath('/variation-targeting'),
  ],
];

describe('carchWrite', () => {
  it.each(WRITE_CASES)('posts %s as %s with every rc field and the csrf headers', async (action, _op, rc, path) => {
    const { gateway, ctx } = context({ [svc('POST', path)]: { status: 200, body: WRITTEN } }, adminWith(action, CSRF));
    await expect(carchWrite(ctx, action, { rc })).resolves.toEqual({ kind: 'ok', data: WRITTEN });
    expect(gateway.calls).toEqual([
      { service: 'strategies-content', method: 'POST', path, form: rc, headers: SENT_CSRF },
    ]);
  });

  it.each(WRITE_CASES)('names %s as %s on an unexpected status', async (action, operation, rc, path) => {
    const { ctx } = context({ [svc('POST', path)]: { status: 500, body: SERVER_ERROR } });
    await expect(carchWrite(ctx, action, { rc })).rejects.toEqual(new Error(`${operation} answered HTTP 500`));
  });

  it('posts the request rc by default, without csrf headers when none came in', async () => {
    const rc = { contentid: CONTENT_ID, responseid: RESPONSE_ID, action: 'Delete', csrf_token: 'T1' };
    const req = adminS2Request({ circuit: 'carch', item: 'datamanager', rc });
    const path = sitePath(`/forms/${CONTENT_ID}/responses/delete`);
    const { gateway, ctx } = context({ [svc('POST', path)]: { status: 200, body: WRITTEN } }, req);
    await carchWrite(ctx, 'datamanager');
    expect(gateway.calls).toEqual([{ service: 'strategies-content', method: 'POST', path, form: { ...req.rc } }]);
    expect(gateway.calls[0]?.form).toEqual(expect.objectContaining({ ...rc, siteid: SITE }));
  });

  it('answers a 403 with the secure() redirect', async () => {
    const path = sitePath(`/forms/${CONTENT_ID}/responses/delete`);
    const { ctx } = context({ [svc('POST', path)]: { status: 403, body: SERVER_ERROR } });
    const rc = { siteid: SITE, contentid: CONTENT_ID };
    await expect(carchWrite(ctx, 'datamanager', { rc })).resolves.toEqual({ kind: 'redirect', location: './' });
  });

  it.each<[string, (ctx: CarchCallContext) => Promise<unknown>]>([
    ['a page read', (ctx) => carchPageData(ctx, 'draft', { siteid: '' })],
    ['a write', (ctx) => carchWrite(ctx, 'variationtargeting', { rc: { siteid: '' } })],
  ])('refuses an empty siteid segment on %s', async (_name, run) => {
    const { gateway, ctx } = context({});
    const empty = new TypeError('rc.siteid is empty; the strategies-content path needs a value');
    await expect(run(ctx)).rejects.toEqual(empty);
    expect(gateway.calls).toEqual([]);
  });
});

describe('relayCarchRaw', () => {
  it('relays loadsitemanager JSON over GET with every rc field as url fields', async () => {
    const path = '/v1/raw/carch/loadsitemanager';
    const json = '{"html":"<div class=\\"mura-grid\\"></div>","perm":"editor"}';
    const type = 'application/json; charset=utf-8';
    // siteManager.loadSiteManager's fields (admin/assets/js/architecture.js 1460).
    const rc = {
      siteid: SITE,
      topid: HOME_ID,
      moduleid: CONTENT_MODULE_ID,
      sortby: '',
      sortdirection: '',
      ptype: 'Page',
      startrow: '1',
      cacheid: '0.42',
    };
    const reply = { status: 200, headers: { 'Content-Type': type }, body: json };
    const { gateway, ctx } = context({ [svc('GET', path)]: reply });
    await expect(relayCarchRaw(ctx, 'loadsitemanager', 'GET', { rc })).resolves.toEqual({
      status: 200,
      contentType: type,
      body: Buffer.from(json),
    });
    expect(gateway.calls).toEqual([{ service: 'strategies-content', method: 'GET', path, query: rc }]);
  });

  it('forwards the csrf headers on GET', async () => {
    const routes = { [svc('GET', '/v1/raw/carch/unlocknode')]: { status: 200, body: '' } };
    const { gateway, ctx } = context(routes, adminWith('unlocknode', CSRF));
    await relayCarchRaw(ctx, 'unlocknode', 'GET', { rc: { siteid: SITE, contentid: CONTENT_ID } });
    expect(gateway.calls[0]?.headers).toEqual(SENT_CSRF);
  });

  it('keeps the download headers and drops the base headers', async () => {
    const disposition = 'attachment;filename=Contact-Us_011526.csv';
    const headers = {
      'Content-Type': 'application/msexcel',
      'Content-Disposition': disposition,
      Expires: '0',
      Generator: 'Masa CMS 7.6.1',
    };
    const { ctx } = context({ [svc('GET', '/v1/raw/carch/downloaddata')]: { status: 200, headers, body: CSV } });
    const rc = { siteid: SITE, contentid: CONTENT_ID };
    await expect(relayCarchRaw(ctx, 'downloaddata', 'GET', { rc })).resolves.toEqual({
      status: 200,
      contentType: 'application/msexcel',
      body: CSV,
      headers: { 'content-disposition': disposition, expires: '0' },
    });
  });

  it('passes service cookies through in order', async () => {
    const setCookies = ['ADMINSIDEBAR=off; Path=/', 'ADMINCONTROLWIDTH=300; Path=/'];
    const reply = { status: 200, headers: { 'Content-Type': HTML_TYPE }, body: DIFF, setCookies };
    const { ctx } = context({ [svc('GET', '/v1/raw/carch/loaddiff')]: reply });
    await expect(relayCarchRaw(ctx, 'loaddiff', 'GET')).resolves.toEqual({
      status: 200,
      contentType: HTML_TYPE,
      body: DIFF,
      setCookies,
    });
  });

  it('labels an aborted POST as HTML, with siteid in the query and the rc fields as the form', async () => {
    const path = '/v1/raw/carch/savequickedit';
    const rc = { siteid: SITE, contentid: CONTENT_ID, attribute: 'isnav', isnav: '1' };
    const { gateway, ctx } = context({ [svc('POST', path)]: { status: 200 } });
    await expect(relayCarchRaw(ctx, 'savequickedit', 'POST', { rc })).resolves.toEqual({
      status: 200,
      contentType: HTML_TYPE,
      body: Buffer.alloc(0),
    });
    expect(gateway.calls).toEqual([
      { service: 'strategies-content', method: 'POST', path, query: { siteid: SITE }, form: rc },
    ]);
  });

  it.each<[string, () => MultipartBody['body']]>([
    ['Uint8Array', () => new TextEncoder().encode(MULTIPART)],
    ['ArrayBuffer', () => new TextEncoder().encode(MULTIPART).buffer],
    ['Blob', () => new Blob([MULTIPART])],
    ['ReadableStream', () => new Blob([MULTIPART]).stream()],
  ])('posts a %s multipart body unchanged', async (_name, body) => {
    let received: RecordedRequest | undefined;
    const route = (request: RecordedRequest) => {
      received = request;
      return { status: 302, headers: { Location: LIST_LOCATION } };
    };
    const { gateway, ctx } = context({ [svc('POST', '/v1/raw/carch/update')]: route }, adminWith('update', CSRF));
    const options = { rc: { siteID: SITE, action: 'add' }, multipart: { contentType: MULTIPART_TYPE, body: body() } };
    await expect(relayCarchRaw(ctx, 'update', 'POST', options)).resolves.toEqual({
      status: 302,
      contentType: HTML_TYPE,
      body: Buffer.alloc(0),
      headers: { location: LIST_LOCATION },
    });
    expect(received?.body).toBe(MULTIPART);
    expect(gateway.calls).toEqual([
      {
        service: 'strategies-content',
        method: 'POST',
        path: '/v1/raw/carch/update',
        query: { siteid: SITE },
        headers: { ...SENT_CSRF, 'content-type': MULTIPART_TYPE },
      },
    ]);
  });

  it.each([401, 403])('answers a %i with a 302 to the secure() target', async (status) => {
    const routes = { [svc('GET', '/v1/raw/carch/statusmodal')]: { status, body: SERVER_ERROR } };
    const { ctx } = context(routes, adminWith('statusmodal', { referer: REFERER }));
    await expect(relayCarchRaw(ctx, 'statusmodal', 'GET')).resolves.toEqual({
      status: 302,
      contentType: HTML_TYPE,
      body: '',
      headers: { location: REFERER },
    });
  });

  it.each<[string, (ctx: CarchCallContext) => Promise<unknown>]>([
    ['a page read', (ctx) => carchPageData(ctx, 'draft', { siteid: SITE })],
    ['a write', (ctx) => carchWrite(ctx, 'variationtargeting', { rc: { siteid: SITE } })],
    ['a raw relay', (ctx) => relayCarchRaw(ctx, 'loaddiff', 'GET')],
  ])('fails closed on %s when strategies-content is down', async (_name, run) => {
    const down = context({
      [svc('GET', sitePath('/content/drafts'))]: { status: 503, body: SERVER_ERROR },
      [svc('POST', sitePath('/variation-targeting'))]: { status: 503, body: SERVER_ERROR },
      [svc('GET', '/v1/raw/carch/loaddiff')]: { status: 503, headers: { 'Content-Type': HTML_TYPE }, body: '<html />' },
    });
    await expect(run(down.ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
    const refused = context({});
    refused.gateway.failWith();
    await expect(run(refused.ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('rawSubmitResult', () => {
  const redirect: RawBody = { status: 302, contentType: HTML_TYPE, body: '', headers: { location: LIST_LOCATION } };
  const bare: RawBody = { status: 302, contentType: HTML_TYPE, body: '' };
  const unnumbered: RawBody = { contentType: HTML_TYPE, body: '<p></p>', headers: { location: LIST_LOCATION } };
  it.each<[string, RawBody, SubmitResult]>([
    ['a 302 with a location', redirect, { kind: 'location', location: LIST_LOCATION }],
    ['a 302 without one', bare, { kind: 'raw', response: bare }],
    ['a 200 with a location', { ...redirect, status: 200 }, { kind: 'raw', response: { ...redirect, status: 200 } }],
    ['a body without a status', unnumbered, { kind: 'raw', response: unnumbered }],
  ])('emits %s', (_name, raw, expected) => {
    expect(rawSubmitResult(raw)).toEqual(expected);
  });
});

describe('toSubmitResult', () => {
  const rendered: SubmitResult = { kind: 'raw', response: { contentType: HTML_TYPE, body: '<div class="alert" />' } };

  it('follows a denial', async () => {
    const render = vi.fn(() => rendered);
    await expect(toSubmitResult({ kind: 'redirect', location: REFERER }, render)).resolves.toEqual({
      kind: 'location',
      location: REFERER,
    });
    expect(render).toHaveBeenCalledTimes(0);
  });

  it('renders a result that names no redirect', async () => {
    const errors = { title: 'The Title field is required.' };
    const result: CarchWriteResult = { saved: false, errors, redirect: null };
    const render = vi.fn(() => Promise.resolve(rendered));
    await expect(toSubmitResult({ kind: 'ok', data: result }, render)).resolves.toBe(rendered);
    expect(render.mock.calls).toEqual([[result]]);
  });

  it('emits a named redirect as a legacy admin URL', async () => {
    const result: CarchWriteResult = {
      saved: true,
      errors: {},
      redirect: {
        circuit: 'cArch',
        action: 'list',
        params: [['topid', HOME_ID], ['siteid', 'tenant a'], ['startrow', '1'], ['keywords', 'a&b']],
      },
    };
    await expect(toSubmitResult({ kind: 'ok', data: result }, () => rendered)).resolves.toEqual({
      kind: 'location',
      location: `/admin/?muraAction=cArch.list&topid=${HOME_ID}&siteid=tenant+a&startrow=1&keywords=a%26b`,
    });
  });

  it('throws on a rejection', async () => {
    await expect(toSubmitResult({ kind: 'rejected', status: 400, body: {} }, () => rendered)).rejects.toEqual(
      new Error('strategies-content rejected the carch write with HTTP 400'),
    );
  });
});

describe('applySessionEffects', () => {
  it('sets only changed values on the session and its writes', () => {
    const req = adminS2Request({ circuit: 'carch', item: 'search' });
    // carch.search: session.keywords=rc.keywords; the other values equal the session's own.
    const effects = { keywords: 'tenant news', openSectionList: '', alerts: { [SITE]: {} }, topID: undefined };
    applySessionEffects(req, effects);
    expect(req.session.keywords).toBe('tenant news');
    expect(req.session.topID).toBe(HOME_ID);
    expect(req.sessionWrites).toEqual({ keywords: 'tenant news' });
  });

  it('writes a changed struct whole', () => {
    const req = adminS2Request({ circuit: 'carch', item: 'update' });
    const alerts = { [SITE]: { a1: { type: 'info', text: 'Saved' } } };
    applySessionEffects(req, { alerts, openSectionList: HOME_ID });
    expect(req.session.alerts).toEqual(alerts);
    expect(req.sessionWrites).toEqual({ alerts, openSectionList: HOME_ID });
  });
});
