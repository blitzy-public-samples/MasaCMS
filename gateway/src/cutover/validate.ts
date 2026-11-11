// Validates cut-over versions against the inventory, groups, decision list and exceptions; CLI `cutover:validate`.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROUTE_FAMILIES, normaliseRouteKey } from '@opt2/platform/legacy-compat';
import { carryWriteEntries, createWriteClosure, type WriteClosure } from './build-groups.js';
import {
  CutoverSchemaError,
  listVersions,
  loadDecisionList,
  loadExceptionsList,
  loadGroups,
  loadInventory,
  loadSourcePin,
  loadTableOwnership,
  loadVariants,
  loadVersion,
} from './loader.js';
import { resolveGatewayPaths, type GatewayPaths } from './paths.js';
import { isPreventedWriter } from './prevented-writers.js';
import type {
  Authority,
  CutoverEntry,
  CutoverTable,
  DecisionListInput,
  Disposition,
  EntryKind,
  ExceptionsDoc,
  Finding,
  FindingRule,
  GroupsFile,
  InventoryDoc,
  InventoryWrite,
  InventoryWriter,
  OwnershipDoc,
  VariantsFile,
} from './types.js';

/** `ci` checks references only; `activation` also reads the rollback reconciliation reports. */
export type ValidationMode = 'ci' | 'activation';

/** Inventory facts of one normalised route key, merged over every item that bears it. */
export interface InventoryKeyFacts {
  disposition: Disposition;
  owningService: string | null;
  /** Write-set units as the inventory records them, `file-store` and `legacy:<table>` included. */
  writeSet: string[];
  /** Legacy tables of the write set. */
  legacyTables: string[];
  kindHint?: 'job' | 'static';
}

export type { DecisionEntryPointRef, DecisionListInput } from './types.js';

/** Everything `validateVersion` checks a version against. */
export interface ValidationContext {
  mode: ValidationMode;
  inventory: InventoryDoc;
  inventoryKeys: Map<string, InventoryKeyFacts>;
  groups: GroupsFile;
  variants: VariantsFile;
  decisionList: DecisionListInput;
  exceptions: ExceptionsDoc;
  ownership: OwnershipDoc;
  sourceSha: string;
  prior?: CutoverTable;
  reconciliationDir: string;
}

/** Paths `loadValidationContext` reads. */
export type ValidationPaths = Pick<
  GatewayPaths,
  | 'schemaFile'
  | 'variantsFile'
  | 'groupsFile'
  | 'inventoryFile'
  | 'tableOwnershipFile'
  | 'decisionListFile'
  | 'exceptionsListFile'
  | 'sourcePinFile'
  | 'reconciliationDir'
>;

const SYNTHETIC_SERVICES: ReadonlySet<string> = new Set([
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
]);
const UNROUTED_OWNERS: ReadonlySet<string> = new Set(['gateway', 'web']);
const SYNTHETIC_PATH_PREFIX = '/v1/';
const FIXTURE_SCHEMA_TABLE = /^(?:synthetic|program_\w+)\./i;
// A key ends in `{<variant>}` only when a declared variant matched (route-key.ts); fixture `{id}` segments end in `@<method>`.
const VARIANT_SUFFIX = /\{[^{}]*\}$/;
const ZERO_DIFFERENCE = 'zero-difference';

const DISPOSITION_RANK: Readonly<Record<Disposition, number>> = { carry: 0, retired: 1, 'legacy-served': 2, decision: 3 };
// Rule an entry's units fall under, by the entry's kind.
const UNITS_RULE: Readonly<Record<EntryKind, FindingRule>> = {
  read: 'read-follows-units',
  static: 'read-follows-units',
  write: 'write-follows-group',
  'legacy-write': 'legacy-write-always-legacy',
  job: 'job-state',
};

interface KeyedItem {
  readonly routeKey: string | null;
  readonly disposition: Disposition;
  readonly owningService: string | null;
  readonly writeSet: readonly InventoryWrite[];
  readonly kindHint?: 'job' | 'static';
}

/** Facts per normalised inventoried key; a key borne by several items takes its most restrictive disposition. */
export function inventoryKeyFacts(inventory: InventoryDoc): Map<string, InventoryKeyFacts> {
  const items: KeyedItem[] = [
    ...inventory.controllers.flatMap((controller) => controller.actions.flatMap((action) => action.variants)),
    ...inventory.routes.map((route) => (route.kind === 'static' ? { ...route, kindHint: 'static' as const } : route)),
    ...inventory.frontEnd,
    // A job routes each step by the step's own units, so the job key itself carries no write set.
    ...inventory.scheduledJobs.map((job) => ({ ...job, writeSet: [], kindHint: 'job' as const })),
  ];
  const collected = new Map<string, { facts: InventoryKeyFacts; units: Set<string>; tables: Set<string> }>();
  for (const item of items) {
    if (item.routeKey === null) continue;
    const key = normaliseRouteKey(item.routeKey);
    let entry = collected.get(key);
    if (entry === undefined) {
      entry = {
        facts: { disposition: item.disposition, owningService: item.owningService, writeSet: [], legacyTables: [] },
        units: new Set(),
        tables: new Set(),
      };
      collected.set(key, entry);
    }
    const { facts } = entry;
    if (DISPOSITION_RANK[item.disposition] > DISPOSITION_RANK[facts.disposition]) facts.disposition = item.disposition;
    facts.owningService ??= item.owningService;
    if (item.kindHint !== undefined) facts.kindHint ??= item.kindHint;
    for (const write of item.writeSet) {
      entry.units.add(write.unit);
      if (write.legacyTable !== null) entry.tables.add(write.legacyTable);
    }
  }
  return new Map(
    [...collected].map(([key, { facts, units, tables }]) => [
      key,
      { ...facts, writeSet: [...units].sort(), legacyTables: [...tables].sort() },
    ]),
  );
}

/** Loads every input through the loader, each schema-validated and bound to the source pin. */
export async function loadValidationContext(
  paths: ValidationPaths,
  mode: ValidationMode,
  opts: { prior?: CutoverTable } = {},
): Promise<ValidationContext> {
  const [variants, groups, inventory, ownership, decisionList, exceptions, pin] = await Promise.all([
    loadVariants(paths),
    loadGroups(paths),
    loadInventory(paths),
    loadTableOwnership(paths),
    loadDecisionList(paths),
    loadExceptionsList(paths),
    loadSourcePin(paths),
  ]);
  const ctx: ValidationContext = {
    mode,
    inventory,
    inventoryKeys: inventoryKeyFacts(inventory),
    groups,
    variants,
    decisionList,
    exceptions,
    ownership,
    sourceSha: pin.sha,
    reconciliationDir: paths.reconciliationDir,
  };
  if (opts.prior !== undefined) ctx.prior = opts.prior;
  return ctx;
}

/** Non-request writers per target unit, mapped through the ownership targets of the writer's legacy table. */
function nonRequestWritersByUnit(ctx: Pick<ValidationContext, 'inventory' | 'ownership'>): Map<string, InventoryWriter[]> {
  const targetsByTable = new Map(ctx.ownership.tables.map((table) => [table.table.toLowerCase(), table.targets]));
  const byUnit = new Map<string, InventoryWriter[]>();
  for (const table of ctx.inventory.tables) {
    const targets = targetsByTable.get(table.table.toLowerCase()) ?? [];
    for (const writer of table.writers) {
      if (writer.trigger === 'request') continue;
      const narrowed = targets.filter((target) => target.rowPredicate !== null && target.rowPredicate === writer.condition);
      for (const target of narrowed.length > 0 ? narrowed : targets) {
        const writers = byUnit.get(target.unit);
        if (writers === undefined) byUnit.set(target.unit, [writer]);
        else writers.push(writer);
      }
    }
  }
  return byUnit;
}

function unprevented(byUnit: Map<string, InventoryWriter[]>, unit: string): InventoryWriter[] {
  return (byUnit.get(unit) ?? []).filter((writer) => isPreventedWriter(writer) === undefined);
}

/** Inventory writers of `unit` reached outside a request that no prevented-writer entry closes. */
export function unpreventedWriters(
  unit: string,
  ctx: Pick<ValidationContext, 'inventory' | 'ownership'>,
): InventoryWriter[] {
  return unprevented(nonRequestWritersByUnit(ctx), unit);
}

function describeWriter(writer: InventoryWriter): string {
  const [first, last] = writer.source.lines;
  return `${writer.component} ${writer.method} ${first}-${last} (${writer.trigger})`;
}

/** Family token of a key, from the shared family list. */
function familyOf(key: string): string | undefined {
  return ROUTE_FAMILIES.find((family) => key.startsWith(`${family}:`));
}

/** Whether a decision-list table name, possibly ending in `*`, names `table`. */
function namesTable(decisionTable: string, table: string): boolean {
  const pattern = decisionTable.toLowerCase();
  const name = table.toLowerCase();
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/** Normalised keys of every withheld action variant and decision-table entry point. */
function withheldKeys(decisionList: DecisionListInput): Set<string> {
  const refs = [
    ...decisionList.actionVariants.flatMap((variant) => [{ routeKey: variant.routeKey }, ...(variant.entryPoints ?? [])]),
    ...decisionList.tables.flatMap((table) => table.withheldEntryPoints ?? []),
  ];
  return new Set(refs.flatMap((ref) => (ref.routeKey === null ? [] : [normaliseRouteKey(ref.routeKey)])));
}

/** Normalised keys of halted exceptions and open `fix` proposals, which stay on legacy. */
function heldBackKeys(exceptions: ExceptionsDoc): Set<string> {
  const keys = new Set<string>();
  for (const entry of exceptions.entries) {
    if (entry.status !== 'halted' && !(entry.decision === 'fix' && entry.status === 'open')) continue;
    for (const key of [entry.routeKey, ...(entry.appliesTo ?? [])]) keys.add(normaliseRouteKey(key));
  }
  return keys;
}

/** Sorted write-closure units of each normalised inventoried key that writes a target unit; a job key routes per step. */
function writeClosures(inventory: InventoryDoc, closure: WriteClosure): Map<string, readonly string[]> {
  const jobKeys = new Set(inventory.scheduledJobs.map((job) => normaliseRouteKey(job.routeKey)));
  const items = [
    ...inventory.controllers.flatMap((controller) => controller.actions.flatMap((action) => action.variants)),
    ...inventory.routes,
    ...inventory.frontEnd,
  ];
  const byKey = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.routeKey === null) continue;
    const key = normaliseRouteKey(item.routeKey);
    const units = jobKeys.has(key) ? [] : closure(item);
    if (units.length === 0) continue;
    const keyUnits = byKey.get(key) ?? new Set<string>();
    for (const unit of units) keyUnits.add(unit);
    byKey.set(key, keyUnits);
  }
  return new Map([...byKey].map(([key, units]) => [key, [...units].sort()]));
}

/** Ids of the generated groups whose writeEntries list each normalised key. */
function writeEntryGroups(groups: GroupsFile): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const group of groups.groups) {
    for (const key of group.writeEntries) {
      const normalised = normaliseRouteKey(key);
      byKey.set(normalised, [...(byKey.get(normalised) ?? []), group.id]);
    }
  }
  return byKey;
}

type ReportVerdict = { ok: true } | { ok: false; reason: string };

/** Reads a reconciliation report named by a rollback reference from the reconciliation directory. */
function reportVerdict(reconciliationDir: string, report: string): ReportVerdict {
  const file = join(reconciliationDir, basename(report));
  let result: unknown;
  try {
    result = (JSON.parse(readFileSync(file, 'utf8')) as { result?: unknown }).result;
  } catch (error) {
    return { ok: false, reason: `${file} is unreadable: ${(error as Error).message}` };
  }
  return result === ZERO_DIFFERENCE ? { ok: true } : { ok: false, reason: `${file} has result ${String(result)}` };
}

/** A version indexed for the rules, with the context-derived key sets they share. */
interface VersionView {
  readonly table: CutoverTable;
  readonly ctx: ValidationContext;
  readonly entriesByKey: Map<string, CutoverEntry[]>;
  readonly groupUnits: Map<string, ReadonlySet<string>>;
  readonly unitTables: Map<string, readonly string[]>;
  readonly withheld: Set<string>;
  readonly heldBack: Set<string>;
  readonly declaredVariants: Set<string>;
  readonly decisionTables: readonly string[];
  readonly writeClosures: Map<string, readonly string[]>;
  readonly carriedWrites: ReadonlySet<string>;
  readonly writeGroups: Map<string, readonly string[]>;
  authority(groupId: string): Authority;
  unitAuthority(unit: string): Authority;
}

function viewOf(table: CutoverTable, ctx: ValidationContext): VersionView {
  const entriesByKey = new Map<string, CutoverEntry[]>();
  for (const entry of table.entries) {
    const key = normaliseRouteKey(entry.route);
    const entries = entriesByKey.get(key);
    if (entries === undefined) entriesByKey.set(key, [entry]);
    else entries.push(entry);
  }
  const authorities = new Map<string, Authority>(Object.entries(table.groupAuthority));
  const authority = (groupId: string): Authority => authorities.get(groupId) ?? 'legacy';
  const unitGroup = new Map(ctx.groups.groups.flatMap((group) => group.units.map((unit): [string, string] => [unit, group.id])));
  const closure = createWriteClosure(ctx.inventory, ctx.ownership);
  return {
    table,
    ctx,
    entriesByKey,
    groupUnits: new Map(ctx.groups.groups.map((group) => [group.id, new Set(group.units)])),
    unitTables: new Map(ctx.ownership.units.map((unit) => [unit.unit, unit.legacyTables])),
    withheld: withheldKeys(ctx.decisionList),
    heldBack: heldBackKeys(ctx.exceptions),
    declaredVariants: new Set(
      ctx.variants.variants.map((v) => `${normaliseRouteKey(v.route)}{${normaliseRouteKey(v.variant)}}`),
    ),
    decisionTables: ctx.decisionList.tables.map((table) => table.table),
    writeClosures: writeClosures(ctx.inventory, closure),
    carriedWrites: new Set(carryWriteEntries(ctx, closure).keys()),
    writeGroups: writeEntryGroups(ctx.groups),
    authority,
    unitAuthority: (unit) => {
      const group = unitGroup.get(unit);
      return group === undefined ? 'legacy' : authority(group);
    },
  };
}

/** Whether an entry is a synthetic service's own `/v1/` route. */
function isSyntheticRoute(route: string, entry: CutoverEntry): boolean {
  const family = familyOf(route);
  return (
    SYNTHETIC_SERVICES.has(entry.owningService) &&
    family !== undefined &&
    route.slice(family.length + 1).startsWith(SYNTHETIC_PATH_PREFIX)
  );
}

/** Whether an entry without an inventoried key may stand in a version. */
function mayBeUninventoried(route: string, entry: CutoverEntry): boolean {
  if (familyOf(route) === 'opt2' || UNROUTED_OWNERS.has(entry.owningService)) return true;
  if (isSyntheticRoute(route, entry)) return true;
  // Legacy static assets (/admin/assets/**, /core/vendor/**, /core/modules/**) are listed as legacy `static`
  // entries; such an entry routes exactly as an unlisted key does, so it is allowed beside the three listed cases.
  return entry.kind === 'static' && entry.state === 'legacy';
}

function touchesDecisionTable(view: VersionView, entry: CutoverEntry, facts: InventoryKeyFacts | undefined): boolean {
  const tables = [...(facts?.legacyTables ?? []), ...entry.units.flatMap((unit) => view.unitTables.get(unit) ?? [])];
  return tables.some((table) => view.decisionTables.some((decisionTable) => namesTable(decisionTable, table)));
}

function entryFindings(view: VersionView, entry: CutoverEntry): Finding[] {
  const { table, ctx } = view;
  const route = normaliseRouteKey(entry.route);
  const facts = ctx.inventoryKeys.get(route);
  const findings: Finding[] = [];
  const add = (rule: Finding['rule'], message: string, group?: string): void => {
    findings.push(group === undefined ? { rule, route, message } : { rule, route, group, message });
  };

  if (facts === undefined && !mayBeUninventoried(route, entry)) {
    add('route-not-inventoried', `${entry.owningService} entry is not an inventoried route`);
  }
  // The inventory's disposition governs an inventoried key; a target violation reports only its most specific rule.
  const disposition = facts?.disposition ?? entry.disposition;
  if (entry.state === 'target') {
    if (view.withheld.has(route) || touchesDecisionTable(view, entry, facts)) add('withheld-never-target', 'withheld entry is target');
    else if (disposition === 'legacy-served') add('legacy-served-never-target', 'legacy-served entry is target');
    else if (disposition !== 'carry') add('target-only-carry', `${disposition} entry is target`);
  }

  const group = entry.group ?? null;
  const knownGroup = group === null || view.groupUnits.has(group);
  if (group !== null && !knownGroup) add('group-unknown', `group ${group} is not in groups.json`, group);
  const unknownUnits = entry.units.filter((unit) => !view.unitTables.has(unit));
  if (unknownUnits.length > 0) add(UNITS_RULE[entry.kind], `units ${unknownUnits.join(', ')} are not in opt2/table-ownership.json`);
  const units = entry.units.filter((unit) => view.unitTables.has(unit));

  // An inventoried writer is held to its write closure and generated group, whatever kind, group and units it declares.
  const closure = view.writeClosures.get(route);
  const missing = closure?.filter((unit) => !entry.units.includes(unit)) ?? [];
  const carried = view.carriedWrites.has(route);
  const generated = carried ? (view.writeGroups.get(route) ?? []) : [];
  const generatedGroup = generated.length === 1 ? generated[0] : undefined;
  const writeGroup = generatedGroup ?? (knownGroup ? group : null);
  if (carried) {
    if (entry.kind !== 'write') add('write-follows-group', `carry write has kind ${entry.kind}`);
    if (generatedGroup === undefined) {
      const listed = generated.length === 0 ? 'no generated group' : `groups ${generated.join(', ')}`;
      add('write-follows-group', `carry write is in ${listed}`);
    } else if (group !== null && knownGroup && group !== generatedGroup) {
      add('write-follows-group', `group ${group} is not its generated group ${generatedGroup}`, group);
    }
    if (missing.length > 0) add('write-follows-group', `units lack ${missing.join(', ')} of its write closure`, writeGroup ?? undefined);
  } else if (closure !== undefined) {
    const heldBack = view.heldBack.has(route);
    if (!heldBack && entry.kind !== 'legacy-write') add('legacy-write-always-legacy', `${disposition} write has kind ${entry.kind}`);
    if (missing.length > 0) {
      add(heldBack ? 'halted-is-legacy-write' : 'legacy-write-always-legacy', `units lack ${missing.join(', ')} of its write closure`);
    }
  }
  // Any other write entry with no units writes no unit of authority, so the schema gives it no group (stub, admin-actions).
  if (carried || (closure === undefined && entry.kind === 'write' && entry.units.length > 0)) {
    if (group === null) add('write-follows-group', 'write entry has no group');
    if (writeGroup !== null) {
      const authority = view.authority(writeGroup);
      if (entry.state !== authority) add('write-follows-group', `state ${entry.state} differs from group authority ${authority}`, writeGroup);
      const groupUnits = view.groupUnits.get(writeGroup);
      const outside = units.filter((unit) => !groupUnits?.has(unit));
      if (outside.length > 0) add('write-follows-group', `units ${outside.join(', ')} are not in the group`, writeGroup);
    }
  }
  if (entry.kind === 'read' && entry.state === 'target') {
    const legacyUnits = units.filter((unit) => view.unitAuthority(unit) !== 'target');
    if (legacyUnits.length > 0) add('read-follows-units', `target read of legacy-authoritative ${legacyUnits.join(', ')}`);
  }
  if (entry.kind === 'legacy-write' && entry.state !== 'legacy') add('legacy-write-always-legacy', 'legacy-write entry is target');

  if (facts?.kindHint === 'job') {
    const expected: Authority = table.previous === null ? 'legacy' : 'target';
    if (entry.kind !== 'job') add('job-state', `scheduled job has kind ${entry.kind}`);
    if (entry.state !== expected) add('job-state', `scheduled job is ${entry.state}; expected ${expected}`);
  } else if (entry.kind === 'job') {
    add('job-state', 'only a scheduled job may be a job entry');
  }
  if (entry.tableVersion > table.tableVersion) {
    add('previous-chain', `entry tableVersion ${entry.tableVersion} follows ${table.tableVersion}`);
  }
  if (VARIANT_SUFFIX.test(route) && !view.declaredVariants.has(route)) {
    add('variant-undeclared', 'variant is not declared in variants.json');
  }
  return findings;
}

function routeOnceFindings(view: VersionView): Finding[] {
  const findings: Finding[] = [];
  for (const [route, entries] of view.entriesByKey) {
    if (entries.length > 1) findings.push({ rule: 'route-once', route, message: `appears in ${entries.length} entries` });
  }
  for (const route of view.ctx.inventoryKeys.keys()) {
    if (!view.entriesByKey.has(route)) findings.push({ rule: 'route-once', route, message: 'inventoried route has no entry' });
  }
  return findings;
}

function heldBackFindings(view: VersionView): Finding[] {
  const findings: Finding[] = [];
  for (const route of view.heldBack) {
    const writes = (view.ctx.inventoryKeys.get(route)?.writeSet.length ?? 0) > 0;
    for (const entry of view.entriesByKey.get(route) ?? []) {
      if (writes && entry.kind !== 'legacy-write') {
        findings.push({ rule: 'halted-is-legacy-write', route, message: `held-back write has kind ${entry.kind}` });
      } else if (!writes && entry.state !== 'legacy') {
        findings.push({ rule: 'halted-read-legacy', route, message: 'held-back read is target' });
      }
    }
  }
  return findings;
}

function writerFindings(view: VersionView): Finding[] {
  const byUnit = nonRequestWritersByUnit(view.ctx);
  const findings: Finding[] = [];
  for (const group of view.ctx.groups.groups) {
    if (view.authority(group.id) !== 'target') continue;
    for (const unit of group.units) {
      for (const writer of unprevented(byUnit, unit)) {
        findings.push({
          rule: 'unprevented-writer',
          unit,
          group: group.id,
          message: `${describeWriter(writer)} writes it and is not prevented`,
        });
      }
    }
  }
  return findings;
}

function rollbackFindings(view: VersionView): Finding[] {
  const { table, ctx } = view;
  const prior = ctx.prior;
  if (prior === undefined) return [];
  const verdicts = new Map<string, ReportVerdict>();
  const verdictOf = (report: string): ReportVerdict => {
    let verdict = verdicts.get(report);
    if (verdict === undefined) {
      verdict = reportVerdict(ctx.reconciliationDir, report);
      verdicts.set(report, verdict);
    }
    return verdict;
  };
  const findings: Finding[] = [];
  for (const [group, priorAuthority] of Object.entries(prior.groupAuthority)) {
    if (priorAuthority !== 'target' || view.authority(group) !== 'legacy') continue;
    const refs = table.rollbackRefs.filter((ref) => ref.groups.includes(group));
    if (refs.length === 0) {
      findings.push({ rule: 'rollback-evidence', group, message: `returns to legacy from ${prior.tableVersion} without rollbackRefs` });
      continue;
    }
    if (ctx.mode !== 'activation') continue;
    const reasons: string[] = [];
    for (const ref of refs) {
      const verdict = verdictOf(ref.report);
      if (verdict.ok) break;
      reasons.push(verdict.reason);
    }
    if (reasons.length === refs.length) findings.push({ rule: 'rollback-evidence', group, message: reasons.join('; ') });
  }
  return findings;
}

function chainFindings(view: VersionView): Finding[] {
  const { table, ctx } = view;
  const { previous, tableVersion } = table;
  const findings: Finding[] = [];
  const add = (message: string): void => {
    findings.push({ rule: 'previous-chain', message });
  };
  if (table.sourceSha !== ctx.sourceSha) {
    findings.push({ rule: 'source-sha', message: `sourceSha ${table.sourceSha} is not the pinned ${ctx.sourceSha}` });
  }
  if (previous === null) {
    if (ctx.prior !== undefined) add(`previous is null although ${ctx.prior.tableVersion} precedes ${tableVersion}`);
    return findings;
  }
  if (previous >= tableVersion) add(`previous ${previous} does not precede ${tableVersion}`);
  if (ctx.prior === undefined) add(`previous ${previous} is not available`);
  else if (ctx.prior.tableVersion !== previous) add(`previous ${previous} is not the prior version ${ctx.prior.tableVersion}`);
  return findings;
}

/** Groups a synthetic service's own non-inventoried `/v1/` target carry writes name after the first version. */
function syntheticWriteGroups(view: VersionView): Set<string> {
  const groups = new Set<string>();
  if (view.table.previous === null) return groups;
  const owners = new Map(view.ctx.ownership.units.map((unit) => [unit.unit, unit.owner]));
  // Only a synthetic module's fixture-backed units lack a legacy oracle once the fixtures are unavailable.
  const fixtureBacked = (unit: string, service: string): boolean => {
    const tables = view.unitTables.get(unit) ?? [];
    return owners.get(unit) === service && tables.length > 0 && tables.every((table) => FIXTURE_SCHEMA_TABLE.test(table));
  };
  for (const [route, entries] of view.entriesByKey) {
    if (view.ctx.inventoryKeys.has(route)) continue;
    for (const entry of entries) {
      const group = entry.group;
      if (entry.kind !== 'write' || entry.disposition !== 'carry' || entry.state !== 'target' || !group) continue;
      const units = view.groupUnits.get(group);
      if (units === undefined || entry.units.length === 0 || !isSyntheticRoute(route, entry)) continue;
      if ([...units].every((unit) => fixtureBacked(unit, entry.owningService))) groups.add(group);
    }
  }
  return groups;
}

function groupAuthorityFindings(view: VersionView): Finding[] {
  const ids = new Set(view.ctx.groups.groups.map((group) => group.id));
  const listed = new Set(Object.keys(view.table.groupAuthority));
  const findings: Finding[] = [];
  for (const group of ids) {
    if (!listed.has(group)) findings.push({ rule: 'group-authority', group, message: 'group has no authority' });
  }
  for (const group of listed) {
    if (!ids.has(group)) findings.push({ rule: 'group-authority', group, message: 'authority names a group not in groups.json' });
  }
  const synthetic = syntheticWriteGroups(view);
  for (const group of view.ctx.groups.groups) {
    if (group.writeEntries.length > 0 || synthetic.has(group.id) || view.authority(group.id) !== 'target') continue;
    findings.push({ rule: 'group-authority', group: group.id, message: 'group without a carry write entry is target' });
  }
  return findings;
}

/** Every rule finding of one version; an empty list means the version may be committed or activated. */
export function validateVersion(table: CutoverTable, ctx: ValidationContext): Finding[] {
  const view = viewOf(table, ctx);
  return [
    ...routeOnceFindings(view),
    ...table.entries.flatMap((entry) => entryFindings(view, entry)),
    ...heldBackFindings(view),
    ...writerFindings(view),
    ...rollbackFindings(view),
    ...chainFindings(view),
    ...groupAuthorityFindings(view),
  ];
}


/** Output sinks and paths of `main`. */
export interface ValidateIo {
  readonly paths?: GatewayPaths;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

interface CliOptions {
  readonly mode: ValidationMode;
  readonly version?: string;
}

const USAGE = 'usage: validate.ts [--ci | --activation] [--version vNNNN]';
const VERSION_ID = /^v\d{4}$/;

/** Parsed options, or the usage error; the last mode flag wins, since the `cutover:validate` script already passes `--ci`. */
function parseArgs(argv: readonly string[]): CliOptions | string {
  let mode: ValidationMode = 'ci';
  let version: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ci' || arg === '--activation') {
      mode = arg === '--ci' ? 'ci' : 'activation';
    } else if (arg === '--version') {
      const id = argv[i + 1];
      if (version !== undefined) return '--version given twice';
      if (id === undefined || !VERSION_ID.test(id)) return '--version needs a vNNNN id';
      version = id;
      i += 1;
    } else {
      return `unknown argument ${String(arg)}`;
    }
  }
  return version === undefined ? { mode } : { mode, version };
}

async function versionIds(paths: Pick<GatewayPaths, 'versionsDir'>): Promise<string[]> {
  try {
    return await listVersions(paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function findingLine(version: string, finding: Finding): string {
  return `${version} ${finding.rule} ${finding.route ?? finding.unit ?? finding.group ?? '-'} ${finding.message}`;
}

/** CLI: validates every committed version (or `--version`) against its predecessor; exit 0 clean, 1 findings, 2 usage error. */
export async function main(argv: readonly string[], io: ValidateIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const options = parseArgs(argv);
  if (typeof options === 'string') {
    stderr(`validate: ${options}\n${USAGE}`);
    return 2;
  }
  const paths = io.paths ?? resolveGatewayPaths();
  const ids = await versionIds(paths);
  if (options.version !== undefined && !ids.includes(options.version)) {
    stderr(`validate: no version file ${options.version} in ${paths.versionsDir}\n${USAGE}`);
    return 2;
  }
  if (ids.length === 0) {
    stderr(`validate: no version files in ${paths.versionsDir}`);
    return 1;
  }
  let ctx: ValidationContext;
  try {
    ctx = await loadValidationContext(paths, options.mode);
  } catch (error) {
    if (!(error instanceof CutoverSchemaError)) throw error;
    stderr(`validate: ${error.message}`);
    return 1;
  }

  const loaded = new Map<string, Promise<CutoverTable | CutoverSchemaError>>();
  const load = (id: string): Promise<CutoverTable | CutoverSchemaError> => {
    let table = loaded.get(id);
    if (table === undefined) {
      table = loadVersion(paths, id).catch((error: unknown) => {
        if (error instanceof CutoverSchemaError) return error;
        throw error;
      });
      loaded.set(id, table);
    }
    return table;
  };

  let failed = false;
  for (const [index, id] of ids.entries()) {
    if (options.version !== undefined && id !== options.version) continue;
    const table = await load(id);
    if (table instanceof CutoverSchemaError) {
      stdout(`${id} schema - ${table.message}`);
      failed = true;
      continue;
    }
    // A null `previous` is checked against the preceding file, so only the first file may start the chain.
    const priorId = table.previous ?? ids[index - 1];
    const prior = priorId !== undefined && ids.includes(priorId) ? await load(priorId) : undefined;
    const findings = validateVersion(
      table,
      prior === undefined || prior instanceof CutoverSchemaError ? ctx : { ...ctx, prior },
    );
    if (findings.length === 0) stdout(`ok ${id}`);
    for (const finding of findings) stdout(findingLine(id, finding));
    failed ||= findings.length > 0;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

