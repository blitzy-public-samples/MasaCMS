// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The only write path of schema `reporting`: the platform repository, the export-output step of migration applies, and the job writes. */
import {
  RepositoryError,
  createRepository,
  qualified,
  sha256Hex,
  type MigrationHandlerOptions,
  type Repository,
  type RepositoryRow,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import type { StoragePort } from '@opt2/platform/storage';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import {
  EXPORT_BUCKET,
  EXPORT_JOB,
  EXPORT_OUTPUT_FIELD,
  OWNED_TABLES,
  OWNER,
  exportObjectKey,
  type ExportJobApplyRow,
  type ExportJobRow,
} from './tables.js';

/** An export job to insert; `row_version` defaults to 1. */
export type NewExportJob = Omit<ExportJobRow, 'tenant_id' | 'row_version'> & Partial<Pick<ExportJobRow, 'tenant_id' | 'row_version'>>;

/** Columns a state move sets on a job; the repository sets `row_version` itself. */
export type ExportJobChanges = Partial<Omit<ExportJobRow, 'tenant_id' | 'job_id' | 'row_version'>>;

/** Domain writes of schema `reporting`; each runs in the caller's open tenant transaction and returns the stored row. */
export interface ReportingWrites {
  /** Inserts a job. */
  insertJob(tx: TenantTx, row: NewExportJob, ctx?: WriteContext): Promise<ExportJobRow>;
  /** Sets `changes` and the next `row_version` on job `key.job_id`; throws RepositoryError when it does not exist. */
  updateJob(tx: TenantTx, key: { job_id: string }, changes: ExportJobChanges, ctx?: WriteContext): Promise<ExportJobRow>;
}

/** The platform repository of schema `reporting` with the export-job writes. */
export type ReportingRepository = Repository & ReportingWrites;

/** Settings of `createReportingRepository`; `storage` holds the export outputs that migration applies carry. */
export interface ReportingRepositoryOptions {
  db: TenantDb;
  storage: StoragePort;
  clock: Clock;
}

/** Verified fixture output bytes, stored once their row is written. */
interface StagedOutput {
  jobId: string;
  key: string;
  bytes: Buffer;
  sha256: string;
  contentType: string;
}

/** An apply row ready for the platform repository, with the output it carried. */
interface StagedWrite {
  row: RepositoryRow;
  output?: StagedOutput;
}

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** True for an `export_job` row carrying the transient `output` field. */
function carriesOutput(table: string, row: RepositoryRow): boolean {
  return table === EXPORT_JOB.table && Object.hasOwn(row, EXPORT_OUTPUT_FIELD);
}

/** The error of output bytes whose SHA-256 is not the job's `output_sha256`. */
function outputMismatch(jobId: string, subject: string, actual: string, expected: unknown): RepositoryError {
  return new RepositoryError(`export job ${jobId} ${subject} has SHA-256 ${actual}, but its output_sha256 is ${String(expected)}`, EXPORT_JOB.table);
}

/** `row` without the transient `output` field. */
function withoutOutput(row: RepositoryRow): RepositoryRow {
  const stripped: RepositoryRow = { ...row };
  delete stripped[EXPORT_OUTPUT_FIELD];
  return stripped;
}

/**
 * Takes the fixture output bytes off an export-job apply row after checking them against `output_sha256`, and points
 * `object_key` at their object (NULL for NULL output). Rows of other tables, or without `output`, pass unchanged.
 */
function stageOutput(tx: TenantTx, table: string, row: RepositoryRow): StagedWrite {
  if (!carriesOutput(table, row)) return { row };
  const apply = row as ExportJobApplyRow;
  const bytes = apply[EXPORT_OUTPUT_FIELD];
  if (bytes === null) return { row: { ...withoutOutput(row), object_key: null } };
  const sha256 = sha256Hex(bytes);
  if (sha256 !== apply.output_sha256) throw outputMismatch(apply.job_id, 'output', sha256, apply.output_sha256);
  const key = exportObjectKey(tx.tenantId, apply.job_id, apply.format);
  return {
    row: { ...withoutOutput(row), object_key: key },
    output: { jobId: apply.job_id, key, bytes, sha256, contentType: apply.content_type ?? DEFAULT_CONTENT_TYPE },
  };
}

/** Builds the reporting repository over the platform repository of `OWNED_TABLES`; `src/app.ts` hands it to the migration handlers. */
export function createReportingRepository(options: ReportingRepositoryOptions): ReportingRepository {
  // The platform repository requires its schema to equal `tx.schema`: `reporting` in the service, a throwaway name in tests.
  const base = createRepository({ owner: OWNER, schema: options.db.schema, tables: OWNED_TABLES, clock: options.clock });
  const lockJobSql = `SELECT row_version FROM ${qualified(base.schema, EXPORT_JOB.table)} WHERE tenant_id = $1 AND job_id = $2 FOR UPDATE`;

  /** Runs `write` on the staged row, then stores the output it carried. */
  async function writeStaged<T>(tx: TenantTx, table: string, row: RepositoryRow, write: (row: RepositoryRow) => Promise<T>): Promise<T> {
    const staged = stageOutput(tx, table, row);
    const written = await write(staged.row);
    // Stored only after the row is written, so a write the repository rejects stores nothing; the deterministic key
    // makes a repeated batch overwrite the same object, and a rolled-back apply may leave it behind.
    const output = staged.output;
    if (output !== undefined) {
      const put = await options.storage.put(EXPORT_BUCKET, output.key, output.bytes, { contentType: output.contentType });
      if (put.sha256 !== output.sha256) throw outputMismatch(output.jobId, 'stored object', put.sha256, output.sha256);
    }
    return written;
  }

  // As in finance and communications, apply rows leave the target-only row_version unmapped: a migrated job takes the
  // column default on insert and keeps its stored value on update.
  function insert<R = RepositoryRow>(tx: TenantTx, table: string, row: RepositoryRow, ctx: WriteContext = {}): Promise<R> {
    return writeStaged(tx, table, row, (staged) => base.insert<R>(tx, table, staged, ctx));
  }

  function upsert<R = RepositoryRow>(tx: TenantTx, table: string, row: RepositoryRow, ctx: WriteContext = {}): Promise<R> {
    return writeStaged(tx, table, row, (staged) => base.upsert<R>(tx, table, staged, ctx));
  }

  // Stored objects are kept on delete: the reconciliation manifest lists objects from the remaining rows only.
  function remove<R = RepositoryRow>(tx: TenantTx, table: string, key: RepositoryRow, ctx: WriteContext = {}): Promise<R | null> {
    return base.delete<R>(tx, table, carriesOutput(table, key) ? withoutOutput(key) : key, ctx);
  }

  function insertJob(tx: TenantTx, row: NewExportJob, ctx: WriteContext = {}): Promise<ExportJobRow> {
    return base.insert<ExportJobRow>(tx, EXPORT_JOB.table, { ...row, row_version: row.row_version ?? '1' }, ctx);
  }

  async function updateJob(tx: TenantTx, key: { job_id: string }, changes: ExportJobChanges, ctx: WriteContext = {}): Promise<ExportJobRow> {
    // A locking read rather than findByKey, so two writers of one job never derive the same row_version.
    const current = await base.read(
      tx,
      EXPORT_JOB.unit,
      async () => (await tx.query<Pick<ExportJobRow, 'row_version'>>(lockJobSql, [tx.tenantId, key.job_id])).rows[0] ?? null,
    );
    // pg returns int8 as a decimal string.
    const updated =
      current === null
        ? null
        : await base.update<ExportJobRow>(
            tx,
            EXPORT_JOB.table,
            { job_id: key.job_id },
            { ...changes, row_version: String(BigInt(current.row_version) + 1n) },
            ctx,
          );
    if (updated === null) {
      throw new RepositoryError(`export job ${key.job_id} does not exist`, EXPORT_JOB.table);
    }
    return updated;
  }

  const repository: ReportingRepository = {
    ...base,
    insert,
    upsert,
    delete: remove,
    insertJob,
    updateJob,
  };
  return Object.freeze(repository satisfies MigrationHandlerOptions['repository']);
}
