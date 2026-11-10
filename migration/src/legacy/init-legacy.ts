import { readFile } from 'node:fs/promises';

import { OPT2_SYNC_SQL_PATH } from '../paths.js';
import type { LegacyDb } from './legacy-db.js';

/** Logger that receives the one success line; the platform pino logger satisfies it structurally. */
export interface InitLegacyLogger {
  info(msg: string): void;
}

/** Legacy-database objects that exist once `initLegacy` has succeeded. */
export interface InitLegacyResult {
  schema: 'opt2_sync';
  table: 'opt2_sync.projector_checkpoint';
}

// 262 CREATE permission denied in database, 229/230 permission denied on object or column,
// 2760 schema missing or not permitted, 15247 no permission to perform the action.
const PERMISSION_ERROR_NUMBERS: ReadonlySet<number> = new Set([229, 230, 262, 2760, 15247]);

const READY_QUERY =
  "select count(*) as n from sys.tables t join sys.schemas s on s.schema_id = t.schema_id where s.name = 'opt2_sync' and t.name = 'projector_checkpoint'";

/** Raised when the legacy database account may not create `opt2_sync`; the original driver error is its `cause`. */
export class Opt2SyncUnavailableError extends Error {
  override readonly name = 'Opt2SyncUnavailableError';
  /** SQL Server's message for the refused statement. */
  readonly reason: string;
  /** SQL Server error number of the refused statement. */
  readonly sqlErrorNumber?: number;

  constructor(reason: string, sqlErrorNumber: number | undefined, options?: ErrorOptions) {
    super(
      `Schema opt2_sync could not be created in the legacy database, so no unit may become target-authoritative: ${reason}`,
      options,
    );
    this.reason = reason;
    this.sqlErrorNumber = sqlErrorNumber;
  }
}

interface SqlServerErrorShape {
  number?: unknown;
  message?: unknown;
  originalError?: { info?: { number?: unknown } };
}

/** SQL Server error number and message of `error` when it is one of the permission failures, else undefined. */
function permissionFailure(error: unknown): { number: number; reason: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const shape = error as SqlServerErrorShape;
  const number = shape.number ?? shape.originalError?.info?.number;
  if (typeof number !== 'number' || !PERMISSION_ERROR_NUMBERS.has(number)) return undefined;
  return { number, reason: typeof shape.message === 'string' ? shape.message : `SQL Server error ${String(number)}` };
}

/** Runs `005_opt2_sync.sql` as one batch on the live legacy database, creating `opt2_sync.projector_checkpoint` if absent. */
export async function initLegacy(
  deps: { legacy: Pick<LegacyDb, 'live'>; logger: InitLegacyLogger },
  options?: { sqlPath?: string | URL },
): Promise<InitLegacyResult> {
  const text = await readFile(options?.sqlPath ?? OPT2_SYNC_SQL_PATH, 'utf8');
  const pool = await deps.legacy.live();
  try {
    // `batch` sends the file text unchanged as a SQL batch; `query` would wrap it in sp_executesql.
    await pool.request().batch(text);
  } catch (error) {
    const refused = permissionFailure(error);
    if (refused === undefined) throw error;
    throw new Opt2SyncUnavailableError(refused.reason, refused.number, { cause: error });
  }
  deps.logger.info('opt2_sync ready');
  return { schema: 'opt2_sync', table: 'opt2_sync.projector_checkpoint' };
}

/** True when `opt2_sync.projector_checkpoint` exists in the live legacy database. */
export async function opt2SyncReady(legacy: Pick<LegacyDb, 'live'>): Promise<boolean> {
  const pool = await legacy.live();
  const result = await pool.request().query<{ n: number }>(READY_QUERY);
  return result.recordset[0]?.n === 1;
}
