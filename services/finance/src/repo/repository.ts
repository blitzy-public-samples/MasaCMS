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
  NON_UNIT_TABLES,
  OWNED_TABLES,
  OWNER,
  PROGRAM_BINDING,
  STAGED_OBJECT,
  attachmentObjectKey,
  type FinanceAttachmentRow,
  type FinanceRecordRow,
  type FinanceRecordVersionRow,
  type FinanceRollupRow,
  type StagedObjectRow,
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
  /** Takes the tenant's finance write lock until `tx` ends, as the fixture procedures take their program applock. */
  lockWrites(tx: TenantTx): Promise<void>;
}

/** The platform repository of schema `finance` with its database handle, attachment storage and domain writes. */
export type FinanceRepository = Repository & FinanceWrites & { readonly db: TenantDb; readonly storage: StoragePort };

/** Settings of `createFinanceRepository`; `clock` defaults to the system clock. */
export interface FinanceRepositoryOptions {
  db: TenantDb;
  /** Handle the staging ledger commits through: a TenantDb on `db`'s schema over a pool of its own, never the pool `db` uses. */
  stagingDb: TenantDb;
  storage: StoragePort;
  clock?: Clock;
}

/** An attachment's verified legacy bytes, stored under `key` once its row is written. */
interface StagedObject {
  key: string;
  bytes: Buffer;
  contentType: string;
  attachmentId: string;
  /** True when `key` is new to this write, so the ledger names it until the write commits. */
  fresh: boolean;
  /** The stored row's previous key, which this write replaces. */
  replaced?: string;
}

/** An apply row ready for the platform repository, with the object it carried. */
interface StagedWrite {
  row: RepositoryRow;
  object?: StagedObject;
}

type CurrentObject = Pick<FinanceAttachmentRow, 'object_key' | 'sha256' | 'content_type'>;

type RollupKey = Pick<FinanceRollupRow, 'legacy_program_id' | 'period' | 'state'>;

const APPLY: ReadonlySet<string> = new Set(APPLY_ORIGINS);
const SITE_COLUMN = 'siteid';
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const TRY_ADVISORY_LOCK_SQL = 'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked';

/** Ledger entries one collection transaction reads. */
const COLLECTION_BATCH = 100;

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

/** Advisory-lock name an apply holds on an object key it stages, until its transaction ends. */
function stagedObjectLock(schema: string, key: string): string {
  return `${schema}.${STAGED_OBJECT.table}:${key}`;
}

/**
 * Takes the legacy bytes off an attachment apply row after checking them against its `sha256`, and points the row at their object:
 * the stored row's key when its bytes and content type are unchanged, else a new version key. `located` is the row plus, for an update,
 * its key. Rows of other tables, or without bytes, pass unchanged.
 */
async function stageAttachment(tx: TenantTx, table: string, row: RepositoryRow, located: RepositoryRow): Promise<StagedWrite> {
  const bytes = row[ATTACHMENT_CONTENT_FIELD];
  if (table !== FINANCE_ATTACHMENT.table || bytes === undefined) return { row };
  if (!Buffer.isBuffer(bytes)) throw new RepositoryError(`${ATTACHMENT_CONTENT_FIELD} must be bytes`, table);
  const attachmentId = requiredText(located, 'attachment_id');
  const actual = sha256Hex(bytes);
  if (actual !== located.sha256) {
    throw new RepositoryError(`attachment ${attachmentId} content has SHA-256 ${actual}, but its sha256 is ${String(located.sha256)}`, table);
  }
  const fileName = requiredText(located, 'file_name');
  const contentType = requiredText(located, 'content_type');
  const { rows } = await tx.query<CurrentObject>(
    `SELECT object_key, sha256, content_type FROM ${qualified(tx.schema, table)} WHERE tenant_id = $1 AND attachment_id = $2 FOR UPDATE`,
    [tx.tenantId, attachmentId],
  );
  const current = rows[0];
  const unchanged = current !== undefined && current.sha256 === actual && current.content_type === contentType;
  const key = unchanged ? current.object_key : attachmentObjectKey(tx.tenantId, cfUuid(), fileName);
  const stripped: RepositoryRow = { ...row, object_key: key, size_bytes: row.size_bytes ?? bytes.length };
  delete stripped[ATTACHMENT_CONTENT_FIELD];
  const object: StagedObject = { key, bytes, contentType, attachmentId, fresh: !unchanged };
  if (current !== undefined && !unchanged) object.replaced = current.object_key;
  return { row: stripped, object };
}

/**
 * Collects the tenant's ledger entries that no open apply holds: deletes each entry's object unless an attachment row references it,
 * then the entry. Runs after every committed apply and serves start-up recovery; returns the number of entries removed.
 */
export async function collectStagedObjects(repository: FinanceRepository, tenantId: string, ctx: WriteContext = {}): Promise<number> {
  const { db, storage } = repository;
  let collected = 0;
  let after = '';
  for (;;) {
    const page = await db.withTenant(tenantId, async (tx) => {
      const { rows } = await tx.query<Pick<StagedObjectRow, 'object_key' | 'attachment_id'>>(
        `SELECT object_key, attachment_id FROM ${qualified(tx.schema, STAGED_OBJECT.table)}` +
          ' WHERE tenant_id = $1 AND object_key > $2 ORDER BY object_key LIMIT $3 FOR UPDATE SKIP LOCKED',
        [tx.tenantId, after, COLLECTION_BATCH],
      );
      for (const entry of rows) {
        const { rows: lock } = await tx.query<{ locked: boolean }>(TRY_ADVISORY_LOCK_SQL, [stagedObjectLock(tx.schema, entry.object_key)]);
        if (lock[0]?.locked !== true) continue;
        const { rows: referenced } = await tx.query(
          `SELECT 1 FROM ${qualified(tx.schema, FINANCE_ATTACHMENT.table)} WHERE tenant_id = $1 AND attachment_id = $2 AND object_key = $3`,
          [tx.tenantId, entry.attachment_id, entry.object_key],
        );
        if (referenced.length === 0) await storage.delete(ATTACHMENT_BUCKET, entry.object_key);
        await repository.delete(tx, STAGED_OBJECT.table, { object_key: entry.object_key }, ctx);
        collected += 1;
      }
      return rows;
    });
    const last = page.at(-1);
    if (last === undefined) return collected;
    after = last.object_key;
  }
}

/** Throws TypeError unless `stagingDb` is a handle of its own on `db`'s schema. */
function assertStagingDb(db: TenantDb, stagingDb: TenantDb): void {
  if (stagingDb === db) throw new TypeError('stagingDb must use a pool of its own, not the handle of db');
  if (stagingDb.schema !== db.schema) throw new TypeError(`stagingDb schema ${stagingDb.schema} differs from db schema ${db.schema}`);
}

/** Builds the finance repository over the platform repository of `OWNED_TABLES` and `NON_UNIT_TABLES`; `src/app.ts` hands it to the migration handlers. */
export function createFinanceRepository({ db, stagingDb, storage, clock = systemClock }: FinanceRepositoryOptions): FinanceRepository {
  assertStagingDb(db, stagingDb);
  // The platform repository requires its schema to equal `tx.schema`: `finance` in the service, a throwaway name in tests.
  const base = createRepository({ owner: OWNER, schema: db.schema, tables: [...OWNED_TABLES, ...NON_UNIT_TABLES], clock });
  const collecting = new WeakSet<TenantTx>();

  /**
   * Records the tenant's `Program_<id>` binding from an applied row with its changelog row, once per tenant and program per transaction;
   * the first program bound to a tenant stays, and a tenant without a known site is skipped.
   */
  async function bindProgram(tx: TenantTx, stored: RepositoryRow, ctx: WriteContext): Promise<void> {
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
    // Serialises the binding of one tenant, so a concurrent apply reads the binding the first one committed.
    await tx.query(ADVISORY_LOCK_SQL, [`${tx.schema}.${PROGRAM_BINDING.table}:${tx.tenantId}`]);
    const { rows } = await tx.query(`SELECT 1 FROM ${qualified(tx.schema, PROGRAM_BINDING.table)} WHERE tenant_id = $1`, [tx.tenantId]);
    if (rows.length === 0) {
      await base.insert(tx, PROGRAM_BINDING.table, { site_id: site, legacy_program_id: programId, updated_at: clock.now() }, ctx);
    }
    bound.add(marker);
  }

  /** Queues one collection of the tenant's ledger for after `tx` commits. */
  function collectAfterCommit(tx: TenantTx, ctx: WriteContext): void {
    if (collecting.has(tx)) return;
    collecting.add(tx);
    const { tenantId } = tx;
    tx.onCommit(async () => {
      await collectStagedObjects(repository, tenantId, ctx);
    });
  }

  /**
   * Stores the bytes of a written attachment row: a new key is locked for the rest of `tx` and recorded `staged` in its own committed
   * `stagingDb` transaction before the bytes are stored, then `tx` drops that entry and records the replaced key `superseded`.
   */
  async function storeObject(tx: TenantTx, object: StagedObject, ctx: WriteContext): Promise<void> {
    const entry = { object_key: object.key, attachment_id: object.attachmentId, recorded_at: clock.now() };
    if (object.fresh) {
      await tx.query(ADVISORY_LOCK_SQL, [stagedObjectLock(tx.schema, object.key)]);
      // Only a fresh key and its changelog row, under no unit gate, so it never waits on a lock an apply holds and one staging connection drains.
      await stagingDb.withTenant(tx.tenantId, (ledger) => base.insert(ledger, STAGED_OBJECT.table, { ...entry, state: 'staged' }, ctx));
    }
    await storage.put(ATTACHMENT_BUCKET, object.key, object.bytes, { contentType: object.contentType });
    if (object.fresh) await base.delete(tx, STAGED_OBJECT.table, { object_key: object.key }, ctx);
    if (object.replaced !== undefined) {
      await base.upsert(tx, STAGED_OBJECT.table, { ...entry, object_key: object.replaced, state: 'superseded' }, ctx);
    }
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
    collectAfterCommit(tx, ctx);
    const staged = await stageAttachment(tx, table, row, located);
    const written = await write(staged.row);
    if (written === null) return written;
    await bindProgram(tx, written as RepositoryRow, ctx);
    // Stored only after the row is written, so a write the repository rejects stores and stages nothing.
    if (staged.object !== undefined) await storeObject(tx, staged.object, ctx);
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

  async function lockWrites(tx: TenantTx): Promise<void> {
    await tx.query(ADVISORY_LOCK_SQL, [`${tx.schema}:writes:${tx.tenantId}`]);
  }

  async function replaceRollups(tx: TenantTx, rows: readonly NewFinanceRollup[], ctx: WriteContext = {}): Promise<FinanceRollupRow[]> {
    // Serialises rebuilds with the tenant's other writes, as the procedure's applock does, so two rebuilds never insert the same key.
    await lockWrites(tx);
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
    lockWrites,
  };
  return Object.freeze(repository satisfies MigrationHandlerOptions['repository']);
}
