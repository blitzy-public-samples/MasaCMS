// Types of the cut-over table, write-authority groups, routing index, validator findings and generator inputs.
import type { RouteFamily, VariantDeclaration, matchRouteKey } from '@opt2/platform/legacy-compat';

/** Side that is authoritative for a route, group or unit. */
export type Authority = 'legacy' | 'target';

/** How the dispatcher treats a cut-over entry. */
export type EntryKind = 'read' | 'write' | 'legacy-write' | 'job' | 'static';

/** Legacy disposition of an inventoried item. */
export type Disposition = 'retired' | 'carry' | 'legacy-served' | 'decision';

/** Process that serves an entry once it is `target`; `none` when no target process serves it. */
export type OwningService =
  | 'identity'
  | 'people'
  | 'programs-sites'
  | 'strategies-content'
  | 'communications'
  | 'reporting'
  | 'surveys'
  | 'timesheets'
  | 'finance'
  | 'e-signature'
  | 'stub'
  | 'web'
  | 'gateway'
  | 'none';

/** One route of a cut-over version; `route` is a canonical route key and `group` is set only on `write` entries. */
export interface CutoverEntry {
  route: string;
  owningService: OwningService;
  tableVersion: string;
  state: Authority;
  kind: EntryKind;
  group?: string | null;
  units: string[];
  disposition: Disposition;
}

/** Groups a version returns to legacy, with the computed rollback set and its reconciliation evidence. */
export interface RollbackRef {
  groups: string[];
  rollbackSet: string[];
  report: string;
  evidence: string[];
}

/** One immutable cut-over version file, `gateway/cutover/versions/vNNNN.json`. */
export interface CutoverTable {
  tableVersion: string;
  previous: string | null;
  sourceSha: string;
  createdAt: string;
  groupAuthority: Record<string, Authority>;
  rollbackRefs: RollbackRef[];
  entries: CutoverEntry[];
}

/** A generated write-authority group: its units and the carry write entries that write them. */
export interface CutoverGroup {
  id: string;
  units: string[];
  writeEntries: string[];
  hasCarryWrite: boolean;
}

/** `gateway/cutover/groups.json`. */
export interface GroupsFile {
  sourceSha: string;
  generatedBy: string;
  inputs: { inventorySha256: string; tableOwnershipSha256: string };
  groups: CutoverGroup[];
}

/** `gateway/cutover/variants.json`. */
export interface VariantsFile {
  sourceSha: string;
  variants: VariantDeclaration[];
}

/** Whether a route's branch consumes a CSRF token: validates it, skips the check, or carries none. */
export type CsrfValidation = 'validates' | 'bypassed' | 'none';

/** Shape of a legacy admin response. */
export type ResponseMode = 'page' | 'fragment' | 'json' | 'redirect' | 'download';

/** Change a legacy write makes to the session user's login state. */
export type SessionEffect = 'none' | 'login' | 'logout' | 'relogin';

/** Inventory facts of one route key that session, CSRF and write-window handling read. */
export interface RouteFacts {
  route: string;
  csrfValidation: CsrfValidation;
  csrfContext?: string;
  responseMode?: ResponseMode;
  contentType?: string;
  writeSet: string[];
  keyScope: string[];
  sessionEffects: SessionEffect[];
}

/** Route facts by route key. */
export interface InventoryFacts {
  get(routeKey: string): RouteFacts | undefined;
  routes(): string[];
}

/** Lookup over an active cut-over version and the groups behind its unit authority. */
export interface RoutingIndex {
  readonly table: CutoverTable;
  entryFor(routeKey: string): CutoverEntry | undefined;
  readonly matchKeys: Parameters<typeof matchRouteKey>[1];
  unitAuthority(unit: string): Authority;
  groupOf(routeKey: string): string | undefined;
  groupAuthority(groupId: string): Authority;
  loginGroupAuthority(): Authority;
}

/** Rule a cut-over version finding violates. */
export type FindingRule =
  | 'schema'
  | 'route-once'
  | 'route-not-inventoried'
  | 'target-only-carry'
  | 'withheld-never-target'
  | 'legacy-served-never-target'
  | 'write-follows-group'
  | 'read-follows-units'
  | 'legacy-write-always-legacy'
  | 'job-state'
  | 'halted-is-legacy-write'
  | 'halted-read-legacy'
  | 'unprevented-writer'
  | 'rollback-evidence'
  | 'source-sha'
  | 'previous-chain'
  | 'group-unknown'
  | 'group-authority'
  | 'variant-undeclared';

/** One validator finding, as a `ValidationFindings` item of the gateway contract. */
export interface Finding {
  rule: FindingRule;
  route?: string;
  unit?: string;
  group?: string;
  message: string;
}

/** A path and inclusive `[first, last]` line range in the pinned source. */
export interface SourceRef {
  readonly path: string;
  readonly lines: readonly [number, number];
}

/** One unit a legacy branch writes, with the call path that reaches it. */
export interface InventoryWrite {
  readonly unit: string;
  readonly legacyTable: string | null;
  readonly op: string;
  readonly via: readonly string[];
  readonly source: SourceRef;
  readonly condition: string | null;
  readonly override: string | null;
}

/** A write a branch reaches only under a guard the inventory cannot decide. */
export interface InventoryConditionalWrite {
  readonly kind: string;
  readonly unit: string | null;
  readonly legacyTable: string | null;
  readonly op: string | null;
  readonly via: readonly string[];
  readonly source: SourceRef;
  readonly guard: string;
}

/** Request predicate that selects an inventoried variant. */
export type InventoryPredicate = Readonly<Pick<VariantDeclaration, 'variant' | 'when'>>;

/** Fields every inventoried item carries. */
export interface InventoryItem {
  readonly id: string;
  readonly source: SourceRef;
  readonly owningService: string | null;
  readonly disposition: Disposition;
}

/** An inventoried item with its computed write closure. */
export interface InventoryWritingItem extends InventoryItem {
  readonly writeSet: readonly InventoryWrite[];
  readonly conditionalWrites: readonly InventoryConditionalWrite[];
}

/** A route-bearing inventoried entry point. */
export interface InventoryEntryPoint extends InventoryWritingItem {
  readonly routeKey: string;
  readonly predicate: InventoryPredicate | null;
  readonly sessionEffects: SessionEffect;
}

/** An admin action variant with its CSRF and response facts. */
export interface InventoryActionVariant extends InventoryEntryPoint {
  readonly csrfValidation: CsrfValidation;
  readonly csrfContext: string | null;
  readonly responseMode: ResponseMode;
  readonly contentType: string | null;
}

/** A controller action: a public method or a view-only action. */
export interface InventoryAction {
  readonly id: string;
  readonly action: string;
  readonly variants: readonly InventoryActionVariant[];
}

/** An admin circuit, or the base controller. */
export interface InventoryController {
  readonly id: string;
  readonly circuit: string;
  readonly isBase: boolean;
  readonly owningService: string | null;
  readonly actions: readonly InventoryAction[];
}

/** Inventory classification of a `routes[]` item. */
export type InventoryRouteKind =
  | 'api-family'
  | 'api-entity-method'
  | 'api-method'
  | 'oauth'
  | 'fixture'
  | 'job'
  | 'static'
  | 'soap';

/** A route family, API entity or method, fixture or SOAP route; `routeKey` is null where no single key applies. */
export interface InventoryRoute extends Omit<InventoryEntryPoint, 'routeKey'> {
  readonly routeKey: string | null;
  readonly kind: InventoryRouteKind;
  readonly family: RouteFamily;
}

/** One step of a scheduled job, with its own write closure. */
export interface InventoryJobStep extends InventoryWritingItem {
  readonly order: number;
  readonly step: string;
}

/** A scheduled job and its ordered steps. */
export interface InventoryScheduledJob extends InventoryItem {
  readonly routeKey: string;
  readonly steps: readonly InventoryJobStep[];
}

/** How a legacy writer is reached. */
export type WriterTrigger = 'request' | 'scheduler' | 'thread' | 'appstart';

/** One legacy component method that writes a table. */
export interface InventoryWriter {
  readonly component: string;
  readonly method: string;
  readonly source: SourceRef;
  readonly op: string;
  readonly routeKeys: readonly string[];
  readonly keyScope: readonly string[];
  readonly trigger: WriterTrigger;
  readonly sessionEffects: SessionEffect;
  readonly condition: string | null;
  readonly override: string | null;
}

/** A legacy table with its writers. */
export interface InventoryTable extends InventoryItem {
  readonly table: string;
  readonly schema: string;
  readonly hasPrimaryKey: boolean | null;
  readonly writers: readonly InventoryWriter[];
}

/** `opt2/inventory/legacy-inventory.json`, the parts the cut-over generators and validator read. */
export interface InventoryDoc {
  readonly sourceSha: string;
  readonly controllers: readonly InventoryController[];
  readonly routes: readonly InventoryRoute[];
  readonly frontEnd: readonly InventoryEntryPoint[];
  readonly scheduledJobs: readonly InventoryScheduledJob[];
  readonly tables: readonly InventoryTable[];
}

/** A target-table unit of write authority and the legacy tables it maps. */
export interface OwnershipUnit {
  readonly unit: string;
  readonly owner: string;
  readonly legacyTables: readonly string[];
}

/** A target table a legacy table maps to, with the rows and columns it owns. */
export interface OwnershipTarget {
  readonly unit: string;
  readonly rowPredicate: string | null;
  readonly ownedColumns: readonly string[];
}

/** A legacy table's owner and target tables. */
export interface OwnershipTable {
  readonly table: string;
  readonly owner: string;
  readonly targets: readonly OwnershipTarget[];
}

/** `opt2/table-ownership.json`, the parts the cut-over generators and validator read. */
export interface OwnershipDoc {
  readonly sourceSha: string;
  readonly units: readonly OwnershipUnit[];
  readonly tables: readonly OwnershipTable[];
}

/** A decision-list table, for which nothing is built. */
export interface DecisionTable {
  readonly table: string;
}

/** A withheld action variant and the legacy tables it writes. */
export interface DecisionActionVariant {
  readonly routeKey: string;
  readonly writeSet: readonly string[];
}

/** `opt2/decision-list.json`, the parts the cut-over validator reads. */
export interface DecisionListDoc {
  readonly sourceSha: string;
  readonly tables: readonly DecisionTable[];
  readonly actionVariants: readonly DecisionActionVariant[];
}

/** A decision-list reference to a withheld entry point; null where no single key applies. */
export interface DecisionEntryPointRef {
  readonly routeKey: string | null;
}

/** `opt2/decision-list.json` with the withheld entry points its tables and action variants list. */
export interface DecisionListInput extends DecisionListDoc {
  readonly tables: readonly (DecisionTable & { readonly withheldEntryPoints?: readonly DecisionEntryPointRef[] })[];
  readonly actionVariants: readonly (DecisionActionVariant & { readonly entryPoints?: readonly DecisionEntryPointRef[] })[];
}

/** An exceptions-list entry and the route keys it applies to. */
export interface ExceptionEntry {
  readonly id: string;
  readonly routeKey: string;
  readonly appliesTo?: readonly string[];
  readonly decision: 'preserve' | 'fix';
  readonly status: 'open' | 'accepted' | 'halted';
}

/** `opt2/exceptions-list.json`, the parts the cut-over generators and validator read. */
export interface ExceptionsDoc {
  readonly sourceSha: string;
  readonly entries: readonly ExceptionEntry[];
}

/** `opt2/source-pin.json`, the pinned commit. */
export interface SourcePin {
  readonly sha: string;
  readonly subject: string;
  readonly repository: string;
  readonly confirmedAt: string;
  readonly confirmCommand: string;
}

/** `${OPT2_STATE_DIR}/fixtures.json`, written by `legacy-fixtures/load-fixtures.sh`. */
export interface FixtureStatus {
  readonly available: boolean;
  readonly reason?: string;
  readonly checkedAt?: string;
}
