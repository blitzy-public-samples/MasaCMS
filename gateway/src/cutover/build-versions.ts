// Generates the cut-over versions v0001-v0003 from the inventory, groups, exceptions and fixture status; CLI `cutover:versions`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normaliseRouteKey, routeKeyForEntryPoint } from '@opt2/platform/legacy-compat';
import { carryWriteEntries, createWriteClosure, legacyWriteExceptionKeys, lineDiff, type WriteClosure } from './build-groups.js';
import { CutoverSchemaError, FILE_STORE_TABLE, loadVersion } from './loader.js';
import { resolveGatewayPaths, type GatewayPaths } from './paths.js';
import { loadValidationContext, unpreventedWriters, validateVersion, type ValidationContext } from './validate.js';
import type {
  Authority,
  CutoverEntry,
  CutoverGroup,
  CutoverTable,
  Disposition,
  EntryKind,
  Finding,
  FixtureStatus,
  GroupsFile,
  OwnershipTarget,
  OwningService,
  RollbackRef,
} from './types.js';

/** The generated version ids, in chain order. */
export const VERSION_IDS = Object.freeze(['v0001', 'v0002', 'v0003'] as const);

/** One generated version id. */
export type VersionId = (typeof VERSION_IDS)[number];

/** Fixed `createdAt` of each generated version, so regeneration is byte-identical. */
export const VERSION_CREATED_AT: Readonly<Record<VersionId, string>> = Object.freeze({
  v0001: '2026-06-01T00:00:00.000Z',
  v0002: '2026-06-02T00:00:00.000Z',
  v0003: '2026-06-03T00:00:00.000Z',
});

/** Reconciliation report and evidence v0003 names for the roster rollback. */
export const ROLLBACK_REPORT = 'opt2/reports/reconciliation/rollback-before.json';
export const ROLLBACK_EVIDENCE = Object.freeze([
  'migration/runbooks/people-roster-rollback.md',
  ROLLBACK_REPORT,
  'opt2/reports/rollback-rehearsal.md',
]);

const ROSTER_ENTRIES: ReadonlySet<string> = new Set(
  [
    'admin:cusers.update{type=2,action=add}',
    'admin:cusers.update{type=2,action=update}',
    'fixture:people/persons/{id}/archive@post',
  ].map(normaliseRouteKey),
);
const ROSTER_UNITS: ReadonlySet<string> = new Set(['people.person_archive', 'timesheets.blackout']);

const OWNING_SERVICES: ReadonlySet<string> = new Set<OwningService>([
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
  'stub',
  'web',
  'gateway',
  'none',
]);

/** A synthetic module: its service, fixture module prefix and web module path segment. */
interface SyntheticModule {
  readonly service: OwningService;
  readonly fixture: string;
  readonly web: string;
}

const SYNTHETIC_MODULES: readonly SyntheticModule[] = [
  { service: 'communications', fixture: 'communications', web: 'communications' },
  { service: 'e-signature', fixture: 'esignature', web: 'e-signature' },
  { service: 'finance', fixture: 'finance', web: 'finance' },
  { service: 'reporting', fixture: 'reporting', web: 'reporting' },
  { service: 'surveys', fixture: 'surveys', web: 'surveys' },
  { service: 'timesheets', fixture: 'timesheets', web: 'timesheets' },
];

/** Bucket owners of the local signed-file routes; `fileStore` buckets hold Masa's file store (the tfiles units). */
const BUCKETS: ReadonlyArray<{ readonly bucket: string; readonly owner: OwningService; readonly fileStore: boolean }> = [
  { bucket: 'content-files', owner: 'strategies-content', fileStore: true },
  { bucket: 'esignature-documents', owner: 'e-signature', fileStore: false },
  { bucket: 'finance-attachments', owner: 'finance', fileStore: false },
  { bucket: 'reporting-exports', owner: 'reporting', fileStore: false },
];

const LEGACY_STATIC_PREFIXES = ['/admin/assets', '/core/vendor', '/core/modules'];
// Same test as the validator's fixture-backed units: tables in the fixture schemas only.
const FIXTURE_TABLE = /^(?:synthetic|program_\w+)\./i;
// A file name makes path families that key files (static) emit the path, so the glob takes the family live requests get.
const GLOB_PROBE = 'index.js';

/**
 * How an entry's state follows a version: `fixed` never changes; `cut-over` is legacy in the first version, then target;
 * `group` is its group's authority; `units` is target from the second version once every unit's group is target.
 */
type StateRule =
  | { readonly type: 'fixed'; readonly state: Authority }
  | { readonly type: 'cut-over' }
  | { readonly type: 'group'; readonly group: string }
  | { readonly type: 'units'; readonly units: readonly string[] };

/** An ownership target; `objectColumns` names the bucket each object column's bytes move to. */
type ObjectTarget = OwnershipTarget & { readonly objectColumns?: Readonly<Record<string, string>> };

/** An entry before a version stamps its state and tableVersion. */
interface PlannedEntry {
  readonly route: string;
  readonly owningService: OwningService;
  readonly kind: EntryKind;
  readonly group: string | null;
  readonly units: readonly string[];
  readonly disposition: Disposition;
  readonly rule: StateRule;
}

/** Inputs out of sync, or a built version the validator rejects. */
export class CutoverBuildError extends Error {
  override readonly name = 'CutoverBuildError';

  constructor(
    message: string,
    readonly findings: readonly Finding[] = [],
  ) {
    super(message);
  }
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(byCodeUnit);

/** Sorted ids of the roster group set R: groups holding a roster write entry or a seam unit. */
export function rosterGroupSet(groups: Pick<GroupsFile, 'groups'>): string[] {
  return sorted(
    groups.groups
      .filter(
        (group) =>
          group.writeEntries.some((key) => ROSTER_ENTRIES.has(normaliseRouteKey(key))) ||
          group.units.some((unit) => ROSTER_UNITS.has(unit)),
      )
      .map((group) => group.id),
  );
}

/** `<family>:<prefix>/**` for a path prefix, with the family route-key.ts gives paths under it. */
export function globRoute(prefix: string): string {
  const path = `${prefix}/${GLOB_PROBE}`;
  const { family, key } = routeKeyForEntryPoint({ kind: 'path', path });
  if (key !== `${family}:${normaliseRouteKey(path)}`) {
    throw new CutoverBuildError(`${prefix}: no path family keys ${path} (got ${key})`);
  }
  return `${family}:${normaliseRouteKey(prefix)}/**`;
}

function owningService(owner: string | null, route: string): OwningService {
  const service = owner ?? 'none';
  if (!OWNING_SERVICES.has(service)) {
    throw new CutoverBuildError(`${route}: owner ${service} is not a cut-over owning service`);
  }
  return service as OwningService;
}

/** Sorted write-closure units per normalised route key, and of every scheduled job over its steps. */
function keyClosures(ctx: ValidationContext, closure: WriteClosure): Map<string, string[]> {
  const units = new Map<string, Set<string>>();
  const add = (routeKey: string, written: readonly string[]): void => {
    const key = normaliseRouteKey(routeKey);
    units.set(key, new Set([...(units.get(key) ?? []), ...written]));
  };
  const { inventory } = ctx;
  for (const item of [
    ...inventory.controllers.flatMap((controller) => controller.actions.flatMap((action) => action.variants)),
    ...inventory.routes,
    ...inventory.frontEnd,
  ]) {
    if (item.routeKey !== null) add(item.routeKey, closure(item));
  }
  for (const job of inventory.scheduledJobs) add(job.routeKey, job.steps.flatMap((step) => closure(step)));
  return new Map([...units].map(([key, keyUnits]) => [key, sorted(keyUnits)]));
}

/** The generated group of each carried write key; inputs out of sync when a key is in no group or in several. */
function carriedGroups(carried: ReadonlyMap<string, readonly string[]>, groups: GroupsFile): Map<string, string> {
  const byKey = new Map<string, string[]>();
  for (const group of groups.groups) {
    for (const key of group.writeEntries.map(normaliseRouteKey)) byKey.set(key, [...(byKey.get(key) ?? []), group.id]);
  }
  const result = new Map<string, string>();
  for (const key of carried.keys()) {
    const ids = byKey.get(key) ?? [];
    const [id] = ids;
    if (ids.length !== 1 || id === undefined) {
      throw new CutoverBuildError(`carry write entry ${key} is in ${ids.length} groups of groups.json; rerun cutover:groups`);
    }
    result.set(key, id);
  }
  return result;
}

/** The entries every version shares, and the synthetic services' `/v1/` entries added from v0002 when fixtures are unavailable. */
interface EntryPlan {
  readonly shared: readonly PlannedEntry[];
  readonly synthetic: readonly PlannedEntry[];
  /** Groups a carried write entry or a synthetic `/v1/` entry writes. */
  readonly written: ReadonlySet<string>;
}

const LEGACY: StateRule = { type: 'fixed', state: 'legacy' };
const TARGET: StateRule = { type: 'fixed', state: 'target' };

/** One entry per inventoried key, and the generated group of each carried write key. */
function inventoriedEntries(ctx: ValidationContext): { entries: PlannedEntry[]; groupOf: Map<string, string> } {
  const closure = createWriteClosure(ctx.inventory, ctx.ownership);
  const carried = carryWriteEntries(ctx, closure);
  const groupOf = carriedGroups(carried, ctx.groups);
  const closures = keyClosures(ctx, closure);
  const heldBack = legacyWriteExceptionKeys(ctx.exceptions);
  const ownerUnits = new Map<string, string[]>();
  for (const { unit, owner } of ctx.ownership.units) ownerUnits.set(owner, sorted([...(ownerUnits.get(owner) ?? []), unit]));

  const entries = [...ctx.inventoryKeys].map(([route, facts]): PlannedEntry => {
    const owner = owningService(facts.owningService, route);
    const base = { route, owningService: owner, disposition: facts.disposition, group: null };
    if (facts.kindHint === 'job') return { ...base, kind: 'job', units: closures.get(route) ?? [], rule: { type: 'cut-over' } };
    if (facts.kindHint === 'static') return { ...base, kind: 'static', units: [], rule: LEGACY };
    const group = groupOf.get(route);
    if (group !== undefined) {
      return { ...base, kind: 'write', group, units: carried.get(route) ?? [], rule: { type: 'group', group } };
    }
    // Any recorded write, decision-list tables included, makes a non-carried key a legacy writer; its units open windows.
    if (facts.writeSet.length > 0) return { ...base, kind: 'legacy-write', units: closures.get(route) ?? [], rule: LEGACY };
    // The inventory records no read sets, so a read is taken to read every unit its owner holds.
    const units = ownerUnits.get(owner) ?? [];
    const movable = facts.disposition === 'carry' && owner !== 'none' && !heldBack.has(route);
    return { ...base, kind: 'read', units, rule: movable ? { type: 'units', units } : LEGACY };
  });
  return { entries, groupOf };
}

function nativeEntry(
  route: string,
  owningService: OwningService,
  kind: EntryKind,
  units: readonly string[],
  rule: StateRule,
  disposition: Disposition = 'carry',
): PlannedEntry {
  return { route, owningService, kind, group: null, units, disposition, rule };
}

/** Entries of OPT-2's own paths and the legacy static assets, which the inventory does not list. */
function nativeEntries(ctx: ValidationContext, inventoried: readonly PlannedEntry[]): PlannedEntry[] {
  const modules = SYNTHETIC_MODULES.flatMap((module) => {
    const prefix = `fixture:${module.fixture}/`;
    const carry = inventoried.filter((entry) => entry.route.startsWith(prefix) && entry.disposition === 'carry');
    const units = sorted(carry.flatMap((entry) => entry.units));
    const rule: StateRule = { type: 'units', units };
    return [
      nativeEntry(globRoute(`/opt2/admin/${module.web}`), 'web', 'read', units, rule),
      nativeEntry(globRoute(`/opt2/admin-actions/${module.web}`), 'web', 'write', [], rule),
    ];
  });
  const unitOwner = new Map(ctx.ownership.units.map((unit) => [unit.unit, unit.owner]));
  const targets: readonly ObjectTarget[] = ctx.ownership.tables.flatMap((table) => table.targets);
  const fileStoreUnits = ctx.ownership.tables
    .filter((table) => table.table.toLowerCase() === FILE_STORE_TABLE)
    .flatMap((table) => table.targets.map((target) => target.unit));
  const files = BUCKETS.map(({ bucket, owner, fileStore }) => {
    const objectUnits = targets.filter((target) => Object.values(target.objectColumns ?? {}).includes(bucket)).map((t) => t.unit);
    const units = sorted([...objectUnits, ...(fileStore ? fileStoreUnits : [])].filter((unit) => unitOwner.get(unit) === owner));
    return nativeEntry(globRoute(`/opt2/files/${bucket}`), owner, 'read', units, { type: 'units', units });
  });
  return [
    nativeEntry(globRoute('/opt2/stub'), 'stub', 'write', [], TARGET),
    nativeEntry(globRoute('/gateway/legacy-bridge'), 'gateway', 'static', [], TARGET),
    nativeEntry(globRoute('/_next'), 'web', 'static', [], TARGET),
    ...LEGACY_STATIC_PREFIXES.map((prefix) => nativeEntry(globRoute(prefix), 'none', 'static', [], LEGACY, 'legacy-served')),
    ...modules,
    ...files,
  ];
}

function planEntries(ctx: ValidationContext, fixturesAvailable: boolean): EntryPlan {
  const { entries, groupOf } = inventoriedEntries(ctx);
  const written = new Set(groupOf.values());
  const synthetic = fixturesAvailable ? [] : SYNTHETIC_MODULES.map((module) => syntheticEntry(ctx, module, written));
  for (const entry of synthetic) if (entry.group !== null) written.add(entry.group);
  return { shared: [...entries, ...nativeEntries(ctx, entries)], synthetic, written };
}

/**
 * A synthetic service's own `/v1/<fixture module>/**` entry for a fixtures-unavailable build; it names the service's one
 * fixture-backed group no carried entry writes, so those units move too, or no group, and fails when there are several.
 */
function syntheticEntry(ctx: ValidationContext, module: SyntheticModule, written: ReadonlySet<string>): PlannedEntry {
  const owners = new Map(ctx.ownership.units.map((unit) => [unit.unit, unit]));
  const fixtureBacked = (unit: string): boolean => {
    const owned = owners.get(unit);
    return owned?.owner === module.service && owned.legacyTables.length > 0 && owned.legacyTables.every((t) => FIXTURE_TABLE.test(t));
  };
  const unwritten = ctx.groups.groups.filter((group) => !written.has(group.id) && group.units.every(fixtureBacked));
  const route = globRoute(`/v1/${module.fixture}`);
  if (unwritten.length > 1) {
    throw new CutoverBuildError(`${route}: fixture-backed units span groups ${unwritten.map((group) => group.id).join(', ')}`);
  }
  const [group] = unwritten as [CutoverGroup?];
  return {
    route,
    owningService: module.service,
    kind: 'write',
    group: group?.id ?? null,
    units: group?.units ?? [],
    disposition: 'carry',
    rule: group === undefined ? { type: 'fixed', state: 'target' } : { type: 'group', group: group.id },
  };
}

/** Authority of every group, keys sorted. */
function authorities(groups: GroupsFile, authority: (group: CutoverGroup) => Authority): Record<string, Authority> {
  return Object.fromEntries(
    [...groups.groups].sort((a, b) => byCodeUnit(a.id, b.id)).map((group): [string, Authority] => [group.id, authority(group)]),
  );
}

function stateOf(
  rule: StateRule,
  first: boolean,
  groupAuthority: Readonly<Record<string, Authority>>,
  unitGroup: ReadonlyMap<string, string>,
): Authority {
  switch (rule.type) {
    case 'fixed':
      return rule.state;
    case 'cut-over':
      return first ? 'legacy' : 'target';
    case 'group':
      return groupAuthority[rule.group] ?? 'legacy';
    case 'units': {
      const target = (unit: string): boolean => groupAuthority[unitGroup.get(unit) ?? ''] === 'target';
      return !first && rule.units.every(target) ? 'target' : 'legacy';
    }
  }
}

function describeFinding(finding: Finding): string {
  return `${finding.rule} ${finding.route ?? finding.unit ?? finding.group ?? '-'} ${finding.message}`;
}

/** Builds v0001-v0003, each validated against its predecessor; throws `CutoverBuildError` rather than return an invalid version. */
export function buildVersions(ctx: ValidationContext, fixtures: Pick<FixtureStatus, 'available'>): CutoverTable[] {
  const plan = planEntries(ctx, fixtures.available);
  const unitGroup = new Map(ctx.groups.groups.flatMap((group) => group.units.map((unit): [string, string] => [unit, group.id])));
  const movable = (group: CutoverGroup): boolean =>
    plan.written.has(group.id) && group.units.every((unit) => unpreventedWriters(unit, ctx).length === 0);
  const v0002 = authorities(ctx.groups, (group) => (movable(group) ? 'target' : 'legacy'));
  const roster = rosterGroupSet(ctx.groups);
  const rollbackRefs: RollbackRef[] =
    roster.length === 0 ? [] : [{ groups: roster, rollbackSet: roster, report: ROLLBACK_REPORT, evidence: [...ROLLBACK_EVIDENCE] }];
  const specs: ReadonlyArray<{
    id: VersionId;
    groupAuthority: Record<string, Authority>;
    entries: readonly PlannedEntry[];
    rollbackRefs: RollbackRef[];
  }> = [
    { id: 'v0001', groupAuthority: authorities(ctx.groups, () => 'legacy'), entries: plan.shared, rollbackRefs: [] },
    { id: 'v0002', groupAuthority: v0002, entries: [...plan.shared, ...plan.synthetic], rollbackRefs: [] },
    {
      id: 'v0003',
      groupAuthority: authorities(ctx.groups, (group) => (roster.includes(group.id) ? 'legacy' : (v0002[group.id] ?? 'legacy'))),
      entries: [...plan.shared, ...plan.synthetic],
      rollbackRefs,
    },
  ];

  const base: ValidationContext = { ...ctx, mode: 'ci' };
  delete base.prior;
  const tables: CutoverTable[] = [];
  for (const spec of specs) {
    const prior = tables.at(-1);
    const previous = new Map((prior?.entries ?? []).map((entry) => [entry.route, entry]));
    const entries = spec.entries
      .map((planned): CutoverEntry => {
        const state = stateOf(planned.rule, prior === undefined, spec.groupAuthority, unitGroup);
        const before = previous.get(planned.route);
        return {
          route: planned.route,
          owningService: planned.owningService,
          tableVersion: before !== undefined && before.state === state ? before.tableVersion : spec.id,
          state,
          kind: planned.kind,
          group: planned.group,
          units: [...planned.units],
          disposition: planned.disposition,
        };
      })
      .sort((a, b) => byCodeUnit(a.route, b.route));
    const table: CutoverTable = {
      tableVersion: spec.id,
      previous: prior?.tableVersion ?? null,
      sourceSha: ctx.sourceSha,
      createdAt: VERSION_CREATED_AT[spec.id],
      groupAuthority: spec.groupAuthority,
      rollbackRefs: spec.rollbackRefs,
      entries,
    };
    const findings = validateVersion(table, prior === undefined ? base : { ...base, prior });
    if (findings.length > 0) {
      throw new CutoverBuildError(`${spec.id} fails validation:\n${findings.map(describeFinding).join('\n')}`, findings);
    }
    tables.push(table);
  }
  return tables;
}

/** The committed serialisation of a version file. */
export function serialiseVersion(table: CutoverTable): string {
  return `${JSON.stringify(table, null, 2)}\n`;
}

/** Whether a version serves a synthetic service's own `/v1/` routes, which only a fixtures-unavailable build does. */
export function servesSyntheticRoutes(table: CutoverTable): boolean {
  const services = new Set<string>(SYNTHETIC_MODULES.map((module) => module.service));
  const body = (route: string): string => route.slice(route.indexOf(':') + 1);
  return table.entries.some(
    (entry) => entry.state === 'target' && services.has(entry.owningService) && body(entry.route).startsWith('/v1/'),
  );
}

/** `--fixtures` value. */
export type FixturesMode = 'available' | 'unavailable' | 'auto';

/** Environment `main` reads for `--fixtures auto`. */
export interface BuildVersionsEnv {
  readonly OPT2_STATE_DIR?: string;
  readonly HOME?: string;
}

/** Output sinks, paths and environment of `main`. */
export interface BuildVersionsIo {
  readonly paths?: GatewayPaths;
  readonly env?: BuildVersionsEnv;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Fixture availability: `${OPT2_STATE_DIR}/fixtures.json`, else as the committed v0002 was built, else available. */
export async function resolveFixtures(mode: FixturesMode, paths: GatewayPaths, env: BuildVersionsEnv): Promise<boolean> {
  if (mode !== 'auto') return mode === 'available';
  const stateDir = env.OPT2_STATE_DIR ?? join(env.HOME ?? homedir(), '.opt2', 'state');
  const file = join(stateDir, 'fixtures.json');
  const status = await readIfPresent(file);
  if (status !== undefined) {
    const { available } = JSON.parse(status) as Partial<FixtureStatus>;
    if (typeof available !== 'boolean') throw new CutoverBuildError(`${file}: available must be true or false`);
    return available;
  }
  try {
    return !servesSyntheticRoutes(await loadVersion(paths, 'v0002'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

const USAGE = 'usage: build-versions.ts [--write] [--fixtures available|unavailable|auto]';
const FIXTURES_MODES: readonly string[] = ['available', 'unavailable', 'auto'];

/** Parsed options, or the usage error; `--write` may repeat, since the `cutover:versions` script already passes it. */
function parseArgs(argv: readonly string[]): { write: boolean; fixtures: FixturesMode } | string {
  let write = false;
  let fixtures: FixturesMode | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      write = true;
    } else if (arg === '--fixtures') {
      const value = argv[i + 1];
      if (fixtures !== undefined) return '--fixtures given twice';
      if (value === undefined || !FIXTURES_MODES.includes(value)) return '--fixtures needs available, unavailable or auto';
      fixtures = value as FixturesMode;
      i += 1;
    } else {
      return `unknown argument ${String(arg)}`;
    }
  }
  return { write, fixtures: fixtures ?? 'auto' };
}

/** CLI: diffs each built version against its file (exit 0 equal, 1 differ or invalid input), or writes them (`--write`); 2 on usage error. */
export async function main(argv: readonly string[], io: BuildVersionsIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const options = parseArgs(argv);
  if (typeof options === 'string') {
    stderr(`build-versions: ${options}\n${USAGE}`);
    return 2;
  }
  const paths = io.paths ?? resolveGatewayPaths();
  let tables: CutoverTable[];
  try {
    const available = await resolveFixtures(options.fixtures, paths, io.env ?? process.env);
    tables = buildVersions(await loadValidationContext(paths, 'ci'), { available });
  } catch (error) {
    if (!(error instanceof CutoverSchemaError || error instanceof CutoverBuildError)) throw error;
    stderr(`build-versions: ${error.message}`);
    return 1;
  }

  if (options.write) await mkdir(paths.versionsDir, { recursive: true });
  let differs = false;
  for (const table of tables) {
    const file = join(paths.versionsDir, `${table.tableVersion}.json`);
    const generated = serialiseVersion(table);
    if (options.write) {
      await writeFile(file, generated);
      stdout(`build-versions: wrote ${file}`);
      continue;
    }
    const committed = await readIfPresent(file);
    if (committed === generated) {
      stdout(`build-versions: ${file} is up to date`);
      continue;
    }
    differs = true;
    if (committed === undefined) {
      // A missing file differs in every line, so a whole-file diff of a version would add nothing to this line.
      stderr(`build-versions: ${file} does not exist; run with --write`);
      continue;
    }
    for (const line of lineDiff(committed, generated)) stdout(line);
    stderr(`build-versions: ${file} differs from the build; run with --write`);
  }
  return differs ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
