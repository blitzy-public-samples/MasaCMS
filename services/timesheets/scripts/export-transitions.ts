// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { generateTable, serializeTable, writeTableJson, type TransitionTableRow } from '@opt2/platform/state-machine';
import { timesheetsLifecycle } from '../src/domain/lifecycle.transitions.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PIN_PATH = fileURLToPath(new URL('../../../opt2/source-pin.json', import.meta.url));
const TABLE_PATH = fileURLToPath(new URL('../test/generated/transition-table.json', import.meta.url));
const REPORT_PATH = fileURLToPath(new URL('../../../opt2/reports/state-machines/timesheets.json', import.meta.url));

const GENERATED_BY = 'services/timesheets/scripts/export-transitions.ts';
const AGGREGATE = 'timesheet_day';
const BLACKOUT_GUARD = 'blackout';
// The committed planning report's value; an existing report's `blackout.appliesTo` always takes precedence.
const DEFAULT_BLACKOUT_APPLIES_TO = 'any action on a blackout day';
const USAGE = 'usage: tsx scripts/export-transitions.ts [--check]';
const REGENERATE_HINT = 'run: npm run export-transitions';

type Mode = 'write' | 'check';

/** Report outcome and status string of one generated HTTP status. */
interface Outcome {
  outcome: 'legal' | 'illegal-state' | 'wrong-role';
  status: '2xx' | '409' | '403';
}

const OUTCOMES: Readonly<Record<TransitionTableRow['expectedStatus'], Outcome>> = {
  200: { outcome: 'legal', status: '2xx' },
  409: { outcome: 'illegal-state', status: '409' },
  403: { outcome: 'wrong-role', status: '403' },
};

/** One unguarded row of the fixture-oracle report, as `synthetic.usp_load_transitions` reads it. */
interface ReportRow extends Outcome {
  from: string;
  action: string;
  role: string;
  to: string | null;
  error?: string;
}

/** The single rule that replaces every guard row: any action on a blackout day is illegal. */
interface BlackoutBlock extends Outcome {
  appliesTo: string;
  error: string;
}

/** Values of the report that vary per run or are owned by the committed file. */
interface ReportMeta {
  generatedAt: string | null;
  provenance: string;
  appliesTo: string;
}

/** The fixture-oracle report written to `opt2/reports/state-machines/timesheets.json`. */
interface TimesheetsReport {
  sourceSha: string;
  generatedBy: string;
  generatedAt: string | null;
  provenance: string;
  service: string;
  aggregate: string;
  states: string[];
  terminal: string[];
  roles: string[];
  actions: string[];
  blackout: BlackoutBlock;
  rows: ReportRow[];
}

/** Per-run fields a committed report may carry; everything else is regenerated. */
interface CommittedMeta {
  generatedAt?: string | null;
  provenance?: string;
  blackout?: { appliesTo?: string };
}

/** Everything one `generateTable` call yields: the full test table plus the report's rows and blackout rule. */
interface Generated {
  table: TransitionTableRow[];
  rows: ReportRow[];
  blackout: Omit<BlackoutBlock, 'appliesTo'>;
}

/** Returns the run mode, or null when the arguments are not exactly none or `--check`. */
function parseArgs(argv: readonly string[]): Mode | null {
  if (argv.length === 0) return 'write';
  if (argv.length === 1 && argv[0] === '--check') return 'check';
  return null;
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

/** Reads the pinned source SHA from `opt2/source-pin.json`. */
async function readSourceSha(): Promise<string> {
  const pin = JSON.parse(await readFile(PIN_PATH, 'utf8')) as { sha: string };
  return pin.sha;
}

/** Maps one unguarded table row to its report form, keys in loader order. */
function toReportRow(r: TransitionTableRow): ReportRow {
  return {
    from: r.from,
    action: r.action,
    role: r.role,
    ...OUTCOMES[r.expectedStatus],
    to: r.to,
    ...(r.errorCode === null ? {} : { error: r.errorCode }),
  };
}

/** Generates the lifecycle table once and collapses its guard rows; throws when the collapse would lose a row. */
function generate(): Generated {
  const table = generateTable(timesheetsLifecycle);
  const unguarded = table.filter((r) => r.guard === null);
  const guarded = table.filter((r) => r.guard !== null);
  const { states, actions, roles } = timesheetsLifecycle;
  const combinations = states.length * actions.length * roles.length;
  const [first] = guarded;
  const collapsible =
    guarded.length === unguarded.length &&
    unguarded.length === combinations &&
    guarded.every((r) => r.guard === BLACKOUT_GUARD && r.expectedStatus === 409 && r.errorCode === BLACKOUT_GUARD);
  if (!collapsible || typeof first?.errorCode !== 'string') {
    const counts = `${guarded.length} guard rows, ${unguarded.length} unguarded rows, ${combinations} combinations`;
    throw new Error(`guard rows do not collapse into one '${BLACKOUT_GUARD}' rule: ${counts}`);
  }
  return {
    table,
    // Generator order (states, then actions, then roles in definition order), not the test table's sorted order.
    rows: unguarded.map(toReportRow),
    blackout: { ...OUTCOMES[first.expectedStatus], error: first.errorCode },
  };
}

/** Run metadata of a committed report text, or of no report, with defaults for keys it lacks. */
function committedMeta(text: string | null): ReportMeta {
  const committed: CommittedMeta = text === null ? {} : (JSON.parse(text) as CommittedMeta);
  return {
    generatedAt: committed.generatedAt ?? null,
    provenance: committed.provenance ?? 'generated',
    appliesTo: committed.blackout?.appliesTo ?? DEFAULT_BLACKOUT_APPLIES_TO,
  };
}

/** Renders the report as two-space JSON with a trailing newline. */
function renderReport(sourceSha: string, generated: Generated, meta: ReportMeta): string {
  const report: TimesheetsReport = {
    sourceSha,
    generatedBy: GENERATED_BY,
    generatedAt: meta.generatedAt,
    provenance: meta.provenance,
    service: timesheetsLifecycle.service,
    aggregate: AGGREGATE,
    states: [...timesheetsLifecycle.states],
    terminal: [...timesheetsLifecycle.terminal],
    roles: [...timesheetsLifecycle.roles],
    actions: [...timesheetsLifecycle.actions],
    blackout: { appliesTo: meta.appliesTo, ...generated.blackout },
    rows: generated.rows,
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Writes or checks the test table and the fixture-oracle report; returns the process exit code. */
async function main(argv: readonly string[]): Promise<number> {
  const mode = parseArgs(argv);
  if (mode === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const generated = generate();
  const sourceSha = await readSourceSha();
  const existing = await readCommitted(REPORT_PATH);
  const meta = committedMeta(existing);
  const expectedWithExistingMeta = renderReport(sourceSha, generated, meta);

  if (mode === 'check') {
    const drifted: string[] = [];
    const tableText = await readCommitted(TABLE_PATH);
    if (tableText !== serializeTable(generated.table)) {
      drifted.push(`${displayPath(TABLE_PATH)}: ${tableText === null ? 'missing' : 'drift'}`);
    }
    if (existing !== expectedWithExistingMeta) {
      drifted.push(`${displayPath(REPORT_PATH)}: ${existing === null ? 'missing' : 'drift'}`);
    }
    if (drifted.length > 0) {
      process.stderr.write(`${[...drifted, `  ${REGENERATE_HINT}`].join('\n')}\n`);
      return 1;
    }
    process.stdout.write('clean\n');
    return 0;
  }

  await mkdir(dirname(TABLE_PATH), { recursive: true });
  await writeTableJson(generated.table, TABLE_PATH);
  process.stdout.write(`wrote: ${displayPath(TABLE_PATH)} (${generated.table.length} rows)\n`);

  if (existing === expectedWithExistingMeta && meta.provenance === 'generated') {
    process.stdout.write(`unchanged: ${displayPath(REPORT_PATH)}\n`);
    return 0;
  }
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  const stamped = { generatedAt: new Date().toISOString(), provenance: 'generated', appliesTo: meta.appliesTo };
  await writeFile(REPORT_PATH, renderReport(sourceSha, generated, stamped), 'utf8');
  const legal = generated.rows.filter((r) => r.outcome === 'legal').length;
  process.stdout.write(`wrote: ${displayPath(REPORT_PATH)} (${generated.rows.length} rows, ${legal} legal)\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
