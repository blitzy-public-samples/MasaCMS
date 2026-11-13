// cUsers.download and cUsers.downloadGroupMembers against cusers.cfc download(), downloadGroupMembers() and
// setDownloadData(): the owner each preserved `rc.records` names, the relayed CSV, denials, and the raw handler's answer.
import { ADMIN_NOACCESS_ACTION } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError, setServiceClientForTests } from '@/lib/gateway-client';
import { handleAdminRaw } from '@/lib/handlers';
import { HTML_CONTENT_TYPE } from '@/lib/responses';
import type { AdminRequest } from '@/lib/request-context';
import { advancedSearchToCsvAction } from '@/screens/cusers/advancedsearchtocsv';
import { downloadScreen } from '@/screens/cusers/download';
import { downloadGroupMembersAction } from '@/screens/cusers/downloadgroupmembers';
import type { ScreenContext, SubmitResult } from '@/screens/registry';
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

// The raw handler's spans stay in-process: the SDK, and with it the OTLP exporter, is never started.
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  ensureTracing: vi.fn(() => Promise.resolve(undefined)),
  logRequest: vi.fn(),
}));

const GROUP_ID = 'C2000000-0000-0000-0000000000000007';
const DISPOSITION = 'attachment;filename=users.csv';
const CSV_TYPE = 'text/csv;charset=UTF-8';
// setDownloadData's shape: qualified header row, then each value with a trailing space, LF row ends.
const CSV = Buffer.from(
  '"USERID","FNAME","LNAME","EMAIL"\n"C1000000-0000-0000-0000000000000001","Zoë ","Ñúñez ","zoe@example.com "\n',
  'utf8',
);

const USERS_ROUTE = routeKey('GET', 'people', '/v1/users/download');
const SEARCH_CSV_ROUTE = routeKey('GET', 'people', '/v1/users/advanced-search.csv');
const MEMBERS_ROUTE = routeKey('GET', 'identity', `/v1/groups/${GROUP_ID}/members.csv`);
const SEARCH_STORE_ROUTE = routeKey('POST', 'people', '/v2/users/advanced-search');

const CSV_REPLY: FakeReply = {
  status: 200,
  headers: { 'Content-Type': CSV_TYPE, 'Content-Disposition': DISPOSITION },
  body: CSV,
  setCookies: ['CFTOKEN=0;Path=/;HttpOnly'],
};

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

/** The S2 admin's request for `cUsers.<item>` with `rc`. */
const cusers = (item: string, rc: Readonly<Record<string, string>>): AdminRequest =>
  adminS2Request({ circuit: 'cusers', item, rc });

/** `cUsers.download` with `rc`, over a gateway answering `routes`. */
function downloadContext(rc: Readonly<Record<string, string>>, routes: FakeRouteTable): ScreenContext & { gateway: FakeGatewayClient } {
  return makeScreenContext({ req: cusers('download', rc), gateway: fakeGatewayClient(routes) });
}

/** The owner calls of `gateway`, without the shell's. */
const ownerCalls = (gateway: FakeGatewayClient) =>
  gateway.calls.map(({ service, method, path, query }) => ({ service, method, path, ...(query === undefined ? {} : { query }) }));

/** The `rc.records` a redirect-mode outcome preserves for `cUsers.download`. */
function preservedRecords(result: SubmitResult): string {
  if (result.kind !== 'redirect') throw new TypeError(`Expected a redirect, got ${result.kind}`);
  expect(result).toMatchObject({ action: 'cUsers.download', preserve: 'records' });
  const records = result.rc?.['records'];
  if (records === undefined) throw new TypeError('The redirect preserves no rc.records');
  return records;
}

/** Bytes of a relayed body. */
function bytesOf(body: unknown): Buffer {
  if (!(body instanceof Uint8Array)) throw new TypeError('Expected the relayed bytes');
  return Buffer.from(body);
}

describe('cUsers.download owner calls', () => {
  it.each<[string, Readonly<Record<string, string>>, string, ReturnType<typeof ownerCalls>[number]]>([
    [
      "the site's users",
      { siteid: 'default', ispublic: '0' },
      USERS_ROUTE,
      { service: 'people', method: 'GET', path: '/v1/users/download', query: { siteid: 'default', ispublic: '0', unassigned: '0' } },
    ],
    [
      "the site's unassigned users",
      { siteid: 'default', ispublic: '1', unassigned: 'true' },
      USERS_ROUTE,
      { service: 'people', method: 'GET', path: '/v1/users/download', query: { siteid: 'default', ispublic: '1', unassigned: '1' } },
    ],
    [
      'the members a preserved group source names',
      { siteid: 'default', records: JSON.stringify({ source: 'group-members', groupId: GROUP_ID }) },
      MEMBERS_ROUTE,
      { service: 'identity', method: 'GET', path: `/v1/groups/${GROUP_ID}/members.csv` },
    ],
    [
      "a preserved search, under the storing action's site and pool",
      { siteid: 'default', ispublic: '1', records: JSON.stringify({ source: 'advanced-search', siteid: 'tenant-a', ispublic: 0 }) },
      SEARCH_CSV_ROUTE,
      { service: 'people', method: 'GET', path: '/v1/users/advanced-search.csv', query: { siteid: 'tenant-a', ispublic: '0' } },
    ],
  ])('reads %s and relays the CSV unchanged', async (_label, rc, route, call) => {
    const ctx = downloadContext(rc, { [route]: CSV_REPLY });

    const raw = await downloadScreen.download(ctx, await downloadScreen.load!(ctx));

    expect(ownerCalls(ctx.gateway)).toEqual([call]);
    expect(raw).toEqual({
      status: 200,
      contentType: CSV_TYPE,
      body: CSV,
      headers: { 'content-disposition': DISPOSITION },
      setCookies: ['CFTOKEN=0;Path=/;HttpOnly'],
    });
    expect(Buffer.compare(bytesOf(raw.body), CSV)).toBe(0);
  });

  it.each<[number, string]>([
    [404, ''],
    [500, 'The server encountered an error'],
  ])('relays a service %i with its body, as only a denial is not relayed', async (status, text) => {
    const ctx = downloadContext({ siteid: 'default' }, { [USERS_ROUTE]: { status, body: text } });

    const raw = await downloadScreen.download(ctx, await downloadScreen.load!(ctx));

    expect(raw).toEqual({ status, contentType: HTML_CONTENT_TYPE, body: Buffer.from(text) });
  });
});

describe('cUsers.download preserved sources', () => {
  it("round-trips cUsers.downloadGroupMembers's flash context to identity's members CSV of rc.userid", async () => {
    const submitted = await downloadGroupMembersAction.submit(
      makeScreenContext({ req: cusers('downloadgroupmembers', { siteid: 'default', userid: GROUP_ID }) }),
    );
    const records = preservedRecords(submitted);
    expect(JSON.parse(records)).toEqual({ source: 'group-members', groupId: GROUP_ID });

    const ctx = downloadContext({ siteid: 'default', records }, { [MEMBERS_ROUTE]: CSV_REPLY });
    const raw = await downloadScreen.download(ctx, await downloadScreen.load!(ctx));

    expect(ownerCalls(ctx.gateway)).toEqual([{ service: 'identity', method: 'GET', path: `/v1/groups/${GROUP_ID}/members.csv` }]);
    expect(Buffer.compare(bytesOf(raw.body), CSV)).toBe(0);
  });

  it("round-trips cUsers.advancedSearchToCSV's flash context to people's CSV of the stored search", async () => {
    const nextn = {
      totalrecords: 0,
      recordsperpage: 25,
      numberofpages: 0,
      currentpagenumber: 1,
      firstpage: 1,
      lastpage: 0,
      next: 1,
      previous: 1,
      through: 0,
      startrow: 1,
    };
    const page = { items: [], nextn, listUnassignedUsers: [], criteria: { paramArray: [] }, groups: [] };
    const criteria = {
      param: '1',
      paramField1: 'tusers.lname^varchar',
      paramRelationship1: 'and',
      paramCriteria1: 'Doe',
      paramCondition1: 'Contains',
    };
    const storeCtx = makeScreenContext({
      req: cusers('advancedsearchtocsv', { siteid: 'tenant-b', ispublic: '0', ...criteria }),
      gateway: fakeGatewayClient({ [SEARCH_STORE_ROUTE]: { status: 200, body: page } }),
    });
    const records = preservedRecords(await advancedSearchToCsvAction.submit(storeCtx));

    const ctx = downloadContext({ siteid: 'default', ispublic: '1', records }, { [SEARCH_CSV_ROUTE]: CSV_REPLY });
    await downloadScreen.load!(ctx);

    expect(ownerCalls(ctx.gateway)).toEqual([
      { service: 'people', method: 'GET', path: '/v1/users/advanced-search.csv', query: { siteid: 'tenant-b', ispublic: '0' } },
    ]);
  });

  it.each<[string, string, new (...args: never[]) => Error]>([
    ['text that is not JSON', 'query rows', SyntaxError],
    ['JSON null', 'null', TypeError],
    ['a JSON array', '[]', TypeError],
    ['an unknown source', JSON.stringify({ source: 'site-members', siteid: 'default' }), TypeError],
  ])('fails on rc.records holding %s without calling a service', async (_label, records, type) => {
    const ctx = downloadContext({ siteid: 'default', records }, {});

    await expect(downloadScreen.load!(ctx)).rejects.toBeInstanceOf(type);
    expect(ctx.gateway.calls).toEqual([]);
  });
});

describe('cUsers.download owner failures', () => {
  const sources: Array<[string, Readonly<Record<string, string>>, string, string, string]> = [
    ['users', { siteid: 'default' }, USERS_ROUTE, 'people', 'downloadUsersCsv'],
    [
      'group members',
      { siteid: 'default', records: JSON.stringify({ source: 'group-members', groupId: GROUP_ID }) },
      MEMBERS_ROUTE,
      'identity',
      'downloadGroupMembers',
    ],
    [
      'advanced search',
      { siteid: 'default', records: JSON.stringify({ source: 'advanced-search', siteid: 'default', ispublic: '1' }) },
      SEARCH_CSV_ROUTE,
      'people',
      'downloadAdvancedSearchCsv',
    ],
  ];

  const denials = sources.flatMap(([label, rc, route, service, operation]) =>
    ([401, 403] as const).map((status) => [label, status, rc, route, service, operation] as const),
  );

  it.each(denials)(
    'reports a %s %i as a denial of its operation',
    async (_label, status, rc, route, service, operation) => {
      const ctx = downloadContext(rc, { [route]: { status, body: { error: { code: 'forbidden', message: 'Denied' } } } });

      const loaded = downloadScreen.load!(ctx);

      await expect(loaded).rejects.toBeInstanceOf(GatewayDenialError);
      await expect(loaded).rejects.toMatchObject({ service, operation, status });
    },
  );

  it.each(sources.map(([label, rc, route, service]) => [label, rc, route, service] as const))(
    'reports %s as unavailable when the gateway answers 503 or cannot be reached',
    async (_label, rc, route, service) => {
      const answered = downloadContext(rc, { [route]: { status: 503, body: '' } });
      await expect(downloadScreen.load!(answered)).rejects.toMatchObject({ name: 'GatewayUnavailableError', service, status: 503 });

      const refused = downloadContext(rc, { [route]: CSV_REPLY });
      refused.gateway.failWith();
      const loaded = downloadScreen.load!(refused);
      await expect(loaded).rejects.toBeInstanceOf(GatewayUnavailableError);
      await expect(loaded).rejects.toMatchObject({ service, status: undefined });
    },
  );
});

describe('cUsers.download through the raw handler', () => {
  const admin = SUBJECTS.admin;
  let fake: FakeGateway;
  let restoreClient: () => void;

  /** identity's session state of the S2 admin and programs-sites' `default` rows, then `routes`. */
  const sessionRoutes = (routes: FakeRouteTable): FakeRouteTable => ({
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
    [routeKey('GET', 'identity', '/v1/sessions/current/sites')]: { status: 200, body: { sites: [{ siteID: 'default', site: 'Default' }] } },
    [routeKey('GET', 'identity', '/v1/sessions/current/admin-state')]: { status: 200, body: { siteid: 'default' } },
    [routeKey('POST', 'identity', '/v1/sessions/current/admin-state')]: (request) => ({ status: 200, body: request.json ?? {} }),
    [routeKey('GET', 'programs-sites', '/v1/sites/default/shell')]: { status: 200, body: { site: siteRecordFor('default'), isNew: 0 } },
    [routeKey('GET', 'programs-sites', '/v1/href-domains')]: { status: 200, body: { allowedDomains: ['localhost'], siteDomain: 'localhost' } },
    ...routes,
  });

  /** Starts the loopback gateway on `routes` and points web's relay at it. */
  async function serve(routes: FakeRouteTable): Promise<void> {
    fake = await startFakeGateway(sessionRoutes(routes));
    restoreEnv();
    restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: fake.url });
    restoreClient = setServiceClientForTests(undefined);
  }

  afterEach(async () => {
    restoreClient();
    await fake.close();
  });

  const peopleRequests = () => fake.requests.filter((request) => request.path.startsWith('/opt2/svc/people/'));

  it('streams the bytes with the content type and disposition people answered', async () => {
    await serve({ [USERS_ROUTE]: CSV_REPLY });
    const request = await adminRequest('/admin-raw/cusers/download', { user: 'admin', query: { siteid: 'default', ispublic: '0', unassigned: '1' } });

    const response = await handleAdminRaw(request, { circuit: 'cusers', action: 'download' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(CSV_TYPE);
    expect(response.headers.get('content-disposition')).toBe(DISPOSITION);
    expect(response.headers.getSetCookie()).toContain('CFTOKEN=0;Path=/;HttpOnly');
    expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), CSV)).toBe(0);
    expect(peopleRequests().map(({ method, path, query }) => ({ method, path, query }))).toEqual([
      { method: 'GET', path: '/opt2/svc/people/v1/users/download', query: { siteid: 'default', ispublic: '0', unassigned: '1' } },
    ]);
  });

  it("answers people's refusal with the access gate's no-access redirect and no CSV", async () => {
    await serve({ [USERS_ROUTE]: { status: 403, body: { error: { code: 'forbidden', message: 'Denied' } } } });
    const request = await adminRequest('/admin-raw/cusers/download', { user: 'admin', query: { siteid: 'default' } });

    const response = await handleAdminRaw(request, { circuit: 'cusers', action: 'download' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain(`?muraAction=${ADMIN_NOACCESS_ACTION}`);
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(await response.text()).toBe('');
    expect(peopleRequests()).toHaveLength(1);
  });
});
