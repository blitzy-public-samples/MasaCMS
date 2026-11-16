// Legacy baseline comparison: the diagnostic TestBox run against the expected baseline, written as the baseline report.
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from '@opt2/platform/service-kit';

import { isMainModule, parseFlags, runCli, type CliOutcome } from '../lib/cli.js';
import { REPO_ROOT, isInsideRepo, repoPath, reportsDir, type EnvLike } from '../lib/paths.js';
import { readJson, writeJsonReport, writeMarkdown } from '../lib/report.js';
import {
  DIAGNOSTIC_RUNNER_PATH,
  baselineStateDir,
  lowerKeysDeep,
  runDiagnostic,
  type SavedRunnerResponse,
} from './run.js';

/** Setup-mandated second copy of the baseline report, outside the repository. */
export const MASA_BASELINE_PATH = '/tmp/masa-baseline.json';

/** Repository-relative path of the expected baseline. */
export const EXPECTED_BASELINE_PATH = 'harness/legacy-baseline/expected-baseline.json';

/** Title of `baseline.md`, as committed. */
export const REPORT_TITLE = 'Legacy TestBox baseline';

const GENERATED_BY = 'harness/src/baseline/compare.ts';
const USAGE = 'usage: npm run baseline:compare (takes no flags)';
const RERUN_REASON = 'the first run differed only by timing-sensitive specs that passed under their threshold';
const NOT_RUN = 'not run';

/** Comparison outcome; its exit code gates the later test-all stages. */
export type BaselineResult = 'match' | 'timing-variance' | 'mismatch';

/** Exit code per result. */
export const EXIT_CODES = { match: 0, 'timing-variance': 3, mismatch: 1 } as const satisfies Record<BaselineResult, number>;

/** The five compared totals. */
export type BaselineTotals = { bundles: number; specs: number; passed: number; failed: number; errored: number };

/** A compared total. */
export type TotalsField = keyof BaselineTotals;

/** Totals in report order. */
export const TOTALS_FIELDS: readonly TotalsField[] = ['bundles', 'specs', 'passed', 'failed', 'errored'];

/** A legacy source location; `lines` holds one line or the first and last line of a range. */
export type SourceRef = { path: string; lines: number[] };

type FailureGroupBase = {
  /** Short bundle name, e.g. `entities`. */
  bundle: string;
  suite?: string;
  count: number;
  timingSensitive?: boolean;
  thresholdMs?: number;
  observedMs?: number[];
  reason: string;
  source: SourceRef;
};

/** One expected failure group: one spec by exact `title`, or a family by `titlePattern` (a regular expression). */
export type ExpectedFailureGroup = FailureGroupBase &
  ({ title: string; titlePattern?: undefined } | { titlePattern: string; title?: undefined });

/** `harness/legacy-baseline/expected-baseline.json`. */
export type ExpectedBaseline = {
  sourceSha: string;
  provenance: string;
  totals: BaselineTotals;
  /** Short names of the bundles the diagnostic runs. */
  bundles: string[];
  failures: ExpectedFailureGroup[];
  excludedBundles: { bundle: string; reason: string; source: SourceRef }[];
  officialRunner: { url: string; expectedHttpStatus: number; expectedSpecs: number; reason: string };
};

/** One TestBox spec, flattened; `status` is TestBox's `Passed`, `Failed`, `Error` or `Skipped`. */
export type FlatSpec = {
  /** Short bundle name: the last dotted segment of the bundle path. */
  bundle: string;
  suitePath: string[];
  spec: string;
  /** `[...suitePath, spec].join(' > ')`. */
  fullName: string;
  status: string;
  failMessage: string;
};

/** A bundle-level exception TestBox recorded instead of running the bundle's specs. */
export type BundleException = { bundle: string; message: string };

/** The diagnostic result as compared; `testBox` is false when the body was not TestBox JSON. */
export type ObservedBaseline = {
  testBox: boolean;
  totals: BaselineTotals;
  /** Short names of the reported bundles, in report order. */
  bundles: string[];
  specs: FlatSpec[];
  bundleExceptions: BundleException[];
};

/** Status of a spec that `diffBaseline` lists as not failing where a failure was expected. */
export type ObservedSpecStatus = { fullName: string; status: string };

/** One difference between the observed and the expected baseline. */
export type Difference =
  | { kind: 'totals'; field: TotalsField; expected: number; observed: number }
  | {
      kind: 'unexpected-failure';
      bundle: string;
      spec: string;
      fullName: string;
      status: string;
      failMessage: string;
      /** The expected group whose count this failure exceeds, or null when it matches no group. */
      group: string | null;
    }
  | {
      kind: 'expected-failure-not-observed';
      group: string;
      bundle: string;
      /** The group's title or title pattern. */
      spec: string;
      timingSensitive: boolean;
      expected: number;
      observed: number;
      /** Specs matching the group that did not fail, with the status each had. */
      actual: ObservedSpecStatus[];
    }
  | { kind: 'missing-bundle'; bundle: string }
  | { kind: 'unexpected-bundle'; bundle: string; excluded: boolean }
  | { kind: 'bundle-exception'; bundle: string; message: string }
  | { kind: 'diagnostic-runner'; field: 'httpStatus' | 'body'; expected: number | string; observed: number | string }
  | { kind: 'official-runner'; field: 'httpStatus' | 'specs'; expected: number; observed: number };

/** Kinds in report order. */
const KIND_ORDER: readonly Difference['kind'][] = [
  'diagnostic-runner',
  'official-runner',
  'totals',
  'missing-bundle',
  'unexpected-bundle',
  'bundle-exception',
  'unexpected-failure',
  'expected-failure-not-observed',
];

/** An expected failure group as the report renders it; `spec` or `specPattern` follows the group's title form. */
export type ExpectedFailureEntry = {
  bundle: string;
  suite: string | null;
  spec?: string;
  specPattern?: string;
  count: number;
  cause: string;
  timingSensitive?: true;
  source: { path: string; lines: string };
};

/** An excluded bundle as the report renders it. */
export type ExcludedBundleEntry = { bundle: string; reason: string; source: { path: string; lines: string } };

/** An observed `Failed` or `Error` spec; `group` names the expected group it matched, else null. */
export type ObservedFailure = {
  bundle: string;
  spec: string;
  fullName: string;
  status: string;
  failMessage: string;
  group: string | null;
};

/** The single diagnostic re-run a timing-only difference triggers. */
export type RerunRecord = {
  reason: string;
  startedAt: string;
  totals: BaselineTotals;
  failures: ObservedFailure[];
  differences: Difference[];
  result: BaselineResult;
};

/** Body of `opt2/reports/baseline.json`; `sourceSha` is stamped by `writeJsonReport`. */
export type BaselineReport = {
  sourceSha?: string;
  generatedBy: string;
  generatedAt: string;
  /** Replaces the placeholder's `pending-run`; the placeholder documents no other post-run value. */
  status: 'generated';
  alsoWrittenTo: string;
  expected: {
    provenance: string;
    source: string;
    totals: BaselineTotals;
    failures: ExpectedFailureEntry[];
    excludedBundles: ExcludedBundleEntry[];
  };
  officialRunner: { url: string; expectedHttpStatus: number; expectedSpecs: number; httpStatus: number; specs: number };
  diagnostic: {
    url: string;
    bundles: string[];
    totals: BaselineTotals;
    failures: ObservedFailure[];
    rerun: RerunRecord | null;
  };
  /** Differences of the first diagnostic run. */
  differences: Difference[];
  result: BaselineResult;
};

/** Injectable process boundary; defaults are `process.env`, the real runner, the committed expected baseline, {@link MASA_BASELINE_PATH} and the system clock. */
export type CompareDeps = {
  env?: EnvLike;
  runDiagnostic?: typeof runDiagnostic;
  expectedPath?: string;
  masaBaselinePath?: string;
  now?: () => Date;
};

/** Summary line fields; `totals` and `differences` describe the run that decided the result. */
export type CompareSummary = {
  result: BaselineResult;
  totals: BaselineTotals;
  differences: number;
  rerun: boolean;
  doneWhenMet: boolean;
};

/** What {@link compareBaseline} returns: the exit code, the summary and the written report body. */
export type CompareResult = { code: (typeof EXIT_CODES)[BaselineResult]; summary: CompareSummary; report: BaselineReport };

const ZERO_TOTALS: BaselineTotals = { bundles: 0, specs: 0, passed: 0, failed: 0, errored: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** TestBox's `globalException` is an empty string when the bundle ran; otherwise a string or an exception struct. */
function exceptionMessage(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    if (Object.keys(value).length === 0) return null;
    const parts = [text(value.type), text(value.message), text(value.detail)].filter((part) => part !== '');
    return parts.length > 0 ? parts.join(': ') : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function collectSpecs(suites: unknown, bundle: string, parents: string[], out: FlatSpec[]): void {
  for (const suite of records(suites)) {
    const suitePath = [...parents, text(suite.name)];
    for (const spec of records(suite.specstats)) {
      const name = text(spec.name);
      out.push({
        bundle,
        suitePath,
        spec: name,
        fullName: [...suitePath, name].join(' > '),
        status: text(spec.status),
        failMessage: text(spec.failmessage),
      });
    }
    collectSpecs(suite.suitestats, bundle, suitePath, out);
  }
}

/** Flattens a TestBox JSON reporter body (any key case); a body that is not TestBox JSON yields zero totals and no specs. */
export function flattenTestBox(body: unknown): ObservedBaseline {
  const root = lowerKeysDeep(body);
  if (!isRecord(root) || !Array.isArray(root.bundlestats) || typeof root.totalspecs !== 'number') {
    return { testBox: false, totals: { ...ZERO_TOTALS }, bundles: [], specs: [], bundleExceptions: [] };
  }
  const totals: BaselineTotals = {
    bundles: count(root.totalbundles),
    specs: count(root.totalspecs),
    passed: count(root.totalpass),
    failed: count(root.totalfail),
    errored: count(root.totalerror),
  };
  const bundles: string[] = [];
  const specs: FlatSpec[] = [];
  const bundleExceptions: BundleException[] = [];
  for (const stats of records(root.bundlestats)) {
    const bundle = (text(stats.path) || text(stats.name)).split('.').pop() ?? '';
    bundles.push(bundle);
    const message = exceptionMessage(stats.globalexception);
    if (message !== null) bundleExceptions.push({ bundle, message });
    collectSpecs(stats.suitestats, bundle, [], specs);
  }
  return { testBox: true, totals, bundles, specs, bundleExceptions };
}

function groupLabel(bundle: string, title: string | undefined, pattern: string | undefined): string {
  return title !== undefined ? `${bundle}: ${title}` : `${bundle}: /${pattern ?? ''}/`;
}

/** Stable identifier of an expected failure group, used as `group` in differences and observed failures. */
export function groupId(group: ExpectedFailureGroup): string {
  return groupLabel(group.bundle, group.title, group.titlePattern);
}

function nameMatches(group: ExpectedFailureGroup, spec: FlatSpec): boolean {
  if (spec.bundle !== group.bundle) return false;
  return group.title !== undefined ? spec.spec === group.title : new RegExp(group.titlePattern).test(spec.spec);
}

function isFailing(spec: FlatSpec): boolean {
  return spec.status === 'Failed' || spec.status === 'Error';
}

/** The group a `Failed` spec counts towards; an `Error` spec never counts, because no errors are expected. */
function groupOf(expected: ExpectedBaseline, spec: FlatSpec): ExpectedFailureGroup | undefined {
  return spec.status === 'Failed' ? expected.failures.find((group) => nameMatches(group, spec)) : undefined;
}

/** The observed `Failed` and `Error` specs, each with the expected group it counts towards. */
export function observedFailures(expected: ExpectedBaseline, observed: ObservedBaseline): ObservedFailure[] {
  return observed.specs.filter(isFailing).map((spec) => {
    const group = groupOf(expected, spec);
    const { bundle, fullName, status, failMessage } = spec;
    return { bundle, spec: spec.spec, fullName, status, failMessage, group: group === undefined ? null : groupId(group) };
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortSubject(difference: Difference): string {
  switch (difference.kind) {
    case 'totals':
      return String(TOTALS_FIELDS.indexOf(difference.field));
    case 'diagnostic-runner':
    case 'official-runner':
      return difference.field;
    case 'unexpected-failure':
      return `${difference.bundle}\u0000${difference.fullName}`;
    case 'expected-failure-not-observed':
      return difference.group;
    default:
      return difference.bundle;
  }
}

function sortDifferences(differences: Difference[]): Difference[] {
  return differences.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || compareText(sortSubject(a), sortSubject(b)),
  );
}

function runnerDifferences(
  expected: ExpectedBaseline,
  observed: ObservedBaseline,
  official: SavedRunnerResponse,
  diagnostic: SavedRunnerResponse,
): Difference[] {
  const out: Difference[] = [];
  if (diagnostic.httpStatus !== 200) {
    out.push({ kind: 'diagnostic-runner', field: 'httpStatus', expected: 200, observed: diagnostic.httpStatus });
  }
  if (!observed.testBox) {
    const body = diagnostic.bodyKind === 'json' ? 'JSON that is not a TestBox result' : `text (${diagnostic.contentType ?? 'no content type'})`;
    out.push({ kind: 'diagnostic-runner', field: 'body', expected: 'TestBox JSON', observed: body });
  }
  const runner = expected.officialRunner;
  if (official.httpStatus !== runner.expectedHttpStatus) {
    out.push({ kind: 'official-runner', field: 'httpStatus', expected: runner.expectedHttpStatus, observed: official.httpStatus });
  }
  if (official.specs !== runner.expectedSpecs) {
    out.push({ kind: 'official-runner', field: 'specs', expected: runner.expectedSpecs, observed: official.specs });
  }
  return out;
}

function failureDifferences(expected: ExpectedBaseline, observed: ObservedBaseline): Difference[] {
  const out: Difference[] = [];
  const counted = new Map<ExpectedFailureGroup, FlatSpec[]>(expected.failures.map((group) => [group, []]));
  for (const spec of observed.specs.filter(isFailing)) {
    const group = groupOf(expected, spec);
    if (group === undefined) out.push(unexpectedFailure(spec, null));
    else counted.get(group)?.push(spec);
  }
  for (const [group, specs] of counted) {
    const id = groupId(group);
    // Which of a family's failures is the surplus is undecidable, so the surplus is taken in name order.
    const surplus = [...specs].sort((a, b) => compareText(a.fullName, b.fullName)).slice(group.count);
    for (const spec of surplus) out.push(unexpectedFailure(spec, id));
    if (specs.length >= group.count) continue;
    const actual = observed.specs
      .filter((spec) => nameMatches(group, spec) && spec.status !== 'Failed')
      .map(({ fullName, status }) => ({ fullName, status }));
    out.push({
      kind: 'expected-failure-not-observed',
      group: id,
      bundle: group.bundle,
      spec: group.title ?? group.titlePattern,
      timingSensitive: group.timingSensitive === true,
      expected: group.count,
      observed: specs.length,
      actual,
    });
  }
  return out;
}

function unexpectedFailure(spec: FlatSpec, group: string | null): Difference {
  const { bundle, fullName, status, failMessage } = spec;
  return { kind: 'unexpected-failure', bundle, spec: spec.spec, fullName, status, failMessage, group };
}

/**
 * Every difference between the observed diagnostic run and the expected baseline, in a deterministic order.
 * A diagnostic body that is not TestBox JSON yields only the runner differences, since nothing else is comparable.
 */
export function diffBaseline(
  expected: ExpectedBaseline,
  observed: ObservedBaseline,
  official: SavedRunnerResponse,
  diagnostic: SavedRunnerResponse,
): Difference[] {
  const out = runnerDifferences(expected, observed, official, diagnostic);
  if (!observed.testBox) return sortDifferences(out);

  for (const field of TOTALS_FIELDS) {
    if (expected.totals[field] !== observed.totals[field]) {
      out.push({ kind: 'totals', field, expected: expected.totals[field], observed: observed.totals[field] });
    }
  }
  const seen = new Set(observed.bundles);
  const wanted = new Set(expected.bundles);
  const excluded = new Set(expected.excludedBundles.map((entry) => entry.bundle));
  for (const bundle of wanted) if (!seen.has(bundle)) out.push({ kind: 'missing-bundle', bundle });
  for (const bundle of seen) {
    if (!wanted.has(bundle)) out.push({ kind: 'unexpected-bundle', bundle, excluded: excluded.has(bundle) });
  }
  for (const { bundle, message } of observed.bundleExceptions) out.push({ kind: 'bundle-exception', bundle, message });
  out.push(...failureDifferences(expected, observed));
  return sortDifferences(out);
}

/**
 * True when the differences are non-empty and consist only of timing-sensitive groups whose specs all passed, plus
 * `passed`/`failed` totals shifted by exactly the number of those flipped specs.
 */
export function isTimingOnly(differences: readonly Difference[], expected: ExpectedBaseline): boolean {
  if (differences.length === 0) return false;
  let flipped = 0;
  const shift: Partial<Record<TotalsField, number>> = {};
  for (const difference of differences) {
    if (difference.kind === 'expected-failure-not-observed') {
      const group = expected.failures.find((candidate) => groupId(candidate) === difference.group);
      const missing = difference.expected - difference.observed;
      const allPassed = difference.actual.length === missing && difference.actual.every((spec) => spec.status === 'Passed');
      if (group?.timingSensitive !== true || !allPassed) return false;
      flipped += missing;
    } else if (difference.kind === 'totals' && (difference.field === 'passed' || difference.field === 'failed')) {
      shift[difference.field] = difference.observed - difference.expected;
    } else {
      return false;
    }
  }
  return flipped > 0 && (shift.passed ?? 0) === flipped && (shift.failed ?? 0) === -flipped;
}

/** Inputs of {@link buildBaselineReport}; `differences` are the first run's. */
export type BaselineReportInput = {
  expected: ExpectedBaseline;
  expectedPath: string;
  masaBaselinePath: string;
  official: SavedRunnerResponse;
  observed: ObservedBaseline;
  differences: Difference[];
  rerun: RerunRecord | null;
  result: BaselineResult;
  generatedAt: Date;
};

function lineSpan(lines: readonly number[]): string {
  const first = Math.min(...lines);
  const last = Math.max(...lines);
  return first === last ? String(first) : `${first}-${last}`;
}

function msRange(values: readonly number[]): string {
  const [first, last] = [Math.min(...values), Math.max(...values)].map((value) => value.toLocaleString('en-US'));
  return first === last ? `${first} ms` : `${first}-${last} ms`;
}

function displayPath(file: string): string {
  const resolved = path.resolve(file);
  return isInsideRepo(resolved) ? path.relative(REPO_ROOT, resolved).split(path.sep).join('/') : resolved;
}

// Keys follow the committed placeholder; values are expected-baseline.json's own (short bundle names), not the
// placeholder's sample values, with `observedMs` folded into `cause` because the placeholder has no key for it.
function failureEntry(group: ExpectedFailureGroup): ExpectedFailureEntry {
  const ran = group.observedMs !== undefined && group.observedMs.length > 0 ? `; ran at ${msRange(group.observedMs)}` : '';
  return {
    bundle: group.bundle,
    suite: group.suite ?? null,
    ...(group.title !== undefined ? { spec: group.title } : { specPattern: group.titlePattern }),
    count: group.count,
    cause: `${group.reason}${ran}`,
    ...(group.timingSensitive === true ? { timingSensitive: true as const } : {}),
    source: { path: group.source.path, lines: lineSpan(group.source.lines) },
  };
}

/** Builds the report body with the committed `opt2/reports/baseline.json` key set at every level; `sourceSha` is left to the writer. */
export function buildBaselineReport(input: BaselineReportInput): BaselineReport {
  const { expected, official, observed } = input;
  return {
    generatedBy: GENERATED_BY,
    generatedAt: input.generatedAt.toISOString(),
    status: 'generated',
    alsoWrittenTo: input.masaBaselinePath,
    expected: {
      provenance: expected.provenance,
      source: displayPath(input.expectedPath),
      totals: { ...expected.totals },
      failures: expected.failures.map(failureEntry),
      excludedBundles: expected.excludedBundles.map(({ bundle, reason, source }) => ({
        bundle,
        reason,
        source: { path: source.path, lines: lineSpan(source.lines) },
      })),
    },
    officialRunner: {
      url: expected.officialRunner.url,
      expectedHttpStatus: expected.officialRunner.expectedHttpStatus,
      expectedSpecs: expected.officialRunner.expectedSpecs,
      httpStatus: official.httpStatus,
      specs: official.specs,
    },
    diagnostic: {
      url: DIAGNOSTIC_RUNNER_PATH,
      bundles: observed.bundles,
      totals: observed.totals,
      failures: observedFailures(expected, observed),
      rerun: input.rerun,
    },
    differences: input.differences,
    result: input.result,
  };
}

function cell(value: string | number): string {
  return String(value).replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|');
}

function code(value: string): string {
  return `\`${cell(value)}\``;
}

function measure(field: TotalsField): string {
  return field.charAt(0).toUpperCase() + field.slice(1);
}

function describeDifference(difference: Difference): [string, string | number, string | number, string] {
  switch (difference.kind) {
    case 'totals':
      return [difference.field, difference.expected, difference.observed, ''];
    case 'diagnostic-runner':
      return [`diagnostic ${difference.field}`, difference.expected, difference.observed, ''];
    case 'official-runner':
      return [`official ${difference.field}`, difference.expected, difference.observed, ''];
    case 'missing-bundle':
      return [difference.bundle, 'reported', 'not reported', ''];
    case 'unexpected-bundle':
      return [difference.bundle, 'not reported', 'reported', difference.excluded ? 'an excluded bundle' : ''];
    case 'bundle-exception':
      return [difference.bundle, 'no bundle exception', 'bundle exception', difference.message];
    case 'unexpected-failure': {
      const expected = difference.group === null ? 'no failure' : `within the count of ${difference.group}`;
      return [`${difference.bundle}: ${difference.fullName}`, expected, difference.status, difference.failMessage];
    }
    case 'expected-failure-not-observed': {
      const actual = difference.actual.map((spec) => `${spec.fullName}: ${spec.status}`).join('; ');
      return [difference.group, `${difference.expected} failed`, `${difference.observed} failed`, actual || 'no other matching spec reported'];
    }
  }
}

function differenceLines(report: BaselineReport): string[] {
  const row = (run: string, difference: Difference): string => {
    const [subject, expected, observed, detail] = describeDifference(difference);
    return `| ${run} | ${code(difference.kind)} | ${cell(subject)} | ${cell(expected)} | ${cell(observed)} | ${cell(detail)} |`;
  };
  const rows = [
    ...report.differences.map((difference) => row('first', difference)),
    ...(report.diagnostic.rerun?.differences ?? []).map((difference) => row('re-run', difference)),
  ];
  if (rows.length === 0) return ['none'];
  return ['| Run | Kind | Subject | Expected | Observed | Detail |', '|---|---|---|---|---|---|', ...rows];
}

/** Body lines of `baseline.md` (title and `Source SHA:` come from `writeMarkdown`); every value is the report's. */
export function renderBaselineMarkdown(report: BaselineReport): string[] {
  const { expected, officialRunner, diagnostic } = report;
  const { rerun } = diagnostic;
  const groupCount = (failures: readonly ObservedFailure[], id: string): number =>
    failures.filter((failure) => failure.group === id).length;
  const excludedNames = expected.excludedBundles.map((entry) => code(entry.bundle)).join(', ');
  const timingNames = expected.failures.filter((entry) => entry.timingSensitive === true).map((entry) => code(entry.bundle));
  const rerunNote = rerun === null ? '' : `, after one re-run whose result was \`${rerun.result}\``;

  return [
    `Status: ${report.status}`,
    `Generated by: ${report.generatedBy}`,
    `Generated at: ${report.generatedAt}`,
    `Result: \`${report.result}\` (exit ${EXIT_CODES[report.result]})${rerunNote}`,
    `Expected from: \`${expected.source}\` (provenance: ${expected.provenance})`,
    `Also written to: \`${report.alsoWrittenTo}\``,
    '',
    '## Totals',
    '',
    `| Measure | Expected (${expected.provenance}) | Observed | Re-run |`,
    '|---|---|---|---|',
    ...TOTALS_FIELDS.map(
      (field) =>
        `| ${measure(field)} | ${expected.totals[field]} | ${diagnostic.totals[field]} | ${rerun === null ? NOT_RUN : rerun.totals[field]} |`,
    ),
    '',
    '## Expected failures',
    '',
    '| Bundle | Spec | Expected | Observed | Re-run | Cause | Source |',
    '|---|---|---|---|---|---|---|',
    ...expected.failures.map((entry) => {
      const id = groupLabel(entry.bundle, entry.spec, entry.specPattern);
      const spec = entry.spec !== undefined ? cell(entry.spec) : code(entry.specPattern ?? '');
      const again = rerun === null ? NOT_RUN : groupCount(rerun.failures, id);
      const cause = entry.timingSensitive === true ? `${entry.cause} (timing-sensitive: a pass triggers one re-run)` : entry.cause;
      const source = code(`${entry.source.path}:${entry.source.lines}`);
      return `| ${code(entry.bundle)} | ${spec} | ${entry.count} | ${groupCount(diagnostic.failures, id)} | ${again} | ${cell(cause)} | ${source} |`;
    }),
    '',
    '## Runners',
    '',
    '| Runner | URL | Expected | Observed |',
    '|---|---|---|---|',
    `| Official | ${code(officialRunner.url)} | HTTP ${officialRunner.expectedHttpStatus}, ${officialRunner.expectedSpecs} specs (directory discovery compiles ${excludedNames}) | HTTP ${officialRunner.httpStatus}, ${officialRunner.specs} specs |`,
    `| Diagnostic | ${code(diagnostic.url)} | ${expected.totals.bundles} named bundles, ${expected.totals.specs} specs | ${diagnostic.totals.bundles} bundles, ${diagnostic.totals.specs} specs |`,
    '',
    '## Excluded bundle',
    '',
    '| Bundle | Reason | Source |',
    '|---|---|---|',
    ...expected.excludedBundles.map(
      (entry) => `| ${code(entry.bundle)} | ${cell(entry.reason)} | ${code(`${entry.source.path}:${entry.source.lines}`)} |`,
    ),
    '',
    'The diagnostic names its bundles explicitly, so it never compiles an excluded bundle; one reported anyway is an `unexpected-bundle` difference.',
    '',
    '## Differences',
    '',
    ...differenceLines(report),
    '',
    '## Result legend',
    '',
    '- `match` (exit 0): observed totals and failure names equal the expected.',
    `- \`timing-variance\` (exit 3): only the timing-sensitive ${timingNames.join(', ')} spec differs, and still does after one re-run; later stages continue, the baseline item is reported unmet.`,
    '- `mismatch` (exit 1): any other difference; later stages stop.',
    '',
    'Failures are reported, never fixed.',
  ];
}

const sourceRefSchema = z.looseObject({ path: z.string(), lines: z.array(z.number()) });

/** Shape of `expected-baseline.json`; each failure group names its spec by exactly one of `title` and `titlePattern`. */
const expectedBaselineSchema: z.ZodType<ExpectedBaseline> = z.looseObject({
  sourceSha: z.string(),
  provenance: z.string(),
  totals: z.looseObject({
    bundles: z.number().int(),
    specs: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    errored: z.number().int(),
  }),
  bundles: z.array(z.string()),
  failures: z.array(
    z
      .looseObject({
        bundle: z.string(),
        suite: z.string().optional(),
        count: z.number().int(),
        timingSensitive: z.boolean().optional(),
        thresholdMs: z.number().optional(),
        observedMs: z.array(z.number()).optional(),
        reason: z.string(),
        source: sourceRefSchema,
        title: z.string().optional(),
        titlePattern: z.string().optional(),
      })
      .refine((group) => (group.title === undefined) !== (group.titlePattern === undefined), {
        error: 'needs exactly one of title and titlePattern',
      })
      .transform((group) => group as ExpectedFailureGroup),
  ),
  excludedBundles: z.array(z.looseObject({ bundle: z.string(), reason: z.string(), source: sourceRefSchema })),
  officialRunner: z.looseObject({
    url: z.string(),
    expectedHttpStatus: z.number().int(),
    expectedSpecs: z.number().int(),
    reason: z.string(),
  }),
});

/** Envelope of a saved runner response; `body` stays unknown so a body that is not TestBox JSON is a reported difference. */
const savedRunnerSchema: z.ZodType<SavedRunnerResponse> = z.looseObject({
  runner: z.enum(['official', 'diagnostic']),
  url: z.string(),
  httpStatus: z.number().int(),
  contentType: z.string().nullable(),
  startedAt: z.string(),
  durationMs: z.number(),
  bodyKind: z.enum(['json', 'text']),
  specs: z.number(),
  body: z.unknown(),
});

async function readExpected(file: string): Promise<ExpectedBaseline> {
  return readJson(file, expectedBaselineSchema);
}

async function readSaved(file: string): Promise<SavedRunnerResponse> {
  try {
    return await readJson(file, savedRunnerSchema);
  } catch (err) {
    const cause = (err as Error).cause as NodeJS.ErrnoException | undefined;
    if (cause?.code === 'ENOENT') throw new Error(`${file} is missing: run baseline:run first`, { cause: err });
    throw err;
  }
}

/**
 * Compares the saved diagnostic run with the expected baseline, re-running the diagnostic once when the only
 * difference is timing, then writes `baseline.json`, its byte-identical setup copy and `baseline.md`.
 */
export async function compareBaseline(deps: CompareDeps = {}): Promise<CompareResult> {
  const env = deps.env ?? process.env;
  const expectedPath = deps.expectedPath ?? repoPath(EXPECTED_BASELINE_PATH);
  const masaBaselinePath = deps.masaBaselinePath ?? MASA_BASELINE_PATH;
  const expected = await readExpected(expectedPath);
  const dir = baselineStateDir(env);
  const official = await readSaved(path.join(dir, 'official.json'));
  const diagnostic = await readSaved(path.join(dir, 'diagnostic.json'));

  const observed = flattenTestBox(diagnostic.body);
  const differences = diffBaseline(expected, observed, official, diagnostic);
  let decided = { totals: observed.totals, differences };
  let rerun: RerunRecord | null = null;
  let result: BaselineResult;
  if (differences.length === 0) {
    result = 'match';
  } else if (!isTimingOnly(differences, expected)) {
    result = 'mismatch';
  } else {
    const again = await (deps.runDiagnostic ?? runDiagnostic)({ rerun: true }, { env });
    const reobserved = flattenTestBox(again.body);
    const redifferences = diffBaseline(expected, reobserved, official, again);
    result = redifferences.length === 0 ? 'match' : isTimingOnly(redifferences, expected) ? 'timing-variance' : 'mismatch';
    rerun = {
      reason: RERUN_REASON,
      startedAt: again.startedAt,
      totals: reobserved.totals,
      failures: observedFailures(expected, reobserved),
      differences: redifferences,
      result,
    };
    decided = { totals: reobserved.totals, differences: redifferences };
  }

  const now = deps.now ?? (() => new Date());
  const body = buildBaselineReport({ expected, expectedPath, masaBaselinePath, official, observed, differences, rerun, result, generatedAt: now() });
  const reports = reportsDir(env);
  const written = await writeJsonReport(path.join(reports, 'baseline.json'), body);
  await mkdir(path.dirname(masaBaselinePath), { recursive: true });
  await copyFile(written.path, masaBaselinePath);
  const report = written.body as BaselineReport;
  await writeMarkdown(path.join(reports, 'baseline.md'), REPORT_TITLE, renderBaselineMarkdown(report));

  const summary: CompareSummary = {
    result,
    totals: decided.totals,
    differences: decided.differences.length,
    rerun: rerun !== null,
    doneWhenMet: result === 'match',
  };
  return { code: EXIT_CODES[result], summary, report };
}

/** CLI entry: takes no flags; exits 0 on `match`, 3 on `timing-variance`, 1 on `mismatch`. */
export const main = async (argv: string[], deps: CompareDeps = {}): Promise<CliOutcome> => {
  parseFlags(argv, { options: {}, usage: USAGE });
  const { code: exitCode, summary } = await compareBaseline(deps);
  return { code: exitCode, summary };
};

if (isMainModule(import.meta.url)) void runCli(main);
