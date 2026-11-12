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
});

describe('renderPdf', () => {
  it('draws the title, then the header row, then every row in order on one page', async () => {
    const table = tableOf('Finance records', ['record_id', 'title', 'amount'], [
      [RECORD_ID, 'Travel, hotel', '1250.5000'],
      ['B2C3D4E5-F607-1829-3A4B5C6D7E8F90A1', 'Say "hi"', ''],
    ]);
    expect(await pdfPages((await renderPdf(input(table))).bytes)).toEqual([
      `Finance records record_id title amount ${RECORD_ID} Travel, hotel 1250.5000 B2C3D4E5-F607-1829-3A4B5C6D7E8F90A1 Say "hi"`,
    ]);
  });

  it('keeps a column at its widest value and wraps only the column with words to spare', async () => {
    const title = 'Purchase order - Bespoke Marble Sausages for the quarterly offsite and the travel that goes with it';
    const table = tableOf('Wide', ['record_id', 'title', 'amount', 'period', 'state'], [[RECORD_ID, title, '22993.5100', '2026-03', 'IN-PROGRESS']]);
    const [page] = await pdfPages((await renderPdf(input(table))).bytes);
    expect(page).toBe(`Wide record_id title amount period state ${RECORD_ID} ${title} 22993.5100 2026-03 IN-PROGRESS`);
  });

  it('omits characters outside Windows-1252, keeps Windows-1252 ones and collapses whitespace as HTML does', async () => {
    const table = tableOf('Caf\u00e9 \u65e5\u672c', ['label'], [
      ['caf\u00e9 \u20ac5 \u201cq\u201d \u2014 \u0160 \u2122'],
      ['\u65e5\u672c \u{1F600} e\u0301 \u0085x'],
      ['line\nfeed\ttab   two'],
      ['soft\u00adhyphen'],
    ]);
    expect(await pdfPages((await renderPdf(input(table))).bytes)).toEqual([
      'Caf\u00e9 label caf\u00e9 \u20ac5 \u201cq\u201d \u2014 \u0160 \u2122 e x line feed tab two soft-hyphen',
    ]);
  });

  it('extracts a no-break space as a space', async () => {
    const [page] = await pdfPages((await renderPdf(input(tableOf('t', ['v'], [['a\u00a0b']])))).bytes);
    expect(page).toBe('t v a b');
  });

  it('paginates a long table with the header row on the first page only and every row once, in order', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`ROW-${String(i + 1).padStart(3, '0')}`, `value ${String(i + 1)}`]);
    const pages = await pdfPages((await renderPdf(input(tableOf('Long', ['code', 'label'], rows)))).bytes);
    expect(pages).toHaveLength(3);
    expect(pages[0]?.startsWith('Long code label ROW-001 value 1')).toBe(true);
    expect(pages.slice(1).every((page) => page.startsWith('ROW-') && !page.includes('code label'))).toBe(true);
    expect(pages.join(' ')).toBe(`Long code label ${rows.map((row) => row.join(' ')).join(' ')}`);
  });

  it('runs a row taller than a page on across pages without losing text', async () => {
    const labels = Array.from({ length: 40 }, (_, i) => `c${String(i + 1)}`);
    const tall = labels.map(() => Array.from({ length: 60 }, () => 'word').join(' '));
    const end = labels.map((_, i) => (i === 0 ? 'END' : ''));
    const pages = await pdfPages((await renderPdf(input(tableOf('Tall', labels, [tall, end])))).bytes);
    const text = pages.join('');
    expect(pages.length).toBeGreaterThanOrEqual(4);
    expect(['w', 'o', 'r', 'd'].map((char) => text.split(char).length - 1)).toEqual([2400, 2400, 2400, 2400]);
    expect(pages[0]?.startsWith('Tall c')).toBe(true);
    expect(pages[0]).not.toMatch(/[word]/);
    expect(pages.at(-1)?.endsWith('E N D')).toBe(true);
  });

  it('continues a title longer than a page on the next page, then draws the table', async () => {
    const title = Array.from({ length: 400 }, () => 'Heading').join(' ');
    const pages = await pdfPages((await renderPdf(input(tableOf(title, ['code'], [['ROW-1']])))).bytes);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join(' ')).toBe(`${title} code ROW-1`);
  });

  it('draws nothing for an empty title and a table without columns', async () => {
    expect(await pdfPages((await renderPdf(input(tableOf('', [], [[], []])))).bytes)).toEqual(['']);
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
