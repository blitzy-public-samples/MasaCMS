// The people-roster rollback group set R, recomputed from groups.json and checked against the committed rollback version.
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';

import type { MigrationContext } from '../context.js';
import { loadGroups, loadVersion, loginGroup, type CutoverVersion, type GroupsFile } from '../cutover/index.js';

/** Which side issues the browser session cookies, decided by the identity login group's authority. */
export type SessionMode = 'legacy-primary' | 'target-primary';

/** Version the rollback leaves. */
export const ROLLBACK_FROM_VERSION = 'v0002';

/** Version that returns R to legacy. */
export const ROLLBACK_VERSION = 'v0003';

/** The rollback group set R with its units and the session modes on each side of the rollback. */
export interface RollbackSet {
  /** Sorted group ids of R. */
  groups: string[];
  /** Sorted units of the groups in R. */
  units: string[];
  containsLoginGroup: boolean;
  sessionModeBefore: SessionMode;
  sessionModeAfter: SessionMode;
}

/** Inputs of {@link deriveRollbackSet}: the groups file, both versions and the configured roster route keys and units. */
export interface DeriveRollbackSetInput {
  groups: GroupsFile;
  from: CutoverVersion;
  to: CutoverVersion;
  routeKeys: readonly string[];
  units: readonly string[];
}

/** The rollback version's rollbackRefs or group authority disagree with the recomputed R. */
export class RollbackSetMismatchError extends Error {
  override readonly name = 'RollbackSetMismatchError';
  readonly exitCode = 1;

  constructor(
    message: string,
    readonly computed: string[],
    readonly rollbackRefGroups: string[],
    readonly returnedToLegacy: string[],
  ) {
    super(message);
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function without(values: readonly string[], removed: readonly string[]): string[] {
  const drop = new Set(removed);
  return values.filter((value) => !drop.has(value));
}

function listed(ids: readonly string[]): string {
  return ids.length === 0 ? 'none' : ids.join(', ');
}

/** `missing …; extra …` of `actual` against `expected`, or `undefined` when both hold the same ids. */
function setDifference(expected: readonly string[], actual: readonly string[]): string | undefined {
  const missing = without(expected, actual);
  const extra = without(actual, expected);
  if (missing.length === 0 && extra.length === 0) return undefined;
  return `missing ${listed(missing)}; extra ${listed(extra)}`;
}

/** Computes R from the groups and checks it against `to`'s rollbackRefs and the groups `to` returns to legacy; pure. */
export function deriveRollbackSet(input: DeriveRollbackSetInput): RollbackSet {
  const { groups, from, to } = input;
  // Route keys compare in normaliseRouteKey form, the rule loginGroup and the gateway's roster set also apply.
  const routeKeys = new Set(input.routeKeys.map(normaliseRouteKey));
  const units = new Set(input.units);
  const members = groups.groups.filter(
    (group) =>
      group.writeEntries.some((route) => routeKeys.has(normaliseRouteKey(route))) || group.units.some((unit) => units.has(unit)),
  );
  const computed = sortedUnique(members.map((group) => group.id));

  const rollbackRefGroups = sortedUnique(to.rollbackRefs.flatMap((ref) => ref.groups));
  const returnedToLegacy = sortedUnique(
    Object.keys(to.groupAuthority).filter((id) => from.groupAuthority[id] === 'target' && to.groupAuthority[id] === 'legacy'),
  );
  // An R group `from` already keeps legacy has nothing to return, so only R's target-authoritative groups must show as
  // returned; every R group must still end legacy in `to`.
  const expectedReturned = computed.filter((id) => from.groupAuthority[id] === 'target');
  const notLegacyAfter = computed.filter((id) => to.groupAuthority[id] !== 'legacy');

  const refsDiff = setDifference(computed, rollbackRefGroups);
  const returnedDiff = setDifference(expectedReturned, returnedToLegacy);
  if (refsDiff !== undefined || returnedDiff !== undefined || notLegacyAfter.length > 0) {
    const problems = [
      refsDiff === undefined ? undefined : `${to.tableVersion} rollbackRefs groups: ${refsDiff}`,
      returnedDiff === undefined ? undefined : `groups returned to legacy from ${from.tableVersion}: ${returnedDiff}`,
      notLegacyAfter.length === 0 ? undefined : `R groups not legacy-authoritative in ${to.tableVersion}: ${listed(notLegacyAfter)}`,
    ].filter((problem) => problem !== undefined);
    throw new RollbackSetMismatchError(
      [`${to.tableVersion} disagrees with the roster rollback set R (${listed(computed)})`, ...problems.map((p) => `  ${p}`)].join('\n'),
      computed,
      rollbackRefGroups,
      returnedToLegacy,
    );
  }

  const login = loginGroup(groups);
  const sessionMode = (version: CutoverVersion): SessionMode =>
    login !== undefined && version.groupAuthority[login.id] === 'target' ? 'target-primary' : 'legacy-primary';

  return {
    groups: computed,
    units: sortedUnique(members.flatMap((group) => group.units)),
    containsLoginGroup: login !== undefined && computed.includes(login.id),
    sessionModeBefore: sessionMode(from),
    sessionModeAfter: sessionMode(to),
  };
}

/** Loads groups.json, the rollback's two versions and the configured roster keys, and derives R from them. */
export function computeRollbackSet(ctx: Pick<MigrationContext, 'config'>): RollbackSet {
  const { paths, rollbackSet } = ctx.config;
  return deriveRollbackSet({
    groups: loadGroups(paths.groupsFile),
    from: loadVersion(paths.cutoverDir, ROLLBACK_FROM_VERSION),
    to: loadVersion(paths.cutoverDir, ROLLBACK_VERSION),
    routeKeys: rollbackSet.routeKeys,
    units: rollbackSet.units,
  });
}
