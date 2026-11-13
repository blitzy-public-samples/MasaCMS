// The cfeed barrel against the legacy inventory's carried cFeed route keys and admin/core/controllers/cfeed.cfc before().
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import { cfeedScreens, cfeedSecondaryMenu } from '@/screens/cfeed';
import { CFEED_RC_DEFAULTS, cfeedGate } from '@/screens/cfeed/before';
import { cfeedEditScreen } from '@/screens/cfeed/edit';
import { cfeedListScreen } from '@/screens/cfeed/list';
import { cfeedSecondaryMenu as leafSecondaryMenu } from '@/screens/cfeed/secondary-menu';
import { cfeedSiteParentsScreen } from '@/screens/cfeed/siteparents';
import { cfeedUpdateScreen } from '@/screens/cfeed/update';
import type { FragmentScreen, PageScreen, ScreenContext, ScreenDefinition } from '@/screens/registry';
import { makeAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

const INVENTORY_URL = new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url);
const FEED_ID = 'F1000000-0000-0000-0000000000000001';
const HTML_TYPE = 'text/html;charset=UTF-8';

interface InventoryVariant {
  readonly routeKey: string;
  readonly disposition: string | null;
  readonly responseMode: string | null;
}

/** Every inventoried `admin:cfeed.*` key with its disposition and response mode. */
function cfeedRecords(): InventoryVariant[] {
  const { controllers } = JSON.parse(readFileSync(INVENTORY_URL, 'utf8')) as {
    controllers: ReadonlyArray<{ readonly actions?: ReadonlyArray<{ readonly variants?: readonly InventoryVariant[] }> }>;
  };
  return controllers
    .flatMap((controller) => (controller.actions ?? []).flatMap((action) => action.variants ?? []))
    .map((variant) => ({ ...variant, routeKey: normaliseRouteKey(variant.routeKey) }))
    .filter((variant) => variant.routeKey.startsWith('admin:cfeed.'));
}

const keyOf = (def: ScreenDefinition): string => normaliseRouteKey(`admin:${def.circuit}.${def.action}`);

const screenOf = (action: string): ScreenDefinition => {
  const def = cfeedScreens.find((candidate) => candidate.action === action);
  if (def === undefined) throw new Error(`cfeed.${action} is not registered`);
  return def;
};

/** The admin on `cfeed.<item>` of site `default` with `rc`, over `gateway`. */
function context(item: string, rc: Record<string, string>, gateway: FakeGatewayClient): ScreenContext {
  const req = makeAdminRequest({ circuit: 'cfeed', item, rc, site: { hasFeedManager: true } }, 'admin');
  return makeScreenContext({ req, gateway });
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('cfeed barrel', () => {
  const records = cfeedRecords();
  const carried = records.filter((record) => record.disposition === 'carry');

  it('registers exactly the carried inventory keys, each once; import2 stays on legacy', () => {
    const keys = cfeedScreens.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.toSorted()).toEqual(carried.map((record) => record.routeKey).toSorted());
    expect(records.find((record) => record.routeKey === 'admin:cfeed.import2')?.disposition).toBe('decision');
    expect(keys).not.toContain('admin:cfeed.import2');
  });

  it('serves each key in its inventoried mode for strategies-content behind the cfeed before() gate', () => {
    for (const def of cfeedScreens) {
      const record = carried.find((candidate) => candidate.routeKey === keyOf(def));
      expect(def.mode, keyOf(def)).toBe(record?.responseMode);
      expect(def.owner, keyOf(def)).toBe('strategies-content');
      expect(def.gate, keyOf(def)).toBe(cfeedGate);
    }
  });

  it('registers the leaves that apply the before() defaults themselves unchanged', () => {
    expect(screenOf('list')).toBe(cfeedListScreen);
    expect(screenOf('edit')).toBe(cfeedEditScreen);
    expect(screenOf('siteparents')).toBe(cfeedSiteParentsScreen);
    expect(screenOf('update')).toBe(cfeedUpdateScreen);
  });

  it('re-exports the shell secondary-menu hook', () => {
    expect(cfeedSecondaryMenu).toBe(leafSecondaryMenu);
  });

  it('loads cFeed.import1 on the rc before() leaves, which the view and the shell then read', async () => {
    const gateway = fakeGatewayClient({
      [routeKey('GET', 'strategies-content', `/v1/sites/default/feeds/${FEED_ID}/import`)]: {
        status: 200,
        body: { rc: { feedBean: { name: 'Wire', version: 'RSS 2.0' }, items: [] } },
      },
    });
    const ctx = context('import1', { feedid: FEED_ID }, gateway);
    // before() adds only the keys the request, after the admin set-up, lacks.
    const expected = { ...CFEED_RC_DEFAULTS, ...ctx.req.rc };
    const page = screenOf('import1') as PageScreen;
    await expect(page.load?.(ctx)).resolves.toEqual({ feedName: 'Wire', version: 'RSS 2.0', items: [] });
    expect({ ...ctx.req.rc }).toEqual(expected);
    expect(ctx.req.rc).toMatchObject({ feedid: FEED_ID, siteid: 'default', startrow: '1', regionID: '0' });
  });

  it('relays cFeed.loadSite with the rc before() leaves', async () => {
    const route = routeKey('GET', 'strategies-content', '/v1/raw/cfeed/loadsite');
    const gateway = fakeGatewayClient({ [route]: { status: 200, headers: { 'Content-Type': HTML_TYPE }, body: '<div></div>' } });
    const ctx = context('loadsite', { keywords: 'news', isNew: '0' }, gateway);
    const expected = { ...CFEED_RC_DEFAULTS, ...ctx.req.rc };
    const fragment = screenOf('loadsite') as FragmentScreen;
    await expect(fragment.render(ctx, undefined)).resolves.toEqual({
      status: 200,
      contentType: HTML_TYPE,
      body: Buffer.from('<div></div>'),
    });
    const call = gateway.calls.find((candidate) => candidate.path === '/v1/raw/cfeed/loadsite');
    // A request value wins over its default; every other before() default travels as the view's rc holds it.
    expect(call?.query).toEqual(expected);
    expect(call?.query).toMatchObject({ keywords: 'news', isNew: '0', siteid: 'default', startrow: '1' });
    expect({ ...ctx.req.rc }).toEqual(expected);
  });
});
