// Runs the snapshot modules' statements on SQL Server's `master` database, and the error those modules raise.
import sql from 'mssql';
import type { ConnectionPool, IResult, ISqlType, Request } from 'mssql';

import type { MigrationContext } from '../context.js';
import { MASTER_DATABASE } from '../legacy/legacy-db.js';

/** A named, typed parameter of a master statement. */
export interface MasterStatementInput {
  name: string;
  type: ISqlType;
  value: unknown;
}

/** Raised when a snapshot cannot be taken, read or dropped. */
export class SnapshotError extends Error {
  override readonly name: string = 'SnapshotError';
}

// BACKUP and RESTORE outlast the driver's 15 s default request timeout, which would cancel them.
const SNAPSHOT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

// mssql 12 accepts per-request overrides as a second constructor argument; @types/mssql 12.3 declares only the first.
const RequestWithOverrides = sql.Request as unknown as new (
  parent: ConnectionPool,
  overrides: { requestTimeout: number },
) => Request;

/** Runs `sqlText` on `master` with the snapshot request timeout: as a plain batch, or with `inputs` through sp_executesql. */
export async function runMasterStatement<R = Record<string, unknown>>(
  ctx: Pick<MigrationContext, 'legacy'>,
  sqlText: string,
  inputs: readonly MasterStatementInput[] = [],
): Promise<IResult<R>> {
  const pool = await ctx.legacy.database(MASTER_DATABASE);
  const request = new RequestWithOverrides(pool, { requestTimeout: SNAPSHOT_REQUEST_TIMEOUT_MS });
  if (inputs.length === 0) return request.batch<R>(sqlText);
  for (const input of inputs) request.input(input.name, input.type, input.value);
  return request.query<R>(sqlText);
}
