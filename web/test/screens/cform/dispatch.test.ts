// The real handlers and registry for the requests the gateway forwards by the inventoried response mode: Import Form as
// a post action, and the form-builder and object-params actions as bare bodies that no page handler serves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setServiceClientForTests } from '@/lib/gateway-client';
import { handleAdminAction, handleAdminPage, handleAdminRaw } from '@/lib/handlers';
import { siteRecordFor } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { routeKey, startFakeGateway, type FakeGateway, type FakeReply, type FakeRouteTable } from '../../helpers/fake-gateway';
import { adminRequest, type AdminRequestOptions } from '../../helpers/requests';
import { FIXED_CSRF, shellRoutes } from '../../helpers/screen-context';
import { SUBJECTS } from '../../helpers/tokens';

// The handlers' spans stay in-process: the SDK, and with it the OTLP exporter, is never started.
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  ensureTracing: vi.fn(() => Promise.resolve(undefined)),
  logRequest: vi.fn(),
}));

const SITE = 'default';
const FORMS_MODULE = '00000000000000000000000000000000004';
const SERVICE_PREFIX = '/opt2/svc/strategies-content/';
const IMPORT_ROUTE = routeKey('POST', 'strategies-content', `/v1/sites/${SITE}/forms/import`);
const LEGACY_LOCATION = `?muraAction=cArch.list&siteid=${SITE}&topid=${FORMS_MODULE}&moduleid=${FORMS_MODULE}&activeTab=0`;
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]);
const HTML_TYPE = 'text/html;charset=UTF-8';
const JSON_TYPE = 'application/json;charset=utf-8';
const FORM_ID = '9A1B2C3D-4E5F-4061-8293A4B5C6D7E8F9';
const CONTENT_ID = 'C0000000-0000-0000-0000000000000001';
const HIST_ID = 'H0000000-0000-0000-0000000000000001';
const CSRF_FIELDS = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };

/** identity's session state of the S2 admin and programs-sites' `default` rows, the shell's routes, then `routes`. */
function sessionRoutes(routes: FakeRouteTable): FakeRouteTable {
  const admin = SUBJECTS.admin;
  return shellRoutes({
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
    [routeKey('GET', 'identity', '/v1/sessions/current/sites')]: { status: 200, body: { sites: [{ siteID: SITE, site: 'Default' }] } },
    [routeKey('GET', 'identity', '/v1/sessions/current/admin-state')]: { status: 200, body: { siteid: SITE } },
    [routeKey('POST', 'identity', '/v1/sessions/current/admin-state')]: (request) => ({ status: 200, body: request.json ?? {} }),
    [routeKey('GET', 'programs-sites', `/v1/sites/${SITE}/shell`)]: { status: 200, body: { site: siteRecordFor(SITE), isNew: 0 } },
    [routeKey('GET', 'programs-sites', '/v1/href-domains')]: { status: 200, body: { allowedDomains: ['localhost'], siteDomain: 'localhost' } },
    ...routes,
  });
}

let fake: FakeGateway;
let restoreEnv: () => void;
let restoreClient: () => void;

// The loopback gateway web's relay calls; each test adds the routes it answers.
beforeEach(async () => {
  fake = await startFakeGateway();
  restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: fake.url });
  restoreClient = setServiceClientForTests(undefined);
});

afterEach(async () => {
  restoreClient();
  restoreEnv();
  await fake.close();
});

/** Answers the session, shell and `routes` calls on the loopback gateway. */
function serve(routes: FakeRouteTable = {}): void {
  for (const [key, route] of Object.entries(sessionRoutes(routes))) fake.setRoute(key, route);
}

/** strategies-content calls web made, without the shell's header prompts. */
const contentRequests = () =>
  fake.requests.filter((request) => request.path.startsWith(SERVICE_PREFIX) && !request.path.endsWith('/header-prompts'));

describe('cForm.importform through the post-action handler', () => {
  it('relays the native multipart form byte-for-byte to importForm once and answers its legacy location()', async () => {
    serve({
      [IMPORT_ROUTE]: {
        status: 200,
        body: {
          saved: true,
          errors: {},
          redirect: {
            circuit: 'cArch',
            action: 'list',
            params: [
              ['siteid', SITE],
              ['topid', FORMS_MODULE],
              ['moduleid', FORMS_MODULE],
              ['activeTab', '0'],
            ],
          },
        },
      },
    });
    const request = await adminRequest('/admin-actions/cform/importform?muraAction=cForm.importform', {
      user: 'admin',
      multipart: {
        ...CSRF_FIELDS,
        title: 'Imported Form',
        formzip: { name: 'export.zip', type: 'application/zip', data: ZIP_BYTES },
      },
    });
    expect(request.headers.get('x-opt2-original-url')).toBe('/admin/?muraAction=cForm.importform');
    const sent = Buffer.from(await request.clone().arrayBuffer());

    const response = await handleAdminAction(request, { circuit: 'cform', action: 'importform' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(LEGACY_LOCATION);
    const imports = contentRequests();
    expect(imports.map(({ method, path }) => `${method} ${path}`)).toEqual([IMPORT_ROUTE]);
    expect(imports[0]?.headers['content-type']).toBe(request.headers.get('content-type'));
    expect(imports[0]?.bytes.equals(sent)).toBe(true);
    expect(imports[0]?.bytes.includes(ZIP_BYTES)).toBe(true);
  });

  it('answers a GET with the Import Form inside the layout and imports nothing', async () => {
    serve();
    const request = await adminRequest('/admin-actions/cform/importform', { user: 'admin', query: { siteid: SITE } });

    const response = await handleAdminAction(request, { circuit: 'cform', action: 'importform' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(HTML_TYPE);
    const text = await response.text();
    expect(text).toContain('<html');
    expect(text).toContain('<form novalidate="novalidate" action="?muraAction=cForm.importform" method="post" enctype="multipart/form-data">');
    expect(contentRequests()).toEqual([]);
  });
});

const jsonReply = (body: string): FakeReply => ({ status: 200, headers: { 'content-type': JSON_TYPE }, body: Buffer.from(body) });

interface BareCase {
  readonly circuit: string;
  readonly action: string;
  readonly request: AdminRequestOptions;
  readonly routes: FakeRouteTable;
  readonly contentType: string;
  readonly body: string;
}

const FIELD_JSON = '{"fieldid":"F2","fieldtype":{"fieldtype":"textfield"},"formid":"F1"}';

// The strategies-content answers each screen relays, as their screen tests record them.
const BARE: readonly BareCase[] = [
  {
    circuit: 'cform',
    action: 'getdialog',
    request: { form: { dialog: 'message-delete-row' } },
    routes: {},
    contentType: HTML_TYPE,
    body: '<span>Delete Row?</span>',
  },
  {
    circuit: 'cform',
    action: 'getfieldtemplate',
    request: { form: { fieldType: 'field-nested', formid: FORM_ID } },
    routes: {
      [routeKey('POST', 'strategies-content', '/v1/raw/cform/getfieldtemplate')]: {
        status: 200,
        headers: { 'content-type': HTML_TYPE },
        body: '<span><select name="formid" id="tb-formid"></select></span>',
      },
    },
    contentType: HTML_TYPE,
    body: '<span><select name="formid" id="tb-formid"></select></span>',
  },
  {
    circuit: 'cform',
    action: 'getform',
    request: { query: { siteid: SITE, formID: FORM_ID } },
    routes: { [routeKey('POST', 'strategies-content', '/v1/raw/cform/getform')]: jsonReply(`{"formid":"${FORM_ID}"}`) },
    contentType: JSON_TYPE,
    body: `{"formid":"${FORM_ID}"}`,
  },
  {
    circuit: 'cform',
    action: 'getfield',
    request: { form: { fieldtype: 'field-textfield', formid: 'F1' } },
    routes: { [routeKey('POST', 'strategies-content', '/v1/raw/cform/getfield')]: jsonReply(FIELD_JSON) },
    contentType: JSON_TYPE,
    body: FIELD_JSON,
  },
  {
    circuit: 'cform',
    action: 'getfieldtype',
    request: { query: { siteid: SITE, fieldType: 'field-textfield' } },
    routes: { [routeKey('GET', 'strategies-content', '/v1/raw/cform/getfieldtype')]: jsonReply('{"fieldtype":"textfield"}') },
    contentType: JSON_TYPE,
    body: '{"fieldtype":"textfield"}',
  },
  {
    circuit: 'cform',
    action: 'getdataset',
    request: { form: { datasetID: '', fieldID: 'D1' } },
    routes: { [routeKey('POST', 'strategies-content', '/v1/raw/cform/getdataset')]: jsonReply('{"datasetid":"D2"}') },
    contentType: JSON_TYPE,
    body: '{"datasetid":"D2"}',
  },
  {
    circuit: 'carch',
    action: 'updateobjectparams',
    request: { form: { contenthistid: HIST_ID, siteid: SITE, approved: '0', preview: '0', ...CSRF_FIELDS } },
    routes: {
      [routeKey('POST', 'strategies-content', `/v1/sites/${SITE}/content/versions/${HIST_ID}/object-params`)]: {
        status: 200,
        body: { saved: true, errors: {}, redirect: null, data: { contentID: CONTENT_ID, contentHistID: HIST_ID } },
      },
    },
    contentType: HTML_TYPE,
    body: `{contentid:'${CONTENT_ID}',contenthistid:'${HIST_ID}'} `,
  },
];

describe.each(BARE)('$circuit.$action', ({ circuit, action, request, routes, contentType, body }) => {
  it('answers the raw handler with the bare legacy body and content type', async () => {
    serve(routes);

    const response = await handleAdminRaw(await adminRequest(`/admin-raw/${circuit}/${action}`, { user: 'admin', ...request }), {
      circuit,
      action,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(contentType);
    const text = await response.text();
    expect(text).toBe(body);
    expect(text).not.toContain('<html');
    expect(contentRequests()).toHaveLength(Object.keys(routes).length);
  });

  it('has no page screen, so the page handler answers 404 without a service call', async () => {
    serve(routes);
    const query = 'query' in request ? request.query : undefined;

    const response = await handleAdminPage(await adminRequest(`/admin/${circuit}/${action}`, { user: 'admin', query }), {
      circuit,
      action,
    });

    expect(response.status).toBe(404);
    expect(contentRequests()).toEqual([]);
  });
});
