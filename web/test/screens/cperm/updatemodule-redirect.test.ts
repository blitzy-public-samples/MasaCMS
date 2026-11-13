// cperm.updatemodule against the cperm.cfc updatemodule() step and the FW/1 redirect() it ends with.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components as IdentitySchemas } from '@/generated/clients/identity';
import { GatewayDenialError } from '@/lib/gateway-client';
import { mergeFw1Context, type AdminRequest } from '@/lib/request-context';
import { fw1RedirectTarget } from '@/lib/urls';
import { cpermGate } from '@/screens/cperm/partials';
import { cpermUpdateModule, moduleRedirect, type ModuleRedirect } from '@/screens/cperm/updatemodule';
import type { Rc, SubmitResult } from '@/screens/registry';
import { CSRF_CONTEXTS, CSRF_CPERM_MODULE } from '../../fixtures/identity/csrf';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type ModulePermissionsResult = IdentitySchemas['schemas']['ModulePermissionsResult'];

const SITE = 'default';
const USERS_MODULE = CSRF_CONTEXTS.cpermModule;
const CATEGORIES_MODULE = '00000000000000000000000000000000010';
const PLUGIN_MODULE = 'C3D1A1B2-0000-0000-0000000000000001';
const REFERER = `http://localhost/admin/?muraAction=cPerm.module&contentid=${USERS_MODULE}&siteid=${SITE}`;
const GROUP_LIST = `${GROUP_IDS.defaultEditor},${GROUP_IDS.umbrellaMembers}`;

/** The module form as the browser posts it: one `groupid` per checked box, then the hidden fields. */
const POSTED: ReadonlyArray<readonly [string, string]> = [
  ['groupid', GROUP_IDS.defaultEditor],
  ['groupid', GROUP_IDS.umbrellaMembers],
  ['router', REFERER],
  ['siteid', SITE],
  ['topid', ''],
  ['moduleid', USERS_MODULE],
  ['csrf_token', CSRF_CPERM_MODULE.csrf_token],
  ['csrf_token_expires', CSRF_CPERM_MODULE.csrf_token_expires],
];

const updateRoute = (moduleId: string): string => routeKey('PUT', 'identity', `/v1/permissions/modules/${moduleId}`);

/** Identity's answer: `written` false is a rejected CSRF pair. */
const updated = (written: boolean): FakeReply => ({
  status: 200,
  body: { written, redirect: { action: 'cUsers.list', params: { siteid: SITE } } } satisfies ModulePermissionsResult,
});

/** The S2 admin's post of `fields` to the form action `./?muraAction=cPerm.updatemodule&contentid=<contentid>`. */
function updateRequest(contentid: string, fields: ReadonlyArray<readonly [string, string]> = POSTED): AdminRequest {
  const form = Object.fromEntries(Object.entries(mergeFw1Context([], {}, fields)));
  return adminS2Request({ circuit: 'cperm', item: 'updatemodule', mode: 'redirect', rc: { contentid, ...form } });
}

/** `cpermUpdateModule.submit` for `req` over `gateway`. */
const submit = (req: AdminRequest, gateway: FakeGatewayClient): Promise<SubmitResult> =>
  cpermUpdateModule.submit(makeScreenContext({ req, gateway }));

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
  it.each<[string, string, string | undefined, string]>([
    ['00000000000000000000000000000000004', 'cUsers.list', undefined, 'cUsers.list&siteid=default'],
    ['00000000000000000000000000000000005', 'cEmail.list', undefined, 'cEmail.list&siteid=default'],
    ['00000000000000000000000000000000007', 'cForm.list', undefined, 'cForm.list&siteid=default'],
    ['00000000000000000000000000000000008', 'cUsers.list', undefined, 'cUsers.list&siteid=default'],
    ['00000000000000000000000000000000009', 'cMailingList.list', undefined, 'cMailingList.list&siteid=default'],
    [
      '00000000000000000000000000000000000',
      'cArch.list',
      'topid=00000000000000000000000000000000001&moduleid=00000000000000000000000000000000000',
      'cArch.list&siteid=default&topid=00000000000000000000000000000000001' +
        '&moduleid=00000000000000000000000000000000000',
    ],
    ['00000000000000000000000000000000010', 'cCategory.list', undefined, 'cCategory.list&siteid=default'],
    ['00000000000000000000000000000000011', 'cFeed.list', undefined, 'cFeed.list&siteid=default'],
    ['00000000000000000000000000000000014', 'cChangesets.list', undefined, 'cChangesets.list&siteid=default'],
    ['00000000000000000000000000000000015', 'cComments.default', undefined, 'cComments&siteid=default'],
    ['00000000000000000000000000000000016', 'cArch.list', 'activeTab=2', 'cArch.list&siteid=default&activeTab=2'],
    ['00000000000000000000000000000000001', 'cPlugins.list', undefined, 'cPlugins.list&siteid=default'],
    [PLUGIN_MODULE, 'cPlugins.list', undefined, 'cPlugins.list&siteid=default'],
    ['', 'cPlugins.list', undefined, 'cPlugins.list&siteid=default'],
  ])('sends module %j to %s', (moduleid, action, queryString, target) => {
    const rc = { siteid: SITE, topid: '', moduleid };
    const redirect = moduleRedirect(rc);
    const expected: SubmitResult = {
      kind: 'redirect',
      action,
      append: 'siteid',
      path: './',
      ...(queryString === undefined ? {} : { queryString }),
    };
    expect(redirect).toStrictEqual(expected);
    expect(locationOf(redirect, rc)).toBe(`./?muraAction=${target}`);
  });

  it.each<[string, string, string]>([
    ['8', 'cUsers.list', './?muraAction=cUsers.list&siteid=default'],
    [' 15 ', 'cComments.default', './?muraAction=cComments&siteid=default'],
    [
      '0',
      'cArch.list',
      './?muraAction=cArch.list&siteid=default&topid=00000000000000000000000000000000001' +
        '&moduleid=00000000000000000000000000000000000',
    ],
    ['16.0', 'cArch.list', './?muraAction=cArch.list&siteid=default&activeTab=2'],
  ])('matches %j as CFML == matches it', (moduleid, action, location) => {
    const rc = { siteid: SITE, moduleid };
    const redirect = moduleRedirect(rc);
    expect(redirect.action).toBe(action);
    expect(locationOf(redirect, rc)).toBe(location);
  });

  it('falls back to the plugin list without an rc.moduleid', () => {
    expect(moduleRedirect({ siteid: SITE })).toStrictEqual({
      kind: 'redirect',
      action: 'cPlugins.list',
      append: 'siteid',
      path: './',
    });
  });

  it('appends the request site ESAPI URL-encoded', () => {
    const rc = { siteid: 'tenant a&b', moduleid: USERS_MODULE };
    expect(locationOf(moduleRedirect(rc), rc)).toBe('./?muraAction=cUsers.list&siteid=tenant+a%26b');
  });
});

describe('cpermUpdateModule', () => {
  it('is the identity-owned cperm.updatemodule redirect behind the cperm gate', () => {
    expect([cpermUpdateModule.circuit, cpermUpdateModule.action, cpermUpdateModule.owner]).toEqual([
      'cperm',
      'updatemodule',
      'identity',
    ]);
    expect(cpermUpdateModule.mode).toBe('redirect');
    expect(cpermUpdateModule.gate).toBe(cpermGate);
  });

  it.each([
    ['saved', true],
    ['rejected', false],
  ])('relays the posted form once and redirects the same when identity reports it %s', async (_case, written) => {
    const gateway = fakeGatewayClient({ [updateRoute(USERS_MODULE)]: updated(written) });
    const result = await submit(updateRequest(USERS_MODULE), gateway);
    expect(result).toStrictEqual({ kind: 'redirect', action: 'cUsers.list', append: 'siteid', path: './' });
    expect(gateway.calls).toHaveLength(1);
    const [call] = gateway.calls;
    expect([call?.service, call?.method, call?.path, call?.query]).toEqual([
      'identity',
      'PUT',
      `/v1/permissions/modules/${USERS_MODULE}`,
      undefined,
    ]);
    expect(Object.entries(call?.form ?? {})).toEqual([
      ['groupid', GROUP_LIST],
      ['contentid', USERS_MODULE],
      ['siteid', SITE],
      ['topid', ''],
      ['moduleid', USERS_MODULE],
      ['router', REFERER],
      ['csrf_token', CSRF_CPERM_MODULE.csrf_token],
      ['csrf_token_expires', CSRF_CPERM_MODULE.csrf_token_expires],
    ]);
  });

  it('writes the action URL contentid and redirects by the form moduleid', async () => {
    const gateway = fakeGatewayClient({ [updateRoute(CATEGORIES_MODULE)]: updated(true) });
    const result = await submit(updateRequest(CATEGORIES_MODULE), gateway);
    expect(gateway.calls.map((call) => call.path)).toEqual([`/v1/permissions/modules/${CATEGORIES_MODULE}`]);
    expect(gateway.calls[0]?.form).toMatchObject({ contentid: CATEGORIES_MODULE, moduleid: USERS_MODULE });
    expect(result).toMatchObject({ action: 'cUsers.list' });
  });

  it('sends an empty groupid and no token fields for a post without them', async () => {
    const gateway = fakeGatewayClient({ [updateRoute(CATEGORIES_MODULE)]: updated(false) });
    const fields: ReadonlyArray<readonly [string, string]> = [
      ['siteid', SITE],
      ['moduleid', CATEGORIES_MODULE],
    ];
    const result = await submit(updateRequest(CATEGORIES_MODULE, fields), gateway);
    expect(Object.entries(gateway.calls[0]?.form ?? {})).toEqual([
      ['groupid', ''],
      ['contentid', CATEGORIES_MODULE],
      ['siteid', SITE],
      ['topid', ''],
      ['moduleid', CATEGORIES_MODULE],
    ]);
    expect(result).toStrictEqual({ kind: 'redirect', action: 'cCategory.list', append: 'siteid', path: './' });
  });

  it.each<401 | 403>([401, 403])('raises identity HTTP %i as a denial', async (status) => {
    const gateway = fakeGatewayClient({ [updateRoute(USERS_MODULE)]: { status } });
    const error = await submit(updateRequest(USERS_MODULE), gateway).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'identity', operation: 'updateModulePermissions', status });
    expect(gateway.calls).toHaveLength(1);
  });

  it('fails on another identity error', async () => {
    const gateway = fakeGatewayClient({ [updateRoute(USERS_MODULE)]: { status: 500 } });
    const error = await submit(updateRequest(USERS_MODULE), gateway).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(GatewayDenialError);
    expect(error).toEqual(new Error('updateModulePermissions answered HTTP 500'));
  });
});
