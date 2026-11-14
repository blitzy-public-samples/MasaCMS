// Runs one scripted migration fault end to end (fault, resume, reconcile) and re-exports the faults folder's public API.
import { setTimeout as delay } from 'node:timers/promises';

import { serializeError } from '@opt2/platform/logging';

import type { MigrationConfig } from '../config.js';
import type { MigrationContext } from '../context.js';
import { currentAuthority } from '../cutover/index.js';
import {
  GENERATED_BY,
  MEASURES,
  RECONCILIATION_DIR,
  ReconcileUsageError,
  fileUnitIds,
  reconcileUnits,
  regenerateSummary,
  reportTargetFor,
  resolvePoint,
  writeReconciliationReport,
  type LegacySource,
  type ReconcileReport,
  type ReconcileResult,
  type ReconcileUnitsOptions,
  type ResolvedPoint,
} from '../reconcile/index.js';
import { writeJsonReport } from '../reports/index.js';
import { latestSnapshot, type SnapshotRecord } from '../snapshot/index.js';
import { createProcessControl, type ProcessControl } from './process-control.js';
import { remoteFaults } from './registry.js';
import { FAULT_SCRIPTS } from './scripts/index.js';
import type { FaultAssertion, FaultEnv, FaultResumeOutput, FaultRunOutput, FaultScript } from './scripts/types.js';

export {
  createFaultRegistry,
  remoteFaults,
  REGISTRY_FAULT_NAMES,
  UnknownFaultError,
  FaultParamsError,
  FaultInjectedError,
  FaultCallError,
  type FaultRegistry,
  type ActiveFault,
  type RegistryFaultName,
  type RemoteFaults,
} from './registry.js';
export {
  createProcessControl,
  spawnChild,
  migrateCliPath,
  outboxCliPath,
  upJsonSchema,
  ProcessEntryError,
  ProcessControlError,
  type ProcessControl,
  type UpProcessEntry,
  type ChildOutcome,
} from './process-control.js';
export { FAULT_SCRIPTS } from './scripts/index.js';
export type { FaultScript, FaultEnv, FaultAssertion, FaultRunOutput, FaultResumeOutput } from './scripts/types.js';

/** Scripted fault ids, in the order of `faults` in the migration config. */
export const FAULT_NAMES = [
  'applier-killed-mid-batch',
  'duplicate-batch',
  'mssql-dropped-mid-extract',
  'service-restarted-mid-apply',
  'pubsub-redelivery',
  'window-import-interrupted',
  'projector-delay',
  'forced-reinit',
] as const;

/** Id of one scripted fault. */
export type FaultName = (typeof FAULT_NAMES)[number];

// A fault id without a script fails compilation here.
const DEFAULT_SCRIPTS = FAULT_SCRIPTS satisfies Readonly<Record<FaultName, FaultScript>>;

const POINT_PREFIX = 'after-fault-';

/** Unknown fault name or parameters its script's schema rejects; the CLI exits 2 on it. */
export class FaultUsageError extends Error {
  // `name` stays the error class, as on the folder's other errors, so the fault id is `fault`.
  override readonly name = 'FaultUsageError';
  readonly exitCode = 2;

  constructor(
    readonly fault: string,
    readonly reason: string,
  ) {
    super(`Fault "${fault}": ${reason}`);
  }
}

/** Throws unless `config.faults` names exactly {@link FAULT_NAMES}, in the same order. */
export function assertFaultNamesMatchConfig(config: Pick<MigrationConfig, 'faults'>): void {
  const configured = config.faults.map((fault) => fault.name);
  if (configured.length === FAULT_NAMES.length && configured.every((name, index) => name === FAULT_NAMES[index])) return;
  throw new Error(`The migration config lists faults [${configured.join(', ')}], but the fault scripts are [${FAULT_NAMES.join(', ')}]`);
}

/** Step of a fault run that failed. */
export type FaultPhase = 'run' | 'resume' | 'reconcile';

/** A failure of one step, kept as its error class and message. */
export interface FaultError {
  phase: FaultPhase;
  message: string;
}

/** The `fault` block of `reconciliation/after-fault-<name>.json`; `steps` are the recovery steps `resume` performed. */
export interface FaultReportBlock {
  name: FaultName;
  params: unknown;
  outcome: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  tableVersion: string | null;
  assertions: FaultAssertion[];
  steps: string[];
  details?: { run?: Record<string, unknown>; resume?: Record<string, unknown> };
  error?: FaultError;
  resumeError?: FaultError;
}

/** Outcome of {@link runFault}; `exitCode` is 0 only for a passed, zero-difference fault or an accepted toggle. */
export interface RunFaultResult {
  name: FaultName;
  outcome: 'passed' | 'failed' | 'toggled';
  assertions: FaultAssertion[];
  /** The first failure, of `run`, `resume` or `reconcile`. */
  error?: FaultError;
  /** Absent for a toggle fault, which has no reconciliation point. */
  reconciliation?: { point: string; result: ReconcileResult; reportPath: string };
  exitCode: 0 | 1;
}

/** Scripts by fault id; a fault without an entry is unknown. */
export type FaultScriptTable = Readonly<Partial<Record<FaultName, FaultScript>>>;

/** Ports {@link runFault} uses instead of its defaults, for example fakes in tests. */
export interface RunFaultDeps {
  scripts?: FaultScriptTable;
  processControl?: ProcessControl;
  remote?: FaultEnv['remote'];
  reconcile?: (ctx: MigrationContext, options: ReconcileUnitsOptions) => Promise<ReconcileReport>;
  writeReport?: (ctx: MigrationContext, report: ReconcileReport) => Promise<string>;
  latestSnapshot?: (ctx: MigrationContext) => Promise<SnapshotRecord | null>;
  sleep?: (ms: number) => Promise<void>;
}

/** What a reconciliation that threw leaves known, for its report. */
interface PartialPoint {
  expectedTableVersion: string | null;
  legacySource: LegacySource | null;
  snapshotSeq: number | null;
}

function isFaultName(name: string): name is FaultName {
  return (FAULT_NAMES as readonly string[]).includes(name);
}

/** `phase`'s failure, also logged with its stack, which the record does not keep. */
function failure(ctx: MigrationContext, name: FaultName, phase: FaultPhase, error: unknown): FaultError {
  ctx.logger.warn({ error: serializeError(error) }, `fault ${name} ${phase} failed`);
  return { phase, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
}

function hasFailedAssertion(assertions: readonly FaultAssertion[]): boolean {
  return assertions.some((assertion) => assertion.status === 'fail');
}

/** The script of `name`, and `params` parsed by its schema. @throws FaultUsageError */
function resolveScript(scripts: FaultScriptTable, name: string, params: unknown): { fault: FaultName; script: FaultScript; parsed: unknown } {
  const script = isFaultName(name) ? scripts[name] : undefined;
  if (!isFaultName(name) || script === undefined) {
    throw new FaultUsageError(name, `unknown fault; known: ${FAULT_NAMES.join(', ')}`);
  }
  const result = script.paramsSchema.safeParse(params ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new FaultUsageError(name, `invalid parameters: ${issues.join('; ')}`);
  }
  return { fault: name, script, parsed: result.data };
}

/** Runs a fault that has no reconciliation point; a throw or a failed assertion fails it. */
async function runToggle(ctx: MigrationContext, env: FaultEnv, fault: FaultName, script: FaultScript, params: unknown): Promise<RunFaultResult> {
  let output: FaultRunOutput;
  try {
    output = await script.run(env, params);
  } catch (error) {
    return { name: fault, outcome: 'failed', assertions: [], error: failure(ctx, fault, 'run', error), exitCode: 1 };
  }
  const failed = hasFailedAssertion(output.assertions);
  return { name: fault, outcome: failed ? 'failed' : 'toggled', assertions: output.assertions, exitCode: failed ? 1 : 0 };
}

/** Legacy database a fault point reads and the snapshot sequence it records. @throws ReconcileUsageError when a snapshot point has no ready snapshot */
async function legacySideOf(
  ctx: MigrationContext,
  latest: NonNullable<RunFaultDeps['latestSnapshot']>,
  point: ResolvedPoint,
): Promise<{ database: string; snapshotSeq: number | null }> {
  const snapshot = await latest(ctx);
  if (point.legacySource === 'live') return { database: ctx.env.MURA_DATABASE, snapshotSeq: snapshot?.seq ?? null };
  if (snapshot === null) throw new ReconcileUsageError(`Point ${point.name} needs a ready snapshot to compare against, and none was found`);
  return { database: snapshot.databaseName, snapshotSeq: snapshot.seq };
}

/** `params.units` when the script's parameters carry units, else every catalog unit plus the file units. */
function unitsOf(ctx: MigrationContext, params: unknown): readonly string[] {
  // Only a script schema that declares `units` as a string array produces the key, so the parsed value is trusted.
  const requested = (params as { units?: readonly string[] } | null | undefined)?.units;
  // The catalog does not list the file units, and their object manifest is one of the zero-tolerance measures.
  return requested ?? [...ctx.catalog.units().map((unit) => unit.id), ...fileUnitIds(ctx.config)];
}

type Reconciled = { ok: true; report: ReconcileReport } | { ok: false; error: FaultError; known: PartialPoint };

/** Reconciles the fault's point; a failure of point, snapshot or comparison is returned with what was resolved before it. */
async function reconcilePoint(ctx: MigrationContext, deps: RunFaultDeps, fault: FaultName, point: string, params: unknown): Promise<Reconciled> {
  const known: PartialPoint = { expectedTableVersion: null, legacySource: null, snapshotSeq: null };
  try {
    const resolved = resolvePoint(ctx.config, point);
    known.expectedTableVersion = resolved.expectedTableVersion;
    known.legacySource = resolved.legacySource;
    const { database, snapshotSeq } = await legacySideOf(ctx, deps.latestSnapshot ?? latestSnapshot, resolved);
    known.snapshotSeq = snapshotSeq;
    const reconcile = deps.reconcile ?? reconcileUnits;
    const report = await reconcile(ctx, { point, units: unitsOf(ctx, params), database, snapshotSeq, legacySource: resolved.legacySource });
    return { ok: true, report };
  } catch (error) {
    return { ok: false, error: failure(ctx, fault, 'reconcile', error), known };
  }
}

/** Writes `reconciliation/<point>.json` for a reconciliation that failed, regenerates `summary.md` and returns the report's path. */
async function writeFailedReconciliation(
  ctx: MigrationContext,
  point: string,
  failed: Extract<Reconciled, { ok: false }>,
  fault: FaultReportBlock,
): Promise<string> {
  // buildReport needs a resolved point and a file-store state, which a failed reconciliation may not have reached.
  const body = {
    point,
    expectedTableVersion: failed.known.expectedTableVersion,
    tableVersion: fault.tableVersion,
    snapshotSeq: failed.known.snapshotSeq,
    legacySource: failed.known.legacySource,
    tolerance: 0,
    measures: [...MEASURES],
    units: [],
    summary: { units: 0, unitsWithDifferences: 0, orphans: 0 },
    fileStore: null,
    result: 'difference' satisfies ReconcileResult,
    error: failed.error,
    fault,
  };
  const target = reportTargetFor(ctx);
  const written = await writeJsonReport(target, `${RECONCILIATION_DIR}/${point}.json`, body, {
    clock: ctx.clock,
    generatedBy: GENERATED_BY,
    status: 'generated',
  });
  await regenerateSummary(target, ctx.config);
  return written.path;
}

/** Runs, always resumes, then reconciles at `after-fault-<fault>` and writes that report on every path. */
async function runReconciling(
  ctx: MigrationContext,
  deps: RunFaultDeps,
  env: FaultEnv,
  fault: FaultName,
  script: FaultScript,
  params: unknown,
): Promise<RunFaultResult> {
  const startedAt = ctx.clock.now().toISOString();
  let tableVersion: string | null = null;
  let runOutput: FaultRunOutput | undefined;
  let runError: FaultError | undefined;
  try {
    // Read before injecting: an unreadable cut-over status skips the fault, which is still resumed and reported.
    tableVersion = (await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths })).tableVersion;
    runOutput = await script.run(env, params);
  } catch (error) {
    runError = failure(ctx, fault, 'run', error);
  }
  let resumeOutput: FaultResumeOutput | undefined;
  let resumeError: FaultError | undefined;
  try {
    resumeOutput = await script.resume(env, params, runOutput);
  } catch (error) {
    resumeError = failure(ctx, fault, 'resume', error);
  }

  const assertions = [...(runOutput?.assertions ?? []), ...(resumeOutput?.assertions ?? [])];
  const outcome = runError !== undefined || resumeError !== undefined || hasFailedAssertion(assertions) ? 'failed' : 'passed';
  const details = {
    ...(runOutput?.details === undefined ? {} : { run: runOutput.details }),
    ...(resumeOutput?.details === undefined ? {} : { resume: resumeOutput.details }),
  };
  const block: FaultReportBlock = {
    name: fault,
    params,
    outcome,
    startedAt,
    finishedAt: ctx.clock.now().toISOString(),
    tableVersion,
    assertions,
    steps: resumeOutput?.steps ?? [],
    ...(Object.keys(details).length === 0 ? {} : { details }),
    ...(runError === undefined ? {} : { error: runError }),
    ...(resumeError === undefined ? {} : { resumeError }),
  };

  const point = `${POINT_PREFIX}${fault}`;
  const reconciled = await reconcilePoint(ctx, deps, fault, point, params);
  let result: ReconcileResult;
  let reportPath: string;
  if (reconciled.ok) {
    result = outcome === 'failed' ? 'difference' : reconciled.report.result;
    const written: ReconcileReport & { fault: FaultReportBlock } = { ...reconciled.report, result, fault: block };
    reportPath = await (deps.writeReport ?? writeReconciliationReport)(ctx, written);
  } else {
    result = 'difference';
    reportPath = await writeFailedReconciliation(ctx, point, reconciled, block);
  }

  const error = runError ?? resumeError ?? (reconciled.ok ? undefined : reconciled.error);
  return {
    name: fault,
    outcome,
    assertions,
    ...(error === undefined ? {} : { error }),
    reconciliation: { point, result, reportPath },
    exitCode: outcome === 'passed' && result === 'zero-difference' ? 0 : 1,
  };
}

/** Runs fault `name`: parses `params`, injects and resumes it, then reconciles unless it is a toggle. @throws FaultUsageError */
export async function runFault(ctx: MigrationContext, name: string, params?: unknown, deps: RunFaultDeps = {}): Promise<RunFaultResult> {
  assertFaultNamesMatchConfig(ctx.config);
  const { fault, script, parsed } = resolveScript(deps.scripts ?? DEFAULT_SCRIPTS, name, params);
  const env: FaultEnv = {
    ctx,
    processControl: deps.processControl ?? createProcessControl({ stateDir: ctx.env.OPT2_STATE_DIR }),
    remote: deps.remote ?? remoteFaults(ctx),
    sleep: deps.sleep ?? ((ms) => delay(ms)),
    clock: ctx.clock,
    logger: ctx.logger,
  };
  return script.reconciles ? runReconciling(ctx, deps, env, fault, script, parsed) : runToggle(ctx, env, fault, script, parsed);
}

