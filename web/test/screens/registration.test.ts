// The cUsers, cEditProfile, cCategory and cArch registry contributions against the inventory's carried route keys.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import { carchScreens } from '@/screens/carch';
import { carchGate } from '@/screens/carch/controller';
import { ccategoryScreens } from '@/screens/ccategory';
import { ceditprofileScreens } from '@/screens/ceditprofile';
import { cusersScreens } from '@/screens/cusers';
import type { ScreenDefinition, ScreenMode } from '@/screens/registry';

const INVENTORY_URL = new URL('../../../opt2/inventory/legacy-inventory.json', import.meta.url);
const EXCEPTIONS_URL = new URL('../../../opt2/exceptions-list.json', import.meta.url);

/** An admin action or variant record as the inventory stores it. */
interface InventoryVariant {
  readonly routeKey: string;
  readonly disposition: string | null;
  readonly responseMode: string | null;
  readonly owningService: string | null;
  readonly exceptionRef: string | null;
}

/** An exceptions-list entry as `opt2/exceptions-list.json` stores it. */
interface ExceptionEntry {
  readonly id: string;
  readonly status: string;
  readonly routeKey: string;
  readonly appliesTo?: readonly string[];
}

/** The normalised route keys of each halted exceptions-list entry, by entry id. */
function haltedExceptionKeys(): Map<string, Set<string>> {
  const { entries } = JSON.parse(readFileSync(EXCEPTIONS_URL, 'utf8')) as { entries: readonly ExceptionEntry[] };
  return new Map(
    entries
      .filter((entry) => entry.status === 'halted')
      .map((entry) => [entry.id, new Set([entry.routeKey, ...(entry.appliesTo ?? [])].map(normaliseRouteKey))] as const),
  );
}

interface InventoryController {
  readonly actions?: ReadonlyArray<{ readonly variants?: readonly InventoryVariant[] }>;
}

/** Every inventoried admin action and variant, keys normalised. */
function adminRecords(): InventoryVariant[] {
  const { controllers } = JSON.parse(readFileSync(INVENTORY_URL, 'utf8')) as {
    controllers: readonly InventoryController[];
  };
  return controllers
    .flatMap((controller) => (controller.actions ?? []).flatMap((action) => action.variants ?? []))
    .map((variant) => ({ ...variant, routeKey: normaliseRouteKey(variant.routeKey) }))
    .filter((variant) => variant.routeKey.startsWith('admin:'));
}

const RECORDS = adminRecords();

/** The normalised route key a definition registers, as the registry builds it. */
const keyOf = (def: ScreenDefinition): string =>
  normaliseRouteKey(`admin:${def.circuit}.${def.action}${def.variant === undefined ? '' : `{${def.variant.key}}`}`);

/** A circuit barrel and the keys it serves in another mode than the inventory records. */
interface BarrelCase {
  readonly circuit: string;
  readonly screens: readonly ScreenDefinition[];
  readonly modes: Readonly<Record<string, ScreenMode>>;
}

const CASES: readonly BarrelCase[] = [
  // `cusers.download` is served by the download handler although its view is inventoried as a page.
  { circuit: 'cusers', screens: cusersScreens, modes: { 'admin:cusers.download': 'download' } },
  { circuit: 'ceditprofile', screens: ceditprofileScreens, modes: {} },
  { circuit: 'ccategory', screens: ccategoryScreens, modes: {} },
];

describe.each(CASES)('$circuit barrel', ({ circuit, screens, modes }) => {
  const records = RECORDS.filter((record) => record.routeKey.startsWith(`admin:${circuit}.`));
  const carried = records.filter((record) => record.disposition === 'carry');

  it('registers exactly the carried inventory keys, each once', () => {
    const keys = screens.map(keyOf);
    expect(carried.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.toSorted()).toEqual(carried.map((record) => record.routeKey).toSorted());
  });

  it('serves each key in its inventoried mode and owner behind the controller before() gate', () => {
    for (const def of screens) {
      const record = carried.find((candidate) => candidate.routeKey === keyOf(def));
      expect(def.mode, keyOf(def)).toBe(modes[keyOf(def)] ?? record?.responseMode);
      expect(def.owner, keyOf(def)).toBe(record?.owningService);
      expect(typeof def.gate, keyOf(def)).toBe('function');
    }
  });
});

describe('carch barrel', () => {
  const carried = new Map(
    RECORDS.filter((record) => record.routeKey.startsWith('admin:carch.') && record.disposition === 'carry').map(
      (record) => [record.routeKey, record] as const,
    ),
  );
  // The carried keys no carch screen registers: those a halted exceptions-list entry keeps on legacy, and the approve
  // variant the variant-less `approvalaction` definition answers.
  const halted = [
    'admin:carch.cropimage',
    'admin:carch.flipimage',
    'admin:carch.multifileupload{upload=image}',
    'admin:carch.rotateimage',
  ];
  const answeredByBase: Readonly<Record<string, string>> = {
    'admin:carch.approvalaction{action=approve}': 'admin:carch.approvalaction',
  };
  const haltedByException = haltedExceptionKeys();
  // The object-params save writes its literal and aborts before any layout, so the raw handler serves it.
  const modes: Readonly<Record<string, ScreenMode>> = { 'admin:carch.updateobjectparams': 'json' };

  it('registers exactly the carried inventory keys but the halted and base-answered ones, each once', () => {
    const keys = carchScreens.map(keyOf);
    const required = [...carried.keys()].filter((key) => !halted.includes(key) && !Object.hasOwn(answeredByBase, key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.toSorted()).toEqual(required.toSorted());
  });

  it.each(halted)('leaves %s to the halted exceptions-list entry its inventory record names', (key) => {
    const ref = carried.get(key)?.exceptionRef;
    expect(ref, key).toBeTypeOf('string');
    expect(haltedByException.get(ref ?? '')?.has(key), key).toBe(true);
  });

  it.each(Object.entries(answeredByBase))('answers the carried %s with the registered %s', (variant, base) => {
    expect(carried.has(variant)).toBe(true);
    expect(carchScreens.map(keyOf)).toContain(base);
  });

  it('serves each key in its inventoried mode and owner behind the carch before() gate', () => {
    for (const def of carchScreens) {
      const record = carried.get(keyOf(def));
      expect(def.mode, keyOf(def)).toBe(modes[keyOf(def)] ?? record?.responseMode);
      expect(def.owner, keyOf(def)).toBe(record?.owningService);
      expect(def.gate, keyOf(def)).toBe(carchGate);
    }
  });
});
