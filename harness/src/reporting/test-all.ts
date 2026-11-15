// Stage records of harness/repro/test-all.sh and the test-all report assembled from them and the stage reports.
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from '@opt2/platform/service-kit';

import { FIXTURES_UNAVAILABLE, readFixtureStatus } from '../golden/catalogue.js';
import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { REPO_ROOT, isInsideRepo, reportsDir, stateDir, type EnvLike } from '../lib/paths.js';
import { readJson, stableStringify, writeJsonReport, writeMarkdown, type ReportOptions } from '../lib/report.js';
import { TEN_SERVICES, type ServiceName } from './check-reviewability.js';
import { vitestResultPath } from './speed.js';

/** Recorded as the report's `generatedBy`. */
export const GENERATED_BY = 'harness/src/reporting/test-all.ts';

/** Stage names of `test-all.sh`, indexed by stage number. */
export const STAGE_NAMES = [
  'Pin and synthetic-label checks',
  'Legacy baseline',
  'Platform on stub',
  'Each service',
  'Migration',
  'Capture',
  'Cut-over',
  'Equivalence and cross-cutting',
  'Rollback',
  'Reports',
] as const;

/** Highest stage number. */
export const LAST_STAGE = STAGE_NAMES.length - 1;

/** Result of one stage; `timing-variance` is the baseline's tolerated beanFeedSecurity timing difference. */
export const STAGE_RESULTS = ['pass', 'fail', 'unmet', 'skipped', 'timing-variance', 'not-run'] as const;
export type StageResult = (typeof STAGE_RESULTS)[number];

/** Columns of the ten-service matrix after `service`. */
export const MATRIX_COLUMNS = ['parity', 'contract', 'isolation', 'events', 'security'] as const;
export type MatrixColumn = (typeof MATRIX_COLUMNS)[number];

/** State of one matrix cell; combined by {@link CELL_PRECEDENCE}. */
export type CellState = 'pass' | 'fail' | 'unmet' | 'pending-run';

/** Rank of each cell state when several sources feed one cell: the highest wins. */
export const CELL_PRECEDENCE: Readonly<Record<CellState, number>> = Object.freeze({
  pass: 0,
  'pending-run': 1,
  unmet: 2,
  fail: 3,
});

/** Cloud paths no local run can exercise; always reported as untested. */
export const CLOUD_PATHS_UNTESTED: readonly string[] = Object.freeze([
  'Identity Platform tokens',
  'invocation credentials',
  'Cloud Tasks',
  'storage signing',
  'Secret Manager',
  'the db-bootstrap job',
  'the OpenTelemetry collector sidecar',
]);

/** The report's `cloudPathsUntested` sentence, built from {@link CLOUD_PATHS_UNTESTED}. */
export const CLOUD_PATHS_UNTESTED_STATEMENT =
  `${joinList(CLOUD_PATHS_UNTESTED)} are untested against live services; ` +
  'terraform plan proves resources and bindings only';

/** Meaning of each exit code of `test-all.sh`, reported verbatim. */
export const EXIT_CODES: Readonly<Record<'0' | '1' | '2', string>> = Object.freeze({
  '0': 'all stages passed',
  '1': 'a stage or a service-matrix cell failed',
  '2': 'completed with acceptance items unmet',
});

/** Unmet items added when the legacy fixtures are unavailable. */
export const FIXTURE_UNMET_ITEMS = ['all ten services pass parity', 'rollback archive-to-blackout leg'] as const;

/** Unmet item of a `timing-variance` baseline. */
export const BASELINE_UNMET_ITEM = 'Done: legacy baseline';

const STATE_VAR = '${OPT2_STATE_DIR}';
const FIXTURES_SOURCE = `${STATE_VAR}/fixtures.json`;
const CATEGORY_SEGMENTS: Readonly<Record<Exclude<MatrixColumn, 'parity'>, string>> = Object.freeze({
  contract: '/test/contract/',
  isolation: '/test/isolation/',
  events: '/test/events/',
  security: '/test/security/',
});

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const isoTimestamp = z.iso.datetime({ offset: true });
const exitCode = z.number().int().min(0).max(255);

/** Schema of `${OPT2_STATE_DIR}/test-all/stage-<n>.json`. */
export const stageRecordSchema = z.object({
  stage: z.number().int().min(0).max(LAST_STAGE),
  name: z.string().min(1),
  result: z.enum(STAGE_RESULTS),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp,
  durationMs: z.number().int().nonnegative(),
  exitCode: exitCode.optional(),
  evidence: z.array(z.string().min(1)),
  reason: z.string().min(1).optional(),
  unmet: z.array(z.object({ item: z.string().min(1), reason: z.string().min(1) })).optional(),
  packages: z.array(z.object({ package: z.string().min(1), exitCode })).optional(),
});
export type StageRecord = z.infer<typeof stageRecordSchema>;

/** Path of stage `n`'s record, `${OPT2_STATE_DIR}/test-all/stage-<n>.json`. */
export function stageRecordPath(n: number, env: EnvLike = process.env): string {
  if (!Number.isInteger(n) || n < 0 || n > LAST_STAGE) throw new RangeError(`stage ${n} is not 0–${LAST_STAGE}`);
  return path.join(stateDir(env), 'test-all', `stage-${n}.json`);
}

/** `file` as reported: repository-relative inside the checkout, `${OPT2_STATE_DIR}/…` under the state directory. */
export function displayPath(file: string, env: EnvLike = process.env): string {
  if (!path.isAbsolute(file)) return file;
  const state = stateDir(env);
  if (file === state || file.startsWith(state + path.sep)) {
    return [STATE_VAR, ...path.relative(state, file).split(path.sep)].filter((part) => part !== '').join('/');
  }
  return isInsideRepo(file) ? path.relative(REPO_ROOT, file).split(path.sep).join('/') : file;
}

// Permissive shapes of the stage reports; each is read once, here, and only the fields used are named.
const PARITY_RESULTS = ['pass', 'fail', 'excepted', 'halted', 'known-issue', 'withheld', FIXTURES_UNAVAILABLE] as const;

/** Fields of `parity.json` the matrix and unmet list use. */
export const parityInputSchema = z.looseObject({
  status: z.string().optional(),
  scenarios: z
    .array(
      z.looseObject({
        id: z.string().min(1),
        service: z.string(),
        result: z.enum(PARITY_RESULTS),
        reason: z.string().nullish(),
        decisionListRef: z.array(z.string()).nullish(),
      }),
    )
    .default(() => []),
  unmetWithheld: z
    .array(z.looseObject({ id: z.string().min(1), decisionListRef: z.string().nullish(), proposal: z.string().nullish() }))
    .default(() => []),
});
export type ParityInput = z.infer<typeof parityInputSchema>;

/** Fields of the vitest JSON reporter output the matrix uses. */
export const vitestInputSchema = z.looseObject({
  testResults: z
    .array(
      z.looseObject({
        name: z.string(),
        status: z.string(),
        assertionResults: z.array(z.looseObject({ status: z.string() })).default(() => []),
      }),
    )
    .default(() => []),
});
export type VitestInput = z.infer<typeof vitestInputSchema>;

/** Fields of `isolation.json` the matrix uses; `null` is a figure not yet measured. */
export const isolationInputSchema = z.looseObject({
  status: z.string().optional(),
  services: z
    .array(
      z.looseObject({
        service: z.string(),
        schema: z.string().nullish(),
        crossTenantReads: z.number().nullish(),
        crossTenantWrites: z.number().nullish(),
        pooledConnectionReuse: z
          .looseObject({ rowsSeen: z.number().nullish(), writeBlocked: z.boolean().nullish() })
          .nullish(),
        rlsCatalog: z
          .looseObject({
            tables: z.number().nullish(),
            enabled: z.number().nullish(),
            forced: z.number().nullish(),
            usingAndWithCheck: z.number().nullish(),
          })
          .nullish(),
        source: z.string().nullish(),
        result: z.string().nullish(),
      }),
    )
    .default(() => []),
  roles: z
    .looseObject({
      rolbypassrls: z.array(z.string()).nullish(),
      rolsuper: z.array(z.string()).nullish(),
      membershipViolations: z
        .array(z.looseObject({ member: z.string(), ancestor: z.string().nullish(), via: z.array(z.string()).nullish() }))
        .nullish(),
    })
    .nullish(),
  consumers: z
    .array(
      z.looseObject({
        subscription: z.string(),
        tenantlessRejected: z.boolean().nullish(),
        fanoutRegistryOnly: z.boolean().nullish(),
        crossTenantEffects: z.number().nullish(),
      }),
    )
    .nullish(),
});
export type IsolationInput = z.infer<typeof isolationInputSchema>;

/** Fields of `events.json` the matrix uses. */
export const eventsInputSchema = z.looseObject({
  status: z.string().optional(),
  result: z.string().nullish(),
  topics: z
    .array(z.looseObject({ producer: z.string().nullish(), consumers: z.array(z.string()).default(() => []) }))
    .default(() => []),
});
export type EventsInput = z.infer<typeof eventsInputSchema>;

/** Fields of `${OPT2_STATE_DIR}/security/summary.json` the matrix uses. */
export const securityInputSchema = z.looseObject({
  verdict: z.string().optional(),
  exitCode: z.number().optional(),
  error: z.string().optional(),
});
export type SecurityInput = z.infer<typeof securityInputSchema>;

/** One input file: its reported path and its content, `null` when the file is absent. */
export interface Source<T> {
  path: string;
  data: T | null;
}

/** One stage of the report. */
export interface StageEntry {
  stage: number;
  name: string;
  result: StageResult;
  durationMs: number | null;
  evidence: string[];
  reason?: string;
}

/** One matrix cell: its state and the reasons of the sources that set it. */
export interface MatrixCell {
  state: CellState;
  reason: string;
}

/** One service row of the matrix. */
export type ServiceMatrixRow = { service: ServiceName } & Record<MatrixColumn, MatrixCell>;

/** One acceptance item left unmet, with the files that show it. */
export interface UnmetItem {
  item: string;
  reason: string;
  evidence: string[];
}

/** Legacy-fixture availability; `available: null` when `fixtures.json` is missing. */
export interface FixtureReport {
  available: boolean | null;
  reason: string | null;
}

/** Inputs of {@link buildServiceMatrix}. */
export interface MatrixInputs {
  parity: Source<ParityInput>;
  vitest: Readonly<Record<ServiceName, Source<VitestInput>>>;
  isolation: Source<IsolationInput>;
  events: Source<EventsInput>;
  security: Source<SecurityInput>;
  /** Stage 3's per-package `npm test` exit codes. */
  packages: readonly { package: string; exitCode: number }[];
}

function stageName(n: number): string {
  return STAGE_NAMES[n] ?? `Stage ${n}`;
}

/**
 * Report stages from the records of stages 0–9 (`null` for a missing record): a missing record after a failed
 * stage is `not-run`, any other missing record is `fail` (`stage record missing`).
 */
export function resolveStages(records: readonly (StageRecord | null)[]): StageEntry[] {
  const stages: StageEntry[] = [];
  let failedAt: number | null = null;
  for (let n = 0; n <= LAST_STAGE; n += 1) {
    const record = records[n] ?? null;
    let entry: StageEntry;
    if (record !== null) {
      const { result, durationMs, evidence, reason } = record;
      entry = { stage: n, name: stageName(n), result, durationMs, evidence: [...evidence] };
      if (reason !== undefined) entry.reason = reason;
    } else {
      const result = failedAt === null ? 'fail' : 'not-run';
      const reason = failedAt === null ? 'stage record missing' : `stage ${failedAt} failed`;
      entry = { stage: n, name: stageName(n), result, durationMs: null, evidence: [], reason };
    }
    if (entry.result === 'fail' && failedAt === null) failedAt = n;
    stages.push(entry);
  }
  return stages;
}

type Contribution = { state: CellState; reason: string };

/** The highest-precedence state of `parts`, with the distinct reasons that carry it. */
function combine(parts: readonly Contribution[]): MatrixCell {
  const state = parts.reduce<CellState>(
    (top, part) => (CELL_PRECEDENCE[part.state] > CELL_PRECEDENCE[top] ? part.state : top),
    'pass',
  );
  const reasons = [...new Set(parts.filter((part) => part.state === state).map((part) => part.reason))];
  return { state, reason: reasons.join('; ') };
}

/** The `pending-run` part of a report that is absent or still the committed placeholder. */
function pendingReport(source: Source<unknown>): Contribution {
  const reason = source.data === null ? `${source.path} absent` : `${source.path} is the pending-run placeholder`;
  return { state: 'pending-run', reason };
}

function withRefs(id: string, refs: readonly string[] | null | undefined): string {
  return refs === null || refs === undefined || refs.length === 0 ? id : `${id} (${refs.join(', ')})`;
}

function parityPart(service: ServiceName, source: Source<ParityInput>): Contribution {
  const report = source.data;
  if (report === null || report.status === 'pending-run') return pendingReport(source);
  const rows = report.scenarios.filter((scenario) => scenario.service === service);
  if (rows.length === 0) return { state: 'pending-run', reason: `no parity scenarios for ${service} in ${source.path}` };
  const failed = rows.filter((row) => row.result === 'fail');
  if (failed.length > 0) return { state: 'fail', reason: `parity failed: ${failed.map((row) => row.id).join(', ')}` };
  const withheld = rows.filter((row) => row.result === 'withheld');
  const skipped = rows.filter((row) => row.result === FIXTURES_UNAVAILABLE);
  if (withheld.length > 0 || skipped.length > 0) {
    const reasons: string[] = [];
    if (withheld.length > 0) {
      reasons.push(`withheld: ${withheld.map((row) => withRefs(row.id, row.decisionListRef)).join('; ')}`);
    }
    if (skipped.length > 0) reasons.push(`${FIXTURES_UNAVAILABLE}: ${skipped.map((row) => row.id).join(', ')}`);
    return { state: 'unmet', reason: reasons.join('; ') };
  }
  const counts = PARITY_RESULTS.map((result) => [result, rows.filter((row) => row.result === result).length] as const)
    .filter(([, n]) => n > 0)
    .map(([result, n]) => `${n} ${result}`);
  return { state: 'pass', reason: `${rows.length} scenarios: ${counts.join(', ')}` };
}

function vitestPart(category: Exclude<MatrixColumn, 'parity'>, source: Source<VitestInput>): Contribution {
  if (source.data === null) return { state: 'pending-run', reason: `vitest JSON ${source.path} absent` };
  const segment = CATEGORY_SEGMENTS[category];
  const files = source.data.testResults
    .map((file) => ({ ...file, name: file.name.split('\\').join('/') }))
    .filter((file) => file.name.includes(segment));
  if (files.length === 0) return { state: 'unmet', reason: `no ${category} suites` };
  const failed = files.filter((file) => file.status === 'failed');
  if (failed.length > 0) {
    const names = failed.map((file) => file.name.slice(file.name.lastIndexOf(segment) + 1));
    return { state: 'fail', reason: `${failed.length} of ${files.length} ${category} files failed: ${names.join(', ')}` };
  }
  const tests = files.flatMap((file) => file.assertionResults);
  const passed = tests.filter((test) => test.status === 'passed').length;
  // A suite that skips because PostgreSQL or the emulator was unreachable must not read as a pass.
  if (passed === 0) {
    return { state: 'unmet', reason: `every ${category} test skipped (${tests.length} tests in ${files.length} files)` };
  }
  return { state: 'pass', reason: `${files.length} ${category} files, ${passed} of ${tests.length} tests passed` };
}

/** Role suffixes bootstrapped per schema; mirrors isolation/catalog.ts, whose imports hold a top-level await. */
export const SERVICE_ROLE_SUFFIXES = Object.freeze(['owner', 'app', 'migrator'] as const);

type IsolationRow = IsolationInput['services'][number];

const RLS_COUNTS = ['enabled', 'forced', 'usingAndWithCheck'] as const;

/** Failing facts of one service row: cross-tenant counts or result, pooled-connection reuse and RLS catalog counts. */
function rowFacts(row: IsolationRow): string[] {
  const facts: string[] = [];
  const reads = row.crossTenantReads ?? 0;
  const writes = row.crossTenantWrites ?? 0;
  if (reads > 0 || writes > 0 || row.result === 'fail') {
    facts.push(`${reads} cross-tenant reads, ${writes} cross-tenant writes, result ${row.result ?? 'unset'}`);
  }
  const reuse = row.pooledConnectionReuse;
  const rowsSeen = reuse?.rowsSeen ?? 0;
  if (rowsSeen > 0) facts.push(`pooledConnectionReuse.rowsSeen ${rowsSeen}`);
  if (reuse?.writeBlocked === false) facts.push('pooledConnectionReuse.writeBlocked false');
  const rls = row.rlsCatalog;
  const tables = rls?.tables;
  if (tables === 0) facts.push('rlsCatalog.tables 0');
  for (const key of RLS_COUNTS) {
    const n = rls?.[key];
    if (tables != null && n != null && n < tables) facts.push(`rlsCatalog.${key} ${n} of ${tables} tables`);
  }
  return facts;
}

/** Failing facts of the `<schema>_owner`, `_app` and `_migrator` roles in the report's role findings. */
function roleFacts(schema: string | null | undefined, roles: IsolationInput['roles']): string[] {
  if (schema === null || schema === undefined || roles === null || roles === undefined) return [];
  const own = new Set<string>(SERVICE_ROLE_SUFFIXES.map((suffix) => `${schema}_${suffix}`));
  const listed = (field: 'rolbypassrls' | 'rolsuper'): string[] =>
    (roles[field] ?? []).filter((role) => own.has(role)).map((role) => `role ${role} in roles.${field}`);
  const memberships = (roles.membershipViolations ?? [])
    .filter((violation) => own.has(violation.member))
    .map(({ member, ancestor, via }) => {
      const chain = via === null || via === undefined || via.length === 0 ? '' : ` via ${via.join(', ')}`;
      const of = ancestor === null || ancestor === undefined ? '' : ` (member of ${ancestor}${chain})`;
      return `role ${member} in roles.membershipViolations${of}`;
    });
  return [...listed('rolbypassrls'), ...listed('rolsuper'), ...memberships];
}

/** Failing facts of `service`'s `<service>.<topic>` event-consumer subscriptions. */
function consumerFacts(service: ServiceName, consumers: IsolationInput['consumers']): string[] {
  return (consumers ?? [])
    .filter((consumer) => consumer.subscription.startsWith(`${service}.`))
    .flatMap((consumer) => {
      const facts: string[] = [];
      const effects = consumer.crossTenantEffects ?? 0;
      if (effects > 0) facts.push(`crossTenantEffects ${effects}`);
      if (consumer.tenantlessRejected === false) facts.push('tenantlessRejected false');
      if (consumer.fanoutRegistryOnly === false) facts.push('fanoutRegistryOnly false');
      return facts.map((fact) => `consumer ${consumer.subscription} ${fact}`);
    });
}

function isolationPart(service: ServiceName, source: Source<IsolationInput>): Contribution {
  const report = source.data;
  if (report === null || report.status === 'pending-run') return pendingReport(source);
  const row = report.services.find((entry) => entry.service === service);
  if (row === undefined) return { state: 'pending-run', reason: `no ${service} entry in ${source.path}` };
  const facts = [...rowFacts(row), ...roleFacts(row.schema, report.roles), ...consumerFacts(service, report.consumers)];
  if (facts.length > 0) return { state: 'fail', reason: `${source.path}: ${facts.join('; ')}` };
  if (row.source === null) {
    return { state: 'pending-run', reason: `${source.path}: ${service} source null; no vitest results were shown` };
  }
  return { state: 'pass', reason: `${source.path}: no cross-tenant reads or writes` };
}

function eventsPart(service: ServiceName, source: Source<EventsInput>): Contribution {
  const report = source.data;
  if (report === null || report.status === 'pending-run') return pendingReport(source);
  const { result, topics } = report;
  if (result === 'fail') {
    const named = topics.some((topic) => topic.producer === service || topic.consumers.includes(service));
    if (named) return { state: 'fail', reason: `${source.path} result fail; ${service} produces or consumes a topic` };
    return { state: 'pass', reason: `${source.path} result fail; ${service} produces and consumes no topic` };
  }
  if (result === 'pass') return { state: 'pass', reason: `${source.path} result pass` };
  return { state: 'pending-run', reason: `${source.path} result ${result ?? 'unset'}` };
}

function securityPart(source: Source<SecurityInput>): Contribution {
  if (source.data === null) return { state: 'pending-run', reason: `${source.path} absent` };
  const { verdict, exitCode: code, error } = source.data;
  if (verdict === 'clean' && (code === undefined || code === 0)) {
    return { state: 'pass', reason: `${source.path} verdict clean` };
  }
  // A scan that could not run (verdict `error`) proves nothing, so it fails like findings do.
  const detail = error === undefined ? '' : `: ${error}`;
  return { state: 'fail', reason: `${source.path} verdict ${verdict ?? 'unset'}, exit code ${code ?? 'unset'}${detail}` };
}

/** Normalised package folder of a stage-3 `--package` entry, such as `services/identity`. */
export function packageKey(dir: string): string {
  return path.posix.normalize(dir.split('\\').join('/')).replace(/\/+$/, '');
}

/** The ten-service matrix; pure over its inputs. */
export function buildServiceMatrix(inputs: MatrixInputs): ServiceMatrixRow[] {
  const security = securityPart(inputs.security);
  return TEN_SERVICES.map((service) => {
    const vitest = inputs.vitest[service];
    const cells: Record<MatrixColumn, MatrixCell> = {
      parity: combine([parityPart(service, inputs.parity)]),
      contract: combine([vitestPart('contract', vitest)]),
      isolation: combine([vitestPart('isolation', vitest), isolationPart(service, inputs.isolation)]),
      events: combine([vitestPart('events', vitest), eventsPart(service, inputs.events)]),
      security: combine([vitestPart('security', vitest), security]),
    };
    const failedRun = inputs.packages.find(
      (entry) => packageKey(entry.package) === `services/${service}` && entry.exitCode !== 0,
    );
    if (failedRun !== undefined) {
      for (const column of MATRIX_COLUMNS) {
        const cell = cells[column];
        if (cell.state !== 'pending-run') continue;
        cells[column] = { state: 'fail', reason: `services/${service} npm test exited ${failedRun.exitCode}; ${cell.reason}` };
      }
    }
    return { service, ...cells };
  });
}

/** Inputs of {@link buildTestAllReport}; every field is read by the caller, so the build is pure. */
export interface TestAllInputs extends Omit<MatrixInputs, 'packages'> {
  /** Records of stages 0–9 by index; `null` where the record is missing. */
  records: readonly (StageRecord | null)[];
  fixtures: FixtureReport;
  generatedAt: string;
  /** Reported locations of the fixture status, the rollback rehearsal and the baseline report. */
  evidence: { fixtures: string; rollback: string; baseline: string };
}

/** `opt2/reports/test-all.json`. */
export interface TestAllReport {
  generatedBy: typeof GENERATED_BY;
  generatedAt: string;
  status: 'generated';
  exitCode: 0 | 1 | 2;
  exitCodes: typeof EXIT_CODES;
  fixtures: FixtureReport & { source: string };
  stages: StageEntry[];
  serviceMatrix: ServiceMatrixRow[];
  unmet: UnmetItem[];
  cloudPathsUntested: string;
  result: 'pass' | 'unmet' | 'fail';
}

/** Adds `item` to `items`, merging the evidence of an item already listed under the same name. */
function addUnmet(items: Map<string, UnmetItem>, item: UnmetItem): void {
  const known = items.get(item.item);
  if (known === undefined) {
    items.set(item.item, { ...item, evidence: [...new Set(item.evidence)] });
    return;
  }
  known.evidence = [...new Set([...known.evidence, ...item.evidence])];
}

function withheldItems(parity: Source<ParityInput>): UnmetItem[] {
  if (parity.data === null || parity.data.status === 'pending-run') return [];
  const byScenario = new Map<string, { refs: string[]; proposals: string[] }>();
  for (const entry of parity.data.unmetWithheld) {
    const scenario = byScenario.get(entry.id) ?? { refs: [], proposals: [] };
    const { decisionListRef: ref, proposal } = entry;
    if (typeof ref === 'string' && !scenario.refs.includes(ref)) scenario.refs.push(ref);
    if (typeof proposal === 'string' && !scenario.proposals.includes(proposal)) scenario.proposals.push(proposal);
    byScenario.set(entry.id, scenario);
  }
  return [...byScenario].map(([id, { refs, proposals }]) => {
    const entries = refs.length > 0 ? refs.join(', ') : 'an unnamed decision-list entry';
    const proposal = proposals.length > 0 ? `; proposal: ${proposals.join(' | ')}` : '';
    return {
      item: `Parity: ${id} withheld`,
      reason: `withheld pending the user's decision on ${entries}${proposal}`,
      evidence: [parity.path, ...refs],
    };
  });
}

function columnEvidence(column: MatrixColumn, service: ServiceName, inputs: Omit<MatrixInputs, 'packages'>): string[] {
  const vitest = inputs.vitest[service].path;
  switch (column) {
    case 'parity':
      return [inputs.parity.path];
    case 'contract':
      return [vitest];
    case 'isolation':
      return [vitest, inputs.isolation.path];
    case 'events':
      return [vitest, inputs.events.path];
    case 'security':
      return [vitest, inputs.security.path];
  }
}

/**
 * Unmet items: withheld parity scenarios, each stage's own items, a `timing-variance` baseline, stages left unmet,
 * skipped or not run without an own item, matrix cells not yet passing or failing, and the fixture items.
 */
export function collectUnmet(
  inputs: Omit<TestAllInputs, 'generatedAt'>,
  stages: readonly StageEntry[],
  matrix: readonly ServiceMatrixRow[],
): UnmetItem[] {
  const items = new Map<string, UnmetItem>();
  for (const item of withheldItems(inputs.parity)) addUnmet(items, item);

  const failedAt = stages.find((stage) => stage.result === 'fail')?.stage ?? null;
  for (const stage of stages) {
    const own = inputs.records[stage.stage]?.unmet ?? [];
    for (const entry of own) addUnmet(items, { ...entry, evidence: stage.evidence });
    if (stage.result === 'timing-variance') {
      addUnmet(items, {
        item: BASELINE_UNMET_ITEM,
        reason: stage.reason ?? 'the beanFeedSecurity timing spec still differed after one re-run (timing-variance)',
        evidence: stage.evidence.length > 0 ? stage.evidence : [inputs.evidence.baseline],
      });
    }
    // A stage stopped by an earlier failure is already covered by exit code 1.
    const stopped = failedAt !== null && failedAt < stage.stage;
    const unfinished = stage.result === 'unmet' || stage.result === 'skipped' || (stage.result === 'not-run' && !stopped);
    if (own.length === 0 && unfinished) {
      addUnmet(items, {
        item: `Stage ${stage.stage}: ${stage.name}`,
        reason: stage.reason === undefined ? stage.result : `${stage.result}: ${stage.reason}`,
        evidence: stage.evidence,
      });
    }
  }

  // A pending-run cell is not green, so a run that leaves one cannot report every acceptance item met.
  for (const row of matrix) {
    for (const column of MATRIX_COLUMNS) {
      const cell = row[column];
      if (cell.state !== 'unmet' && cell.state !== 'pending-run') continue;
      addUnmet(items, {
        item: `Done: ten services: ${row.service} ${column}`,
        reason: `${cell.state}: ${cell.reason}`,
        evidence: columnEvidence(column, row.service, inputs),
      });
    }
  }

  if (inputs.fixtures.available !== true) {
    const why = `legacy fixtures unavailable: ${inputs.fixtures.reason ?? 'no reason recorded'}`;
    addUnmet(items, {
      item: FIXTURE_UNMET_ITEMS[0],
      reason: `${why}; parity covers four of ten services`,
      evidence: [inputs.evidence.fixtures, inputs.parity.path],
    });
    addUnmet(items, {
      item: FIXTURE_UNMET_ITEMS[1],
      reason: `${why}; the rehearsal ran create and edit only`,
      evidence: [inputs.evidence.fixtures, inputs.evidence.rollback],
    });
  }
  return [...items.values()];
}

/** 1 when any stage or matrix cell failed, else 2 when any item is unmet, else 0. */
export function deriveExitCode(
  stages: readonly Pick<StageEntry, 'result'>[],
  matrix: readonly ServiceMatrixRow[],
  unmet: readonly UnmetItem[],
): 0 | 1 | 2 {
  const cellFailed = matrix.some((row) => MATRIX_COLUMNS.some((column) => row[column].state === 'fail'));
  if (cellFailed || stages.some((stage) => stage.result === 'fail')) return 1;
  return unmet.length > 0 ? 2 : 0;
}

const RESULT_OF_EXIT = { 0: 'pass', 1: 'fail', 2: 'unmet' } as const;

/** The test-all report body (without `sourceSha`, which the writer stamps); pure over its inputs. */
export function buildTestAllReport(inputs: TestAllInputs): TestAllReport {
  const stages = resolveStages(inputs.records);
  const serviceMatrix = buildServiceMatrix({ ...inputs, packages: inputs.records[3]?.packages ?? [] });
  const unmet = collectUnmet(inputs, stages, serviceMatrix);
  const exitCode = deriveExitCode(stages, serviceMatrix, unmet);
  return {
    generatedBy: GENERATED_BY,
    generatedAt: inputs.generatedAt,
    status: 'generated',
    exitCode,
    exitCodes: EXIT_CODES,
    fixtures: { available: inputs.fixtures.available, reason: inputs.fixtures.reason, source: FIXTURES_SOURCE },
    stages,
    serviceMatrix,
    unmet,
    cloudPathsUntested: CLOUD_PATHS_UNTESTED_STATEMENT,
    result: RESULT_OF_EXIT[exitCode],
  };
}

function mdCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function mdCodes(items: readonly string[]): string {
  return items.length === 0 ? '—' : items.map((item) => `\`${mdCell(item)}\``).join(', ');
}

/** `ms` as `850 ms`, `12.4 s` or `3 min 05 s`; `—` for `null`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

function fixtureLine(fixtures: FixtureReport): string {
  if (fixtures.available === true) return `available${fixtures.reason === null ? '' : ` (${fixtures.reason})`}`;
  const state = fixtures.available === false ? 'unavailable' : 'unknown';
  return `${state}: ${fixtures.reason ?? 'no reason recorded'}`;
}

function matrixCell(cell: MatrixCell): string {
  return mdCell(`${cell.state}: ${cell.reason}`);
}

/** Body lines of `test-all.md`, after the title and `Source SHA:` line. */
export function renderTestAllMarkdown(report: TestAllReport): string[] {
  const lines = [
    `Status: ${report.status}`,
    `Generated by: ${report.generatedBy}`,
    `Generated at: ${report.generatedAt}`,
    `Exit code: ${report.exitCode} (${report.result}: ${EXIT_CODES[`${report.exitCode}`]})`,
    `Fixtures: ${fixtureLine(report.fixtures)} (from \`${report.fixtures.source}\`)`,
    '',
  ];
  if (report.fixtures.available !== true) {
    lines.push(
      `With fixtures unavailable, parity covers four of ten services; "${FIXTURE_UNMET_ITEMS[0]}" and the ` +
        `${FIXTURE_UNMET_ITEMS[1]} are unmet.`,
      '',
    );
  }
  lines.push('## Stages', '', '| Stage | Name | Result | Duration | Evidence |', '|---|---|---|---|---|');
  for (const stage of report.stages) {
    const result = stage.reason === undefined ? stage.result : `${stage.result} (${stage.reason})`;
    lines.push(`| ${stage.stage} | ${stage.name} | ${mdCell(result)} | ${formatDuration(stage.durationMs)} | ${mdCodes(stage.evidence)} |`);
  }
  lines.push('', '## Service matrix', '', '| Service | Parity | Contract | Isolation | Events | Security |', '|---|---|---|---|---|---|');
  for (const row of report.serviceMatrix) {
    lines.push(`| ${row.service} | ${MATRIX_COLUMNS.map((column) => matrixCell(row[column])).join(' | ')} |`);
  }
  lines.push('', '## Unmet items', '');
  if (report.unmet.length === 0) lines.push('None.');
  for (const item of report.unmet) {
    lines.push(`- **${mdCell(item.item)}**: ${mdCell(item.reason)}. Evidence: ${mdCodes(item.evidence)}`);
  }
  lines.push('', '## Cloud paths', '', `${report.cloudPathsUntested}.`);
  return lines;
}

/** Injectable process inputs of {@link main}. */
export interface MainDeps {
  env?: EnvLike;
  clock?: () => Date;
  pin?: ReportOptions['pin'];
}

async function readSource<T>(file: string, schema: z.ZodType<T>, env: EnvLike): Promise<Source<T>> {
  return { path: displayPath(file, env), data: existsSync(file) ? await readJson(file, schema) : null };
}

/** Reads every stage record, stage report, vitest result and the fixture status the report is built from. */
export async function readTestAllInputs(env: EnvLike, generatedAt: string): Promise<TestAllInputs> {
  const reports = reportsDir(env);
  const stageNumbers = STAGE_NAMES.map((_, n) => n);
  const records = await Promise.all(stageNumbers.map((n) => readSource(stageRecordPath(n, env), stageRecordSchema, env)));
  const vitestEntries = await Promise.all(
    TEN_SERVICES.map(async (service) => {
      const source = await readSource(vitestResultPath(`services/${service}`, env), vitestInputSchema, env);
      return [service, source] as const;
    }),
  );
  const [parity, isolation, events, security] = await Promise.all([
    readSource(path.join(reports, 'parity.json'), parityInputSchema, env),
    readSource(path.join(reports, 'isolation.json'), isolationInputSchema, env),
    readSource(path.join(reports, 'events.json'), eventsInputSchema, env),
    readSource(path.join(stateDir(env), 'security', 'summary.json'), securityInputSchema, env),
  ]);
  const fixturesFile = path.join(stateDir(env), 'fixtures.json');
  let fixtures: FixtureReport = { available: null, reason: 'fixtures.json missing' };
  if (existsSync(fixturesFile)) {
    const status = readFixtureStatus(env);
    fixtures = { available: status.available, reason: status.reason };
  }
  return {
    records: records.map((record) => record.data),
    parity,
    vitest: Object.fromEntries(vitestEntries) as Record<ServiceName, Source<VitestInput>>,
    isolation,
    events,
    security,
    fixtures,
    generatedAt,
    evidence: {
      fixtures: displayPath(fixturesFile, env),
      rollback: displayPath(path.join(reports, 'rollback-rehearsal.md'), env),
      baseline: displayPath(path.join(reports, 'baseline.json'), env),
    },
  };
}

const RECORD_USAGE =
  'test-all record --stage <n> --result <result> --started-at <iso> --finished-at <iso> [--exit-code <n>] ' +
  '[--evidence <path>]... [--reason <text>] [--unmet <item>=<reason>]... [--package <dir>=<exitCode>]...';
const ASSEMBLE_USAGE = 'test-all [assemble] [--exit-code] [--no-write]';
const HELP = `${ASSEMBLE_USAGE} [--help]
${RECORD_USAGE} [--help]

record    Writes \${OPT2_STATE_DIR}/test-all/stage-<n>.json for one stage of harness/repro/test-all.sh. Recording
          stage 0 starts a run: it removes the records of stages 1–${LAST_STAGE} left by an earlier run.
            --stage <n>                 0–${LAST_STAGE}: ${STAGE_NAMES.map((name, n) => `${n} ${name}`).join(', ')}
            --result <result>           ${STAGE_RESULTS.join(', ')}
            --started-at, --finished-at ISO-8601 timestamps (Z or an offset); durationMs is their difference
            --exit-code <n>             the stage's exit code
            --evidence <path>           repeatable; absolute paths are recorded repository- or state-relative
            --reason <text>             why the stage did not pass
            --unmet <item>=<reason>     repeatable acceptance item left unmet by the stage
            --package <dir>=<exitCode>  repeatable npm test exit code per package (stage 3)
assemble  (default) Builds test-all.json and test-all.md in OPT2_REPORTS_DIR (default opt2/reports) from the stage
          records, parity.json, isolation.json, events.json, \${OPT2_STATE_DIR}/security/summary.json, the vitest
          results under \${OPT2_STATE_DIR}/test-all/vitest and \${OPT2_STATE_DIR}/fixtures.json.
            --exit-code   exit with the report's exit code: ${Object.entries(EXIT_CODES)
              .map(([code, meaning]) => `${code} ${meaning}`)
              .join('; ')}
            --no-write    print the summary only; write no report

Output: one JSON summary line on stdout. Exit: 0 written (or the report's code with --exit-code), 1 a failure,
2 usage error.

Examples (from harness/):
  npm run report:test-all -- record --stage 0 --result pass --started-at 2026-06-30T10:00:00Z --finished-at 2026-06-30T10:00:42Z
  npm run report:test-all -- --exit-code`;

function required(flag: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new UsageError(`${flag} is required`, RECORD_USAGE);
  return value;
}

function integerFlag(flag: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} ${value}: not a non-negative integer`, RECORD_USAGE);
  return Number(value);
}

function splitPair(flag: string, value: string, at: 'first' | 'last'): [string, string] {
  const i = at === 'first' ? value.indexOf('=') : value.lastIndexOf('=');
  if (i <= 0 || i === value.length - 1) throw new UsageError(`${flag} ${value}: expected <name>=<value>`, RECORD_USAGE);
  return [value.slice(0, i), value.slice(i + 1)];
}

/** `record` subcommand: validates the flags and writes the stage record with stable JSON. */
export async function recordStage(argv: string[], deps: MainDeps = {}): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: {
      stage: { type: 'string' },
      result: { type: 'string' },
      'started-at': { type: 'string' },
      'finished-at': { type: 'string' },
      'exit-code': { type: 'string' },
      evidence: { type: 'string', multiple: true },
      reason: { type: 'string' },
      unmet: { type: 'string', multiple: true },
      package: { type: 'string', multiple: true },
    },
    usage: RECORD_USAGE,
    help: HELP,
  });
  const env = deps.env ?? process.env;
  const stage = integerFlag('--stage', required('--stage', values.stage));
  const startedAt = required('--started-at', values['started-at']);
  const finishedAt = required('--finished-at', values['finished-at']);
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  if (durationMs < 0) throw new UsageError(`--finished-at ${finishedAt} precedes --started-at ${startedAt}`, RECORD_USAGE);
  const parsed = stageRecordSchema.safeParse({
    stage,
    name: stageName(stage),
    result: required('--result', values.result),
    startedAt,
    finishedAt,
    durationMs,
    exitCode: values['exit-code'] === undefined ? undefined : integerFlag('--exit-code', values['exit-code']),
    evidence: (values.evidence ?? []).map((evidence) => displayPath(evidence, env)),
    reason: values.reason,
    unmet: values.unmet?.map((entry) => {
      const [item, reason] = splitPair('--unmet', entry, 'first');
      return { item, reason };
    }),
    packages: values.package?.map((entry) => {
      const [dir, code] = splitPair('--package', entry, 'last');
      return { package: packageKey(dir), exitCode: integerFlag('--package', code) };
    }),
  });
  if (!parsed.success) throw new UsageError(z.prettifyError(parsed.error), RECORD_USAGE);

  const file = stageRecordPath(stage, env);
  await mkdir(path.dirname(file), { recursive: true });
  // Stage 0 opens a run, so records left by an earlier run are never read as this run's.
  if (stage === 0) {
    const later = STAGE_NAMES.map((_, n) => n).filter((n) => n > 0);
    await Promise.all(later.map((n) => rm(stageRecordPath(n, env), { force: true })));
  }
  await writeFile(file, stableStringify(parsed.data), 'utf8');
  return { summary: { stage, result: parsed.data.result, durationMs, path: displayPath(file, env) } };
}

/** `assemble` subcommand: builds the report and writes both files unless `--no-write`. */
export async function assemble(argv: string[], deps: MainDeps = {}): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: { 'exit-code': { type: 'boolean' }, 'no-write': { type: 'boolean' } },
    usage: ASSEMBLE_USAGE,
    help: HELP,
  });
  const env = deps.env ?? process.env;
  const generatedAt = (deps.clock ?? (() => new Date()))().toISOString();
  const report = buildTestAllReport(await readTestAllInputs(env, generatedAt));

  const written: { json?: string; md?: string } = {};
  if (values['no-write'] !== true) {
    const dir = reportsDir(env);
    const opts = { generatedBy: GENERATED_BY, pin: deps.pin };
    written.json = displayPath((await writeJsonReport(path.join(dir, 'test-all.json'), { ...report }, opts)).path, env);
    written.md = displayPath(
      await writeMarkdown(path.join(dir, 'test-all.md'), 'Test-all report', renderTestAllMarkdown(report), { pin: deps.pin }),
      env,
    );
  }
  return {
    code: values['exit-code'] === true ? report.exitCode : 0,
    summary: {
      exitCode: report.exitCode,
      result: report.result,
      unmet: report.unmet.length,
      failingStages: report.stages.filter((stage) => stage.result === 'fail').map((stage) => stage.stage),
      written: values['no-write'] !== true,
      ...written,
    },
  };
}

/** CLI entry: `record` writes one stage record; `assemble`, the default, writes the test-all report. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<CliOutcome> {
  const [command, ...rest] = argv;
  if (command === 'record') return recordStage(rest, deps);
  if (command === 'assemble') return assemble(rest, deps);
  return assemble(argv, deps);
}

if (isMainModule(import.meta.url)) void runCli(main);
