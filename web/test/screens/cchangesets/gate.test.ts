// cChangesets before() gate, param defaults and registered actions of admin/core/controllers/cchangesets.cfc.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import { secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import {
  CCHANGESETS_RC_DEFAULTS,
  cchangesetsGate,
  cchangesetsScreens,
  cchangesetsSecondaryMenu,
} from '@/screens/cchangesets';
import { cchangesetsSecondaryMenu as secondaryMenuHook } from '@/screens/cchangesets/secondary-menu';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

const M014 = '00000000000000000000000000000000014';
const M000 = '00000000000000000000000000000000000';
const LIST = { circuit: 'cChangesets', item: 'list' } as const;
const ALLOW: GateDecision = { kind: 'allow' };

const INVENTORY_URL = new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url);
const CCHANGESETS_PREFIX = 'admin:cchangesets.';

/** An admin action variant as the inventory stores it. */
interface InventoryVariant {
  readonly routeKey: string;
  readonly disposition: string | null;
  readonly owningService: string | null;
  readonly responseMode: string | null;
}

interface InventoryController {
  readonly actions?: ReadonlyArray<{ readonly variants?: readonly InventoryVariant[] }>;
}

/** Every inventoried cChangesets variant keyed by its lower-case action. */
function inventoriedActions(): Map<string, InventoryVariant> {
  const { controllers } = JSON.parse(readFileSync(INVENTORY_URL, 'utf8')) as {
    controllers: readonly InventoryController[];
  };
  const variants = controllers
    .flatMap((controller) => (controller.actions ?? []).flatMap((action) => action.variants ?? []))
    .map((variant) => ({ ...variant, routeKey: normaliseRouteKey(variant.routeKey) }))
    .filter((variant) => variant.routeKey.startsWith(CCHANGESETS_PREFIX));
  return new Map(variants.map((variant) => [variant.routeKey.slice(CCHANGESETS_PREFIX.length), variant]));
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** The gate's decision for `req`, and the `secure()` spy it received, which answers the real `secure(req)`. */
async function gate(req: AdminRequest): Promise<{ decision: GateDecision; secureSpy: Mock<() => GateDecision> }> {
  const secureSpy = vi.fn(() => secure(req));
  return { decision: await cchangesetsGate(req, { secure: secureSpy }), secureSpy };
}

// makeAdminRequest derives modulePerm from the token's m:<NNN> roles and takes no override, so only it is replaced.
/** The qa_editor preset with `modulePerm` granting exactly `granted`. */
function editorGranting(granted: readonly string[], partial: AdminRequestPartial = LIST): AdminRequest {
  return { ...editorRequest(partial), modulePerm: (moduleId: string) => granted.includes(moduleId) };
}

describe('cchangesetsGate', () => {
  it('allows S2', async () => {
    const { decision, secureSpy } = await gate(adminS2Request(LIST));

    expect(decision).toEqual(ALLOW);
    expect(secureSpy).not.toHaveBeenCalled();
  });

  it('allows the site admin on its own site', async () => {
    const req = siteAdminRequest('tenant-a', LIST);
    const { decision, secureSpy } = await gate(req);

    expect(req.rc['siteid']).toBe('tenant-a');
    expect(decision).toEqual(ALLOW);
    expect(secureSpy).not.toHaveBeenCalled();
  });

  it('delegates a site admin addressing another site', async () => {
    const { decision, secureSpy } = await gate(siteAdminRequest('tenant-a', { ...LIST, rc: { siteid: 'tenant-b' } }));

    expect(secureSpy).toHaveBeenCalledTimes(1);
    expect(secureSpy).toHaveBeenCalledWith();
    expect(decision).toBe(secureSpy.mock.results[0]?.value);
  });

  it('allows Change Sets plus Site Manager without admin membership', async () => {
    const req = editorGranting([M014, M000]);
    const { decision, secureSpy } = await gate(req);

    expect([req.isS2, req.isSiteAdmin]).toEqual([false, false]);
    expect(decision).toEqual(ALLOW);
    expect(secureSpy).not.toHaveBeenCalled();
  });

  it.each<[string, () => AdminRequest, [boolean, boolean]]>([
    ['only m:014', () => editorGranting([M014]), [true, false]],
    ['only m:000, as the qa_editor preset holds', () => editorRequest(LIST), [false, true]],
    ['neither module perm', () => editorGranting([]), [false, false]],
  ])('delegates with %s', async (_label, request, perms) => {
    const req = request();
    const { decision, secureSpy } = await gate(req);

    expect([req.modulePerm(M014), req.modulePerm(M000)]).toEqual(perms);
    expect(secureSpy).toHaveBeenCalledTimes(1);
    expect(decision).toEqual(secure(req));
    expect(decision).toEqual({ kind: 'redirect', location: './' });
  });

  it('delegates both module perms on a site the token does not serve', async () => {
    const { decision, secureSpy } = await gate(editorGranting([M014, M000], { ...LIST, rc: { siteid: 'tenant-a' } }));

    expect(secureSpy).toHaveBeenCalledTimes(1);
    expect(decision).toBe(secureSpy.mock.results[0]?.value);
  });

  it('sends anonymous to the login form', async () => {
    const { decision, secureSpy } = await gate(anonymousRequest(LIST));

    expect(secureSpy).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({
      kind: 'redirect',
      location: expect.stringMatching(/^\.\/\?muraAction=cLogin\.main&returnURL=/),
    });
  });
});

describe('CCHANGESETS_RC_DEFAULTS', () => {
  it('holds the before() param defaults as rc strings', () => {
    expect(CCHANGESETS_RC_DEFAULTS).toEqual({
      startrow: '1',
      page: '1',
      startdate: '',
      stopdate: '',
      keywords: '',
      categoryid: '',
      tags: '',
    });
    expect(Object.isFrozen(CCHANGESETS_RC_DEFAULTS)).toBe(true);
  });
});

describe('cchangesetsScreens', () => {
  // publish writes the withheld tcontenteventreminders table, so it stays legacy-served.
  it('registers the carried actions, leaving publish on legacy', () => {
    expect(cchangesetsScreens.map(({ action }) => action).sort()).toEqual([
      'assignments',
      'delete',
      'edit',
      'list',
      'loadtagarray',
      'removeitem',
      'rollback',
      'save',
    ]);
    expect(inventoriedActions().get('publish')?.disposition).toBe('decision');
  });

  it('puts every action behind the gate for strategies-content', () => {
    for (const screen of cchangesetsScreens) {
      expect({ circuit: screen.circuit, owner: screen.owner, gated: screen.gate === cchangesetsGate }).toEqual({
        circuit: 'cchangesets',
        owner: 'strategies-content',
        gated: true,
      });
    }
  });

  it('answers each action in its inventoried mode', () => {
    const modes = Object.fromEntries(cchangesetsScreens.map(({ action, mode }) => [action, mode]));
    const carried = [...inventoriedActions()].filter(([, variant]) => variant.disposition === 'carry');

    expect(modes).toEqual({
      list: 'page',
      assignments: 'page',
      edit: 'page',
      save: 'page',
      rollback: 'redirect',
      removeitem: 'redirect',
      delete: 'redirect',
      loadtagarray: 'fragment',
    });
    expect(Object.fromEntries(carried.map(([action, variant]) => [action, variant.responseMode]))).toEqual(modes);
    expect(carried.every(([, variant]) => variant.owningService === 'strategies-content')).toBe(true);
  });
});

describe('cchangesets index', () => {
  it('re-exports the secondary menu hook', () => {
    expect(cchangesetsSecondaryMenu).toBe(secondaryMenuHook);
  });
});
