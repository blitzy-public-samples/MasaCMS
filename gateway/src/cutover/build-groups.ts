// Derives the write-authority groups of gateway/cutover/groups.json from inventory write closures and ownership units.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diff } from 'node:util';
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import {
  CutoverSchemaError,
  DECISION_TABLE_PREFIX,
  FILE_STORE,
  FILE_STORE_TABLE,
  loadExceptionsList,
  loadSourcePin,
  parseInventory,
  parseTableOwnership,
} from './loader.js';
import { resolveGatewayPaths, type GatewayPaths } from './paths.js';
import type {
  CutoverGroup,
  Disposition,
  ExceptionsDoc,
  GroupsFile,
  InventoryDoc,
  InventoryWrite,
  InventoryWriter,
  OwnershipDoc,
  OwnershipTarget,
} from './types.js';

/** `generatedBy` of groups.json. */
export const GENERATED_BY = 'gateway/src/cutover/build-groups.ts';

// Identity's legacy-hash upgrade at login (userUtility.cfc:168-173, the savePassword call at 172) never joins
// identity.credential to a group: identity performs the upgrade only while that unit is target-authoritative.
const LEGACY_HASH_UPGRADE = Object.freeze({
  component: 'core/mura/user/userUtility.cfc',
  method: 'lookupByCredentials',
  lines: Object.freeze([168, 173] as const),
  call: 'userDAO.savePassword',
  unit: 'identity.credential',
});

/** Parsed opt2 inputs of `buildGroups`, with the SHA-256 of the committed inventory and ownership bytes. */
export interface BuildGroupsInput {
  readonly sourceSha: string;
  readonly inventory: InventoryDoc;
  readonly ownership: OwnershipDoc;
  readonly exceptions: ExceptionsDoc;
  readonly inputs: GroupsFile['inputs'];
}

/** An item whose write closure is resolved; without `writeSet` the closure comes from the `tables[].writers[]` of its key. */
export interface ClosureItem {
  readonly id?: string;
  readonly routeKey?: string | null;
  readonly writeSet?: readonly InventoryWrite[];
}

/** Sorted units an item's write closure writes. */
export type WriteClosure = (item: ClosureItem) => string[];

/** A route-bearing inventoried item: admin action variant, route or front-end entry. */
type RouteItem = ClosureItem & { readonly id: string; readonly routeKey: string | null; readonly disposition: Disposition };

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function overlaps(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/** Whether a call path has `caller` directly calling `callee`. */
function calls(via: readonly string[], caller: string, callee: string): boolean {
  return via.some((step, i) => step === caller && via[i + 1] === callee);
}

interface UpgradeWriter {
  readonly record: InventoryWriter;
  readonly covers: (write: InventoryWrite) => boolean;
}

/** The inventory's legacy-hash upgrade writer and a test for the closure writes it contributes to identity.credential. */
function legacyHashUpgrade(inventory: InventoryDoc): UpgradeWriter | undefined {
  const record = inventory.tables
    .flatMap((table) => table.writers)
    .find(
      (writer) =>
        writer.component === LEGACY_HASH_UPGRADE.component &&
        writer.method === LEGACY_HASH_UPGRADE.method &&
        overlaps(writer.source.lines, LEGACY_HASH_UPGRADE.lines),
    );
  if (record === undefined) return undefined;
  const caller = `${basename(record.component, '.cfc')}.${record.method}`;
  return {
    record,
    // Closures record the write at the upgrade itself (writer overrides) or at the DAO statement it calls.
    covers: (write) =>
      write.unit === LEGACY_HASH_UPGRADE.unit &&
      ((write.source.path === record.source.path && overlaps(write.source.lines, record.source.lines)) ||
        calls(write.via, caller, LEGACY_HASH_UPGRADE.call)),
  };
}

/** Builds the write-closure resolver shared by the group and version generators. */
export function createWriteClosure(inventory: InventoryDoc, ownership: OwnershipDoc): WriteClosure {
  const units = new Set(ownership.units.map((unit) => unit.unit));
  const targetsByTable = new Map<string, readonly OwnershipTarget[]>(
    ownership.tables.map((table) => [table.table.toLowerCase(), table.targets]),
  );
  const fileStoreUnits = (targetsByTable.get(FILE_STORE_TABLE) ?? []).map((target) => target.unit);
  const upgrade = legacyHashUpgrade(inventory);
  const writersByRoute = new Map<string, Array<{ table: string; writer: InventoryWriter }>>();
  for (const table of inventory.tables) {
    for (const writer of table.writers) {
      for (const routeKey of writer.routeKeys) {
        const key = normaliseRouteKey(routeKey);
        const writers = writersByRoute.get(key);
        if (writers === undefined) writersByRoute.set(key, [{ table: table.table, writer }]);
        else writers.push({ table: table.table, writer });
      }
    }
  }

  const unitsOfWrite = (unit: string, item: ClosureItem): readonly string[] => {
    if (units.has(unit)) return [unit];
    if (unit === FILE_STORE && fileStoreUnits.length > 0) return fileStoreUnits;
    // Decision-list and retired tables have no target units.
    if (unit.startsWith(DECISION_TABLE_PREFIX)) return [];
    throw new Error(`${item.id ?? item.routeKey ?? 'item'}: write ${unit} maps to no unit of opt2/table-ownership.json`);
  };

  const unitsOfWriter = (table: string, writer: InventoryWriter): string[] => {
    const targets = targetsByTable.get(table.toLowerCase()) ?? [];
    const matched = targets.filter((target) => target.rowPredicate !== null && target.rowPredicate === writer.condition);
    return (matched.length > 0 ? matched : targets)
      .map((target) => target.unit)
      .filter((unit) => !(writer === upgrade?.record && unit === LEGACY_HASH_UPGRADE.unit));
  };

  // conditionalWrites stay out: the inventory records each one's guard as never holding on the branch it annotates.
  return (item) => {
    const closure = new Set<string>();
    if (item.writeSet !== undefined) {
      for (const write of item.writeSet) {
        if (upgrade?.covers(write)) continue;
        for (const unit of unitsOfWrite(write.unit, item)) closure.add(unit);
      }
    } else if (item.routeKey) {
      for (const { table, writer } of writersByRoute.get(normaliseRouteKey(item.routeKey)) ?? []) {
        for (const unit of unitsOfWriter(table, writer)) closure.add(unit);
      }
    }
    return [...closure].sort(byCodeUnit);
  };
}

/** Normalised keys an exceptions entry holds back as `legacy-write`: halted ones and open `fix` proposals. */
export function legacyWriteExceptionKeys(exceptions: ExceptionsDoc): Set<string> {
  const keys = new Set<string>();
  for (const entry of exceptions.entries) {
    if (entry.status !== 'halted' && !(entry.decision === 'fix' && entry.status === 'open')) continue;
    for (const key of [entry.routeKey, ...(entry.appliesTo ?? [])]) keys.add(normaliseRouteKey(key));
  }
  return keys;
}

function routeItems(inventory: InventoryDoc): RouteItem[] {
  const variants = inventory.controllers.flatMap((controller) => controller.actions.flatMap((action) => action.variants));
  return [...variants, ...inventory.routes, ...inventory.frontEnd];
}

/** Carry write entry points by normalised route key, each with the sorted units of its write closure. */
export function carryWriteEntries(
  input: Pick<BuildGroupsInput, 'inventory' | 'exceptions'>,
  closure: WriteClosure,
): Map<string, string[]> {
  const items = routeItems(input.inventory);
  const heldBack = legacyWriteExceptionKeys(input.exceptions);
  // A job routes each step by its own units, so its key never writes as a whole.
  for (const job of input.inventory.scheduledJobs) heldBack.add(normaliseRouteKey(job.routeKey));
  // A key any non-carry item also bears is withheld or legacy-served on that branch, so it runs on legacy.
  for (const item of items) {
    if (item.disposition !== 'carry' && item.routeKey !== null) heldBack.add(normaliseRouteKey(item.routeKey));
  }

  const entries = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.disposition !== 'carry') continue;
    const units = closure(item);
    if (item.routeKey === null) {
      // Null marks a route family or retired route with no single key; a write there could be neither routed nor grouped.
      if (units.length > 0) throw new Error(`${item.id}: carry item without a route key writes ${units.join(', ')}`);
      continue;
    }
    const key = normaliseRouteKey(item.routeKey);
    if (heldBack.has(key) || units.length === 0) continue;
    const keyUnits = entries.get(key) ?? new Set<string>();
    for (const unit of units) keyUnits.add(unit);
    entries.set(key, keyUnits);
  }
  const keys = [...entries.keys()].sort(byCodeUnit);
  return new Map(keys.map((key) => [key, [...(entries.get(key) ?? [])].sort(byCodeUnit)]));
}

/** Disjoint unit sets; each root is its set's smallest unit id, so roots name groups directly. */
class UnitSets {
  private readonly parent = new Map<string, string>();

  constructor(units: Iterable<string>) {
    for (const unit of units) this.parent.set(unit, unit);
  }

  find(unit: string): string {
    let root = unit;
    for (let up = this.parentOf(root); up !== root; up = this.parentOf(root)) root = up;
    for (let node = unit; node !== root; ) {
      const next = this.parentOf(node);
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  union(units: readonly string[]): void {
    const [first, ...rest] = units;
    if (first === undefined) return;
    for (const unit of rest) {
      const a = this.find(first);
      const b = this.find(unit);
      if (a !== b) this.parent.set(a < b ? b : a, a < b ? a : b);
    }
  }

  private parentOf(unit: string): string {
    const up = this.parent.get(unit);
    if (up === undefined) throw new Error(`unit ${unit} is not in opt2/table-ownership.json`);
    return up;
  }
}

/** Computes groups.json: one group per set of units joined by carry entry points and carried job steps, plus the units joining it. */
export function buildGroups(input: BuildGroupsInput): GroupsFile {
  const closure = createWriteClosure(input.inventory, input.ownership);
  const allUnits = [...new Set(input.ownership.units.map((unit) => unit.unit))].sort(byCodeUnit);
  const joins = new Map(
    input.ownership.units.flatMap(({ unit, joinsUnit }) => (joinsUnit === undefined ? [] : [[unit, joinsUnit] as const])),
  );
  // A joining unit stands in for the unit it joins, so it never names a group.
  const anchor = (unit: string): string => joins.get(unit) ?? unit;
  const sets = new UnitSets(allUnits.filter((unit) => !joins.has(unit)));
  const entries = carryWriteEntries(input, closure);
  for (const units of entries.values()) sets.union(units.map(anchor));
  for (const job of input.inventory.scheduledJobs) {
    for (const step of job.steps) if (step.disposition === 'carry') sets.union(closure(step).map(anchor));
  }

  const entriesByRoot = new Map<string, Set<string>>();
  for (const [key, units] of entries) {
    for (const unit of units) {
      const root = sets.find(anchor(unit));
      entriesByRoot.set(root, (entriesByRoot.get(root) ?? new Set<string>()).add(key));
    }
  }
  const unitsByRoot = new Map<string, string[]>();
  for (const unit of allUnits) {
    const root = sets.find(anchor(unit));
    const members = unitsByRoot.get(root);
    if (members === undefined) unitsByRoot.set(root, [unit]);
    else members.push(unit);
  }

  const groups = [...unitsByRoot].map(([root, units]): CutoverGroup => {
    const writeEntries = [...(entriesByRoot.get(root) ?? [])].sort(byCodeUnit);
    return { id: `grp:${root}`, units, writeEntries, hasCarryWrite: writeEntries.length > 0 };
  });
  return {
    sourceSha: input.sourceSha,
    generatedBy: GENERATED_BY,
    inputs: { inventorySha256: input.inputs.inventorySha256, tableOwnershipSha256: input.inputs.tableOwnershipSha256 },
    groups: groups.sort((a, b) => byCodeUnit(a.id, b.id)),
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Reads and validates the opt2 inputs of `buildGroups`, hashing the inventory and ownership bytes it validated. */
export async function loadBuildGroupsInput(
  paths: Pick<GatewayPaths, 'inventoryFile' | 'tableOwnershipFile' | 'exceptionsListFile' | 'sourcePinFile'>,
): Promise<BuildGroupsInput> {
  const [inventoryBytes, ownershipBytes, exceptions, pin] = await Promise.all([
    readFile(paths.inventoryFile),
    readFile(paths.tableOwnershipFile),
    loadExceptionsList(paths),
    loadSourcePin(paths),
  ]);
  const ownership = parseTableOwnership(paths.tableOwnershipFile, ownershipBytes.toString('utf8'), pin);
  return {
    sourceSha: pin.sha,
    inventory: parseInventory(paths.inventoryFile, inventoryBytes.toString('utf8'), pin, ownership),
    ownership,
    exceptions,
    inputs: { inventorySha256: sha256(inventoryBytes), tableOwnershipSha256: sha256(ownershipBytes) },
  };
}

/** The committed serialisation of groups.json. */
export function serialiseGroups(groups: GroupsFile): string {
  return `${JSON.stringify(groups, null, 2)}\n`;
}

/** Line diff from `committed` to `generated`: `@@ -<line> +<line> @@` hunk headers, `-` committed lines, `+` generated lines. */
export function lineDiff(committed: string, generated: string): string[] {
  const lines: string[] = [];
  let committedLine = 1;
  let generatedLine = 1;
  let inHunk = false;
  // util.diff marks lines only in its first argument 1 and lines only in its second -1, first-argument lines first.
  for (const [op, text] of diff(committed.split('\n'), generated.split('\n'))) {
    if (op === 0) {
      inHunk = false;
      committedLine += 1;
      generatedLine += 1;
      continue;
    }
    if (!inHunk) lines.push(`@@ -${committedLine} +${generatedLine} @@`);
    inHunk = true;
    if (op === 1) {
      lines.push(`-${text}`);
      committedLine += 1;
    } else {
      lines.push(`+${text}`);
      generatedLine += 1;
    }
  }
  return lines;
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Output sinks and paths of `main`. */
export interface BuildGroupsIo {
  readonly paths?: GatewayPaths;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const USAGE = 'usage: build-groups.ts [--write]';

/** CLI: diffs the build against groups.json (exit 0 equal, 1 differ or invalid input), or writes it with `--write`; 2 on usage error. */
export async function main(argv: readonly string[], io: BuildGroupsIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const unknown = argv.find((arg) => arg !== '--write');
  if (unknown !== undefined) {
    stderr(`build-groups: unknown argument ${unknown}\n${USAGE}`);
    return 2;
  }
  const paths = io.paths ?? resolveGatewayPaths();
  let input: BuildGroupsInput;
  try {
    input = await loadBuildGroupsInput(paths);
  } catch (error) {
    if (!(error instanceof CutoverSchemaError)) throw error;
    stderr(`build-groups: ${error.message}`);
    return 1;
  }
  const generated = serialiseGroups(buildGroups(input));
  if (argv.includes('--write')) {
    await writeFile(paths.groupsFile, generated);
    stdout(`build-groups: wrote ${paths.groupsFile}`);
    return 0;
  }
  const committed = await readIfPresent(paths.groupsFile);
  if (committed === generated) {
    stdout(`build-groups: ${paths.groupsFile} is up to date`);
    return 0;
  }
  for (const line of lineDiff(committed ?? '', generated)) stdout(line);
  stderr(
    committed === undefined
      ? `build-groups: ${paths.groupsFile} does not exist; run with --write`
      : `build-groups: ${paths.groupsFile} differs from the build; run with --write`,
  );
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
