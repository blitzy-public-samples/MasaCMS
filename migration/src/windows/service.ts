// Write windows: one writer per unit while a legacy-served or withheld writer runs on legacy against `target`-authoritative units.
import { setTimeout as delay } from 'node:timers/promises';

import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { GATE_WAIT_MS, type GatePhase } from '@opt2/platform/migration-kit';
import type { MetadataTx } from '@opt2/platform/tenancy';

import { resolveReportsDir } from '../config.js';
import type { MigrationContext } from '../context.js';
import { currentAuthority, loadVersion } from '../cutover/index.js';
import type { components } from '../generated/openapi.js';
import {
  LegacyRestartError,
  RestartUnavailableError,
  StartupGuardFrozenError,
  countStartupRows,
  recoverStartupGuard,
  restartLegacy,
  runStartupGuardSequence,
  type StartupGuardSteps,
} from '../legacy/index.js';
import { GateConflict, OwnerCallError, type DataOwner } from '../owners/index.js';
import {
  resolveReportTarget,
  upsertLogEntry,
  type ReportTarget,
  type WindowKind,
  type WindowLogEntry,
  type WindowOutcome,
  type WindowPhaseName,
} from '../reports/index.js';
import { ProjectionTimeoutError, type Projector } from '../reverse/index.js';

import { importWindow, type ImportResult } from './import.js';
import { LeaseUnavailableError, acquireLeases, releaseLeases } from './leases.js';
import { runLegacyStepWith, type LegacyStepInput, type LegacyStepResult, type WindowLifecycle } from './legacy-steps.js';
import {
  contentUnits,
  drainExclusions,
  freezeLegacyBound,
  runReloadWindowWith,
  sendReloadRequest,
  tryGuardLock,
  unfreezeLegacyBound,
  type FrozenRoutes,
  type ReloadWindowResult,
} from './reload.js';
import { STARTUP_WINDOW_HOLDER_ENV } from './via-service.js';

type Schemas = components['schemas'];
type WindowOpenRequest = Schemas['WindowOpenRequest'];
type WindowOpenResponse = Schemas['WindowOpenResponse'];
type WindowCompleteRequest = Schemas['WindowCompleteRequest'];
type WindowCompleteResponse = Schemas['WindowCompleteResponse'];
type WindowScope = Schemas['WindowScope'];
type WriteWindow = Schemas['WriteWindow'];
type ContractPhase = WriteWindow['phases'][number]['phase'];
type ContractOutcome = Exclude<WriteWindow['outcome'], 'pending'>;

/** `migration.write_window.state`. */
export type WindowRowState = 'opening' | 'open' | 'closed' | 'failed' | 'import-pending' | 'resolved';

/** `migration.write_window.kind`. */
type RowKind = 'request' | 'legacy-step' | 'startup' | 'reload';

/** Why an open was refused before legacy executed anything. */
export type WindowRefusalReason = 'lease-unavailable' | 'owner-unavailable' | 'gate-conflict' | 'projection-timeout' | 'budget-exceeded';

/** Lifecycle event of a window; the gate phases and `closed`/`aborted` are the contract's, the others add detail. */
export type WindowEventName =
  | 'opened'
  | 'leased'
  | 'quiet'
  | 'projection-awaited'
  | 'executing'
  | 'completed'
  | 'importing'
  | 'imported'
  | 'import-pending'
  | 'guard'
  | 'lease-extended'
  | 'restart-evidence'
  | 'operator-evidence'
  | 'closed'
  | 'aborted';

/** Counts and reasons recorded with an event. */
export interface WindowEventDetail {
  forwarded?: boolean;
  legacyStatus?: number;
  /** Rows the owners applied, by owner. */
  rowsImported?: Record<string, number>;
  objectsTransferred?: number;
  objectsRemoved?: number;
  /** Rows matching the start-up predicate when the guard ran. */
  count?: number;
  guarded?: boolean;
  reason?: string;
  actor?: string;
  units?: string[];
}

/** One recorded event; `at` is ISO-8601. */
export interface WindowEvent {
  phase: WindowEventName;
  at: string;
  detail?: WindowEventDetail;
}

/** What `migration.write_window.error` holds: the refusal, the failed import, the missing evidence or the guard freeze left in place. */
export type WindowErrorDoc =
  | { kind: 'refused'; reason: string; message: string }
  | { kind: 'import-failed'; message: string; attempt: number }
  | { kind: 'awaiting-evidence'; reason: 'restart-unavailable' | 'restart-failed'; message: string }
  | { kind: 'guard-frozen'; message: string; frozen: FrozenRoutes };

/** One `migration.write_window` row. */
export interface WindowRecord {
  windowId: string;
  routeKey: string;
  units: string[];
  scope: WindowScope;
  requestId: string | null;
  kind: WindowKind;
  state: WindowRowState;
  /** Gate phase the window last set at its owners. */
  phase: GatePhase | null;
  /** Units whose gates this window closed, by owner; the import covers exactly these. */
  closedGates: Record<string, string[]>;
  events: WindowEvent[];
  leaseExpiresAt: Date | null;
  legacyStatus: number | null;
  rowsImported: number;
  /** Import attempts started; each attempt's apply batch ids are distinct. */
  attempts: number;
  outcome: ContractOutcome | null;
  error: WindowErrorDoc | null;
  openedAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

/** Test and fault hooks; a throw from `beforeImport` acts as an import interrupted after legacy committed. */
export interface WindowHooks {
  beforeImport?(window: WindowRecord, attempt: number): Promise<void>;
}

/** Ports of {@link createWindowService}; `shouldRun` pauses the retry loop while background work is suspended. */
export interface WindowServiceOptions {
  projector: Pick<Projector, 'awaitProjection'>;
  hooks?: WindowHooks;
  restart?: typeof restartLegacy;
  shouldRun?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

/** The open was refused and everything it took was given back; renders as the legacy 503 before legacy executes. */
export class WindowRefusedError extends LegacyServiceUnavailableError {
  override readonly name: string = 'WindowRefusedError';

  constructor(
    readonly windowId: string,
    override readonly reason: WindowRefusalReason,
    override readonly cause: unknown,
  ) {
    super(`Write window ${windowId} refused (${reason}): ${messageOf(cause)}`, 'auto', reason);
  }
}

/** No window has this id. */
export class WindowNotFoundError extends Error {
  override readonly name: string = 'WindowNotFoundError';
  readonly statusCode = 404;

  constructor(readonly windowId: string) {
    super(`No write window ${windowId}`);
  }
}

/** The window's state does not allow the action, or another writer changed it first. */
export class WindowStateError extends Error {
  override readonly name: string = 'WindowStateError';
  readonly statusCode = 409;

  constructor(
    readonly windowId: string,
    readonly state: WindowRowState,
    readonly action: string,
  ) {
    super(`Write window ${windowId} is ${state}; cannot ${action}`);
  }
}

/** Write-window lifecycle of the migration service. */
export interface WindowService {
  /** Leases the units, closes the gates of the `target`-authoritative ones and awaits their projection; legacy may then execute. @throws WindowRefusedError */
  open(request: WindowOpenRequest, opts?: { kind?: WindowKind }): Promise<WindowOpenResponse>;
  /** Imports what legacy wrote and closes the window, or leaves it import-pending with its gates closed. @throws WindowNotFoundError */
  complete(windowId: string, request: WindowCompleteRequest): Promise<WindowCompleteResponse>;
  /** @throws WindowNotFoundError */
  get(windowId: string): Promise<WriteWindow>;
  /** Imports and closes an import-pending window on the operator's evidence that its legacy request can no longer commit. @throws WindowNotFoundError, WindowStateError */
  resolve(windowId: string, opts?: { actor?: string }): Promise<WriteWindow>;
  /** Runs one site-monitor step on legacy, inside a window when it writes `target`-authoritative units. */
  runLegacyStep(input: LegacyStepInput): Promise<LegacyStepResult>;
  /** Runs Masa's reload request inside a `reload` window on every content unit. */
  runReloadWindow(): Promise<ReloadWindowResult>;
  /** At service start: gives back what windows left opening took; open and import-pending windows go to the retry loop. */
  resumeWindows(): Promise<void>;
  /** One pass of the retry loop: retries import-pending windows with evidence and handles expired leases. */
  runRecoveryPass(): Promise<void>;
  /** Runs {@link runRecoveryPass} every configured import-retry interval until stopped. */
  startImportRetryLoop(): { stop(): Promise<void> };
  /** Stops the loop and waits for every window operation in progress. */
  stop(): Promise<void>;
}

const ACTIVE_STATES: readonly WindowRowState[] = ['opening', 'open', 'import-pending'];
const TERMINAL_STATES: ReadonlySet<WindowRowState> = new Set(['closed', 'failed', 'resolved']);
const EVIDENCE_EVENTS: ReadonlySet<WindowEventName> = new Set(['completed', 'restart-evidence', 'operator-evidence']);
const CONTRACT_PHASES: ReadonlySet<string> = new Set<ContractPhase>(['quiet', 'executing', 'importing', 'import-pending', 'closed', 'aborted']);
const LOG_PHASES: ReadonlySet<string> = new Set<WindowPhaseName>(['quiet', 'executing', 'importing', 'import-pending', 'closed']);
const CONTRACT_STATE: Readonly<Record<WindowRowState, WriteWindow['state']>> = {
  opening: 'opening',
  open: 'open',
  'import-pending': 'import-pending',
  closed: 'closed',
  resolved: 'closed',
  failed: 'aborted',
};
const LOG_OUTCOME: Readonly<Partial<Record<WindowRowState, WindowOutcome>>> = {
  closed: 'closed',
  failed: 'aborted-503',
  'import-pending': 'import-pending',
  resolved: 'resolved-by-operator',
};
const ROW_KIND: Readonly<Record<WindowKind, RowKind>> = {
  request: 'request',
  'sitemonitor-step': 'legacy-step',
  startup: 'startup',
  reload: 'reload',
};
const WINDOW_KIND: Readonly<Record<RowKind, WindowKind>> = {
  request: 'request',
  'legacy-step': 'sitemonitor-step',
  startup: 'startup',
  reload: 'reload',
};
const COLUMNS =
  'window_id, route_key, units, scope, request_id, kind, state, phase, closed_gates, phases, lease_expires_at, legacy_status, rows_imported, attempts, outcome, error, opened_at, updated_at, closed_at';
const REPORT_FILE = 'windows.json';
const noop = (): void => undefined;

interface WindowRow {
  window_id: string;
  route_key: string;
  units: string[];
  scope: WindowScope;
  request_id: string | null;
  kind: RowKind;
  state: WindowRowState;
  phase: GatePhase | null;
  closed_gates: Record<string, string[]> | null;
  phases: WindowEvent[] | null;
  lease_expires_at: Date | null;
  legacy_status: number | null;
  rows_imported: number;
  attempts: number;
  outcome: ContractOutcome | null;
  error: WindowErrorDoc | null;
  opened_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

/** A `windows.json` entry: the run-log shape plus the detailed events and object counts. */
type WindowReportEntry = WindowLogEntry & { events: WindowEvent[]; objectsTransferred: number; objectsRemoved: number };

/** The open's budget ran out between steps. */
class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';

  constructor(budgetMs: number) {
    super(`Write window open budget of ${String(budgetMs)} ms exhausted`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function writeWindowTable(tx: MetadataTx): string {
  return `${tx.schema}.write_window`;
}

function toRecord(row: WindowRow): WindowRecord {
  return {
    windowId: row.window_id,
    routeKey: row.route_key,
    units: row.units,
    scope: row.scope,
    requestId: row.request_id,
    kind: WINDOW_KIND[row.kind],
    state: row.state,
    phase: row.phase,
    closedGates: row.closed_gates ?? {},
    events: row.phases ?? [],
    leaseExpiresAt: row.lease_expires_at,
    legacyStatus: row.legacy_status,
    rowsImported: row.rows_imported,
    attempts: row.attempts,
    outcome: row.outcome,
    error: row.error,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

/** Sorted units whose gates the window closed. */
function closedUnits(record: Pick<WindowRecord, 'closedGates'>): string[] {
  return [...new Set(Object.values(record.closedGates).flat())].sort();
}

/** The latest evidence that the window's legacy request can no longer commit, if any. */
function lastEvidence(record: Pick<WindowRecord, 'events'>): WindowEvent | undefined {
  return record.events.findLast((event) => EVIDENCE_EVENTS.has(event.phase));
}

/** False only for a window completed with `forwarded: false`: legacy executed nothing, so nothing is imported. */
function wasForwarded(record: Pick<WindowRecord, 'events'>): boolean {
  return !record.events.some((event) => event.phase === 'completed' && event.detail?.forwarded === false);
}

/** `windowGet`'s view; the stored events are a superset of the contract's phases, which are filtered out of them. */
function toView(record: WindowRecord): WriteWindow {
  return {
    windowId: record.windowId,
    routeKey: record.routeKey,
    units: record.units,
    scope: record.scope,
    state: CONTRACT_STATE[record.state],
    phase: record.phase ?? 'quiet',
    phases: record.events
      .filter((event) => CONTRACT_PHASES.has(event.phase))
      .map((event) => ({ phase: event.phase as ContractPhase, at: event.at })),
    rowsImported: record.rowsImported,
    outcome: record.outcome ?? 'pending',
  };
}

/** The `windows.json` entry of a window. */
function toReportEntry(record: WindowRecord): WindowReportEntry {
  const rowsImported: Record<string, number> = {};
  let objectsTransferred = 0;
  let objectsRemoved = 0;
  for (const event of record.events) {
    if (event.phase !== 'imported') continue;
    for (const [owner, rows] of Object.entries(event.detail?.rowsImported ?? {})) rowsImported[owner] = (rowsImported[owner] ?? 0) + rows;
    objectsTransferred += event.detail?.objectsTransferred ?? 0;
    objectsRemoved += event.detail?.objectsRemoved ?? 0;
  }
  const outcome = LOG_OUTCOME[record.state];
  const scope: WindowLogEntry['scope'] = 'keys' in record.scope ? { ...record.scope.keys } : { table: true };
  return {
    windowId: record.windowId,
    holderId: record.windowId,
    kind: record.kind,
    routeKey: record.routeKey,
    units: record.units,
    scope,
    phases: record.events
      .filter((event) => LOG_PHASES.has(event.phase))
      .map((event) => ({ phase: event.phase as WindowPhaseName, at: event.at })),
    events: record.events,
    ...(record.closedAt === null ? {} : { durationMs: record.closedAt.getTime() - record.openedAt.getTime() }),
    rowsImported,
    objectsTransferred,
    objectsRemoved,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

/** Refusal reason of an open failure; undefined for a failure that is not one of the refusals. */
function refusalReason(error: unknown): WindowRefusalReason | undefined {
  if (error instanceof BudgetExceededError) return 'budget-exceeded';
  if (error instanceof LeaseUnavailableError) return 'lease-unavailable';
  if (error instanceof GateConflict) return 'gate-conflict';
  if (error instanceof ProjectionTimeoutError) return 'projection-timeout';
  if (error instanceof OwnerCallError || error instanceof LegacyServiceUnavailableError) return 'owner-unavailable';
  return undefined;
}

/** Creates the window service over the context's `migration` pool, owners, gateway and legacy ports. */
export function createWindowService(ctx: MigrationContext, options: WindowServiceOptions): WindowService {
  const { openBudgetMs, importRetryMs, gatewayLeaseMs } = ctx.config.windows;
  const restart = options.restart ?? restartLegacy;
  const sleep = options.sleep ?? ((ms: number) => delay(ms, undefined, { ref: false }));
  const tails = new Map<string, Promise<void>>();
  const running = new Set<Promise<void>>();
  let reportTarget: ReportTarget | undefined;
  let loop: { stop(): Promise<void> } | undefined;

  const now = (): Date => ctx.clock.now();

  function addEvent(record: WindowRecord, phase: WindowEventName, detail?: WindowEventDetail, at: Date = now()): void {
    record.events.push(detail === undefined ? { phase, at: at.toISOString() } : { phase, at: at.toISOString(), detail });
  }

  /** Runs `fn` once every earlier operation on `windowId` has settled; in-process single flight per window. */
  function exclusive<T>(windowId: string, fn: () => Promise<T>): Promise<T> {
    const result = (tails.get(windowId) ?? Promise.resolve()).then(fn);
    const tail = result.then(noop, noop);
    tails.set(windowId, tail);
    running.add(tail);
    void tail.then(() => {
      running.delete(tail);
      if (tails.get(windowId) === tail) tails.delete(windowId);
    });
    return result;
  }

  async function report(record: WindowRecord): Promise<void> {
    try {
      reportTarget ??= resolveReportTarget({ reportsDir: resolveReportsDir(ctx.config, ctx.env), sourceShaFile: ctx.config.paths.sourcePin });
      await upsertLogEntry(reportTarget, REPORT_FILE, 'windowId', toReportEntry(record), { clock: ctx.clock });
    } catch (error) {
      ctx.logger.error({ error: asError(error) }, `Recording window ${record.windowId} in ${REPORT_FILE} failed`);
    }
  }

  async function insert(record: WindowRecord): Promise<void> {
    await ctx.db.withMetadata((tx) =>
      tx.query(
        `INSERT INTO ${writeWindowTable(tx)} (${COLUMNS})
         VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19)`,
        [
          record.windowId,
          record.routeKey,
          record.units,
          JSON.stringify(record.scope),
          record.requestId,
          ROW_KIND[record.kind],
          record.state,
          record.phase,
          JSON.stringify(record.closedGates),
          JSON.stringify(record.events),
          record.leaseExpiresAt,
          record.legacyStatus,
          record.rowsImported,
          record.attempts,
          record.outcome,
          record.error === null ? null : JSON.stringify(record.error),
          record.openedAt,
          record.updatedAt,
          record.closedAt,
        ],
      ),
    );
    await report(record);
  }

  /** Writes the record as `next` by compare-and-set on its persisted state, then mirrors it into the report. */
  async function persist(record: WindowRecord, next: WindowRowState = record.state): Promise<void> {
    record.updatedAt = now();
    const result = await ctx.db.withMetadata((tx) =>
      tx.query(
        `UPDATE ${writeWindowTable(tx)}
            SET state = $2, phase = $3, closed_gates = $4::jsonb, phases = $5::jsonb, lease_expires_at = $6, legacy_status = $7,
                rows_imported = $8, attempts = $9, outcome = $10, error = $11::jsonb, updated_at = $12, closed_at = $13
          WHERE window_id = $1 AND state = $14`,
        [
          record.windowId,
          next,
          record.phase,
          JSON.stringify(record.closedGates),
          JSON.stringify(record.events),
          record.leaseExpiresAt,
          record.legacyStatus,
          record.rowsImported,
          record.attempts,
          record.outcome,
          record.error === null ? null : JSON.stringify(record.error),
          record.updatedAt,
          record.closedAt,
          record.state,
        ],
      ),
    );
    if ((result.rowCount ?? 0) === 0) throw new WindowStateError(record.windowId, record.state, `move to ${next}`);
    record.state = next;
    await report(record);
  }

  async function load(windowId: string): Promise<WindowRecord> {
    const { rows } = await ctx.db.withMetadata((tx) =>
      tx.query<WindowRow>(`SELECT ${COLUMNS} FROM ${writeWindowTable(tx)} WHERE window_id = $1`, [windowId]),
    );
    const row = rows[0];
    if (row === undefined) throw new WindowNotFoundError(windowId);
    return toRecord(row);
  }

  async function listActive(): Promise<WindowRecord[]> {
    const { rows } = await ctx.db.withMetadata((tx) =>
      tx.query<WindowRow>(`SELECT ${COLUMNS} FROM ${writeWindowTable(tx)} WHERE state = ANY($1::text[]) ORDER BY opened_at, window_id`, [
        ACTIVE_STATES,
      ]),
    );
    return rows.map(toRecord);
  }

  /** `units` grouped by owner, owners and units sorted. */
  function byOwner(units: Iterable<string>): [DataOwner, string[]][] {
    const groups = new Map<DataOwner, string[]>();
    for (const unit of [...new Set(units)].sort()) {
      const owner = ctx.catalog.ownerOf(unit);
      groups.set(owner, [...(groups.get(owner) ?? []), unit]);
    }
    return [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  function gatedOwners(record: WindowRecord): [DataOwner, string[]][] {
    return Object.entries(record.closedGates).map(([owner, units]) => [owner as DataOwner, units]);
  }

  /**
   * Closes the gates of `units` for this window owner by owner, persisting each owner's units once its close succeeded.
   * `pending` names the owner whose close is in flight, so a failed open can give back a close whose answer was lost.
   */
  async function closeGates(
    record: WindowRecord,
    units: readonly string[],
    phase: GatePhase,
    opts: { timeoutMs?: () => number; pending?: { owner?: DataOwner; units?: string[] } } = {},
  ): Promise<void> {
    for (const [owner, ownerUnits] of byOwner(units)) {
      if (opts.pending !== undefined) Object.assign(opts.pending, { owner, units: ownerUnits });
      const timeoutMs = opts.timeoutMs === undefined ? undefined : Math.max(1, Math.min(GATE_WAIT_MS, opts.timeoutMs()));
      await ctx.owners.gate(owner, { op: 'close', units: ownerUnits, holderId: record.windowId, phase, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      record.closedGates[owner] = [...new Set([...(record.closedGates[owner] ?? []), ...ownerUnits])].sort();
      record.phase = phase;
      await persist(record);
      if (opts.pending !== undefined) Object.assign(opts.pending, { owner: undefined, units: undefined });
    }
  }

  async function setPhase(record: WindowRecord, phase: GatePhase): Promise<void> {
    for (const [owner, units] of gatedOwners(record)) await ctx.owners.gate(owner, { op: 'phase', units, holderId: record.windowId, phase });
    record.phase = phase;
  }

  /** Reopens every gate the window closed by holder compare-and-set; units another holder took were never this window's. */
  async function reopenGates(record: WindowRecord): Promise<void> {
    for (const [owner, units] of gatedOwners(record)) {
      try {
        await ctx.owners.gate(owner, { op: 'open', units, holderId: record.windowId });
      } catch (error) {
        if (!(error instanceof GateConflict)) throw error;
        ctx.logger.warn(`Gates ${error.units.join(', ')} at ${owner} were not window ${record.windowId}'s to reopen`);
      }
    }
  }

  /** Reopens a close whose answer was lost; a close that never applied makes this a no-op or a conflict. */
  async function reopenUncertain(record: WindowRecord, owner: DataOwner, units: string[]): Promise<void> {
    try {
      await ctx.owners.gate(owner, { op: 'open', units, holderId: record.windowId });
    } catch (error) {
      if (!(error instanceof GateConflict)) {
        ctx.logger.warn({ error: asError(error) }, `Reopening the unconfirmed gate close of window ${record.windowId} at ${owner} failed`);
      }
    }
  }

  /** Gives back what a window that never answered its open took; it stays opening for the next pass when an owner cannot be reached. */
  async function giveBack(record: WindowRecord, reason: string, cause: unknown): Promise<void> {
    record.error = { kind: 'refused', reason, message: messageOf(cause) };
    try {
      await reopenGates(record);
      await releaseLeases(ctx, record.windowId);
    } catch (cleanupError) {
      ctx.logger.error({ error: asError(cleanupError) }, `Window ${record.windowId} keeps its gates and leases until an owner can reopen them`);
      await persist(record);
      return;
    }
    record.outcome = 'aborted';
    record.closedAt = now();
    addEvent(record, 'aborted', { reason });
    await persist(record, 'failed');
  }

  async function open(request: WindowOpenRequest, opts: { kind?: WindowKind } = {}): Promise<WindowOpenResponse> {
    const units = [...new Set(request.units)].sort();
    for (const unit of units) ctx.catalog.ownerOf(unit);
    const openedAt = now();
    const record: WindowRecord = {
      windowId: cfUuid(),
      routeKey: request.routeKey,
      units,
      scope: request.scope,
      requestId: request.requestId,
      kind: opts.kind ?? 'request',
      state: 'opening',
      phase: null,
      closedGates: {},
      events: [{ phase: 'opened', at: openedAt.toISOString() }],
      leaseExpiresAt: null,
      legacyStatus: null,
      rowsImported: 0,
      attempts: 0,
      outcome: null,
      error: null,
      openedAt,
      updatedAt: openedAt,
      closedAt: null,
    };
    const remaining = (): number => openBudgetMs - (now().getTime() - openedAt.getTime());
    const within = (): number => {
      const left = remaining();
      if (left <= 0) throw new BudgetExceededError(openBudgetMs);
      return left;
    };
    const pending: { owner?: DataOwner; units?: string[] } = {};

    return exclusive(record.windowId, async () => {
      await insert(record);
      try {
        await acquireLeases(ctx, { units, holderId: record.windowId, kind: 'window', budgetMs: within(), sleep: options.sleep });
        addEvent(record, 'leased');
        await persist(record);
        const authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths, timeoutMs: within() });
        const targetUnits = units.filter((unit) => authority.isTargetAuthoritative(unit));
        if (targetUnits.length > 0) {
          within();
          await closeGates(record, targetUnits, 'quiet', { timeoutMs: within, pending });
          addEvent(record, 'quiet', { units: targetUnits });
          const owners = byOwner(targetUnits).map(([owner]) => owner);
          await options.projector.awaitProjection({ owners, timeoutMs: within() });
          addEvent(record, 'projection-awaited');
          within();
          await setPhase(record, 'executing');
        }
        record.phase = 'executing';
        record.leaseExpiresAt = new Date(now().getTime() + gatewayLeaseMs);
        addEvent(record, 'executing');
        await persist(record, 'open');
      } catch (error) {
        const reason = refusalReason(error);
        if (pending.owner !== undefined && pending.units !== undefined && !(error instanceof GateConflict)) {
          await reopenUncertain(record, pending.owner, pending.units);
        }
        try {
          await giveBack(record, reason ?? 'error', error);
        } catch (persistError) {
          ctx.logger.error({ error: asError(persistError) }, `Recording the refusal of window ${record.windowId} failed`);
        }
        ctx.logger.warn({ requestId: request.requestId }, `Write window ${record.windowId} for ${request.routeKey} refused (${reason ?? 'error'}): ${messageOf(error)}`);
        throw reason === undefined ? error : new WindowRefusedError(record.windowId, reason, error);
      }
      return { windowId: record.windowId, state: 'open', phase: 'executing' };
    });
  }

  /** One import attempt over `units`; the attempt number is persisted first, so a retry after a crash never reuses its batch ids. */
  async function importOnce(record: WindowRecord, units: string[], scope: WindowScope): Promise<ImportResult> {
    const attempt = record.attempts + 1;
    record.attempts = attempt;
    await persist(record);
    await options.hooks?.beforeImport?.(record, attempt);
    const result = await importWindow(ctx, { windowId: record.windowId, attempt, units, scope });
    if (result.rowsImported > 0 || result.objectsTransferred > 0 || result.objectsRemoved.length > 0) {
      record.rowsImported += result.rowsImported;
      const rowsImported = Object.fromEntries(Object.entries(result.perOwner).map(([owner, counts]) => [owner, counts.rows]));
      addEvent(record, 'imported', {
        rowsImported,
        objectsTransferred: result.objectsTransferred,
        objectsRemoved: result.objectsRemoved.length,
      });
      await persist(record);
    }
    if (result.objectsRemoved.length > 0) {
      ctx.logger.warn(`Window ${record.windowId}: content-files objects whose legacy file is gone: ${result.objectsRemoved.join(', ')}`);
    }
    return result;
  }

  /** Leases and gates every content unit under this window, sends Masa's reload request and imports the content units. */
  async function reloadInWindow(record: WindowRecord): Promise<void> {
    const contents = contentUnits(ctx.catalog);
    await acquireLeases(ctx, { units: contents, holderId: record.windowId, kind: 'window', budgetMs: openBudgetMs, sleep: options.sleep });
    const authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
    const targetContents = contents.filter((unit) => authority.isTargetAuthoritative(unit));
    const closed = new Set(closedUnits(record));
    await closeGates(record, targetContents.filter((unit) => !closed.has(unit)), 'importing');
    // Legacy may have re-initialised before a transport failure, so the content units are imported either way.
    const sent = await sendReloadRequest(ctx).then(
      () => undefined,
      (error: unknown) => error ?? new Error('Reload request failed'),
    );
    if (targetContents.length > 0) await importOnce(record, targetContents, { table: true });
    if (sent !== undefined) throw sent;
  }

  /** Routes the window-joined guard leaves out of its in-flight wait. */
  async function guardExclusions(record: WindowRecord): Promise<string[]> {
    const { tableVersion } = await ctx.gateway.status();
    if (tableVersion === null) return [record.routeKey];
    return drainExclusions(loadVersion(ctx.config.paths.cutoverDir, tableVersion), record.routeKey, closedUnits(record));
  }

  async function countLiveStartupRows(): Promise<number> {
    return countStartupRows(await ctx.legacy.live());
  }

  /**
   * After an import that touched `tcontent`, converts rows Masa's start-up would rewrite before any legacy request can run.
   * Skipped while another guard sequence runs, since its reload converts every matching row and waits for this window's leases.
   */
  async function guardStartup(record: WindowRecord): Promise<void> {
    const count = await countLiveStartupRows();
    if (count === 0) return;
    let frozen: FrozenRoutes | undefined;
    const steps: StartupGuardSteps<void, void> = {
      async freezeLegacyBound() {
        frozen = await freezeLegacyBound(ctx, { exceptRoutes: await guardExclusions(record) });
      },
      // Legacy already committed and the import is applied, so there is nothing left to commit.
      commit: async () => undefined,
      runReloadWindow: () => reloadInWindow(record),
      remainingStartupRows: countLiveStartupRows,
      async unfreeze() {
        if (frozen !== undefined) await unfreezeLegacyBound(ctx, frozen);
      },
    };
    let guarded = false;
    try {
      const run = await tryGuardLock(() => runStartupGuardSequence(steps));
      guarded = run.ran;
    } catch (error) {
      guarded = true;
      if (error instanceof StartupGuardFrozenError && frozen !== undefined) {
        record.error = { kind: 'guard-frozen', message: error.message, frozen };
      }
      throw error;
    } finally {
      addEvent(record, 'guard', { count, guarded });
    }
    if (!guarded) ctx.logger.info(`Window ${record.windowId} left ${String(count)} start-up rows to the running guard sequence`);
  }

  /** Finishes a guard sequence whose freeze was left in place: reload under this window, then unfreeze once no row matches. */
  async function recoverGuard(record: WindowRecord, frozen: FrozenRoutes): Promise<void> {
    let guarded = true;
    try {
      const run = await tryGuardLock(() =>
        recoverStartupGuard({
          runReloadWindow: () => reloadInWindow(record),
          remainingStartupRows: countLiveStartupRows,
          unfreeze: () => unfreezeLegacyBound(ctx, frozen),
        }),
      );
      guarded = run.ran;
    } finally {
      addEvent(record, 'guard', { guarded });
    }
    if (!guarded) throw new Error(`Another start-up guard sequence is running; window ${record.windowId} keeps its freeze for the next attempt`);
    record.error = null;
  }

  /** Leaves the window import-pending: its gates stay closed, so target reads and writes of its units wait or answer 503. */
  async function markImportPending(record: WindowRecord, error: unknown): Promise<void> {
    try {
      await setPhase(record, 'import-pending');
    } catch (phaseError) {
      ctx.logger.warn({ error: asError(phaseError) }, `Window ${record.windowId} could not mark its gates import-pending; they stay closed`);
    }
    record.phase = 'import-pending';
    record.error =
      record.error?.kind === 'guard-frozen'
        ? { ...record.error, message: messageOf(error) }
        : { kind: 'import-failed', message: messageOf(error), attempt: record.attempts };
    if (record.events.at(-1)?.phase !== 'import-pending') addEvent(record, 'import-pending');
    try {
      await persist(record, 'import-pending');
    } catch (persistError) {
      ctx.logger.error({ error: asError(persistError) }, `Recording window ${record.windowId} as import-pending failed`);
    }
    ctx.logger.warn({ error: asError(error) }, `Window ${record.windowId} import attempt ${String(record.attempts)} failed and is retried`);
  }

  /**
   * Sets the importing phase at the owners. False when a gate is no longer this window's: while it holds its leases only
   * its own reopen frees a gate, and it reopens only after a complete import, so that import needs no repeat.
   */
  async function enterImporting(record: WindowRecord): Promise<boolean> {
    try {
      await setPhase(record, 'importing');
    } catch (error) {
      if (error instanceof GateConflict) return false;
      throw error;
    }
    addEvent(record, 'importing');
    await persist(record);
    return true;
  }

  /**
   * Imports what legacy wrote, runs the start-up guard, reopens every gate and releases the leases only after every
   * reopen succeeded. On any failure the window is left import-pending.
   */
  async function finish(record: WindowRecord, final: 'closed' | 'resolved'): Promise<'closed' | 'import-pending'> {
    const evidence = lastEvidence(record);
    const forwarded = wasForwarded(record);
    const retry = record.state === 'import-pending';
    const eventsBefore = record.events.length;
    try {
      const units = closedUnits(record);
      if (forwarded && units.length > 0 && (await enterImporting(record))) {
        if (evidence !== undefined && evidence.phase !== 'completed') {
          await ctx.gateway.clearOrphans({ side: 'legacy', evidence: { kind: 'legacy-restart', holderId: record.windowId, at: evidence.at } });
        }
        // A window widened over the content units for a restart or a reload imports them whole: start-up rewrites any row.
        const contents = new Set(contentUnits(ctx.catalog));
        const widened = units.some((unit) => !record.units.includes(unit));
        const whole = widened ? units.filter((unit) => contents.has(unit)) : [];
        const scoped = units.filter((unit) => !whole.includes(unit));
        let touchedContent = false;
        if (scoped.length > 0) touchedContent = (await importOnce(record, scoped, record.scope)).touchedContent;
        if (whole.length > 0) touchedContent = (await importOnce(record, whole, { table: true })).touchedContent || touchedContent;
        if (record.error?.kind === 'guard-frozen') await recoverGuard(record, record.error.frozen);
        else if (touchedContent) await guardStartup(record);
      }
      await reopenGates(record);
      await releaseLeases(ctx, record.windowId);
    } catch (error) {
      // A failed retry keeps only what it imported, so a long outage does not grow the event log every interval.
      if (retry) record.events = [...record.events.slice(0, eventsBefore), ...record.events.slice(eventsBefore).filter((event) => event.phase === 'imported')];
      await markImportPending(record, error);
      return 'import-pending';
    }
    record.error = null;
    record.outcome = final === 'resolved' ? 'resolved' : forwarded ? 'imported' : 'not-forwarded';
    record.closedAt = now();
    addEvent(record, 'closed');
    await persist(record, final);
    return 'closed';
  }

  async function complete(windowId: string, request: WindowCompleteRequest): Promise<WindowCompleteResponse> {
    return exclusive(windowId, async () => {
      const record = await load(windowId);
      if (TERMINAL_STATES.has(record.state)) return { state: 'closed' };
      if (record.state === 'opening') throw new WindowStateError(windowId, record.state, 'complete');
      // A complete after the lease expired is the evidence an expired window was waiting for.
      const awaiting = record.state === 'import-pending' && record.error?.kind === 'awaiting-evidence';
      if (record.state === 'import-pending' && !awaiting) return { state: 'import-pending' };
      if (record.phase !== 'importing' || awaiting) {
        record.legacyStatus = request.legacyStatus ?? null;
        if (awaiting) record.error = null;
        addEvent(record, 'completed', {
          forwarded: request.forwarded,
          ...(request.legacyStatus === undefined ? {} : { legacyStatus: request.legacyStatus }),
        });
        await persist(record);
      }
      return { state: await finish(record, 'closed') };
    });
  }

  /** True while a live gateway instance still holds an in-flight legacy write on the window's route. */
  async function heldByLiveGateway(record: WindowRecord): Promise<boolean> {
    const status = await ctx.gateway.status();
    const live = new Set(status.instances.filter((instance) => instance.live).map((instance) => instance.instanceId));
    return status.inflight.some((row) => row.side === 'legacy' && row.route === record.routeKey && live.has(row.instanceId));
  }

  /** Leaves the window import-pending until an operator resolves it; nothing has shown that its legacy request ended. */
  async function awaitEvidence(record: WindowRecord, error: RestartUnavailableError | LegacyRestartError): Promise<void> {
    try {
      await setPhase(record, 'import-pending');
    } catch (phaseError) {
      ctx.logger.warn({ error: asError(phaseError) }, `Window ${record.windowId} could not mark its gates import-pending; they stay closed`);
    }
    record.phase = 'import-pending';
    record.error = {
      kind: 'awaiting-evidence',
      reason: error instanceof RestartUnavailableError ? 'restart-unavailable' : 'restart-failed',
      message: error.message,
    };
    addEvent(record, 'import-pending', { reason: record.error.reason });
    await persist(record, 'import-pending');
    ctx.logger.error(
      { route: record.routeKey },
      `Window ${record.windowId} lost its gateway and has no restart evidence (${error.message}); resolve it with opt2-migrate resolve-window ${record.windowId}`,
    );
  }

  /**
   * An executing window past its lease: extended while a live gateway instance still holds its request; otherwise a
   * controlled legacy restart under this holder, with the content units leased for the start-up, is the evidence to import.
   */
  async function recoverExpired(record: WindowRecord): Promise<void> {
    if (record.leaseExpiresAt === null || record.leaseExpiresAt.getTime() > now().getTime()) return;
    if (await heldByLiveGateway(record)) {
      record.leaseExpiresAt = new Date(now().getTime() + gatewayLeaseMs);
      addEvent(record, 'lease-extended');
      await persist(record);
      return;
    }
    const contents = contentUnits(ctx.catalog);
    await acquireLeases(ctx, { units: contents, holderId: record.windowId, kind: 'window', budgetMs: openBudgetMs, sleep: options.sleep });
    const authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
    const closed = new Set(closedUnits(record));
    await closeGates(record, contents.filter((unit) => authority.isTargetAuthoritative(unit) && !closed.has(unit)), 'executing');
    const restartedAt = now();
    try {
      // The configuration names no restart budget; the restart runs under this window's lease, so the lease duration bounds it.
      await restart(ctx.env, { timeoutMs: gatewayLeaseMs, extraEnv: { [STARTUP_WINDOW_HOLDER_ENV]: record.windowId } });
    } catch (error) {
      if (error instanceof RestartUnavailableError || error instanceof LegacyRestartError) {
        await awaitEvidence(record, error);
        return;
      }
      throw error;
    }
    addEvent(record, 'restart-evidence', undefined, restartedAt);
    await persist(record);
    await finish(record, 'closed');
  }

  /** Recovery of one window not being worked on in this process, read afresh under its single flight. */
  async function recoverOne(windowId: string): Promise<void> {
    const record = await load(windowId);
    if (record.state === 'opening') {
      await giveBack(record, record.error?.kind === 'refused' ? record.error.reason : 'interrupted', record.error?.message ?? 'open interrupted');
    } else if (record.state === 'open') {
      if (record.phase === 'importing') await finish(record, 'closed');
      else await recoverExpired(record);
    } else if (record.state === 'import-pending' && lastEvidence(record) !== undefined && record.error?.kind !== 'awaiting-evidence') {
      await finish(record, 'closed');
    }
  }

  async function runRecoveryPass(): Promise<void> {
    if (options.shouldRun !== undefined && !(await options.shouldRun())) return;
    for (const record of await listActive()) {
      if (tails.has(record.windowId)) continue;
      try {
        await exclusive(record.windowId, () => recoverOne(record.windowId));
      } catch (error) {
        ctx.logger.warn({ error: asError(error) }, `Recovery of window ${record.windowId} failed; retried next pass`);
      }
    }
  }

  async function resumeWindows(): Promise<void> {
    for (const record of await listActive()) {
      if (record.state !== 'opening' || tails.has(record.windowId)) continue;
      // An opening window never answered the gateway, so legacy never executed under it.
      await exclusive(record.windowId, async () => {
        const fresh = await load(record.windowId);
        if (fresh.state === 'opening') await giveBack(fresh, 'interrupted', 'open interrupted by a service restart');
      });
    }
  }

  async function resolve(windowId: string, opts: { actor?: string } = {}): Promise<WriteWindow> {
    return exclusive(windowId, async () => {
      const record = await load(windowId);
      if (TERMINAL_STATES.has(record.state)) return toView(record);
      if (record.state !== 'import-pending') throw new WindowStateError(windowId, record.state, 'resolve');
      if (record.error?.kind === 'awaiting-evidence') record.error = null;
      addEvent(record, 'operator-evidence', opts.actor === undefined ? undefined : { actor: opts.actor });
      await persist(record);
      await finish(record, 'resolved');
      return toView(record);
    });
  }

  async function get(windowId: string): Promise<WriteWindow> {
    return toView(await load(windowId));
  }

  function startImportRetryLoop(): { stop(): Promise<void> } {
    if (loop !== undefined) return loop;
    let stopping = false;
    let wake: () => void = noop;
    const stopped = new Promise<void>((resolveStop) => {
      wake = resolveStop;
    });
    const run = (async () => {
      while (!stopping) {
        await Promise.race([sleep(importRetryMs), stopped]);
        if (stopping) break;
        try {
          await runRecoveryPass();
        } catch (error) {
          ctx.logger.warn({ error: asError(error) }, 'Write window recovery pass failed');
        }
      }
    })();
    const handle = {
      async stop(): Promise<void> {
        stopping = true;
        wake();
        await run;
        if (loop === handle) loop = undefined;
      },
    };
    loop = handle;
    return handle;
  }

  const lifecycle: WindowLifecycle = { open, complete };

  return {
    open,
    complete,
    get,
    resolve,
    runLegacyStep: (input) => runLegacyStepWith(ctx, lifecycle, input),
    runReloadWindow: () => runReloadWindowWith(ctx, lifecycle),
    resumeWindows,
    runRecoveryPass,
    startImportRetryLoop,
    async stop() {
      await loop?.stop();
      await Promise.allSettled([...running]);
    },
  };
}
