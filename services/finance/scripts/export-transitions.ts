// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  compareTableRows,
  generateTable,
  serializeTable,
  writeTableJson,
  type TransitionTableRow,
} from '@opt2/platform/state-machine';
import { financeLifecycle } from '../src/domain/lifecycle.transitions.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TABLE_PATH = fileURLToPath(new URL('../test/generated/transition-table.json', import.meta.url));
const EXPORT_PATH = fileURLToPath(new URL('../../../opt2/reports/state-machines/finance.json', import.meta.url));
const PIN_PATH = fileURLToPath(new URL('../../../opt2/source-pin.json', import.meta.url));

const GENERATED_BY = 'services/finance/scripts/export-transitions.ts';
const AGGREGATE = 'finance_record';
const USAGE = 'usage: export-transitions [--check]';
const REGENERATE_HINT = 'run: npm run export-transitions';
const MAX_DIFF_ENTRIES = 10;
// Per-run stamps: a regenerated export and the committed planning copy differ only here.
const RUN_METADATA_KEYS: ReadonlySet<string> = new Set(['generatedAt', 'provenance']);

type Mode = 'write' | 'check';

/** One row of the fixture-oracle export, as `synthetic.usp_load_transitions` reads it. */
interface ExportRow {
  from: string;
  action: string;
  role: string;
  outcome: 'legal' | 'illegal-state' | 'wrong-role';
  status: '2xx' | '409' | '403';
  to: string | null;
  newVersion?: true;
  error?: string;
}

/** The fixture-oracle export document written to `opt2/reports/state-machines/finance.json`. */
interface FinanceExport {
  sourceSha: string;
  generatedBy: string;
  generatedAt: string;
  provenance: 'generated';
  service: string;
  aggregate: string;
  states: string[];
  terminal: string[];
  roles: string[];
  actions: string[];
  rows: ExportRow[];
}

/** Returns the run mode, or null when the arguments are not exactly none or `--check`. */
function parseArgs(argv: readonly string[]): Mode | null {
  if (argv.length === 0) return 'write';
  if (argv.length === 1 && argv[0] === '--check') return 'check';
  return null;
}

/** True for a non-null, non-array JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the pinned source SHA from `opt2/source-pin.json`. */
async function readSourceSha(): Promise<string> {
  const pin: unknown = JSON.parse(await readFile(PIN_PATH, 'utf8'));
  const sha = isRecord(pin) ? pin['sha'] : undefined;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${PIN_PATH}: "sha" is missing or is not a 40-character lowercase hex commit id`);
  }
  return sha;
}

/** Export outcome and status string for a generated row's HTTP status. */
function classify(expectedStatus: TransitionTableRow['expectedStatus']): Pick<ExportRow, 'outcome' | 'status'> {
  switch (expectedStatus) {
    case 200:
      return { outcome: 'legal', status: '2xx' };
    case 409:
      return { outcome: 'illegal-state', status: '409' };
    case 403:
      return { outcome: 'wrong-role', status: '403' };
    default:
      throw new Error(`unexpected expectedStatus ${String(expectedStatus satisfies never)}`);
  }
}

/** Maps one generated table row to its export form, keys in loader order. */
function toExportRow(row: TransitionTableRow): ExportRow {
  if (row.guard !== null) {
    throw new Error(`${row.from}/${row.action}/${row.role}: guard '${row.guard}' has no finance export form`);
  }
  const { outcome, status } = classify(row.expectedStatus);
  return {
    from: row.from,
    action: row.action,
    role: row.role,
    outcome,
    status,
    to: row.to,
    ...(row.newVersion ? { newVersion: true as const } : {}),
    ...(row.errorCode === null ? {} : { error: row.errorCode }),
  };
}

/** Assembles the export document; `ordered` must already be in table order. */
function buildExport(sourceSha: string, ordered: readonly TransitionTableRow[], generatedAt: string): FinanceExport {
  if (financeLifecycle.service !== 'finance') {
    throw new Error(`financeLifecycle.service is '${financeLifecycle.service}', expected 'finance'`);
  }
  return {
    sourceSha,
    generatedBy: GENERATED_BY,
    generatedAt,
    provenance: 'generated',
    service: financeLifecycle.service,
    aggregate: AGGREGATE,
    states: [...financeLifecycle.states],
    terminal: [...financeLifecycle.terminal],
    roles: [...financeLifecycle.roles],
    actions: [...financeLifecycle.actions],
    rows: ordered.map(toExportRow),
  };
}

/** One-line JSON of a value, or `(absent)` for a missing one. */
function oneLine(value: unknown): string {
  return value === undefined ? '(absent)' : JSON.stringify(value);
}

/**
 * Lists the differences between an expected and a committed JSON document: up to ten differing entries
 * (top-level keys, or row indices of a bare array or of `rows`), then a row-count line when the counts differ.
 */
function diffJson(expected: unknown, committed: unknown): string[] {
  const entries: string[] = [];
  const counts: string[] = [];
  const note = (label: string, want: unknown, have: unknown): void => {
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      entries.push(`${label}: expected ${oneLine(want)}, committed ${oneLine(have)}`);
    }
  };
  const compareRows = (label: string, want: readonly unknown[], have: readonly unknown[]): void => {
    if (want.length !== have.length) counts.push(`${label}: expected ${want.length} rows, committed ${have.length}`);
    for (let index = 0; index < Math.max(want.length, have.length); index += 1) {
      note(`${label}[${index}]`, want[index], have[index]);
    }
  };

  if (Array.isArray(expected) && Array.isArray(committed)) {
    compareRows('rows', expected, committed);
  } else if (isRecord(expected) && isRecord(committed)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(committed)])) {
      const want = expected[key];
      const have = committed[key];
      if (key === 'rows' && Array.isArray(want) && Array.isArray(have)) compareRows(key, want, have);
      else note(key, want, have);
    }
    if (entries.length === 0 && counts.length === 0) note('(key order)', Object.keys(expected), Object.keys(committed));
  } else {
    note('(document)', expected, committed);
  }
  return [...entries.slice(0, MAX_DIFF_ENTRIES), ...counts];
}

/** Copy of a JSON object without the per-run metadata keys, key order kept. */
function withoutRunMetadata(value: unknown): unknown {
  return isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !RUN_METADATA_KEYS.has(key)))
    : value;
}

/** Path relative to the repository root, for messages. */
function displayPath(path: string): string {
  return relative(REPO_ROOT, path);
}

/** Reads a committed file, or returns null when it does not exist. */
async function readCommitted(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Stderr report for one committed file compared after `normalise`; empty when it matches `expected`. */
async function driftReport(path: string, expected: unknown, normalise: (value: unknown) => unknown): Promise<string[]> {
  const text = await readCommitted(path);
  if (text === null) return [`${displayPath(path)}: missing`, `  ${REGENERATE_HINT}`];
  const committed = normalise(JSON.parse(text));
  if (JSON.stringify(committed) === JSON.stringify(expected)) return [];
  return [
    `${displayPath(path)}: drift`,
    ...diffJson(expected, committed).map((line) => `  ${line}`),
    `  ${REGENERATE_HINT}`,
  ];
}

/** Writes or checks the test table and the fixture export; returns the process exit code. */
async function main(argv: readonly string[]): Promise<number> {
  const mode = parseArgs(argv);
  if (mode === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const rows = generateTable(financeLifecycle);
  const tableText = serializeTable(rows);
  const exportDoc = buildExport(await readSourceSha(), [...rows].sort(compareTableRows), new Date().toISOString());

  if (mode === 'write') {
    await mkdir(dirname(TABLE_PATH), { recursive: true });
    await mkdir(dirname(EXPORT_PATH), { recursive: true });
    await writeTableJson(rows, TABLE_PATH);
    await writeFile(EXPORT_PATH, `${JSON.stringify(exportDoc, null, 2)}\n`, 'utf8');
    process.stdout.write(`${displayPath(TABLE_PATH)}: ${rows.length} rows\n`);
    process.stdout.write(`${displayPath(EXPORT_PATH)}: ${exportDoc.rows.length} rows\n`);
    return 0;
  }

  const reports = [
    ...(await driftReport(TABLE_PATH, JSON.parse(tableText), (value) => value)),
    ...(await driftReport(EXPORT_PATH, withoutRunMetadata(exportDoc), withoutRunMetadata)),
  ];
  if (reports.length > 0) {
    process.stderr.write(`${reports.join('\n')}\n`);
    return 1;
  }
  process.stdout.write('transition tables up to date\n');
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
