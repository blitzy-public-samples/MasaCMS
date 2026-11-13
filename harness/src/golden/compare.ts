// Compares each golden set with its replay output through the one normaliser and writes the parity report.
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@opt2/platform/logging';
import { z } from '@opt2/platform/service-kit';
import {
  EXCEPTIONS_LIST_PATH,
  goldenRun,
  goldenSetPath,
  readGoldenSet,
  type GoldenSet,
  type GoldenSideEffects,
} from './capture.js';
import {
  CATALOGUE_PATH,
  FIXTURES_UNAVAILABLE,
  SERVICES,
  decisionRefs,
  exceptionRefs,
  isRehearsalScenario,
  loadCatalogue,
  readFixtureStatus,
  skipReason,
  type Catalogue,
  type FixtureStatus,
  type Scenario,
  type ServiceName,
  type StepExpectation,
} from './catalogue.js';
import { GoldenConfigError, haltEvidence, type DifferenceSelector, type ExceptionEntry } from './errors.js';
import { KNOWN_ISSUE_IDS, compareNormalised, type Difference } from './normalise/index.js';
import { RULES_PATH, loadRules, type NormaliseRules } from './normalise/rules.js';
import {
  GENERATED_BY as REPLAYED_BY,
  replayOutputPath,
  replayOutputSchema,
  type ReplayHalt,
  type ReplayOutput,
} from './replay.js';
import { originBaseUrl } from './session.js';
import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { safeDiagnostic } from '../lib/diagnostics.js';
import { createHarnessLogger } from '../lib/logger.js';
import { REPO_ROOT, opt2Path, reportsDir, stateDir, type EnvLike } from '../lib/paths.js';
import { pinnedSha } from '../lib/pin.js';
import { readJson, stableStringify, writeJsonReport, writeMarkdown } from '../lib/report.js';

/** `generatedBy` of the parity report. */
export const GENERATED_BY = 'harness/src/golden/compare.ts';

/** Title of `parity.md`. */
export const PARITY_TITLE = 'Parity report';

/** Title of `opt2/exceptions-list.md`. */
export const EXCEPTIONS_TITLE = 'Exceptions list';

/** The decision list withheld scenarios link to. */
export const DECISION_LIST_PATH: string = opt2Path('decision-list.json');

/** Cut-over version parity is judged under; the rehearsal scenarios replay under v0003. */
export const PARITY_TABLE_VERSION = 'v0002';

/** Services with a Masa legacy oracle: the only ones parity covers without the legacy fixtures. */
export const MIGRATED_SERVICES = [
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
] as const satisfies readonly ServiceName[];

/** Report item left unmet when the legacy fixtures are unavailable. */
export const UNMET_WITHOUT_FIXTURES = 'all ten services pass parity';

/** Result of one scenario, in report order. */
export const PARITY_RESULTS = [
  'pass',
  'fail',
  'excepted',
  'halted',
  'known-issue',
  'withheld',
  FIXTURES_UNAVAILABLE,
] as const;
export type ParityResult = (typeof PARITY_RESULTS)[number];

const FIXTURES_SOURCE = '${OPT2_STATE_DIR}/fixtures.json';
// Kept as a literal variable reference so the committed report holds no machine path.
const STATE_ROOT = '${OPT2_STATE_DIR}';
const BROWSER_ROOT = `${STATE_ROOT}/golden/browser`;
const DECISION_LIST_REF = 'opt2/decision-list.json';
const DECISION_LIST_LINK = '[decision-list.md](../decision-list.md)';
const EXCEPTIONS_LIST_LINK = '[exceptions-list.md](../exceptions-list.md)';
const PENDING_RUN = 'pending-run';
const DIFFERENCE_KINDS = ['changed', 'missing', 'extra', 'order', 'status'] as const;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** A difference as reported, with the exceptions entry that excuses it. */
export interface ParityDifference extends Difference {
  exceptionId?: string;
}

/** What {@link classifyScenario} decides for one scenario. */
export interface ScenarioVerdict {
  result: ParityResult;
  /** Why the scenario failed, halted or was skipped; `null` otherwise. */
  reason: string | null;
  differences: ParityDifference[];
  /** The halted case's entry, else the first entry excusing a difference. */
  exceptionId: string | null;
  /** Decision-list references of the withheld variants the scenario exercises. */
  decisionListRef: string[] | null;
}

/** One scenario row of the parity report. */
export interface ScenarioParity extends ScenarioVerdict {
  id: string;
  service: ServiceName;
  /** Repository- or `${OPT2_STATE_DIR}`-relative locations of the compared sides. */
  evidence: { golden: string; replay: string };
}

/** Counts per result; `total` counts every included scenario. */
export interface ParitySummary {
  total: number;
  pass: number;
  fail: number;
  excepted: number;
  halted: number;
  knownIssue: number;
  withheld: number;
  skipped: number;
}

/** One withheld scenario and decision-list entry, unmet until the user approves the proposal. */
export interface UnmetWithheld {
  id: string;
  decisionListRef: string | null;
  proposal: string | null;
}

/** Withheld and halted outcomes the catalogue declares before any run. */
export interface PlannedParity {
  provenance: 'planning';
  withheld: { scenario: string; routeKeys: string[]; decisionListRef: string[] }[];
  halted: { scenario: string; exceptionId: string; routeKeys: string[] }[];
}

/** Parity coverage when the legacy fixtures are unavailable. */
export interface ParityCoverage {
  servicesCovered: number;
  servicesTotal: number;
  unmet: string[];
}

/** `opt2/reports/parity.json`. */
export interface ParityReport {
  sourceSha: string;
  generatedBy: typeof GENERATED_BY;
  generatedAt: string;
  status: 'complete';
  replayedBy: string;
  tableVersion: typeof PARITY_TABLE_VERSION;
  fixtures: { available: boolean; reason: string | null; source: string };
  summary: ParitySummary;
  scenarios: ScenarioParity[];
  unmetWithheld: UnmetWithheld[];
  planned: PlannedParity;
  coverage?: ParityCoverage;
}

const nullableString = z.string().nullable();
const count = z.number().int().nonnegative();

/** Schema of the written `parity.json`. */
export const parityReportSchema = z.strictObject({
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character lowercase hex commit id'),
  generatedBy: z.literal(GENERATED_BY),
  generatedAt: z.iso.datetime(),
  status: z.literal('complete'),
  replayedBy: z.literal(REPLAYED_BY),
  tableVersion: z.literal(PARITY_TABLE_VERSION),
  fixtures: z.strictObject({ available: z.boolean(), reason: nullableString, source: z.literal(FIXTURES_SOURCE) }),
  summary: z.strictObject({
    total: count,
    pass: count,
    fail: count,
    excepted: count,
    halted: count,
    knownIssue: count,
    withheld: count,
    skipped: count,
  }),
  scenarios: z.array(
    z.strictObject({
      id: z.string().min(1),
      service: z.enum(SERVICES),
      result: z.enum(PARITY_RESULTS),
      reason: nullableString,
      differences: z.array(
        z.looseObject({
          step: z.string(),
          path: z.string(),
          kind: z.enum(DIFFERENCE_KINDS),
          classification: z.enum(['difference', 'known-issue']),
          maskId: z.enum(KNOWN_ISSUE_IDS).optional(),
          exceptionId: z.string().optional(),
        }),
      ),
      exceptionId: nullableString,
      decisionListRef: z.array(z.string()).nullable(),
      evidence: z.strictObject({ golden: z.string().min(1), replay: z.string().min(1) }),
    }),
  ),
  unmetWithheld: z.array(
    z.strictObject({ id: z.string().min(1), decisionListRef: nullableString, proposal: nullableString }),
  ),
  planned: z.strictObject({
    provenance: z.literal('planning'),
    withheld: z.array(
      z.strictObject({ scenario: z.string(), routeKeys: z.array(z.string()), decisionListRef: z.array(z.string()) }),
    ),
    halted: z.array(z.strictObject({ scenario: z.string(), exceptionId: z.string(), routeKeys: z.array(z.string()) })),
  }),
  coverage: z.strictObject({ servicesCovered: count, servicesTotal: count, unmet: z.array(z.string()) }).optional(),
});

const decisionListSchema = z.looseObject({
  actionVariants: z.array(z.looseObject({ routeKey: z.string().min(1), proposal: z.string() })).default(() => []),
  tables: z
    .array(
      z.looseObject({
        table: z.string().min(1),
        proposedOwner: z.string(),
        reason: z.string(),
        // Site-monitor job steps have no route key.
        withheldEntryPoints: z.array(z.looseObject({ routeKey: z.string().min(1).nullable() })).default(() => []),
      }),
    )
    .default(() => []),
});
/** The decision-list fields compare reads. */
export type DecisionList = z.output<typeof decisionListSchema>;

/** Reads the decision list at `file`. */
export function loadDecisionList(file: string = DECISION_LIST_PATH): Promise<DecisionList> {
  return readJson(file, decisionListSchema);
}

const selectorSchema: z.ZodType<DifferenceSelector> = z.strictObject({
  step: z.string().min(1),
  path: z.string().min(1),
  kind: z.array(z.enum(DIFFERENCE_KINDS)).min(1).optional(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
});

const exceptionEntrySchema: z.ZodType<ExceptionEntry> = z.looseObject({
  id: z.string().min(1),
  scenario: z.string().min(1),
  routeKey: z.string().min(1),
  appliesTo: z.array(z.string()).optional(),
  difference: z.string(),
  matches: z.array(selectorSchema).min(1).optional(),
  decision: z.enum(['preserve', 'fix']),
  reason: z.string(),
  status: z.enum(['open', 'accepted', 'halted']),
  evidence: z.looseObject({ golden: z.string(), replay: z.string() }),
  sourceSha: z.string(),
});

/** The exceptions list as stored: `{…, entries}` or a bare array of entries. */
export type ExceptionsList = ExceptionEntry[] | { entries: ExceptionEntry[]; [key: string]: unknown };

const exceptionsListSchema: z.ZodType<ExceptionsList> = z.union([
  z.array(exceptionEntrySchema),
  z.looseObject({ entries: z.array(exceptionEntrySchema) }),
]);

/** Reads the exceptions list at `file`; compare only reads it, never changes an entry. */
export function loadExceptionsList(file: string = EXCEPTIONS_LIST_PATH): Promise<ExceptionsList> {
  return readJson(file, exceptionsListSchema);
}

/** The entries of `list` in stored order. */
export function exceptionEntries(list: ExceptionsList): ExceptionEntry[] {
  return Array.isArray(list) ? list : list.entries;
}

/** `entry.routeKey` followed by its `appliesTo` keys. */
export function entryRouteKeys(entry: Pick<ExceptionEntry, 'routeKey' | 'appliesTo'>): string[] {
  return [entry.routeKey, ...(entry.appliesTo ?? [])];
}

/** Whether `entry` may excuse differences: an accepted entry or an open `preserve`, never halted or an open `fix`. */
export function isExcepting(entry: Pick<ExceptionEntry, 'decision' | 'status'>): boolean {
  return entry.status === 'accepted' || (entry.status === 'open' && entry.decision === 'preserve');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep-partial equality: primitives strictly, arrays element-wise at equal length, objects on the pattern's keys. */
function partialEqual(pattern: unknown, value: unknown): boolean {
  if (Array.isArray(pattern)) {
    return (
      Array.isArray(value) && value.length === pattern.length && pattern.every((p, i) => partialEqual(p, value[i]))
    );
  }
  if (isPlainObject(pattern)) {
    return (
      isPlainObject(value) &&
      Object.entries(pattern).every(([key, p]) => partialEqual(p, Object.hasOwn(value, key) ? value[key] : undefined))
    );
  }
  return pattern === value;
}

/** Whether `selector` describes `difference`: its step, its path or a parent of it, and the kinds and values given. */
export function selectorMatches(selector: DifferenceSelector, difference: Difference): boolean {
  const { path: at } = difference;
  const atPath = at === selector.path || at.startsWith(`${selector.path}.`) || at.startsWith(`${selector.path}[`);
  return (
    selector.step === difference.step &&
    atPath &&
    (selector.kind === undefined || selector.kind.includes(difference.kind)) &&
    (selector.expected === undefined || partialEqual(selector.expected, difference.expected)) &&
    (selector.actual === undefined || partialEqual(selector.actual, difference.actual))
  );
}

const differenceSchema = z
  .looseObject({
    step: z.string(),
    path: z.string(),
    kind: z.enum(DIFFERENCE_KINDS),
    // Written as JSON, a `missing` value's `actual` and an `extra` value's `expected` are absent.
    expected: z.unknown().optional(),
    actual: z.unknown().optional(),
    classification: z.enum(['difference', 'known-issue']),
    maskId: z.enum(KNOWN_ISSUE_IDS).optional(),
  })
  .transform(
    (d): Difference => ({
      step: d.step,
      path: d.path,
      kind: d.kind,
      expected: d.expected,
      actual: d.actual,
      classification: d.classification,
      ...(d.maskId === undefined ? {} : { maskId: d.maskId }),
    }),
  );

/** Name of the step holding a browser flow's resulting DOM, on both the captured and the replayed side. */
export const BROWSER_FINAL_STEP = 'final-dom';

/**
 * Record the browser interaction suite writes for a browser scenario: its gateway replay output, its
 * {@link browserDifferences} against the capture, and the target's console, notes and off-origin XHRs. `result` is
 * informational.
 */
export interface BrowserRecord extends ReplayOutput {
  differences: Difference[];
  console: string[];
  notes: string[];
  foreignOrigins: { step: string; origin: string }[];
  result?: string;
}

// Typed by key so a field added to ReplayOutput is picked for its schema too.
const REPLAY_OUTPUT_KEYS = Object.keys({
  sourceSha: true,
  scenarioId: true,
  replayedAt: true,
  origin: true,
  tableVersion: true,
  skipped: true,
  steps: true,
  sideEffects: true,
  halted: true,
  error: true,
  generatedBy: true,
  generatedAt: true,
} satisfies Record<keyof ReplayOutput, true>);

/** Schema of a {@link BrowserRecord}; its replay output fields are checked by `replayOutputSchema`. */
export const browserRecordSchema: z.ZodType<BrowserRecord> = z
  .looseObject({
    result: z.string().optional(),
    differences: z.array(differenceSchema),
    console: z.array(z.string()),
    notes: z.array(z.string()),
    foreignOrigins: z.array(z.strictObject({ step: z.string().min(1), origin: z.string().min(1) })),
  })
  .transform((record, ctx) => {
    const fields = REPLAY_OUTPUT_KEYS.filter((key) => key in record).map((key) => [key, record[key]]);
    const replay = replayOutputSchema.safeParse(Object.fromEntries(fields));
    if (!replay.success) {
      for (const { message, path: at } of replay.error.issues) ctx.addIssue({ code: 'custom', message, path: at });
      return z.NEVER;
    }
    const { result, differences, notes, foreignOrigins } = record;
    return {
      ...replay.data,
      differences,
      console: record.console,
      notes,
      foreignOrigins,
      ...(result === undefined ? {} : { result }),
    };
  });

/** Path of browser scenario `id`'s record, `<stateDir>/golden/browser/<id>.json`, outside the checkout. */
export function browserResultPath(id: string, env: EnvLike = process.env): string {
  return path.join(stateDir(env), 'golden', 'browser', `${id}.json`);
}

/** Step name of the console differences {@link browserDifferences} reports. */
export const BROWSER_CONSOLE_STEP = 'console';

const NO_SIDE_EFFECTS: GoldenSideEffects = { mail: [], rows: {}, tasks: [], files: [] };
const CONSOLE_NOT_STRINGS = `golden set's ${BROWSER_FINAL_STEP} console is not a list of strings`;

/** Console errors the capture's final DOM step records: `[]` when absent, `null` when not a list of strings. */
function capturedConsole(golden: Pick<GoldenSet, 'steps'>): string[] | null {
  const final = golden.steps.find((step) => step.name === BROWSER_FINAL_STEP)?.normalised;
  const value = final !== undefined && 'console' in final ? final.console : undefined;
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string') ? value : null;
}

/** An unlisted difference on `step` at `at`. */
function unlistedDifference(
  step: string,
  at: string,
  kind: Difference['kind'],
  expected: unknown,
  actual: unknown,
): Difference {
  return { step, path: at, kind, expected, actual, classification: 'difference' };
}

/** Inputs of {@link browserDifferences} beyond the two compared sides. */
export interface BrowserDifferenceOptions {
  scenario: Scenario;
  rules: NormaliseRules;
  /** Origin every replayed XHR must address. */
  gatewayOrigin: string;
}

/**
 * Differences of a browser replay against its capture: the normaliser's, paired steps' route keys, console errors the
 * capture did not raise (a multiset) and XHRs off `gatewayOrigin`. Throws `GoldenConfigError` for a non-string console.
 */
export function browserDifferences(
  golden: Pick<GoldenSet, 'steps'>,
  record: Pick<BrowserRecord, 'steps' | 'console' | 'foreignOrigins'>,
  opts: BrowserDifferenceOptions,
): Difference[] {
  const legacyConsole = capturedConsole(golden);
  if (legacyConsole === null) throw new GoldenConfigError(CONSOLE_NOT_STRINGS);
  const found = compareNormalised(
    goldenRun({ steps: golden.steps, sideEffects: NO_SIDE_EFFECTS }),
    goldenRun({ steps: record.steps, sideEffects: NO_SIDE_EFFECTS }),
    { rules: opts.rules, scenario: opts.scenario },
  );
  const legacyKeys = new Map(golden.steps.map((step) => [`${step.index}|${step.name}`, step.routeKey]));
  for (const step of record.steps) {
    const expected = legacyKeys.get(`${step.index}|${step.name}`);
    if (expected !== undefined && expected !== step.routeKey) {
      found.push(unlistedDifference(step.name, 'routeKey', 'changed', expected, step.routeKey));
    }
  }
  const remaining = new Map<string, number>();
  for (const message of legacyConsole) remaining.set(message, (remaining.get(message) ?? 0) + 1);
  record.console.forEach((message, i) => {
    const left = remaining.get(message) ?? 0;
    if (left > 0) remaining.set(message, left - 1);
    else found.push(unlistedDifference(BROWSER_CONSOLE_STEP, `console[${i}]`, 'extra', undefined, message));
  });
  for (const { step, origin } of record.foreignOrigins) {
    found.push(unlistedDifference(step, 'request.origin', 'changed', opts.gatewayOrigin, origin));
  }
  return found;
}

/** The step fields classification reads, common to golden, replay and browser steps. */
interface RecordedStep {
  name: string;
  routeKey: string;
  expected?: StepExpectation;
  decisionListRef?: string;
  exceptionId?: string;
  gap?: { reason: string };
}

interface DecisionIndex {
  refsByRouteKey: Map<string, string[]>;
  proposals: Map<string, string>;
}

/** Decision-list references per route key, its action variant first, then every table withholding it. */
function indexDecisionList(list: DecisionList): DecisionIndex {
  const refsByRouteKey = new Map<string, string[]>();
  const proposals = new Map<string, string>();
  const add = (routeKey: string, ref: string): void => {
    const refs = refsByRouteKey.get(routeKey) ?? [];
    if (!refs.includes(ref)) refsByRouteKey.set(routeKey, [...refs, ref]);
  };
  for (const variant of list.actionVariants) {
    const ref = `${DECISION_LIST_REF}#actionVariants/${variant.routeKey}`;
    add(variant.routeKey, ref);
    proposals.set(ref, variant.proposal);
  }
  for (const table of list.tables) {
    const ref = `${DECISION_LIST_REF}#tables/${table.table}`;
    proposals.set(ref, `Proposed owner: ${table.proposedOwner}. ${table.reason}`);
    for (const entry of table.withheldEntryPoints) if (entry.routeKey !== null) add(entry.routeKey, ref);
  }
  return { refsByRouteKey, proposals };
}

function unique<T>(values: Iterable<T | undefined>): T[] {
  return [...new Set([...values].filter((value): value is T => value !== undefined))];
}

/** References of `routeKeys`; throws `GoldenConfigError` for a key the decision list does not withhold. */
function resolveDecisionRefs(routeKeys: readonly string[], index: DecisionIndex, scenarioId: string): string[] {
  return unique(
    routeKeys.flatMap((routeKey) => {
      const refs = index.refsByRouteKey.get(routeKey);
      if (refs === undefined) {
        throw new GoldenConfigError(
          `${scenarioId}: decisionListRef ${routeKey} names no action variant or withheld table entry point of ` +
            `${DECISION_LIST_REF}`,
          { path: `scenario ${scenarioId}` },
        );
      }
      return refs;
    }),
  );
}

function declaresWithheld(scenario: Scenario): boolean {
  return scenario.expected === 'withheld' || scenario.steps.some((step) => step.expected === 'withheld');
}

function declaresHalted(scenario: Scenario): boolean {
  return scenario.expected === 'halted' || scenario.steps.some((step) => step.expected === 'halted');
}

/** Inputs of {@link classifyScenario} beyond the two compared sides. */
export interface ClassifyOptions {
  scenario: Scenario;
  exceptions: readonly ExceptionEntry[];
  rules: NormaliseRules;
  decisionList: DecisionList;
  /** A fixture-dependent scenario is skipped when these are unavailable. */
  fixtures?: Pick<FixtureStatus, 'available' | 'reason'>;
  /** The interaction suite's record of a browser scenario; `null` or absent when it has not run. */
  browser?: BrowserRecord | null;
  /** SHA the capture and its replay or browser record carry, and the replay's version; default pin and scenario's. */
  expected?: { sourceSha?: string; tableVersion?: string };
  /** Origin a browser record's XHRs must address; default the gateway's. */
  gatewayOrigin?: string;
  /** Why a side could not be read; stated instead of "missing". */
  readErrors?: { golden?: string; replay?: string };
}

/** The differences, steps and halts of one compared scenario, or why there is nothing to compare. */
type Observed = { error: string } | { differences: Difference[]; steps: RecordedStep[]; halted: ReplayHalt[] };

function failedRun(what: string, error: { message: string; step?: string }): string {
  return `${what} failed${error.step === undefined ? '' : ` at ${error.step}`}: ${error.message}`;
}

function hasFinalDom(steps: readonly RecordedStep[]): boolean {
  return steps.some((step) => step.name === BROWSER_FINAL_STEP);
}

/** Why `golden` is not a legacy capture of the scenario at the expected SHA; `null` when it is. */
function captureGap(golden: GoldenSet, opts: ClassifyOptions, label: string): string | null {
  const { id } = opts.scenario;
  const pin = opts.expected?.sourceSha ?? pinnedSha();
  if (golden.scenarioId !== id) return `golden set holds scenario ${golden.scenarioId}, not ${id}`;
  if (golden.origin !== 'legacy' || golden.tableVersion !== null) {
    const found = `origin ${String(golden.origin)}, tableVersion ${String(golden.tableVersion)}`;
    return `golden set is not a legacy capture (${found})`;
  }
  if (golden.sourceSha !== pin) return `${label} was taken at ${golden.sourceSha}, not the pinned ${pin}`;
  return null;
}

/** Why `replay` is not a gateway replay of the scenario at the expected SHA and version; `null` when it is. */
function replayGap(replay: ReplayOutput, opts: ClassifyOptions, label: string): string | null {
  const { id, tableVersion } = opts.scenario;
  const pin = opts.expected?.sourceSha ?? pinnedSha();
  const version = opts.expected?.tableVersion ?? tableVersion;
  if (replay.scenarioId !== id) return `${label} holds scenario ${replay.scenarioId}, not ${id}`;
  if (replay.origin !== 'gateway') {
    return `${label} was not replayed through the gateway (origin ${String(replay.origin)})`;
  }
  if (replay.sourceSha !== pin) return `${label} was replayed at ${replay.sourceSha}, not the pinned ${pin}`;
  if (replay.tableVersion !== version) return `${label} was replayed under ${replay.tableVersion}, not ${version}`;
  return null;
}

/** Why the HTTP sides present are not the scenario's capture and replay; `null` when they are. */
function evidenceGap(golden: GoldenSet | null, replay: ReplayOutput | null, opts: ClassifyOptions): string | null {
  return (
    (golden === null ? null : captureGap(golden, opts, 'capture')) ??
    (replay === null ? null : replayGap(replay, opts, 'replay output'))
  );
}

/** Why `golden` and `record` do not evidence one completed flow of the scenario; `null` when they do. */
function browserEvidenceGap(golden: GoldenSet, record: BrowserRecord, opts: ClassifyOptions): string | null {
  const captured = captureGap(golden, opts, 'browser capture');
  if (captured !== null) return captured;
  if (!hasFinalDom(golden.steps)) return `golden set holds no ${BROWSER_FINAL_STEP} step`;
  if (capturedConsole(golden) === null) return CONSOLE_NOT_STRINGS;
  const replayed = replayGap(record, opts, 'browser record');
  if (replayed !== null) return replayed;
  if (record.steps.length === 0) return 'browser record holds no steps';
  if (!hasFinalDom(record.steps)) return `browser record holds no ${BROWSER_FINAL_STEP} step`;
  return null;
}

/** Whether `a` and `b` hold the same differences, in any order. */
function sameDifferences(a: readonly Difference[], b: readonly Difference[]): boolean {
  const keys = (list: readonly Difference[]): string[] => list.map((d) => stableStringify(d)).sort();
  const [left, right] = [keys(a), keys(b)];
  return left.length === right.length && left.every((key, i) => key === right[i]);
}

function observe(golden: GoldenSet | null, replay: ReplayOutput | null, opts: ClassifyOptions): Observed {
  const { scenario, readErrors } = opts;
  const evidence = haltEvidence(scenario.id);
  if (scenario.browser !== undefined) {
    if (golden === null) return { error: readErrors?.golden ?? `no golden set at ${evidence.golden}` };
    const record = opts.browser ?? null;
    if (record === null) return { error: readErrors?.replay ?? 'browser flow not run' };
    if (record.error !== undefined) return { error: failedRun('browser flow', record.error) };
    const gap = browserEvidenceGap(golden, record, opts);
    if (gap !== null) return { error: gap };
    const gatewayOrigin = opts.gatewayOrigin ?? new URL(originBaseUrl('gateway')).origin;
    const differences = browserDifferences(golden, record, { scenario, rules: opts.rules, gatewayOrigin });
    if (!sameDifferences(record.differences, differences)) {
      const counts = `${record.differences.length} recorded, ${differences.length} recomputed`;
      return { error: `browser record differences disagree with its exchanges against the capture (${counts})` };
    }
    return { differences, steps: record.steps, halted: record.halted };
  }
  if (golden === null) return { error: readErrors?.golden ?? `no golden set at ${evidence.golden}` };
  if (replay === null) return { error: readErrors?.replay ?? `no replay output at ${evidence.replay}` };
  if (replay.error !== undefined) return { error: failedRun('replay', replay.error) };
  const gap = evidenceGap(golden, replay, opts);
  if (gap !== null) return { error: gap };
  const differences = compareNormalised(goldenRun(golden), goldenRun(replay), { rules: opts.rules, scenario });
  return { differences, steps: [...golden.steps, ...replay.steps], halted: replay.halted };
}

function skipCause(golden: GoldenSet | null, replay: ReplayOutput | null, opts: ClassifyOptions): string | null {
  const { scenario, fixtures } = opts;
  if (fixtures !== undefined && skipReason(scenario, fixtures) !== null) {
    return fixtures.reason ?? 'the legacy fixtures are unavailable';
  }
  // A skip marker counts only on the scenario's own evidence; observe fails any other.
  if (evidenceGap(golden, replay, opts) !== null) return null;
  if (golden?.skipped !== undefined) return 'the golden set was captured without the legacy fixtures';
  if (replay?.skipped !== undefined) return 'the replay ran without the legacy fixtures';
  return null;
}

/** Tags each difference with the first excepting, route-eligible entry of the scenario whose selector describes it. */
function exceptDifferences(
  differences: readonly Difference[],
  steps: readonly RecordedStep[],
  scenarioId: string,
  exceptions: readonly ExceptionEntry[],
): ParityDifference[] {
  const excepting = exceptions.filter((entry) => entry.scenario === scenarioId && isExcepting(entry));
  const byStep = new Map<string, Set<string>>();
  for (const step of steps) byStep.set(step.name, (byStep.get(step.name) ?? new Set()).add(step.routeKey));
  const scenarioKeys = new Set(steps.map((step) => step.routeKey));
  return differences.map((difference) => {
    if (difference.classification === 'known-issue') return difference;
    // A side-effect or console difference names no recorded step, so the scenario's route keys stand in.
    const keys = byStep.get(difference.step) ?? scenarioKeys;
    const entry = excepting.find(
      (candidate) =>
        entryRouteKeys(candidate).some((key) => keys.has(key)) &&
        (candidate.matches ?? []).some((selector) => selectorMatches(selector, difference)),
    );
    return entry === undefined ? difference : { ...difference, exceptionId: entry.id };
  });
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Classifies one scenario. Precedence: skipped; nothing to compare, a failed run, or evidence of another scenario,
 * SHA or version (`fail`); any difference neither masked nor excused (`fail`); a halted case (`halted`); a withheld
 * variant (`withheld`); then `excepted`, `known-issue`, `pass`. A browser scenario compares `opts.browser`'s
 * exchanges with `golden` in place of `replay`.
 * Throws `GoldenConfigError` when a withheld route key is not on the decision list.
 */
export function classifyScenario(
  golden: GoldenSet | null,
  replay: ReplayOutput | null,
  opts: ClassifyOptions,
): ScenarioVerdict {
  const { scenario } = opts;
  const recorded: RecordedStep[] = [...(golden?.steps ?? []), ...(replay?.steps ?? []), ...(opts.browser?.steps ?? [])];
  const withheldKeys = unique([
    ...decisionRefs(scenario),
    ...recorded.filter((step) => step.expected === 'withheld').map((step) => step.decisionListRef),
  ]);
  const refs = resolveDecisionRefs(withheldKeys, indexDecisionList(opts.decisionList), scenario.id);
  const verdict = (
    result: ParityResult,
    reason: string | null,
    differences: ParityDifference[] = [],
    exceptionId: string | null = null,
  ): ScenarioVerdict => ({
    result,
    reason,
    differences,
    exceptionId,
    decisionListRef: refs.length > 0 ? refs : null,
  });

  const skipped = skipCause(golden, replay, opts);
  if (skipped !== null) return verdict(FIXTURES_UNAVAILABLE, skipped);
  const observed = observe(golden, replay, opts);
  if ('error' in observed) return verdict('fail', observed.error);

  const differences = exceptDifferences(observed.differences, observed.steps, scenario.id, opts.exceptions);
  const counted = differences.filter((d) => d.classification === 'difference' && d.exceptionId === undefined);
  const excepted = differences.filter((d) => d.exceptionId !== undefined);
  const haltSteps = observed.steps.filter((step) => step.expected === 'halted' || step.gap !== undefined);
  const haltIds = unique([
    ...observed.halted.map((halt) => halt.exceptionId),
    ...haltSteps.map((step) => step.exceptionId),
    ...exceptionRefs(scenario),
  ]);
  const exceptionId = haltIds[0] ?? excepted[0]?.exceptionId ?? null;

  if (counted.length > 0) {
    return verdict('fail', plural(counted.length, 'unlisted difference'), differences, exceptionId);
  }
  if (observed.halted.length > 0 || haltSteps.length > 0 || declaresHalted(scenario)) {
    const reason = observed.halted[0]?.reason ?? haltSteps.find((step) => step.gap !== undefined)?.gap?.reason;
    return verdict('halted', reason ?? 'declared halted; served by legacy', differences, exceptionId);
  }
  if (refs.length > 0 || declaresWithheld(scenario)) return verdict('withheld', null, differences, exceptionId);
  if (excepted.length > 0) return verdict('excepted', null, differences, exceptionId);
  if (differences.length > 0) return verdict('known-issue', null, differences);
  return verdict('pass', null, differences);
}

/** `verdict` as a report row of `scenario`. */
export function toScenarioParity(
  scenario: Pick<Scenario, 'id' | 'service' | 'browser'>,
  verdict: ScenarioVerdict,
): ScenarioParity {
  const { golden, replay } = haltEvidence(scenario.id);
  const browserRecord = `${BROWSER_ROOT}/${scenario.id}.json`;
  return {
    id: scenario.id,
    service: scenario.service,
    ...verdict,
    evidence: { golden, replay: scenario.browser === undefined ? replay : browserRecord },
  };
}


/** Inputs of {@link buildParityReport}. */
export interface ParityReportInputs {
  catalogue: Pick<Catalogue, 'scenarios'>;
  /** Classified scenarios; reported in catalogue order. */
  scenarios: readonly ScenarioParity[];
  fixtures: Pick<FixtureStatus, 'available' | 'reason'>;
  decisionList: DecisionList;
  exceptions: readonly ExceptionEntry[];
  /** Default the pinned SHA. */
  sourceSha?: string;
  clock?: () => Date;
}

const SUMMARY_KEYS: Readonly<Record<ParityResult, keyof Omit<ParitySummary, 'total'>>> = {
  pass: 'pass',
  fail: 'fail',
  excepted: 'excepted',
  halted: 'halted',
  'known-issue': 'knownIssue',
  withheld: 'withheld',
  [FIXTURES_UNAVAILABLE]: 'skipped',
};

function summarise(scenarios: readonly ScenarioParity[]): ParitySummary {
  const summary: ParitySummary = {
    total: scenarios.length,
    pass: 0,
    fail: 0,
    excepted: 0,
    halted: 0,
    knownIssue: 0,
    withheld: 0,
    skipped: 0,
  };
  for (const scenario of scenarios) summary[SUMMARY_KEYS[scenario.result]] += 1;
  return summary;
}

/** The catalogue's declared withheld and halted outcomes, in catalogue order. */
function plannedParity(
  scenarios: readonly Scenario[],
  index: DecisionIndex,
  exceptions: readonly ExceptionEntry[],
): PlannedParity {
  const withheld = scenarios.filter(declaresWithheld).map((scenario) => {
    const routeKeys = decisionRefs(scenario);
    return { scenario: scenario.id, routeKeys, decisionListRef: resolveDecisionRefs(routeKeys, index, scenario.id) };
  });
  const halted = scenarios.flatMap((scenario) =>
    exceptionRefs(scenario).map((exceptionId) => {
      const entry = exceptions.find((candidate) => candidate.id === exceptionId);
      return { scenario: scenario.id, exceptionId, routeKeys: entry === undefined ? [] : entryRouteKeys(entry) };
    }),
  );
  return { provenance: 'planning', withheld, halted };
}

/**
 * The parity report of `inputs`: scenarios in catalogue order with their summary, every withheld scenario's
 * decision-list entries and proposals, the catalogue's planned outcomes, and the coverage left when the legacy
 * fixtures are unavailable. Throws `GoldenConfigError` for a scenario the catalogue does not hold.
 */
export function buildParityReport(inputs: ParityReportInputs): ParityReport {
  const order = new Map(inputs.catalogue.scenarios.map((scenario, i) => [scenario.id, i]));
  const ranked = inputs.scenarios.map((scenario) => {
    const at = order.get(scenario.id);
    if (at === undefined) throw new GoldenConfigError(`parity report: catalogue has no scenario ${scenario.id}`);
    return { at, scenario };
  });
  const scenarios = ranked.sort((a, b) => a.at - b.at).map(({ scenario }) => scenario);
  const index = indexDecisionList(inputs.decisionList);
  const unmetWithheld = scenarios
    .filter((scenario) => scenario.result === 'withheld')
    .flatMap((scenario): UnmetWithheld[] =>
      scenario.decisionListRef === null
        ? [{ id: scenario.id, decisionListRef: null, proposal: null }]
        : scenario.decisionListRef.map((ref) => ({
            id: scenario.id,
            decisionListRef: ref,
            proposal: index.proposals.get(ref) ?? null,
          })),
    );
  const report: ParityReport = {
    sourceSha: inputs.sourceSha ?? pinnedSha(),
    generatedBy: GENERATED_BY,
    generatedAt: (inputs.clock ?? (() => new Date()))().toISOString(),
    status: 'complete',
    replayedBy: REPLAYED_BY,
    tableVersion: PARITY_TABLE_VERSION,
    fixtures: { available: inputs.fixtures.available, reason: inputs.fixtures.reason, source: FIXTURES_SOURCE },
    summary: summarise(scenarios),
    scenarios,
    unmetWithheld,
    planned: plannedParity(inputs.catalogue.scenarios, index, inputs.exceptions),
  };
  if (!inputs.fixtures.available) {
    report.coverage = {
      servicesCovered: MIGRATED_SERVICES.length,
      servicesTotal: SERVICES.length,
      unmet: [UNMET_WITHOUT_FIXTURES],
    };
  }
  return report;
}

/** `text` safe inside one Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replaceAll('|', '\\|');
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.map(cell).join(' | ')} |`;
}

function code(text: string): string {
  return `\`${text}\``;
}

function codes(values: readonly string[]): string {
  return values.map(code).join(', ');
}

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

const RESULT_LEGEND: readonly (readonly [ParityResult, string])[] = [
  ['pass', 'Replay matches the golden set after normalisation.'],
  [
    'fail',
    'An unlisted difference, or no golden set, replay output or browser record of the scenario, pin and version to compare.',
  ],
  ['excepted', 'The difference matches an exceptions entry.'],
  [
    'halted',
    '`EquivalenceImpossible`, recorded on `opt2/exceptions-list.json`; served by legacy and must still match its golden set.',
  ],
  ['known-issue', 'The difference is a masked known legacy issue.'],
  [
    'withheld',
    'Exercises a decision-list variant, so it ran against legacy through the gateway; unmet pending the user.',
  ],
  [FIXTURES_UNAVAILABLE, 'Needs the legacy fixtures, which are unavailable.'],
];

function differencesCell(differences: readonly ParityDifference[]): string {
  if (differences.length === 0) return '0';
  const excepted = differences.filter((d) => d.exceptionId !== undefined).length;
  const known = differences.filter((d) => d.classification === 'known-issue').length;
  const counted = differences.length - excepted - known;
  const parts = [
    ...(counted > 0 ? [`${counted} unlisted`] : []),
    ...(excepted > 0 ? [`${excepted} excepted`] : []),
    ...(known > 0 ? [`${known} known-issue`] : []),
  ];
  return `${differences.length} (${parts.join(', ')})`;
}

function referenceCell(exceptionId: string | null, decisionListRef: readonly string[] | null): string {
  const parts: string[] = [];
  if (exceptionId !== null) parts.push(`${EXCEPTIONS_LIST_LINK}: ${code(exceptionId)}`);
  if (decisionListRef !== null) parts.push(`${DECISION_LIST_LINK}: ${codes(decisionListRef)}`);
  return parts.join('; ');
}

function scenarioRow(scenario: ScenarioParity): string {
  const result = `${code(scenario.result)}${scenario.reason === null ? '' : `: ${scenario.reason}`}`;
  const reference = referenceCell(scenario.exceptionId, scenario.decisionListRef);
  const evidence = `golden ${code(scenario.evidence.golden)}, replay ${code(scenario.evidence.replay)}`;
  const cells = [
    `<a id="${scenario.id}"></a>${scenario.id}`,
    scenario.service,
    result,
    differencesCell(scenario.differences),
    reference === '' ? evidence : `${evidence}; ${reference}`,
  ];
  return tableRow(cells);
}

function fixturesLine(fixtures: ParityReport['fixtures']): string {
  const reason = fixtures.reason === null ? '' : ` (${fixtures.reason})`;
  return `Fixtures: ${fixtures.available ? 'available' : `unavailable${reason}`} (from ${code(fixtures.source)})`;
}

/** Body lines of `parity.md` for `writeMarkdown`, which adds the title and the `Source SHA:` line. */
export function renderParityMarkdown(report: ParityReport): string[] {
  const { summary } = report;
  const lines = [
    `Status: ${report.status}`,
    `Generated by: ${report.generatedBy}`,
    `Generated at: ${report.generatedAt}`,
    `Replayed by: ${report.replayedBy}`,
    `Table version: ${report.tableVersion} (GS-PE-RH-*: v0003)`,
    fixturesLine(report.fixtures),
    '',
    '## Result legend',
    '',
    '| Result | Meaning |',
    '|---|---|',
    ...RESULT_LEGEND.map(([result, meaning]) => tableRow([code(result), meaning])),
    '',
    '## Summary',
    '',
    '| Result | Count |',
    '|---|---|',
    `| total | ${summary.total} |`,
    ...PARITY_RESULTS.map((result) => `| ${code(result)} | ${summary[SUMMARY_KEYS[result]]} |`),
    '',
    '## Scenarios',
    '',
  ];
  if (report.scenarios.length === 0) {
    lines.push('No scenario was compared.');
  } else {
    lines.push('| ID | Service | Result | Differences | Evidence |', '|---|---|---|---|---|');
    lines.push(...report.scenarios.map(scenarioRow));
  }
  lines.push('', '## Unmet (withheld)', '');
  if (report.unmetWithheld.length === 0) {
    lines.push('None: no scenario is withheld.');
  } else {
    lines.push('| Scenario | Decision-list entry | Proposal |', '|---|---|---|');
    for (const unmet of report.unmetWithheld) {
      const ref = unmet.decisionListRef;
      const entry = ref === null ? 'none recorded' : `${DECISION_LIST_LINK}: ${code(ref)}`;
      lines.push(tableRow([unmet.id, entry, unmet.proposal ?? 'none recorded']));
    }
  }
  lines.push(
    '',
    `## Planned (provenance: ${report.planned.provenance})`,
    '',
    'Expected from the golden catalogue before any run; not results.',
    '',
    '| Scenario | Expected result | Route keys | Reference |',
    '|---|---|---|---|',
    ...report.planned.withheld.map((p) => {
      const reference = `${DECISION_LIST_LINK}: ${codes(p.decisionListRef)}`;
      return tableRow([p.scenario, code('withheld'), codes(p.routeKeys), reference]);
    }),
    ...report.planned.halted.map((p) =>
      tableRow([p.scenario, code('halted'), codes(p.routeKeys), `${EXCEPTIONS_LIST_LINK}: ${code(p.exceptionId)}`]),
    ),
  );
  if (report.coverage !== undefined) {
    const { servicesCovered, servicesTotal, unmet } = report.coverage;
    lines.push(
      '',
      `The legacy fixtures are unavailable, so parity covers ${numberWord(servicesCovered)} of ` +
        `${numberWord(servicesTotal)} services, and ${unmet.map((item) => `"${item}"`).join(', ')} is unmet.`,
    );
  }
  return lines;
}

/** Per-scenario state the exceptions rendering shows beside each entry's evidence. */
export interface ExceptionsRunState {
  /** Parity result per compared scenario id. */
  results: ReadonlyMap<string, ParityResult>;
  /** Scenario ids whose golden set exists. */
  captured: ReadonlySet<string>;
}

const EXCEPTIONS_LEGEND = [
  '| Value | Field | Meaning |',
  '|---|---|---|',
  '| `preserve` | decision | The target is changed until it matches legacy. |',
  '| `fix` | decision | A proposal: callers keep the legacy contract until the user accepts, so the route stays legacy. |',
  '| `halted` | status | Equivalence is impossible: the case stays on legacy, and its replay through the gateway must still match its golden set. |',
];

const EXCEPTIONS_FOOTER = [
  'Parity runs append runtime entries to this list: an `EquivalenceImpossible` halt, the GS-CO-15 500 gap, halted roster operations and a non-`fileDir` file store.',
  '',
  'Weaknesses reproduced on carried routes without an open entry are listed in [pre-existing-defects.md](reports/pre-existing-defects.md).',
];

const PARITY_JSON_EVIDENCE = /^opt2\/reports\/parity\.json(?=#|$)/;

function evidenceCell(entry: ExceptionEntry, run: ExceptionsRunState | undefined): string {
  const goldenState = run === undefined ? PENDING_RUN : run.captured.has(entry.scenario) ? 'captured' : 'not captured';
  const replayState = run === undefined ? PENDING_RUN : (run.results.get(entry.scenario) ?? 'not in this run');
  const { golden, replay } = entry.evidence;
  const onParity = PARITY_JSON_EVIDENCE.test(replay);
  const replayPart = onParity
    ? `parity ${code(replay.replace(PARITY_JSON_EVIDENCE, 'opt2/reports/parity.md'))}`
    : `replay ${code(replay)}`;
  return `golden ${code(golden)} (${goldenState}), ${replayPart} (${replayState})`;
}

/**
 * Body lines of `opt2/exceptions-list.md` for `writeMarkdown`: the decision and status legend, one row per entry,
 * and the closing notes. Without `run`, each evidence state reads `pending-run`.
 */
export function renderExceptionsMarkdown(list: ExceptionsList, run?: ExceptionsRunState): string[] {
  const rows = exceptionEntries(list).map((entry) =>
    tableRow([
      entry.id,
      entry.scenario,
      codes(entryRouteKeys(entry)),
      entry.difference,
      code(entry.decision),
      code(entry.status),
      evidenceCell(entry, run),
    ]),
  );
  return [
    ...EXCEPTIONS_LEGEND,
    '',
    '| Id | Scenario | Route keys | Difference | Decision | Status | Evidence |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    ...EXCEPTIONS_FOOTER,
  ];
}


/** `opt2/exceptions-list.md` beside the exceptions list at `exceptionsPath`. */
export function exceptionsMarkdownPath(exceptionsPath: string): string {
  return exceptionsPath.replace(/\.json$/, '') + '.md';
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** `message` with the state directory and the checkout root written portably, so no machine path is reported. */
function portable(message: string, env: EnvLike): string {
  return message.replaceAll(stateDir(env), STATE_ROOT).replaceAll(`${REPO_ROOT}${path.sep}`, '');
}

function errorMessage(err: unknown, env: EnvLike): string {
  return portable(err instanceof Error ? err.message : String(err), env);
}

/** Whether `err` or an error it wraps reports a missing file. */
function isMissingFile(err: unknown): boolean {
  for (let cause = err; cause instanceof Error; cause = cause.cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return true;
  }
  return false;
}

/** One side read from `file`: its value, `null` when absent, or why it could not be read. */
async function readSide<T>(
  file: string,
  read: () => Promise<T>,
  env: EnvLike,
): Promise<{ value: T | null; error?: string }> {
  if (!(await exists(file))) return { value: null };
  try {
    return { value: await read() };
  } catch (err) {
    return { value: null, error: errorMessage(err, env) };
  }
}

interface CompareContext {
  env: EnvLike;
  rules: NormaliseRules;
  fixtures: Pick<FixtureStatus, 'available' | 'reason'>;
  exceptions: readonly ExceptionEntry[];
  decisionList: DecisionList;
  gatewayOrigin: string;
  readGolden: (id: string) => Promise<GoldenSet>;
  /** Filled with the scenarios whose golden set was read. */
  captured: Set<string>;
}

type ReadErrors = NonNullable<ClassifyOptions['readErrors']>;

/** Scenario `id`'s golden set, `null` when absent; any other read failure is stated in `readErrors.golden`. */
async function readCapture(id: string, ctx: CompareContext, readErrors: ReadErrors): Promise<GoldenSet | null> {
  try {
    const golden = await ctx.readGolden(id);
    ctx.captured.add(id);
    return golden;
  } catch (err) {
    if (!isMissingFile(err)) readErrors.golden = errorMessage(err, ctx.env);
    return null;
  }
}

/** Reads and classifies one scenario; `null` for a rehearsal scenario not yet replayed, which is reported nowhere. */
async function compareScenario(scenario: Scenario, ctx: CompareContext): Promise<ScenarioParity | null> {
  const { env } = ctx;
  const opts: ClassifyOptions = {
    scenario,
    exceptions: ctx.exceptions,
    rules: ctx.rules,
    decisionList: ctx.decisionList,
    fixtures: ctx.fixtures,
    gatewayOrigin: ctx.gatewayOrigin,
  };
  const readErrors: ReadErrors = {};
  if (scenario.browser !== undefined) {
    const golden = await readCapture(scenario.id, ctx, readErrors);
    const file = browserResultPath(scenario.id, env);
    const record = await readSide(file, () => readJson(file, browserRecordSchema), env);
    if (record.error !== undefined) readErrors.replay = record.error;
    return toScenarioParity(scenario, classifyScenario(golden, null, { ...opts, browser: record.value, readErrors }));
  }
  const replayFile = replayOutputPath(scenario.id, env);
  if (isRehearsalScenario(scenario.id) && !(await exists(replayFile))) return null;
  if (skipReason(scenario, ctx.fixtures) !== null) {
    return toScenarioParity(scenario, classifyScenario(null, null, opts));
  }

  const golden = await readCapture(scenario.id, ctx, readErrors);
  const replay = await readSide(replayFile, () => readJson(replayFile, replayOutputSchema), env);
  if (replay.error !== undefined) readErrors.replay = replay.error;
  return toScenarioParity(scenario, classifyScenario(golden, replay.value, { ...opts, readErrors }));
}

const USAGE = 'tsx src/golden/compare.ts [--catalogue <path>] [--exceptions <path>] [--decision-list <path>]';
const HELP = [
  `Usage: ${USAGE}`,
  '',
  'Compares every golden set with its replay output under ${OPT2_STATE_DIR}/golden/replay/ (browser scenarios:',
  '${OPT2_STATE_DIR}/golden/browser/) and writes parity.json and parity.md to ${OPT2_REPORTS_DIR:-opt2/reports},',
  'then the exceptions-list Markdown beside --exceptions (default opt2/exceptions-list.json), which is only read.',
  'Rehearsal scenarios are included once their replay output exists.',
  '',
  'Exit: 0 no scenario fails (withheld and skipped are reported as unmet), 1 a scenario fails, 2 usage error.',
].join('\n');

/** Collaborators of {@link main} beyond the environment. */
export interface MainDeps {
  /** Default {@link readGoldenSet}. */
  readGolden?: (id: string) => Promise<GoldenSet>;
  clock?: () => Date;
  /** Progress log; default {@link createHarnessLogger} on stderr. */
  logger?: Logger;
}

function pathFlag(value: string | undefined, flag: string, fallback: string): string {
  if (value === '') throw new UsageError(`--${flag} needs a path`, USAGE);
  return value === undefined ? fallback : path.resolve(value);
}

/**
 * Classifies every catalogue scenario, writes `parity.json` and `parity.md` under `reportsDir(env)`, then regenerates
 * the exceptions-list Markdown. Exit 1 when any scenario fails. Summary: the result counts and the written paths.
 */
export async function main(argv: string[], env: EnvLike = process.env, deps: MainDeps = {}): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: {
      catalogue: { type: 'string' },
      exceptions: { type: 'string' },
      'decision-list': { type: 'string' },
    },
    usage: USAGE,
    help: HELP,
  });
  const cataloguePath = pathFlag(values.catalogue, 'catalogue', CATALOGUE_PATH);
  const exceptionsPath = pathFlag(values.exceptions, 'exceptions', EXCEPTIONS_LIST_PATH);
  const decisionListPath = pathFlag(values['decision-list'], 'decision-list', DECISION_LIST_PATH);
  const logger = deps.logger ?? createHarnessLogger('harness-golden-compare', env);

  const catalogue = await loadCatalogue(cataloguePath);
  const list = await loadExceptionsList(exceptionsPath);
  const exceptions = exceptionEntries(list);
  const ctx: CompareContext = {
    env,
    rules: loadRules(RULES_PATH, env),
    fixtures: readFixtureStatus(env),
    exceptions,
    decisionList: await loadDecisionList(decisionListPath),
    gatewayOrigin: new URL(originBaseUrl('gateway', env)).origin,
    readGolden: deps.readGolden ?? ((id) => readGoldenSet(id)),
    captured: new Set(),
  };

  const scenarios: ScenarioParity[] = [];
  for (const scenario of catalogue.scenarios) {
    const parity = await compareScenario(scenario, ctx);
    if (parity === null) {
      logger.info(safeDiagnostic(`${scenario.id}: not replayed yet; omitted`, env));
      continue;
    }
    scenarios.push(parity);
    const line = safeDiagnostic(`${scenario.id}: ${parity.result}${parity.reason === null ? '' : ` (${parity.reason})`}`, env);
    if (parity.result === 'fail') logger.warn(line);
    else logger.info(line);
  }
  const report = buildParityReport({
    catalogue,
    scenarios,
    fixtures: ctx.fixtures,
    decisionList: ctx.decisionList,
    exceptions,
    clock: deps.clock,
  });

  const dir = reportsDir(env);
  const written = await writeJsonReport(path.join(dir, 'parity.json'), { ...report }, { generatedBy: GENERATED_BY });
  const parityMarkdown = await writeMarkdown(path.join(dir, 'parity.md'), PARITY_TITLE, renderParityMarkdown(report));
  for (const { scenario } of exceptions) {
    if (!ctx.captured.has(scenario) && (await exists(goldenSetPath(scenario)))) ctx.captured.add(scenario);
  }
  const results = new Map(report.scenarios.map((scenario) => [scenario.id, scenario.result]));
  const exceptionsMarkdown = await writeMarkdown(
    exceptionsMarkdownPath(exceptionsPath),
    EXCEPTIONS_TITLE,
    renderExceptionsMarkdown(list, { results, captured: ctx.captured }),
  );
  return {
    code: report.summary.fail > 0 ? 1 : 0,
    summary: { ...report.summary, parityJson: written.path, parityMarkdown, exceptionsMarkdown },
  };
}

if (isMainModule(import.meta.url)) void runCli(main);
