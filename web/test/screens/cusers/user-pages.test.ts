// The cUsers list, search and advanced-search loaders and the Web Service Connected Account choices over people's
// page-only `items`: the rows shown, the iterator's page index and the download button stay those of the whole result.
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/people';
import { createCsrfRenderer } from '@/lib/csrf';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { loadAdvancedSearch, renderAdvancedSearch } from '@/screens/cusers/advancedsearch';
import { advancedSearchToCsvAction } from '@/screens/cusers/advancedsearchtocsv';
import { loadListUsers } from '@/screens/cusers/listusers';
import { loadSearch } from '@/screens/cusers/search';
import { renderEditView } from '@/screens/cwebservice/edit';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply, type RecordedRequest } from '../../helpers/fake-gateway';

type UserListRow = components['schemas']['UserListRow'];
type NextN = components['schemas']['NextN'];

const LIST_ROUTE = routeKey('GET', 'people', '/v2/users');
const SEARCH_ROUTE = routeKey('GET', 'people', '/v2/users/search');
const ADVANCED_ROUTE = routeKey('GET', 'people', '/v2/users/advanced-search');
const ADVANCED_STORE_ROUTE = routeKey('POST', 'people', '/v2/users/advanced-search');
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

/** A person row of people's list with the id `n` and last name `Person <n>`. */
function row(n: number): UserListRow {
  return { UserID: `AB000000-0000-0000-${String(n).padStart(16, '0')}`, Fname: 'Ann', Lname: `Person ${n}`, isPublic: 0, S2: 0 };
}

/** `utility.getNextN` of `total` rows by `perPage` from page start row `startrow`, under the contract's keys. */
function nextn(total: number, perPage: number, startrow: number): NextN {
  const pages = Math.ceil(total / perPage);
  const current = Math.ceil(startrow / perPage);
  const next = current * perPage + 1;
  return {
    totalrecords: total,
    recordsperpage: perPage,
    numberofpages: pages,
    currentpagenumber: current,
    firstpage: 1,
    lastpage: Math.min(pages, 7),
    next: next > total ? 1 : next,
    previous: Math.max(current - 1, 1) * perPage - perPage + 1,
    through: total < next ? total : next - 1,
    startrow,
  };
}

/** identity's CSRF pair for every requested context. */
function issueTokens(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  return { status: 200, body: { tokens: contexts.map((context) => ({ context, [CSRF_FIELD_TOKEN]: 'T', [CSRF_FIELD_EXPIRES]: 'E' })) } };
}

/** The handlers' ScreenContext for `req` over `gateway`. */
function contextFor(req: AdminRequest, gateway: FakeGatewayClient): ScreenContext {
  return { req, gateway, csrf: createCsrfRenderer(gateway), rb: rbFor('en_US'), hooks: { secondaryMenus: {} }, now: new Date('2026-06-30T12:00:00Z') };
}

/** An S2 admin's cUsers request for `item` with `rc`. */
const cusers = (item: string, rc: Readonly<Record<string, string>>): AdminRequest => adminS2Request({ circuit: 'cusers', item, rc });

describe('cUsers.listUsers over a page of people', () => {
  it('shows every row people answers for the page, at the page index the start row names', async () => {
    const gateway = fakeGatewayClient({
      [LIST_ROUTE]: { status: 200, body: { items: [row(2)], nextn: nextn(3, 1, 2), listUnassignedUsers: [row(2).UserID] } },
    });
    const data = await loadListUsers(contextFor(cusers('listusers', { siteid: 'default', ispublic: '0', startrow: '2', recordsperpage: '1' }), gateway));
    expect(data.rows.map((shown) => shown.userid)).toEqual([row(2).UserID]);
    expect(data.pageIndex).toBe(2);
    expect(data.listUnassignedUsers).toBe(row(2).UserID);
    expect(gateway.calls[0]?.query).toMatchObject({ startrow: '2', recordsperpage: '1' });
  });
});

describe('cUsers.search over a page of matches', () => {
  it.each<[string, Readonly<Record<string, string>>, UserListRow[], NextN, number]>([
    ['a middle page', { startrow: '2', recordsperpage: '1' }, [row(2)], nextn(3, 1, 2), 2],
    ['the empty page that starts at the last match', { startrow: '5', recordsperpage: '25' }, [], nextn(100, 25, 5), 5],
  ])('keeps the iterator page index of %s', async (_label, paging, items, pageNextN, pageIndex) => {
    const gateway = fakeGatewayClient({ [SEARCH_ROUTE]: { status: 200, body: { items, nextn: pageNextN, listUnassignedUsers: [] } } });
    const data = await loadSearch(contextFor(cusers('search', { siteid: 'default', ispublic: '0', search: 'person', ...paging }), gateway));
    expect(gateway.calls).toEqual([
      expect.objectContaining({ service: 'people', method: 'GET', path: '/v2/users/search', query: { siteid: 'default', ispublic: '0', search: 'person', ...paging } }),
    ]);
    expect(data.rows.map((shown) => shown.userid)).toEqual(items.map((item) => item.UserID));
    expect(data.pageIndex).toBe(pageIndex);
  });
});

describe('cUsers.advancedSearch over a page of matches', () => {
  it.each<[string, UserListRow[], NextN, boolean]>([
    ['a page of matches', [row(1)], nextn(1, 25, 1), true],
    ['the empty page past the last match', [], nextn(100, 25, 5), true],
    ['no match', [], nextn(0, 25, 1), false],
  ])('offers the CSV download for %s as the whole result decides', async (_label, items, pageNextN, download) => {
    const page = { items, nextn: pageNextN, listUnassignedUsers: [], criteria: { paramArray: [] }, groups: [] };
    const gateway = fakeGatewayClient({ [ADVANCED_ROUTE]: { status: 200, body: page }, [CSRF_ROUTE]: issueTokens });
    const ctx = contextFor(cusers('advancedsearch', { siteid: 'default', ispublic: '0', startrow: String(pageNextN.startrow) }), gateway);
    const view = await renderAdvancedSearch(ctx, await loadAdvancedSearch(ctx));
    const body = toString(view.body);
    expect(body.includes("muraAction.value='cUsers.advancedSearchToCSV'")).toBe(download);
    for (const item of items) expect(body).toContain(item.UserID);
  });
});

describe('cUsers.advancedSearchToCSV', () => {
  it("stores the request's criteria through people's page-only search, then redirects to the download", async () => {
    const page = { items: [], nextn: nextn(0, 25, 1), listUnassignedUsers: [], criteria: { paramArray: [] }, groups: [] };
    const gateway = fakeGatewayClient({ [ADVANCED_STORE_ROUTE]: { status: 200, body: page } });
    const rc = { siteid: 'default', ispublic: '0', param: '1', paramField1: 'tusers.lname^varchar', paramRelationship1: 'and', paramCriteria1: 'Doe', paramCondition1: 'Contains' };
    const result = await advancedSearchToCsvAction.submit(contextFor(cusers('advancedsearchtocsv', rc), gateway));
    expect(gateway.calls).toEqual([
      expect.objectContaining({ service: 'people', method: 'POST', path: '/v2/users/advanced-search', query: { siteid: 'default', ispublic: '0' } }),
    ]);
    expect(gateway.calls[0]?.form).toMatchObject({ param: '1', paramField1: 'tusers.lname^varchar', paramCriteria1: 'Doe' });
    expect(result).toMatchObject({ kind: 'redirect', action: 'cUsers.download', preserve: 'records' });
  });
});

describe('cwebservice.edit Connected Account choices', () => {
  it('collects every page of the system users, a page of 1000 per call', async () => {
    const people = Array.from({ length: 1500 }, (_, index) => row(index + 1));
    const answerPage = (request: RecordedRequest): FakeReply => {
      const page = Number(request.query.startrow);
      const perPage = Number(request.query.recordsperpage);
      const items = people.slice((page - 1) * perPage, page * perPage);
      return { status: 200, body: { items, nextn: nextn(people.length, perPage, page), listUnassignedUsers: [] } };
    };
    const gateway = fakeGatewayClient({ [LIST_ROUTE]: answerPage, [CSRF_ROUTE]: issueTokens });
    const req = adminS2Request({ circuit: 'cwebservice', item: 'edit', rc: { siteid: 'default' } });
    const state = {
      clientid: 'CC000000-0000-0000-0000000000000001',
      clientsecret: '',
      siteid: 'default',
      name: '',
      description: '',
      granttype: 'basic',
      userid: '',
      redirecturl: '',
      exists: false,
    };
    const body = toString((await renderEditView(contextFor(req, gateway), state)).body);
    const listCalls = gateway.calls.filter((call) => call.service === 'people');
    expect(listCalls.map((call) => call.query)).toEqual([
      { siteid: 'default', ispublic: '0', startrow: '1', recordsperpage: '1000' },
      { siteid: 'default', ispublic: '0', startrow: '2', recordsperpage: '1000' },
    ]);
    expect(people.every((person) => body.includes(person.UserID))).toBe(true);
  });
});
