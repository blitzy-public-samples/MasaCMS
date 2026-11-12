// Unit tests for the reverse projector's legacy writers, checkpoint store and change decoding, over a recording SQL Server fake.
import { Buffer } from 'node:buffer';

import { encodeRow, type CanonicalColumn, type CanonicalValue, type ChangeOp, type ProjectedChangeRow } from '@opt2/platform/migration-kit';
import sql from 'mssql';
import type { Request } from 'mssql';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogColumn, TableCatalog } from '../../src/extract/index.js';
import type { LegacyTableTarget } from '../../src/owners/index.js';
import {
  CHECKPOINT_TABLE,
  ProjectionConflictError,
  applyLegacyChange,
  bindValue,
  clearPendingEffects,
  decodeLegacyChange,
  readCheckpoint,
  readCheckpoints,
  readyHorizonOf,
  summarise,
  upsertCheckpoint,
  type ApplyLegacyOptions,
  type CheckpointRow,
  type LegacyChange,
  type LegacyEffect,
} from '../../src/reverse/apply-legacy.js';

const TENANT = '0b0c4f7e-3f7a-4c1e-9a55-1d2b3c4d5e6f';
const OPERATION = 'a0000000-0000-4000-8000-00000000000a';

interface Bound {
  type: unknown;
  value: unknown;
}

interface Issued {
  sql: string;
  params: Record<string, Bound>;
}

interface Reply {
  recordset?: unknown[];
  rowsAffected?: number[];
}

/** Transaction scope whose requests record their inputs and SQL; queries take `replies` in order, then an empty result. */
function fakeTx(...replies: Reply[]) {
  const issued: Issued[] = [];
  const request = vi.fn(() => {
    const params: Record<string, Bound> = {};
    const fake = {
      input(name: string, type: unknown, value: unknown) {
        params[name] = { type, value };
        return fake;
      },
      async query(text: string) {
        issued.push({ sql: text, params });
        const reply = replies.shift() ?? {};
        return { recordset: reply.recordset ?? [], recordsets: [], rowsAffected: reply.rowsAffected ?? [], output: {} };
      },
    };
    return fake as unknown as Request;
  });
  return { scope: { request }, request, issued, statements: () => issued.map((entry) => entry.sql) };
}

/** Bound values of one issued statement by parameter name. */
function valuesOf(entry: Issued | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry?.params ?? {}).map(([name, bound]) => [name, bound.value]));
}

function column(name: string, sqlType: string, extra: Partial<CatalogColumn> = {}): CatalogColumn {
  return { name, type: 's', sqlType, nullable: true, maxLength: null, precision: null, numericScale: null, ordinal: 1, ...extra };
}

function table(schema: string, name: string, columns: CatalogColumn[], keys: { primaryKey?: string[]; identity?: string[] } = {}): TableCatalog {
  const primaryKey = keys.primaryKey ?? [];
  return {
    database: 'muradb',
    schema,
    table: name,
    qualified: schema === 'dbo' ? name : `${schema}.${name}`,
    columns,
    primaryKey,
    identityColumns: keys.identity ?? [],
    hasPrimaryKey: primaryKey.length > 0,
  };
}

const TUSERS = table(
  'dbo',
  'tusers',
  [column('UserID', 'char'), column('SiteID', 'varchar'), column('Fname', 'nvarchar'), column('Lname', 'nvarchar'), column('Type', 'int', { type: 'i' })],
  { primaryKey: ['UserID'] },
);
const TUSERSMEMB = table('dbo', 'tusersmemb', [column('UserID', 'char'), column('GroupID', 'char')], { primaryKey: ['UserID', 'GroupID'] });
const EXTEND_DATA = table(
  'dbo',
  'tclassextenddata',
  [column('dataID', 'int', { type: 'i' }), column('baseID', 'char'), column('attributeValue', 'ntext')],
  { primaryKey: ['dataID'], identity: ['dataID'] },
);
const ATTACHMENT = table('synthetic', 'attachment', [column('hash', 'varbinary', { type: 'b' }), column('name', 'nvarchar')], { primaryKey: ['hash'] });
const TLOG = table('dbo', 'tlog', [
  column('logID', 'int', { type: 'i' }),
  column('entry', 'nvarchar'),
  column('body', 'ntext'),
  column('note', 'text'),
  column('payload', 'varbinary', { type: 'b' }),
  column('picture', 'image', { type: 'b' }),
  column('qty', 'int', { type: 'i' }),
  column('stamp', 'datetime', { type: 't' }),
  column('closedAt', 'datetime2', { type: 't' }),
], { identity: ['logID'] });

const TARGET: LegacyTableTarget = { unit: 'people.person', owner: 'people', rowPredicate: null, keyColumns: ['UserID'], ownedColumns: 'whole-table' };

function options(tableCatalog: TableCatalog, extra: Partial<ApplyLegacyOptions> = {}): ApplyLegacyOptions {
  return { tableCatalog, target: TARGET, split: false, ownedColumns: 'whole-table', ...extra };
}

function change(op: ChangeOp, catalog: TableCatalog, fields: Partial<LegacyChange> = {}): LegacyChange {
  return {
    owner: 'people',
    tenantId: TENANT,
    unit: 'people.person',
    xid: '901',
    seq: '7',
    op,
    legacyTable: catalog.qualified,
    physicalTable: { schema: catalog.schema, table: catalog.table, qualified: catalog.qualified },
    columns: [...catalog.columns],
    key: 's2:u1',
    ...fields,
  };
}

/** The error a rejected write settles with. */
async function failureOf(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('bindValue', () => {
  const VARCHAR = sql.VarChar(sql.MAX);
  const NVARCHAR = sql.NVarChar(sql.MAX);
  const VARBINARY = sql.VarBinary(sql.MAX);

  it.each([
    { sqlType: 'char', value: 'u1', expr: '@v', type: VARCHAR, bound: 'u1' },
    { sqlType: 'varchar', value: 'default', expr: '@v', type: VARCHAR, bound: 'default' },
    { sqlType: 'text', value: 'body', expr: '@v', type: VARCHAR, bound: 'body' },
    { sqlType: 'nchar', value: 'Ada', expr: '@v', type: NVARCHAR, bound: 'Ada' },
    { sqlType: 'nvarchar', value: 'Łucja', expr: '@v', type: NVARCHAR, bound: 'Łucja' },
    { sqlType: 'ntext', value: 'long', expr: '@v', type: NVARCHAR, bound: 'long' },
    { sqlType: 'xml', value: '<a/>', expr: '@v', type: NVARCHAR, bound: '<a/>' },
    { sqlType: 'binary', value: Buffer.from('ab01', 'hex'), expr: '@v', type: VARBINARY, bound: Buffer.from('ab01', 'hex') },
    { sqlType: 'varbinary', value: 'abcd', expr: '@v', type: VARBINARY, bound: Buffer.from('abcd', 'hex') },
    { sqlType: 'image', value: Buffer.from('ff', 'hex'), expr: '@v', type: VARBINARY, bound: Buffer.from('ff', 'hex') },
    { sqlType: 'datetime', value: '2026-03-01T10:00:00.000', expr: 'CONVERT(datetime, @v, 126)', type: VARCHAR, bound: '2026-03-01T10:00:00.000' },
    { sqlType: 'smalldatetime', value: '2026-03-01T10:00:00', expr: 'CONVERT(smalldatetime, @v, 126)', type: VARCHAR, bound: '2026-03-01T10:00:00' },
    { sqlType: 'datetime2', value: '2026-03-01T10:00:00.1234567', expr: 'CONVERT(datetime2, @v, 126)', type: VARCHAR, bound: '2026-03-01T10:00:00.1234567' },
    { sqlType: 'date', value: '2026-03-01', expr: 'CONVERT(date, @v, 126)', type: VARCHAR, bound: '2026-03-01' },
    { sqlType: 'int', value: '42', expr: 'CAST(@v AS int)', type: VARCHAR, bound: '42' },
    { sqlType: 'smallint', value: '-7', expr: 'CAST(@v AS smallint)', type: VARCHAR, bound: '-7' },
    { sqlType: 'tinyint', value: '1', expr: 'CAST(@v AS tinyint)', type: VARCHAR, bound: '1' },
    { sqlType: 'bigint', value: '9007199254740993', expr: 'CAST(@v AS bigint)', type: VARCHAR, bound: '9007199254740993' },
    { sqlType: 'bit', value: '1', expr: 'CAST(@v AS bit)', type: VARCHAR, bound: '1' },
    { sqlType: 'float', value: '1.5E0', expr: 'CAST(@v AS float)', type: VARCHAR, bound: '1.5E0' },
    { sqlType: 'real', value: '2.5E0', expr: 'CAST(@v AS real)', type: VARCHAR, bound: '2.5E0' },
    { sqlType: 'money', value: '12.3400', expr: 'CAST(@v AS money)', type: VARCHAR, bound: '12.3400' },
    { sqlType: 'smallmoney', value: '1.0000', expr: 'CAST(@v AS smallmoney)', type: VARCHAR, bound: '1.0000' },
    { sqlType: 'uniqueidentifier', value: OPERATION, expr: 'CAST(@v AS uniqueidentifier)', type: VARCHAR, bound: OPERATION },
  ])('binds a $sqlType value as $expr', ({ sqlType, value, expr, type, bound }) => {
    const request = { input: vi.fn() };

    expect(bindValue(request, 'v', column('c', sqlType), value)).toBe(expr);
    expect(request.input).toHaveBeenCalledExactlyOnceWith('v', type, bound);
  });

  it.each([
    { sqlType: 'decimal', precision: 18, numericScale: 4, expr: 'CAST(@v AS decimal(18,4))' },
    { sqlType: 'numeric', precision: 10, numericScale: null, expr: 'CAST(@v AS decimal(10,0))' },
  ])('casts a $sqlType value to its precision and scale', ({ sqlType, precision, numericScale, expr }) => {
    const request = { input: vi.fn() };

    expect(bindValue(request, 'v', column('c', sqlType, { type: 'd', precision, numericScale }), '12.5000')).toBe(expr);
    expect(request.input).toHaveBeenCalledExactlyOnceWith('v', VARCHAR, '12.5000');
  });

  it('returns NULL for a null value and binds nothing', () => {
    const request = { input: vi.fn() };

    expect(bindValue(request, 'v', column('c', 'nvarchar'), null)).toBe('NULL');
    expect(request.input).not.toHaveBeenCalled();
  });

  it.each([
    { sqlType: 'nvarchar', message: 'column c (nvarchar) expects text, got bytes' },
    { sqlType: 'int', message: 'column c (int) expects text, got bytes' },
  ])('rejects bytes for a $sqlType column', ({ sqlType, message }) => {
    const request = { input: vi.fn() };

    expect(() => bindValue(request, 'v', column('c', sqlType), Buffer.from('01', 'hex'))).toThrow(new TypeError(message));
    expect(request.input).not.toHaveBeenCalled();
  });

  it('rejects a type with no parameter conversion', () => {
    const request = { input: vi.fn() };

    expect(() => bindValue(request, 'v', column('c', 'sql_variant'), 'x')).toThrow(
      new TypeError('column c has no parameter conversion for SQL Server type sql_variant'),
    );
    expect(request.input).not.toHaveBeenCalled();
  });
});

describe('projector checkpoint', () => {
  const SELECT = `SELECT owner, tenant_id, CONVERT(varchar(20), cursor_xid) AS cursor_xid, CONVERT(varchar(20), cursor_seq) AS cursor_seq, CONVERT(varchar(20), applied_horizon) AS applied_horizon, batch_id, rows_applied, updated_at, pending_effects, CONVERT(varchar(20), ready_horizon) AS ready_horizon FROM ${CHECKPOINT_TABLE}`;
  const UPDATED_AT = new Date('2026-03-01T10:00:00.000Z');
  const EFFECTS: LegacyEffect[] = [
    { kind: 'siteRefresh', siteId: 'tenant-a' },
    { kind: 'purgeCache', siteId: 'tenant-a' },
  ];
  const RECORD = {
    owner: 'people',
    tenant_id: TENANT,
    cursor_xid: '18446744073709551000',
    cursor_seq: '9007199254740993',
    applied_horizon: '18446744073709551001',
    batch_id: 'batch-7',
    rows_applied: 2,
    updated_at: UPDATED_AT,
    pending_effects: null,
    ready_horizon: null,
  };
  const ROW: CheckpointRow = {
    owner: 'people',
    tenantId: TENANT,
    cursorXid: '18446744073709551000',
    cursorSeq: '9007199254740993',
    appliedHorizon: '18446744073709551001',
    batchId: 'batch-7',
    rowsApplied: 2,
    updatedAt: UPDATED_AT,
    pendingEffects: [],
    readyHorizon: null,
  };
  const OWING_RECORD = { ...RECORD, pending_effects: JSON.stringify(EFFECTS), ready_horizon: '18446744073709550999' };
  const OWING_ROW: CheckpointRow = { ...ROW, pendingEffects: EFFECTS, readyHorizon: '18446744073709550999' };

  it('lives in the opt2_sync schema of the legacy database', () => {
    expect(CHECKPOINT_TABLE).toBe('opt2_sync.projector_checkpoint');
  });

  it('reads every checkpoint ordered by owner and tenant with xids as exact decimal text and owed effects parsed', async () => {
    const tx = fakeTx({ recordset: [RECORD, OWING_RECORD] });

    await expect(readCheckpoints(tx.scope)).resolves.toEqual([ROW, OWING_ROW]);
    expect(tx.statements()).toEqual([`${SELECT} ORDER BY owner, tenant_id`]);
    expect(tx.issued[0]?.params).toEqual({});
  });

  it('rejects owed effects that are not a JSON array', async () => {
    const tx = fakeTx({ recordset: [{ ...RECORD, pending_effects: '{"kind":"purgeCache"}' }] });

    await expect(readCheckpoints(tx.scope)).rejects.toThrow(new TypeError(`pending_effects of people / ${TENANT} is not a JSON array`));
  });

  it('cancels its SQL Server request when the signal aborts', async () => {
    let fail: (error: Error) => void = () => undefined;
    const request = {
      input: vi.fn(),
      query: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      cancel: vi.fn(() => fail(Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }))),
    };
    const controller = new AbortController();

    const read = readCheckpoints({ request: () => request as unknown as Request }, { owners: ['people'] }, { signal: controller.signal });
    controller.abort();

    await expect(read).rejects.toMatchObject({ code: 'ECANCEL' });
    expect(request.cancel).toHaveBeenCalledTimes(1);
  });

  it('reads nothing once its signal has aborted', async () => {
    const tx = fakeTx({ recordset: [RECORD] });

    await expect(readCheckpoints(tx.scope, {}, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(tx.issued).toEqual([]);
  });

  it('reads only the named owners', async () => {
    const tx = fakeTx({ recordset: [RECORD] });

    await expect(readCheckpoints(tx.scope, { owners: ['identity', 'people'] })).resolves.toEqual([ROW]);
    expect(tx.statements()).toEqual([`${SELECT} WHERE owner IN (@o0, @o1) ORDER BY owner, tenant_id`]);
    expect(tx.issued[0]?.params).toEqual({
      o0: { type: sql.NVarChar(64), value: 'identity' },
      o1: { type: sql.NVarChar(64), value: 'people' },
    });
  });

  it('reads nothing for an empty owner filter', async () => {
    const tx = fakeTx({ recordset: [RECORD] });

    await expect(readCheckpoints(tx.scope, { owners: [] })).resolves.toEqual([]);
    expect(tx.issued).toEqual([]);
  });

  it.each([
    { label: 'the stored checkpoint', recordset: [RECORD], expected: ROW },
    { label: 'null before the first batch', recordset: [], expected: null },
  ])('reads $label of one owner and tenant', async ({ recordset, expected }) => {
    const tx = fakeTx({ recordset });

    await expect(readCheckpoint(tx.scope, 'people', TENANT)).resolves.toEqual(expected);
    expect(tx.statements()).toEqual([`${SELECT} WHERE owner = @owner AND tenant_id = @tenantId`]);
    expect(tx.issued[0]?.params).toEqual({
      owner: { type: sql.NVarChar(64), value: 'people' },
      tenantId: { type: sql.VarChar(36), value: TENANT },
    });
  });

  it.each([
    { label: 'no owed effects as NULL', pendingEffects: [], bound: null, record: RECORD, expected: ROW },
    { label: 'owed effects as a JSON array', pendingEffects: EFFECTS, bound: JSON.stringify(EFFECTS), record: OWING_RECORD, expected: OWING_ROW },
  ])('upserts in one statement that keeps the greater applied horizon, stores $label and returns the stored row', async ({ pendingEffects, bound, record, expected }) => {
    const tx = fakeTx({ recordset: [record] });
    const write = { owner: 'people', tenantId: TENANT, cursorXid: '18446744073709551000', cursorSeq: '9007199254740993', appliedHorizon: '18446744073709551001', batchId: 'batch-7', rowsApplied: 2, pendingEffects };

    await expect(upsertCheckpoint(tx.scope, write)).resolves.toEqual(expected);
    expect(tx.request).toHaveBeenCalledTimes(1);
    expect(tx.statements()[0]?.split('\n')).toEqual([
      `UPDATE ${CHECKPOINT_TABLE} WITH (UPDLOCK, HOLDLOCK) SET cursor_xid = CAST(@cursorXid AS decimal(20,0)), cursor_seq = CAST(@cursorSeq AS bigint), applied_horizon = CASE WHEN applied_horizon > CAST(@appliedHorizon AS decimal(20,0)) THEN applied_horizon ELSE CAST(@appliedHorizon AS decimal(20,0)) END, batch_id = @batchId, rows_applied = @rowsApplied, updated_at = SYSDATETIME(), pending_effects = @pendingEffects, ready_horizon = CASE WHEN @pendingEffects IS NULL THEN NULL WHEN pending_effects IS NULL THEN applied_horizon ELSE ready_horizon END WHERE owner = @owner AND tenant_id = @tenantId;`,
      `IF @@ROWCOUNT = 0 INSERT INTO ${CHECKPOINT_TABLE} (owner, tenant_id, cursor_xid, cursor_seq, applied_horizon, batch_id, rows_applied, updated_at, pending_effects) VALUES (@owner, @tenantId, CAST(@cursorXid AS decimal(20,0)), CAST(@cursorSeq AS bigint), CAST(@appliedHorizon AS decimal(20,0)), @batchId, @rowsApplied, SYSDATETIME(), @pendingEffects);`,
      `${SELECT} WHERE owner = @owner AND tenant_id = @tenantId;`,
    ]);
    expect(tx.issued[0]?.params).toEqual({
      owner: { type: sql.NVarChar(64), value: 'people' },
      tenantId: { type: sql.VarChar(36), value: TENANT },
      cursorXid: { type: sql.VarChar(sql.MAX), value: '18446744073709551000' },
      cursorSeq: { type: sql.VarChar(sql.MAX), value: '9007199254740993' },
      appliedHorizon: { type: sql.VarChar(sql.MAX), value: '18446744073709551001' },
      batchId: { type: sql.NVarChar(64), value: 'batch-7' },
      rowsApplied: { type: sql.Int, value: 2 },
      pendingEffects: { type: sql.NVarChar(sql.MAX), value: bound },
    });
  });

  it('rejects an upsert that returns no stored row', async () => {
    const write = { owner: 'people', tenantId: TENANT, cursorXid: '10', cursorSeq: '1', appliedHorizon: '11', batchId: 'batch-1', rowsApplied: 0, pendingEffects: [] };

    await expect(upsertCheckpoint(fakeTx({ recordset: [] }).scope, write)).rejects.toThrow(`checkpoint of people / ${TENANT} was not stored`);
  });

  it('clears the owed effects of the batch that stored them', async () => {
    const tx = fakeTx({ rowsAffected: [1] });

    await expect(clearPendingEffects(tx.scope, OWING_ROW)).resolves.toBeUndefined();
    expect(tx.statements()).toEqual([
      `UPDATE ${CHECKPOINT_TABLE} SET pending_effects = NULL, ready_horizon = NULL WHERE owner = @owner AND tenant_id = @tenantId AND batch_id = @batchId`,
    ]);
    expect(tx.issued[0]?.params).toEqual({
      owner: { type: sql.NVarChar(64), value: 'people' },
      tenantId: { type: sql.VarChar(36), value: TENANT },
      batchId: { type: sql.NVarChar(64), value: 'batch-7' },
    });
  });

  it.each([
    { label: 'the applied horizon when nothing is owed', row: ROW, expected: '18446744073709551001' },
    { label: 'the ready horizon while effects are owed', row: OWING_ROW, expected: '18446744073709550999' },
    { label: 'null while effects are owed and none ever ran', row: { ...OWING_ROW, readyHorizon: null }, expected: null },
  ])('readyHorizonOf gives $label', ({ row, expected }) => {
    expect(readyHorizonOf(row)).toBe(expected);
  });
});

describe('decodeLegacyChange', () => {
  const PERSON: CanonicalColumn[] = [
    { name: 'UserID', type: 's' },
    { name: 'Fname', type: 's' },
    { name: 'Type', type: 'i' },
  ];
  const ENTRY: CanonicalColumn[] = [
    { name: 'entry_id', type: 's' },
    { name: 'hours', type: 'd', scale: 2 },
    { name: 'legacy_program_id', type: 'i' },
  ];
  const PERSON_CTX = { owner: 'people', tenantId: TENANT, unit: 'people.person', columns: PERSON };
  const ENTRY_CTX = { owner: 'timesheets', tenantId: TENANT, unit: 'timesheets.entry', columns: ENTRY };
  const KEY = encodeRow([{ name: 'UserID', type: 's' }], { UserID: 'u1' });

  function projected(op: ChangeOp, legacy: ProjectedChangeRow['legacy'], operationId: string | null = null): ProjectedChangeRow {
    return {
      xid: '901',
      seq: '7',
      table: 'person',
      op,
      key: KEY,
      before: null,
      after: null,
      columns: [],
      origin: 'target',
      actorUserId: null,
      actorService: 'people',
      at: '2026-03-01 10:00:00.000',
      requestId: null,
      operationId,
      legacy,
    };
  }

  function personProjection(before: Record<string, unknown> | null, after: Record<string, unknown> | null, columns: string[] = []) {
    return {
      unit: 'people.person',
      legacyTable: 'tusers',
      key: KEY,
      before: before === null ? null : encodeRow(PERSON, before),
      after: after === null ? null : encodeRow(PERSON, after),
      columns,
    };
  }

  it.each([
    { label: 'no projection', legacy: [] },
    { label: "only another unit's projection", legacy: [{ ...personProjection(null, { UserID: 'u1', Fname: 'Ada', Type: 2 }), unit: 'identity.account' }] },
  ])('returns null for a row with $label', ({ legacy }) => {
    expect(decodeLegacyChange(projected('insert', legacy), PERSON_CTX)).toBeNull();
  });

  it('rejects a row with two projections for one unit', () => {
    const projection = personProjection(null, { UserID: 'u1', Fname: 'Ada', Type: 2 });

    expect(() => decodeLegacyChange(projected('insert', [projection, projection]), PERSON_CTX)).toThrow(
      'changelog row 901:7 of person has 2 legacy projections for unit people.person',
    );
  });

  it('decodes an update into both images, its changed columns and its operation', () => {
    const projection = personProjection({ UserID: 'u1', Fname: 'Ada', Type: 2 }, { UserID: 'u1', Fname: 'Grace', Type: 2 }, ['Fname']);

    expect(decodeLegacyChange(projected('update', [projection], OPERATION), PERSON_CTX)).toStrictEqual({
      owner: 'people',
      tenantId: TENANT,
      unit: 'people.person',
      xid: '901',
      seq: '7',
      op: 'update',
      legacyTable: 'tusers',
      physicalTable: { schema: 'dbo', table: 'tusers', qualified: 'tusers' },
      columns: PERSON,
      key: KEY,
      before: { UserID: 'u1', Fname: 'Ada', Type: '2' },
      after: { UserID: 'u1', Fname: 'Grace', Type: '2' },
      changedColumns: ['Fname'],
      operationId: OPERATION,
    });
  });

  it('decodes an insert with no before-image, changed columns, operation or program', () => {
    const projection = personProjection(null, { UserID: 'u1', Fname: 'Ada', Type: null });

    expect(decodeLegacyChange(projected('insert', [projection]), PERSON_CTX)).toStrictEqual({
      owner: 'people',
      tenantId: TENANT,
      unit: 'people.person',
      xid: '901',
      seq: '7',
      op: 'insert',
      legacyTable: 'tusers',
      physicalTable: { schema: 'dbo', table: 'tusers', qualified: 'tusers' },
      columns: PERSON,
      key: KEY,
      after: { UserID: 'u1', Fname: 'Ada', Type: null },
    });
  });

  it.each([
    { source: 'projection', legacyProgramId: 2, imageProgramId: 9, programId: 2 },
    { source: 'image', legacyProgramId: undefined, imageProgramId: 1, programId: 1 },
  ])('addresses a folded row to Program_<id> from its $source without the program column', ({ legacyProgramId, imageProgramId, programId }) => {
    const projection = {
      unit: 'timesheets.entry',
      legacyTable: 'timesheet',
      key: 's2:e1',
      before: encodeRow(ENTRY, { entry_id: 'e1', hours: '7.50', legacy_program_id: imageProgramId }),
      after: encodeRow(ENTRY, { entry_id: 'e1', hours: '8.00', legacy_program_id: imageProgramId }),
      columns: ['hours', 'legacy_program_id'],
      ...(legacyProgramId === undefined ? {} : { legacyProgramId }),
    };
    const decoded = decodeLegacyChange({ ...projected('update', [projection]), table: 'entry' }, ENTRY_CTX);

    expect(decoded).toMatchObject({
      legacyTable: `Program_${String(programId)}.timesheet`,
      physicalTable: { schema: `Program_${String(programId)}`, table: 'timesheet', qualified: `Program_${String(programId)}.timesheet` },
      columns: ENTRY.slice(0, 2),
      before: { entry_id: 'e1', hours: '7.50' },
      after: { entry_id: 'e1', hours: '8.00' },
      changedColumns: ['hours'],
      programId,
    });
    expect(Object.keys(decoded?.after ?? {})).toEqual(['entry_id', 'hours']);
  });
});

describe('applyLegacyChange on a keyed table', () => {
  const ADA = { UserID: 'u1', Fname: 'Ada', Lname: null, Type: '2' };

  it.each([
    { label: 'by default', opts: {} },
    { label: 'for an empty ownership key', opts: { keyColumns: [] } },
    { label: 'for a whole-table split unit', opts: { split: true, ownedColumns: 'whole-table' as const } },
  ])('updates an inserted row that already exists by primary key $label', async ({ opts }) => {
    const tx = fakeTx({ rowsAffected: [1] });

    await expect(applyLegacyChange(tx.scope, change('insert', TUSERS, { after: ADA }), options(TUSERS, opts))).resolves.toEqual({ rows: 1 });
    expect(tx.statements()).toEqual(['UPDATE [dbo].[tusers] SET [Fname] = @p0, [Lname] = NULL, [Type] = CAST(@p2 AS int) WHERE [UserID] = @p3']);
    expect(valuesOf(tx.issued[0])).toEqual({ p0: 'Ada', p2: '2', p3: 'u1' });
  });

  it('inserts a non-split row from its own after-image when no row has its key', async () => {
    const tx = fakeTx({ rowsAffected: [0] }, { rowsAffected: [1] });
    const fetchOtherParts = vi.fn(async () => [{ UserID: 'u1', Lname: 'Lovelace' }]);

    await expect(applyLegacyChange(tx.scope, change('insert', TUSERS, { after: ADA }), options(TUSERS, { fetchOtherParts }))).resolves.toEqual({ rows: 1 });
    expect(tx.statements()).toEqual([
      'UPDATE [dbo].[tusers] SET [Fname] = @p0, [Lname] = NULL, [Type] = CAST(@p2 AS int) WHERE [UserID] = @p3',
      'INSERT INTO [dbo].[tusers] ([UserID], [Fname], [Lname], [Type]) VALUES (@p0, @p1, NULL, CAST(@p3 AS int));',
    ]);
    expect(valuesOf(tx.issued[1])).toEqual({ p0: 'u1', p1: 'Ada', p3: '2' });
    expect(fetchOtherParts).not.toHaveBeenCalled();
  });

  it('counts instead of updating a row made only of key columns', async () => {
    const tx = fakeTx({ recordset: [{ n: 1 }] });

    await expect(applyLegacyChange(tx.scope, change('insert', TUSERSMEMB, { after: { UserID: 'u1', GroupID: 'g1' } }), options(TUSERSMEMB))).resolves.toEqual({ rows: 1 });
    expect(tx.statements()).toEqual(['SELECT COUNT(*) AS n FROM [dbo].[tusersmemb] WHERE [UserID] = @p0 AND [GroupID] = @p1']);
    expect(valuesOf(tx.issued[0])).toEqual({ p0: 'u1', p1: 'g1' });
  });

  it.each([
    { label: 'a zero count', recordset: [{ n: 0 }] },
    { label: 'no count row', recordset: [] },
  ])('inserts a key-only row on $label', async ({ recordset }) => {
    const tx = fakeTx({ recordset }, { rowsAffected: [1] });

    await expect(applyLegacyChange(tx.scope, change('insert', TUSERSMEMB, { after: { UserID: 'u1', GroupID: 'g1' } }), options(TUSERSMEMB))).resolves.toEqual({ rows: 1 });
    expect(tx.statements()[1]).toBe('INSERT INTO [dbo].[tusersmemb] ([UserID], [GroupID]) VALUES (@p0, @p1);');
  });

  it('matches on the ownership key, a null key value as IS NULL', async () => {
    const tx = fakeTx({ rowsAffected: [1] });
    const after = { UserID: 'u1', SiteID: null, Fname: 'Ada', Type: '2' };

    await applyLegacyChange(tx.scope, change('insert', TUSERS, { after }), options(TUSERS, { keyColumns: ['SiteID', 'Fname'] }));
    expect(tx.statements()).toEqual(['UPDATE [dbo].[tusers] SET [UserID] = @p0, [Type] = CAST(@p1 AS int) WHERE [SiteID] IS NULL AND [Fname] = @p2']);
    expect(valuesOf(tx.issued[0])).toEqual({ p0: 'u1', p1: '2', p2: 'Ada' });
  });

  it('resolves image names to columns case-insensitively', async () => {
    const tx = fakeTx({ rowsAffected: [1] });

    await applyLegacyChange(tx.scope, change('insert', TUSERS, { after: { userid: 'u1', fname: 'Ada' } }), options(TUSERS));
    expect(tx.statements()).toEqual(['UPDATE [dbo].[tusers] SET [Fname] = @p0 WHERE [UserID] = @p1']);
    expect(valuesOf(tx.issued[0])).toEqual({ p0: 'Ada', p1: 'u1' });
  });

  it('inserts an explicit identity value with IDENTITY_INSERT switched off on every path', async () => {
    const tx = fakeTx({ rowsAffected: [0] }, { rowsAffected: [1] });
    const after = { dataID: '41', baseID: 'u1', attributeValue: 'blue' };
    const insert = 'INSERT INTO [dbo].[tclassextenddata] ([dataID], [baseID], [attributeValue]) VALUES (CAST(@p0 AS int), @p1, @p2);';

    await expect(applyLegacyChange(tx.scope, change('insert', EXTEND_DATA, { after }), options(EXTEND_DATA))).resolves.toEqual({ rows: 1 });
    expect(tx.statements()).toEqual([
      'UPDATE [dbo].[tclassextenddata] SET [baseID] = @p0, [attributeValue] = @p1 WHERE [dataID] = CAST(@p2 AS int)',
      [
        'SET IDENTITY_INSERT [dbo].[tclassextenddata] ON;',
        'BEGIN TRY',
        insert,
        'END TRY',
        'BEGIN CATCH',
        'SET IDENTITY_INSERT [dbo].[tclassextenddata] OFF;',
        'THROW;',
        'END CATCH;',
        'SET IDENTITY_INSERT [dbo].[tclassextenddata] OFF;',
      ].join('\n'),
    ]);
    expect(valuesOf(tx.issued[1])).toEqual({ p0: '41', p1: 'u1', p2: 'blue' });
  });

  it("updates only owned columns of a split row and inserts it merged with the other owners' parts", async () => {
    const tx = fakeTx({ rowsAffected: [0] }, { rowsAffected: [1] });
    const fetchOtherParts = vi.fn(async (): Promise<Record<string, CanonicalValue>[]> => [
      { UserID: 'u1', Fname: 'Other', Lname: 'Lovelace', legacy_program_id: null },
    ]);
    const inserted = change('insert', TUSERS, { after: { UserID: 'u1', Fname: 'Ada', Type: '2' } });

    await expect(applyLegacyChange(tx.scope, inserted, options(TUSERS, { split: true, ownedColumns: ['fname'], fetchOtherParts }))).resolves.toEqual({ rows: 1 });
    expect(tx.statements()).toEqual([
      'UPDATE [dbo].[tusers] SET [Fname] = @p0 WHERE [UserID] = @p1',
      'INSERT INTO [dbo].[tusers] ([UserID], [Fname], [Type], [Lname]) VALUES (@p0, @p1, CAST(@p2 AS int), @p3);',
    ]);
    expect(valuesOf(tx.issued[1])).toEqual({ p0: 'u1', p1: 'Ada', p2: '2', p3: 'Lovelace' });
    expect(fetchOtherParts).toHaveBeenCalledExactlyOnceWith(inserted);
  });

  it('updates the changed columns of the row the before-image keys', async () => {
    const tx = fakeTx({ rowsAffected: [1] });
    const updated = change('update', TUSERS, {
      before: { UserID: 'u1', Fname: 'Ada', Lname: 'King', Type: '2' },
      after: { UserID: 'u1', Fname: 'Ada', Lname: 'Lovelace', Type: '2' },
      changedColumns: ['lname'],
    });

    await expect(applyLegacyChange(tx.scope, updated, options(TUSERS))).resolves.toEqual({ rows: 1 });
    expect(tx.statements()).toEqual(['UPDATE [dbo].[tusers] SET [Lname] = @p0 WHERE [UserID] = @p1']);
    expect(valuesOf(tx.issued[0])).toEqual({ p0: 'Lovelace', p1: 'u1' });
  });

  it('updates every non-key column when the change names none', async () => {
    const tx = fakeTx({ rowsAffected: [1] });
    const updated = change('update', TUSERS, { before: { UserID: 'u1', Fname: 'Ada' }, after: { UserID: 'u1', Fname: 'Ada', Lname: 'Lovelace', Type: '2' } });

    await applyLegacyChange(tx.scope, updated, options(TUSERS));
    expect(tx.statements()).toEqual(['UPDATE [dbo].[tusers] SET [Fname] = @p0, [Lname] = @p1, [Type] = CAST(@p2 AS int) WHERE [UserID] = @p3']);
  });

  it('sets a changed key column on the row its old key locates', async () => {
    const tx = fakeTx({ rowsAffected: [1] });
    const updated = change('update', TUSERS, { before: { UserID: 'u1', Fname: 'Ada' }, after: { UserID: 'u2', Fname: 'Ada' }, changedColumns: ['UserID'] });

    await applyLegacyChange(tx.scope, updated, options(TUSERS));
    expect(tx.statements()).toEqual(['UPDATE [dbo].[tusers] SET [UserID] = @p0 WHERE [UserID] = @p1']);
    expect(valuesOf(tx.issued[0])).toEqual({ p0: 'u2', p1: 'u1' });
  });

  it('locates an update without a before-image by its after-image key', async () => {
    const tx = fakeTx({ rowsAffected: [1] });

    await applyLegacyChange(tx.scope, change('update', TUSERS, { after: { UserID: 'u1', Fname: 'Grace' }, changedColumns: ['Fname'] }), options(TUSERS));
    expect(tx.statements()).toEqual(['UPDATE [dbo].[tusers] SET [Fname] = @p0 WHERE [UserID] = @p1']);
    expect(valuesOf(tx.issued[0])).toEqual({ p0: 'Grace', p1: 'u1' });
  });

  it('leaves an unchanged binary key out of SET', async () => {
    const tx = fakeTx({ rowsAffected: [1] });
    const updated = change('update', ATTACHMENT, {
      before: { hash: Buffer.from('ab01', 'hex'), name: 'a.pdf' },
      after: { hash: Buffer.from('ab01', 'hex'), name: 'b.pdf' },
    });

    await applyLegacyChange(tx.scope, updated, options(ATTACHMENT));
    expect(tx.statements()).toEqual(['UPDATE [synthetic].[attachment] SET [name] = @p0 WHERE [hash] = @p1']);
    expect(valuesOf(tx.issued[0])).toEqual({ p0: 'b.pdf', p1: Buffer.from('ab01', 'hex') });
  });

  it.each<{ reason: string; catalog: TableCatalog; after: Record<string, CanonicalValue>; changedColumns: string[]; opts: Partial<ApplyLegacyOptions> }>([
    { reason: 'a column the unit does not own', catalog: TUSERS, after: { UserID: 'u1', Lname: 'Lovelace' }, changedColumns: ['Lname'], opts: { split: true, ownedColumns: ['Fname'] } },
    { reason: 'only an identity column', catalog: EXTEND_DATA, after: { dataID: '41', baseID: 'u1' }, changedColumns: ['dataID'], opts: {} },
  ])('writes nothing for an update of $reason', async ({ catalog, after, changedColumns, opts }) => {
    const tx = fakeTx();

    await expect(applyLegacyChange(tx.scope, change('update', catalog, { after, changedColumns }), options(catalog, opts))).resolves.toEqual({ rows: 0 });
    expect(tx.issued).toEqual([]);
  });

  it('rejects an update of a non-split row legacy no longer holds', async () => {
    const tx = fakeTx({ rowsAffected: [0] });
    const updated = change('update', TUSERS, { before: { UserID: 'u1', Fname: 'Ada' }, after: { UserID: 'u1', Fname: 'Grace' } });

    const error = await failureOf(applyLegacyChange(tx.scope, updated, options(TUSERS)));

    expect(error).toBeInstanceOf(ProjectionConflictError);
    expect(error).toMatchObject({ name: 'ProjectionConflictError', message: 'update of tusers found no matching legacy row', table: 'tusers', op: 'update', key: 's2:u1' });
    expect(tx.issued).toHaveLength(1);
  });

  it("inserts a missing split row merged with the other owners' parts on update", async () => {
    const tx = fakeTx({ rowsAffected: [0] }, { rowsAffected: [1] });
    const fetchOtherParts = vi.fn(async (): Promise<Record<string, CanonicalValue>[]> => [{ UserID: 'u1', Fname: 'Ada', Type: '2' }]);
    const updated = change('update', TUSERS, { after: { UserID: 'u1', Lname: 'Lovelace' }, changedColumns: ['Lname'] });

    await expect(applyLegacyChange(tx.scope, updated, options(TUSERS, { split: true, ownedColumns: ['Lname'], fetchOtherParts }))).resolves.toEqual({ rows: 1 });
    expect(tx.statements()).toEqual([
      'UPDATE [dbo].[tusers] SET [Lname] = @p0 WHERE [UserID] = @p1',
      'INSERT INTO [dbo].[tusers] ([UserID], [Lname], [Fname], [Type]) VALUES (@p0, @p1, @p2, CAST(@p3 AS int));',
    ]);
  });

  it.each([
    { label: 'reporting the deleted row', rowsAffected: [1], rows: 1 },
    { label: 'treating an absent row as already deleted', rowsAffected: [0], rows: 0 },
  ])('deletes by the before-image key, $label', async ({ rowsAffected, rows }) => {
    const tx = fakeTx({ rowsAffected });

    await expect(applyLegacyChange(tx.scope, change('delete', TUSERS, { before: { UserID: 'u1', Fname: 'Ada' } }), options(TUSERS))).resolves.toEqual({ rows });
    expect(tx.statements()).toEqual(['DELETE FROM [dbo].[tusers] WHERE [UserID] = @p0']);
    expect(valuesOf(tx.issued[0])).toEqual({ p0: 'u1' });
  });

  it.each([
    { predicate: 'Type = 2', where: '[Type] IN (CAST(@p1 AS int))', values: { p0: 'u1', p1: '2' } },
    { predicate: 'type in (1, -2)', where: '[Type] IN (CAST(@p1 AS int), CAST(@p2 AS int))', values: { p0: 'u1', p1: '1', p2: '-2' } },
    { predicate: "SiteID IN ('tenant-a', 'o''hare')", where: '[SiteID] IN (@p1, @p2)', values: { p0: 'u1', p1: 'tenant-a', p2: "o'hare" } },
  ])('restricts a split delete to the unit rows of $predicate', async ({ predicate, where, values }) => {
    const tx = fakeTx({ rowsAffected: [1] });
    const opts = options(TUSERS, { split: true, ownedColumns: ['Fname'], target: { ...TARGET, rowPredicate: predicate } });

    await applyLegacyChange(tx.scope, change('delete', TUSERS, { before: { UserID: 'u1' } }), opts);
    expect(tx.statements()).toEqual([`DELETE FROM [dbo].[tusers] WHERE [UserID] = @p0 AND ${where}`]);
    expect(valuesOf(tx.issued[0])).toEqual(values);
  });

  it.each([
    { label: 'a split unit without a predicate', split: true, predicate: null },
    { label: 'a class-map predicate', split: true, predicate: 'classMap owner = identity' },
    { label: 'a parent-row predicate', split: true, predicate: 'owner Type = 1' },
    { label: 'a predicate over a column the table lacks', split: true, predicate: 'Nickname = 1' },
    { label: 'a non-literal value', split: true, predicate: 'Type = abc' },
    { label: 'a non-literal list item', split: true, predicate: 'Type in (1, two)' },
    { label: 'a table that is not split', split: false, predicate: 'Type = 2' },
  ])('deletes by key alone for $label', async ({ split, predicate }) => {
    const tx = fakeTx({ rowsAffected: [1] });
    const opts = options(TUSERS, { split, ownedColumns: ['Fname'], target: { ...TARGET, rowPredicate: predicate } });

    await applyLegacyChange(tx.scope, change('delete', TUSERS, { before: { UserID: 'u1' } }), opts);
    expect(tx.statements()).toEqual(['DELETE FROM [dbo].[tusers] WHERE [UserID] = @p0']);
  });

  it.each<{ label: string; op: ChangeOp; fields: Partial<LegacyChange>; opts: Partial<ApplyLegacyOptions>; message: string }>([
    { label: 'an insert without an after-image', op: 'insert', fields: {}, opts: {}, message: 'insert of tusers carries no after-image' },
    { label: 'an update without an after-image', op: 'update', fields: { before: { UserID: 'u1' } }, opts: {}, message: 'update of tusers carries no after-image' },
    { label: 'a delete without a before-image', op: 'delete', fields: { after: { UserID: 'u1' } }, opts: {}, message: 'delete of tusers carries no before-image' },
    { label: 'an image column the table lacks', op: 'insert', fields: { after: { UserID: 'u1', Nickname: 'x' } }, opts: {}, message: 'column Nickname is not a column of tusers' },
    { label: 'an image without a key value', op: 'insert', fields: { after: { Fname: 'Ada' } }, opts: {}, message: 'insert of tusers carries no value for key column UserID' },
    { label: 'an ownership key column the table lacks', op: 'insert', fields: { after: { UserID: 'u1' } }, opts: { keyColumns: ['Nickname'] }, message: 'key column Nickname is not a column of tusers' },
  ])('rejects $label before writing', async ({ op, fields, opts, message }) => {
    const tx = fakeTx();

    await expect(applyLegacyChange(tx.scope, change(op, TUSERS, fields), options(TUSERS, opts))).rejects.toThrow(new TypeError(message));
    expect(tx.issued).toEqual([]);
  });
});

describe('applyLegacyChange on a table without a primary key', () => {
  const BEFORE = {
    entry: 'login',
    body: 'Ada ',
    note: 'n',
    payload: Buffer.from('00ff', 'hex'),
    picture: Buffer.from('01', 'hex'),
    qty: '3',
    stamp: '2026-03-01T10:00:00.000',
    closedAt: null,
  };
  const EXACT_WHERE = [
    '([entry] COLLATE Latin1_General_BIN2 = @p0 AND DATALENGTH([entry]) = DATALENGTH(@p0))',
    '(CAST([body] AS nvarchar(max)) COLLATE Latin1_General_BIN2 = @p1 AND DATALENGTH(CAST([body] AS nvarchar(max))) = DATALENGTH(@p1))',
    '(CAST([note] AS varchar(max)) COLLATE Latin1_General_BIN2 = @p2 AND DATALENGTH(CAST([note] AS varchar(max))) = DATALENGTH(@p2))',
    '([payload] = @p3 AND DATALENGTH([payload]) = DATALENGTH(@p3))',
    '(CAST([picture] AS varbinary(max)) = @p4 AND DATALENGTH(CAST([picture] AS varbinary(max))) = DATALENGTH(@p4))',
    '[qty] = CAST(@p5 AS int)',
    '[stamp] = CONVERT(datetime, @p6, 126)',
    '[closedAt] IS NULL',
  ].join(' AND ');

  it('inserts the after-image as a new row, letting SQL Server generate a null identity', async () => {
    const tx = fakeTx({ rowsAffected: [1] });
    const after = { logID: null, entry: 'login', qty: '4', stamp: null };

    await expect(applyLegacyChange(tx.scope, change('insert', TLOG, { after }), options(TLOG))).resolves.toEqual({ rows: 1 });
    expect(tx.statements()).toEqual(['INSERT INTO [dbo].[tlog] ([entry], [qty], [stamp]) VALUES (@p0, CAST(@p1 AS int), NULL);']);
    expect(valuesOf(tx.issued[0])).toEqual({ p0: 'login', p1: '4' });
  });

  it('deletes exactly one row equal to the before-image in every column, null-aware, whatever the ownership key', async () => {
    const tx = fakeTx({ rowsAffected: [1] });

    await expect(applyLegacyChange(tx.scope, change('delete', TLOG, { before: BEFORE }), options(TLOG, { keyColumns: ['entry'] }))).resolves.toEqual({ rows: 1 });
    expect(tx.statements()).toEqual([`DELETE TOP (1) FROM [dbo].[tlog] WHERE ${EXACT_WHERE}`]);
    expect(valuesOf(tx.issued[0])).toEqual({
      p0: 'login',
      p1: 'Ada ',
      p2: 'n',
      p3: Buffer.from('00ff', 'hex'),
      p4: Buffer.from('01', 'hex'),
      p5: '3',
      p6: '2026-03-01T10:00:00.000',
    });
  });

  it('replaces one row of an update: deletes its before-image, then inserts its after-image', async () => {
    const tx = fakeTx({ rowsAffected: [1] }, { rowsAffected: [1] });
    const updated = change('update', TLOG, { before: { entry: 'login', qty: '3' }, after: { entry: 'login', qty: '4' }, changedColumns: ['qty'] });

    await expect(applyLegacyChange(tx.scope, updated, options(TLOG))).resolves.toEqual({ rows: 1 });
    expect(tx.statements()).toEqual([
      'DELETE TOP (1) FROM [dbo].[tlog] WHERE ([entry] COLLATE Latin1_General_BIN2 = @p0 AND DATALENGTH([entry]) = DATALENGTH(@p0)) AND [qty] = CAST(@p1 AS int)',
      'INSERT INTO [dbo].[tlog] ([entry], [qty]) VALUES (@p0, CAST(@p1 AS int));',
    ]);
    expect(valuesOf(tx.issued[0])).toEqual({ p0: 'login', p1: '3' });
    expect(valuesOf(tx.issued[1])).toEqual({ p0: 'login', p1: '4' });
  });

  it.each([
    { label: 'a delete', op: 'delete' as const, fields: { before: BEFORE } },
    { label: 'an update', op: 'update' as const, fields: { before: BEFORE, after: { ...BEFORE, qty: '4' } } },
  ])('rejects $label whose before-image matches no row and writes nothing after it', async ({ op, fields }) => {
    const tx = fakeTx({ rowsAffected: [0] });

    const error = await failureOf(applyLegacyChange(tx.scope, change(op, TLOG, fields), options(TLOG)));

    expect(error).toBeInstanceOf(ProjectionConflictError);
    expect(error).toMatchObject({ message: `${op} of tlog found no matching legacy row`, table: 'tlog', op });
    expect(tx.statements()).toEqual([`DELETE TOP (1) FROM [dbo].[tlog] WHERE ${EXACT_WHERE}`]);
  });
});

describe('a projector batch', () => {
  it('writes its changes and its checkpoint through the one transaction it is given, never ending it', async () => {
    const record = { owner: 'people', tenant_id: TENANT, cursor_xid: '901', cursor_seq: '8', applied_horizon: '902', batch_id: 'batch-9', rows_applied: 2, updated_at: null, pending_effects: null, ready_horizon: null };
    const tx = fakeTx({ rowsAffected: [1] }, { rowsAffected: [1] }, { recordset: [record] });

    await applyLegacyChange(tx.scope, change('update', TUSERS, { before: { UserID: 'u1' }, after: { UserID: 'u1', Fname: 'Grace' } }), options(TUSERS));
    await applyLegacyChange(tx.scope, change('delete', TLOG, { before: { entry: 'login', qty: null } }), options(TLOG));
    const stored = await upsertCheckpoint(tx.scope, { owner: 'people', tenantId: TENANT, cursorXid: '901', cursorSeq: '8', appliedHorizon: '902', batchId: 'batch-9', rowsApplied: 2, pendingEffects: [] });

    expect(stored).toMatchObject({ cursorXid: '901', cursorSeq: '8', appliedHorizon: '902', batchId: 'batch-9', rowsApplied: 2, updatedAt: null });
    expect(tx.request).toHaveBeenCalledTimes(3);
    expect(tx.statements()).toEqual([
      expect.stringMatching(/^UPDATE \[dbo\]\.\[tusers\] SET \[Fname\] = @p0 /),
      expect.stringMatching(/^DELETE TOP \(1\) FROM \[dbo\]\.\[tlog\] .* AND \[qty\] IS NULL$/),
      expect.stringMatching(/^UPDATE opt2_sync\.projector_checkpoint WITH \(UPDLOCK, HOLDLOCK\) /),
    ]);
    expect(tx.statements().some((text) => /\b(BEGIN\s+TRAN|COMMIT|ROLLBACK)/i.test(text))).toBe(false);
  });
});

describe('summarise', () => {
  it('collects tables, trimmed site ids from both images and dbo tcontent and tsettings touches', () => {
    const tcontent = table('dbo', 'tcontent', [column('ContentID', 'char'), column('SiteID', 'varchar')]);
    const tsettings = table('dbo', 'tsettings', [column('SiteID', 'varchar')]);
    const changes = [
      change('insert', tcontent, { after: { ContentID: 'c1', SiteID: 'default   ' } }),
      change('update', tsettings, { before: { siteid: 'tenant-a' }, after: { SiteID: 'tenant-b' } }),
      change('delete', TUSERS, { before: { UserID: 'u1', SiteID: 'default' } }),
    ];

    expect(summarise(changes)).toEqual({
      rows: 3,
      tables: new Set(['tcontent', 'tsettings', 'tusers']),
      siteIds: new Set(['default', 'tenant-a', 'tenant-b']),
      touchesTcontent: true,
      touchesTsettings: true,
    });
  });

  it('ignores same-named tables outside dbo and blank, null or byte site ids', () => {
    const programContent = table('Program_1', 'tcontent', [column('SiteID', 'varchar')]);
    const programSettings = table('Program_1', 'TSETTINGS', [column('SiteID', 'varbinary')]);
    const changes = [
      change('insert', programContent, { after: { SiteID: '   ' } }),
      change('update', programSettings, { before: { SiteID: null }, after: { SiteID: Buffer.from('64', 'hex') } }),
    ];

    expect(summarise(changes)).toEqual({
      rows: 2,
      tables: new Set(['Program_1.tcontent', 'Program_1.TSETTINGS']),
      siteIds: new Set(),
      touchesTcontent: false,
      touchesTsettings: false,
    });
    expect(summarise([])).toEqual({ rows: 0, tables: new Set(), siteIds: new Set(), touchesTcontent: false, touchesTsettings: false });
  });
});
