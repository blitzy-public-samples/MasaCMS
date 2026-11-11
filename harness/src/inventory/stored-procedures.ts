// Stored-procedure check of the legacy inventory: static DDL scan at the pin plus live SQL Server catalog listing.
import type { ReadOnlyMssql } from '../lib/mssql.js';
import { stripComments, type SourceTree } from './closure.js';

/** Bootstrap DDL scanned by the static check. */
export const BOOTSTRAP_DDL = 'core/setup/db/mssql.sql';

/** Folder of the schema-update templates; it also holds `Application.cfc`, which is not scanned. */
export const DB_UPDATES_DIR = 'core/mura/dbUpdates';

/** Glob of the scanned schema-update templates, as reported. */
export const DB_UPDATES_GLOB = `${DB_UPDATES_DIR}/*.cfm`;

/** Number of `core/mura/dbUpdates/*.cfm` files at the pinned SHA. */
export const EXPECTED_DB_UPDATE_FILES = 37;

/** Statement forms the static check looks for. */
export const STATIC_PATTERNS = ['CREATE PROCEDURE', 'CREATE PROC', 'CREATE FUNCTION', 'CREATE TRIGGER'] as const;

/** `sys.objects` types counted as functions. */
export const FUNCTION_TYPES = ['FN', 'IF', 'TF'] as const;

/**
 * Schemas the live check leaves out: the legacy fixtures' own objects. `opt2_sync` is deliberately not
 * excluded; it holds only the projector checkpoint table, so any routine found there is reported.
 */
export const EXCLUDED_SCHEMAS = ['synthetic', 'Program_*'] as const;

/** Object count the assumption "Masa has no stored procedures" predicts. */
export const EXPECTED_OBJECTS = 0;

/** Source of the current time, injectable for deterministic `checkedAt` values. */
export type Clock = () => Date;

/** Object class a static match or live object belongs to. */
export type ObjectKind = 'procedure' | 'function' | 'trigger';

/** Live object class; database-level triggers have no schema. */
export type LiveObjectKind = ObjectKind | 'database-trigger';

/** One `CREATE … PROCEDURE|PROC|FUNCTION|TRIGGER` statement outside comments. */
export interface StaticMatch {
  path: string;
  line: number;
  kind: ObjectKind;
  /** Schema part of the created object's name, or null when the name has one part or none was parsed. */
  schema: string | null;
  /** Created object's name without quoting, or null when no identifier follows the keyword. */
  name: string | null;
  /** Trimmed source line holding the keyword. */
  text: string;
}

/** Result of `staticCheck`. */
export interface StaticCheck {
  files: string[];
  scanned: number;
  matches: StaticMatch[];
  count: number;
}

/** One `FOREIGN KEY` or `REFERENCES` clause outside comments. */
export interface ForeignKeyMatch {
  path: string;
  line: number;
  clause: 'FOREIGN KEY' | 'REFERENCES';
  text: string;
}

/** Result of `foreignKeyCheck`: declared foreign keys in the same files. */
export interface ForeignKeyCheck {
  static: number;
  matches: ForeignKeyMatch[];
}

/** One routine or trigger found in the live catalog. */
export interface LiveObject {
  schema: string | null;
  name: string;
  kind: LiveObjectKind;
  /** `sys.objects.type`, trimmed (e.g. `P`, `TR`, `FN`). */
  objectType: string;
}

/** Result of `liveCheck`. */
export interface LiveCheck {
  procedures: number;
  triggers: number;
  databaseTriggers: number;
  functions: number;
  total: number;
  excludedSchemas: string[];
  /** False when the caller reports fixtures loaded or a fixture schema already exists. */
  takenBeforeFixtures: boolean;
  checkedAt: string;
  objects: LiveObject[];
}

/** Named object behind a non-zero count, for inventorying a refuted assumption. */
export interface Finding {
  name: string | null;
  schema: string | null;
  kind: LiveObjectKind;
  origin: 'static' | 'live';
  /** Static matches only. */
  source: { path: string; line: number } | null;
}

/** `refuted` when any object was found; `pending-run` when the static scan is clean and no live check ran. */
export type CheckResult = 'confirmed' | 'refuted' | 'pending-run';

/** Combined result recorded as the inventory's `storedProcedureCheck`. */
export interface StoredProcedureCheck {
  static: StaticCheck;
  /** Scanned over the same files because the inventory records the no-foreign-key evidence beside this check. */
  foreignKeys: ForeignKeyCheck;
  live: LiveCheck | null;
  liveStatus: 'live' | 'pending-run';
  expected: typeof EXPECTED_OBJECTS;
  result: CheckResult;
  findings: Finding[];
}

/** Options of the static scans. */
export interface StaticCheckOptions {
  /** Required number of `*.cfm` schema updates; null skips the assertion (miniature test trees). Default 37. */
  expectedDbUpdates?: number | null;
}

/** Options of `liveCheck`. */
export interface LiveCheckOptions {
  fixturesLoaded?: boolean;
  clock?: Clock;
}

/** Options of `storedProcedureCheck`; without `db` the live part is `pending-run`. */
export interface StoredProcedureCheckOptions extends StaticCheckOptions, LiveCheckOptions {
  db?: ReadOnlyMssql;
}

interface ScanText {
  path: string;
  original: string;
  code: string;
}

const OBJECT_DDL = /\bCREATE\s+(?:OR\s+ALTER\s+)?(PROCEDURE|PROC|FUNCTION|TRIGGER)\b/gi;
const FOREIGN_KEY_DDL = /\b(?:(FOREIGN\s+KEY)|REFERENCES)\b/gi;
const IDENT = String.raw`(?:\[(?:[^\]]|\]\])+\]|"(?:[^"]|"")+"|[A-Za-z_@#][\w@#$]*)`;
const OBJECT_NAME = new RegExp(String.raw`\s+(${IDENT}(?:\s*\.\s*${IDENT}){0,2})`, 'y');
const NAME_PART = new RegExp(IDENT, 'g');

function skipDelimited(text: string, at: number, close: string): number {
  let j = at + 1;
  while (j < text.length) {
    if (text.charAt(j) === close) {
      if (text.charAt(j + 1) !== close) return j + 1;
      j += 2;
      continue;
    }
    j++;
  }
  return text.length;
}

function endOfBlockComment(text: string, at: number): number {
  let depth = 0;
  let j = at;
  while (j < text.length) {
    if (text.startsWith('/*', j)) {
      depth++;
      j += 2;
    } else if (text.startsWith('*/', j)) {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else {
      j++;
    }
  }
  return text.length;
}

/**
 * Blanks T-SQL `--` and nested `/* … *\/` comments with spaces, keeping newlines and offsets.
 * String literals and `[…]`/`"…"` identifiers are skipped, so comment markers inside them stay.
 */
export function stripSqlComments(sql: string): string {
  const parts: string[] = [];
  let last = 0;
  let i = 0;
  const blank = (from: number, to: number): void => {
    parts.push(sql.slice(last, from), sql.slice(from, to).replace(/[^\r\n]/g, ' '));
    last = to;
  };
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (c === "'" || c === '"' || c === '[') {
      i = skipDelimited(sql, i, c === '[' ? ']' : c);
    } else if (c === '-' && sql.charAt(i + 1) === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol < 0 ? sql.length : eol;
      blank(i, end);
      i = end;
    } else if (c === '/' && sql.charAt(i + 1) === '*') {
      const end = endOfBlockComment(sql, i);
      blank(i, end);
      i = end;
    } else {
      i++;
    }
  }
  parts.push(sql.slice(last));
  return parts.join('');
}

function unquoteIdent(part: string): string {
  if (part.startsWith('[')) return part.slice(1, -1).replace(/\]\]/g, ']');
  if (part.startsWith('"')) return part.slice(1, -1).replace(/""/g, '"');
  return part;
}

function objectName(code: string, from: number): { schema: string | null; name: string | null } {
  OBJECT_NAME.lastIndex = from;
  const qualified = OBJECT_NAME.exec(code)?.[1];
  if (qualified === undefined) return { schema: null, name: null };
  const parts = [...qualified.matchAll(NAME_PART)].map((m) => unquoteIdent(m[0]));
  return { schema: parts.length > 1 ? (parts[parts.length - 2] ?? null) : null, name: parts[parts.length - 1] ?? null };
}

function lineText(text: string, line: number): string {
  return (text.split('\n')[line - 1] ?? '').trim();
}

function kindOf(keyword: string): ObjectKind {
  const upper = keyword.toUpperCase();
  return upper === 'FUNCTION' ? 'function' : upper === 'TRIGGER' ? 'trigger' : 'procedure';
}

/** Comment-stripped texts of the bootstrap DDL and the sorted schema updates; throws on an unexpected update count. */
function scanTexts(tree: SourceTree, opts: StaticCheckOptions): ScanText[] {
  const expected = opts.expectedDbUpdates === undefined ? EXPECTED_DB_UPDATE_FILES : opts.expectedDbUpdates;
  const updates = tree.list(DB_UPDATES_DIR, { ext: ['.cfm'] });
  if (expected !== null && updates.length !== expected) {
    throw new Error(`expected ${expected} ${DB_UPDATES_GLOB} files, found ${updates.length}`);
  }
  const bootstrap = tree.readText(BOOTSTRAP_DDL);
  return [
    { path: BOOTSTRAP_DDL, original: bootstrap, code: stripSqlComments(bootstrap) },
    ...updates.map((path) => {
      const original = tree.readText(path);
      return { path, original, code: stripComments(original) };
    }),
  ];
}

function scanObjects(tree: SourceTree, texts: readonly ScanText[]): StaticCheck {
  const matches: StaticMatch[] = [];
  for (const { path, original, code } of texts) {
    for (const m of code.matchAll(OBJECT_DDL)) {
      const line = tree.lineOf(code, m.index);
      const keyword = m[1] ?? '';
      matches.push({
        path,
        line,
        kind: kindOf(keyword),
        ...objectName(code, m.index + m[0].length),
        text: lineText(original, line),
      });
    }
  }
  return { files: texts.map((t) => t.path), scanned: texts.length, matches, count: matches.length };
}

function scanForeignKeys(tree: SourceTree, texts: readonly ScanText[]): ForeignKeyCheck {
  const matches: ForeignKeyMatch[] = [];
  for (const { path, original, code } of texts) {
    for (const m of code.matchAll(FOREIGN_KEY_DDL)) {
      const line = tree.lineOf(code, m.index);
      matches.push({ path, line, clause: m[1] === undefined ? 'REFERENCES' : 'FOREIGN KEY', text: lineText(original, line) });
    }
  }
  return { static: matches.length, matches };
}

/**
 * Scans `core/setup/db/mssql.sql` (SQL comments stripped) and every `core/mura/dbUpdates/*.cfm` (CFML comments
 * stripped) for routine and trigger creation; throws when the update count differs from `expectedDbUpdates`.
 */
export function staticCheck(tree: SourceTree, opts: StaticCheckOptions = {}): StaticCheck {
  return scanObjects(tree, scanTexts(tree, opts));
}

/** Counts `FOREIGN KEY` and `REFERENCES` clauses in the files `staticCheck` scans. */
export function foreignKeyCheck(tree: SourceTree, opts: StaticCheckOptions = {}): ForeignKeyCheck {
  return scanForeignKeys(tree, scanTexts(tree, opts));
}

type LiveCategory = 'procedures' | 'triggers' | 'databaseTriggers' | 'functions';

interface CatalogRow {
  schemaName: string | null;
  name: string;
  objectType: string;
}

const SCHEMA_FILTER = "s.name <> 'synthetic' AND s.name NOT LIKE 'Program[_]%'";
const FUNCTION_TYPE_LIST = FUNCTION_TYPES.map((t) => `'${t}'`).join(', ');

// Each category lists its rows rather than COUNT(*), so one statement yields both the count and the findings' names.
const LIVE_QUERIES: Readonly<Record<LiveCategory, string>> = {
  procedures:
    'SELECT s.name AS schemaName, p.name AS name, p.type AS objectType FROM sys.procedures p ' +
    `JOIN sys.schemas s ON s.schema_id = p.schema_id WHERE ${SCHEMA_FILTER} ORDER BY s.name, p.name`,
  triggers:
    'SELECT s.name AS schemaName, t.name AS name, t.type AS objectType FROM sys.triggers t ' +
    'JOIN sys.objects o ON o.object_id = t.parent_id JOIN sys.schemas s ON s.schema_id = o.schema_id ' +
    `WHERE t.parent_class = 1 AND ${SCHEMA_FILTER} ORDER BY s.name, t.name`,
  databaseTriggers:
    'SELECT NULL AS schemaName, t.name AS name, t.type AS objectType FROM sys.triggers t ' +
    'WHERE t.parent_class = 0 ORDER BY t.name',
  functions:
    'SELECT s.name AS schemaName, o.name AS name, o.type AS objectType FROM sys.objects o ' +
    `JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN (${FUNCTION_TYPE_LIST}) AND ${SCHEMA_FILTER} ` +
    'ORDER BY s.name, o.name',
};

const LIVE_KINDS: Readonly<Record<LiveCategory, LiveObjectKind>> = {
  procedures: 'procedure',
  triggers: 'trigger',
  databaseTriggers: 'database-trigger',
  functions: 'function',
};

const FIXTURE_SCHEMAS_QUERY =
  "SELECT s.name AS name FROM sys.schemas s WHERE s.name = 'synthetic' OR s.name LIKE 'Program[_]%'";

/** Statements `liveCheck` sends, in order: one per category, then the fixture-schema probe. */
export const LIVE_CHECK_SQL: readonly string[] = [
  LIVE_QUERIES.procedures,
  LIVE_QUERIES.triggers,
  LIVE_QUERIES.databaseTriggers,
  LIVE_QUERIES.functions,
  FIXTURE_SCHEMAS_QUERY,
];

/**
 * Lists procedures, table triggers, database triggers and `FN`/`IF`/`TF` functions outside the fixture schemas
 * through `readOnlyQuery`. `takenBeforeFixtures` is false when `fixturesLoaded` is set or a fixture schema exists.
 */
export async function liveCheck(db: ReadOnlyMssql, opts: LiveCheckOptions = {}): Promise<LiveCheck> {
  const clock = opts.clock ?? (() => new Date());
  const counts: Record<LiveCategory, number> = { procedures: 0, triggers: 0, databaseTriggers: 0, functions: 0 };
  const objects: LiveObject[] = [];
  for (const category of Object.keys(LIVE_QUERIES) as LiveCategory[]) {
    const rows = await db.readOnlyQuery<CatalogRow>(LIVE_QUERIES[category]);
    counts[category] = rows.length;
    for (const row of rows) {
      objects.push({
        schema: row.schemaName ?? null,
        name: row.name,
        kind: LIVE_KINDS[category],
        objectType: row.objectType.trim(),
      });
    }
  }
  const fixtureSchemas = await db.readOnlyQuery<{ name: string }>(FIXTURE_SCHEMAS_QUERY);
  const fixturesLoaded = opts.fixturesLoaded === true || fixtureSchemas.length > 0;
  return {
    ...counts,
    total: counts.procedures + counts.triggers + counts.databaseTriggers + counts.functions,
    excludedSchemas: [...EXCLUDED_SCHEMAS],
    takenBeforeFixtures: !fixturesLoaded,
    checkedAt: clock().toISOString(),
    objects,
  };
}

function checkResult(staticCount: number, live: LiveCheck | null): CheckResult {
  if (staticCount > 0 || (live !== null && live.total > 0)) return 'refuted';
  return live === null ? 'pending-run' : 'confirmed';
}

/** Static scan, foreign-key scan and, when `db` is given, the live catalog check, with a verdict and findings. */
export async function storedProcedureCheck(
  tree: SourceTree,
  opts: StoredProcedureCheckOptions = {},
): Promise<StoredProcedureCheck> {
  const texts = scanTexts(tree, opts);
  const scan = scanObjects(tree, texts);
  const live = opts.db === undefined ? null : await liveCheck(opts.db, opts);
  const findings: Finding[] = [
    ...scan.matches.map((m): Finding => ({
      name: m.name,
      schema: m.schema,
      kind: m.kind,
      origin: 'static',
      source: { path: m.path, line: m.line },
    })),
    ...(live?.objects ?? []).map((o): Finding => ({
      name: o.name,
      schema: o.schema,
      kind: o.kind,
      origin: 'live',
      source: null,
    })),
  ];
  return {
    static: scan,
    foreignKeys: scanForeignKeys(tree, texts),
    live,
    liveStatus: live === null ? 'pending-run' : 'live',
    expected: EXPECTED_OBJECTS,
    result: checkResult(scan.count, live),
    findings,
  };
}

