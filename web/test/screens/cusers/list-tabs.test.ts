// cUsers.list and cUsers.listUsers tabs, and the listUsers filter, as the views' `eq 1` / `eq 0` read them on ACF 2023.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/people';
import { createCsrfRenderer } from '@/lib/csrf';
import { resetLegacySettingsForTests } from '@/lib/env';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { normaliseCusersRc } from '@/screens/cusers/gate';
import { getNextN } from '@/screens/cusers/inc/dsp_nextn';
import { loadGroupList, renderGroupList } from '@/screens/cusers/list';
import { loadListUsers, renderListUsersBody } from '@/screens/cusers/listusers';
import { loadSearch } from '@/screens/cusers/search';
import type { ScreenContext } from '@/screens/registry';
import { siteAdminRequest } from '../../helpers/admin-request';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeRouteTable } from '../../helpers/fake-gateway';

const SITE = 'tenant-a';
const VIEW_ALL = 'View All';
const UNASSIGNED_ONLY = 'View Unassigned Only';
const LIST_USERS_PATH = '/v2/users';

/** People's `listUsersV2` page with no rows, so the list fetches no CSRF tokens. */
const NO_USERS = Object.freeze({
  items: [],
  nextn: {
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
  },
  listUnassignedUsers: [],
} satisfies components['schemas']['UserListPageV2']);

/** `[ispublic, active tab]`: 1 the member tab, 0 the system tab, null neither. */
type TabCase = readonly [string, 1 | 0 | null];

const NUMERIC_TEXT: readonly TabCase[] = [
  ['1', 1],
  ['1.0', 1],
  ['1e0', 1],
  ['+1', 1],
  [' 1', 1],
  ['x', 1],
  ['0', 0],
  ['0.0', 0],
  ['.0', 0],
  ['-0', 0],
  ['1.', null],
  ['0.', null],
  ['2', null],
  ['-1', null],
];

// Legacy `cUsers.list` rejects boolean words before its view runs (HTTP 500), so only listUsers renders them.
const BOOLEAN_WORDS: readonly TabCase[] = [
  ['yes', 1],
  ['true', 1],
  ['TRUE', 1],
  ['no', 0],
  ['false', 0],
  ['No', 0],
];

/** A page context whose gateway records the calls it receives. */
type RecordingContext = ScreenContext & { readonly gateway: FakeGatewayClient };

/** The page context of `req`, with people answering `listUsersV2` with {@link NO_USERS}, and `routes`. */
function contextFor(req: AdminRequest, routes: FakeRouteTable = {}): RecordingContext {
  const gateway = fakeGatewayClient({ [routeKey('GET', 'people', LIST_USERS_PATH)]: { status: 200, body: NO_USERS }, ...routes });
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

const request = (item: string, rc: Readonly<Record<string, string>>): AdminRequest =>
  siteAdminRequest(SITE, { circuit: 'cusers', item, rc });

/** `[path, query]` of every people call `ctx` made. */
const peopleCalls = (ctx: RecordingContext): unknown[] =>
  ctx.gateway.calls.filter((call) => call.service === 'people').map((call) => [call.path, call.query]);

/** The `listUsersV2` query of a first page of 25 member users of {@link SITE}, with `fields` replaced. */
const listUsersQuery = (fields: Readonly<Record<string, string>>): Record<string, string> => ({
  siteid: SITE,
  ispublic: '1',
  unassigned: '0',
  startrow: '1',
  recordsperpage: '25',
  ...fields,
});

/** The `cUsers.list` view of a site admin for `rc`, with no groups. */
async function groupList(rc: Readonly<Record<string, string>>): Promise<cheerio.CheerioAPI> {
  const req = request('list', rc);
  const data = { rc: normaliseCusersRc(req), rows: [], nextn: getNextN(0, 25, 1), pageIndex: 1 };
  const view = await renderGroupList(contextFor(req), data);
  return cheerio.load(toString(view.body), null, false);
}

/** The `cUsers.listUsers` view of a site admin for `rc`, with no users. */
async function userList(rc: Readonly<Record<string, string>>): Promise<cheerio.CheerioAPI> {
  const ctx = contextFor(request('listusers', rc));
  return cheerio.load(toString(await renderListUsersBody(ctx, await loadListUsers(ctx))), null, false);
}

/** The `ispublic` of every tab link, and of the active ones. */
function tabsOf($: cheerio.CheerioAPI): { tabs: string[]; active: string[] } {
  const items = $('ul#viewTabs > li').toArray();
  const flag = (li: (typeof items)[number]): string =>
    /[?&]ispublic=(\d)/.exec($(li).find('a').attr('href') ?? '')?.[1] ?? '';
  return { tabs: items.map(flag), active: items.filter((li) => $(li).attr('class') === 'active').map(flag) };
}

const expectedTabs = (active: TabCase[1]): { tabs: string[]; active: string[] } => ({
  tabs: ['1', '0'],
  active: active === null ? [] : [String(active)],
});

beforeEach(() => {
  vi.stubEnv('MURA_CONTEXT', undefined);
  vi.stubEnv('MURA_ADMINDIR', undefined);
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('renderGroupList tabs', () => {
  it.each(NUMERIC_TEXT)('ispublic=%j: active tab %j', async (ispublic, active) => {
    expect(tabsOf(await groupList({ siteid: SITE, ispublic }))).toEqual(expectedTabs(active));
  });
});

describe('boolean-word ispublic on cUsers.list and cUsers.search', () => {
  const LOADS = { list: loadGroupList, search: loadSearch };

  // People answers the getUserGroups or getSearch argument error as the legacy 500; the failed page then fails closed.
  it.each(
    BOOLEAN_WORDS.flatMap(([ispublic]) => [
      ['list', ispublic, '/v1/users/groups', 'listUserGroups', {}] as const,
      ['search', ispublic, '/v2/users/search', 'searchUsersV2', { search: 'doe' }] as const,
    ]),
  )('cUsers.%s relays ispublic %j to %s unchanged and rejects its 500 as %s', async (item, ispublic, path, operation, terms) => {
    const server500 = { status: 500, body: { error: { message: 'Unhandled Exception', code: 'server_error' } } };
    const ctx = contextFor(request(item, { siteid: SITE, ispublic, search: 'doe' }), {
      [routeKey('GET', 'people', path)]: server500,
    });
    await expect(LOADS[item](ctx)).rejects.toThrow(`${operation} answered HTTP 500`);
    expect(peopleCalls(ctx)).toEqual([[path, { siteid: SITE, ispublic, ...terms, startrow: '1', recordsperpage: '25' }]]);
  });
});

describe('renderListUsersBody tabs', () => {
  it.each([...NUMERIC_TEXT, ...BOOLEAN_WORDS])('ispublic=%j: active tab %j', async (ispublic, active) => {
    expect(tabsOf(await userList({ siteid: SITE, ispublic }))).toEqual(expectedTabs(active));
  });
});

describe('listUsers unassigned filter', () => {
  it.each<[string, string, string, boolean, string]>([
    ['1', '1', VIEW_ALL, true, '0'],
    ['1.0', '1.0', VIEW_ALL, true, '0'],
    ['yes', 'yes', VIEW_ALL, true, '0'],
    ['1.', '1.', VIEW_ALL, false, '0'],
    ['2', '2', VIEW_ALL, false, '0'],
    ['0.', '0.', VIEW_ALL, false, '1'],
    ['0', '0', UNASSIGNED_ONLY, false, '1'],
    ['0.0', '0.0', UNASSIGNED_ONLY, false, '1'],
    ['no', 'no', UNASSIGNED_ONLY, false, '1'],
    [' 0', '0', UNASSIGNED_ONLY, false, '1'],
    ['x', '0', UNASSIGNED_ONLY, false, '1'],
  ])('unassigned=%j: sent as %j, label %j, empty-list argument %j, toggle to %j', async (unassigned, sent, label, named, toggle) => {
    const rc = { siteid: SITE, ispublic: '1', unassigned };
    const ctx = contextFor(request('listusers', rc));
    const data = await loadListUsers(ctx);
    expect(peopleCalls(ctx)).toEqual([[LIST_USERS_PATH, listUsersQuery({ unassigned: sent })]]);
    expect(data.noUsersMessage).toBe(`There are currently no ${named ? "'unassigned'" : ''} users available.`);
    const $ = cheerio.load(toString(await renderListUsersBody(ctx, data)), null, false);
    const filter = $('a.btn:has(i.mi-filter)');
    expect(filter.text().trim()).toBe(label);
    expect(/[?&]unassigned=([^&]*)$/.exec(filter.attr('href') ?? '')?.[1]).toBe(toggle);
  });
});

describe('loadListUsers site', () => {
  it.each<[string, string]>([
    ['ALL', ''],
    ['all', ''],
    [SITE, SITE],
  ])('siteid=%j is sent as is and leaves the view rc.siteid %j', async (siteid, viewSiteId) => {
    const ctx = contextFor(request('listusers', { siteid }));
    expect((await loadListUsers(ctx)).rc.siteid).toBe(viewSiteId);
    expect(peopleCalls(ctx)).toEqual([[LIST_USERS_PATH, listUsersQuery({ siteid })]]);
  });
});
