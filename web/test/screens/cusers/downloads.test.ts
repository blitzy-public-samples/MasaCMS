// The users CSV export of cusers.cfc download(), downloadGroupMembers() and advancedSearchToCSV() with
// cusers/inc/dsp_download.cfm: the owner each source names, its CSV relayed byte for byte, and the preserved source.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayUnavailableError, isUnavailable, type GatewayResponse } from '@/lib/gateway-client';
import { advancedSearchToCsvAction } from '@/screens/cusers/advancedsearchtocsv';
import { downloadScreen } from '@/screens/cusers/download';
import { downloadGroupMembersAction } from '@/screens/cusers/downloadgroupmembers';
import { relayUsersCsv, type UsersCsvSource } from '@/screens/cusers/inc/dsp_download';
import type { RawBody, SubmitResult } from '@/screens/registry';
import {
  GROUP_MEMBERS_CSV_BODY,
  GROUP_MEMBERS_CSV_HEADERS,
  editorGroupMembersCsv,
} from '../../fixtures/identity/group-members-csv';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import { advancedSearchLastNameAnswer, advancedSearchLastNameCriteria } from '../../fixtures/people/search';
import {
  ADVANCED_SEARCH_CSV_BODY,
  PASSWORD_COLUMN_QUIRK_CSV_BODY,
  TENANT_A_USERS_CSV_BODY,
  USERS_CSV_HEADERS,
  advancedSearchCsv,
  passwordColumnQuirkCsv,
  tenantAUsersCsv,
} from '../../fixtures/people/users-csv';
import { adminS2Request, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeCall, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

type AdminRequest = ReturnType<typeof adminS2Request>;
type CsvHeaders = typeof USERS_CSV_HEADERS | typeof GROUP_MEMBERS_CSV_HEADERS;
type OwnerCall = Pick<FakeCall, 'service' | 'method' | 'path' | 'query'>;

const USERS_CSV_ROUTE = routeKey('GET', 'people', '/v1/users/download');
const SEARCH_CSV_ROUTE = routeKey('GET', 'people', '/v1/users/advanced-search.csv');
const MEMBERS_CSV_PATH = `/v1/groups/${GROUP_IDS.defaultEditor}/members.csv` as const;
const MEMBERS_CSV_ROUTE = routeKey('GET', 'identity', MEMBERS_CSV_PATH);
const SEARCH_STORE_PATH = '/v2/users/advanced-search';
const SEARCH_STORE_ROUTE = routeKey('POST', 'people', SEARCH_STORE_PATH);

const groupMembersSource: UsersCsvSource = { source: 'group-members', groupId: GROUP_IDS.defaultEditor };

/** The tenant-a site admin on `cUsers.<item>` with `rc`. */
const tenantAAdmin = (item: string, rc: Readonly<Record<string, string>>): AdminRequest =>
  siteAdminRequest('tenant-a', { circuit: 'cusers', item, rc });

/** The S2 admin on `cUsers.<item>` with `rc`. */
const s2Admin = (item: string, rc: Readonly<Record<string, string>>): AdminRequest =>
  adminS2Request({ circuit: 'cusers', item, rc });

const ownerCalls = (calls: readonly FakeCall[]): OwnerCall[] =>
  calls.map(({ service, method, path, query }) => ({ service, method, path, query }));

/** The relayed body as bytes; throws when web decoded it. */
function bytesOf(raw: RawBody): Buffer {
  if (!(raw.body instanceof Uint8Array)) throw new TypeError('Expected the relayed bytes');
  return Buffer.from(raw.body);
}

/** The users CSV source a redirect preserves as `rc.records` for `cUsers.download`. */
function preservedSource(result: SubmitResult): UsersCsvSource {
  const records = result.kind === 'redirect' ? result.rc?.['records'] : undefined;
  if (records === undefined) throw new TypeError(`Expected a redirect preserving rc.records, got ${result.kind}`);
  return JSON.parse(records) as UsersCsvSource;
}

/** A gateway answer of `status` with `headers` and the UTF-8 bytes of `body`. */
const serviceAnswer = (
  status: number,
  headers: Readonly<Record<string, string>>,
  body: string,
): GatewayResponse<Buffer> => ({
  status,
  ok: status >= 200 && status < 300,
  headers,
  body: Buffer.from(body, 'utf8'),
  setCookies: [],
});

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('downloadScreen', () => {
  interface DownloadCase {
    readonly label: string;
    readonly req: () => AdminRequest;
    readonly route: string;
    readonly reply: FakeReply;
    readonly headers: CsvHeaders;
    readonly body: string;
    readonly call: OwnerCall;
  }

  const usersCall = (unassigned: '0' | '1'): OwnerCall => ({
    service: 'people',
    method: 'GET',
    path: '/v1/users/download',
    query: { siteid: 'tenant-a', ispublic: '0', unassigned },
  });

  it.each<DownloadCase>([
    {
      label: "the site's users for unassigned=0",
      req: () => tenantAAdmin('download', { ispublic: '0', unassigned: '0' }),
      route: USERS_CSV_ROUTE,
      reply: tenantAUsersCsv,
      headers: USERS_CSV_HEADERS,
      body: TENANT_A_USERS_CSV_BODY,
      call: usersCall('0'),
    },
    {
      label: "the site's unassigned users for unassigned=1",
      req: () => tenantAAdmin('download', { ispublic: '0', unassigned: '1' }),
      route: USERS_CSV_ROUTE,
      reply: tenantAUsersCsv,
      headers: USERS_CSV_HEADERS,
      body: TENANT_A_USERS_CSV_BODY,
      call: usersCall('1'),
    },
    {
      label: "identity's members of a preserved group source",
      req: () => s2Admin('download', { records: JSON.stringify(groupMembersSource) }),
      route: MEMBERS_CSV_ROUTE,
      reply: editorGroupMembersCsv,
      headers: GROUP_MEMBERS_CSV_HEADERS,
      body: GROUP_MEMBERS_CSV_BODY,
      call: { service: 'identity', method: 'GET', path: MEMBERS_CSV_PATH, query: undefined },
    },
    {
      label: "people's result of a preserved advanced-search source",
      req: () =>
        tenantAAdmin('download', {
          records: JSON.stringify({ source: 'advanced-search', siteid: 'tenant-a', ispublic: 0 } satisfies UsersCsvSource),
        }),
      route: SEARCH_CSV_ROUTE,
      reply: advancedSearchCsv,
      headers: USERS_CSV_HEADERS,
      body: ADVANCED_SEARCH_CSV_BODY,
      call: {
        service: 'people',
        method: 'GET',
        path: '/v1/users/advanced-search.csv',
        query: { siteid: 'tenant-a', ispublic: '0' },
      },
    },
    {
      label: 'a CSV with the password column quirk',
      req: () => tenantAAdmin('download', { ispublic: '0' }),
      route: USERS_CSV_ROUTE,
      reply: passwordColumnQuirkCsv,
      headers: USERS_CSV_HEADERS,
      body: PASSWORD_COLUMN_QUIRK_CSV_BODY,
      call: usersCall('0'),
    },
  ])('relays $label unchanged', async ({ req, route, reply, headers, body, call }) => {
    const ctx = makeScreenContext({ req: req(), gateway: fakeGatewayClient({ [route]: reply }) });

    const raw = await downloadScreen.download(ctx, await downloadScreen.load!(ctx));

    expect(ownerCalls(ctx.gateway.calls)).toEqual([call]);
    expect(raw).toEqual({
      status: reply.status,
      contentType: headers['content-type'],
      headers: { 'content-disposition': headers['content-disposition'] },
      body: expect.any(Uint8Array),
    });
    expect(raw.contentType.split(';')[0]).toBe('text/csv');
    expect(raw.headers?.['content-disposition']).toBe('attachment;filename=users.csv');
    expect(bytesOf(raw).equals(Buffer.from(body, 'utf8'))).toBe(true);
  });

  it('rejects with the unavailability the handler answers as the legacy 503', async () => {
    const failure = new GatewayUnavailableError('people', 503);
    const ctx = makeScreenContext({
      req: tenantAAdmin('download', { ispublic: '0' }),
      gateway: fakeGatewayClient({ [USERS_CSV_ROUTE]: tenantAUsersCsv }),
    });
    ctx.gateway.failWith(failure);

    await expect(downloadScreen.load!(ctx)).rejects.toBe(failure);
    expect(isUnavailable(failure)).toBe(true);
  });
});

describe('relayUsersCsv', () => {
  it('keeps the status, content type, disposition and bytes of a 200 users CSV', () => {
    const response = serviceAnswer(200, USERS_CSV_HEADERS, TENANT_A_USERS_CSV_BODY);

    const raw = relayUsersCsv(response);

    expect(raw).toStrictEqual({
      status: 200,
      contentType: USERS_CSV_HEADERS['content-type'],
      body: response.body,
      headers: { 'content-disposition': USERS_CSV_HEADERS['content-disposition'] },
    });
    expect(raw.body).toBe(response.body);
  });

  it.each<[number, string, string]>([
    [400, 'application/json;charset=utf-8', '{"error":{"code":"invalidParameters","message":"siteid"}}'],
    [500, 'text/html;charset=UTF-8', '<html><body>Error</body></html>'],
  ])('passes a service %i through with its own content type and body', (status, contentType, body) => {
    const response = serviceAnswer(status, { 'content-type': contentType }, body);

    expect(relayUsersCsv(response)).toStrictEqual({ status, contentType, body: response.body });
  });
});

describe('downloadGroupMembersAction', () => {
  it("redirects to cUsers.download preserving the group's members source, with no service call", async () => {
    const ctx = makeScreenContext({
      req: s2Admin('downloadgroupmembers', { userid: GROUP_IDS.defaultEditor }),
      gateway: fakeGatewayClient(),
    });

    const result = await downloadGroupMembersAction.submit(ctx);

    expect(result).toStrictEqual({
      kind: 'redirect',
      action: 'cUsers.download',
      preserve: 'records',
      rc: { records: expect.any(String) },
    });
    expect(preservedSource(result)).toEqual(groupMembersSource);
    expect(ctx.gateway.calls).toEqual([]);
  });
});

describe('advancedSearchToCsvAction', () => {
  const { paramArray, inActive } = advancedSearchLastNameCriteria;
  const postedCriteria: Readonly<Record<string, string>> = {
    param: paramArray.map((_row, index) => String(index + 1)).join(','),
    inActive,
    ...Object.fromEntries(
      paramArray.flatMap(({ Field, Relationship, Criteria, Condition }, index) => [
        [`paramField${index + 1}`, Field],
        [`paramRelationship${index + 1}`, Relationship],
        [`paramCriteria${index + 1}`, Criteria],
        [`paramCondition${index + 1}`, Condition],
      ]),
    ),
  };
  const storeCall = {
    service: 'people',
    method: 'POST',
    path: SEARCH_STORE_PATH,
    query: { siteid: 'tenant-a', ispublic: '0' },
    form: {
      muraAction: 'core:cusers.advancedsearchtocsv',
      // The admin set-up's rc defaults for fields the form did not post.
      categoryID: '',
      groupID: '',
      membersOnly: 'false',
      visitorStatus: 'All',
      ...postedCriteria,
    },
  } satisfies FakeCall;

  it.each<[string, Readonly<Record<string, string>>, readonly FakeCall[]]>([
    ['stores posted criteria once', postedCriteria, [storeCall]],
    ['stores nothing without param', {}, []],
  ])('%s, then redirects to cUsers.download with the search source', async (_label, criteria, calls) => {
    const ctx = makeScreenContext({
      req: tenantAAdmin('advancedsearchtocsv', { siteid: 'tenant-a', ispublic: '0', ...criteria }),
      gateway: fakeGatewayClient({ [SEARCH_STORE_ROUTE]: { status: 200, body: advancedSearchLastNameAnswer } }),
    });

    const result = await advancedSearchToCsvAction.submit(ctx);

    expect(ctx.gateway.calls).toEqual(calls);
    expect(result).toStrictEqual({
      kind: 'redirect',
      action: 'cUsers.download',
      preserve: 'records',
      rc: { records: expect.any(String) },
    });
    expect(preservedSource(result)).toStrictEqual({ source: 'advanced-search', siteid: 'tenant-a', ispublic: '0' });
  });
});
