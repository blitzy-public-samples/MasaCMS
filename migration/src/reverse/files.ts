/** Reverse projection of strategies-content `content.file_object` changes onto the legacy `fileDir` store. */
import { decodeRow, sha256Hex, type CanonicalColumn, type ChangeRow } from '@opt2/platform/migration-kit';

import type { MigrationContext } from '../context.js';
import { InvalidStoredNameError, formatStoredName, parseObjectKey, storePath } from '../files/index.js';

// Named as `opt2/table-ownership.json` lists the table among its new tables; it is not a catalog unit, since no
// cut-over group gates the manifest of `content-files`.
/** Id of strategies-content's stored-object manifest, `<schema>.<table>`. */
export const FILE_OBJECT_UNIT = 'content.file_object';

/** `table` of the manifest's changelog rows: the repository table name. */
const FILE_OBJECT_TABLE = 'file_object';

// Catalog order of content.file_object, which is the column order of its changelog before- and after-images.
const FILE_OBJECT_COLUMNS: readonly CanonicalColumn[] = [
  { name: 'tenant_id', type: 's' },
  { name: 'file_id', type: 's' },
  { name: 'variant', type: 's' },
  { name: 'ext', type: 's' },
  { name: 'object_key', type: 's' },
  { name: 'size', type: 'i' },
  { name: 'sha256', type: 's' },
  { name: 'content_type', type: 's' },
  { name: 'orphan', type: 'i' },
  { name: 'created_at', type: 't' },
];

/** Write of one stored object to `<siteId>/cache/file/<name>`, checked against the size and SHA-256 its change recorded. */
export interface FilePutOp {
  kind: 'put';
  tenantId: string;
  siteId: string;
  /** `content-files` key `<tenantId>/<name>`. */
  key: string;
  /** Legacy stored name `<fileID><variant>.<ext>`. */
  name: string;
  size: number;
  /** Lowercase hex. */
  sha256: string;
}

/** Removal of one legacy stored file by its exact name. */
export interface FileDeleteOp {
  kind: 'delete';
  tenantId: string;
  siteId: string;
  key: string;
  name: string;
}

/** One legacy file-store operation of a projected batch. */
export type FileOp = FilePutOp | FileDeleteOp;

/** Batch summary: files written, files the bridge removed and bytes written. */
export interface FileOpsResult {
  put: number;
  deleted: number;
  bytes: number;
}

/** No legacy site is known for the tenant of a file object, so its legacy directory cannot be chosen. */
export class UnknownFileTenantError extends Error {
  override readonly name = 'UnknownFileTenantError';

  constructor(
    readonly tenantId: string,
    readonly key: string,
  ) {
    super(`No legacy site is known for tenant ${tenantId} of file object ${key}`);
  }
}

/** The owner's bytes of an object differ in size or SHA-256 from its change row; nothing was written for it. */
export class FileObjectMismatchError extends Error {
  override readonly name = 'FileObjectMismatchError';

  constructor(
    readonly key: string,
    readonly expected: { size: number; sha256: string },
    readonly actual: { size: number; sha256: string },
  ) {
    super(
      `File object ${key} has ${String(actual.size)} bytes hashing to ${actual.sha256}, ` +
        `not the change row's ${String(expected.size)} bytes hashing to ${expected.sha256}`,
    );
  }
}

/** True for a changelog row of `content.file_object`; `unit` is the row's owner schema and table, `<schema>.<table>`. */
export function isFileObjectChange(row: Pick<ChangeRow, 'table'>, unit: string): boolean {
  return unit === FILE_OBJECT_UNIT && row.table === FILE_OBJECT_TABLE;
}

/** The stored object one image of a change describes, placed in its tenant's legacy site. */
function storedObjectOf(row: ChangeRow, image: 'before' | 'after', tenantSites: ReadonlyMap<string, string>): Omit<FilePutOp, 'kind'> {
  const encoding = row[image];
  if (encoding === null) throw new TypeError(`${row.op} change ${row.xid}:${row.seq} of ${row.table} has no ${image} image`);
  const values = decodeRow(FILE_OBJECT_COLUMNS, encoding);
  // object_key, size and sha256 are NOT NULL columns, so their decoded values are strings.
  const key = values.object_key as string;
  const parts = parseObjectKey(key);
  if (parts === null) throw new InvalidStoredNameError(key);
  const siteId = tenantSites.get(parts.tenantId);
  if (siteId === undefined) throw new UnknownFileTenantError(parts.tenantId, key);
  return {
    tenantId: parts.tenantId,
    siteId,
    key,
    name: formatStoredName(parts),
    size: Number(values.size as string),
    sha256: values.sha256 as string,
  };
}

/**
 * File-store operations of `content.file_object` changes, in row order: a put for an insert or update, a delete for a
 * delete, and a delete of the old name before the put when an update changes the key.
 * @param tenantSites legacy site of each tenant, the inverse of `tenantIdForSite` over the live `tsettings` site ids.
 * @throws UnknownFileTenantError for a tenant without a site; InvalidStoredNameError for a malformed key.
 */
export function planFileOps(rows: readonly ChangeRow[], tenantSites: ReadonlyMap<string, string>): FileOp[] {
  const ops: FileOp[] = [];
  for (const row of rows) {
    const before = row.op === 'insert' ? undefined : storedObjectOf(row, 'before', tenantSites);
    const after = row.op === 'delete' ? undefined : storedObjectOf(row, 'after', tenantSites);
    if (before !== undefined && before.key !== after?.key) {
      const { tenantId, siteId, key, name } = before;
      ops.push({ kind: 'delete', tenantId, siteId, key, name });
    }
    if (after !== undefined) ops.push({ kind: 'put', ...after });
  }
  return ops;
}

/**
 * Applies the operations in order through the legacy bridge, reading each put's bytes from strategies-content.
 * Every operation is idempotent, so a batch interrupted part-way is safe to run again.
 * @throws FileObjectMismatchError when an object's bytes differ from its change row; UnsupportedFileStoreError when the
 *   legacy store is not `fileDir`.
 */
export async function executeFileOps(
  deps: Pick<MigrationContext, 'bridge' | 'owners' | 'logger'>,
  ops: readonly FileOp[],
): Promise<FileOpsResult> {
  const result: FileOpsResult = { put: 0, deleted: 0, bytes: 0 };
  for (const op of ops) {
    const path = storePath(op.siteId, op.name);
    if (op.kind === 'delete') {
      const { deleted } = await deps.bridge.filesDelete(op.siteId, { name: op.name });
      result.deleted += deleted.length;
      deps.logger.info({ tenantId: op.tenantId }, `Projected delete of legacy file ${path}: ${String(deleted.length)} removed`);
      continue;
    }
    // The owner's migration object read: its export manifest carries no signed URL, and its signed downloads need a user token.
    const bytes = await deps.owners.getObject(op.key);
    const sha256 = sha256Hex(bytes);
    if (bytes.byteLength !== op.size || sha256 !== op.sha256) {
      throw new FileObjectMismatchError(op.key, { size: op.size, sha256: op.sha256 }, { size: bytes.byteLength, sha256 });
    }
    await deps.bridge.filesPut(op.siteId, op.name, bytes, sha256);
    result.put += 1;
    result.bytes += bytes.byteLength;
    deps.logger.info({ tenantId: op.tenantId }, `Projected legacy file ${path} from ${op.key}: ${String(bytes.byteLength)} bytes`);
  }
  return result;
}
