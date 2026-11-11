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
  OUTPUT_SLOTS,
  OWNED_TABLES,
  OWNER,
  exportObjectKey,
  type ExportFormat,
  type ExportJobApplyRow,
  type ExportJobRow,
} from './tables.js';

/** An export job to insert; `row_version` defaults to 1. */
export type NewExportJob = Omit<ExportJobRow, 'tenant_id' | 'row_version'> & Partial<Pick<ExportJobRow, 'tenant_id' | 'row_version'>>;

/** Columns a state move sets on a job; the repository sets `row_version` itself. */
export type ExportJobChanges = Partial<Omit<ExportJobRow, 'tenant_id' | 'job_id' | 'row_version'>>;

/** Domain writes of schema `reporting`; each runs in the caller's open tenant transaction and returns the stored row. */
export interface ReportingWrites {
  /** Inserts a job; throws RepositoryError when a non-null `object_key` names no object of the job with its `output_sha256`. */
  insertJob(tx: TenantTx, row: NewExportJob, ctx?: WriteContext): Promise<ExportJobRow>;
  /** Sets `changes` and the next `row_version` on job `key.job_id`; throws RepositoryError when it does not exist or a changed output pointer names no matching object of the job. */
  updateJob(tx: TenantTx, key: { job_id: string }, changes: ExportJobChanges, ctx?: WriteContext): Promise<ExportJobRow>;
}

/** The platform repository of schema `reporting` with the export-job writes. */
export type ReportingRepository = Repository & ReportingWrites;

/** Settings of `createReportingRepository`; `storage` holds the export outputs migration applies carry, and `db` runs their post-commit cleanup. */
export interface ReportingRepositoryOptions {
  db: TenantDb;
  storage: StoragePort;
  clock: Clock;
}

/** Verified fixture output bytes, stored once their row is written. */
interface StagedOutput {
  bytes: Buffer;
  sha256: string;
  contentType: string;
}

/** An apply row ready for the platform repository; `output` is the verified bytes it carried, null for NULL output, absent without `output`. */
interface StagedWrite {
  row: RepositoryRow;
  output?: StagedOutput | null;
}

/** The output pointer of an export job row. */
type OutputPointer = Pick<ExportJobRow, 'object_key' | 'output_sha256' | 'format'>;

/** A job's output bookkeeping in one transaction: the key committed before it, the keys and formats it wrote, and whether cleanup is scheduled. */
interface JobOutputs {
  committed: string | null;
  keys: Set<string>;
  formats: Set<ExportFormat>;
  collecting: boolean;
}

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const POINTER_COLUMNS = ['object_key', 'output_sha256'] as const;
const [FIRST_SLOT, SECOND_SLOT] = OUTPUT_SLOTS;

/** True for an `export_job` row carrying the transient `output` field. */
function carriesOutput(table: string, row: RepositoryRow): boolean {
  return table === EXPORT_JOB.table && Object.hasOwn(row, EXPORT_OUTPUT_FIELD);
}

/** The job id of an `export_job` write setting `output`, `object_key` or `output_sha256`; undefined for any other write. */
function pointerJob(table: string, row: RepositoryRow, jobId: unknown = row.job_id): string | undefined {
  if (table !== EXPORT_JOB.table) return undefined;
  return carriesOutput(table, row) || POINTER_COLUMNS.some((column) => Object.hasOwn(row, column)) ? String(jobId) : undefined;
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

/** Takes the fixture output bytes off an export-job apply row after checking them against `output_sha256`; other rows pass unchanged. */
function stageOutput(table: string, row: RepositoryRow): StagedWrite {
  if (!carriesOutput(table, row)) return { row };
  const apply = row as ExportJobApplyRow;
  const bytes = apply[EXPORT_OUTPUT_FIELD];
  if (bytes === null) return { row: withoutOutput(row), output: null };
  const sha256 = sha256Hex(bytes);
  if (sha256 !== apply.output_sha256) throw outputMismatch(apply.job_id, 'output', sha256, apply.output_sha256);
  return { row: withoutOutput(row), output: { bytes, sha256, contentType: apply.content_type ?? DEFAULT_CONTENT_TYPE } };
}

/** The output-slot key of job `jobId` other than `committed`, the key its committed row names. */
function freeSlotKey(tenantId: string, jobId: string, format: ExportFormat, committed: string | null): string {
  const first = exportObjectKey(tenantId, jobId, format, FIRST_SLOT);
  return committed === first ? exportObjectKey(tenantId, jobId, format, SECOND_SLOT) : first;
}

/** Builds the reporting repository over the platform repository of `OWNED_TABLES`; `src/app.ts` hands it to the migration handlers. */
export function createReportingRepository(options: ReportingRepositoryOptions): ReportingRepository {
  // The platform repository requires its schema to equal `tx.schema`: `reporting` in the service, a throwaway name in tests.
  const base = createRepository({ owner: OWNER, schema: options.db.schema, tables: OWNED_TABLES, clock: options.clock });
  const lockJobSql = `SELECT row_version FROM ${qualified(base.schema, EXPORT_JOB.table)} WHERE tenant_id = $1 AND job_id = $2 FOR UPDATE`;
  const pointerSql = `SELECT object_key, output_sha256, format FROM ${qualified(base.schema, EXPORT_JOB.table)} WHERE tenant_id = $1 AND job_id = $2`;
  const outputs = new WeakMap<TenantTx, Map<string, JobOutputs>>();

  /** Serialises the output-pointer writes and cleanups of job `jobId` until `tx` ends; returns the pointer `tx` sees and the job's bookkeeping in `tx`. */
  async function lockOutput(tx: TenantTx, jobId: string): Promise<{ job: JobOutputs; current: OutputPointer | null }> {
    await tx.query(ADVISORY_LOCK_SQL, [`${base.schema}.${EXPORT_JOB.table}.output:${tx.tenantId}:${jobId}`]);
    const current = (await tx.query<OutputPointer>(pointerSql, [tx.tenantId, jobId])).rows[0] ?? null;
    let jobs = outputs.get(tx);
    if (jobs === undefined) {
      jobs = new Map();
      outputs.set(tx, jobs);
    }
    let job = jobs.get(jobId);
    if (job === undefined) {
      // Every write that moves the pointer locks first, so at the job's first lock in `tx` the row still names its committed key.
      const committed = current?.object_key ?? null;
      job = { committed, keys: new Set(committed === null ? [] : [committed]), formats: new Set(), collecting: false };
      jobs.set(jobId, job);
    }
    return { job, current };
  }

  /** Deletes every object of job `jobId` that `job` lists or an output slot holds, except the one its committed row names; a deleted job keeps them all. */
  function collect(tenantId: string, jobId: string, job: JobOutputs): Promise<void> {
    return options.db.withTenant(tenantId, async (tx) => {
      const { current } = await lockOutput(tx, jobId);
      if (current === null) return;
      const candidates = new Set(job.keys);
      for (const format of new Set([...job.formats, current.format])) {
        for (const slot of OUTPUT_SLOTS) candidates.add(exportObjectKey(tenantId, jobId, format, slot));
      }
      if (current.object_key !== null) candidates.delete(current.object_key);
      for (const key of candidates) await options.storage.delete(EXPORT_BUCKET, key);
    });
  }

  /** Records the pointer a write of job `jobId` left in `tx`; with `collectAfter`, schedules the job's cleanup for after `tx` commits. */
  function noteWrite(
    tx: TenantTx,
    jobId: string,
    job: JobOutputs,
    stored: Pick<OutputPointer, 'object_key' | 'format'>,
    collectAfter: boolean,
  ): void {
    if (stored.object_key !== null) job.keys.add(stored.object_key);
    job.formats.add(stored.format);
    if (collectAfter && !job.collecting) {
      job.collecting = true;
      tx.onCommit(() => collect(tx.tenantId, jobId, job));
    }
  }

  /** The key `current` names when its object already holds `output` under its content type; null otherwise. */
  async function storedKey(current: OutputPointer | null, output: StagedOutput): Promise<string | null> {
    const key = current?.object_key ?? null;
    if (key === null || current?.output_sha256 !== output.sha256) return null;
    const head = await options.storage.head(EXPORT_BUCKET, key);
    return head?.sha256 === output.sha256 && head.contentType === output.contentType ? key : null;
  }

  /** Throws unless `stored` keeps the pointer `before` held, names nothing, or names a stored object of its own job with its `output_sha256`. */
  async function verifyPointer(tx: TenantTx, before: OutputPointer | null, stored: ExportJobRow): Promise<void> {
    const key = stored.object_key;
    if (key === null || (key === before?.object_key && stored.output_sha256 === before?.output_sha256)) return;
    if (!key.startsWith(`${tx.tenantId}/${stored.job_id}.`)) {
      throw new RepositoryError(`export job ${stored.job_id} object_key ${key} is not a key of the job`, EXPORT_JOB.table);
    }
    const head = await options.storage.head(EXPORT_BUCKET, key);
    if (head === null) throw new RepositoryError(`export job ${stored.job_id} object_key ${key} names no stored object`, EXPORT_JOB.table);
    if (head.sha256 !== stored.output_sha256) throw outputMismatch(stored.job_id, `object ${key}`, head.sha256, stored.output_sha256);
  }

  /** Runs `write`, a write of job `jobId` setting `object_key` or `output_sha256` without output bytes, under the job's output lock. */
  async function writePointer<T>(tx: TenantTx, jobId: string, write: () => Promise<T>): Promise<T> {
    const { job, current } = await lockOutput(tx, jobId);
    const written = await write();
    const stored = written as ExportJobRow | null;
    if (stored !== null) {
      await verifyPointer(tx, current, stored);
      noteWrite(tx, jobId, job, stored, stored.object_key !== (current?.object_key ?? null));
    }
    return written;
  }

  /** Runs `write` on the staged row; output bytes go to the key already holding them, else to the output slot the committed row does not name. */
  async function writeStaged<T>(tx: TenantTx, table: string, row: RepositoryRow, write: (row: RepositoryRow) => Promise<T>): Promise<T> {
    const staged = stageOutput(table, row);
    const jobId = pointerJob(table, row);
    if (jobId === undefined) return write(staged.row);
    const output = staged.output;
    if (output === undefined) return writePointer(tx, jobId, () => write(staged.row));
    const { job, current } = await lockOutput(tx, jobId);
    const format = (staged.row as ExportJobApplyRow).format;
    const reused = output === null ? null : await storedKey(current, output);
    const upload = output === null || reused !== null ? undefined : { ...output, key: freeSlotKey(tx.tenantId, jobId, format, job.committed) };
    const key = reused ?? upload?.key ?? null;
    const written = await write({ ...staged.row, object_key: key });
    // Stored only after the row is written, so a write the repository rejects stores nothing; the committed object is never overwritten.
    if (upload !== undefined) {
      const put = await options.storage.put(EXPORT_BUCKET, upload.key, upload.bytes, { contentType: upload.contentType });
      if (put.sha256 !== upload.sha256) throw outputMismatch(jobId, 'stored object', put.sha256, upload.sha256);
    }
    noteWrite(tx, jobId, job, { object_key: key, format }, true);
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

  function update<R = RepositoryRow>(
    tx: TenantTx,
    table: string,
    key: RepositoryRow,
    patch: RepositoryRow,
    ctx: WriteContext = {},
  ): Promise<R | null> {
    const jobId = pointerJob(table, patch, key.job_id);
    const write = (): Promise<R | null> => base.update<R>(tx, table, key, patch, ctx);
    return jobId === undefined ? write() : writePointer(tx, jobId, write);
  }

  // Stored objects are kept on delete: the reconciliation manifest lists objects from the remaining rows only.
  async function remove<R = RepositoryRow>(tx: TenantTx, table: string, key: RepositoryRow, ctx: WriteContext = {}): Promise<R | null> {
    // Locked so a later write of the job in `tx` still knows the key committed before this delete.
    if (table === EXPORT_JOB.table) await lockOutput(tx, String(key.job_id));
    return base.delete<R>(tx, table, carriesOutput(table, key) ? withoutOutput(key) : key, ctx);
  }

  function insertJob(tx: TenantTx, row: NewExportJob, ctx: WriteContext = {}): Promise<ExportJobRow> {
    return writePointer(tx, row.job_id, () => base.insert<ExportJobRow>(tx, EXPORT_JOB.table, { ...row, row_version: row.row_version ?? '1' }, ctx));
  }

  // The output lock comes before the gate and row locks, as on every write that moves an output pointer.
  function updateJob(tx: TenantTx, key: { job_id: string }, changes: ExportJobChanges, ctx: WriteContext = {}): Promise<ExportJobRow> {
    const write = (): Promise<ExportJobRow> => setJob(tx, key, changes, ctx);
    return pointerJob(EXPORT_JOB.table, changes, key.job_id) === undefined ? write() : writePointer(tx, key.job_id, write);
  }

  async function setJob(tx: TenantTx, key: { job_id: string }, changes: ExportJobChanges, ctx: WriteContext): Promise<ExportJobRow> {
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
    update,
    upsert,
    delete: remove,
    insertJob,
    updateJob,
  };
  return Object.freeze(repository satisfies MigrationHandlerOptions['repository']);
}
