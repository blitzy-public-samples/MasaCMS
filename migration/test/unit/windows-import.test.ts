// Unit tests for the window import over a scripted legacy SQL Server, fake owners and a fake bridge.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { Logger } from '@opt2/platform/logging';
import { decodeRow, encodeRow, type ApplyRequest, type CanonicalColumn, type ExportResponse, type ObjectManifestEntry } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import type { ConnectionPool } from 'mssql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { clearCatalogCache, compareKeyValues, type KeyValue } from '../../src/extract/index.js';
import { objectKey, type StoredVariant } from '../../src/files/index.js';
import { UnsupportedFileStoreError, type BridgeClient, type FileListing, type LegacyDb, type LegacyFileEntry } from '../../src/legacy/index.js';
import { OwnerCallError, UnknownUnitError, loadUnitCatalog, type OwnersClient, type PutObjectParams } from '../../src/owners/index.js';
import {
  WindowImportError,
  importWindow,
  toExtractScope,
  windowBatchId,
  type ImportInput,
  type WindowImportContext,
} from '../../src/windows/import.js';

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

/** Fake owners: exports served per unit and tenant in pages of two rows; applies and object uploads recorded. */
function fakeOwners(units: Record<string, UnitExportSpec>, options: { failApply?: Error } = {}) {
  const applies: { owner: string; request: ApplyRequest }[] = [];
  const puts: { params: PutObjectParams; bytes: Uint8Array }[] = [];
  let xid = 100;
  const siteOf = (tenantId: string, spec: UnitExportSpec | undefined): string | undefined =>
    Object.keys({ ...spec?.rows, ...spec?.objects }).find((site) => tenantIdForSite(site) === tenantId);
  async function* exportPages(_owner: string, params: { unit: string; tenantId: string }): AsyncGenerator<ExportResponse> {
    await Promise.resolve();
    const spec = units[params.unit];
    const site = spec === undefined ? undefined : siteOf(params.tenantId, spec);
    const rows = (site === undefined ? [] : (spec?.rows?.[site] ?? [])).map((row) => {
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
      xid += 1;
      return Promise.resolve({ batchId: request.batchId, duplicate: false, applied: request.rows.length, skipped: 0, writePositions: new Map([[owner, String(xid)]]) });
    }),
    exportPages,
    putObject: vi.fn((params: PutObjectParams, bytes: Uint8Array) => {
      puts.push({ params, bytes });
      return Promise.resolve({
        key: objectKey(params.tenantId, params.fileId, params.variant as StoredVariant, params.ext),
        size: bytes.byteLength,
        sha256: params.sha256,
        created: true,
        writePositions: new Map([['strategies-content', '900']]),
      });
    }),
  } as unknown as OwnersClient;
  /** Applied rows decoded over their batch's columns. */
  const appliedRows = () =>
    applies.flatMap(({ owner, request }) =>
      request.rows.map((row) => ({ owner, op: row.op, discriminator: row.discriminator, tenantId: request.tenantId, values: decodeRow(request.columns, row.row) })),
    );
  return { owners, applies, puts, appliedRows };
}

/** Fake bridge: one `fileDir` listing per store directory, with the bytes of each stored name. */
function fakeBridge(listings: Record<string, { fileStore?: string; files: { name: string; bytes: Buffer }[] }>) {
  const gets: string[] = [];
  const entry = (name: string, bytes: Buffer): LegacyFileEntry => {
    const dot = name.lastIndexOf('.');
    return { name, fileId: name.slice(0, 35), variant: name.slice(35, dot) as LegacyFileEntry['variant'], ext: name.slice(dot + 1), size: bytes.byteLength, sha256: sha(bytes), lastModified: '2026-06-30T12:00:00.000' };
  };
  const bridge = {
    filesList: vi.fn((dir: string): Promise<FileListing> => {
      const listing = listings[dir];
      return Promise.resolve({ fileStore: listing?.fileStore ?? 'fileDir', files: (listing?.files ?? []).map(({ name, bytes }) => entry(name, bytes)), serverTime: '2026-06-30T12:00:00.000' });
    }),
    filesGet: vi.fn((dir: string, name: string) => {
      gets.push(`${dir}/${name}`);
      const found = listings[dir]?.files.find((file) => file.name === name);
      return found === undefined ? Promise.reject(new Error(`no file ${dir}/${name}`)) : Promise.resolve({ bytes: found.bytes, sha256: sha(found.bytes) });
    }),
  } as unknown as BridgeClient;
  return { bridge, gets };
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

const SURVEY_TABLE: TableSpec = {
  columns: [int('survey_id'), varchar('siteID', 25), { name: 'title', type: 'nvarchar', maxLength: 200 }, varchar('created_by', 35)],
  primaryKey: ['survey_id'],
  rows: [
    { survey_id: 1, siteID: 'tenant-a', title: 'Renamed', created_by: 'x' },
    { survey_id: 3, siteID: 'tenant-a', title: 'New', created_by: 'x' },
    { survey_id: 4, siteID: 'tenant-b', title: 'Changed out of scope', created_by: 'x' },
    { survey_id: 5, siteID: 'tenant-a', title: 'Same', created_by: 'x' },
  ],
};

const SURVEY_EXPORT: UnitExportSpec = {
  legacyTable: 'synthetic.survey',
  columns: [i('survey_id'), s('siteID'), s('title')],
  rows: {
    'tenant-a': [
      { survey_id: '1', siteID: 'tenant-a', title: 'Original' },
      { survey_id: '2', siteID: 'tenant-a', title: 'Deleted in legacy' },
      { survey_id: '5', siteID: 'tenant-a', title: 'Same' },
    ],
    'tenant-b': [{ survey_id: '4', siteID: 'tenant-b', title: 'Before' }],
  },
};

function contextOf(parts: { legacy: LegacyDb; owners: OwnersClient; bridge?: BridgeClient; batchRows?: number }): WindowImportContext {
  const base = loadConfig();
  return {
    config: { ...base, backfill: { ...base.backfill, batchRows: parts.batchRows ?? base.backfill.batchRows } },
    legacy: parts.legacy,
    catalog: loadUnitCatalog(base.paths.tableOwnership),
    owners: parts.owners,
    bridge: parts.bridge ?? fakeBridge({}).bridge,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
  } as WindowImportContext;
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

describe('importWindow', () => {
  it('sends scoped inserts, updates and deletes to the owner as legacy-window writes', async () => {
    const { legacy, db } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.survey': SURVEY_TABLE });
    const fake = fakeOwners({ 'surveys.survey': SURVEY_EXPORT });
    const result = await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['surveys.survey'], { keys: { siteid: 'tenant-a' } }));

    expect(fake.applies).toHaveLength(1);
    const [{ owner, request }] = fake.applies as [{ owner: string; request: ApplyRequest }];
    expect(owner).toBe('surveys');
    expect(request).toMatchObject({
      batchId: windowBatchId('W1', 1, 'surveys', 'synthetic.survey', 0),
      origin: 'legacy-window',
      legacyTable: 'synthetic.survey',
      tenantId: TENANT_A,
      units: ['surveys.survey'],
      holderId: 'W1',
      columns: SURVEY_EXPORT.columns,
    });
    expect(fake.appliedRows().map(({ op, values }) => [op, values.survey_id, values.title])).toEqual([
      ['upsert', '1', 'Renamed'],
      ['delete', '2', 'Deleted in legacy'],
      ['upsert', '3', 'New'],
    ]);
    expect(result).toMatchObject({ rowsImported: 3, perOwner: { surveys: { batches: 1, rows: 3 } }, objectsTransferred: 0, objectsRemoved: [], touchedContent: false });
    expect(result.writePositions.get('surveys')).toBe('101');
    expect(db.queries.some((query) => /FROM \[synthetic\]\.\[survey\] WHERE/.test(query))).toBe(true);
  });

  it('compares a tenant-b change only when the scope reaches it', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.survey': SURVEY_TABLE });
    const fake = fakeOwners({ 'surveys.survey': SURVEY_EXPORT });
    const result = await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['surveys.survey'], { table: true }));
    expect(fake.applies.map(({ request }) => request.tenantId)).toEqual([TENANT_A, TENANT_B].sort());
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

    expect(fake.applies.map(({ owner }) => owner)).toEqual(['people']);
    expect(fake.applies[0]?.request.columns).toEqual([s('UserID'), s('GroupName'), s('Fname'), s('SiteID'), i('Type')]);
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
      const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.survey': SURVEY_TABLE });
      const fake = fakeOwners({ 'surveys.survey': SURVEY_EXPORT });
      await importWindow(contextOf({ legacy, owners: fake.owners, batchRows: 2 }), windowInput(['surveys.survey'], { keys: { siteid: 'tenant-a' } }, attempt));
      expect(fake.applies.map(({ request }) => request.rows.length)).toEqual([2, 1]);
      return fake.applies.map(({ request }) => request.batchId);
    };
    const first = await run(1);
    expect(first).toEqual([windowBatchId('W1', 1, 'surveys', 'synthetic.survey', 0), windowBatchId('W1', 1, 'surveys', 'synthetic.survey', 1)]);
    expect(await run(1)).toEqual(first);
    const retry = await run(2);
    expect(retry.some((id) => first.includes(id))).toBe(false);
  });

  it('wraps an owner failure in WindowImportError naming the owner and table', async () => {
    const failure = new OwnerCallError('surveys', 'POST', '/internal/v1/migration/apply', 503, { error: 'unavailable' });
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.survey': SURVEY_TABLE });
    const fake = fakeOwners({ 'surveys.survey': SURVEY_EXPORT }, { failApply: failure });
    const error = await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['surveys.survey'], { table: true })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WindowImportError);
    expect(error).toMatchObject({ windowId: 'W1', owner: 'surveys', table: 'synthetic.survey', cause: failure });
  });

  it('wraps a legacy SQL failure in WindowImportError', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS });
    const fake = fakeOwners({ 'surveys.survey': SURVEY_EXPORT });
    const error = await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['surveys.survey'], { table: true })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WindowImportError);
    expect(error).toMatchObject({ windowId: 'W1', table: 'synthetic.survey' });
  });

  it('places a child row in its parent survey\'s tenant', async () => {
    const reminders: TableSpec = {
      columns: [int('reminder_id'), int('survey_id'), int('offset_minutes')],
      primaryKey: ['reminder_id'],
      rows: [
        { reminder_id: 10, survey_id: 1, offset_minutes: 60 },
        { reminder_id: 11, survey_id: 4, offset_minutes: 30 },
      ],
    };
    const fake = fakeOwners({
      'surveys.survey_reminder': {
        legacyTable: 'synthetic.survey_reminder',
        columns: [i('reminder_id'), i('survey_id'), i('offset_minutes')],
        rows: { 'tenant-b': [{ reminder_id: '11', survey_id: '4', offset_minutes: '15' }] },
      },
    });
    const { legacy, db } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.survey': SURVEY_TABLE, 'synthetic.survey_reminder': reminders });
    await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['surveys.survey_reminder'], { keys: { siteid: 'tenant-a' } }));

    expect(fake.appliedRows().map(({ op, tenantId, values }) => [tenantId, op, values.reminder_id, values.offset_minutes])).toEqual(
      [
        [TENANT_A, 'upsert', '10', '60'],
        [TENANT_B, 'upsert', '11', '30'],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(db.queries.some((query) => query.includes('FROM [synthetic].[survey] WHERE [survey_id] IN'))).toBe(true);
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
    const day = (dayId: number, hours: number) => ({ day_id: dayId, hours });
    const daySpec = (rows: Row[]): TableSpec => ({ columns: [int('day_id'), int('hours')], primaryKey: ['day_id'], rows });
    const fake = fakeOwners({
      'timesheets.timesheet_day': {
        legacyTable: 'timesheet_day',
        columns: [i('day_id'), i('hours')],
        rows: {
          'tenant-a': [{ day_id: '1', hours: '8', [PROGRAM]: '1' }],
          'tenant-b': [{ day_id: '1', hours: '6', [PROGRAM]: '2' }],
        },
      },
    });
    const { legacy } = fakeLegacy({
      'dbo.tsettings': TSETTINGS,
      'synthetic.program_site': { columns: [int('program_id'), varchar('siteID', 25)], primaryKey: ['program_id'], rows: [{ program_id: 1, siteID: 'tenant-a' }, { program_id: 2, siteID: 'tenant-b' }] },
      'Program_1.timesheet_day': daySpec([day(1, 7), day(2, 4)]),
      'Program_2.timesheet_day': daySpec([day(1, 6)]),
    });
    await importWindow(contextOf({ legacy, owners: fake.owners }), windowInput(['timesheets.timesheet_day'], { table: true }));

    expect(fake.applies.map(({ request }) => [request.tenantId, request.legacyProgramId, request.legacyTable, request.columns])).toEqual([
      [TENANT_A, 1, 'timesheet_day', [i('day_id'), i('hours')]],
    ]);
    expect(fake.appliedRows().map(({ op, values }) => [op, values.day_id, values.hours])).toEqual([
      ['upsert', '1', '7'],
      ['upsert', '2', '4'],
    ]);
  });

  it('compares the whole table when the owner does not export the scope column', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS, 'synthetic.survey': SURVEY_TABLE });
    const drop = (rows: Row[] = []) => rows.map(({ siteID: _site, ...rest }) => rest);
    const fake = fakeOwners({
      'surveys.survey': {
        ...SURVEY_EXPORT,
        columns: [i('survey_id'), s('title')],
        rows: { 'tenant-a': drop(SURVEY_EXPORT.rows?.['tenant-a']), 'tenant-b': drop(SURVEY_EXPORT.rows?.['tenant-b']) },
      },
    });
    const ctx = contextOf({ legacy, owners: fake.owners });
    await importWindow(ctx, windowInput(['surveys.survey'], { keys: { siteid: 'tenant-a' } }));

    expect(fake.appliedRows().map(({ tenantId, op, values }) => [tenantId === TENANT_A ? 'a' : 'b', op, values.survey_id])).toEqual(
      expect.arrayContaining([
        ['a', 'upsert', '1'],
        ['a', 'delete', '2'],
        ['a', 'upsert', '3'],
        ['b', 'upsert', '4'],
      ]),
    );
    expect(fake.appliedRows()).toHaveLength(4);
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('compares all of synthetic.survey'));
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

  it('transfers a new _small rendition to strategies-content with its SHA-256 and lists stale manifest objects', async () => {
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
            { key: keyOf(FILE_2, '', 'png'), size: 3, sha256: sha('old'), legacyPath: `umbrella/cache/file/${FILE_2}.png` },
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
    expect(Buffer.from(fake.puts[0]?.bytes ?? []).equals(small)).toBe(true);
    expect(result).toMatchObject({ objectsTransferred: 1, objectsRemoved: [keyOf(FILE_2, '', 'png')], rowsImported: 0 });
    expect(result.writePositions.get('strategies-content')).toBe('900');
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
