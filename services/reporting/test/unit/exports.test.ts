// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export writers against the fixture's rules: CSV cells, XLSX cells per sheet and PDF text per page, never bytes. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import type { ExportTable } from '../../src/domain/sources.js';
import {
  extensionFor,
  renderCsv,
  renderExport,
  renderPdf,
  renderXlsx,
  type ExportWriterInput,
} from '../../src/domain/writers/index.js';
import type { ExportDefinitionRow, ExportFormat, ExportJobRow } from '../../src/repo/tables.js';

const JOB_ID = '0A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const RECORD_ID = 'F1D51F56-09DF-B1D1-6E2AD3839353D5E2';

const job: ExportJobRow = {
  tenant_id: '7d4a9f3e-1c2b-5e6f-8a9b-0c1d2e3f4a5b',
  job_id: JOB_ID,
  siteid: 'tenant-a',
  definition_id: '2C3D4E5F-6071-8293-A4B5C6D7E8F90A1B',
  format: 'pdf',
  state: 'running',
  requested_by_id: '1B2C3D4E-5F60-7182-93A4B5C6D7E8F90A',
  created: new Date('2026-06-30T09:00:00.000Z'),
  started_at: new Date('2026-06-30T09:00:01.000Z'),
  finished_at: null,
  error: null,
  file_name: null,
  content_type: null,
  object_key: null,
  output_sha256: null,
  row_version: '2',
};

const definition: ExportDefinitionRow = {
  tenant_id: job.tenant_id,
  definition_id: job.definition_id,
  siteid: job.siteid,
  name: 'Finance records',
  source: 'finance.records',
  columns: '["record_id","title","amount","created"]',
};

function tableOf(title: string, labels: readonly string[], rows: readonly (readonly string[])[]): ExportTable {
  return { title, columns: labels.map((label) => ({ field: label, label })), rows };
}

function input(table: ExportTable, jobChanges: Partial<ExportJobRow> = {}): ExportWriterInput {
  return { definition, table, job: { ...job, ...jobChanges } };
}

const LABELS = ['record_id', 'title', 'amount', 'created'];
const ROWS = [
  [RECORD_ID, 'Travel, hotel', '1250.5000', '2026-06-30 09:00:00.000'],
  ['B2C3D4E5-F607-1829-3A4B5C6D7E8F90A1', 'Say "hi"', '0012', ''],
  ['C3D4E5F6-0718-293A-4B5C6D7E8F90A1B2', 'line\nfeed', 'cr\rreturn', 'crlf\r\nend'],
  ['D4E5F607-1829-3A4B-5C6D7E8F90A1B2C3', ' padded ', 'caf\u00e9 \u65e5\u672c \u{1F600}', '=SUM(A1)'],
];
const SAMPLE = tableOf('Finance records', LABELS, ROWS);

const STANDARD_FONT_DATA_URL = join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts/');

/** PDF text per page as the golden normaliser extracts it: text items joined with spaces, whitespace collapsed and trimmed. */
async function pdfPages(bytes: Buffer): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, standardFontDataUrl: STANDARD_FONT_DATA_URL });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' ').replace(/\s+/g, ' ').trim());
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

async function pdfCreationDate(bytes: Buffer): Promise<unknown> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, standardFontDataUrl: STANDARD_FONT_DATA_URL });
  try {
    const { info } = await (await task.promise).getMetadata();
    return (info as Record<string, unknown>).CreationDate;
  } finally {
    await task.destroy();
  }
}

/** XLSX cells per worksheet: name, then each row's [value, type] pairs. */
async function xlsxSheets(bytes: Buffer): Promise<{ name: string; rows: [ExcelJS.CellValue, ExcelJS.ValueType][][] }[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  return workbook.worksheets.map((sheet) => {
    const rows: [ExcelJS.CellValue, ExcelJS.ValueType][][] = [];
    for (let r = 1; r <= sheet.rowCount; r += 1) {
      const row = sheet.getRow(r);
      const cells: [ExcelJS.CellValue, ExcelJS.ValueType][] = [];
      for (let c = 1; c <= row.cellCount; c += 1) cells.push([row.getCell(c).value, row.getCell(c).type]);
      rows.push(cells);
    }
    return { name: sheet.name, rows };
  });
}

describe('renderCsv', () => {
  it('writes the header labels, then every row, quoting only fields with a quote, comma, CR or LF, every line ending CRLF', async () => {
    const { bytes } = await renderCsv(input(SAMPLE));
    const text = bytes.toString('utf8');
    expect(text).toBe(
      'record_id,title,amount,created\r\n' +
        `${RECORD_ID},"Travel, hotel",1250.5000,2026-06-30 09:00:00.000\r\n` +
        'B2C3D4E5-F607-1829-3A4B5C6D7E8F90A1,"Say ""hi""",0012,\r\n' +
        'C3D4E5F6-0718-293A-4B5C6D7E8F90A1B2,"line\nfeed","cr\rreturn","crlf\r\nend"\r\n' +
        'D4E5F607-1829-3A4B-5C6D7E8F90A1B2C3, padded ,caf\u00e9 \u65e5\u672c \u{1F600},=SUM(A1)\r\n',
    );
    expect(parse(text)).toEqual([LABELS, ...ROWS]);
  });

  it.each([
    { name: 'a header without rows', labels: ['a', 'b'], rows: [], text: 'a,b\r\n' },
    { name: 'an empty cell', labels: ['x'], rows: [['']], text: 'x\r\n\r\n' },
    { name: 'no columns', labels: [], rows: [[], []], text: '\r\n\r\n\r\n' },
  ])('writes $name line by line', async ({ labels, rows, text }) => {
    expect((await renderCsv(input(tableOf('t', labels, rows)))).bytes.toString('utf8')).toBe(text);
  });
});

describe('renderXlsx', () => {
  it('stores the header and every row in one sheet named export, each cell a string', async () => {
    const sheets = await xlsxSheets((await renderXlsx(input(SAMPLE))).bytes);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['export']);
    expect(sheets[0]?.rows).toEqual([LABELS, ...ROWS].map((row) => row.map((value) => [value, ExcelJS.ValueType.String])));
  });

  it.each([
    { name: 'control characters', value: 'nul\u0000bell\u0007vt\u000bdel\u007f' },
    { name: 'a literal _xHHHH_ escape', value: 'literal _x0041_ and _x00af_' },
    { name: 'a tab and a line feed', value: 'tab\there\nnext' },
  ])('keeps $name in a cell', async ({ value }) => {
    const sheets = await xlsxSheets((await renderXlsx(input(tableOf('t', ['v'], [[value]])))).bytes);
    expect(sheets[0]?.rows[1]).toEqual([[value, ExcelJS.ValueType.String]]);
  });

  it('stores only the header row for a table without rows', async () => {
    const sheets = await xlsxSheets((await renderXlsx(input(tableOf('t', ['a', 'b'], [])))).bytes);
    expect(sheets).toEqual([{ name: 'export', rows: [[['a', ExcelJS.ValueType.String], ['b', ExcelJS.ValueType.String]]] }]);
  });

  it.each([
    { name: 'start', changes: {}, date: '2026-06-30T09:00:01.000Z' },
    { name: 'creation, before it starts', changes: { started_at: null }, date: '2026-06-30T09:00:00.000Z' },
  ])('dates the workbook at the job $name', async ({ changes, date }) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from((await renderXlsx(input(SAMPLE, changes))).bytes).buffer);
    expect([workbook.created.toISOString(), workbook.modified.toISOString()]).toEqual([date, date]);
  });
});

const rowsText = (rows: readonly (readonly string[])[]): string => rows.map((row) => row.join(' ')).join(' ');
const repeated = (word: string, count: number): string => Array.from({ length: count }, () => word).join(' ');
const LONG_ROWS = Array.from({ length: 120 }, (_, i) => [`ROW-${String(i + 1).padStart(3, '0')}`, `value ${String(i + 1)}`]);
const SPLIT_LABELS = Array.from({ length: 12 }, (_, i) => `c${String(i + 1)}`);
const SPLIT_TAIL = '09DF-B1D1-6E2AD3839353D5E2';

describe('renderPdf', () => {
  // Each expectation is the text pdfjs-dist extracts, page by page, from the fixture's cfdocument output for the table.
  it.each([
    {
      name: 'a one-page table, Times stretched to the Serif widths the layout measured',
      table: SAMPLE,
      pages: [
        `Finance records record_id t i t l e a m o u n t c r e a t e d ${RECORD_ID} Travel, h o t e l 1250.5000 2026-06-30 09:00:00.000 ` +
          'B2C3D4E5-F607-1829-3A4B5C6D7E8F90A1 Say "hi" 0012 C3D4E5F6-0718-293A-4B5C6D7E8F90A1B2 line feed c r r e t u r n crlf end ' +
          'D4E5F607-1829-3A4B-5C6D7E8F90A1B2C3 p a d d e d c a f \u00e9 =SUM(A1)',
      ],
    },
    {
      name: 'a table without rows as its title and header row',
      table: tableOf('Finance records', LABELS, []),
      pages: ['Finance records record_id t i t l e a m o u n t c r e a t e d'],
    },
    {
      name: 'empty cells as no text',
      table: tableOf('Nulls', ['a', 'b', 'c'], [['', 'x', ''], ['', '', ''], ['z', '', 'w']]),
      pages: ['N u l l s a b c x z w'],
    },
    {
      name: 'only Windows-1252 characters, with whitespace collapsed as HTML does',
      table: tableOf('Caf\u00e9 \u65e5\u672c', ['label'], [
        ['caf\u00e9 \u20ac5 \u201cq\u201d \u2014 \u0160 \u2122'],
        ['\u65e5\u672c \u{1F600} e\u0301 \u0085x'],
        ['line\nfeed\ttab   two'],
        ['soft\u00adhyphen'],
        ['a\u00a0b'],
        ['zero\u200bwidth\u200b\u200bspace'],
      ]),
      pages: ['C a f \u00e9 l a b e l caf\u00e9 \u20ac5 \u201cq\u201d \u2014 \u0160 \u2122 e x line feed tab two s o f t - h y p h e n a b zerowidthspace'],
    },
    {
      name: 'a long table broken after rows 36, 76 and 116, with the header row on the first page only',
      table: tableOf('Long', ['code', 'label'], LONG_ROWS),
      pages: [
        `Long c o d e l a b e l ${rowsText(LONG_ROWS.slice(0, 36))}`,
        rowsText(LONG_ROWS.slice(36, 76)),
        rowsText(LONG_ROWS.slice(76, 116)),
        rowsText(LONG_ROWS.slice(116)),
      ],
    },
    {
      name: 'a row taller than a page over nine pages, its one-line cell centred on the fifth',
      table: tableOf('Tall', ['k', 'v'], [['0'.repeat(60), 'abcdefgh '.repeat(400)], ['y', 'x']]),
      pages: [
        `Tall k v ${repeated('abcdefgh', 43)}`,
        ...Array.from({ length: 3 }, () => repeated('abcdefgh', 48)),
        `${'0'.repeat(60)} ${repeated('abcdefgh', 48)}`,
        ...Array.from({ length: 3 }, () => repeated('abcdefgh', 48)),
        `${repeated('abcdefgh', 21)} y x`,
      ],
    },
    {
      name: 'a title longer than a page before the table',
      table: tableOf('Heading '.repeat(400), ['code'], [['ROW-1']]),
      pages: [...Array.from({ length: 4 }, () => repeated('Heading', 100)), 'c o d e ROW-1'],
    },
    {
      name: 'a table wider than the page at the smallest font in column parts',
      table: tableOf('Split', SPLIT_LABELS, [SPLIT_LABELS.map(() => RECORD_ID)]),
      pages: [
        `Split c 1 c 2 c 3 c 4 c 5 c 6 ${repeated(RECORD_ID, 6)}`,
        `c 6 c 7 c 8 c 9 c10 c11 c12 ${SPLIT_TAIL} ${repeated(RECORD_ID, 6)}`,
      ],
    },
    { name: 'an empty title and a table without columns as one blank page', table: tableOf('', [], [[], []]), pages: [''] },
  ])('draws $name', async ({ table, pages }) => {
    expect(await pdfPages((await renderPdf(input(table))).bytes)).toEqual(pages);
  });

  it.each([
    { name: 'start', changes: {}, date: 'D:20260630090001Z' },
    { name: 'creation, before it starts', changes: { started_at: null }, date: 'D:20260630090000Z' },
  ])('dates the document at the job $name', async ({ changes, date }) => {
    expect(await pdfCreationDate((await renderPdf(input(SAMPLE, changes))).bytes)).toBe(date);
  });
});

describe('renderExport', () => {
  it.each<{ format: ExportFormat; contentType: string }>([
    { format: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { format: 'csv', contentType: 'text/csv' },
    { format: 'pdf', contentType: 'application/pdf' },
  ])('renders $format as export-<jobId>.$format with its content type', async ({ format, contentType }) => {
    const rendering = await renderExport(format, input(SAMPLE, { format }));
    expect(extensionFor(format)).toBe(format);
    expect({ fileName: rendering.fileName, contentType: rendering.contentType }).toEqual({ fileName: `export-${JOB_ID}.${format}`, contentType });
    expect(rendering.bytes.length).toBeGreaterThan(0);
  });

  it('rejects an unsupported format', async () => {
    await expect(renderExport('docx' as never, input(SAMPLE))).rejects.toThrow('unsupported export format: docx');
  });
});
