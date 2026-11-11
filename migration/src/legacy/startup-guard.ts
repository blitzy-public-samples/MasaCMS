import type { Request } from 'mssql';

/** Masa's legacy URL conversion condition, verbatim from core/appcfc/onApplicationStart_include.cfm:896-899. */
export const STARTUP_PREDICATE_WHERE = "type in ('File','Link') and active=1 and body is null and filename is not null";

/** Counts the rows Masa's start-up would rewrite, whatever its `readonly` setting; `tcontent` stays unqualified. */
export const STARTUP_COUNT_SQL = `select count(*) as n from tcontent where ${STARTUP_PREDICATE_WHERE}`;

/** Counts matching rows through `scope`; pass the batch's own transaction so its uncommitted writes are counted. */
export async function countStartupRows(scope: { request(): Request }): Promise<number> {
  const result = await scope.request().query<{ n: number }>(STARTUP_COUNT_SQL);
  const row = result.recordset[0];
  if (row === undefined) throw new Error('Start-up predicate count returned no row');
  return Number(row.n);
}

/** Caller-supplied actions of the guard sequence; each owns its own budget. */
export interface StartupGuardSteps<C = void, W = void> {
  /** Freezes every legacy-bound entry at the gateway and waits for their in-flight requests. */
  freezeLegacyBound(): Promise<void>;
  /** Commits the pending batch. */
  commit(): Promise<C>;
  /** Runs a `?appreload` request inside a write window on the content units, including its import. */
  runReloadWindow(): Promise<W>;
  /** Counts predicate rows on the live database after the reload window's import. */
  remainingStartupRows(): Promise<number>;
  /** Unfreezes the entries `freezeLegacyBound` froze. */
  unfreeze(): Promise<void>;
}

/** The batch committed and the freeze stays in place; run `recoverStartupGuard` before legacy traffic resumes. */
export class StartupGuardFrozenError extends Error {
  override readonly name = 'StartupGuardFrozenError';
  /** Matching rows left after the import; undefined when the reload window or the count failed. */
  readonly remaining: number | undefined;

  constructor(remaining: number | undefined, options?: ErrorOptions) {
    super(
      remaining === undefined
        ? 'Start-up guard reload window or row count failed after commit; legacy-bound entries stay frozen'
        : `${String(remaining)} rows still match the start-up predicate; legacy-bound entries stay frozen`,
      options,
    );
    this.remaining = remaining;
  }
}

/** Runs the reload window, then unfreezes only if no matching row remains; else throws `StartupGuardFrozenError`. */
export async function recoverStartupGuard<W>(
  steps: Pick<StartupGuardSteps<unknown, W>, 'runReloadWindow' | 'remainingStartupRows' | 'unfreeze'>,
): Promise<W> {
  let reload: W;
  let remaining: number;
  try {
    reload = await steps.runReloadWindow();
    remaining = await steps.remainingStartupRows();
  } catch (error) {
    throw new StartupGuardFrozenError(undefined, { cause: error });
  }
  if (remaining !== 0) throw new StartupGuardFrozenError(remaining);
  await steps.unfreeze();
  return reload;
}

/**
 * Freezes, commits and converts; unfreezes on a pre-commit failure or once no matching row remains.
 * After a post-commit failure the freeze stays and `StartupGuardFrozenError` is thrown.
 */
export async function runStartupGuardSequence<C, W>(steps: StartupGuardSteps<C, W>): Promise<{ commit: C; reload: W }> {
  let commit: C;
  try {
    await steps.freezeLegacyBound();
    commit = await steps.commit();
  } catch (error) {
    try {
      await steps.unfreeze();
    } catch (unfreezeError) {
      throw new AggregateError(
        [error, unfreezeError],
        'Start-up guard step failed and unfreezing legacy-bound entries failed',
      );
    }
    throw error;
  }
  const reload = await recoverStartupGuard(steps);
  return { commit, reload };
}

/** Whether the guard sequence ran, and the matching row count that decided it. */
export interface StartupGuardOutcome {
  guarded: boolean;
  count: number;
}

/**
 * Commits directly when no row matches the start-up predicate, otherwise through the guard sequence.
 * The freeze runs while the caller's SQL Server transaction is still open: a legacy request blocked on its
 * `tcontent` locks holds the freeze wait until the freeze budget expires, so the sequence fails, unfreezes and the
 * caller rolls back.
 */
export async function commitWithStartupGuard<C>(
  args: { scope: { request(): Request } } & StartupGuardSteps<C, unknown>,
): Promise<StartupGuardOutcome & { commit: C }> {
  const count = await countStartupRows(args.scope);
  if (count === 0) return { guarded: false, count: 0, commit: await args.commit() };
  const { commit } = await runStartupGuardSequence(args);
  return { guarded: true, count, commit };
}
