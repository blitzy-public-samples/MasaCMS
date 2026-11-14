// Cut-over transitions of the migration service: one `migration.transition` row each, driven step by step and resumable.
import path from 'node:path';

import { LegacyApiError, cfUuid } from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import type { MetadataTx } from '@opt2/platform/tenancy';

import { resolveReportsDir } from '../config.js';
import type { MigrationContext } from '../context.js';
import type { components } from '../generated/openapi.js';
import { resolveReportTarget, upsertLogEntry, type ReportTarget, type TransitionLogEntry } from '../reports/index.js';
import type { Projector } from '../reverse/index.js';
import type { SchedulerService } from '../scheduler/index.js';
import type { WindowService } from '../windows/index.js';

import {
  TERMINAL_TRANSITION_STATES,
  TRANSITION_STEPS,
  TransitionAbortedError,
  TransitionPreconditionError,
  abortTransition,
  contractTransitionState,
  createTransitionStartupGuard,
  initialTransitionProgress,
  planTransition,
  runTransitionStep,
  type ClosedGate,
  type StepDeps,
  type StepOutcome,
  type TransitionPlan,
  type TransitionProgress,
  type TransitionRecord,
  type TransitionStartupGuard,
  type TransitionState,
  type TransitionStepLog,
  type TransitionStepNumber,
} from './steps.js';

/** A transition as `transitionStart` and `transitionGet` answer it. */
export type TransitionView = components['schemas']['Transition'];

/** Ports of {@link createTransitionService}; `startupGuard` defaults to {@link createTransitionStartupGuard}. */
export interface TransitionServiceOptions {
  projector: Pick<Projector, 'awaitProjection'>;
  windows: Pick<WindowService, 'get'>;
  scheduler: SchedulerService;
  startupGuard?: TransitionStartupGuard;
  sleep?: (ms: number) => Promise<void>;
}

/** Input of {@link TransitionService.start}. */
export interface TransitionStartInput {
  /** Cut-over version to activate, for example `v0002`. */
  to: string;
  /** Recorded as `requested_by`; defaults to the role every `transitionStart` caller holds. */
  requestedBy?: string;
}

/** Cut-over transitions of the migration service. */
export interface TransitionService {
  /**
   * Refuses a transition that may not start, records it and runs it in the background.
   * @throws TransitionInProgressError, TransitionPreconditionError, LegacyApiError (`invalidParameters`) for an unknown version
   */
  start(input: TransitionStartInput): Promise<TransitionView>;
  /** @throws TransitionNotFoundError */
  get(transitionId: string): Promise<TransitionView>;
  /** Continues the non-terminal transition, if any, from its persisted state unless this process already runs it. */
  resume(): Promise<TransitionView | null>;
  /** Lets each running transition finish its current step, then waits for it; the rows stay resumable. */
  stop(): Promise<void>;
}

/** Another transition has not finished yet. */
export class TransitionInProgressError extends Error {
  override readonly name: string = 'TransitionInProgressError';
  readonly statusCode = 409;

  constructor(readonly activeId: string) {
    super(`Transition ${activeId} is still in progress`);
  }
}

/** No transition has this id. */
export class TransitionNotFoundError extends Error {
  override readonly name: string = 'TransitionNotFoundError';
  readonly statusCode = 404;

  constructor(readonly transitionId: string) {
    super(`No transition ${transitionId}`);
  }
}

const COLUMNS =
  'transition_id, from_version, to_version, state, step, units, entries, frozen_routes, paused, closed_gates, snapshot_seq, reconciliation, error, requested_by, started_at, updated_at, finished_at';
const REPORT_FILE = 'transitions.json';
/** Where the contract locates reconciliation reports, relative to the repository root. */
const RECONCILIATION_REPORTS = 'opt2/reports/reconciliation';
const DEFAULT_REQUESTER = 'platform.operator';
const UNIQUE_VIOLATION = '23505';
const ACTIVE_INDEX = 'transition_active_uidx';
const ACTIVATE_STEP: TransitionStepNumber = 7;
const LAST_STEP: TransitionStepNumber = 8;
const OUTCOME: Readonly<Partial<Record<TransitionState, TransitionLogEntry['outcome']>>> = {
  completed: 'activated',
  aborted: 'aborted',
  failed: 'aborted',
};

// The table has no plan, progress or step-log columns: the plan and the step log share `entries`, the progress fields
// without a column of their own go to `paused`, and the last completed step is `step - 1` (8 once completed).
/** `entries`: the plan step 1 derives, `null` before, and the step log. */
interface StoredEntries {
  plan: TransitionPlan | null;
  steps: TransitionStepLog[];
}

/** `paused`: the progress without the fields stored in `closed_gates`, `snapshot_seq` and `reconciliation`. */
type StoredProgress = Omit<TransitionProgress, 'closedGates' | 'snapshotSeq' | 'reconciliation'>;

/** `error`: why the transition aborted or failed, at the step it had reached. */
interface ErrorDoc {
  step: number;
  message: string;
}

/** One `migration.transition` row. */
interface TransitionRow {
  transition_id: string;
  from_version: string;
  to_version: string;
  state: TransitionState;
  step: number;
  units: string[];
  entries: StoredEntries;
  frozen_routes: string[];
  paused: StoredProgress;
  closed_gates: ClosedGate[];
  snapshot_seq: number | null;
  reconciliation: TransitionProgress['reconciliation'] | null;
  error: ErrorDoc | null;
  requested_by: string;
  started_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transitionTable(tx: MetadataTx): string {
  return `${tx.schema}.transition`;
}

/** A step refused the transition: it cannot succeed by running the step again. */
function isRefusal(error: unknown): error is TransitionAbortedError | TransitionPreconditionError {
  return error instanceof TransitionAbortedError || error instanceof TransitionPreconditionError;
}

/** `error` is the missing version file of the proposed version `to`. */
function isMissingVersion(error: unknown, to: string): boolean {
  const { code, path: file } = (error ?? {}) as NodeJS.ErrnoException;
  return code === 'ENOENT' && typeof file === 'string' && path.basename(file) === `${to}.json`;
}

/** `error` is the insert of a second non-terminal transition. */
function isActiveConflict(error: unknown): boolean {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === ACTIVE_INDEX;
}

/** The step the transition is at: the one running or next, the one it stopped at, or 8 once completed. */
function currentStep(record: Pick<TransitionRecord, 'state' | 'lastStep'>): TransitionStepNumber {
  return record.state === 'completed' ? LAST_STEP : (Math.min(record.lastStep + 1, LAST_STEP) as TransitionStepNumber);
}

function toRecord(row: TransitionRow): TransitionRecord {
  const { plan, steps } = row.entries;
  const progress: TransitionProgress = {
    ...row.paused,
    closedGates: row.closed_gates,
    ...(row.snapshot_seq === null ? {} : { snapshotSeq: row.snapshot_seq }),
    ...(row.reconciliation === null ? {} : { reconciliation: row.reconciliation }),
  };
  return {
    transitionId: row.transition_id,
    from: row.from_version,
    to: row.to_version,
    state: row.state,
    lastStep: row.state === 'completed' ? LAST_STEP : ((row.step - 1) as TransitionRecord['lastStep']),
    ...(plan === null ? {} : { plan }),
    progress,
    steps,
    ...(row.error === null ? {} : { abortReason: row.error.message }),
    startedAt: row.started_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at.toISOString() }),
  };
}

/** Values of the columns a transition changes, in the order of `$2…$13` of the update. */
function mutableColumns(record: TransitionRecord): unknown[] {
  const { closedGates, snapshotSeq, reconciliation, ...rest } = record.progress;
  const entries: StoredEntries = { plan: record.plan ?? null, steps: record.steps };
  const error: ErrorDoc | undefined = record.abortReason === undefined ? undefined : { step: currentStep(record), message: record.abortReason };
  return [
    record.state,
    currentStep(record),
    record.plan?.setT ?? [],
    JSON.stringify(entries),
    record.plan?.frozenRoutes ?? [],
    JSON.stringify(rest satisfies StoredProgress),
    JSON.stringify(closedGates),
    snapshotSeq ?? null,
    reconciliation === undefined ? null : JSON.stringify(reconciliation),
    error === undefined ? null : JSON.stringify(error),
    new Date(record.updatedAt),
    record.finishedAt === undefined ? null : new Date(record.finishedAt),
  ];
}

/** Repository-relative path of a reconciliation report, which the steps record as an absolute path. */
function reconciliationRef(reportPath: string): string {
  return `${RECONCILIATION_REPORTS}/${path.basename(reportPath)}`;
}

/** The reconciliation of `T` as the view shows it. */
function reconciliationOf(progress: TransitionProgress): NonNullable<TransitionView['reconciliation']> | undefined {
  const done = progress.reconciliation;
  if (done === undefined) return undefined;
  return { report: reconciliationRef(done.reportPath), differences: done.differences, point: done.point, result: done.result };
}

/** Why the transition stopped: its abort reason, else the failure of the step it is at, which `resume()` runs again. */
function errorOf(record: TransitionRecord): NonNullable<TransitionView['error']> | undefined {
  const step = currentStep(record);
  const name = TRANSITION_STEPS.find((definition) => definition.step === step)?.name;
  if (record.abortReason !== undefined) return { step, name, message: record.abortReason, state: record.state };
  const last = record.steps.at(-1);
  if (last?.step !== step || last.result !== 'error' || last.detail === undefined) return undefined;
  return { step, name, message: last.detail, state: record.state };
}

/**
 * The `Transition` view of `record`. The contract admits no further top-level field, so the step name and the row
 * state travel inside `error`, and the step log and changed entries stay in the row and `transitions.json`.
 */
export function toTransitionView(record: TransitionRecord): TransitionView {
  const reconciliation = reconciliationOf(record.progress);
  const error = errorOf(record);
  return {
    transitionId: record.transitionId,
    fromVersion: record.from,
    toVersion: record.to,
    state: contractTransitionState(record.state),
    step: currentStep(record),
    units: record.plan?.setT ?? [],
    frozenRoutes: record.plan?.frozenRoutes ?? [],
    startedAt: record.startedAt,
    ...(reconciliation === undefined ? {} : { reconciliation }),
    ...(error === undefined ? {} : { error }),
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
  };
}

/** The reconciliation as `transitions.json` keeps it: the report writer keeps a `path` value and digests a `report` one. */
function logReconciliation(reconciliation: NonNullable<TransitionProgress['reconciliation']>): Record<string, unknown> {
  const { point, result, differences, reportPath } = reconciliation;
  return { point, result, differences, path: reconciliationRef(reportPath) };
}

/** The `transitions.json` entry of `record`. */
function toLogEntry(record: TransitionRecord): TransitionLogEntry {
  const { plan } = record;
  const { reconciliation } = record.progress;
  const outcome = OUTCOME[record.state];
  return {
    transitionId: record.transitionId,
    from: record.from,
    to: record.to,
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    setT: plan?.setT ?? [],
    entriesChanged: plan?.entriesChanged.map((change) => change.route) ?? [],
    legacyWriteEntries: plan?.legacyWriteEntries ?? [],
    steps: record.steps.map(({ step, name, startedAt, finishedAt, result }) => ({
      step,
      name,
      startedAt,
      ...(finishedAt === undefined ? {} : { finishedAt }),
      ...(result === undefined ? {} : { result }),
    })),
    ...(reconciliation === undefined ? {} : { reconciliation: logReconciliation(reconciliation) }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(record.abortReason === undefined ? {} : { abortReason: record.abortReason }),
  };
}

/** Creates the transition service over the context's `migration` pool; `server.ts` calls `resume()` at start and `stop()` before closing. */
export function createTransitionService(ctx: MigrationContext, options: TransitionServiceOptions): TransitionService {
  const startupGuard = options.startupGuard ?? createTransitionStartupGuard(ctx);
  // One loop per transition id in this process, so start and resume never drive the same transition twice.
  const loops = new Map<string, Promise<void>>();
  let stopping = false;
  let reportTarget: ReportTarget | undefined;

  const now = (): string => ctx.clock.now().toISOString();

  function stepDeps(record: TransitionRecord): StepDeps {
    return {
      ctx,
      projector: options.projector,
      windows: options.windows,
      scheduler: options.scheduler,
      startupGuard,
      sleep: options.sleep,
      persist: async (progress) => {
        record.progress = progress;
        await persistRecord(record);
      },
    };
  }

  /** Mirrors the row into `transitions.json`; the row is the record, so a failed mirror is only logged. */
  async function report(record: TransitionRecord): Promise<void> {
    try {
      reportTarget ??= resolveReportTarget({ reportsDir: resolveReportsDir(ctx.config, ctx.env), sourceShaFile: ctx.config.paths.sourcePin });
      await upsertLogEntry(reportTarget, REPORT_FILE, 'transitionId', toLogEntry(record), { clock: ctx.clock });
    } catch (error) {
      ctx.logger.error({ error: serializeError(error) }, `Recording transition ${record.transitionId} in ${REPORT_FILE} failed`);
    }
  }

  async function selectOne(where: string, values: unknown[]): Promise<TransitionRecord | undefined> {
    const { rows } = await ctx.db.withMetadata((tx) =>
      tx.query<TransitionRow>(`SELECT ${COLUMNS} FROM ${transitionTable(tx)} WHERE ${where}`, values),
    );
    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  const load = (transitionId: string): Promise<TransitionRecord | undefined> => selectOne('transition_id = $1', [transitionId]);
  const loadActive = (): Promise<TransitionRecord | undefined> =>
    selectOne('state <> ALL($1::text[])', [[...TERMINAL_TRANSITION_STATES]]);

  /** Inserts the new row. @throws TransitionInProgressError when another transition holds `transition_active_uidx` */
  async function insert(record: TransitionRecord, requestedBy: string): Promise<void> {
    try {
      await ctx.db.withMetadata((tx) =>
        tx.query(
          `INSERT INTO ${transitionTable(tx)}
             (transition_id, from_version, to_version, requested_by, started_at, state, step, units, entries, frozen_routes, paused,
              closed_gates, snapshot_seq, reconciliation, error, updated_at, finished_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb, $10::text[], $11::jsonb, $12::jsonb, $13, $14::jsonb, $15::jsonb, $16, $17)`,
          [record.transitionId, record.from, record.to, requestedBy, new Date(record.startedAt), ...mutableColumns(record)],
        ),
      );
    } catch (error) {
      if (!isActiveConflict(error)) throw error;
      const active = await loadActive();
      if (active === undefined) throw error;
      throw new TransitionInProgressError(active.transitionId);
    }
    await report(record);
  }

  /** Writes `record` onto its non-terminal row, bumping `updated_at`, then mirrors it into the report. */
  async function persistRecord(record: TransitionRecord): Promise<void> {
    record.updatedAt = now();
    const { rowCount } = await ctx.db.withMetadata((tx) =>
      tx.query(
        `UPDATE ${transitionTable(tx)}
            SET state = $2, step = $3, units = $4::text[], entries = $5::jsonb, frozen_routes = $6::text[], paused = $7::jsonb,
                closed_gates = $8::jsonb, snapshot_seq = $9, reconciliation = $10::jsonb, error = $11::jsonb, updated_at = $12, finished_at = $13
          WHERE transition_id = $1 AND state <> ALL($14::text[])`,
        [record.transitionId, ...mutableColumns(record), [...TERMINAL_TRANSITION_STATES]],
      ),
    );
    if ((rowCount ?? 0) === 0) throw new Error(`Transition ${record.transitionId} has no non-terminal row to update`);
    await report(record);
  }

  /** Closes the step log's open entry, if any, with `result`. */
  function closeStep(record: TransitionRecord, result: NonNullable<TransitionStepLog['result']>, detail?: string): void {
    const open = record.steps.at(-1);
    if (open === undefined || open.finishedAt !== undefined) return;
    open.finishedAt = now();
    open.result = result;
    if (detail !== undefined) open.detail = detail;
  }

  /** Ends the transition as failed with `reason` persisted and `cause` logged; nothing is undone, so what it still holds stays closed for an operator. */
  async function fail(record: TransitionRecord, reason: string, cause: unknown): Promise<void> {
    record.state = 'failed';
    record.abortReason = reason;
    record.finishedAt = now();
    await persistRecord(record);
    ctx.logger.error({ error: serializeError(cause) }, `Transition ${record.transitionId} to ${record.to} failed`);
  }

  /** Retrying the undo cannot succeed: a refusal, or the proposed version is active, so the transition can no longer abort. */
  async function abortRefused(record: TransitionRecord, error: unknown): Promise<boolean> {
    if (isRefusal(error)) return true;
    try {
      return (await ctx.gateway.status()).tableVersion === record.to;
    } catch {
      // An unreachable gateway settles nothing; the undo is tried again on resume.
      return false;
    }
  }

  /** Undoes the side effects of an aborting transition; an undo that throws leaves the row aborting, its gates closed, for `resume()`. */
  async function finishAbort(record: TransitionRecord): Promise<void> {
    const reason = record.abortReason ?? `Transition ${record.transitionId} was aborting`;
    let progress: TransitionProgress;
    try {
      progress = await abortTransition(stepDeps(record), record);
    } catch (error) {
      if (await abortRefused(record, error)) {
        await fail(record, `${reason}; the abort was refused: ${messageOf(error)}`, error);
        return;
      }
      ctx.logger.error(
        { error: serializeError(error) },
        `Transition ${record.transitionId} undo failed; it stays aborting with its gates closed until resumed`,
      );
      return;
    }
    record.progress = progress;
    record.state = 'aborted';
    record.finishedAt = now();
    await persistRecord(record);
    ctx.logger.info(`Transition ${record.transitionId} to ${record.to} aborted; ${record.from} stays active`);
  }

  async function abort(record: TransitionRecord, reason: string): Promise<void> {
    record.state = 'aborting';
    record.abortReason = reason;
    await persistRecord(record);
    await finishAbort(record);
  }

  /** Aborts a step that refuses or fails before activation, fails a refusal after it, and leaves any other failure to `resume()`. */
  async function onStepError(record: TransitionRecord, error: unknown): Promise<void> {
    const step = currentStep(record);
    const message = messageOf(error);
    const refusal = isRefusal(error);
    if (step < ACTIVATE_STEP || (refusal && step === ACTIVATE_STEP)) {
      ctx.logger.warn({ error: serializeError(error) }, `Transition ${record.transitionId} step ${String(step)} failed, so it aborts`);
      closeStep(record, 'aborted', message);
      await abort(record, message);
      return;
    }
    closeStep(record, 'error', message);
    if (refusal) {
      await fail(record, message, error);
      return;
    }
    // Activation may have happened, so the transition goes forward: steps 7 and 8 run again on resume.
    await persistRecord(record);
    ctx.logger.error({ error: serializeError(error) }, `Transition ${record.transitionId} step ${String(step)} failed and runs again on resume`);
  }

  /** Runs the steps after `lastStep`, persisting before and after each, or continues the undo of an aborting transition. */
  async function drive(record: TransitionRecord): Promise<void> {
    if (record.state === 'aborting') return finishAbort(record);
    const deps = stepDeps(record);
    for (const { step, name, state } of TRANSITION_STEPS.slice(record.lastStep)) {
      if (stopping) return;
      // An entry still open was cut short by a process exit; its step runs again.
      closeStep(record, 'error', 'interrupted');
      record.state = state;
      record.steps.push({ step, name, startedAt: now() });
      await persistRecord(record);
      let outcome: StepOutcome;
      try {
        outcome = await runTransitionStep(deps, record, step);
      } catch (error) {
        await onStepError(record, error);
        return;
      }
      record.plan = outcome.plan ?? record.plan;
      record.progress = outcome.progress;
      record.lastStep = step;
      closeStep(record, 'ok');
      if (step === LAST_STEP) {
        record.state = 'completed';
        record.finishedAt = now();
      }
      await persistRecord(record);
    }
  }

  /** Drives `record` in the background unless this process already drives it or is stopping, which leaves the row to the next resume. */
  function launch(record: TransitionRecord): void {
    const id = record.transitionId;
    if (stopping || loops.has(id)) return;
    const loop = (async () => {
      try {
        await drive(record);
      } catch (error) {
        ctx.logger.error({ error: serializeError(error) }, `Transition ${id} stopped and continues from its persisted state on resume`);
      } finally {
        loops.delete(id);
      }
    })();
    loops.set(id, loop);
  }

  return {
    async start({ to, requestedBy = DEFAULT_REQUESTER }) {
      const active = await loadActive();
      if (active !== undefined) throw new TransitionInProgressError(active.transitionId);
      let plan: TransitionPlan;
      try {
        plan = await planTransition(ctx, to);
      } catch (error) {
        // The contract answers an unknown version with 400; a missing active version or groups file stays a server error.
        if (isMissingVersion(error, to)) throw new LegacyApiError('invalidParameters');
        throw error;
      }
      const at = now();
      const record: TransitionRecord = {
        transitionId: cfUuid(),
        from: plan.from,
        to,
        state: 'started',
        lastStep: 0,
        progress: initialTransitionProgress(),
        steps: [],
        startedAt: at,
        updatedAt: at,
      };
      await insert(record, requestedBy);
      // The view is taken first: the loop starts changing the record before its first await.
      const view = toTransitionView(record);
      launch(record);
      return view;
    },

    async get(transitionId) {
      const record = await load(transitionId);
      if (record === undefined) throw new TransitionNotFoundError(transitionId);
      return toTransitionView(record);
    },

    async resume() {
      const record = await loadActive();
      if (record === undefined) return null;
      const view = toTransitionView(record);
      launch(record);
      return view;
    },

    async stop() {
      stopping = true;
      await Promise.all(loops.values());
    },
  };
}
