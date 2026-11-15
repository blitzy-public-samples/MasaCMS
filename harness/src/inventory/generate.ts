// Legacy inventory orchestrator: runs the extractors over the pinned archive, decides every item's disposition and
// writes opt2/inventory/legacy-inventory.{json,md}.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { gitArchiveExtract } from '../lib/git.js';
import type { FetchLike } from '../lib/http.js';
import { createReadOnlyMssql, type ReadOnlyMssql } from '../lib/mssql.js';
import { isInsideRepo, opt2Path, REPO_ROOT, stateDir, type EnvLike } from '../lib/paths.js';
import { pinnedSha, readPin } from '../lib/pin.js';
import { sortKeysDeep, stableStringify, writeMarkdown } from '../lib/report.js';
import {
  computeClosure,
  openSourceTree,
  type ClosureContext,
  type ClosureWrite,
  type ConditionalWrite,
  type SourceTree,
  type UnresolvedRef,
  type WriteClosure,
} from './closure.js';
import {
  extractControllers,
  ROLE_OVERRIDES_REF,
  searchCoreMuraAction,
  type ActionEntry,
  type ControllerEntry,
  type CoreMuraActionSearch,
  type VariantEntry,
  type VariantPredicate,
} from './controllers.js';
import {
  AREA_OWNERS,
  areaKeyForRouteKey,
  decide,
  loadDecisionList,
  loadExceptions,
  NO_OWNER,
  type DecisionList,
  type Disposition,
  type DispositionContext,
  type DispositionCorrection,
  type DispositionFacts,
  type DispositionFinding,
  type DispositionResult,
  type DispositionStep,
  type ExceptionsList,
  type OwnerBasis,
  type RuntimeCategory,
  type StoredDataOwner,
  type VariantPredicates,
  type WriteProtocol,
} from './disposition.js';
import {
  attachDaoWrites,
  classCounts,
  extractEntities,
  fetchLiveEntities,
  mergeLive,
  type EntityEntry,
  type LiveEntities,
} from './entities.js';
import { extractFrontEnd, type FrontEndEntry } from './frontend.js';
import { extractJobs, jobWriteEvidence, type ExpectedOutcome, type ScheduledJobEntry, type ScheduledJobStep } from './jobs.js';
import { loadRoleOverrides, loadWriterOverrides, type RoleOverrides, type SourceRef, type WriterOverrides } from './overrides.js';
import { extractRelations, type Relation, type RelationCounts } from './relations.js';
import { renderInventoryMarkdown } from './render-md.js';
import { loadInventoryVariants, normaliseInventoryKey, type InventoryVariants } from './route-keys.js';
import { extractRoutes, type RouteCounts, type RouteEntry } from './routes.js';
import { buildComponentIndex, extractAliases, extractServices, extractTransients, STARTUP_PATH, type ServiceEntry } from './services.js';
import { storedProcedureCheck, type LiveCheck, type StoredProcedureCheck } from './stored-procedures.js';
import {
  assignOwners,
  attachWriters,
  DB_UPDATES_DIR,
  extractTables,
  fetchLiveCatalog,
  loadTableOwnership,
  mergeLiveCatalog,
  tableKey,
  type TableEntry,
  type TableOwnership,
  type WriteEvidence,
} from './tables.js';

/** Value of the inventory's `generatedBy` field. */
export const GENERATED_BY = 'harness/src/inventory/generate.ts';

/** File name of the inventory JSON in the output directory. */
export const INVENTORY_JSON = 'legacy-inventory.json';

/** File name of the Markdown rendering in the output directory. */
export const INVENTORY_MD = 'legacy-inventory.md';

const WRITER_OVERRIDES_REF = 'harness/inventory/writer-overrides.yaml';

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/** Owner and disposition fields written onto every disposed item. */
export interface DispositionFields {
  owningService: string | null;
  owners: string[];
  ownerBasis: OwnerBasis;
  disposition: Disposition;
  dispositionStep: DispositionStep;
  dispositionReason: string;
  withheld: boolean;
  legacyWrite: boolean;
  haltedBy: string | null;
  protocol: WriteProtocol | null;
  decisionListRef: string | null;
  /** True when the decision list and the computed disposition disagree for this item. */
  decisionListGap: boolean;
  correction: DispositionCorrection | null;
}

/** Tables of an item's write closure left out of its disposition write set by an environment guard. */
export interface EnvironmentExclusion {
  environmentExcludedWrites: string[];
}

/** Disposition of one target unit of a split table. */
export interface UnitDisposition extends DispositionFields {
  unit: string;
  rowPredicate: string | null;
}

// Inventory entries: each extractor's facts plus the owner and disposition fields decided here.
/** An `entities[]` entry. */
export type InventoryEntity = EntityEntry & DispositionFields & EnvironmentExclusion;
export type InventoryService = ServiceEntry & DispositionFields & EnvironmentExclusion & { tablesWritten: string[] };
export type InventoryVariant = VariantEntry & DispositionFields & EnvironmentExclusion;
export type InventoryAction = Omit<ActionEntry, 'variants'> & { variants: InventoryVariant[] };
export type InventoryController = Omit<ControllerEntry, 'actions'> & {
  owningService: string | null;
  ownerBasis: OwnerBasis;
  disposition: null;
  dispositionStep: null;
  actions: InventoryAction[];
};
export type InventoryFrontEnd = Omit<FrontEndEntry, 'closure'> &
  DispositionFields &
  EnvironmentExclusion &
  Pick<WriteClosure, 'conditionalWrites' | 'threads' | 'overrides'> & {
    unresolvedCalls: UnresolvedRef[];
    /** A legacy writer of units a target service owns, run inside write windows once those units move. */
    windowed: boolean;
  };
export type InventoryJobStep = Omit<ScheduledJobStep, 'closure'> & DispositionFields & EnvironmentExclusion;
export type InventoryJob = Omit<ScheduledJobEntry, 'steps'> & DispositionFields & { steps: InventoryJobStep[] };
export type InventoryRoute = Omit<RouteEntry, 'owningService' | 'disposition' | 'dispositionStep'> & DispositionFields & EnvironmentExclusion;
export type InventoryTable = Omit<TableEntry, 'owningService' | 'decisionListRef'> &
  DispositionFields & {
    /** Owner value of the ownership file: a service, `split`, `decision-list` or `retired`. */
    ownershipOwner: string | null;
    ruleSteps: number[];
    hasSiteIdLive: boolean | null;
    hasPrimaryKeyLive: boolean | null;
    unitDispositions: UnitDisposition[];
  };

/** Live part of the stored-procedure check before a live run: every field null. */
export type PendingLiveCheck = { [K in keyof LiveCheck]: null };

/** The inventory's `storedProcedureCheck`. */
export type InventoryStoredProcedureCheck = Omit<StoredProcedureCheck, 'live'> & { live: LiveCheck | PendingLiveCheck };

/** Kind of a generator finding. */
export type FindingKind =
  | 'correction'
  | 'decision-list-mismatch'
  | 'unclassified-gate'
  | 'unresolved-call'
  | 'unmatched-write'
  | 'unkeyed-entry'
  | 'count-difference';

/** A finding of the run; `measure` names a count, `id` an inventoried item. */
export interface GeneratedFinding {
  kind: FindingKind;
  id: string | null;
  measure?: string;
  source: SourceRef | null;
  detail: string | null;
  aapFigure?: number;
  computed?: number;
}

/** Whether live fields hold catalog and registration data or wait for a `--live` run. */
export type LiveStatus = 'live' | 'pending-run';

/** The legacy inventory document, `opt2/inventory/legacy-inventory.json`. */
export interface LegacyInventory {
  sourceSha: string;
  generatedBy: typeof GENERATED_BY;
  extractedFrom: { method: 'git archive'; sha: string; workingTree: false };
  counts: InventoryCounts;
  entities: InventoryEntity[];
  services: InventoryService[];
  controllers: InventoryController[];
  coreMuraActionSearch: CoreMuraActionSearch;
  frontEnd: InventoryFrontEnd[];
  scheduledJobs: InventoryJob[];
  routes: InventoryRoute[];
  tables: InventoryTable[];
  relations: Relation[];
  storedProcedureCheck: InventoryStoredProcedureCheck;
  findings: GeneratedFinding[];
}

/** Per-section counts of the inventory. */
export interface InventoryCounts {
  entities: Record<'orm-base' | 'orm-concrete' | 'not-entity' | 'domain-bean' | 'dynamicPatterns', number> & {
    dynamic: number | null;
  };
  ormTables: { concrete: number; ormOnly: number };
  services: { registeredSingletons: number; serviceList: number; transient: number; aliases: number; declaredBeans: number };
  controllers: ControllerEntryCounts;
  coreMuraActionFiles: number;
  frontEnd: number;
  scheduledJobs: { jobs: number; siteMonitorSteps: number };
  routes: RouteCounts;
  tables: {
    bootstrap: number;
    bootstrapAfterDrops: number;
    migrationCreated: number;
    ormOnly: number;
    staticTotal: number;
    retired: number;
    withSiteIdStatic: number;
    withoutPrimaryKeyBootstrap: number;
    withoutPrimaryKey: number;
    fixture: number;
    dynamic: number;
    liveOnly: number;
    live: number | null;
    withSiteIdLive: number | null;
  };
  relations: RelationCounts;
  storedProcedures: { static: number; live: number | null; foreignKeys: number };
  dispositions: Record<Disposition, number>;
  liveStatus: LiveStatus;
}

type ControllerEntryCounts = Awaited<ReturnType<typeof extractControllers>>['counts'];

/** Reviewed and committed inputs, each read and validated once per run. */
export interface InventoryInputs {
  roleOverrides: RoleOverrides;
  writerOverrides: WriterOverrides;
  variants: InventoryVariants;
  ownership: TableOwnership;
  decisionList: DecisionList;
  exceptions: ExceptionsList;
  /** Fixture front controller and SQL; undefined reads the working tree, null means no fixture routes. */
  fixtureTree?: SourceTree | null;
}

/** Live sources of a `--live` run; the caller owns and closes `db`. */
export interface LiveSources {
  origin: string;
  db: ReadOnlyMssql;
  fixturesLoaded: boolean;
  fetch?: FetchLike;
}

/** Options of {@link generateInventory}; without `sourceTree` the pinned commit is extracted with `git archive`. */
export interface GenerateOptions {
  live?: LiveSources;
  sourceTree?: SourceTree;
  inputs?: Partial<InventoryInputs>;
  /** Keep the archive extraction and return its path. */
  keepExtract?: boolean;
  /** Number of `core/mura/dbUpdates/*.cfm` files the stored-procedure scan requires; null skips it. */
  expectedDbUpdates?: number | null;
}

/** The generated inventory, its Markdown text and the kept extraction directory, if any. */
export interface GenerateResult {
  inventory: LegacyInventory;
  markdown: string;
  extractDir: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Facts no extractor yields
// ---------------------------------------------------------------------------------------------------------------

/** Rule-step facts of an item beyond its writes: a CFML-runtime dependence or an owner held in stored data. */
interface RuntimeFact {
  runtimeCategory?: RuntimeCategory;
  webRootFilesystem?: boolean;
  storedDataOwner?: StoredDataOwner;
}

// Disposition facts of admin actions that the extractors, which record writes only, cannot see: CFML-runtime
// dependence (bundle engine, plugins, export HTML, scaffolder, display objects), the legacy web-root filesystem and
// owners held in stored data (subtype baseTable, trash objectClass). Keyed by base route key, else by circuit area.
const ADMIN_FACTS: Readonly<Record<string, RuntimeFact>> = Object.freeze({
  'admin:cplugins': { runtimeCategory: 'plugin' },
  'admin:scaffold': { runtimeCategory: 'scaffolder' },
  'admin:cfilemanager': { webRootFilesystem: true },
  'admin:cextend': { storedDataOwner: 'baseTable' },
  'admin:ctrash': { storedDataOwner: 'objectClass' },
  'admin:csettings.createbundle': { runtimeCategory: 'bundle' },
  'admin:csettings.selectbundleoptions': { runtimeCategory: 'bundle' },
  'admin:csettings.deploybundle': { runtimeCategory: 'bundle' },
  'admin:csettings.exporthtml': { runtimeCategory: 'export-html' },
  'admin:csettings.editplugin': { runtimeCategory: 'plugin' },
  'admin:csettings.deployplugin': { runtimeCategory: 'plugin' },
  'admin:csettings.updateplugin': { runtimeCategory: 'plugin' },
  'admin:csettings.updatepluginversion': { runtimeCategory: 'plugin' },
  'admin:csettings.deleteplugin': { runtimeCategory: 'plugin' },
  'admin:carch.export': { runtimeCategory: 'bundle' },
  'admin:carch.exportcontent': { runtimeCategory: 'bundle' },
  'admin:carch.exportcomponent': { runtimeCategory: 'bundle' },
  'admin:carch.import': { runtimeCategory: 'bundle' },
  'admin:carch.importcontent': { runtimeCategory: 'bundle' },
  'admin:carch.importcomponent': { runtimeCategory: 'bundle' },
  'admin:carch.displayobjectmodal': { runtimeCategory: 'theme-render' },
  'admin:carch.frontendconfigurator': { runtimeCategory: 'theme-render' },
});

// The same dependencies of DI1 services, by component path prefix; the output cache holds rendered theme output.
const SERVICE_FACTS: readonly (readonly [string, RuntimeFact])[] = Object.freeze([
  ['core/mura/plugin/', { runtimeCategory: 'plugin' }],
  ['core/mura/autoUpdater/', { runtimeCategory: 'auto-update' }],
  ['core/mura/cluster/', { runtimeCategory: 'cluster' }],
  ['core/mura/settings/settingsBundle.cfc', { runtimeCategory: 'bundle' }],
  ['core/mura/publisher.cfc', { runtimeCategory: 'bundle' }],
  ['core/mura/publisherKeys.cfc', { runtimeCategory: 'bundle' }],
  ['core/mura/content/contentHTMLExporter.cfc', { runtimeCategory: 'export-html' }],
  ['core/mura/content/contentRenderer', { runtimeCategory: 'theme-render' }],
  ['core/mura/content/staticContentRenderer.cfc', { runtimeCategory: 'theme-render' }],
  ['core/mura/Translator/', { runtimeCategory: 'theme-render' }],
  ['core/mura/Handler/', { runtimeCategory: 'theme-render' }],
  ['core/mura/cache/', { runtimeCategory: 'theme-render' }],
  ['core/mura/fileWriter.cfc', { webRootFilesystem: true }],
  ['core/mura/fckeditor.cfc', { webRootFilesystem: true }],
]);

// Site-monitor steps whose work exists only in the legacy runtime: the display-window purge empties the output cache.
const STEP_FACTS: Readonly<Record<string, RuntimeFact>> = Object.freeze({
  'cache-purge': { runtimeCategory: 'theme-render' },
});

// Legacy states that never hold while a request runs in the oracle environment. A write reached only under one stays as
// evidence in the closure and in its table's writers, but is left out of the write set an item is disposed by:
// - cluster commands are written only with broadcasting on and peers present (clusterManager.cfc:203-211), which the
//   environment check asserts never hold;
// - a stored site missing from the in-memory registry is loaded on demand with its module configuration
//   (settingsManager.cfc:440-486); start-up fills the registry and the projector refreshes it after every site
//   change, so those writes are the start-up writer's, not the request's.
const ENVIRONMENT_GUARDS: readonly { tables: readonly string[] | null; condition: RegExp }[] = Object.freeze([
  { tables: ['tclustercommands'], condition: /\bbroadcastClusterCommands\b|\brsPeers\.recordcount\b/i },
  { tables: null, condition: /!\(\s*structKeyExists\(\s*variables\.sites\s*,/i },
]);

/** The migration plan's static figures, by measure, that the computed counts are compared with. */
const AAP_FIGURES: Readonly<Record<string, number>> = Object.freeze({
  'tables.bootstrap': 41,
  'tables.migration': 12,
  'tables.ormOnly': 21,
  'tables.staticTotal': 73,
  'tables.withSiteId': 54,
  'entities.ormBase': 4,
  'entities.ormConcrete': 24,
  'controllers.circuits': 25,
  dbUpdates: 37,
  coreMuraActionFiles: 21,
});

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byId<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareText(a.id, b.id));
}

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function baseKey(routeKey: string): string {
  return normaliseInventoryKey(routeKey).replace(/\{[^{}]*\}$/, '');
}

function adminFacts(routeKey: string): RuntimeFact {
  return own(ADMIN_FACTS, baseKey(routeKey)) ?? own(ADMIN_FACTS, areaKeyForRouteKey(routeKey)) ?? {};
}

function serviceFacts(componentPath: string): RuntimeFact {
  return SERVICE_FACTS.find(([prefix]) => componentPath.startsWith(prefix))?.[1] ?? {};
}

/** Request predicates of a variant branch in the flat form split-table ownership reads; disjunctions and negations stay open. */
function predicatesOf(when: VariantPredicate['when']): VariantPredicates {
  const out: Record<string, string | boolean> = {};
  for (const c of when) {
    if ('equals' in c) out[c.param] = c.equals;
    else if ('in' in c && c.in.length === 1 && c.in[0] !== undefined) out[c.param] = c.in[0];
    else if ('nonEmpty' in c) out[c.param] = true;
    else if ('truthy' in c) out[c.param] = 'true';
  }
  return out;
}

function guardsOf(table: string): RegExp[] {
  const key = tableKey(table);
  return ENVIRONMENT_GUARDS.filter((g) => g.tables === null || g.tables.some((t) => tableKey(t) === key)).map((g) => g.condition);
}

/** Writes of a closure with the guard conditions it recorded for them. */
type WriteEvidenceOf = Pick<WriteClosure, 'writes' | 'conditionalWrites'>;

/** Whether `w` runs only under an environment guard of its table on every path `conditionalWrites` records for it. */
function guardedWrite(w: ClosureWrite, conditionalWrites: readonly ConditionalWrite[]): boolean {
  if (w.table === null || !w.conditional) return false;
  const guards = guardsOf(w.table);
  if (guards.length === 0) return false;
  const key = tableKey(w.table);
  const paths = conditionalWrites.filter(
    (c) =>
      tableKey(c.table) === key &&
      c.source.path === w.source.path &&
      c.source.lines[0] === w.source.lines[0] &&
      c.source.lines[1] === w.source.lines[1],
  );
  return paths.length > 0 && paths.every((c) => guards.some((g) => g.test(c.condition)));
}

/** Tables of `writeSet` written in `closures`, each of whose writes there runs only under an environment guard. */
function environmentExcluded(writeSet: readonly string[], closures: readonly WriteEvidenceOf[]): string[] {
  return writeSet.filter((table) => {
    const key = tableKey(table);
    const verdicts = closures.flatMap((c) =>
      c.writes.filter((w) => w.table !== null && tableKey(w.table) === key).map((w) => guardedWrite(w, c.conditionalWrites)),
    );
    return verdicts.length > 0 && verdicts.every(Boolean);
  });
}

/** `writeSet` without the tables in `excluded`. */
function without(writeSet: readonly string[], excluded: readonly string[]): string[] {
  const drop = new Set(excluded.map(tableKey));
  return writeSet.filter((t) => !drop.has(tableKey(t)));
}

/** The write closure fields of a route entry, in the shape `attachWriters` reads. */
function routeClosure(r: RouteEntry): WriteClosure {
  return {
    tables: r.writeSet,
    writes: r.closureEvidence,
    conditionalWrites: r.conditionalWrites,
    fileStore: r.fileStoreWrite,
    fileStoreEvidence: r.fileStoreEvidence,
    sessionEffects: r.sessionEffects,
    threads: r.threads,
    unresolved: r.unresolved,
    overrides: r.overrides,
    visited: [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------------------------------------------

/** Applies `decide` to one item, optionally under a narrowed ownership view, and records its findings. */
interface Disposer {
  dispose(facts: DispositionFacts, ownership?: TableOwnership): DispositionFields;
  readonly findings: DispositionFinding[];
}

function fieldsOf(r: DispositionResult, decisionListGap: boolean): DispositionFields {
  return {
    owningService: r.owningService,
    owners: r.owners,
    ownerBasis: r.ownerBasis,
    disposition: r.disposition,
    dispositionStep: r.dispositionStep,
    dispositionReason: r.basis,
    withheld: r.withheld,
    legacyWrite: r.legacyWrite,
    haltedBy: r.haltedBy ?? null,
    protocol: r.protocol ?? null,
    decisionListRef: r.decisionListRef ?? null,
    decisionListGap,
    correction: r.correction ?? null,
  };
}

function createDisposer(inputs: InventoryInputs): Disposer {
  const findings: DispositionFinding[] = [];
  const ctx: DispositionContext = {
    ownership: inputs.ownership,
    decisionList: inputs.decisionList,
    exceptions: inputs.exceptions,
    findings,
  };
  return {
    findings,
    dispose(facts, ownership) {
      const before = findings.length;
      const result = decide(facts, ownership === undefined ? ctx : { ...ctx, ownership });
      return fieldsOf(result, findings.slice(before).some((f) => f.kind === 'decision-list-mismatch'));
    },
  };
}

function correctionText(c: DispositionCorrection): string {
  const parts: string[] = [];
  if (c.expected.disposition !== undefined) {
    parts.push(`AAP expects ${c.expected.disposition}, the rule computes ${c.computed.disposition} at step ${String(c.step)}`);
  }
  if (c.expected.owningService !== undefined) {
    parts.push(`expected owner ${c.expected.owningService}, computed owner ${c.computed.owningService ?? 'none'}`);
  }
  return `${parts.join('; ')} (${c.basis})`;
}

/** `fields` with a correction against the extractor's expected outcome when the rule found none of its own. */
function withExpected(
  fields: DispositionFields,
  expected: ExpectedOutcome | null,
  id: string,
  findings: GeneratedFinding[],
): DispositionFields {
  if (fields.correction !== null || expected === null) return fields;
  const want: DispositionCorrection['expected'] = {};
  if (expected.disposition !== fields.disposition) want.disposition = expected.disposition;
  if (expected.owningService !== null && expected.owningService !== fields.owningService) want.owningService = expected.owningService;
  if (want.disposition === undefined && want.owningService === undefined) return fields;
  const correction: DispositionCorrection = {
    expected: want,
    computed: { disposition: fields.disposition, owningService: fields.owningService },
    step: fields.dispositionStep,
    basis: fields.dispositionReason,
  };
  findings.push({ kind: 'correction', id, source: null, detail: `${correctionText(correction)} [${expected.ref}]` });
  return { ...fields, correction };
}

/** Unresolved calls reached by the inventoried entries, one finding per call site. */
class UnresolvedCalls {
  private readonly calls = new Map<string, { ref: UnresolvedRef; ids: Set<string> }>();

  note(id: string, refs: readonly UnresolvedRef[]): void {
    for (const ref of refs) {
      const key = JSON.stringify([ref.source.path, ref.source.lines, ref.kind, ref.expr]);
      const call = this.calls.get(key) ?? { ref, ids: new Set<string>() };
      call.ids.add(id);
      this.calls.set(key, call);
    }
  }

  findings(): GeneratedFinding[] {
    return [...this.calls.values()].map(({ ref, ids }) => {
      const [first, ...rest] = [...ids].sort(compareText);
      return {
        kind: 'unresolved-call',
        id: first ?? null,
        source: ref.source,
        detail:
          `${ref.kind} reference ${ref.expr}${rest.length > 0 ? ` (also reached from ${String(rest.length)} more)` : ''}; ` +
          `settle it in ${WRITER_OVERRIDES_REF}`,
      };
    });
  }
}

function controllerItems(entries: readonly ControllerEntry[], d: Disposer, calls: UnresolvedCalls): InventoryController[] {
  return byId(entries).map((c) => {
    const area = own(AREA_OWNERS, `admin:${c.circuit.toLowerCase()}`);
    const owner = area === undefined || area === NO_OWNER ? null : area;
    return {
      ...c,
      owningService: owner,
      ownerBasis: owner === null ? 'none' : 'aap-0.3.2',
      disposition: null,
      dispositionStep: null,
      actions: c.actions.map((a) => ({
        ...a,
        variants: a.variants.map((v): InventoryVariant => {
          calls.note(v.id, v.unresolvedCalls);
          const fact = adminFacts(v.routeKey);
          const excluded = environmentExcluded(v.writeSet, [{ writes: v.closureEvidence, conditionalWrites: v.conditionalWrites }]);
          const fields = d.dispose({
            itemKind: 'action',
            id: v.id,
            routeKey: v.routeKey,
            variantPredicates: predicatesOf(v.predicate?.when ?? []),
            reachable: true,
            writeSet: without(v.writeSet, excluded),
            fileStoreWrite: v.fileStoreWrite,
            rendersCfml: false,
            webRootFilesystem: fact.webRootFilesystem === true,
            runtimeCategory: fact.runtimeCategory,
            storedDataOwner: fact.storedDataOwner,
            areaKey: areaKeyForRouteKey(v.routeKey),
          });
          return { ...v, environmentExcludedWrites: excluded, ...fields };
        }),
      })),
    };
  });
}

function frontEndItems(
  entries: readonly FrontEndEntry[],
  d: Disposer,
  calls: UnresolvedCalls,
  findings: GeneratedFinding[],
): InventoryFrontEnd[] {
  return byId(entries).map((e) => {
    const { closure, ...entry } = e;
    calls.note(e.id, closure.unresolved);
    if (e.unkeyed || e.routeKey === null) {
      findings.push({ kind: 'unkeyed-entry', id: e.id, source: e.source, detail: `front-end entry ${e.name} has no platform route key` });
    }
    const excluded = environmentExcluded(e.writeSet, [closure]);
    const fields = d.dispose({
      itemKind: 'front-end',
      id: e.id,
      routeKey: e.routeKey ?? undefined,
      variantPredicates: predicatesOf(e.predicate?.when ?? []),
      reachable: e.reachable,
      writeSet: without(e.writeSet, excluded),
      fileStoreWrite: e.fileStoreWrite,
      rendersCfml: e.rendersCfml,
      webRootFilesystem: false,
      areaKey: e.routeKey === null ? e.id : areaKeyForRouteKey(e.routeKey),
    });
    return {
      ...entry,
      ...fields,
      environmentExcludedWrites: excluded,
      conditionalWrites: closure.conditionalWrites,
      threads: closure.threads,
      overrides: closure.overrides,
      unresolvedCalls: closure.unresolved,
      windowed: fields.legacyWrite && fields.owners.length > 0,
    };
  });
}

function jobItems(
  jobs: readonly ScheduledJobEntry[],
  d: Disposer,
  calls: UnresolvedCalls,
  findings: GeneratedFinding[],
): InventoryJob[] {
  return byId(jobs).map((job) => {
    // The orchestrator itself writes only its own cursor; each step is disposed by its own write set.
    const jobFields = d.dispose({
      itemKind: 'route',
      id: job.id,
      routeKey: job.routeKey,
      reachable: true,
      writeSet: [],
      fileStoreWrite: false,
      rendersCfml: false,
      webRootFilesystem: false,
      areaKey: areaKeyForRouteKey(job.routeKey),
    });
    const steps = job.steps.map((s): InventoryJobStep => {
      const { closure, ...step } = s;
      calls.note(s.id, closure.unresolved);
      const fact = own(STEP_FACTS, s.step) ?? {};
      const excluded = environmentExcluded(s.tables, [closure]);
      const fields = d.dispose({
        itemKind: 'job-step',
        id: s.id,
        reachable: true,
        writeSet: without(s.tables, excluded),
        fileStoreWrite: s.fileStoreWrite,
        rendersCfml: false,
        webRootFilesystem: false,
        // Steps whose writes come from handlers registered at run time are plugin monitor events.
        runtimeCategory: s.dynamic === true ? 'plugin' : fact.runtimeCategory,
        areaKey: s.id,
      });
      return { ...step, environmentExcludedWrites: excluded, ...withExpected(fields, s.expected, s.id, findings) };
    });
    return { ...job, ...withExpected(jobFields, job.expected, job.id, findings), steps };
  });
}

// The JSON API umbrella families and the SOAP components have no route key by construction.
function keyless(r: RouteEntry): boolean {
  return r.kind === 'soap' || (r.kind === 'api-family' && (r.family === 'api' || r.family === 'rest'));
}

function routeItems(
  routes: readonly RouteEntry[],
  d: Disposer,
  calls: UnresolvedCalls,
  findings: GeneratedFinding[],
): InventoryRoute[] {
  return byId(routes).map((r) => {
    calls.note(r.id, r.unresolved);
    if (r.routeKey === null && !keyless(r)) {
      findings.push({ kind: 'unkeyed-entry', id: r.id, source: r.source, detail: `${r.kind} route has no platform route key` });
    }
    const excluded = environmentExcluded(r.writeSet, [{ writes: r.closureEvidence, conditionalWrites: r.conditionalWrites }]);
    const fields = d.dispose({
      itemKind: r.kind === 'fixture' ? 'fixture-route' : r.kind === 'api-entity-method' || r.kind === 'api-method' ? 'api' : 'route',
      id: r.id,
      routeKey: r.routeKey ?? undefined,
      variantPredicates: predicatesOf(r.predicate?.when ?? []),
      reachable: r.reachable,
      writeSet: without(r.writeSet, excluded),
      fileStoreWrite: r.fileStoreWrite,
      rendersCfml: r.rendersCfml,
      webRootFilesystem: r.webRootFilesystem,
      runtimeCategory: r.runtimeCategory ?? undefined,
      areaKey: r.areaKey,
      fixtureModule: r.fixtureModule ?? undefined,
    });
    return { ...r, environmentExcludedWrites: excluded, ...fields };
  });
}

/** Closures behind an entity's `writesTables`, rooted as `attachDaoWrites` roots them. */
function entityClosures(e: EntityEntry, ctx: ClosureContext): WriteClosure[] {
  if (e.writesBasis === 'bean-save') return [computeClosure({ component: e.source.path, method: 'save' }, ctx)];
  const dao = e.dao;
  if (e.writesBasis !== 'dao-methods' || dao === null) return [];
  return (ctx.index.parsed(dao)?.functions ?? []).filter((f) => f.name !== '').map((f) => computeClosure({ component: dao, method: f.name }, ctx));
}

function entityItems(entities: readonly EntityEntry[], ctx: ClosureContext, d: Disposer): InventoryEntity[] {
  return byId(entities).map((e) => {
    const writeSet = e.writesTables ?? (e.table === null ? [] : [e.table]);
    const excluded = environmentExcluded(writeSet, entityClosures(e, ctx));
    const fields = d.dispose({
      itemKind: 'entity',
      id: e.id,
      reachable: true,
      writeSet: without(writeSet, excluded),
      fileStoreWrite: false,
      rendersCfml: false,
      webRootFilesystem: false,
      areaKey: `entity:${e.id}`,
    });
    return { ...e, environmentExcludedWrites: excluded, ...fields };
  });
}

function serviceItems(
  services: readonly ServiceEntry[],
  tables: readonly TableEntry[],
  routes: readonly RouteEntry[],
  evidence: readonly WriteEvidence[],
  d: Disposer,
): InventoryService[] {
  // SOAP v1 components are registered beans whose only entry point, the SOAP route, is unreachable at the pin.
  const unreachable = new Set(routes.filter((r) => r.kind === 'soap' && !r.reachable).map((r) => r.source.path));
  const written = new Map<string, Set<string>>();
  for (const t of tables) {
    for (const w of t.writers) written.set(w.component, (written.get(w.component) ?? new Set<string>()).add(t.table));
  }
  return byId(services).map((s) => {
    const tablesWritten = [...(written.get(s.source.path) ?? [])].sort(compareText);
    const own = evidence.map((ev) => ({
      writes: ev.closure.writes.filter((w) => w.component === s.source.path),
      conditionalWrites: ev.closure.conditionalWrites,
    }));
    const excluded = environmentExcluded(tablesWritten, own);
    const fact = serviceFacts(s.source.path);
    const fields = d.dispose({
      itemKind: 'service',
      id: s.id,
      reachable: !unreachable.has(s.source.path),
      writeSet: without(tablesWritten, excluded),
      fileStoreWrite: false,
      rendersCfml: false,
      webRootFilesystem: fact.webRootFilesystem === true,
      runtimeCategory: fact.runtimeCategory,
      areaKey: `service:${s.id}`,
    });
    return { ...s, tablesWritten, environmentExcludedWrites: excluded, ...fields };
  });
}

type OwnershipEntry = TableOwnership['tables'][number];

function ownershipLookup(ownership: TableOwnership): (table: string) => OwnershipEntry | undefined {
  const exact = new Map(ownership.tables.map((t) => [tableKey(t.table), t]));
  const patterns = ownership.tables
    .filter((t) => t.table.endsWith('*'))
    .map((t) => ({ prefix: tableKey(t.table.slice(0, -1)), entry: t }));
  return (table) => {
    const key = tableKey(table);
    return exact.get(key) ?? patterns.find((p) => key.startsWith(p.prefix))?.entry;
  };
}

function stepRank(step: DispositionStep): number {
  return typeof step === 'number' ? step : Number.MAX_SAFE_INTEGER;
}

/** Table-level fields of a split table: the first carried unit's disposition, else its earliest-step unit's. */
function splitFields(units: readonly UnitDisposition[]): DispositionFields {
  const lead = units.find((u) => u.disposition === 'carry') ?? [...units].sort((a, b) => stepRank(a.dispositionStep) - stepRank(b.dispositionStep))[0];
  if (lead === undefined) throw new Error('a split table needs at least one target unit');
  return {
    owningService: null,
    owners: [...new Set(units.flatMap((u) => u.owners))].sort(compareText),
    ownerBasis: 'table-ownership',
    disposition: lead.disposition,
    dispositionStep: lead.dispositionStep,
    dispositionReason: `split across ${String(units.length)} target units; each unit is disposed in unitDispositions`,
    withheld: units.every((u) => u.withheld),
    legacyWrite: lead.legacyWrite,
    haltedBy: null,
    protocol: null,
    decisionListRef: null,
    decisionListGap: units.some((u) => u.decisionListGap),
    correction: null,
  };
}

function tableItems(tables: readonly TableEntry[], ownership: TableOwnership, d: Disposer): InventoryTable[] {
  const ownershipOf = ownershipLookup(ownership);
  return byId(tables).map((t) => {
    const facts: DispositionFacts = {
      itemKind: 'table',
      id: t.id,
      reachable: true,
      tableAbsent: t.retired,
      writeSet: [t.table],
      fileStoreWrite: false,
      rendersCfml: false,
      webRootFilesystem: false,
      areaKey: `table:${t.table}`,
    };
    const entry = ownershipOf(t.table);
    // A split table is one item per target unit: each unit is decided under an ownership view holding only that unit.
    const units: UnitDisposition[] =
      entry === undefined || entry.owner !== 'split' || t.retired
        ? []
        : entry.targets.map((target) => ({
            unit: target.unit,
            rowPredicate: typeof target.rowPredicate === 'string' ? target.rowPredicate : null,
            ...d.dispose(
              { ...facts, id: `${t.id}#${target.unit}` },
              { ...ownership, tables: [{ ...entry, owner: target.owner, targets: [target] }] },
            ),
          }));
    const fields = units.length > 0 ? splitFields(units) : d.dispose(facts);
    const { owningService, decisionListRef, ...rest } = t;
    return {
      ...rest,
      ...fields,
      decisionListRef: fields.decisionListRef ?? decisionListRef,
      ownershipOwner: owningService,
      ruleSteps: [...t.ownershipRuleStep],
      hasSiteIdLive: t.live?.hasSiteId ?? null,
      hasPrimaryKeyLive: t.live?.hasPrimaryKey ?? null,
      unitDispositions: units,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------------------------

const PENDING_LIVE_CHECK: PendingLiveCheck = Object.freeze({
  procedures: null,
  triggers: null,
  databaseTriggers: null,
  functions: null,
  total: null,
  excludedSchemas: null,
  takenBeforeFixtures: null,
  checkedAt: null,
  objects: null,
});

async function loadInputs(given: Partial<InventoryInputs> = {}): Promise<InventoryInputs> {
  return {
    roleOverrides: given.roleOverrides ?? (await loadRoleOverrides()),
    writerOverrides: given.writerOverrides ?? (await loadWriterOverrides()),
    variants: given.variants ?? (await loadInventoryVariants()),
    ownership: given.ownership ?? (await loadTableOwnership()),
    decisionList: given.decisionList ?? (await loadDecisionList()),
    exceptions: given.exceptions ?? (await loadExceptions()),
    fixtureTree: given.fixtureTree,
  };
}

function compareFindings(a: GeneratedFinding, b: GeneratedFinding): number {
  return (
    compareText(a.kind, b.kind) ||
    compareText(a.id ?? a.measure ?? '', b.id ?? b.measure ?? '') ||
    compareText(a.source?.path ?? '', b.source?.path ?? '') ||
    (a.source?.lines[0] ?? 0) - (b.source?.lines[0] ?? 0) ||
    compareText(a.detail ?? '', b.detail ?? '')
  );
}

function countDifferences(computed: Readonly<Record<string, number>>): GeneratedFinding[] {
  return Object.entries(AAP_FIGURES).flatMap(([measure, aapFigure]): GeneratedFinding[] => {
    const value = computed[measure];
    return value === undefined || value === aapFigure
      ? []
      : [{ kind: 'count-difference', id: null, measure, source: null, detail: null, aapFigure, computed: value }];
  });
}

async function buildInventory(tree: SourceTree, opts: GenerateOptions): Promise<LegacyInventory> {
  const sha = pinnedSha();
  const inputs = await loadInputs(opts.inputs);
  const live = opts.live;
  const disposer = createDisposer(inputs);
  const calls = new UnresolvedCalls();
  const findings: GeneratedFinding[] = [];

  // Entities, then the services and aliases that make up the closures' component index.
  const entityExtraction = extractEntities(tree);
  const aliases = extractAliases(tree);
  const serviceEntries = extractServices(tree);
  const transients = extractTransients(tree);
  const index = buildComponentIndex({ services: serviceEntries, transients, aliases, ormIndex: entityExtraction.ormIndex, tree });
  const ctx: ClosureContext = { tree, index, overrides: inputs.writerOverrides };
  const liveEntities: LiveEntities | null = live === undefined ? null : await fetchLiveEntities(live.origin, { fetch: live.fetch });
  const entities = attachDaoWrites(mergeLive(entityExtraction.entities, liveEntities, tree), ctx);

  // Entry points with their write closures, and the application start-up root.
  const variants = inputs.variants.variants;
  const controllers = await extractControllers(ctx, { variants, roleOverrides: inputs.roleOverrides });
  const frontEnd = await extractFrontEnd(tree, { index, overrides: inputs.writerOverrides, routeKeyOptions: { variants } });
  const jobs = await extractJobs(ctx, { routeKeyOptions: { variants } });
  const routes = await extractRoutes(tree, { index, overrides: inputs.writerOverrides, variants, fixtureTree: inputs.fixtureTree });
  const appStart = tree.exists(STARTUP_PATH) ? computeClosure({ component: STARTUP_PATH, method: '', trigger: 'appstart' }, ctx) : null;
  const coreMuraActionSearch = searchCoreMuraAction(tree);

  // Tables, the live catalog, writers from every entry point's evidence, then owners.
  const tableExtraction = extractTables(tree, entityExtraction.ormTables);
  const catalog = live === undefined ? null : await fetchLiveCatalog(live.db);
  const declaredEntityTables = (liveEntities?.entities ?? []).flatMap((e) => (e.origin === 'dynamic' && e.table ? [e.table] : []));
  const evidence: WriteEvidence[] = [
    ...controllers.writeEvidence,
    ...frontEnd.frontEnd.map((e) => ({ entryRouteKey: e.routeKey, trigger: e.trigger, closure: e.closure })),
    ...jobWriteEvidence(jobs.scheduledJobs),
    ...routes.routes.map((r) => ({ entryRouteKey: r.routeKey, trigger: 'request' as const, closure: routeClosure(r) })),
    ...(appStart === null ? [] : [{ entryRouteKey: null, trigger: 'appstart' as const, closure: appStart }]),
  ];
  const attached = attachWriters(
    mergeLiveCatalog(tableExtraction.tables, catalog, { declaredEntityTables }),
    evidence,
    inputs.writerOverrides,
    { jobs: jobs.scheduledJobs },
  );
  const tables = assignOwners(attached.tables, inputs.ownership);

  // Relations and the stored-procedure check.
  const relations = extractRelations({ entities, tables, tree, index: entityExtraction.ormIndex, ownership: inputs.ownership });
  const procedures = await storedProcedureCheck(tree, {
    db: live?.db,
    fixturesLoaded: live?.fixturesLoaded,
    expectedDbUpdates: opts.expectedDbUpdates,
  });

  // Dispositions, once per item.
  const controllerItemsOut = controllerItems(controllers.controllers, disposer, calls);
  const frontEndOut = frontEndItems(frontEnd.frontEnd, disposer, calls, findings);
  const jobsOut = jobItems(jobs.scheduledJobs, disposer, calls, findings);
  const routesOut = routeItems(routes.routes, disposer, calls, findings);
  const entitiesOut = entityItems(entities, ctx, disposer);
  const servicesOut = serviceItems(serviceEntries, tables, routes.routes, evidence, disposer);
  const tablesOut = tableItems(tables, inputs.ownership, disposer);

  for (const g of controllers.unclassifiedGates) {
    const circuit = g.circuit.toLowerCase();
    const roles = g.actions === null ? `role:${circuit}.*` : g.actions.map((a) => `role:${circuit}.${a}`).join(', ');
    findings.push({
      kind: 'unclassified-gate',
      id: `ctl:${circuit}`,
      source: g.source,
      detail: `before() gate of ${g.circuit} for ${g.actions === null ? 'every action' : g.actions.join(', ')} matches no extractor pattern; add ${roles} to ${ROLE_OVERRIDES_REF}`,
    });
  }
  for (const u of attached.unmatched) {
    findings.push({
      kind: 'unmatched-write',
      id: null,
      source: u.source,
      detail: `${u.component}#${u.method} writes ${u.table}, which no tables[] entry lists${u.override === null ? '' : ` (override ${u.override})`}`,
    });
  }
  for (const j of jobs.differences) {
    findings.push({
      kind: 'correction',
      id: `${j.jobId}.${j.step}`,
      source: null,
      detail: `site-monitor ${j.kind}: expected ${String(j.expected)}, computed ${String(j.computed)}`,
    });
  }
  for (const c of tableExtraction.corrections) {
    findings.push({
      kind: 'correction',
      id: null,
      measure: `tables.${c.measure}`,
      source: null,
      detail: `expected ${c.expected.join(', ') || 'none'}; computed ${c.computed.join(', ') || 'none'}`,
    });
  }
  for (const f of disposer.findings) findings.push({ kind: f.kind, id: f.id, source: null, detail: f.detail });
  findings.push(...calls.findings());

  const entityCounts = classCounts(entities);
  const staticCounts = tableExtraction.counts;
  findings.push(
    ...countDifferences({
      'tables.bootstrap': staticCounts.bootstrap,
      'tables.migration': staticCounts.migration,
      'tables.ormOnly': staticCounts.orm,
      'tables.staticTotal': staticCounts.staticTotal,
      'tables.withSiteId': staticCounts.withSiteId,
      'entities.ormBase': entityCounts.ormBase,
      'entities.ormConcrete': entityCounts.ormConcrete,
      'controllers.circuits': controllers.counts.circuits,
      dbUpdates: tree.list(DB_UPDATES_DIR, { ext: ['cfm'] }).length,
      coreMuraActionFiles: coreMuraActionSearch.filesMentioning,
    }),
  );

  const variantsOut = controllerItemsOut.flatMap((c) => c.actions.flatMap((a) => a.variants));
  const dispositions: Record<Disposition, number> = { carry: 0, 'legacy-served': 0, decision: 0, retired: 0 };
  const disposed: readonly DispositionFields[] = [
    ...variantsOut,
    ...frontEndOut,
    ...jobsOut.flatMap((j) => j.steps),
    ...routesOut,
    ...entitiesOut,
    ...servicesOut,
    ...tablesOut,
  ];
  for (const item of disposed) dispositions[item.disposition] += 1;
  const originCount = (origin: TableEntry['origin']): number => tables.filter((t) => t.origin === origin).length;
  const liveStatus: LiveStatus = live === undefined ? 'pending-run' : 'live';

  return {
    sourceSha: sha,
    generatedBy: GENERATED_BY,
    extractedFrom: { method: 'git archive', sha, workingTree: false },
    counts: {
      entities: {
        'orm-base': entityCounts.ormBase,
        'orm-concrete': entityCounts.ormConcrete,
        'not-entity': entityCounts.notEntity,
        'domain-bean': entityCounts.domainBean,
        dynamic: entityCounts.dynamic,
        dynamicPatterns: entityCounts.dynamicPatterns,
      },
      ormTables: { concrete: entityExtraction.ormTables.length, ormOnly: staticCounts.orm },
      services: {
        registeredSingletons: serviceEntries.length,
        serviceList: serviceEntries.reduce((n, s) => n + s.serviceListNames.length, 0),
        transient: transients.length,
        aliases: aliases.aliases.length,
        declaredBeans: aliases.declaredBeans.length,
      },
      controllers: controllers.counts,
      coreMuraActionFiles: coreMuraActionSearch.filesMentioning,
      frontEnd: frontEndOut.length,
      scheduledJobs: { jobs: jobsOut.length, siteMonitorSteps: jobsOut.reduce((n, j) => n + j.steps.length, 0) },
      routes: routes.counts,
      tables: {
        bootstrap: staticCounts.bootstrap,
        bootstrapAfterDrops: tableExtraction.tables.filter((t) => t.origin === 'bootstrap' && !t.retired).length,
        migrationCreated: staticCounts.migration,
        ormOnly: staticCounts.orm,
        staticTotal: staticCounts.staticTotal,
        retired: staticCounts.retired,
        withSiteIdStatic: staticCounts.withSiteId,
        withoutPrimaryKeyBootstrap: staticCounts.withoutPrimaryKeyBootstrap,
        withoutPrimaryKey: staticCounts.withoutPrimaryKey,
        fixture: originCount('fixture'),
        dynamic: originCount('dynamic'),
        liveOnly: originCount('live-only'),
        live: catalog === null ? null : tables.filter((t) => t.live?.present === true).length,
        withSiteIdLive: catalog === null ? null : tables.filter((t) => t.live?.present === true && t.live.hasSiteId === true).length,
      },
      relations: relations.counts,
      storedProcedures: {
        static: procedures.static.count,
        live: procedures.live?.total ?? null,
        foreignKeys: procedures.foreignKeys.static,
      },
      dispositions,
      liveStatus,
    },
    entities: entitiesOut,
    services: servicesOut,
    controllers: controllerItemsOut,
    coreMuraActionSearch,
    frontEnd: frontEndOut,
    scheduledJobs: jobsOut,
    routes: routesOut,
    tables: tablesOut,
    relations: byId(relations.relations),
    storedProcedureCheck: { ...procedures, live: procedures.live ?? PENDING_LIVE_CHECK },
    findings: findings.sort(compareFindings),
  };
}

/** The Markdown text `writeMarkdown` writes for `inv`. */
function markdownOf(inv: LegacyInventory): string {
  const { title, lines } = renderInventoryMarkdown(inv);
  return `${[`# ${title}`, `Source SHA: ${inv.sourceSha}`, '', ...lines].join('\n').replace(/\n+$/, '')}\n`;
}

/** Generates the inventory and its Markdown without writing; extracts the pinned commit unless `opts.sourceTree` is given. */
export async function generateInventory(opts: GenerateOptions = {}): Promise<GenerateResult> {
  if (opts.sourceTree !== undefined) {
    const inventory = await buildInventory(opts.sourceTree, opts);
    return { inventory, markdown: markdownOf(inventory), extractDir: null };
  }
  const dir = await gitArchiveExtract(readPin().sha);
  try {
    const inventory = await buildInventory(openSourceTree(dir), opts);
    return { inventory, markdown: markdownOf(inventory), extractDir: opts.keepExtract === true ? dir : null };
  } finally {
    if (opts.keepExtract !== true) await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------

/** Writes the inventory JSON and its Markdown rendering into `outDir`; returns both absolute paths. */
export async function writeInventory(inv: LegacyInventory, outDir: string): Promise<string[]> {
  const sha = pinnedSha();
  if (inv.sourceSha !== sha) throw new Error(`inventory sourceSha ${inv.sourceSha} differs from the pinned SHA ${sha}`);
  await mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, INVENTORY_JSON);
  await writeFile(jsonPath, stableStringify(inv), 'utf8');
  const { title, lines } = renderInventoryMarkdown(inv);
  return [jsonPath, await writeMarkdown(path.join(outDir, INVENTORY_MD), title, lines)];
}

/** Outcome of comparing generated text with the files in the output directory. */
export interface InventoryCheck {
  json: { match: boolean; firstDifference: string | null };
  markdown: { match: boolean; firstDifferingLine: number | null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON path of the first value that differs between `a` and `b`, keys visited in code-unit order; null when equal. */
export function firstJsonDifference(a: unknown, b: unknown, at = '$'): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const found = firstJsonDifference(a[i], b[i], `${at}[${String(i)}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (isRecord(a) && isRecord(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compareText)) {
      const found = firstJsonDifference(a[key], b[key], `${at}.${key}`);
      if (found !== null) return found;
    }
    return null;
  }
  return at;
}

function jsonDifference(generated: string, committed: string | null): string | null {
  if (committed === generated) return null;
  if (committed === null) return '$ (file absent)';
  let parsed: unknown;
  try {
    parsed = JSON.parse(committed);
  } catch {
    return '$ (committed file is not valid JSON)';
  }
  return firstJsonDifference(JSON.parse(generated), sortKeysDeep(parsed)) ?? '$ (equal values, different serialisation)';
}

function firstDifferingLine(generated: string, committed: string | null): number | null {
  if (committed === generated) return null;
  if (committed === null) return 1;
  const a = generated.split('\n');
  const b = committed.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i + 1;
  return null;
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Compares the generated JSON and Markdown with the files in `outDir` without writing. */
export async function checkInventory(result: Pick<GenerateResult, 'inventory' | 'markdown'>, outDir: string): Promise<InventoryCheck> {
  const json = jsonDifference(stableStringify(result.inventory), await readIfPresent(path.join(outDir, INVENTORY_JSON)));
  const line = firstDifferingLine(result.markdown, await readIfPresent(path.join(outDir, INVENTORY_MD)));
  return {
    json: { match: json === null, firstDifference: json },
    markdown: { match: line === null, firstDifferingLine: line },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

const USAGE = 'inventory [--live] [--check] [--out <dir>] [--keep-extract]';
const HELP = `${USAGE} [--help]

Generates the legacy inventory from a git archive extraction of the pinned commit and writes
legacy-inventory.json and legacy-inventory.md.

Options:
  --live          add live entity registrations (LEGACY_ORIGIN, else http://127.0.0.1:$PORT) and the read-only
                  SQL Server catalog (MURA_DB* variables)
  --check         generate in memory and compare with the files in the output directory; exit 1 on a difference
                  and write nothing
  --out <dir>     output directory; a relative path resolves against the working directory (default: opt2/inventory)
  --keep-extract  keep the archive extraction and report its path
  --help          print this help and exit 0
`;

async function fixturesLoaded(env: EnvLike): Promise<boolean> {
  const text = await readIfPresent(path.join(stateDir(env), 'fixtures.json'));
  return text !== null && (JSON.parse(text) as { available?: unknown }).available === true;
}

/** Live sources from the environment; the caller closes `db`. */
async function openLiveSources(env: EnvLike): Promise<LiveSources> {
  const origin = env.LEGACY_ORIGIN || (env.PORT ? `http://127.0.0.1:${env.PORT}` : undefined);
  if (origin === undefined) throw new UsageError('--live needs LEGACY_ORIGIN or PORT', USAGE);
  const loaded = await fixturesLoaded(env);
  return { origin, db: await createReadOnlyMssql(env), fixturesLoaded: loaded };
}

function displayPath(p: string): string {
  return isInsideRepo(p) ? path.relative(REPO_ROOT, p).split(path.sep).join('/') : p;
}

function summaryOf(inv: LegacyInventory): Record<string, unknown> {
  return {
    entities: inv.entities.length,
    services: inv.services.length,
    controllers: inv.controllers.length,
    actions: inv.controllers.reduce((n, c) => n + c.actions.length, 0),
    frontEnd: inv.frontEnd.length,
    routes: inv.routes.length,
    tables: inv.tables.length,
    relations: inv.relations.length,
    findings: inv.findings.length,
    liveStatus: inv.counts.liveStatus,
  };
}

/** CLI entry point: generates the inventory, then checks it against or writes it to the output directory. */
export async function main(argv: string[], env: EnvLike = process.env): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: { live: { type: 'boolean' }, check: { type: 'boolean' }, out: { type: 'string' }, 'keep-extract': { type: 'boolean' } },
    usage: USAGE,
    help: HELP,
  });
  if (values.out === '') throw new UsageError('--out needs a directory', USAGE);
  const outDir = values.out === undefined ? opt2Path('inventory') : path.resolve(values.out);
  const live = values.live === true ? await openLiveSources(env) : undefined;
  let result: GenerateResult;
  try {
    result = await generateInventory({ live, keepExtract: values['keep-extract'] === true });
  } finally {
    await live?.db.close();
  }
  const summary: Record<string, unknown> = { ...summaryOf(result.inventory), wrote: [] };
  if (result.extractDir !== null) summary.extract = result.extractDir;

  const gates = result.inventory.findings.filter((f) => f.kind === 'unclassified-gate');
  if (gates.length > 0) {
    for (const g of gates) {
      process.stderr.write(`unclassified gate ${g.id ?? ''} at ${g.source?.path ?? ''}:${String(g.source?.lines[0] ?? '')}: ${g.detail ?? ''}\n`);
    }
    return { code: 1, summary: { ...summary, unclassifiedGates: gates.map((g) => ({ id: g.id, source: g.source })) } };
  }
  if (values.check === true) {
    const check = await checkInventory(result, outDir);
    return { code: check.json.match && check.markdown.match ? 0 : 1, summary: { ...summary, check } };
  }
  const wrote = await writeInventory(result.inventory, outDir);
  return { summary: { ...summary, wrote: wrote.map(displayPath) } };
}

if (isMainModule(import.meta.url)) void runCli(main);
