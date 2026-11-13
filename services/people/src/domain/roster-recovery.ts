// Recovery of roster operations a request left open: run by the people outbox sweep and by `opt2-people resolve-operation`.
import { serializeError, type Logger } from '@opt2/platform/logging';
import { endOperation, withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import { discardOperation, releaseOperation, type RecoveryHook } from '@opt2/platform/outbox';
import { ServiceUnavailableError, type Clock } from '@opt2/platform/service-kit';
import { registeredTenants, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import type { PeopleEvents } from '../events/publish.js';
import type { AccountOperationState, IdentityClient } from '../legacy/identity-client.js';
import type { PeopleRepository, RosterOperationStatePatch } from '../repo/repository.js';
import { FINISH_PENDING_ERROR, type RosterOperationRow, type RosterState } from '../repo/tables.js';
import { restoreBeforeImage } from './roster-protocol.js';

/** Age, since its last state change, past which the sweep resolves an operation. */
export const RECOVERY_THRESHOLD_MS = 30_000;

/** Continuous identity unreachability past which an open operation is halted for an operator. */
export const HALT_AFTER_MS = 300_000;

/** Collaborators of a resolution. */
export interface RecoveryDeps {
  db: TenantDb;
  repo: PeopleRepository;
  identity: IdentityClient;
  events: PeopleEvents;
  clock: Clock;
  logger: Logger;
}

/** The final state an operator forces a resolution towards. */
export type ResolveTarget = 'rolled-back' | 'done';

/** What a resolution did: identity aborted or reverted with people rolled back, both sides finished, halted, or nothing. */
export type ResolveAction = 'aborted' | 'reverted' | 'finished' | 'halted' | 'unchanged';

/** One resolution: the operation's state before and after, and identity's state when identity answered. */
export interface ResolveOutcome {
  operationId: string;
  from: RosterState;
  to: RosterState;
  action: ResolveAction;
  identityState?: AccountOperationState;
}

/** Outcomes of one sweep's recovery. */
export interface RecoveryCounts {
  resolved: number;
  halted: number;
  failed: number;
}

/** An operation the tenant does not hold, or a resolution its recorded states refuse; nothing was changed. */
export class RosterResolutionError extends Error {
  override readonly name: string = 'RosterResolutionError';

  constructor(
    readonly operationId: string,
    message: string,
  ) {
    super(message);
  }
}

/** Raised by the sweep hook once every stale operation was tried and some failed; each failure is logged on its own line. */
export class RosterRecoveryError extends Error {
  override readonly name: string = 'RosterRecoveryError';

  constructor(readonly counts: RecoveryCounts) {
    super(`${counts.failed} roster operation(s) failed recovery`);
  }
}

/** What a resolution does once identity's state is known. */
type Plan = { kind: 'rollback'; step: 'abort' | 'revert' } | { kind: 'finish'; step: boolean };

/** The write context of every people write a resolution makes. */
function writeContext(operationId: string): WriteContext {
  return { operationId, origin: 'target', actorService: 'people' };
}

/** A char(35) id without its padding. */
function unpadded(id: string): string {
  return id.replace(/ +$/, '');
}

function outcome(operation: RosterOperationRow, to: RosterState, action: ResolveAction, identityState?: AccountOperationState): ResolveOutcome {
  return { operationId: operation.operation_id, from: operation.state, to, action, ...(identityState === undefined ? {} : { identityState }) };
}

function refused(operation: RosterOperationRow, target: ResolveTarget, identityState?: AccountOperationState): RosterResolutionError {
  const identity = identityState ?? 'unknown';
  return new RosterResolutionError(
    operation.operation_id,
    `Roster operation ${operation.operation_id} in state ${operation.state} cannot resolve to ${target} while identity reports ${identity}`,
  );
}

/** Whether the operation needs identity's state: false when it is settled (or halted without an operator target), else true; throws when `to` contradicts a settled state. */
function needsResolution(operation: RosterOperationRow, to: ResolveTarget | undefined): boolean {
  const { state } = operation;
  const finished = state === 'done' && operation.error !== FINISH_PENDING_ERROR;
  if (state === 'rolled-back' || finished) {
    const reached: ResolveTarget = state === 'rolled-back' ? 'rolled-back' : 'done';
    if (to !== undefined && to !== reached) throw refused(operation, to);
    return false;
  }
  if (state === 'done' && to === 'rolled-back') throw refused(operation, to);
  return state !== 'halted' || to !== undefined;
}

/** The resolution of an unsettled operation given identity's state; null when the two sides cannot reach `target`. */
function decide(operation: RosterOperationRow, identityState: AccountOperationState | undefined, target: ResolveTarget): Plan | null {
  switch (target) {
    case 'done': {
      // Done needs people's change committed: a done operation, or a before-image only the people commit records.
      const peopleCommitted = operation.state === 'done' || operation.before_image !== null;
      if (!peopleCommitted) return null;
      if (identityState === 'committed') return { kind: 'finish', step: true };
      return identityState === 'finished' ? { kind: 'finish', step: false } : null;
    }
    case 'rolled-back':
      switch (identityState) {
        case 'committed':
        case 'reverted':
          return { kind: 'rollback', step: 'revert' };
        case 'finished':
          return null;
        default:
          // Prepared, aborted or never recorded: abort is idempotent and clears a prepare that died before recording.
          return { kind: 'rollback', step: 'abort' };
      }
  }
}

/** Sets the operation's state, then runs `alongside` in the same gated transaction. */
async function writeState(
  deps: Pick<RecoveryDeps, 'db' | 'repo'>,
  tenantId: string,
  operationId: string,
  patch: RosterOperationStatePatch,
  alongside?: (tx: TenantTx) => Promise<unknown>,
): Promise<void> {
  await withGatedTenant(deps.db, tenantId, async (tx) => {
    await deps.repo.setRosterOperationState(tx, operationId, patch, writeContext(operationId));
    if (alongside !== undefined) await alongside(tx);
  });
}

/** Undoes identity's side, then people's from the before-image, and ends the operation rolled back. */
async function rollBack(deps: RecoveryDeps, tenantId: string, operation: RosterOperationRow, step: 'abort' | 'revert'): Promise<void> {
  const operationId = operation.operation_id;
  const userId = unpadded(operation.user_id);
  // Identity first: its recorded state then tells a later run whether people still has to restore, while the user stays closed here.
  if (step === 'revert') await deps.identity.revert(userId, operationId);
  else await deps.identity.abort(userId, operationId);
  if (operation.before_image !== null) await restoreBeforeImage(deps, tenantId, operation);
  await writeState(deps, tenantId, operationId, { state: 'rolled-back', identityUnreachableSince: null }, async (tx) => {
    await discardOperation(tx, operationId);
    await endOperation(tx, operationId);
  });
}

/** Moves an open operation to done (releasing people's held events), repeats identity's finish when owed, and ends the operation. */
async function finish(deps: RecoveryDeps, tenantId: string, operation: RosterOperationRow, step: boolean): Promise<void> {
  const operationId = operation.operation_id;
  if (operation.state !== 'done') {
    await writeState(deps, tenantId, operationId, { state: 'done', error: FINISH_PENDING_ERROR, identityUnreachableSince: null }, (tx) =>
      releaseOperation(tx, operationId),
    );
  }
  if (step) await deps.identity.finish(unpadded(operation.user_id), operationId);
  await writeState(deps, tenantId, operationId, { state: 'done', error: null, identityUnreachableSince: null }, (tx) => endOperation(tx, operationId));
}

/** Records identity's unreachability; halts an open operation once it has lasted past `HALT_AFTER_MS`. A done operation keeps retrying its finish. */
async function recordUnreachable(
  deps: RecoveryDeps,
  tenantId: string,
  operation: RosterOperationRow,
  identityState: AccountOperationState | undefined,
  replied: boolean,
): Promise<ResolveOutcome> {
  const operationId = operation.operation_id;
  const now = deps.clock.now();
  // A reply earlier in this run restarts the unreachable period.
  const since = replied ? now : (operation.identity_unreachable_since ?? now);
  if (operation.state !== 'done' && now.getTime() - since.getTime() > HALT_AFTER_MS) {
    await writeState(deps, tenantId, operationId, { state: 'halted', identityUnreachableSince: since });
    const userId = unpadded(operation.user_id);
    deps.logger.error({ tenantId, userId }, `roster operation ${operationId} of user ${userId} halted: identity unreachable since ${since.toISOString()}`);
    return outcome(operation, 'halted', 'halted', identityState);
  }
  if (operation.identity_unreachable_since?.getTime() !== since.getTime()) {
    await writeState(deps, tenantId, operationId, { state: operation.state, identityUnreachableSince: since });
  }
  return outcome(operation, operation.state, 'unchanged', identityState);
}

/** Resolves one roster operation from its and identity's recorded states, or towards an operator's `to`; throws RosterResolutionError for a combination the two sides cannot reach. */
export async function resolveOperation(deps: RecoveryDeps, args: { tenantId: string; operationId: string; to?: ResolveTarget }): Promise<ResolveOutcome> {
  const { tenantId, to } = args;
  const operation = await withTenant(deps.db, tenantId, (tx) => deps.repo.findRosterOperation(tx, args.operationId));
  if (operation === null) {
    throw new RosterResolutionError(args.operationId, `Roster operation ${args.operationId} is not held by tenant ${tenantId}`);
  }
  if (!needsResolution(operation, to)) return outcome(operation, operation.state, 'unchanged');

  const userId = unpadded(operation.user_id);
  let identityState: AccountOperationState | undefined;
  let replied = false;
  try {
    identityState = await deps.identity.operationState(userId, operation.operation_id);
    replied = true;
    // A finished identity has reopened and released its side, so only rolling people forward keeps the two sides equal.
    const target: ResolveTarget = to ?? (operation.state === 'done' || identityState === 'finished' ? 'done' : 'rolled-back');
    const plan = decide(operation, identityState, target);
    if (plan === null) throw refused(operation, target, identityState);
    if (plan.kind === 'rollback') {
      await rollBack(deps, tenantId, operation, plan.step);
      return outcome(operation, 'rolled-back', plan.step === 'revert' ? 'reverted' : 'aborted', identityState);
    }
    await finish(deps, tenantId, operation, plan.step);
    return outcome(operation, 'done', 'finished', identityState);
  } catch (err) {
    // An operator's run fails and leaves the operation as it was; only recovery records unreachability and halts.
    if (!(err instanceof ServiceUnavailableError) || to !== undefined) throw err;
    return recordUnreachable(deps, tenantId, operation, identityState, replied);
  }
}

/** Resolves every operation of every registered tenant left unchanged past `RECOVERY_THRESHOLD_MS`; one failure is logged and the rest still run. */
export async function recoverRosterOperations(deps: RecoveryDeps): Promise<RecoveryCounts> {
  const counts: RecoveryCounts = { resolved: 0, halted: 0, failed: 0 };
  // Case-folded as withTenant folds them, so one tenant is never listed twice.
  const tenantIds = new Set((await registeredTenants(deps.db)).map((entry) => entry.tenantId.toLowerCase()));
  for (const tenantId of tenantIds) {
    const olderThan = new Date(deps.clock.now().getTime() - RECOVERY_THRESHOLD_MS);
    const stale = await withTenant(deps.db, tenantId, async (tx) => {
      const rows = await deps.repo.listStaleRosterOperations(tx, olderThan);
      // Touching updated_at under the listing's row locks keeps an overlapping sweep from resolving the same operations.
      for (const row of rows) await deps.repo.setRosterOperationState(tx, row.operation_id, { state: row.state }, writeContext(row.operation_id));
      return rows;
    });
    for (const row of stale) {
      try {
        const { action } = await resolveOperation(deps, { tenantId, operationId: row.operation_id });
        if (action === 'halted') counts.halted += 1;
        else if (action !== 'unchanged') counts.resolved += 1;
      } catch (err) {
        counts.failed += 1;
        deps.logger.error(
          { tenantId, userId: unpadded(row.user_id), error: serializeError(err) },
          `roster operation ${row.operation_id} recovery failed`,
        );
      }
    }
  }
  return counts;
}

/** The `roster-operations` recovery hook of the people outbox sweep; it fails, after trying every operation, when any failed. */
export function rosterRecoveryHook(deps: Omit<RecoveryDeps, 'logger' | 'clock'>): RecoveryHook {
  return {
    name: 'roster-operations',
    async run(ctx) {
      const counts = await recoverRosterOperations({ ...deps, clock: ctx.clock, logger: ctx.logger });
      if (counts.failed > 0) throw new RosterRecoveryError(counts);
    },
  };
}
