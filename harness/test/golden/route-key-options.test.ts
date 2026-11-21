import { readFileSync } from 'node:fs';
import { routeKeyCaseOptions } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coverageRouteKey } from '../../src/golden/coverage.js';
import { INVENTORY_PATH, defaultRouteKeyOptions } from '../../src/golden/route-key-options.js';

/** Text read in place of the committed inventory while set. */
const inventoryText = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();
  const readFileSync = (...args: Parameters<typeof actual.readFileSync>) =>
    inventoryText.value !== undefined && String(args[0]).endsWith('/opt2/inventory/legacy-inventory.json')
      ? inventoryText.value
      : actual.readFileSync(...args);
  return { ...actual, readFileSync: readFileSync as typeof actual.readFileSync };
});

afterEach(() => {
  inventoryText.value = undefined;
  vi.resetModules();
});

const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')) as { routes: Array<{ routeKey: string | null }> };
/** Every inventoried remote-function key, `<api|rest>:<entity>.~<function>`; a `{variant}` key keys another spelling of the same call. */
const remoteFunctionKeys = inventory.routes.flatMap((route) =>
  route.routeKey?.includes('.~') === true && !route.routeKey.includes('{') ? [route.routeKey] : [],
);

describe('defaultRouteKeyOptions', () => {
  it('keeps the shared case sites and reads the inventory once', () => {
    const options = defaultRouteKeyOptions();
    expect(options.siteExists).toBe(routeKeyCaseOptions.siteExists);
    expect(defaultRouteKeyOptions().entityRemoteFunctions).toBe(options.entityRemoteFunctions);
  });

  it('finds remote-function keys in the inventory', () => {
    expect(remoteFunctionKeys.length).toBeGreaterThan(0);
  });

  it.each(remoteFunctionKeys)('keys the dotted call of %s as the inventory and the gateway do', (key) => {
    const [family = '', call = ''] = key.split(':');
    const [entity = '', name = ''] = call.split('.~');
    expect(defaultRouteKeyOptions().entityRemoteFunctions?.[entity]).toContain(name);
    const route = `/_api/${family === 'rest' ? 'rest' : 'json'}/v1/default/?method=${entity}.${name}`;
    expect(coverageRouteKey({ method: 'POST', route })).toBe(key);
  });

  it.each([
    ['no routes', { controllers: [] }],
    ['a route without a kind', { routes: [{ routeKey: 'api:comment.~flag' }] }],
    ['a route key that is not a string', { routes: [{ kind: 'api-entity-method', routeKey: 7 }] }],
  ])('throws a GoldenConfigError naming the inventory for %s', async (_label, doc) => {
    inventoryText.value = JSON.stringify(doc);
    vi.resetModules();
    const fresh = await import('../../src/golden/route-key-options.js');
    const { GoldenConfigError } = await import('../../src/golden/errors.js');
    let thrown: unknown;
    try {
      fresh.defaultRouteKeyOptions();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GoldenConfigError);
    expect(thrown).toMatchObject({ path: INVENTORY_PATH, message: expect.stringContaining(INVENTORY_PATH) });
  });
});
