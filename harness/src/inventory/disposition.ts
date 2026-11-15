// The one legacy disposition rule (AAP 0.5.6) over typed facts; owners come from the table-ownership file, withheld items from the decision list.
import { z } from '@opt2/platform/service-kit';
import { repoPath } from '../lib/paths.js';
import { pinnedSha } from '../lib/pin.js';
import { readJson } from '../lib/report.js';
import { normaliseInventoryKey } from './route-keys.js';
import { tableKey, type TableOwnership } from './tables.js';

/** Default location of the decision list. */
export const DECISION_LIST_PATH: string = repoPath('opt2/decision-list.json');

/** Default location of the exceptions list. */
export const EXCEPTIONS_LIST_PATH: string = repoPath('opt2/exceptions-list.json');

/** The services whose items can be carried; every other owner is legacy-served. */
export const MIGRATED_SERVICES: readonly string[] = Object.freeze(['identity', 'people', 'programs-sites', 'strategies-content']);

/** Area-owner value of an area no service owns. */
export const NO_OWNER = 'none';

/** `owningService` of a withheld item whose writes span owners and no proposal names one. */
export const SPANNING_OWNER = 'spanning';

/** Legacy table that stands for the file store in owner derivation: `tfiles` and the stored objects share its owner. */
export const FILE_STORE_TABLE = 'tfiles';

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/** One of the four dispositions every inventoried item takes. */
export type Disposition = 'retired' | 'decision' | 'legacy-served' | 'carry';

/** The rule step that settled a disposition; fixture routes are carried by definition. */
export type DispositionStep = 1 | 2 | 3 | 4 | 5 | 'fixture-definition';

/** Kind of an inventoried item. */
export type ItemKind = 'entity' | 'service' | 'action' | 'front-end' | 'route' | 'api' | 'fixture-route' | 'job-step' | 'table';

/** CFML-runtime dependence that makes an item legacy-served. */
export type RuntimeCategory =
  | 'plugin'
  | 'bundle'
  | 'export-html'
  | 'scaffolder'
  | 'auto-update'
  | 'cluster'
  | 'bean-metadata'
  | 'theme-render';

/** Stored value an item's owner depends on: an extended subtype's `baseTable` or a trash row's `objectClass`. */
export type StoredDataOwner = 'baseTable' | 'objectClass';

/** Request predicates of an item's variant branch, as the write closure takes them: a value, `true` (present) or `false`/`null` (absent). */
export type VariantPredicates = Readonly<Record<string, string | boolean | null>>;

/** Where an item's `owningService` comes from. */
export type OwnerBasis = 'table-ownership' | 'aap-0.3.2' | 'named-input' | 'decision-list-proposal' | 'fixture-module' | 'spanning' | 'none';

/** Cross-service write protocol a carried spanning item uses. */
export type WriteProtocol = 'roster-write';

/** Facts the rule decides an item from; `writeSet` lists the legacy tables its closure writes. */
export interface DispositionFacts {
  itemKind: ItemKind;
  id: string;
  routeKey?: string;
  variantPredicates?: VariantPredicates;
  reachable: boolean;
  tableAbsent?: boolean;
  writeSet: readonly string[];
  fileStoreWrite: boolean;
  rendersCfml: boolean;
  webRootFilesystem: boolean;
  runtimeCategory?: RuntimeCategory;
  storedDataOwner?: StoredDataOwner;
  areaKey: string;
  fixtureModule?: string;
}

/** A rule result that differs from the outcome the AAP 0.3.2 tables expect; the computed side governs. */
export interface DispositionCorrection {
  expected: { disposition?: Disposition; owningService?: string };
  computed: { disposition: Disposition; owningService: string | null };
  step: DispositionStep;
  basis: string;
}

/** Disposition of one item; optional members are absent when they do not apply. */
export interface DispositionResult {
  disposition: Disposition;
  dispositionStep: DispositionStep;
  /** Why the step applied. */
  basis: string;
  owningService: string | null;
  /** Owners of the write set, file store included; empty for an item that writes nothing. */
  owners: string[];
  ownerBasis: OwnerBasis;
  withheld: boolean;
  legacyWrite: boolean;
  haltedBy?: string;
  protocol?: WriteProtocol;
  decisionListRef?: string;
  correction?: DispositionCorrection;
}

/** Kind of a disposition finding. */
export type DispositionFindingKind = 'correction' | 'decision-list-mismatch';

/** A finding `decide` records for the inventory's findings list. */
export interface DispositionFinding {
  kind: DispositionFindingKind;
  id: string;
  itemKind: ItemKind;
  routeKey: string | null;
  detail: string;
  correction?: DispositionCorrection;
}

/** A named owner of a spanning branch and the protocol its writes use. */
export interface NamedSpanningOwner {
  owner: string;
  protocol: WriteProtocol;
  /** Services the protocol coordinates; a write set reaching any other owner is not covered. */
  participants: readonly string[];
}

/** Owners of a write set; decision-list tables are reported apart from the owners. */
export interface WriteSetOwners {
  owners: string[];
  decisionTables: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------

const decisionListSchema = z.looseObject({
  sourceSha: z.string(),
  tables: z.array(
    z.looseObject({ table: z.string().min(1), proposedOwner: z.string().min(1), buildWithheld: z.boolean() }),
  ),
  actionVariants: z.array(
    z.looseObject({
      routeKey: z.string().min(1),
      entryPoints: z.array(z.looseObject({ routeKey: z.string().min(1) })).optional(),
      owners: z.array(z.string().min(1)),
      proposal: z.string().min(1),
      proposedOwner: z.string().min(1).optional(),
    }),
  ),
  spanningControllers: z.array(z.looseObject({ controller: z.string().min(1) })),
});

/** A validated decision list; action-variant and entry-point route keys are normalised. */
export type DecisionList = z.infer<typeof decisionListSchema>;

const exceptionsListSchema = z.looseObject({
  sourceSha: z.string(),
  entries: z.array(
    z.looseObject({
      id: z.string().min(1),
      routeKey: z.string().min(1),
      appliesTo: z.array(z.string().min(1)).optional(),
      decision: z.enum(['preserve', 'fix']),
      status: z.enum(['open', 'accepted', 'halted']),
    }),
  ),
});

/** A validated exceptions list; `routeKey` and `appliesTo[]` values are normalised. */
export type ExceptionsList = z.infer<typeof exceptionsListSchema>;

/** The validated inputs `decide` reads, plus the list it appends findings to when given. */
export interface DispositionContext {
  ownership: TableOwnership;
  decisionList: DecisionList;
  exceptions: ExceptionsList;
  findings?: DispositionFinding[];
}

async function readPinned<T extends { sourceSha: string }>(path: string, schema: z.ZodType<T>): Promise<T> {
  const doc = await readJson(path, schema);
  const sha = pinnedSha();
  if (doc.sourceSha !== sha) {
    throw new Error(`${repoPath(path)}: sourceSha ${JSON.stringify(doc.sourceSha)} differs from the pinned SHA ${sha}`);
  }
  return doc;
}

/** Reads and validates the decision list stamped with the pinned SHA, normalising its action-variant and entry-point route keys. */
export async function loadDecisionList(path: string = DECISION_LIST_PATH): Promise<DecisionList> {
  const doc = await readPinned(path, decisionListSchema);
  return {
    ...doc,
    actionVariants: doc.actionVariants.map((v) => ({
      ...v,
      routeKey: normaliseInventoryKey(v.routeKey),
      ...(v.entryPoints === undefined
        ? {}
        : { entryPoints: v.entryPoints.map((e) => ({ ...e, routeKey: normaliseInventoryKey(e.routeKey) })) }),
    })),
  };
}

/** Reads and validates the exceptions list stamped with the pinned SHA, normalising every route key. */
export async function loadExceptions(path: string = EXCEPTIONS_LIST_PATH): Promise<ExceptionsList> {
  const doc = await readPinned(path, exceptionsListSchema);
  return {
    ...doc,
    entries: doc.entries.map((e) => ({
      ...e,
      routeKey: normaliseInventoryKey(e.routeKey),
      ...(e.appliesTo === undefined ? {} : { appliesTo: e.appliesTo.map(normaliseInventoryKey) }),
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Constant tables
// ---------------------------------------------------------------------------------------------------------------

/** Entity owner of each area's read-side items; writing items take their write-set owners. */
export const AREA_OWNERS: Readonly<Record<string, string>> = Object.freeze({
  // AAP 0.3.2 admin circuits; `cusers` names the owner of the user reads.
  'admin:clogin': 'identity',
  'admin:home': 'identity',
  'admin:cmessage': 'identity',
  'admin:cperm': 'identity',
  'admin:cwebservice': 'identity',
  'admin:cusers': 'people',
  'admin:ceditprofile': 'people',
  'admin:csettings': 'programs-sites',
  'admin:carch': 'strategies-content',
  'admin:cchangesets': 'strategies-content',
  'admin:ccomments': 'strategies-content',
  'admin:ccategory': 'strategies-content',
  'admin:cfeed': 'strategies-content',
  'admin:cchain': 'strategies-content',
  'admin:cform': 'strategies-content',
  'admin:cnav': 'strategies-content',
  'admin:cfilemanager': 'strategies-content',
  'admin:razuna': 'strategies-content',
  'admin:cemail': 'communications',
  'admin:cmailinglist': 'communications',
  'admin:cdashboard': 'reporting',
  'admin:cplugins': NO_OWNER,
  'admin:scaffold': NO_OWNER,
  'admin:cextend': NO_OWNER,
  'admin:ctrash': NO_OWNER,
  // AAP 0.3.2 JSON API entities.
  'api:site': 'programs-sites',
  'api:group': 'identity',
  'api:user': 'people',
  'api:address': 'people',
  'api:content': 'strategies-content',
  'api:contentnav': 'strategies-content',
  'api:comment': 'strategies-content',
  'api:category': 'strategies-content',
  'api:contentcategoryassign': 'strategies-content',
  'api:file': 'strategies-content',
  'api:filemetadata': 'strategies-content',
  'api:changeset': 'strategies-content',
  'api:changesetcategoryassignment': 'strategies-content',
  'api:feed': 'strategies-content',
  'api:stats': 'strategies-content',
  'api:variationtargeting': 'strategies-content',
  // AAP 0.3.2 JSON API methods.
  'api:login': 'identity',
  'api:logout': 'identity',
  'api:generatecsrftokens': 'identity',
  'api:findcurrentuser': 'identity',
  'api:validateemail': 'identity',
  'api:submitform': 'strategies-content',
  'api:findcalendaritems': 'strategies-content',
  'api:findrelatedcontent': 'strategies-content',
  'api:geturlforimage': 'strategies-content',
  'api:findversionhistory': 'strategies-content',
  'api:findcrumbarray': 'strategies-content',
  'api:processasyncobject': 'strategies-content',
  'api:declareentity': 'programs-sites',
  'api:undeclareentity': 'programs-sites',
  'api:checkschema': 'programs-sites',
  'api:swagger': NO_OWNER,
  // AAP 0.3.2 route families; OAuth keys are REST methods.
  feed: 'strategies-content',
  render: 'strategies-content',
  variation: 'strategies-content',
  asset: 'strategies-content',
  trackopen: 'communications',
  sitemonitor: 'programs-sites',
  'api:oauth': 'identity',
  'api:oauth2': 'identity',
  'api:tokeninfo': 'identity',
  widgets: NO_OWNER,
  // AAP 0.3.2 public front end; doaction values take their write-set owners.
  'page:render': 'reporting',
});

const ROSTER_WRITE: NamedSpanningOwner = Object.freeze({
  owner: 'people',
  protocol: 'roster-write',
  participants: Object.freeze(['identity', 'people']),
});

/** Spanning branches whose owner an input names (AAP 0.4.3); REST keys resolve through their JSON API form. */
export const NAMED_SPANNING_OWNERS: Readonly<Record<string, NamedSpanningOwner>> = Object.freeze({
  'admin:cusers.update{type=2,action=add}': ROSTER_WRITE,
  'admin:cusers.update{type=2,action=update}': ROSTER_WRITE,
  'api:user.save': ROSTER_WRITE,
  'admin:ceditprofile.update': ROSTER_WRITE,
});

/** Dispositions the AAP 0.3.2 tables expect, by route key (JSON API form) or area key; the rule result governs. */
export const AAP_EXPECTED: Readonly<Record<string, Disposition>> = Object.freeze({
  // Admin circuits and variants.
  'admin:clogin': 'carry',
  'admin:home': 'carry',
  'admin:cmessage': 'carry',
  'admin:cperm': 'carry',
  'admin:cwebservice': 'carry',
  'admin:cusers': 'carry',
  'admin:cusers.update{type=1}': 'carry',
  'admin:cusers.update{type=2,action=add}': 'carry',
  'admin:cusers.update{type=2,action=update}': 'carry',
  'admin:cusers.update{type=2,action=delete}': 'decision',
  'admin:cusers.update{photo}': 'decision',
  'admin:ceditprofile': 'carry',
  'admin:ceditprofile.update{photo}': 'decision',
  'admin:csettings': 'carry',
  'admin:csettings.updatesite{action=add}': 'decision',
  'admin:csettings.updatesite{action=delete}': 'decision',
  'admin:csettings.sitecopyselect': 'decision',
  'admin:csettings.sitecopy': 'decision',
  'admin:csettings.createbundle': 'legacy-served',
  'admin:csettings.selectbundleoptions': 'legacy-served',
  'admin:csettings.exporthtml': 'legacy-served',
  'admin:csettings.editplugin': 'legacy-served',
  'admin:csettings.deployplugin': 'legacy-served',
  'admin:csettings.updateplugin': 'legacy-served',
  'admin:csettings.updatepluginversion': 'legacy-served',
  'admin:csettings.deleteplugin': 'legacy-served',
  'admin:cextend': 'decision',
  'admin:ctrash': 'decision',
  'admin:carch': 'carry',
  'admin:carch.export': 'legacy-served',
  'admin:carch.exportcontent': 'legacy-served',
  'admin:carch.importcontent': 'legacy-served',
  'admin:carch.exportcomponent': 'legacy-served',
  'admin:carch.importcomponent': 'legacy-served',
  'admin:carch.emailtest': 'legacy-served',
  'admin:cchangesets': 'carry',
  'admin:ccomments': 'carry',
  'admin:ccategory': 'carry',
  'admin:cfeed': 'carry',
  'admin:cchain': 'carry',
  'admin:cform': 'carry',
  'admin:cnav': 'carry',
  'admin:cfilemanager': 'legacy-served',
  'admin:cemail': 'legacy-served',
  'admin:cmailinglist': 'legacy-served',
  'admin:cdashboard': 'legacy-served',
  'admin:cplugins': 'legacy-served',
  'admin:scaffold': 'legacy-served',
  'admin:razuna': 'legacy-served',
  // Route families.
  feed: 'carry',
  render: 'carry',
  variation: 'carry',
  trackopen: 'legacy-served',
  sitemonitor: 'carry',
  asset: 'legacy-served',
  widgets: 'legacy-served',
  'api:oauth': 'carry',
  'api:oauth2': 'carry',
  'api:tokeninfo': 'carry',
  // JSON API entities and methods.
  'api:site': 'carry',
  'api:content': 'carry',
  'api:contentnav': 'carry',
  'api:comment': 'carry',
  'api:category': 'carry',
  'api:contentcategoryassign': 'carry',
  'api:file': 'carry',
  'api:filemetadata': 'carry',
  'api:changeset': 'carry',
  'api:changesetcategoryassignment': 'carry',
  'api:feed': 'carry',
  'api:stats': 'carry',
  'api:variationtargeting': 'carry',
  'api:group': 'carry',
  'api:user': 'carry',
  'api:address': 'carry',
  'api:user.delete': 'decision',
  'api:user.save{photo}': 'decision',
  'api:group.save{photo}': 'decision',
  'api:login': 'carry',
  'api:logout': 'carry',
  'api:generatecsrftokens': 'carry',
  'api:findcurrentuser': 'carry',
  'api:validateemail': 'carry',
  'api:submitform': 'carry',
  'api:findcalendaritems': 'carry',
  'api:findrelatedcontent': 'carry',
  'api:geturlforimage': 'carry',
  'api:findversionhistory': 'carry',
  'api:findcrumbarray': 'carry',
  'api:processasyncobject': 'legacy-served',
  'api:swagger': 'legacy-served',
  'api:declareentity': 'legacy-served',
  'api:undeclareentity': 'legacy-served',
  'api:checkschema': 'legacy-served',
  // Public front end and application reload.
  'page:render': 'legacy-served',
  'page:login': 'legacy-served',
  'page:logout': 'legacy-served',
  'page:updateprofile': 'legacy-served',
  'page:createprofile': 'legacy-served',
  'page:saverate': 'legacy-served',
  'page:saveform': 'legacy-served',
  'page:setreminder': 'legacy-served',
  'page:return': 'legacy-served',
  'page:subscribe': 'legacy-served',
  'page:unsubscribe': 'legacy-served',
  'page:forwardemail': 'legacy-served',
  'page:contactsend': 'legacy-served',
  'reload:application': 'legacy-served',
  // SOAP v1 components.
  'soap:v1': 'retired',
});

/** Service of each fixture module under `/legacy-fixtures/cfml/api.cfm/<module>/`. */
export const FIXTURE_MODULE_SERVICES: Readonly<Record<string, string>> = Object.freeze({
  people: 'people',
  timesheets: 'timesheets',
  finance: 'finance',
  surveys: 'surveys',
  reporting: 'reporting',
  communications: 'communications',
  esignature: 'e-signature',
});

// ---------------------------------------------------------------------------------------------------------------
// Keys and owners
// ---------------------------------------------------------------------------------------------------------------

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

// The JSON API serves json, ajax and rest requests through one dispatcher, so a REST key shares its API key's facts.
function jsonApiForm(key: string): string {
  return key.startsWith('rest:') ? `api:${key.slice('rest:'.length)}` : key;
}

const PATH_FAMILIES: ReadonlySet<string> = new Set(['cfm', 'apiother', 'static', 'opt2', 'bridge']);

/** Area key of a route key: its circuit, entity or method, fixture module, path, or family, as `AREA_OWNERS` keys it. */
export function areaKeyForRouteKey(routeKey: string): string {
  const key = jsonApiForm(normaliseInventoryKey(routeKey)).replace(/\{[^{}]*\}$/, '');
  const colon = key.indexOf(':');
  if (colon < 0) return key;
  const family = key.slice(0, colon);
  const body = key.slice(colon + 1);
  if (family === 'admin' || family === 'api') return `${family}:${body.split('.')[0] ?? ''}`;
  if (family === 'fixture') return `fixture:${body.split('/')[0] ?? ''}`;
  if (family === 'cfc') return `cfc:${body.split('?')[0] ?? ''}`;
  if (family === 'page' || PATH_FAMILIES.has(family)) return key;
  return family;
}

const globCache = new Map<string, RegExp>();

function keyMatches(pattern: string, key: string): boolean {
  if (!pattern.includes('*')) return pattern === key;
  let re = globCache.get(pattern);
  if (re === undefined) {
    re = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    globCache.set(pattern, re);
  }
  return re.test(key);
}

type OwnershipTable = TableOwnership['tables'][number];

interface OwnershipIndex {
  exact: Map<string, OwnershipTable>;
  patterns: { prefix: string; entry: OwnershipTable }[];
}

const ownershipIndexes = new WeakMap<TableOwnership, OwnershipIndex>();

function ownershipIndex(ownership: TableOwnership): OwnershipIndex {
  let index = ownershipIndexes.get(ownership);
  if (index === undefined) {
    index = {
      exact: new Map(ownership.tables.map((t) => [tableKey(t.table), t])),
      patterns: ownership.tables
        .filter((t) => t.table.endsWith('*'))
        .map((t) => ({ prefix: tableKey(t.table.slice(0, -1)), entry: t })),
    };
    ownershipIndexes.set(ownership, index);
  }
  return index;
}

const EQUALS_PREDICATE = /^(?:owner\s+)?([a-z_]\w*)\s*=\s*'?([^']*?)'?$/i;
const IN_PREDICATE = /^(?:owner\s+)?([a-z_]\w*)\s+in\s*\((.*)\)$/i;
const CLASS_OWNER_PREDICATE = /^classMap\s+owner\s*=\s*(\S+)$/i;
const BASE_TABLE_COLUMN = 'basetable';

/** A parsed row predicate: a column with its allowed lower-case values, or the owner a trash class map assigns. */
type RowPredicate = { column: string; values: string[] } | { classOwner: string };

/** Parsed form of `Type = 2`, `owner Type = 1`, `baseTable in ('…')` or `classMap owner = <service>`; null for any other text. */
function parseRowPredicate(rowPredicate: unknown): RowPredicate | null {
  if (typeof rowPredicate !== 'string') return null;
  const text = rowPredicate.trim();
  const classOwner = CLASS_OWNER_PREDICATE.exec(text)?.[1];
  if (classOwner !== undefined) return { classOwner };
  const eq = EQUALS_PREDICATE.exec(text);
  if (eq?.[1] !== undefined && eq[2] !== undefined) return { column: eq[1].toLowerCase(), values: [eq[2].toLowerCase()] };
  const list = IN_PREDICATE.exec(text);
  if (list?.[1] === undefined || list[2] === undefined) return null;
  return { column: list[1].toLowerCase(), values: [...list[2].matchAll(/'([^']*)'/g)].map((m) => (m[1] ?? '').toLowerCase()) };
}

function requestAllows(predicate: RowPredicate | null, request: ReadonlyMap<string, string | boolean | null>): boolean {
  if (predicate === null || 'classOwner' in predicate) return true;
  const value = request.get(predicate.column);
  return typeof value !== 'string' || predicate.values.includes(value.toLowerCase());
}

function coWritesAllow(predicate: RowPredicate | null, written: ReadonlySet<string>, directOwners: ReadonlySet<string>): boolean {
  if (predicate === null) return true;
  if ('classOwner' in predicate) return directOwners.has(predicate.classOwner);
  return predicate.column !== BASE_TABLE_COLUMN || predicate.values.some((v) => written.has(tableKey(v)));
}

type OwnershipTarget = OwnershipTable['targets'][number];

// A baseTable or objectClass row belongs to the entity its branch also writes, so the co-written tables pick the
// targets the request cannot; every target counts only when neither the request nor the co-writes select one.
function splitTargets(
  targets: readonly OwnershipTarget[],
  request: ReadonlyMap<string, string | boolean | null>,
  written: ReadonlySet<string>,
  directOwners: ReadonlySet<string>,
): OwnershipTarget[] {
  const parsed = targets.map((target) => ({ target, predicate: parseRowPredicate(target.rowPredicate) }));
  const allowed = parsed.filter((p) => requestAllows(p.predicate, request));
  const pool = allowed.length > 0 ? allowed : parsed;
  const coWritten = pool.filter((p) => coWritesAllow(p.predicate, written, directOwners));
  return (coWritten.length > 0 ? coWritten : pool).map((p) => p.target);
}

/**
 * Sorted owner services of the legacy tables `writeSet`. A split table keeps the targets the request `predicates`
 * allow, narrowed by the co-written tables for baseTable and trash-class splits, or all targets when none remain.
 */
export function ownersOfWriteSet(
  writeSet: readonly string[],
  predicates: VariantPredicates,
  ownership: TableOwnership,
): WriteSetOwners {
  const index = ownershipIndex(ownership);
  const request = new Map(Object.entries(predicates).map(([name, value]) => [name.toLowerCase(), value] as const));
  const written = new Set(writeSet.map(tableKey));
  const owners = new Set<string>();
  const directOwners = new Set<string>();
  const decisionTables = new Set<string>();
  const splits: OwnershipTable[] = [];
  for (const table of writeSet) {
    const key = tableKey(table);
    const entry = index.exact.get(key) ?? index.patterns.find((p) => key.startsWith(p.prefix))?.entry;
    if (entry === undefined) throw new Error(`table ownership assigns no owner to written table ${table}`);
    if (entry.owner === 'retired') continue;
    if (entry.owner === 'decision-list') {
      decisionTables.add(table);
    } else if (entry.owner === 'split') {
      splits.push(entry);
    } else {
      owners.add(entry.owner);
      directOwners.add(entry.owner);
    }
  }
  for (const entry of splits) {
    for (const target of splitTargets(entry.targets, request, written, directOwners)) owners.add(target.owner);
  }
  return { owners: [...owners].sort(compareText), decisionTables: [...decisionTables].sort(compareText) };
}

// ---------------------------------------------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------------------------------------------

interface Outcome {
  disposition: Disposition;
  step: DispositionStep;
  basis: string;
  owningService: string | null;
  ownerBasis: OwnerBasis;
  withheld: boolean;
  protocol?: WriteProtocol;
  decisionListRef?: string;
}

interface OwnerChoice {
  owningService: string | null;
  ownerBasis: OwnerBasis;
}

type DecisionTable = DecisionList['tables'][number];
type DecisionVariant = DecisionList['actionVariants'][number];
type ExceptionEntry = ExceptionsList['entries'][number];

/** What the rule reads about one item beyond its facts, resolved once per `decide`. */
interface Resolved {
  routeKey: string | null;
  written: WriteSetOwners;
  owner: OwnerChoice;
  area: string | undefined;
  named: NamedSpanningOwner | undefined;
  tableEntry: DecisionTable | undefined;
  variant: DecisionVariant | undefined;
}

function ownerChoice(owners: readonly string[], area: string | undefined, named: NamedSpanningOwner | undefined): OwnerChoice {
  const [only] = owners;
  if (owners.length === 1 && only !== undefined) return { owningService: only, ownerBasis: 'table-ownership' };
  if (owners.length > 1) {
    return named === undefined
      ? { owningService: SPANNING_OWNER, ownerBasis: 'spanning' }
      : { owningService: named.owner, ownerBasis: 'named-input' };
  }
  if (area === undefined) return { owningService: null, ownerBasis: 'none' };
  return { owningService: area === NO_OWNER ? null : area, ownerBasis: 'aap-0.3.2' };
}

function legacyServedBasis(facts: DispositionFacts, owner: OwnerChoice, area: string | undefined): string | undefined {
  if (facts.rendersCfml) return 'renders CFML through the theme and display-object runtime';
  if (facts.webRootFilesystem) return 'depends on the legacy web-root filesystem';
  if (facts.runtimeCategory !== undefined) return `depends on the CFML runtime (${facts.runtimeCategory})`;
  const service = owner.owningService;
  if (service !== null && service !== SPANNING_OWNER && !MIGRATED_SERVICES.includes(service)) {
    return `owner ${service} is not a migrated domain`;
  }
  if (service === null && area === NO_OWNER) return 'no service owns its area';
  return undefined;
}

function decisionTableEntry(list: DecisionList, table: string): DecisionTable | undefined {
  const key = tableKey(table);
  return list.tables.find((t) => keyMatches(tableKey(t.table), key));
}

/** The action variant whose route key or one of whose entry points covers `routeKey`. */
function decisionVariant(list: DecisionList, routeKey: string | null): DecisionVariant | undefined {
  if (routeKey === null) return undefined;
  return list.actionVariants.find(
    (v) => keyMatches(v.routeKey, routeKey) || (v.entryPoints ?? []).some((e) => keyMatches(e.routeKey, routeKey)),
  );
}

/** First exceptions entry covering `routeKey` that keeps its route on legacy: halted, or an open `fix` proposal. */
function holdingException(list: ExceptionsList, routeKey: string | null): ExceptionEntry | undefined {
  if (routeKey === null) return undefined;
  return list.entries.find(
    (e) =>
      (e.status === 'halted' || (e.decision === 'fix' && e.status === 'open')) &&
      [e.routeKey, ...(e.appliesTo ?? [])].some((pattern) => keyMatches(pattern, routeKey)),
  );
}

function fixtureOutcome(facts: DispositionFacts, module: string): Outcome {
  const service = own(FIXTURE_MODULE_SERVICES, module.toLowerCase());
  if (service === undefined) throw new Error(`${facts.id}: fixture module ${module} maps to no service`);
  return {
    disposition: 'carry',
    step: 'fixture-definition',
    basis: `fixture route of the ${module} module, carried to ${service} by definition`,
    owningService: service,
    ownerBasis: 'fixture-module',
    withheld: false,
  };
}

function carryBasis(owner: OwnerChoice): string {
  if (owner.ownerBasis === 'table-ownership') return `single owner ${owner.owningService ?? ''} among the migrated services`;
  if (owner.owningService === null) return 'writes nothing and depends on no legacy runtime';
  return `area owner ${owner.owningService} is a migrated service`;
}

function applyRule(facts: DispositionFacts, r: Resolved): Outcome {
  if (facts.fixtureModule !== undefined) return fixtureOutcome(facts, facts.fixtureModule);
  if (!facts.reachable || facts.tableAbsent === true) {
    const basis = facts.reachable ? 'its table is absent from the live catalog' : 'unreachable over HTTP or the scheduler at the pinned SHA';
    return { disposition: 'retired', step: 1, basis, ...r.owner, withheld: false };
  }
  const [decisionTable] = r.written.decisionTables;
  if (decisionTable !== undefined) {
    return {
      disposition: 'decision',
      step: 2,
      basis: `writes decision-list table ${decisionTable}`,
      owningService: r.tableEntry?.proposedOwner ?? null,
      ownerBasis: r.tableEntry === undefined ? 'none' : 'decision-list-proposal',
      withheld: r.tableEntry?.buildWithheld ?? true,
      ...(r.tableEntry === undefined ? {} : { decisionListRef: `opt2/decision-list.json#${r.tableEntry.table}` }),
    };
  }
  if (facts.storedDataOwner !== undefined || (r.written.owners.length > 1 && r.named === undefined)) {
    const proposed = r.variant?.proposedOwner;
    return {
      disposition: 'decision',
      step: 3,
      basis:
        facts.storedDataOwner === undefined
          ? `write set spans ${r.written.owners.join(', ')}; no input names the owner`
          : `owner depends on the stored ${facts.storedDataOwner}`,
      owningService: proposed ?? SPANNING_OWNER,
      ownerBasis: proposed === undefined ? 'spanning' : 'decision-list-proposal',
      withheld: true,
      ...(r.variant === undefined ? {} : { decisionListRef: `opt2/decision-list.json#${r.variant.routeKey}` }),
    };
  }
  const served = legacyServedBasis(facts, r.owner, r.area);
  if (served !== undefined) return { disposition: 'legacy-served', step: 4, basis: served, ...r.owner, withheld: false };
  if (r.named !== undefined) {
    return {
      disposition: 'carry',
      step: 5,
      basis: `an input names ${r.named.owner} as owner of writes spanning ${r.written.owners.join(', ')}`,
      ...r.owner,
      withheld: false,
      protocol: r.named.protocol,
    };
  }
  return { disposition: 'carry', step: 5, basis: carryBasis(r.owner), ...r.owner, withheld: false };
}

function correctionOf(
  facts: DispositionFacts,
  outcome: Outcome,
  r: Resolved,
  areaKey: string,
): DispositionCorrection | undefined {
  const expected: DispositionCorrection['expected'] = {};
  const lookupKey = r.routeKey === null ? undefined : jsonApiForm(r.routeKey);
  const disposition = (lookupKey === undefined ? undefined : own(AAP_EXPECTED, lookupKey)) ?? own(AAP_EXPECTED, areaKey);
  if (disposition !== undefined && disposition !== outcome.disposition) expected.disposition = disposition;
  const writes = facts.writeSet.length > 0 || facts.fileStoreWrite;
  if (writes && r.written.owners.length === 1 && r.area !== undefined && r.area !== NO_OWNER && outcome.owningService !== r.area) {
    expected.owningService = r.area;
  }
  if (expected.disposition === undefined && expected.owningService === undefined) return undefined;
  return {
    expected,
    computed: { disposition: outcome.disposition, owningService: outcome.owningService },
    step: outcome.step,
    basis: outcome.basis,
  };
}

function mismatchDetails(outcome: Outcome, r: Resolved): string[] {
  const details: string[] = [];
  const [decisionTable] = r.written.decisionTables;
  if (outcome.step === 2 && decisionTable !== undefined && r.tableEntry === undefined) {
    details.push(`writes ${decisionTable}, which table ownership assigns to the decision list, but opt2/decision-list.json lists no such table`);
  }
  if (outcome.step === 3 && r.routeKey !== null && r.variant === undefined) {
    details.push(`computed decision at step 3 (${outcome.basis}) but opt2/decision-list.json lists no matching action variant`);
  }
  if (r.variant !== undefined && outcome.disposition !== 'decision') {
    details.push(
      `opt2/decision-list.json lists ${r.variant.routeKey} but the rule computes ${outcome.disposition} at step ${String(outcome.step)} (${outcome.basis})`,
    );
  }
  return details;
}

function correctionDetail(c: DispositionCorrection): string {
  const parts: string[] = [];
  if (c.expected.disposition !== undefined) {
    parts.push(`AAP expects ${c.expected.disposition}, the rule computes ${c.computed.disposition} at step ${String(c.step)}`);
  }
  if (c.expected.owningService !== undefined) {
    parts.push(`area owner ${c.expected.owningService}, computed owner ${c.computed.owningService ?? 'none'}`);
  }
  return `${parts.join('; ')} (${c.basis})`;
}

function resolve(facts: DispositionFacts, ctx: DispositionContext, areaKey: string): Resolved {
  const routeKey = facts.routeKey === undefined ? null : normaliseInventoryKey(facts.routeKey);
  const writeSet = facts.fileStoreWrite ? [...facts.writeSet, FILE_STORE_TABLE] : facts.writeSet;
  let written: WriteSetOwners;
  try {
    written = ownersOfWriteSet(writeSet, facts.variantPredicates ?? {}, ctx.ownership);
  } catch (err) {
    throw new Error(`${facts.id}: ${(err as Error).message}`, { cause: err });
  }
  const area = own(AREA_OWNERS, areaKey);
  const candidate = routeKey === null ? undefined : own(NAMED_SPANNING_OWNERS, jsonApiForm(routeKey));
  const named =
    candidate !== undefined && written.owners.length > 1 && written.owners.every((o) => candidate.participants.includes(o))
      ? candidate
      : undefined;
  const [decisionTable] = written.decisionTables;
  return {
    routeKey,
    written,
    owner: ownerChoice(written.owners, area, named),
    area,
    named,
    tableEntry: decisionTable === undefined ? undefined : decisionTableEntry(ctx.decisionList, decisionTable),
    variant: decisionVariant(ctx.decisionList, routeKey),
  };
}

/** Disposition of one item under the first applicable rule step, with halts, legacy writes and corrections; appends findings to `ctx.findings` when given. */
export function decide(facts: DispositionFacts, ctx: DispositionContext): DispositionResult {
  const areaKey = normaliseInventoryKey(facts.areaKey);
  const r = resolve(facts, ctx, areaKey);
  const outcome = applyRule(facts, r);
  const writes = facts.writeSet.length > 0 || facts.fileStoreWrite;
  const holder = holdingException(ctx.exceptions, r.routeKey);
  const result: DispositionResult = {
    disposition: outcome.disposition,
    dispositionStep: outcome.step,
    basis: outcome.basis,
    owningService: outcome.owningService,
    owners: r.written.owners,
    ownerBasis: outcome.ownerBasis,
    withheld: outcome.withheld,
    legacyWrite: writes && (outcome.disposition !== 'carry' || holder !== undefined),
  };
  if (holder !== undefined) result.haltedBy = holder.id;
  if (outcome.protocol !== undefined) result.protocol = outcome.protocol;
  if (outcome.decisionListRef !== undefined) result.decisionListRef = outcome.decisionListRef;
  const correction = correctionOf(facts, outcome, r, areaKey);
  if (correction !== undefined) result.correction = correction;

  if (ctx.findings !== undefined) {
    const base = { id: facts.id, itemKind: facts.itemKind, routeKey: r.routeKey };
    for (const detail of mismatchDetails(outcome, r)) ctx.findings.push({ kind: 'decision-list-mismatch', ...base, detail });
    if (correction !== undefined) {
      ctx.findings.push({ kind: 'correction', ...base, detail: correctionDetail(correction), correction });
    }
  }
  return result;
}

