// Read-only model of the gateway's committed cut-over versions and groups, and the authority and transition sets they imply.
import { readFileSync } from 'node:fs';

import { normaliseRouteKey } from '@opt2/platform/legacy-compat';

import { cutoverVersionFile } from '../paths.js';

/** Write authority of a unit, and routing state of an entry. */
export type Authority = 'legacy' | 'target';

/** Kind of a cut-over entry. */
export type EntryKind = 'read' | 'write' | 'legacy-write' | 'job' | 'static';

/** Inventory disposition copied onto an entry. */
export type Disposition = 'retired' | 'carry' | 'legacy-served' | 'decision';

/** One route of a cut-over version. */
export interface CutoverEntry {
  /** Canonical lower-case route key, including any variant. */
  route: string;
  owningService: string;
  /** Version that last changed this entry. */
  tableVersion: string;
  state: Authority;
  kind: EntryKind;
  /** Group id for a `write` entry with units; otherwise `null` or absent. */
  group?: string | null;
  /** Target-table units `<schema>.<table>` the entry reads or writes. */
  units: string[];
  disposition: Disposition;
}

/** Rollback evidence for the groups a version returns to `legacy`. */
export interface RollbackRef {
  groups: string[];
  rollbackSet: string[];
  /** Zero-difference reconciliation report the return relies on. */
  report: string;
  evidence: string[];
}

/** One immutable `versions/vNNNN.json` file. */
export interface CutoverVersion {
  tableVersion: string;
  previous: string | null;
  sourceSha: string;
  createdAt: string;
  groupAuthority: Record<string, Authority>;
  rollbackRefs: RollbackRef[];
  entries: CutoverEntry[];
}

/** One generated cut-over group. */
export interface CutoverGroup {
  id: string;
  units: string[];
  /** Route keys of the carry entry points writing any of the group's units. */
  writeEntries: string[];
  hasCarryWrite: boolean;
}

/** `gateway/cutover/groups.json`. */
export interface GroupsFile {
  sourceSha: string;
  generatedBy?: string;
  inputs?: Record<string, string>;
  groups: CutoverGroup[];
}

/** An entry whose state differs between two versions. */
export interface ChangedEntry {
  route: string;
  /** State in the active version; `null` when the route is absent there. */
  from: Authority | null;
  /** State in the proposed version; `null` when the route is absent there. */
  to: Authority | null;
  /** The proposed entry, or the active one when the route was removed. */
  entry: CutoverEntry;
}

/** Transition set between an active and a proposed version; sets iterate in sorted order. */
export interface VersionDiff {
  /** Units whose authority changes. */
  changedUnits: Set<string>;
  toTarget: Set<string>;
  toLegacy: Set<string>;
  /** Sorted by route. */
  changedEntries: ChangedEntry[];
  /** `legacy-write` entries of the proposed version touching a changed unit, sorted by route. */
  legacyWritesMeetingT: CutoverEntry[];
}

/** Cut-over data that contradicts itself or its file name. */
export class CutoverDataError extends Error {
  override readonly name = 'CutoverDataError';
}

/** Route key of the admin login action, whose group decides the session mode. */
export const LOGIN_ROUTE_KEY = 'admin:clogin.login';

function byRoute(a: CutoverEntry | ChangedEntry, b: CutoverEntry | ChangedEntry): number {
  if (a.route === b.route) return 0;
  return a.route < b.route ? -1 : 1;
}

/** Reads `<cutoverDir>/versions/<v>.json`; `cutoverDir` must be absolute. */
export function loadVersion(cutoverDir: string, v: string): CutoverVersion {
  const file = cutoverVersionFile(cutoverDir, v);
  const version = JSON.parse(readFileSync(file, 'utf8')) as CutoverVersion;
  if (version.tableVersion !== v) {
    throw new CutoverDataError(`${file} declares tableVersion "${version.tableVersion}", expected "${v}"`);
  }
  return version;
}

/** Reads the groups file at the given absolute path. */
export function loadGroups(groupsFile: string): GroupsFile {
  return JSON.parse(readFileSync(groupsFile, 'utf8')) as GroupsFile;
}

/** Authority of every unit of every group under `version`, in groups-file order. */
export function unitAuthority(version: CutoverVersion, groups: GroupsFile): Map<string, Authority> {
  const authority = new Map<string, Authority>();
  const groupOfUnit = new Map<string, string>();
  for (const group of groups.groups) {
    const groupAuthority = version.groupAuthority[group.id];
    if (groupAuthority === undefined) {
      throw new CutoverDataError(`Version ${version.tableVersion} has no groupAuthority for group ${group.id}`);
    }
    for (const unit of group.units) {
      const other = groupOfUnit.get(unit);
      if (other !== undefined) throw new CutoverDataError(`Unit ${unit} is in both group ${other} and group ${group.id}`);
      groupOfUnit.set(unit, group.id);
      authority.set(unit, groupAuthority);
    }
  }
  return authority;
}

/** Entries the version routes to legacy. */
export function legacyBoundEntries(version: CutoverVersion): CutoverEntry[] {
  return version.entries.filter((entry) => entry.state === 'legacy');
}

/** Entries of kind `legacy-write`. */
export function legacyWriteEntries(version: CutoverVersion): CutoverEntry[] {
  return version.entries.filter((entry) => entry.kind === 'legacy-write');
}

/** Entries reading or writing any of `units`. */
export function entriesTouching(version: CutoverVersion, units: Iterable<string>): CutoverEntry[] {
  const wanted = new Set(units);
  return version.entries.filter((entry) => entry.units.some((unit) => wanted.has(unit)));
}

/** The group whose write entries include the admin login action. */
export function loginGroup(groups: GroupsFile): CutoverGroup | undefined {
  const login = normaliseRouteKey(LOGIN_ROUTE_KEY);
  return groups.groups.find((group) => group.writeEntries.some((route) => normaliseRouteKey(route) === login));
}

/** Units, entries and `legacy-write` entries a transition from `active` to `proposed` changes. */
export function diffVersions(active: CutoverVersion, proposed: CutoverVersion, groups: GroupsFile): VersionDiff {
  const before = unitAuthority(active, groups);
  const after = unitAuthority(proposed, groups);
  const changed = [...after]
    .filter(([unit, authority]) => before.get(unit) !== authority)
    .map(([unit]) => unit)
    .sort();
  const changedUnits = new Set(changed);

  const activeByRoute = new Map(active.entries.map((entry) => [entry.route, entry]));
  const proposedRoutes = new Set(proposed.entries.map((entry) => entry.route));
  const changedEntries: ChangedEntry[] = [];
  for (const entry of proposed.entries) {
    const from = activeByRoute.get(entry.route)?.state ?? null;
    if (from !== entry.state) changedEntries.push({ route: entry.route, from, to: entry.state, entry });
  }
  for (const entry of active.entries) {
    if (!proposedRoutes.has(entry.route)) changedEntries.push({ route: entry.route, from: entry.state, to: null, entry });
  }

  return {
    changedUnits,
    toTarget: new Set(changed.filter((unit) => after.get(unit) === 'target')),
    toLegacy: new Set(changed.filter((unit) => after.get(unit) === 'legacy')),
    changedEntries: changedEntries.sort(byRoute),
    legacyWritesMeetingT: legacyWriteEntries(proposed)
      .filter((entry) => entry.units.some((unit) => changedUnits.has(unit)))
      .sort(byRoute),
  };
}
