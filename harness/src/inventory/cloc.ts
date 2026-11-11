// cloc size report of the pinned legacy source, measured on a `git archive` extraction outside the checkout.
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from '@opt2/platform/service-kit';

import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { defaultRunner, gitArchiveExtract } from '../lib/git.js';
import { assertOutsideRepo, opt2Path, repoPath } from '../lib/paths.js';
import { readPin, type Pin } from '../lib/pin.js';
import { writeJsonReport, writeMarkdown } from '../lib/report.js';

/** cloc release the planning figures were measured with. */
export const CLOC_REQUIRED_VERSION = '1.98';

/** Recorded as `generatedBy` in `cloc.json`. */
export const GENERATED_BY = 'harness/src/inventory/cloc.ts';

/** `--not-match-d` of the filtered measurement; equals `command.notMatchD` of the committed `opt2/inventory/cloc.json`. */
export const CLOC_NOT_MATCH_D = String.raw`(^|/)(core/vendor|core/mura/lib|admin/assets/js/(jquery|filebrowser/assets|bootstrap-slider|porthole|minigrid)|node_modules|\.git|\.github)(/|$)`;

/** `--not-match-f` of the filtered measurement; equals `command.notMatchF` of the committed `opt2/inventory/cloc.json`. */
export const CLOC_NOT_MATCH_F =
  String.raw`(^|/)(oneui\.js|shadowbox\.js|DD_belatedPNG\.js|html5\.js|less\.js|bootstrap-tabdrop\.js|ios-drag-drop\.js|package-lock\.json|[^/]+\.min\.(js|css)|[^/]+\.map)$` +
  String.raw`|(^|/)admin/assets/css/(admin|admin-frontend|ie)\.css$` +
  String.raw`|(^|/)core_assets/css/mura\.7\.[0-9]+(\.skin)?\.css$` +
  String.raw`|(^|/)cta/js/mura\.displayobject\.cta\.js$` +
  String.raw`|(^|/)cta/js/src/templates\.js$` +
  String.raw`|(^|/)(core_assets|admin/assets)/js/mura\.js$`;

/** One exclusion group: its verbatim patterns and why they are excluded. */
export interface ClocExclusionGroup {
  readonly items: readonly string[];
  readonly why: string;
}

/** The three exclusion groups of the filtered measurement, stated verbatim. */
export const CLOC_EXCLUSIONS: Readonly<Record<'vendored' | 'generated' | 'tooling', ClocExclusionGroup>> = Object.freeze({
  vendored: Object.freeze({
    items: Object.freeze([
      'core/vendor',
      'core/mura/lib',
      'admin/assets/js/{jquery,filebrowser/assets,bootstrap-slider,porthole,minigrid}',
      'oneui.js',
      'shadowbox.js',
      'DD_belatedPNG.js',
      'html5.js',
      'less.js',
      'bootstrap-tabdrop.js',
      'ios-drag-drop.js',
    ]),
    why: 'Not Masa application code',
  }),
  generated: Object.freeze({
    items: Object.freeze([
      'admin/assets/css/{admin,admin-frontend,ie}.css',
      'core_assets/css/mura.7.x(.skin).css',
      '*.min.js',
      '*.min.css',
      '*.map',
      'cta/js/mura.displayobject.cta.js',
      'cta/js/src/templates.js',
      'core_assets/js/mura.js',
      'admin/assets/js/mura.js',
    ]),
    why: 'Build output (gulpfile.js LESS, GruntFile.js, webpack)',
  }),
  tooling: Object.freeze({
    items: Object.freeze(['node_modules', '.git', 'package-lock.json']),
    why: 'Not code; the .git pattern also covers .github',
  }),
});

// The unfiltered figure keeps the exclusions that reproduce the planning measurement (1,243 files, 362,994 lines):
// `vendor`, `node_modules` and `.git` directories at any depth plus lockfiles, minified files and source maps.
// Excluding only core/vendor, node_modules and .git would count those too (1,348 files, 367,990 lines).
/** `--not-match-d` of the unfiltered measurement. */
export const UNFILTERED_NOT_MATCH_D = String.raw`(^|/)(vendor|node_modules|\.git)(/|$)`;

/** `--not-match-f` of the unfiltered measurement. */
export const UNFILTERED_NOT_MATCH_F = String.raw`(^|/)(package-lock\.json|[^/]+\.min\.(js|css)|[^/]+\.map)$`;

/** Patterns the unfiltered measurement excludes; directory names match at any depth. */
export const UNFILTERED_EXCLUDES: readonly string[] = Object.freeze([
  'vendor',
  'node_modules',
  '.git',
  'package-lock.json',
  '*.min.js',
  '*.min.css',
  '*.map',
]);

/** cloc languages that make up CFML application code. */
export const CFML_LANGUAGES: readonly string[] = Object.freeze(['ColdFusion CFScript', 'ColdFusion']);

/** Small languages reported as one row, in label order. */
export const GROUPED_LANGUAGES: readonly string[] = Object.freeze(['Text', 'JSON', 'YAML', 'Markdown', 'HTML', 'Handlebars']);

/** Report labels for cloc language names that need one. */
export const LANGUAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ColdFusion: 'ColdFusion (tags)',
  Properties: 'Properties (resource bundles)',
});

/** A file count and a code-line count. */
export interface Figure {
  files: number;
  code: number;
}

/** The cloc 1.98 planning measurement; each language key is a report row's `language`. */
export const PLANNING_FIGURES: Readonly<{
  version: string;
  totals: Readonly<Figure>;
  cfmlApplicationCode: Readonly<Figure>;
  unfiltered: Readonly<Figure>;
  languages: Readonly<Record<string, Readonly<Figure>>>;
}> = Object.freeze({
  version: CLOC_REQUIRED_VERSION,
  totals: Object.freeze({ files: 1179, code: 228839 }),
  cfmlApplicationCode: Object.freeze({ files: 875, code: 146851 }),
  unfiltered: Object.freeze({ files: 1243, code: 362994 }),
  languages: Object.freeze({
    'ColdFusion CFScript': Object.freeze({ files: 307, code: 95807 }),
    ColdFusion: Object.freeze({ files: 568, code: 51044 }),
    LESS: Object.freeze({ files: 153, code: 32856 }),
    Properties: Object.freeze({ files: 41, code: 26002 }),
    JavaScript: Object.freeze({ files: 40, code: 12860 }),
    SQL: Object.freeze({ files: 6, code: 4504 }),
    SVG: Object.freeze({ files: 7, code: 3233 }),
    CSS: Object.freeze({ files: 25, code: 1184 }),
    'Text, JSON, YAML, Markdown, HTML, Handlebars': Object.freeze({ files: 32, code: 1349 }),
  }),
});

/** Raised when the `cloc` binary cannot be found; the report is never estimated instead. */
export class ClocUnavailable extends Error {
  override name = 'ClocUnavailable';

  constructor(options?: ErrorOptions) {
    super(`cloc ${CLOC_REQUIRED_VERSION} required (apt: cloc)`, options);
  }
}

/** Runs `cloc`; `defaultRunner` satisfies it. A reported non-zero `code` fails the run. */
export type ClocRunner = (
  file: string,
  args: readonly string[],
  opts: { cwd: string },
) => Promise<{ stdout: string; stderr: string; code?: number | null }>;

/** Counts for one language. */
export interface ClocLanguage {
  language: string;
  files: number;
  blank: number;
  comment: number;
  code: number;
}

/** Counts for one file; `path` is relative to the measured directory. */
export interface ClocFile {
  path: string;
  language: string;
  blank: number;
  comment: number;
  code: number;
}

/** Parsed cloc run: `version` is null only when cloc counted nothing; `byFile` is set in by-file mode. */
export interface ClocResult {
  version: string | null;
  languages: ClocLanguage[];
  totals: { files: number; blank: number; comment: number; code: number };
  byFile?: ClocFile[];
}

/** Options of {@link runCloc} and {@link clocArgs}. */
export interface RunClocOptions {
  notMatchD?: string;
  notMatchF?: string;
  byFile?: boolean;
  /** File listing the paths to count, relative to the measured directory; replaces the `.` target. */
  listFile?: string;
  runner?: ClocRunner;
}

/** cloc arguments for `opts`, in the order they are passed; the target is `.` inside the measured directory. */
export function clocArgs(opts: Omit<RunClocOptions, 'runner'> = {}): string[] {
  const args = ['--json', '--fullpath', '--quiet'];
  if (opts.notMatchD !== undefined) args.push(`--not-match-d=${opts.notMatchD}`);
  if (opts.notMatchF !== undefined) args.push(`--not-match-f=${opts.notMatchF}`);
  if (opts.byFile) args.push('--by-file');
  args.push(opts.listFile === undefined ? '.' : `--list-file=${opts.listFile}`);
  return args;
}

const count = z.number().int().nonnegative();
const languageRowSchema = z.object({ nFiles: count, blank: count, comment: count, code: count });
const fileRowSchema = z.object({ language: z.string().min(1), blank: count, comment: count, code: count });
const headerSchema = z.object({ cloc_version: z.string().min(1) });
const outputSchema = z.record(z.string(), z.unknown());

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byCodeThenName(a: ClocLanguage, b: ClocLanguage): number {
  return b.code - a.code || compareText(a.language, b.language);
}

function aggregateLanguages(files: readonly ClocFile[]): ClocLanguage[] {
  const totals = new Map<string, ClocLanguage>();
  for (const file of files) {
    const row = totals.get(file.language) ?? { language: file.language, files: 0, blank: 0, comment: 0, code: 0 };
    row.files += 1;
    row.blank += file.blank;
    row.comment += file.comment;
    row.code += file.code;
    totals.set(file.language, row);
  }
  return [...totals.values()];
}

function parseClocOutput(stdout: string, byFile: boolean): ClocResult {
  const raw = outputSchema.parse(JSON.parse(stdout));
  const rows = Object.entries(raw).filter(([key]) => key !== 'header' && key !== 'SUM');
  const sum = raw.SUM === undefined ? undefined : languageRowSchema.parse(raw.SUM);
  const result: ClocResult = {
    version: raw.header === undefined ? null : headerSchema.parse(raw.header).cloc_version,
    languages: [],
    totals: { files: sum?.nFiles ?? 0, blank: sum?.blank ?? 0, comment: sum?.comment ?? 0, code: sum?.code ?? 0 },
  };
  if (byFile) {
    result.byFile = rows
      .map(([file, value]) => ({ path: file.replace(/^\.\//, ''), ...fileRowSchema.parse(value) }))
      .sort((a, b) => compareText(a.path, b.path));
    result.languages = aggregateLanguages(result.byFile);
  } else {
    result.languages = rows.map(([language, value]) => {
      const { nFiles, blank, comment, code } = languageRowSchema.parse(value);
      return { language, files: nFiles, blank, comment, code };
    });
  }
  result.languages.sort(byCodeThenName);
  return result;
}

/**
 * Runs cloc over `dir` (relative paths resolve against the repository root) with `.` as the target, so
 * `--fullpath` regexes see paths such as `./core/vendor/...`. Throws `ClocUnavailable` when cloc is missing.
 */
export async function runCloc(dir: string, opts: RunClocOptions = {}): Promise<ClocResult> {
  const cwd = repoPath(dir);
  // A missing working directory makes spawn fail with the same ENOENT as a missing binary.
  if (!(await stat(cwd)).isDirectory()) throw new Error(`cloc target ${cwd} is not a directory`);
  const run: ClocRunner = opts.runner ?? defaultRunner;
  let output: Awaited<ReturnType<ClocRunner>>;
  try {
    output = await run('cloc', clocArgs(opts), { cwd });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') throw new ClocUnavailable({ cause: err });
    throw err;
  }
  const stderr = output.stderr.trim();
  if (typeof output.code === 'number' && output.code !== 0) {
    throw new Error(`cloc exited with status ${output.code} in ${cwd}${stderr === '' ? '' : `: ${stderr}`}`);
  }
  let result: ClocResult;
  try {
    result = parseClocOutput(output.stdout, opts.byFile === true);
  } catch (err) {
    const detail = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
    throw new Error(`cloc output in ${cwd} is not cloc JSON: ${detail}`, { cause: err });
  }
  // cloc prints `{}` and exits 0 when it cannot read its input.
  if (result.version === null && stderr !== '') throw new Error(`cloc counted nothing in ${cwd}: ${stderr}`);
  return result;
}

/** One row of the report's language table; the grouped row carries its members in `breakdown`. */
export interface ClocReportLanguage {
  language: string;
  label: string;
  files: number;
  code: number;
  aggregate?: true;
  languagesIncluded?: string[];
  breakdown?: { language: string; files: number; code: number }[];
}

/** Body of `opt2/inventory/cloc.json`, in the committed shape. */
export interface ClocReport {
  [key: string]: unknown;
  sourceSha: string;
  generatedBy: string;
  extractedFrom: string;
  measuredWith: string;
  measuredAt: string;
  provenance: 'measured';
  command: {
    tool: 'cloc';
    version: string | null;
    args: string[];
    notMatchD: string;
    notMatchF: string;
    workingDirectory: string;
  };
  exclusions: typeof CLOC_EXCLUSIONS;
  languages: ClocReportLanguage[];
  totals: Figure;
  cfmlApplicationCode: Figure & { languages: string[] };
  unfiltered: Figure & { excludes: string[]; notMatchD: string; notMatchF: string };
  detail: { blank: number; comment: number; perFile: ClocFile[]; reason: string };
}

/** One figure that differs from {@link PLANNING_FIGURES}; null where a side has no such row. */
export interface PlanningDifference {
  figure: string;
  planning: Figure | null;
  measured: Figure | null;
}

/** Outcome of {@link comparePlanning}. */
export interface PlanningComparison {
  matchesPlanning: boolean;
  versionMatches: boolean;
  differences: PlanningDifference[];
}

const FILTERED_OPTIONS = { notMatchD: CLOC_NOT_MATCH_D, notMatchF: CLOC_NOT_MATCH_F, byFile: true } as const;
const UNFILTERED_OPTIONS = { notMatchD: UNFILTERED_NOT_MATCH_D, notMatchF: UNFILTERED_NOT_MATCH_F } as const;
const WORKING_DIRECTORY = 'scratch extraction outside the checkout';

function figureOf(row: { files: number; code: number }): Figure {
  return { files: row.files, code: row.code };
}

function sumFigures(rows: readonly ClocLanguage[]): Figure {
  return rows.reduce((acc, row) => ({ files: acc.files + row.files, code: acc.code + row.code }), { files: 0, code: 0 });
}

/** Files and code lines of the `CFML_LANGUAGES` rows of `result`. */
export function cfmlFigure(result: Pick<ClocResult, 'languages'>): Figure {
  return sumFigures(result.languages.filter((row) => CFML_LANGUAGES.includes(row.language)));
}

/** Report rows: each language by code lines, then the `GROUPED_LANGUAGES` row when any of them was counted. */
export function reportLanguages(languages: readonly ClocLanguage[]): ClocReportLanguage[] {
  const rows: ClocReportLanguage[] = languages
    .filter((row) => !GROUPED_LANGUAGES.includes(row.language))
    .map((row) => ({ language: row.language, label: LANGUAGE_LABELS[row.language] ?? row.language, ...figureOf(row) }));
  const members = GROUPED_LANGUAGES.flatMap((name) => languages.filter((row) => row.language === name));
  if (members.length > 0) {
    const name = members.map((row) => row.language).join(', ');
    rows.push({
      language: name,
      label: name,
      ...sumFigures(members),
      aggregate: true,
      languagesIncluded: members.map((row) => row.language),
      breakdown: members.map((row) => ({ language: row.language, ...figureOf(row) })),
    });
  }
  return rows;
}

/** Builds the `cloc.json` body from the filtered (by-file) and unfiltered runs over the extraction of `sha`. */
export function buildClocReport(sha: string, filtered: ClocResult, unfiltered: ClocResult, measuredAt: Date): ClocReport {
  return {
    sourceSha: sha,
    generatedBy: GENERATED_BY,
    extractedFrom: `git archive ${sha}`,
    measuredWith: `cloc ${filtered.version ?? 'unknown'}`,
    measuredAt: measuredAt.toISOString(),
    provenance: 'measured',
    command: {
      tool: 'cloc',
      version: filtered.version,
      args: clocArgs(FILTERED_OPTIONS),
      notMatchD: CLOC_NOT_MATCH_D,
      notMatchF: CLOC_NOT_MATCH_F,
      workingDirectory: WORKING_DIRECTORY,
    },
    exclusions: CLOC_EXCLUSIONS,
    languages: reportLanguages(filtered.languages),
    totals: figureOf(filtered.totals),
    cfmlApplicationCode: { languages: [...CFML_LANGUAGES], ...cfmlFigure(filtered) },
    unfiltered: {
      excludes: [...UNFILTERED_EXCLUDES],
      notMatchD: UNFILTERED_NOT_MATCH_D,
      notMatchF: UNFILTERED_NOT_MATCH_F,
      ...figureOf(unfiltered.totals),
    },
    detail: {
      blank: filtered.totals.blank,
      comment: filtered.totals.comment,
      perFile: filtered.byFile ?? [],
      reason: 'per-file counts of the filtered measurement, sorted by path',
    },
  };
}

function sameFigure(a: Figure | null, b: Figure | null): boolean {
  return a !== null && b !== null && a.files === b.files && a.code === b.code;
}

/** Differences between `report` and {@link PLANNING_FIGURES}, per total, derived figure and language row. */
export function comparePlanning(report: ClocReport): PlanningComparison {
  const candidates: PlanningDifference[] = [
    { figure: 'totals', planning: PLANNING_FIGURES.totals, measured: report.totals },
    {
      figure: 'cfmlApplicationCode',
      planning: PLANNING_FIGURES.cfmlApplicationCode,
      measured: figureOf(report.cfmlApplicationCode),
    },
    { figure: 'unfiltered', planning: PLANNING_FIGURES.unfiltered, measured: figureOf(report.unfiltered) },
  ];
  const measured = new Map(report.languages.map((row) => [row.language, figureOf(row)]));
  const names = new Set([...Object.keys(PLANNING_FIGURES.languages), ...measured.keys()]);
  for (const name of names) {
    candidates.push({
      figure: `languages.${name}`,
      planning: PLANNING_FIGURES.languages[name] ?? null,
      measured: measured.get(name) ?? null,
    });
  }
  const differences = candidates
    .filter((c) => !sameFigure(c.planning, c.measured))
    .map((c) => ({ figure: c.figure, planning: c.planning === null ? null : figureOf(c.planning), measured: c.measured }));
  return {
    matchesPlanning: differences.length === 0,
    versionMatches: report.command.version === PLANNING_FIGURES.version,
    differences,
  };
}

const EXCLUSION_TITLES: Readonly<Record<keyof typeof CLOC_EXCLUSIONS, string>> = {
  vendored: 'Vendored code',
  generated: 'Generated files',
  tooling: 'Tooling',
};

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function code(text: string): string {
  return `\`${text}\``;
}

function shellWord(arg: string): string {
  if (/^[\w./=:,@+-]+$/.test(arg)) return arg;
  const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
  const eq = arg.indexOf('=');
  return arg.startsWith('--') && eq > 0 ? `${arg.slice(0, eq + 1)}${quote(arg.slice(eq + 1))}` : quote(arg);
}

function commandLine(args: readonly string[]): string {
  return `    cd <extraction-dir> && cloc ${args.map(shellWord).join(' ')}`;
}

function figureCells(figure: Figure | null): string {
  return figure === null ? '— | —' : `${num(figure.files)} | ${num(figure.code)}`;
}

/** Markdown lines of `cloc.md` (after the title and `Source SHA:` line) for `report` and its planning comparison. */
export function renderClocMarkdown(report: ClocReport, planning: PlanningComparison): string[] {
  const lines = [
    `Measured with: ${report.measuredWith} · provenance: ${report.provenance} · measured at: ${report.measuredAt}`,
    '',
  ];
  if (!planning.versionMatches) {
    lines.push(
      `The planning figures were measured with cloc ${PLANNING_FIGURES.version}; this report was measured with ${report.measuredWith}.`,
      '',
    );
  }
  lines.push(
    'The input is a `git archive` extraction of the pin, made outside the checkout; `harness/src/inventory/cloc.ts` regenerates this file.',
    '',
    '## Command',
    '',
    'Filtered measurement:',
    '',
    commandLine(report.command.args),
    '',
    `- ${code('--not-match-d')}: ${code(report.command.notMatchD)}`,
    `- ${code('--not-match-f')}: ${code(report.command.notMatchF)}`,
    '',
    'Unfiltered measurement:',
    '',
    commandLine(clocArgs(UNFILTERED_OPTIONS)),
    '',
    `- ${code('--not-match-d')}: ${code(report.unfiltered.notMatchD)}`,
    `- ${code('--not-match-f')}: ${code(report.unfiltered.notMatchF)}`,
    '',
    '## Exclusions',
    '',
    '| Exclusion | Patterns | Why |',
    '|---|---|---|',
  );
  for (const key of Object.keys(EXCLUSION_TITLES) as (keyof typeof CLOC_EXCLUSIONS)[]) {
    const group = report.exclusions[key];
    lines.push(`| ${EXCLUSION_TITLES[key]} | ${group.items.map(code).join(', ')} | ${group.why} |`);
  }
  lines.push('', '## Result', '', '| Language | Files | Code lines |', '|---|---:|---:|');
  for (const row of report.languages) lines.push(`| ${row.label} | ${num(row.files)} | ${num(row.code)} |`);
  lines.push(
    `| **Total** | **${num(report.totals.files)}** | **${num(report.totals.code)}** |`,
    '',
    '## Derived figures',
    '',
    '| Figure | Files | Code lines |',
    '|---|---:|---:|',
    `| CFML application code (CFScript + tags) | ${figureCells(report.cfmlApplicationCode)} |`,
    `| Unfiltered (excludes only ${report.unfiltered.excludes.map(code).join(', ')}) | ${figureCells(report.unfiltered)} |`,
    '',
    'Directory patterns match a directory name at any depth.',
    '',
    `Blank lines: ${num(report.detail.blank)}; comment lines: ${num(report.detail.comment)}. ` +
      `\`cloc.json\` lists the ${num(report.detail.perFile.length)} counted files under \`detail.perFile\`.`,
    '',
    '## Planning comparison',
    '',
  );
  if (planning.matchesPlanning) {
    lines.push(`Every figure matches the planning measurement made with cloc ${PLANNING_FIGURES.version}.`);
  } else {
    lines.push(
      `These figures differ from the planning measurement made with cloc ${PLANNING_FIGURES.version}; the measured values are the ones reported.`,
      '',
      '| Figure | Planning files | Planning code lines | Measured files | Measured code lines |',
      '|---|---:|---:|---:|---:|',
      ...planning.differences.map((d) => `| ${d.figure} | ${figureCells(d.planning)} | ${figureCells(d.measured)} |`),
    );
  }
  return lines;
}

/** Inputs of {@link generateCloc}; each defaults to the real extraction, cloc binary, clock and `opt2/inventory`. */
export interface GenerateClocOptions {
  /** Output directory for `cloc.json` and `cloc.md`; a relative path resolves against the repository root. */
  out?: string;
  runner?: ClocRunner;
  /** Extracts the pinned tree into a new directory outside the checkout and returns its path. */
  extract?: (sha: string) => Promise<string>;
  clock?: () => Date;
  pin?: () => Pin;
}

/** Paths written by {@link generateCloc}, the report body and its planning comparison. */
export interface ClocGeneration {
  jsonPath: string;
  mdPath: string;
  report: ClocReport;
  planning: PlanningComparison;
}

/** Measures the pinned tree and writes `cloc.json` and `cloc.md`; the extraction is always removed. */
export async function generateCloc(opts: GenerateClocOptions = {}): Promise<ClocGeneration> {
  const pin = (opts.pin ?? readPin)();
  const pinOf = (): Pin => pin;
  const extract = opts.extract ?? ((sha: string) => gitArchiveExtract(sha));
  const dir = assertOutsideRepo(await extract(pin.sha), 'cloc extraction');
  const measuredAt = (opts.clock ?? (() => new Date()))();
  let filtered: ClocResult;
  let unfiltered: ClocResult;
  try {
    filtered = await runCloc(dir, { ...FILTERED_OPTIONS, runner: opts.runner });
    unfiltered = await runCloc(dir, { ...UNFILTERED_OPTIONS, runner: opts.runner });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const report = buildClocReport(pin.sha, filtered, unfiltered, measuredAt);
  const planning = comparePlanning(report);
  const out = opts.out ?? opt2Path('inventory');
  const { path: jsonPath } = await writeJsonReport(path.join(out, 'cloc.json'), report, {
    generatedBy: GENERATED_BY,
    clock: () => measuredAt,
    pin: pinOf,
  });
  const lines = renderClocMarkdown(report, planning);
  const mdPath = await writeMarkdown(path.join(out, 'cloc.md'), 'Legacy size report (cloc)', lines, { pin: pinOf });
  return { jsonPath, mdPath, report, planning };
}

const USAGE = 'cloc [--out <dir>]';
const HELP = `${USAGE} [--help]

Measures the pinned legacy source with cloc and writes the size report cloc.json and cloc.md.

Options:
  --out <dir>  output directory for cloc.json and cloc.md; a relative path resolves against the repository root,
               not the working directory (default: opt2/inventory)
  --help       print this help and exit 0

The commit pinned in opt2/source-pin.json is extracted with git archive into a new opt2-archive-* directory under
TMPDIR, measured with the full exclusions and again unfiltered, and removed. Figures or a cloc version that differ
from the cloc ${CLOC_REQUIRED_VERSION} planning measurement are reported and noted in cloc.md, not failed.

Requires: git and tar on PATH, a checkout that holds the pinned commit, cloc ${CLOC_REQUIRED_VERSION} on PATH (apt: cloc), and TMPDIR
(default /tmp) outside the checkout.

Output: one JSON summary line on stdout. Exit: 0 report written, 1 failure (cloc missing or failing, git, pin or
write error), 2 usage error.

Examples (from harness/):
  npm run inventory:cloc
  TMPDIR=/path/to/scratch npm run --silent inventory:cloc -- --out /path/to/out`;

/** CLI entry: writes the report and summarises the figures and any planning differences. */
export async function main(argv: string[]): Promise<CliOutcome> {
  const { values } = parseFlags(argv, { options: { out: { type: 'string' } }, usage: USAGE, help: HELP });
  if (values.out === '') throw new UsageError('--out needs a directory', USAGE);
  const { jsonPath, mdPath, report, planning } = await generateCloc({ out: values.out });
  return {
    summary: {
      json: jsonPath,
      md: mdPath,
      measuredWith: report.measuredWith,
      totals: report.totals,
      cfmlApplicationCode: figureOf(report.cfmlApplicationCode),
      unfiltered: figureOf(report.unfiltered),
      ...planning,
    },
  };
}

if (isMainModule(import.meta.url)) void runCli(main);
