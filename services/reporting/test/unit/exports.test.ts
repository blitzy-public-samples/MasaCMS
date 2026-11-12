// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export writers against the fixture's rules: CSV cells, XLSX cells per sheet and PDF text per page, never bytes. */
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import type { ExportTableStream } from '../../src/domain/sources.js';
import {
  extensionFor,
  renderCsv,
  renderExport,
  renderPdf,
  renderXlsx,
  type ExportRendering,
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

/** A table whose rows each iteration yields afresh; `pulled` counts the rows taken, `closed` tells an iteration has ended, and `fail` throws its error in place of row `after`. */
function tableOf(
  title: string,
  labels: readonly string[],
  rows: readonly (readonly string[])[],
  fail?: { after: number; error: Error },
): ExportTableStream & { pulled: () => number; closed: () => boolean } {
  let pulled = 0;
  let closed = false;
  return {
    title,
    columns: labels.map((label) => ({ field: label, label })),
    rows: {
      async *[Symbol.asyncIterator]() {
        try {
          for (const [i, row] of rows.entries()) {
            if (i === fail?.after) throw fail.error;
            pulled += 1;
            // Each row settles on a later microtask, never a later event-loop turn, as the fastest source would.
            yield await Promise.resolve(row);
          }
          if (fail !== undefined) throw fail.error;
        } finally {
          closed = true;
        }
      },
    },
    pulled: () => pulled,
    closed: () => closed,
  };
}

function input(table: ExportTableStream, jobChanges: Partial<ExportJobRow> = {}): ExportWriterInput {
  return { definition, table, job: { ...job, ...jobChanges } };
}

/** The whole body of a rendering. */
async function bytesOf(rendering: ExportRendering | Promise<ExportRendering>): Promise<Buffer> {
  return buffer((await rendering).body);
}

/** The first chunk of a paused `body`, once its buffer has stopped filling. */
async function firstChunk(body: Readable): Promise<unknown> {
  const chunk: unknown = await new Promise((resolve) => body.once('readable', () => resolve(body.read())));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return chunk;
}

/** `count` event-loop turns. */
async function turns(count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) await nextTurn();
}

/** Turns until the writable side of an unread `body` is full, then a few more for its writer to see that. */
async function filled(body: PassThrough): Promise<void> {
  while (!body.writableNeedDrain) await nextTurn();
  await turns(10);
}

/** `count` two-column rows `ROW-<n>`, `value <n>`. */
function numberedRows(count: number): string[][] {
  return Array.from({ length: count }, (_, i) => [`ROW-${String(i + 1).padStart(3, '0')}`, `value ${String(i + 1)}`]);
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

/** Deterministic pseudo-random integers below `bound`, from a 32-bit LCG seeded with `seed`. */
function randomInts(seed: number): (bound: number) => number {
  let state = seed >>> 0;
  return (bound) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % bound;
  };
}

const CSV_PIECES = ['', 'a', 'Zz', ' ', ',', '"', '""', '\r', '\n', '\r\n', '\t', ';', 'caf\u00e9', '\u65e5\u672c', '\u{1F600}', '=SUM(A1)', '0012', '1250.5000'];

/** `count` generated tables of up to 6 columns and 12 rows, each cell joined from up to 4 pieces; the first has neither. */
function generatedTables(count: number): { labels: string[]; rows: string[][] }[] {
  const next = randomInts(20260630);
  const cell = (): string => Array.from({ length: next(5) }, () => CSV_PIECES[next(CSV_PIECES.length)] ?? '').join('');
  return Array.from({ length: count }, (_, t) => {
    const width = t === 0 ? 0 : next(7);
    const height = t === 0 ? 0 : next(13);
    return {
      labels: Array.from({ length: width }, cell),
      rows: Array.from({ length: height }, () => Array.from({ length: width }, cell)),
    };
  });
}

describe('renderCsv', () => {
  it('writes the header labels, then every row, quoting only fields with a quote, comma, CR or LF, every line ending CRLF', async () => {
    const text = (await bytesOf(renderCsv(input(SAMPLE)))).toString('utf8');
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
    expect((await bytesOf(renderCsv(input(tableOf('t', labels, rows))))).toString('utf8')).toBe(text);
  });

  it('streams the same UTF-8 bytes the synchronous serializer writes for generated tables of quotes, commas, CR, LF and empty cells', async () => {
    const options = { record_delimiter: '\r\n', quoted_match: /[\r\n]/, eof: true };
    for (const { labels, rows } of generatedTables(300)) {
      const expected = Buffer.from(stringify([labels, ...rows], options), 'utf8');
      expect(await bytesOf(renderCsv(input(tableOf('t', labels, rows))))).toEqual(expected);
    }
  });
});

describe('renderXlsx', () => {
  it('stores the header and every row in one sheet named export, each cell a string', async () => {
    const sheets = await xlsxSheets(await bytesOf(renderXlsx(input(SAMPLE))));
    expect(sheets.map((sheet) => sheet.name)).toEqual(['export']);
    expect(sheets[0]?.rows).toEqual([LABELS, ...ROWS].map((row) => row.map((value) => [value, ExcelJS.ValueType.String])));
  });

  it.each([
    { name: 'control characters', value: 'nul\u0000bell\u0007vt\u000bdel\u007f' },
    { name: 'a literal _xHHHH_ escape', value: 'literal _x0041_ and _x00af_' },
    { name: 'a tab and a line feed', value: 'tab\there\nnext' },
  ])('keeps $name in a cell', async ({ value }) => {
    const sheets = await xlsxSheets(await bytesOf(renderXlsx(input(tableOf('t', ['v'], [[value]])))));
    expect(sheets[0]?.rows[1]).toEqual([[value, ExcelJS.ValueType.String]]);
  });

  it('stores only the header row for a table without rows', async () => {
    const sheets = await xlsxSheets(await bytesOf(renderXlsx(input(tableOf('t', ['a', 'b'], [])))));
    expect(sheets).toEqual([{ name: 'export', rows: [[['a', ExcelJS.ValueType.String], ['b', ExcelJS.ValueType.String]]] }]);
  });

  it('stores every row of a table larger than its output buffers in order', async () => {
    const rows = numberedRows(5_000);
    const sheets = await xlsxSheets(await bytesOf(renderXlsx(input(tableOf('t', ['code', 'label'], rows)))));
    expect(sheets[0]?.rows.map((row) => row.map(([value]) => value))).toEqual([['code', 'label'], ...rows]);
  });

  it('stops reading rows while its unread body is full, then reads the rest as the body is read, storing every row in order', async () => {
    const rows = numberedRows(60_000);
    const table = tableOf('t', ['code', 'label'], rows);
    const body = renderXlsx(input(table)).body as PassThrough;
    await filled(body);
    const pulled = table.pulled();
    await turns(1_000);
    expect([table.pulled(), body.writableNeedDrain]).toEqual([pulled, true]);
    expect(pulled).toBeLessThan(rows.length);
    const sheets = await xlsxSheets(await buffer(body));
    expect([table.pulled(), table.closed()]).toEqual([rows.length, true]);
    expect(sheets[0]?.rows.map((row) => row.map(([value]) => value))).toEqual([['code', 'label'], ...rows]);
  });

  it('stops reading rows and ends the table when the consumer destroys its full body', async () => {
    const table = tableOf('t', ['code', 'label'], numberedRows(60_000));
    const body = renderXlsx(input(table)).body as PassThrough;
    await filled(body);
    const pulled = table.pulled();
    expect(table.closed()).toBe(false);
    body.destroy();
    await once(body, 'close');
    await turns(10);
    expect([table.closed(), body.errored]).toEqual([true, null]);
    expect(table.pulled()).toBeLessThanOrEqual(pulled + 1);
  });

  it.each([
    { name: 'start', changes: {}, date: '2026-06-30T09:00:01.000Z' },
    { name: 'creation, before it starts', changes: { started_at: null }, date: '2026-06-30T09:00:00.000Z' },
  ])('dates the workbook at the job $name', async ({ changes, date }) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(await bytesOf(renderXlsx(input(SAMPLE, changes)))).buffer);
    expect([workbook.created.toISOString(), workbook.modified.toISOString()]).toEqual([date, date]);
  });
});

const rowsText = (rows: readonly (readonly string[])[]): string => rows.map((row) => row.join(' ')).join(' ');
const repeated = (word: string, count: number): string => Array.from({ length: count }, () => word).join(' ');
const LONG_ROWS = numberedRows(120);
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
    expect(await pdfPages(await bytesOf(renderPdf(input(table))))).toEqual(pages);
  });

  it.each([
    { name: 'start', changes: {}, date: 'D:20260630090001Z' },
    { name: 'creation, before it starts', changes: { started_at: null }, date: 'D:20260630090000Z' },
  ])('dates the document at the job $name', async ({ changes, date }) => {
    expect(await pdfCreationDate(await bytesOf(renderPdf(input(SAMPLE, changes))))).toBe(date);
  });

  it('paints pages only as the body is consumed', async () => {
    const table = tableOf('Long', ['code', 'label'], numberedRows(12_000));
    const total = (await bytesOf(renderPdf(input(table)))).length;
    const { body } = await renderPdf(input(table));
    await firstChunk(body);
    // The body holds about its high-water mark, plus the page that crossed it.
    const bound = body.readableHighWaterMark + 16 * 1024;
    expect(total).toBeGreaterThan(3 * bound);
    expect(body.readableLength).toBeLessThan(bound);
    body.destroy();
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
    expect((await bytesOf(rendering)).length).toBeGreaterThan(0);
  });

  it.each<ExportFormat>(['csv', 'xlsx', 'pdf'])('fails %s with the very error a row read raises, after the rows before it', async (format) => {
    const error = new Error('page 2 unreadable');
    const table = tableOf('t', LABELS, ROWS, { after: 2, error });
    await expect(bytesOf(renderExport(format, input(table, { format })))).rejects.toBe(error);
    expect(table.pulled()).toBe(2);
  });

  it.each<ExportFormat>(['csv', 'xlsx'])('reads %s rows only as the body is consumed and stops reading when it is destroyed', async (format) => {
    const table = tableOf('t', ['code', 'label'], numberedRows(200_000));
    const { body } = await renderExport(format, input(table, { format }));
    await firstChunk(body);
    const pulled = table.pulled();
    expect(pulled).toBeLessThan(200_000);
    body.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(table.pulled()).toBeLessThanOrEqual(pulled + 1);
  });

  it('rejects an unsupported format', async () => {
    await expect(renderExport('docx' as never, input(SAMPLE))).rejects.toThrow('unsupported export format: docx');
  });
});
