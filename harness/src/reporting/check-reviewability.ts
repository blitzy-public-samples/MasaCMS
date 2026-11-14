// Checks each service's README, TRACEABILITY and contracts for the pinned SHA, and that its traceability table
// covers every inventory item it carries or owns.
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from '@opt2/platform/service-kit';

import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { REPO_ROOT, reportsDir, type EnvLike } from '../lib/paths.js';
import { pinnedSha, readPin, type Pin } from '../lib/pin.js';
import { readJson, writeJsonReport, writeMarkdown } from '../lib/report.js';
import { extractSha } from './check-pin.js';

/** The ten OPT-2 services, in plan order; the stub is not one of them. */
export const TEN_SERVICES = [
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
] as const;

/** One of {@link TEN_SERVICES}. */
export type ServiceName = (typeof TEN_SERVICES)[number];

/** The six synthetic services, whose legacy oracle is `legacy-fixtures/`. */
export const SYNTHETIC_SERVICES = [
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
] as const satisfies readonly ServiceName[];

/** Recorded as the report's `generatedBy`. */
export const GENERATED_BY = 'harness/src/reporting/check-reviewability.ts';

/** Repository-relative inputs, resolved under the checked root. */
export const INVENTORY_PATH = 'opt2/inventory/legacy-inventory.json';
export const OWNERSHIP_PATH = 'opt2/table-ownership.json';
const PIN_RELATIVE_PATH = 'opt2/source-pin.json';

/** Pass condition stated in both report files. */
export const PASS_CONDITION =
  'README.md, TRACEABILITY.md and contracts present with the pinned SHA; ' +
  'every inventory item the service carries or owns has a traceability row';

/** One data row of a Markdown pipe table in a TRACEABILITY file. */
export interface TraceabilityRow {
  /** 1-based line number in the file. */
  line: number;
  /** Cell texts with `\|` unescaped. */
  cells: string[];
  /** Lower-cased match tokens of the row. */
  tokens: Set<string>;
  /** `path.ext:lines` references and `legacy-fixtures/` paths, as written. */
  sourceRefs: string[];
  /** Target code paths, as written. */
  codePaths: string[];
  /** Test files (suffix stripped) and GS scenario ids, as written. */
  testRefs: string[];
}

const SEPARATOR_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;
const CODE_SPAN = /`([^`]+)`/g;
const WORD_LEAD = /^[`*()[\];]+/;
const WORD_TRAIL = /[`*()[\];.,]+$/;
const CELL_EDGE = /^[`*\s]+|[`*\s]+$/g;
const PATH_TOKEN = /^[^\s`'"<>|;]+$/;
const SOURCE_REF = /^[^\s:]+\.[A-Za-z0-9]+:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;
const CODE_PREFIXES =
  /^(?:src|db|scripts|config)\/|^services\/[^/]+\/(?:src|db|scripts|config)\/|^(?:web|gateway|platform|migration)\//;
const SCENARIO_ID = /^GS-[A-Z]+(-RH)?-\d{2}$/;
const TEST_FILE = /(?:^|\/)(?:test|e2e)\/.*(?:\.test\.ts|\.e2e\.ts)$/;
const REF_SUFFIX = /(?:#.*|:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/;
const SERVICE_RELATIVE = /^(?:src|db|scripts|config|test)\//;

/** Cells of a pipe-table row, split on unescaped `|`, with `\|` unescaped. */
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (ch === '\\' && row[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  const trimmed = row.trim();
  // Leading and trailing pipes delimit the row rather than an empty cell.
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) cells.pop();
  return cells.map((cell) => cell.trim());
}

function stripWord(word: string): string {
  return word.replace(WORD_LEAD, '').replace(WORD_TRAIL, '');
}

/** Match candidates of one cell, original case: code-span contents, the trimmed cell text and stripped words. */
function cellCandidates(cell: string): { spans: string[]; whole: string; words: string[] } {
  const spans = [...cell.matchAll(CODE_SPAN)].flatMap((m) => {
    const content = m[1]?.trim() ?? '';
    return content === '' ? [] : [content];
  });
  const words = cell
    .split(/\s+/)
    .map(stripWord)
    .filter((word) => word !== '');
  return { spans, whole: cell.replace(CELL_EDGE, ''), words };
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function rowOf(line: number, cells: string[]): TraceabilityRow {
  const tokens = new Set<string>();
  const sourceRefs: string[] = [];
  const codePaths: string[] = [];
  const testRefs: string[] = [];
  for (const cell of cells) {
    const { spans, whole, words } = cellCandidates(cell);
    if (whole !== '') tokens.add(whole.toLowerCase());
    for (const candidate of [...spans, ...words]) {
      tokens.add(candidate.toLowerCase());
      if (SCENARIO_ID.test(candidate)) {
        pushUnique(testRefs, candidate);
        continue;
      }
      if (!PATH_TOKEN.test(candidate)) continue;
      const testFile = candidate.replace(REF_SUFFIX, '');
      // A test file cited with a line suffix proves the row; it is not a legacy source.
      if (TEST_FILE.test(testFile)) {
        pushUnique(testRefs, testFile);
      } else if (SOURCE_REF.test(candidate) || candidate.startsWith('legacy-fixtures/')) {
        pushUnique(sourceRefs, candidate);
      } else if (
        CODE_PREFIXES.test(candidate) &&
        !candidate.includes('/test/') &&
        !candidate.includes('/e2e/')
      ) {
        pushUnique(codePaths, candidate);
      }
    }
  }
  return { line, cells, tokens, sourceRefs, codePaths, testRefs };
}

/**
 * Data rows of every Markdown pipe table in `markdown`: each table's header row (the row before its `|---|`
 * separator) and the separator are skipped, and pipe rows inside fenced code blocks are ignored.
 */
export function parseTraceabilityRows(markdown: string): TraceabilityRow[] {
  const lines = markdown.split(/\r?\n/);
  const rows: TraceabilityRow[] = [];
  let inFence = false;
  let inTable = false;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? '';
    if (FENCE.test(text)) {
      inFence = !inFence;
      inTable = false;
      continue;
    }
    if (inFence) continue;
    const isPipeRow = text.trimStart().startsWith('|');
    if (inTable) {
      // Inside a table body a delimiter-like row is data, as in GFM.
      if (isPipeRow) rows.push(rowOf(i + 1, splitCells(text)));
      else inTable = false;
      continue;
    }
    const previous = lines[i - 1];
    if (SEPARATOR_ROW.test(text) && text.includes('|') && previous !== undefined && previous.includes('|')) {
      inTable = true;
    }
  }
  return rows;
}

/** Number of traceability data rows in `markdown`. */
export function traceabilityRowCount(markdown: string): number {
  return parseTraceabilityRows(markdown).length;
}

const entrySchema = z.looseObject({
  id: z.string(),
  owningService: z.string().nullish(),
  disposition: z.string().nullish(),
  routeKey: z.string().nullish(),
  baseRouteKey: z.string().nullish(),
});
const actionSchema = entrySchema.extend({ variants: z.array(entrySchema).nullish() });
const controllerSchema = z.looseObject({ actions: z.array(actionSchema).nullish() });
const jobSchema = entrySchema.extend({ steps: z.array(entrySchema).nullish() });
const tableSchema = entrySchema.extend({ table: z.string() });

/** The fields of `opt2/inventory/legacy-inventory.json` this check reads; other fields pass through. */
export const inventorySchema = z.looseObject({
  entities: z.array(entrySchema).default([]),
  services: z.array(entrySchema).default([]),
  controllers: z.array(controllerSchema).default([]),
  frontEnd: z.array(entrySchema).default([]),
  scheduledJobs: z.array(jobSchema).default([]),
  routes: z.array(entrySchema).default([]),
  tables: z.array(tableSchema).default([]),
});

/** The fields of `opt2/table-ownership.json` this check reads; a unit is named by `unit` (or `id`). */
export const ownershipSchema = z.looseObject({
  units: z
    .array(z.looseObject({ unit: z.string().optional(), id: z.string().optional(), owner: z.string() }))
    .default([]),
  tables: z
    .array(
      z.looseObject({
        table: z.string(),
        owner: z.string(),
        targets: z.array(z.looseObject({ unit: z.string(), owner: z.string().nullish() })).default([]),
      }),
    )
    .default([]),
});

/** A validated inventory. */
export type Inventory = z.infer<typeof inventorySchema>;
/** A validated table-ownership file. */
export type Ownership = z.infer<typeof ownershipSchema>;
type InventoryEntry = z.infer<typeof entrySchema>;

/** Inventory list an item comes from. */
export type ItemCategory = 'entity' | 'service' | 'admin-action' | 'front-end' | 'job' | 'route' | 'table';

/** One inventory item a service carries or owns. */
export interface ReviewItem {
  id: string;
  category: ItemCategory;
  disposition: string | null;
  routeKey?: string;
  baseRouteKey?: string;
  /** Legacy table name, for tables. */
  table?: string;
  /** Target units of the table this service owns, for tables. */
  units?: string[];
}

const FIXTURE_SCHEMA = /^(?:program_(?:\d+|n)|synthetic)\./i;
/** Dispositions whose items keep running on legacy, so their rows need no target code path. */
const CODE_EXEMPT: ReadonlySet<string> = new Set(['legacy-served', 'decision', 'retired']);

function itemOf(entry: InventoryEntry, category: ItemCategory): ReviewItem {
  const item: ReviewItem = { id: entry.id, category, disposition: entry.disposition ?? null };
  if (entry.routeKey) item.routeKey = entry.routeKey;
  if (entry.baseRouteKey) item.baseRouteKey = entry.baseRouteKey;
  return item;
}

/**
 * Items `service` carries (`disposition === 'carry'` and `owningService === service`) across entities, services,
 * admin actions and their variants, front-end entries, scheduled jobs and their steps, and routes; plus every table
 * it owns, whole or through a split target unit. Ordered by inventory list, then inventory order; ids are unique.
 */
export function carriedOrOwnedItems(service: string, inventory: Inventory, ownership: Ownership): ReviewItem[] {
  const items = new Map<string, ReviewItem>();
  const add = (item: ReviewItem): void => {
    if (!items.has(item.id)) items.set(item.id, item);
  };
  const carried = (entry: InventoryEntry): boolean =>
    entry.owningService === service && entry.disposition === 'carry';

  const actions = inventory.controllers.flatMap((c) => (c.actions ?? []).flatMap((a) => [a, ...(a.variants ?? [])]));
  const lists: [InventoryEntry[], ItemCategory][] = [
    [inventory.entities, 'entity'],
    [inventory.services, 'service'],
    [actions, 'admin-action'],
    [inventory.frontEnd, 'front-end'],
    [inventory.scheduledJobs.flatMap((job) => [job, ...(job.steps ?? [])]), 'job'],
    [inventory.routes, 'route'],
  ];
  for (const [entries, category] of lists) {
    for (const entry of entries) if (carried(entry)) add(itemOf(entry, category));
  }

  const unitOwner = new Map<string, string>();
  for (const unit of ownership.units) {
    const name = unit.unit ?? unit.id;
    if (name !== undefined) unitOwner.set(name, unit.owner);
  }
  const ownedUnits = new Map<string, string[]>();
  const splitOwned = new Set<string>();
  for (const table of ownership.tables) {
    const units = table.targets
      .filter((target) => (unitOwner.get(target.unit) ?? target.owner) === service)
      .map((target) => target.unit);
    ownedUnits.set(table.table, units);
    if (table.owner === 'split' && units.length > 0) splitOwned.add(table.table);
  }
  const inventoryTables = new Map(inventory.tables.map((table) => [table.table, table]));
  const tableItem = (name: string, entry: InventoryEntry | undefined): ReviewItem => ({
    ...(entry === undefined ? { id: `tbl:${name}`, category: 'table', disposition: null } : itemOf(entry, 'table')),
    table: name,
    units: ownedUnits.get(name) ?? [],
  });
  for (const table of inventory.tables) {
    if (table.owningService === service) add(tableItem(table.table, table));
  }
  for (const name of splitOwned) add(tableItem(name, inventoryTables.get(name)));
  return [...items.values()];
}

/** Lower-cased keys a row may name an item by: its id and route keys, and for tables the table and owned unit names. */
export function coverageKeys(item: ReviewItem): string[] {
  const keys = [item.id, item.routeKey, item.baseRouteKey];
  if (item.table !== undefined) keys.push(item.table, item.table.replace(FIXTURE_SCHEMA, ''), ...(item.units ?? []));
  const present = keys.filter((key): key is string => key !== undefined && key !== '');
  return [...new Set(present.map((key) => key.toLowerCase()))];
}

/** A checked file under `services/<svc>/`; `sha` is its first SHA differing from the pin, else its first SHA. */
export type FileRecord = { path: string; present: boolean; sha: string | null };

/** The TRACEABILITY file record with its data-row count (`null` when absent). */
export type TraceabilityRecord = FileRecord & { rows: number | null };

/** Why a carried or owned item lacks a valid traceability row. */
export type MissingReason = 'no-row' | 'incomplete-row' | 'code-path-missing' | 'test-missing';

/** Parts a covering row must reference. */
export type RowPart = 'source-ref' | 'code-path' | 'test-ref';

/** An uncovered item; `line` is the row judged, `lacks` its absent parts, `paths` its references not on disk. */
export type MissingItem = {
  id: string;
  routeKey?: string;
  reason: MissingReason;
  line?: number;
  lacks?: RowPart[];
  paths?: string[];
};

/** Outcome of {@link checkService}. */
export type ServiceReport = {
  service: string;
  readme: FileRecord;
  traceability: TraceabilityRecord;
  contracts: { openapi: FileRecord; events: FileRecord[] };
  inventoryItems: { carriedOrOwned: number; covered: number; missing: MissingItem[] };
  result: 'pass' | 'fail';
};

/** Body of `opt2/reports/reviewability.json`. */
export type ReviewabilityReport = {
  sourceSha: string;
  generatedBy: string;
  generatedAt: string;
  status: 'generated';
  inventory: string;
  passCondition: string;
  services: ServiceReport[];
  result: 'pass' | 'fail';
};

/** Inputs of {@link checkService}: the checkout read, the pinned SHA, and the validated inventory and ownership. */
export interface CheckDeps {
  root: string;
  sha: string;
  inventory: Inventory;
  ownership: Ownership;
}

type RowVerdict =
  | { ok: true }
  | { ok: false; reason: Exclude<MissingReason, 'no-row'>; lacks?: RowPart[]; paths?: string[] };

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function checkFile(
  root: string,
  relPath: string,
  sha: string,
): Promise<{ record: FileRecord; content: string | null }> {
  const content = await readOptional(path.join(root, relPath));
  if (content === null) return { record: { path: relPath, present: false, sha: null }, content };
  const { found, problem } = extractSha(relPath, content, sha);
  const carried = problem === undefined ? (found.find((value) => value !== sha) ?? found[0] ?? null) : null;
  return { record: { path: relPath, present: true, sha: carried }, content };
}

/** Whether `record` is present and carries exactly `sha`. */
export function fileOk(record: FileRecord, sha: string): boolean {
  return record.present && record.sha === sha;
}

async function eventContracts(root: string, service: string): Promise<string[]> {
  const dir = `services/${service}/contracts/events`;
  let names: string[];
  try {
    names = await fs.readdir(path.join(root, dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${dir}/${name}`);
}

/** Existence check for row references: service-relative paths resolve under `services/<svc>/`, others under `root`. */
function referenceChecker(root: string, service: string): (ref: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (ref) => {
    const relPath = ref.replace(/#.*$/, '');
    const file = SERVICE_RELATIVE.test(relPath)
      ? path.join(root, 'services', service, relPath)
      : path.join(root, relPath);
    let known = cache.get(file);
    if (known === undefined) {
      known = fs.access(file).then(
        () => true,
        () => false,
      );
      cache.set(file, known);
    }
    return known;
  };
}

async function missingRefs(refs: string[], exists: (ref: string) => Promise<boolean>): Promise<string[]> {
  const checkable = refs.filter((ref) => !ref.includes('*') && !ref.includes('{') && !SCENARIO_ID.test(ref));
  const present = await Promise.all(checkable.map(exists));
  return checkable.filter((_, i) => !present[i]);
}

async function judgeRow(
  row: TraceabilityRow,
  requireCode: boolean,
  exists: (ref: string) => Promise<boolean>,
): Promise<RowVerdict> {
  const lacks: RowPart[] = [];
  if (row.sourceRefs.length === 0) lacks.push('source-ref');
  if (requireCode && row.codePaths.length === 0) lacks.push('code-path');
  if (row.testRefs.length === 0) lacks.push('test-ref');
  if (lacks.length > 0) return { ok: false, reason: 'incomplete-row', lacks };
  const [code, tests] = await Promise.all([missingRefs(row.codePaths, exists), missingRefs(row.testRefs, exists)]);
  if (code.length > 0) return { ok: false, reason: 'code-path-missing', paths: [...code, ...tests] };
  if (tests.length > 0) return { ok: false, reason: 'test-missing', paths: tests };
  return { ok: true };
}

/** Rows naming `item`, in file order, through an index from token to row positions. */
function coveringRows(item: ReviewItem, rows: TraceabilityRow[], index: Map<string, number[]>): TraceabilityRow[] {
  const positions = new Set<number>();
  for (const key of coverageKeys(item)) for (const position of index.get(key) ?? []) positions.add(position);
  return [...positions].sort((a, b) => a - b).flatMap((position) => rows[position] ?? []);
}

/**
 * Verdict for one item: covered when any covering row has a source ref, a code path (unless legacy-run) and a test
 * ref, all on disk; otherwise the first complete row's missing references, else the first row's absent parts.
 */
async function judgeItem(
  item: ReviewItem,
  rows: TraceabilityRow[],
  index: Map<string, number[]>,
  exists: (ref: string) => Promise<boolean>,
): Promise<MissingItem | null> {
  const base: MissingItem = { id: item.id, reason: 'no-row' };
  if (item.routeKey !== undefined) base.routeKey = item.routeKey;
  let incomplete: MissingItem | undefined;
  let unresolved: MissingItem | undefined;
  for (const row of coveringRows(item, rows, index)) {
    const verdict = await judgeRow(row, !CODE_EXEMPT.has(item.disposition ?? ''), exists);
    if (verdict.ok) return null;
    const missing: MissingItem = { ...base, reason: verdict.reason, line: row.line };
    if (verdict.lacks !== undefined) missing.lacks = verdict.lacks;
    if (verdict.paths !== undefined) missing.paths = verdict.paths;
    if (verdict.reason === 'incomplete-row') incomplete ??= missing;
    else unresolved ??= missing;
  }
  return unresolved ?? incomplete ?? base;
}

/** Checks one service's README, TRACEABILITY and contracts for the pinned SHA, and its traceability coverage. */
export async function checkService(service: string, deps: CheckDeps): Promise<ServiceReport> {
  const dir = `services/${service}`;
  const [readme, traceability, openapi, eventPaths] = await Promise.all([
    checkFile(deps.root, `${dir}/README.md`, deps.sha),
    checkFile(deps.root, `${dir}/TRACEABILITY.md`, deps.sha),
    checkFile(deps.root, `${dir}/contracts/openapi.yaml`, deps.sha),
    eventContracts(deps.root, service),
  ]);
  const events = await Promise.all(eventPaths.map((relPath) => checkFile(deps.root, relPath, deps.sha)));

  const rows = traceability.content === null ? [] : parseTraceabilityRows(traceability.content);
  const index = new Map<string, number[]>();
  rows.forEach((row, position) => {
    for (const token of row.tokens) {
      const positions = index.get(token);
      if (positions === undefined) index.set(token, [position]);
      else positions.push(position);
    }
  });
  const exists = referenceChecker(deps.root, service);
  const items = carriedOrOwnedItems(service, deps.inventory, deps.ownership);
  const verdicts = await Promise.all(items.map((item) => judgeItem(item, rows, index, exists)));
  const missing = verdicts.filter((verdict): verdict is MissingItem => verdict !== null);

  const files = [readme.record, traceability.record, openapi.record, ...events.map((event) => event.record)];
  const result = files.every((record) => fileOk(record, deps.sha)) && missing.length === 0 ? 'pass' : 'fail';
  return {
    service,
    readme: readme.record,
    traceability: { ...traceability.record, rows: traceability.content === null ? null : rows.length },
    contracts: { openapi: openapi.record, events: events.map((event) => event.record) },
    inventoryItems: { carriedOrOwned: items.length, covered: items.length - missing.length, missing },
    result,
  };
}

/** Report of `services` checked against `deps`, stamped `generatedAt` by `clock`. */
export async function buildReport(
  services: readonly string[],
  deps: CheckDeps,
  clock: () => Date = () => new Date(),
): Promise<ReviewabilityReport> {
  const reports = await Promise.all(services.map((service) => checkService(service, deps)));
  return {
    sourceSha: deps.sha,
    generatedBy: GENERATED_BY,
    generatedAt: clock().toISOString(),
    status: 'generated',
    inventory: INVENTORY_PATH,
    passCondition: PASS_CONDITION,
    services: reports,
    result: reports.every((report) => report.result === 'pass') ? 'pass' : 'fail',
  };
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function fileCell(record: FileRecord, sha: string): string {
  if (!record.present) return 'absent';
  if (record.sha === null) return 'no SHA';
  return record.sha === sha ? 'ok' : 'SHA mismatch';
}

function eventsCell(events: FileRecord[], sha: string): string {
  if (events.length === 0) return 'none';
  return `${events.filter((event) => fileOk(event, sha)).length}/${events.length} ok`;
}

function missingLine(item: MissingItem): string {
  const name = item.routeKey === undefined ? `\`${item.id}\`` : `\`${item.id}\` (\`${item.routeKey}\`)`;
  const at = item.line === undefined ? '' : ` at line ${item.line}`;
  const detail =
    item.lacks !== undefined
      ? ` (lacks ${item.lacks.join(', ')})`
      : item.paths !== undefined
        ? `: ${item.paths.map((ref) => `\`${ref}\``).join(', ')}`
        : '';
  return `- ${name}: ${item.reason}${at}${detail}`;
}

/** Body lines of `opt2/reports/reviewability.md`, after its title and `Source SHA:` line. */
export function markdownLines(report: ReviewabilityReport): string[] {
  const sha = report.sourceSha;
  const lines = [
    `Status: ${report.status}`,
    `Generated by: ${report.generatedBy}`,
    `Generated at: ${report.generatedAt}`,
    `Inventory: \`${report.inventory}\``,
    `Result: **${report.result}**`,
    '',
    '| Service | README | TRACEABILITY | OpenAPI | Events | Rows | Carried or owned | Covered | Missing | Result |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const service of report.services) {
    const { carriedOrOwned, covered, missing } = service.inventoryItems;
    const cells = [
      service.service,
      fileCell(service.readme, sha),
      fileCell(service.traceability, sha),
      fileCell(service.contracts.openapi, sha),
      eventsCell(service.contracts.events, sha),
      service.traceability.rows === null ? '—' : String(service.traceability.rows),
      String(carriedOrOwned),
      String(covered),
      String(missing.length),
      service.result,
    ];
    lines.push(`| ${cells.map(cell).join(' | ')} |`);
  }
  lines.push('', `Pass: ${PASS_CONDITION}.`, '', '## Missing items', '');
  const withMissing = report.services.filter((service) => service.inventoryItems.missing.length > 0);
  if (withMissing.length === 0) lines.push('None.');
  for (const service of withMissing) {
    lines.push(`### ${service.service}`, '', ...service.inventoryItems.missing.map(missingLine), '');
  }
  return lines;
}

const USAGE = 'check-reviewability [--root <dir>] [--service <name>]... [--no-write]';
const HELP = `${USAGE} [--help]

Checks that each service carries README.md, TRACEABILITY.md and contracts/openapi.yaml with the pinned SHA (and every
contracts/events/*.json it has), and that its TRACEABILITY.md has a row for every inventory item it carries or owns:
the item's inventory id, route key or table, a legacy source (path:lines or a legacy-fixtures/ path), a code path
(carried items) and a test file or GS id, each referenced file present.

Options:
  --root <dir>       checkout to check, resolved against the working directory (default: the repository root)
  --service <name>   check only this service; repeatable (default: ${TEN_SERVICES.join(', ')})
  --no-write         print the summary only; write no report
  --help             print this help and exit 0

Reads <root>/${INVENTORY_PATH}, <root>/${OWNERSHIP_PATH} and <root>/${PIN_RELATIVE_PATH}.
Writes reviewability.json and reviewability.md to OPT2_REPORTS_DIR (default opt2/reports).

Output: one JSON summary line on stdout. Exit: 0 every checked service passes, 1 any fails or a failure, 2 usage error.

Examples (from harness/):
  npm run check:reviewability
  npm run check:reviewability -- --service identity --no-write`;

function isServiceName(name: string): name is ServiceName {
  return (TEN_SERVICES as readonly string[]).includes(name);
}

function selectServices(names: string[] | undefined): ServiceName[] {
  if (names === undefined || names.length === 0) return [...TEN_SERVICES];
  const unknown = names.filter((name) => !isServiceName(name));
  if (unknown.length > 0) {
    throw new UsageError(`--service ${unknown.join(', ')}: not one of ${TEN_SERVICES.join(', ')}`, USAGE);
  }
  return TEN_SERVICES.filter((service) => names.includes(service));
}

/** Injectable process inputs of {@link main}. */
export interface MainDeps {
  root?: string;
  env?: EnvLike;
  clock?: () => Date;
}

/** CLI entry: checks the selected services and writes both report files unless `--no-write`; exit 1 when any fails. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: {
      root: { type: 'string' },
      service: { type: 'string', multiple: true },
      'no-write': { type: 'boolean' },
    },
    usage: USAGE,
    help: HELP,
  });
  if (values.root === '') throw new UsageError('--root needs a directory', USAGE);
  const root = values.root === undefined ? (deps.root ?? REPO_ROOT) : path.resolve(values.root);
  const services = selectServices(values.service);

  const pinPath = path.join(root, PIN_RELATIVE_PATH);
  const sha = pinnedSha({ path: pinPath });
  const [inventory, ownership] = await Promise.all([
    readJson(path.join(root, INVENTORY_PATH), inventorySchema),
    readJson(path.join(root, OWNERSHIP_PATH), ownershipSchema),
  ]);
  const report = await buildReport(services, { root, sha, inventory, ownership }, deps.clock);

  if (values['no-write'] !== true) {
    const dir = reportsDir(deps.env ?? process.env);
    const pin = (): Pin => readPin({ path: pinPath });
    await writeJsonReport(path.join(dir, 'reviewability.json'), report, { generatedBy: GENERATED_BY, pin });
    await writeMarkdown(path.join(dir, 'reviewability.md'), 'Reviewability', markdownLines(report), { pin });
  }
  const failing = report.services.filter((service) => service.result !== 'pass').map((service) => service.service);
  return { code: report.result === 'pass' ? 0 : 1, summary: { result: report.result, failing } };
}

if (isMainModule(import.meta.url)) void runCli(main);
