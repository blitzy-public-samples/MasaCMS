// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The only write path of schema `finance`: the platform repository, the attachment and program steps of migration applies, and the domain writes. */
import {
  APPLY_ORIGINS,
  LEGACY_PROGRAM_ID_COLUMN,
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
import { siteForTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import {
  ATTACHMENT_BUCKET,
  ATTACHMENT_CONTENT_FIELD,
  FINANCE_ATTACHMENT,
  FINANCE_RECORD,
  FINANCE_RECORD_VERSION,
  FINANCE_ROLLUP,
  OWNED_TABLES,
  OWNER,
  PROGRAM_BINDING,
  attachmentObjectKey,
  type FinanceAttachmentRow,
  type FinanceRecordRow,
  type FinanceRecordVersionRow,
  type FinanceRollupRow,
} from './tables.js';

/** A record to insert; `record_id` defaults to a new CF UUID and `row_version` to 1. */
export type NewFinanceRecord = Omit<FinanceRecordRow, 'tenant_id' | 'record_id' | 'row_version'> &
  Partial<Pick<FinanceRecordRow, 'tenant_id' | 'record_id' | 'row_version'>>;

/** Columns a lifecycle action or edit sets on a record. */
export type FinanceRecordChanges = Partial<
  Pick<FinanceRecordRow, 'state' | 'title' | 'amount' | 'period' | 'version' | 'lastupdate' | 'lastupdatebyid'>
>;

/** A version row to insert; `version_id` defaults to a new CF UUID. */
export type NewFinanceRecordVersion = Omit<FinanceRecordVersionRow, 'tenant_id' | 'version_id' | 'row_version'> &
  Partial<Pick<FinanceRecordVersionRow, 'tenant_id' | 'version_id' | 'row_version'>>;

/** An attachment row whose bytes are already stored under `object_key`; `attachment_id` defaults to a new CF UUID. */
export type NewFinanceAttachment = Omit<FinanceAttachmentRow, 'tenant_id' | 'attachment_id' | 'row_version'> &
  Partial<Pick<FinanceAttachmentRow, 'tenant_id' | 'attachment_id' | 'row_version'>>;

/** One rollup row of a rebuild. */
export type NewFinanceRollup = Omit<FinanceRollupRow, 'tenant_id' | 'row_version'> & Partial<Pick<FinanceRollupRow, 'tenant_id' | 'row_version'>>;

/** Domain writes of schema `finance`; each runs in the caller's open tenant transaction and returns the stored row. */
export interface FinanceWrites {
  /** Inserts a record. */
  insertRecord(tx: TenantTx, row: NewFinanceRecord, ctx?: WriteContext): Promise<FinanceRecordRow>;
  /** Sets `changes` and the next `row_version` on `current`, which the caller read FOR UPDATE; throws RepositoryError when it is gone. */
  updateRecord(tx: TenantTx, current: FinanceRecordRow, changes: FinanceRecordChanges, ctx?: WriteContext): Promise<FinanceRecordRow>;
  /** Inserts a version row. */
  insertVersion(tx: TenantTx, row: NewFinanceRecordVersion, ctx?: WriteContext): Promise<FinanceRecordVersionRow>;
  /** Inserts an attachment row. */
  insertAttachment(tx: TenantTx, row: NewFinanceAttachment, ctx?: WriteContext): Promise<FinanceAttachmentRow>;
  /** Deletes every rollup row of the tenant, then inserts `rows` in order, as `usp_finance_rollup` rebuilds its table. */
  replaceRollups(tx: TenantTx, rows: readonly NewFinanceRollup[], ctx?: WriteContext): Promise<FinanceRollupRow[]>;
}

/** The platform repository of schema `finance` with its database handle, attachment storage and domain writes. */
export type FinanceRepository = Repository & FinanceWrites & { readonly db: TenantDb; readonly storage: StoragePort };

/** Settings of `createFinanceRepository`; `clock` defaults to the system clock. */
export interface FinanceRepositoryOptions {
  db: TenantDb;
  storage: StoragePort;
  clock?: Clock;
}

/** An attachment's verified legacy bytes, stored once its row is written. */
interface StagedObject {
  key: string;
  bytes: Buffer;
  contentType: string;
}

/** An apply row ready for the platform repository, with the object it carried. */
interface StagedWrite {
  row: RepositoryRow;
  object?: StagedObject;
}

type RollupKey = Pick<FinanceRollupRow, 'legacy_program_id' | 'period' | 'state'>;

const APPLY: ReadonlySet<string> = new Set(APPLY_ORIGINS);
const SITE_COLUMN = 'siteid';
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

/** `<tenantId>:<programId>` pairs already bound, per apply transaction. */
const boundPrograms = new WeakMap<TenantTx, Set<string>>();

/** True for the writes of `POST /internal/v1/migration/apply`. */
function isApply(ctx: WriteContext): boolean {
  return ctx.origin !== undefined && APPLY.has(ctx.origin);
}

/** The non-empty text `column` of an attachment apply row; throws RepositoryError otherwise. */
function requiredText(row: RepositoryRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string' || value === '') {
    throw new RepositoryError(`apply row carrying ${ATTACHMENT_CONTENT_FIELD} has no ${column}`, FINANCE_ATTACHMENT.table);
  }
  return value;
}

/**
 * Takes the legacy bytes off an attachment apply row after checking them against its `sha256`, and points the row at their object;
 * `located` is the row plus, for an update, its key. Rows of other tables, or without bytes, pass unchanged.
 */
function stageAttachment(tx: TenantTx, table: string, row: RepositoryRow, located: RepositoryRow): StagedWrite {
  const bytes = row[ATTACHMENT_CONTENT_FIELD];
  if (table !== FINANCE_ATTACHMENT.table || bytes === undefined) return { row };
  if (!Buffer.isBuffer(bytes)) throw new RepositoryError(`${ATTACHMENT_CONTENT_FIELD} must be bytes`, table);
  const attachmentId = requiredText(located, 'attachment_id');
  const actual = sha256Hex(bytes);
  if (actual !== located.sha256) {
    throw new RepositoryError(`attachment ${attachmentId} content has SHA-256 ${actual}, but its sha256 is ${String(located.sha256)}`, table);
  }
  const key = attachmentObjectKey(tx.tenantId, attachmentId, requiredText(located, 'file_name'));
  const stripped: RepositoryRow = { ...row, object_key: key, size_bytes: row.size_bytes ?? bytes.length };
  delete stripped[ATTACHMENT_CONTENT_FIELD];
  return { row: stripped, object: { key, bytes, contentType: requiredText(located, 'content_type') } };
}

/** Builds the finance repository over the platform repository of `OWNED_TABLES`; `src/app.ts` hands it to the migration handlers. */
export function createFinanceRepository({ db, storage, clock = systemClock }: FinanceRepositoryOptions): FinanceRepository {
  // The platform repository requires its schema to equal `tx.schema`: `finance` in the service, a throwaway name in tests.
  const base = createRepository({ owner: OWNER, schema: db.schema, tables: OWNED_TABLES, clock });

  /** Records the tenant's `Program_<id>` binding from an applied row, once per tenant and program per transaction; never gated or changelogged. */
  async function bindProgram(tx: TenantTx, stored: RepositoryRow): Promise<void> {
    const programId = stored[LEGACY_PROGRAM_ID_COLUMN];
    if (programId === undefined || programId === null) return;
    const marker = `${tx.tenantId}:${String(programId)}`;
    let bound = boundPrograms.get(tx);
    if (bound === undefined) {
      bound = new Set<string>();
      boundPrograms.set(tx, bound);
    }
    if (bound.has(marker)) return;
    const siteColumn = stored[SITE_COLUMN];
    const site = typeof siteColumn === 'string' && siteColumn !== '' ? siteColumn : await siteForTenant(tx, tx.tenantId);
    if (site === null) return;
    // `updated_at` is NOT NULL without a default.
    await tx.query(
      `INSERT INTO ${qualified(tx.schema, PROGRAM_BINDING.table)} (tenant_id, site_id, legacy_program_id, updated_at)` +
        ' VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [tx.tenantId, site, programId, clock.now()],
    );
    bound.add(marker);
  }

  /** Runs `write`, adding the attachment and program steps to migration applies; target writes reach `base` unchanged. */
  async function writeApplied<T>(
    tx: TenantTx,
    table: string,
    row: RepositoryRow,
    ctx: WriteContext,
    located: RepositoryRow,
    write: (row: RepositoryRow) => Promise<T>,
  ): Promise<T> {
    if (!isApply(ctx)) return write(row);
    const staged = stageAttachment(tx, table, row, located);
    const written = await write(staged.row);
    if (written === null) return written;
    await bindProgram(tx, written as RepositoryRow);
    // Stored only after the row is written, so a write the repository rejects stores nothing; the deterministic key
    // makes a repeated batch overwrite the same object.
    if (staged.object !== undefined) {
      await storage.put(ATTACHMENT_BUCKET, staged.object.key, staged.object.bytes, { contentType: staged.object.contentType });
    }
    return written;
  }

  function insert<R = RepositoryRow>(tx: TenantTx, table: string, row: RepositoryRow, ctx: WriteContext = {}): Promise<R> {
    return writeApplied(tx, table, row, ctx, row, (staged) => base.insert<R>(tx, table, staged, ctx));
  }

  function upsert<R = RepositoryRow>(tx: TenantTx, table: string, row: RepositoryRow, ctx: WriteContext = {}): Promise<R> {
    return writeApplied(tx, table, row, ctx, row, (staged) => base.upsert<R>(tx, table, staged, ctx));
  }

  function update<R = RepositoryRow>(
    tx: TenantTx,
    table: string,
    key: RepositoryRow,
    patch: RepositoryRow,
    ctx: WriteContext = {},
  ): Promise<R | null> {
    return writeApplied(tx, table, patch, ctx, { ...key, ...patch }, (staged) => base.update<R>(tx, table, key, staged, ctx));
  }

  function replaceOne<R = RepositoryRow>(
    tx: TenantTx,
    table: string,
    beforeContentRow: RepositoryRow,
    afterContentRow: RepositoryRow,
    ctx: WriteContext = {},
  ): Promise<R | null> {
    return writeApplied(tx, table, afterContentRow, ctx, afterContentRow, (staged) =>
      base.replaceOne<R>(tx, table, beforeContentRow, staged, ctx),
    );
  }

  function insertRecord(tx: TenantTx, row: NewFinanceRecord, ctx: WriteContext = {}): Promise<FinanceRecordRow> {
    const stored = { ...row, record_id: row.record_id ?? cfUuid(), row_version: row.row_version ?? '1' };
    return insert<FinanceRecordRow>(tx, FINANCE_RECORD.table, stored, ctx);
  }

  async function updateRecord(
    tx: TenantTx,
    current: FinanceRecordRow,
    changes: FinanceRecordChanges,
    ctx: WriteContext = {},
  ): Promise<FinanceRecordRow> {
    // pg returns int8 as a decimal string.
    const patch = { ...changes, row_version: String(BigInt(current.row_version) + 1n) };
    const updated = await update<FinanceRecordRow>(tx, FINANCE_RECORD.table, { record_id: current.record_id }, patch, ctx);
    if (updated === null) {
      throw new RepositoryError(`record ${current.record_id} does not exist`, FINANCE_RECORD.table);
    }
    return updated;
  }

  function insertVersion(tx: TenantTx, row: NewFinanceRecordVersion, ctx: WriteContext = {}): Promise<FinanceRecordVersionRow> {
    return insert<FinanceRecordVersionRow>(tx, FINANCE_RECORD_VERSION.table, { ...row, version_id: row.version_id ?? cfUuid() }, ctx);
  }

  function insertAttachment(tx: TenantTx, row: NewFinanceAttachment, ctx: WriteContext = {}): Promise<FinanceAttachmentRow> {
    return insert<FinanceAttachmentRow>(tx, FINANCE_ATTACHMENT.table, { ...row, attachment_id: row.attachment_id ?? cfUuid() }, ctx);
  }

  async function replaceRollups(tx: TenantTx, rows: readonly NewFinanceRollup[], ctx: WriteContext = {}): Promise<FinanceRollupRow[]> {
    // Serialises rebuilds of one tenant, as the procedure's TABLOCKX does, so two rebuilds never insert the same key.
    await tx.query(ADVISORY_LOCK_SQL, [`${tx.schema}.${FINANCE_ROLLUP.table}:rebuild:${tx.tenantId}`]);
    const stale = await base.read(tx, FINANCE_ROLLUP.unit, async () => {
      const { rows: keys } = await tx.query<RollupKey>(
        `SELECT legacy_program_id, period, state FROM ${qualified(tx.schema, FINANCE_ROLLUP.table)}` +
          ' WHERE tenant_id = $1 ORDER BY legacy_program_id, period COLLATE "C", state COLLATE "C"',
        [tx.tenantId],
      );
      return keys;
    });
    for (const key of stale) {
      await base.delete(tx, FINANCE_ROLLUP.table, key, ctx);
    }
    const stored: FinanceRollupRow[] = [];
    for (const row of rows) {
      stored.push(await insert<FinanceRollupRow>(tx, FINANCE_ROLLUP.table, row, ctx));
    }
    return stored;
  }

  const repository: FinanceRepository = {
    ...base,
    insert,
    update,
    upsert,
    replaceOne,
    db,
    storage,
    insertRecord,
    updateRecord,
    insertVersion,
    insertAttachment,
    replaceRollups,
  };
  return Object.freeze(repository satisfies MigrationHandlerOptions['repository']);
}
