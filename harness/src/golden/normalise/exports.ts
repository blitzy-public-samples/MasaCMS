// Export and download models of the golden normaliser: CSV cells, XLSX cells per sheet, PDF text per page, ZIP entry
// digests and downloaded-file digests. Bytes of CSV, XLSX, PDF and ZIP bodies are never compared.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { sha256Hex } from '@opt2/platform/migration-kit';
import { GoldenConfigError } from '../errors.js';
import { createIdOrdinals } from './ids.js';
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

/** ZIP entry by normalised name and content; a directory `<name>/` or expanded nested archive `<name>!/` is empty. */
export interface ZipEntry {
  name: string;
  sha256: string;
  size: number;
}

/** ZIP download as its entries; `filename` from Content-Disposition when compared. */
export interface ZipModel {
  kind: 'zip';
  contentType: string;
  entries: ZipEntry[];
  filename?: string;
}

/** Any other download, by content digest and content type; `filename` from Content-Disposition when compared. */
export interface FileModel {
  kind: 'file';
  sha256: string;
  contentType: string;
  filename?: string;
}

/** Normalised model of an export or download body. */
export type ExportModel = CsvModel | XlsxModel | PdfModel | ZipModel | FileModel;

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
  ['application/zip', 'zip'],
  ['application/x-zip-compressed', 'zip'],
]);

/** Levels of archives nested in a ZIP download that are read as archives; one nested deeper is a file by its digest. */
export const ZIP_NESTING_LIMIT = 3;

/** Merged cells an XLSX body may declare across its worksheets; exceljs creates each one on load. */
export const XLSX_MERGED_CELL_LIMIT = 100_000;

/** Merged ranges an XLSX body may declare across its worksheets; exceljs checks each against every earlier one. */
export const XLSX_MERGED_RANGE_LIMIT = 2_000;

// Excel's last row: exceljs bounds columns itself but not rows.
const XLSX_LAST_ROW = 1_048_576;

/** A range's bounds as exceljs decodes them, each at least 1. */
interface ExcelRangeBounds {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The parts exceljs parsed from a workbook; each worksheet's `mergeCells` are the refs it merges next. */
interface ParsedWorkbook {
  worksheets: { mergeCells?: readonly (string | undefined)[] | null }[];
}

/** exceljs's XLSX reader: `load` parses every part, calls `reconcile`, then builds the workbook from the model. */
interface XlsxReader {
  load(data: ArrayBuffer): Promise<ExcelJS.Workbook>;
  reconcile(model: ParsedWorkbook, options: unknown): void;
}

// exceljs's own range decoder and XLSX reader (it has no exports map), so merges are read as its load reads them.
const ExcelRange = createRequire(import.meta.url)('exceljs/lib/doc/range.js') as new (
  ref: string | undefined,
) => ExcelRangeBounds;
const ExcelXlsx = createRequire(import.meta.url)('exceljs/lib/xlsx/xlsx.js') as new (
  workbook: ExcelJS.Workbook,
) => XlsxReader;

const ZIP_NAME = /\.zip$/i;
const NESTED_ENTRY_SEPARATOR = '!/';

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

function csvRow(row: readonly string[], state: IdOrdinals, rules: NormaliseRules, keys: readonly (string | undefined)[]): string[] {
  return row.map((cell, c) => normaliseString(applyWhitespace(cell, rules.exports.csv.whitespace), state, rules, keys[c]));
}

const codeUnitOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `rows` with each run tying on `keyColumns` sorted per `exports.csv.keyTies`; throws GoldenConfigError for a column the header lacks. */
function orderKeyTies(
  header: readonly string[],
  rows: readonly string[][],
  keyColumns: readonly string[],
  keys: readonly (string | undefined)[],
  rules: NormaliseRules,
): string[][] {
  const ties = rules.exports.csv.keyTies;
  const indexes = keyColumns.map((name) => {
    const index = header.findIndex((cell) => cell.trim() === name);
    if (index < 0) throw new GoldenConfigError(`csvKeyOrder column ${name} is not a header of the CSV`);
    return index;
  });
  const keyOf = (row: readonly string[]): string =>
    indexes
      .map((index) => {
        const cell = applyWhitespace(row[index] ?? '', ties.whitespace);
        return ties.match === 'case-insensitive' ? cell.toLowerCase() : cell;
      })
      .join('\u0000');
  // A row normalised alone numbers only its own ids, so the order never depends on raw ids or earlier steps.
  const sortKey = (row: readonly string[]): [string, string] => [
    JSON.stringify(csvRow(row, createIdOrdinals(), rules, keys)),
    JSON.stringify(row),
  ];
  const rowKeys = rows.map(keyOf);
  const ordered: string[][] = [];
  for (let start = 0; start < rows.length; ) {
    let end = start + 1;
    while (end < rows.length && rowKeys[end] === rowKeys[start]) end += 1;
    const run = rows.slice(start, end);
    if (run.length > 1) {
      const sorted = run.map((row) => ({ row, by: sortKey(row) }));
      sorted.sort((a, b) => codeUnitOrder(a.by[0], b.by[0]) || codeUnitOrder(a.by[1], b.by[1]));
      ordered.push(...sorted.map(({ row }) => row));
    } else {
      ordered.push(...run);
    }
    start = end;
  }
  return ordered;
}

/**
 * CSV `text` as its cell grid, each cell normalised under its column header after runs tying on `keyColumns` are
 * ordered; `exports.csv.whitespace: exact` keeps Masa's appended-space quirk visible.
 */
export function csvModel(text: string, state: IdOrdinals, rules: NormaliseRules, keyColumns: readonly string[] = []): CsvModel {
  const [header, ...rows] = parse(text, { bom: true, relax_column_count: true, relax_quotes: true });
  if (header === undefined) return { kind: 'csv', rows: [] };
  const keys = columnKeys(header, rules);
  const ordered = keyColumns.length === 0 ? rows : orderKeyTies(header, rows, keyColumns, keys, rules);
  return { kind: 'csv', rows: [csvRow(header, state, rules, []), ...ordered.map((row) => csvRow(row, state, rules, keys))] };
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

/** Cells exceljs creates to merge `ref`, Infinity past Excel's last row; throws as its load does for a bad ref. */
function mergedCells(ref: string | undefined): number {
  const range = new ExcelRange(ref);
  if (range.bottom > XLSX_LAST_ROW) return Infinity;
  return (range.bottom - range.top + 1) * (range.right - range.left + 1);
}

/** exceljs's XLSX reader, throwing RangeError before it merges more ranges or cells than the limits allow. */
class MergeBoundedXlsx extends ExcelXlsx {
  override reconcile(model: ParsedWorkbook, options: unknown): void {
    super.reconcile(model, options);
    let ranges = 0;
    let cells = 0;
    for (const ref of model.worksheets.flatMap((sheet) => sheet.mergeCells ?? [])) {
      ranges += 1;
      cells += mergedCells(ref);
      // Negated, so a NaN count fails the bound too.
      if (!(ranges <= XLSX_MERGED_RANGE_LIMIT && cells <= XLSX_MERGED_CELL_LIMIT)) {
        throw new RangeError(
          `XLSX merges more than ${XLSX_MERGED_RANGE_LIMIT} ranges or ${XLSX_MERGED_CELL_LIMIT} cells`,
        );
      }
    }
  }
}

/** XLSX `bytes` as cell values per worksheet; workbook metadata, styles and string storage are not part of it. */
export async function xlsxModel(bytes: Buffer, state: IdOrdinals, rules: NormaliseRules): Promise<XlsxModel> {
  const workbook = new ExcelJS.Workbook();
  // exceljs declares its input as an ArrayBuffer; JSZip reads either form.
  await new MergeBoundedXlsx(workbook).load(Uint8Array.from(bytes).buffer);
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

/** A ZIP entry as read: its raw name (`<outer>!/<inner>` when nested) and bytes. */
interface ZipFile {
  name: string;
  content: Buffer;
}

/**
 * Raw entries of archive `bytes` at nesting `depth`, named under `prefix`, with nested archives expanded and no implied
 * directories; undefined when `bytes` is not a ZIP.
 */
async function zipEntries(bytes: Buffer, prefix: string, depth: number): Promise<ZipFile[] | undefined> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch {
    return undefined;
  }
  const files: ZipFile[] = [];
  for (const entry of Object.values(zip.files)) {
    // JSZip gives a directory no unsafeOriginalName; its name ends in '/', so it is never expanded.
    const name = `${prefix}${entry.unsafeOriginalName ?? entry.name}`;
    const content = await entry.async('nodebuffer');
    const nestedPrefix = `${name}${NESTED_ENTRY_SEPARATOR}`;
    const nested =
      depth < ZIP_NESTING_LIMIT && ZIP_NAME.test(name) ? await zipEntries(content, nestedPrefix, depth + 1) : undefined;
    // An expanded archive is listed itself, so one holding no entries is still compared.
    if (nested === undefined) files.push({ name, content });
    else files.push({ name: nestedPrefix, content: Buffer.alloc(0) }, ...nested);
  }
  return files;
}

// A byte order mark stays part of the text, so it is compared.
const UTF8_TEXT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** `content` as text when it is valid UTF-8 without NUL bytes; undefined for binary content. */
function textContent(content: Buffer): string | undefined {
  if (content.includes(0)) return undefined;
  try {
    return UTF8_TEXT.decode(content);
  } catch {
    return undefined;
  }
}

// cfwddx writes a query as one <field> per column, each listing that column's values in row order.
const WDDX_RECORDSET_HEAD = /^<wddxPacket version='1\.0'><header\/><data><recordset rowCount='(\d+)' fieldNames='([^']*)'[^>]*>/;
// cffile action="write" ends the file with a line separator.
const WDDX_RECORDSET_TAIL = /<\/recordset><\/data><\/wddxPacket>(?:\r?\n)?$/;
const WDDX_FIELD_OPEN = /<field name='[^']*'>/y;
const WDDX_FIELD_CLOSE = '</field>';
const WDDX_VALUE = /<(string|number|dateTime|boolean|binary|null)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/y;

/** The values of one WDDX field body in order; undefined when the body is not a run of WDDX values. */
function wddxValues(body: string): string[] | undefined {
  const values: string[] = [];
  WDDX_VALUE.lastIndex = 0;
  while (WDDX_VALUE.lastIndex < body.length) {
    const match = WDDX_VALUE.exec(body);
    if (match === null) return undefined;
    values.push(match[0]);
  }
  return values;
}

/**
 * `text` with the rows of its WDDX recordset in `exports.zip.recordsetRows.order`: by the row normalised alone, then
 * raw; any other text is returned unchanged.
 */
function sortedRecordsetRows(text: string, rules: NormaliseRules): string {
  const head = WDDX_RECORDSET_HEAD.exec(text);
  const tail = WDDX_RECORDSET_TAIL.exec(text);
  if (head === null || tail === null || tail.index < head[0].length) return text;
  const rowCount = Number(head[1]);
  const columns = head[2] === '' ? 0 : (head[2] ?? '').split(',').length;
  const body = text.slice(head[0].length, tail.index);
  const fields: { open: string; values: string[] }[] = [];
  for (let at = 0; at < body.length; ) {
    WDDX_FIELD_OPEN.lastIndex = at;
    const open = WDDX_FIELD_OPEN.exec(body);
    const close = open === null ? -1 : body.indexOf(WDDX_FIELD_CLOSE, WDDX_FIELD_OPEN.lastIndex);
    if (open === null || close < 0) return text;
    const values = wddxValues(body.slice(WDDX_FIELD_OPEN.lastIndex, close));
    if (values?.length !== rowCount) return text;
    fields.push({ open: open[0], values });
    at = close + WDDX_FIELD_CLOSE.length;
  }
  if (rowCount < 2 || fields.length !== columns) return text;
  const rows = Array.from({ length: rowCount }, (_row, r) => {
    const raw = fields.map((field) => field.values[r] ?? '').join('');
    return { r, alone: normaliseString(raw, createIdOrdinals(), rules), raw };
  });
  rows.sort((a, b) => codeUnitOrder(a.alone, b.alone) || codeUnitOrder(a.raw, b.raw));
  const sorted = fields.map(
    (field) => `${field.open}${rows.map(({ r }) => field.values[r] ?? '').join('')}${WDDX_FIELD_CLOSE}`,
  );
  return `${head[0]}${sorted.join('')}${tail[0]}`;
}

function zipEntry(file: ZipFile, state: IdOrdinals, rules: NormaliseRules, recordsets: RegExp): ZipEntry {
  const name = normaliseString(file.name, state, rules);
  const raw = textContent(file.content);
  const text = raw !== undefined && recordsets.test(file.name) ? sortedRecordsetRows(raw, rules) : raw;
  const content = text === undefined ? file.content : Buffer.from(normaliseString(text, state, rules), 'utf8');
  return { name, sha256: sha256Hex(content), size: content.length };
}

/**
 * ZIP `bytes` as entries sorted by raw name, text content normalised before hashing; ids are numbered in that order,
 * name before content. Entry times and order, and the row order of `exports.zip.recordsetRows` entries, are not
 * compared. Undefined when not a ZIP; `contentType` kept verbatim.
 */
export async function zipModel(
  bytes: Buffer,
  contentType: string,
  state: IdOrdinals,
  rules: NormaliseRules,
): Promise<ZipModel | undefined> {
  const files = await zipEntries(bytes, '', 0);
  if (files === undefined) return undefined;
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const recordsets = new RegExp(rules.exports.zip.recordsetRows.entries);
  return { kind: 'zip', contentType, entries: files.map((file) => zipEntry(file, state, rules, recordsets)) };
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

/** `model` with the normalised Content-Disposition filename when `compare` names it and the response carries one. */
function withFilename<T extends ZipModel | FileModel>(
  model: T,
  compare: readonly string[],
  response: ExportResponse,
  state: IdOrdinals,
  rules: NormaliseRules,
): T {
  const filename = compare.includes('contentDispositionFilename') ? dispositionFilename(response.headers) : undefined;
  return filename === undefined ? model : { ...model, filename: normaliseString(filename, state, rules) };
}

function downloadedFileModel(response: ExportResponse, state: IdOrdinals, rules: NormaliseRules): FileModel {
  const model = fileModel({ sha256: response.sha256, contentType: response.contentType });
  return withFilename(model, rules.exports.file.compare, response, state, rules);
}

/** Model of a recorded export or download response, by the kind its content type selects; `csvKeyColumns` as {@link csvModel}. */
export async function exportModel(
  response: ExportResponse,
  state: IdOrdinals,
  rules: NormaliseRules,
  csvKeyColumns: readonly string[] = [],
): Promise<ExportModel> {
  switch (exportKindFor(response.contentType)) {
    case 'csv':
      return csvModel(response.text ?? bodyBytes(response).toString('utf8'), state, rules, csvKeyColumns);
    case 'xlsx':
      return xlsxModel(bodyBytes(response), state, rules);
    case 'pdf':
      return pdfModel(bodyBytes(response), state, rules);
    case 'zip': {
      const model = await zipModel(bodyBytes(response), response.contentType, state, rules);
      return model === undefined
        ? downloadedFileModel(response, state, rules)
        : withFilename(model, rules.exports.zip.compare, response, state, rules);
    }
    case 'file':
      return downloadedFileModel(response, state, rules);
  }
}

/** Model of a byte body whose step compares no export: a ZIP by its files, any other body by its digest. */
export async function byteBodyModel(
  response: ExportResponse,
  state: IdOrdinals,
  rules: NormaliseRules,
): Promise<ZipModel | FileModel> {
  const zip =
    exportKindFor(response.contentType) === 'zip'
      ? await zipModel(bodyBytes(response), response.contentType, state, rules)
      : undefined;
  return zip ?? fileModel({ sha256: response.sha256, contentType: response.contentType });
}
