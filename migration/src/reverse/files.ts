/** Reverse projection of strategies-content `content.file_object` changes onto the legacy `fileDir` store. */
import { createHash } from 'node:crypto';

import { compareXid, decodeRow, formatCursor, type CanonicalColumn, type ChangeRow } from '@opt2/platform/migration-kit';

import { ownerBySchema } from '../config.js';
import type { MigrationContext } from '../context.js';
import { InvalidStoredNameError, formatStoredName, parseObjectKey, storePath } from '../files/index.js';
import { OwnerCallError } from '../owners/index.js';

import { readHorizon } from './operations.js';

// Named as `opt2/table-ownership.json` lists the table among its new tables; it is not a catalog unit, since no
// cut-over group gates the manifest of `content-files`.
/** Id of strategies-content's stored-object manifest, `<schema>.<table>`. */
export const FILE_OBJECT_UNIT = 'content.file_object';

/** `table` of the manifest's changelog rows: the repository table name. */
const FILE_OBJECT_TABLE = 'file_object';

/** PostgreSQL schema of the manifest's owner. */
const FILE_OBJECT_SCHEMA = FILE_OBJECT_UNIT.slice(0, FILE_OBJECT_UNIT.indexOf('.'));

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
  /** Cursor of the change the put comes from; changes after it are read for the key's later state. */
  cursor: string;
}

/** Size and SHA-256 of one stored object. */
type ObjectState = Pick<FilePutOp, 'size' | 'sha256'>;

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

/** Batch summary: files written, files the bridge removed, bytes written, and puts a later change of their key superseded. */
export interface FileOpsResult {
  put: number;
  deleted: number;
  bytes: number;
  superseded: number;
}

/** Dependencies of {@link executeFileOps}; `signal` stops reading a key's later state before its next page. */
export type FileOpsDeps = Pick<MigrationContext, 'bridge' | 'owners' | 'logger' | 'config'> & { signal?: AbortSignal };

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

/**
 * The owner's bytes of an object differ in size or SHA-256 from its change row, so the bridge kept none that differ.
 * `exceeded` is true when reading stopped at the first chunk beyond the row's size; `actual` then covers the bytes read.
 */
export class FileObjectMismatchError extends Error {
  override readonly name = 'FileObjectMismatchError';

  constructor(
    readonly key: string,
    readonly expected: { size: number; sha256: string },
    readonly actual: { size: number; sha256: string },
    readonly exceeded = false,
  ) {
    super(
      exceeded
        ? `File object ${key} exceeded the change row's ${String(expected.size)} bytes: ${String(actual.size)} bytes were read`
        : `File object ${key} has ${String(actual.size)} bytes hashing to ${actual.sha256}, ` +
            `not the change row's ${String(expected.size)} bytes hashing to ${expected.sha256}`,
    );
  }
}

/** True for a changelog row of `content.file_object`; `unit` is the row's owner schema and table, `<schema>.<table>`. */
export function isFileObjectChange(row: Pick<ChangeRow, 'table'>, unit: string): boolean {
  return unit === FILE_OBJECT_UNIT && row.table === FILE_OBJECT_TABLE;
}

/** The stored object one image of a change describes, placed in its tenant's legacy site. */
function storedObjectOf(
  row: ChangeRow,
  image: 'before' | 'after',
  tenantSites: ReadonlyMap<string, string>,
): Omit<FilePutOp, 'kind' | 'cursor'> {
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
 * File-store operations of `content.file_object` changes: a put for an insert or update, a delete for a delete, and a
 * delete of the old name when an update changes the key. Only the last operation of each key is kept, in row order,
 * since it decides the key's final state and distinct keys are distinct legacy names.
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
    if (after !== undefined) ops.push({ kind: 'put', ...after, cursor: formatCursor({ xid: BigInt(row.xid), seq: BigInt(row.seq) }) });
  }
  const last = new Map(ops.map((op, index) => [op.key, index] as const));
  return ops.filter((op, index) => last.get(op.key) === index);
}

/**
 * Count and SHA-256 of one object stream, pulled through one held iterator: the bridge body and the final drain share
 * its read position, and closing the body leaves the stream open.
 */
class ObjectRead {
  size = 0;
  /** Set once the stream ended or overran `limit`. */
  sha256: string | undefined;
  exceeded = false;
  readonly #chunks: AsyncIterator<Uint8Array>;
  readonly #hash = createHash('sha256');
  #pending: Promise<Uint8Array | undefined> | undefined;

  constructor(
    source: AsyncIterable<Uint8Array>,
    readonly limit: number,
  ) {
    this.#chunks = source[Symbol.asyncIterator]();
  }

  /** The next chunk within `limit`, or undefined once the stream ended or overran it; concurrent callers share one read. */
  next(): Promise<Uint8Array | undefined> {
    this.#pending ??= this.#read().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #read(): Promise<Uint8Array | undefined> {
    if (this.sha256 !== undefined) return undefined;
    const chunk = await this.#chunks.next();
    if (chunk.done !== true) {
      this.#hash.update(chunk.value);
      this.size += chunk.value.byteLength;
      if (this.size <= this.limit) return chunk.value;
      this.exceeded = true;
    }
    this.sha256 = this.#hash.digest('hex');
    return undefined;
  }

  /** Bridge body: the chunks within `limit`; fails at the first chunk beyond it, without passing it on. */
  async *body(): AsyncGenerator<Uint8Array, void, undefined> {
    for (let chunk = await this.next(); chunk !== undefined; chunk = await this.next()) yield chunk;
    if (this.exceeded) throw new RangeError(`File object stream exceeded ${String(this.limit)} bytes`);
  }

  /** Reads on to the stream's end, or to its first chunk beyond `limit`. */
  async drain(): Promise<void> {
    while (this.sha256 === undefined) await this.next();
  }
}

/**
 * Streams the current object of `op.key` from strategies-content into the legacy store, sending `op.size` bytes, and
 * reads the object to its end before succeeding. The bridge refuses a body not hashing to `op.sha256`.
 * @throws FileObjectMismatchError when the object's size or SHA-256 differs from `op`'s, else the read's or the bridge's failure.
 */
async function putObject(deps: Pick<FileOpsDeps, 'bridge' | 'owners'>, op: FilePutOp): Promise<void> {
  // The owner's migration object read: its export manifest carries no signed URL, and its signed downloads need a user token.
  const source = await deps.owners.getObject(op.key);
  try {
    const read = new ObjectRead(source, op.size);
    const failure = await deps.bridge.filesPut(op.siteId, op.name, read.body(), op.sha256, { size: op.size }).then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    // Once the bridge has every byte sent, the rest of the stream decides between a match and a mismatch.
    if (failure === undefined || read.size === op.size) await read.drain();
    if (read.sha256 !== undefined && (read.exceeded || read.size !== op.size || read.sha256 !== op.sha256)) {
      const expected = { size: op.size, sha256: op.sha256 };
      throw new FileObjectMismatchError(op.key, expected, { size: read.size, sha256: read.sha256 }, read.exceeded);
    }
    if (failure !== undefined) throw failure.error;
  } finally {
    source.destroy();
  }
}

/** The size and SHA-256 an image records for the stored object `key`, or undefined when the image is of another key or absent. */
function imageStateOf(image: string | null, key: string): ObjectState | undefined {
  if (image === null) return undefined;
  const values = decodeRow(FILE_OBJECT_COLUMNS, image);
  return values.object_key === key ? { size: Number(values.size), sha256: values.sha256 as string } : undefined;
}

/** True when a put failed because the owner's object is no longer the one it was checked against. */
function isReplaced(error: unknown): boolean {
  return error instanceof FileObjectMismatchError || (error instanceof OwnerCallError && error.status === 404);
}

/** A key's state after the later changes read; `decided` when reading reached a complete page or its first read's horizon. */
interface LaterState {
  /** The last-committed touching change's object; null when it removed the key; undefined when no change read touches it. */
  state: ObjectState | null | undefined;
  decided: boolean;
}

/**
 * State of the put's key after the last-committed later change touching it, read after the put's own change in at most
 * `projection.streamPagesPerCycle` pages, none once `signal` aborts, up to a complete page or the first read's horizon.
 */
async function laterState(deps: Pick<FileOpsDeps, 'owners' | 'config' | 'signal'>, op: FilePutOp): Promise<LaterState> {
  const owner = ownerBySchema(deps.config, FILE_OBJECT_SCHEMA).name;
  const { batchRows: limit, streamPagesPerCycle } = deps.config.projection;
  let state: ObjectState | null | undefined;
  let frontier: string | undefined;
  // Seq, not the cursor's (xid, seq), is the commit order of one key's changes.
  let latest = -1n;
  let after = op.cursor;
  for (let pages = 0; pages < streamPagesPerCycle && deps.signal?.aborted !== true; pages += 1) {
    const page = await deps.owners.changes(owner, { tenantId: op.tenantId, after, limit });
    frontier ??= page.horizon;
    for (const row of page.rows) {
      if (row.table !== FILE_OBJECT_TABLE || BigInt(row.seq) < latest) continue;
      const written = imageStateOf(row.after, op.key);
      const touched = written ?? (imageStateOf(row.before, op.key) === undefined ? undefined : null);
      if (touched === undefined) continue;
      state = touched;
      latest = BigInt(row.seq);
    }
    if (page.complete || compareXid(readHorizon(page), frontier) >= 0) return { state, decided: true };
    after = page.cursor;
  }
  return { state, decided: false };
}

/** Puts the later object `state`; false, writing nothing, when none was read or an undecided `state` is not the current object. */
async function putLaterState(
  deps: Pick<FileOpsDeps, 'bridge' | 'owners'>,
  op: FilePutOp,
  state: ObjectState | undefined,
  decided: boolean,
): Promise<boolean> {
  if (state === undefined) return false;
  try {
    await putObject(deps, { ...op, ...state });
    return true;
  } catch (error) {
    if (decided || !isReplaced(error)) throw error;
    return false;
  }
}

/**
 * Applies the operations in order through the legacy bridge, idempotently; a put whose object a later change replaced or
 * removed applies the key's later state, and is skipped, for a later batch to project, while that state is undecided.
 * @throws FileObjectMismatchError or OwnerCallError when an object matches neither its change row nor the key's decided
 *   later state; UnsupportedFileStoreError when the legacy store is not `fileDir`.
 */
export async function executeFileOps(deps: FileOpsDeps, ops: readonly FileOp[]): Promise<FileOpsResult> {
  const result: FileOpsResult = { put: 0, deleted: 0, bytes: 0, superseded: 0 };
  for (const op of ops) {
    const path = storePath(op.siteId, op.name);
    if (op.kind === 'delete') {
      const { deleted } = await deps.bridge.filesDelete(op.siteId, { name: op.name });
      result.deleted += deleted.length;
      deps.logger.info({ tenantId: op.tenantId }, `Projected delete of legacy file ${path}: ${String(deleted.length)} removed`);
      continue;
    }
    let later: LaterState | undefined;
    try {
      await putObject(deps, op);
    } catch (error) {
      later = isReplaced(error) ? await laterState(deps, op) : undefined;
      if (later === undefined || (later.decided && later.state === undefined)) throw error;
    }
    if (later?.state === null) {
      const { deleted } = await deps.bridge.filesDelete(op.siteId, { name: op.name });
      result.superseded += 1;
      result.deleted += deleted.length;
      deps.logger.info(
        { tenantId: op.tenantId },
        `Projected delete of legacy file ${path}: a later change removed ${op.key}; ${String(deleted.length)} removed`,
      );
      continue;
    }
    if (later !== undefined) {
      result.superseded += 1;
      if (!(await putLaterState(deps, op, later.state, later.decided))) {
        deps.logger.info({ tenantId: op.tenantId }, `Skipped legacy file ${path} from ${op.key}: a later change of the key projects it`);
        continue;
      }
    }
    const size = later?.state?.size ?? op.size;
    result.put += 1;
    result.bytes += size;
    deps.logger.info(
      { tenantId: op.tenantId },
      later === undefined
        ? `Projected legacy file ${path} from ${op.key}: ${String(size)} bytes`
        : `Projected legacy file ${path} from ${op.key} as a later change recorded it: ${String(size)} bytes`,
    );
  }
  return result;
}
