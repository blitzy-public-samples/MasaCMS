// Scripted fault forced-reinit: leaves one live tcontent row matching Masa's start-up predicate and proves the start-up guard converts it.
import { z } from '@opt2/platform/service-kit';
import sql from 'mssql';
import type { ConnectionPool } from 'mssql';

import { runFeed } from '../../apply/index.js';
import type { MigrationContext } from '../../context.js';
import { currentAuthority } from '../../cutover/index.js';
import { commitWithStartupGuard, countStartupRows, recoverStartupGuard, type StartupGuardOutcome } from '../../legacy/index.js';
import {
  completeWindowViaService,
  contentUnits,
  freezeLegacyBound,
  holdersOf,
  openWindowViaService,
  unfreezeLegacyBound,
  type ReloadWindowResult,
  type WindowLifecycle,
} from '../../windows/index.js';
import { runReloadWindowWith, type FrozenRoutes } from '../../windows/reload.js';

import {
  fail,
  pass,
  skipped,
  type FaultAssertion,
  type FaultEnv,
  type FaultResumeOutput,
  type FaultRunOutput,
  type FaultScript,
} from './types.js';

const FAULT = 'forced-reinit';
const EXPECTED_ORDER = ['freeze', 'commit', 'reload-window', 'unfreeze'] as const;
const NOT_CONVERTED = 'Masa did not convert the row (configBean readonly, or the reload did not re-run onApplicationStart)';

// A File row, since a Link's Body is its URL. Masa's start-up sets Body = Filename on such a row once Body is null
// (onApplicationStart_include.cfm:896-922).
const PICK_SQL = `SELECT TOP 1 ContentHistID, ContentID, Body, Filename, URLTitle FROM tcontent
  WHERE SiteID = @siteId AND Type = 'File' AND Active = 1 AND Filename IS NOT NULL AND Body IS NOT NULL
  ORDER BY ContentHistID`;
const CLEAR_BODY_SQL = 'UPDATE tcontent SET Body = NULL WHERE ContentHistID = @h';
const READ_SQL = 'SELECT Body, Filename, URLTitle FROM tcontent WHERE ContentHistID = @h';

const paramsSchema = z.object({ siteId: z.string().min(1).default('tenant-a') }).strict();

/** Parameters of {@link forcedReinit}. */
export type ForcedReinitParams = z.output<typeof paramsSchema>;

/** The tcontent columns Masa's start-up conversion rewrites. */
interface ContentText {
  Body: string | null;
  Filename: string | null;
  URLTitle: string | null;
}

interface PickedRow extends ContentText {
  ContentHistID: string;
  ContentID: string;
}

interface ErrorDetail {
  name: string;
  message: string;
}

/** What the guarded commit of the cleared row did. */
interface GuardRun {
  order: string[];
  committed: boolean;
  outcome?: StartupGuardOutcome;
  reload?: ReloadWindowResult;
  frozen?: FrozenRoutes;
  unfrozen: boolean;
  error?: ErrorDetail;
  rollbackError?: ErrorDetail;
}

/** Name and message of a caught value. */
function errorDetail(error: unknown): ErrorDetail {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };
}

/** Runs one check; a thrown error becomes the check's failed assertion. */
async function check(name: string, assess: () => Promise<FaultAssertion>): Promise<FaultAssertion> {
  try {
    return await assess();
  } catch (error) {
    return fail(name, { error: errorDetail(error) });
  }
}

/** Write-window lifecycle over the running migration service's contract, which carries no window kind and sets its own request id. */
function lifecycleOf(ctx: MigrationContext): WindowLifecycle {
  return {
    open: (request) => openWindowViaService(ctx, { routeKey: request.routeKey, units: request.units, scope: request.scope }),
    complete: (windowId, request) => completeWindowViaService(ctx, windowId, { forwarded: request.forwarded }),
  };
}

/** Body, Filename and URLTitle of one tcontent version; undefined when no such version exists. */
async function readRow(pool: ConnectionPool, contentHistId: string): Promise<ContentText | undefined> {
  const result = await pool.request().input('h', sql.Char(35), contentHistId).query<ContentText>(READ_SQL);
  return result.recordset[0];
}

/** Matching-row count on the live legacy database. */
async function liveStartupRows(ctx: MigrationContext): Promise<number> {
  return countStartupRows(await ctx.legacy.live());
}

/**
 * Clears the row's Body in one live transaction and commits it through the start-up guard sequence; never throws.
 * The fault runs at a quiesced point, so the transaction's row lock holds no legacy request the freeze waits for.
 */
async function clearBodyUnderGuard(ctx: MigrationContext, live: ConnectionPool, contentHistId: string): Promise<GuardRun> {
  const run: GuardRun = { order: [], committed: false, unfrozen: false };
  const tx = new sql.Transaction(live);
  let begun = false;
  try {
    await tx.begin();
    begun = true;
    const cleared = await tx.request().input('h', sql.Char(35), contentHistId).query(CLEAR_BODY_SQL);
    const changed = cleared.rowsAffected[0];
    if (changed !== 1) throw new Error(`Clearing Body of ${contentHistId} changed ${String(changed)} rows, not 1`);
    const { guarded, count } = await commitWithStartupGuard({
      scope: tx,
      async freezeLegacyBound() {
        run.order.push('freeze');
        run.frozen = await freezeLegacyBound(ctx);
      },
      async commit() {
        run.order.push('commit');
        await tx.commit();
        run.committed = true;
      },
      async runReloadWindow() {
        run.order.push('reload-window');
        run.reload = await runReloadWindowWith(ctx, lifecycleOf(ctx));
      },
      remainingStartupRows: () => liveStartupRows(ctx),
      async unfreeze() {
        run.order.push('unfreeze');
        if (run.frozen !== undefined) await unfreezeLegacyBound(ctx, run.frozen);
        run.unfrozen = true;
      },
    });
    run.outcome = { guarded, count };
  } catch (error) {
    run.error = errorDetail(error);
  }
  if (begun && !run.committed) {
    try {
      await tx.rollback();
    } catch (rollbackError) {
      run.rollbackError = errorDetail(rollbackError);
    }
  }
  return run;
}

/** The freeze a guard run left in place, which only `resume` can lift. */
function heldFreeze(run: GuardRun): FrozenRoutes | undefined {
  return run.frozen !== undefined && run.frozen.routes.length > 0 && !run.unfrozen ? run.frozen : undefined;
}

/** Assertions on the guard run and the live row after it. */
async function guardAssertions(
  ctx: MigrationContext,
  live: ConnectionPool,
  run: GuardRun,
  row: { contentHistId: string; before: ContentText },
): Promise<{ assertions: FaultAssertion[]; after: ContentText | null }> {
  const assertions: FaultAssertion[] = [];
  const { outcome, order, reload, error } = run;
  assertions.push(
    outcome?.guarded === true && outcome.count === 1
      ? pass('guard-triggered', outcome)
      : fail('guard-triggered', { outcome: outcome ?? null, error: error ?? null }),
  );
  const sequenced =
    order.length === EXPECTED_ORDER.length &&
    order.every((step, index) => step === EXPECTED_ORDER[index]) &&
    reload?.windowState === 'closed' &&
    reload.startupRowsRemaining === 0;
  assertions.push(
    sequenced ? pass('guard-sequence', { order, reload }) : fail('guard-sequence', { order, reload: reload ?? null, error: error ?? null }),
  );
  assertions.push(
    await check('predicate-empty-after', async () => {
      const count = await liveStartupRows(ctx);
      return count === 0
        ? pass('predicate-empty-after', { count })
        : fail('predicate-empty-after', { count }, 'rows still match the start-up predicate');
    }),
  );
  let after: ContentText | null = null;
  assertions.push(
    await check('row-converted', async () => {
      const current = (await readRow(live, row.contentHistId)) ?? null;
      after = current;
      if (!run.committed) return skipped('row-converted', 'the Body change was rolled back, so Masa had no row to convert');
      // Masa sets Body to the filename and may rewrite Filename and URLTitle; the original Body is not restored.
      return current !== null && current.Body !== null
        ? pass('row-converted', { before: row.before, after: current })
        : fail('row-converted', { before: row.before, after: current }, NOT_CONVERTED);
    }),
  );
  return { assertions, after };
}

/** Clears one active File row's Body on the live database and checks the guard freezes, commits, reloads and unfreezes. */
async function run(env: FaultEnv, { siteId }: ForcedReinitParams): Promise<FaultRunOutput> {
  const { ctx } = env;
  const live = await ctx.legacy.live();
  const assertions: FaultAssertion[] = [];

  const startupRows = await countStartupRows(live);
  if (startupRows !== 0) {
    assertions.push(fail('predicate-empty-before', { count: startupRows }, 'start-up predicate already non-empty'));
    return { assertions, details: { siteId } };
  }
  assertions.push(pass('predicate-empty-before', { count: 0 }));

  const holders = await holdersOf(ctx, contentUnits(ctx.catalog));
  if (holders.size > 0) {
    assertions.push(fail('content-units-free', { holders: Object.fromEntries(holders) }, 'content units are leased'));
    return { assertions, details: { siteId } };
  }
  assertions.push(pass('content-units-free'));

  const picked = (await live.request().input('siteId', sql.NVarChar(25), siteId).query<PickedRow>(PICK_SQL)).recordset[0];
  if (picked === undefined) {
    assertions.push(fail('guard-triggered', { siteId }, 'no active File content with a body for the site'));
    return { assertions, details: { siteId } };
  }
  const { ContentHistID: contentHistId, ContentID: contentId } = picked;
  const before: ContentText = { Body: picked.Body, Filename: picked.Filename, URLTitle: picked.URLTitle };

  const guard = await clearBodyUnderGuard(ctx, live, contentHistId);
  const checked = await guardAssertions(ctx, live, guard, { contentHistId, before });
  const held = heldFreeze(guard);
  return {
    assertions: [...assertions, ...checked.assertions],
    details: {
      siteId,
      contentHistId,
      contentId,
      before,
      after: checked.after,
      order: guard.order,
      reload: guard.reload ?? null,
      error: guard.error ?? null,
      ...(guard.rollbackError === undefined ? {} : { rollbackError: guard.rollbackError }),
    },
    // A freeze the guard left in place is lifted by resume: a fresh freeze skips routes that are already frozen.
    state: { contentHistId, ...(held === undefined ? {} : { frozen: held }) },
  };
}

/** Converts rows still matching the predicate, lifts a held freeze, and feeds legacy-authoritative content units. */
async function resume(env: FaultEnv, _params: ForcedReinitParams, output?: FaultRunOutput): Promise<FaultResumeOutput> {
  const { ctx } = env;
  const steps: string[] = [];
  const assertions: FaultAssertion[] = [];
  const held = output?.state?.frozen as FrozenRoutes | undefined;

  const startupRows = await liveStartupRows(ctx);
  if (startupRows > 0) {
    steps.push('reload-again');
    assertions.push(
      await check('resume-predicate-empty', async () => {
        const frozen = held ?? (await freezeLegacyBound(ctx));
        // Unfreezes only once no row matches, keeping the freeze otherwise, so no legacy request can re-initialise
        // Masa outside a window while a matching row exists.
        const reload = await recoverStartupGuard({
          runReloadWindow: () => runReloadWindowWith(ctx, lifecycleOf(ctx)),
          remainingStartupRows: () => liveStartupRows(ctx),
          unfreeze: () => unfreezeLegacyBound(ctx, frozen),
        });
        return pass('resume-predicate-empty', { count: startupRows, reload });
      }),
    );
  } else {
    if (held !== undefined) {
      steps.push('unfreeze-held');
      assertions.push(
        await check('held-freeze-lifted', async () => {
          await unfreezeLegacyBound(ctx, held);
          return pass('held-freeze-lifted', held);
        }),
      );
    }
    assertions.push(pass('resume-predicate-empty', { count: 0 }));
  }

  // A target-authoritative content unit received Masa's conversion through the reload window's import; a
  // legacy-authoritative one receives it only through the feed.
  const authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
  const feedUnits = contentUnits(ctx.catalog).filter((unit) => !authority.isTargetAuthoritative(unit));
  if (feedUnits.length > 0) {
    steps.push('rerun-feed');
    assertions.push(
      await check('feed-propagated', async () => {
        const feed = await runFeed(ctx);
        const detail = { snapshotSeq: feed.snapshotSeq, ...feed.reconciliation };
        return feed.exitCode === 0 ? pass('feed-propagated', detail) : fail('feed-propagated', detail, 'the feed reconciliation found differences');
      }),
    );
  }
  return { steps, assertions, details: { startupRows, feedUnits } };
}

/** Forces a start-up re-initialisation case and proves the guard converts it before legacy traffic resumes. */
export const forcedReinit: FaultScript<ForcedReinitParams> = {
  name: FAULT,
  reconciles: true,
  paramsSchema,
  run,
  resume,
};
