// Cut-over fixtures for gateway suites: entries, tables, groups and routing indexes without the generators, and a CutoverState double.
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LegacyServiceUnavailableError, normaliseRouteKey } from '@opt2/platform/legacy-compat';
import {
  buildRoutingIndex,
  loadGroups,
  loadSourcePin,
  loadTableOwnership,
  loadVariants,
  loadVersion,
} from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import { DEFAULT_FREEZE_WAIT_MS, type CutoverState, type CutoverStatus } from '../../src/cutover/state.js';
import type {
  Authority,
  CutoverEntry,
  CutoverGroup,
  CutoverTable,
  GroupsFile,
  OwnershipDoc,
  RollbackRef,
  RoutingIndex,
  VariantsFile,
} from '../../src/cutover/types.js';

/** A committed cut-over version. */
export type CommittedVersion = 'v0001' | 'v0002' | 'v0003';

// An empty env, so the committed cut-over directory is used whatever OPT2_CUTOVER_DIR the shell sets.
const COMMITTED = resolveGatewayPaths({});
const PLACEHOLDER_VERSION = 'v9001';
const DEFAULT_CREATED_AT = '2026-06-01T00:00:00.000Z';
const GENERATED_BY = 'gateway/test/helpers/versions.ts';
const PLACEHOLDER_SHA256 = '0'.repeat(64);
const POLL_MS = 10;

// The loaders are asynchronous; the pin and the small variants file are read once here so the builders below stay synchronous.
const [pin, committedVariantsFile] = await Promise.all([loadSourcePin(COMMITTED), loadVariants(COMMITTED)]);

/** The pinned source SHA, as `opt2/source-pin.json` records it. */
export const TEST_SOURCE_SHA: string = pin.sha;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byCodeUnit);
}

/** A cut-over entry with test defaults; `group` is `grp:<first unit>` for a write with units, else null. */
export function entry(partial: Partial<CutoverEntry> & { route: string }): CutoverEntry {
  const kind = partial.kind ?? 'read';
  const units = [...(partial.units ?? [])];
  const first = units[0];
  return {
    route: partial.route,
    owningService: partial.owningService ?? 'stub',
    tableVersion: partial.tableVersion ?? PLACEHOLDER_VERSION,
    state: partial.state ?? 'legacy',
    kind,
    group: partial.group !== undefined ? partial.group : kind === 'write' && first !== undefined ? `grp:${first}` : null,
    units,
    disposition: partial.disposition ?? 'carry',
  };
}

/** Fields of {@link cutoverTable}; omitted ones take test defaults. */
export interface CutoverTableInit {
  tableVersion: string;
  previous?: string | null;
  entries: CutoverEntry[];
  groupAuthority?: Record<string, Authority>;
  rollbackRefs?: RollbackRef[];
  createdAt?: string;
}

/** Authority of every group an entry names: `target` when one of its write entries is `target`, else `legacy`. */
function derivedGroupAuthority(entries: readonly CutoverEntry[]): Record<string, Authority> {
  const authority = new Map<string, Authority>();
  for (const { group, kind, state } of entries) {
    if (group === undefined || group === null) continue;
    if (kind === 'write' && state === 'target') authority.set(group, 'target');
    else if (!authority.has(group)) authority.set(group, 'legacy');
  }
  return Object.fromEntries([...authority].sort(([a], [b]) => byCodeUnit(a, b)));
}

/** A cut-over version bound to the pin, with every entry stamped with its `tableVersion`. */
export function cutoverTable(init: CutoverTableInit): CutoverTable {
  const { tableVersion, previous = null, groupAuthority, rollbackRefs = [], createdAt = DEFAULT_CREATED_AT } = init;
  const entries = init.entries.map((item) => ({ ...item, tableVersion, units: [...item.units] }));
  return {
    tableVersion,
    previous,
    sourceSha: TEST_SOURCE_SHA,
    createdAt,
    groupAuthority: groupAuthority ?? derivedGroupAuthority(entries),
    rollbackRefs,
    entries,
  };
}

/** One group of {@link groupsFile}; `writeEntries` defaults to none and `hasCarryWrite` to whether there are any. */
export type GroupInit = Partial<CutoverGroup> & { id: string; units: string[] };

/** A groups file bound to the pin, sorted as `build-groups.ts` sorts it. */
export function groupsFile(groups: readonly GroupInit[]): GroupsFile {
  return {
    sourceSha: TEST_SOURCE_SHA,
    generatedBy: GENERATED_BY,
    inputs: { inventorySha256: PLACEHOLDER_SHA256, tableOwnershipSha256: PLACEHOLDER_SHA256 },
    groups: groups
      .map((group): CutoverGroup => {
        const writeEntries = sortedUnique(group.writeEntries ?? []);
        return {
          id: group.id,
          units: sortedUnique(group.units),
          writeEntries,
          hasCarryWrite: group.hasCarryWrite ?? writeEntries.length > 0,
        };
      })
      .sort((a, b) => byCodeUnit(a.id, b.id)),
  };
}

/** One group per group id the table's entries name, with their units and the routes of its `write` entries. */
export function groupsForTable(table: CutoverTable): GroupsFile {
  const groups = new Map<string, { units: string[]; writeEntries: string[] }>();
  for (const item of table.entries) {
    if (item.group === undefined || item.group === null) continue;
    let group = groups.get(item.group);
    if (group === undefined) {
      group = { units: [], writeEntries: [] };
      groups.set(item.group, group);
    }
    group.units.push(...item.units);
    if (item.kind === 'write') group.writeEntries.push(item.route);
  }
  return groupsFile([...groups].map(([id, group]) => ({ id, ...group })));
}

/** The committed `variants.json`. */
export function committedVariants(): VariantsFile {
  return committedVariantsFile;
}

/** The real routing index of `table`, over its own groups and the committed variants unless given. */
export function indexFor(table: CutoverTable, groups?: GroupsFile, variants?: VariantsFile): RoutingIndex {
  return buildRoutingIndex(table, variants ?? committedVariants(), groups ?? groupsForTable(table));
}

const committedTables = new Map<CommittedVersion, Promise<CutoverTable>>();
const committedIndexes = new Map<CommittedVersion, Promise<RoutingIndex>>();
let committedGroupsFile: Promise<GroupsFile> | undefined;
let committedOwnership: Promise<OwnershipDoc> | undefined;

/** A committed version, read and schema-validated by the real loader once per process. */
export function committedTable(version: CommittedVersion): Promise<CutoverTable> {
  let table = committedTables.get(version);
  if (table === undefined) {
    table = loadVersion(COMMITTED, version);
    committedTables.set(version, table);
  }
  return table;
}

/** The committed `groups.json`, validated against the pin and the table ownership. */
export function committedGroups(): Promise<GroupsFile> {
  committedGroupsFile ??= loadGroups(COMMITTED);
  return committedGroupsFile;
}

/** The routing index of a committed version over the committed groups and variants. */
export function committedIndex(version: CommittedVersion): Promise<RoutingIndex> {
  let index = committedIndexes.get(version);
  if (index === undefined) {
    index = Promise.all([committedTable(version), committedGroups()]).then(([table, groups]) =>
      buildRoutingIndex(table, committedVariantsFile, groups),
    );
    committedIndexes.set(version, index);
  }
  return index;
}

/** `groups` plus a singleton group for every ownership unit it leaves out, so `loadGroups` finds a full partition. */
async function partitioned(groups: GroupsFile): Promise<GroupsFile> {
  committedOwnership ??= loadTableOwnership(COMMITTED);
  const { units } = await committedOwnership;
  const grouped = new Set(groups.groups.flatMap((group) => group.units));
  const singletons = units.filter(({ unit }) => !grouped.has(unit)).map(({ unit }) => ({ id: `grp:${unit}`, units: [unit] }));
  return groupsFile([...groups.groups, ...singletons]);
}

/** Settings of {@link writeCutoverDir}. */
export interface WriteCutoverDirOptions {
  groups?: GroupsFile;
  variants?: VariantsFile;
  extraTables?: CutoverTable[];
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Writes a temporary cut-over directory holding `table` and `extraTables`, for use as `OPT2_CUTOVER_DIR`; the caller removes it.
 * Without `groups`, groups.json is `groupsForTable(table)` completed with singleton groups for the remaining ownership units,
 * because the real cut-over state reads it through `loadGroups`, which rejects a file that does not partition every unit.
 */
export async function writeCutoverDir(table: CutoverTable, opts: WriteCutoverDirOptions = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'opt2-gateway-cutover-'));
  const paths = resolveGatewayPaths({ OPT2_CUTOVER_DIR: dir });
  const groups = opts.groups ?? (await partitioned(groupsForTable(table)));
  await mkdir(paths.versionsDir);
  await Promise.all([
    copyFile(COMMITTED.schemaFile, paths.schemaFile),
    writeJson(paths.variantsFile, opts.variants ?? committedVariantsFile),
    writeJson(paths.groupsFile, groups),
    ...[table, ...(opts.extraTables ?? [])].map((version) =>
      writeJson(path.join(paths.versionsDir, `${version.tableVersion}.json`), version),
    ),
  ]);
  return dir;
}

/** A CutoverState double over a fixed routing index, with setters for its index and epoch. */
export interface FakeCutoverState extends CutoverState {
  setIndex(index: RoutingIndex | undefined): void;
  setEpoch(epoch: number): void;
  /** Frozen route keys, normalised and sorted. */
  frozenRoutes(): string[];
  readonly calls: { readEpochForWrite: number };
}

/** Settings of {@link fakeCutoverState}. */
export interface FakeCutoverStateOptions {
  /** Defaults to 1 with an index, else 0. */
  epoch?: number;
  frozen?: readonly string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** A CutoverState that serves `index` from memory; freezes bump the epoch, and `activate` always rejects. */
export function fakeCutoverState(index: RoutingIndex | undefined, opts: FakeCutoverStateOptions = {}): FakeCutoverState {
  let current = index;
  let epoch = opts.epoch ?? (index === undefined ? 0 : 1);
  const frozen = new Set((opts.frozen ?? []).map(normaliseRouteKey));
  const calls = { readEpochForWrite: 0 };
  const frozenRoutes = (): string[] => [...frozen].sort(byCodeUnit);

  const status = (): CutoverStatus => ({
    tableVersion: current?.table.tableVersion ?? null,
    previous: current?.table.previous ?? null,
    epoch,
    groupAuthority: { ...(current?.table.groupAuthority ?? {}) },
    frozen: frozenRoutes(),
    instances: [],
    acknowledgedEpoch: null,
    inflight: [],
    sessionMode: current?.loginGroupAuthority() === 'target' ? 'target-primary' : 'legacy-primary',
  });

  const changeFreezes = (op: 'freeze' | 'unfreeze', routes: readonly string[]): Promise<CutoverStatus> => {
    for (const route of routes) {
      if (op === 'freeze') frozen.add(normaliseRouteKey(route));
      else frozen.delete(normaliseRouteKey(route));
    }
    epoch += 1;
    return Promise.resolve(status());
  };

  return {
    calls,
    setIndex: (next) => {
      current = next;
    },
    setEpoch: (next) => {
      epoch = next;
    },
    frozenRoutes,
    start: () => Promise.resolve(),
    stop: () => undefined,
    active: () => current,
    epoch: () => epoch,
    async readEpochForWrite() {
      calls.readEpochForWrite += 1;
      if (current === undefined) {
        throw new LegacyServiceUnavailableError('No cut-over version is active', 'auto', 'no-active-version');
      }
      return { epoch, index: current };
    },
    isFrozen: (route) => frozen.has(normaliseRouteKey(route)),
    async waitUnfrozen(route, ms = DEFAULT_FREEZE_WAIT_MS) {
      const key = normaliseRouteKey(route);
      const deadline = Date.now() + ms;
      while (frozen.has(key)) {
        const left = deadline - Date.now();
        if (left <= 0) return false;
        await sleep(Math.min(POLL_MS, left));
      }
      return true;
    },
    activate: () =>
      Promise.reject(new Error('fakeCutoverState cannot activate versions; use createCutoverState over the gateway db double')),
    freeze: (routes) => changeFreezes('freeze', routes),
    unfreeze: (routes) => changeFreezes('unfreeze', routes),
    awaitVisible: () => Promise.resolve(true),
    status: () => Promise.resolve(status()),
  };
}
