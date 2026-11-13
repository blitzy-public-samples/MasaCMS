// cperm.main's Admin group id over identity's paged `/v1/groups?ispublic=0` listing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/identity';
import { loadCpermMain } from '@/screens/cperm/main';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import { CONTENT_NODE_IDS, cpermMainAnswer, cpermMainSystemGroupsAnswer } from '../../fixtures/identity/permissions';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type RecordedRequest } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The registry pulls in every circuit's screens; the shell reads only its hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type GroupListItem = components['schemas']['GroupListItem'];

const SITE = 'default';
const GROUPS_ROUTE = routeKey('GET', 'identity', '/v1/groups');
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const [ADMIN_GROUP, ...OTHER_GROUPS] = cpermMainSystemGroupsAnswer.items as GroupListItem[];

/** A system group of the pool that is not its Admin group. */
const otherGroup = (n: number): GroupListItem => ({
  ...(OTHER_GROUPS[0] as GroupListItem),
  UserID: `6B000000-0000-0000-${String(n).padStart(16, '0')}`,
  GroupName: `Group ${n}`,
});

/** identity's `listGroups` over `rows`, answering the window `offset` asks for at its default size of 1000. */
function pagedGroups(rows: readonly GroupListItem[]): (request: RecordedRequest) => FakeReply {
  return (request) => {
    const offset = Number(request.query.offset ?? '0');
    const items = rows.slice(offset, offset + 1000);
    const next = offset + items.length;
    return { status: 200, body: { items, total: rows.length, nextOffset: next < rows.length ? next : null } };
  };
}

/** The `cperm.main` context of the root node on `default`, its site holding `chains` approval chains. */
function contextFor(groups: (request: RecordedRequest) => FakeReply, chains: number) {
  const gateway = fakeGatewayClient({
    [routeKey('GET', 'identity', `/v1/permissions/content/${CONTENT_NODE_IDS.root}`)]: { status: 200, body: cpermMainAnswer },
    [routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/content/${CONTENT_NODE_IDS.root}/history`)]: { status: 404 },
    [routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/approval-chains`)]: {
      status: 200,
      body: { rc: { chains: Array.from({ length: chains }, (_, n) => ({ chainID: `CH-${n}`, name: `Chain ${n}` })) } },
    },
    [GROUPS_ROUTE]: groups,
  });
  const req = adminS2Request({ circuit: 'cperm', item: 'main', rc: { siteid: SITE, contentid: CONTENT_NODE_IDS.root } });
  return makeScreenContext({ req, gateway });
}

/** The queries of the `/v1/groups` calls `ctx` recorded. */
const groupQueries = (ctx: ReturnType<typeof contextFor>): unknown[] =>
  ctx.gateway.calls.filter((call) => call.path === '/v1/groups').map((call) => call.query);

describe('cperm.main Admin group id', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('takes the Admin group from the first page in one call', async () => {
    const ctx = contextFor(pagedGroups(cpermMainSystemGroupsAnswer.items), 1);

    expect((await loadCpermMain(ctx)).adminGroupId).toBe(GROUP_IDS.defaultAdmin);
    expect(groupQueries(ctx)).toEqual([{ siteid: SITE, ispublic: '0', offset: '0' }]);
  });

  it('follows nextOffset to the page holding the Admin group, matched as SQL Server matches its name', async () => {
    const rows = [...Array.from({ length: 1500 }, (_, n) => otherGroup(n)), { ...(ADMIN_GROUP as GroupListItem), GroupName: 'ADMIN  ' }];
    const ctx = contextFor(pagedGroups(rows), 1);

    expect((await loadCpermMain(ctx)).adminGroupId).toBe(GROUP_IDS.defaultAdmin);
    expect(groupQueries(ctx)).toEqual(['0', '1000'].map((offset) => ({ siteid: SITE, ispublic: '0', offset })));
  });

  it('answers a fresh CF UUID once the pages end without an Admin group', async () => {
    const ctx = contextFor(pagedGroups(Array.from({ length: 1001 }, (_, n) => otherGroup(n))), 2);

    expect((await loadCpermMain(ctx)).adminGroupId).toMatch(CF_UUID);
    expect(groupQueries(ctx)).toHaveLength(2);
  });

  it('reads no group without approval chains', async () => {
    const ctx = contextFor(pagedGroups(cpermMainSystemGroupsAnswer.items), 0);

    expect((await loadCpermMain(ctx)).adminGroupId).toBe('');
    expect(groupQueries(ctx)).toEqual([]);
  });
});
