// Markdown rendering of the legacy inventory (opt2/inventory/legacy-inventory.md); every value comes from the inventory.
import { sortKeysDeep } from '../lib/report.js';
import { SPANNING_OWNER, type Disposition, type DispositionStep } from './disposition.js';

/** Title of the rendering; `writeMarkdown` adds the `Source SHA:` line below it. */
export const INVENTORY_TITLE = 'Legacy inventory (Masa CMS 7.6.1)';

const EMPTY = '—';
const PENDING = 'pending-run';

// The input types are the structural view this renderer reads. They are declared here rather than imported from
// generate.ts, which is built after this module and imports it; its LegacyInventory must stay assignable to them.

/** Location of a fact in the pinned archive. */
export interface SourceRef {
  path: string;
  lines: readonly number[];
}

/** Any inventoried item: an id and, usually, its source. */
export interface SourcedItem {
  id: string;
  source?: SourceRef | null;
}

/** The owner and disposition fields every disposed item carries. */
export interface DisposedItem extends SourcedItem {
  owningService: string | null;
  owners?: readonly string[];
  disposition: Disposition | null;
  dispositionStep: DispositionStep | null;
  withheld?: boolean;
  legacyWrite?: boolean;
  haltedBy?: string | null;
  exceptionRef?: string | null;
  expected?: { disposition?: Disposition | null } | null;
  correction?: { expected?: { disposition?: Disposition } } | null;
}

/** Shared CSRF facts of a request entry point. */
export interface CsrfFacts {
  csrfValidation: string | null;
  csrfContext: string | null;
}

/** One controller action variant, the unit the admin table lists. */
export interface ControllerVariantView extends DisposedItem, CsrfFacts {
  routeKey: string | null;
  responseMode: string | null;
  contentType: string | null;
}

/** One admin circuit; the base controller has no actions and is listed as itself. */
export interface ControllerView extends DisposedItem {
  circuit: string;
  isBase: boolean;
  actions: readonly { variants: readonly ControllerVariantView[] }[];
}

/** Kind of a `routes[]` entry; each kind renders in exactly one route table. */
export type RouteKind = 'api-family' | 'job' | 'static' | 'api-entity-method' | 'api-method' | 'oauth' | 'fixture' | 'soap';

/** One `routes[]` entry. */
export interface RouteView extends DisposedItem, CsrfFacts {
  kind: RouteKind;
  routeKey: string | null;
  decisionListRef: string | null;
}

/** One `frontEnd[]` entry. */
export interface FrontEndView extends DisposedItem, CsrfFacts {
  entry: string;
  windowed: boolean;
  sessionEffects: string;
}

/** A run-time rule of a scheduled job with its sources. */
export interface JobRuleView {
  rule: string;
  source?: SourceRef | null;
  endSource?: SourceRef | null;
  dedupeSource?: SourceRef | null;
}

/** One `scheduledJobs[]` entry with its registration, semantics and steps. */
export interface ScheduledJobView extends DisposedItem {
  routeKey: string;
  registration: {
    type: string;
    url: string;
    startTime: string;
    intervalSeconds: number;
    requestTimeoutSeconds: number;
    condition: string;
    pingDefault: { value: boolean | string } | null;
    liveTask: object | null;
    livePing: boolean | null;
    liveStatus: string;
  };
  semantics: {
    cursor?: JobRuleView | null;
    catchUp?: JobRuleView | null;
    order?: JobRuleView | null;
    gating?: JobRuleView | null;
    purgeWindow?: JobRuleView | null;
    bounceDedupeIneffective?: boolean;
  };
  steps: readonly (DisposedItem & {
    order: number;
    call: string;
    targetMechanism: string | null;
    stateThisRun: string | null;
  })[];
}

/** One `tables[]` entry. */
export interface TableView extends DisposedItem {
  origin: string;
  hasSiteId: boolean | null;
  hasSiteIdLive?: boolean | null;
  hasPrimaryKey: boolean | null;
  hasPrimaryKeyLive?: boolean | null;
  bootstrapHasPrimaryKey: boolean | null;
  ruleSteps: readonly number[];
  writers: readonly unknown[];
}

/** A finding the generator records; `measure` names a count difference, `id` any other item. */
export interface InventoryFinding {
  kind: string;
  id?: string | null;
  measure?: string;
  detail?: string | null;
  source?: SourceRef | null;
  aapFigure?: number | string | null;
  computed?: number | string | null;
}

/** The inventory document as this renderer reads it. */
export interface RenderableInventory {
  generatedBy: string;
  extractedFrom: string | { method: string; sha: string };
  /** Per-section counts: scalars, or one level of named scalars. */
  counts: object;
  entities: readonly SourcedItem[];
  services: readonly SourcedItem[];
  controllers: readonly ControllerView[];
  coreMuraActionSearch: {
    query: string;
    scope: string;
    handlers: number;
    filesMentioning: number;
    files: readonly { use: string }[];
    dispatcher?: SourceRef | null;
  };
  frontEnd: readonly FrontEndView[];
  scheduledJobs: readonly ScheduledJobView[];
  routes: readonly RouteView[];
  tables: readonly TableView[];
  relations: readonly (SourcedItem & { kind: string })[];
  storedProcedureCheck: {
    static: { count: number };
    live: { total: number | null };
    foreignKeys?: { static: number };
  };
  findings?: readonly InventoryFinding[];
}

// ---------------------------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------------------------

// One line per row and no column breaks: line breaks fold to a space and pipes are escaped, inside code spans too.
function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').replaceAll('|', '\\|');
}

/** Plain-text cell; `<` is escaped so values are never read as HTML. */
function text(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  return oneLine(value).replaceAll('<', '\\<');
}

/** Code-span cell, fenced past any backtick run inside the value. */
function code(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  const body = oneLine(value);
  const longest = Math.max(0, ...Array.from(body.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = longest > 0 ? ' ' : '';
  return `${fence}${pad}${body}${pad}${fence}`;
}

function sourceText(source: SourceRef | null | undefined): string | null {
  if (source === null || source === undefined) return null;
  const [start, end] = source.lines;
  if (start === undefined) return source.path;
  return end === undefined || end === start ? `${source.path}:${start}` : `${source.path}:${start}-${end}`;
}

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return PENDING;
  return value ? 'yes' : 'no';
}

/** Owner cell: the owning service, else the spanned owners. */
function ownerCell(item: DisposedItem): string {
  if (item.owningService !== null && item.owningService !== SPANNING_OWNER) return text(item.owningService);
  const owners = item.owners ?? [];
  return owners.length > 0 ? `spans ${text(owners.join(', '))}` : EMPTY;
}

function exceptionOf(item: DisposedItem): string | null {
  return item.haltedBy || item.exceptionRef || null;
}

/**
 * Disposition cell: `<disposition> (<step>[, withheld][, legacy-write])`, then the correction, then the holding
 * exception unless the table shows it in its own Notes column. The step stays beside the flags because the column
 * is "Disposition (step)", and corrections keep the committed rendering's `(corrected; expected …)` wording.
 */
function dispositionCell(item: DisposedItem, exceptionInCell = true): string {
  if (item.disposition === null) return EMPTY;
  const notes: string[] = item.dispositionStep === null ? [] : [String(item.dispositionStep)];
  if (item.withheld === true) notes.push('withheld');
  if (item.legacyWrite === true && item.haltedBy) notes.push('legacy-write');
  let cell = notes.length > 0 ? `${item.disposition} (${notes.join(', ')})` : item.disposition;
  if (item.correction) {
    const expected = item.correction.expected?.disposition ?? item.expected?.disposition ?? item.disposition;
    cell += ` (corrected; expected ${expected})`;
  }
  const exception = exceptionInCell ? exceptionOf(item) : null;
  return exception === null ? cell : `${cell} ${code(exception)}`;
}

function csrfCell(item: CsrfFacts): string {
  if (item.csrfValidation === null) return EMPTY;
  return item.csrfContext ? `${text(item.csrfValidation)} ${code(item.csrfContext)}` : text(item.csrfValidation);
}

function responseCell(item: ControllerVariantView): string {
  if (item.responseMode === null) return EMPTY;
  return item.contentType ? `${text(item.responseMode)} (${text(item.contentType)})` : text(item.responseMode);
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [row(header), row(header.map(() => '---')), ...rows.map(row)];
}

// ---------------------------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------------------------

// Row order of the committed rendering; sections and items it does not name follow, in code-unit order.
const COUNT_ORDER: Readonly<Record<string, readonly string[]>> = {
  entities: ['orm-base', 'orm-concrete', 'not-entity', 'domain-bean', 'dynamic', 'dynamicPatterns'],
  ormTables: ['concrete', 'ormOnly'],
  services: ['registeredSingletons', 'serviceList', 'transient', 'aliases'],
  controllers: ['circuits', 'base', 'actions', 'viewOnlyActions', 'variants'],
  coreMuraActionFiles: [],
  frontEnd: [],
  scheduledJobs: ['jobs', 'siteMonitorSteps'],
  routes: ['families', 'apiEntityMethods', 'apiMethods', 'oauth', 'soap', 'fixture'],
  tables: [
    'bootstrap',
    'bootstrapAfterDrops',
    'migrationCreated',
    'ormOnly',
    'staticTotal',
    'retired',
    'withSiteIdStatic',
    'withoutPrimaryKeyBootstrap',
    'fixture',
    'testSuite',
    'dynamicPatterns',
    'live',
    'withSiteIdLive',
  ],
  relations: [],
  storedProcedures: ['static', 'live'],
  dispositions: ['carry', 'legacy-served', 'decision', 'retired'],
  notes: ['withSiteIdStatic', 'dispositions'],
};

// `liveStatus` is a status, not a count; the header line shows it.
const LIVE_STATUS_KEY = 'liveStatus';

function ordered(keys: readonly string[], preferred: readonly string[]): string[] {
  const present = new Set(keys);
  const first = preferred.filter((k) => present.has(k));
  const named = new Set(first);
  return [...first, ...keys.filter((k) => !named.has(k)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function countText(value: unknown): string {
  if (value === null || value === undefined) return PENDING;
  if (Array.isArray(value)) return text(value.map(String).join(', '));
  return text(String(value));
}

function liveStatusOf(counts: object): string {
  const c = counts as Readonly<Record<string, unknown>>;
  if (typeof c[LIVE_STATUS_KEY] === 'string') return c[LIVE_STATUS_KEY];
  for (const section of ordered(Object.keys(c), Object.keys(COUNT_ORDER))) {
    const value = c[section];
    if (isRecord(value) && typeof value[LIVE_STATUS_KEY] === 'string') return value[LIVE_STATUS_KEY];
  }
  return EMPTY;
}

function countsSection(counts: object): string[] {
  const c = counts as Readonly<Record<string, unknown>>;
  const rows: string[][] = [];
  for (const section of ordered(Object.keys(c), Object.keys(COUNT_ORDER))) {
    if (section === LIVE_STATUS_KEY) continue;
    const value = c[section];
    if (!isRecord(value)) {
      rows.push([text(section), EMPTY, countText(value)]);
      continue;
    }
    for (const item of ordered(Object.keys(value), COUNT_ORDER[section] ?? [])) {
      if (item !== LIVE_STATUS_KEY) rows.push([text(section), text(item), countText(value[item])]);
    }
  }
  return table(['Section', 'Item', 'Count'], rows);
}

function controllersSection(inv: RenderableInventory): string[] {
  const rows: string[][] = [];
  for (const c of inv.controllers) {
    if (c.isBase) rows.push([code(c.id), EMPTY, ownerCell(c), dispositionCell(c), EMPTY, EMPTY]);
    for (const action of c.actions) {
      for (const v of action.variants) {
        rows.push([code(v.id), code(v.routeKey), ownerCell(v), dispositionCell(v), csrfCell(v), responseCell(v)]);
      }
    }
  }
  const search = inv.coreMuraActionSearch;
  const uses = new Map<string, number>();
  for (const f of search.files) uses.set(f.use, (uses.get(f.use) ?? 0) + 1);
  const useText = [...uses.keys()]
    .sort()
    .map((use) => `${use} ${String(uses.get(use))}`)
    .join(', ');
  const dispatcher = sourceText(search.dispatcher);
  const searchLine =
    `Search for ${code(search.query)} in ${code(search.scope)}: ${String(search.handlers)} handlers; ` +
    `${String(search.filesMentioning)} files mention it${useText === '' ? '' : ` (${useText})`}` +
    `${dispatcher === null ? '' : `; admin dispatch at ${code(dispatcher)}`}.`;
  return [
    ...table(['Id', 'Route key', 'Owner', 'Disposition (step)', 'CSRF', 'Response mode'], rows),
    '',
    searchLine,
  ];
}

const ROUTE_TABLE_OF: Readonly<Record<RouteKind, number>> = {
  'api-family': 0,
  job: 0,
  static: 0,
  'api-entity-method': 1,
  'api-method': 1,
  oauth: 2,
  fixture: 2,
  soap: 2,
};

const ROUTE_HEADINGS: readonly string[] = [
  '## Route families',
  '## JSON API entities and methods',
  '## OAuth, SOAP and fixture routes',
];

function routeSections(routes: readonly RouteView[]): string[][] {
  const rows: string[][][] = ROUTE_HEADINGS.map(() => []);
  for (const r of routes) {
    const notes = [r.decisionListRef, exceptionOf(r)].filter((n): n is string => Boolean(n)).map(code);
    rows[ROUTE_TABLE_OF[r.kind]]?.push([
      code(r.id),
      code(r.routeKey),
      ownerCell(r),
      dispositionCell(r, false),
      csrfCell(r),
      notes.length > 0 ? notes.join(', ') : EMPTY,
    ]);
  }
  return ROUTE_HEADINGS.map((heading, i) => [
    heading,
    '',
    ...table(['Id', 'Route key', 'Owner', 'Disposition (step)', 'CSRF', 'Notes'], rows[i] ?? []),
  ]);
}

function frontEndSection(entries: readonly FrontEndView[]): string[] {
  return table(
    ['Id', 'Entry', 'Owner', 'Disposition (step)', 'CSRF', 'Windowed', 'Session effects'],
    entries.map((e) => [
      code(e.id),
      text(e.entry),
      ownerCell(e),
      dispositionCell(e),
      csrfCell(e),
      e.windowed ? 'yes' : 'no',
      text(e.sessionEffects),
    ]),
  );
}

const SEMANTIC_LABELS: readonly (readonly [keyof ScheduledJobView['semantics'], string])[] = [
  ['cursor', 'Cursor'],
  ['catchUp', 'Catch-up'],
  ['order', 'Order'],
  ['gating', 'Gating'],
  ['purgeWindow', 'Purge window'],
];

function liveValue(value: object | boolean | null, liveStatus: string): string {
  if (value === null) return liveStatus === PENDING ? PENDING : 'none';
  return code(typeof value === 'boolean' ? String(value) : JSON.stringify(sortKeysDeep(value)));
}

function jobLines(job: ScheduledJobView): string[] {
  const reg = job.registration;
  const ping = reg.pingDefault === null ? EMPTY : code(String(reg.pingDefault.value));
  const lines = [
    `${code(job.id)} (${code(job.routeKey)}, ${ownerCell(job)}, ${dispositionCell(job)}): ${text(reg.type)} to ` +
      `${code(reg.url)}, start ${text(reg.startTime)}, interval ${String(reg.intervalSeconds)} s, request timeout ` +
      `${String(reg.requestTimeoutSeconds)} s, registered only when ${text(reg.condition)}; ${code('ping')} default ${ping}; ` +
      `live task: ${liveValue(reg.liveTask, reg.liveStatus)}; live ${code('ping')}: ${liveValue(reg.livePing, reg.liveStatus)}.`,
    '',
  ];
  for (const [key, label] of SEMANTIC_LABELS) {
    const rule = job.semantics[key];
    if (rule === null || rule === undefined || typeof rule === 'boolean') continue;
    const sources = [rule.source, rule.endSource, rule.dedupeSource]
      .map(sourceText)
      .filter((s): s is string => s !== null)
      .map(code);
    lines.push(`- ${label}: ${text(rule.rule)}${sources.length > 0 ? ` (${sources.join(', ')})` : ''}`);
  }
  if (job.semantics.bounceDedupeIneffective !== undefined) {
    lines.push(`- Bounce dedupe ineffective: ${yesNo(job.semantics.bounceDedupeIneffective)}`);
  }
  if (lines.length > 2) lines.push('');
  lines.push(
    ...table(
      ['Order', 'Step', 'Call', 'Owner', 'Disposition (step)', 'Target mechanism', 'State this run'],
      job.steps.map((s) => [
        String(s.order),
        code(s.id),
        text(s.call),
        ownerCell(s),
        dispositionCell(s),
        text(s.targetMechanism),
        text(s.stateThisRun),
      ]),
    ),
  );
  return lines;
}

// A static flag with the live catalog's value beside it when that differs.
function withLive(cell: string, flag: boolean | null, live: boolean | null | undefined): string {
  return live === null || live === undefined || live === flag ? cell : `${cell} (live: ${yesNo(live)})`;
}

function tablesSection(tables: readonly TableView[]): string[] {
  return table(
    ['Id', 'Origin', 'siteID', 'PK', 'Owner(s)', 'Rule step(s)', 'Disposition (step)', 'Writers'],
    tables.map((t) => {
      const bootstrap = t.bootstrapHasPrimaryKey;
      const pk =
        t.hasPrimaryKey !== null && bootstrap !== null && bootstrap !== t.hasPrimaryKey
          ? `${yesNo(t.hasPrimaryKey)} (bootstrap: ${yesNo(bootstrap)})`
          : yesNo(t.hasPrimaryKey);
      const owners = t.owners ?? [];
      return [
        code(t.id),
        text(t.origin),
        withLive(yesNo(t.hasSiteId), t.hasSiteId, t.hasSiteIdLive),
        withLive(pk, t.hasPrimaryKey, t.hasPrimaryKeyLive),
        owners.length > 0 ? text(owners.join(', ')) : ownerCell(t),
        t.ruleSteps.length > 0 ? t.ruleSteps.join(', ') : EMPTY,
        dispositionCell(t),
        String(t.writers.length),
      ];
    }),
  );
}

function relationsSection(inv: RenderableInventory): string[] {
  const kinds = new Map<string, number>();
  for (const r of inv.relations) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
  const kindText = [...kinds].map(([kind, n]) => `${kind} ${String(n)}`).join(', ');
  const sp = inv.storedProcedureCheck;
  const live = sp.live.total === null ? PENDING : String(sp.live.total);
  const fk = sp.foreignKeys === undefined ? '' : `; foreign keys: static ${String(sp.foreignKeys.static)}`;
  return [
    `- Relations: ${String(inv.relations.length)}${kindText === '' ? '' : ` (${text(kindText)})`}`,
    `- Stored procedures: static ${String(sp.static.count)}, live ${live}${fk}`,
  ];
}

// Source of every item by id, for findings that name an item without its source.
function sourceIndex(inv: RenderableInventory): Map<string, SourceRef> {
  const index = new Map<string, SourceRef>();
  const add = (item: SourcedItem): void => {
    if (item.source && !index.has(item.id)) index.set(item.id, item.source);
  };
  for (const list of [inv.entities, inv.services, inv.frontEnd, inv.routes, inv.tables, inv.relations]) list.forEach(add);
  for (const c of inv.controllers) {
    add(c);
    for (const a of c.actions) a.variants.forEach(add);
  }
  for (const j of inv.scheduledJobs) {
    add(j);
    j.steps.forEach(add);
  }
  return index;
}

function findingsSection(inv: RenderableInventory, findings: readonly InventoryFinding[]): string[] {
  if (findings.length === 0) return ['None.'];
  const sources = sourceIndex(inv);
  return table(
    ['Kind', 'Id', 'Source', 'Detail'],
    findings.map((f) => {
      const id = f.id ?? f.measure ?? null;
      const source = sourceText(f.source ?? (id === null ? undefined : sources.get(id)));
      const figures =
        f.aapFigure === undefined && f.computed === undefined
          ? null
          : `AAP ${String(f.aapFigure ?? EMPTY)}, computed ${String(f.computed ?? EMPTY)}`;
      return [text(f.kind), code(id), code(source), text(f.detail ?? figures)];
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------------------------------------------

/**
 * Renders the inventory as the title and body lines of `opt2/inventory/legacy-inventory.md`, for
 * `writeMarkdown(path, title, lines)`. Pure: rows keep the inventory's order and no value is recomputed.
 */
export function renderInventoryMarkdown(inv: RenderableInventory): { title: string; lines: string[] } {
  const from = typeof inv.extractedFrom === 'string' ? inv.extractedFrom : `${inv.extractedFrom.method} ${inv.extractedFrom.sha}`;
  const sections: string[][] = [
    [`Extracted from: ${text(from)} · generator: ${text(inv.generatedBy)} · live fields: ${liveStatusOf(inv.counts)}`],
    ['## Counts', '', ...countsSection(inv.counts)],
    ['## Admin controllers', '', ...controllersSection(inv)],
    ...routeSections(inv.routes),
    ['## Public front end', '', ...frontEndSection(inv.frontEnd)],
    ['## Site monitor', '', ...inv.scheduledJobs.flatMap((job, i) => [...(i > 0 ? [''] : []), ...jobLines(job)])],
    ['## Tables', '', ...tablesSection(inv.tables)],
    ['## Relations and stored procedures', '', ...relationsSection(inv)],
  ];
  if (inv.findings !== undefined) sections.push(['## Findings', '', ...findingsSection(inv, inv.findings)]);
  return { title: INVENTORY_TITLE, lines: sections.flatMap((s, i) => (i === 0 ? s : ['', ...s])) };
}

