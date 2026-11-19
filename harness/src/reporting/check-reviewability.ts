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
  'every inventory item the service carries or owns has a traceability row; ' +
  'every cited test name is a test title of its cited file';

/** A test file a row cites, suffix stripped, with the quoted test names cited after it. */
export interface TestCitation {
  file: string;
  names: string[];
}

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
  /** Each cited test file with its cited test names, in cell order. */
  testNames: TestCitation[];
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
/** What may follow the quote closing a cited test name. */
const NAME_CLOSE = /^\s*(?:,\s*"|;|\(|$)/;
const BARE_WORD = /[^\s`"(;]+/y;

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

/** The code span opening at `start`: its content and end, or a null content when no equal backtick run closes it. */
function codeSpanAt(text: string, start: number): { content: string | null; end: number } {
  let open = start;
  while (text.charAt(open) === '`') open += 1;
  for (let at = open; at < text.length; ) {
    if (text.charAt(at) !== '`') {
      at += 1;
      continue;
    }
    let close = at;
    while (text.charAt(close) === '`') close += 1;
    if (close - at === open - start) return { content: text.slice(open, at), end: close };
    at = close;
  }
  return { content: null, end: open };
}

/** Index of the quote closing a test name that opens before `from`, or -1 when none closes it. */
function nameEnd(cell: string, from: number): number {
  for (let at = cell.indexOf('"', from); at !== -1; at = cell.indexOf('"', at + 1)) {
    const rest = cell.slice(at + 1);
    if (!rest.startsWith('"') && NAME_CLOSE.test(rest)) return at;
  }
  return -1;
}

/** End of the parenthetical opening at `start`, code spans skipped. */
function parentheticalEnd(cell: string, start: number): number {
  let depth = 0;
  for (let at = start; at < cell.length; ) {
    const ch = cell.charAt(at);
    if (ch === '`') {
      at = codeSpanAt(cell, at).end;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return at + 1;
    at += 1;
  }
  return cell.length;
}

/** The test file `candidate` names, its line or anchor suffix stripped, or null. */
function testFileOf(candidate: string): string | null {
  if (!PATH_TOKEN.test(candidate)) return null;
  const file = candidate.replace(REF_SUFFIX, '');
  return TEST_FILE.test(file) ? file : null;
}

/** Test files a cell cites, each with the quoted names after it up to the next `;`, test file, GS id or cell end. */
function cellCitations(cell: string): TestCitation[] {
  const citations: TestCitation[] = [];
  let current: TestCitation | undefined;
  const cite = (candidate: string): void => {
    const file = testFileOf(candidate);
    if (file !== null) {
      current = { file, names: [] };
      citations.push(current);
    } else if (SCENARIO_ID.test(candidate)) {
      current = undefined;
    }
  };
  for (let at = 0; at < cell.length; ) {
    const ch = cell.charAt(at);
    if (ch === '`') {
      const span = codeSpanAt(cell, at);
      if (span.content !== null) cite(span.content.trim());
      at = span.end;
    } else if (ch === '"' && current !== undefined) {
      const close = nameEnd(cell, at + 1);
      const end = close === -1 ? cell.length : close;
      current.names.push(cell.slice(at + 1, end));
      at = end + 1;
    } else if (ch === '(' && current !== undefined) {
      at = parentheticalEnd(cell, at);
    } else if (ch === ';') {
      current = undefined;
      at += 1;
    } else if (/[\s"(]/.test(ch)) {
      at += 1;
    } else {
      BARE_WORD.lastIndex = at;
      const word = BARE_WORD.exec(cell)?.[0] ?? ch;
      cite(stripWord(word));
      at += word.length;
    }
  }
  return citations;
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
  return { line, cells, tokens, sourceRefs, codePaths, testRefs, testNames: cells.flatMap(cellCitations) };
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
  ownerBasis: z.string().nullish(),
  disposition: z.string().nullish(),
  routeKey: z.string().nullish(),
  baseRouteKey: z.string().nullish(),
});
const actionSchema = entrySchema.extend({ variants: z.array(entrySchema).nullish() });
const controllerSchema = entrySchema.extend({ actions: z.array(actionSchema).nullish() });
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

/** Inventory list an item comes from; `admin-controller` is a `controllers[]` circuit itself. */
export type ItemCategory =
  | 'entity'
  | 'service'
  | 'admin-controller'
  | 'admin-action'
  | 'front-end'
  | 'job'
  | 'route'
  | 'table';

/** One inventory item a service carries or owns. */
export interface ReviewItem {
  id: string;
  category: ItemCategory;
  disposition: string | null;
  /** Whether a covering row must cite target code; false for items that keep running on legacy. */
  codeRequired: boolean;
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
/**
 * `ownerBasis` values of an owner that is not settled: one the decision list only proposes, or the planned owner of a
 * write set that spans owners with no input naming one. The item is not owned until the user approves.
 */
const UNSETTLED_OWNER: ReadonlySet<string> = new Set(['decision-list-proposal', 'spanning']);

function itemOf(
  entry: InventoryEntry,
  category: ItemCategory,
  codeRequired = !CODE_EXEMPT.has(entry.disposition ?? ''),
): ReviewItem {
  const item: ReviewItem = { id: entry.id, category, disposition: entry.disposition ?? null, codeRequired };
  if (entry.routeKey) item.routeKey = entry.routeKey;
  if (entry.baseRouteKey) item.baseRouteKey = entry.baseRouteKey;
  return item;
}

/**
 * Items `service` carries or owns (`owningService === service`, any disposition, unless that owner is unsettled) across
 * entities, services, controllers with their actions and variants, front-end entries, scheduled jobs and their steps,
 * routes and tables; plus every table it owns through a split target unit. A controller needs target code only when
 * the service carries one of its actions. Ordered by inventory list, then inventory order; ids are unique.
 */
export function carriedOrOwnedItems(service: string, inventory: Inventory, ownership: Ownership): ReviewItem[] {
  const items = new Map<string, ReviewItem>();
  const add = (item: ReviewItem): void => {
    if (!items.has(item.id)) items.set(item.id, item);
  };
  const carries = (entry: InventoryEntry): boolean =>
    entry.owningService === service && entry.disposition === 'carry';
  const owns = (entry: InventoryEntry): boolean =>
    entry.owningService === service && (entry.disposition === 'carry' || !UNSETTLED_OWNER.has(entry.ownerBasis ?? ''));
  const addOwned = (entries: InventoryEntry[], category: ItemCategory): void => {
    for (const entry of entries) if (owns(entry)) add(itemOf(entry, category));
  };

  addOwned(inventory.entities, 'entity');
  addOwned(inventory.services, 'service');
  for (const controller of inventory.controllers) {
    const actions = (controller.actions ?? []).flatMap((a) => [a, ...(a.variants ?? [])]);
    if (owns(controller)) add(itemOf(controller, 'admin-controller', actions.some(carries)));
    addOwned(actions, 'admin-action');
  }
  addOwned(inventory.frontEnd, 'front-end');
  addOwned(inventory.scheduledJobs.flatMap((job) => [job, ...(job.steps ?? [])]), 'job');
  addOwned(inventory.routes, 'route');

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
    ...(entry === undefined
      ? { id: `tbl:${name}`, category: 'table', disposition: null, codeRequired: true }
      : itemOf(entry, 'table')),
    table: name,
    units: ownedUnits.get(name) ?? [],
  });
  for (const table of inventory.tables) {
    if (owns(table)) add(tableItem(table.table, table));
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
  citations: CitationCheck;
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

/** File a row reference names: service-relative paths resolve under `services/<svc>/`, others under `root`. */
function refPath(root: string, service: string, ref: string): string {
  const relPath = ref.replace(/#.*$/, '');
  return SERVICE_RELATIVE.test(relPath) ? path.join(root, 'services', service, relPath) : path.join(root, relPath);
}

/** Existence check for row references, resolved by {@link refPath}. */
function referenceChecker(root: string, service: string): (ref: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (ref) => {
    const file = refPath(root, service, ref);
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

type Typescript = typeof import('typescript');
type TsNode = import('typescript').Node;
type TsExpression = import('typescript').Expression;
type TsIdentifier = import('typescript').Identifier;
type TsCall = import('typescript').CallExpression;
type TsTemplate = import('typescript').TemplateExpression;
let typescript: Promise<Typescript> | undefined;

/** The TypeScript compiler, loaded on first use so importers of this module do not load it. */
function loadTypescript(): Promise<Typescript> {
  typescript ??= import('typescript').then((mod) => mod.default);
  return typescript;
}

/** Literal runs of a title or template; one placeholder sits between each adjacent pair. */
type Runs = string[];

/** A template literal, whether it has literal word text, and the templates nested in its placeholders. */
interface CaseTemplate {
  runs: Runs;
  words: boolean;
  nested: CaseTemplate[];
}

/** Values and computed keys a file writes into one binding, and the member names it writes through. */
interface Written {
  values: TsNode[];
  names: string[];
}

/** Literals, property names and numbers reachable from one registration's inputs, its templates, and verdicts. */
interface CaseInputs {
  literals: Set<string>;
  templates: CaseTemplate[];
  memo: Map<string, boolean>;
}

/** A registration whose title is placeholders only or computed; its case names come from its own inputs. */
interface OpenTitle {
  runs: Runs;
  inputs: () => CaseInputs;
}

/** Titles of the test registrations in one source file. */
interface FileTitles {
  /** Literal titles: string titles decoded, template titles as written. */
  exact: Set<string>;
  /** Titles with placeholders and literal words. */
  patterns: RegExp[];
  open: OpenTitle[];
}

/** One parsed source file, the candidate paths of each import it follows, and its titles once classified. */
interface ParsedFile {
  file: string;
  source: import('typescript').SourceFile;
  imports: string[][];
  titles?: FileTitles;
}

/** Titles of a cited file and of every file it imports, transitively. */
interface TitleUniverse {
  files: FileTitles[];
}

/** Placeholders vitest fills in a title (`%%` stays a literal `%`). */
const TITLE_PLACEHOLDER = /%%|%[sdifjoO#$]|\$[A-Za-z_]\w*(?:\.\w+)*/g;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
/** A name, a dotted or hyphenated key, or a number, as computed keys and values print. */
const PLAIN_VALUE = /^(?:[A-Za-z_$][\w$]*(?:[.-][\w$]+)*|-?\d+(?:\.\d+)?)$/;
const PLATFORM_IMPORT = /^@opt2\/platform\/([\w-]+)$/;
/** vitest registrars, called bare or as a property such as `api.it`. */
const REGISTRARS: ReadonlySet<string> = new Set(['it', 'test', 'describe', 'suite', 'bench']);
/** Registrar properties that still name a registrar, as `it.skip` and `describe.each(…)` do. */
const MODIFIERS: ReadonlySet<string> = new Set([
  'each',
  'for',
  'skip',
  'skipIf',
  'runIf',
  'only',
  'concurrent',
  'sequential',
  'todo',
  'fails',
]);
/** Modifiers called before the title, so their own call configures rather than registers. */
const CONFIGURERS: ReadonlySet<string> = new Set(['each', 'for', 'skipIf', 'runIf']);
/** Modifiers whose arguments are a registration's case rows. */
const CASE_SOURCES: ReadonlySet<string> = new Set(['each', 'for']);
/** vitest's registrar types, which a parameter may be declared as. */
const REGISTRAR_TYPES: ReadonlySet<string> = new Set(['TestAPI', 'SuiteAPI', 'ChainableTestAPI', 'ChainableSuiteAPI']);
/** Array methods whose callback parameters take the receiver's elements. */
const ELEMENT_METHODS: ReadonlySet<string> = new Set(['map', 'flatMap', 'forEach', 'filter']);
/** Methods that add their arguments to the array, map or set they are called on. */
const MUTATORS: ReadonlySet<string> = new Set(['push', 'unshift', 'splice', 'set', 'add']);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Runs of `text` split at the placeholders vitest fills. */
function titleRuns(text: string): Runs {
  const runs: Runs = [];
  let run = '';
  let last = 0;
  for (const match of text.matchAll(TITLE_PLACEHOLDER)) {
    run += text.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[0] === '%%') {
      run += '%';
    } else {
      runs.push(run);
      run = '';
    }
  }
  runs.push(run + text.slice(last));
  return runs;
}

function hasWord(runs: Runs): boolean {
  return WORD_CHAR.test(runs.join(''));
}

/** Whole-text pattern of `runs`, each placeholder matching any text. */
function runsPattern(runs: Runs): RegExp {
  return new RegExp(`^${runs.map(escapeRegExp).join('[\\s\\S]*?')}$`);
}

/** Candidate files of an import: relative `.js` as `.ts`/`.tsx`, extensionless, and `@opt2/platform/<sub>` sources. */
function importCandidates(from: string, specifier: string, root: string): string[] {
  const platform = PLATFORM_IMPORT.exec(specifier);
  if (platform !== null) return [path.join(root, 'platform', 'src', platform[1] ?? '', 'index.ts')];
  if (!specifier.startsWith('.')) return [];
  const target = path.resolve(path.dirname(from), specifier);
  const ext = path.extname(target);
  if (ext === '.ts' || ext === '.tsx') return [target];
  const stem = ext === '.js' || ext === '.jsx' ? target.slice(0, -ext.length) : undefined;
  if (stem !== undefined) return [`${stem}.ts`, `${stem}.tsx`];
  return [`${target}.ts`, `${target}.tsx`, path.join(target, 'index.ts'), path.join(target, 'index.tsx')];
}

/** One source file parsed with parent links, and the candidate paths of each value import or re-export. */
function parseSource(ts: Typescript, file: string, text: string, root: string): ParsedFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const imports: string[][] = [];
  for (const node of source.statements) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !(ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly)
    ) {
      const candidates = importCandidates(file, node.moduleSpecifier.text, root);
      if (candidates.length > 0) imports.push(candidates);
    }
  }
  return { file, source, imports };
}

/** Classifier of the test registrations in parsed files whose imports `settled` holds. */
function titleModel(
  ts: Typescript,
  settled: Map<string, ParsedFile | null>,
  root: string,
): (file: ParsedFile) => FileTitles {
  const unwrap = (node: TsExpression): TsExpression =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
      ? unwrap(node.expression)
      : node;
  const templateOf = (node: TsTemplate): CaseTemplate => {
    const runs = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
    const nested: CaseTemplate[] = [];
    const seek = (child: TsNode): void => {
      if (ts.isTemplateExpression(child)) nested.push(templateOf(child));
      else ts.forEachChild(child, seek);
    };
    for (const span of node.templateSpans) seek(span.expression);
    return { runs, words: hasWord(runs), nested };
  };

  /** The declaration `name` binds `text` with, or undefined. */
  const binds = (name: import('typescript').BindingName, text: string): TsNode | undefined => {
    if (ts.isIdentifier(name)) return name.text === text ? name.parent : undefined;
    for (const element of name.elements) {
      const found = ts.isOmittedExpression(element) ? undefined : binds(element.name, text);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const inStatements = (statements: readonly import('typescript').Statement[], text: string): TsNode | undefined => {
    for (const statement of statements) {
      let found: TsNode | undefined;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) found ??= binds(declaration.name, text);
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.name?.text === text
      ) {
        found = statement;
      } else if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
        const clause = statement.importClause;
        const bindings = clause.namedBindings;
        if (clause.name?.text === text) {
          found = clause;
        } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          found = bindings.name.text === text ? bindings : undefined;
        } else {
          found = bindings?.elements.find((element) => element.name.text === text);
        }
      }
      if (found !== undefined) return found;
    }
    return undefined;
  };
  /** The declaration an identifier reference names, sought through its enclosing scopes. */
  const declarationOf = (id: TsIdentifier): TsNode | undefined => {
    for (let scope: TsNode | undefined = id.parent; scope !== undefined; scope = scope.parent) {
      let found: TsNode | undefined;
      if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseOrDefaultClause(scope)) {
        found = inStatements(scope.statements, id.text);
      } else if (
        (ts.isForOfStatement(scope) || ts.isForInStatement(scope) || ts.isForStatement(scope)) &&
        scope.initializer !== undefined &&
        ts.isVariableDeclarationList(scope.initializer)
      ) {
        for (const declaration of scope.initializer.declarations) found ??= binds(declaration.name, id.text);
      } else if (ts.isFunctionLike(scope)) {
        for (const parameter of scope.parameters) found ??= binds(parameter.name, id.text);
      } else if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined) {
        found = binds(scope.variableDeclaration.name, id.text);
      }
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const isExported = (node: TsNode): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  /** The parsed file an import or re-export of `from` names, when it was followed. */
  const moduleOf = (from: TsNode, specifier: TsExpression | undefined): ParsedFile | null => {
    if (specifier === undefined || !ts.isStringLiteral(specifier)) return null;
    for (const candidate of importCandidates(from.getSourceFile().fileName, specifier.text, root)) {
      const parsed = settled.get(candidate);
      if (parsed !== null) return parsed ?? null;
    }
    return null;
  };
  /** The declaration `parsed` exports as `name`, through its re-exports. */
  const exportOf = (parsed: ParsedFile, name: string, seen: Set<string>): TsNode | undefined => {
    const key = `${parsed.file}\0${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    for (const statement of parsed.source.statements) {
      let found: TsNode | undefined;
      if (ts.isExportDeclaration(statement)) {
        const target = moduleOf(statement, statement.moduleSpecifier);
        const clause = statement.exportClause;
        const element =
          clause !== undefined && ts.isNamedExports(clause)
            ? clause.elements.find((entry) => entry.name.text === name)
            : undefined;
        const local = element === undefined ? name : (element.propertyName ?? element.name).text;
        if (clause === undefined || element !== undefined) {
          found =
            target !== null
              ? exportOf(target, local, seen)
              : statement.moduleSpecifier === undefined
                ? inStatements(parsed.source.statements, local)
                : undefined;
        }
      } else if (isExported(statement)) {
        found = inStatements([statement], name);
      }
      if (found !== undefined) return found;
    }
    return undefined;
  };
  /** `node`, or for an import binding the declaration it names in the file it imports. */
  const follow = (node: TsNode | undefined, seen: Set<string> = new Set()): TsNode | undefined => {
    if (node === undefined || !(ts.isImportSpecifier(node) || ts.isImportClause(node))) return node;
    const declaration = ts.isImportSpecifier(node) ? node.parent.parent.parent : node.parent;
    const target = moduleOf(declaration, declaration.moduleSpecifier);
    const name = ts.isImportSpecifier(node) ? (node.propertyName ?? node.name).text : 'default';
    return target === null ? undefined : follow(exportOf(target, name, seen), seen);
  };
  const resolved = new Map<TsIdentifier, TsNode | undefined>();
  /** The declaration `id` names, in this file or in the file an import of it names. */
  const resolve = (id: TsIdentifier): TsNode | undefined => {
    if (!resolved.has(id)) resolved.set(id, follow(declarationOf(id)));
    return resolved.get(id);
  };
  const assignments: ReadonlySet<import('typescript').SyntaxKind> = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
  ]);
  const keywords: ReadonlySet<import('typescript').SyntaxKind> = new Set([
    ts.SyntaxKind.TrueKeyword,
    ts.SyntaxKind.FalseKeyword,
    ts.SyntaxKind.NullKeyword,
  ]);
  const writes = new Map<import('typescript').SourceFile, Map<TsNode, Written>>();
  /** What its file assigns into or adds to the binding `declaration` makes: values, computed keys, member names. */
  const writtenInto = (declaration: TsNode): Written => {
    const source = declaration.getSourceFile();
    let index = writes.get(source);
    if (index === undefined) {
      const found = new Map<TsNode, Written>();
      const record = (target: TsExpression, values: readonly TsNode[]): void => {
        const entry: Written = { values: [...values], names: [] };
        let root = unwrap(target);
        while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
          if (ts.isPropertyAccessExpression(root)) entry.names.push(root.name.text);
          else entry.values.push(root.argumentExpression);
          root = unwrap(root.expression);
        }
        const bound = ts.isIdentifier(root) ? declarationOf(root) : undefined;
        if (bound === undefined) return;
        const known = found.get(bound);
        found.set(
          bound,
          known === undefined
            ? entry
            : { values: [...known.values, ...entry.values], names: [...known.names, ...entry.names] },
        );
      };
      const seek = (node: TsNode): void => {
        if (ts.isBinaryExpression(node) && assignments.has(node.operatorToken.kind)) {
          record(node.left, [node.right]);
        } else if (ts.isCallExpression(node)) {
          const callee = unwrap(node.expression);
          if (ts.isPropertyAccessExpression(callee) && MUTATORS.has(callee.name.text)) {
            record(callee.expression, node.arguments);
          }
        }
        ts.forEachChild(node, seek);
      };
      seek(source);
      index = found;
      writes.set(source, index);
    }
    return index.get(declaration) ?? { values: [], names: [] };
  };

  /** Whether `node` is a registrar: a registrar name or property, a modifier chain of one, or a name bound to one. */
  const isRegistrar = (node: TsExpression, seen: Set<TsNode> = new Set()): boolean => {
    const expression = unwrap(node);
    if (ts.isCallExpression(expression)) {
      const callee = unwrap(expression.expression);
      return ts.isPropertyAccessExpression(callee) && CONFIGURERS.has(callee.name.text) && isRegistrar(callee, seen);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const name = expression.name.text;
      return REGISTRARS.has(name) || (MODIFIERS.has(name) && isRegistrar(expression.expression, seen));
    }
    if (!ts.isIdentifier(expression)) return false;
    if (REGISTRARS.has(expression.text)) return true;
    const declaration = resolve(expression);
    if (declaration === undefined || seen.has(declaration)) return false;
    seen.add(declaration);
    if (!ts.isVariableDeclaration(declaration) && !ts.isParameter(declaration)) return false;
    if (declaration.initializer !== undefined && isRegistrar(declaration.initializer, seen)) return true;
    return ts.isParameter(declaration) && declaration.type !== undefined && typeIsRegistrar(declaration.type, seen);
  };
  /** Whether a declared type is a registrar's: `typeof` one, a vitest registrar type, or an alias of either. */
  const typeIsRegistrar = (type: import('typescript').TypeNode, seen: Set<TsNode>): boolean => {
    if (ts.isParenthesizedTypeNode(type)) return typeIsRegistrar(type.type, seen);
    if (ts.isUnionTypeNode(type)) return type.types.some((member) => typeIsRegistrar(member, seen));
    if (ts.isTypeQueryNode(type)) {
      const queried = (name: import('typescript').EntityName): boolean =>
        ts.isIdentifier(name)
          ? isRegistrar(name, seen)
          : REGISTRARS.has(name.right.text) || (MODIFIERS.has(name.right.text) && queried(name.left));
      return queried(type.exprName);
    }
    if (!ts.isTypeReferenceNode(type)) return false;
    const name = type.typeName;
    if (REGISTRAR_TYPES.has(ts.isIdentifier(name) ? name.text : name.right.text)) return true;
    const alias = ts.isIdentifier(name) ? resolve(name) : undefined;
    if (alias === undefined || seen.has(alias) || !ts.isTypeAliasDeclaration(alias)) return false;
    seen.add(alias);
    return typeIsRegistrar(alias.type, seen);
  };

  const forwarded = new Map<TsNode, number | null>();
  /** Index of the parameter `helper` passes on as the title of a registration in its body, or null. */
  const forwardedParameter = (helper: import('typescript').FunctionLikeDeclaration): number | null => {
    if (forwarded.has(helper)) return forwarded.get(helper) ?? null;
    forwarded.set(helper, null);
    let index: number | null = null;
    const seek = (node: TsNode): void => {
      if (index !== null) return;
      if (ts.isCallExpression(node)) {
        const at = titleIndex(node);
        const title = at === null ? undefined : node.arguments[at];
        const named = title === undefined ? undefined : unwrap(title);
        const declaration = named !== undefined && ts.isIdentifier(named) ? declarationOf(named) : undefined;
        if (declaration !== undefined && ts.isParameter(declaration) && declaration.parent === helper) {
          index = helper.parameters.indexOf(declaration);
        }
      }
      ts.forEachChild(node, seek);
    };
    if (helper.body !== undefined) seek(helper.body);
    forwarded.set(helper, index);
    return index;
  };
  /** The function `declaration` declares or is initialised with, if any. */
  const functionOf = (declaration: TsNode | undefined): import('typescript').FunctionLikeDeclaration | undefined => {
    if (declaration === undefined) return undefined;
    if (ts.isFunctionDeclaration(declaration)) return declaration;
    const value =
      ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
        ? unwrap(declaration.initializer)
        : undefined;
    return value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? value : undefined;
  };
  /** Whether a registration argument is a test or suite body: a function, or a name of one or of a parameter. */
  const isBody = (node: TsExpression): boolean => {
    const value = unwrap(node);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true;
    const declaration = ts.isIdentifier(value) ? resolve(value) : undefined;
    return declaration !== undefined && (ts.isParameter(declaration) || functionOf(declaration) !== undefined);
  };
  /** Index of the argument `call` registers as a title, followed by its body unless a `.todo`, or null. */
  const titleIndex = (call: TsCall): number | null => {
    const callee = unwrap(call.expression);
    const todo = ts.isPropertyAccessExpression(callee) && callee.name.text === 'todo';
    if ((!todo && call.arguments.length < 2) || call.arguments.length === 0) return null;
    if (ts.isPropertyAccessExpression(callee) && CONFIGURERS.has(callee.name.text)) return null;
    const registrar = isRegistrar(callee);
    const helper = registrar || !ts.isIdentifier(callee) ? undefined : functionOf(resolve(callee));
    const at = registrar ? 0 : helper === undefined ? null : forwardedParameter(helper);
    return at !== null && (todo || call.arguments.slice(at + 1).some(isBody)) ? at : null;
  };
  /** The case-row arguments of `call`'s `.each(…)` and `.for(…)` links. */
  const caseRows = (call: TsCall): TsExpression[] => {
    const rows: TsExpression[] = [];
    for (let link = unwrap(call.expression); ; ) {
      if (ts.isCallExpression(link)) {
        const callee = unwrap(link.expression);
        if (ts.isPropertyAccessExpression(callee) && CASE_SOURCES.has(callee.name.text)) rows.push(...link.arguments);
        link = callee;
      } else if (ts.isPropertyAccessExpression(link)) {
        link = unwrap(link.expression);
      } else {
        return rows;
      }
    }
  };

  /** Literals, property names, numbers and templates reachable from `roots`, each name followed to its declaration. */
  const inputsOf = (roots: TsNode[]): CaseInputs => {
    const inputs: CaseInputs = { literals: new Set(), templates: [], memo: new Map() };
    const seen = new Set<TsNode>();
    const returns = (fn: import('typescript').SignatureDeclaration): void => {
      const body = 'body' in fn ? fn.body : undefined;
      if (body === undefined) return;
      if (!ts.isBlock(body)) return walk(body);
      const seek = (node: TsNode): void => {
        if (ts.isReturnStatement(node)) {
          if (node.expression !== undefined) walk(node.expression);
        } else if (!ts.isFunctionLike(node)) {
          ts.forEachChild(node, seek);
        }
      };
      seek(body);
    };
    const declared = (node: TsNode): void => {
      if (seen.has(node)) return;
      seen.add(node);
      if (ts.isBindingElement(node)) {
        if (node.initializer !== undefined) walk(node.initializer);
        let bound: TsNode = node;
        while (ts.isBindingElement(bound) || ts.isObjectBindingPattern(bound) || ts.isArrayBindingPattern(bound)) {
          bound = bound.parent;
        }
        declared(bound);
      } else if (ts.isVariableDeclaration(node)) {
        const holder = node.parent.parent;
        const looped =
          (ts.isForOfStatement(holder) || ts.isForInStatement(holder)) && holder.initializer === node.parent;
        if (looped) walk(holder.expression);
        else if (node.initializer !== undefined) walk(node.initializer);
        const written = writtenInto(node);
        written.names.forEach((name) => inputs.literals.add(name));
        written.values.forEach(walk);
      } else if (ts.isParameter(node)) {
        if (node.initializer !== undefined) walk(node.initializer);
        const fn: TsNode = node.parent;
        const call = fn.parent;
        if (ts.isCallExpression(call) && call.arguments.some((argument) => argument === fn)) {
          const callee = unwrap(call.expression);
          if (ts.isPropertyAccessExpression(callee) && ELEMENT_METHODS.has(callee.name.text)) walk(callee.expression);
          else caseRows(call).forEach(walk);
        }
      } else if (ts.isFunctionDeclaration(node)) {
        returns(node);
      }
    };
    const walk = (node: TsNode): void => {
      if (seen.has(node) || ts.isTypeNode(node)) return;
      seen.add(node);
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        inputs.literals.add(node.text);
      } else if (ts.isNumericLiteral(node)) {
        const negated = ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.MinusToken;
        inputs.literals.add(negated ? `-${node.text}` : node.text);
      } else if (keywords.has(node.kind)) {
        inputs.literals.add(node.getText());
      } else if (ts.isIdentifier(node)) {
        const declaration = resolve(node);
        if (declaration !== undefined) declared(declaration);
      } else if (ts.isPropertyAccessExpression(node)) {
        const target = ts.isIdentifier(node.expression) ? resolve(node.expression) : undefined;
        const namespace =
          target !== undefined && ts.isNamespaceImport(target)
            ? moduleOf(target, target.parent.parent.moduleSpecifier)
            : null;
        const member = namespace === null ? undefined : follow(exportOf(namespace, node.name.text, new Set()));
        if (member !== undefined) declared(member);
        else walk(node.expression);
      } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        if (ts.isComputedPropertyName(node.name)) walk(node.name.expression);
        else inputs.literals.add(node.name.text);
        walk(ts.isPropertyAssignment(node) ? node.initializer : node.name);
      } else if (ts.isFunctionLike(node)) {
        returns(node);
      } else {
        if (ts.isTemplateExpression(node)) inputs.templates.push(templateOf(node));
        ts.forEachChild(node, walk);
      }
    };
    roots.forEach(walk);
    return inputs;
  };

  return (parsed) => {
    if (parsed.titles !== undefined) return parsed.titles;
    const titles: FileTitles = { exact: new Set(), patterns: [], open: [] };
    const openTitle = (runs: Runs, roots: TsNode[]): void => {
      let inputs: CaseInputs | undefined;
      titles.open.push({ runs, inputs: () => (inputs ??= inputsOf(roots)) });
    };
    const addTitle = (written: string, runs: Runs, roots: TsNode[]): void => {
      titles.exact.add(written);
      if (runs.length === 1) return;
      if (hasWord(runs)) titles.patterns.push(runsPattern(runs));
      else openTitle(runs, roots);
    };
    const register = (call: TsCall, argument: TsExpression): void => {
      let title = unwrap(argument);
      const declaration = ts.isIdentifier(title) ? declarationOf(title) : undefined;
      if (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
        declaration.initializer !== undefined
      ) {
        const value = unwrap(declaration.initializer);
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) || ts.isTemplateExpression(value)) {
          title = value;
        }
      }
      if (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) {
        addTitle(title.text, titleRuns(title.text), caseRows(call));
      } else if (ts.isTemplateExpression(title)) {
        const runs = title.templateSpans.reduce<Runs>(
          (acc, span) => [...acc, ...titleRuns(span.literal.text)],
          titleRuns(title.head.text),
        );
        const written = title.getSourceFile().text.slice(title.getStart() + 1, title.end - 1);
        addTitle(written, runs, [...caseRows(call), ...title.templateSpans.map((span) => span.expression)]);
      } else {
        openTitle(['', ''], [...caseRows(call), title]);
      }
    };
    const visit = (node: TsNode): void => {
      if (ts.isCallExpression(node)) {
        const at = titleIndex(node);
        const argument = at === null ? undefined : node.arguments[at];
        if (argument !== undefined) register(node, argument);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed.source);
    parsed.titles = titles;
    return titles;
  };
}

async function readSource(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/** Title universes of cited test files under one checkout; each file is read and parsed once. */
export interface TestTitles {
  /** Universe of `file` (absolute), or null when it is absent. */
  universe(file: string): Promise<TitleUniverse | null>;
}

/** {@link TestTitles} over the checkout at `root`, which `@opt2/platform/<sub>` imports resolve under. */
export function testTitles(root: string): TestTitles {
  const parsed = new Map<string, Promise<ParsedFile | null>>();
  const settled = new Map<string, ParsedFile | null>();
  const universes = new Map<string, Promise<TitleUniverse | null>>();
  let model: Promise<(file: ParsedFile) => FileTitles> | undefined;
  const parse = (file: string): Promise<ParsedFile | null> => {
    let known = parsed.get(file);
    if (known === undefined) {
      known = Promise.all([loadTypescript(), readSource(file)]).then(([ts, text]) => {
        const result = text === null ? null : parseSource(ts, file, text, root);
        settled.set(file, result);
        return result;
      });
      parsed.set(file, known);
    }
    return known;
  };
  const firstPresent = async (candidates: string[]): Promise<ParsedFile | null> => {
    for (const candidate of candidates) {
      const file = await parse(candidate);
      if (file !== null) return file;
    }
    return null;
  };
  const collect = async (file: string): Promise<TitleUniverse | null> => {
    const own = await parse(file);
    if (own === null) return null;
    const seen = new Set([file]);
    const files = [own];
    let frontier = [own];
    while (frontier.length > 0) {
      const found = await Promise.all(frontier.flatMap((index) => index.imports).map(firstPresent));
      frontier = [];
      for (const hit of found) {
        if (hit === null || seen.has(hit.file)) continue;
        seen.add(hit.file);
        files.push(hit);
        frontier.push(hit);
      }
    }
    const classify = await (model ??= loadTypescript().then((ts) => titleModel(ts, settled, root)));
    return { files: files.map(classify) };
  };
  return {
    universe(file) {
      let known = universes.get(file);
      if (known === undefined) {
        known = collect(file);
        universes.set(file, known);
      }
      return known;
    },
  };
}

/** Whether `text` spells `runs` with each placeholder filled by a piece `piece` admits. */
function fillsRuns(text: string, runs: Runs, piece: (part: string) => boolean): boolean {
  const [lead = '', ...rest] = runs;
  if (!text.startsWith(lead) || !rest.every((run) => text.includes(run))) return false;
  const fill = (from: number, separators: Runs): boolean => {
    const [separator = '', ...more] = separators;
    if (more.length === 0) {
      const end = text.length - separator.length;
      return end >= from && text.endsWith(separator) && piece(text.slice(from, end));
    }
    let at = text.indexOf(separator, from);
    while (at !== -1) {
      if (piece(text.slice(from, at)) && fill(at + separator.length, more)) return true;
      at = at < text.length ? text.indexOf(separator, at + 1) : -1;
    }
    return false;
  };
  return fill(lead.length, rest);
}

function memoised(memo: Map<string, boolean>, text: string, verdict: () => boolean): boolean {
  let known = memo.get(text);
  if (known === undefined) {
    known = verdict();
    memo.set(text, known);
  }
  return known;
}

/** Whether `text` is one of `inputs`, or one of its templates filled with inputs, or with plain values beside words. */
function isCaseName(inputs: CaseInputs, text: string): boolean {
  const holds = (template: CaseTemplate, piece: string, phrase: boolean): boolean =>
    piece === '' ||
    NUMBER.test(piece) ||
    inputs.literals.has(piece) ||
    (phrase && PLAIN_VALUE.test(piece)) ||
    template.nested.some((inner) => fillsRuns(piece, inner.runs, (part) => holds(inner, part, phrase || inner.words)));
  const fills = (template: CaseTemplate): boolean =>
    fillsRuns(text, template.runs, (piece) => holds(template, piece, template.words));
  return inputs.literals.has(text) || memoised(inputs.memo, text, () => inputs.templates.some(fills));
}

/** Whether `segment` is a title of `universe`, or fills an open title with case names of that registration's inputs. */
function segmentResolves(universe: TitleUniverse, segment: string): boolean {
  const { files } = universe;
  if (files.some((titles) => titles.exact.has(segment) || titles.patterns.some((re) => re.test(segment)))) return true;
  return files.some((titles) =>
    titles.open.some(({ runs, inputs }) => fillsRuns(segment, runs, (piece) => isCaseName(inputs(), piece))),
  );
}

/** Whether cited `name` resolves whole, or each of its ` › ` segments resolves. */
function nameResolves(universe: TitleUniverse, name: string): boolean {
  if (segmentResolves(universe, name)) return true;
  const segments = name.split(' › ');
  return segments.length > 1 && segments.every((segment) => segmentResolves(universe, segment));
}

/** A cited test name no test title of its cited file admits. */
export type UnresolvedName = { line: number; file: string; name: string };

/** Cited test names of every data row, with those that do not resolve. */
export type CitationCheck = { names: number; unresolved: UnresolvedName[] };

async function checkCitations(
  rows: TraceabilityRow[],
  service: string,
  root: string,
  titles: TestTitles,
): Promise<CitationCheck> {
  const cited = rows.flatMap((row) =>
    row.testNames.filter((citation) => citation.names.length > 0).map((citation) => ({ line: row.line, citation })),
  );
  const universes = await Promise.all(
    cited.map(({ citation }) => titles.universe(refPath(root, service, citation.file))),
  );
  const unresolved: UnresolvedName[] = [];
  cited.forEach(({ line, citation }, i) => {
    const universe = universes[i] ?? null;
    for (const name of citation.names) {
      if (universe === null || !nameResolves(universe, name)) unresolved.push({ line, file: citation.file, name });
    }
  });
  return { names: cited.reduce((sum, { citation }) => sum + citation.names.length, 0), unresolved };
}

async function judgeRow(
  row: TraceabilityRow,
  requireCode: boolean,
  exists: (ref: string) => Promise<boolean>,
  unresolved: UnresolvedName[],
): Promise<RowVerdict> {
  const lacks: RowPart[] = [];
  if (row.sourceRefs.length === 0) lacks.push('source-ref');
  if (requireCode && row.codePaths.length === 0) lacks.push('code-path');
  if (row.testRefs.length === 0) lacks.push('test-ref');
  if (lacks.length > 0) return { ok: false, reason: 'incomplete-row', lacks };
  const [code, tests] = await Promise.all([missingRefs(row.codePaths, exists), missingRefs(row.testRefs, exists)]);
  if (code.length > 0) return { ok: false, reason: 'code-path-missing', paths: [...code, ...tests] };
  const names = unresolved
    .filter((entry) => !tests.includes(entry.file))
    .map((entry) => `${entry.file} › "${entry.name}"`);
  if (tests.length > 0 || names.length > 0) return { ok: false, reason: 'test-missing', paths: [...tests, ...names] };
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
 * ref, all on disk, with every cited name resolved; else the first complete row's misses, else its absent parts.
 */
async function judgeItem(
  item: ReviewItem,
  rows: TraceabilityRow[],
  index: Map<string, number[]>,
  exists: (ref: string) => Promise<boolean>,
  unresolvedAt: Map<number, UnresolvedName[]>,
): Promise<MissingItem | null> {
  const base: MissingItem = { id: item.id, reason: 'no-row' };
  if (item.routeKey !== undefined) base.routeKey = item.routeKey;
  let incomplete: MissingItem | undefined;
  let unresolved: MissingItem | undefined;
  for (const row of coveringRows(item, rows, index)) {
    const verdict = await judgeRow(row, item.codeRequired, exists, unresolvedAt.get(row.line) ?? []);
    if (verdict.ok) return null;
    const missing: MissingItem = { ...base, reason: verdict.reason, line: row.line };
    if (verdict.lacks !== undefined) missing.lacks = verdict.lacks;
    if (verdict.paths !== undefined) missing.paths = verdict.paths;
    if (verdict.reason === 'incomplete-row') incomplete ??= missing;
    else unresolved ??= missing;
  }
  return unresolved ?? incomplete ?? base;
}

/** Checks one service's README, TRACEABILITY and contracts for the pinned SHA, its coverage and its cited names. */
export async function checkService(
  service: string,
  deps: CheckDeps,
  titles: TestTitles = testTitles(deps.root),
): Promise<ServiceReport> {
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
  const citations = await checkCitations(rows, service, deps.root, titles);
  const unresolvedAt = new Map<number, UnresolvedName[]>();
  for (const entry of citations.unresolved) {
    unresolvedAt.set(entry.line, [...(unresolvedAt.get(entry.line) ?? []), entry]);
  }
  const items = carriedOrOwnedItems(service, deps.inventory, deps.ownership);
  const verdicts = await Promise.all(items.map((item) => judgeItem(item, rows, index, exists, unresolvedAt)));
  const missing = verdicts.filter((verdict): verdict is MissingItem => verdict !== null);

  const files = [readme.record, traceability.record, openapi.record, ...events.map((event) => event.record)];
  const filesOk = files.every((record) => fileOk(record, deps.sha));
  const result = filesOk && missing.length === 0 && citations.unresolved.length === 0 ? 'pass' : 'fail';
  return {
    service,
    readme: readme.record,
    traceability: { ...traceability.record, rows: traceability.content === null ? null : rows.length },
    contracts: { openapi: openapi.record, events: events.map((event) => event.record) },
    inventoryItems: { carriedOrOwned: items.length, covered: items.length - missing.length, missing },
    citations,
    result,
  };
}

/** Report of `services` checked against `deps`, stamped `generatedAt` by `clock`. */
export async function buildReport(
  services: readonly string[],
  deps: CheckDeps,
  clock: () => Date = () => new Date(),
): Promise<ReviewabilityReport> {
  const titles = testTitles(deps.root);
  const reports = await Promise.all(services.map((service) => checkService(service, deps, titles)));
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

function unresolvedLine(entry: UnresolvedName): string {
  return `- line ${entry.line}: \`${entry.file}\` › "${entry.name}"`;
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
  if (withMissing.length === 0) lines.push('None.', '');
  for (const service of withMissing) {
    lines.push(`### ${service.service}`, '', ...service.inventoryItems.missing.map(missingLine), '');
  }
  lines.push('## Unresolved test names', '');
  const withUnresolved = report.services.filter((service) => service.citations.unresolved.length > 0);
  if (withUnresolved.length === 0) lines.push('None.');
  for (const service of withUnresolved) {
    lines.push(`### ${service.service}`, '', ...service.citations.unresolved.map(unresolvedLine), '');
  }
  return lines;
}

const USAGE = 'check-reviewability [--root <dir>] [--service <name>]... [--no-write]';
const HELP = `${USAGE} [--help]

Checks that each service carries README.md, TRACEABILITY.md and contracts/openapi.yaml with the pinned SHA (and every
contracts/events/*.json it has), and that its TRACEABILITY.md has a row for every inventory item it carries or owns:
the item's inventory id, route key or table, a legacy source (path:lines or a legacy-fixtures/ path), a code path
(carried items) and a test file or GS id, each referenced file present. On every row, each quoted test name cited
after a test file (\`file\` › "name", "name") must be a test title of that file or of a file it imports: the title of an
it, test, describe, suite or bench call (through .each, .skip and the other modifiers, a name bound to one, or a helper
passing its parameter on as the title), one of its %s, $name or \${...} templates filled in with case names drawn from
that registration's own .each/.for rows or loop, or a "parent › child" path of them.

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
