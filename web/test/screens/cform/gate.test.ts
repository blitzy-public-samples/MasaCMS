// cform before(): the Site Manager and Forms module gate of admin/core/controllers/cform.cfc, and the registered actions.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import { runGate, secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { cformGate, cformScreens } from '@/screens/cform';
import type { ScreenDefinition } from '@/screens/registry';
import {
  adminS2Request,
  anonymousRequest,
  buildTestAdminRequest,
  editorRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';

const M000 = '00000000000000000000000000000000000';
const M004 = '00000000000000000000000000000000004';
const SENTINEL: GateDecision = Object.freeze({ kind: 'redirect', location: './?muraAction=cLogin.main' });
const ALLOW: GateDecision = { kind: 'allow' };
const GETFORM = { circuit: 'cform', item: 'getform' } as const;

const INVENTORY_URL = new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url);
const CFORM_PREFIX = 'admin:cform.';

/** An admin action or variant record as the inventory stores it. */
interface InventoryVariant {
  readonly routeKey: string;
  readonly disposition: string | null;
  readonly owningService: string | null;
  readonly responseMode: string | null;
}

interface InventoryController {
  readonly actions?: ReadonlyArray<{ readonly variants?: readonly InventoryVariant[] }>;
}

/** Every inventoried cform action variant, with its normalised action name. */
function cformRecords(): Array<InventoryVariant & { readonly action: string }> {
  const { controllers } = JSON.parse(readFileSync(INVENTORY_URL, 'utf8')) as {
    controllers: readonly InventoryController[];
  };
  return controllers
    .flatMap((controller) => (controller.actions ?? []).flatMap((action) => action.variants ?? []))
    .map((variant) => ({ ...variant, routeKey: normaliseRouteKey(variant.routeKey) }))
    .filter((variant) => variant.routeKey.startsWith(CFORM_PREFIX))
    .map((variant) => ({ ...variant, action: variant.routeKey.slice(CFORM_PREFIX.length) }));
}

const INVENTORY = cformRecords();
const CARRIED = INVENTORY.filter((record) => record.disposition === 'carry');

const actionOf = (screen: ScreenDefinition): string => normaliseRouteKey(screen.action);

let restore: () => void;
let secureSpy: Mock<() => GateDecision>;

beforeEach(() => {
  restore = useTestEnv();
  secureSpy = vi.fn(() => SENTINEL);
});

afterEach(() => {
  restore();
});

const gate = async (req: AdminRequest): Promise<GateDecision> => cformGate(req, { secure: secureSpy });

// makeAdminRequest derives modulePerm from the claims and takes no override, so the preset's member is replaced.
/** The qa_editor preset on its token site with `modulePerm` granting only `granted`, recording each module id asked. */
function editorGranting(granted: string): { req: AdminRequest; modulePerm: Mock<(moduleId: string) => boolean> } {
  const modulePerm = vi.fn((moduleId: string) => moduleId === granted);
  return { req: { ...editorRequest(GETFORM), modulePerm }, modulePerm };
}

/** qa_editor holding the Site Manager and Forms grants of its token site. */
const editorWithForms = (partial: AdminRequestPartial): AdminRequest =>
  editorRequest({ ...GETFORM, ...partial, user: { roles: [Roles.systemUser, moduleRole(M000), moduleRole(M004)] } });

describe('cformGate', () => {
  it('allows s2', async () => {
    expect(await gate(adminS2Request(GETFORM))).toEqual(ALLOW);
    expect(secureSpy).not.toHaveBeenCalled();
  });

  it('allows a site admin on its own site', async () => {
    const req = siteAdminRequest('tenant-a', GETFORM);

    expect(req.rc['siteid']).toBe('tenant-a');
    expect(await gate(req)).toEqual(ALLOW);
    expect(secureSpy).not.toHaveBeenCalled();
  });

  it('secures anonymous', async () => {
    expect(await gate(anonymousRequest(GETFORM))).toBe(SENTINEL);
    expect(secureSpy).toHaveBeenCalledTimes(1);
    // runGate binds secure() to the request, so the gate passes nothing.
    expect(secureSpy).toHaveBeenCalledWith();
  });

  it('secures qa_editor, who lacks m:004', async () => {
    expect(await gate(editorRequest(GETFORM))).toBe(SENTINEL);
    expect(secureSpy).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string, string[][]]>([
    ['secures with m:000 only', M000, [[M000], [M004]]],
    ['secures with m:004 only', M004, [[M000]]],
  ])('%s', async (_label, granted, asked) => {
    const { req, modulePerm } = editorGranting(granted);

    expect(await gate(req)).toBe(SENTINEL);
    expect(modulePerm.mock.calls).toEqual(asked);
    expect(secureSpy).toHaveBeenCalledTimes(1);
  });

  it.each(REQUESTED_SITE_CASES)('admits $who only when it administers that site', async ({ request, administers }) => {
    expect(await gate(request(GETFORM))).toEqual(administers ? ALLOW : SENTINEL);
  });

  it.each<[string, AdminRequestPartial, GateDecision]>([
    ['on its token site', {}, ALLOW],
    ['on Default, its token site in another case', { rc: { siteid: 'Default' } }, ALLOW],
    ['on tenant-b, a site its token does not serve', { rc: { siteid: 'tenant-b' } }, SENTINEL],
  ])('checks the module grants of qa_editor %s against rc.siteid', async (_case, partial, expected) => {
    expect(await gate(editorWithForms(partial))).toEqual(expected);
  });

  it.each<[string, 'siteAdmin' | 'qaEditor', string, GateDecision]>([
    ['allows a built site-admin request', 'siteAdmin', 'tenant-a', ALLOW],
    ['secures a built qa_editor request', 'qaEditor', 'default', SENTINEL],
  ])('%s', async (_label, user, siteid, expected) => {
    const req = await buildTestAdminRequest({ circuit: 'cform', action: 'getform', user, query: { siteid } });

    expect(await gate(req)).toEqual(expected);
  });

  it('sends anonymous to the login form through the real secure()', async () => {
    const req = anonymousRequest(GETFORM);

    expect(await cformGate(req, { secure: () => secure(req) })).toEqual({
      kind: 'redirect',
      location: expect.stringMatching(/^\.\/\?muraAction=cLogin\.main/),
    });
  });

  it('sends qa_editor back to the referrer through runGate', async () => {
    const referer = 'http://localhost/admin/?muraAction=cArch.list';
    const req = editorRequest({ ...GETFORM, headers: new Headers({ referer }) });

    expect(await runGate(req, cformGate)).toEqual({ kind: 'redirect', location: referer });
  });

  it('lets s2 through runGate', async () => {
    expect(await runGate(adminS2Request(GETFORM), cformGate)).toEqual(ALLOW);
  });
});

describe('cformScreens', () => {
  const byAction = new Map(cformScreens.map((screen) => [actionOf(screen), screen]));

  it.each<[string, ScreenDefinition]>(cformScreens.map((screen) => [screen.action, screen]))(
    'registers %s for strategies-content behind cformGate',
    (_action, screen) => {
      expect(screen.circuit).toBe('cform');
      expect(screen.owner).toBe('strategies-content');
      expect(screen.gate).toBe(cformGate);
    },
  );

  it('registers exactly the carried inventory actions, each once', () => {
    const actions = cformScreens.map(actionOf);

    expect(CARRIED).not.toHaveLength(0);
    expect(byAction.size).toBe(actions.length);
    expect(actions.toSorted()).toEqual(CARRIED.map((record) => record.action).toSorted());
  });

  it.each(CARRIED.map((record) => [record.action, record] as const))('serves carried %s in its inventoried mode', (action, record) => {
    expect(byAction.has(action)).toBe(true);
    expect(byAction.get(action)).toMatchObject({ mode: record.responseMode, owner: record.owningService });
  });

  it('registers nothing the inventory does not carry', () => {
    const notCarried = new Set(INVENTORY.filter((r) => r.disposition !== 'carry').map((r) => r.action));

    expect(cformScreens.map(actionOf).filter((action) => notCarried.has(action))).toEqual([]);
  });
});
