// cUsers.editGroupMembers over identity's paged members listing: the page `setUsersIterator()` shows, read window by window.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/identity';
import type { ServicePath } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { loadEditGroupMembers, renderEditGroupMembers, type EditGroupMembersData } from '@/screens/cusers/editgroupmembers';
import { getNextN, legacyPageIndex } from '@/screens/cusers/inc/dsp_nextn';
import { GROUP_IDS, editorGroupMembers, groupsById } from '../../fixtures/identity/groups';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type RecordedRequest } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The registry pulls in every circuit's screens; the shell reads only its hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type GroupMember = components['schemas']['GroupMember'];

/** Include output cut from legacy ACF 2023 pages (admin, siteid=default), CSRF pairs replaced by the test pair. */
const fixture = (path: string): string => readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), 'utf8');

const GROUP_ID = GROUP_IDS.defaultEditor;
const MEMBERS_PATH: ServicePath = `/v1/groups/${GROUP_ID}/members`;
const ALL = '100000';

/** `count` members cycling the Editor group's fixture members, each under its own id, in identity's listing order. */
function members(count: number): GroupMember[] {
  return Array.from({ length: count }, (_, n) => {
    const template = editorGroupMembers[n % editorGroupMembers.length] as GroupMember;
    const userId = `5C000000-0000-0000-${String(n).padStart(16, '0')}`;
    return { ...template, groupID: userId, userID: userId, Lname: `${template.Lname ?? ''} ${String(n).padStart(5, '0')}` };
  });
}

/** identity `listGroupMembers` over `listing`, recording each window's offset and limit and answering as identity pages. */
function membersRoute(listing: readonly GroupMember[], windows: [number, number][]): (request: RecordedRequest) => FakeReply {
  return (request) => {
    const offset = Number(request.query.offset ?? '0');
    const limit = Number(request.query.limit ?? '1000');
    windows.push([offset, limit]);
    const items = listing.slice(offset, offset + limit);
    const next = offset + items.length;
    return { status: 200, body: { items, total: listing.length, nextOffset: next < listing.length ? next : null } };
  };
}

/** The screen context of an admin on `default` asking for the Editor group's members with `paging` in rc. */
function contextFor(listing: readonly GroupMember[], paging: Record<string, string>, windows: [number, number][] = []) {
  const gateway = fakeGatewayClient({
    [routeKey('GET', 'identity', `/v1/groups/${GROUP_ID}`)]: { status: 200, body: { group: groupsById[GROUP_ID], isNew: false } },
    [routeKey('GET', 'identity', MEMBERS_PATH)]: membersRoute(listing, windows),
  });
  const req = adminS2Request({ circuit: 'cusers', item: 'editgroupmembers', rc: { userid: GROUP_ID, siteid: 'default', ...paging } });
  return makeScreenContext({ req, gateway });
}

/** What the screen loaded from the whole listing before identity paged it: every row, then the iterator's page of them. */
function wholeListingPage(all: EditGroupMembersData['rows'], startRowRc: number, recordsPerPage: number): Pick<EditGroupMembersData, 'rows' | 'nextn' | 'pageIndex'> {
  const startRow = startRowRc > all.length ? 1 : startRowRc;
  const nextn = getNextN(all.length, recordsPerPage, startRow, 3);
  const pageIndex = legacyPageIndex(nextn.startRow, nextn.recordsPerPage, all.length);
  const first = (pageIndex - 1) * nextn.recordsPerPage;
  return { rows: all.slice(first, first + nextn.recordsPerPage), nextn, pageIndex };
}

describe('cUsers.editGroupMembers paging', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('reads the whole listing for the All page window by window, in identity order', async () => {
    const listing = members(2500);
    const windows: [number, number][] = [];

    const data = await loadEditGroupMembers(contextFor(listing, { startrow: '1', recordsperpage: ALL }, windows));

    expect(data.rows.map((row) => row.userid)).toEqual(listing.map((member) => member.userID));
    expect(windows).toEqual([[0, 1000], [1000, 1000], [2000, 1000]]);
  });

  it.each<[string, number, string, string, [number, number][]]>([
    ['an empty group', 0, '1', '25', [[0, 25]]],
    ['the first page', 60, '1', '25', [[0, 25]]],
    ['the second page', 60, '2', '25', [[0, 1], [25, 25]]],
    ['the partial last page', 60, '3', '25', [[0, 1], [50, 25]]],
    ['a page starting at the last row', 50, '3', '25', [[0, 1]]],
    ['a page past the listing, read as page 1', 40, '3', '25', [[0, 1], [0, 25]]],
    ['a start row past the listing, reset to 1', 5, '10', '25', [[0, 1], [0, 25]]],
    ['a row number read as a page number', 60, '26', '25', [[0, 1], [0, 25]]],
    ['a fractional start row', 30, '2.5', '10', [[0, 1], [15, 10]]],
    ['a fractional page size', 10, '2', '2.5', [[0, 1], [2, 3]]],
    ['an unparsable start row, read as 1', 30, 'x', '10', [[0, 10]]],
    ['a page of 1000 after the first', 2500, '2', '1000', [[0, 1], [1000, 1000]]],
    ['a page of 1500 spanning two windows', 4000, '2', '1500', [[0, 1], [1500, 1000], [2500, 500]]],
    ['the All page of a small group', 3, '1', ALL, [[0, 1000]]],
  ])('shows %s exactly as the whole-listing slice did, reading only its windows', async (_case, count, startrow, recordsperpage, expected) => {
    const listing = members(count);
    const all = (await loadEditGroupMembers(contextFor(listing, { startrow: '1', recordsperpage: ALL }))).rows;
    const windows: [number, number][] = [];
    const ctx = contextFor(listing, { startrow, recordsperpage }, windows);

    const data = await loadEditGroupMembers(ctx);
    const before = wholeListingPage(all, data.rc.startRow, data.rc.recordsperpage);

    expect({ rows: data.rows, nextn: data.nextn, pageIndex: data.pageIndex }).toEqual(before);
    expect(windows).toEqual(expected);
    const markup = toString((await renderEditGroupMembers(ctx, data)).body);
    expect(markup).toBe(toString((await renderEditGroupMembers(ctx, { ...data, ...before })).body));
  });

  it('renders a one-member group with the legacy users list byte for byte', async () => {
    const qaEditor: GroupMember = {
      groupID: '3BEC10FC-F5B5-5517-7E7F2072657EFB68',
      userID: '3BEC10FC-F5B5-5517-7E7F2072657EFB68',
      Fname: 'QA',
      Lname: 'Editor',
      Email: 'qa_editor@example.com',
      IsPublic: 0,
      S2: 0,
      LastUpdate: '2026-11-13T02:44:17',
      LastUpdateBy: 'Admin User',
    };
    const ctx = makeScreenContext({
      req: adminS2Request({ circuit: 'cusers', item: 'editgroupmembers', rc: { userid: '3BEA0C3E-ADEF-CA41-18EF6712DF2AA18D', siteid: 'default', ispublic: '1' } }),
      gateway: fakeGatewayClient({
        [routeKey('GET', 'identity', '/v1/groups/3BEA0C3E-ADEF-CA41-18EF6712DF2AA18D')]: { status: 200, body: { group: groupsById[GROUP_ID], isNew: false } },
        [routeKey('GET', 'identity', '/v1/groups/3BEA0C3E-ADEF-CA41-18EF6712DF2AA18D/members')]: membersRoute([qaEditor], []),
      }),
    });

    const markup = toString((await renderEditGroupMembers(ctx, await loadEditGroupMembers(ctx))).body);

    expect(markup).toContain(fixture('identity/cusers-editgroupmembers-users-list.html'));
  });

  it('renders a group without members with the legacy empty notice byte for byte', async () => {
    const ctx = contextFor([], { startrow: '1' });

    const markup = toString((await renderEditGroupMembers(ctx, await loadEditGroupMembers(ctx))).body);

    expect(markup).toContain(fixture('identity/cusers-editgroupmembers-users-empty.html'));
  });

  it('reads no member of an id that is no CF UUID', async () => {
    const ctx = contextFor(members(3), { userid: 'not-a-group' });

    const data = await loadEditGroupMembers(ctx);

    expect({ groupName: data.groupName, rows: data.rows, pageIndex: data.pageIndex }).toEqual({ groupName: '', rows: [], pageIndex: 1 });
    expect(ctx.gateway.calls.filter((call) => call.path.startsWith('/v1/groups'))).toEqual([]);
  });
});
