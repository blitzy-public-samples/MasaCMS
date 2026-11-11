/** Unit gates and open operations: write authority inside each owning service. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { OPEN_OPERATION_TABLE, UNIT_GATE_TABLE, qualified, type GatePhase, type GateState } from './ddl.js';
import { withMetadata, withTenant, type MetadataTx, type Queryable, type TenantDb, type TenantTx } from '../tenancy/index.js';
import { LegacyServiceUnavailableError } from '../legacy-compat/index.js';

/** Longest a write, read, operation start or gate close waits on a gate. */
export const GATE_WAIT_MS = 30_000;

const POLL_START_MS = 50;
const POLL_MAX_MS = 500;
const LOCK_NOT_AVAILABLE = '55P03';
const READ_BLOCKING_PHASES: ReadonlySet<GatePhase> = new Set<GatePhase>(['executing', 'importing', 'import-pending']);
const GATE_COLUMNS = 'unit, state, holder_id, phase';
const SET_LOCK_TIMEOUT_SQL = "SELECT set_config('lock_timeout', $1, true)";
const READ_FENCE_SAVEPOINT = 'opt2_read_fence';

/** One `unit_gate` row. */
export interface UnitGate {
  unit: string;
  state: GateState;
  holderId: string | null;
  phase: GatePhase;
}

/** One `open_operation` row; `startedAt` is `YYYY-MM-DDTHH:MM:SS.mmm` in the server's local time. */
export interface OpenOperation {
  operationId: string;
  kind: string;
  units: string[];
  startedAt: string;
}

/** A database handle, or an open transaction that gate reads run inside. */
export type GateSource = TenantDb | TenantTx | MetadataTx;

/** Wait budget override; defaults to `GATE_WAIT_MS`. */
export interface GateBudgetOptions {
  budgetMs?: number;
}

/** Input of `registerOperation`. */
export interface RegisterOperationInput {
  operationId: string;
  kind: string;
  units: readonly string[];
}

/** Input of `closeGates`; `allowLegacy` lets a transition close units that are still `legacy`. */
export interface CloseGatesOptions {
  units: readonly string[];
  holderId: string;
  phase?: GatePhase;
  allowLegacy?: boolean;
  timeoutMs?: number;
}

/** Input of `setGatePhase`. */
export interface SetGatePhaseOptions {
  units: readonly string[];
  holderId: string;
  phase: GatePhase;
}

/** Input of `openGates`; `state` is the authority the reopened units take. */
export interface OpenGatesOptions {
  units: readonly string[];
  holderId: string;
  state?: Exclude<GateState, 'closed'>;
}

/** A write waited its full budget on a closed gate. */
export class GateClosedError extends LegacyServiceUnavailableError {
  override readonly name: string = 'GateClosedError';

  constructor(
    readonly units: string[],
    message = `Unit gate closed for ${units.join(', ')}; the write waited out its budget`,
  ) {
    super(message, 'auto', 'unit-gate-closed');
  }
}

/** A gate closed while the unit of work held or was taking gate locks; roll back and re-run the unit of work. */
export class GateRaceError extends LegacyServiceUnavailableError {
  override readonly name: string = 'GateRaceError';

  constructor(
    readonly units: string[],
    message = `Unit gate closed during acquisition for ${units.join(', ')}; the unit of work must roll back and re-run`,
  ) {
    super(message, 'auto', 'unit-gate-race');
  }
}

/** The target is not write-authoritative for a unit: its gate is `legacy` or missing. */
export class UnitNotAuthoritativeError extends LegacyServiceUnavailableError {
  override readonly name: string = 'UnitNotAuthoritativeError';

  constructor(
    readonly units: string[],
    message = `Target is not write-authoritative for ${units.join(', ')}`,
  ) {
    super(message, 'auto', 'unit-not-authoritative');
  }
}

/** A read waited its full budget while a legacy write window executed or imported. */
export class UnitReadBlockedError extends LegacyServiceUnavailableError {
  override readonly name: string = 'UnitReadBlockedError';

  constructor(
    readonly units: string[],
    message = `Legacy write window in progress for ${units.join(', ')}; the read waited out its budget`,
  ) {
    super(message, 'auto', 'unit-read-blocked');
  }
}

/** An operation could not start on a closed unit, or a gate could not close past an open operation, within the budget. */
export class OperationBlockedError extends LegacyServiceUnavailableError {
  override readonly name: string = 'OperationBlockedError';

  constructor(
    readonly units: string[],
    message = `Open operation or closed gate blocks ${units.join(', ')}`,
  ) {
    super(message, 'auto', 'operation-blocked');
  }
}

/** Compare-and-set refused: another holder owns the gate, the caller is not the holder, or the gate is missing. */
export class GateConflictError extends Error {
  override readonly name: string = 'GateConflictError';

  constructor(
    readonly units: string[],
    message = `Unit gate compare-and-set refused for ${units.join(', ')}`,
  ) {
    super(message);
  }
}

const migrationAuthorityBrand: unique symbol = Symbol('opt2.migration-kit.migration-authority');
const issuedAuthorities = new WeakSet<object>();

/** Proof that a write is a migration apply of the `platform.migration` identity; it passes any gate state. */
export interface MigrationAuthority {
  readonly [migrationAuthorityBrand]: true;
  readonly batchId?: string;
  readonly holderId?: string;
}

/** Issues a migration authority; only the migration handlers call it, after the `platform.migration` role check. */
export function createMigrationAuthority(ids: { batchId?: string; holderId?: string } = {}): MigrationAuthority {
  const authority: MigrationAuthority = Object.freeze({
    [migrationAuthorityBrand]: true as const,
    batchId: ids.batchId,
    holderId: ids.holderId,
  });
  issuedAuthorities.add(authority);
  return authority;
}

/** True only for an authority `createMigrationAuthority` issued. */
export function isMigrationAuthority(value: unknown): value is MigrationAuthority {
  return typeof value === 'object' && value !== null && issuedAuthorities.has(value);
}

interface GateRow {
  unit: string;
  state: GateState;
  holder_id: string | null;
  phase: GatePhase;
}

interface OperationRow {
  operation_id: string;
  kind: string;
  units: string[];
  started: string;
}

interface TxGates {
  readonly units: Set<string>;
  readonly deadline: number;
}

const acquiredGates = new WeakMap<TenantTx, TxGates>();
/** Units whose gates `awaitReadable` share-locked in each transaction. */
const fencedReads = new WeakMap<TenantTx | MetadataTx, Set<string>>();
const budgetScope = new AsyncLocalStorage<{ readonly deadline: number }>();

function gateTable(schema: string): string {
  return qualified(schema, UNIT_GATE_TABLE);
}

function operationTable(schema: string): string {
  return qualified(schema, OPEN_OPERATION_TABLE);
}

function toGate(row: GateRow): UnitGate {
  return { unit: row.unit, state: row.state, holderId: row.holder_id, phase: row.phase };
}

function distinct(units: readonly string[]): string[] {
  return [...new Set(units)];
}

function deadlineFor(opts: GateBudgetOptions): number {
  return budgetScope.getStore()?.deadline ?? Date.now() + (opts.budgetMs ?? GATE_WAIT_MS);
}

function isLockNotAvailable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

function onSource<T>(source: GateSource, fn: (q: Queryable, schema: string) => Promise<T>): Promise<T> {
  return 'query' in source ? fn(source, source.schema) : withMetadata(source, (tx) => fn(tx, tx.schema));
}

/** Sleeps the current backoff step, capped at the deadline; false once the deadline has passed. */
async function pause(delayMs: number, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return false;
  }
  await sleep(Math.min(delayMs, remaining));
  return true;
}

function nextDelay(delayMs: number): number {
  return Math.min(delayMs * 2, POLL_MAX_MS);
}

/** Polls `blocking` until it returns no units; throws `timeout(units)` once the deadline passes. */
async function waitFor(deadline: number, blocking: () => Promise<string[]>, timeout: (units: string[]) => Error): Promise<void> {
  for (let delay = POLL_START_MS; ; delay = nextDelay(delay)) {
    const units = await blocking();
    if (units.length === 0) {
      return;
    }
    if (!(await pause(delay, deadline))) {
      throw timeout(units);
    }
  }
}

/** Re-runs `attempt` while `retryable` names units for its error; throws `timeout(units)` once the deadline passes. */
async function retryWhile<T>(
  deadline: number,
  attempt: () => Promise<T>,
  retryable: (err: unknown) => string[] | undefined,
  timeout: (units: string[]) => Error,
): Promise<T> {
  for (let delay = POLL_START_MS; ; delay = nextDelay(delay)) {
    try {
      return await attempt();
    } catch (err) {
      const units = retryable(err);
      if (units === undefined) {
        throw err;
      }
      if (!(await pause(delay, deadline))) {
        throw timeout(units);
      }
    }
  }
}

function raceUnits(err: unknown): string[] | undefined {
  return err instanceof GateRaceError ? err.units : undefined;
}

async function setLockTimeout(q: Queryable, remainingMs: number): Promise<void> {
  // lock_timeout 0 disables the timeout, so an exhausted budget still gets the shortest positive one.
  await q.query(SET_LOCK_TIMEOUT_SQL, [`${Math.max(1, Math.ceil(remainingMs))}ms`]);
}

async function selectGates(q: Queryable, schema: string, units?: readonly string[]): Promise<UnitGate[]> {
  const { rows } = await q.query<GateRow>(
    `SELECT ${GATE_COLUMNS} FROM ${gateTable(schema)} WHERE $1::text[] IS NULL OR unit = ANY($1::text[]) ORDER BY unit`,
    [units === undefined ? null : distinct(units)],
  );
  return rows.map(toGate);
}

/** Closed units among `units`, read without locks; throws UnitNotAuthoritativeError for `legacy` or missing gates. */
async function closedUnits(q: Queryable, schema: string, units: string[]): Promise<string[]> {
  const { rows } = await q.query<{ unit: string; state: GateState }>(
    `SELECT unit, state FROM ${gateTable(schema)} WHERE unit = ANY($1::text[])`,
    [units],
  );
  const states = new Map(rows.map((row) => [row.unit, row.state]));
  const notAuthoritative = units.filter((unit) => (states.get(unit) ?? 'legacy') === 'legacy');
  if (notAuthoritative.length > 0) {
    throw new UnitNotAuthoritativeError(notAuthoritative);
  }
  return units.filter((unit) => states.get(unit) === 'closed');
}

/** Takes FOR SHARE on `units`' gates, restoring `lock_timeout` afterwards; throws GateRaceError unless all are still open. */
async function lockOpenGates(q: Queryable, schema: string, units: string[], deadline: number, nowait: boolean): Promise<void> {
  const saved = nowait ? undefined : (await q.query<{ value: string }>("SELECT current_setting('lock_timeout') AS value")).rows[0];
  if (!nowait) {
    await setLockTimeout(q, deadline - Date.now());
  }
  let rows: { unit: string; state: GateState }[];
  try {
    ({ rows } = await q.query<{ unit: string; state: GateState }>(
      `SELECT unit, state FROM ${gateTable(schema)} WHERE unit = ANY($1::text[]) ORDER BY unit FOR SHARE${nowait ? ' NOWAIT' : ''}`,
      [units],
    ));
  } catch (err) {
    if (isLockNotAvailable(err)) {
      throw new GateRaceError(units);
    }
    throw err;
  }
  if (saved !== undefined) {
    await q.query(SET_LOCK_TIMEOUT_SQL, [saved.value]);
  }
  // FOR SHARE returns the latest committed row version, so a close that committed while this waited shows here.
  const states = new Map(rows.map((row) => [row.unit, row.state]));
  const lost = units.filter((unit) => states.get(unit) !== 'open');
  if (lost.length > 0) {
    throw new GateRaceError(lost);
  }
}

/** Share-locks `units`' gates in a savepoint; returns [] keeping the locks, or the locked or read-blocking units after releasing them. */
async function fenceReadable(q: Queryable, schema: string, units: string[]): Promise<string[]> {
  await q.query(`SAVEPOINT ${READ_FENCE_SAVEPOINT}`);
  let blocked: string[];
  try {
    // FOR SHARE reads the latest committed phase; NOWAIT keeps a read from queueing behind, or deadlocking with, a phase change.
    const { rows } = await q.query<{ unit: string; phase: GatePhase }>(
      `SELECT unit, phase FROM ${gateTable(schema)} WHERE unit = ANY($1::text[]) ORDER BY unit FOR SHARE NOWAIT`,
      [units],
    );
    blocked = rows.filter((row) => READ_BLOCKING_PHASES.has(row.phase)).map((row) => row.unit);
  } catch (err) {
    if (!isLockNotAvailable(err)) {
      throw err;
    }
    blocked = units;
  }
  if (blocked.length > 0) {
    await q.query(`ROLLBACK TO SAVEPOINT ${READ_FENCE_SAVEPOINT}`);
  }
  await q.query(`RELEASE SAVEPOINT ${READ_FENCE_SAVEPOINT}`);
  return blocked;
}

/** Inserts a `legacy` gate for every unit that has none. */
export async function ensureUnitGates(db: TenantDb, units: readonly string[]): Promise<void> {
  const wanted = distinct(units);
  if (wanted.length === 0) {
    return;
  }
  await withMetadata(db, (tx) =>
    tx.query(`INSERT INTO ${gateTable(tx.schema)} (unit) SELECT unnest($1::text[]) ON CONFLICT (unit) DO NOTHING`, [wanted]),
  );
}

/** The gates of `units`, or every gate, ordered by unit. */
export function readGates(source: GateSource, units?: readonly string[]): Promise<UnitGate[]> {
  return onSource(source, (q, schema) => selectGates(q, schema, units));
}

/** Takes FOR SHARE on `units`' gates in the business transaction `tx`, waiting while one is closed. */
export async function acquireWriteGates(tx: TenantTx, units: readonly string[], opts: GateBudgetOptions = {}): Promise<void> {
  let state = acquiredGates.get(tx);
  const wanted = distinct(units).filter((unit) => state === undefined || !state.units.has(unit));
  if (wanted.length === 0) {
    return;
  }
  if (state === undefined) {
    state = { units: new Set(), deadline: deadlineFor(opts) };
    acquiredGates.set(tx, state);
  }
  const { deadline } = state;
  // Waiting while holding FOR SHARE on a gate would block the closer's FOR UPDATE behind this transaction.
  const holding = state.units.size > 0 || (fencedReads.get(tx)?.size ?? 0) > 0;
  await waitFor(
    deadline,
    async () => {
      const closed = await closedUnits(tx, tx.schema, wanted);
      if (holding && closed.length > 0) {
        throw new GateRaceError(closed);
      }
      return closed;
    },
    (closed) => new GateClosedError(closed),
  );
  await lockOpenGates(tx, tx.schema, wanted, deadline, holding);
  for (const unit of wanted) {
    state.units.add(unit);
  }
}

/** Runs `fn` in a tenant transaction, re-running it after a GateRaceError until the shared gate budget runs out. */
export function withGatedTenant<T>(
  db: TenantDb,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  opts: GateBudgetOptions = {},
): Promise<T> {
  const scope = budgetScope.getStore() ?? { deadline: Date.now() + (opts.budgetMs ?? GATE_WAIT_MS) };
  return budgetScope.run(scope, () =>
    retryWhile(scope.deadline, () => withTenant(db, tenantId, fn), raceUnits, (units) => new GateClosedError(units)),
  );
}

/** Waits out a window's executing or import phase on `units`, then share-locks their gates until `tx` ends; throws UnitReadBlockedError after the budget. */
export async function awaitReadable(tx: TenantTx | MetadataTx, units: readonly string[], opts: GateBudgetOptions = {}): Promise<void> {
  const written = tx.kind === 'tenant' ? acquiredGates.get(tx)?.units : undefined;
  const fenced = fencedReads.get(tx) ?? new Set<string>();
  const wanted = distinct(units).filter((unit) => !fenced.has(unit) && !(written?.has(unit) ?? false));
  if (wanted.length === 0) {
    return;
  }
  // Waiting while holding FOR SHARE on a gate would block the window's phase change behind this transaction.
  const holding = fenced.size > 0 || (written?.size ?? 0) > 0;
  await waitFor(
    deadlineFor(opts),
    async () => {
      // An unlocked look first, so a read waiting out a window holds no share lock the window's next phase change must wait for.
      const gates = await readGates(tx, wanted);
      const pending = gates.filter((gate) => READ_BLOCKING_PHASES.has(gate.phase)).map((gate) => gate.unit);
      const blocked = pending.length > 0 ? pending : await fenceReadable(tx, tx.schema, wanted);
      if (holding && blocked.length > 0) {
        throw new GateRaceError(
          blocked,
          `Legacy write window in progress for ${blocked.join(', ')} while the unit of work held gate locks; it must roll back and re-run`,
        );
      }
      return blocked;
    },
    (blocked) => new UnitReadBlockedError(blocked),
  );
  for (const unit of wanted) {
    fenced.add(unit);
  }
  fencedReads.set(tx, fenced);
}

/** Registers a multi-transaction operation on open units and commits it before the operation's first write. */
export async function registerOperation(db: TenantDb, input: RegisterOperationInput, opts: GateBudgetOptions = {}): Promise<void> {
  const wanted = distinct(input.units);
  const deadline = Date.now() + (opts.budgetMs ?? GATE_WAIT_MS);
  const blocked = (units: string[]): OperationBlockedError =>
    new OperationBlockedError(units, `Operation ${input.operationId} cannot start: unit gate closed for ${units.join(', ')}`);
  await retryWhile(
    deadline,
    () =>
      withMetadata(db, async (tx) => {
        await waitFor(deadline, () => closedUnits(tx, tx.schema, wanted), blocked);
        // The share locks last until COMMIT, so a concurrent close waits for this row and then sees it.
        await lockOpenGates(tx, tx.schema, wanted, deadline, false);
        await tx.query(
          `INSERT INTO ${operationTable(tx.schema)} (operation_id, kind, units) VALUES ($1, $2, $3::text[]) ON CONFLICT (operation_id) DO NOTHING`,
          [input.operationId, input.kind, wanted],
        );
      }),
    raceUnits,
    blocked,
  );
}

/** Removes an operation's registration; ending an unknown or ended operation is a no-op. */
export async function endOperation(source: GateSource, operationId: string): Promise<void> {
  await onSource(source, (q, schema) => q.query(`DELETE FROM ${operationTable(schema)} WHERE operation_id = $1`, [operationId]));
}

/** Open operations touching any of `units`, or every open operation, oldest first. */
export function openOperations(source: GateSource, units?: readonly string[]): Promise<OpenOperation[]> {
  return onSource(source, async (q, schema) => {
    const { rows } = await q.query<OperationRow>(
      `SELECT operation_id, kind, units, to_char(started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS started
         FROM ${operationTable(schema)} WHERE $1::text[] IS NULL OR units && $1::text[] ORDER BY started_at, operation_id`,
      [units === undefined ? null : distinct(units)],
    );
    return rows.map((row) => ({ operationId: row.operation_id, kind: row.kind, units: row.units, startedAt: row.started }));
  });
}

class CloseRetry extends Error {
  constructor(readonly units: string[]) {
    super(`Unit gates not closable yet: ${units.join(', ')}`);
  }
}

/** Closes `units`' gates for `holderId` by compare-and-set once writers and open operations drain; idempotent per holder. */
export async function closeGates(db: TenantDb, opts: CloseGatesOptions): Promise<UnitGate[]> {
  const { holderId, phase = 'quiet', allowLegacy = false, timeoutMs = GATE_WAIT_MS } = opts;
  const units = distinct(opts.units);
  if (units.length === 0) {
    return [];
  }
  const closable: GateState[] = allowLegacy ? ['open', 'legacy'] : ['open'];
  const deadline = Date.now() + timeoutMs;
  return retryWhile(
    deadline,
    () =>
      withMetadata(db, async (tx) => {
        const table = gateTable(tx.schema);
        await setLockTimeout(tx, deadline - Date.now());
        let locked: UnitGate[];
        try {
          const { rows } = await tx.query<GateRow>(
            `SELECT ${GATE_COLUMNS} FROM ${table} WHERE unit = ANY($1::text[]) ORDER BY unit FOR UPDATE`,
            [units],
          );
          locked = rows.map(toGate);
        } catch (err) {
          if (isLockNotAvailable(err)) {
            throw new CloseRetry(units);
          }
          throw err;
        }
        const byUnit = new Map(locked.map((gate) => [gate.unit, gate]));
        const refused = units.filter((unit) => {
          const gate = byUnit.get(unit);
          if (gate === undefined) {
            return true;
          }
          return gate.state === 'closed' ? gate.holderId !== holderId : !closable.includes(gate.state);
        });
        if (refused.length > 0) {
          throw new GateConflictError(refused);
        }
        // A separate statement takes a fresh snapshot, so it sees operations registered by writers FOR UPDATE waited for.
        const { rows: operations } = await tx.query<{ units: string[] }>(
          `SELECT units FROM ${operationTable(tx.schema)} WHERE units && $1::text[]`,
          [units],
        );
        if (operations.length > 0) {
          throw new CloseRetry(units.filter((unit) => operations.some((operation) => operation.units.includes(unit))));
        }
        const { rows } = await tx.query<GateRow>(
          `UPDATE ${table} SET state = 'closed', holder_id = $2, phase = $3, updated_at = localtimestamp(3)
            WHERE unit = ANY($1::text[]) AND (state = ANY($4::text[]) OR holder_id = $2)
            RETURNING ${GATE_COLUMNS}`,
          [units, holderId, phase, closable],
        );
        const closed = new Map(rows.map((row) => [row.unit, toGate(row)]));
        return locked.flatMap((gate) => closed.get(gate.unit) ?? []);
      }),
    (err) => (err instanceof CloseRetry ? err.units : undefined),
    (blocked) => new OperationBlockedError(blocked, `Unit gates could not close within ${timeoutMs} ms: ${blocked.join(', ')}`),
  );
}

/** Sets the phase of gates `holderId` holds once fenced reads end; throws GateConflictError, changing nothing, unless it holds every unit. */
export async function setGatePhase(db: TenantDb, opts: SetGatePhaseOptions): Promise<UnitGate[]> {
  const units = distinct(opts.units);
  return withMetadata(db, async (tx) => {
    // Fenced reads hold FOR SHARE on their gates until they commit, so the UPDATE waits for them within the gate budget.
    await setLockTimeout(tx, GATE_WAIT_MS);
    let rows: { unit: string }[];
    try {
      ({ rows } = await tx.query<{ unit: string }>(
        `UPDATE ${gateTable(tx.schema)} SET phase = $3, updated_at = localtimestamp(3)
          WHERE unit = ANY($1::text[]) AND holder_id = $2 RETURNING unit`,
        [units, opts.holderId, opts.phase],
      ));
    } catch (err) {
      if (isLockNotAvailable(err)) {
        throw new OperationBlockedError(
          units,
          `Unit gate phase could not change to ${opts.phase} within ${GATE_WAIT_MS} ms past reads of ${units.join(', ')}`,
        );
      }
      throw err;
    }
    const updated = new Set(rows.map((row) => row.unit));
    const refused = units.filter((unit) => !updated.has(unit));
    if (refused.length > 0) {
      throw new GateConflictError(refused);
    }
    return selectGates(tx, tx.schema, units);
  });
}

/** Reopens `holderId`'s gates as `state`; other gates not already in that state stay untouched and raise GateConflictError after commit. */
export async function openGates(db: TenantDb, opts: OpenGatesOptions): Promise<UnitGate[]> {
  const { holderId, state = 'open' } = opts;
  const units = distinct(opts.units);
  const { gates, refused } = await withMetadata(db, async (tx) => {
    await tx.query(
      `UPDATE ${gateTable(tx.schema)} SET state = $3, holder_id = NULL, phase = 'quiet', updated_at = localtimestamp(3)
        WHERE unit = ANY($1::text[]) AND holder_id = $2`,
      [units, holderId, state],
    );
    const current = await selectGates(tx, tx.schema, units);
    const reopened = new Set(current.filter((gate) => gate.holderId === null && gate.state === state).map((gate) => gate.unit));
    return { gates: current, refused: units.filter((unit) => !reopened.has(unit)) };
  });
  if (refused.length > 0) {
    throw new GateConflictError(refused);
  }
  return gates;
}
