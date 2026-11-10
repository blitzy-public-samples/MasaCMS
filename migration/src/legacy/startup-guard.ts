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
  /** Unfreezes the entries `freezeLegacyBound` froze. */
  unfreeze(): Promise<void>;
}

/** Freezes, commits, runs the reload window and always unfreezes; a failed unfreeze never hides the step's error. */
export async function runStartupGuardSequence<C, W>(steps: StartupGuardSteps<C, W>): Promise<{ commit: C; reload: W }> {
  let outcome: { commit: C; reload: W };
  try {
    await steps.freezeLegacyBound();
    const commit = await steps.commit();
    const reload = await steps.runReloadWindow();
    outcome = { commit, reload };
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
  await steps.unfreeze();
  return outcome;
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
