// Speed report: per-service Blitzy hours, review hours, legacy input size, output size, tests and rates, each
// labelled measured, estimated, derived or unavailable with its basis.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from '@opt2/platform/service-kit';

import { CFML_LANGUAGES, runCloc, type ClocResult, type ClocRunner } from '../inventory/cloc.js';
import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { gitArchiveExtract } from '../lib/git.js';
import { REPO_ROOT, assertOutsideRepo, repoPath, reportsDir, stateDir, type EnvLike } from '../lib/paths.js';
import { readPin, type Pin } from '../lib/pin.js';
import { readJson, writeJsonReport, writeMarkdown } from '../lib/report.js';
import {
  INVENTORY_PATH,
  SYNTHETIC_SERVICES,
  TEN_SERVICES,
  inventorySchema,
  traceabilityRowCount,
  type Inventory,
  type ServiceName,
} from './check-reviewability.js';

/** Recorded as the report's `generatedBy`. */
export const GENERATED_BY = 'harness/src/reporting/speed.ts';

/** How a metric was obtained. */
export type MetricLabel = 'measured' | 'estimated' | 'derived' | 'unavailable';

/** One reported figure; `value` is null exactly when `label` is `unavailable`, and `basis` states how it was obtained. */
export interface Metric {
  value: number | null;
  label: MetricLabel;
  basis: string;
}

/** Every label, in legend order. */
export const METRIC_LABELS: readonly MetricLabel[] = Object.freeze(['measured', 'estimated', 'derived', 'unavailable']);

/** The metrics of each service row, in report order. */
export const METRIC_KEYS = [
  'blitzyElapsedHours',
  'humanReviewHours',
  'cfmlLines',
  'fixtureSqlLines',
  'entities',
  'endpoints',
  'typescriptLines',
  'tests',
  'coverage',
  'hoursPer1000CfmlLines',
  'hoursPerEntity',
] as const;

/** One of {@link METRIC_KEYS}. */
export type MetricKey = (typeof METRIC_KEYS)[number];

/** Review minutes per traceability row, the stated basis of the human review hours. */
export const REVIEW_MINUTES_PER_ROW = 5;

/** Hours apportionment basis, as `bases.hoursApportionment` of the report states it. */
export const HOURS_APPORTIONMENT = 'share of output TypeScript lines when per-service bounds are missing';

/** Repository-relative inputs. */
export const ACTIVITY_PATH = 'opt2/speed/blitzy-activity.json';
export const CLOC_REPORT_PATH = 'opt2/inventory/cloc.json';

/** Default vitest result directory, as recorded in the report. */
const VITEST_DIR_LABEL = '${OPT2_STATE_DIR}/test-all/vitest';

/** cloc `--not-match-d` that drops `src/generated` when cloc runs inside `services/<svc>/src`. */
export const GENERATED_NOT_MATCH_D = String.raw`^(\./)?generated(/|$)`;

/** Fixture module of each service with a legacy fixture. */
export const FIXTURE_MODULE: Readonly<Partial<Record<ServiceName, string>>> = Object.freeze({
  people: 'people',
  communications: 'communications',
  reporting: 'reporting',
  surveys: 'surveys',
  timesheets: 'timesheets',
  finance: 'finance',
  'e-signature': 'esignature',
});

/** Every expansion of `pattern`'s `{a,b,…}` groups, left to right; a pattern without braces is returned alone. */
export function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (match === null) return [pattern];
  const head = pattern.slice(0, match.index);
  const tail = pattern.slice(match.index + match[0].length);
  return (match[1] ?? '').split(',').flatMap((alt) => expandBraces(`${head}${alt}${tail}`));
}

/** REFERENCE paths of one service: at the pin, and new fixture files in the working tree; a trailing `/` is a directory. */
export interface ReferenceSources {
  pin: readonly string[];
  fixture: readonly string[];
}

function sources(pin: readonly string[], fixture: readonly string[] = []): ReferenceSources {
  return Object.freeze({ pin: Object.freeze(pin.flatMap(expandBraces)), fixture: Object.freeze(fixture.flatMap(expandBraces)) });
}

function fixtureModuleFile(service: ServiceName): string[] {
  const module = FIXTURE_MODULE[service];
  return module === undefined ? [] : [`legacy-fixtures/cfml/modules/${module}.cfc`];
}

const CONTENT_CIRCUITS = '{carch,cchangesets,ccomments,ccategory,cfeed,cchain,cform,cnav}';

/** Source File column of the AAP file-by-file plan, per service; synthetic services have only their fixture CFML. */
export const SERVICE_REFERENCE_SOURCES: Readonly<Record<ServiceName, ReferenceSources>> = Object.freeze({
  identity: sources([
    'admin/core/controllers/{clogin,cperm,cwebservice,cusers,home,cmessage}.cfc',
    'admin/core/views/{clogin,cperm,cwebservice,cmessage}/',
    'core/mura/login/loginManager.cfc',
    'core/mura/user/{userUtility,userstrikes,sessionUserFacade,userDAO,userManager,userRedirectBean,userDeviceBean}.cfc',
    'core/mura/permission.cfc',
    'core/mura/client/api/oauth/',
    'core/mura/client/api/json/v1/jsonApiUtility.cfc',
  ]),
  people: sources(
    [
      'admin/core/controllers/{cusers,ceditprofile}.cfc',
      'admin/core/views/{cusers,ceditprofile}/',
      'core/mura/user/{userBean,userManager,userDAO,addressBean}.cfc',
      'core/mura/extend/',
      'core/mura/Handler/standardEventsHandler.cfc',
    ],
    fixtureModuleFile('people'),
  ),
  'programs-sites': sources([
    'admin/core/controllers/csettings.cfc',
    'admin/core/views/csettings/',
    'core/mura/settings/',
    'core/mura/extend/',
    'core/mura/content/contentServer.cfc',
  ]),
  'strategies-content': sources([
    `admin/core/controllers/${CONTENT_CIRCUITS}.cfc`,
    `admin/core/views/${CONTENT_CIRCUITS}/`,
    'core/mura/content/',
    'core/mura/category/',
    'core/mura/formBuilder/',
    'core/mura/client/api/feed/v1/feedApiUtility.cfc',
    'core/mura/client/api/json/v1/jsonApiUtility.cfc',
    'core/modules/v1/comments/ajax/commentsProxy.cfc',
  ]),
  communications: sources([], fixtureModuleFile('communications')),
  reporting: sources([], fixtureModuleFile('reporting')),
  surveys: sources([], fixtureModuleFile('surveys')),
  timesheets: sources([], fixtureModuleFile('timesheets')),
  finance: sources([], fixtureModuleFile('finance')),
  'e-signature': sources([], fixtureModuleFile('e-signature')),
});

/** Whether `service` is one of the synthetic services. */
export function isSynthetic(service: ServiceName): boolean {
  return (SYNTHETIC_SERVICES as readonly string[]).includes(service);
}

/** `pkg` (a repository-relative folder such as `services/identity`) as a file-name slug, `services-identity`. */
export function packageSlug(pkg: string): string {
  return pkg
    .split(/[\\/]+/)
    .filter((part) => part !== '')
    .join('-');
}

/**
 * vitest JSON reporter output of `pkg` written by `harness/repro/test-all.sh`:
 * `<dir>/<pkg-slug>.json`, where `dir` defaults to `${OPT2_STATE_DIR}/test-all/vitest`.
 */
export function vitestResultPath(pkg: string, env: EnvLike = process.env, dir?: string): string {
  return path.join(dir ?? path.join(stateDir(env), 'test-all', 'vitest'), `${packageSlug(pkg)}.json`);
}

const boundsSchema = z.looseObject({ start: z.string().nullish(), end: z.string().nullish() });

/** Permissive shape of `opt2/speed/blitzy-activity.json`; bounds are ISO timestamps or null. */
export const activitySchema = z.looseObject({
  sourceSha: z.string().nullish(),
  recordedBy: z.string().nullish(),
  runTotal: boundsSchema.nullish(),
  services: z.record(z.string(), boundsSchema.extend({ folder: z.string().nullish() })).nullish(),
});

/** A parsed activity record. */
export type Activity = z.infer<typeof activitySchema>;

/** One input file or directory of the report: its path as recorded, whether it exists, and any read error. */
export type InputRecord = { path: string; present: boolean; error?: string; [key: string]: unknown };

/** The report's `inputs`. */
export type SpeedInputs = { activity: InputRecord; cloc: InputRecord; inventory: InputRecord; vitest: InputRecord };

/** Per-service figures read from the inputs, before hours and rates are computed. */
export interface ServiceMeasurements {
  service: ServiceName;
  cfmlLines: Metric;
  fixtureSqlLines: Metric;
  entities: Metric;
  endpoints: Metric;
  typescriptLines: Metric;
  tests: Metric;
  coverage: Metric;
  /** Data rows of `services/<svc>/TRACEABILITY.md`, the basis of the human review hours. */
  traceabilityRows: Metric;
}

/** One service row of the report. */
export type SpeedRow = {
  service: ServiceName;
  folder: string;
  synthetic: boolean;
  fixtureModule: string | null;
} & Record<MetricKey, Metric>;

/** Body of `opt2/reports/speed.json`. */
export type SpeedReport = {
  sourceSha: string;
  generatedBy: string;
  generatedAt: string;
  status: 'generated';
  inputs: SpeedInputs;
  bases: { reviewMinutesPerRow: number; hoursApportionment: string };
  labels: MetricLabel[];
  services: SpeedRow[];
};

/** Inputs of {@link buildSpeedReport}. */
export interface SpeedReportInput {
  sha: string;
  generatedAt: string;
  /** Null when the activity file is absent or unreadable. */
  activity: Activity | null;
  inputs: SpeedInputs;
  services: readonly ServiceMeasurements[];
}

/** `n` rounded to two decimals. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A measured metric. */
export function measuredMetric(value: number, basis: string): Metric {
  return { value, label: 'measured', basis };
}

/** An unavailable metric whose basis states the reason. */
export function unavailableMetric(reason: string): Metric {
  return { value: null, label: 'unavailable', basis: reason };
}

type Span = { hours: number; start: string; end: string };

/** Hours from `bounds.start` to `bounds.end`; null when either is missing, not a timestamp, or the end precedes the start. */
export function spanHours(bounds: { start?: string | null; end?: string | null } | null | undefined): Span | null {
  const start = bounds?.start;
  const end = bounds?.end;
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return { hours: (to - from) / 3_600_000, start, end };
}

/**
 * Blitzy elapsed hours per service: measured from the service's recorded bounds; otherwise estimated as the run's
 * recorded hours (the `runTotal` span, else the sum of measured service spans) apportioned by the service's share of
 * the ten services' output TypeScript lines; otherwise unavailable. Commit timestamps are never consulted.
 */
export function computeBlitzyHours(
  activity: Activity | null,
  tsLines: Readonly<Partial<Record<ServiceName, Metric>>>,
): Record<ServiceName, Metric> {
  const spans = new Map<ServiceName, Span>();
  for (const service of TEN_SERVICES) {
    const span = spanHours(activity?.services?.[service]);
    if (span !== null) spans.set(service, span);
  }
  const runSpan = spanHours(activity?.runTotal);
  const total =
    runSpan !== null
      ? { hours: runSpan.hours, source: `runTotal ${runSpan.start} to ${runSpan.end}` }
      : spans.size > 0
        ? { hours: [...spans.values()].reduce((sum, span) => sum + span.hours, 0), source: 'sum of measured service spans' }
        : null;
  const tsValues = TEN_SERVICES.map((service) => tsLines[service]?.value ?? null);
  const tsTotal = tsValues.every((value) => value !== null) ? tsValues.reduce<number>((sum, v) => sum + (v ?? 0), 0) : null;

  const result = {} as Record<ServiceName, Metric>;
  for (const service of TEN_SERVICES) {
    const span = spans.get(service);
    const ts = tsLines[service]?.value ?? null;
    if (span !== undefined) {
      result[service] = measuredMetric(
        round2(span.hours),
        `services.${service} end − start in ${ACTIVITY_PATH} (${span.start} to ${span.end})`,
      );
    } else if (activity === null) {
      result[service] = unavailableMetric(`${ACTIVITY_PATH} absent or unreadable; no recorded hours; rates not computed`);
    } else if (total === null) {
      result[service] = unavailableMetric(
        `no recorded hours: neither services.${service} nor runTotal has both bounds in ${ACTIVITY_PATH}; rates not computed`,
      );
    } else if (ts === null) {
      result[service] = unavailableMetric(
        `no per-service bounds, and output TypeScript lines are unavailable to apportion the run total; rates not computed`,
      );
    } else if (tsTotal === null || tsTotal === 0) {
      result[service] = unavailableMetric(
        `no per-service bounds, and the ten services' output TypeScript total is ${tsTotal === null ? 'incomplete' : 'zero'}; rates not computed`,
      );
    } else {
      result[service] = {
        value: round2((total.hours * ts) / tsTotal),
        label: 'estimated',
        basis:
          `run total apportioned by share of output TypeScript lines: ${round2(total.hours)} h (${total.source}) × ` +
          `${ts} / ${tsTotal} lines`,
      };
    }
  }
  return result;
}

/** Human review hours: traceability rows × `minutesPerRow` / 60, always estimated. */
export function reviewHours(rows: Metric, minutesPerRow: number = REVIEW_MINUTES_PER_ROW): Metric {
  if (rows.value === null) return unavailableMetric(`traceability rows unavailable: ${rows.basis}`);
  return {
    value: round2((rows.value * minutesPerRow) / 60),
    label: 'estimated',
    basis: `${rows.value} traceability rows × ${minutesPerRow} min per row / 60 (${rows.basis})`,
  };
}

/**
 * Hours per `per` units of `denominator`: derived from measured hours, estimated from estimated hours, and
 * unavailable when the hours or the denominator are unavailable or the denominator is zero.
 */
export function rateMetric(hours: Metric, denominator: Metric, per: number, unit: string): Metric {
  if (hours.value === null) return unavailableMetric('Blitzy hours unavailable; rate not computed');
  if (denominator.value === null) return unavailableMetric(`${unit} unavailable; rate not computed`);
  if (denominator.value === 0) return unavailableMetric(`zero ${unit}; rate not computed`);
  const scaled = per === 1 ? `${denominator.value} ${unit}` : `(${denominator.value} ${unit} / ${per})`;
  return {
    value: round2(hours.value / (denominator.value / per)),
    label: hours.label === 'measured' ? 'derived' : 'estimated',
    basis: `${hours.value} h (${hours.label}) / ${scaled}`,
  };
}

function unmeasured(service: ServiceName): ServiceMeasurements {
  const none = unavailableMetric('not measured');
  return {
    service,
    cfmlLines: none,
    fixtureSqlLines: none,
    entities: none,
    endpoints: none,
    typescriptLines: none,
    tests: none,
    coverage: none,
    traceabilityRows: none,
  };
}

/** The report body for `input`, one row per service in {@link TEN_SERVICES} order; pure. */
export function buildSpeedReport(input: SpeedReportInput): SpeedReport {
  const byService = new Map(input.services.map((m) => [m.service, m]));
  const measurements = TEN_SERVICES.map((service) => byService.get(service) ?? unmeasured(service));
  const hours = computeBlitzyHours(
    input.activity,
    Object.fromEntries(measurements.map((m) => [m.service, m.typescriptLines])),
  );
  const services = measurements.map((m): SpeedRow => {
    const blitzyElapsedHours = hours[m.service];
    return {
      service: m.service,
      folder: `services/${m.service}`,
      synthetic: isSynthetic(m.service),
      fixtureModule: FIXTURE_MODULE[m.service] ?? null,
      blitzyElapsedHours,
      humanReviewHours: reviewHours(m.traceabilityRows),
      cfmlLines: m.cfmlLines,
      fixtureSqlLines: m.fixtureSqlLines,
      entities: m.entities,
      endpoints: m.endpoints,
      typescriptLines: m.typescriptLines,
      tests: m.tests,
      coverage: m.coverage,
      hoursPer1000CfmlLines: rateMetric(blitzyElapsedHours, m.cfmlLines, 1000, 'CFML lines'),
      hoursPerEntity: rateMetric(blitzyElapsedHours, m.entities, 1, 'entities'),
    };
  });
  return {
    sourceSha: input.sha,
    generatedBy: GENERATED_BY,
    generatedAt: input.generatedAt,
    status: 'generated',
    inputs: input.inputs,
    bases: { reviewMinutesPerRow: REVIEW_MINUTES_PER_ROW, hoursApportionment: HOURS_APPORTIONMENT },
    labels: [...METRIC_LABELS],
    services,
  };
}

function isMetric(value: unknown): value is Metric {
  if (value === null || typeof value !== 'object') return false;
  const { value: figure, label, basis } = value as Record<string, unknown>;
  const labelled = typeof label === 'string' && (METRIC_LABELS as readonly string[]).includes(label);
  const valued = label === 'unavailable' ? figure === null : typeof figure === 'number' && Number.isFinite(figure);
  return labelled && valued && typeof basis === 'string' && basis !== '';
}

/** `<service>.<metric>` for every service of {@link TEN_SERVICES} or metric that `report` lacks or holds malformed. */
export function missingMetrics(report: Pick<SpeedReport, 'services'>): string[] {
  const rows = new Map(report.services.map((row) => [row.service, row]));
  return TEN_SERVICES.flatMap((service) => {
    const row = rows.get(service) as Record<string, unknown> | undefined;
    return METRIC_KEYS.filter((key) => !isMetric(row?.[key])).map((key) => `${service}.${key}`);
  });
}


/** Code lines of `languages` in a cloc result. */
export function languageCode(result: Pick<ClocResult, 'languages'>, languages: readonly string[]): number {
  return result.languages.filter((row) => languages.includes(row.language)).reduce((sum, row) => sum + row.code, 0);
}

function ownersOf(entry: { owningService?: string | null; variants?: { owningService?: string | null }[] | null }): string[] {
  if (entry.owningService) return [entry.owningService];
  return [...new Set((entry.variants ?? []).flatMap((v) => (v.owningService ? [v.owningService] : [])))];
}

/**
 * Entities and endpoints `service` owns in the inventory, any disposition. Entities exclude `not-entity`; a synthetic
 * service owning none counts its fixture tables. An admin action without an owner of its own counts for each owner
 * of its variants.
 */
export function inventoryCounts(service: ServiceName, inventory: Inventory): { entities: Metric; endpoints: Metric } {
  const owned = (entry: { owningService?: string | null }): boolean => entry.owningService === service;
  const entityCount = inventory.entities.filter((e) => owned(e) && e.class !== 'not-entity').length;
  let entities = measuredMetric(entityCount, `entities[] owned in ${INVENTORY_PATH}, class other than not-entity`);
  if (entityCount === 0 && isSynthetic(service)) {
    const tables = inventory.tables.filter((t) => owned(t) && t.origin === 'fixture').length;
    entities = measuredMetric(tables, `no owned entities[]; owned fixture tables (tables[] origin fixture) in ${INVENTORY_PATH}`);
  }
  const routes = inventory.routes.filter(owned).length;
  const actions = inventory.controllers
    .flatMap((c) => c.actions ?? [])
    .filter((a) => ownersOf(a).includes(service)).length;
  const frontEnd = inventory.frontEnd.filter(owned).length;
  const steps = inventory.scheduledJobs.flatMap((j) => j.steps ?? []).filter(owned).length;
  const endpoints = measuredMetric(
    routes + actions + frontEnd + steps,
    `${routes} routes + ${actions} admin actions (own owner, else a variant's) + ${frontEnd} front-end entries + ` +
      `${steps} job steps owned in ${INVENTORY_PATH}, any disposition`,
  );
  return { entities, endpoints };
}

/** Message of `err` with each `[from, to]` replacement applied, so reports carry no machine-specific paths. */
function describeError(err: unknown, replacements: readonly (readonly [string, string])[] = []): string {
  let text = err instanceof Error ? err.message : String(err);
  for (const [from, to] of [...replacements, [`${REPO_ROOT}${path.sep}`, ''], [REPO_ROOT, '.']] as const) {
    text = text.split(from).join(to);
  }
  return text;
}

async function readOptionalText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw err;
  }
}

/** The JSON at `relPath` validated by `schema`, or null with the reason recorded when it is absent or invalid. */
async function readInput<T>(relPath: string, schema: z.ZodType<T>): Promise<{ data: T | null; record: InputRecord }> {
  if (!existsSync(repoPath(relPath))) return { data: null, record: { path: relPath, present: false } };
  try {
    return { data: await readJson(relPath, schema), record: { path: relPath, present: true } };
  } catch (err) {
    return { data: null, record: { path: relPath, present: true, error: describeError(err) } };
  }
}

const count = z.number().int().nonnegative();
const clocReportSchema = z.looseObject({ sourceSha: z.string() });
const vitestSchema = z.looseObject({
  numTotalTests: count,
  numPassedTests: count,
  numFailedTests: count,
  numPendingTests: count.optional(),
  numTodoTests: count.optional(),
});
const coverageSchema = z.looseObject({
  total: z.looseObject({
    statements: z.looseObject({ pct: z.number(), covered: count.optional(), total: count.optional() }),
  }),
});

/** Shared state of one collection run. */
interface CollectContext {
  sha: string;
  scratch: string;
  /** The pinned tree, or null with `extractionError` set. */
  extraction: string | null;
  extractionError: string | null;
  /** Why pin measurements are refused, when `opt2/inventory/cloc.json` names another commit. */
  clocMismatch: string | null;
  runner?: ClocRunner;
}

function pathReplacements(ctx: CollectContext): [string, string][] {
  const pairs: [string, string][] = [];
  if (ctx.extraction !== null) pairs.push([ctx.extraction, '<pin extraction>']);
  pairs.push([ctx.scratch, '<scratch>']);
  return pairs;
}

/** CFML code lines of the paths in `entries` (relative to `cwd`), counted by one cloc run over a list file. */
async function cfmlOfList(ctx: CollectContext, cwd: string, entries: readonly string[], name: string): Promise<number> {
  const listFile = path.join(ctx.scratch, name);
  await writeFile(listFile, `${entries.join('\n')}\n`, 'utf8');
  return languageCode(await runCloc(cwd, { listFile, runner: ctx.runner }), CFML_LANGUAGES);
}

async function measureCfml(service: ServiceName, ctx: CollectContext): Promise<Metric> {
  const { pin, fixture } = SERVICE_REFERENCE_SOURCES[service];
  const parts: string[] = [];
  let total = 0;
  try {
    if (pin.length > 0) {
      if (ctx.clocMismatch !== null) return unavailableMetric(ctx.clocMismatch);
      if (ctx.extraction === null) return unavailableMetric(`pin extraction failed: ${ctx.extractionError ?? 'unknown'}`);
      const extraction = ctx.extraction;
      const absent = pin.filter((entry) => !existsSync(path.join(extraction, entry)));
      if (absent.length > 0) return unavailableMetric(`REFERENCE paths absent at the pin: ${absent.join(', ')}`);
      total += await cfmlOfList(ctx, extraction, pin, `${service}.pin.list`);
      parts.push(`${pin.length} REFERENCE paths in git archive ${ctx.sha}`);
    }
    if (fixture.length > 0) {
      const absent = fixture.filter((entry) => !existsSync(repoPath(entry)));
      if (absent.length > 0) return unavailableMetric(`fixture CFML absent: ${absent.join(', ')}`);
      total += await cfmlOfList(ctx, REPO_ROOT, fixture, `${service}.fixture.list`);
      parts.push(`fixture CFML in the working tree (${fixture.join(', ')})`);
    }
  } catch (err) {
    return unavailableMetric(`cloc failed: ${describeError(err, pathReplacements(ctx))}`);
  }
  if (parts.length === 0) return unavailableMetric('no REFERENCE or fixture CFML listed');
  return measuredMetric(
    total,
    `cloc ${CFML_LANGUAGES.join(' + ')} code lines over ${parts.join(' + ')}; ` +
      'whole REFERENCE files per AAP 0.6.1; a file shared by several services counts for each',
  );
}

async function measureFixtureSql(service: ServiceName, ctx: CollectContext): Promise<Metric> {
  const module = FIXTURE_MODULE[service];
  if (module === undefined) return unavailableMetric('no fixture SQL: the service has no legacy fixture module');
  const dir = `legacy-fixtures/sql/${module}`;
  if (!existsSync(repoPath(dir))) return unavailableMetric(`no fixture SQL: ${dir}/ absent`);
  try {
    const code = languageCode(await runCloc(dir, { runner: ctx.runner }), ['SQL']);
    return measuredMetric(code, `cloc SQL code lines in ${dir}/; reported apart from CFML lines`);
  } catch (err) {
    return unavailableMetric(`cloc failed in ${dir}/: ${describeError(err, pathReplacements(ctx))}`);
  }
}

async function measureTypeScript(service: ServiceName, ctx: CollectContext): Promise<Metric> {
  const dir = `services/${service}/src`;
  if (!existsSync(repoPath(dir))) return unavailableMetric(`${dir}/ absent`);
  try {
    const code = languageCode(await runCloc(dir, { notMatchD: GENERATED_NOT_MATCH_D, runner: ctx.runner }), ['TypeScript']);
    return measuredMetric(code, `cloc TypeScript code lines in ${dir}/, excluding src/generated/`);
  } catch (err) {
    return unavailableMetric(`cloc failed in ${dir}/: ${describeError(err, pathReplacements(ctx))}`);
  }
}

async function measureTests(file: string, shown: string): Promise<Metric> {
  if (!existsSync(file)) {
    return unavailableMetric(`vitest JSON ${shown} absent; harness/repro/test-all.sh stage 3 writes it`);
  }
  try {
    const result = await readJson(file, vitestSchema);
    const skipped = (result.numPendingTests ?? 0) + (result.numTodoTests ?? 0);
    return measuredMetric(
      result.numTotalTests,
      `numTotalTests of vitest JSON ${shown}: ${result.numPassedTests} passed, ${result.numFailedTests} failed, ${skipped} skipped or todo`,
    );
  } catch (err) {
    return unavailableMetric(`vitest JSON ${shown} unreadable: ${describeError(err, [[file, shown]])}`);
  }
}

async function measureCoverage(service: ServiceName): Promise<Metric> {
  const relPath = `services/${service}/coverage/coverage-summary.json`;
  if (!existsSync(repoPath(relPath))) return unavailableMetric(`${relPath} absent; npm test in services/${service} writes it`);
  try {
    const { statements } = (await readJson(relPath, coverageSchema)).total;
    const counts = statements.covered === undefined || statements.total === undefined ? '' : ` (${statements.covered}/${statements.total} statements)`;
    return measuredMetric(statements.pct, `total.statements.pct of ${relPath}${counts}`);
  } catch (err) {
    return unavailableMetric(`${relPath} unreadable: ${describeError(err)}`);
  }
}

async function measureTraceability(service: ServiceName): Promise<Metric> {
  const relPath = `services/${service}/TRACEABILITY.md`;
  const text = await readOptionalText(repoPath(relPath));
  if (text === null) return unavailableMetric(`${relPath} absent`);
  return measuredMetric(traceabilityRowCount(text), `data rows of ${relPath}`);
}

/** Injectable inputs of {@link collectSpeedInputs} and {@link main}; each defaults to the real process. */
export interface SpeedDeps {
  env?: EnvLike;
  clock?: () => Date;
  pin?: () => Pin;
  /** cloc runner passed to every `runCloc` call. */
  runner?: ClocRunner;
  /** Extracts the pinned tree into a new directory under `scratch`, outside the checkout, and returns its path. */
  extract?: (sha: string, scratch: string) => Promise<string>;
}

/** Options of {@link collectSpeedInputs}. */
export interface CollectOptions extends Omit<SpeedDeps, 'clock' | 'pin'> {
  pin: Pin;
  /** Directory of the vitest JSON results; default `${OPT2_STATE_DIR}/test-all/vitest`. */
  vitestDir?: string;
}

/**
 * Reads every input and measures each service. The pinned tree is extracted once into a scratch directory under
 * TMPDIR, which is removed afterwards; a missing input or a failing measurement yields an unavailable metric.
 */
export async function collectSpeedInputs(opts: CollectOptions): Promise<Omit<SpeedReportInput, 'generatedAt'>> {
  const sha = opts.pin.sha;
  const activity = await readInput(ACTIVITY_PATH, activitySchema);
  const clocReport = await readInput(CLOC_REPORT_PATH, clocReportSchema);
  const inventory = await readInput(INVENTORY_PATH, inventorySchema);
  const clocSha = clocReport.data?.sourceSha ?? null;
  const vitestDir = opts.vitestDir ?? path.join(stateDir(opts.env ?? process.env), 'test-all', 'vitest');
  const shownDir = opts.vitestDir ?? VITEST_DIR_LABEL;
  const inputs: SpeedInputs = {
    activity: activity.record,
    cloc: { ...clocReport.record, sourceSha: clocSha, matchesPin: clocSha === sha, extractedFrom: `git archive ${sha}` },
    inventory: inventory.record,
    vitest: {
      path: shownDir,
      present: existsSync(vitestDir),
      coverage: 'services/<svc>/coverage/coverage-summary.json',
    },
  };

  const scratch = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'speed scratch root'), 'opt2-speed-'));
  const ctx: CollectContext = {
    sha,
    scratch,
    extraction: null,
    extractionError: null,
    clocMismatch:
      clocSha !== null && clocSha !== sha ? `${CLOC_REPORT_PATH} sourceSha ${clocSha} differs from the pin ${sha}` : null,
    runner: opts.runner,
  };
  const services: ServiceMeasurements[] = [];
  try {
    if (ctx.clocMismatch === null) {
      const extract = opts.extract ?? ((pinSha: string, dir: string) => gitArchiveExtract(pinSha, path.join(dir, 'tree')));
      try {
        ctx.extraction = assertOutsideRepo(await extract(sha, scratch), 'pin extraction');
      } catch (err) {
        ctx.extractionError = describeError(err, pathReplacements(ctx));
      }
    }
    const noInventory = unavailableMetric(`${INVENTORY_PATH} ${inventory.record.present ? 'unreadable' : 'absent'}`);
    for (const service of TEN_SERVICES) {
      const counts =
        inventory.data === null ? { entities: noInventory, endpoints: noInventory } : inventoryCounts(service, inventory.data);
      const slug = packageSlug(`services/${service}`);
      services.push({
        service,
        cfmlLines: await measureCfml(service, ctx),
        fixtureSqlLines: await measureFixtureSql(service, ctx),
        ...counts,
        typescriptLines: await measureTypeScript(service, ctx),
        tests: await measureTests(vitestResultPath(`services/${service}`, opts.env, vitestDir), `${shownDir}/${slug}.json`),
        coverage: await measureCoverage(service),
        traceabilityRows: await measureTraceability(service),
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { sha, activity: activity.data, inputs, services };
}

const METRIC_TITLES: Readonly<Record<MetricKey, string>> = Object.freeze({
  blitzyElapsedHours: 'Blitzy hours',
  humanReviewHours: 'Review hours',
  cfmlLines: 'CFML lines',
  fixtureSqlLines: 'Fixture SQL lines',
  entities: 'Entities',
  endpoints: 'Endpoints',
  typescriptLines: 'TS lines',
  tests: 'Tests',
  coverage: 'Coverage',
  hoursPer1000CfmlLines: 'h/1k CFML',
  hoursPerEntity: 'h/entity',
});

const LABEL_LEGEND: Readonly<Record<MetricLabel, string>> = Object.freeze({
  measured: `read directly from \`${ACTIVITY_PATH}\`, cloc, the inventory, the TRACEABILITY files or vitest output.`,
  estimated: 'computed from a stated basis (apportioned hours; traceability rows × minutes per row); rates from estimated hours.',
  derived: 'computed from measured hours.',
  unavailable: 'the input is missing or could not be measured, as the basis states; rates are not computed without hours.',
});

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function metricCell(key: MetricKey, metric: Metric): string {
  if (metric.value === null) return '— (unavailable)';
  const figure = metric.value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${key === 'coverage' ? `${figure}%` : figure} (${metric.label})`;
}

/** Body lines of `opt2/reports/speed.md`, after its title and `Source SHA:` line. */
export function renderSpeedMarkdown(report: SpeedReport): string[] {
  const lines = [
    `Status: ${report.status}`,
    `Generated by: ${report.generatedBy}`,
    `Generated at: ${report.generatedAt}`,
    '',
    '## Bases',
    '',
    '| Basis | Value |',
    '|---|---|',
    `| Minutes per traceability row (human review hours) | ${report.bases.reviewMinutesPerRow} |`,
    `| Hours apportionment | ${cell(report.bases.hoursApportionment)} |`,
    '| Commit timestamps | never used |',
    '',
    '## Inputs',
    '',
    '| Input | Path | Present | Note |',
    '|---|---|---|---|',
  ];
  for (const [name, input] of Object.entries(report.inputs) as [keyof SpeedInputs, InputRecord][]) {
    const note =
      input.error ??
      (name === 'cloc' && input.present ? `sourceSha ${String(input.sourceSha)}; matches the pin: ${String(input.matchesPin)}` : '');
    lines.push(`| ${name} | \`${cell(input.path)}\` | ${input.present ? 'yes' : 'no'} | ${cell(note)} |`);
  }
  lines.push('', '## Labels', '', ...METRIC_LABELS.map((label) => `- ${label}: ${LABEL_LEGEND[label]}`), '');
  lines.push(
    '## Metrics',
    '',
    `| Service | ${METRIC_KEYS.map((key) => METRIC_TITLES[key]).join(' | ')} |`,
    `|${METRIC_KEYS.map(() => '---|').join('')}---|`,
  );
  for (const row of report.services) {
    lines.push(`| ${row.service} | ${METRIC_KEYS.map((key) => cell(metricCell(key, row[key]))).join(' | ')} |`);
  }
  lines.push('', '## Basis of each metric', '');
  for (const row of report.services) {
    lines.push(`### ${row.service}`, '');
    for (const key of METRIC_KEYS) lines.push(`- ${METRIC_TITLES[key]} (${row[key].label}): ${row[key].basis}`);
    lines.push('');
  }
  return lines;
}

const USAGE = 'speed [--vitest-dir <dir>] [--no-write]';
const HELP = `${USAGE} [--help]

Writes the speed report speed.json and speed.md: one row per service with Blitzy elapsed hours, human review hours,
legacy CFML and fixture SQL lines, owned entities and endpoints, output TypeScript lines, tests, coverage, and hours
per 1,000 CFML lines and per entity. Every metric carries a label (${METRIC_LABELS.join(', ')}) and its basis.

Options:
  --vitest-dir <dir>  directory of the vitest JSON results, <pkg-slug>.json per package, resolved against the working
                      directory (default: \${OPT2_STATE_DIR}/test-all/vitest, written by harness/repro/test-all.sh)
  --no-write          print the summary only; write no report
  --help              print this help and exit 0

Reads ${ACTIVITY_PATH}, ${CLOC_REPORT_PATH}, ${INVENTORY_PATH}, services/<svc>/TRACEABILITY.md,
services/<svc>/coverage/coverage-summary.json and the vitest results. Legacy CFML is measured with cloc over a
git archive extraction of the pin made under TMPDIR, outside the checkout. Writes to OPT2_REPORTS_DIR (default
opt2/reports). Commit timestamps are never used.

Output: one JSON summary line on stdout. Exit: 0 report built with every metric, 1 a metric missing or a failure,
2 usage error.

Examples (from harness/):
  npm run report:speed
  npm run report:speed -- --vitest-dir /path/to/vitest --no-write`;

/** CLI entry: collects the inputs, builds the report and writes both files unless `--no-write`. */
export async function main(argv: string[], deps: SpeedDeps = {}): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: { 'vitest-dir': { type: 'string' }, 'no-write': { type: 'boolean' } },
    usage: USAGE,
    help: HELP,
  });
  if (values['vitest-dir'] === '') throw new UsageError('--vitest-dir needs a directory', USAGE);
  const env = deps.env ?? process.env;
  const pin = (deps.pin ?? readPin)();
  const pinOf = (): Pin => pin;
  const vitestDir = values['vitest-dir'] === undefined ? undefined : path.resolve(values['vitest-dir']);
  const collected = await collectSpeedInputs({ env, pin, vitestDir, runner: deps.runner, extract: deps.extract });
  const report = buildSpeedReport({ ...collected, generatedAt: (deps.clock ?? (() => new Date()))().toISOString() });
  const missing = missingMetrics(report);

  const written: { json?: string; md?: string } = {};
  if (values['no-write'] !== true) {
    const dir = reportsDir(env);
    written.json = (await writeJsonReport(path.join(dir, 'speed.json'), report, { generatedBy: GENERATED_BY, pin: pinOf })).path;
    written.md = await writeMarkdown(path.join(dir, 'speed.md'), 'Speed report', renderSpeedMarkdown(report), { pin: pinOf });
  }
  const labels = Object.fromEntries(
    METRIC_LABELS.map((label) => [
      label,
      report.services.reduce((n, row) => n + METRIC_KEYS.filter((key) => row[key].label === label).length, 0),
    ]),
  );
  return { code: missing.length === 0 ? 0 : 1, summary: { ...written, written: values['no-write'] !== true, labels, missing } };
}

if (isMainModule(import.meta.url)) void runCli(main);

