// cperm.updatemodule: the rc values updatemodule() assigns before redirect(), and a tenant-a Site Manager post.
// The full module table, the Users and Categories posts and identity's error answers are in
// updatemodule-redirect.test.ts; this suite holds only the cases that file does not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components as IdentitySchemas } from '@/generated/clients/identity';
import { mergeFw1Context, type AdminRequest } from '@/lib/request-context';
import { fw1RedirectTarget } from '@/lib/urls';
import { cpermUpdateModule, moduleRedirect, type ModuleRedirect } from '@/screens/cperm/updatemodule';
import type { Rc } from '@/screens/registry';
import { CSRF_CPERM_MODULE } from '../../fixtures/identity/csrf';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import { MODULE_IDS } from '../../fixtures/identity/permissions';
import { siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type ModulePermissionsResult = IdentitySchemas['schemas']['ModulePermissionsResult'];

const SITE = 'tenant-a';
const TOP_ID = '00000000000000000000000000000000001';
const SITE_MANAGER_LOCATION = `./?muraAction=cArch.list&siteid=${SITE}&topid=${TOP_ID}&moduleid=${MODULE_IDS.content}`;
const REFERER = `http://localhost/admin/?muraAction=cPerm.module&contentid=${MODULE_IDS.content}&siteid=${SITE}`;
const UPDATE_ROUTE = routeKey('PUT', 'identity', `/v1/permissions/modules/${MODULE_IDS.content}`);

/** The Site Manager module form as posted: one `groupid` per checked box, then the hidden fields. */
const POSTED: ReadonlyArray<readonly [string, string]> = [
  ['groupid', GROUP_IDS.tenantAAdmin],
  ['groupid', GROUP_IDS.timesheetsEmployee],
  ['groupid', GROUP_IDS.umbrellaMembers],
  ['router', REFERER],
  ['siteid', SITE],
  ['topid', 'X'],
  ['moduleid', MODULE_IDS.content],
  ['csrf_token', CSRF_CPERM_MODULE.csrf_token],
  ['csrf_token_expires', CSRF_CPERM_MODULE.csrf_token_expires],
];

/** The tenant-a site admin's post to `./?muraAction=cPerm.updatemodule&contentid=<Site Manager>`. */
function updateRequest(): AdminRequest {
  const form = Object.fromEntries(Object.entries(mergeFw1Context([], {}, POSTED)));
  return siteAdminRequest(SITE, {
    circuit: 'cperm',
    item: 'updatemodule',
    mode: 'redirect',
    rc: { contentid: MODULE_IDS.content, ...form },
  });
}

/** Identity's answer: `written` false is a rejected CSRF pair. */
const updated = (written: boolean): FakeReply => ({
  status: 200,
  body: {
    written,
    redirect: { action: 'cArch.list', params: { siteid: SITE, topid: TOP_ID, moduleid: MODULE_IDS.content } },
  } satisfies ModulePermissionsResult,
});

/** The `Location` FW/1 sends for `redirect`, appending each `append` key `rc` holds. */
function locationOf(redirect: ModuleRedirect, rc: Rc): string {
  const append = (redirect.append ?? '').split(',').flatMap((key): Array<[string, string]> => {
    const value = rc[key];
    return value === undefined ? [] : [[key, value]];
  });
  return fw1RedirectTarget({ action: redirect.action, append, queryString: redirect.queryString, path: redirect.path });
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('moduleRedirect', () => {
  it.each<[moduleid: string, incoming: Readonly<Record<string, string>>, queryString: string, location: string]>([
    [MODULE_IDS.content, { topid: 'X' }, `topid=${TOP_ID}&moduleid=${MODULE_IDS.content}`, SITE_MANAGER_LOCATION],
    [
      '00000000000000000000000000000000016',
      { activeTab: '0' },
      'activeTab=2',
      `./?muraAction=cArch.list&siteid=${SITE}&activeTab=2`,
    ],
  ])('%s overrides %j', (moduleid, incoming, queryString, location) => {
    const rc = { siteid: SITE, ...incoming, moduleid };
    const redirect = moduleRedirect(rc);
    expect(redirect).toStrictEqual({ kind: 'redirect', action: 'cArch.list', append: 'siteid', path: './', queryString });
    expect(locationOf(redirect, rc)).toBe(location);
  });
});

describe('cpermUpdateModule', () => {
  it.each([true, false])('Site Manager post, written=%s', async (written) => {
    const gateway = fakeGatewayClient({ [UPDATE_ROUTE]: updated(written) });
    const req = updateRequest();
    const result = await cpermUpdateModule.submit(makeScreenContext({ req, gateway }));

    expect(gateway.calls.map(({ service, method, path }) => [service, method, path])).toEqual([
      ['identity', 'PUT', `/v1/permissions/modules/${MODULE_IDS.content}`],
    ]);
    expect(Object.entries(gateway.calls[0]?.form ?? {})).toEqual([
      ['groupid', `${GROUP_IDS.tenantAAdmin},${GROUP_IDS.timesheetsEmployee},${GROUP_IDS.umbrellaMembers}`],
      ['contentid', MODULE_IDS.content],
      ['siteid', SITE],
      ['topid', 'X'],
      ['moduleid', MODULE_IDS.content],
      ['router', REFERER],
      ['csrf_token', CSRF_CPERM_MODULE.csrf_token],
      ['csrf_token_expires', CSRF_CPERM_MODULE.csrf_token_expires],
    ]);

    const expected: ModuleRedirect = {
      kind: 'redirect',
      action: 'cArch.list',
      append: 'siteid',
      path: './',
      queryString: `topid=${TOP_ID}&moduleid=${MODULE_IDS.content}`,
    };
    expect(result).toStrictEqual(expected);
    expect(locationOf(expected, req.rc)).toBe(SITE_MANAGER_LOCATION);
  });
});
