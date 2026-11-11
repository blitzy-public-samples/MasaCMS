// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance records: create, lifecycle transitions and edits with their version rows, and the record reads of finance.cfc. */
import { applyTransition } from '@opt2/platform/state-machine';
import { LEGACY_ERROR_MAP, cfUuid } from '@opt2/platform/legacy-compat';
import type { Clock } from '@opt2/platform/service-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { StoragePort } from '@opt2/platform/storage';
import type { WriteContext } from '@opt2/platform/migration-kit';
import { financeLifecycle, type FinanceAction, type FinanceState } from './lifecycle.transitions.js';
import { formatMoney, moneyFromNumeric, type Money } from './money.js';
import type { FinanceRecordChanges, FinanceRepository, NewFinanceRecordVersion } from '../repo/repository.js';
import {
  findProgramBinding,
  findRecord,
  periodTotals,
  listRecords as queryRecordPage,
  listVersions as queryVersions,
  type PeriodScope,
  type RecordPage,
  type RecordPaging,
} from '../repo/queries.js';
import type { FinanceRecordRow, FinanceRecordVersionRow } from '../repo/tables.js';

/** The acting user and the legacy site of the request, both taken from the verified token. */
export type FinanceActor = { userId: string; siteId: string };

/** Collaborators of the finance domain functions. */
export type FinanceDomainDeps = { repository: FinanceRepository; storage: StoragePort; clock: Clock };

/** Fields of a new record, already validated at the route boundary. */
export type RecordInput = { title: string; amount: Money; period: string };

/** Fields an `edit` sets; an absent field keeps its stored value. */
export type RecordEdit = Partial<RecordInput>;

/** A lifecycle action on record `id`; `roles` are the verified token roles, and only `edit` applies `input`. */
export type TransitionCommand = { id: string; action: FinanceAction; roles: readonly string[]; input?: RecordEdit };

/** A written record and the version row written with it. */
export type RecordWrite = { record: FinanceRecordRow; version: FinanceRecordVersionRow };

/** Fixture envelope error types the record paths raise. */
export type FinanceDomainErrorType = 'notFound' | 'invalidParameters';

// The fixture raises both with an empty message, so envelope.cfc answers its default message for the type.
const DOMAIN_ERROR_MESSAGES: Readonly<Record<FinanceDomainErrorType, string>> = Object.freeze({
  notFound: 'Not Found',
  invalidParameters: LEGACY_ERROR_MAP.invalidParameters.message,
});

/** A finance fixture error of `type`, carrying the fixture's message; `legacy/envelope.ts` renders it. */
export class FinanceDomainError extends Error {
  override readonly name = 'FinanceDomainError';

  constructor(readonly type: FinanceDomainErrorType) {
    super(DOMAIN_ERROR_MESSAGES[type]);
  }
}

const INITIAL_STATE: FinanceState = 'IN-PROGRESS';
const CREATE_ACTION = 'create';
const EDIT_ACTION: FinanceAction = 'edit';
// 999999999999999.9999, the largest numeric(19,4) value, as Money.
const MAX_PERIOD_TOTAL: Money = 9_999_999_999_999_999_999n;

/** The version row snapshotting the stored `record` after `action` by `actor` at `at`. */
function versionOf(record: FinanceRecordRow, action: string, actor: FinanceActor, at: Date): NewFinanceRecordVersion {
  return {
    tenant_id: record.tenant_id,
    version_id: cfUuid(),
    record_id: record.record_id,
    version: record.version,
    state: record.state,
    title: record.title,
    amount: record.amount,
    period: record.period,
    action,
    actor_user_id: actor.userId,
    created: at,
    legacy_program_id: record.legacy_program_id,
  };
}

/** The record columns `edit` sets: only the fields present in `input`. */
function editedColumns(input: RecordEdit = {}): FinanceRecordChanges {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.amount === undefined ? {} : { amount: formatMoney(input.amount) }),
    ...(input.period === undefined ? {} : { period: input.period }),
  };
}

/** Takes the tenant write lock, then throws `invalidParameters` when `amount` would carry a sum of `scope` past numeric(19,4), as the fixture procedures do. */
async function guardPeriodTotal(tx: TenantTx, deps: FinanceDomainDeps, scope: PeriodScope, amount: Money): Promise<void> {
  await deps.repository.lockWrites(tx);
  const totals = await periodTotals(tx, scope);
  if (totals.positive + (amount > 0n ? amount : 0n) > MAX_PERIOD_TOTAL || totals.negative + (amount < 0n ? amount : 0n) < -MAX_PERIOD_TOTAL) {
    throw new FinanceDomainError('invalidParameters');
  }
}

/** Provenance of a domain write by `actor`. */
function writeContext(actor: FinanceActor): WriteContext {
  return { actorUserId: actor.userId };
}

/**
 * Creates an IN-PROGRESS record at version 1 with its `create` version row.
 * Throws `invalidParameters` when the tenant has no program or the amount would overflow its period's totals.
 */
export async function createRecord(tx: TenantTx, deps: FinanceDomainDeps, input: RecordInput, actor: FinanceActor): Promise<RecordWrite> {
  const binding = await findProgramBinding(tx);
  if (binding === null) throw new FinanceDomainError('invalidParameters');
  await guardPeriodTotal(tx, deps, { programId: binding.legacy_program_id, period: input.period }, input.amount);
  const now = deps.clock.now();
  const ctx = writeContext(actor);
  const record = await deps.repository.insertRecord(
    tx,
    {
      tenant_id: tx.tenantId,
      record_id: cfUuid(),
      siteid: actor.siteId,
      title: input.title,
      amount: formatMoney(input.amount),
      period: input.period,
      state: INITIAL_STATE,
      version: 1,
      created: now,
      createdbyid: actor.userId,
      lastupdate: null,
      lastupdatebyid: null,
      legacy_program_id: binding.legacy_program_id,
    },
    ctx,
  );
  const version = await deps.repository.insertVersion(tx, versionOf(record, CREATE_ACTION, actor, now), ctx);
  return { record, version };
}

/**
 * Applies `command.action` to its record under the finance lifecycle and writes the resulting version row.
 * Throws `notFound` for a missing record before any role or state check; a rejected transition throws `TransitionRejectedError`;
 * an edit that would overflow its period's totals throws `invalidParameters`.
 */
export async function transitionRecord(
  tx: TenantTx,
  deps: FinanceDomainDeps,
  command: TransitionCommand,
  actor: FinanceActor,
): Promise<RecordWrite> {
  const current = await findRecord(tx, command.id, { forUpdate: true });
  if (current === null) throw new FinanceDomainError('notFound');
  return applyTransition(financeLifecycle, { state: current.state, action: command.action, roles: command.roles }, async (transition) => {
    if (transition.action === EDIT_ACTION) {
      const scope = { programId: current.legacy_program_id, period: command.input?.period ?? current.period, excludeRecordId: current.record_id };
      await guardPeriodTotal(tx, deps, scope, command.input?.amount ?? moneyFromNumeric(current.amount));
    }
    const now = deps.clock.now();
    const ctx = writeContext(actor);
    const changes: FinanceRecordChanges = {
      state: transition.to,
      ...(transition.action === EDIT_ACTION ? editedColumns(command.input) : {}),
      version: current.version + 1,
      lastupdate: now,
      lastupdatebyid: actor.userId,
    };
    const record = await deps.repository.updateRecord(tx, current, changes, ctx);
    const version = await deps.repository.insertVersion(tx, versionOf(record, transition.action, actor, now), ctx);
    return { record, version };
  });
}

/** The record `id`; throws `notFound` when the tenant has none. */
export async function getRecord(tx: TenantTx, id: string): Promise<FinanceRecordRow> {
  const record = await findRecord(tx, id);
  if (record === null) throw new FinanceDomainError('notFound');
  return record;
}

/** One page of the tenant's records in fixture order, with the total count. */
export function listRecords(tx: TenantTx, paging: RecordPaging): Promise<RecordPage> {
  return queryRecordPage(tx, paging);
}

/** Every version row of record `recordId` by version; throws `notFound` when the record is missing. */
export async function listVersions(tx: TenantTx, recordId: string): Promise<FinanceRecordVersionRow[]> {
  await getRecord(tx, recordId);
  return queryVersions(tx, recordId);
}
