// Unit tests for the window import over a scripted legacy SQL Server, fake owners and a fake bridge.
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';

import type { Logger } from '@opt2/platform/logging';
import { MAX_EXPORT_MATCH_LENGTH, decodeRow, encodeRow, type ApplyRequest, type CanonicalColumn, type ExportResponse, type ObjectManifestEntry, type PositionResponse, type PublishedEvent } from '@opt2/platform/migration-kit';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import type { ConnectionPool } from 'mssql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { clearCatalogCache, compareKeyValues, type ExtractScope, type KeyValue } from '../../src/extract/index.js';
import { objectKey, type StoredVariant } from '../../src/files/index.js';
import { UnsupportedFileStoreError, type BridgeClient, type FileListing, type LegacyDb, type LegacyFileEntry } from '../../src/legacy/index.js';
import { OwnerCallError, UnknownUnitError, loadUnitCatalog, type DataOwner, type ExportParams, type ObjectBody, type OwnersClient, type PositionParams, type PutObjectParams } from '../../src/owners/index.js';
import type { FingerprintReader, TableFingerprint, WindowFingerprints } from '../../src/windows/fingerprints.js';
import {
  WindowImportError,
  importWindow,
  legacyProjector,
  toExtractScope,
  windowBatchId,
  type ImportInput,
  type WindowImportContext,
} from '../../src/windows/import.js';
import { DELETION_POLL_MS, DELETION_WAIT_MS, type PublishedCursors } from '../../src/windows/site-deletion.js';
import { REGISTRATION_POLL_MS, REGISTRATION_WAIT_MS } from '../../src/windows/site-registration.js';
import { UNITS, fixtureInventoryFor, writeInventoryFile, writeOwnershipFile } from '../helpers/fixtures.js';

type Row = Record<string, unknown>;

interface ColumnSpec {
  name: string;
  type: string;
  maxLength?: number;
}

interface TableSpec {
  columns: ColumnSpec[];
  primaryKey?: string[];
  rows: Row[];
}

const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const UMBRELLA = tenantIdForSite('umbrella');
const FILE_1 = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FILE_2 = 'B1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const SELECT = /^SELECT (.+?) FROM \[([^\]]+)\]\.\[([^\]]+)\](?: WHERE (.+))?$/s;
const TERM = /\(?\[([^\]]+)\] IN \(([^)]*)\)\)?/g;

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const norm = (value: unknown): string => String(value).replace(/ +$/, '').toLowerCase();

function valueAt(row: Row, name: string): unknown {
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : row[key];
}

/** Scripted legacy database: catalog queries from the specs, SELECTs filtered by their `IN` terms and ordered by key. */
class FakeDb {
  readonly queries: string[] = [];

  constructor(readonly tables: Record<string, TableSpec>) {}

  spec(schema: string, table: string): TableSpec | undefined {
    const wanted = `${schema}.${table}`.toLowerCase();
    return Object.entries(this.tables).find(([name]) => name.toLowerCase() === wanted)?.[1];
  }

  select(text: string, inputs: ReadonlyMap<string, unknown>): Row[] {
    const match = SELECT.exec(text.replace(/ ORDER BY .*$/s, ''));
    if (match === null) throw new Error(`fake legacy: unexpected statement ${text}`);
    const [, list = '', schema = '', table = '', where] = match;
    const spec = this.spec(schema, table);
    if (spec === undefined) throw Object.assign(new Error(`Invalid object name '${schema}.${table}'.`), { number: 208 });
    const items = list.split(', ').map((item) => {
      const parts = /^\[([^\]]+)\](?: AS \[([^\]]+)\])?$/.exec(item);
      if (parts === null) throw new Error(`fake legacy: unexpected select item ${item}`);
      return { column: parts[1] ?? '', alias: parts[2] ?? parts[1] ?? '' };
    });
    const terms = [...(where ?? '').matchAll(TERM)].map(([, column = '', params = '']) => ({
      column,
      values: new Set(params.split(', ').map((param) => norm(inputs.get(param.slice(1))))),
    }));
    const key = spec.primaryKey ?? [];
    return spec.rows
      .filter((row) => terms.length === 0 || terms.some((term) => term.values.has(norm(valueAt(row, term.column)))))
      .toSorted((a, b) => compareKeyValues(key.map((name) => a[name] as KeyValue), key.map((name) => b[name] as KeyValue)))
      .map((row) => Object.fromEntries(items.map(({ column, alias }) => [alias, valueAt(row, column) ?? null])));
  }
}

/** mssql request double: plain queries resolve their recordset, stream requests emit rows one per tick. */
class FakeRequest extends EventEmitter {
  stream = false;
  readonly inputs = new Map<string, unknown>();
  private rows: Row[] = [];
  private index = 0;
  private paused = false;
  private ended = false;
  private settle: (() => void) | undefined;

  constructor(private readonly db: FakeDb) {
    super();
  }

  input(name: string, ...rest: unknown[]): this {
    this.inputs.set(name, rest.length > 1 ? rest[1] : rest[0]);
    return this;
  }

  query(text: string): Promise<unknown> {
    this.db.queries.push(text);
    if (text.includes('DATABASEPROPERTYEX')) return Promise.resolve({ recordset: [{ updateability: 'READ_ONLY' }] });
    if (text.includes('INFORMATION_SCHEMA.COLUMNS')) {
      const spec = this.db.spec(String(this.inputs.get('schema')), String(this.inputs.get('table')));
      const columns = (spec?.columns ?? []).map((column, index) => ({
        COLUMN_NAME: column.name,
        DATA_TYPE: column.type,
        IS_NULLABLE: 'YES',
        CHARACTER_MAXIMUM_LENGTH: column.maxLength ?? null,
        NUMERIC_PRECISION: null,
        NUMERIC_SCALE: null,
        ORDINAL_POSITION: index + 1,
      }));
      const sets = [columns, (spec?.primaryKey ?? []).map((name) => ({ name })), []];
      return Promise.resolve({ recordsets: sets, recordset: columns });
    }
    if (text.includes('FROM sys.tables t JOIN sys.schemas s')) {
      const recordset = Object.keys(this.db.tables).map((name) => {
        const dot = name.indexOf('.');
        return { schema_name: name.slice(0, dot), table_name: name.slice(dot + 1) };
      });
      return Promise.resolve({ recordset });
    }
    let rows: Row[];
    try {
      rows = this.db.select(text, this.inputs);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.stream) return Promise.resolve({ recordset: rows, recordsets: [rows] });
    this.rows = rows;
    return new Promise((resolve) => {
      this.settle = () => resolve({});
      setImmediate(() => this.pump());
    });
  }

  pause(): boolean {
    this.paused = true;
    return true;
  }

  resume(): boolean {
    this.paused = false;
    setImmediate(() => this.pump());
    return true;
  }

  cancel(): void {
    setImmediate(() => this.end());
  }

  private pump(): void {
    if (this.ended || this.paused) return;
    if (this.index >= this.rows.length) {
      this.end();
      return;
    }
    this.emit('row', this.rows[this.index++]);
    setImmediate(() => this.pump());
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('done', { rowsAffected: [] });
    this.settle?.();
  }
}

let databases = 0;

function fakeLegacy(tables: Record<string, TableSpec>): { legacy: LegacyDb; db: FakeDb } {
  const db = new FakeDb(tables);
  databases += 1;
  const pool = { config: { database: `muradb_import_${String(databases)}` }, request: () => new FakeRequest(db) } as unknown as ConnectionPool;
  const legacy: LegacyDb = {
    live: () => Promise.resolve(pool),
    database: () => Promise.reject(new Error('fake legacy: the window import reads the live database only')),
    transaction: () => Promise.reject(new Error('fake legacy: the window import opens no transaction')),
    close: () => Promise.resolve(),
  };
  return { legacy, db };
}


/** One unit's export: the owner's legacy table, columns and keyed-ness, with canonical-text rows and objects per legacy site. */
interface UnitExportSpec {
  legacyTable: string;
  keyless?: boolean;
  columns: CanonicalColumn[];
  rows?: Record<string, Row[]>;
  objects?: Record<string, ObjectManifestEntry[]>;
}

/** Export-row field carrying the row's `Program_<id>` for folded tables. */
const PROGRAM = '__program';

/** `rows` that `match` selects as an owner compares them; all of them when the export lacks a match column. */
function matchedRows(columns: readonly CanonicalColumn[], rows: Row[], match: ExportParams['match']): Row[] {
  if (match === undefined) return rows;
  const entries = Object.entries(match).map(([name, values]) => ({ column: columns.find((column) => column.name.toLowerCase() === name.toLowerCase()), values: new Set(values.map(norm)) }));
  if (entries.some(({ column }) => column === undefined)) return rows;
  return rows.filter((row) => entries.some(({ column, values }) => values.has(norm(row[column?.name ?? '']))));
}

/** An event of the fake outboxes, with its producer. */
type OutboxEvent = PublishedEvent & { owner: string };

/**
 * Fake outboxes and inboxes: `publish` adds a producer's event at the next `seq`; a consumer reports its receipt of an event, in
 * the event's tenant, from its `lags[consumer]`-th read of it, the first by default, and one in `failing` fails each receipt read.
 * `asked` records every listing and receipt read.
 */
function fakeEvents(lags: Readonly<Record<string, number>> = {}, failing: readonly string[] = []) {
  const outbox: OutboxEvent[] = [];
  const reads = new Map<string, number>();
  const asked: { owner: string; query: PositionParams }[] = [];
  const readsOf = (consumer: string, eventId: string): number => reads.get(`${consumer}:${eventId}`) ?? 0;
  return {
    asked,
    publish(owner: string, topic: string, tenantId: string): OutboxEvent {
      const event: OutboxEvent = { owner, eventId: randomUUID(), topic, tenantId, kind: 'state', seq: String(outbox.length + 1) };
      outbox.push(event);
      return event;
    },
    /** Whether `consumer` has reported its receipt of `eventId`. */
    received: (consumer: string, eventId: string | undefined): boolean => eventId !== undefined && readsOf(consumer, eventId) >= (lags[consumer] ?? 1),
    position(owner: string, query: PositionParams): Promise<PositionResponse> {
      asked.push({ owner, query });
      const base = { owner, position: '1', outbox: null, inbox: null };
      if (query.eventIds !== undefined) {
        if (failing.includes(owner)) return Promise.reject(new OwnerCallError(owner as DataOwner, 'GET', '/internal/v1/migration/position', 503, { error: 'unavailable' }));
        const receipts = Object.fromEntries(
          query.eventIds.map((eventId) => {
            reads.set(`${owner}:${eventId}`, readsOf(owner, eventId) + 1);
            const event = outbox.find((candidate) => candidate.eventId === eventId);
            return [eventId, event !== undefined && readsOf(owner, eventId) >= (lags[owner] ?? 1) ? [event.tenantId] : []];
          }),
        );
        return Promise.resolve({ ...base, inbox: { total: 0, bySubscription: {}, receipts } });
      }
      const after = Number(query.publishedAfter ?? '0');
      const mine = outbox.filter((event) => event.owner === owner && (query.publishedTopics ?? []).includes(event.topic));
      const frontier = query.publishedThrough ?? (mine.length === 0 ? String(after) : String(Math.max(...mine.map((event) => Number(event.seq)))));
      const eligible = mine.filter((event) => Number(event.seq) > after && Number(event.seq) <= Number(frontier));
      const limit = query.publishedLimit ?? eligible.length;
      const published = eligible.slice(0, limit).map(({ eventId, topic, tenantId, kind, seq }) => ({ eventId, topic, tenantId, kind, seq }));
      return Promise.resolve({
        ...base,
        published,
        publishedNext: published.at(-1)?.seq ?? String(after),
        publishedComplete: eligible.length <= limit,
        publishedFrontier: frontier,
      });
    },
  };
}

/**
 * Fake owners: exports served per unit and tenant in pages of two rows, filtered by `match` when `honourMatch`; export params,
 * applies, object uploads (each body read to its end with its declared size) and deletes recorded. `failPut` fails each
 * upload; a delete of a key in `absentKeys` answers `deleted: false`. A position ask listing published events or reading
 * receipts is answered by `events`, an empty outbox by default; any other must ask for the registered tenants, answered as
 * `registered`, read per owner when it is a function, or left out with `omitRegistered`. `onApply` sees each recorded apply.
 */
function fakeOwners(
  units: Record<string, UnitExportSpec>,
  options: {
    failApply?: Error;
    failPut?: Error;
    honourMatch?: boolean;
    failDelete?: Error;
    absentKeys?: readonly string[];
    registered?: readonly string[] | ((owner: string) => readonly string[]);
    omitRegistered?: boolean;
    onApply?: (owner: string, request: ApplyRequest) => void;
    events?: ReturnType<typeof fakeEvents>;
  } = {},
) {
  const events = options.events ?? fakeEvents();
  const applies: { owner: string; request: ApplyRequest }[] = [];
  const puts: { params: PutObjectParams; bytes: Buffer; size: number }[] = [];
  const deletes: string[] = [];
  const exports: ExportParams[] = [];
  let xid = 100;
  const siteOf = (tenantId: string, spec: UnitExportSpec | undefined): string | undefined =>
    Object.keys({ ...spec?.rows, ...spec?.objects }).find((site) => tenantIdForSite(site) === tenantId);
  async function* exportPages(_owner: string, params: ExportParams): AsyncGenerator<ExportResponse> {
    exports.push(params);
    await Promise.resolve();
    const spec = units[params.unit];
    const site = spec === undefined ? undefined : siteOf(params.tenantId, spec);
    const stored = site === undefined ? [] : (spec?.rows?.[site] ?? []);
    const rows = (options.honourMatch === true ? matchedRows(spec?.columns ?? [], stored, params.match) : stored).map((row) => {
      const encoded = encodeRow(spec?.columns ?? [], row);
      return { key: encoded, row: encoded, hash: sha(encoded), ...(row[PROGRAM] === undefined ? {} : { legacyProgramId: Number(row[PROGRAM]) }) };
    });
    const objects = site === undefined ? [] : (spec?.objects?.[site] ?? []);
    for (let start = 0; start === 0 || start < rows.length; start += 2) {
      const chunk = rows.slice(start, start + 2);
      const tables =
        spec === undefined
          ? []
          : [{ unit: params.unit, legacyTable: spec.legacyTable, targetTable: params.unit, keyless: spec.keyless ?? false, columns: spec.columns, rows: chunk }];
      yield { unit: params.unit, tenantId: params.tenantId, tables, next: start + 2 >= rows.length ? null : `page-${String(start + 2)}`, ...(start === 0 ? { objects } : {}) };
    }
  }
  const owners = {
    apply: vi.fn((owner: string, request: ApplyRequest) => {
      if (options.failApply !== undefined) return Promise.reject(options.failApply);
      applies.push({ owner, request });
      options.onApply?.(owner, request);
      xid += 1;
      return Promise.resolve({ batchId: request.batchId, duplicate: false, applied: request.rows.length, skipped: 0, writePositions: new Map([[owner, String(xid)]]) });
    }),
    exportPages,
    position: vi.fn((owner: string, query: PositionParams = {}) => {
      if (query.publishedTopics !== undefined || query.eventIds !== undefined) return events.position(owner, query);
      if (query.registeredTenants !== true) return Promise.reject(new Error(`fake owners: the position of ${owner} was asked without its registered tenants`));
      const listed = typeof options.registered === 'function' ? options.registered(owner) : (options.registered ?? []);
      const registered = options.omitRegistered === true ? {} : { registeredTenants: [...listed].sort() };
      return Promise.resolve({ owner, position: String(xid), outbox: null, inbox: null, ...registered });
    }),
    putObject: vi.fn(async (params: PutObjectParams, body: ObjectBody) => {
      if (body instanceof Uint8Array) throw new Error('the window import sends a stream');
      const bytes = await buffer(body.stream);
      puts.push({ params, bytes, size: body.size });
      if (options.failPut !== undefined) throw options.failPut;
      return Promise.resolve({
        key: objectKey(params.tenantId, params.fileId, params.variant as StoredVariant, params.ext),
        size: bytes.byteLength,
        sha256: params.sha256,
        created: true,
        writePositions: new Map([['strategies-content', '900']]),
      });
    }),
    deleteObject: vi.fn((key: string) => {
      if (options.failDelete !== undefined) return Promise.reject(options.failDelete);
      deletes.push(key);
      return Promise.resolve({ key, deleted: !(options.absentKeys ?? []).includes(key), writePositions: new Map([['strategies-content', '950']]) });
    }),
  } as unknown as OwnersClient;
  /** Applied rows decoded over their batch's columns. */
  const appliedRows = () =>
    applies.flatMap(({ owner, request }) =>
      request.rows.map((row) => ({ owner, op: row.op, discriminator: row.discriminator, tenantId: request.tenantId, values: decodeRow(request.columns, row.row) })),
    );
  return { owners, applies, puts, deletes, appliedRows, exports, events };
}

/**
 * Fake bridge: one `fileDir` listing per store directory, with the bytes of each stored name, which `files.get` writes to its
 * sink; a file's `served` bytes replace them there, as when the file changed after its listing. `spools` records the
 * temporary directory's entries at each read.
 */
function fakeBridge(listings: Record<string, { fileStore?: string; files: { name: string; bytes: Buffer; served?: Buffer }[] }>) {
  const gets: string[] = [];
  const spools: string[][] = [];
  const entry = (name: string, bytes: Buffer): LegacyFileEntry => {
    const dot = name.lastIndexOf('.');
    return { name, fileId: name.slice(0, 35), variant: name.slice(35, dot) as LegacyFileEntry['variant'], ext: name.slice(dot + 1), size: bytes.byteLength, sha256: sha(bytes), lastModified: '2026-06-30T12:00:00.000' };
  };
  const bridge = {
    filesList: vi.fn((dir: string): Promise<FileListing> => {
      const listing = listings[dir];
      return Promise.resolve({ fileStore: listing?.fileStore ?? 'fileDir', files: (listing?.files ?? []).map(({ name, bytes }) => entry(name, bytes)), serverTime: '2026-06-30T12:00:00.000' });
    }),
    filesGet: vi.fn(async (dir: string, name: string, sink: Writable) => {
      gets.push(`${dir}/${name}`);
      spools.push(await readdir(tmpdir()));
      const found = listings[dir]?.files.find((file) => file.name === name);
      if (found === undefined) throw new Error(`no file ${dir}/${name}`);
      const bytes = found.served ?? found.bytes;
      await pipeline(Readable.from([bytes]), sink);
      return { sha256: sha(bytes), size: bytes.byteLength };
    }),
  } as unknown as BridgeClient;
  return { bridge, gets, spools };
}

const varchar = (name: string, maxLength = 50): ColumnSpec => ({ name, type: 'varchar', maxLength });
const int = (name: string): ColumnSpec => ({ name, type: 'int' });
const s = (name: string): CanonicalColumn => ({ name, type: 's' });
const i = (name: string): CanonicalColumn => ({ name, type: 'i' });

/** Live `tsettings`: tenant-a keeps its files in the umbrella pool. */
const TSETTINGS: TableSpec = {
  columns: [varchar('SiteID', 25), varchar('filePoolID', 25)],
  primaryKey: ['SiteID'],
  rows: [
    { SiteID: 'default', filePoolID: null },
    { SiteID: 'tenant-a', filePoolID: 'umbrella' },
    { SiteID: 'tenant-b', filePoolID: '' },
    { SiteID: 'umbrella', filePoolID: null },
  ],
};

const ARCHIVE_TABLE: TableSpec = {
  columns: [int('archive_id'), varchar('siteID', 50), { name: 'archived_by', type: 'nvarchar', maxLength: 50 }, varchar('archived_by_id', 35)],
  primaryKey: ['archive_id'],
  rows: [
    { archive_id: 1, siteID: 'tenant-a', archived_by: 'Renamed', archived_by_id: 'x' },
    { archive_id: 3, siteID: 'tenant-a', archived_by: 'New', archived_by_id: 'x' },
    { archive_id: 4, siteID: 'tenant-b', archived_by: 'Changed out of scope', archived_by_id: 'x' },
    { archive_id: 5, siteID: 'tenant-a', archived_by: 'Same', archived_by_id: 'x' },
  ],
};

const ARCHIVE_EXPORT: UnitExportSpec = {
  legacyTable: 'synthetic.person_archive',
  columns: [i('archive_id'), s('siteID'), s('archived_by')],
  rows: {
    'tenant-a': [
      { archive_id: '1', siteID: 'tenant-a', archived_by: 'Original' },
      { archive_id: '2', siteID: 'tenant-a', archived_by: 'Deleted in legacy' },
      { archive_id: '5', siteID: 'tenant-a', archived_by: 'Same' },
    ],
    'tenant-b': [{ archive_id: '4', siteID: 'tenant-b', archived_by: 'Before' }],
  },
};

let inventoryDir: string;
let committedInventory: string;
let fixtureInventory: string;
let fixtureOwnership: string;

beforeAll(async () => {
  inventoryDir = await mkdtemp(join(tmpdir(), 'windows-import-inventory-'));
  committedInventory = await writeInventoryFile(join(inventoryDir, 'committed'), fixtureInventoryFor(loadUnitCatalog(loadConfig().paths.tableOwnership)));
  fixtureInventory = await writeInventoryFile(join(inventoryDir, 'fixture'));
  fixtureOwnership = await writeOwnershipFile(join(inventoryDir, 'fixture'));
});

afterAll(async () => {
  await rm(inventoryDir, { recursive: true, force: true });
});

/**
 * A window import context over the committed table ownership, or the fixture's with `fixture`, ordering tables by the fixture
 * inventory of the tables that ownership records; the system clock unless `clock` is given.
 */
function contextOf(parts: { legacy: LegacyDb; owners: OwnersClient; bridge?: BridgeClient; batchRows?: number; clock?: Clock; fixture?: boolean }): WindowImportContext {
  const base = loadConfig();
  const [tableOwnership, inventory] = parts.fixture === true ? [fixtureOwnership, fixtureInventory] : [base.paths.tableOwnership, committedInventory];
  return {
    config: { ...base, paths: { ...base.paths, inventory, tableOwnership }, backfill: { ...base.backfill, batchRows: parts.batchRows ?? base.backfill.batchRows } },
    legacy: parts.legacy,
    catalog: loadUnitCatalog(tableOwnership),
    owners: parts.owners,
    bridge: parts.bridge ?? fakeBridge({}).bridge,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    clock: parts.clock ?? systemClock,
  };
}

/** A clock that moves only when `sleep` is awaited, by the milliseconds slept. */
function fakeTime() {
  let now = Date.UTC(2026, 5, 30, 12);
  const slept: number[] = [];
  return {
    clock: { now: () => new Date(now) } satisfies Clock,
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    slept,
  };
}

const windowInput = (units: string[], scope: ImportInput['scope'], attempt = 1): ImportInput => ({ windowId: 'W1', attempt, units, scope });

beforeEach(() => {
  clearCatalogCache();
});

describe('toExtractScope', () => {
  it.each([
    [{ table: true } as const, 'table'],
    [undefined, 'table'],
    [{ keys: { SiteID: 'tenant-a', userid: 'U1' } }, { siteid: ['tenant-a'], userid: ['U1'] }],
  ])('maps %j to %j', (scope, expected) => {
    expect(toExtractScope(scope as ImportInput['scope'] | undefined)).toEqual(expected);
  });
});

describe('windowBatchId', () => {
  it('names the window, attempt, owner, table and sequence', () => {
    expect(windowBatchId('W1', 2, 'people', 'tusers', 3)).toBe('win:W1:a2:people:tusers:3');
    expect(windowBatchId('W1', 1, 'people', 'tusers', 3)).not.toBe(windowBatchId('W1', 2, 'people', 'tusers', 3));
  });
});

describe('legacyProjector', () => {
  const compare = [s('ContentID'), s('SiteID'), s('Title')];
  const missing = (column: string): { throws: string } => ({ throws: `live legacy table tcontent has no column ${column}, which its owner maps` });

  it.each<{ label: string; rows: Row[]; expected: (Row | { throws: string })[] }>([
    {
      label: 'maps mixed-case legacy keys, null values included, for every row of one shape',
      rows: [
        { contentid: 'C1', SITEID: 'tenant-a', title: null },
        { contentid: 'C2', SITEID: 'tenant-b', title: 'Two' },
      ],
      expected: [
        { ContentID: 'C1', SiteID: 'tenant-a', Title: null },
        { ContentID: 'C2', SiteID: 'tenant-b', Title: 'Two' },
      ],
    },
    {
      label: 'prefers the exact key over an earlier case variant',
      rows: [{ ContentID: 'C1', siteid: 'variant', SiteID: 'exact', Title: 'One' }],
      expected: [{ ContentID: 'C1', SiteID: 'exact', Title: 'One' }],
    },
    {
      label: 'raises for a first row missing a mapped column',
      rows: [{ ContentID: 'C1', Title: 'One' }],
      expected: [missing('SiteID')],
    },
    {
      label: 'raises for a later row missing a mapped column, then projects the next row',
      rows: [
        { ContentID: 'C1', SiteID: 'tenant-a', Title: 'One' },
        { ContentID: 'C2', SiteID: 'tenant-a' },
        { ContentID: 'C3', SiteID: 'tenant-b', Title: 'Three' },
      ],
      expected: [{ ContentID: 'C1', SiteID: 'tenant-a', Title: 'One' }, missing('Title'), { ContentID: 'C3', SiteID: 'tenant-b', Title: 'Three' }],
    },
    {
      label: 'resolves a row of another shape afresh, then the first shape again',
      rows: [
        { ContentID: 'C1', SiteID: 'tenant-a', Title: 'One' },
        { contentid: 'C2', siteid: 'tenant-b', TITLE: 'Two', extra: 'x' },
        { ContentID: 'C3', SiteID: 'tenant-a', Title: 'Three' },
      ],
      expected: [
        { ContentID: 'C1', SiteID: 'tenant-a', Title: 'One' },
        { ContentID: 'C2', SiteID: 'tenant-b', Title: 'Two' },
        { ContentID: 'C3', SiteID: 'tenant-a', Title: 'Three' },
      ],
    },
    {
      label: 'takes the exact key a later row gains over the case variant an earlier row mapped',
      rows: [
        { contentid: 'C1', siteid: 'tenant-a', title: 'One' },
        { contentid: 'stale', ContentID: 'C2', siteid: 'tenant-a', title: 'Two' },
      ],
      expected: [
        { ContentID: 'C1', SiteID: 'tenant-a', Title: 'One' },
        { ContentID: 'C2', SiteID: 'tenant-a', Title: 'Two' },
      ],
    },
  ])('$label', ({ rows, expected }) => {
    const project = legacyProjector(compare, 'tcontent');
    rows.forEach((row, index) => {
      const outcome = expected[index];
      if (outcome !== undefined && 'throws' in outcome) expect(() => project(row)).toThrow(outcome.throws);
      else expect(project(row)).toEqual(outcome);
    });
  });
});

describe('importWindow', () => {
  it('sends scoped inserts, updates and deletes to the owner as legacy-window writes', async () => {
    const { legacy, db } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': ARCHIVE_TABLE });
    const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT });
    const result = await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['people.person_archive'], { keys: { siteid: 'tenant-a' } }));

    // Upserts go first, the table's deletes in a later batch.
    expect(fake.applies.map(({ request }) => [request.batchId, request.rows.map((row) => row.op)])).toEqual([
      [windowBatchId('W1', 1, 'people', 'synthetic.person_archive', 0), ['upsert', 'upsert']],
      [windowBatchId('W1', 1, 'people', 'synthetic.person_archive', 1), ['delete']],
    ]);
    for (const { owner, request } of fake.applies) {
      expect(owner).toBe('people');
      expect(request).toMatchObject({
        origin: 'legacy-window',
        legacyTable: 'synthetic.person_archive',
        tenantId: TENANT_A,
        units: ['people.person_archive'],
        holderId: 'W1',
        columns: ARCHIVE_EXPORT.columns,
      });
    }
    expect(fake.appliedRows().map(({ op, values }) => [op, values.archive_id, values.archived_by])).toEqual([
      ['upsert', '1', 'Renamed'],
      ['upsert', '3', 'New'],
      ['delete', '2', 'Deleted in legacy'],
    ]);
    expect(result).toMatchObject({ rowsImported: 3, perOwner: { people: { batches: 2, rows: 3 } }, objectsTransferred: 0, objectsRemoved: [], touchedContent: false });
    expect(result.writePositions.get('people')).toBe('102');
    expect(db.queries.some((query) => /FROM \[synthetic\]\.\[person_archive\] WHERE/.test(query))).toBe(true);
  });

  it('compares a tenant-b change only when the scope reaches it', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': ARCHIVE_TABLE });
    const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT });
    const result = await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['people.person_archive'], { table: true }));
    const upserts: [string, string[]][] = [
      [TENANT_A, ['upsert', 'upsert']],
      [TENANT_B, ['upsert']],
    ];
    expect(fake.applies.map(({ request }) => [request.tenantId, request.rows.map((row) => row.op)])).toEqual([
      ...upserts.sort(([a], [b]) => (a < b ? -1 : 1)),
      [TENANT_A, ['delete']],
    ]);
    expect(result.rowsImported).toBe(4);
  });

  it('applies a split tusers change to the owner of the row type and only over its columns', async () => {
    const users: TableSpec = {
      columns: [varchar('UserID', 35), varchar('GroupName'), varchar('Fname'), varchar('Password'), int('Type'), varchar('SiteID', 25)],
      primaryKey: ['UserID'],
      rows: [
        { UserID: 'G1', GroupName: 'Editors renamed', Fname: null, Password: null, Type: 1, SiteID: 'tenant-a' },
        { UserID: 'U1', GroupName: null, Fname: 'Anne', Password: 'new-hash', Type: 2, SiteID: 'tenant-a' },
        { UserID: 'U2', GroupName: null, Fname: 'Bob', Password: 'changed-hash', Type: 2, SiteID: 'tenant-a' },
      ],
    };
    const fake = fakeOwners({
      'people.person': {
        legacyTable: 'tusers',
        columns: [s('UserID'), s('GroupName'), s('Fname'), s('SiteID')],
        rows: {
          'tenant-a': [
            { UserID: 'U1', GroupName: null, Fname: 'Ann', SiteID: 'tenant-a' },
            { UserID: 'U2', GroupName: null, Fname: 'Bob', SiteID: 'tenant-a' },
            { UserID: 'U3', GroupName: null, Fname: 'Gone', SiteID: 'tenant-a' },
          ],
        },
      },
    });
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.tusers': users });
    await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['people.person'], { keys: { siteid: 'tenant-a' } }));

    expect(fake.applies.map(({ owner, request }) => [owner, request.columns])).toEqual([
      ['people', [s('UserID'), s('GroupName'), s('Fname'), s('SiteID'), i('Type')]],
      ['people', [s('UserID'), s('GroupName'), s('Fname'), s('SiteID'), i('Type')]],
    ]);
    expect(fake.appliedRows().map(({ op, values }) => ({ op, ...values }))).toEqual([
      { op: 'upsert', UserID: 'U1', GroupName: null, Fname: 'Anne', SiteID: 'tenant-a', Type: '2' },
      { op: 'delete', UserID: 'U3', GroupName: null, Fname: 'Gone', SiteID: 'tenant-a', Type: '2' },
    ]);
  });

  it('applies the added occurrence of a duplicated keyless row once, and removes one surplus occurrence', async () => {
    const row = (object: string) => ({ Object: object, SiteID: 'tenant-a', Name: object, OrderNo: 1 });
    const objects: TableSpec = {
      columns: [varchar('Object'), varchar('SiteID', 25), varchar('Name'), int('OrderNo')],
      rows: [row('A'), row('A'), row('B')],
    };
    const exported = (object: string) => ({ Object: object, SiteID: 'tenant-a', Name: object, OrderNo: '1' });
    const fake = fakeOwners({
      'programs_sites.system_object': {
        legacyTable: 'tsystemobjects',
        keyless: true,
        columns: [s('Object'), s('SiteID'), s('Name'), i('OrderNo')],
        rows: { 'tenant-a': [exported('A'), exported('B'), exported('B')] },
      },
    });
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.tsystemobjects': objects });
    await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['programs_sites.system_object'], { keys: { siteid: 'tenant-a' } }));

    expect(fake.appliedRows().map(({ op, values }) => [op, values.Object])).toEqual(
      expect.arrayContaining([
        ['insert', 'A'],
        ['delete', 'B'],
      ]),
    );
    expect(fake.appliedRows()).toHaveLength(2);
  });

  it('keeps batch ids stable within an attempt and new across attempts', async () => {
    const run = async (attempt: number): Promise<string[]> => {
      const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': ARCHIVE_TABLE });
      const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT });
      await importWindow(contextOf({ legacy, owners: fake.owners, batchRows: 2 }), windowInput(['people.person_archive'], { keys: { siteid: 'tenant-a' } }, attempt));
      expect(fake.applies.map(({ request }) => request.rows.length)).toEqual([2, 1]);
      return fake.applies.map(({ request }) => request.batchId);
    };
    const first = await run(1);
    expect(first).toEqual([windowBatchId('W1', 1, 'people', 'synthetic.person_archive', 0), windowBatchId('W1', 1, 'people', 'synthetic.person_archive', 1)]);
    expect(await run(1)).toEqual(first);
    const retry = await run(2);
    expect(retry.some((id) => first.includes(id))).toBe(false);
  });

  it.each([
    ['the live scope column for a key scope', { keys: { siteid: 'tenant-a' } }, { siteID: ['tenant-a'] }],
    ['no match for a table scope', { table: true }, undefined],
    ['no match for a scope value too long to send', { keys: { siteid: 'x'.repeat(MAX_EXPORT_MATCH_LENGTH) } }, undefined],
  ] as [string, ImportInput['scope'], ExportParams['match']][])('reads every tenant export once with %s', async (_label, scope, match) => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': ARCHIVE_TABLE });
    const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT });
    await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['people.person_archive'], scope));
    // The scope's site is read as well, live or not.
    const sites = [...TSETTINGS.rows.map((row) => String(row.SiteID)), ...('keys' in scope && scope.keys.siteid !== undefined ? [scope.keys.siteid] : [])];
    const tenants = [...new Set(sites.map((site) => tenantIdForSite(site)))].sort();
    expect(fake.exports).toEqual(tenants.map((tenantId) => ({ unit: 'people.person_archive', tenantId, match })));
  });

  it('applies the same rows whether the owner honours the match or returns more rows', async () => {
    const run = async (honourMatch: boolean) => {
      const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': ARCHIVE_TABLE });
      const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT }, { honourMatch });
      await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['people.person_archive'], { keys: { siteid: 'TENANT-A' } }));
      return fake.appliedRows().map(({ tenantId, op, values }) => [tenantId, op, values.archive_id]);
    };
    const honoured = await run(true);
    expect(honoured).toEqual([
      [TENANT_A, 'upsert', '1'],
      [TENANT_A, 'upsert', '3'],
      [TENANT_A, 'delete', '2'],
    ]);
    expect(await run(false)).toEqual(honoured);
  });

  it('streams a folded table of two programs into full batches as each program fills, then the remainders in program order', async () => {
    const enrolmentSpec = (ids: number[]): TableSpec => ({ columns: [int('enrolment_id'), int('cohort_id')], primaryKey: ['enrolment_id'], rows: ids.map((id) => ({ enrolment_id: id, cohort_id: 8 })) });
    const run = async () => {
      const { legacy } = fakeLegacy({
        'dbo.tsettings': TSETTINGS,
        'synthetic.program_site': { columns: [int('program_id'), varchar('siteID', 25)], primaryKey: ['program_id'], rows: [{ program_id: 1, siteID: 'tenant-a' }, { program_id: 2, siteID: 'tenant-a' }] },
        'Program_1.enrolment': enrolmentSpec([1, 2, 3]),
        'Program_2.enrolment': enrolmentSpec([1, 2]),
      });
      const fake = fakeOwners({ [UNITS.enrolment]: { legacyTable: 'enrolment', columns: [i('enrolment_id'), i('cohort_id')], rows: { 'tenant-a': [] } } });
      await importWindow(contextOf({ legacy, owners: fake.owners, batchRows: 2, fixture: true }), windowInput([UNITS.enrolment], { table: true }));
      return fake.applies.map(({ request }) => ({
        batchId: request.batchId,
        tenantId: request.tenantId,
        programId: request.legacyProgramId,
        enrolments: request.rows.map((row) => decodeRow(request.columns, row.row).enrolment_id),
      }));
    };
    const first = await run();
    const table = loadUnitCatalog(fixtureOwnership).legacyTablesOf(UNITS.enrolment)[0] ?? '';
    expect(first).toEqual([
      { batchId: windowBatchId('W1', 1, 'programs-sites', table, 0), tenantId: TENANT_A, programId: 1, enrolments: ['1', '2'] },
      { batchId: windowBatchId('W1', 1, 'programs-sites', table, 1), tenantId: TENANT_A, programId: 2, enrolments: ['1', '2'] },
      { batchId: windowBatchId('W1', 1, 'programs-sites', table, 2), tenantId: TENANT_A, programId: 1, enrolments: ['3'] },
    ]);
    expect(await run()).toEqual(first);
  });

  it('wraps an owner failure in WindowImportError naming the owner and table', async () => {
    const failure = new OwnerCallError('people', 'POST', '/internal/v1/migration/apply', 503, { error: 'unavailable' });
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': ARCHIVE_TABLE });
    const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT }, { failApply: failure });
    const error = await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['people.person_archive'], { table: true })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WindowImportError);
    expect(error).toMatchObject({ windowId: 'W1', owner: 'people', table: 'synthetic.person_archive', cause: failure });
  });

  it('fails the attempt with WindowImportError naming the owner whose position leaves out its registered tenants', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': ARCHIVE_TABLE });
    const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT }, { omitRegistered: true });
    const error = await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['people.person_archive'], { table: true })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WindowImportError);
    expect(error).toMatchObject({ windowId: 'W1', owner: 'people', table: 'synthetic.person_archive' });
    expect(fake.applies).toEqual([]);
  });

  describe('a site legacy added or deleted', () => {
    const GONE = tenantIdForSite('gone');
    const FRESH = tenantIdForSite('fresh');
    const LIVE = [...new Set(TSETTINGS.rows.map((row) => tenantIdForSite(String(row.SiteID))))];
    // Unit ids sort apart from the dependency order: the site unit, parent of every other, sorts last.
    const SITE_UNITS = ['content.content', 'identity.group_account', 'identity.redirect', 'programs_sites.site'];
    const group = (site: string) => ({ UserID: `G-${site}`, GroupName: 'Admin', Type: 1, SiteID: site });
    const page = (site: string) => ({ tcontent_ID: 1, SiteID: site, Title: 'Home' });
    const redirect = (site: string) => ({ redirectID: `R-${site}`, siteid: site });
    const text = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([name, value]) => [name, String(value)]));
    const of = <T>(site: string | undefined, rowOf: (site: string) => T): T[] => (site === undefined ? [] : [rowOf(site)]);
    /** Live legacy holding the live sites plus `site` with its Admin group, home page and a redirect. */
    const legacyWith = (site: string | undefined) =>
      fakeLegacy({
        'dbo.tsettings': { ...TSETTINGS, rows: [...TSETTINGS.rows, ...of(site, (SiteID) => ({ SiteID, filePoolID: null }))] },
        'dbo.tusers': { columns: [varchar('UserID', 35), varchar('GroupName'), int('Type'), varchar('SiteID', 25)], primaryKey: ['UserID'], rows: of(site, group) },
        'dbo.tcontent': { columns: [int('tcontent_ID'), varchar('SiteID', 25), varchar('Title')], primaryKey: ['tcontent_ID'], rows: of(site, page) },
        'dbo.tredirects': { columns: [varchar('redirectID', 35), varchar('siteid', 25)], primaryKey: ['redirectID'], rows: of(site, redirect) },
      }).legacy;
    /** Owner exports holding the live sites plus `site` with its Admin group, home page and a redirect. */
    const exportsWith = (site: string | undefined): Record<string, UnitExportSpec> => {
      const sites = [...TSETTINGS.rows.map((row) => String(row.SiteID)), ...of(site, (id) => id)];
      const held = (rowOf: (site: string) => Row) => (site === undefined ? {} : { [site]: [text(rowOf(site))] });
      return {
        'programs_sites.site': { legacyTable: 'tsettings', columns: [s('SiteID')], rows: Object.fromEntries(sites.map((id) => [id, [{ SiteID: id }]])) },
        'identity.group_account': { legacyTable: 'tusers', columns: [s('UserID'), s('GroupName'), i('Type'), s('SiteID')], rows: held(group) },
        'content.content': { legacyTable: 'tcontent', columns: [i('tcontent_ID'), s('SiteID'), s('Title')], rows: held(page) },
        'identity.redirect': { legacyTable: 'tredirects', columns: [s('redirectID'), s('siteid')], rows: held(redirect) },
      };
    };
    const PARENTS_FIRST = [
      ['programs-sites', 'tsettings', FRESH, ['upsert']],
      ['identity', 'tusers', FRESH, ['upsert']],
      ['identity', 'tredirects', FRESH, ['upsert']],
      ['strategies-content', 'tcontent', FRESH, ['upsert']],
    ];
    const CHILDREN_FIRST = [
      ['strategies-content', 'tcontent', GONE, ['delete']],
      ['identity', 'tredirects', GONE, ['delete']],
      ['identity', 'tusers', GONE, ['delete']],
      ['programs-sites', 'tsettings', GONE, ['delete']],
    ];
    /** Owners consuming the site topic and a topic of identity, whose group apply follows the site table's in SITE_UNITS. */
    const CONSUMERS = ['people', 'strategies-content'];
    const applied = (fake: ReturnType<typeof fakeOwners>) => fake.applies.map(({ owner, request }) => [owner, request.legacyTable, request.tenantId, request.rows.map((row) => row.op)]);

    /**
     * Owner registries starting at `initial`. A programs-sites upsert, or `deliver`, releases its tenant's site event, which
     * each owner registers at its `lags[owner]`-th position read after the release, the first by default.
     */
    const siteRegistry = (initial: readonly string[], lags: Readonly<Record<string, number>> = {}) => {
      const registries = new Map<string, Set<string>>();
      const deliveries: { tenantId: string; reads: Map<string, number> }[] = [];
      const of = (owner: string): Set<string> => {
        const registry = registries.get(owner) ?? new Set(initial);
        registries.set(owner, registry);
        return registry;
      };
      const deliver = (tenantId: string): void => {
        deliveries.push({ tenantId, reads: new Map() });
      };
      return {
        deliver,
        has: (owner: string, tenantId: string): boolean => of(owner).has(tenantId),
        read: (owner: string): string[] => {
          for (const { tenantId, reads } of deliveries) {
            const count = (reads.get(owner) ?? 0) + 1;
            reads.set(owner, count);
            if (count >= (lags[owner] ?? 1)) of(owner).add(tenantId);
          }
          return [...of(owner)];
        },
        onApply: (owner: string, request: ApplyRequest): void => {
          if (owner === 'programs-sites' && request.tenantId !== undefined && request.rows.some((row) => row.op !== 'delete')) deliver(request.tenantId);
        },
      };
    };

    it.each([
      ['added', { table: true as const }, undefined, 'fresh', LIVE, PARENTS_FIRST],
      ['deleted, in a whole-table window, while its owners still register it', { table: true as const }, 'gone', undefined, [...LIVE, GONE], CHILDREN_FIRST],
      ['deleted, in a window scoped to it, once its owners no longer register it', { keys: { siteid: 'gone' } }, 'gone', undefined, LIVE, CHILDREN_FIRST],
    ] as [string, ImportInput['scope'], string | undefined, string | undefined, string[], unknown[][]][])(
      'applies a site %s in dependency order: upserts parents first, deletes children first',
      async (_label, scope, held, live, registered, expected) => {
        const registry = siteRegistry(registered);
        const fake = fakeOwners(exportsWith(held), { registered: registry.read, onApply: registry.onApply });
        const result = await importWindow(contextOf({ legacy: legacyWith(live), owners: fake.owners }), windowInput(SITE_UNITS, scope));

        expect(fake.applies.map(({ owner, request }) => [owner, request.legacyTable, request.tenantId, request.rows.map((row) => row.op)])).toEqual(expected);
        expect(result.rowsImported).toBe(4);
      },
    );

    /** Each site table's primary key column and the key of `site`'s row in it. */
    const SITE_KEYS: [string, string, (site: string) => string | number][] = [
      ['tsettings', 'SiteID', (site) => site],
      ['tusers', 'UserID', (site) => `G-${site}`],
      ['tcontent', 'tcontent_ID', () => 1],
      ['tredirects', 'redirectID', (site) => `R-${site}`],
    ];
    /** Fingerprints of the site tables under `scope` holding `site`'s rows, or none of them. */
    const siteFingerprints = (site: string | undefined, scope: ExtractScope): WindowFingerprints => ({
      scope,
      elapsedMs: 1,
      tables: new Map(
        SITE_KEYS.map(([table, column, keyOf]): [string, TableFingerprint] => [
          table,
          { table, keyed: true, keyColumns: [column], rows: new Map(site === undefined ? [] : [[JSON.stringify([keyOf(site)]), { key: [keyOf(site)], hash: 'h' }]]) },
        ]),
      ),
    });

    it.each([
      ['in a whole-table window, while its owners still register it', { table: true as const }, [...LIVE, GONE]],
      ['in a window scoped to it, once its owners no longer register it', { keys: { siteid: 'gone' } }, LIVE],
    ] as [string, ImportInput['scope'], string[]][])('deletes a site deleted %s by the keys its row fingerprints lost, children first', async (_label, scope, registered) => {
      const fake = fakeOwners(exportsWith('gone'), { registered });
      const readFingerprints = vi.fn<FingerprintReader>(() => Promise.resolve(siteFingerprints(undefined, toExtractScope(scope))));
      const input = { ...windowInput(SITE_UNITS, scope), fingerprints: siteFingerprints('gone', toExtractScope(scope)), readFingerprints };
      const result = await importWindow(contextOf({ legacy: legacyWith(undefined), owners: fake.owners }), input);

      expect(fake.applies.map(({ owner, request }) => [owner, request.legacyTable, request.tenantId, request.rows.map((row) => row.op)])).toEqual(CHILDREN_FIRST);
      expect(result.rowsImported).toBe(4);
      expect(new Set(fake.exports.map(({ match }) => JSON.stringify(match)))).toEqual(new Set(SITE_KEYS.map(([, column, keyOf]) => JSON.stringify({ [column]: [keyOf('gone')] }))));
    });

    it('sends the steps after an added site only once every consumer of their events registered its tenant', async () => {
      // Site events reach people and strategies-content late, as when their delivery lags the group events'.
      const registry = siteRegistry(LIVE, { people: 3, 'strategies-content': 5 });
      const unregistered: string[][] = [];
      const fake = fakeOwners(exportsWith(undefined), {
        registered: registry.read,
        onApply: (owner, request) => {
          registry.onApply(owner, request);
          // A consumer dead-letters as invalid-tenant an event of a tenant its registry lacks.
          unregistered.push(CONSUMERS.filter((consumer) => !registry.has(consumer, request.tenantId ?? '')));
        },
      });
      const time = fakeTime();
      const ctx = contextOf({ legacy: legacyWith('fresh'), owners: fake.owners, clock: time.clock });
      await importWindow(ctx, windowInput(SITE_UNITS, { table: true }), { sleep: time.sleep });

      expect(applied(fake)).toEqual(PARENTS_FIRST);
      expect(unregistered).toEqual([CONSUMERS, [], [], []]);
      expect(time.slept).toEqual(Array.from({ length: 4 }, () => REGISTRATION_POLL_MS));
      expect(ctx.logger.info).toHaveBeenCalledWith(`window W1 waited ${String(4 * REGISTRATION_POLL_MS)} ms for ${CONSUMERS.join(', ')} to register new tenants ${FRESH}`);
    });

    it.each([
      ['never registers it', (registry: ReturnType<typeof siteRegistry>) => registry.read, ''],
      [
        'cannot be read',
        (registry: ReturnType<typeof siteRegistry>) => (owner: string) => {
          if (owner === 'people') throw new OwnerCallError('people', 'GET', '/internal/v1/migration/position', 503, { error: 'unavailable' });
          return registry.read(owner);
        },
        ' (',
      ],
    ] as const)('fails the attempt before any later step is sent when a consumer %s within the bound', async (_label, registeredOf, cause) => {
      const registry = siteRegistry(LIVE, { people: Number.POSITIVE_INFINITY });
      const fake = fakeOwners(exportsWith(undefined), { registered: registeredOf(registry), onApply: registry.onApply });
      const time = fakeTime();
      const ctx = contextOf({ legacy: legacyWith('fresh'), owners: fake.owners, clock: time.clock });
      const error = await importWindow(ctx, windowInput(SITE_UNITS, { table: true }), { sleep: time.sleep }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WindowImportError);
      expect(error).toMatchObject({ windowId: 'W1', owner: 'people', table: 'tsettings' });
      expect((error as Error).message).toContain(`people lacks ${FRESH}${cause}`);
      expect(applied(fake)).toEqual(PARENTS_FIRST.slice(0, 1));
      expect(time.slept.reduce((sum, ms) => sum + ms, 0)).toBe(REGISTRATION_WAIT_MS);
    });

    it('waits again on a retry that finds the site applied, for the tenant whose tsettings key the fingerprints gained', async () => {
      const registry = siteRegistry(LIVE, { people: 3 });
      // The failed attempt applied the site; people has not registered it yet.
      registry.deliver(FRESH);
      const unregistered: string[][] = [];
      const exports = { ...exportsWith(undefined), 'programs_sites.site': exportsWith('fresh')['programs_sites.site'] } as Record<string, UnitExportSpec>;
      const fake = fakeOwners(exports, {
        registered: registry.read,
        onApply: (_owner, request) => unregistered.push(CONSUMERS.filter((consumer) => !registry.has(consumer, request.tenantId ?? ''))),
      });
      const time = fakeTime();
      const scope = toExtractScope({ table: true });
      const readFingerprints = vi.fn<FingerprintReader>(() => Promise.resolve(siteFingerprints('fresh', scope)));
      const input = { ...windowInput(SITE_UNITS, { table: true }, 2), fingerprints: siteFingerprints(undefined, scope), readFingerprints };
      await importWindow(contextOf({ legacy: legacyWith('fresh'), owners: fake.owners, clock: time.clock }), input, { sleep: time.sleep });

      expect(applied(fake)).toEqual(PARENTS_FIRST.slice(1));
      expect(unregistered).toEqual([[], [], []]);
      expect(time.slept).toEqual([REGISTRATION_POLL_MS, REGISTRATION_POLL_MS]);
    });

    /** Fingerprints of the site tables holding tenant-a's rows before legacy executed and, after, without its Admin group. */
    const groupRemoved = (): Pick<ImportInput, 'fingerprints' | 'readFingerprints'> => {
      const before = siteFingerprints('tenant-a', 'table');
      const tables = new Map([...before.tables].map(([key, fingerprint]): [string, TableFingerprint] => [key, key === 'tusers' ? { ...fingerprint, keyed: true, keyColumns: ['UserID'], rows: new Map() } : fingerprint]));
      return { fingerprints: before, readFingerprints: () => Promise.resolve({ ...before, tables }) };
    };

    it.each([
      ['compared in full', {}, [['programs-sites', 'tsettings', TENANT_B, ['upsert']], ['identity', 'tusers', TENANT_A, ['delete']]], ['programs-sites', 'identity', 'strategies-content']],
      ['skipped as unchanged by its fingerprints', groupRemoved(), [['identity', 'tusers', TENANT_A, ['delete']]], ['identity']],
    ] as [string, Partial<ImportInput>, unknown[][], string[]][])('reads no other registry when the site table, %s, adds no site', async (_label, narrowing, expected, owners) => {
      // Legacy moved tenant-b's files to the umbrella pool and removed tenant-a's Admin group.
      const pools = Object.fromEntries(TSETTINGS.rows.map((row) => [String(row.SiteID), [{ ...text(row), filePoolID: row.SiteID === 'tenant-b' ? 'umbrella' : (row.filePoolID ?? null) }]]));
      const reads: string[] = [];
      const fake = fakeOwners(
        {
          ...exportsWith(undefined),
          'programs_sites.site': { legacyTable: 'tsettings', columns: [s('SiteID'), s('filePoolID')], rows: pools },
          'identity.group_account': exportsWith('tenant-a')['identity.group_account'] as UnitExportSpec,
        },
        {
          registered: (owner) => {
            reads.push(owner);
            return LIVE;
          },
        },
      );
      await importWindow(contextOf({ legacy: legacyWith(undefined), owners: fake.owners }), { ...windowInput(SITE_UNITS, { table: true }), ...narrowing });

      expect(applied(fake)).toEqual(expected);
      // Each compared step's owner, read once for the tenants its export is read in.
      expect(reads).toEqual(owners);
    });

    it.each([
      ['identity and strategies-content', ['content.content', 'identity.group_account', 'programs_sites.site'], CONSUMERS],
      ['people', ['people.person', 'programs_sites.site'], ['identity']],
      ['strategies-content alone, whose topics no consumer subscribes to', ['content.content', 'programs_sites.site'], []],
    ])('reads, when %s follow an added site, only the registries of consumers of the site topic and their topics', async (_label, units, consumers) => {
      const registry = siteRegistry(LIVE);
      // Registry reads after the site apply: the barrier's, then one per later step's owner.
      const reads: string[] = [];
      let siteApplied = false;
      const fake = fakeOwners(
        { ...exportsWith(undefined), 'people.person': { legacyTable: 'tusers', columns: [s('UserID'), s('SiteID')], rows: {} } },
        {
          registered: (owner) => {
            if (siteApplied) reads.push(owner);
            return registry.read(owner);
          },
          onApply: (owner, request) => {
            siteApplied ||= owner === 'programs-sites';
            registry.onApply(owner, request);
          },
        },
      );
      await importWindow(contextOf({ legacy: legacyWith('fresh'), owners: fake.owners }), windowInput(units, { table: true }));

      const later = units.map((unit) => loadUnitCatalog(loadConfig().paths.tableOwnership).ownerOf(unit)).filter((owner) => owner !== 'programs-sites');
      expect(reads.slice(0, consumers.length).sort()).toEqual(consumers);
      expect(reads.slice(consumers.length).sort()).toEqual(later.sort());
    });

    const GROUP_TOPIC = 'identity.group.changed.v1';
    /** Owners consuming the site topic and identity's group topic. */
    const GROUP_CONSUMERS = ['people', 'strategies-content'];
    /** Identity's topics that consumers of the site topic declare. */
    const IDENTITY_TOPICS = ['identity.group.changed.v1', 'identity.membership.changed.v1', 'identity.permission.changed.v1'];
    const capture = { owner: 'identity', query: { publishedTopics: IDENTITY_TOPICS, publishedAfter: '0', publishedLimit: 1 } };
    /** Identity's cursor held from before legacy executed, when its outbox was empty. */
    const HELD: PublishedCursors = new Map<DataOwner, string>([['identity', '0']]);

    /**
     * Owners exporting `exports` while legacy has deleted site `gone`: identity's group delete in its tenant publishes a group
     * event, `earlier` when an earlier attempt published it. Records the reads made before the first apply and, at each tsettings
     * apply, the group consumers yet to report their receipt of that event.
     */
    const deletingGone = (events: ReturnType<typeof fakeEvents>, exports = exportsWith('gone'), earlier?: OutboxEvent) => {
      const unreceived: string[][] = [];
      let published = earlier;
      let askedBefore: number | undefined;
      const fake = fakeOwners(exports, {
        registered: [...LIVE, GONE],
        events,
        onApply: (owner, request) => {
          askedBefore ??= events.asked.length;
          if (owner === 'identity' && request.legacyTable === 'tusers' && request.tenantId === GONE) published = events.publish('identity', GROUP_TOPIC, GONE);
          if (owner === 'programs-sites') unreceived.push(GROUP_CONSUMERS.filter((consumer) => !events.received(consumer, published?.eventId)));
        },
      });
      return { fake, unreceived, published: () => published, askedBefore: () => askedBefore };
    };
    const cursorsInput = (cursors: PublishedCursors | undefined, attempt = 1): ImportInput => ({
      ...windowInput(SITE_UNITS, { table: true }, attempt),
      ...(cursors === undefined ? {} : { publishedCursors: cursors }),
    });

    it.each([
      ['held from before legacy executed', HELD, []],
      ['taken at the attempt\'s start, before anything is sent', undefined, [capture]],
    ] as [string, PublishedCursors | undefined, unknown[]][])(
      'sends the tsettings delete only once the consumers of the site topic received the group delete in its tenant, with cursors %s',
      async (_label, cursors, before) => {
        // The group event reaches people and strategies-content late, as when the site event's delivery would overtake it.
        const events = fakeEvents({ people: 3, 'strategies-content': 5 });
        const { fake, unreceived, askedBefore } = deletingGone(events);
        const time = fakeTime();
        const ctx = contextOf({ legacy: legacyWith(undefined), owners: fake.owners, clock: time.clock });
        await importWindow(ctx, cursorsInput(cursors), { sleep: time.sleep });

        expect(applied(fake)).toEqual(CHILDREN_FIRST);
        expect(events.asked.slice(0, askedBefore())).toEqual(before);
        expect(unreceived).toEqual([[]]);
        expect(time.slept).toEqual(Array.from({ length: 4 }, () => DELETION_POLL_MS));
        expect(ctx.logger.info).toHaveBeenCalledWith(`window W1 waited ${String(4 * DELETION_POLL_MS)} ms for the receipts of 1 events in deleted tenants ${GONE}`);
      },
    );

    it.each([
      ['never reports its receipt', () => fakeEvents({ people: Number.POSITIVE_INFINITY }), ''],
      ['cannot be read', () => fakeEvents({}, ['people']), ' ('],
    ] as const)('sends no tsettings delete and fails the attempt naming the consumer and event when people %s within the bound', async (_label, eventsOf, cause) => {
      const { fake, published } = deletingGone(eventsOf());
      const time = fakeTime();
      const ctx = contextOf({ legacy: legacyWith(undefined), owners: fake.owners, clock: time.clock });
      const error = await importWindow(ctx, cursorsInput(HELD), { sleep: time.sleep }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WindowImportError);
      expect(error).toMatchObject({ windowId: 'W1', owner: 'people', table: 'tsettings' });
      expect((error as Error).message).toContain(`people lacks receipts of ${String(published()?.eventId)} (${GROUP_TOPIC}) in ${GONE}${cause}`);
      expect(applied(fake)).toEqual(CHILDREN_FIRST.slice(0, 3));
      expect(time.slept.reduce((sum, ms) => sum + ms, 0)).toBe(DELETION_WAIT_MS);
    });

    it.each([
      ['awaits the group event the failed attempt published, from the cursors held since before legacy executed', HELD, [], [DELETION_POLL_MS]],
      ['takes its cursors past that event when it holds none, awaiting only later ones', undefined, GROUP_CONSUMERS, []],
    ] as [string, PublishedCursors | undefined, string[], number[]][])('on a retry that finds only the site left to delete, %s', async (_label, cursors, unreceivedAtDelete, slept) => {
      const events = fakeEvents({ people: 2 });
      const earlier = events.publish('identity', GROUP_TOPIC, GONE);
      const exports = { ...exportsWith(undefined), 'programs_sites.site': exportsWith('gone')['programs_sites.site'] } as Record<string, UnitExportSpec>;
      const { fake, unreceived } = deletingGone(events, exports, earlier);
      const time = fakeTime();
      await importWindow(contextOf({ legacy: legacyWith(undefined), owners: fake.owners, clock: time.clock }), cursorsInput(cursors, 2), { sleep: time.sleep });

      expect(applied(fake)).toEqual(CHILDREN_FIRST.slice(3));
      expect(unreceived).toEqual([unreceivedAtDelete]);
      expect(time.slept).toEqual(slept);
    });

    it.each([
      ['a site add, with cursors held', SITE_UNITS, 'fresh', undefined, HELD],
      ['deletes of a site\'s rows in a window without the site unit', ['content.content', 'identity.group_account', 'identity.redirect'], undefined, 'gone', undefined],
    ] as [string, string[], string | undefined, string | undefined, PublishedCursors | undefined][])(
      'lists no published event and reads no receipt for %s',
      async (_label, units, live, held, cursors) => {
        const events = fakeEvents();
        const registry = siteRegistry([...LIVE, GONE]);
        const fake = fakeOwners(exportsWith(held), { registered: registry.read, onApply: registry.onApply, events });
        const input = { ...windowInput(units, { table: true }), ...(cursors === undefined ? {} : { publishedCursors: cursors }) };
        await importWindow(contextOf({ legacy: legacyWith(live), owners: fake.owners }), input);

        expect(fake.applies.length).toBeGreaterThan(0);
        expect(events.asked).toEqual([]);
      },
    );

  });

  it('wraps a legacy SQL failure in WindowImportError', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS });
    const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT });
    const error = await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['people.person_archive'], { table: true })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WindowImportError);
    expect(error).toMatchObject({ windowId: 'W1', table: 'synthetic.person_archive' });
  });

  it('places a child row in its parent client\'s tenant', async () => {
    const clients: TableSpec = {
      columns: [varchar('clientid', 35), varchar('siteid', 25), varchar('name')],
      primaryKey: ['clientid'],
      rows: [
        { clientid: 'C1', siteid: 'tenant-a', name: 'Portal' },
        { clientid: 'C4', siteid: 'tenant-b', name: 'Partner' },
      ],
    };
    const tokens: TableSpec = {
      columns: [varchar('token', 35), varchar('clientid', 35), varchar('granttype')],
      primaryKey: ['token'],
      rows: [
        { token: 'T10', clientid: 'C1', granttype: 'client_credentials' },
        { token: 'T11', clientid: 'C4', granttype: 'authorization_code' },
      ],
    };
    const fake = fakeOwners({
      'identity.oauth_token': {
        legacyTable: 'toauthtokens',
        columns: [s('token'), s('clientid'), s('granttype')],
        rows: { 'tenant-b': [{ token: 'T11', clientid: 'C4', granttype: 'password' }] },
      },
    });
    const { legacy, db } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.toauthclients': clients, 'dbo.toauthtokens': tokens });
    await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['identity.oauth_token'], { keys: { siteid: 'tenant-a' } }));

    expect(fake.appliedRows().map(({ op, tenantId, values }) => [tenantId, op, values.token, values.granttype])).toEqual(
      [
        [TENANT_A, 'upsert', 'T10', 'client_credentials'],
        [TENANT_B, 'upsert', 'T11', 'authorization_code'],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(db.queries.some((query) => query.includes('FROM [dbo].[toauthclients] WHERE [clientid] IN'))).toBe(true);
  });

  it('sends a parent-typed split row to its owner with the parent type as discriminator', async () => {
    const users: TableSpec = {
      columns: [varchar('UserID', 35), int('Type'), varchar('SiteID', 25)],
      primaryKey: ['UserID'],
      rows: [
        { UserID: 'G1', Type: 1, SiteID: 'tenant-a' },
        { UserID: 'U1', Type: 2, SiteID: 'tenant-a' },
      ],
    };
    const interests: TableSpec = {
      columns: [varchar('userID', 35), varchar('categoryID', 35)],
      primaryKey: ['userID', 'categoryID'],
      rows: [
        { userID: 'G1', categoryID: 'C2' },
        { userID: 'U1', categoryID: 'C1' },
      ],
    };
    const fake = fakeOwners({
      'people.user_interest': { legacyTable: 'tusersinterests', columns: [s('userID'), s('categoryID')], rows: { 'tenant-a': [] } },
    });
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.tusers': users, 'dbo.tusersinterests': interests });
    await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['people.user_interest'], { table: true }));

    expect(fake.appliedRows().map(({ owner, op, discriminator, tenantId, values }) => ({ owner, op, discriminator, tenantId, ...values }))).toEqual([
      { owner: 'people', op: 'upsert', discriminator: 2, tenantId: TENANT_A, userID: 'U1', categoryID: 'C1' },
    ]);
  });

  it('folds Program_<id> tables into per-program batches in each program\'s site tenant', async () => {
    const enrolment = (enrolmentId: number, cohortId: number) => ({ enrolment_id: enrolmentId, cohort_id: cohortId });
    const enrolmentSpec = (rows: Row[]): TableSpec => ({ columns: [int('enrolment_id'), int('cohort_id')], primaryKey: ['enrolment_id'], rows });
    const fake = fakeOwners({
      [UNITS.enrolment]: {
        legacyTable: 'enrolment',
        columns: [i('enrolment_id'), i('cohort_id')],
        rows: {
          'tenant-a': [{ enrolment_id: '1', cohort_id: '8', [PROGRAM]: '1' }],
          'tenant-b': [{ enrolment_id: '1', cohort_id: '6', [PROGRAM]: '2' }],
        },
      },
    });
    const { legacy } = fakeLegacy({
      'dbo.tsettings': TSETTINGS,
      'synthetic.program_site': { columns: [int('program_id'), varchar('siteID', 25)], primaryKey: ['program_id'], rows: [{ program_id: 1, siteID: 'tenant-a' }, { program_id: 2, siteID: 'tenant-b' }] },
      'Program_1.enrolment': enrolmentSpec([enrolment(1, 7), enrolment(2, 4)]),
      'Program_2.enrolment': enrolmentSpec([enrolment(1, 6)]),
    });
    await importWindow(contextOf({ legacy, owners: fake.owners, fixture: true }), windowInput([UNITS.enrolment], { table: true }));

    expect(fake.applies.map(({ request }) => [request.tenantId, request.legacyProgramId, request.legacyTable, request.columns])).toEqual([
      [TENANT_A, 1, 'enrolment', [i('enrolment_id'), i('cohort_id')]],
    ]);
    expect(fake.appliedRows().map(({ op, values }) => [op, values.enrolment_id, values.cohort_id])).toEqual([
      ['upsert', '1', '7'],
      ['upsert', '2', '4'],
    ]);
  });

  it('compares the whole table when the owner does not export the scope column', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': ARCHIVE_TABLE });
    const drop = (rows: Row[] = []) => rows.map(({ siteID: _site, ...rest }) => rest);
    const fake = fakeOwners({
      'people.person_archive': {
        ...ARCHIVE_EXPORT,
        columns: [i('archive_id'), s('archived_by')],
        rows: { 'tenant-a': drop(ARCHIVE_EXPORT.rows?.['tenant-a']), 'tenant-b': drop(ARCHIVE_EXPORT.rows?.['tenant-b']) },
      },
    });
    const ctx = contextOf({ legacy, owners: fake.owners });
    await importWindow(ctx, windowInput(['people.person_archive'], { keys: { siteid: 'tenant-a' } }));

    expect(fake.appliedRows().map(({ tenantId, op, values }) => [tenantId === TENANT_A ? 'a' : 'b', op, values.archive_id])).toEqual(
      expect.arrayContaining([
        ['a', 'upsert', '1'],
        ['a', 'delete', '2'],
        ['a', 'upsert', '3'],
        ['b', 'upsert', '4'],
      ]),
    );
    expect(fake.appliedRows()).toHaveLength(4);
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('compares all of synthetic.person_archive'));
  });

  describe('a table split by object class', () => {
    const trash = (rows: Row[]): TableSpec => ({
      columns: [varchar('objectID', 35), varchar('siteID', 25), varchar('objectClass'), varchar('objectLabel')],
      primaryKey: ['objectID'],
      rows,
    });
    const trashExport = (rows: Row[]): UnitExportSpec => ({ legacyTable: 'ttrash', columns: [s('objectID'), s('siteID'), s('objectClass'), s('objectLabel')], rows: { 'tenant-a': rows } });
    const item = (objectID: string, objectClass: string, objectLabel = objectID) => ({ objectID, siteID: 'tenant-a', objectClass, objectLabel });

    it('sends a statically owned class to its owner with the owner as discriminator', async () => {
      const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.ttrash': trash([item('O1', 'content'), item('O2', 'group'), item('O3', 'user')]) });
      const fake = fakeOwners({ 'content.trash': trashExport([]) });
      await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['content.trash'], { keys: { siteid: 'tenant-a' } }));
      expect(fake.appliedRows().map(({ op, discriminator, values }) => [op, discriminator, values.objectID])).toEqual([['upsert', 'strategies-content', 'O1']]);
    });

    it('updates a held row whose owner depends on stored data, and fails closed on a new one', async () => {
      const held = fakeOwners({ 'people.trash': trashExport([item('U1', 'user', 'old')]) });
      const live = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.ttrash': trash([item('U1', 'user', 'new')]) });
      await importWindow(contextOf({ legacy: live.legacy, owners: held.owners }), windowInput(['people.trash'], { keys: { siteid: 'tenant-a' } }));
      expect(held.appliedRows().map(({ op, discriminator, values }) => [op, discriminator, values.objectLabel])).toEqual([['upsert', 'people', 'new']]);

      const fresh = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.ttrash': trash([item('U2', 'user')]) });
      const error = await importWindow(contextOf({ legacy: fresh.legacy, owners: fakeOwners({ 'people.trash': trashExport([]) }).owners }), windowInput(['people.trash'], { table: true })).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(WindowImportError);
      expect(error).toMatchObject({ table: 'ttrash' });
    });
  });

  it('reports touched content when tcontent is imported', async () => {
    const content: TableSpec = {
      columns: [int('tcontent_ID'), varchar('SiteID', 25), varchar('Title')],
      primaryKey: ['tcontent_ID'],
      rows: [{ tcontent_ID: 7, SiteID: 'tenant-a', Title: 'Home' }],
    };
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.tcontent': content });
    const fake = fakeOwners({ 'content.content': { legacyTable: 'tcontent', columns: [i('tcontent_ID'), s('SiteID'), s('Title')], rows: { 'tenant-a': [] } } });
    const result = await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['content.content'], { keys: { siteid: 'tenant-a' } }));
    expect(result.touchedContent).toBe(true);
    expect(fake.appliedRows().map(({ op, owner, values }) => [owner, op, values.Title])).toEqual([['strategies-content', 'upsert', 'Home']]);
  });

  it('transfers a new _small rendition to strategies-content with its SHA-256', async () => {
    const original = Buffer.from('original-bytes');
    const source = Buffer.from('source-bytes');
    const small = Buffer.from('small-rendition-bytes');
    const files: TableSpec = {
      columns: [varchar('fileID', 35), varchar('siteID', 25), varchar('contentType'), varchar('contentSubType'), varchar('fileExt')],
      primaryKey: ['fileID'],
      rows: [{ fileID: FILE_1, siteID: 'umbrella', contentType: 'image', contentSubType: 'jpeg', fileExt: 'jpg' }],
    };
    const keyOf = (fileId: string, variant: '' | '_source' | '_small', ext: string) => objectKey(UMBRELLA, fileId, variant, ext);
    const fake = fakeOwners({
      'content.file': {
        legacyTable: 'tfiles',
        columns: [s('fileID')],
        objects: {
          umbrella: [
            { key: keyOf(FILE_1, '', 'jpg'), size: original.byteLength, sha256: sha(original), legacyPath: `umbrella/cache/file/${FILE_1}.jpg` },
            { key: keyOf(FILE_1, '_source', 'jpg'), size: source.byteLength, sha256: sha(source), legacyPath: `umbrella/cache/file/${FILE_1}_source.jpg` },
          ],
        },
      },
    });
    const { bridge, gets } = fakeBridge({
      umbrella: {
        files: [
          { name: `${FILE_1}.jpg`, bytes: original },
          { name: `${FILE_1}_source.jpg`, bytes: source },
          { name: `${FILE_1}_small.jpg`, bytes: small },
        ],
      },
    });
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.tfiles': files });
    const result = await importWindow(contextOf({ legacy, owners: fake.owners, bridge }), windowInput(['content.file_object'], { keys: { siteid: 'tenant-a' } }));

    expect(gets).toEqual([`umbrella/${FILE_1}_small.jpg`]);
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]?.params).toEqual({ tenantId: UMBRELLA, fileId: FILE_1, variant: '_small', ext: 'jpg', contentType: 'image/jpeg', sha256: sha(small) });
    expect(fake.puts[0]?.bytes.equals(small)).toBe(true);
    expect(fake.puts[0]?.size).toBe(small.byteLength);
    expect(result).toMatchObject({ objectsTransferred: 1, objectsRemoved: [], rowsImported: 0 });
    expect(fake.deletes).toEqual([]);
    expect(result.writePositions.get('strategies-content')).toBe('900');
  });

  describe('objects whose legacy file is gone', () => {
    const FILE_3 = 'C1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
    const FILE_4 = 'D1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
    const FILE_5 = 'E1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
    const FILE_6 = 'F1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
    const GONE = tenantIdForSite('gone');
    const original = Buffer.from('original-bytes');
    const orphanCopy = Buffer.from('orphan-copy-bytes');
    const fileRow = (fileID: string, siteID: string) => ({ fileID, siteID, contentType: 'image', contentSubType: 'png', fileExt: 'png' });
    // FILE_2 and FILE_3 have no row, so their objects are orphans under the umbrella tenant.
    const files: TableSpec = {
      columns: [varchar('fileID', 35), varchar('siteID', 25), varchar('contentType'), varchar('contentSubType'), varchar('fileExt')],
      primaryKey: ['fileID'],
      rows: [{ ...fileRow(FILE_1, 'umbrella'), contentSubType: 'jpeg', fileExt: 'jpg' }, fileRow(FILE_4, 'tenant-b'), fileRow(FILE_5, 'tenant-b')],
    };
    const keys = {
      original: objectKey(UMBRELLA, FILE_1, '', 'jpg'),
      rendition: objectKey(UMBRELLA, FILE_1, '_medium', 'jpg'),
      orphan: objectKey(UMBRELLA, FILE_2, '', 'png'),
      orphanElsewhere: objectKey(UMBRELLA, FILE_3, '', 'png'),
      movedRow: objectKey(UMBRELLA, FILE_4, '', 'png'),
      tenantB: objectKey(TENANT_B, FILE_5, '', 'png'),
      // An object of site "gone", which legacy deleted with its tfiles rows and store directory.
      gone: objectKey(GONE, FILE_6, '', 'png'),
    };
    const entry = (key: string, bytes: Buffer): ObjectManifestEntry => ({ key, size: bytes.byteLength, sha256: sha(bytes) });
    const setup = (options: Parameters<typeof fakeOwners>[1] = {}) => {
      const fake = fakeOwners(
        {
          'content.file': {
            legacyTable: 'tfiles',
            columns: [s('fileID')],
            objects: {
              umbrella: [
                entry(keys.original, original),
                entry(keys.rendition, Buffer.from('medium')),
                entry(keys.orphan, Buffer.from('orphan')),
                entry(keys.orphanElsewhere, orphanCopy),
                entry(keys.movedRow, Buffer.from('moved')),
              ],
              'tenant-b': [entry(keys.tenantB, Buffer.from('b'))],
              gone: [entry(keys.gone, Buffer.from('gone'))],
            },
          },
        },
        options,
      );
      const { bridge } = fakeBridge({
        umbrella: { files: [{ name: `${FILE_1}.jpg`, bytes: original }] },
        'tenant-b': { files: [{ name: `${FILE_3}.png`, bytes: orphanCopy }] },
      });
      const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.tfiles': files });
      return { fake, ctx: contextOf({ legacy, owners: fake.owners, bridge }) };
    };

    // A key is kept while a directory left unlisted could still hold its file; one no directory can produce goes at once.
    it.each([
      ['a window scoped to tenant-a and its umbrella pool', { keys: { siteid: 'tenant-a' } }, [keys.rendition, keys.movedRow], []],
      ['a window scoped to tenant-b', { keys: { siteid: 'tenant-b' } }, [keys.movedRow, keys.tenantB], []],
      ['a whole-store window', { table: true as const }, [keys.rendition, keys.orphan, keys.movedRow, keys.tenantB], []],
      [
        'a window scoped to tenant-a while the owner registers deleted site "gone"',
        { keys: { siteid: 'tenant-a' } },
        [keys.rendition, keys.movedRow, keys.gone],
        [...TSETTINGS.rows.map((row) => tenantIdForSite(String(row.SiteID))), GONE],
      ],
    ])('deletes through strategies-content only what %s rules out', async (_label, scope, deleted, registered) => {
      const { fake, ctx } = setup({ registered });
      const result = await importWindow(ctx, windowInput(['content.file_object'], scope));

      expect(fake.deletes.toSorted()).toEqual(deleted.toSorted());
      expect(result).toMatchObject({ objectsTransferred: 0, objectsRemoved: deleted.toSorted() });
      expect(result.writePositions.get('strategies-content')).toBe('950');
    });

    it('counts no object the owner had already deleted', async () => {
      const { fake, ctx } = setup({ absentKeys: [keys.orphan] });
      const result = await importWindow(ctx, windowInput(['content.file_object'], { table: true }));

      expect(fake.deletes).toContain(keys.orphan);
      expect(result.objectsRemoved).toEqual([keys.rendition, keys.movedRow, keys.tenantB].toSorted());
    });

    it('fails the attempt with WindowImportError when a delete fails', async () => {
      const refused = new OwnerCallError('strategies-content', 'DELETE', '/internal/v1/migration/objects', 503, { error: 'unavailable' });
      const { ctx } = setup({ failDelete: refused });
      const error = await importWindow(ctx, windowInput(['content.file_object'], { table: true })).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WindowImportError);
      expect(error).toMatchObject({ owner: 'strategies-content', table: 'tfiles', cause: refused });
    });
  });

  it('reads the tfiles rows of the listed files only', async () => {
    const bytes = Buffer.from('png-bytes');
    const fileRow = (fileID: string) => ({ fileID, siteID: 'tenant-b', contentType: 'image', contentSubType: 'png', fileExt: 'png' });
    const files: TableSpec = {
      columns: [varchar('fileID', 35), varchar('siteID', 25), varchar('contentType'), varchar('contentSubType'), varchar('fileExt')],
      primaryKey: ['fileID'],
      rows: [fileRow(FILE_1), fileRow(FILE_2)],
    };
    const { bridge } = fakeBridge({ 'tenant-b': { files: [{ name: `${FILE_1}.png`, bytes }, { name: `${FILE_1}_small.png`, bytes }, { name: 'readme.txt', bytes }] } });
    const { legacy, db } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.tfiles': files });
    const fake = fakeOwners({ 'content.file': { legacyTable: 'tfiles', columns: [s('fileID')] } });
    await importWindow(contextOf({ legacy, owners: fake.owners, bridge }), windowInput(['content.file_object'], { keys: { siteid: 'tenant-b' } }));

    expect(db.queries.filter((query) => query.includes('[tfiles]'))).toEqual([
      'SELECT [fileID] AS [k], [siteID] AS [v0], [contentType] AS [v1], [contentSubType] AS [v2], [fileExt] AS [v3] FROM [dbo].[tfiles] WHERE [fileID] IN (@p0)',
    ]);
    expect(fake.puts.map(({ params }) => [params.tenantId, params.fileId, params.variant, params.contentType])).toEqual([
      [TENANT_B, FILE_1, '', 'image/png'],
      [TENANT_B, FILE_1, '_small', 'image/png'],
    ]);
  });

  describe('object spool', () => {
    const listed = Buffer.from('png-bytes');
    const changed = Buffer.from('changed-png-bytes');
    const files: TableSpec = {
      columns: [varchar('fileID', 35), varchar('siteID', 25), varchar('contentType'), varchar('contentSubType'), varchar('fileExt')],
      primaryKey: ['fileID'],
      rows: [{ fileID: FILE_1, siteID: 'tenant-b', contentType: 'image', contentSubType: 'png', fileExt: 'png' }],
    };
    const ownerFailure = new OwnerCallError('strategies-content', 'POST', '/internal/v1/migration/objects', 503, {});
    let spoolParent: string;

    beforeEach(async () => {
      spoolParent = await mkdtemp(join(tmpdir(), 'windows-import-spool-'));
      vi.stubEnv('TMPDIR', spoolParent);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await rm(spoolParent, { recursive: true, force: true });
    });

    it.each<{ label: string; served?: Buffer; failPut?: Error; puts: number; expected: (outcome: unknown) => void }>([
      { label: 'the object is stored', puts: 1, expected: (outcome) => expect(outcome).toMatchObject({ objectsTransferred: 1 }) },
      {
        label: 'the bytes read differ from the listing, sending nothing',
        served: changed,
        puts: 0,
        expected: (outcome) => {
          expect(outcome).toBeInstanceOf(WindowImportError);
          expect((outcome as Error).message).toBe(
            `window W1 import of tfiles failed: legacy file tenant-b/cache/file/${FILE_1}.png hashes to ${sha(changed)}, not its listing's ${sha(listed)}`,
          );
        },
      },
      {
        label: 'the owner fails the upload',
        failPut: ownerFailure,
        puts: 1,
        expected: (outcome) => expect(outcome).toMatchObject({ name: 'WindowImportError', owner: 'strategies-content', cause: ownerFailure }),
      },
    ])('leaves no spool behind when $label', async ({ served, failPut, puts, expected }) => {
      const { bridge, spools } = fakeBridge({ 'tenant-b': { files: [{ name: `${FILE_1}.png`, bytes: listed, ...(served === undefined ? {} : { served }) }] } });
      const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.tfiles': files });
      const fake = fakeOwners({ 'content.file': { legacyTable: 'tfiles', columns: [s('fileID')] } }, failPut === undefined ? {} : { failPut });

      const outcome = await importWindow(contextOf({ legacy, owners: fake.owners, bridge }), windowInput(['content.file_object'], { keys: { siteid: 'tenant-b' } })).catch(
        (caught: unknown) => caught,
      );

      expected(outcome);
      expect(fake.puts).toHaveLength(puts);
      expect(spools).toEqual([[expect.stringMatching(/^opt2-file-spool-/)]]);
      expect(await readdir(spoolParent)).toEqual([]);
    });
  });

  it('lets UnsupportedFileStoreError through unwrapped', async () => {
    const files: TableSpec = { columns: [varchar('fileID', 35), varchar('siteID', 25), varchar('contentType'), varchar('contentSubType'), varchar('fileExt')], primaryKey: ['fileID'], rows: [] };
    const { bridge } = fakeBridge({ 'tenant-b': { fileStore: 's3', files: [] } });
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'dbo.tfiles': files });
    const fake = fakeOwners({});
    const error = await importWindow(contextOf({ legacy, owners: fake.owners, bridge }), windowInput(['content.file_object'], { keys: { siteid: 'tenant-b' } })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedFileStoreError);
    expect(error).not.toBeInstanceOf(WindowImportError);
  });

  it('rejects a unit the catalog does not know', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS });
    const error = await importWindow(contextOf({ legacy, owners: fakeOwners({}).owners }), windowInput(['nobody.nothing'], { table: true })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WindowImportError);
    expect((error as WindowImportError).cause).toBeInstanceOf(UnknownUnitError);
  });
});

describe('importWindow with row fingerprints from before legacy executed', () => {
  const SCOPE: ImportInput['scope'] = { keys: { siteid: 'tenant-a' } };
  const ARCHIVE = 'synthetic.person_archive';

  /** A keyed archive fingerprint of `rows`, each a key and its hash, by `keyColumn`. */
  const archivePrint = (rows: [number | string, string][], keyColumn = 'archive_id'): TableFingerprint => ({
    table: ARCHIVE,
    keyed: true,
    keyColumns: [keyColumn],
    rows: new Map(rows.map(([key, hash]) => [JSON.stringify([key]), { key: [key], hash }])),
  });
  const printsOf = (scope: ExtractScope, tables: Record<string, TableFingerprint>): WindowFingerprints => ({ scope, tables: new Map(Object.entries(tables)), elapsedMs: 7 });
  const after = (tables: Record<string, TableFingerprint>) => vi.fn<FingerprintReader>((_ctx, _tables, scope) => Promise.resolve(printsOf(scope, tables)));
  const infoLines = (ctx: WindowImportContext): unknown[] => vi.mocked(ctx.logger.info).mock.calls.map(([line]) => line);
  /** What the attempt applied, as tenant, op and archive id, sorted. */
  const appliedOf = (fake: ReturnType<typeof fakeOwners>): string[][] =>
    fake
      .appliedRows()
      .map(({ tenantId, op, values }) => [tenantId === TENANT_A ? 'a' : tenantId === TENANT_B ? 'b' : String(tenantId), op, String(values.archive_id)])
      .sort((x, y) => x.join().localeCompare(y.join()));

  /** The archive window over ARCHIVE_TABLE and ARCHIVE_EXPORT without fingerprints, as every case below must still apply it. */
  const TODAY = [
    ['a', 'delete', '2'],
    ['a', 'upsert', '1'],
    ['a', 'upsert', '3'],
  ];

  it.each([
    ['people.person_archive', ARCHIVE, { 'synthetic.person_archive': ARCHIVE_TABLE }, false],
    ['content.content', 'tcontent', { 'dbo.tcontent': { columns: [int('tcontent_ID'), varchar('SiteID', 25), varchar('Title')], primaryKey: ['tcontent_ID'], rows: [{ tcontent_ID: 7, SiteID: 'tenant-a', Title: 'Home' }] } }, true],
  ] as [string, string, Record<string, TableSpec>, boolean][])(
    'skips %s, whose rows kept their fingerprints, without reading legacy or the owner, keeping its touched-content report and returning the fingerprints read',
    async (unit, table, tables, touchedContent) => {
      const { legacy, db } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, ...tables });
      const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT });
      const print = { ...archivePrint([[1, 'a']]), table };
      const readFingerprints = after({ [table]: print });
      const ctx = contextOf({ legacy, owners: fake.owners });
      const result = await importWindow(ctx, { ...windowInput([unit], SCOPE), fingerprints: printsOf(toExtractScope(SCOPE), { [table]: print }), readFingerprints });

      expect(readFingerprints).toHaveBeenCalledWith(ctx, [table], toExtractScope(SCOPE));
      expect(fake.exports).toEqual([]);
      expect(fake.applies).toEqual([]);
      expect(db.queries).toEqual([]);
      expect(result).toMatchObject({ rowsImported: 0, touchedContent });
      expect(result.fingerprints).toBe(await readFingerprints.mock.results[0]?.value);
      expect(infoLines(ctx)).toContainEqual(
        expect.stringMatching(/^window W1 skipped 1 unchanged tables, narrowed 0 to their changed keys and compared 0 whole; row fingerprints took 7 ms before and \d+ ms after legacy executed$/),
      );
    },
  );

  it('reads both sides of a changed table only at its changed keys, finding a row moved out of scope on each side', async () => {
    const moved: TableSpec = { ...ARCHIVE_TABLE, rows: [...ARCHIVE_TABLE.rows, { archive_id: 6, siteID: 'tenant-b', archived_by: 'Moved', archived_by_id: 'x' }] };
    const held = ARCHIVE_EXPORT.rows?.['tenant-a'] ?? [];
    const exported: UnitExportSpec = { ...ARCHIVE_EXPORT, rows: { ...ARCHIVE_EXPORT.rows, 'tenant-a': [...held, { archive_id: '6', siteID: 'tenant-a', archived_by: 'Moved' }] } };
    const { legacy, db } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': moved });
    const fake = fakeOwners({ 'people.person_archive': exported }, { honourMatch: true });
    const before = archivePrint([[1, 'a'], [2, 'b'], [5, 'e'], [6, 'f']]);
    const ctx = contextOf({ legacy, owners: fake.owners });
    await importWindow(ctx, { ...windowInput(['people.person_archive'], SCOPE), fingerprints: printsOf(toExtractScope(SCOPE), { [ARCHIVE]: before }), readFingerprints: after({ [ARCHIVE]: archivePrint([[1, 'A'], [3, 'c'], [5, 'e']]) }) });

    expect(appliedOf(fake)).toEqual([...TODAY, ['a', 'delete', '6'], ['b', 'upsert', '6']].sort((x, y) => x.join().localeCompare(y.join())));
    expect(new Set(fake.exports.map(({ match }) => JSON.stringify(match)))).toEqual(new Set([JSON.stringify({ archive_id: [1, 2, 6, 3] })]));
    expect(db.queries.filter((query) => query.includes('FROM [synthetic].[person_archive]'))).toEqual([
      expect.stringContaining('FROM [synthetic].[person_archive] WHERE ([archive_id] IN (@p0, @p1, @p2, @p3))'),
    ]);
    expect(infoLines(ctx)).toContainEqual(expect.stringContaining('skipped 0 unchanged tables, narrowed 1 to their changed keys and compared 0 whole'));
  });

  it.each([true, false])('splits changed keys too long for one match into several narrow export reads per tenant, honoured match %s', async (honourMatch) => {
    const added = Array.from({ length: 1500 }, (_, index) => 1000 + index);
    const archive: TableSpec = { ...ARCHIVE_TABLE, rows: added.map((id) => ({ archive_id: id, siteID: 'tenant-a', archived_by: 'New', archived_by_id: 'x' })) };
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': archive });
    const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT }, { honourMatch });
    const prints = { fingerprints: printsOf(toExtractScope(SCOPE), { [ARCHIVE]: archivePrint([[2, 'b']]) }), readFingerprints: after({ [ARCHIVE]: archivePrint(added.map((id) => [id, 'n'])) }) };
    await importWindow(contextOf({ legacy, owners: fake.owners }), { ...windowInput(['people.person_archive'], SCOPE), ...prints });

    const tenantA = fake.exports.filter(({ tenantId }) => tenantId === TENANT_A);
    expect(tenantA.length).toBeGreaterThan(1);
    for (const { match } of tenantA) expect(JSON.stringify(match).length).toBeLessThanOrEqual(MAX_EXPORT_MATCH_LENGTH);
    expect(tenantA.flatMap(({ match }) => match?.archive_id ?? [])).toEqual([2, ...added]);
    expect(fake.appliedRows().map(({ op }) => op).sort()).toEqual(['delete', ...added.map(() => 'upsert')]);
    expect(fake.appliedRows().filter(({ op }) => op === 'delete').map(({ values }) => values.archive_id)).toEqual(['2']);
  });

  it.each([
    ['no fingerprints', undefined],
    ['fingerprints taken under another scope', printsOf('table', { [ARCHIVE]: archivePrint([[1, 'a']]) })],
  ] as [string, WindowFingerprints | undefined][])('compares every table under the window scope with %s', async (_label, fingerprints) => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': ARCHIVE_TABLE });
    const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT });
    const readFingerprints = after({});
    const ctx = contextOf({ legacy, owners: fake.owners });
    const result = await importWindow(ctx, { ...windowInput(['people.person_archive'], SCOPE), ...(fingerprints === undefined ? {} : { fingerprints }), readFingerprints });

    expect(readFingerprints).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('fingerprints');
    expect(appliedOf(fake)).toEqual(TODAY);
    expect(new Set(fake.exports.map(({ match }) => JSON.stringify(match)))).toEqual(new Set([JSON.stringify({ siteID: ['tenant-a'] })]));
    expect(infoLines(ctx)).not.toContainEqual(expect.stringContaining('unchanged tables'));
  });

  it('compares every table in full when reading the fingerprints after legacy executed fails', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': ARCHIVE_TABLE });
    const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT });
    const failure = new Error('Login failed for user');
    const ctx = contextOf({ legacy, owners: fake.owners });
    const result = await importWindow(ctx, {
      ...windowInput(['people.person_archive'], SCOPE),
      fingerprints: printsOf(toExtractScope(SCOPE), { [ARCHIVE]: archivePrint([[1, 'a']]) }),
      readFingerprints: () => Promise.reject(failure),
    });

    expect(appliedOf(fake)).toEqual(TODAY);
    expect(result.rowsImported).toBe(3);
    expect(result).not.toHaveProperty('fingerprints');
    expect(ctx.logger.warn).toHaveBeenCalledWith({ error: expect.objectContaining({ type: 'Error' }) }, 'window W1 compares every table in full: reading its row fingerprints failed');
  });

  it('reads a table under the window scope when its owner does not export the column its changed keys were found by', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.person_archive': ARCHIVE_TABLE });
    const fake = fakeOwners({ 'people.person_archive': ARCHIVE_EXPORT });
    const ctx = contextOf({ legacy, owners: fake.owners });
    // The live archived_by_id column, which the owner's export lacks, has the fewest values among the changed rows.
    const prints = { fingerprints: printsOf(toExtractScope(SCOPE), { [ARCHIVE]: archivePrint([], 'archived_by_id') }), readFingerprints: after({ [ARCHIVE]: archivePrint([['x', 'n']], 'archived_by_id') }) };
    await importWindow(ctx, { ...windowInput(['people.person_archive'], SCOPE), ...prints });

    expect(appliedOf(fake)).toEqual(TODAY);
    expect(fake.exports[0]?.match).toEqual({ archived_by_id: ['x'] });
    expect(new Set(fake.exports.slice(1).map(({ match }) => JSON.stringify(match)))).toEqual(new Set([JSON.stringify({ siteID: ['tenant-a'] })]));
    expect(infoLines(ctx)).toContainEqual(expect.stringContaining('narrowed 0 to their changed keys and compared 1 whole'));
  });
});
