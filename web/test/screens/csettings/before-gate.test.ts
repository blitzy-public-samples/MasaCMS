// csettings.cfc before() (85-95) against legacy, and the carried csettings screens the registry receives.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { csettingsGate, csettingsScreens } from '@/screens/csettings';
import { editSiteScreen } from '@/screens/csettings/editsite';
import { listScreen } from '@/screens/csettings/list';
import { loadCustomImageScreen } from '@/screens/csettings/loadcustomimage';
import { loadCustomImagesScreen } from '@/screens/csettings/loadcustomimages';
import type { ScreenDefinition } from '@/screens/registry';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

const ALLOW: GateDecision = { kind: 'allow' };

/** The `listFindNoCase` exclusions of `before()`, in the controller's casing. */
const S2_ONLY_ITEMS = [
  'list',
  'editPlugin',
  'deployPlugin',
  'updatePlugin',
  'updatePluginVersion',
  'siteCopy',
  'sitecopyselect',
  'sitecopyresult',
] as const;

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

const gate = (req: AdminRequest): GateDecision | Promise<GateDecision> =>
  csettingsGate(req, { secure: () => secure(req) });

/** `csettings.<item>` with `rc` merged over the request's own. */
const on = (item: string, rc: Readonly<Record<string, string>> = {}): AdminRequestPartial => ({
  circuit: 'csettings',
  item,
  rc,
});

/** The tenant-a site admin on `csettings.<item>`, its session on tenant-a. */
const tenantAAdmin = (item: string, rc?: Readonly<Record<string, string>>): AdminRequest =>
  siteAdminRequest('tenant-a', on(item, rc));

describe('csettingsScreens', () => {
  it('lists the Sites list, Edit Site and the custom image size fragments', () => {
    const carried = (
      screen: object,
      action: string,
      mode: ScreenDefinition['mode'],
    ): Readonly<Record<string, unknown>> => ({
      ...screen,
      circuit: 'csettings',
      action,
      mode,
      owner: 'programs-sites',
      gate: csettingsGate,
    });

    expect(csettingsScreens).toEqual([
      carried(listScreen, 'list', 'page'),
      carried(editSiteScreen, 'editsite', 'page'),
      carried(loadCustomImageScreen, 'loadcustomimage', 'fragment'),
      carried(loadCustomImagesScreen, 'loadcustomimages', 'fragment'),
    ]);
    expect(Object.isFrozen(csettingsScreens)).toBe(true);
    expect(csettingsScreens.every((def) => Object.isFrozen(def))).toBe(true);
  });
});

describe('csettingsGate', () => {
  it.each<[string, AdminRequest]>([
    ...[...S2_ONLY_ITEMS, 'editsite', 'loadcustomimage', 'loadcustomimages'].map((item): [string, AdminRequest] => [
      `S2 on ${item}`,
      adminS2Request(on(item)),
    ]),
    ['the tenant-a site admin on editsite for tenant-a', tenantAAdmin('editsite', { siteid: 'tenant-a' })],
    ['the tenant-a site admin on editsite for TENANT-A', tenantAAdmin('editsite', { siteid: 'TENANT-A' })],
    ['the tenant-a site admin on loadcustomimage', tenantAAdmin('loadcustomimage')],
    ['the tenant-a site admin on loadcustomimages', tenantAAdmin('loadcustomimages')],
    [
      'a default site admin on editsite without a siteid',
      siteAdminRequest('default', { ...on('editsite'), user: { site: 'default' } }),
    ],
  ])('allows %s', async (_label, req) => {
    expect(await gate(req)).toEqual(ALLOW);
  });

  it.each<[string, AdminRequest]>([
    ...S2_ONLY_ITEMS.map((item): [string, AdminRequest] => [
      `the tenant-a site admin on ${item}`,
      tenantAAdmin(item),
    ]),
    ['the tenant-a site admin on editsite for tenant-b', tenantAAdmin('editsite', { siteid: 'tenant-b' })],
    ['the tenant-a site admin on loadcustomimages for tenant-b', siteAdminRequest('tenant-b', on('loadcustomimages'))],
    ['the tenant-a site admin on editsite without a siteid', tenantAAdmin('editsite')],
    ['the tenant-a site admin on editsite for a blank siteid', tenantAAdmin('editsite', { siteid: '' })],
    ...['list', 'editsite', 'loadcustomimage', 'loadcustomimages'].map((item): [string, AdminRequest] => [
      `the editor on ${item}`,
      editorRequest(on(item, { siteid: 'default' })),
    ]),
  ])('secures %s', async (_label, req) => {
    const decision = await gate(req);
    expect(decision).toEqual(secure(req));
    expect(decision).toEqual({ kind: 'redirect', location: './' });
  });

  it('secures anonymous to the login form', async () => {
    const req = anonymousRequest(on('editsite', { siteid: 'default' }));
    const decision = await gate(req);
    expect(decision).toEqual(secure(req));
    expect(decision).toMatchObject({ location: expect.stringMatching(/^\.\/\?muraAction=cLogin\.main&returnURL=/) });
  });
});
