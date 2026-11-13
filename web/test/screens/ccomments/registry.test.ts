// The ccomments circuit's registry contribution against ccomments.cfc and the legacy inventory.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import { ccommentsScreens } from '@/screens/ccomments';
import {
  ccommentsApprove,
  ccommentsDelete,
  ccommentsMarkAsSpam,
  ccommentsPurgeDeletedComments,
  ccommentsUnapprove,
} from '@/screens/ccomments/actions';
import { ccommentsAjax, ccommentsBulkEdit, ccommentsSingleEdit } from '@/screens/ccomments/ajax';
import { ccommentsDefault } from '@/screens/ccomments/default';
import { ccommentsLoadComments } from '@/screens/ccomments/loadcomments';
import { ccommentsLoadCommentsPage } from '@/screens/ccomments/loadcommentspage';
import { ccommentsGate } from '@/screens/ccomments/shared';
import { allScreens, findScreen, routeKeyOf, type ScreenDefinition, type ScreenMode } from '@/screens/registry';
import { useTestEnv } from '../../helpers/env';

const INVENTORY_URL = new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url);

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

/** A route key with the owner and response mode that serve it. */
interface Served {
  readonly routeKey: string;
  readonly owner: string | null;
  readonly mode: string | null;
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

const INVENTORY = adminRecords().filter((record) => record.routeKey.startsWith('admin:ccomments.'));

/** Legacy-cased FW/1 item, its definition and its inventoried mode, in registration order. */
const EXPECTED: ReadonlyArray<readonly [string, ScreenDefinition, ScreenMode]> = [
  ['default', ccommentsDefault, 'page'],
  ['loadComments', ccommentsLoadComments, 'fragment'],
  ['loadCommentsPage', ccommentsLoadCommentsPage, 'fragment'],
  ['ajax', ccommentsAjax, 'fragment'],
  ['bulkEdit', ccommentsBulkEdit, 'redirect'],
  ['singleEdit', ccommentsSingleEdit, 'redirect'],
  ['approve', ccommentsApprove, 'redirect'],
  ['unapprove', ccommentsUnapprove, 'redirect'],
  ['delete', ccommentsDelete, 'redirect'],
  ['markAsSpam', ccommentsMarkAsSpam, 'redirect'],
  ['purgeDeletedComments', ccommentsPurgeDeletedComments, 'redirect'],
];

const keyOf = (def: ScreenDefinition): string => normaliseRouteKey(routeKeyOf(def));

const byKey = <T extends { readonly routeKey: string }>(rows: readonly T[]): T[] =>
  rows.toSorted((a, b) => a.routeKey.localeCompare(b.routeKey));

const served = (def: ScreenDefinition): Served => ({ routeKey: keyOf(def), owner: def.owner, mode: def.mode });

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('ccommentsScreens', () => {
  it('contributes eleven entries with unique keys', () => {
    const keys = ccommentsScreens.map(keyOf);
    expect(keys).toHaveLength(11);
    expect(new Set(keys).size).toBe(11);
  });

  it.each(EXPECTED)('declares %s under the ccomments gate', (_action, def) => {
    expect(def).toMatchObject({ circuit: 'ccomments', owner: 'strategies-content' });
    expect(def.gate).toBe(ccommentsGate);
  });

  it('serves each key in its legacy mode', () => {
    const expected = EXPECTED.map(([action, , mode]) => ({
      routeKey: normaliseRouteKey(`admin:ccomments.${action}`),
      mode,
    }));
    const actual = ccommentsScreens.map((def) => ({ routeKey: keyOf(def), mode: def.mode }));
    expect(byKey(actual)).toEqual(byKey(expected));
  });

  it('matches the carried inventory entries', () => {
    const carried = INVENTORY.filter((record) => record.disposition === 'carry').map(
      (record): Served => ({ routeKey: record.routeKey, owner: record.owningService, mode: record.responseMode }),
    );
    expect(carried).not.toHaveLength(0);
    expect(byKey(ccommentsScreens.map(served))).toEqual(byKey(carried));
  });

  it('registers nothing the inventory does not carry', () => {
    const notCarried = new Set(INVENTORY.filter((r) => r.disposition !== 'carry').map((r) => r.routeKey));
    expect(ccommentsScreens.map(keyOf).filter((key) => notCarried.has(key))).toEqual([]);
  });

  it.each(EXPECTED.map(([action, def], index) => [action, def, index] as const))(
    'registers the %s export',
    (_action, def, index) => {
      expect(ccommentsScreens[index]).toBe(def);
    },
  );
});

describe('registry', () => {
  it.each(EXPECTED)('resolves %s in legacy and lower case', (action, def) => {
    expect(findScreen('cComments', action, {})).toBe(def);
    expect(findScreen('ccomments', action.toLowerCase(), {})).toBe(def);
  });

  it('lists exactly the circuit entries', () => {
    const listed = allScreens().filter((def) => def.circuit === 'ccomments');
    expect(listed).toHaveLength(ccommentsScreens.length);
    expect(listed.filter((def) => !ccommentsScreens.includes(def)).map(keyOf)).toEqual([]);
  });
});
