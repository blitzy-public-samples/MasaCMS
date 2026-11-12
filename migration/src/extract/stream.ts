/** Row extractor: streams one SQL Server table as canonical rows, keyed tables in key order and keyless tables in encoding order. */
import { Buffer } from 'node:buffer';
import { mkdtemp, open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectionPool, Request } from 'mssql';

import { compareEncodings, decodeRow, encodeKey, encodeRow } from '@opt2/platform/migration-kit';
import type { CanonicalValue } from '@opt2/platform/migration-kit';

import { quoteIdent, type LegacyDb } from '../legacy/legacy-db.js';
import { CatalogError, findColumn, readTableCatalog, type CatalogColumn, type LegacyTableRef, type TableCatalog } from './catalog.js';
import { bindScope, buildScopeFilter, type ExtractScope, type ScopeFilter } from './scope.js';

/** Bytes of row encodings a keyless stream sorts in memory before spilling the run to disk. */
export const DEFAULT_SORT_RUN_BYTES = 64 * 1024 * 1024;

/** Buffered rows at which the SQL request is paused; it resumes once half of them are consumed. */
export const DEFAULT_HIGH_WATER_MARK = 256;

const BINARY_COLLATION = 'Latin1_General_BIN2';
const SPILL_PREFIX = 'opt2-extract-';
const WRITE_BATCH_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const COMPACT_AT = 4096;
const LABEL_LIMIT = 120;
const LIVE_DATABASE = '(live)';
const NO_KEY_VALUES: readonly KeyValue[] = Object.freeze([]);

/** A key column value as the driver returns it after normalisation: bit as 0/1, bigint as bigint, datetime as Date. */
export type KeyValue = CanonicalValue | number | bigint | Date;

/**
 * One extracted row. `key` is the encoded key, or the whole-row `encoding` for keyless tables; `keyValues` are the key
 * values in key order (empty for keyless tables); `row` maps every selected column to its canonical value text.
 */
export interface CanonicalRow {
  table: string;
  legacyProgramId?: number;
  key: string;
  keyValues: readonly KeyValue[];
  encoding: string;
  row: Readonly<Record<string, CanonicalValue>>;
}

/** What to extract; `database` undefined reads the live legacy database, otherwise the named one (e.g. a snapshot). */
export interface StreamOptions {
  legacy: Pick<LegacyDb, 'live' | 'database'>;
  database?: string;
  table: string | LegacyTableRef;
  /** Key order of a keyed table; absent or empty uses the live primary key, ignored for keyless tables. */
  keyColumns?: readonly string[];
  scope?: ExtractScope;
  /** Encoded columns; absent or empty encodes every column. Key columns are read either way. */
  columns?: readonly string[];
  /** `CanonicalRow.table`; defaults to the table's qualified name. */
  label?: string;
  sortRunBytes?: number;
  /** Parent of the keyless spill directory; defaults to the OS temporary directory. */
  spillDir?: string;
  highWaterMark?: number;
}

/** The resolved read of one stream; `columns` are the encoded columns in catalog order. */
export interface StreamShape {
  database: string;
  table: string;
  catalog: TableCatalog;
  keyed: boolean;
  keyColumns: readonly string[];
  columns: readonly CatalogColumn[];
  selectSql: string;
  scope: ScopeFilter;
}

/** Reading `table` of `database` failed; `cause` is the driver error when there is one. */
export class ExtractError extends Error {
  readonly database: string;
  readonly table: string;

  constructor(message: string, details: { database: string; table: string; cause?: unknown }) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ExtractError';
    this.database = details.database;
    this.table = details.table;
  }
}

/** A keyed stream yielded a row whose key sorts before the previous row's; `previous` and `current` are the encoded keys. */
export class ExtractOrderError extends ExtractError {
  readonly previous: string;
  readonly current: string;

  constructor(details: { database: string; table: string; previous: string; current: string }) {
    super(
      `rows of ${details.table} in database ${details.database} are out of key order: ${clip(details.current)} after ${clip(details.previous)}`,
      details,
    );
    this.name = 'ExtractOrderError';
    this.previous = details.previous;
    this.current = details.current;
  }
}

function clip(text: string): string {
  return text.length <= LABEL_LIMIT ? text : `${text.slice(0, LABEL_LIMIT)}…`;
}

interface StreamPlan {
  pool: ConnectionPool;
  shape: StreamShape;
  selectColumns: readonly CatalogColumn[];
}

function tableName(table: string | LegacyTableRef): string {
  return typeof table === 'string' ? table : table.qualified;
}

function resolveNames(catalog: TableCatalog, names: readonly string[], role: string): string[] {
  return names.map((name) => {
    const column = findColumn(catalog, name);
    if (column === undefined) {
      throw new ExtractError(`${role} column ${name} is not a column of ${catalog.qualified}`, { database: catalog.database, table: catalog.qualified });
    }
    return column.name;
  });
}

// The driver would read decimal and money as JS doubles; CONVERT carries their exact fixed-scale digits (style 2: four decimals for money).
function decimalText(column: CatalogColumn): string {
  const name = quoteIdent(column.name);
  return column.sqlType === 'money' || column.sqlType === 'smallmoney' ? `CONVERT(varchar(64), ${name}, 2)` : `CONVERT(varchar(64), ${name})`;
}

function selectExpression(column: CatalogColumn): string {
  const name = quoteIdent(column.name);
  switch (column.sqlType) {
    case 'text':
    case 'ntext':
      return `CAST(${name} AS nvarchar(max)) AS ${name}`;
    case 'image':
      return `CAST(${name} AS varbinary(max)) AS ${name}`;
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
      return `${decimalText(column)} AS ${name}`;
    default:
      return name;
  }
}

// A binary collation orders text by code point whatever the database collation, as compareKeyValues does in Node.
function orderExpression(column: CatalogColumn): string {
  const name = quoteIdent(column.name);
  switch (column.sqlType) {
    case 'char':
    case 'varchar':
    case 'nchar':
    case 'nvarchar':
      return `${name} COLLATE ${BINARY_COLLATION}`;
    case 'uniqueidentifier':
      return `CONVERT(char(36), ${name}) COLLATE ${BINARY_COLLATION}`;
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
      // Ordered as the text the driver returns, so the SQL order is the string order of the key values.
      return `${decimalText(column)} COLLATE ${BINARY_COLLATION}`;
    default:
      return name;
  }
}

function selectSql(catalog: TableCatalog, selectColumns: readonly CatalogColumn[], keyColumns: readonly string[], scope: ScopeFilter): string {
  const byName = new Map(catalog.columns.map((column) => [column.name, column]));
  const order = keyColumns
    .map((name) => `${orderExpression(byName.get(name) as CatalogColumn)} ASC`)
    .join(', ');
  return `SELECT ${selectColumns.map(selectExpression).join(', ')} FROM ${quoteIdent(catalog.schema)}.${quoteIdent(catalog.table)}${scope.whereSql}${order === '' ? '' : ` ORDER BY ${order}`}`;
}

async function planStream(options: StreamOptions): Promise<StreamPlan> {
  let pool: ConnectionPool;
  let catalog: TableCatalog;
  try {
    pool = await (options.database === undefined ? options.legacy.live() : options.legacy.database(options.database));
    catalog = await readTableCatalog(pool, options.table);
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    const table = tableName(options.table);
    throw new ExtractError(`cannot read the catalog of ${table}`, { database: options.database ?? LIVE_DATABASE, table, cause: error });
  }

  const keyed = catalog.hasPrimaryKey;
  const keyColumns = !keyed
    ? []
    : options.keyColumns !== undefined && options.keyColumns.length > 0
      ? resolveNames(catalog, options.keyColumns, 'key')
      : catalog.primaryKey;
  const encoded = options.columns !== undefined && options.columns.length > 0 ? new Set(resolveNames(catalog, options.columns, 'requested')) : undefined;
  const keySet = new Set(keyColumns);
  const columns = encoded === undefined ? catalog.columns : catalog.columns.filter((column) => encoded.has(column.name));
  const selectColumns = encoded === undefined ? catalog.columns : catalog.columns.filter((column) => encoded.has(column.name) || keySet.has(column.name));
  const scope = buildScopeFilter(catalog.columns, options.scope);
  const shape: StreamShape = Object.freeze({
    database: catalog.database,
    table: options.label ?? catalog.qualified,
    catalog,
    keyed,
    keyColumns: Object.freeze([...keyColumns]),
    columns: Object.freeze([...columns]),
    selectSql: selectSql(catalog, selectColumns, keyColumns, scope),
    scope,
  });
  return { pool, shape, selectColumns: Object.freeze([...selectColumns]) };
}

/** Resolves the catalog, columns, key and SELECT of a stream without reading rows. */
export async function describeStream(options: StreamOptions): Promise<StreamShape> {
  return (await planStream(options)).shape;
}

type DriverRow = Readonly<Record<string, unknown>>;

/** Adapts driver values to the forms encodeValue and compareKeyValues take: bit as 0/1, bigint text as bigint. */
function normaliseValue(column: CatalogColumn, value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && column.sqlType === 'bigint') return BigInt(value);
  return value;
}

function normaliseRow(columns: readonly CatalogColumn[], raw: DriverRow): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const column of columns) values[column.name] = normaliseValue(column, raw[column.name]);
  return values;
}

function isCancellation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ECANCEL';
}

/** Rows of one streaming request, buffered with back-pressure; the first driver error is thrown from `next`. */
class RequestRows {
  private rows: (DriverRow | undefined)[] = [];
  private head = 0;
  private paused = false;
  private held = false;
  private finished = false;
  private cancelled = false;
  private failure: ExtractError | undefined;
  private reported = false;
  private wake: (() => void) | undefined;
  private signalEnded!: () => void;
  private readonly ended = new Promise<void>((resolve) => {
    this.signalEnded = resolve;
  });

  constructor(
    private readonly request: Request,
    private readonly highWaterMark: number,
    private readonly wrap: (error: unknown) => ExtractError,
  ) {
    request.stream = true;
    request.on('row', (row: DriverRow) => this.push(row));
    request.on('error', (error: unknown) => this.fail(error));
    request.on('done', () => this.finish());
  }

  start(text: string): void {
    void this.request.query(text).then(
      () => this.finish(),
      (error: unknown) => {
        this.fail(error);
        this.finish();
      },
    );
  }

  /** The next row, or undefined once the request is done. */
  async next(): Promise<DriverRow | undefined> {
    for (;;) {
      if (this.failure !== undefined) {
        this.reported = true;
        throw this.failure;
      }
      if (this.head < this.rows.length) {
        const row = this.rows[this.head] as DriverRow;
        this.rows[this.head++] = undefined;
        if (this.head === this.rows.length) {
          this.rows = [];
          this.head = 0;
        } else if (this.head >= COMPACT_AT) {
          this.rows.splice(0, this.head);
          this.head = 0;
        }
        this.resumeIfDrained();
        return row;
      }
      if (this.finished) return undefined;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  /** Pauses the request until `release`, whatever the buffered row count. */
  hold(): void {
    this.held = true;
    if (!this.paused) this.setPaused(true);
  }

  release(): void {
    this.held = false;
    this.resumeIfDrained();
  }

  /**
   * Cancels a request still running and waits for it to end. A driver error the consumer never saw is thrown unless
   * `quiet`; the cancellation's own error never is.
   */
  async close(quiet: boolean): Promise<void> {
    if (!this.finished) {
      this.cancelled = true;
      this.request.cancel();
      await this.ended;
    }
    if (!quiet && !this.reported && this.failure !== undefined) {
      this.reported = true;
      throw this.failure;
    }
  }

  private push(row: DriverRow): void {
    if (this.cancelled || this.failure !== undefined) return;
    this.rows.push(row);
    if (!this.paused && this.rows.length - this.head >= this.highWaterMark) this.setPaused(true);
    this.notify();
  }

  private fail(error: unknown): void {
    if (this.cancelled && isCancellation(error)) return;
    this.failure ??= this.wrap(error);
    this.notify();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.signalEnded();
    this.notify();
  }

  private resumeIfDrained(): void {
    if (this.paused && !this.held && this.rows.length - this.head <= Math.floor(this.highWaterMark / 2)) this.setPaused(false);
  }

  private setPaused(paused: boolean): void {
    if (this.finished) return;
    this.paused = paused;
    if (paused) this.request.pause();
    else this.request.resume();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

// Rows carry canonical value text on both paths, as decodeRow gives it; keyValues keep the typed driver values so keys
// order as SQL Server orders them.
async function* keyedRows(rows: RequestRows, plan: StreamPlan): AsyncGenerator<CanonicalRow, void, undefined> {
  const { shape, selectColumns } = plan;
  const encodesSelection = selectColumns.length === shape.columns.length;
  let previous: CanonicalRow | undefined;
  for (;;) {
    const raw = await rows.next();
    if (raw === undefined) return;
    const values = normaliseRow(selectColumns, raw);
    const selected = encodeRow(selectColumns, values);
    const row = decodeRow(selectColumns, selected);
    const current: CanonicalRow = {
      table: shape.table,
      key: encodeKey(selectColumns, shape.keyColumns, row),
      keyValues: shape.keyColumns.map((name) => values[name] as KeyValue),
      encoding: encodesSelection ? selected : encodeRow(shape.columns, row),
      row,
    };
    if (previous !== undefined && compareCanonicalRows(current, previous) < 0) {
      throw new ExtractOrderError({ database: shape.database, table: shape.table, previous: previous.key, current: current.key });
    }
    previous = current;
    yield current;
  }
}

function keylessRow(shape: StreamShape, encoding: string): CanonicalRow {
  return { table: shape.table, key: encoding, keyValues: NO_KEY_VALUES, encoding, row: decodeRow(shape.columns, encoding) };
}

async function writeFully(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    offset += bytesWritten;
  }
}

/** Writes `records` in order to the new file `file`, each as a 4-byte big-endian byte length and its UTF-8 text. */
export async function writeRecords(file: string, records: Iterable<string> | AsyncIterable<string>): Promise<void> {
  const handle = await open(file, 'wx');
  try {
    let batch: Buffer[] = [];
    let batchBytes = 0;
    for await (const record of records) {
      const payload = Buffer.from(record, 'utf8');
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(payload.length, 0);
      batch.push(header, payload);
      batchBytes += header.length + payload.length;
      if (batchBytes >= WRITE_BATCH_BYTES) {
        await writeFully(handle, Buffer.concat(batch, batchBytes));
        batch = [];
        batchBytes = 0;
      }
    }
    if (batchBytes > 0) await writeFully(handle, Buffer.concat(batch, batchBytes));
  } finally {
    await handle.close();
  }
}

/** Sorts `run` and writes it to `file` as one record per encoding. */
async function writeRun(file: string, run: string[]): Promise<void> {
  run.sort(compareEncodings);
  await writeRecords(file, run);
}

/** Sequential reader of one spill run's records. */
export class RunReader {
  private buffer = Buffer.alloc(0);
  private offset = 0;
  private position = 0;

  constructor(
    private readonly file: string,
    private readonly handle: FileHandle,
  ) {}

  /** The next record, or undefined at the end of the run. */
  async next(): Promise<string | undefined> {
    if (!(await this.ensure(4))) {
      if (this.offset < this.buffer.length) throw new Error(`spill run ${this.file} ends inside a record header`);
      return undefined;
    }
    const length = this.buffer.readUInt32BE(this.offset);
    if (!(await this.ensure(4 + length))) throw new Error(`spill run ${this.file} ends inside a record`);
    const start = this.offset + 4;
    this.offset = start + length;
    return this.buffer.toString('utf8', start, this.offset);
  }

  close(): Promise<void> {
    return this.handle.close();
  }

  /** Whether `bytes` unread bytes are buffered, reading on as needed; false when the file ends first. */
  private async ensure(bytes: number): Promise<boolean> {
    while (this.buffer.length - this.offset < bytes) {
      const chunk = Buffer.allocUnsafe(Math.max(READ_CHUNK_BYTES, bytes - (this.buffer.length - this.offset)));
      const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, this.position);
      if (bytesRead === 0) return false;
      this.position += bytesRead;
      this.buffer = Buffer.concat([this.buffer.subarray(this.offset), chunk.subarray(0, bytesRead)]);
      this.offset = 0;
    }
    return true;
  }
}

interface HeapEntry {
  encoding: string;
  reader: RunReader;
}

/** Binary min-heap of run heads ordered by `compareEncodings`. */
class RunHeap {
  private readonly items: HeapEntry[] = [];

  push(entry: HeapEntry): void {
    const items = this.items;
    let index = items.length;
    items.push(entry);
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = items[parentIndex] as HeapEntry;
      if (compareEncodings(parent.encoding, entry.encoding) <= 0) break;
      items[index] = parent;
      index = parentIndex;
    }
    items[index] = entry;
  }

  pop(): HeapEntry | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top;
    let index = 0;
    for (;;) {
      const left = 2 * index + 1;
      if (left >= items.length) break;
      const right = left + 1;
      const child = right < items.length && compareEncodings((items[right] as HeapEntry).encoding, (items[left] as HeapEntry).encoding) < 0 ? right : left;
      const candidate = items[child] as HeapEntry;
      if (compareEncodings(last.encoding, candidate.encoding) <= 0) break;
      items[index] = candidate;
      index = child;
    }
    items[index] = last;
    return top;
  }
}

/** K-way merge of sorted spill runs, each read sequentially. */
export async function* mergeRuns(files: readonly string[]): AsyncGenerator<string, void, undefined> {
  const readers: RunReader[] = [];
  try {
    for (const file of files) readers.push(new RunReader(file, await open(file, 'r')));
    const heap = new RunHeap();
    for (const reader of readers) {
      const first = await reader.next();
      if (first !== undefined) heap.push({ encoding: first, reader });
    }
    for (let top = heap.pop(); top !== undefined; top = heap.pop()) {
      yield top.encoding;
      const following = await top.reader.next();
      if (following !== undefined) heap.push({ encoding: following, reader: top.reader });
    }
  } finally {
    await Promise.all(readers.map((reader) => reader.close()));
  }
}

/** Keyless rows sorted by encoding through memory-bounded runs; duplicates are yielded once per occurrence. */
async function* keylessRows(rows: RequestRows, shape: StreamShape, options: StreamOptions): AsyncGenerator<CanonicalRow, void, undefined> {
  const runLimit = options.sortRunBytes ?? DEFAULT_SORT_RUN_BYTES;
  const files: string[] = [];
  let dir: string | undefined;
  let run: string[] = [];
  let runBytes = 0;
  const spill = async (): Promise<void> => {
    dir ??= await mkdtemp(join(options.spillDir ?? tmpdir(), SPILL_PREFIX));
    const file = join(dir, `run-${String(files.length)}`);
    await writeRun(file, run);
    files.push(file);
    run = [];
    runBytes = 0;
  };
  try {
    for (;;) {
      const raw = await rows.next();
      if (raw === undefined) break;
      const encoding = encodeRow(shape.columns, normaliseRow(shape.columns, raw));
      run.push(encoding);
      runBytes += Buffer.byteLength(encoding, 'utf8');
      if (runBytes >= runLimit) {
        rows.hold();
        await spill();
        rows.release();
      }
    }
    if (files.length === 0) {
      run.sort(compareEncodings);
      for (const encoding of run) yield keylessRow(shape, encoding);
      return;
    }
    if (run.length > 0) await spill();
    for await (const encoding of mergeRuns(files)) yield keylessRow(shape, encoding);
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Streams the table's canonical rows: keyed tables in ORDER BY key order (checked with `compareCanonicalRows`),
 * keyless tables sorted by encoding. Breaking early cancels the SQL request and removes any spill files.
 */
export async function* streamCanonicalRows(options: StreamOptions): AsyncGenerator<CanonicalRow, void, undefined> {
  const plan = await planStream(options);
  const { shape } = plan;
  const request = plan.pool.request();
  bindScope(request, shape.scope);
  const rows = new RequestRows(
    request,
    options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK,
    (error) => new ExtractError(`reading ${shape.table} from database ${shape.database} failed`, { database: shape.database, table: shape.table, cause: error }),
  );
  rows.start(shape.selectSql);
  let thrown = false;
  try {
    if (shape.keyed) yield* keyedRows(rows, plan);
    else yield* keylessRows(rows, shape, options);
  } catch (error) {
    thrown = true;
    throw error;
  } finally {
    await rows.close(thrown);
  }
}

function unpadded(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

function typeRank(value: KeyValue): number {
  if (value === null) return 0;
  if (typeof value === 'number' || typeof value === 'bigint') return 1;
  if (value instanceof Date) return 2;
  return typeof value === 'string' ? 3 : 4;
}

function sign(order: number): number {
  return order < 0 ? -1 : order > 0 ? 1 : 0;
}

function compareKeyValue(a: KeyValue, b: KeyValue): number {
  if (a === b) return 0;
  if ((typeof a === 'number' || typeof a === 'bigint') && (typeof b === 'number' || typeof b === 'bigint')) return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof Date && b instanceof Date) return sign(a.getTime() - b.getTime());
  if (typeof a === 'string' && typeof b === 'string') {
    const x = unpadded(a);
    const y = unpadded(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return Buffer.compare(a, b);
  return sign(typeRank(a) - typeRank(b));
}

/**
 * Orders key tuples as the extractor's ORDER BY does: null first, numbers numerically, dates by time, text by code unit
 * ignoring trailing spaces, binary by byte; a shorter tuple sorts first.
 */
export function compareKeyValues(a: readonly KeyValue[], b: readonly KeyValue[]): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) {
    const order = compareKeyValue(a[index] ?? null, b[index] ?? null);
    if (order !== 0) return order;
  }
  return sign(a.length - b.length);
}

function compareProgramIds(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return sign(a - b);
}

/** The order every extracted stream yields: by key values then program id when both rows are keyed, else by encoding. */
export function compareCanonicalRows(a: CanonicalRow, b: CanonicalRow): number {
  if (a.keyValues.length > 0 && b.keyValues.length > 0) {
    return compareKeyValues(a.keyValues, b.keyValues) || compareProgramIds(a.legacyProgramId, b.legacyProgramId);
  }
  return compareEncodings(a.encoding, b.encoding);
}
