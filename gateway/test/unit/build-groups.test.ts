// Tests the committed groups.json against the grouping rules applied to the committed inventory's carry closures.
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  carryWriteEntries,
  createWriteClosure,
  loadBuildGroupsInput,
  type BuildGroupsInput,
  type WriteClosure,
} from '../../src/cutover/build-groups.js';
import { loadGroups } from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import type { CutoverGroup, GroupsFile, InventoryActionVariant } from '../../src/cutover/types.js';

// The rule cases on hand-built inventories, byte equality and sorting are in test/cutover/build-groups.test.ts.

const LOGIN = 'admin:clogin.login';
const CREDENTIAL = 'identity.credential';
const UPGRADE = { component: 'core/mura/user/userUtility.cfc', method: 'lookupByCredentials', call: 'userDAO.savePassword' };
const paths = resolveGatewayPaths({});

let input: BuildGroupsInput;
let closure: WriteClosure;
let entries: Map<string, string[]>;
let committed: GroupsFile;

beforeAll(async () => {
  [input, committed] = await Promise.all([loadBuildGroupsInput(paths), loadGroups(paths)]);
  closure = createWriteClosure(input.inventory, input.ownership);
  entries = carryWriteEntries(input, closure);
});

/** Units connected to `start` by shared closures and joining-unit anchors, sorted. */
function component(start: string, links: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const seen = new Set([start]);
  for (const unit of seen) for (const next of links.get(unit) ?? []) seen.add(next);
  return [...seen].sort();
}

describe('committed groups.json', () => {
  it('lists each carry write entry in the one group holding its whole closure, and only entries touching that group', () => {
    const groupOf = new Map(committed.groups.flatMap((group) => group.units.map((unit) => [unit, group] as const)));
    for (const [key, units] of entries) {
      const holders = new Set(units.map((unit) => groupOf.get(unit)?.id));
      expect([...holders], key).toHaveLength(1);
      expect(groupOf.get(units[0] as string)?.writeEntries, key).toContain(key);
    }
    for (const group of committed.groups) {
      const touching = [...entries].filter(([, units]) => units.some((unit) => group.units.includes(unit))).map(([key]) => key);
      expect(group.writeEntries, group.id).toEqual(touching);
    }
  });

  it('joins no units beyond those carry closures, carried job steps and joining units connect', () => {
    const links = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      for (const [from, to] of [[a, b], [b, a]] as const) links.set(from, (links.get(from) ?? new Set<string>()).add(to));
    };
    const steps = input.inventory.scheduledJobs.flatMap((job) => job.steps).filter((step) => step.disposition === 'carry');
    for (const units of [...entries.values(), ...steps.map(closure)]) for (const unit of units.slice(1)) link(units[0] as string, unit);
    for (const { unit, joinsUnit } of input.ownership.units) if (joinsUnit !== undefined) link(unit, joinsUnit);
    for (const group of committed.groups) expect(component(group.units[0] as string, links), group.id).toEqual(group.units);
  });

  it('never lists a key that a legacy-served, withheld or retired inventory item bears', () => {
    const { controllers, routes, frontEnd } = input.inventory;
    const items = [...controllers.flatMap((c) => c.actions.flatMap((a) => a.variants)), ...routes, ...frontEnd];
    const heldBack = new Set(
      items.flatMap((item) => (item.disposition !== 'carry' && item.routeKey !== null ? [normaliseRouteKey(item.routeKey)] : [])),
    );
    const listed = committed.groups.flatMap((group) => group.writeEntries);
    expect(heldBack.size).toBeGreaterThan(0);
    expect(listed.filter((key) => heldBack.has(key))).toEqual([]);
  });

  it('legacy-hash upgrade never joins identity.credential to the login group; only other carry writers of it can', () => {
    const upgradeWriter = input.inventory.tables
      .flatMap((table) => table.writers)
      .find((writer) => writer.component === UPGRADE.component && writer.method === UPGRADE.method);
    expect(upgradeWriter?.routeKeys.map((key) => normaliseRouteKey(key)) ?? []).toContain(LOGIN);

    const login = input.inventory.controllers
      .flatMap((c) => c.actions.flatMap((a) => a.variants))
      .find((variant) => normaliseRouteKey(variant.routeKey) === LOGIN);
    expect(login?.disposition).toBe('carry');
    const upgradeWrite = login?.writeSet.find((write) => write.unit === CREDENTIAL && write.via.includes(UPGRADE.call));
    expect(upgradeWrite?.via ?? []).toContain(`userUtility.${UPGRADE.method}`);
    expect(closure(login as InventoryActionVariant)).not.toContain(CREDENTIAL);
    expect(entries.get(LOGIN)).not.toContain(CREDENTIAL);

    const loginGroups = committed.groups.filter((group) => group.writeEntries.includes(LOGIN));
    expect(loginGroups).toHaveLength(1);
    const loginGroup = loginGroups[0] as CutoverGroup;
    const credentialWriters = [...entries].filter(([, units]) => units.includes(CREDENTIAL)).map(([key]) => key);
    expect(credentialWriters).not.toContain(LOGIN);
    // The roster writers may join identity.credential to the login group; login's own closure never does.
    expect(loginGroup.units.includes(CREDENTIAL)).toBe(credentialWriters.some((key) => loginGroup.writeEntries.includes(key)));
  });
});
