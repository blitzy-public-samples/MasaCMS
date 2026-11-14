// Unit tests for the target side of reconciliation over a fake owners client serving fixed export pages.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeRow, type CanonicalColumn, type CanonicalValue, type ExportResponse, type ExportTable } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compareCanonicalRows, type CanonicalRow } from '../../src/extract/index.js';
import { OwnerCallError, type ExportParams, type OwnersClient } from '../../src/owners/index.js';
import { toUnitRow, type UnitTableShape } from '../../src/reconcile/legacy-side.js';
import {
  TargetShapeError,
  readTargetObjects,
  readTargetUnitRows,
  type ReconcileTargetDeps,
  type TargetUnitRows,
} from '../../src/reconcile/target-side.js';

type Values = Record<string, CanonicalValue>;

const TENANT = tenantIdForSite('tenant-a');
const ID_A = 'A0000000-0000-0000-0000000000000001';
const ID_B = 'B0000000-0000-0000-0000000000000002';
const ID_C = 'C0000000-0000-0000-0000000000000003';

/** tcontent's share compared by the content unit: key, two owned columns and the money-like amount; `tcontent_ID` is IDENTITY [core/setup/db/mssql.sql:3]. */
const CONTENT_SHAPE: UnitTableShape = {
  unit: 'content.content',
  owner: 'strategies-content',
  legacyTable: 'tcontent',
  keyed: true,
  keyColumns: ['ContentHistID'],
  columns: [
    { name: 'ContentHistID', type: 's' },
    { name: 'Title', type: 's' },
    { name: 'Display', type: 'i' },
    { name: 'Amount', type: 'd', scale: 4 },
  ],
  excludedColumns: ['tcontent_ID'],
  objectColumns: [],
  folded: false,
};

/** The owner's export columns: other spelling, the excluded IDENTITY column, and catalog order. */
const CONTENT_EXPORT_COLUMNS: CanonicalColumn[] = [
  { name: 'tcontent_ID', type: 'i' },
  { name: 'contenthistid', type: 's' },
  { name: 'TITLE', type: 's' },
  { name: 'display', type: 'i' },
  { name: 'amount', type: 'd', scale: 4 },
];

const PROGRAM_SHAPE: UnitTableShape = {
  unit: 'timesheets.timesheet',
  owner: 'timesheets',
  legacyTable: 'Program_N.timesheet',
  keyed: true,
  keyColumns: ['timesheet_id', 'legacy_program_id'],
  columns: [
    { name: 'timesheet_id', type: 'i' },
    { name: 'status', type: 's' },
    { name: 'legacy_program_id', type: 'i' },
  ],
  excludedColumns: [],
  objectColumns: [],
  folded: true,
};

const PROGRAM_EXPORT_COLUMNS: CanonicalColumn[] = [
  { name: 'timesheet_id', type: 'i' },
  { name: 'status', type: 's' },
];

const KEYLESS_SHAPE: UnitTableShape = {
  unit: 'communications.mailing_list_member',
  owner: 'communications',
  legacyTable: 'dbo.tmailinglistmembers',
  keyed: false,
  keyColumns: [],
  columns: [
    { name: 'MLID', type: 's' },
    { name: 'Email', type: 's' },
  ],
  excludedColumns: [],
  objectColumns: [],
  folded: false,
};

/** A folded finance-attachment share whose `content` bytes the owner stores as objects. */
const ATTACHMENT_SHAPE: UnitTableShape = {
  unit: 'finance.attachment',
  owner: 'finance',
  legacyTable: 'Program_N.finance_attachment',
  keyed: true,
  keyColumns: ['attachment_id', 'legacy_program_id'],
  columns: [
    { name: 'attachment_id', type: 's' },
    { name: 'sha256', type: 's' },
    { name: 'legacy_program_id', type: 'i' },
  ],
  excludedColumns: [],
  objectColumns: [{ name: 'content', type: 'b' }],
  folded: true,
};

/** The owner exports the attachment columns without `content`. */
const ATTACHMENT_EXPORT_COLUMNS: CanonicalColumn[] = [
  { name: 'attachment_id', type: 's' },
  { name: 'sha256', type: 's' },
];

function exportTable(legacyTable: string, columns: CanonicalColumn[], rows: { values: Values; legacyProgramId?: number }[]): ExportTable {
  return {
    unit: 'unit',
    legacyTable,
    targetTable: 'schema.table',
    keyless: false,
    columns,
    rows: rows.map(({ values, legacyProgramId }) => ({
      key: 'owner-key',
      row: encodeRow(columns, values),
      hash: 'owner-hash',
      ...(legacyProgramId === undefined ? {} : { legacyProgramId }),
    })),
  };
}

function page(tables: ExportTable[], next: string | null, objects?: ExportResponse['objects']): ExportResponse {
  return { unit: 'unit', tenantId: TENANT, tables, next, ...(objects === undefined ? {} : { objects }) };
}

/** A fake owners client whose `exportPages` yields `pages` in order and records each call. */
function ownersServing(pages: ExportResponse[]): { deps: ReconcileTargetDeps; calls: [string, ExportParams][] } {
  const calls: [string, ExportParams][] = [];
  async function* exportPages(owner: string, params: ExportParams): AsyncGenerator<ExportResponse> {
    calls.push([owner, params]);
    for (const served of pages) yield await Promise.resolve(served);
  }
  return { deps: { owners: { exportPages } as unknown as OwnersClient }, calls };
}

const content = (id: string, title: string | null, identity: string): Values => ({
  tcontent_ID: identity,
  contenthistid: id,
  TITLE: title,
  display: '1',
  amount: '12.3400',
});

/** The legacy side's row for the same values, keyed on the shape's column names. */
const legacyContent = (id: string, title: string | null): ReturnType<typeof toUnitRow> =>
  toUnitRow(CONTENT_SHAPE, { ContentHistID: id, Title: title, Display: '1', Amount: '12.3400' });

/** The rows of `result` in reading order. */
async function drain(result: TargetUnitRows): Promise<CanonicalRow[]> {
  const rows: CanonicalRow[] = [];
  for await (const row of result.rows) rows.push(row);
  return rows;
}

let spillDir: string;

beforeEach(async () => {
  spillDir = await mkdtemp(join(tmpdir(), 'opt2-target-side-test-'));
});

afterEach(async () => {
  await rm(spillDir, { recursive: true, force: true });
});

describe('readTargetUnitRows', () => {
  const unordered = (): ExportResponse[] => [
    page([exportTable('tcontent', CONTENT_EXPORT_COLUMNS, [{ values: content(ID_C, 'C', '3') }, { values: content(ID_A, 'A', '1') }])], 'cursor-1'),
    page([exportTable('tcontent', CONTENT_EXPORT_COLUMNS, [{ values: content(ID_B, null, '2') }])], null),
  ];

  it.each([undefined, 1])('reads the unit export for the tenant, concatenates its pages and sorts the rows (sortRunBytes %s)', async (sortRunBytes) => {
    const { deps, calls } = ownersServing(unordered());

    const result = await readTargetUnitRows(deps, CONTENT_SHAPE, TENANT, { sortRunBytes, spillDir });
    const rows = await drain(result);

    expect(calls).toEqual([['strategies-content', { unit: 'content.content', tenantId: TENANT }]]);
    expect(result).toMatchObject({ count: 3, objects: null });
    expect(rows).toEqual([legacyContent(ID_A, 'A'), legacyContent(ID_B, null), legacyContent(ID_C, 'C')]);
    expect([...rows].sort(compareCanonicalRows)).toEqual(rows);
    expect(await readdir(spillDir)).toEqual([]);
  });

  it.each([
    ['disposed without being read', (result: TargetUnitRows) => result.dispose()],
    [
      'left after its first row',
      async (result: TargetUnitRows) => {
        for await (const row of result.rows) {
          expect(row.row.ContentHistID).toBe(ID_A);
          break;
        }
      },
    ],
  ])('removes its spill files when %s', async (_case, finish) => {
    const { deps } = ownersServing(unordered());

    const result = await readTargetUnitRows(deps, CONTENT_SHAPE, TENANT, { sortRunBytes: 1, spillDir });
    expect(await readdir(spillDir)).toHaveLength(1);
    await finish(result);

    expect(await readdir(spillDir)).toEqual([]);
  });

  it('removes the rows it spilled when a later export page fails', async () => {
    const mistyped = CONTENT_EXPORT_COLUMNS.map((column) => (column.name === 'display' ? { ...column, type: 's' as const } : column));
    const values: Values = { tcontent_ID: '2', contenthistid: ID_B, TITLE: 'B', display: '1', amount: '1.0000' };
    const [first] = unordered();
    const { deps } = ownersServing([first as ExportResponse, page([exportTable('tcontent', mistyped, [{ values }])], null)]);

    await expect(readTargetUnitRows(deps, CONTENT_SHAPE, TENANT, { sortRunBytes: 1, spillDir })).rejects.toMatchObject({
      name: 'TargetShapeError',
      mismatchedColumns: ['Display'],
    });
    expect(await readdir(spillDir)).toEqual([]);
  });

  it('drops an excluded IDENTITY column, so differing IDENTITY values encode alike', async () => {
    const { deps } = ownersServing([
      page([exportTable('dbo.TCONTENT', CONTENT_EXPORT_COLUMNS, [{ values: content(ID_A, 'A', '999') }])], null),
    ]);

    const [row] = await drain(await readTargetUnitRows(deps, CONTENT_SHAPE, TENANT));

    expect(row?.encoding).toBe(legacyContent(ID_A, 'A').encoding);
    expect(Object.keys(row?.row ?? {})).toEqual(['ContentHistID', 'Title', 'Display', 'Amount']);
  });

  it('keeps only the tables of the shape legacy table among the unit export', async () => {
    const other = exportTable('tcontentobjects', [{ name: 'ContentHistID', type: 's' }], [{ values: { ContentHistID: ID_B } }]);
    const { deps } = ownersServing([page([other, exportTable('tcontent', CONTENT_EXPORT_COLUMNS, [{ values: content(ID_A, 'A', '1') }])], null)]);

    const rows = await drain(await readTargetUnitRows(deps, CONTENT_SHAPE, TENANT));

    expect(rows).toEqual([legacyContent(ID_A, 'A')]);
  });

  it('matches a folded mapping by its table part and encodes legacyProgramId as the program column', async () => {
    const rows = [
      { values: { timesheet_id: '7', status: 'DRAFT' }, legacyProgramId: 2 },
      { values: { timesheet_id: '7', status: 'SUBMITTED' }, legacyProgramId: 1 },
    ];
    const { deps } = ownersServing([page([exportTable('timesheet', PROGRAM_EXPORT_COLUMNS, rows)], null)]);

    const read = await drain(await readTargetUnitRows(deps, PROGRAM_SHAPE, TENANT));

    expect(read).toEqual([
      toUnitRow(PROGRAM_SHAPE, { timesheet_id: '7', status: 'SUBMITTED', legacy_program_id: '1' }, 1),
      toUnitRow(PROGRAM_SHAPE, { timesheet_id: '7', status: 'DRAFT', legacy_program_id: '2' }, 2),
    ]);
    expect(read.map((row) => row.table)).toEqual(['Program_N.timesheet', 'Program_N.timesheet']);
  });

  it('orders keyless rows by their encoding and keys them by it', async () => {
    const columns: CanonicalColumn[] = [
      { name: 'mlid', type: 's' },
      { name: 'email', type: 's' },
    ];
    const rows = [{ values: { mlid: 'L', email: 'b@example.com' } }, { values: { mlid: 'L', email: 'a@example.com' } }];
    const { deps } = ownersServing([page([exportTable('tmailinglistmembers', columns, rows)], null)]);

    const read = await drain(await readTargetUnitRows(deps, KEYLESS_SHAPE, TENANT));

    expect(read.map((row) => row.row.Email)).toEqual(['a@example.com', 'b@example.com']);
    expect(read.every((row) => row.key === row.encoding && row.keyValues.length === 0)).toBe(true);
  });

  it.each([
    {
      name: 'missing comparison columns',
      columns: CONTENT_EXPORT_COLUMNS.filter((column) => column.name !== 'TITLE' && column.name !== 'display'),
      missing: ['Title', 'Display'],
      mismatched: [],
    },
    {
      name: 'a decimal exported with another scale',
      columns: CONTENT_EXPORT_COLUMNS.map((column) => (column.name === 'amount' ? { ...column, scale: 2 } : column)),
      missing: [],
      mismatched: ['Amount'],
    },
  ])('throws TargetShapeError once for $name', async ({ columns, missing, mismatched }) => {
    const values: Values = { tcontent_ID: '1', contenthistid: ID_A, TITLE: 'A', display: '1', amount: '12.34' };
    const kept = Object.fromEntries(columns.map((column) => [column.name, values[column.name] ?? null]));
    const { deps } = ownersServing([page([exportTable('tcontent', columns, [{ values: kept }])], null)]);

    const error = await readTargetUnitRows(deps, CONTENT_SHAPE, TENANT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TargetShapeError);
    expect(error).toMatchObject({ unit: 'content.content', legacyTable: 'tcontent', missingColumns: missing, mismatchedColumns: mismatched });
  });

  it('throws TargetShapeError when no export page carries the legacy table', async () => {
    const { deps } = ownersServing([page([], null)]);

    await expect(readTargetUnitRows(deps, CONTENT_SHAPE, TENANT)).rejects.toMatchObject({
      name: 'TargetShapeError',
      missingColumns: ['ContentHistID', 'Title', 'Display', 'Amount'],
      message: 'Owner export of unit content.content has no table for legacy table tcontent',
    });
  });

  it('throws TargetShapeError for a folded row without legacyProgramId', async () => {
    const { deps } = ownersServing([page([exportTable('timesheet', PROGRAM_EXPORT_COLUMNS, [{ values: { timesheet_id: '1', status: 'DRAFT' } }])], null)]);

    await expect(readTargetUnitRows(deps, PROGRAM_SHAPE, TENANT)).rejects.toMatchObject({ missingColumns: ['legacy_program_id'] });
  });

  it.each([
    { includeObjects: true, expected: [{ key: `${TENANT}/F1.png`, size: 3, sha256: 'ab' }, { key: `${TENANT}/F1_small.png`, size: 2, sha256: 'cd' }] },
    { includeObjects: false, expected: null },
  ])('maps the paged object manifest only when includeObjects is $includeObjects', async ({ includeObjects, expected }) => {
    const table = exportTable('tcontent', CONTENT_EXPORT_COLUMNS, []);
    const { deps } = ownersServing([
      page([table], 'cursor-1', [{ key: `${TENANT}/F1.png`, size: 3, sha256: 'AB', contentType: 'image/png' }]),
      page([], null, [{ key: `${TENANT}/F1_small.png`, size: 2, sha256: 'cd' }]),
    ]);

    const result = await readTargetUnitRows(deps, CONTENT_SHAPE, TENANT, { includeObjects });

    expect(result).toMatchObject({ objects: expected, count: 0 });
    expect(await drain(result)).toEqual([]);
  });

  it.each([undefined, false, true])(
    'reads an object-column shape from rows without its object column and keys the manifest by legacyPath (includeObjects %s)',
    async (includeObjects) => {
      const rows = [{ values: { attachment_id: 'AT1', sha256: 'ab' }, legacyProgramId: 1 }];
      const { deps } = ownersServing([
        page([exportTable('finance_attachment', ATTACHMENT_EXPORT_COLUMNS, rows)], 'cursor-1', [
          { key: `${TENANT}/K1.pdf`, size: 3, sha256: 'AB', contentType: 'application/pdf', legacyPath: 'Program_1.finance_attachment/AT1' },
        ]),
        page([exportTable('finance_attachment', ATTACHMENT_EXPORT_COLUMNS, [])], null, [
          { key: `${TENANT}/K2.pdf`, size: 0, sha256: '01', legacyPath: 'Program_2.finance_attachment/AT1' },
        ]),
      ]);

      const result = await readTargetUnitRows(deps, ATTACHMENT_SHAPE, TENANT, { includeObjects });

      expect(result).toMatchObject({
        count: 1,
        objects: [
          { key: 'Program_1.finance_attachment/AT1', size: 3, sha256: 'ab' },
          { key: 'Program_2.finance_attachment/AT1', size: 0, sha256: '01' },
        ],
      });
      expect(await drain(result)).toEqual([toUnitRow(ATTACHMENT_SHAPE, { attachment_id: 'AT1', sha256: 'ab', legacy_program_id: '1' }, 1)]);
    },
  );

  it('reads an empty object-column table as no rows and no objects', async () => {
    const { deps } = ownersServing([page([exportTable('finance_attachment', ATTACHMENT_EXPORT_COLUMNS, [])], null)]);

    const result = await readTargetUnitRows(deps, ATTACHMENT_SHAPE, TENANT);

    expect(result).toMatchObject({ count: 0, objects: [] });
    expect(await drain(result)).toEqual([]);
  });

  it('throws TargetShapeError for an object-column manifest entry without a legacyPath', async () => {
    const { deps } = ownersServing([
      page([exportTable('finance_attachment', ATTACHMENT_EXPORT_COLUMNS, [])], null, [{ key: `${TENANT}/K1.pdf`, size: 3, sha256: 'ab' }]),
    ]);

    await expect(readTargetUnitRows(deps, ATTACHMENT_SHAPE, TENANT)).rejects.toMatchObject({
      name: 'TargetShapeError',
      missingColumns: ['content'],
      message: `Owner export of unit finance.attachment lists object ${TENANT}/K1.pdf without the legacyPath of its Program_N.finance_attachment row`,
    });
  });

  it('lets an owner failure propagate', async () => {
    const failure = new OwnerCallError('strategies-content', 'GET', '/internal/v1/migration/export', 503, { error: 'unavailable' });
    const exportPages = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }),
    }));
    const deps = { owners: { exportPages } as unknown as OwnersClient };

    await expect(readTargetUnitRows(deps, CONTENT_SHAPE, TENANT)).rejects.toBe(failure);
    expect(exportPages).toHaveBeenCalledTimes(1);
  });
});

describe('readTargetObjects', () => {
  it('collects the manifest of every export page of the unit', async () => {
    const { deps, calls } = ownersServing([
      page([], 'cursor-1', [{ key: `${TENANT}/F1.pdf`, size: 10, sha256: 'EF' }]),
      page([], null),
      page([], null, [{ key: `${TENANT}/F2.pdf`, size: 0, sha256: '01' }]),
    ]);

    const objects = await readTargetObjects(deps, { owner: 'strategies-content', unit: 'content.file' }, TENANT);

    expect(calls).toEqual([['strategies-content', { unit: 'content.file', tenantId: TENANT }]]);
    expect(objects).toEqual([
      { key: `${TENANT}/F1.pdf`, size: 10, sha256: 'ef' },
      { key: `${TENANT}/F2.pdf`, size: 0, sha256: '01' },
    ]);
  });
});
