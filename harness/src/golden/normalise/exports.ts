// Export and download models of the golden normaliser: CSV cells, XLSX cells per sheet, PDF text per page and
// downloaded-file digests. Bytes of CSV, XLSX and PDF bodies are never compared.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { sha256Hex } from '@opt2/platform/migration-kit';
import type { NormaliseRules } from './rules.js';
import { normaliseValue } from './values.js';

type IdOrdinals = Parameters<typeof normaliseValue>[1];
type WhitespaceMode = NormaliseRules['exports']['csv']['whitespace'];

/** One XLSX cell value after normalisation; empty cells are null. */
export type XlsxCell = string | number | boolean | null;

/** CSV body as its grid of cell values, header row included. */
export interface CsvModel {
  kind: 'csv';
  rows: string[][];
}

/** One worksheet's rows of cell values, trailing empty cells and rows trimmed. */
export interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
}

/** XLSX body as its worksheets in workbook order. */
export interface XlsxModel {
  kind: 'xlsx';
  sheets: XlsxSheet[];
}

/** PDF body as the extracted text of each page. */
export interface PdfModel {
  kind: 'pdf';
  pages: string[];
}

/** Any other download, by content digest and content type; `filename` from Content-Disposition when compared. */
export interface FileModel {
  kind: 'file';
  sha256: string;
  contentType: string;
  filename?: string;
}

/** Normalised model of an export or download body. */
export type ExportModel = CsvModel | XlsxModel | PdfModel | FileModel;

/** Which model a body is compared by. */
export type ExportKind = ExportModel['kind'];

/** Digest source of {@link fileModel}: the recorded `sha256`, or the body bytes to hash. */
export type FileModelInput = { contentType: string } & (
  | { sha256: string; bytes?: Buffer }
  | { sha256?: undefined; bytes: Buffer }
);

/** The parts of a recorded response an export model is built from (a golden `RecordedResponse` fits). */
export interface ExportResponse {
  contentType: string;
  text?: string;
  bytesBase64?: string;
  sha256: string;
  headers?: Readonly<Record<string, string | readonly string[]>>;
}

const KIND_BY_MEDIA_TYPE: ReadonlyMap<string, ExportKind> = new Map([
  ['text/csv', 'csv'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/pdf', 'pdf'],
]);

// pdfjs loads the standard 14 fonts a PDF references without embedding (pdfkit's Helvetica) from this directory.
const STANDARD_FONT_DATA_URL = join(
  dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
  'standard_fonts/',
);

const DISPOSITION_FILENAME = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i;

function applyWhitespace(s: string, mode: WhitespaceMode): string {
  return mode === 'collapse-and-trim' ? s.replace(/\s+/g, ' ').trim() : s;
}

function normaliseString(s: string, state: IdOrdinals, rules: NormaliseRules, key?: string): string {
  return String(normaliseValue(s, state, rules, key));
}

// Header cells name their columns, so date-only, token and key-bound timestamp columns follow the JSON key rules.
function columnKeys(header: readonly unknown[] | undefined, rules: NormaliseRules): (string | undefined)[] {
  if (header === undefined || !rules.timestamps.dateOnlyFieldKinds.includes('column-headers')) return [];
  return header.map((cell) => (typeof cell === 'string' && cell.trim() !== '' ? cell.trim() : undefined));
}

/**
 * CSV `text` as its cell grid, each cell normalised as a body value under its column header.
 * Cells keep their whitespace under `exports.csv.whitespace: exact`, so Masa's appended-space quirk stays visible.
 */
export function csvModel(text: string, state: IdOrdinals, rules: NormaliseRules): CsvModel {
  const records = parse(text, { bom: true, relax_column_count: true, relax_quotes: true });
  const keys = columnKeys(records[0], rules);
  const mode = rules.exports.csv.whitespace;
  return {
    kind: 'csv',
    rows: records.map((row, r) =>
      row.map((cell, c) => normaliseString(applyWhitespace(cell, mode), state, rules, r === 0 ? undefined : keys[c])),
    ),
  };
}

// exceljs decodes date serials into the UTC fields of a Date, so these are the wall-clock values the sheet holds.
function cellValue(value: ExcelJS.CellValue): XlsxCell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 19);
  if (typeof value !== 'object') return value;
  if ('richText' in value) return value.richText.map((run) => run.text).join('');
  if ('error' in value) return value.error;
  if ('formula' in value || 'sharedFormula' in value) return cellValue(value.result);
  // Hyperlink text read from a file may itself be a rich-text value, despite the declared string type.
  return cellValue(value.text);
}

function sheetRows(sheet: ExcelJS.Worksheet): XlsxCell[][] {
  const rows: XlsxCell[][] = [];
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.findRow(r);
    const cells: XlsxCell[] = [];
    for (let c = 1; c <= (row?.cellCount ?? 0); c += 1) {
      const cell = cellValue(row?.getCell(c).value);
      cells.push(cell === '' ? null : cell);
    }
    while (cells.length > 0 && cells.at(-1) === null) cells.pop();
    rows.push(cells);
  }
  while (rows.length > 0 && rows.at(-1)?.length === 0) rows.pop();
  return rows;
}

/** XLSX `bytes` as cell values per worksheet; workbook metadata, styles and string storage are not part of it. */
export async function xlsxModel(bytes: Buffer, state: IdOrdinals, rules: NormaliseRules): Promise<XlsxModel> {
  const workbook = new ExcelJS.Workbook();
  // exceljs declares its input as an ArrayBuffer; JSZip reads either form.
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  const compareNames = rules.exports.xlsx.sheetNames === 'compare';
  return {
    kind: 'xlsx',
    sheets: workbook.worksheets.map((sheet) => {
      const name = compareNames ? normaliseString(sheet.name, state, rules) : '';
      const rows = sheetRows(sheet);
      const keys = columnKeys(rows[0], rules);
      return {
        name,
        rows: rows.map((row, r) =>
          row.map((cell, c) => normaliseValue(cell, state, rules, r === 0 ? undefined : keys[c]) as XlsxCell),
        ),
      };
    }),
  };
}

/** PDF `bytes` as the text of each page: text items joined with spaces, whitespace per `exports.pdf.whitespace`. */
export async function pdfModel(bytes: Buffer, state: IdOrdinals, rules: NormaliseRules): Promise<PdfModel> {
  // A copy: pdfjs transfers the buffer it is given to its worker.
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });
  try {
    const doc = await task.promise;
    const texts: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      texts.push(content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' '));
    }
    const mode = rules.exports.pdf.whitespace;
    return { kind: 'pdf', pages: texts.map((text) => normaliseString(applyWhitespace(text, mode), state, rules)) };
  } finally {
    await task.destroy();
  }
}

/** File model from the recorded `sha256`, else from the SHA-256 of `bytes`; `contentType` is kept verbatim. */
export function fileModel(input: FileModelInput): FileModel {
  const sha256 = input.sha256 === undefined ? sha256Hex(input.bytes) : input.sha256;
  return { kind: 'file', sha256, contentType: input.contentType };
}

/**
 * Model kind for a response content type, by its media type alone (the rules declare no content-type mappings);
 * unlisted types are compared as files.
 */
export function exportKindFor(contentType: string): ExportKind {
  const media = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return KIND_BY_MEDIA_TYPE.get(media) ?? 'file';
}

function dispositionFilename(headers: ExportResponse['headers']): string | undefined {
  const raw = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-disposition')?.[1];
  const value = typeof raw === 'string' ? raw : raw?.[0];
  const match = value === undefined ? null : DISPOSITION_FILENAME.exec(value);
  if (match === null) return undefined;
  return match[1] === undefined ? match[2]?.trim() : match[1].replace(/\\(.)/g, '$1');
}

function bodyBytes(response: ExportResponse): Buffer {
  return response.bytesBase64 === undefined
    ? Buffer.from(response.text ?? '', 'utf8')
    : Buffer.from(response.bytesBase64, 'base64');
}

/** Model of a recorded export or download response, by the kind its content type selects. */
export async function exportModel(
  response: ExportResponse,
  state: IdOrdinals,
  rules: NormaliseRules,
): Promise<ExportModel> {
  switch (exportKindFor(response.contentType)) {
    case 'csv':
      return csvModel(response.text ?? bodyBytes(response).toString('utf8'), state, rules);
    case 'xlsx':
      return xlsxModel(bodyBytes(response), state, rules);
    case 'pdf':
      return pdfModel(bodyBytes(response), state, rules);
    case 'file': {
      const model = fileModel({ sha256: response.sha256, contentType: response.contentType });
      const filename = rules.exports.file.compare.includes('contentDispositionFilename')
        ? dispositionFilename(response.headers)
        : undefined;
      return filename === undefined ? model : { ...model, filename: normaliseString(filename, state, rules) };
    }
  }
}
